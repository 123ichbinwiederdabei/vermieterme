import { describe, expect, it } from "vitest";
import { isEligibleInvoiceLine } from "@/lib/cost-invoice";

describe("Kleinkläranlagen-Rechnungszeilen", () => {
  it("includes operating, maintenance, inspection, electricity and sludge removal", () => {
    for (const classification of ["WARTUNG", "PRÜFUNG", "BETRIEBSSTROM", "SCHLAMMABFUHR"]) {
      expect(isEligibleInvoiceLine({ classification, confirmedRunningExpense: false })).toBe(true);
    }
  });

  it("excludes repairs and investment costs and requires an explicit operating confirmation for other", () => {
    for (const classification of ["REPARATUR", "ERSATZ", "SANIERUNG", "MODERNISIERUNG"]) {
      expect(isEligibleInvoiceLine({ classification, confirmedRunningExpense: true })).toBe(false);
    }
    expect(isEligibleInvoiceLine({ classification: "SONSTIGES", confirmedRunningExpense: false })).toBe(false);
    expect(isEligibleInvoiceLine({ classification: "SONSTIGES", confirmedRunningExpense: true })).toBe(true);
  });
});
