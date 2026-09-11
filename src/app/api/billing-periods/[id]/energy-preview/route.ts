import { prisma } from "@/lib/prisma";
import { ApiError, apiHandler, jsonCreated, jsonOk, requireAuth } from "@/lib/api-utils";
import { buildEnergyPreview } from "@/lib/energy-preview";
import { serializeExact } from "@/lib/billing-v2";

export function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return apiHandler(async () => {
    const session = await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const preview = await buildEnergyPreview(body.kind, id, body.costCategoryId);
    if (preview.blockers.length > 0) throw new ApiError(preview.blockers.join(" "), 400);
    const period = await prisma.billingPeriod.findUnique({ where: { id } });
    if (!period) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
    if (period.sentDate || period.paidDate) throw new ApiError("Versendete oder bezahlte Abrechnungen können nicht verändert werden", 409);

    const snapshot = await prisma.$transaction(async (tx) => {
      await tx.billingSnapshot.updateMany({ where: { billingPeriodId: id, kind: preview.kind, status: "APPLIED" }, data: { status: "SUPERSEDED" } });
      await tx.costAllocation.deleteMany({ where: { billingPeriodId: id, costCategoryId: preview.costCategoryId } });
      const created = await tx.billingSnapshot.create({ data: {
        billingPeriodId: id,
        costCategoryId: preview.costCategoryId,
        kind: preview.kind,
        sourceFingerprint: preview.sourceFingerprint,
        sourceJson: JSON.stringify({ fingerprint: preview.sourceFingerprint }),
        resultJson: JSON.stringify(serializeExact(preview)),
        appliedBy: session.user.id,
      }});
      if (preview.allocations.length > 0) await tx.costAllocation.createMany({ data: preview.allocations.map((row) => ({
        billingPeriodId: id,
        costCategoryId: preview.costCategoryId,
        unitId: row.unitId,
        tenantId: row.tenantId,
        periodStart: new Date(`${row.periodStart}T00:00:00.000Z`),
        periodEnd: new Date(`${row.periodEnd}T00:00:00.000Z`),
        amountCents: BigInt(row.amountCents),
        quantity: row.quantity ?? null,
        distributionKey: row.distributionKey,
        calculationBasis: row.calculationBasis,
        sourceType: row.sourceType,
        sourceReferenceId: row.sourceReferenceId ?? null,
        snapshotId: created.id,
      })) });
      await tx.cost.upsert({ where: { billingPeriodId_costCategoryId: { billingPeriodId: id, costCategoryId: preview.costCategoryId } }, update: {
        totalAmountCents: BigInt(preview.totalAmountCents), reviewed: false, enabled: true,
      }, create: {
        billingPeriodId: id, costCategoryId: preview.costCategoryId, totalAmount: 0, totalAmountCents: BigInt(preview.totalAmountCents), reviewed: false,
      }});
      if (preview.kind === "HEATING_OIL") {
        const rows = serializeExact(preview.details.fifoRows) as Array<{ lotId: string; consumedLiters: string; amountCents: string; co2CostCents: string; co2Grams: string }>;
        await tx.oilLotConsumption.updateMany({ where: { snapshot: { billingPeriodId: id, kind: "HEATING_OIL" }, active: true }, data: { active: false } });
        if (rows.length > 0) await tx.oilLotConsumption.createMany({ data: rows.map((row) => ({
          lotId: row.lotId, snapshotId: created.id, quantityLiters: row.consumedLiters,
          amountCents: BigInt(row.amountCents), co2CostCents: BigInt(row.co2CostCents), co2Grams: BigInt(row.co2Grams),
        })) });
      }
      return created;
    });
    return jsonCreated(snapshot);
  });
}
