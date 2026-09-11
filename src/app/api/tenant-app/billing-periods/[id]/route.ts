import { NextRequest } from "next/server";
import { apiHandler, jsonOk } from "@/lib/api-utils";
import { requireTenantAuth } from "@/lib/tenant-auth";
import { buildTenantStatement } from "@/lib/billing-statement";
import { prisma } from "@/lib/prisma";

export function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return apiHandler(async () => {
    const { tenantId } = await requireTenantAuth();
    const { id } = await params;
    const statement = await buildTenantStatement(id, tenantId);
    const period = await prisma.billingPeriod.findUnique({ where: { id }, include: { documents: true } });
    return jsonOk({
      id, startDate: statement.startDate, endDate: statement.endDate,
      billingDate: period?.billingDate ?? null, sentDate: period?.sentDate ?? null, paidDate: period?.paidDate ?? null,
      property: statement.property,
      costs: statement.categories.map((row) => ({ id: row.id, category: row.name, distributionKey: row.allocations[0]?.distributionKey ?? "Zugeordnet", totalAmount: Number(row.actualCents) / 100, unitAmount: Number(row.actualCents) / 100, amountCents: row.actualCents, prepaymentCents: row.prepaymentCents })),
      prepayments: [{ id: tenantId, monthlyAmount: 0 }],
      totals: { totalCosts: Number(statement.totalActualCents) / 100, totalUnitCosts: Number(statement.totalActualCents) / 100, totalPrepayment: Number(statement.totalPrepaymentCents) / 100, difference: Number(BigInt(statement.totalPrepaymentCents) - BigInt(statement.totalActualCents)) / 100, totalUnitCostsCents: statement.totalActualCents, totalPrepaymentCents: statement.totalPrepaymentCents, differenceCents: (BigInt(statement.totalPrepaymentCents) - BigInt(statement.totalActualCents)).toString() },
      documents: period?.documents ?? [], heatingDetails: statement.heatingDetails, electricityDetails: statement.electricityDetails,
    });
  });
}
