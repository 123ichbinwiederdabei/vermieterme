import { createHash } from "crypto";
import { ApiError } from "@/lib/api-utils";
import { allocateCents, fromScaledInteger, serializeExact, toScaledInteger } from "@/lib/billing-v2";
import { splitUnitAmountAcrossTenants } from "@/lib/energy-billing";
import { prisma } from "@/lib/prisma";
import { isEligibleInvoiceLine, SMALL_WASTEWATER_CATEGORY } from "@/lib/cost-invoice";

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
  const invoices = await prisma.costInvoice.findMany({ where: { billingPeriodId, costCategoryId }, include: { lines: true }, orderBy: { serviceDate: "asc" } });
  const blockers: string[] = [];
  const warnings: string[] = [];
  let eligible = 0n;
  let excluded = 0n;
  const details = invoices.map((invoice) => {
    const sum = invoice.lines.reduce((total, line) => total + line.amountCents, 0n);
    if (sum !== invoice.totalAmountCents) blockers.push(`Rechnung ${invoice.invoiceNumber || invoice.id}: Summe der Rechnungszeilen stimmt nicht mit dem Gesamtbetrag überein.`);
    const eligibleAmount = invoice.lines.filter(isEligibleInvoiceLine).reduce((total, line) => total + line.amountCents, 0n);
    const excludedAmount = invoice.totalAmountCents - eligibleAmount;
    eligible += eligibleAmount;
    excluded += excludedAmount;
    return { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, totalAmountCents: invoice.totalAmountCents.toString(), eligibleAmountCents: eligibleAmount.toString(), excludedAmountCents: excludedAmount.toString(), lines: invoice.lines };
  });
  if (!invoices.length) warnings.push("Noch keine Rechnungen für die Kleinkläranlage erfasst.");
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
  return { kind: "SMALL_WASTEWATER", billingPeriodId, costCategoryId, totalAmountCents: eligible.toString(), tenantAmountCents: tenantAmount.toString(), landlordAmountCents: (excluded + vacancy).toString(), vacancyAmountCents: vacancy.toString(), allocations, details: { invoices: details, eligibleAmountCents: eligible.toString(), excludedAmountCents: excluded.toString() }, blockers, warnings, sourceFingerprint };
}
