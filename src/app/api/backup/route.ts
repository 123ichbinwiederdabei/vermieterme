import { ApiError, apiHandler, jsonOk, requireAuth } from "@/lib/api-utils";
import { serializeExact } from "@/lib/billing-v2";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { prisma } from "@/lib/prisma";

const modelReads = {
  propertyTaxSettings: () => prisma.propertyTaxSetting.findMany(),
  costInvoices: () => prisma.costInvoice.findMany(),
  costInvoiceLines: () => prisma.costInvoiceLine.findMany(),
  leaseCostCategoryAgreements: () =>
    prisma.leaseCostCategoryAgreement.findMany(),
  oilFoxCsvImports: () => prisma.oilFoxCsvImport.findMany(),
  invoiceTemplates: () => prisma.invoiceTemplate.findMany(),
  invoiceAttachments: () => prisma.invoiceAttachment.findMany(),
  invoiceExtractionJobs: () => prisma.invoiceExtractionJob.findMany(),
  categoryCalculationHeads: () => prisma.categoryCalculationHead.findMany(),
  statementRevisions: () => prisma.statementRevision.findMany(),
  properties: () => prisma.property.findMany(),
  units: () => prisma.unit.findMany(),
  tenants: () => prisma.tenant.findMany(),
  costCategories: () => prisma.costCategory.findMany(),
  billingPeriods: () => prisma.billingPeriod.findMany(),
  costs: () => prisma.cost.findMany(),
  prepayments: () => prisma.prepayment.findMany(),
  landlordInfo: () => prisma.landlordInfo.findMany(),
  pdfTemplates: () => prisma.pdfTemplate.findMany(),
  rentChanges: () => prisma.rentChange.findMany(),
  vpiEntries: () => prisma.vpiEntry.findMany(),
  documents: () => prisma.document.findMany(),
  heatingSystems: () => prisma.heatingSystem.findMany(),
  heatingSystemUnits: () => prisma.heatingSystemUnit.findMany(),
  heatingOilTanks: () => prisma.heatingOilTank.findMany(),
  heatingOilDeliveries: () => prisma.heatingOilDelivery.findMany(),
  oilInventoryLots: () => prisma.oilInventoryLot.findMany(),
  oilStockReadings: () => prisma.oilStockReading.findMany(),
  oilFoxDevices: () => prisma.oilFoxDevice.findMany(),
  oilDeliveryCandidates: () => prisma.oilDeliveryCandidate.findMany(),
  oilFoxSyncStates: () => prisma.oilFoxSyncState.findMany(),
  electricityContracts: () => prisma.electricityContract.findMany(),
  electricityTariffs: () => prisma.electricityTariff.findMany(),
  electricityMeters: () => prisma.electricityMeter.findMany(),
  electricityReadings: () => prisma.electricityReading.findMany(),
  electricityReadingAudits: () => prisma.electricityReadingAudit.findMany(),
  externalBillingClosings: () => prisma.externalBillingClosing.findMany(),
  externalBillingClosingTenants: () =>
    prisma.externalBillingClosingTenant.findMany(),
  leaseFinancialPeriods: () => prisma.leaseFinancialPeriod.findMany(),
  prepaymentComponents: () => prisma.prepaymentComponent.findMany(),
  billingSnapshots: () => prisma.billingSnapshot.findMany(),
  costAllocations: () => prisma.costAllocation.findMany(),
  oilLotConsumptions: () => prisma.oilLotConsumption.findMany(),
};

