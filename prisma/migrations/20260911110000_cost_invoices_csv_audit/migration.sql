-- Beleggestuetzte Kleinklaeranlagenkosten und vertragliche Freigaben.
CREATE TABLE "CostInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billingPeriodId" TEXT NOT NULL,
    "costCategoryId" TEXT NOT NULL,
    "supplier" TEXT,
    "invoiceNumber" TEXT,
    "invoiceDate" DATETIME,
    "serviceDate" DATETIME,
    "totalAmountCents" BIGINT NOT NULL,
    "note" TEXT,
    "documentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CostInvoice_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostInvoice_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CostInvoice_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CostInvoice_documentId_key" ON "CostInvoice"("documentId");
CREATE INDEX "CostInvoice_billingPeriodId_costCategoryId_idx" ON "CostInvoice"("billingPeriodId", "costCategoryId");

CREATE TABLE "CostInvoiceLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "costInvoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "classification" TEXT NOT NULL,
    "confirmedRunningExpense" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CostInvoiceLine_costInvoiceId_fkey" FOREIGN KEY ("costInvoiceId") REFERENCES "CostInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "LeaseCostCategoryAgreement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "costCategoryId" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedBy" TEXT NOT NULL,
    "contractDocumentId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LeaseCostCategoryAgreement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LeaseCostCategoryAgreement_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LeaseCostCategoryAgreement_tenantId_costCategoryId_validFrom_idx" ON "LeaseCostCategoryAgreement"("tenantId", "costCategoryId", "validFrom");

CREATE TABLE "OilFoxCsvImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tankId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedDuplicates" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OilFoxCsvImport_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "HeatingOilTank" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OilFoxCsvImport_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "OilFoxDevice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OilFoxCsvImport_tankId_deviceId_fileHash_key" ON "OilFoxCsvImport"("tankId", "deviceId", "fileHash");
CREATE INDEX "OilFoxCsvImport_tankId_importedAt_idx" ON "OilFoxCsvImport"("tankId", "importedAt");

ALTER TABLE "OilStockReading" ADD COLUMN "oilFoxCsvImportId" TEXT;
CREATE INDEX "OilStockReading_oilFoxCsvImportId_idx" ON "OilStockReading"("oilFoxCsvImportId");
