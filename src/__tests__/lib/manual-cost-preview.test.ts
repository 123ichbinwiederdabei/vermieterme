import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { billingPeriod: { findUnique: vi.fn() }, costCategory: { findUnique: vi.fn() } },
}));

import { prisma } from "@/lib/prisma";
import { buildManualCostPreview } from "@/lib/manual-cost-preview";

function fixture() {
  return {
    id: "period", startDate: new Date("2024-01-01"), endDate: new Date("2024-12-31"),
    costs: [{ totalAmountCents: 0n, costCategory: { name: "Grundsteuer", calculationType: "MANUAL", distributionKey: "Manuell" } }],
    property: {
      propertyTaxSetting: {
        allocationMethod: "ALLOCATABLE_AMOUNT", annualAssessmentCents: 120_000n,
        annualAllocatableAmountCents: 80_000n, annualRateMicroCentsPerM2: 1_000_000n, allocationNote: "Wohnanteil",
      },
      units: [
        { id: "occupied", name: "Wohnung", areaM2: "80", shares: 1, tenants: [{
          id: "tenant", firstName: "Anna", lastName: "Test", moveInDate: new Date("2023-01-01"), moveOutDate: null,
          financialPeriods: [{ validFrom: new Date("2023-01-01"), validTo: null }],
        }] },
        { id: "vacant", name: "Leerstand", areaM2: "20", shares: 1, tenants: [] },
      ],
    },
  };
}

describe("recovered property-tax billing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the non-residential assessment and vacancy with the landlord", async () => {
    vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(fixture() as never);
    const result = await buildManualCostPreview("period", "tax");
    expect(result.blockers).toEqual([]);
    expect(result.totalAmountCents).toBe("120000");
    expect(result.tenantAmountCents).toBe("64000");
    expect(result.vacancyAmountCents).toBe("16000");
    expect(result.landlordAmountCents).toBe("56000");
    expect(BigInt(result.tenantAmountCents) + BigInt(result.landlordAmountCents)).toBe(BigInt(result.totalAmountCents));
  });

  it("uses the persisted rate as micro-euro per square metre", async () => {
    const period = fixture();
    period.property.propertyTaxSetting.allocationMethod = "RATE_PER_M2";
    vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(period as never);
    const result = await buildManualCostPreview("period", "tax");
    expect(result.details.allocatableAmountCents).toBe("10000");
    expect(result.tenantAmountCents).toBe("8000");
    expect(result.landlordAmountCents).toBe("112000");
  });

  it("prorates a partial leap year with integer cents", async () => {
    const period = fixture();
    period.endDate = new Date("2024-06-30");
    vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(period as never);
    const result = await buildManualCostPreview("period", "tax");
    expect(result.totalAmountCents).toBe("59672");
    expect(result.details.allocatableAmountCents).toBe("39781");
    expect(BigInt(result.tenantAmountCents) + BigInt(result.landlordAmountCents)).toBe(59672n);
  });

  it("blocks a gap in tenant financial coverage", async () => {
    const period = fixture();
    period.property.units[0].tenants[0].financialPeriods[0].validFrom = new Date("2024-02-01");
    vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue(period as never);
    const result = await buildManualCostPreview("period", "tax");
    expect(result.blockers).toContain("Miet-/NK-Finanzperioden für Anna Test decken den Abrechnungszeitraum nicht lückenlos ab.");
  });
});
