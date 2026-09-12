import { createHash } from "crypto";
import { ApiError } from "@/lib/api-utils";
import { allocateCents, fromScaledInteger, serializeExact, toScaledInteger } from "@/lib/billing-v2";
import { calculateElectricityCostCents, isoDay, splitUnitAmountAcrossTenants } from "@/lib/energy-billing";
import { prisma } from "@/lib/prisma";
import { allocateServiceLineToPeriod, isEligibleInvoiceLine, SMALL_WASTEWATER_CATEGORY } from "@/lib/cost-invoice";

export { isEligibleInvoiceLine, SMALL_WASTEWATER_CATEGORY } from "@/lib/cost-invoice";

export type InvoicePreview = {
  kind: "SMALL_WASTEWATER";
  billingPeriodId: string;
  costCategoryId: string;
  totalAmountCents: string;
  tenantAmountCents: string;
  landlordAmountCents: string;
  vacancyAmountCents: string;
  allocations: ReturnType<typeof splitUnitAmountAcrossTenants>["allocations"];
  details: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
  sourceFingerprint: string;
};

const overlaps = (startA: Date, endA: Date | null, startB: Date, endB: Date) =>
  startA <= endB && (!endA || endA >= startB);

async function smallWastewaterElectricity(propertyId: string, periodStart: Date, periodEnd: Date) {
  const contracts = await prisma.electricityContract.findMany({
    where: { propertyId }, include: { tariffs: true, meters: { where: { role: "SMALL_WASTEWATER_ELECTRICITY" }, include: { readings: true } } },
  });
  let amountCents = 0n;
  const blockers: string[] = [];
  const details: Array<Record<string, string>> = [];
  for (const contract of contracts) for (const meter of contract.meters) {
    const settlementStart = (tariff: typeof contract.tariffs[number]) => tariff.billingValidFrom ?? tariff.validFrom;
    const settlementEnd = (tariff: typeof contract.tariffs[number]) => tariff.billingValidTo ?? tariff.validTo ?? periodEnd;
    const boundaries = new Map<string, Date>([[isoDay(periodStart), periodStart], [isoDay(periodEnd), periodEnd]]);
    for (const tariff of contract.tariffs) {
      const date = settlementStart(tariff);
      if (date > periodStart && date < periodEnd) boundaries.set(isoDay(date), date);
    }
    const readingByDay = new Map(meter.readings.map((reading) => [isoDay(reading.readingDate), reading]));
    const dates = [...boundaries.values()].sort((a, b) => a.getTime() - b.getTime());
    if (dates.some((date) => !readingByDay.has(isoDay(date)))) {
      blockers.push(`Ablesung für Anlagenzähler ${meter.meterNumber} an jeder Abrechnungs- oder Tarifgrenze erforderlich.`);
      continue;
    }
    for (let index = 0; index < dates.length - 1; index += 1) {
      const start = dates[index]; const end = dates[index + 1];
      const priorDay = new Date(end); priorDay.setUTCDate(priorDay.getUTCDate() - 1);
      const tariff = contract.tariffs.find((row) => settlementStart(row) <= start && settlementEnd(row) >= priorDay);
      if (!tariff) { blockers.push(`Tariflücke für Anlagenzähler ${meter.meterNumber} ab ${isoDay(start)}.`); continue; }
      try {
        const result = calculateElectricityCostCents(readingByDay.get(isoDay(start))!.readingKwh.toString(), readingByDay.get(isoDay(end))!.readingKwh.toString(), tariff.priceMicroEuroPerKwh);
        amountCents += result.amountCents;
        details.push({ meterNumber: meter.meterNumber, start: isoDay(start), end: isoDay(end), consumptionKwh: result.consumptionKwh, amountCents: result.amountCents.toString(), priceMicroEuroPerKwh: tariff.priceMicroEuroPerKwh.toString() });
      } catch (error) { blockers.push(error instanceof Error ? `${meter.meterNumber}: ${error.message}` : `Anlagenzähler ${meter.meterNumber}: Berechnung fehlgeschlagen.`); }
    }
  }
  return { amountCents, blockers, details };
}