export function GET() {
  return apiHandler(async () => {
    await requireAuth();
    const entries = await Promise.all(
      Object.entries(modelReads).map(
        async ([key, read]) => [key, await read()] as const,
      ),
    );
    const body = serializeExact({
      version: 3,
      exportedAt: new Date().toISOString(),
      data: Object.fromEntries(entries),
    });
    return new Response(JSON.stringify(body, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="vermieterme-backup-v3-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  });
}

const RESTORE_ORDER: Array<[string, keyof typeof prisma]> = [
  ["properties", "property"],
  ["costCategories", "costCategory"],
  ["units", "unit"],
  ["tenants", "tenant"],
  ["billingPeriods", "billingPeriod"],
  ["documents", "document"],
  ["propertyTaxSettings", "propertyTaxSetting"],
  ["heatingSystems", "heatingSystem"],
  ["heatingSystemUnits", "heatingSystemUnit"],
  ["heatingOilTanks", "heatingOilTank"],
  ["oilFoxDevices", "oilFoxDevice"],
  ["heatingOilDeliveries", "heatingOilDelivery"],
  ["oilInventoryLots", "oilInventoryLot"],
  ["oilFoxCsvImports", "oilFoxCsvImport"],
  ["oilStockReadings", "oilStockReading"],
  ["oilDeliveryCandidates", "oilDeliveryCandidate"],
  ["oilFoxSyncStates", "oilFoxSyncState"],
  ["electricityContracts", "electricityContract"],
  ["electricityTariffs", "electricityTariff"],
  ["electricityMeters", "electricityMeter"],
  ["electricityReadings", "electricityReading"],
  ["electricityReadingAudits", "electricityReadingAudit"],
  ["externalBillingClosings", "externalBillingClosing"],
  ["externalBillingClosingTenants", "externalBillingClosingTenant"],
  ["leaseFinancialPeriods", "leaseFinancialPeriod"],
  ["prepaymentComponents", "prepaymentComponent"],
  ["costs", "cost"],
  ["prepayments", "prepayment"],
  ["billingSnapshots", "billingSnapshot"],
  ["costAllocations", "costAllocation"],
  ["oilLotConsumptions", "oilLotConsumption"],
  ["categoryCalculationHeads", "categoryCalculationHead"],
  ["statementRevisions", "statementRevision"],
  ["costInvoices", "costInvoice"],
  ["costInvoiceLines", "costInvoiceLine"],
  ["leaseCostCategoryAgreements", "leaseCostCategoryAgreement"],
  ["invoiceTemplates", "invoiceTemplate"],
  ["invoiceAttachments", "invoiceAttachment"],
  ["invoiceExtractionJobs", "invoiceExtractionJob"],
  ["landlordInfo", "landlordInfo"],
  ["pdfTemplates", "pdfTemplate"],
  ["rentChanges", "rentChange"],
  ["vpiEntries", "vpiEntry"],
];
export function POST(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const body = (await request.json()) as {
      version: number;
      data: Record<string, unknown>;
    };
    if (body.version !== 3 || !body.data)
      throw new ApiError(
        "Version-3-Backup erforderlich; ältere Sicherungen isoliert migrieren",
        400,
      );
    for (const key of Object.keys(modelReads))
      if (!Array.isArray(body.data[key]))
        throw new ApiError(`Backup-Tabelle ${key} fehlt`, 400);
    if (
      (await prisma.billingSnapshot.count()) ||
      (await prisma.property.count())
    )
      throw new ApiError(
        "Wiederherstellung nur in eine leere Datenbank. Vorhandene Daten durch verifizierten SQLite-/Uploads-Backup wiederherstellen.",
        409,
      );
    // JSON contains metadata; the separate uploads archive must already be restored.
    for (const document of body.data.documents as Array<{
      fileName: string;
      fileHash: string | null;
    }>) {
      if (path.basename(document.fileName) !== document.fileName)
        throw new ApiError("Ungültiger Dateiname im Backup", 400);
      let bytes: Buffer;
      try {
        bytes = await readFile(
          path.join(process.cwd(), "data/uploads", document.fileName),
        );
      } catch {
        throw new ApiError(
          "Upload-Archiv vor dem Datenimport wiederherstellen",
          400,
        );
      }
      if (
        document.fileHash &&
        createHash("sha256").update(bytes).digest("hex") !== document.fileHash
      )
        throw new ApiError(
          "Upload-Prüfsumme stimmt nicht mit dem Backup überein",
          400,
        );
    }
    await prisma.$transaction(async (tx) => {
      // The migration inserts the water category even in an otherwise empty database.
      const existingCategories = await tx.costCategory.findMany();
      if (existingCategories.some((row) => row.id !== "krandorf-water"))
        throw new ApiError(
          "Wiederherstellung benötigt eine leere Datenbank ohne eigene Kostenarten",
          409,
        );
      await tx.costCategory.deleteMany();
      for (const [key, model] of RESTORE_ORDER) {
        const rows = body.data[key] as Record<string, unknown>[];
        const prepared = rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([field, value]) => [
              field,
              value !== null &&
              typeof value === "string" &&
              (field.endsWith("Cents") ||
                [
                  "priceMicroEuroPerKwh",
                  "annualRateMicroCentsPerM2",
                  "co2Grams",
                  "emissionFactorMicrogWh",
                ].includes(field))
                ? BigInt(value)
                : value,
            ]),
          ),
        );
        if (prepared.length)
          await (
            tx[model as keyof typeof tx] as unknown as {
              createMany: (args: {
                data: Record<string, unknown>[];
              }) => Promise<unknown>;
            }
          ).createMany({ data: prepared });
      }
    });
    return jsonOk({ success: true, version: 3 });
  });
}
