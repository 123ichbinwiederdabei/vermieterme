import { createHash } from "crypto";
import { ApiError } from "@/lib/api-utils";
import { allocateCents, serializeExact } from "@/lib/billing-v2";
import { isoDay, splitUnitAmountAcrossTenants } from "@/lib/energy-billing";
import { prisma } from "@/lib/prisma";
import {
  meterIntervals,
  exactElectricityTotal,
} from "@/lib/electricity-intervals";
import { invoicePool } from "@/lib/invoice-pool";
import { categoryCode } from "@/lib/invoice-categories";

export {
  isEligibleInvoiceLine,
  SMALL_WASTEWATER_CATEGORY,
} from "@/lib/cost-invoice";

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
  sourceData?: unknown;
};

const overlaps = (startA: Date, endA: Date | null, startB: Date, endB: Date) =>
  startA <= endB && (!endA || endA >= startB);

export async function plantElectricity(
  propertyId: string,
  periodStart: Date,
  periodEnd: Date,
  role = "SMALL_WASTEWATER_ELECTRICITY",
) {
  const contracts = await prisma.electricityContract.findMany({
    where: { propertyId },
    include: {
      tariffs: true,
      meters: { where: { role }, include: { readings: true } },
    },
  });
  const blockers: string[] = [];
  const intervals: import("@/lib/electricity-intervals").ElectricInterval[] =
    [];
  for (const contract of contracts)
    for (const meter of contract.meters) {
      const result = meterIntervals(contract, meter, periodStart, periodEnd);
      blockers.push(...result.blockers);
      intervals.push(...result.intervals);
    }
  return {
    amountCents: exactElectricityTotal(intervals),
    blockers,
    details: serializeExact(intervals),
    source: serializeExact(contracts),
  };
}

export async function buildSmallWastewaterPreview(
  billingPeriodId: string,
  costCategoryId: string,
): Promise<InvoicePreview> {
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: {
        include: {
          units: {
            include: { tenants: { include: { costCategoryAgreements: true } } },
          },
        },
      },
      costs: false,
    },
  });
  const category = await prisma.costCategory.findUnique({
    where: { id: costCategoryId },
  });
  if (!period || !category)
    throw new ApiError(
      "Abrechnungszeitraum oder Kostenart nicht gefunden",
      404,
    );
  if (categoryCode(category) !== "WASTEWATER")
    throw new ApiError(
      "Diese Vorschau ist nur für Entwässerung – Kleinkläranlage verfügbar",
      400,
    );
  const pool = await invoicePool(
    period.propertyId,
    billingPeriodId,
    costCategoryId,
    "WASTEWATER",
    period.startDate,
    period.endDate,
  );
  const invoices = pool.invoices;
  const blockers = [...pool.blockers];
  const warnings: string[] = [];
  let eligible = pool.eligible;
  const excluded = pool.excluded;
  const electricity = await plantElectricity(
    period.propertyId,
    period.startDate,
    period.endDate,
  );
  if (
    electricity.details.length &&
    invoices.some((invoice) =>
      invoice.lines.some((line) => line.classification === "BETRIEBSSTROM"),
    )
  )
    blockers.push(
      "Anlagenstrom darf nur einmal erfasst werden: Rechnung oder Zählerverbrauch.",
    );
  eligible += electricity.amountCents;
  blockers.push(...electricity.blockers);
  const units = period.property.units;
  for (const unit of units) {
    for (const tenant of unit.tenants) {
      if (
        !overlaps(
          tenant.moveInDate,
          tenant.moveOutDate,
          period.startDate,
          period.endDate,
        )
      )
        continue;
      const agreement = tenant.costCategoryAgreements.some(
        (row) =>
          row.costCategoryId === costCategoryId &&
          row.validFrom <=
            (tenant.moveInDate > period.startDate
              ? tenant.moveInDate
              : period.startDate) &&
          (!row.validTo ||
            row.validTo >=
              (tenant.moveOutDate && tenant.moveOutDate < period.endDate
                ? tenant.moveOutDate
                : period.endDate)),
      );
      if (!agreement)
        blockers.push(
          `Die Vertragsbestätigung für Entwässerungskosten bei ${tenant.firstName} ${tenant.lastName} fehlt oder deckt den Zeitraum nicht ab.`,
        );
    }
  }
  const weights = units.map(() => 1n);
  const unitShares = allocateCents(eligible, weights);
  let vacancy = 0n;
  const allocations: InvoicePreview["allocations"] = [];
  units.forEach((unit, index) => {
    const split = splitUnitAmountAcrossTenants(
      unitShares[index] ?? 0n,
      unit.id,
      unit.tenants,
      period.startDate,
      period.endDate,
      {
        distributionKey: "EQUAL",
        calculationBasis: `Gleicher Anteil: 1/${units.length} · Belegungstage`,
        sourceType: "SMALL_WASTEWATER",
        sourceReferenceId: costCategoryId,
      },
    );
    allocations.push(...split.allocations);
    vacancy += split.vacancyCents;
  });
  const tenantAmount = allocations.reduce(
    (sum, row) => sum + BigInt(row.amountCents),
    0n,
  );
  const sourceData = serializeExact({
    invoices,
    units,
    electricity,
    period: [isoDay(period.startDate), isoDay(period.endDate)],
  });
  const sourceFingerprint = createHash("sha256")
    .update(JSON.stringify(sourceData))
    .digest("hex");
  return {
    kind: "SMALL_WASTEWATER",
    billingPeriodId,
    costCategoryId,
    totalAmountCents: (eligible + excluded).toString(),
    tenantAmountCents: tenantAmount.toString(),
    landlordAmountCents: (excluded + vacancy).toString(),
    vacancyAmountCents: vacancy.toString(),
    allocations,
    details: {
      invoices: serializeExact(pool.details),
      eligibleAmountCents: eligible.toString(),
      excludedAmountCents: excluded.toString(),
      plantElectricityCents: electricity.amountCents.toString(),
      plantElectricityIntervals: electricity.details,
    },
    blockers,
    warnings,
    sourceFingerprint,
    sourceData,
  };
}
