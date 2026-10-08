import path from "path";
import { unlink } from "fs/promises";
import { prisma } from "@/lib/prisma";
import { apiHandler, requireAuth, jsonOk, ApiError } from "@/lib/api-utils";

const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");

export function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;

    const document = await prisma.document.findUnique({
      where: { id },
      include: {
        invoiceAttachments: true,
        costInvoice: true,
        heatingOilDelivery: true,
      },
    });
    if (!document) {
      throw new ApiError("Dokument nicht gefunden", 404);
    }

    if (
      document.invoiceAttachments.length ||
      document.costInvoice ||
      document.heatingOilDelivery
    )
      throw new ApiError(
        "Rechnungsbelege bleiben zur Nachvollziehbarkeit erhalten; neue Belege als Revision erfassen",
        409,
      );
    const [snapshot, system, lot, agreement] = await Promise.all([
      prisma.billingSnapshot.findFirst({
        where: { sourceJson: { contains: id } },
      }),
      prisma.heatingSystem.findFirst({
        where: {
          OR: [{ exceptionDocumentId: id }, { contractualDocumentId: id }],
        },
      }),
      prisma.oilInventoryLot.findFirst({ where: { co2EvidenceReference: id } }),
      prisma.leaseCostCategoryAgreement.findFirst({
        where: { contractDocumentId: id },
      }),
    ]);
    if (snapshot || system || lot || agreement)
      throw new ApiError(
        "Beleg ist Bestandteil eines Abrechnungsnachweises und muss erhalten bleiben",
        409,
      );
    // Delete file from disk
    try {
      await unlink(path.join(UPLOAD_DIR, document.fileName));
    } catch {
      // File might already be deleted
    }

    await prisma.document.delete({ where: { id } });

    return jsonOk({ success: true });
  });
}
