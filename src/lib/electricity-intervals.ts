import {
  fromScaledInteger,
  roundFraction,
  toScaledInteger,
} from "@/lib/billing-v2";
import { isoDay } from "@/lib/energy-billing";

export const ELECTRICITY_DENOMINATOR = 10_000_000n;
type Tenant = { id: string; moveInDate: Date; moveOutDate: Date | null };
export type MeterInput = {
  id: string;
  meterNumber: string;
  role: string;
  unitId: string | null;
  validFrom?: Date;
  validTo?: Date | null;
  readings: {
    readingDate: Date;
    readingKwh: { toString(): string };
    reason?: string;
    note?: string | null;
  }[];
};
export type ContractInput = {
  id?: string;
  provider?: string;
  validFrom?: Date;
  validTo?: Date | null;
  basePriceAllocation?: string;
  tariffs: {
    validFrom: Date;
    validTo: Date | null;
    billingValidFrom?: Date | null;
    billingValidTo?: Date | null;
    billingEffectiveReason?: string | null;
    priceMicroEuroPerKwh: bigint;
    monthlyBasePriceCents?: bigint;
  }[];
  meters: MeterInput[];
};
export type ElectricInterval = {
  unitId: string | null;
  tenantId: string | null;
  meterId: string;
  meterNumber: string;
  start: string;
  end: string;
  consumptionKwh: string;
  numerator: bigint;
  priceMicroEuroPerKwh: string;
  fallbackNotes?: string;
};
export const nextDay = (date: Date) => new Date(date.getTime() + 86_400_000);
export const priorDay = (date: Date) => new Date(date.getTime() - 86_400_000);
export const maxDate = (...dates: Date[]) =>
  new Date(Math.max(...dates.map((date) => date.getTime())));
export const minDate = (...dates: Date[]) =>
  new Date(Math.min(...dates.map((date) => date.getTime())));
export const tariffStart = (tariff: ContractInput["tariffs"][number]) =>
  tariff.billingValidFrom ?? tariff.validFrom;
export const tariffEnd = (
  tariff: ContractInput["tariffs"][number],
  end: Date,
) => tariff.billingValidTo ?? tariff.validTo ?? end;

export function meterIntervals(
  contract: ContractInput,
  meter: MeterInput,
  start: Date,
  end: Date,
  tenants: Tenant[] = [],
) {
  const from = maxDate(
    start,
    contract.validFrom ?? start,
    meter.validFrom ?? start,
  );
  const to = minDate(end, contract.validTo ?? end, meter.validTo ?? end);
  const blockers: string[] = [];
  const intervals: ElectricInterval[] = [];
  if (to <= from) return { intervals, blockers, from, to };
  const boundaries = new Map<string, Date>([
    [isoDay(from), from],
    [isoDay(to), to],
  ]);
  const add = (date: Date) => {
    if (date > from && date < to) boundaries.set(isoDay(date), date);
  };
  for (const tariff of contract.tariffs) {
    add(tariffStart(tariff));
    if (tariff.validTo || tariff.billingValidTo)
      add(nextDay(tariffEnd(tariff, to)));
    if (
      ((tariff.billingValidFrom &&
        isoDay(tariff.billingValidFrom) !== isoDay(tariff.validFrom)) ||
        (tariff.billingValidTo &&
          tariff.validTo &&
          isoDay(tariff.billingValidTo) !== isoDay(tariff.validTo))) &&
      !tariff.billingEffectiveReason?.trim()
    )
      blockers.push(
        `Tarifabweichung für ${meter.meterNumber} ist nicht begründet.`,
      );
  }
  for (const tenant of tenants) {
    add(tenant.moveInDate);
    if (tenant.moveOutDate) add(nextDay(tenant.moveOutDate));
  }
  const dates = [...boundaries.values()].sort(
    (a, b) => a.getTime() - b.getTime(),
  );
  for (const reading of meter.readings)
    if (reading.reason === "DOCUMENTED_ESTIMATE" && !reading.note?.trim())
      blockers.push(
        `Ersatzablesung für ${meter.meterNumber} ist nicht dokumentiert.`,
      );
  const readings = new Map(
    meter.readings.map((row) => [isoDay(row.readingDate), row]),
  );
  for (const date of dates)
    if (!readings.has(isoDay(date)))
      blockers.push(
        `Ablesung für Zähler ${meter.meterNumber} am ${isoDay(date)} fehlt. Ersatzmethode muss dokumentiert sein.`,
      );
  if (dates.some((date) => !readings.has(isoDay(date))))
    return { intervals, blockers, from, to };
  for (let index = 0; index < dates.length - 1; index++) {
    const a = dates[index];
    const b = dates[index + 1];
    const tariffs = contract.tariffs.filter(
      (row) => tariffStart(row) <= a && tariffEnd(row, to) >= priorDay(b),
    );
    if (tariffs.length !== 1) {
      blockers.push(
        `Tariflücke oder überlappende Tarife für ${meter.meterNumber} ab ${isoDay(a)}.`,
      );
      continue;
    }
    const residents = tenants.filter(
      (row) =>
        row.moveInDate <= a && (!row.moveOutDate || row.moveOutDate >= a),
    );
    if (residents.length > 1) {
      blockers.push(`Überlappende Mietverhältnisse für ${meter.meterNumber}.`);
      continue;
    }
    try {
      const quantity =
        toScaledInteger(readings.get(isoDay(b))!.readingKwh.toString()) -
        toScaledInteger(readings.get(isoDay(a))!.readingKwh.toString());
      if (quantity < 0n) throw new Error("Zählerstand läuft rückwärts.");
      intervals.push({
        unitId: meter.unitId,
        tenantId: residents[0]?.id ?? null,
        meterId: meter.id,
        meterNumber: meter.meterNumber,
        start: isoDay(a),
        end: isoDay(b),
        consumptionKwh: fromScaledInteger(quantity),
        numerator: quantity * tariffs[0].priceMicroEuroPerKwh,
        priceMicroEuroPerKwh: tariffs[0].priceMicroEuroPerKwh.toString(),
        fallbackNotes:
          [readings.get(isoDay(a)), readings.get(isoDay(b))]
            .filter((reading) => reading?.reason === "DOCUMENTED_ESTIMATE")
            .map((reading) => reading!.note)
            .join("; ") || undefined,
      });
    } catch (error) {
      blockers.push(
        `${meter.meterNumber}: ${error instanceof Error ? error.message : "Ungültige Messung"}`,
      );
    }
  }
  return { intervals, blockers, from, to };
}

export function exactElectricityTotal(intervals: ElectricInterval[]) {
  return roundFraction(
    intervals.reduce((sum, row) => sum + row.numerator, 0n),
    ELECTRICITY_DENOMINATOR,
  );
}
