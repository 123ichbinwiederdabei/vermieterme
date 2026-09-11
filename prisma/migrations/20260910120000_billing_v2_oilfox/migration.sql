-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" DATETIME,
    "image" TEXT,
    "password" TEXT
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "street" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "totalShares" INTEGER NOT NULL DEFAULT 100,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "floor" TEXT NOT NULL,
    "shares" INTEGER NOT NULL,
    "areaM2" DECIMAL,
    "ownerOccupied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Unit_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "unitId" TEXT NOT NULL,
    "salutation" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "salutation2" TEXT,
    "firstName2" TEXT,
    "lastName2" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "bankName" TEXT,
    "iban" TEXT,
    "accountHolder" TEXT,
    "moveInDate" DATETIME NOT NULL,
    "moveOutDate" DATETIME,
    "leaseType" TEXT NOT NULL DEFAULT 'standard',
    "indexBaseYear" INTEGER,
    "indexReferenceValue" REAL,
    "indexReferenceDate" DATETIME,
    "indexMinMonths" INTEGER NOT NULL DEFAULT 12,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tenant_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CostCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "distributionKey" TEXT NOT NULL,
    "calculationType" TEXT NOT NULL DEFAULT 'MANUAL',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BillingPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "propertyId" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "billingDate" DATETIME,
    "sentDate" DATETIME,
    "paidDate" DATETIME,
    "copiedFromId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BillingPeriod_copiedFromId_fkey" FOREIGN KEY ("copiedFromId") REFERENCES "BillingPeriod" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BillingPeriod_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Cost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billingPeriodId" TEXT NOT NULL,
    "costCategoryId" TEXT NOT NULL,
    "totalAmount" REAL NOT NULL,
    "totalAmountCents" BIGINT,
    "unitAmount" REAL,
    "reviewed" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "distributionKeyOverride" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Cost_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Cost_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Prepayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billingPeriodId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "monthlyAmount" REAL NOT NULL,
    "reviewed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Prepayment_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Prepayment_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RentChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "unitId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "effectiveDate" DATETIME NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RentChange_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PdfTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT 'Standard',
    "config" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "VpiEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "value" REAL NOT NULL,
    "baseYear" INTEGER NOT NULL DEFAULT 2020,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "billingPeriodId" TEXT,
    "tenantId" TEXT,
    "fileName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Document_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Document_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TenantAccessToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantAccessToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LandlordInfo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "bankName" TEXT,
    "iban" TEXT,
    "accountHolder" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "HeatingSystem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "energySource" TEXT NOT NULL DEFAULT 'HEATING_OIL',
    "supplyType" TEXT NOT NULL DEFAULT 'CENTRAL',
    "billingRegime" TEXT NOT NULL DEFAULT 'STANDARD_HEIZKOSTENV',
    "consumptionSharePercent" INTEGER NOT NULL DEFAULT 50,
    "baseSharePercent" INTEGER NOT NULL DEFAULT 50,
    "consumptionSource" TEXT NOT NULL DEFAULT 'NONE',
    "centralHotWater" BOOLEAN NOT NULL DEFAULT false,
    "ownerOccupiedUnitId" TEXT,
    "contractualValidFrom" DATETIME,
    "contractualReason" TEXT,
    "contractualDocumentId" TEXT,
    "exceptionReasonCode" TEXT,
    "exceptionReason" TEXT,
    "exceptionValidFrom" DATETIME,
    "exceptionValidTo" DATETIME,
    "exceptionDocumentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HeatingSystem_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HeatingSystemUnit" (
    "heatingSystemId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,

    PRIMARY KEY ("heatingSystemId", "unitId"),
    CONSTRAINT "HeatingSystemUnit_heatingSystemId_fkey" FOREIGN KEY ("heatingSystemId") REFERENCES "HeatingSystem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HeatingSystemUnit_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HeatingOilTank" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "heatingSystemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacityLiters" DECIMAL,
    "deliveryDetectionThresholdLiters" DECIMAL NOT NULL DEFAULT 200,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HeatingOilTank_heatingSystemId_fkey" FOREIGN KEY ("heatingSystemId") REFERENCES "HeatingSystem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HeatingOilDelivery" (
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
    CONSTRAINT "HeatingOilDelivery_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "HeatingOilTank" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HeatingOilDelivery_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OilInventoryLot" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OilInventoryLot_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "HeatingOilTank" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OilInventoryLot_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "HeatingOilDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OilLotConsumption" (
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
    CONSTRAINT "OilLotConsumption_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BillingSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OilStockReading" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tankId" TEXT NOT NULL,
    "oilFoxDeviceId" TEXT,
    "deviceHwid" TEXT,
    "readingDate" DATETIME NOT NULL,
    "quantityLiters" DECIMAL,
    "fillLevelPercent" INTEGER,
    "batteryLevel" TEXT,
    "validationError" TEXT,
    "distanceCm" DECIMAL,
    "method" TEXT NOT NULL DEFAULT 'MANUAL',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "documentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OilStockReading_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "HeatingOilTank" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OilStockReading_oilFoxDeviceId_fkey" FOREIGN KEY ("oilFoxDeviceId") REFERENCES "OilFoxDevice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OilFoxDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hwid" TEXT NOT NULL,
    "tankId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "quantityUnit" TEXT,
    "connectionStatus" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "lastMeasurementAt" DATETIME,
    "nextMeasurementAt" DATETIME,
    "lastSyncAt" DATETIME,
    "lastError" TEXT,
    "apiVersion" TEXT,
    "apiWarning" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OilFoxDevice_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "HeatingOilTank" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OilDeliveryCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tankId" TEXT NOT NULL,
    "beforeMeasurementId" TEXT NOT NULL,
    "afterMeasurementId" TEXT NOT NULL,
    "estimatedIncreaseLiters" DECIMAL NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "deliveryId" TEXT,
    "note" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OilDeliveryCandidate_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "HeatingOilTank" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OilDeliveryCandidate_beforeMeasurementId_fkey" FOREIGN KEY ("beforeMeasurementId") REFERENCES "OilStockReading" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OilDeliveryCandidate_afterMeasurementId_fkey" FOREIGN KEY ("afterMeasurementId") REFERENCES "OilStockReading" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OilDeliveryCandidate_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "HeatingOilDelivery" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OilFoxSyncState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "lastAttemptAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "leaseUntil" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ElectricityContract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "propertyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "contractReference" TEXT,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "basePriceAllocation" TEXT NOT NULL DEFAULT 'BY_CONSUMPTION',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ElectricityContract_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ElectricityTariff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contractId" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "priceCentsPerKwh" INTEGER NOT NULL,
    "monthlyBasePriceCents" BIGINT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ElectricityTariff_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "ElectricityContract" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ElectricityMeter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contractId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "unitId" TEXT,
    "meterNumber" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ElectricityMeter_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "ElectricityContract" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ElectricityMeter_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ElectricityMeter_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ElectricityReading" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "meterId" TEXT NOT NULL,
    "readingDate" DATETIME NOT NULL,
    "readingKwh" DECIMAL NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'REGULAR',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ElectricityReading_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "ElectricityMeter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LeaseFinancialPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "monthlyColdRentCents" BIGINT NOT NULL,
    "monthlyPrepaymentCents" BIGINT NOT NULL,
    "reason" TEXT,
    "revisionOfId" TEXT,
    "revisionReason" TEXT,
    "supersededAt" DATETIME,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaseFinancialPeriod_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PrepaymentComponent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "financialPeriodId" TEXT NOT NULL,
    "costCategoryId" TEXT NOT NULL,
    "monthlyAmountCents" BIGINT NOT NULL,
    CONSTRAINT "PrepaymentComponent_financialPeriodId_fkey" FOREIGN KEY ("financialPeriodId") REFERENCES "LeaseFinancialPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PrepaymentComponent_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingSnapshot" (
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
    CONSTRAINT "BillingSnapshot_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CostAllocation" (
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
    CONSTRAINT "CostAllocation_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "CostCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "BillingSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Cost_billingPeriodId_costCategoryId_key" ON "Cost"("billingPeriodId", "costCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Prepayment_billingPeriodId_unitId_key" ON "Prepayment"("billingPeriodId", "unitId");

-- CreateIndex
CREATE INDEX "RentChange_unitId_effectiveDate_idx" ON "RentChange"("unitId", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "VpiEntry_year_month_baseYear_key" ON "VpiEntry"("year", "month", "baseYear");

-- CreateIndex
CREATE UNIQUE INDEX "TenantAccessToken_tenantId_key" ON "TenantAccessToken"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantAccessToken_token_key" ON "TenantAccessToken"("token");

-- CreateIndex
CREATE INDEX "HeatingSystem_propertyId_idx" ON "HeatingSystem"("propertyId");

-- CreateIndex
CREATE INDEX "HeatingOilTank_heatingSystemId_idx" ON "HeatingOilTank"("heatingSystemId");

-- CreateIndex
CREATE UNIQUE INDEX "HeatingOilDelivery_documentId_key" ON "HeatingOilDelivery"("documentId");

-- CreateIndex
CREATE INDEX "HeatingOilDelivery_tankId_deliveryDate_idx" ON "HeatingOilDelivery"("tankId", "deliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "OilInventoryLot_deliveryId_key" ON "OilInventoryLot"("deliveryId");

-- CreateIndex
CREATE INDEX "OilInventoryLot_tankId_sourceDate_idx" ON "OilInventoryLot"("tankId", "sourceDate");

-- CreateIndex
CREATE INDEX "OilLotConsumption_snapshotId_active_idx" ON "OilLotConsumption"("snapshotId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "OilLotConsumption_lotId_snapshotId_key" ON "OilLotConsumption"("lotId", "snapshotId");

-- CreateIndex
CREATE INDEX "OilStockReading_tankId_readingDate_idx" ON "OilStockReading"("tankId", "readingDate");

-- CreateIndex
CREATE UNIQUE INDEX "OilStockReading_oilFoxDeviceId_readingDate_key" ON "OilStockReading"("oilFoxDeviceId", "readingDate");

-- CreateIndex
CREATE UNIQUE INDEX "OilFoxDevice_hwid_key" ON "OilFoxDevice"("hwid");

-- CreateIndex
CREATE UNIQUE INDEX "OilFoxDevice_tankId_key" ON "OilFoxDevice"("tankId");

-- CreateIndex
CREATE UNIQUE INDEX "OilDeliveryCandidate_afterMeasurementId_key" ON "OilDeliveryCandidate"("afterMeasurementId");

-- CreateIndex
CREATE UNIQUE INDEX "OilDeliveryCandidate_deliveryId_key" ON "OilDeliveryCandidate"("deliveryId");

-- CreateIndex
CREATE INDEX "OilDeliveryCandidate_tankId_status_idx" ON "OilDeliveryCandidate"("tankId", "status");

-- CreateIndex
CREATE INDEX "ElectricityContract_propertyId_idx" ON "ElectricityContract"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "ElectricityTariff_contractId_validFrom_key" ON "ElectricityTariff"("contractId", "validFrom");

-- CreateIndex
CREATE INDEX "ElectricityMeter_propertyId_unitId_idx" ON "ElectricityMeter"("propertyId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "ElectricityMeter_contractId_meterNumber_key" ON "ElectricityMeter"("contractId", "meterNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ElectricityReading_meterId_readingDate_key" ON "ElectricityReading"("meterId", "readingDate");

-- CreateIndex
CREATE INDEX "LeaseFinancialPeriod_tenantId_validFrom_idx" ON "LeaseFinancialPeriod"("tenantId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PrepaymentComponent_financialPeriodId_costCategoryId_key" ON "PrepaymentComponent"("financialPeriodId", "costCategoryId");

-- CreateIndex
CREATE INDEX "BillingSnapshot_billingPeriodId_kind_idx" ON "BillingSnapshot"("billingPeriodId", "kind");

-- CreateIndex
CREATE INDEX "CostAllocation_billingPeriodId_costCategoryId_idx" ON "CostAllocation"("billingPeriodId", "costCategoryId");

-- CreateIndex
CREATE INDEX "CostAllocation_tenantId_idx" ON "CostAllocation"("tenantId");
