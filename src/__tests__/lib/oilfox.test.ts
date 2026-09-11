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

  it("imports the Krandorf OilFox export with a separate litre unit and millimetres", () => {
    const result = parseOilFoxCsv("Measurement Time;Fill Level;Fill Level Unit;Fill Level Height [mm];Distance [mm];Pressure [Pa];Metering Status;Manually Invalidated;Fill Level [%];Metering Type;Signal Strength\n2024-07-17 16:31;3163;L;980;510;;OK;false;74;AUTOMATIC;GOOD\n2024-07-18 16:31;3200;gal;970;500;;OK;false;75;AUTOMATIC;GOOD");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ fillLevelLiters: "3163", distanceCm: "51", fillLevelPercent: 74, meteringStatus: "OK", manuallyInvalidated: false, meteringType: "AUTOMATIC", signalStrength: "GOOD" });
    expect(result.unitErrors).toBe(1);
    expect(result.detectedColumns).toContain("Measurement Time");
  });

  it("detects significant increases only", () => {
    expect(isPossibleDelivery("1370", "3850", "200")).toBe(true);
    expect(isPossibleDelivery("1370", "1500", "200")).toBe(false);
  });
});
