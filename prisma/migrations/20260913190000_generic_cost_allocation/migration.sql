-- Effective-dated, configuration-driven operating-cost allocation.
ALTER TABLE "HeatingOilTank" ADD COLUMN "activeFrom" DATETIME;
ALTER TABLE "HeatingOilTank" ADD COLUMN "activeTo" DATETIME;
ALTER TABLE "HeatingOilTank" ADD COLUMN "archivedAt" DATETIME;

ALTER TABLE "OilStockReading" ADD COLUMN "billingEffectiveDate" DATETIME;
ALTER TABLE "ElectricityReading" ADD COLUMN "billingEffectiveDate" DATETIME;
ALTER TABLE "CostInvoiceLine" ADD COLUMN "directUnitId" TEXT;
ALTER TABLE "LeaseFinancialPeriod" ADD COLUMN "monthlyGeneralOperatingAndHeatingPrepaymentCents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "LeaseFinancialPeriod" ADD COLUMN "monthlyFlatRateCents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "CostAllocation" ADD COLUMN "allocationRuleId" TEXT;

CREATE TABLE "PropertyCostAllocationRule" (
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

CREATE TABLE "PropertyCostAllocationRuleUnit" (
  "ruleId" TEXT NOT NULL,
  "unitId" TEXT NOT NULL,
  "included" BOOLEAN NOT NULL DEFAULT true,
  "weight" DECIMAL,
  "areaM2" DECIMAL,
  PRIMARY KEY ("ruleId", "unitId"),
  CONSTRAINT "PropertyCostAllocationRuleUnit_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PropertyCostAllocationRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PropertyCostAllocationRuleUnit_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "LeaseFlatRateCoverage" (
  "financialPeriodId" TEXT NOT NULL,
  "costCategoryId" TEXT NOT NULL,
  PRIMARY KEY ("financialPeriodId", "costCategoryId"),
  CONSTRAINT "LeaseFlatRateCoverage_financialPeriodId_fkey" FOREIGN KEY ("financialPeriodId") REFERENCES "LeaseFinancialPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LeaseFlatRateCoverage_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "HeatMeter" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "heatingSystemId" TEXT NOT NULL,
  "unitId" TEXT NOT NULL,
  "meterNumber" TEXT NOT NULL,
  "meterType" TEXT NOT NULL DEFAULT 'HEAT',
  "validFrom" DATETIME NOT NULL,
  "validTo" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "HeatMeter_heatingSystemId_fkey" FOREIGN KEY ("heatingSystemId") REFERENCES "HeatingSystem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "HeatMeter_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "HeatMeterReading" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "meterId" TEXT NOT NULL,
  "readingDate" DATETIME NOT NULL,
  "billingEffectiveDate" DATETIME,
  "readingValue" DECIMAL NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "notes" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HeatMeterReading_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "HeatMeter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "OilInventoryBaseline" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tankId" TEXT NOT NULL,
  "effectiveDate" DATETIME NOT NULL,
  "sourceMeasurementId" TEXT,
  "inventoryLotId" TEXT NOT NULL,
  "confirmedBy" TEXT,
  "confirmedAt" DATETIME,
  "sourceDocumentId" TEXT,
  "note" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OilInventoryBaseline_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "HeatingOilTank" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OilInventoryBaseline_inventoryLotId_fkey" FOREIGN KEY ("inventoryLotId") REFERENCES "OilInventoryLot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "BillingPeriodEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "billingPeriodId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "documentId" TEXT,
  "note" TEXT,
  "confirmedBy" TEXT NOT NULL,
  "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingPeriodEvidence_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PropertyCostAllocationRule_propertyId_costCategoryId_validFrom_idx" ON "PropertyCostAllocationRule"("propertyId", "costCategoryId", "validFrom");
CREATE INDEX "PropertyCostAllocationRuleUnit_unitId_idx" ON "PropertyCostAllocationRuleUnit"("unitId");
CREATE UNIQUE INDEX "HeatMeter_heatingSystemId_meterNumber_key" ON "HeatMeter"("heatingSystemId", "meterNumber");
CREATE INDEX "HeatMeter_unitId_idx" ON "HeatMeter"("unitId");
CREATE UNIQUE INDEX "HeatMeterReading_meterId_readingDate_key" ON "HeatMeterReading"("meterId", "readingDate");
CREATE UNIQUE INDEX "OilInventoryBaseline_inventoryLotId_key" ON "OilInventoryBaseline"("inventoryLotId");
CREATE UNIQUE INDEX "OilInventoryBaseline_tankId_effectiveDate_key" ON "OilInventoryBaseline"("tankId", "effectiveDate");
CREATE UNIQUE INDEX "BillingPeriodEvidence_billingPeriodId_kind_key" ON "BillingPeriodEvidence"("billingPeriodId", "kind");
CREATE INDEX "CostInvoiceLine_directUnitId_idx" ON "CostInvoiceLine"("directUnitId");
CREATE INDEX "CostAllocation_allocationRuleId_idx" ON "CostAllocation"("allocationRuleId");
