import { apiHandler, requireAdmin, jsonOk, ApiError } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { issueBillingPreview } from "@/lib/billing-workflow";
import { randomUUID } from "node:crypto";
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return apiHandler(async () => {
    const session = await requireAdmin();
    const { id } = await params;
    const body = await request.json();
    const preview = await prisma.domainChangePreview.findUniqueOrThrow({ where: { id: String(body.previewId) } });
    if (JSON.parse(preview.payloadJson).billingPeriodId !== id) throw new ApiError("Vorschau gehort zu anderem Zeitraum", 409);
    return jsonOk(await issueBillingPreview(preview.id, body.confirmed === true, { userId: session.user.id, requestId: randomUUID(), reason: String(body.reason || "Web-Freigabe nach PDF-Prufung") }));
  });
}
