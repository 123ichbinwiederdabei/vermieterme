import { prisma } from "@/lib/prisma";
import {
  ApiError,
  apiHandler,
  jsonCreated,
  jsonOk,
  requireAuth,
} from "@/lib/api-utils";
import {
  dateValue,
  decimalString,
  integerCents,
  integerMicroEuros,
  requiredString,
} from "@/lib/billing-v2-input";
import { invalidateProperty } from "@/lib/billing-freshness";
import { toScaledInteger } from "@/lib/billing-v2";

export function GET(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const propertyId =
      new URL(request.url).searchParams.get("propertyId") || undefined;
    return jsonOk(
      await prisma.electricityContract.findMany({
        where: propertyId ? { propertyId } : undefined,
        include: {
          property: true,
          tariffs: { orderBy: { validFrom: "desc" } },
          meters: {
            include: {
              unit: true,
              readings: { orderBy: { readingDate: "desc" } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    );
  });
}

export function POST(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const body = await request.json();
    const action = requiredString(body.action, "Aktion");
    // Invalidate all three electricity-dependent pools before a source mutation.
    let affectedProperty =
      typeof body.propertyId === "string" ? body.propertyId : null;
    if (body.contractId)
      affectedProperty =
        (
          await prisma.electricityContract.findUnique({
            where: { id: body.contractId },
          })
        )?.propertyId ?? null;
    if (body.meterId)
      affectedProperty =
        (
          await prisma.electricityMeter.findUnique({
            where: { id: body.meterId },
          })
        )?.propertyId ?? null;
    if (body.id && action.includes("Reading")) {
      const reading = await prisma.electricityReading.findUnique({
        where: { id: body.id },
        include: { meter: true },
      });
      affectedProperty = reading?.meter.propertyId ?? null;
    }
    async function sourceJsonCreated(data: unknown) {
      if (affectedProperty) await invalidateProperty(affectedProperty);
      return jsonCreated(data);
    }
    async function sourceJsonOk(data: unknown) {
      if (affectedProperty) await invalidateProperty(affectedProperty);
      return jsonOk(data);
    }
    if (
      body.validFrom &&
      body.validTo &&
      dateValue(body.validTo, "Gültigkeitsende") <
        dateValue(body.validFrom, "Gültigkeitsbeginn")
    )
      throw new ApiError("Ungültiger Gültigkeitszeitraum", 400);
    if (
      body.billingValidFrom &&
      body.billingValidTo &&
      dateValue(body.billingValidTo, "Abrechnungsende") <
        dateValue(body.billingValidFrom, "Abrechnungsbeginn")
    )
      throw new ApiError("Ungültiger Abrechnungszeitraum", 400);
    if (
      (body.billingValidFrom || body.billingValidTo) &&
      !String(body.billingEffectiveReason || "").trim()
    )
      throw new ApiError(
        "Abweichende Tarifgrenzen benötigen eine dokumentierte Begründung",
        400,
      );
    if (
      body.basePriceAllocation &&
      !["BY_CONSUMPTION", "EQUAL_PER_UNIT"].includes(body.basePriceAllocation)
    )
      throw new ApiError("Ungültiger Grundpreisschlüssel", 400);

    if (action === "createContract") {
      return sourceJsonCreated(
        await prisma.electricityContract.create({
          data: {
            propertyId: requiredString(body.propertyId, "Objekt"),
            provider: requiredString(body.provider, "Anbieter"),
            contractReference: body.contractReference || null,
            validFrom: dateValue(body.validFrom, "Gültigkeitsbeginn"),
            validTo: body.validTo
              ? dateValue(body.validTo, "Gültigkeitsende")
              : null,
            basePriceAgreementNote:
              String(body.basePriceAgreementNote || "").trim() || null,
            basePriceAllocation: body.basePriceAllocation || "BY_CONSUMPTION",
          },
        }),
      );
    }

    if (action === "updateContractPolicy") {
      const contractId = requiredString(body.contractId, "Vertrag");
      const note = requiredString(
        body.basePriceAgreementNote,
        "Vereinbarung zum Grundpreisschlüssel",
      );
      if (
        !["BY_CONSUMPTION", "EQUAL_PER_UNIT"].includes(body.basePriceAllocation)
      )
        throw new ApiError("Ungültiger Grundpreisschlüssel", 400);
      return sourceJsonOk(
        await prisma.electricityContract.update({
          where: { id: contractId },
          data: {
            basePriceAllocation: body.basePriceAllocation,
            basePriceAgreementNote: note,
          },
        }),
      );
    }
    if (action === "createTariff") {
      const contractId = requiredString(body.contractId, "Vertrag");
      const validFrom = dateValue(body.validFrom, "Gültigkeitsbeginn");
      const validTo = body.validTo
        ? dateValue(body.validTo, "Gültigkeitsende")
        : null;
      const overlap = await prisma.electricityTariff.findFirst({
        where: {
          contractId,
          AND: [
            {
              validFrom: {
                lte: validTo ?? new Date("9999-12-31T00:00:00.000Z"),
              },
            },
            { OR: [{ validTo: null }, { validTo: { gte: validFrom } }] },
          ],
        },
      });
      if (overlap)
        throw new ApiError(
          "Tarifperioden dürfen sich nicht überschneiden",
          409,
        );
      const price = integerMicroEuros(body.priceMicroEuroPerKwh, "Strompreis");
      return sourceJsonCreated(
        await prisma.electricityTariff.create({
          data: {
            contractId,
            validFrom,
            validTo,
            billingValidFrom: body.billingValidFrom
              ? dateValue(body.billingValidFrom, "Abrechnungswirksam ab")
              : null,
            billingValidTo: body.billingValidTo
              ? dateValue(body.billingValidTo, "Abrechnungswirksam bis")
              : null,
            billingEffectiveReason:
              String(body.billingEffectiveReason || "").trim() || null,
            priceMicroEuroPerKwh: price,
            monthlyBasePriceCents: integerCents(
              body.monthlyBasePriceCents,
              "Grundpreis",
            ),
            name: body.name || null,
          },
        }),
      );
    }

    if (action === "updateTariff") {
      const id = requiredString(body.id, "Tarif");
      const existing = await prisma.electricityTariff.findUnique({
        where: { id },
      });
      if (!existing) throw new ApiError("Tarif nicht gefunden", 404);
      const billingValidFrom = body.billingValidFrom
        ? dateValue(body.billingValidFrom, "Abrechnungswirksam ab")
        : null;
      const billingValidTo = body.billingValidTo
        ? dateValue(body.billingValidTo, "Abrechnungswirksam bis")
        : null;
      if (
        billingValidFrom &&
        billingValidTo &&
        billingValidTo < billingValidFrom
      )
        throw new ApiError("Das Abrechnungsende liegt vor dem Beginn", 400);
      const priceMicroEuroPerKwh =
        body.priceMicroEuroPerKwh === undefined
          ? existing.priceMicroEuroPerKwh
          : integerMicroEuros(body.priceMicroEuroPerKwh, "Strompreis");
      const updated = await prisma.$transaction(async (tx) => {
        const tariff = await tx.electricityTariff.update({
          where: { id },
          data: {
            billingValidFrom,
            billingValidTo,
            billingEffectiveReason:
              String(body.billingEffectiveReason || "").trim() || null,
            priceMicroEuroPerKwh,
          },
        });
        const contract = await tx.electricityContract.findUnique({
          where: { id: existing.contractId },
        });
        if (contract)
          await tx.categoryCalculationHead.updateMany({
            where: { billingPeriod: { propertyId: contract.propertyId } },
            data: { stale: true },
          });
        if (contract)
          await tx.billingPeriod.updateMany({
            where: { propertyId: contract.propertyId },
            data: { sourceRevision: { increment: 1 } },
          });
        return tariff;
      });
      return sourceJsonOk(updated);
    }

    if (action === "createMeter") {
      const contractId = requiredString(body.contractId, "Vertrag");
      const contract = await prisma.electricityContract.findUnique({
        where: { id: contractId },
      });
      if (!contract) throw new ApiError("Stromvertrag nicht gefunden", 404);
      const role = requiredString(body.role, "Zählerrolle");
      const supportedRoles = new Set([
        "UNIT_CONSUMPTION",
        "COMMON_ELECTRICITY",
        "INFORMATIONAL_TOTAL",
        "SMALL_WASTEWATER_ELECTRICITY",
        "HEATING_ELECTRICITY",
      ]);
      if (!supportedRoles.has(role))
        throw new ApiError("Ungültige Zählerrolle", 400);
      if (role === "UNIT_CONSUMPTION" && !body.unitId)
        throw new ApiError("Ein Wohnungszähler benötigt eine Wohnung", 400);
      if (
        ["SMALL_WASTEWATER_ELECTRICITY", "HEATING_ELECTRICITY"].includes(
          role,
        ) &&
        body.unitId
      )
        throw new ApiError(
          "Der Anlagenzähler der Kleinkläranlage darf keiner Wohnung zugeordnet werden",
          400,
        );
      if (
        body.unitId &&
        !(await prisma.unit.findFirst({
          where: { id: body.unitId, propertyId: contract.propertyId },
        }))
      )
        throw new ApiError("Wohnung gehört nicht zum Stromvertrag", 400);
      return sourceJsonCreated(
        await prisma.electricityMeter.create({
          data: {
            contractId,
            propertyId: contract.propertyId,
            unitId: body.unitId || null,
            meterNumber: requiredString(body.meterNumber, "Zählernummer"),
            role,
            validFrom: dateValue(body.validFrom, "Gültigkeitsbeginn"),
            validTo: body.validTo
              ? dateValue(body.validTo, "Gültigkeitsende")
              : null,
          },
        }),
      );
    }

    if (action === "createReading") {
      const meterId = requiredString(body.meterId, "Zähler");
      const readingDate = dateValue(body.readingDate, "Ablesedatum");
      const readingKwh = decimalString(body.readingKwh, "Zählerstand");
      if (
        body.reason === "DOCUMENTED_ESTIMATE" &&
        !String(body.note || "").trim()
      )
        throw new ApiError(
          "Ersatzablesung benötigt Methode, Begründung und Belegreferenz",
          400,
        );
      const following = await prisma.electricityReading.findFirst({
        where: { meterId, readingDate: { gt: readingDate } },
        orderBy: { readingDate: "asc" },
      });
      if (
        following &&
        toScaledInteger(readingKwh) >
          toScaledInteger(following.readingKwh.toString())
      )
        throw new ApiError(
          "Ablesung überschreitet den folgenden Zählerstand",
          400,
        );
      const previous = await prisma.electricityReading.findFirst({
        where: { meterId, readingDate: { lt: readingDate } },
        orderBy: { readingDate: "desc" },
      });
      if (
        previous &&
        toScaledInteger(readingKwh) <
          toScaledInteger(previous.readingKwh.toString())
      ) {
        throw new ApiError(
          "Der Stromzählerstand darf nicht rückwärts laufen",
          400,
        );
      }
      return sourceJsonCreated(
        await prisma.electricityReading.create({
          data: {
            meterId,
            readingDate,
            readingKwh,
            reason: body.reason || "REGULAR",
            note: body.note || null,
          },
        }),
      );
    }

    if (action === "updateReading" || action === "deleteReading") {
      const id = requiredString(body.id, "Ablesung");
      const reading = await prisma.electricityReading.findUnique({
        where: { id },
      });
      if (!reading) throw new ApiError("Ablesung nicht gefunden", 404);
      const reason = requiredString(
        body.correctionReason,
        "Korrekturbegründung",
      );
      if (action === "deleteReading") {
        await prisma.$transaction([
          prisma.electricityReadingAudit.create({
            data: {
              meterId: reading.meterId,
              action: "DELETE",
              previousJson: JSON.stringify({
                readingDate: reading.readingDate,
                readingKwh: reading.readingKwh.toString(),
                reason: reading.reason,
                note: reading.note,
              }),
              reason,
            },
          }),
          prisma.electricityReading.delete({ where: { id } }),
        ]);
        return sourceJsonOk({ deleted: true });
      }
      const readingKwh = decimalString(body.readingKwh, "Zählerstand");
      const updated = await prisma.$transaction(async (tx) => {
        await tx.electricityReadingAudit.create({
          data: {
            readingId: id,
            meterId: reading.meterId,
            action: "UPDATE",
            previousJson: JSON.stringify({
              readingDate: reading.readingDate,
              readingKwh: reading.readingKwh.toString(),
              reason: reading.reason,
              note: reading.note,
            }),
            reason,
          },
        });
        return tx.electricityReading.update({
          where: { id },
          data: { readingKwh, note: body.note ?? reading.note },
        });
      });
      return sourceJsonOk(updated);
    }

    throw new ApiError("Unbekannte Aktion", 400);
  });
}
