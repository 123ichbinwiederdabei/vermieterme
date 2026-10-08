-- Complete the immutable invoice-workflow schema introduced by the preceding
-- application commit. SQLite needs a table rebuild to add the self-reference.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
