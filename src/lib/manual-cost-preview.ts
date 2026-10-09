import { configuredAllocation } from "@/lib/configured-allocation";
import { ApiError } from "@/lib/api-error";
import {
  calculateAnnualAreaRateCents,
  fromScaledInteger,
  serializeExact,
  toScaledInteger,
} from "@/lib/billing-v2";
import {
  daysInclusive,
  isoDay,
} from "@/lib/energy-billing";
import { categoryCode, eligibleForCategory } from "@/lib/invoice-categories";
import { allocateServiceLineToPeriod } from "@/lib/cost-invoice";
import { invoicePool } from "@/lib/invoice-pool";
import { euroToCents } from "@/lib/money";
import { prisma } from "@/lib/prisma";

export type ManualCostPreview = {
  kind: "MANUAL";
  billingPeriodId: string;
  costCategoryId: string;
  totalAmountCents: string;
  tenantAmountCents: string;
  landlordAmountCents: string;
  vacancyAmountCents: string;
  allocations: import("@/lib/energy-billing").AllocationResult[];
  details: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
  sourceFingerprint: string;
  sourceData?: unknown;
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
    result +=
      (amount * BigInt(sectionDays) + BigInt(Math.floor(yearDays / 2))) /
      BigInt(yearDays);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear() + 1, 0, 1));
  }
  return result;
}

