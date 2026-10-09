import { expect, it } from "vitest";
import { meterIntervals } from "@/lib/electricity-intervals";
const d = (date: string) => new Date(date);
const contract = { validFrom: d("2026-01-01"), tariffs: [{ validFrom: d("2026-01-01"), validTo: null, priceMicroEuroPerKwh: 254700n }], meters: [] };
const meter = { id: "meter", meterNumber: "123", role: "UNIT_CONSUMPTION", unitId: "unit", readings: [{ readingDate: d("2026-01-01"), readingKwh: "100" }, { readingDate: d("2026-09-12"), billingEffectiveDate: d("2026-09-11"), readingKwh: "200", note: "Confirmed closing boundary, actual reading on September 12", confirmed: true }, { readingDate: d("2026-12-31"), readingKwh: "350" }] };
it("shares the measured cutover between adjacent calendar periods without changing or counting consumption twice", () => {
  const closing = meterIntervals(contract,meter,d("2026-01-01"),d("2026-09-11"));
  const opening = meterIntervals(contract,meter,d("2026-09-12"),d("2026-12-31"));
  expect(closing.blockers).toEqual([]); expect(opening.blockers).toEqual([]);
  expect(closing.intervals[0].consumptionKwh).toBe("100"); expect(opening.intervals[0].consumptionKwh).toBe("150");
  expect(closing.intervals[0].boundaryNotes).toContain("2026-09-12");
  expect(meter.readings[1].readingDate).toEqual(d("2026-09-12"));
});
it("rejects undocumented or unconfirmed closing-date aliases", () => {
  for(const override of [{note:""},{confirmed:false}]){
    const result=meterIntervals(contract,{...meter,readings:meter.readings.map((r,i)=>i===1?{...r,...override}:r)},d("2026-01-01"),d("2026-09-11"));
    expect(result.blockers.join(" ")).toContain("nicht bestätigt oder dokumentiert");expect(result.intervals).toEqual([]);
  }
});
it("does not override a conflicting actual reading with an alias", () => {
  const result=meterIntervals(contract,{...meter,readings:[...meter.readings,{readingDate:d("2026-09-11"),readingKwh:"190"}]},d("2026-01-01"),d("2026-09-11"));
  expect(result.blockers.join(" ")).toContain("Widersprüchliche Grenzablesung");
});
