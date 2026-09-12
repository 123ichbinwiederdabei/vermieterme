import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import {
  allocateCents,
  calculateElectricityCostCents,
  calculateFifoConsumption,
  co2TenantPercent,
  daysInclusive,
  isoDay,
  prorateMonthlyCents,
  splitUnitAmountAcrossTenants,
  toScaledInteger,
} from "@/lib/energy-billing";
import { fromScaledInteger, serializeExact } from "@/lib/billing-v2";
import { ApiError } from "@/lib/api-utils";
import { buildSmallWastewaterPreview } from "@/lib/cost-invoice-billing";

export interface EnergyPreview {
  kind: "HEATING_OIL" | "ELECTRICITY" | "SMALL_WASTEWATER";
  billingPeriodId: string;
  costCategoryId: string;
  totalAmountCents: string;
  tenantAmountCents: string;
  landlordAmountCents: string;
  vacancyAmountCents: string;
  allocations: Array<{
    unitId: string;
    tenantId: string | null;
    periodStart: string;
    periodEnd: string;
    amountCents: string;
    quantity?: string;
    distributionKey: string;
    calculationBasis: string;
    sourceType: string;
    sourceReferenceId?: string;
  }>;
  details: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
  sourceFingerprint: string;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(serializeExact(value))).digest("hex");
}

function nearestReading<T extends { readingDate: Date; quantityLiters: unknown; validationError?: string | null }>(readings: T[], target: Date) {
  return readings.filter((row) => row.quantityLiters != null && !row.validationError).sort((a, b) => Math.abs(a.readingDate.getTime() - target.getTime()) - Math.abs(b.readingDate.getTime() - target.getTime()))[0];
}

function dateInside(value: Date, start: Date, end: Date): boolean {
  return value >= start && value <= end;
}

function intersect(startA: Date, endA: Date, startB: Date, endB: Date) {
  const start = startA > startB ? startA : startB;
  const end = endA < endB ? endA : endB;
  return end >= start ? { start, end } : null;
}

