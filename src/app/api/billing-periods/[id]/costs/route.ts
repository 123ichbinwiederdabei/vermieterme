import { assertDraftPeriod, invalidateProperty } from "@/lib/billing-freshness";
import { integerCents, requiredString } from "@/lib/billing-v2-input";
import { euroToCents } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { apiHandler, requireAuth, jsonOk, jsonCreated } from "@/lib/api-utils";

export function GET(
  _request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await paramsPromise;
    const costs = await prisma.cost.findMany({
      where: { billingPeriodId: id },
      include: {
        costCategory: true,
      },
    });

    return jsonOk(costs);
  });
}

export function POST(
  request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await paramsPromise;
    const body = await request.json();
    const period = await assertDraftPeriod(id);
    const costCategoryId = requiredString(body.costCategoryId, "Kostenart");
    const amount =
      body.totalAmountCents === undefined
        ? body.totalAmount === undefined
          ? undefined
          : BigInt(euroToCents(String(body.totalAmount)))
        : integerCents(body.totalAmountCents, "Gesamtbetrag");
    const cost = await prisma.cost.upsert({
      where: {
        billingPeriodId_costCategoryId: { billingPeriodId: id, costCategoryId },
      },
      update: {
        totalAmountCents: amount,
        reviewed: false,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        distributionKeyOverride: body.distributionKeyOverride,
      },
      create: {
        billingPeriodId: id,
        costCategoryId,
        totalAmount: 0,
        totalAmountCents: amount ?? 0n,
        reviewed: false,
      },
    });
    await invalidateProperty(period.propertyId);
    return jsonCreated(cost);
  });
}
