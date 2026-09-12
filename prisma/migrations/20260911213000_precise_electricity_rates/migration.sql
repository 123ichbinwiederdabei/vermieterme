-- Preserve existing cent-per-kWh semantics while moving unit prices to µ€/kWh.
-- Final allocated billing amounts remain integer cents.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ElectricityTariff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contractId" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "billingValidFrom" DATETIME,
    "billingValidTo" DATETIME,
    "billingEffectiveReason" TEXT,
    "priceMicroEuroPerKwh" BIGINT NOT NULL,
    "monthlyBasePriceCents" BIGINT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ElectricityTariff_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "ElectricityContract" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_ElectricityTariff" (
  "id", "contractId", "validFrom", "validTo", "billingValidFrom", "billingValidTo", "billingEffectiveReason", "priceMicroEuroPerKwh", "monthlyBasePriceCents", "name", "createdAt", "updatedAt"
)
SELECT
  "id", "contractId", "validFrom", "validTo", "billingValidFrom", "billingValidTo", "billingEffectiveReason", "priceCentsPerKwh" * 10000, "monthlyBasePriceCents", "name", "createdAt", "updatedAt"
FROM "ElectricityTariff";

DROP TABLE "ElectricityTariff";
ALTER TABLE "new_ElectricityTariff" RENAME TO "ElectricityTariff";
CREATE UNIQUE INDEX "ElectricityTariff_contractId_validFrom_key" ON "ElectricityTariff"("contractId", "validFrom");

PRAGMA foreign_keys=ON;
