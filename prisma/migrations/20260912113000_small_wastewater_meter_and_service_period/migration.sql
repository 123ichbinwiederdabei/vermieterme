-- A service range permits a recurring invoice to be allocated exactly to
-- every affected billing period. Existing invoice dates remain untouched.
ALTER TABLE "CostInvoice" ADD COLUMN "propertyId" TEXT;
ALTER TABLE "CostInvoice" ADD COLUMN "servicePeriodStart" DATETIME;
ALTER TABLE "CostInvoice" ADD COLUMN "servicePeriodEnd" DATETIME;

UPDATE "CostInvoice"
SET "propertyId" = (
  SELECT "propertyId" FROM "BillingPeriod"
  WHERE "BillingPeriod"."id" = "CostInvoice"."billingPeriodId"
);

CREATE INDEX "CostInvoice_propertyId_servicePeriodStart_idx"
ON "CostInvoice"("propertyId", "servicePeriodStart");
