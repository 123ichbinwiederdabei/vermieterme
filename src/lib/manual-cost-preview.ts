import { ApiError } from "@/lib/api-utils";
import { allocateCents, calculateAnnualAreaRateCents, fromScaledInteger, serializeExact, toScaledInteger } from "@/lib/billing-v2";
import { daysInclusive, isoDay, splitUnitAmountAcrossTenants } from "@/lib/energy-billing";
import { prisma } from "@/lib/prisma";

export type ManualCostPreview = {
  kind: "MANUAL";
  billingPeriodId: string;
  costCategoryId: string;
  totalAmountCents: string;
  tenantAmountCents: string;
  landlordAmountCents: string;
  vacancyAmountCents: string;
  allocations: ReturnType<typeof splitUnitAmountAcrossTenants>["allocations"];
  details: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
  sourceFingerprint: string;
};

function prorateAnnual(amount: bigint, start: Date, end: Date): bigint {
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
  let result = 0n;
  while (cursor <= end) {
    const yearEnd = new Date(Date.UTC(cursor.getUTCFullYear(), 11, 31));
    const sectionStart = cursor < start ? start : cursor;
    const sectionEnd = yearEnd < end ? yearEnd : end;
    const yearDays = daysInclusive(cursor, yearEnd);
    const sectionDays = daysInclusive(sectionStart, sectionEnd);
    result += (amount * BigInt(sectionDays) + BigInt(Math.floor(yearDays / 2))) / BigInt(yearDays);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear() + 1, 0, 1));
  }
  return result;
}

