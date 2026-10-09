import {
  apiHandler,
  requireAuth,
  jsonCreated,
  jsonOk,
  ApiError,
} from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { assertDraftPeriod } from "@/lib/billing-freshness";

export function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    return jsonOk(
      await prisma.invoiceExtractionJob.findMany({
        where: { invoiceId: id },
        include: { template: true },
        orderBy: { createdAt: "desc" },
      }),
    );
  });
}
export function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const invoice = await prisma.costInvoice.findUnique({
      where: { id },
      include: { attachments: true },
    });
    if (!invoice) throw new ApiError("Rechnung fehlt", 404);
    if (invoice.billingPeriodId) await assertDraftPeriod(invoice.billingPeriodId);
    if (invoice.status !== "DRAFT")
      throw new ApiError(
        "Erneute Extraktion darf eine bestätigte Rechnung nicht verändern",
        409,
      );
    const documentId =
      body.documentId ||
      invoice.attachments[0]?.documentId ||
      invoice.documentId;
    if (
      !documentId ||
      (!invoice.attachments.some((a) => a.documentId === documentId) &&
        invoice.documentId !== documentId)
    )
      throw new ApiError("Beleg gehört nicht zur Rechnung", 400);
    const existing = await prisma.invoiceExtractionJob.findFirst({
      where: {
        invoiceId: id,
        documentId,
        status: { in: ["QUEUED", "PROCESSING"] },
      },
    });
    if (existing) return jsonOk(existing);
    if (body.templateId) {
      const template = await prisma.invoiceTemplate.findUnique({
        where: { id: body.templateId },
      });
      if (
        !template ||
        template.status !== "PUBLISHED" ||
        template.costCategoryId !== invoice.costCategoryId ||
        template.section !== invoice.section
      )
        throw new ApiError("Vorlage passt nicht zur Rechnung", 400);
    }
    const previous = await prisma.invoiceExtractionJob.findFirst({
      where: { invoiceId: id, documentId, ocrJson: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    return jsonCreated(
      await prisma.invoiceExtractionJob.create({
        data: {
          invoiceId: id,
          documentId,
          templateId: body.templateId || null,
          ocrJson: previous?.ocrJson ?? null,
        },
      }),
    );
  });
}