export async function buildHeatingOilPreview(
  billingPeriodId: string,
  costCategoryId: string
): Promise<EnergyPreview> {
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: {
        include: {
          units: { include: { tenants: { include: { financialPeriods: { where: { supersededAt: null } } } } } },
          heatingSystems: {
            include: {
              units: true,
              tanks: {
                include: {
                  stockReadings: true,
                  inventoryLots: {
                    include: { consumptions: { where: { active: true } } },
                  },
                  deliveries: true,
                  deliveryCandidates: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!period) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
  const system = period.property.heatingSystems[0];
  if (!system) throw new ApiError("Für das Objekt ist kein Heizsystem konfiguriert", 400);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (system.centralHotWater) blockers.push("Zentrale Warmwasserabrechnung ist derzeit deaktiviert.");
  if (system.billingRegime === "STANDARD_HEIZKOSTENV" && system.consumptionSource === "NONE") {
    blockers.push("Für das Standardregime fehlen Wärmeverbrauchsdaten.");
  }
  if (system.billingRegime === "SECTION_11_EXCEPTION" && !system.exceptionReason) {
    blockers.push("Die dokumentierte Begründung für die §-11-Ausnahme fehlt.");
  }
  const connectedIds = new Set(system.units.map((row) => row.unitId));
  const units = period.property.units.filter((unit) => connectedIds.has(unit.id));
  for (const unit of units) if (!unit.areaM2 || toScaledInteger(unit.areaM2.toString()) <= 0n) blockers.push(`Wohnfläche für ${unit.name} fehlt.`);
  for (const unit of units) for (const tenant of unit.tenants) if (tenant.moveInDate <= period.endDate && (!tenant.moveOutDate || tenant.moveOutDate >= period.startDate) && tenant.financialPeriods.length === 0) blockers.push(`Für ${tenant.firstName} ${tenant.lastName} fehlt eine Miet-/NK-Finanzperiode.`);

  let totalAmount = 0n;
  let totalCo2Cost = 0n;
  let totalCo2Grams = 0n;
  const fifoRows: Array<Record<string, unknown>> = [];
  const source: Array<Record<string, unknown>> = [];

  for (const tank of system.tanks) {
    const startReading = nearestReading(tank.stockReadings, period.startDate);
    const endReading = nearestReading(tank.stockReadings, period.endDate);
    if (!startReading?.quantityLiters) blockers.push(`Valider Anfangstankstand für ${tank.name} fehlt.`);
    if (!endReading?.quantityLiters) blockers.push(`Valider Endtankstand für ${tank.name} fehlt.`);
    if (!startReading?.quantityLiters || !endReading?.quantityLiters) continue;
    const startGap = Math.round(Math.abs(startReading.readingDate.getTime() - period.startDate.getTime()) / 86_400_000);
    const endGap = Math.round(Math.abs(endReading.readingDate.getTime() - period.endDate.getTime()) / 86_400_000);
    if (startGap > 3) warnings.push(`Anfangsmessung für ${tank.name} liegt ${startGap} Tage von der Periodengrenze entfernt.`);
    if (endGap > 3) warnings.push(`Endmessung für ${tank.name} liegt ${endGap} Tage von der Periodengrenze entfernt.`);
    if (tank.deliveryCandidates.some((candidate) => candidate.status === "PENDING")) warnings.push(`${tank.name} hat ungeklärte mögliche Lieferungen.`);
    if (tank.capacityLiters && toScaledInteger(endReading.quantityLiters.toString()) > toScaledInteger(tank.capacityLiters.toString())) blockers.push(`Endbestand für ${tank.name} überschreitet die Tankkapazität.`);
    const delivered = tank.deliveries
      .filter((delivery) => dateInside(delivery.deliveryDate, period.startDate, period.endDate))
      .reduce((sum, delivery) => sum + toScaledInteger(delivery.quantityLiters.toString()), 0n);
    const consumption = toScaledInteger(startReading.quantityLiters.toString()) + delivered - toScaledInteger(endReading.quantityLiters.toString());
    if (consumption < 0n) {
      blockers.push(`Der berechnete Verbrauch für ${tank.name} ist negativ.`);
      continue;
    }

    const lots = tank.inventoryLots.filter((lot) => lot.sourceDate <= period.endDate).map((lot) => {
      const consumed = lot.consumptions.reduce((sum, row) => sum + toScaledInteger(row.quantityLiters.toString()), 0n);
      const original = toScaledInteger(lot.quantityLiters.toString());
      const remaining = original - consumed;
      const remainingAmount = lot.totalAmountCents - lot.consumptions.reduce((sum, row) => sum + row.amountCents, 0n);
      const remainingCo2Cost = lot.co2CostCents - lot.consumptions.reduce((sum, row) => sum + row.co2CostCents, 0n);
      const remainingCo2 = lot.co2Grams - lot.consumptions.reduce((sum, row) => sum + row.co2Grams, 0n);
      return {
        id: lot.id,
        sourceDate: lot.sourceDate,
        quantityLiters: fromScaledInteger(remaining),
        totalAmountCents: remainingAmount,
        co2CostCents: remainingCo2Cost,
        co2Grams: remainingCo2,
      };
    }).filter((lot) => toScaledInteger(lot.quantityLiters) > 0n);
    try {
      const fifo = calculateFifoConsumption(lots, fromScaledInteger(consumption));
      totalAmount += fifo.totalAmountCents;
      totalCo2Cost += fifo.totalCo2CostCents;
      totalCo2Grams += fifo.totalCo2Grams;
      fifoRows.push(...fifo.consumptions.map((row) => ({ tankId: tank.id, tankName: tank.name, ...row })));
    } catch (error) {
      blockers.push(error instanceof Error ? `${tank.name}: ${error.message}` : `${tank.name}: FIFO-Berechnung fehlgeschlagen.`);
    }
    source.push({ tankId: tank.id, startReading, startGapDays: startGap, endReading, endGapDays: endGap, deliveredLiters: fromScaledInteger(delivered), physicalConsumptionLiters: fromScaledInteger(consumption) });
  }

  const totalArea = units.reduce((sum, unit) => sum + toScaledInteger(unit.areaM2?.toString() ?? "0"), 0n);
  const tenantPercent = co2TenantPercent(totalCo2Grams, fromScaledInteger(totalArea), daysInclusive(period.startDate, period.endDate));
  const landlordCo2 = (totalCo2Cost * BigInt(100 - tenantPercent) + 50n) / 100n;
  const allocatable = totalAmount - landlordCo2;
  const unitAmounts = allocateCents(allocatable, units.map((unit) => toScaledInteger(unit.areaM2?.toString() ?? "0")));
  const allocations: EnergyPreview["allocations"] = [];
  let vacancy = 0n;
  units.forEach((unit, index) => {
    const split = splitUnitAmountAcrossTenants(unitAmounts[index], unit.id, unit.tenants, period.startDate, period.endDate, {
      distributionKey: "AREA",
      calculationBasis: `${unit.areaM2?.toString() ?? "0"} m² von ${fromScaledInteger(totalArea)} m²`,
      sourceType: "HEATING_OIL",
      sourceReferenceId: system.id,
    });
    allocations.push(...split.allocations);
    vacancy += split.vacancyCents;
  });
  const tenantAmount = allocations.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
  const sourceFingerprint = fingerprint({ system, source, fifoRows, unitAreas: units.map((unit) => [unit.id, unit.areaM2?.toString()]) });
  return {
    kind: "HEATING_OIL",
    billingPeriodId,
    costCategoryId,
    totalAmountCents: totalAmount.toString(),
    tenantAmountCents: tenantAmount.toString(),
    landlordAmountCents: (landlordCo2 + vacancy).toString(),
    vacancyAmountCents: vacancy.toString(),
    allocations,
    details: { fifoRows, co2CostCents: totalCo2Cost.toString(), co2Grams: totalCo2Grams.toString(), co2TenantPercent: tenantPercent, landlordCo2Cents: landlordCo2.toString() },
    blockers,
    warnings,
    sourceFingerprint,
  };
}

export async function buildElectricityPreview(
  billingPeriodId: string,
  costCategoryId: string
): Promise<EnergyPreview> {
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: {
        include: {
          units: { include: { tenants: true } },
          electricityContracts: {
            include: { tariffs: true, meters: { include: { readings: true } } },
          },
        },
      },
    },
  });
  if (!period) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const unitEnergy = new Map<string, { amount: bigint; consumption: bigint }>();
  let commonAmount = 0n;
  let totalBase = 0n;
  const intervalDetails: Array<Record<string, unknown>> = [];

  for (const contract of period.property.electricityContracts) {
    let contractBase = 0n;
    // Contractual validity and settlement validity are intentionally distinct
    // when a tariff change could not be measured on its contractual date.
    const settlementStart = (tariff: typeof contract.tariffs[number]) => tariff.billingValidFrom ?? tariff.validFrom;
    const settlementEnd = (tariff: typeof contract.tariffs[number]) => tariff.billingValidTo ?? tariff.validTo ?? period.endDate;
    const activeTariffs = contract.tariffs.filter((tariff) => intersect(settlementStart(tariff), settlementEnd(tariff), period.startDate, period.endDate));
    if (activeTariffs.length === 0) blockers.push(`Für ${contract.provider} fehlt ein Tarif im Abrechnungszeitraum.`);
    for (const tariff of activeTariffs) {
      const range = intersect(settlementStart(tariff), settlementEnd(tariff), period.startDate, period.endDate);
      if (range) { const amount = prorateMonthlyCents(tariff.monthlyBasePriceCents, range.start, range.end); contractBase += amount; totalBase += amount; }
    }
    for (const meter of contract.meters.filter((row) => row.role !== "INFORMATIONAL_TOTAL")) {
      const boundaries = new Map<string, Date>();
      boundaries.set(isoDay(period.startDate), period.startDate);
      boundaries.set(isoDay(period.endDate), period.endDate);
      for (const tariff of activeTariffs) if (settlementStart(tariff) > period.startDate && settlementStart(tariff) < period.endDate) boundaries.set(isoDay(settlementStart(tariff)), settlementStart(tariff));
      if (meter.unitId) {
        const unit = period.property.units.find((row) => row.id === meter.unitId);
        for (const tenant of unit?.tenants ?? []) {
          if (tenant.moveInDate > period.startDate && tenant.moveInDate < period.endDate) boundaries.set(isoDay(tenant.moveInDate), tenant.moveInDate);
          if (tenant.moveOutDate && tenant.moveOutDate > period.startDate && tenant.moveOutDate < period.endDate) boundaries.set(isoDay(tenant.moveOutDate), tenant.moveOutDate);
        }
      }
      const dates = [...boundaries.values()].sort((a, b) => a.getTime() - b.getTime());
      const readingMap = new Map(meter.readings.map((reading) => [isoDay(reading.readingDate), reading]));
      for (const boundary of dates) if (!readingMap.has(isoDay(boundary))) blockers.push(`Ablesung für Zähler ${meter.meterNumber} am ${isoDay(boundary)} fehlt.`);
      if (dates.some((date) => !readingMap.has(isoDay(date)))) continue;
      for (let index = 0; index < dates.length - 1; index += 1) {
        const start = dates[index];
        const end = dates[index + 1];
        // A reading on the next effective date closes the preceding interval;
        // the preceding tariff therefore needs to cover the calendar day
        // before that boundary, not the boundary itself.
        const priorCalendarDay = new Date(end); priorCalendarDay.setDate(priorCalendarDay.getDate() - 1);
        const tariff = activeTariffs.find((row) => settlementStart(row) <= start && settlementEnd(row) >= priorCalendarDay);
        if (!tariff) {
          blockers.push(`Tariflücke für Zähler ${meter.meterNumber} ab ${isoDay(start)}.`);
          continue;
        }
        const startReading = readingMap.get(isoDay(start))!;
        const endReading = readingMap.get(isoDay(end))!;
        try {
          const result = calculateElectricityCostCents(startReading.readingKwh.toString(), endReading.readingKwh.toString(), tariff.priceMicroEuroPerKwh);
          const consumption = toScaledInteger(result.consumptionKwh);
          if (meter.role === "UNIT_CONSUMPTION" && meter.unitId) {
            const current = unitEnergy.get(meter.unitId) ?? { amount: 0n, consumption: 0n };
            current.amount += result.amountCents;
            current.consumption += consumption;
            unitEnergy.set(meter.unitId, current);
          } else if (meter.role === "COMMON_ELECTRICITY") {
            commonAmount += result.amountCents;
          }
          intervalDetails.push({ meterId: meter.id, meterNumber: meter.meterNumber, start: isoDay(start), end: isoDay(end), consumptionKwh: result.consumptionKwh, priceMicroEuroPerKwh: tariff.priceMicroEuroPerKwh.toString(), contractValidFrom: isoDay(tariff.validFrom), billingValidFrom: isoDay(settlementStart(tariff)), billingEffectiveReason: tariff.billingEffectiveReason, amountCents: result.amountCents.toString() });
        } catch (error) {
          blockers.push(error instanceof Error ? `${meter.meterNumber}: ${error.message}` : `${meter.meterNumber}: Berechnung fehlgeschlagen.`);
        }
      }
    }

    const billableUnits = period.property.units.filter((unit) => contract.meters.some((meter) => meter.unitId === unit.id && meter.role === "UNIT_CONSUMPTION"));
    const baseWeights = contract.basePriceAllocation === "EQUAL_PER_UNIT"
      ? billableUnits.map(() => 1n)
      : billableUnits.map((unit) => unitEnergy.get(unit.id)?.consumption ?? 0n);
    const baseShares = allocateCents(contractBase, baseWeights);
    billableUnits.forEach((unit, index) => {
      const current = unitEnergy.get(unit.id) ?? { amount: 0n, consumption: 0n };
      current.amount += baseShares[index] ?? 0n;
      unitEnergy.set(unit.id, current);
    });
  }

  const allUnits = period.property.units;
  const commonShares = allocateCents(commonAmount, allUnits.map((unit) => toScaledInteger(unit.areaM2?.toString() ?? "0")));
  const allocations: EnergyPreview["allocations"] = [];
  let vacancy = 0n;
  allUnits.forEach((unit, index) => {
    const own = unitEnergy.get(unit.id) ?? { amount: 0n, consumption: 0n };
    const amount = own.amount + (commonShares[index] ?? 0n);
    if (amount === 0n) return;
    const split = splitUnitAmountAcrossTenants(amount, unit.id, unit.tenants, period.startDate, period.endDate, {
      quantity: fromScaledInteger(own.consumption),
      distributionKey: own.amount > 0n ? "DIRECT_CONSUMPTION" : "AREA",
      calculationBasis: `${fromScaledInteger(own.consumption)} kWh plus Allgemeinstrom/Grundpreis`,
      sourceType: "ELECTRICITY",
    });
    allocations.push(...split.allocations);
    vacancy += split.vacancyCents;
  });
  const tenantAmount = allocations.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
  const total = tenantAmount + vacancy;
  const sourceFingerprint = fingerprint({ contracts: period.property.electricityContracts, intervalDetails });
  return {
    kind: "ELECTRICITY",
    billingPeriodId,
    costCategoryId,
    totalAmountCents: total.toString(),
    tenantAmountCents: tenantAmount.toString(),
    landlordAmountCents: vacancy.toString(),
    vacancyAmountCents: vacancy.toString(),
    allocations,
    details: { intervalDetails, basePriceCents: totalBase.toString(), commonElectricityCents: commonAmount.toString() },
    blockers,
    warnings,
    sourceFingerprint,
  };
}

export async function buildEnergyPreview(kind: string, billingPeriodId: string, costCategoryId: string) {
  if (kind === "HEATING_OIL") return buildHeatingOilPreview(billingPeriodId, costCategoryId);
  if (kind === "ELECTRICITY") return buildElectricityPreview(billingPeriodId, costCategoryId);
  if (kind === "SMALL_WASTEWATER") return buildSmallWastewaterPreview(billingPeriodId, costCategoryId);
  throw new ApiError("Unbekannte Energie-Kostenart", 400);
}