function hasFinancialCoverage(
  tenant: {
    moveInDate: Date;
    moveOutDate: Date | null;
    financialPeriods: Array<{ validFrom: Date; validTo: Date | null }>;
  },
  start: Date,
  end: Date,
) {
  const tenancyStart = tenant.moveInDate > start ? tenant.moveInDate : start;
  const tenancyEnd =
    (tenant.moveOutDate ?? end) < end ? (tenant.moveOutDate ?? end) : end;
  if (tenancyEnd < tenancyStart) return true;
  const periods = tenant.financialPeriods
    .map((row) => ({
      start: row.validFrom > tenancyStart ? row.validFrom : tenancyStart,
      end:
        (row.validTo ?? tenancyEnd) < tenancyEnd
          ? (row.validTo ?? tenancyEnd)
          : tenancyEnd,
    }))
    .filter((row) => row.end >= row.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  let expected = tenancyStart.getTime();
  for (const period of periods) {
    if (period.start.getTime() > expected) return false;
    expected = Math.max(expected, period.end.getTime() + 86_400_000);
  }
  return expected > tenancyEnd.getTime();
}

export async function buildManualCostPreview(
  billingPeriodId: string,
  costCategoryId: string,
): Promise<ManualCostPreview> {
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: {
        include: {
          propertyTaxSetting: true,
          units: {
            include: {
              tenants: {
                include: {
                  financialPeriods: { where: { supersededAt: null } },
                },
              },
            },
          },
        },
      },
      costs: { where: { costCategoryId }, include: { costCategory: true } },
    },
  });
  if (!period) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
  const cost = period.costs[0];
  const category =
    cost?.costCategory ??
    (await prisma.costCategory.findUnique({ where: { id: costCategoryId } }));
  if (!category || category.calculationType !== "MANUAL")
    throw new ApiError("Manuelle Kostenart nicht gefunden", 404);
  const blockers: string[] = [];
  const warnings: string[] = [];
  // Grundsteuer is intentionally tied to this object-level setting.  Older
  // installations may still carry the legacy "Manuell" category key.
  const code = categoryCode(category);
  const key =
    code === "PROPERTY_TAX" || code === "WATER"
      ? "Wohnfläche"
      : code === "WASTE"
        ? "Gleicher Anteil"
        : (cost?.distributionKeyOverride ?? category.distributionKey);
  let allocatable =
    cost?.totalAmountCents ??
    (cost?.totalAmount ? BigInt(euroToCents(String(cost.totalAmount))) : 0n);
  let assessment = allocatable;
  let charges: import("@/lib/configured-allocation").AllocationCharge[] | undefined;
  let source: Record<string, unknown> = {
    source: "MANUAL_COST",
    distributionKey: key,
  };

  const units = period.property.units.filter(
    (unit) => code !== "PROPERTY_TAX" || !unit.ownerOccupied,
  );
  if (code === "PROPERTY_TAX") {
    const setting = period.property.propertyTaxSetting;
    if (!setting) blockers.push("Grundsteuerumlage für das Objekt fehlt.");
    else if (setting.allocationMethod === "ALLOCATABLE_AMOUNT") {
      if (setting.annualAllocatableAmountCents == null)
        blockers.push("Umlagefähiger Grundsteuer-Wohnanteil fehlt.");
      else
        allocatable = prorateAnnual(
          setting.annualAllocatableAmountCents,
          period.startDate,
          period.endDate,
        );
      assessment =
        setting.annualAssessmentCents == null
          ? allocatable
          : prorateAnnual(
              setting.annualAssessmentCents,
              period.startDate,
              period.endDate,
            );
      source = {
        source: "PROPERTY_TAX_SETTING",
        method: setting.allocationMethod,
        annualAllocatableAmountCents:
          setting.annualAllocatableAmountCents?.toString() ?? null,
        annualAssessmentCents:
          setting.annualAssessmentCents?.toString() ?? null,
        note: setting.allocationNote,
      };
    } else if (setting.allocationMethod === "RATE_PER_M2") {
      if (setting.annualRateMicroCentsPerM2 == null)
        blockers.push("Jährlicher Grundsteuer-Satz je m² fehlt.");
      const totalArea = units.reduce(
        (sum, unit) => sum + toScaledInteger(unit.areaM2?.toString() ?? "0"),
        0n,
      );
      const annual =
        setting.annualRateMicroCentsPerM2 == null
          ? 0n
          : calculateAnnualAreaRateCents(
              setting.annualRateMicroCentsPerM2,
              fromScaledInteger(totalArea),
            );
      allocatable = prorateAnnual(annual, period.startDate, period.endDate);
      assessment =
        setting.annualAssessmentCents == null
          ? allocatable
          : prorateAnnual(
              setting.annualAssessmentCents,
              period.startDate,
              period.endDate,
            );
      source = {
        source: "PROPERTY_TAX_SETTING",
        method: setting.allocationMethod,
        annualRateMicroCentsPerM2:
          setting.annualRateMicroCentsPerM2?.toString() ?? null,
        annualAssessmentCents:
          setting.annualAssessmentCents?.toString() ?? null,
        note: setting.allocationNote,
      };
    } else blockers.push("Ungültige Grundsteuer-Umlagemethode.");
  }

  if (category.code === "PROPERTY_TAX") {
    const pool = await invoicePool(
      period.propertyId,
      billingPeriodId,
      costCategoryId,
      code,
      period.startDate,
      period.endDate,
    );
    if (!pool.invoices.length)
      blockers.push(
        "Grundsteuerbescheid und belegte Berechnung des Mietwohnanteils fehlen.",
      );
    else {
      blockers.push(...pool.blockers);
      allocatable = 0n;
      assessment = 0n;
      for (const invoice of pool.invoices) {
        const data = JSON.parse(invoice.dataJson) as Record<string, string>;
        if (!data.annualAllocatableAmountCents || !data.taxBasisNote?.trim())
          blockers.push(
            "Bestätigter Mietwohnanteil mit Berechnungsnachweis fehlt.",
          );
        allocatable += allocateServiceLineToPeriod(
          BigInt(data.annualAllocatableAmountCents || "0"),
          invoice.servicePeriodStart,
          invoice.servicePeriodEnd,
          period.startDate,
          period.endDate,
        );
        assessment += allocateServiceLineToPeriod(
          invoice.totalAmountCents,
          invoice.servicePeriodStart,
          invoice.servicePeriodEnd,
          period.startDate,
          period.endDate,
        );
      }
      source = {
        source: "PROPERTY_TAX_INVOICES",
        invoices: serializeExact(pool.invoices),
      };
    }
  }
  if (code !== "PROPERTY_TAX") {
    const pool = await invoicePool(
      period.propertyId,
      billingPeriodId,
      costCategoryId,
      code,
      period.startDate,
      period.endDate,
    );
    if (pool.invoices.length) {
      allocatable = pool.eligible;
      charges = pool.invoices.flatMap((invoice) => invoice.lines.filter((line) => eligibleForCategory(code, line)).map((line) => ({ amountCents: line.amountCents, start: invoice.servicePeriodStart!, end: invoice.servicePeriodEnd! })));
      assessment = pool.eligible + pool.excluded;
      source = { ...source, invoices: serializeExact(pool.invoices) };
      blockers.push(...pool.blockers);
    } else { assessment = allocatable; if (allocatable !== 0n) blockers.push("Originalbeleg für Kosten fehlt."); }
  }
  if (allocatable > assessment)
    blockers.push(
      "Umlagefähiger Grundsteuerbetrag überschreitet den Bescheid.",
    );
  for (const unit of units)
      if (toScaledInteger(unit.areaM2?.toString() ?? "0") <= 0n)
        blockers.push(`Wohnfläche für ${unit.name} fehlt.`);
  for (const unit of units)
    for (const tenant of unit.tenants) {
      if (!hasFinancialCoverage(tenant, period.startDate, period.endDate))
        blockers.push(
          `Miet-/NK-Finanzperioden für ${tenant.firstName} ${tenant.lastName} decken den Abrechnungszeitraum nicht lückenlos ab.`,
        );
    }
  let resolved: Awaited<ReturnType<typeof configuredAllocation>> | undefined;
  try {
    resolved = await configuredAllocation({ propertyId: period.propertyId, categoryId: costCategoryId, units, start: period.startDate, end: period.endDate, amountCents: allocatable, sourceType: "MANUAL_COST", charges, legacyMethod: key === "Gleicher Anteil" ? "FIXED_SHARES" : "AREA" });
    warnings.push(...resolved.warnings);
  } catch (error) { blockers.push(error instanceof Error ? error.message : "Verteilung fehlgeschlagen"); }
  const allocations = resolved?.allocations ?? [];
  const vacancy = resolved?.vacancyAmountCents ?? 0n;
  const tenantAmount = resolved?.tenantAmountCents ?? 0n;
  const ownerAmount = resolved?.landlordOwnerAmountCents ?? 0n;
  const nonAllocatable =
    assessment > allocatable ? assessment - allocatable : 0n;
  return {
    kind: "MANUAL",
    billingPeriodId,
    costCategoryId,
    totalAmountCents: assessment.toString(),
    tenantAmountCents: tenantAmount.toString(),
    landlordAmountCents: (nonAllocatable + vacancy + ownerAmount).toString(),
    vacancyAmountCents: vacancy.toString(),
    allocations,
    details: {
      ...source,
      landlordOwnerAmountCents: ownerAmount.toString(),
      rules: serializeExact(resolved?.rules ?? []),
      allocatableAmountCents: allocatable.toString(),
      nonAllocatableLandlordCents: nonAllocatable.toString(),
      unitWeights: units.map((unit) => ({
        unitId: unit.id,
        unitName: unit.name,
        weight: resolved?.unitDetails.find((row) => row.unitId === unit.id)?.weight || "0",
        amountCents: resolved?.unitDetails.find((row) => row.unitId === unit.id)?.amountCents ?? "0",
      })),
    },
    blockers,
    warnings,
    sourceFingerprint: JSON.stringify(
      serializeExact({
        source,
        period: [isoDay(period.startDate), isoDay(period.endDate)],
        units,
        rules: resolved?.rules, states: resolved?.states, consumptionEvidence: resolved?.consumptionEvidence,
        resolvedRules: resolved?.rules,
        resolvedStates: resolved?.states,
        allocatable,
      }),
    ),
    sourceData: serializeExact({
      source,
      units,
      allocatable,
      assessment,
      period: [isoDay(period.startDate), isoDay(period.endDate)],
    }),
  };
}
