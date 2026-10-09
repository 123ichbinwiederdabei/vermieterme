import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    unitStatePeriod: { findMany: vi.fn().mockResolvedValue([]) },
    propertyCostAllocationRule: { findMany: vi.fn(async ({ where }: { where: { costCategoryId: string } }) => [{ id: "dated-rule", validFrom: new Date("2026-01-01"), validTo: null, allocationMethod: where.costCategoryId === "sewage" ? "FIXED_SHARES" : "AREA", consumptionSharePercent: null, units: ["isabella", "vladimir", "owner"].map((unitId) => ({ unitId, included: where.costCategoryId !== "tax" || unitId !== "owner", weight: "1", areaM2: null })) }]) },
    statementRevision: { findFirst: vi.fn().mockResolvedValue(null) },
    billingPeriod: { findUnique: vi.fn() },
    tenant: { findUnique: vi.fn() },
    costCategory: { findUnique: vi.fn() },
    costInvoice: { findMany: vi.fn() },
    electricityContract: { findMany: vi.fn() },
  },
}));
import { prisma } from "@/lib/prisma";
import { buildManualCostPreview } from "@/lib/manual-cost-preview";
import { buildSmallWastewaterPreview } from "@/lib/cost-invoice-billing";
import {
  buildElectricityPreview,
  buildHeatingOilPreview,
} from "@/lib/energy-preview";
import { buildTenantStatement } from "@/lib/billing-statement";
import { co2TenantPercent } from "@/lib/energy-billing";
import { isEligibleInvoiceLine } from "@/lib/cost-invoice";

