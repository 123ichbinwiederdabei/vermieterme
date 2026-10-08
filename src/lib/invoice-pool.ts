import { prisma } from "@/lib/prisma";
import { allocateServiceLineToPeriod } from "@/lib/cost-invoice";
import { eligibleForCategory } from "@/lib/invoice-categories";

export async function invoicePool(
  propertyId: string,
  billingPeriodId: string,
  costCategoryId: string,
  code: string,
  start: Date,
  end: Date,
) {
  const invoices = await prisma.costInvoice.findMany({
    where: {
      propertyId,
      costCategoryId,
      status: { not: "DISCARDED" },
      revisions: { none: { status: "CONFIRMED" } },
      OR: [
        { servicePeriodStart: { lte: end }, servicePeriodEnd: { gte: start } },
        { billingPeriodId, servicePeriodStart: null },
      ],
    },
    include: { lines: true, attachments: { include: { document: true } } },
    orderBy: { serviceDate: "asc" },
  });
  const blockers: string[] = [];
  let eligible = 0n;
  let excluded = 0n;
  const details = invoices.map((invoice) => {
    if (invoice.status !== "CONFIRMED")
      blockers.push(
        `Rechnung ${invoice.invoiceNumber || invoice.id} ist nicht bestätigt.`,
      );
    if (!invoice.servicePeriodStart || !invoice.servicePeriodEnd)
      blockers.push(
        `Leistungszeitraum für Rechnung ${invoice.invoiceNumber || invoice.id} fehlt.`,
      );
    if (
      invoice.lines.reduce((sum, line) => sum + line.amountCents, 0n) !==
      invoice.totalAmountCents
    )
      blockers.push(
        `Rechnungszeilen für ${invoice.invoiceNumber || invoice.id} stimmen nicht mit dem Gesamtbetrag überein.`,
      );
    const lines = invoice.lines.map((line) => ({
      ...line,
      periodAmountCents: allocateServiceLineToPeriod(
        line.amountCents,
        invoice.servicePeriodStart,
        invoice.servicePeriodEnd,
        start,
        end,
      ),
    }));
    for (const line of lines) {
      if (eligibleForCategory(code, line)) eligible += line.periodAmountCents;
      else if (
        !["HEATING_OIL", "TARIF", "JAHRESRECHNUNG"].includes(
          line.classification,
        )
      )
        excluded += line.periodAmountCents;
    }
    return { ...invoice, lines };
  });
  return { invoices, eligible, excluded, details, blockers };
}
