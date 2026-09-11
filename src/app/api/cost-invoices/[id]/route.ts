import { ApiError, apiHandler, jsonOk, requireAuth } from "@/lib/api-utils";
import { integerCents, requiredString } from "@/lib/billing-v2-input";
import { prisma } from "@/lib/prisma";

export function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const invoice = await prisma.costInvoice.findUnique({ where: { id }, include: { lines: true } });
    if (!invoice) throw new ApiError("Rechnung nicht gefunden", 404);
    const totalAmountCents = body.totalAmountCents === undefined ? invoice.totalAmountCents : integerCents(body.totalAmountCents, "Gesamtbetrag");
    const lines = Array.isArray(body.lines) ? body.lines.map((line: Record<string, unknown>, index: number) => ({ description: requiredString(line.description, `Beschreibung Zeile ${index + 1}`), amountCents: integerCents(line.amountCents, `Betrag Zeile ${index + 1}`), classification: requiredString(line.classification, `Klassifikation Zeile ${index + 1}`), confirmedRunningExpense: line.confirmedRunningExpense === true })) : invoice.lines;
    if (lines.reduce((sum: bigint, line: { amountCents: bigint }) => sum + line.amountCents, 0n) !== totalAmountCents) throw new ApiError("Gesamtbetrag und Rechnungszeilen stimmen nicht überein", 400);
    return jsonOk(await prisma.costInvoice.update({ where: { id }, data: { supplier: body.supplier === undefined ? undefined : String(body.supplier || "").trim() || null, invoiceNumber: body.invoiceNumber === undefined ? undefined : String(body.invoiceNumber || "").trim() || null, totalAmountCents, note: body.note === undefined ? undefined : String(body.note || "").trim() || null, ...(Array.isArray(body.lines) ? { lines: { deleteMany: {}, create: lines } } : {}) }, include: { lines: true } }));
  });
}

export function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return apiHandler(async () => { await requireAuth(); const { id } = await params; await prisma.costInvoice.delete({ where: { id } }); return jsonOk({ deleted: true }); });
}
