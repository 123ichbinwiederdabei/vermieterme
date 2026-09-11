import { prisma } from "@/lib/prisma";
import { allocateCents, prorateMonthlyCents } from "@/lib/billing-v2";
import { isoDay } from "@/lib/energy-billing";
import { ApiError } from "@/lib/api-utils";

function overlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  return end >= start ? { start, end } : null;
}

export interface TenantStatement {
  billingPeriodId: string;
  startDate: string;
  endDate: string;
  property: { street: string; zip: string; city: string };
  unit: { id: string; name: string; areaM2: string | null; shares: number };
  tenant: { id: string; salutation: string; firstName: string; lastName: string; firstName2: string | null; lastName2: string | null };
  categories: Array<{ id: string; name: string; actualCents: string; prepaymentCents: string; differenceCents: string; allocations: Array<{ amountCents: string; periodStart: string; periodEnd: string; calculationBasis: string; distributionKey: string }> }>;
  totalActualCents: string;
  totalPrepaymentCents: string;
  balanceCents: string;
  heatingDetails: Record<string, unknown> | null;
  electricityDetails: Record<string, unknown> | null;
}

export async function buildTenantStatement(billingPeriodId: string, tenantId: string): Promise<TenantStatement> {
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: true,
      costAllocations: { where: { tenantId }, include: { costCategory: true }, orderBy: { periodStart: "asc" } },
      billingSnapshots: { where: { status: "APPLIED" }, orderBy: { createdAt: "desc" } },
    },
  });
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { unit: true, financialPeriods: { where: { supersededAt: null }, include: { components: { include: { costCategory: true } } }, orderBy: { validFrom: "asc" } } } });
  if (!period || !tenant || tenant.unit.propertyId !== period.propertyId) throw new ApiError("Abrechnung oder Mietverhältnis nicht gefunden", 404);
  const tenancy = overlap(tenant.moveInDate, tenant.moveOutDate ?? period.endDate, period.startDate, period.endDate);
  if (!tenancy) throw new ApiError("Das Mietverhältnis liegt nicht im Abrechnungszeitraum", 400);

  const actual = new Map<string, { name: string; total: bigint; allocations: TenantStatement["categories"][number]["allocations"] }>();
  for (const row of period.costAllocations) {
    const current = actual.get(row.costCategoryId) ?? { name: row.costCategory.name, total: 0n, allocations: [] };
    current.total += row.amountCents;
    current.allocations.push({ amountCents: row.amountCents.toString(), periodStart: isoDay(row.periodStart), periodEnd: isoDay(row.periodEnd), calculationBasis: row.calculationBasis, distributionKey: row.distributionKey });
    actual.set(row.costCategoryId, current);
  }
  const prepaid = new Map<string, { name: string; total: bigint }>();
  for (const financial of tenant.financialPeriods) {
    const section = overlap(financial.validFrom, financial.validTo ?? tenancy.end, tenancy.start, tenancy.end);
    if (!section) continue;
    for (const component of financial.components) {
      const current = prepaid.get(component.costCategoryId) ?? { name: component.costCategory.name, total: 0n };
      current.total += prorateMonthlyCents(component.monthlyAmountCents, section.start, section.end);
      prepaid.set(component.costCategoryId, current);
    }
  }
  const categoryIds = [...new Set([...actual.keys(), ...prepaid.keys()])].sort();
  const categories = categoryIds.map((id) => {
    const actualRow = actual.get(id); const prepaidRow = prepaid.get(id);
    const actualCents = actualRow?.total ?? 0n; const prepaymentCents = prepaidRow?.total ?? 0n;
    return { id, name: actualRow?.name ?? prepaidRow?.name ?? id, actualCents: actualCents.toString(), prepaymentCents: prepaymentCents.toString(), differenceCents: (actualCents - prepaymentCents).toString(), allocations: actualRow?.allocations ?? [] };
  });
  const totalActual = categories.reduce((sum, row) => sum + BigInt(row.actualCents), 0n);
  const totalPrepayment = categories.reduce((sum, row) => sum + BigInt(row.prepaymentCents), 0n);
  const snapshotDetails = (kind: string) => {
    const row = period.billingSnapshots.find((item) => item.kind === kind);
    if (!row) return null;
    try { return (JSON.parse(row.resultJson) as { details?: Record<string, unknown> }).details ?? null; } catch { return null; }
  };
  return {
    billingPeriodId, startDate: isoDay(period.startDate), endDate: isoDay(period.endDate),
    property: { street: period.property.street, zip: period.property.zip, city: period.property.city },
    unit: { id: tenant.unit.id, name: tenant.unit.name, areaM2: tenant.unit.areaM2?.toString() ?? null, shares: tenant.unit.shares },
    tenant: { id: tenant.id, salutation: tenant.salutation, firstName: tenant.firstName, lastName: tenant.lastName, firstName2: tenant.firstName2, lastName2: tenant.lastName2 },
    categories, totalActualCents: totalActual.toString(), totalPrepaymentCents: totalPrepayment.toString(), balanceCents: (totalActual - totalPrepayment).toString(),
    heatingDetails: snapshotDetails("HEATING_OIL"), electricityDetails: snapshotDetails("ELECTRICITY"),
  };
}

export async function buildAllTenantStatements(billingPeriodId: string) {
  const period = await prisma.billingPeriod.findUnique({ where: { id: billingPeriodId }, include: { property: { include: { units: { include: { tenants: true } } } } } });
  if (!period) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
  const ids = period.property.units.flatMap((unit) => unit.tenants.filter((tenant) => tenant.moveInDate <= period.endDate && (!tenant.moveOutDate || tenant.moveOutDate >= period.startDate)).map((tenant) => tenant.id));
  return Promise.all(ids.map((id) => buildTenantStatement(billingPeriodId, id)));
}

export function distributeRoundingExample(total: bigint, weights: bigint[]) { return allocateCents(total, weights); }
