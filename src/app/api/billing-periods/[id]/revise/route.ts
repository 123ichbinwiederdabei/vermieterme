import {
  apiHandler,
  requireAuth,
  jsonCreated,
  ApiError,
} from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { requiredString } from "@/lib/billing-v2-input";

export function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const reason = requiredString(body.reason, "Korrekturgrund");
    return jsonCreated(
      await prisma.$transaction(async (tx) => {
        const original = await tx.billingPeriod.findUnique({
          where: { id },
          include: { statementRevisions: true, costs: true },
        });
        if (
          !original ||
          !original.statementRevisions.length ||
          original.status === "SUPERSEDED"
        )
          throw new ApiError(
            "Nur die aktuelle ausgestellte Abrechnung kann revidiert werden",
            409,
          );
        const created = await tx.billingPeriod.create({
          data: {
            propertyId: original.propertyId,
            startDate: original.startDate,
            endDate: original.endDate,
            copiedFromId: id,
            revisionOfPeriodId: id,
            revisionReason: reason,
            costs: {
              create: original.costs.map((cost) => ({
                costCategoryId: cost.costCategoryId,
                totalAmount: 0,
                totalAmountCents: cost.totalAmountCents,
                enabled: cost.enabled,
                reviewed: false,
                distributionKeyOverride: cost.distributionKeyOverride,
              })),
            },
          },
        });
        await tx.billingPeriod.update({
          where: { id },
          data: { status: "SUPERSEDED" },
        });
        return created;
      }),
    );
  });
}
