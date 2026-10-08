import {
  allocateCents,
  calculateElectricityCostCents,
  calculateFifoConsumption,
  prorateMonthlyCents,
  toScaledInteger,
} from "@/lib/billing-v2";

export interface AllocationResult {
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
}

export function isoDay(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function daysInclusive(start: Date, end: Date): number {
  return (
    Math.floor(
      (Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) -
        Date.UTC(
          start.getUTCFullYear(),
          start.getUTCMonth(),
          start.getUTCDate(),
        )) /
        86_400_000,
    ) + 1
  );
}

export function co2TenantPercent(
  co2Grams: bigint,
  areaM2: string,
  periodDays: number,
): number {
  const areaMilli = toScaledInteger(areaM2);
  if (areaMilli <= 0n || periodDays <= 0) return 100;
  // §5: first round the actual period intensity to 0.1 kg/m², then
  // shorten the table thresholds for a period under one year.
  const tenths = (co2Grams * 10n + areaMilli / 2n) / areaMilli;
  const tableDays = BigInt(Math.min(periodDays, 365));
  const thresholds = [120n, 170n, 220n, 270n, 320n, 370n, 420n, 470n, 520n];
  const tier = thresholds.findIndex(
    (value) => tenths * 365n < value * tableDays,
  );
  if (tier >= 0) return 100 - tier * 10;
  return 5;
}

export function splitUnitAmountAcrossTenants(
  amountCents: bigint,
  unitId: string,
  tenants: Array<{ id: string; moveInDate: Date; moveOutDate: Date | null }>,
  periodStart: Date,
  periodEnd: Date,
  source: Omit<
    AllocationResult,
    "unitId" | "tenantId" | "periodStart" | "periodEnd" | "amountCents"
  >,
): { allocations: AllocationResult[]; vacancyCents: bigint } {
  const overlaps = tenants
    .map((tenant) => {
      const start =
        tenant.moveInDate > periodStart ? tenant.moveInDate : periodStart;
      const endCandidate = tenant.moveOutDate ?? periodEnd;
      const end = endCandidate < periodEnd ? endCandidate : periodEnd;
      return {
        tenant,
        start,
        end,
        days: end >= start ? daysInclusive(start, end) : 0,
      };
    })
    .filter((row) => row.days > 0);
  if (
    overlaps.some((row, i) =>
      overlaps.some(
        (other, j) =>
          i !== j && row.start <= other.end && row.end >= other.start,
      ),
    )
  )
    throw new Error(
      "Überlappende Mietverhältnisse müssen vor der Abrechnung korrigiert werden.",
    );
  const totalDays = daysInclusive(periodStart, periodEnd);
  const occupiedDays = overlaps.reduce((sum, row) => sum + row.days, 0);
  const weights = [
    ...overlaps.map((row) => BigInt(row.days)),
    BigInt(Math.max(0, totalDays - occupiedDays)),
  ];
  const shares = allocateCents(amountCents, weights);
  return {
    allocations: overlaps.map((row, index) => ({
      unitId,
      tenantId: row.tenant.id,
      periodStart: isoDay(row.start),
      periodEnd: isoDay(row.end),
      amountCents: shares[index].toString(),
      ...source,
    })),
    vacancyCents: shares[shares.length - 1] ?? 0n,
  };
}

export {
  allocateCents,
  calculateElectricityCostCents,
  calculateFifoConsumption,
  prorateMonthlyCents,
  toScaledInteger,
};
