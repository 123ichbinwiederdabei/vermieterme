import { prisma } from "@/lib/prisma";
import { ApiError, apiHandler, jsonCreated, jsonOk, requireAuth } from "@/lib/api-utils";
import { dateValue, decimalString, integerCents, integerMicroEuros, requiredString } from "@/lib/billing-v2-input";
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
      const price = integerMicroEuros(body.priceMicroEuroPerKwh, "Strompreis");
      return jsonCreated(await prisma.electricityTariff.create({ data: {
        contractId,
        validFrom,
        validTo,
        billingValidFrom: body.billingValidFrom ? dateValue(body.billingValidFrom, "Abrechnungswirksam ab") : null,
        billingValidTo: body.billingValidTo ? dateValue(body.billingValidTo, "Abrechnungswirksam bis") : null,
        billingEffectiveReason: String(body.billingEffectiveReason || "").trim() || null,
        priceMicroEuroPerKwh: price,
        monthlyBasePriceCents: integerCents(body.monthlyBasePriceCents, "Grundpreis"),
        name: body.name || null,
      }}));
    }

    if (action === "updateTariff") {
      const id = requiredString(body.id, "Tarif"); const existing = await prisma.electricityTariff.findUnique({ where: { id } });
      if (!existing) throw new ApiError("Tarif nicht gefunden", 404);
      const billingValidFrom = body.billingValidFrom ? dateValue(body.billingValidFrom, "Abrechnungswirksam ab") : null;
      const billingValidTo = body.billingValidTo ? dateValue(body.billingValidTo, "Abrechnungswirksam bis") : null;
      if (billingValidFrom && billingValidTo && billingValidTo < billingValidFrom) throw new ApiError("Das Abrechnungsende liegt vor dem Beginn", 400);
      const priceMicroEuroPerKwh = body.priceMicroEuroPerKwh === undefined ? existing.priceMicroEuroPerKwh : integerMicroEuros(body.priceMicroEuroPerKwh, "Strompreis");
      const updated = await prisma.$transaction(async (tx) => {
        const tariff = await tx.electricityTariff.update({ where: { id }, data: { billingValidFrom, billingValidTo, billingEffectiveReason: String(body.billingEffectiveReason || "").trim() || null, priceMicroEuroPerKwh } });
        const contract = await tx.electricityContract.findUnique({ where: { id: existing.contractId } });
        if (contract) await tx.billingSnapshot.updateMany({ where: { billingPeriod: { propertyId: contract.propertyId }, kind: "ELECTRICITY", status: "APPLIED" }, data: { status: "STALE" } });
        return tariff;
      });
      return jsonOk(updated);
    }

    if (action === "createMeter") {
      const contractId = requiredString(body.contractId, "Vertrag");
      const contract = await prisma.electricityContract.findUnique({ where: { id: contractId } });
      if (!contract) throw new ApiError("Stromvertrag nicht gefunden", 404);
      const role = requiredString(body.role, "Zählerrolle");
      const supportedRoles = new Set(["UNIT_CONSUMPTION", "COMMON_ELECTRICITY", "INFORMATIONAL_TOTAL", "SMALL_WASTEWATER_ELECTRICITY"]);
      if (!supportedRoles.has(role)) throw new ApiError("Ungültige Zählerrolle", 400);
      if (role === "UNIT_CONSUMPTION" && !body.unitId) throw new ApiError("Ein Wohnungszähler benötigt eine Wohnung", 400);
      if (role === "SMALL_WASTEWATER_ELECTRICITY" && body.unitId) throw new ApiError("Der Anlagenzähler der Kleinkläranlage darf keiner Wohnung zugeordnet werden", 400);
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

    if (action === "updateReading" || action === "deleteReading") {
      const id = requiredString(body.id, "Ablesung"); const reading = await prisma.electricityReading.findUnique({ where: { id } });
      if (!reading) throw new ApiError("Ablesung nicht gefunden", 404);
      const reason = requiredString(body.correctionReason, "Korrekturbegründung");
      if (action === "deleteReading") {
        await prisma.$transaction([prisma.electricityReadingAudit.create({ data: { meterId: reading.meterId, action: "DELETE", previousJson: JSON.stringify({ readingDate: reading.readingDate, readingKwh: reading.readingKwh.toString(), reason: reading.reason, note: reading.note }), reason } }), prisma.electricityReading.delete({ where: { id } })]);
        return jsonOk({ deleted: true });
      }
      const readingKwh = decimalString(body.readingKwh, "Zählerstand");
      const updated = await prisma.$transaction(async (tx) => {
        await tx.electricityReadingAudit.create({ data: { readingId: id, meterId: reading.meterId, action: "UPDATE", previousJson: JSON.stringify({ readingDate: reading.readingDate, readingKwh: reading.readingKwh.toString(), reason: reading.reason, note: reading.note }), reason } });
        return tx.electricityReading.update({ where: { id }, data: { readingKwh, note: body.note ?? reading.note } });
      });
      return jsonOk(updated);
    }

    throw new ApiError("Unbekannte Aktion", 400);
  });
}
