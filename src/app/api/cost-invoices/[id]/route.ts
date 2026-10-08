import { apiHandler, jsonOk, requireAuth, ApiError } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { confirmInvoice } from "@/lib/invoice-service";
import { assertDraftPeriod, invalidateProperty } from "@/lib/billing-freshness";

export function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    const session = await requireAuth();
    const { id } = await params;
    const body = await request.json();
    if (body.action === "confirm")
      return jsonOk(await confirmInvoice(id, body, session.user.id));
    const invoice = await prisma.costInvoice.findUnique({ where: { id } });
    if (!invoice) throw new ApiError("Rechnung fehlt", 404);
    await assertDraftPeriod(invoice.billingPeriodId);
    if (invoice.status !== "DRAFT")
      throw new ApiError("Bestätigte Rechnung ist unveränderlich", 409);
    const updated = await prisma.costInvoice.update({
      where: { id },
      data: {
        dataJson: JSON.stringify(body.values ?? {}),
        note: body.note === undefined ? undefined : String(body.note),
      },
    });
    await invalidateProperty(invoice.propertyId);
    return jsonOk(updated);
  });
}
export function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const invoice = await prisma.costInvoice.findUnique({ where: { id } });
    if (!invoice) throw new ApiError("Rechnung fehlt", 404);
    await assertDraftPeriod(invoice.billingPeriodId);
    if (invoice.status !== "DRAFT")
      throw new ApiError(
        "Bestätigte Rechnung kann nur durch eine Revision korrigiert werden",
        409,
      );
    await prisma.costInvoice.update({
      where: { id },
      data: { status: "DISCARDED" },
    });
    await invalidateProperty(invoice.propertyId);
    return jsonOk({ deleted: true });
  });
}
