-- AlterTable
ALTER TABLE "Document" ADD COLUMN "propertyId" TEXT;

-- AlterTable
ALTER TABLE "ElectricityTariff" ADD COLUMN "sourceDocumentId" TEXT;
ALTER TABLE "ElectricityTariff" ADD COLUMN "vatRate" DECIMAL;

-- AlterTable
ALTER TABLE "HeatingSystem" ADD COLUMN "activeTankId" TEXT;

-- CreateTable
CREATE TABLE "UnitStatePeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "unitId" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "areaM2" DECIMAL NOT NULL,
    "ownerOccupied" BOOLEAN NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UnitStatePeriod_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LeaseParty" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "sourceDocumentId" TEXT NOT NULL,
    CONSTRAINT "LeaseParty_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DomainChangePreview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "impactJson" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "resultJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DocumentStorage" (
    "testedAt" DATETIME,
    "testedFingerprint" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "propertyId" TEXT NOT NULL,
    "driveId" TEXT NOT NULL,
    "rootItemId" TEXT NOT NULL,
    "objectFolder" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DocumentStorage_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DocumentArchive" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "storageId" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "itemId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DocumentArchive_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" DATETIME,
    "leaseToken" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MicrosoftImportSource" (
    "testedAt" DATETIME,
    "testedFingerprint" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "propertyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mailbox" TEXT,
    "folderId" TEXT NOT NULL,
    "driveId" TEXT,
    "costCategoryId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autoBook" BOOLEAN NOT NULL DEFAULT false,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "cursor" TEXT,
    "nextRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdBy" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "ImportedSourceItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sourceVersion" TEXT
);

-- CreateTable
CREATE TABLE "StatementArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billingPeriodId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "revision" INTEGER,
    "previewId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "fingerprint" TEXT NOT NULL,
    "statementJson" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "StatementDispatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactId" TEXT NOT NULL,
    "previewId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "graphMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "acceptedAt" DATETIME,
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BillingNotice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "propertyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resolvedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InvoiceConsumption" (
    "billingPeriodId" TEXT NOT NULL,
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "amountCents" BIGINT NOT NULL
);

-- CreateTable
CREATE TABLE "AllocationConsumptionReading" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "costCategoryId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "readingDate" DATETIME NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "sourceDocumentId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "InvoiceVerifiedSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "expectedJson" TEXT NOT NULL,
    "expectedLinesJson" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CostInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billingPeriodId" TEXT,
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
    CONSTRAINT "CostInvoice_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CostInvoice_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostInvoice_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CostInvoice_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CostInvoice" ("billingPeriodId", "confirmedAt", "confirmedBy", "costCategoryId", "createdAt", "dataJson", "documentId", "id", "invoiceDate", "invoiceNumber", "note", "propertyId", "revisionOfId", "section", "serviceDate", "servicePeriodEnd", "servicePeriodStart", "status", "supplier", "totalAmountCents", "updatedAt") SELECT "billingPeriodId", "confirmedAt", "confirmedBy", "costCategoryId", "createdAt", "dataJson", "documentId", "id", "invoiceDate", "invoiceNumber", "note", "propertyId", "revisionOfId", "section", "serviceDate", "servicePeriodEnd", "servicePeriodStart", "status", "supplier", "totalAmountCents", "updatedAt" FROM "CostInvoice";
DROP TABLE "CostInvoice";
ALTER TABLE "new_CostInvoice" RENAME TO "CostInvoice";
CREATE UNIQUE INDEX "CostInvoice_documentId_key" ON "CostInvoice"("documentId");
CREATE INDEX "CostInvoice_billingPeriodId_costCategoryId_idx" ON "CostInvoice"("billingPeriodId", "costCategoryId");
CREATE TABLE "new_ElectricityReading" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "meterId" TEXT NOT NULL,
    "readingDate" DATETIME NOT NULL,
    "billingEffectiveDate" DATETIME,
    "readingKwh" DECIMAL NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'REGULAR',
    "estimationMethod" TEXT,
    "uncertaintyNote" TEXT,
    "confirmed" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ElectricityReading_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "ElectricityMeter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ElectricityReading" ("billingEffectiveDate", "createdAt", "id", "meterId", "note", "readingDate", "readingKwh", "reason") SELECT "billingEffectiveDate", "createdAt", "id", "meterId", "note", "readingDate", "readingKwh", "reason" FROM "ElectricityReading";
DROP TABLE "ElectricityReading";
ALTER TABLE "new_ElectricityReading" RENAME TO "ElectricityReading";
CREATE UNIQUE INDEX "ElectricityReading_meterId_readingDate_key" ON "ElectricityReading"("meterId", "readingDate");
CREATE TABLE "new_HeatMeterReading" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "meterId" TEXT NOT NULL,
    "readingDate" DATETIME NOT NULL,
    "billingEffectiveDate" DATETIME,
    "readingValue" DECIMAL NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "sourceDocumentId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HeatMeterReading_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "HeatMeter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_HeatMeterReading" ("billingEffectiveDate", "createdAt", "id", "meterId", "notes", "readingDate", "readingValue", "source") SELECT "billingEffectiveDate", "createdAt", "id", "meterId", "notes", "readingDate", "readingValue", "source" FROM "HeatMeterReading";
