export const BILLING_CATEGORIES = [
  {
    code: "HEATING",
    name: "Heizkosten",
    key: "Wohnfläche",
    kind: "HEATING_OIL",
  },
  {
    code: "ELECTRICITY",
    name: "Haushaltsstrom",
    key: "Verbrauch",
    kind: "ELECTRICITY",
  },
  {
    code: "WATER",
    name: "Wasserversorgung",
    key: "Wohnfläche",
    kind: "MANUAL",
  },
  {
    code: "WASTE",
    name: "Müllentsorgung",
    key: "Gleicher Anteil",
    kind: "MANUAL",
  },
  {
    code: "WASTEWATER",
    name: "Kleinkläranlage",
    key: "Gleicher Anteil",
    kind: "SMALL_WASTEWATER",
  },
  {
    code: "PROPERTY_TAX",
    name: "Grundsteuer",
    key: "Wohnfläche",
    kind: "MANUAL",
  },
] as const;

export function categoryCode(category: {
  code?: string;
  name: string;
  calculationType?: string;
}): string {
  if (category.code && category.code !== "OTHER") return category.code;
  if (
    category.calculationType === "HEATING_OIL" ||
    /Heizöl|Heizkosten/.test(category.name)
  )
    return "HEATING";
  if (category.calculationType === "ELECTRICITY") return "ELECTRICITY";
  if (/Kleinkläranlage/.test(category.name)) return "WASTEWATER";
  if (/Grundsteuer/.test(category.name)) return "PROPERTY_TAX";
  if (/Müll|Abfall/.test(category.name)) return "WASTE";
  if (/Wasser|Wasserversorgung/.test(category.name)) return "WATER";
  return "OTHER";
}

export const INVOICE_SECTIONS: Record<string, string[]> = {
  HEATING: ["HEATING_OIL", "WARTUNG", "SCHORNSTEINFEGER", "BETRIEBSSTROM"],
  ELECTRICITY: ["TARIF", "JAHRESRECHNUNG"],
  WATER: ["WASSER"],
  WASTE: ["GEBÜHREN"],
  WASTEWATER: ["WARTUNG", "PRÜFUNG", "SCHLAMMABFUHR", "BETRIEBSSTROM"],
  PROPERTY_TAX: ["BESCHEID"],
  OTHER: ["OPERATING"],
};

export const LINE_CLASSES = [
  "WARTUNG",
  "PRÜFUNG",
  "SCHORNSTEINFEGER",
  "EMISSIONSMESSUNG",
  "BETRIEBSSTROM",
  "SCHLAMMABFUHR",
  "WASSER",
  "GRUNDGEBÜHR",
  "GEBÜHREN",
  "BESCHEID",
  "HEATING_OIL",
  "TARIF",
  "JAHRESRECHNUNG",
  "REPARATUR",
  "ERSATZ",
  "SANIERUNG",
  "MODERNISIERUNG",
  "SONSTIGES",
  "OPERATING",
];

export function eligibleForCategory(
  code: string,
  line: { classification: string; confirmedRunningExpense: boolean },
): boolean {
  if (
    ["REPARATUR", "ERSATZ", "SANIERUNG", "MODERNISIERUNG"].includes(
      line.classification,
    )
  )
    return false;
  if (line.classification === "SONSTIGES") return line.confirmedRunningExpense;
  const allowed: Record<string, string[]> = {
    HEATING: [
      "WARTUNG",
      "PRÜFUNG",
      "SCHORNSTEINFEGER",
      "EMISSIONSMESSUNG",
      "BETRIEBSSTROM",
    ],
    WATER: ["WASSER", "GRUNDGEBÜHR"],
    WASTE: ["GEBÜHREN"],
    WASTEWATER: ["WARTUNG", "PRÜFUNG", "BETRIEBSSTROM", "SCHLAMMABFUHR"],
    PROPERTY_TAX: ["BESCHEID"],
    OTHER: ["OPERATING"],
  };
  return (allowed[code] ?? ["OPERATING"]).includes(line.classification);
}
