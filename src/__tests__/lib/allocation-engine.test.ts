import { describe, expect, it } from "vitest";
import {
  allocateConfiguredCost,
  calculateBavariaResidentialTaxCents,
  resolveRuleSegments,
  type AllocationUnit,
} from "@/lib/allocation-engine";

const start = new Date("2026-10-01T00:00:00.000Z");
const end = new Date("2026-12-31T00:00:00.000Z");
const tenant = (id: string) => ({ id, moveInDate: start, moveOutDate: null });
const source = { distributionKey: "FIXED_SHARES", sourceType: "TEST", allocationRuleId: "rule-1" };

function units(owner = true): AllocationUnit[] {
  return [
    { unitId: "isabella", unitName: "Isabella", ownerOccupied: false, included: true, weight: "1", areaM2: "80", tenants: [tenant("tenant-i")] },
    { unitId: "vladimir", unitName: "Vladimir", ownerOccupied: false, included: true, weight: "1", areaM2: "200", tenants: [tenant("tenant-v")] },
    { unitId: "owner", unitName: "Vermieter", ownerOccupied: owner, included: true, weight: "1", areaM2: null, tenants: [] },
  ];
}

describe("generic operating-cost allocation", () => {
  it("allocates 300 euro as exact thirds and retains the owner share", () => {
    const result = allocateConfiguredCost(30_000n, "FIXED_SHARES", units(), start, end, source);
    expect(result.unitDetails.map((row) => row.amountCents)).toEqual(["10000", "10000", "10000"]);
    expect(result.tenantAmountCents).toBe(20_000n);
    expect(result.landlordOwnerAmountCents).toBe(10_000n);
    expect(result.vacancyAmountCents).toBe(0n);
  });

  it("retains a vacant unit share instead of redistributing it", () => {
    const vacant = units(false);
    const result = allocateConfiguredCost(30_000n, "FIXED_SHARES", vacant, start, end, source);
    expect(result.tenantAmountCents).toBe(20_000n);
    expect(result.vacancyAmountCents).toBe(10_000n);
  });

  it("normalizes unequal shares and conserves every cent", () => {
    const weighted = units();
    weighted[0].weight = "1";
    weighted[1].weight = "2";
    weighted[2].weight = "3";
    const result = allocateConfiguredCost(10_001n, "FIXED_SHARES", weighted, start, end, source);
    expect(result.unitDetails.map((row) => row.amountCents)).toEqual(["1667", "3334", "5000"]);
    expect(result.tenantAmountCents + result.landlordOwnerAmountCents + result.vacancyAmountCents).toBe(10_001n);
  });

  it("uses only configured heating areas", () => {
    const heated = units().slice(0, 2);
    const result = allocateConfiguredCost(28_000n, "AREA", heated, start, end, { ...source, distributionKey: "AREA" });
    expect(result.unitDetails.map((row) => row.amountCents)).toEqual(["8000", "20000"]);
    expect(result.unitDetails.map((row) => row.basis)).toEqual(["80 m² von 280 m²", "200 m² von 280 m²"]);
  });

  it("rejects rule gaps and accepts an exact 1 October transition", () => {
    const oldRule = { id: "old", validFrom: new Date("2026-09-13T00:00:00.000Z"), validTo: new Date("2026-09-30T00:00:00.000Z") };
    const newRule = { id: "new", validFrom: new Date("2026-10-01T00:00:00.000Z"), validTo: null };
    expect(resolveRuleSegments([oldRule, newRule], new Date("2026-09-13"), end).map((row) => row.rule.id)).toEqual(["old", "new"]);
    expect(() => resolveRuleSegments([newRule], new Date("2026-09-13"), end)).toThrow("fehlt");
  });

  it("calculates the Bavarian residential component with exact scaled arithmetic", () => {
    // 80 m² × 0.50 €/m² × 70 % × 400 % = 112.00 €.
    expect(calculateBavariaResidentialTaxCents("80", 500_000n, 700_000n, 40_000n)).toBe(11_200n);
  });
});
