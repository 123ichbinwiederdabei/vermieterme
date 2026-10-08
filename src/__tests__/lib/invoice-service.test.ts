import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { invoiceInput } from "@/lib/invoice-service";
const values = {
  invoiceDate: "2026-10-01",
  servicePeriodStart: "2026-01-01",
  servicePeriodEnd: "2026-12-31",
  totalAmountCents: "11900",
  netAmountCents: "10000",
  vatAmountCents: "1900",
  vatRate: "19",
};
describe("confirmed invoice validation", () => {
  it("keeps the gross total and full annual service range", () => {
    const result = invoiceInput({ values }, "WASSER");
    expect(result.totalAmountCents).toBe(11900n);
    expect(result.lines[0].amountCents).toBe(11900n);
    expect(result.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
  it("blocks incomplete or reversed dates", () => {
    expect(() =>
      invoiceInput(
        { values: { ...values, servicePeriodStart: "" } },
        "WARTUNG",
      ),
    ).toThrow();
    expect(() =>
      invoiceInput(
        { values: { ...values, servicePeriodEnd: "2025-12-31" } },
        "WASSER",
      ),
    ).toThrow();
  });
  it("blocks unmatched line sums and invalid classifications", () => {
    expect(() =>
      invoiceInput(
        {
          values,
          lines: [
            {
              description: "Repair",
              amountCents: "1000",
              classification: "REPARATUR",
            },
          ],
        },
        "WARTUNG",
      ),
    ).toThrow();
    expect(() =>
      invoiceInput(
        {
          values,
          lines: [
            {
              description: "Repair",
              amountCents: "11900",
              classification: "INVALID",
            },
          ],
        },
        "WARTUNG",
      ),
    ).toThrow();
  });
  it("retains excluded repairs as classified evidence", () => {
    const result = invoiceInput(
      {
        values,
        lines: [
          {
            description: "Repair",
            amountCents: "11900",
            classification: "REPARATUR",
          },
        ],
      },
      "WARTUNG",
    );
    expect(result.lines[0].classification).toBe("REPARATUR");
  });
});
