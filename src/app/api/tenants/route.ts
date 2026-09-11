import { prisma } from "@/lib/prisma";
import { apiHandler, requireAuth, jsonOk, jsonCreated } from "@/lib/api-utils";

export function GET(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const unitId = searchParams.get("unitId");

    const tenants = await prisma.tenant.findMany({
      where: unitId ? { unitId } : undefined,
      include: {
        unit: {
          include: {
            property: true,
          },
        },
        financialPeriods: {
          include: { components: { include: { costCategory: true } } },
          orderBy: { validFrom: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return jsonOk(tenants);
  });
}

export function POST(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const body = await request.json();
    const {
      unitId,
      salutation,
      firstName,
      lastName,
      salutation2,
      firstName2,
      lastName2,
      phone,
      email,
      bankName,
      iban,
      accountHolder,
      moveInDate,
      moveOutDate,
      leaseType,
      indexBaseYear,
      indexReferenceValue,
      indexReferenceDate,
      indexMinMonths,
      monthlyColdRentCents,
      monthlyPrepaymentCents,
      prepaymentComponents,
    } = body;

    const tenantData = {
        unitId,
        salutation,
        firstName,
        lastName,
        salutation2,
        firstName2,
        lastName2,
        phone: phone || null,
        email: email || null,
        bankName: bankName || null,
        iban: iban || null,
        accountHolder: accountHolder || null,
        moveInDate: new Date(moveInDate),
        moveOutDate: moveOutDate ? new Date(moveOutDate) : null,
        leaseType: leaseType || "standard",
        indexBaseYear: indexBaseYear ?? null,
        indexReferenceValue: indexReferenceValue ?? null,
        indexReferenceDate: indexReferenceDate
          ? new Date(indexReferenceDate)
          : null,
        indexMinMonths: indexMinMonths ?? 12,
    };
    if (monthlyColdRentCents === undefined || monthlyPrepaymentCents === undefined) {
      return jsonCreated(await prisma.tenant.create({ data: tenantData }));
    }
    const tenant = await prisma.$transaction(async (tx) => {
      const created = await tx.tenant.create({ data: tenantData });
      {
        const components = Array.isArray(prepaymentComponents) ? prepaymentComponents : [];
        const componentTotal = components.reduce((sum: bigint, component: { monthlyAmountCents: string }) => sum + BigInt(component.monthlyAmountCents), 0n);
        if (componentTotal !== BigInt(monthlyPrepaymentCents)) {
          throw new Error("Die Summe der NK-Komponenten entspricht nicht der gesamten NK-Vorauszahlung");
        }
        await tx.leaseFinancialPeriod.create({ data: {
          tenantId: created.id,
          validFrom: new Date(moveInDate),
          validTo: moveOutDate ? new Date(moveOutDate) : null,
          monthlyColdRentCents: BigInt(monthlyColdRentCents),
          monthlyPrepaymentCents: BigInt(monthlyPrepaymentCents),
          reason: "Mietbeginn",
          components: { create: components.map((component: { costCategoryId: string; monthlyAmountCents: string }) => ({
            costCategoryId: component.costCategoryId,
            monthlyAmountCents: BigInt(component.monthlyAmountCents),
          })) },
        }});
      }
      return created;
    });

    return jsonCreated(tenant);
  });
}
