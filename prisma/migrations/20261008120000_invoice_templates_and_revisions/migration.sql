-- AlterTable
ALTER TABLE "Document" ADD COLUMN "fileHash" TEXT;

-- AlterTable
ALTER TABLE "HeatingSystem" ADD COLUMN "evidenceValidatedAt" DATETIME;
ALTER TABLE "HeatingSystem" ADD COLUMN "evidenceValidatedBy" TEXT;

-- AlterTable
ALTER TABLE "ElectricityContract" ADD COLUMN "basePriceAgreementNote" TEXT;

-- CreateTable
CREATE TABLE "InvoiceTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "seriesId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "costCategoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "section" TEXT NOT NULL DEFAULT 'OPERATING',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "rulesJson" TEXT NOT NULL,
    "markersJson" TEXT NOT NULL,
    "testResultsJson" TEXT,
    "testedHash" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" DATETIME,
    CONSTRAINT "InvoiceTemplate_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InvoiceAttachment" (
    "invoiceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,

    PRIMARY KEY ("invoiceId", "documentId"),
    CONSTRAINT "InvoiceAttachment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CostInvoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoiceAttachment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InvoiceExtractionJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "templateId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" DATETIME,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ocrJson" TEXT,
    "resultJson" TEXT,
    "error" TEXT,
    "confirmedBy" TEXT,
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InvoiceExtractionJob_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CostInvoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoiceExtractionJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoiceExtractionJob_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "InvoiceTemplate" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CategoryCalculationHead" (
    "billingPeriodId" TEXT NOT NULL,
    "costCategoryId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "stale" BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY ("billingPeriodId", "costCategoryId"),
    CONSTRAINT "CategoryCalculationHead_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CategoryCalculationHead_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BillingSnapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StatementRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billingPeriodId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "revisionOfId" TEXT,
    "reason" TEXT,
    "payloadJson" TEXT NOT NULL,
    "snapshotIdsJson" TEXT NOT NULL,
    "calculationVersion" TEXT NOT NULL DEFAULT 'krandorf-v3',
    "issuedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StatementRevision_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CostCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "distributionKey" TEXT NOT NULL,
    "calculationType" TEXT NOT NULL DEFAULT 'MANUAL',
    "code" TEXT NOT NULL DEFAULT 'OTHER',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CostCategory" ("calculationType", "createdAt", "distributionKey", "id", "name", "sortOrder", "updatedAt") SELECT "calculationType", "createdAt", "distributionKey", "id", "name", "sortOrder", "updatedAt" FROM "CostCategory";
DROP TABLE "CostCategory";
ALTER TABLE "new_CostCategory" RENAME TO "CostCategory";
CREATE TABLE "new_BillingPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "propertyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "billingDate" DATETIME,
    "sentDate" DATETIME,
    "paidDate" DATETIME,
    "sourceRevision" INTEGER NOT NULL DEFAULT 0,
    "revisionOfPeriodId" TEXT,
    "revisionReason" TEXT,
    "copiedFromId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BillingPeriod_copiedFromId_fkey" FOREIGN KEY ("copiedFromId") REFERENCES "BillingPeriod" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BillingPeriod_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BillingPeriod" ("billingDate", "copiedFromId", "createdAt", "endDate", "id", "paidDate", "propertyId", "sentDate", "startDate", "status", "updatedAt") SELECT "billingDate", "copiedFromId", "createdAt", "endDate", "id", "paidDate", "propertyId", "sentDate", "startDate", "status", "updatedAt" FROM "BillingPeriod";
DROP TABLE "BillingPeriod";
ALTER TABLE "new_BillingPeriod" RENAME TO "BillingPeriod";
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
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "section" TEXT NOT NULL DEFAULT 'OPERATING',
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "confirmedBy" TEXT,
    "confirmedAt" DATETIME,
    "revisionOfId" TEXT,
    "note" TEXT,
    "documentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CostInvoice_revisionOfId_fkey" FOREIGN KEY ("revisionOfId") REFERENCES "CostInvoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
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
CREATE TABLE "new_HeatingOilDelivery" (
    "revisionOfId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "tankId" TEXT NOT NULL,
    "deliveryDate" DATETIME NOT NULL,
    "invoiceDate" DATETIME,
    "quantityLiters" DECIMAL NOT NULL,
    "totalAmountCents" BIGINT NOT NULL,
    "additionalChargesCents" BIGINT NOT NULL DEFAULT 0,
    "priceCentsPerLiter" INTEGER,
    "co2CostCents" BIGINT NOT NULL DEFAULT 0,
    "co2Grams" BIGINT NOT NULL DEFAULT 0,
    "emissionFactorMicrogWh" BIGINT NOT NULL DEFAULT 0,
    "energyContentKwh" DECIMAL NOT NULL DEFAULT 0,
    "invoiceNumber" TEXT,
    "supplier" TEXT,
    "documentId" TEXT,
    "beforeMeasurementId" TEXT,
    "afterMeasurementId" TEXT,
    "detectedIncreaseLiters" DECIMAL,
    "confirmationStatus" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HeatingOilDelivery_revisionOfId_fkey" FOREIGN KEY ("revisionOfId") REFERENCES "HeatingOilDelivery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "HeatingOilDelivery_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "HeatingOilTank" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HeatingOilDelivery_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_HeatingOilDelivery" ("additionalChargesCents", "afterMeasurementId", "beforeMeasurementId", "co2CostCents", "co2Grams", "confirmationStatus", "createdAt", "deliveryDate", "detectedIncreaseLiters", "documentId", "emissionFactorMicrogWh", "energyContentKwh", "id", "invoiceDate", "invoiceNumber", "notes", "priceCentsPerLiter", "quantityLiters", "supplier", "tankId", "totalAmountCents", "updatedAt") SELECT "additionalChargesCents", "afterMeasurementId", "beforeMeasurementId", "co2CostCents", "co2Grams", "confirmationStatus", "createdAt", "deliveryDate", "detectedIncreaseLiters", "documentId", "emissionFactorMicrogWh", "energyContentKwh", "id", "invoiceDate", "invoiceNumber", "notes", "priceCentsPerLiter", "quantityLiters", "supplier", "tankId", "totalAmountCents", "updatedAt" FROM "HeatingOilDelivery";
DROP TABLE "HeatingOilDelivery";
ALTER TABLE "new_HeatingOilDelivery" RENAME TO "HeatingOilDelivery";
CREATE UNIQUE INDEX "HeatingOilDelivery_documentId_key" ON "HeatingOilDelivery"("documentId");
CREATE INDEX "HeatingOilDelivery_tankId_deliveryDate_idx" ON "HeatingOilDelivery"("tankId", "deliveryDate");
CREATE TABLE "new_OilInventoryLot" (
    "revisionOfId" TEXT,
    "revisionNumber" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL PRIMARY KEY,
    "tankId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceDate" DATETIME NOT NULL,
    "quantityLiters" DECIMAL NOT NULL,
    "totalAmountCents" BIGINT NOT NULL,
    "co2CostCents" BIGINT NOT NULL DEFAULT 0,
    "co2Grams" BIGINT NOT NULL DEFAULT 0,
    "emissionFactorMicrogWh" BIGINT NOT NULL DEFAULT 0,
    "energyContentKwh" DECIMAL NOT NULL DEFAULT 0,
    "note" TEXT,
    "co2EvidenceReference" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OilInventoryLot_revisionOfId_fkey" FOREIGN KEY ("revisionOfId") REFERENCES "OilInventoryLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OilInventoryLot_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "HeatingOilTank" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OilInventoryLot_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "HeatingOilDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_OilInventoryLot" ("co2CostCents", "co2Grams", "createdAt", "deliveryId", "emissionFactorMicrogWh", "energyContentKwh", "id", "note", "quantityLiters", "sourceDate", "sourceType", "tankId", "totalAmountCents") SELECT "co2CostCents", "co2Grams", "createdAt", "deliveryId", "emissionFactorMicrogWh", "energyContentKwh", "id", "note", "quantityLiters", "sourceDate", "sourceType", "tankId", "totalAmountCents" FROM "OilInventoryLot";
DROP TABLE "OilInventoryLot";
ALTER TABLE "new_OilInventoryLot" RENAME TO "OilInventoryLot";
CREATE UNIQUE INDEX "OilInventoryLot_deliveryId_key" ON "OilInventoryLot"("deliveryId");
CREATE INDEX "OilInventoryLot_tankId_sourceDate_idx" ON "OilInventoryLot"("tankId", "sourceDate");
CREATE TABLE "new_OilLotConsumption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "quantityLiters" DECIMAL NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "co2CostCents" BIGINT NOT NULL,
    "co2Grams" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OilLotConsumption_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "OilInventoryLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OilLotConsumption_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BillingSnapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_OilLotConsumption" ("active", "amountCents", "co2CostCents", "co2Grams", "createdAt", "id", "lotId", "quantityLiters", "snapshotId") SELECT "active", "amountCents", "co2CostCents", "co2Grams", "createdAt", "id", "lotId", "quantityLiters", "snapshotId" FROM "OilLotConsumption";
DROP TABLE "OilLotConsumption";
ALTER TABLE "new_OilLotConsumption" RENAME TO "OilLotConsumption";
CREATE INDEX "OilLotConsumption_snapshotId_active_idx" ON "OilLotConsumption"("snapshotId", "active");
CREATE UNIQUE INDEX "OilLotConsumption_lotId_snapshotId_key" ON "OilLotConsumption"("lotId", "snapshotId");
CREATE TABLE "new_BillingSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billingPeriodId" TEXT NOT NULL,
    "costCategoryId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "sourceFingerprint" TEXT NOT NULL,
    "sourceJson" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "revisionOfId" TEXT,
    "appliedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingSnapshot_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_BillingSnapshot" ("appliedBy", "billingPeriodId", "costCategoryId", "createdAt", "id", "kind", "resultJson", "revisionOfId", "sourceFingerprint", "sourceJson", "status") SELECT "appliedBy", "billingPeriodId", "costCategoryId", "createdAt", "id", "kind", "resultJson", "revisionOfId", "sourceFingerprint", "sourceJson", "status" FROM "BillingSnapshot";
DROP TABLE "BillingSnapshot";
ALTER TABLE "new_BillingSnapshot" RENAME TO "BillingSnapshot";
CREATE INDEX "BillingSnapshot_billingPeriodId_kind_idx" ON "BillingSnapshot"("billingPeriodId", "kind");
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CostAllocation_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BillingSnapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_CostAllocation" ("amountCents", "billingPeriodId", "calculationBasis", "costCategoryId", "createdAt", "distributionKey", "id", "periodEnd", "periodStart", "quantity", "snapshotId", "sourceReferenceId", "sourceType", "tenantId", "unitId") SELECT "amountCents", "billingPeriodId", "calculationBasis", "costCategoryId", "createdAt", "distributionKey", "id", "periodEnd", "periodStart", "quantity", "snapshotId", "sourceReferenceId", "sourceType", "tenantId", "unitId" FROM "CostAllocation";
DROP TABLE "CostAllocation";
ALTER TABLE "new_CostAllocation" RENAME TO "CostAllocation";
CREATE INDEX "CostAllocation_billingPeriodId_costCategoryId_idx" ON "CostAllocation"("billingPeriodId", "costCategoryId");
CREATE INDEX "CostAllocation_tenantId_idx" ON "CostAllocation"("tenantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "InvoiceTemplate_costCategoryId_status_idx" ON "InvoiceTemplate"("costCategoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceTemplate_seriesId_version_key" ON "InvoiceTemplate"("seriesId", "version");

-- CreateIndex
CREATE INDEX "InvoiceExtractionJob_status_availableAt_idx" ON "InvoiceExtractionJob"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryCalculationHead_snapshotId_key" ON "CategoryCalculationHead"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementRevision_billingPeriodId_tenantId_revision_key" ON "StatementRevision"("billingPeriodId", "tenantId", "revision");

-- Preserve names/IDs used by leases while introducing stable domain codes.
UPDATE CostCategory SET code = CASE
 WHEN calculationType = 'HEATING_OIL' THEN 'HEATING'
 WHEN calculationType = 'ELECTRICITY' THEN 'ELECTRICITY'
 WHEN name LIKE '%Kleinkläranlage%' THEN 'WASTEWATER'
 WHEN name LIKE '%Grundsteuer%' THEN 'PROPERTY_TAX'
 WHEN name LIKE '%Müll%' THEN 'WASTE'
 WHEN name IN ('Wasser', 'Wasserversorgung') THEN 'WATER'
 ELSE 'OTHER' END;
INSERT INTO CostCategory (id,name,distributionKey,calculationType,code,sortOrder,updatedAt)
 SELECT 'krandorf-water','Wasserversorgung','Wohnfläche','MANUAL','WATER',3,CURRENT_TIMESTAMP
 WHERE NOT EXISTS (SELECT 1 FROM CostCategory WHERE code='WATER');
INSERT INTO CategoryCalculationHead (billingPeriodId,costCategoryId,snapshotId,stale)
 SELECT s.billingPeriodId,s.costCategoryId,s.id,1 FROM BillingSnapshot s
 WHERE s.costCategoryId IS NOT NULL AND s.status='APPLIED'
 AND NOT EXISTS (SELECT 1 FROM BillingSnapshot n WHERE n.billingPeriodId=s.billingPeriodId AND n.costCategoryId=s.costCategoryId AND n.status='APPLIED' AND (n.createdAt>s.createdAt OR (n.createdAt=s.createdAt AND n.id>s.id)));
-- Legacy float amounts are converted only when exactly representable as cents.
UPDATE Cost SET totalAmountCents=CAST(ROUND(totalAmount*100) AS INTEGER),reviewed=0
 WHERE totalAmountCents IS NULL AND totalAmount>=0 AND ABS(totalAmount*100-ROUND(totalAmount*100))<0.0000001;
