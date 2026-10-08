import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-error";

export async function assertDraftPeriod(id: string) {
  const period = await prisma.billingPeriod.findUnique({
    where: { id },
    include: { statementRevisions: { take: 1 } },
  });
  if (!period) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
  if (
    period.status === "SUPERSEDED" ||
    period.sentDate ||
    period.paidDate ||
    period.statementRevisions.length
  )
    throw new ApiError(
      "Ausgestellte Abrechnung ist unveränderlich. Bitte einen Korrekturzeitraum anlegen.",
      409,
    );
  return period;
}

export async function invalidateProperty(propertyId: string) {
  await prisma.$transaction([
    prisma.categoryCalculationHead.updateMany({
      where: { billingPeriod: { propertyId } },
      data: { stale: true },
    }),
    prisma.billingPeriod.updateMany({
      where: { propertyId },
      data: { sourceRevision: { increment: 1 } },
    }),
  ]);
}

export async function invalidatePeriod(
  billingPeriodId: string,
  costCategoryId?: string,
) {
  await prisma.$transaction([
    prisma.categoryCalculationHead.updateMany({
      where: { billingPeriodId, ...(costCategoryId ? { costCategoryId } : {}) },
      data: { stale: true },
    }),
    prisma.billingPeriod.update({
      where: { id: billingPeriodId },
      data: { sourceRevision: { increment: 1 } },
    }),
  ]);
}
