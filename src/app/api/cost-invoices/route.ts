import {
  ApiError,
  apiHandler,
  jsonCreated,
  jsonOk,
  requireAuth,
} from "@/lib/api-utils";
import { requiredString } from "@/lib/billing-v2-input";
import { categoryCode, INVOICE_SECTIONS } from "@/lib/invoice-categories";
import { assertDraftPeriod, invalidateProperty } from "@/lib/billing-freshness";
import { prisma } from "@/lib/prisma";

export function GET(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const url = new URL(request.url);
    const billingPeriodId = url.searchParams.get("billingPeriodId") || "";
    const costCategoryId = url.searchParams.get("costCategoryId") || "";
    const period = await prisma.billingPeriod.findUnique({
      where: { id: billingPeriodId },
    });
    if (!period) throw new ApiError("Abrechnungszeitraum fehlt", 404);
    return jsonOk(
      await prisma.costInvoice.findMany({
        where: {
          propertyId: period.propertyId,
          costCategoryId,
          status: { not: "DISCARDED" },
          OR: [
            { billingPeriodId },
            {
              servicePeriodStart: { lte: period.endDate },
              servicePeriodEnd: { gte: period.startDate },
            },
          ],
        },
        include: {
          lines: true,
          document: true,
          attachments: { include: { document: true } },
          extractionJobs: { orderBy: { createdAt: "desc" } },
        },
        orderBy: { createdAt: "desc" },
      }),
    );
  });
}
export function POST(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const body = await request.json();
    const billingPeriodId = requiredString(
      body.billingPeriodId,
      "Abrechnungszeitraum",
    );
    const costCategoryId = requiredString(body.costCategoryId, "Kostenart");
    const period = await assertDraftPeriod(billingPeriodId);
    const category = await prisma.costCategory.findUnique({
      where: { id: costCategoryId },
    });
    if (!category) throw new ApiError("Kostenart fehlt", 404);
    const sections = INVOICE_SECTIONS[categoryCode(category)] ?? ["OPERATING"];
    const section = body.section || sections[0];
    if (!sections.includes(section))
      throw new ApiError("Ungültiger Rechnungsabschnitt", 400);
    let revisionData = {};
    let revisionOfId = null;
    if (body.revisionOfId) {
      const old = await prisma.costInvoice.findUnique({
        where: { id: body.revisionOfId },
        include: { attachments: true },
      });
      if (
        !old ||
        old.propertyId !== period.propertyId ||
        old.costCategoryId !== costCategoryId ||
        old.section !== section ||
        old.status !== "CONFIRMED"
      )
        throw new ApiError("Ungültige Rechnungsrevision", 400);
      if (
        old.section === "HEATING_OIL" &&
        !period.revisionOfPeriodId &&
        (await prisma.oilLotConsumption.count({
          where: {
            lot: { note: `Rechnung ${old.id}` },
            snapshot: { activeHead: { isNot: null } },
          },
        }))
      )
        throw new ApiError(
          "Bereits verbrauchtes Heizöl in einem Korrekturzeitraum revidieren",
          409,
        );
      revisionOfId = old.id;
      revisionData = {
        dataJson: old.dataJson,
        totalAmountCents: old.totalAmountCents,
        attachments: {
          create: old.attachments.map((attachment) => ({
            documentId: attachment.documentId,
          })),
        },
      };
    }
    const created = await prisma.costInvoice.create({
      data: {
        billingPeriodId,
        propertyId: period.propertyId,
        costCategoryId,
        section,
        totalAmountCents: 0n,
        dataJson: "{}",
        status: "DRAFT",
        revisionOfId,
        ...revisionData,
      },
      include: { lines: true },
    });
    await invalidateProperty(period.propertyId);
    return jsonCreated(created);
  });
}
