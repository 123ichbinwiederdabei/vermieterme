import {
  apiHandler,
  requireAuth,
  jsonCreated,
  jsonOk,
  ApiError,
} from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { dateValue, requiredString } from "@/lib/billing-v2-input";
import { assertDraftPeriod } from "@/lib/billing-freshness";

export function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const start = dateValue(body.startDate, "Neuer Beginn");
    const original = await assertDraftPeriod(id);
    if (start <= original.startDate || start > original.endDate)
      throw new ApiError(
        "Stichtag muss innerhalb des offenen Zeitraums liegen",
        400,
      );
    if (await prisma.billingSnapshot.count({ where: { billingPeriodId: id } }))
      throw new ApiError(
        "Bereits berechneten Zeitraum nicht durch Stichtagsaufteilung verändern",
        409,
      );
    const preview = {
      originalId: id,
      previousStart: original.startDate,
      previousEnd: new Date(start.getTime() - 86_400_000),
      newStart: start,
      newEnd: original.endDate,
      requiredReadings: [
        "Heizöltank",
        "Haushaltsstrom",
        "Kleinkläranlage",
        "Heizungsstrom",
      ],
    };
    if (body.dryRun !== false) return jsonOk(preview);
    const reason = requiredString(
      body.reason,
      "Dokumentierte Stichtagsbegründung",
    );
    return jsonCreated(
      await prisma.$transaction(async (tx) => {
        const current = await tx.billingPeriod.findUnique({
          where: { id },
          include: { statementRevisions: true },
        });
        if (
          !current ||
          current.updatedAt.getTime() !== original.updatedAt.getTime() ||
          current.statementRevisions.length
        )
          throw new ApiError("Zeitraum wurde verändert", 409);
        await tx.billingPeriod.update({
          where: { id },
          data: { endDate: preview.previousEnd, revisionReason: reason },
        });
        return tx.billingPeriod.create({
          data: {
            propertyId: original.propertyId,
            startDate: start,
            endDate: original.endDate,
            revisionReason: reason,
          },
        });
      }),
    );
  });
}
