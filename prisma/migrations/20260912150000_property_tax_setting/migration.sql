CREATE TABLE "PropertyTaxSetting" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "propertyId" TEXT NOT NULL,
  "annualAssessmentCents" BIGINT,
  "allocationMethod" TEXT NOT NULL DEFAULT 'ALLOCATABLE_AMOUNT',
  "annualAllocatableAmountCents" BIGINT,
  "annualRateMicroCentsPerM2" BIGINT,
  "allocationNote" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PropertyTaxSetting_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PropertyTaxSetting_propertyId_key" ON "PropertyTaxSetting"("propertyId");