DROP TABLE "HeatMeterReading";
ALTER TABLE "new_HeatMeterReading" RENAME TO "HeatMeterReading";
CREATE UNIQUE INDEX "HeatMeterReading_meterId_readingDate_key" ON "HeatMeterReading"("meterId", "readingDate");
CREATE TABLE "new_LeaseFinancialPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "monthlyColdRentCents" BIGINT NOT NULL,
    "monthlyPrepaymentCents" BIGINT NOT NULL,
    "monthlyGeneralOperatingAndHeatingPrepaymentCents" BIGINT NOT NULL DEFAULT 0,
    "sourceDocumentId" TEXT,
    "monthlyElectricityPrepaymentCents" BIGINT NOT NULL DEFAULT 0,
    "monthlyFlatRateCents" BIGINT NOT NULL DEFAULT 0,
    "reason" TEXT,
    "revisionOfId" TEXT,
    "revisionReason" TEXT,
    "supersededAt" DATETIME,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaseFinancialPeriod_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LeaseFinancialPeriod" ("createdAt", "createdBy", "id", "monthlyColdRentCents", "monthlyFlatRateCents", "monthlyGeneralOperatingAndHeatingPrepaymentCents", "monthlyPrepaymentCents", "reason", "revisionOfId", "revisionReason", "supersededAt", "tenantId", "validFrom", "validTo") SELECT "createdAt", "createdBy", "id", "monthlyColdRentCents", "monthlyFlatRateCents", "monthlyGeneralOperatingAndHeatingPrepaymentCents", "monthlyPrepaymentCents", "reason", "revisionOfId", "revisionReason", "supersededAt", "tenantId", "validFrom", "validTo" FROM "LeaseFinancialPeriod";
DROP TABLE "LeaseFinancialPeriod";
ALTER TABLE "new_LeaseFinancialPeriod" RENAME TO "LeaseFinancialPeriod";
CREATE INDEX "LeaseFinancialPeriod_tenantId_validFrom_idx" ON "LeaseFinancialPeriod"("tenantId", "validFrom");
CREATE TABLE "new_PropertyCostAllocationRule" (
    "purpose" TEXT NOT NULL DEFAULT 'TOTAL',
    "supersededAt" DATETIME,
    "revisionOfId" TEXT,
    "consumptionSharePercent" INTEGER,
    "id" TEXT NOT NULL PRIMARY KEY,
    "propertyId" TEXT NOT NULL,
    "costCategoryId" TEXT NOT NULL,
    "allocationMethod" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "requiresTenantAgreement" BOOLEAN NOT NULL DEFAULT false,
    "explanation" TEXT,
    "sourceDocumentId" TEXT,
    "sourceNote" TEXT,
    "residentialEquivalentMicroEuroPerM2" BIGINT,
    "residentialAssessmentFactorMillionths" BIGINT,
    "municipalHebesatzBasisPoints" BIGINT,
    "annualAssessmentCents" BIGINT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PropertyCostAllocationRule_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PropertyCostAllocationRule_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PropertyCostAllocationRule" ("allocationMethod", "annualAssessmentCents", "costCategoryId", "createdAt", "createdBy", "explanation", "id", "municipalHebesatzBasisPoints", "propertyId", "requiresTenantAgreement", "residentialAssessmentFactorMillionths", "residentialEquivalentMicroEuroPerM2", "sourceDocumentId", "sourceNote", "updatedAt", "validFrom", "validTo") SELECT "allocationMethod", "annualAssessmentCents", "costCategoryId", "createdAt", "createdBy", "explanation", "id", "municipalHebesatzBasisPoints", "propertyId", "requiresTenantAgreement", "residentialAssessmentFactorMillionths", "residentialEquivalentMicroEuroPerM2", "sourceDocumentId", "sourceNote", "updatedAt", "validFrom", "validTo" FROM "PropertyCostAllocationRule";
DROP TABLE "PropertyCostAllocationRule";
ALTER TABLE "new_PropertyCostAllocationRule" RENAME TO "PropertyCostAllocationRule";
CREATE INDEX "PropertyCostAllocationRule_propertyId_costCategoryId_validFrom_idx" ON "PropertyCostAllocationRule"("propertyId", "costCategoryId", "validFrom");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "UnitStatePeriod_unitId_validFrom_idx" ON "UnitStatePeriod"("unitId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentStorage_propertyId_key" ON "DocumentStorage"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentStorage_driveId_rootItemId_objectFolder_key" ON "DocumentStorage"("driveId", "rootItemId", "objectFolder");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentArchive_documentId_key" ON "DocumentArchive"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentArchive_storageId_relativePath_key" ON "DocumentArchive"("storageId", "relativePath");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundJob_dedupeKey_key" ON "BackgroundJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "BackgroundJob_status_availableAt_idx" ON "BackgroundJob"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedSourceItem_sourceId_sourceKey_key" ON "ImportedSourceItem"("sourceId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "StatementArtifact_documentId_key" ON "StatementArtifact"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementArtifact_billingPeriodId_tenantId_revision_key" ON "StatementArtifact"("billingPeriodId", "tenantId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "StatementDispatch_previewId_key" ON "StatementDispatch"("previewId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingNotice_propertyId_key_key" ON "BillingNotice"("propertyId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceConsumption_lineId_snapshotId_key" ON "InvoiceConsumption"("lineId", "snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationConsumptionReading_costCategoryId_unitId_readingDate_key" ON "AllocationConsumptionReading"("costCategoryId", "unitId", "readingDate");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceVerifiedSample_documentId_key" ON "InvoiceVerifiedSample"("documentId");
