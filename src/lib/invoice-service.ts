import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-utils";
import {
  dateValue,
  decimalString,
  integerCents,
  requiredString,
} from "@/lib/billing-v2-input";
import {
  LINE_CLASSES,
  categoryCode,
  INVOICE_SECTIONS,
} from "@/lib/invoice-categories";
import { validateInvoiceValues } from "@/lib/invoice-extraction";
import { serializeExact } from "@/lib/billing-v2";
import { assertDraftPeriod } from "@/lib/billing-freshness";

type Input = Record<string, unknown>;
function signedCents(value: unknown, label: string) {
  if (!/^-?\d+$/.test(String(value)))
    throw new ApiError(`${label} muss als Centbetrag vorliegen`, 400);
  return BigInt(String(value));
}
export function invoiceInput(body: Input, section: string) {
  const values =
    body.values && typeof body.values === "object"
      ? (body.values as Record<string, string>)
      : (body as Record<string, string>);
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(values))
    if (typeof value === "string") data[key] = value.trim();
  const totalAmountCents = signedCents(data.totalAmountCents, "Gesamtbetrag");
  const invoiceDate = dateValue(data.invoiceDate, "Rechnungsdatum");
  const start = dateValue(
    data.servicePeriodStart || data.deliveryDate,
    "Leistungsbeginn",
  );
  const end = dateValue(
    data.servicePeriodEnd || data.deliveryDate,
    "Leistungsende",
  );
  if (end < start) throw new ApiError("Ungültiger Leistungszeitraum", 400);
  for (const key of [
    "co2CostCents",
    "co2Grams",
    "monthlyBasePriceCents",
    "priceMicroEuroPerKwh",
    "annualAllocatableAmountCents",
    "annualRateMicroCentsPerM2",
  ])
    if (data[key]) integerCents(data[key], key);
  for (const key of ["netAmountCents", "vatAmountCents"])
    if (data[key]) signedCents(data[key], key);
  for (const key of [
    "quantityLiters",
    "consumptionKwh",
    "energyContentKwh",
    "vatRate",
  ])
    if (data[key]) decimalString(data[key], key);
  for (const key of ["deliveryDate", "tariffValidFrom", "tariffValidTo"])
    if (data[key]) dateValue(data[key], key);
  const errors = validateInvoiceValues(data);
  if (errors.length) throw new ApiError(errors.join(" "), 400);
  const rawLines =
    Array.isArray(body.lines) && body.lines.length
      ? (body.lines as Input[])
      : [
          {
            description: section,
            amountCents: totalAmountCents.toString(),
            classification: section,
          },
        ];
  const lines = rawLines.map((line, index) => {
    const classification = requiredString(
      line.classification,
      `Klassifikation Zeile ${index + 1}`,
    );
    if (!LINE_CLASSES.includes(classification))
      throw new ApiError("Ungültige Zeilenklassifikation", 400);
    return {
      description: requiredString(
        line.description,
        `Beschreibung Zeile ${index + 1}`,
      ),
      amountCents: signedCents(line.amountCents, `Betrag Zeile ${index + 1}`),
      classification,
      confirmedRunningExpense: line.confirmedRunningExpense === true,
    };
  });
  if (
    lines.reduce((sum, line) => sum + line.amountCents, 0n) !== totalAmountCents
  )
    throw new ApiError(
      "Rechnungszeilen müssen centgenau dem Gesamtbetrag entsprechen",
      400,
    );
  return { data, totalAmountCents, invoiceDate, start, end, lines };
}

