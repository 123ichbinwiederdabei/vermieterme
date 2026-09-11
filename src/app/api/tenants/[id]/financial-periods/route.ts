import { prisma } from "@/lib/prisma";
import { ApiError, apiHandler, jsonCreated, jsonOk, requireAuth } from "@/lib/api-utils";
import { dateValue, integerCents } from "@/lib/billing-v2-input";

export function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    return jsonOk(await prisma.leaseFinancialPeriod.findMany({
      where: { tenantId: id },
      include: { components: { include: { costCategory: true } } },
      orderBy: [{ validFrom: "desc" }, { createdAt: "desc" }],
    }));
  });
}

export function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return apiHandler(async () => {
    const session = await requireAuth();
    const { id: tenantId } = await params;
    const body = await request.json();
    const validFrom = dateValue(body.validFrom, "Gültigkeitsbeginn");
    const coldRent = integerCents(body.monthlyColdRentCents, "Kaltmiete");
    const prepayment = integerCents(body.monthlyPrepaymentCents, "NK-Vorauszahlung");
    const components = Array.isArray(body.components) ? body.components : [];
    const normalized: Array<{ costCategoryId: string; monthlyAmountCents: bigint }> = components.map((component: { costCategoryId?: unknown; monthlyAmountCents?: unknown }) => ({
      costCategoryId: String(component.costCategoryId || ""),
      monthlyAmountCents: integerCents(component.monthlyAmountCents, "NK-Komponente"),
    }));
    if (normalized.some((component) => !component.costCategoryId)) throw new ApiError("Jede NK-Komponente benötigt eine Kostenart", 400);
    const componentTotal = normalized.reduce((sum, component) => sum + component.monthlyAmountCents, 0n);
    if (componentTotal !== prepayment) throw new ApiError("Die Summe der NK-Komponenten entspricht nicht der gesamten NK-Vorauszahlung", 400);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new ApiError("Mieter nicht gefunden", 404);
    if (validFrom < tenant.moveInDate || (tenant.moveOutDate && validFrom > tenant.moveOutDate)) {
      throw new ApiError("Die Finanzperiode muss innerhalb des Mietzeitraums beginnen", 400);
    }

    const created = await prisma.$transaction(async (tx) => {
      const current = await tx.leaseFinancialPeriod.findFirst({
        where: { tenantId, supersededAt: null, validFrom: { lt: validFrom }, OR: [{ validTo: null }, { validTo: { gte: validFrom } }] },
        orderBy: { validFrom: "desc" },
      });
      if (current) {
        const previousDay = new Date(validFrom);
        previousDay.setUTCDate(previousDay.getUTCDate() - 1);
        await tx.leaseFinancialPeriod.update({ where: { id: current.id }, data: { validTo: previousDay } });
      }
      const conflict = await tx.leaseFinancialPeriod.findFirst({
        where: { tenantId, supersededAt: null, validFrom: { gte: validFrom } },
      });
      if (conflict) throw new ApiError("Ab diesem Datum besteht bereits eine Finanzperiode", 409);
      return tx.leaseFinancialPeriod.create({
        data: {
          tenantId,
          validFrom,
          validTo: tenant.moveOutDate,
          monthlyColdRentCents: coldRent,
          monthlyPrepaymentCents: prepayment,
          reason: body.reason || null,
          createdBy: session.user.id,
          components: { create: normalized },
        },
        include: { components: true },
      });
    });
    return jsonCreated(created);
  });
}
