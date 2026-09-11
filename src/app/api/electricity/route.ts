import { prisma } from "@/lib/prisma";
import { ApiError, apiHandler, jsonCreated, jsonOk, requireAuth } from "@/lib/api-utils";
import { dateValue, decimalString, integerCents, requiredString } from "@/lib/billing-v2-input";
import { toScaledInteger } from "@/lib/billing-v2";

export function GET(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const propertyId = new URL(request.url).searchParams.get("propertyId") || undefined;
    return jsonOk(await prisma.electricityContract.findMany({
      where: propertyId ? { propertyId } : undefined,
      include: {
        property: true,
        tariffs: { orderBy: { validFrom: "desc" } },
        meters: { include: { unit: true, readings: { orderBy: { readingDate: "desc" } } } },
      },
      orderBy: { createdAt: "desc" },
    }));
  });
}

export function POST(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const body = await request.json();
    const action = requiredString(body.action, "Aktion");

    if (action === "createContract") {
      return jsonCreated(await prisma.electricityContract.create({ data: {
        propertyId: requiredString(body.propertyId, "Objekt"),
        provider: requiredString(body.provider, "Anbieter"),
        contractReference: body.contractReference || null,
        validFrom: dateValue(body.validFrom, "Gültigkeitsbeginn"),
        validTo: body.validTo ? dateValue(body.validTo, "Gültigkeitsende") : null,
        basePriceAllocation: body.basePriceAllocation || "BY_CONSUMPTION",
      }}));
    }

    if (action === "createTariff") {
      const contractId = requiredString(body.contractId, "Vertrag");
      const validFrom = dateValue(body.validFrom, "Gültigkeitsbeginn");
      const validTo = body.validTo ? dateValue(body.validTo, "Gültigkeitsende") : null;
      const overlap = await prisma.electricityTariff.findFirst({ where: {
        contractId,
        AND: [
          { validFrom: { lte: validTo ?? new Date("9999-12-31T00:00:00.000Z") } },
          { OR: [{ validTo: null }, { validTo: { gte: validFrom } }] },
        ],
      }});
      if (overlap) throw new ApiError("Tarifperioden dürfen sich nicht überschneiden", 409);
      const price = Number(body.priceCentsPerKwh);
      if (!Number.isInteger(price) || price < 0) throw new ApiError("Strompreis muss in vollen Cent je kWh angegeben werden", 400);
      return jsonCreated(await prisma.electricityTariff.create({ data: {
        contractId,
        validFrom,
        validTo,
        priceCentsPerKwh: price,
        monthlyBasePriceCents: integerCents(body.monthlyBasePriceCents, "Grundpreis"),
        name: body.name || null,
      }}));
    }

    if (action === "createMeter") {
      const contractId = requiredString(body.contractId, "Vertrag");
      const contract = await prisma.electricityContract.findUnique({ where: { id: contractId } });
      if (!contract) throw new ApiError("Stromvertrag nicht gefunden", 404);
      const role = requiredString(body.role, "Zählerrolle");
      if (role === "UNIT_CONSUMPTION" && !body.unitId) throw new ApiError("Ein Wohnungszähler benötigt eine Wohnung", 400);
      return jsonCreated(await prisma.electricityMeter.create({ data: {
        contractId,
        propertyId: contract.propertyId,
        unitId: body.unitId || null,
        meterNumber: requiredString(body.meterNumber, "Zählernummer"),
        role,
        validFrom: dateValue(body.validFrom, "Gültigkeitsbeginn"),
        validTo: body.validTo ? dateValue(body.validTo, "Gültigkeitsende") : null,
      }}));
    }

    if (action === "createReading") {
      const meterId = requiredString(body.meterId, "Zähler");
      const readingDate = dateValue(body.readingDate, "Ablesedatum");
      const readingKwh = decimalString(body.readingKwh, "Zählerstand");
      const previous = await prisma.electricityReading.findFirst({
        where: { meterId, readingDate: { lt: readingDate } },
        orderBy: { readingDate: "desc" },
      });
      if (previous && toScaledInteger(readingKwh) < toScaledInteger(previous.readingKwh.toString())) {
        throw new ApiError("Der Stromzählerstand darf nicht rückwärts laufen", 400);
      }
      return jsonCreated(await prisma.electricityReading.create({ data: {
        meterId,
        readingDate,
        readingKwh,
        reason: body.reason || "REGULAR",
        note: body.note || null,
      }}));
    }

    throw new ApiError("Unbekannte Aktion", 400);
  });
}
