import { ApiError, apiHandler, jsonOk, requireAuth } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";

function cents(value: unknown, label: string): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  if (!/^-?\d+$/.test(String(value)))
    throw new ApiError(`${label} muss in Cent angegeben werden.`, 400);
  return BigInt(String(value));
}

export function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    return jsonOk(
      await prisma.propertyTaxSetting.findUnique({ where: { propertyId: id } }),
    );
  });
}

export function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const allocationMethod = body.allocationMethod;
    if (
      allocationMethod !== "ALLOCATABLE_AMOUNT" &&
      allocationMethod !== "RATE_PER_M2"
    )
      throw new ApiError("Ungültige Umlagemethode.", 400);
    const annualAssessmentCents = cents(
      body.annualAssessmentCents,
      "Grundsteuer laut Bescheid",
    );
    const annualAllocatableAmountCents = cents(
      body.annualAllocatableAmountCents,
      "Umlagefähiger Wohnanteil",
    );
    const annualRateMicroCentsPerM2 = cents(
      body.annualRateMicroCentsPerM2,
      "Satz je m²",
    );
    if (annualAssessmentCents !== null && annualAssessmentCents < 0n)
      throw new ApiError("Der Bescheidbetrag darf nicht negativ sein.", 400);
    if (
      annualAllocatableAmountCents !== null &&
      annualAllocatableAmountCents < 0n
    )
      throw new ApiError(
        "Der umlagefähige Betrag darf nicht negativ sein.",
        400,
      );
    if (annualRateMicroCentsPerM2 !== null && annualRateMicroCentsPerM2 < 0n)
      throw new ApiError("Der Satz je m² darf nicht negativ sein.", 400);
    if (
      allocationMethod === "ALLOCATABLE_AMOUNT" &&
      annualAllocatableAmountCents === null
    )
      throw new ApiError("Der umlagefähige Wohnanteil fehlt.", 400);
    if (
      allocationMethod === "RATE_PER_M2" &&
      annualRateMicroCentsPerM2 === null
    )
      throw new ApiError("Der Satz je m² fehlt.", 400);
    if (
      annualAssessmentCents !== null &&
      annualAllocatableAmountCents !== null &&
      annualAllocatableAmountCents > annualAssessmentCents
    )
      throw new ApiError("Wohnanteil überschreitet den Bescheidbetrag", 400);
    const setting = await prisma.$transaction(async (tx) => {
      const saved = await tx.propertyTaxSetting.upsert({
        where: { propertyId: id },
        update: {
          annualAssessmentCents,
          allocationMethod,
          annualAllocatableAmountCents,
          annualRateMicroCentsPerM2,
          allocationNote: String(body.allocationNote || "").trim() || null,
        },
        create: {
          propertyId: id,
          annualAssessmentCents,
          allocationMethod,
          annualAllocatableAmountCents,
          annualRateMicroCentsPerM2,
          allocationNote: String(body.allocationNote || "").trim() || null,
        },
      });
      await tx.categoryCalculationHead.updateMany({
        where: { billingPeriod: { propertyId: id } },
        data: { stale: true },
      });
      await tx.billingPeriod.updateMany({
        where: { propertyId: id },
        data: { sourceRevision: { increment: 1 } },
      });
      return saved;
    });
    return jsonOk(setting);
  });
}
