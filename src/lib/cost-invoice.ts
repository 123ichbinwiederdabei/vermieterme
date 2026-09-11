export const SMALL_WASTEWATER_CATEGORY = "Entwässerung – Kleinkläranlage";

const ELIGIBLE = new Set(["WARTUNG", "PRÜFUNG", "BETRIEBSSTROM", "SCHLAMMABFUHR"]);

export function isEligibleInvoiceLine(line: { classification: string; confirmedRunningExpense: boolean }) {
  return ELIGIBLE.has(line.classification) || (line.classification === "SONSTIGES" && line.confirmedRunningExpense);
}