function hasFinancialCoverage(tenant: { moveInDate: Date; moveOutDate: Date | null; financialPeriods: Array<{ validFrom: Date; validTo: Date | null }> }, start: Date, end: Date) {
  const tenancyStart = tenant.moveInDate > start ? tenant.moveInDate : start;
  const tenancyEnd = (tenant.moveOutDate ?? end) < end ? (tenant.moveOutDate ?? end) : end;
  if (tenancyEnd < tenancyStart) return true;
  const periods = tenant.financialPeriods
    .map((row) => ({ start: row.validFrom > tenancyStart ? row.validFrom : tenancyStart, end: (row.validTo ?? tenancyEnd) < tenancyEnd ? (row.validTo ?? tenancyEnd) : tenancyEnd }))
    .filter((row) => row.end >= row.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  let expected = tenancyStart.getTime();
  for (const period of periods) {
    if (period.start.getTime() > expected) return false;
    expected = Math.max(expected, period.end.getTime() + 86_400_000);
  }
  return expected > tenancyEnd.getTime();
}

export async function buildManualCostPreview(billingPeriodId: string, costCategoryId: string): Promise<ManualCostPreview> {
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: { include: { propertyTaxSetting: true, units: { include: { tenants: { include: { financialPeriods: { where: { supersededAt: null } } } } } } } },
      costs: { where: { costCategoryId }, include: { costCategory: true } },
    },
  });
  if (!period) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
  const cost = period.costs[0];
  const category = cost?.costCategory ?? await prisma.costCategory.findUnique({ where: { id: costCategoryId } });
  if (!category || category.calculationType !== "MANUAL") throw new ApiError("Manuelle Kostenart nicht gefunden", 404);
  const blockers: string[] = [];
  const warnings: string[] = [];
  // Grundsteuer is intentionally tied to this object-level setting.  Older
  // installations may still carry the legacy "Manuell" category key.
  const key = category.name === "Grundsteuer" ? "Wohnfläche" : (cost?.distributionKeyOverride ?? category.distributionKey);
  let allocatable = cost?.totalAmountCents ?? 0n;
  let assessment = allocatable;
  let source: Record<string, unknown> = { source: "MANUAL_COST", distributionKey: key };

  if (category.name === "Grundsteuer") {
    const setting = period.property.propertyTaxSetting;
    if (!setting) blockers.push("Grundsteuerumlage für das Objekt fehlt.");
    else if (setting.allocationMethod === "ALLOCATABLE_AMOUNT") {
      if (setting.annualAllocatableAmountCents == null) blockers.push("Umlagefähiger Grundsteuer-Wohnanteil fehlt.");
      else allocatable = prorateAnnual(setting.annualAllocatableAmountCents, period.startDate, period.endDate);
      assessment = setting.annualAssessmentCents == null ? allocatable : prorateAnnual(setting.annualAssessmentCents, period.startDate, period.endDate);
      source = { source: "PROPERTY_TAX_SETTING", method: setting.allocationMethod, annualAllocatableAmountCents: setting.annualAllocatableAmountCents?.toString() ?? null, annualAssessmentCents: setting.annualAssessmentCents?.toString() ?? null, note: setting.allocationNote };
    } else if (setting.allocationMethod === "RATE_PER_M2") {
      if (setting.annualRateMicroCentsPerM2 == null) blockers.push("Jährlicher Grundsteuer-Satz je m² fehlt.");
      const totalArea = period.property.units.reduce((sum, unit) => sum + toScaledInteger(unit.areaM2?.toString() ?? "0"), 0n);
      const annual = setting.annualRateMicroCentsPerM2 == null
        ? 0n
        : calculateAnnualAreaRateCents(setting.annualRateMicroCentsPerM2, fromScaledInteger(totalArea));
      allocatable = prorateAnnual(annual, period.startDate, period.endDate);
      assessment = setting.annualAssessmentCents == null ? allocatable : prorateAnnual(setting.annualAssessmentCents, period.startDate, period.endDate);
      source = { source: "PROPERTY_TAX_SETTING", method: setting.allocationMethod, annualRateMicroCentsPerM2: setting.annualRateMicroCentsPerM2?.toString() ?? null, annualAssessmentCents: setting.annualAssessmentCents?.toString() ?? null, note: setting.allocationNote };
    } else blockers.push("Ungültige Grundsteuer-Umlagemethode.");
  }

  const units = period.property.units;
  const weights = units.map((unit) => {
    if (key === "Wohnfläche") return toScaledInteger(unit.areaM2?.toString() ?? "0");
    if (key === "MEA") return BigInt(unit.shares);
    if (key === "Gleicher Anteil") return 1n;
    return 0n;
  });
  if (!(["Wohnfläche", "MEA", "Gleicher Anteil"] as string[]).includes(key)) blockers.push(`Der Verteilerschlüssel „${key}“ kann nicht automatisch abgerechnet werden.`);
  if (key === "Wohnfläche") for (const unit of units) if (toScaledInteger(unit.areaM2?.toString() ?? "0") <= 0n) blockers.push(`Wohnfläche für ${unit.name} fehlt.`);
  for (const unit of units) for (const tenant of unit.tenants) {
    if (!hasFinancialCoverage(tenant, period.startDate, period.endDate)) blockers.push(`Miet-/NK-Finanzperioden für ${tenant.firstName} ${tenant.lastName} decken den Abrechnungszeitraum nicht lückenlos ab.`);
  }
  const unitAmounts = allocateCents(allocatable, weights);
  const allocations: ManualCostPreview["allocations"] = [];
  let vacancy = 0n;
  units.forEach((unit, index) => {
    const split = splitUnitAmountAcrossTenants(unitAmounts[index] ?? 0n, unit.id, unit.tenants, period.startDate, period.endDate, {
      distributionKey: key,
      calculationBasis: key === "Wohnfläche" ? `${unit.areaM2?.toString() ?? "0"} m² von ${fromScaledInteger(weights.reduce((sum, value) => sum + value, 0n))} m²` : key,
      sourceType: "MANUAL_COST",
      sourceReferenceId: costCategoryId,
    });
    allocations.push(...split.allocations); vacancy += split.vacancyCents;
  });
  const tenantAmount = allocations.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
  const nonAllocatable = assessment > allocatable ? assessment - allocatable : 0n;
  return {
    kind: "MANUAL", billingPeriodId, costCategoryId, totalAmountCents: assessment.toString(), tenantAmountCents: tenantAmount.toString(), landlordAmountCents: (nonAllocatable + vacancy).toString(), vacancyAmountCents: vacancy.toString(), allocations,
    details: { ...source, allocatableAmountCents: allocatable.toString(), nonAllocatableLandlordCents: nonAllocatable.toString(), unitWeights: units.map((unit, index) => ({ unitId: unit.id, unitName: unit.name, weight: weights[index].toString(), amountCents: (unitAmounts[index] ?? 0n).toString() })) },
    blockers, warnings, sourceFingerprint: JSON.stringify(serializeExact({ source, period: [isoDay(period.startDate), isoDay(period.endDate)], weights: weights.map(String), allocatable })),
  };
}
