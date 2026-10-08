import { BILLING_CATEGORIES, categoryCode } from "@/lib/invoice-categories";
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
  draft?: boolean;
  billingPeriodId: string;
  startDate: string;
  endDate: string;
  property: { street: string; zip: string; city: string };
  unit: { id: string; name: string; areaM2: string | null; shares: number };
  tenant: {
    id: string;
    salutation: string;
    firstName: string;
    lastName: string;
    firstName2: string | null;
    lastName2: string | null;
  };
  categories: Array<{
    id: string;
    name: string;
    totalAmountCents: string;
    actualCents: string;
    prepaymentCents: string;
    differenceCents: string;
    allocations: Array<{
      amountCents: string;
      periodStart: string;
      periodEnd: string;
      calculationBasis: string;
      distributionKey: string;
    }>;
  }>;
  totalPropertyCostsCents: string;
  refundCents: string;
  totalActualCents: string;
  totalPrepaymentCents: string;
  balanceCents: string;
  heatingDetails: Record<string, unknown> | null;
  electricityDetails: Record<string, unknown> | null;
}

export async function buildTenantStatement(
  billingPeriodId: string,
  tenantId: string,
  options: {
    draft?: boolean;
    revision?: number;
    issuedOnly?: boolean;
    forIssue?: boolean;
  } = {},
): Promise<TenantStatement> {
  if (!options.draft) {
    const frozen = await prisma.statementRevision.findFirst({
      where: {
        billingPeriodId,
        tenantId,
        ...(options.revision ? { revision: options.revision } : {}),
      },
      orderBy: { revision: "desc" },
    });
    if (frozen) return JSON.parse(frozen.payloadJson) as TenantStatement;
    if (options.issuedOnly)
      throw new ApiError("Abrechnung ist noch nicht ausgestellt", 409);
    if (options.revision)
      throw new ApiError("Abrechnungsrevision nicht gefunden", 404);
  }
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: true,
      costs: { include: { costCategory: true } },
      calculationHeads: { include: { snapshot: true } },
      costAllocations: {
        where: { tenantId, snapshot: { activeHead: { isNot: null } } },
        include: { costCategory: true },
        orderBy: { periodStart: "asc" },
      },
      billingSnapshots: {
        where: { status: "APPLIED" },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: {
      unit: true,
      financialPeriods: {
        where: { supersededAt: null },
        include: { components: { include: { costCategory: true } } },
        orderBy: { validFrom: "asc" },
      },
    },
  });
  if (!period || !tenant || tenant.unit.propertyId !== period.propertyId)
    throw new ApiError("Abrechnung oder Mietverhältnis nicht gefunden", 404);
  const heads = period.calculationHeads;
  if (
    period.status === "SUPERSEDED" ||
    !heads.length ||
    heads.some((head) => head.stale) ||
    period.costs.some(
      (cost) =>
        cost.enabled &&
        !heads.some((head) => head.costCategoryId === cost.costCategoryId),
    )
  )
    throw new ApiError(
      "Abrechnung unvollständig oder veraltet: alle Kostenarten berechnen und bestätigen",
      409,
    );
  const configured = await prisma.costCategory.findMany();
  for (const required of BILLING_CATEGORIES) {
    const category = configured.find(
      (row) => categoryCode(row) === required.code,
    );
    if (!category || !heads.some((head) => head.costCategoryId === category.id))
      throw new ApiError(
        `${required.name}: Berechnung oder bestätigte Nullkosten fehlen`,
        409,
      );
  }
  const activeIds = new Set(heads.map((head) => head.snapshotId));
  const tenancy = overlap(
    tenant.moveInDate,
    tenant.moveOutDate ?? period.endDate,
    period.startDate,
    period.endDate,
  );
  if (!tenancy)
    throw new ApiError(
      "Das Mietverhältnis liegt nicht im Abrechnungszeitraum",
      400,
    );

  const actual = new Map<
    string,
    {
      name: string;
      total: bigint;
      allocations: TenantStatement["categories"][number]["allocations"];
    }
  >();
  for (const row of period.costAllocations.filter(
    (row) => row.snapshotId && activeIds.has(row.snapshotId),
  )) {
    const current = actual.get(row.costCategoryId) ?? {
      name: row.costCategory.name,
      total: 0n,
      allocations: [],
    };
    current.total += row.amountCents;
    current.allocations.push({
      amountCents: row.amountCents.toString(),
      periodStart: isoDay(row.periodStart),
      periodEnd: isoDay(row.periodEnd),
      calculationBasis: row.calculationBasis,
      distributionKey: row.distributionKey,
    });
    actual.set(row.costCategoryId, current);
  }
  const coverage = tenant.financialPeriods
    .map((financial) =>
      overlap(
        financial.validFrom,
        financial.validTo ?? tenancy.end,
        tenancy.start,
        tenancy.end,
      ),
    )
    .filter((range): range is { start: Date; end: Date } => range !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  let expected = tenancy.start.getTime();
  for (const range of coverage) {
    if (range.start.getTime() !== expected)
      throw new ApiError("Finanzperioden haben Lücken oder Überlappungen", 409);
    expected = range.end.getTime() + 86_400_000;
  }
  if (expected <= tenancy.end.getTime())
    throw new ApiError(
      "Finanzperioden decken das Mietverhältnis nicht ab",
      409,
    );
  const prepaid = new Map<string, { name: string; total: bigint }>();
  for (const financial of tenant.financialPeriods) {
    const section = overlap(
      financial.validFrom,
      financial.validTo ?? tenancy.end,
      tenancy.start,
      tenancy.end,
    );
    if (!section) continue;
    for (const component of financial.components) {
      const current = prepaid.get(component.costCategoryId) ?? {
        name: component.costCategory.name,
        total: 0n,
      };
      current.total += prorateMonthlyCents(
        component.monthlyAmountCents,
        section.start,
        section.end,
      );
      prepaid.set(component.costCategoryId, current);
    }
  }
  const categoryIds = [
    ...new Set([...actual.keys(), ...prepaid.keys()]),
  ].sort();
  const categories = categoryIds.map((id) => {
    const actualRow = actual.get(id);
    const prepaidRow = prepaid.get(id);
    const actualCents = actualRow?.total ?? 0n;
    const prepaymentCents = prepaidRow?.total ?? 0n;
    const head = heads.find((head) => head.costCategoryId === id);
    const totalAmountCents = head
      ? String(JSON.parse(head.snapshot.resultJson).totalAmountCents)
      : "0";
    return {
      id,
      totalAmountCents,
      name: actualRow?.name ?? prepaidRow?.name ?? id,
      actualCents: actualCents.toString(),
      prepaymentCents: prepaymentCents.toString(),
      differenceCents: (actualCents - prepaymentCents).toString(),
      allocations: actualRow?.allocations ?? [],
    };
  });
  const totalActual = categories.reduce(
    (sum, row) => sum + BigInt(row.actualCents),
    0n,
  );
  const totalPrepayment = categories.reduce(
    (sum, row) => sum + BigInt(row.prepaymentCents),
    0n,
  );
  const snapshotDetails = (kind: string) => {
    const row = heads
      .map((head) => head.snapshot)
      .find((item) => item.kind === kind);
    if (!row) return null;
    try {
      return (
        (JSON.parse(row.resultJson) as { details?: Record<string, unknown> })
          .details ?? null
      );
    } catch {
      return null;
    }
  };
  return {
    draft: !options.forIssue,
    billingPeriodId,
    startDate: isoDay(period.startDate),
    endDate: isoDay(period.endDate),
    property: {
      street: period.property.street,
      zip: period.property.zip,
      city: period.property.city,
    },
    unit: {
      id: tenant.unit.id,
      name: tenant.unit.name,
      areaM2: tenant.unit.areaM2?.toString() ?? null,
      shares: tenant.unit.shares,
    },
    tenant: {
      id: tenant.id,
      salutation: tenant.salutation,
      firstName: tenant.firstName,
      lastName: tenant.lastName,
      firstName2: tenant.firstName2,
      lastName2: tenant.lastName2,
    },
    categories,
    totalPropertyCostsCents: categories
      .reduce((sum, row) => sum + BigInt(row.totalAmountCents), 0n)
      .toString(),
    refundCents: (totalPrepayment - totalActual).toString(),
    totalActualCents: totalActual.toString(),
    totalPrepaymentCents: totalPrepayment.toString(),
    balanceCents: (totalActual - totalPrepayment).toString(),
    heatingDetails: snapshotDetails("HEATING_OIL"),
    electricityDetails: snapshotDetails("ELECTRICITY"),
  };
}

export async function buildAllTenantStatements(billingPeriodId: string) {
  const issued = await prisma.statementRevision.findMany({
    where: { billingPeriodId },
    orderBy: { revision: "desc" },
  });
  if (issued.length) {
    const seen = new Set<string>();
    return issued
      .filter((row) => {
        if (seen.has(row.tenantId)) return false;
        seen.add(row.tenantId);
        return true;
      })
      .map((row) => JSON.parse(row.payloadJson) as TenantStatement);
  }
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: { include: { units: { include: { tenants: true } } } },
    },
  });
  if (!period) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
  const ids = period.property.units.flatMap((unit) =>
    unit.tenants
      .filter(
        (tenant) =>
          tenant.moveInDate <= period.endDate &&
          (!tenant.moveOutDate || tenant.moveOutDate >= period.startDate),
      )
      .map((tenant) => tenant.id),
  );
  return Promise.all(
    ids.map((id) => buildTenantStatement(billingPeriodId, id)),
  );
}

export function distributeRoundingExample(total: bigint, weights: bigint[]) {
  return allocateCents(total, weights);
}
