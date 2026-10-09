import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { BILLING_CATEGORIES } from "../src/lib/invoice-categories";

export const fixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=",
  "base64",
);
const day = (value: string) => new Date(`${value}T00:00:00Z`);
export async function createKrandorfFixture(db: PrismaClient, prefix: string) {
  await db.user.upsert({ where: { id: "test-user" }, create: { id: "test-user", name: "Test administrator" }, update: {} });
  const property = await db.property.create({
    data: {
      id: `${prefix}-property`,
      street: "Krandorf 7",
      zip: "92431",
      city: "Neunburg",
      totalShares: 390,
    },
  });
  const categories: Record<string, string> = {};
  for (const definition of BILLING_CATEGORIES) {
    const existing = await db.costCategory.findFirst({
      where: { code: definition.code },
    });
    const row =
      existing ??
      (await db.costCategory.create({
        data: {
          name: definition.name,
          code: definition.code,
          distributionKey: definition.key,
          calculationType: ["HEATING_OIL", "ELECTRICITY"].includes(
            definition.kind,
          )
            ? definition.kind
            : "MANUAL",
        },
      }));
    categories[definition.code] = row.id;
  }
  const period = await db.billingPeriod.create({
    data: {
      id: `${prefix}-period`,
      propertyId: property.id,
      startDate: day("2026-10-01"),
      endDate: day("2026-12-31"),
    },
  });
  const units = [];
  const tenants = [];
  for (const [index, [name, area]] of [
    ["Isabella", "80"],
    ["Vladimir", "200"],
    ["Vermieter", "110"],
  ].entries()) {
    const unit = await db.unit.create({
      data: {
        id: `${prefix}-unit-${index}`,
        propertyId: property.id,
        name,
        floor: "EG",
        shares: Number(area),
        areaM2: area,
        ownerOccupied: index === 2,
      },
    });
    units.push(unit);
    if (index === 2) continue;
    const electricityAdvance = index === 0 ? 4100n : 10000n;
    const totalAdvance = index === 0 ? 20000n : 30000n;
    const tenant = await db.tenant.create({
      data: {
        id: `${prefix}-tenant-${index}`,
        unitId: unit.id,
        salutation: index === 0 ? "Frau" : "Herr",
        firstName: name,
        lastName: "Test",
        moveInDate: period.startDate,
        financialPeriods: {
          create: {
            validFrom: period.startDate,
            monthlyColdRentCents: 70000n,
            monthlyPrepaymentCents: totalAdvance,
            components: {
              create: [
                {
                  costCategoryId: categories.ELECTRICITY,
                  monthlyAmountCents: electricityAdvance,
                },
                {
                  costCategoryId: categories.HEATING,
                  monthlyAmountCents: totalAdvance - electricityAdvance,
                },
              ],
            },
          },
        },
        costCategoryAgreements: {
          create: {
            costCategoryId: categories.WASTEWATER,
            validFrom: period.startDate,
            confirmedBy: "test-user",
            note: "Vertraglich bestätigt",
          },
        },
      },
    });
    tenants.push(tenant);
  }
  const document = await db.document.create({
    data: {
      id: `${prefix}-document`,
      originalName: "synthetic.png",
      fileName: `${prefix}-synthetic.png`,
      mimeType: "image/png",
      size: fixturePng.length,
      fileHash: createHash("sha256").update(fixturePng).digest("hex"),
      category: "heating-evidence",
    },
  });
  const system = await db.heatingSystem.create({
    data: {
      propertyId: property.id,
      name: "Testheizung",
      billingRegime: "SECTION_11_EXCEPTION",
      exceptionReasonCode: "TECHNICALLY_IMPOSSIBLE",
      exceptionReason: "Testnachweis für technisch unmögliche Messung",
      exceptionValidFrom: period.startDate,
      exceptionValidTo: period.endDate,
      exceptionDocumentId: document.id,
      evidenceValidatedAt: new Date(),
      evidenceValidatedBy: "test-user",
      units: { create: units.slice(0, 2).map((unit) => ({ unitId: unit.id })) },
    },
  });
  const tank = await db.heatingOilTank.create({
    data: { heatingSystemId: system.id, name: "Tank", capacityLiters: "2000" },
  });
  await db.oilInventoryLot.create({
    data: {
      tankId: tank.id,
      sourceDate: period.startDate,
      sourceType: "OPENING",
      quantityLiters: "1000",
      totalAmountCents: 100000n,
      co2CostCents: 10000n,
      co2Grams: 2680000n,
      co2EvidenceReference: document.id,
    },
  });
  await db.oilStockReading.createMany({
    data: [
      {
        tankId: tank.id,
        readingDate: period.startDate,
        quantityLiters: "1000",
        source: "MANUAL",
        confirmed: true,
      },
      {
        tankId: tank.id,
        readingDate: period.endDate,
        quantityLiters: "500",
        source: "MANUAL",
        confirmed: true,
      },
    ],
  });
  const contract = await db.electricityContract.create({
    data: {
      propertyId: property.id,
      provider: "Teststrom",
      validFrom: period.startDate,
      basePriceAllocation: "EQUAL_PER_UNIT",
      basePriceAgreementNote:
        "Vertrag §4: Grundpreis hälftig für beide Mietwohnungen",
      tariffs: {
        create: {
          validFrom: period.startDate,
          priceMicroEuroPerKwh: 276400n,
          monthlyBasePriceCents: 1000n,
        },
      },
    },
  });
  for (const [index, [number, role, amount]] of [
    ["35863079", "UNIT_CONSUMPTION", "1000"],
    ["32983031", "UNIT_CONSUMPTION", "2000"],
    ["5388519", "SMALL_WASTEWATER_ELECTRICITY", "100"],
  ].entries()) {
    await db.electricityMeter.create({
      data: {
        contractId: contract.id,
        propertyId: property.id,
        unitId: index < 2 ? units[index].id : null,
        meterNumber: number,
        role,
        validFrom: period.startDate,
        readings: {
          create: [
            { readingDate: period.startDate, readingKwh: "0" },
            { readingDate: period.endDate, readingKwh: amount },
          ],
        },
      },
    });
  }
  for (const definition of BILLING_CATEGORIES) {
    await db.cost.create({ data: { billingPeriodId: period.id, costCategoryId: categories[definition.code], totalAmount: 0, totalAmountCents: 0n, enabled: true } });
    if (definition.code === "ELECTRICITY") {
      await db.propertyCostAllocationRule.create({ data: { propertyId: property.id, costCategoryId: categories[definition.code], purpose: "BASE", allocationMethod: "FIXED_SHARES", validFrom: period.startDate, sourceDocumentId: document.id, units: { create: units.map((unit) => ({ unitId: unit.id, included: true, weight: "1" })) } } });
    } else {
      await db.propertyCostAllocationRule.create({ data: { propertyId: property.id, costCategoryId: categories[definition.code], allocationMethod: ["WASTE", "WASTEWATER"].includes(definition.code) ? "FIXED_SHARES" : "AREA", validFrom: period.startDate, sourceDocumentId: document.id, units: { create: units.map((unit) => ({ unitId: unit.id, included: definition.code !== "PROPERTY_TAX" && definition.code !== "HEATING" || !unit.ownerOccupied, weight: "1" })) } } });
    }
    await db.leaseCostCategoryAgreement.createMany({ data: tenants.filter(() => definition.code !== "WASTEWATER").map((tenant) => ({ tenantId: tenant.id, costCategoryId: categories[definition.code], validFrom: period.startDate, confirmedBy: "test-user", contractDocumentId: document.id, note: "Verified test contract" })) });
  }
  await db.document.update({ where: { id: document.id }, data: { propertyId: property.id } });
  return {
    property,
    period,
    categories,
    units,
    tenants,
    document,
    tank,
    contract,
  };
}
