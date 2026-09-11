import { apiHandler, jsonOk } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { requireTenantAuth } from "@/lib/tenant-auth";
import { buildTenantStatement } from "@/lib/billing-statement";

export function GET() {
  return apiHandler(async () => {
    const { tenantId } = await requireTenantAuth();
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { unit: true } });
    if (!tenant) return jsonOk([]);
    const periods = await prisma.billingPeriod.findMany({ where: { propertyId: tenant.unit.propertyId }, orderBy: { startDate: "desc" } });
    const statements = await Promise.all(periods.map((period) => buildTenantStatement(period.id, tenantId)));
    return jsonOk(statements.map((statement) => ({
      id: statement.billingPeriodId,
      startDate: statement.startDate,
      endDate: statement.endDate,
      billingDate: periods.find((row) => row.id === statement.billingPeriodId)?.billingDate ?? null,
      sentDate: periods.find((row) => row.id === statement.billingPeriodId)?.sentDate ?? null,
      paidDate: periods.find((row) => row.id === statement.billingPeriodId)?.paidDate ?? null,
      property: statement.property,
      totalUnitCosts: Number(statement.totalActualCents) / 100,
      totalPrepayment: Number(statement.totalPrepaymentCents) / 100,
      difference: Number(BigInt(statement.totalPrepaymentCents) - BigInt(statement.totalActualCents)) / 100,
      totalUnitCostsCents: statement.totalActualCents,
      totalPrepaymentCents: statement.totalPrepaymentCents,
      differenceCents: (BigInt(statement.totalPrepaymentCents) - BigInt(statement.totalActualCents)).toString(),
    })));
  });
}
