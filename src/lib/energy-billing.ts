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
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())) /
        86_400_000
    ) + 1
  );
}

export function co2TenantPercent(
  co2Grams: bigint,
  areaM2: string,
  periodDays: number
): number {
  const areaMilli = toScaledInteger(areaM2);
  if (areaMilli <= 0n || periodDays <= 0) return 100;
  const tenthsKgPerM2Year =
    (co2Grams * 3650n * 1000n) /
    (areaMilli * BigInt(periodDays) * 1000n);
  const value = Number(tenthsKgPerM2Year) / 10;
  if (value < 12) return 100;
  if (value < 17) return 90;
  if (value < 22) return 80;
  if (value < 27) return 70;
  if (value < 32) return 60;
  if (value < 37) return 50;
  if (value < 42) return 40;
  if (value < 47) return 30;
  if (value < 52) return 20;
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
  >
): { allocations: AllocationResult[]; vacancyCents: bigint } {
  const overlaps = tenants
    .map((tenant) => {
      const start = tenant.moveInDate > periodStart ? tenant.moveInDate : periodStart;
      const endCandidate = tenant.moveOutDate ?? periodEnd;
      const end = endCandidate < periodEnd ? endCandidate : periodEnd;
      return { tenant, start, end, days: end >= start ? daysInclusive(start, end) : 0 };
    })
    .filter((row) => row.days > 0);
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
