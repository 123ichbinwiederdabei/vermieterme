import { assertDraftPeriod, invalidateProperty } from "@/lib/billing-freshness";
import { prisma } from "@/lib/prisma";
import { apiHandler, requireAuth, ApiError, jsonOk } from "@/lib/api-utils";

export function GET(
  _request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await paramsPromise;
    const billingPeriod = await prisma.billingPeriod.findUnique({
      where: { id },
      include: {
        property: {
          include: {
            units: {
              include: {
                tenants: true,
              },
            },
          },
        },
        costs: {
          include: {
            costCategory: true,
          },
        },
        prepayments: {
          include: {
            unit: true,
          },
        },
        billingSnapshots: { orderBy: { createdAt: "desc" } },
        costAllocations: {
          include: { costCategory: true, unit: true, tenant: true },
        },
      },
    });

    if (!billingPeriod) {
      throw new ApiError("Billing period not found", 404);
    }

    return jsonOk(billingPeriod);
  });
}

export function PUT(
  request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await paramsPromise;
    const body = await request.json();
    const { propertyId, startDate, endDate, billingDate, sentDate, paidDate } =
      body;

    const original = await assertDraftPeriod(id);
    if (propertyId && propertyId !== original.propertyId)
      throw new ApiError(
        "Objekt eines bestehenden Zeitraums kann nicht gewechselt werden",
        409,
      );
    const from = startDate ? new Date(startDate) : original.startDate;
    const to = endDate ? new Date(endDate) : original.endDate;
    if (to < from) throw new ApiError("Ungültiger Zeitraum", 400);
    const overlap = await prisma.billingPeriod.findFirst({
      where: {
        id: { not: id },
        propertyId: original.propertyId,
        status: { not: "SUPERSEDED" },
        startDate: { lte: to },
        endDate: { gte: from },
      },
    });
    if (overlap) throw new ApiError("Überlappender Abrechnungszeitraum", 409);
    const billingPeriod = await prisma.billingPeriod.update({
      where: { id },
      data: {
        propertyId,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        billingDate:
          billingDate !== undefined
            ? billingDate
              ? new Date(billingDate)
              : null
            : undefined,
        sentDate:
          sentDate !== undefined
            ? sentDate
              ? new Date(sentDate)
              : null
            : undefined,
        paidDate:
          paidDate !== undefined
            ? paidDate
              ? new Date(paidDate)
              : null
            : undefined,
      },
    });

    await invalidateProperty(original.propertyId);
    return jsonOk(billingPeriod);
  });
}

export function DELETE(
  _request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await paramsPromise;
    await assertDraftPeriod(id);
    if (await prisma.billingSnapshot.count({ where: { billingPeriodId: id } }))
      throw new ApiError(
        "Zeitraum mit unveränderlichen Berechnungen kann nicht gelöscht werden",
        409,
      );
    await prisma.billingPeriod.delete({
      where: { id },
    });

    return jsonOk({ success: true });
  });
}
