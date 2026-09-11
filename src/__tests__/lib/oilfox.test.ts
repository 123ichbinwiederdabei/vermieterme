import { describe, expect, it } from "vitest";
import { parseOilFoxCsv } from "@/lib/oilfox-csv";
import { isPossibleDelivery } from "@/lib/oilfox-sync";

describe("OilFox import and delivery detection", () => {
  it("imports German FoxMobile CSV values", () => {
    const result = parseOilFoxCsv("Datum;Füllstand (Liter);Messwert (cm)\n01.02.2026 08:15;1.370,5;82,3\n02.02.2026 08:15;3850;31\ninvalid;row;x");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].fillLevelLiters).toBe("1370.5");
    expect(result.rows[0].distanceCm).toBe("82.3");
    expect(result.invalidRows).toBe(1);
  });

  it("detects significant increases only", () => {
    expect(isPossibleDelivery("1370", "3850", "200")).toBe(true);
    expect(isPossibleDelivery("1370", "1500", "200")).toBe(false);
  });
});
