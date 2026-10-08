-- Align existing SQLite tables with declared Prisma relations and nullability.
-- Preserve all rows and the indexes used by invoice and allocation lookups.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CostAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billingPeriodId" TEXT NOT NULL,
    "costCategoryId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "tenantId" TEXT,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "quantity" DECIMAL,
    "distributionKey" TEXT NOT NULL,
    "calculationBasis" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceReferenceId" TEXT,
    "snapshotId" TEXT,
    "allocationRuleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CostAllocation_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BillingSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_allocationRuleId_fkey" FOREIGN KEY ("allocationRuleId") REFERENCES "PropertyCostAllocationRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CostAllocation" ("allocationRuleId", "amountCents", "billingPeriodId", "calculationBasis", "costCategoryId", "createdAt", "distributionKey", "id", "periodEnd", "periodStart", "quantity", "snapshotId", "sourceReferenceId", "sourceType", "tenantId", "unitId") SELECT "allocationRuleId", "amountCents", "billingPeriodId", "calculationBasis", "costCategoryId", "createdAt", "distributionKey", "id", "periodEnd", "periodStart", "quantity", "snapshotId", "sourceReferenceId", "sourceType", "tenantId", "unitId" FROM "CostAllocation";
DROP TABLE "CostAllocation";
ALTER TABLE "new_CostAllocation" RENAME TO "CostAllocation";
CREATE INDEX "CostAllocation_billingPeriodId_costCategoryId_idx" ON "CostAllocation"("billingPeriodId", "costCategoryId");
CREATE INDEX "CostAllocation_tenantId_idx" ON "CostAllocation"("tenantId");
CREATE INDEX "CostAllocation_allocationRuleId_idx" ON "CostAllocation"("allocationRuleId");
CREATE TABLE "new_CostInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billingPeriodId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "costCategoryId" TEXT NOT NULL,
    "supplier" TEXT,
    "invoiceNumber" TEXT,
    "invoiceDate" DATETIME,
    "serviceDate" DATETIME,
    "servicePeriodStart" DATETIME,
    "servicePeriodEnd" DATETIME,
    "totalAmountCents" BIGINT NOT NULL,
    "note" TEXT,
    "documentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CostInvoice_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostInvoice_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostInvoice_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CostInvoice_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CostInvoice" ("billingPeriodId", "costCategoryId", "createdAt", "documentId", "id", "invoiceDate", "invoiceNumber", "note", "propertyId", "serviceDate", "servicePeriodEnd", "servicePeriodStart", "supplier", "totalAmountCents", "updatedAt") SELECT "billingPeriodId", "costCategoryId", "createdAt", "documentId", "id", "invoiceDate", "invoiceNumber", "note", "propertyId", "serviceDate", "servicePeriodEnd", "servicePeriodStart", "supplier", "totalAmountCents", "updatedAt" FROM "CostInvoice";
DROP TABLE "CostInvoice";
ALTER TABLE "new_CostInvoice" RENAME TO "CostInvoice";
CREATE UNIQUE INDEX "CostInvoice_documentId_key" ON "CostInvoice"("documentId");
CREATE INDEX "CostInvoice_billingPeriodId_costCategoryId_idx" ON "CostInvoice"("billingPeriodId", "costCategoryId");
CREATE INDEX "CostInvoice_propertyId_servicePeriodStart_idx" ON "CostInvoice"("propertyId", "servicePeriodStart");
CREATE TABLE "new_CostInvoiceLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "costInvoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "classification" TEXT NOT NULL,
    "confirmedRunningExpense" BOOLEAN NOT NULL DEFAULT false,
    "directUnitId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CostInvoiceLine_costInvoiceId_fkey" FOREIGN KEY ("costInvoiceId") REFERENCES "CostInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostInvoiceLine_directUnitId_fkey" FOREIGN KEY ("directUnitId") REFERENCES "Unit" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CostInvoiceLine" ("amountCents", "classification", "confirmedRunningExpense", "costInvoiceId", "createdAt", "description", "directUnitId", "id", "updatedAt") SELECT "amountCents", "classification", "confirmedRunningExpense", "costInvoiceId", "createdAt", "description", "directUnitId", "id", "updatedAt" FROM "CostInvoiceLine";
DROP TABLE "CostInvoiceLine";
ALTER TABLE "new_CostInvoiceLine" RENAME TO "CostInvoiceLine";
CREATE INDEX "CostInvoiceLine_directUnitId_idx" ON "CostInvoiceLine"("directUnitId");
CREATE TABLE "new_OilStockReading" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tankId" TEXT NOT NULL,
    "oilFoxDeviceId" TEXT,
    "deviceHwid" TEXT,
    "readingDate" DATETIME NOT NULL,
    "billingEffectiveDate" DATETIME,
    "quantityLiters" DECIMAL,
    "fillLevelPercent" INTEGER,
    "batteryLevel" TEXT,
    "validationError" TEXT,
    "distanceCm" DECIMAL,
    "meteringStatus" TEXT,
    "manuallyInvalidated" BOOLEAN,
    "meteringType" TEXT,
    "signalStrength" TEXT,
    "method" TEXT NOT NULL DEFAULT 'MANUAL',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "documentId" TEXT,
    "oilFoxCsvImportId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OilStockReading_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "HeatingOilTank" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OilStockReading_oilFoxDeviceId_fkey" FOREIGN KEY ("oilFoxDeviceId") REFERENCES "OilFoxDevice" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OilStockReading_oilFoxCsvImportId_fkey" FOREIGN KEY ("oilFoxCsvImportId") REFERENCES "OilFoxCsvImport" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_OilStockReading" ("batteryLevel", "billingEffectiveDate", "confirmed", "createdAt", "deviceHwid", "distanceCm", "documentId", "fillLevelPercent", "id", "manuallyInvalidated", "meteringStatus", "meteringType", "method", "note", "oilFoxCsvImportId", "oilFoxDeviceId", "quantityLiters", "readingDate", "signalStrength", "source", "tankId", "validationError") SELECT "batteryLevel", "billingEffectiveDate", "confirmed", "createdAt", "deviceHwid", "distanceCm", "documentId", "fillLevelPercent", "id", "manuallyInvalidated", "meteringStatus", "meteringType", "method", "note", "oilFoxCsvImportId", "oilFoxDeviceId", "quantityLiters", "readingDate", "signalStrength", "source", "tankId", "validationError" FROM "OilStockReading";
DROP TABLE "OilStockReading";
ALTER TABLE "new_OilStockReading" RENAME TO "OilStockReading";
CREATE INDEX "OilStockReading_tankId_readingDate_idx" ON "OilStockReading"("tankId", "readingDate");
CREATE INDEX "OilStockReading_oilFoxCsvImportId_idx" ON "OilStockReading"("oilFoxCsvImportId");
CREATE UNIQUE INDEX "OilStockReading_oilFoxDeviceId_readingDate_key" ON "OilStockReading"("oilFoxDeviceId", "readingDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

