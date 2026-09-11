import { prisma } from "@/lib/prisma";
import { ApiError, apiHandler, jsonCreated, jsonOk, requireAuth } from "@/lib/api-utils";
import { dateValue, decimalString, integerCents, requiredString } from "@/lib/billing-v2-input";
import { toScaledInteger } from "@/lib/billing-v2";

export function GET(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const propertyId = new URL(request.url).searchParams.get("propertyId") || undefined;
    const systems = await prisma.heatingSystem.findMany({
      where: propertyId ? { propertyId } : undefined,
      include: {
        property: true,
        units: { include: { unit: true } },
        tanks: {
          include: {
            deliveries: { orderBy: { deliveryDate: "desc" } },
            inventoryLots: { orderBy: [{ sourceDate: "asc" }, { id: "asc" }] },
            stockReadings: { orderBy: { readingDate: "desc" } },
            oilFoxDevices: true,
            deliveryCandidates: {
              include: { beforeMeasurement: true, afterMeasurement: true, delivery: true },
              orderBy: { createdAt: "desc" },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return jsonOk(systems);
  });
}

export function POST(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const body = await request.json();
    const action = requiredString(body.action, "Aktion");

    if (action === "updateSystem") {
      const id = requiredString(body.id, "Heizsystem");
      const existing = await prisma.heatingSystem.findUnique({ where: { id }, include: { property: { include: { units: true } } } });
      if (!existing) throw new ApiError("Heizsystem nicht gefunden", 404);
      const unitIds = Array.isArray(body.unitIds) ? body.unitIds.filter((value: unknown) => typeof value === "string") : [];
      if (!unitIds.length) throw new ApiError("Mindestens eine Wohnung ist erforderlich", 400);
      const billingRegime = requiredString(body.billingRegime, "Abrechnungsregime");
      const consumptionSharePercent = Number(body.consumptionSharePercent ?? existing.consumptionSharePercent);
      const baseSharePercent = Number(body.baseSharePercent ?? existing.baseSharePercent);
      if (billingRegime === "STANDARD_HEIZKOSTENV" && (!Number.isInteger(consumptionSharePercent) || consumptionSharePercent < 50 || consumptionSharePercent > 70 || baseSharePercent !== 100 - consumptionSharePercent)) throw new ApiError("Im Standardregime muss der Verbrauchsanteil zwischen 50 % und 70 % liegen und zusammen mit den Grundkosten 100 % ergeben", 400);
      if (body.centralHotWater === true) throw new ApiError("Zentrale Warmwasserabrechnung ist derzeit deaktiviert", 400);
      if (billingRegime === "SECTION_11_EXCEPTION" && !String(body.exceptionReason || "").trim()) throw new ApiError("Für § 11 ist eine dokumentierte Ausnahmebegründung erforderlich", 400);
      const ownerUnit = body.ownerOccupiedUnitId ? existing.property.units.find((unit) => unit.id === body.ownerOccupiedUnitId) : null;
      if (billingRegime === "SECTION_2_CONTRACTUAL_DEVIATION" && (existing.property.units.length > 2 || !ownerUnit?.ownerOccupied || !String(body.contractualReason || "").trim())) throw new ApiError("§ 2 benötigt höchstens zwei Wohnungen, eine als Vermieterwohnung markierte Wohnung und eine dokumentierte Vereinbarung", 400);
      const updated = await prisma.$transaction(async (tx) => {
        const system = await tx.heatingSystem.update({ where: { id }, data: {
          name: requiredString(body.name, "Bezeichnung"), energySource: body.energySource || existing.energySource, supplyType: body.supplyType || existing.supplyType, billingRegime, consumptionSharePercent, baseSharePercent, consumptionSource: body.consumptionSource || existing.consumptionSource, centralHotWater: false,
          ownerOccupiedUnitId: body.ownerOccupiedUnitId || null, contractualValidFrom: body.contractualValidFrom ? dateValue(body.contractualValidFrom, "Gültigkeitsbeginn") : null, contractualReason: body.contractualReason || null, contractualDocumentId: body.contractualDocumentId || null, exceptionReasonCode: body.exceptionReasonCode || null, exceptionReason: body.exceptionReason || null, exceptionValidFrom: body.exceptionValidFrom ? dateValue(body.exceptionValidFrom, "Ausnahmebeginn") : null, exceptionValidTo: body.exceptionValidTo ? dateValue(body.exceptionValidTo, "Ausnahmeende") : null, exceptionDocumentId: body.exceptionDocumentId || null,
          units: { deleteMany: {}, create: unitIds.map((unitId: string) => ({ unitId })) },
        }, include: { units: true } });
        await tx.billingSnapshot.updateMany({ where: { billingPeriod: { propertyId: existing.propertyId }, kind: "HEATING_OIL", status: "APPLIED" }, data: { status: "STALE" } });
        return system;
      });
      return jsonOk(updated);
    }

    if (action === "createSystem") {
      const propertyId = requiredString(body.propertyId, "Objekt");
      const unitIds = Array.isArray(body.unitIds) ? body.unitIds.filter((id: unknown) => typeof id === "string") : [];
      if (unitIds.length === 0) throw new ApiError("Mindestens eine Wohnung ist erforderlich", 400);
      const billingRegime = requiredString(body.billingRegime, "Abrechnungsregime");
      const consumptionSharePercent = Number(body.consumptionSharePercent ?? 50);
      const baseSharePercent = Number(body.baseSharePercent ?? 50);
      if (billingRegime === "STANDARD_HEIZKOSTENV" && (!Number.isInteger(consumptionSharePercent) || consumptionSharePercent < 50 || consumptionSharePercent > 70 || baseSharePercent !== 100 - consumptionSharePercent)) {
        throw new ApiError("Im Standardregime muss der Verbrauchsanteil zwischen 50 % und 70 % liegen und zusammen mit den Grundkosten 100 % ergeben", 400);
      }
      if (body.centralHotWater === true) {
        throw new ApiError("Zentrale Warmwasserabrechnung ist derzeit deaktiviert", 400);
      }
      if (billingRegime === "SECTION_11_EXCEPTION" && !String(body.exceptionReason || "").trim()) {
        throw new ApiError("Für § 11 ist eine dokumentierte Ausnahmebegründung erforderlich", 400);
      }
      if (billingRegime === "SECTION_2_CONTRACTUAL_DEVIATION") {
        const property = await prisma.property.findUnique({ where: { id: propertyId }, include: { units: true } });
        const ownerUnit = property?.units.find((unit) => unit.id === body.ownerOccupiedUnitId);
        if (!property || property.units.length > 2 || !ownerUnit?.ownerOccupied || !String(body.contractualReason || "").trim()) {
          throw new ApiError("§ 2 benötigt höchstens zwei Wohnungen, eine Vermieterwohnung und eine dokumentierte Vereinbarung", 400);
        }
      }
      const system = await prisma.heatingSystem.create({
        data: {
          propertyId,
          name: requiredString(body.name, "Bezeichnung"),
          billingRegime,
          consumptionSharePercent,
          baseSharePercent,
          ownerOccupiedUnitId: body.ownerOccupiedUnitId || null,
          contractualValidFrom: body.contractualValidFrom ? dateValue(body.contractualValidFrom, "Gültigkeitsbeginn") : null,
          contractualReason: body.contractualReason || null,
          exceptionReasonCode: body.exceptionReasonCode || null,
          exceptionReason: body.exceptionReason || null,
          exceptionValidFrom: body.exceptionValidFrom ? dateValue(body.exceptionValidFrom, "Ausnahmebeginn") : null,
          exceptionValidTo: body.exceptionValidTo ? dateValue(body.exceptionValidTo, "Ausnahmeende") : null,
          units: { create: unitIds.map((unitId: string) => ({ unitId })) },
        },
        include: { units: true },
      });
      return jsonCreated(system);
    }

    if (action === "createTank") {
      return jsonCreated(await prisma.heatingOilTank.create({
        data: {
          heatingSystemId: requiredString(body.heatingSystemId, "Heizsystem"),
          name: requiredString(body.name, "Tankbezeichnung"),
          capacityLiters: body.capacityLiters ? decimalString(body.capacityLiters, "Tankkapazität", false) : null,
          deliveryDetectionThresholdLiters: decimalString(body.deliveryDetectionThresholdLiters ?? "200", "Liefererkennung", false),
          location: optionalText(body.location), manufacturer: optionalText(body.manufacturer), model: optionalText(body.model), serialNumber: optionalText(body.serialNumber), tankType: optionalText(body.tankType), material: optionalText(body.material),
          lengthMm: optionalDecimal(body.lengthMm, "Länge"), widthMm: optionalDecimal(body.widthMm, "Breite"), heightMm: optionalDecimal(body.heightMm, "Höhe"), diameterMm: optionalDecimal(body.diameterMm, "Durchmesser"), usableVolumeLiters: optionalDecimal(body.usableVolumeLiters, "Nutzvolumen"), measurementNotes: optionalText(body.measurementNotes), notes: optionalText(body.notes),
        },
      }));
    }

    if (action === "updateTank") {
      const id = requiredString(body.id, "Tank");
      const existing = await prisma.heatingOilTank.findUnique({ where: { id }, include: { stockReadings: { where: { quantityLiters: { not: null } } } } });
      if (!existing) throw new ApiError("Tank nicht gefunden", 404);
      const capacityLiters = body.capacityLiters === "" || body.capacityLiters == null ? null : decimalString(body.capacityLiters, "Tankkapazität", false);
      if (capacityLiters && existing.stockReadings.some((reading) => reading.quantityLiters && toScaledInteger(reading.quantityLiters.toString()) > toScaledInteger(capacityLiters))) throw new ApiError("Die neue Tankkapazität liegt unter einem vorhandenen Tankstand.", 400);
      const usableVolumeLiters = optionalDecimal(body.usableVolumeLiters, "Nutzvolumen");
      if (capacityLiters && usableVolumeLiters && toScaledInteger(usableVolumeLiters) > toScaledInteger(capacityLiters)) throw new ApiError("Das Nutzvolumen darf die Tankkapazität nicht überschreiten.", 400);
      const tank = await prisma.$transaction(async (tx) => {
        const updated = await tx.heatingOilTank.update({ where: { id }, data: { name: requiredString(body.name, "Tankbezeichnung"), capacityLiters, deliveryDetectionThresholdLiters: decimalString(body.deliveryDetectionThresholdLiters ?? existing.deliveryDetectionThresholdLiters.toString(), "Liefererkennung", false), location: optionalText(body.location), manufacturer: optionalText(body.manufacturer), model: optionalText(body.model), serialNumber: optionalText(body.serialNumber), tankType: optionalText(body.tankType), material: optionalText(body.material), lengthMm: optionalDecimal(body.lengthMm, "Länge"), widthMm: optionalDecimal(body.widthMm, "Breite"), heightMm: optionalDecimal(body.heightMm, "Höhe"), diameterMm: optionalDecimal(body.diameterMm, "Durchmesser"), usableVolumeLiters, measurementNotes: optionalText(body.measurementNotes), notes: optionalText(body.notes) } });
        await tx.billingSnapshot.updateMany({ where: { billingPeriod: { propertyId: (await tx.heatingSystem.findUnique({ where: { id: existing.heatingSystemId } }))!.propertyId }, kind: "HEATING_OIL", status: "APPLIED" }, data: { status: "STALE" } });
        return updated;
      });
      return jsonOk(tank);
    }

    if (action === "createOpeningLot") {
      return jsonCreated(await prisma.oilInventoryLot.create({
        data: {
          tankId: requiredString(body.tankId, "Tank"),
          sourceType: "OPENING_BALANCE",
          sourceDate: dateValue(body.sourceDate, "Bestandsdatum"),
          quantityLiters: decimalString(body.quantityLiters, "Menge", false),
          totalAmountCents: integerCents(body.totalAmountCents, "Bestandswert"),
          co2CostCents: integerCents(body.co2CostCents ?? "0", "CO₂-Kosten"),
          co2Grams: BigInt(String(body.co2Grams ?? "0")),
          energyContentKwh: decimalString(body.energyContentKwh ?? "0", "Energiegehalt"),
          emissionFactorMicrogWh: BigInt(String(body.emissionFactorMicrogWh ?? "0")),
          note: body.note || null,
        },
      }));
    }

    if (action === "createDelivery") {
      const delivery = await prisma.$transaction(async (tx) => {
        const created = await tx.heatingOilDelivery.create({
          data: {
            tankId: requiredString(body.tankId, "Tank"),
            deliveryDate: dateValue(body.deliveryDate, "Lieferdatum"),
            invoiceDate: body.invoiceDate ? dateValue(body.invoiceDate, "Rechnungsdatum") : null,
            quantityLiters: decimalString(body.quantityLiters, "Liefermenge", false),
            totalAmountCents: integerCents(body.totalAmountCents, "Gesamtbetrag"),
            additionalChargesCents: integerCents(body.additionalChargesCents ?? "0", "Liefernebenkosten"),
            priceCentsPerLiter: body.priceCentsPerLiter == null ? null : Number(integerCents(body.priceCentsPerLiter, "Preis je Liter")),
            co2CostCents: integerCents(body.co2CostCents ?? "0", "CO₂-Kosten"),
            co2Grams: BigInt(String(body.co2Grams ?? "0")),
            emissionFactorMicrogWh: BigInt(String(body.emissionFactorMicrogWh ?? "0")),
            energyContentKwh: decimalString(body.energyContentKwh ?? "0", "Energiegehalt"),
            invoiceNumber: body.invoiceNumber || null,
            supplier: body.supplier || null,
            beforeMeasurementId: body.beforeMeasurementId || null,
            afterMeasurementId: body.afterMeasurementId || null,
            detectedIncreaseLiters: body.detectedIncreaseLiters || null,
            notes: body.notes || null,
          },
        });
        await tx.oilInventoryLot.create({
          data: {
            tankId: created.tankId,
            deliveryId: created.id,
            sourceType: "DELIVERY",
            sourceDate: created.deliveryDate,
            quantityLiters: created.quantityLiters,
            totalAmountCents: created.totalAmountCents,
            co2CostCents: created.co2CostCents,
            co2Grams: created.co2Grams,
            emissionFactorMicrogWh: created.emissionFactorMicrogWh,
            energyContentKwh: created.energyContentKwh,
          },
        });
        if (body.candidateId) {
          await tx.oilDeliveryCandidate.update({ where: { id: String(body.candidateId) }, data: { status: "CONFIRMED", deliveryId: created.id, reviewedAt: new Date() } });
        }
        return created;
      });
      return jsonCreated(delivery);
    }

    if (action === "createReading") {
      const quantityLiters = decimalString(body.quantityLiters, "Tankstand");
      const tankId = requiredString(body.tankId, "Tank");
      const tank = await prisma.heatingOilTank.findUnique({ where: { id: tankId } });
      if (tank?.capacityLiters && toScaledInteger(quantityLiters) > toScaledInteger(tank.capacityLiters.toString())) {
        throw new ApiError("Der Tankstand überschreitet die Tankkapazität", 400);
      }
      return jsonCreated(await prisma.oilStockReading.create({
        data: {
          tankId,
          readingDate: dateValue(body.readingDate, "Ablesedatum"),
          quantityLiters,
          method: body.method || "MANUAL",
          source: "MANUAL",
          confirmed: true,
          note: body.note || null,
        },
      }));
    }

    if (action === "updateCandidate") {
      const id = requiredString(body.id, "Lieferhinweis");
      const status = requiredString(body.status, "Status");
      if (!["IGNORED", "CONFIRMED", "PENDING"].includes(status)) throw new ApiError("Ungültiger Lieferstatus", 400);
      return jsonOk(await prisma.oilDeliveryCandidate.update({ where: { id }, data: { status, note: body.note || null, reviewedAt: status === "PENDING" ? null : new Date() } }));
    }

    if (action === "linkCandidateToDelivery") {
      const id = requiredString(body.id, "Lieferhinweis");
      const deliveryId = requiredString(body.deliveryId, "Heizölrechnung");
      const [candidate, delivery] = await Promise.all([prisma.oilDeliveryCandidate.findUnique({ where: { id } }), prisma.heatingOilDelivery.findUnique({ where: { id: deliveryId } })]);
      if (!candidate || !delivery) throw new ApiError("Lieferhinweis oder Heizölrechnung nicht gefunden", 404);
      if (candidate.tankId !== delivery.tankId) throw new ApiError("Lieferhinweis und Rechnung gehören nicht zum selben Tank", 400);
      return jsonOk(await prisma.oilDeliveryCandidate.update({ where: { id }, data: { deliveryId, status: "CONFIRMED", reviewedAt: new Date() } }));
    }

    if (action === "assignOilFoxDevice") {
      const deviceId = requiredString(body.deviceId, "OilFox-Gerät");
      const tankId = requiredString(body.tankId, "Tank");
      const device = await prisma.oilFoxDevice.findUnique({ where: { id: deviceId } });
      if (!device) throw new ApiError("OilFox-Gerät nicht gefunden", 404);
      if (device.quantityUnit && device.quantityUnit !== "L") throw new ApiError("Nur OilFox-Geräte mit Einheit Liter können dem Heizöltank zugeordnet werden", 400);
      return jsonOk(await prisma.oilFoxDevice.update({ where: { id: deviceId }, data: { tankId, connectionStatus: "ASSIGNED" } }));
    }

    throw new ApiError("Unbekannte Aktion", 400);
  });
}

function optionalText(value: unknown): string | null { const text = typeof value === "string" ? value.trim() : ""; return text || null; }
function optionalDecimal(value: unknown, label: string): string | null { return value === "" || value == null ? null : decimalString(value, label, false); }
