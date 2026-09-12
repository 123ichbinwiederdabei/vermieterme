import { describe, expect, it } from "vitest";
import { allocateCents, calculateElectricityCostCents, calculateFifoConsumption, prorateMonthlyCents, toScaledInteger } from "@/lib/billing-v2";
import { euroToCents, euroToMicroEuros, microEurosPerKwhToEuro, microEurosPerKwhToInput } from "@/lib/money";

describe("Billing v2 exact arithmetic", () => {
  it("parses Euro without floating-point arithmetic", () => {
    expect(euroToCents("12,34")).toBe("1234");
    expect(euroToCents("0.01")).toBe("1");
    expect(() => euroToCents("1.234")).toThrow();
    expect(euroToMicroEuros("0,2547")).toBe("254700");
    expect(microEurosPerKwhToEuro("276400")).toBe("0,2764 €");
    expect(microEurosPerKwhToInput("254700")).toBe("0.2547");
  });

  it("distributes cent remainders deterministically", () => {
    expect(allocateCents(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateCents(7n, [2n, 1n])).toEqual([5n, 2n]);
  });

  it("uses FIFO rather than an average price", () => {
    const result = calculateFifoConsumption([
      { id: "opening", sourceDate: "2025-01-01", quantityLiters: "1000", totalAmountCents: 100000n },
      { id: "delivery", sourceDate: "2025-06-01", quantityLiters: "1000", totalAmountCents: 120000n },
    ], "1500");
    expect(result.totalAmountCents).toBe(160000n);
    expect(result.consumptions.map((row) => [row.lotId, row.consumedLiters, row.remainingLiters])).toEqual([["opening", "1000", "0"], ["delivery", "500", "500"]]);
    expect(result.consumptions[1].remainingAmountCents).toBe(60000n);
  });

  it("prices measured electricity and rejects a reversing meter", () => {
    expect(calculateElectricityCostCents("1000.125", "1123.575", 320000n)).toEqual({ consumptionKwh: "123.45", amountCents: 3950n });
    expect(calculateElectricityCostCents("0", "100", 254700n)).toEqual({ consumptionKwh: "100", amountCents: 2547n });
    expect(() => calculateElectricityCostCents("10", "9.999", 300000n)).toThrow("rückwärts");
  });

  it("prorates partial months by calendar days", () => {
    expect(prorateMonthlyCents(3100n, "2025-01-16", "2025-01-31")).toBe(1600n);
    expect(toScaledInteger("12,345")).toBe(12345n);
  });
});
