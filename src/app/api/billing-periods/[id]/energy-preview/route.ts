import {
  ApiError,
  apiHandler,
  jsonCreated,
  jsonOk,
  requireAuth,
} from "@/lib/api-utils";
import { buildEnergyPreview } from "@/lib/energy-preview";

export function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") || "";
    const costCategoryId = url.searchParams.get("costCategoryId") || "";
    if (!costCategoryId) throw new ApiError("Kostenart fehlt", 400);
    return jsonOk(await buildEnergyPreview(kind, id, costCategoryId));
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
    const { applyBillingCalculation } = await import("@/lib/mcp/lifecycle");
    try { return jsonCreated(await applyBillingCalculation(id, body.kind, String(body.costCategoryId), body.zeroReason, { userId: session.user.id, requestId: crypto.randomUUID(), reason: "Web-Kostenberechnung bestätigt" })); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(error instanceof Error ? error.message : "Fachprüfung fehlgeschlagen", 409); }
  });
}
