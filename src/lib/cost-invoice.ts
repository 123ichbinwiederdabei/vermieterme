export const SMALL_WASTEWATER_CATEGORY = "Entwässerung – Kleinkläranlage";

const ELIGIBLE = new Set(["WARTUNG", "PRÜFUNG", "BETRIEBSSTROM", "SCHLAMMABFUHR"]);

export function isEligibleInvoiceLine(line: { classification: string; confirmedRunningExpense: boolean }) {
  return ELIGIBLE.has(line.classification) || (line.classification === "SONSTIGES" && line.confirmedRunningExpense);
}

function utcDay(value: Date) {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/**
 * Deterministic daily-cent allocation. The first remaining service days get
 * one extra cent, so any grouping of days still sums exactly to the invoice
 * line total without relying on calculation order.
 */
export function allocateServiceLineToPeriod(
  amountCents: bigint,
  serviceStart: Date | null,
  serviceEnd: Date | null,
  periodStart: Date,
  periodEnd: Date,
) {
  if (!serviceStart || !serviceEnd) return amountCents;
  const start = utcDay(serviceStart);
  const end = utcDay(serviceEnd);
  const periodFrom = utcDay(periodStart);
  const periodTo = utcDay(periodEnd);
  if (end < start) throw new Error("Leistungszeitraum ist ungültig.");
  const overlapFrom = Math.max(start, periodFrom);
  const overlapTo = Math.min(end, periodTo);
  if (overlapTo < overlapFrom) return 0n;
  const dayMs = 86_400_000;
  const allDays = BigInt((end - start) / dayMs + 1);
  const coveredDays = BigInt((overlapTo - overlapFrom) / dayMs + 1);
  const base = amountCents / allDays;
  const remainder = amountCents % allDays;
  if (remainder === 0n) return base * coveredDays;
  const extraEnd = start + (Number(remainder) - 1) * dayMs;
  const extraFrom = Math.max(overlapFrom, start);
  const extraTo = Math.min(overlapTo, extraEnd);
  const earlyDaysCovered = extraTo < extraFrom ? 0n : BigInt((extraTo - extraFrom) / dayMs + 1);
  return base * coveredDays + earlyDaysCovered;
}