export async function buildSmallWastewaterPreview(billingPeriodId: string, costCategoryId: string): Promise<InvoicePreview> {
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: { include: { units: { include: { tenants: { include: { costCategoryAgreements: true } } } } } },
      costs: false,
    },
  });
  const category = await prisma.costCategory.findUnique({ where: { id: costCategoryId } });
  if (!period || !category) throw new ApiError("Abrechnungszeitraum oder Kostenart nicht gefunden", 404);
  if (category.name !== SMALL_WASTEWATER_CATEGORY) throw new ApiError("Diese Vorschau ist nur für Entwässerung – Kleinkläranlage verfügbar", 400);
  const invoices = await prisma.costInvoice.findMany({
    where: {
      costCategoryId,
      OR: [
        { propertyId: period.propertyId, servicePeriodStart: { lte: period.endDate }, servicePeriodEnd: { gte: period.startDate } },
        { billingPeriodId, servicePeriodStart: null },
      ],
    },
    include: { lines: true }, orderBy: { serviceDate: "asc" },
  });
  const blockers: string[] = [];
  const warnings: string[] = [];
  let eligible = 0n;
  let excluded = 0n;
  const details = invoices.map((invoice) => {
    const sum = invoice.lines.reduce((total, line) => total + line.amountCents, 0n);
    if (sum !== invoice.totalAmountCents) blockers.push(`Rechnung ${invoice.invoiceNumber || invoice.id}: Summe der Rechnungszeilen stimmt nicht mit dem Gesamtbetrag überein.`);
    const periodLines = invoice.lines.map((line) => ({ ...line, periodAmountCents: allocateServiceLineToPeriod(line.amountCents, invoice.servicePeriodStart, invoice.servicePeriodEnd, period.startDate, period.endDate) }));
    const eligibleAmount = periodLines.filter(isEligibleInvoiceLine).reduce((total, line) => total + line.periodAmountCents, 0n);
    const excludedAmount = periodLines.filter((line) => !isEligibleInvoiceLine(line)).reduce((total, line) => total + line.periodAmountCents, 0n);
    eligible += eligibleAmount;
    excluded += excludedAmount;
    return { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, totalAmountCents: invoice.totalAmountCents.toString(), eligibleAmountCents: eligibleAmount.toString(), excludedAmountCents: excludedAmount.toString(), servicePeriodStart: invoice.servicePeriodStart, servicePeriodEnd: invoice.servicePeriodEnd, lines: periodLines.map((line) => ({ ...line, periodAmountCents: line.periodAmountCents.toString() })) };
  });
  if (!invoices.length) warnings.push("Noch keine Rechnungen für die Kleinkläranlage erfasst.");
  const electricity = await smallWastewaterElectricity(period.propertyId, period.startDate, period.endDate);
  eligible += electricity.amountCents;
  blockers.push(...electricity.blockers);
  const units = period.property.units;
  for (const unit of units) {
    if (!unit.areaM2 || toScaledInteger(unit.areaM2.toString()) <= 0n) blockers.push(`Wohnfläche für ${unit.name} fehlt.`);
    for (const tenant of unit.tenants) {
      if (!overlaps(tenant.moveInDate, tenant.moveOutDate, period.startDate, period.endDate)) continue;
      const agreement = tenant.costCategoryAgreements.some((row) => row.costCategoryId === costCategoryId && row.validFrom <= period.startDate && (!row.validTo || row.validTo >= period.endDate));
      if (!agreement) blockers.push(`Die Vertragsbestätigung für Entwässerungskosten bei ${tenant.firstName} ${tenant.lastName} fehlt oder deckt den Zeitraum nicht ab.`);
    }
  }
  const weights = units.map((unit) => toScaledInteger(unit.areaM2?.toString() ?? "0"));
  const unitShares = allocateCents(eligible, weights);
  let vacancy = 0n;
  const allocations: InvoicePreview["allocations"] = [];
  units.forEach((unit, index) => {
    const split = splitUnitAmountAcrossTenants(unitShares[index] ?? 0n, unit.id, unit.tenants, period.startDate, period.endDate, {
      distributionKey: "AREA",
      calculationBasis: `${unit.areaM2?.toString() ?? "0"} m² von ${fromScaledInteger(weights.reduce((sum, weight) => sum + weight, 0n))} m²`,
      sourceType: "SMALL_WASTEWATER",
      sourceReferenceId: costCategoryId,
    });
    allocations.push(...split.allocations);
    vacancy += split.vacancyCents;
  });
  const tenantAmount = allocations.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
  const sourceFingerprint = createHash("sha256").update(JSON.stringify(serializeExact({ invoices, units: units.map((unit) => [unit.id, unit.areaM2?.toString()]) }))).digest("hex");
  return { kind: "SMALL_WASTEWATER", billingPeriodId, costCategoryId, totalAmountCents: eligible.toString(), tenantAmountCents: tenantAmount.toString(), landlordAmountCents: (excluded + vacancy).toString(), vacancyAmountCents: vacancy.toString(), allocations, details: { invoices: details, eligibleAmountCents: eligible.toString(), excludedAmountCents: excluded.toString(), plantElectricityCents: electricity.amountCents.toString(), plantElectricityIntervals: electricity.details }, blockers, warnings, sourceFingerprint };
}
