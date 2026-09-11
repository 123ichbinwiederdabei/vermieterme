-- CSV source metadata and a complete technical tank profile.
ALTER TABLE "HeatingOilTank" ADD COLUMN "location" TEXT;
ALTER TABLE "HeatingOilTank" ADD COLUMN "manufacturer" TEXT;
ALTER TABLE "HeatingOilTank" ADD COLUMN "model" TEXT;
ALTER TABLE "HeatingOilTank" ADD COLUMN "serialNumber" TEXT;
ALTER TABLE "HeatingOilTank" ADD COLUMN "tankType" TEXT;
ALTER TABLE "HeatingOilTank" ADD COLUMN "material" TEXT;
ALTER TABLE "HeatingOilTank" ADD COLUMN "lengthMm" DECIMAL;
ALTER TABLE "HeatingOilTank" ADD COLUMN "widthMm" DECIMAL;
ALTER TABLE "HeatingOilTank" ADD COLUMN "heightMm" DECIMAL;
ALTER TABLE "HeatingOilTank" ADD COLUMN "diameterMm" DECIMAL;
ALTER TABLE "HeatingOilTank" ADD COLUMN "usableVolumeLiters" DECIMAL;
ALTER TABLE "HeatingOilTank" ADD COLUMN "measurementNotes" TEXT;
ALTER TABLE "HeatingOilTank" ADD COLUMN "notes" TEXT;

ALTER TABLE "OilStockReading" ADD COLUMN "meteringStatus" TEXT;
ALTER TABLE "OilStockReading" ADD COLUMN "manuallyInvalidated" BOOLEAN;
ALTER TABLE "OilStockReading" ADD COLUMN "meteringType" TEXT;
ALTER TABLE "OilStockReading" ADD COLUMN "signalStrength" TEXT;

ALTER TABLE "ElectricityTariff" ADD COLUMN "billingValidFrom" DATETIME;
ALTER TABLE "ElectricityTariff" ADD COLUMN "billingValidTo" DATETIME;
ALTER TABLE "ElectricityTariff" ADD COLUMN "billingEffectiveReason" TEXT;

CREATE TABLE "ExternalBillingClosing" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "propertyId" TEXT NOT NULL,
  "closingDate" DATETIME NOT NULL,
  "note" TEXT,
  "createdBy" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalBillingClosing_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ExternalBillingClosing_propertyId_closingDate_key" ON "ExternalBillingClosing"("propertyId", "closingDate");
CREATE INDEX "ExternalBillingClosing_propertyId_closingDate_idx" ON "ExternalBillingClosing"("propertyId", "closingDate");

CREATE TABLE "ExternalBillingClosingTenant" (
  "closingId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  PRIMARY KEY ("closingId", "tenantId"),
  CONSTRAINT "ExternalBillingClosingTenant_closingId_fkey" FOREIGN KEY ("closingId") REFERENCES "ExternalBillingClosing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExternalBillingClosingTenant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ExternalBillingClosingTenant_tenantId_idx" ON "ExternalBillingClosingTenant"("tenantId");

CREATE TABLE "ElectricityReadingAudit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "readingId" TEXT,
  "meterId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "previousJson" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ElectricityReadingAudit_readingId_fkey" FOREIGN KEY ("readingId") REFERENCES "ElectricityReading" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "ElectricityReadingAudit_meterId_createdAt_idx" ON "ElectricityReadingAudit"("meterId", "createdAt");
