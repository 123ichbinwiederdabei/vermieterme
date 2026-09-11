import { ApiError, apiHandler, jsonCreated, jsonOk, requireAuth } from "@/lib/api-utils";
import { dateValue, requiredString } from "@/lib/billing-v2-input";
import { prisma } from "@/lib/prisma";

export function GET(request: Request) {
  return apiHandler(async () => {
    await requireAuth(); const propertyId = new URL(request.url).searchParams.get("propertyId") || undefined;
    return jsonOk(await prisma.externalBillingClosing.findMany({ where: propertyId ? { propertyId } : undefined, include: { property: true, tenants: { include: { tenant: { include: { unit: true } } } } }, orderBy: { closingDate: "desc" } }));
  });
}

export function POST(request: Request) {
  return apiHandler(async () => {
    const session = await requireAuth(); const body = await request.json(); const propertyId = requiredString(body.propertyId, "Objekt"); const closingDate = dateValue(body.closingDate, "Abschlussdatum");
    const tenantIds: string[] = Array.isArray(body.tenantIds) ? body.tenantIds.filter((id: unknown): id is string => typeof id === "string") : [];
    if (!tenantIds.length) throw new ApiError("Mindestens ein Mietverhältnis ist erforderlich", 400);
    const tenants = await prisma.tenant.findMany({ where: { id: { in: tenantIds }, unit: { propertyId } } });
    if (tenants.length !== tenantIds.length) throw new ApiError("Alle Mietverhältnisse müssen zum Objekt gehören", 400);
    const closing = await prisma.externalBillingClosing.create({ data: { propertyId, closingDate, note: String(body.note || "").trim() || "Extern erledigte Abrechnung; keine Kostenwerte nacherfasst.", createdBy: session.user.email || session.user.id, tenants: { create: tenantIds.map((tenantId) => ({ tenantId })) } }, include: { tenants: { include: { tenant: true } } } });
    return jsonCreated(closing);
  });
}
