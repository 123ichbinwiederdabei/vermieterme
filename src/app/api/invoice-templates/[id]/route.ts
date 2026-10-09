import { apiHandler, requireAuth, jsonOk, ApiError } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";

export function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const template = await prisma.invoiceTemplate.findUnique({ where: { id } });
    if (!template) throw new ApiError("Vorlage fehlt", 404);
    return jsonOk(template);
  });
}
export function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    const session = await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const context = { userId: session.user.id, requestId: crypto.randomUUID(), reason: "Visuelle Vorlage: unabhängige Sollwerte geprüft" };
    const { testInvoiceTemplate, publishInvoiceTemplate } = await import("@/lib/mcp/lifecycle");
    try {
      if (body.action === "test") return jsonOk(await testInvoiceTemplate(id, body.samples, context));
      if (body.action === "publish") return jsonOk(await publishInvoiceTemplate(id, context));
      throw new Error("Unbekannte Vorlagenaktion");
    } catch (error) { throw new ApiError(error instanceof Error ? error.message : "Vorlagenprüfung fehlgeschlagen", 409); }
  });
}