export async function confirmInvoice(id: string, body: Input, actorId: string) {
  const invoice = await prisma.costInvoice.findUnique({
    where: { id },
    include: { costCategory: true, attachments: true, lines: true },
  });
  if (!invoice) throw new ApiError("Rechnung nicht gefunden", 404);
  await assertDraftPeriod(invoice.billingPeriodId);
  if (invoice.status !== "DRAFT")
    throw new ApiError(
      "Bestätigte Rechnung unveränderlich; Korrektur als Revision erfassen",
      409,
    );
  if (!invoice.attachments.length && !invoice.documentId)
    throw new ApiError("Rechnungsbeleg erforderlich", 400);
  const code = categoryCode(invoice.costCategory);
  if (!(INVOICE_SECTIONS[code] ?? []).includes(invoice.section))
    throw new ApiError("Ungültige Rechnungskategorie", 400);
  const parsed = invoiceInput(body, invoice.section);
  const duplicate = await prisma.costInvoice.findFirst({
    where: {
      propertyId: invoice.propertyId,
      status: "CONFIRMED",
      supplier: parsed.data.supplier || null,
      invoiceNumber: parsed.data.invoiceNumber || null,
      totalAmountCents: parsed.totalAmountCents,
      invoiceDate: parsed.invoiceDate,
      id: {
        notIn: [id, ...(invoice.revisionOfId ? [invoice.revisionOfId] : [])],
      },
    },
  });
  if (duplicate && !body.duplicateReason)
    throw new ApiError(
      "Mögliche doppelte Rechnung. Abweichenden Beleg begründen.",
      409,
    );
  const evidence = invoice.attachments[0]?.documentId ?? invoice.documentId!;
  if (invoice.section === "HEATING_OIL") {
    for (const key of [
      "tankId",
      "deliveryDate",
      "quantityLiters",
      "co2CostCents",
      "co2Grams",
    ])
      if (!parsed.data[key])
        throw new ApiError(
          `${key}: bestätigte Heizöl-/CO₂-Angabe erforderlich`,
          400,
        );
    decimalString(parsed.data.quantityLiters, "Heizölmenge", false);
    if (BigInt(parsed.data.co2CostCents) > parsed.totalAmountCents)
      throw new ApiError("CO₂-Kosten überschreiten Rechnungsbetrag", 400);
    const tank = await prisma.heatingOilTank.findUnique({
      where: { id: parsed.data.tankId },
      include: { heatingSystem: true },
    });
    if (!tank || tank.heatingSystem.propertyId !== invoice.propertyId)
      throw new ApiError("Tank gehört nicht zum Objekt", 400);
  }
  if (code === "PROPERTY_TAX") {
    if (
      !parsed.data.annualAllocatableAmountCents ||
      !parsed.data.taxBasisNote?.trim()
    )
      throw new ApiError(
        "Wohnanteil der beiden Mietwohnungen und belegte Berechnung erforderlich",
        400,
      );
    if (
      BigInt(parsed.data.annualAllocatableAmountCents) > parsed.totalAmountCents
    )
      throw new ApiError("Wohnanteil überschreitet Bescheidbetrag", 400);
  }
  if (code === "ELECTRICITY" && invoice.section === "TARIF") {
    for (const key of [
      "contractId",
      "priceMicroEuroPerKwh",
      "monthlyBasePriceCents",
      "tariffValidFrom",
    ])
      if (!parsed.data[key])
        throw new ApiError(`${key}: bestätigte Tarifangabe erforderlich`, 400);
    const contract = await prisma.electricityContract.findUnique({
      where: { id: parsed.data.contractId },
    });
    if (!contract || contract.propertyId !== invoice.propertyId)
      throw new ApiError("Stromvertrag gehört nicht zum Objekt", 400);
    if (
      parsed.data.tariffValidTo &&
      dateValue(parsed.data.tariffValidTo, "Tarifende") <
        dateValue(parsed.data.tariffValidFrom, "Tarifbeginn")
    )
      throw new ApiError("Ungültiger Tarifzeitraum", 400);
  }
  return prisma.$transaction(async (tx) => {
    if (
      invoice.revisionOfId &&
      (await tx.costInvoice.count({
        where: { revisionOfId: invoice.revisionOfId, status: "CONFIRMED" },
      }))
    )
      throw new ApiError(
        "Eine bestätigte Revision existiert bereits. Neueste Rechnung revidieren.",
        409,
      );
    const claimed = await tx.costInvoice.updateMany({
      where: { id, status: "DRAFT" },
      data: {
        status: "CONFIRMED",
        confirmedBy: actorId,
        confirmedAt: new Date(),
        supplier: parsed.data.supplier || null,
        invoiceNumber: parsed.data.invoiceNumber || null,
        invoiceDate: parsed.invoiceDate,
        serviceDate: parsed.start,
        servicePeriodStart: parsed.start,
        servicePeriodEnd: parsed.end,
        totalAmountCents: parsed.totalAmountCents,
        dataJson: JSON.stringify({
          ...parsed.data,
          duplicateReason: body.duplicateReason || null,
        }),
      },
    });
    if (claimed.count !== 1)
      throw new ApiError("Rechnung wurde bereits bestätigt", 409);
    await tx.costInvoiceLine.deleteMany({ where: { costInvoiceId: id } });
    await tx.costInvoiceLine.createMany({
      data: parsed.lines.map((line) => ({ ...line, costInvoiceId: id })),
    });
    if (code === "ELECTRICITY" && invoice.section === "TARIF") {
      const contract = await tx.electricityContract.findUniqueOrThrow({
        where: { id: parsed.data.contractId },
        include: { tariffs: true },
      });
      const from = dateValue(parsed.data.tariffValidFrom, "Tarifbeginn");
      const to = parsed.data.tariffValidTo
        ? dateValue(parsed.data.tariffValidTo, "Tarifende")
        : null;
      const existing = contract.tariffs.find(
        (tariff) => tariff.validFrom.getTime() === from.getTime(),
      );
      const previous = contract.tariffs.filter(
        (tariff) =>
          tariff.id !== existing?.id &&
          tariff.validFrom <= (to ?? new Date("9999-12-31")) &&
          (!tariff.validTo || tariff.validTo >= from),
      );
      for (const tariff of previous) {
        if (tariff.validTo || tariff.validFrom >= from)
          throw new ApiError(
            "Tarifüberschneidung: bestehende Abrechnungsintervalle zuerst klären",
            409,
          );
        const end = new Date(from.getTime() - 86_400_000);
        await tx.electricityTariff.update({
          where: { id: tariff.id },
          data: {
            validTo: end,
            billingValidTo: tariff.billingValidTo ? end : null,
          },
        });
      }
      const values = {
        priceMicroEuroPerKwh: BigInt(parsed.data.priceMicroEuroPerKwh),
        monthlyBasePriceCents: BigInt(parsed.data.monthlyBasePriceCents),
        ...(parsed.data.tariffValidTo ? { validTo: to } : {}),
      };
      const tariff = existing
        ? await tx.electricityTariff.update({
            where: { id: existing.id },
            data: values,
          })
        : await tx.electricityTariff.create({
            data: {
              contractId: contract.id,
              validFrom: from,
              validTo: to,
              ...values,
            },
          });
      await tx.costInvoice.update({
        where: { id },
        data: {
          dataJson: JSON.stringify({
            ...parsed.data,
            appliedTariffId: tariff.id,
            previousTariffs: serializeExact(contract.tariffs),
          }),
        },
      });
    }
    if (invoice.section === "HEATING_OIL") {
      const originalInvoice = invoice.revisionOfId
        ? await tx.costInvoice.findUnique({
            where: { id: invoice.revisionOfId },
          })
        : null;
      const originalData = originalInvoice
        ? JSON.parse(originalInvoice.dataJson)
        : {};
      const oldLot = originalData.lotId
        ? await tx.oilInventoryLot.findUnique({
            where: { id: originalData.lotId },
          })
        : null;
      if (originalInvoice && !oldLot)
        throw new ApiError(
          "Ursprünglicher FIFO-Bestand fehlt; Bestandskorrektur erforderlich",
          409,
        );
      const rootId = oldLot?.revisionOfId ?? oldLot?.id;
      const latest = rootId
        ? await tx.oilInventoryLot.findFirst({
            where: { OR: [{ id: rootId }, { revisionOfId: rootId }] },
            orderBy: { revisionNumber: "desc" },
          })
        : null;
      const delivery = await tx.heatingOilDelivery.create({
        data: {
          tankId: parsed.data.tankId,
          deliveryDate: new Date(parsed.data.deliveryDate),
          invoiceDate: parsed.invoiceDate,
          quantityLiters: parsed.data.quantityLiters,
          revisionOfId: originalData.deliveryId || null,
          totalAmountCents: parsed.totalAmountCents,
          co2CostCents: BigInt(parsed.data.co2CostCents),
          co2Grams: BigInt(parsed.data.co2Grams),
          supplier: parsed.data.supplier || null,
          invoiceNumber: parsed.data.invoiceNumber || null,
        },
      });
      const lot = await tx.oilInventoryLot.create({
        data: {
          revisionOfId: rootId ?? null,
          revisionNumber: (latest?.revisionNumber ?? 0) + 1,
          tankId: delivery.tankId,
          deliveryId: delivery.id,
          sourceType: "DELIVERY",
          sourceDate: delivery.deliveryDate,
          quantityLiters: delivery.quantityLiters,
          totalAmountCents: delivery.totalAmountCents,
          co2CostCents: delivery.co2CostCents,
          co2Grams: delivery.co2Grams,
          co2EvidenceReference: evidence,
          note: `Rechnung ${id}`,
        },
      });
      await tx.costInvoice.update({
        where: { id },
        data: {
          dataJson: JSON.stringify({
            ...parsed.data,
            deliveryId: delivery.id,
            lotId: lot.id,
          }),
        },
      });
    }
    if (code === "PROPERTY_TAX")
      await tx.propertyTaxSetting.upsert({
        where: { propertyId: invoice.propertyId },
        create: {
          propertyId: invoice.propertyId,
          annualAssessmentCents: parsed.totalAmountCents,
          annualAllocatableAmountCents: BigInt(
            parsed.data.annualAllocatableAmountCents,
          ),
          allocationNote: parsed.data.taxBasisNote,
          allocationMethod: "ALLOCATABLE_AMOUNT",
        },
        update: {
          annualAssessmentCents: parsed.totalAmountCents,
          annualAllocatableAmountCents: BigInt(
            parsed.data.annualAllocatableAmountCents,
          ),
          allocationNote: parsed.data.taxBasisNote,
          allocationMethod: "ALLOCATABLE_AMOUNT",
        },
      });
    await tx.categoryCalculationHead.updateMany({
      where: { billingPeriod: { propertyId: invoice.propertyId } },
      data: { stale: true },
    });
    await tx.billingPeriod.updateMany({
      where: { propertyId: invoice.propertyId },
      data: { sourceRevision: { increment: 1 } },
    });
    await tx.invoiceExtractionJob.updateMany({
      where: {
        invoiceId: id,
        status: { in: ["REVIEW_REQUIRED", "QUEUED", "PROCESSING", "FAILED"] },
      },
      data: {
        status: "CONFIRMED",
        confirmedBy: actorId,
        confirmedAt: new Date(),
      },
    });
    return serializeExact(
      await tx.costInvoice.findUnique({
        where: { id },
        include: { lines: true },
      }),
    );
  });
}
