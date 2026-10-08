import { apiHandler, requireAuth, jsonOk, ApiError } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { buildTenantStatement } from "@/lib/billing-statement";
import { categoryCode, BILLING_CATEGORIES } from "@/lib/invoice-categories";

export function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const period = await prisma.billingPeriod.findUnique({
      where: { id },
      include: {
        property: {
          include: {
            units: { include: { tenants: true } },
            heatingSystems: { include: { tanks: true } },
            electricityContracts: true,
          },
        },
        costs: true,
        calculationHeads: { include: { snapshot: true } },
        statementRevisions: { orderBy: { revision: "desc" } },
      },
    });
    if (!period) throw new ApiError("Abrechnung fehlt", 404);
    const all = await prisma.costCategory.findMany({
      orderBy: { sortOrder: "asc" },
    });
    const categories: Array<
      (typeof all)[number] & {
        label: string;
        kind: string;
        stale: boolean;
        preview: unknown;
      }
    > = BILLING_CATEGORIES.flatMap((definition) => {
      const category = all.find(
        (category) => categoryCode(category) === definition.code,
      );
      if (!category) return [];
      const head = period.calculationHeads.find(
        (head) => head.costCategoryId === category.id,
      );
      return [
        {
          ...category,
          code: definition.code,
          label: definition.name,
          kind: definition.kind,
          stale: head?.stale ?? false,
          preview: head ? JSON.parse(head.snapshot.resultJson) : null,
        },
      ];
    });
    for (const category of all.filter(
      (category) =>
        categoryCode(category) === "OTHER" &&
        period.costs.some(
          (cost) => cost.costCategoryId === category.id && cost.enabled,
        ),
    )) {
      const head = period.calculationHeads.find(
        (head) => head.costCategoryId === category.id,
      );
      categories.push({
        ...category,
        code: "OTHER",
        label: category.name,
        kind: "MANUAL",
        stale: head?.stale ?? false,
        preview: head ? JSON.parse(head.snapshot.resultJson) : null,
      });
    }
    const tenants = period.property.units.flatMap((unit) =>
      unit.tenants.filter(
        (tenant) =>
          tenant.moveInDate <= period.endDate &&
          (!tenant.moveOutDate || tenant.moveOutDate >= period.startDate),
      ),
    );
    const statements = await Promise.all(
      tenants.map(async (tenant) => {
        try {
          return {
            tenantId: tenant.id,
            statement: await buildTenantStatement(id, tenant.id),
            error: null,
          };
        } catch (error) {
          return {
            tenantId: tenant.id,
            statement: null,
            error:
              error instanceof Error
                ? error.message
                : "Berechnung unvollständig",
          };
        }
      }),
    );
    return jsonOk({
      period,
      categories,
      statements,
      locked:
        period.statementRevisions.length > 0 ||
        !!period.sentDate ||
        !!period.paidDate ||
        period.status === "SUPERSEDED",
    });
  });
}
