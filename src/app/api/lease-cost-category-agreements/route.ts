import { invalidateProperty } from "@/lib/billing-freshness";
import {
  ApiError,
  apiHandler,
  jsonCreated,
  jsonOk,
  requireAuth,
} from "@/lib/api-utils";
import { dateValue, requiredString } from "@/lib/billing-v2-input";
import { prisma } from "@/lib/prisma";

export function GET(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const tenantId =
      new URL(request.url).searchParams.get("tenantId") || undefined;
    return jsonOk(
      await prisma.leaseCostCategoryAgreement.findMany({
        where: tenantId ? { tenantId } : undefined,
        include: { costCategory: true, tenant: true },
        orderBy: { validFrom: "desc" },
      }),
    );
  });
}
export function POST(request: Request) {
  return apiHandler(async () => {
    const session = await requireAuth();
    const body = await request.json();
    const tenantId = requiredString(body.tenantId, "Mietverhältnis");
    const costCategoryId = requiredString(body.costCategoryId, "Kostenart");
    const validFrom = dateValue(body.validFrom, "Gültig ab");
    const validTo = body.validTo ? dateValue(body.validTo, "Gültig bis") : null;
    if (validTo && validTo < validFrom)
      throw new ApiError("Gültig bis darf nicht vor Gültig ab liegen", 400);
    const agreement = await prisma.leaseCostCategoryAgreement.create({
      data: {
        tenantId,
        costCategoryId,
        validFrom,
        validTo,
        confirmedBy: session.user.id,
        contractDocumentId:
          String(body.contractDocumentId || "").trim() || null,
        note: String(body.note || "").trim() || null,
      },
    });
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { unit: true },
    });
    if (tenant) await invalidateProperty(tenant.unit.propertyId);
    return jsonCreated(agreement);
  });
}
