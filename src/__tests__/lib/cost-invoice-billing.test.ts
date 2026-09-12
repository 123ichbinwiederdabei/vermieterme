import { describe, expect, it } from "vitest";
import { allocateServiceLineToPeriod, isEligibleInvoiceLine } from "@/lib/cost-invoice";

describe("Kleinkläranlagen-Rechnungszeilen", () => {
  it("includes operating, maintenance, inspection, electricity and sludge removal", () => {
    for (const classification of ["WARTUNG", "PRÜFUNG", "BETRIEBSSTROM", "SCHLAMMABFUHR"]) {
      expect(isEligibleInvoiceLine({ classification, confirmedRunningExpense: false })).toBe(true);
    }
  });

  it("allocates a cross-year invoice line in deterministic daily cents", () => {
    const start = new Date("2024-12-30T00:00:00.000Z");
    const end = new Date("2025-01-02T00:00:00.000Z");
    const december = allocateServiceLineToPeriod(101n, start, end, start, new Date("2024-12-31T00:00:00.000Z"));
    const january = allocateServiceLineToPeriod(101n, start, end, new Date("2025-01-01T00:00:00.000Z"), end);
    expect(december).toBe(51n);
    expect(january).toBe(50n);
    expect(december + january).toBe(101n);
  });

  it("excludes repairs and investment costs and requires an explicit operating confirmation for other", () => {
    for (const classification of ["REPARATUR", "ERSATZ", "SANIERUNG", "MODERNISIERUNG"]) {
      expect(isEligibleInvoiceLine({ classification, confirmedRunningExpense: true })).toBe(false);
    }
    expect(isEligibleInvoiceLine({ classification: "SONSTIGES", confirmedRunningExpense: false })).toBe(false);
    expect(isEligibleInvoiceLine({ classification: "SONSTIGES", confirmedRunningExpense: true })).toBe(true);
  });
});
