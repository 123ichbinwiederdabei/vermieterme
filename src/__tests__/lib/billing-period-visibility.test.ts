import { describe, expect, it } from "vitest";
import { billingPeriodCoversCalendarYear, isActiveBillingPeriod } from "@/lib/billing";

describe("billing-period visibility", () => {
  it("recognises a calendar year fully enclosed by a multi-year period", () => {
    expect(billingPeriodCoversCalendarYear({ startDate: "2024-08-01", endDate: "2026-09-12" }, 2025)).toBe(true);
    expect(billingPeriodCoversCalendarYear({ startDate: "2026-09-13", endDate: "2026-12-31" }, 2025)).toBe(false);
  });

  it("keeps superseded periods out of operational selections", () => {
    expect(isActiveBillingPeriod({ status: "OPEN" })).toBe(true);
    expect(isActiveBillingPeriod({ status: "SUPERSEDED" })).toBe(false);
  });
});