const day = (date: string) => new Date(date);
const tenant = (
  id: string,
  start = "2026-01-01",
  end: string | null = null,
) => ({
  id,
  firstName: id,
  lastName: "Test",
  moveInDate: day(start),
  moveOutDate: end ? day(end) : null,
  financialPeriods: [{ validFrom: day(start), validTo: end ? day(end) : null }],
  costCategoryAgreements: [
    { costCategoryId: "sewage", validFrom: day("2026-01-01"), validTo: null },
  ],
});
const units = () => [
  {
    id: "isabella",
    name: "ELW",
    areaM2: "80",
    ownerOccupied: false,
    shares: 80,
    tenants: [tenant("isabella")],
  },
  {
    id: "vladimir",
    name: "Haus",
    areaM2: "200",
    ownerOccupied: false,
    shares: 200,
    tenants: [tenant("vladimir")],
  },
  {
    id: "owner",
    name: "Vermieter",
    areaM2: "110",
    ownerOccupied: true,
    shares: 0,
    tenants: [],
  },
];
function period() {
  return {
    id: "period",
    propertyId: "property",
    startDate: day("2026-01-01"),
    endDate: day("2026-12-31"),
    property: {
      units: units(),
      propertyTaxSetting: {
        allocationMethod: "ALLOCATABLE_AMOUNT",
        annualAssessmentCents: 28000n,
        annualAllocatableAmountCents: 28000n,
        annualRateMicroCentsPerM2: 1000000n,
        allocationNote: "Only the two rented flats",
      },
    },
    costs: [
      {
        totalAmount: 280,
        totalAmountCents: 28000n,
        costCategory: {
          name: "Grundsteuer",
          calculationType: "MANUAL",
          distributionKey: "Wohnfläche",
        },
      },
    ],
  };
}
function electricPeriod(
  values: string[] = ["0", "1000"],
  price = 1000000n,
  base = 0n,
) {
  const p = period();
  p.endDate = day("2026-01-10");
  p.property.units = [p.property.units[0]];
  return {
    ...p,
    property: {
      ...p.property,
      electricityContracts: [
        {
          id: "contract",
          provider: "Test",
          basePriceAllocation: "EQUAL_PER_UNIT",
          tariffs: [
            {
              validFrom: p.startDate,
              validTo: null,
              priceMicroEuroPerKwh: price,
              monthlyBasePriceCents: base,
            },
          ],
          meters: [
            {
              id: "meter",
              role: "UNIT_CONSUMPTION",
              unitId: "isabella",
              meterNumber: "35863079",
              validFrom: p.startDate,
              validTo: null,
              readings: [
                { readingDate: p.startDate, readingKwh: values[0] },
                { readingDate: p.endDate, readingKwh: values[1] },
              ],
            },
          ],
        },
      ],
    },
  };
}
function oilPeriod() {
  const p = period();
  return {
    ...p,
    property: {
      ...p.property,
      heatingSystems: [
        {
          id: "system",
          billingRegime: "SECTION_11_EXCEPTION",
          exceptionReason: "Free text",
          exceptionReasonCode: null,
          exceptionValidFrom: null,
          exceptionValidTo: null,
          exceptionDocumentId: null,
          centralHotWater: false,
          consumptionSource: "NONE",
          consumptionSharePercent: 50,
          baseSharePercent: 50,
          units: [{ unitId: "isabella" }, { unitId: "vladimir" }],
          tanks: [
            {
              id: "tank",
              name: "Tank",
              capacityLiters: "2000",
              deliveryCandidates: [],
              deliveries: [],
              stockReadings: [
                { readingDate: p.startDate, quantityLiters: "1000" },
                { readingDate: p.endDate, quantityLiters: "500" },
              ],
              inventoryLots: [
                {
                  id: "lot",
                  sourceDate: p.startDate,
                  quantityLiters: "1000",
                  totalAmountCents: 100000n,
                  co2CostCents: 0n,
                  co2Grams: 0n,
                  consumptions: [],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.costInvoice.findMany).mockResolvedValue([]);
  vi.mocked(prisma.electricityContract.findMany).mockResolvedValue([]);
});

it("Grundsteuer distributes the rental component over 280 m², excluding owner area", async () => {
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(
    period() as never,
  );
  const r = await buildManualCostPreview("period", "tax");
  expect(r.allocations.filter((a) => a.tenantId).map((a) => a.amountCents)).toEqual(["8000", "20000"]);
});
it("Kleinkläranlage charges one third to each tenant and the owner", async () => {
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(
    period() as never,
  );
  vi.mocked(prisma.costCategory.findUnique).mockResolvedValue({
    name: "Entwässerung – Kleinkläranlage",
  } as never);
  vi.mocked(prisma.costInvoice.findMany).mockResolvedValue([
    {
      id: "invoice",
      status: "CONFIRMED",
      invoiceNumber: "TEST",
      totalAmountCents: 39000n,
      servicePeriodStart: day("2026-01-01"),
      servicePeriodEnd: day("2026-12-31"),
      lines: [
        {
          amountCents: 39000n,
          classification: "WARTUNG",
          confirmedRunningExpense: false,
        },
      ],
    },
  ] as never);
  vi.mocked(prisma.electricityContract.findMany).mockResolvedValue([]);
  const r = await buildSmallWastewaterPreview("period", "sewage");
  expect(r.allocations.filter((a) => a.tenantId).map((a) => a.amountCents)).toEqual(["13000", "13000"]);
});
it("Tenant change uses interval consumption rather than a day split of the annual total", async () => {
  const p = electricPeriod();
  p.property.units[0].tenants = [
    tenant("old", "2026-01-01", "2026-01-05"),
    tenant("new", "2026-01-06"),
  ];
  p.property.electricityContracts[0].meters[0].readings.splice(
    1,
    0,
    { readingDate: day("2026-01-05"), readingKwh: "900" },
    { readingDate: day("2026-01-06"), readingKwh: "900" },
  );
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(p as never);
  const r = await buildElectricityPreview("period", "electricity");
  expect(r.blockers).toEqual([]);
  expect(r.allocations.filter((a) => a.tenantId).map((a) => a.amountCents)).toEqual(["90000", "10000"]);
});
it("Standard HeizkostenV is blocked if declared heat data has no implemented consumption calculation", async () => {
  const p = oilPeriod();
  const s = p.property.heatingSystems[0];
  s.billingRegime = "STANDARD_HEIZKOSTENV";
  s.consumptionSource = "HEAT_METERS";
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(p as never);
  expect(
    (await buildHeatingOilPreview("period", "oil")).blockers.length,
  ).toBeGreaterThan(0);
});
it("Section 11 requires structured, valid evidence instead of a free-text reason", async () => {
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(
    oilPeriod() as never,
  );
  expect(
    (await buildHeatingOilPreview("period", "oil")).blockers.length,
  ).toBeGreaterThan(0);
});
it("CO2 tier rounds 11.95 kg/m²/year to 12.0 before classification", () => {
  expect(co2TenantPercent(3346000n, "280", 365)).toBe(90);
});
it("Electricity unit prices retain sub-cent precision until the final allocation", async () => {
  const p = electricPeriod(["0", "2"], 4900n);
  p.property.units[0].tenants = [
    tenant("old", "2026-01-01", "2026-01-05"),
    tenant("new", "2026-01-06"),
  ];
  p.property.electricityContracts[0].meters[0].readings.splice(
    1,
    0,
    { readingDate: day("2026-01-05"), readingKwh: "1" },
    { readingDate: day("2026-01-06"), readingKwh: "1" },
  );
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(p as never);
  expect(
    (await buildElectricityPreview("period", "electricity")).totalAmountCents,
  ).toBe("1");
});
it("A consumption-based Grundpreis remains payable when all meters have zero use", async () => {
  const p = electricPeriod(["0", "0"], 1000000n, 10000n);
  p.endDate = day("2026-01-31");
  const c = p.property.electricityContracts[0];
  c.basePriceAllocation = "BY_CONSUMPTION";
  c.meters[0].readings[1].readingDate = p.endDate;
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(p as never);
  const r = await buildElectricityPreview("period", "electricity");
  expect(BigInt(r.totalAmountCents)).toBe(10000n);
});
it("Inactive future meters are excluded from the current billing period", async () => {
  const p = electricPeriod();
  p.property.electricityContracts[0].meters[0].validFrom = day("2027-01-01");
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(p as never);
  expect(
    (await buildElectricityPreview("period", "electricity")).totalAmountCents,
  ).toBe("0");
});
it("Plant electricity changes are included in the wastewater source fingerprint", async () => {
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(
    period() as never,
  );
  vi.mocked(prisma.costCategory.findUnique).mockResolvedValue({
    name: "Entwässerung – Kleinkläranlage",
  } as never);
  vi.mocked(prisma.costInvoice.findMany).mockResolvedValue([]);
  const contract = {
    tariffs: [
      {
        validFrom: day("2026-01-01"),
        validTo: null,
        priceMicroEuroPerKwh: 1000000n,
      },
    ],
    meters: [
      {
        id: "plant",
        role: "SMALL_WASTEWATER_ELECTRICITY",
        unitId: null,
        meterNumber: "5388519",
        readings: [
          { readingDate: day("2026-01-01"), readingKwh: "0" },
          { readingDate: day("2026-12-31"), readingKwh: "100" },
        ],
      },
    ],
  };
  vi.mocked(prisma.electricityContract.findMany).mockResolvedValue([
    contract,
  ] as never);
  const first = await buildSmallWastewaterPreview("period", "sewage");
  contract.tariffs[0].priceMicroEuroPerKwh = 2000000n;
  const second = await buildSmallWastewaterPreview("period", "sewage");
  expect(first.totalAmountCents).not.toBe(second.totalAmountCents);
  expect(first.sourceFingerprint).not.toBe(second.sourceFingerprint);
});
it("Manual cost editor values reach the shared allocation engine", async () => {
  const p = period();
  p.costs[0] = {
    totalAmount: 390,
    totalAmountCents: null as never,
    costCategory: {
      name: "Wasser",
      calculationType: "MANUAL",
      distributionKey: "Wohnfläche",
    },
  };
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(p as never);
  expect(
    (await buildManualCostPreview("period", "water")).totalAmountCents,
  ).toBe("39000");
});
it("Water with a valid cent amount uses the full 390 m² and retains the owner share", async () => {
  const p = period();
  p.costs[0] = {
    totalAmount: 390,
    totalAmountCents: 39000n,
    costCategory: {
      name: "Wasser",
      calculationType: "MANUAL",
      distributionKey: "Wohnfläche",
    },
  };
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(p as never);
  const result = await buildManualCostPreview("period", "water");
  expect(result.allocations.filter((a) => a.tenantId).map((a) => a.amountCents)).toEqual([
    "8000",
    "20000",
  ]);
  expect(result.landlordAmountCents).toBe("11000");
});
it("Statements reject incomplete billing instead of silently ignoring entered manual charges", async () => {
  const p = period();
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue({
    ...p,
    costAllocations: [],
    billingSnapshots: [],
    calculationHeads: [],
  } as never);
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
    ...tenant("isabella"),
    unit: { ...p.property.units[0], propertyId: "property" },
    financialPeriods: [
      {
        validFrom: p.startDate,
        validTo: null,
        components: [
          {
            costCategoryId: "water",
            costCategory: { name: "Wasser" },
            monthlyAmountCents: 10000n,
          },
        ],
      },
    ],
  } as never);
  await expect(buildTenantStatement("period", "isabella")).rejects.toThrow();
});
it("Repair, replacement, refurbishment and modernization lines remain excluded", () => {
  for (const classification of [
    "REPARATUR",
    "ERSATZ",
    "SANIERUNG",
    "MODERNISIERUNG",
  ])
    expect(
      isEligibleInvoiceLine({ classification, confirmedRunningExpense: true }),
    ).toBe(false);
});

it("CO2 rounds the period intensity before reducing the short-period thresholds", () => {
  expect(co2TenantPercent(848400n, "280", 92)).toBe(100);
});
