import { apiHandler, ApiError, jsonOk } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { requireTenantAuth } from "@/lib/tenant-auth";
import { NextRequest } from "next/server";

export function GET() {
  return apiHandler(async () => {
    const { tenantId } = await requireTenantAuth();

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        unit: {
          include: { property: true },
        },
        financialPeriods: {
          where: { supersededAt: null },
          include: { components: { include: { costCategory: true } } },
          orderBy: { validFrom: "desc" },
        },
      },
    });

    if (!tenant) {
      throw new ApiError("Mieter nicht gefunden", 404);
    }

    return jsonOk({
      id: tenant.id,
      salutation: tenant.salutation,
      firstName: tenant.firstName,
      lastName: tenant.lastName,
      salutation2: tenant.salutation2,
      firstName2: tenant.firstName2,
      lastName2: tenant.lastName2,
      phone: tenant.phone,
      email: tenant.email,
      bankName: tenant.bankName,
      iban: tenant.iban,
      accountHolder: tenant.accountHolder,
      moveInDate: tenant.moveInDate,
      moveOutDate: tenant.moveOutDate,
      unit: {
        id: tenant.unit.id,
        name: tenant.unit.name,
        floor: tenant.unit.floor,
        shares: tenant.unit.shares,
      },
      property: {
        id: tenant.unit.property.id,
        street: tenant.unit.property.street,
        zip: tenant.unit.property.zip,
        city: tenant.unit.property.city,
        totalShares: tenant.unit.property.totalShares,
      },
      financialPeriods: tenant.financialPeriods,
      currentFinance: tenant.financialPeriods.find((period) => period.validFrom <= new Date() && (!period.validTo || period.validTo >= new Date())) ?? null,
    });
  });
}

export function PUT(req: NextRequest) {
  return apiHandler(async () => {
    const { tenantId } = await requireTenantAuth();

    const body = await req.json();
    const { phone, email, bankName, iban, accountHolder } = body;

    const tenant = await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && { email }),
        ...(bankName !== undefined && { bankName }),
        ...(iban !== undefined && { iban }),
        ...(accountHolder !== undefined && { accountHolder }),
      },
    });

    return jsonOk({
      id: tenant.id,
      phone: tenant.phone,
      email: tenant.email,
      bankName: tenant.bankName,
      iban: tenant.iban,
      accountHolder: tenant.accountHolder,
    });
  });
}
