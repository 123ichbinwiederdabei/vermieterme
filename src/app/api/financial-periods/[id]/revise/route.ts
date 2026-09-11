import { prisma } from "@/lib/prisma";
import { ApiError, apiHandler, jsonCreated, requireAuth } from "@/lib/api-utils";
import { dateValue, integerCents, requiredString } from "@/lib/billing-v2-input";

export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return apiHandler(async () => {
    const session = await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const revisionReason = requiredString(body.revisionReason, "Revisionsgrund");
    const original = await prisma.leaseFinancialPeriod.findUnique({ where: { id }, include: { components: true } });
    if (!original) throw new ApiError("Finanzperiode nicht gefunden", 404);
    const components = Array.isArray(body.components) ? body.components : original.components;
    const normalized: Array<{ costCategoryId: string; monthlyAmountCents: bigint }> = components.map((component: { costCategoryId: string; monthlyAmountCents: unknown }) => ({
      costCategoryId: component.costCategoryId,
      monthlyAmountCents: integerCents(component.monthlyAmountCents, "NK-Komponente"),
    }));
    const prepayment = integerCents(body.monthlyPrepaymentCents ?? original.monthlyPrepaymentCents, "NK-Vorauszahlung");
    if (normalized.reduce((sum, component) => sum + component.monthlyAmountCents, 0n) !== prepayment) {
      throw new ApiError("Die Summe der NK-Komponenten entspricht nicht der gesamten NK-Vorauszahlung", 400);
    }
    const revised = await prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.leaseFinancialPeriod.update({ where: { id }, data: { supersededAt: now } });
      return tx.leaseFinancialPeriod.create({ data: {
        tenantId: original.tenantId,
        validFrom: body.validFrom ? dateValue(body.validFrom, "Gültigkeitsbeginn") : original.validFrom,
        validTo: body.validTo ? dateValue(body.validTo, "Gültigkeitsende") : original.validTo,
        monthlyColdRentCents: integerCents(body.monthlyColdRentCents ?? original.monthlyColdRentCents, "Kaltmiete"),
        monthlyPrepaymentCents: prepayment,
        reason: body.reason ?? original.reason,
        revisionOfId: original.id,
        revisionReason,
        createdBy: session.user.id,
        components: { create: normalized },
      }, include: { components: true } });
    });
    return jsonCreated(revised);
  });
}
