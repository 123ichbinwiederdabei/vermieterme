import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    await prisma.user.upsert({
      where: { email: process.env.ADMIN_EMAIL },
      update: {},
      create: {
        email: process.env.ADMIN_EMAIL,
        name: "Admin",
        password: await hash(process.env.ADMIN_PASSWORD, 12),
      },
    });
  }

  // Landlord Info
  await prisma.landlordInfo.upsert({
    where: { id: "landlord-1" },
    update: {},
    create: {
      id: "landlord-1",
      name: "Max & Erika Mustermann",
      street: "Musterstraße 42",
      zip: "28195",
      city: "Bremen",
      phone: "0421-1234567",
      email: "info@mustermann-vermietung.de",
      bankName: "Sparkasse Bremen",
      iban: "DE89 3704 0044 0532 0130 00",
      accountHolder: "Max Mustermann",
    },
  });

  // Property
  const property = await prisma.property.upsert({
    where: { id: "property-1" },
    update: {},
    create: {
      id: "property-1",
      street: "Bremer Str. 10",
      zip: "28205",
      city: "Bremen",
      totalShares: 100,
    },
  });

  // Units
  const unitEG = await prisma.unit.upsert({
    where: { id: "unit-1" },
    update: {},
    create: {
      id: "unit-1",
      propertyId: property.id,
      name: "Wohnung I",
      floor: "EG",
      shares: 25,
      areaM2: "75.00",
    },
  });

  const unitOG = await prisma.unit.upsert({
    where: { id: "unit-2" },
    update: {},
    create: {
      id: "unit-2",
      propertyId: property.id,
      name: "Wohnung II",
      floor: "1. OG",
      shares: 35,
      areaM2: "95.00",
    },
  });

  // Tenants
  await prisma.tenant.upsert({
    where: { id: "tenant-1" },
    update: {},
    create: {
      id: "tenant-1",
      unitId: unitEG.id,
      salutation: "Frau",
      firstName: "Anna",
      lastName: "Schmidt",
      salutation2: "Herr",
      firstName2: "Jan",
      lastName2: "Schmidt",
      moveInDate: new Date("2020-01-01"),
    },
  });

  await prisma.tenant.upsert({
    where: { id: "tenant-2" },
    update: {},
    create: {
      id: "tenant-2",
      unitId: unitOG.id,
      salutation: "Herr",
      firstName: "Thomas",
      lastName: "Müller",
      moveInDate: new Date("2022-06-01"),
    },
  });

  // Cost Categories
  const categories = [
    { id: "cat-1", name: "Gebäudeversicherung", distributionKey: "MEA", sortOrder: 1 },
    { id: "cat-2", name: "Gartenpflege", distributionKey: "MEA", sortOrder: 2 },
    { id: "cat-3", name: "Gebäudereinigung", distributionKey: "MEA", sortOrder: 3 },
    { id: "cat-4", name: "Wasser/Abwasser/Allgemeinstrom", distributionKey: "siehe Anlage", sortOrder: 4 },
    { id: "cat-5", name: "Gehwegreinigung", distributionKey: "MEA", sortOrder: 5 },
    { id: "cat-6", name: "Schornsteinfeger", distributionKey: "MEA", sortOrder: 6 },
    { id: "cat-7", name: "Wartung Heizung", distributionKey: "siehe Anlage", sortOrder: 7 },
    { id: "cat-8", name: "Grundsteuer", distributionKey: "laut Bescheid", sortOrder: 8 },
    { id: "cat-9", name: "Abfall", distributionKey: "siehe Anlage", sortOrder: 9 },
    { id: "cat-oil", name: "Heizöl", distributionKey: "AREA", calculationType: "HEATING_OIL", sortOrder: 10 },
    { id: "cat-electricity", name: "Strom", distributionKey: "DIRECT_CONSUMPTION", calculationType: "ELECTRICITY", sortOrder: 11 },
    { id: "cat-other-operating-costs", name: "Sonstige Betriebskosten", distributionKey: "siehe Anlage", calculationType: "MANUAL", sortOrder: 12 },
  ];

  for (const cat of categories) {
    await prisma.costCategory.upsert({
      where: { id: cat.id },
      update: {},
      create: cat,
    });
  }

  const heating = await prisma.heatingSystem.upsert({
    where: { id: "heating-1" }, update: {}, create: { id: "heating-1", propertyId: property.id, name: "Ölheizung", billingRegime: "SECTION_11_EXCEPTION", exceptionReasonCode: "NO_METERING", exceptionReason: "Demo: keine Wärmeverbrauchserfassung", exceptionValidFrom: new Date("2023-01-01") },
  });
  for (const unitId of [unitEG.id, unitOG.id]) await prisma.heatingSystemUnit.upsert({ where: { heatingSystemId_unitId: { heatingSystemId: heating.id, unitId } }, update: {}, create: { heatingSystemId: heating.id, unitId } });
  await prisma.heatingOilTank.upsert({ where: { id: "tank-1" }, update: {}, create: { id: "tank-1", heatingSystemId: heating.id, name: "Gemeinsamer Heizöltank", capacityLiters: "5000", deliveryDetectionThresholdLiters: "200" } });

  for (const [tenantId, coldRent, prepayment] of [["tenant-1", 85000n, 20000n], ["tenant-2", 95000n, 24000n]] as const) {
    const financial = await prisma.leaseFinancialPeriod.upsert({ where: { id: `finance-${tenantId}` }, update: {}, create: { id: `finance-${tenantId}`, tenantId, validFrom: new Date(tenantId === "tenant-1" ? "2020-01-01" : "2022-06-01"), monthlyColdRentCents: coldRent, monthlyPrepaymentCents: prepayment, reason: "Mietbeginn" } });
    await prisma.prepaymentComponent.upsert({ where: { financialPeriodId_costCategoryId: { financialPeriodId: financial.id, costCategoryId: "cat-oil" } }, update: {}, create: { financialPeriodId: financial.id, costCategoryId: "cat-oil", monthlyAmountCents: prepayment / 2n } });
    await prisma.prepaymentComponent.upsert({ where: { financialPeriodId_costCategoryId: { financialPeriodId: financial.id, costCategoryId: "cat-electricity" } }, update: {}, create: { financialPeriodId: financial.id, costCategoryId: "cat-electricity", monthlyAmountCents: prepayment - prepayment / 2n } });
  }

  // Billing Period 2023 (abgeschlossen)
  const bp2023 = await prisma.billingPeriod.upsert({
    where: { id: "bp-2023" },
    update: {},
    create: {
      id: "bp-2023",
      propertyId: property.id,
      startDate: new Date("2023-01-01"),
      endDate: new Date("2023-12-31"),
      billingDate: new Date("2024-07-01"),
    },
  });

  // Costs 2023
  const costs2023 = [
    { costCategoryId: "cat-1", totalAmount: 2100.00, unitAmount: 525.00 },
    { costCategoryId: "cat-2", totalAmount: 1800.00, unitAmount: 450.00 },
    { costCategoryId: "cat-3", totalAmount: 240.00, unitAmount: 60.00 },
    { costCategoryId: "cat-4", totalAmount: 1500.00, unitAmount: 350.00 },
    { costCategoryId: "cat-5", totalAmount: 600.00, unitAmount: 150.00 },
    { costCategoryId: "cat-6", totalAmount: 150.00, unitAmount: 37.50 },
    { costCategoryId: "cat-7", totalAmount: 120.00, unitAmount: 30.00 },
    { costCategoryId: "cat-8", totalAmount: 480.00, unitAmount: 120.00 },
    { costCategoryId: "cat-9", totalAmount: 360.00, unitAmount: 90.00 },
  ];

  for (const cost of costs2023) {
    await prisma.cost.upsert({
      where: {
        billingPeriodId_costCategoryId: {
          billingPeriodId: bp2023.id,
          costCategoryId: cost.costCategoryId,
        },
      },
      update: {},
      create: {
        billingPeriodId: bp2023.id,
        ...cost,
      },
    });
  }

  // Prepayments 2023
  await prisma.prepayment.upsert({
    where: {
      billingPeriodId_unitId: {
        billingPeriodId: bp2023.id,
        unitId: unitEG.id,
      },
    },
    update: {},
    create: {
      billingPeriodId: bp2023.id,
      unitId: unitEG.id,
      monthlyAmount: 150,
    },
  });

  await prisma.prepayment.upsert({
    where: {
      billingPeriodId_unitId: {
        billingPeriodId: bp2023.id,
        unitId: unitOG.id,
      },
    },
    update: {},
    create: {
      billingPeriodId: bp2023.id,
      unitId: unitOG.id,
      monthlyAmount: 200,
    },
  });

  // Billing Period 2024 (in Bearbeitung - Kosten vorhanden, kein Abrechnungsdatum)
  const bp2024 = await prisma.billingPeriod.upsert({
    where: { id: "bp-2024" },
    update: {},
    create: {
      id: "bp-2024",
      propertyId: property.id,
      startDate: new Date("2024-01-01"),
      endDate: new Date("2024-12-31"),
    },
  });

  // Costs 2024
  const costs2024 = [
    { costCategoryId: "cat-1", totalAmount: 2200.00, unitAmount: 550.00 },
    { costCategoryId: "cat-2", totalAmount: 1900.00, unitAmount: 475.00 },
    { costCategoryId: "cat-3", totalAmount: 250.00, unitAmount: 62.50 },
    { costCategoryId: "cat-4", totalAmount: 1600.00, unitAmount: 370.00 },
    { costCategoryId: "cat-5", totalAmount: 620.00, unitAmount: 155.00 },
    { costCategoryId: "cat-6", totalAmount: 160.00, unitAmount: 40.00 },
  ];

  for (const cost of costs2024) {
    await prisma.cost.upsert({
      where: {
        billingPeriodId_costCategoryId: {
          billingPeriodId: bp2024.id,
          costCategoryId: cost.costCategoryId,
        },
      },
      update: {},
      create: {
        billingPeriodId: bp2024.id,
        ...cost,
      },
    });
  }

  // Prepayments 2024
  await prisma.prepayment.upsert({
    where: {
      billingPeriodId_unitId: {
        billingPeriodId: bp2024.id,
        unitId: unitEG.id,
      },
    },
    update: {},
    create: {
      billingPeriodId: bp2024.id,
      unitId: unitEG.id,
      monthlyAmount: 160,
    },
  });

  await prisma.prepayment.upsert({
    where: {
      billingPeriodId_unitId: {
        billingPeriodId: bp2024.id,
        unitId: unitOG.id,
      },
    },
    update: {},
    create: {
      billingPeriodId: bp2024.id,
      unitId: unitOG.id,
      monthlyAmount: 210,
    },
  });

  console.log("Seed completed successfully!");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
