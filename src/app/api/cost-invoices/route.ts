import { ApiError, apiHandler, jsonCreated, jsonOk, requireAuth } from "@/lib/api-utils";
import { integerCents, dateValue, requiredString } from "@/lib/billing-v2-input";
import { SMALL_WASTEWATER_CATEGORY } from "@/lib/cost-invoice";
import { prisma } from "@/lib/prisma";

const classifications = new Set(["WARTUNG", "PRÜFUNG", "BETRIEBSSTROM", "SCHLAMMABFUHR", "REPARATUR", "ERSATZ", "SANIERUNG", "MODERNISIERUNG", "SONSTIGES"]);

async function assertSmallWastewater(costCategoryId: string) {
  const category = await prisma.costCategory.findUnique({ where: { id: costCategoryId } });
  if (!category || category.name !== SMALL_WASTEWATER_CATEGORY) throw new ApiError("Rechnungen sind hier nur für Entwässerung – Kleinkläranlage verfügbar", 400);
}

export function GET(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const url = new URL(request.url);
    const billingPeriodId = url.searchParams.get("billingPeriodId") || "";
    const costCategoryId = url.searchParams.get("costCategoryId") || "";
    if (!billingPeriodId || !costCategoryId) throw new ApiError("Abrechnungszeitraum und Kostenart fehlen", 400);
    await assertSmallWastewater(costCategoryId);
    return jsonOk(await prisma.costInvoice.findMany({ where: { billingPeriodId, costCategoryId }, include: { lines: true, document: true }, orderBy: [{ serviceDate: "desc" }, { createdAt: "desc" }] }));
  });
}

export function POST(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const body = await request.json();
    const billingPeriodId = requiredString(body.billingPeriodId, "Abrechnungszeitraum");
    const costCategoryId = requiredString(body.costCategoryId, "Kostenart");
    await assertSmallWastewater(costCategoryId);
    const billingPeriod = await prisma.billingPeriod.findUnique({ where: { id: billingPeriodId } });
    if (!billingPeriod) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
    const servicePeriodStart = body.servicePeriodStart ? dateValue(body.servicePeriodStart, "Leistungsbeginn") : (body.serviceDate ? dateValue(body.serviceDate, "Leistungsdatum") : null);
    const servicePeriodEnd = body.servicePeriodEnd ? dateValue(body.servicePeriodEnd, "Leistungsende") : servicePeriodStart;
    if (servicePeriodStart && servicePeriodEnd && servicePeriodEnd < servicePeriodStart) throw new ApiError("Leistungsende darf nicht vor Leistungsbeginn liegen", 400);
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (!lines.length) throw new ApiError("Mindestens eine Rechnungszeile ist erforderlich", 400);
    const normalized = lines.map((line: unknown, index: number) => {
      const value = line as Record<string, unknown>;
      const classification = requiredString(value.classification, `Klassifikation Zeile ${index + 1}`);
      if (!classifications.has(classification)) throw new ApiError("Ungültige Rechnungszeilen-Klassifikation", 400);
      return { description: requiredString(value.description, `Beschreibung Zeile ${index + 1}`), amountCents: integerCents(value.amountCents, `Betrag Zeile ${index + 1}`), classification, confirmedRunningExpense: value.confirmedRunningExpense === true };
    });
    const totalAmountCents = integerCents(body.totalAmountCents, "Gesamtbetrag");
    if (normalized.reduce((sum: bigint, line: (typeof normalized)[number]) => sum + line.amountCents, 0n) !== totalAmountCents) throw new ApiError("Gesamtbetrag und Summe der Rechnungszeilen müssen centgenau übereinstimmen", 400);
    return jsonCreated(await prisma.costInvoice.create({ data: { billingPeriodId, propertyId: billingPeriod.propertyId, costCategoryId, supplier: String(body.supplier || "").trim() || null, invoiceNumber: String(body.invoiceNumber || "").trim() || null, invoiceDate: body.invoiceDate ? dateValue(body.invoiceDate, "Rechnungsdatum") : null, serviceDate: body.serviceDate ? dateValue(body.serviceDate, "Leistungsdatum") : servicePeriodStart ?? undefined, servicePeriodStart: servicePeriodStart ?? undefined, servicePeriodEnd: servicePeriodEnd ?? undefined, totalAmountCents, note: String(body.note || "").trim() || null, lines: { create: normalized } }, include: { lines: true } }));
  });
}
