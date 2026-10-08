import {
  toScaledInteger,
  fromScaledInteger,
  roundFraction,
} from "@/lib/billing-v2";

export type Region = { x: number; y: number; width: number; height: number };
export type OcrWord = { text: string; confidence: number; region: Region };
export type OcrPage = { page: number; words: OcrWord[] };
export type OcrDocument = { pages: OcrPage[]; text: string };
export type FieldFormat =
  | "TEXT"
  | "DATE"
  | "CENTS"
  | "DECIMAL"
  | "PERCENT"
  | "GRAMS"
  | "MICRO_EURO";
export type FieldRule = {
  field: string;
  page: number;
  region: Region;
  format: FieldFormat;
  required: boolean;
  unit?: string;
  pattern?: string;
  anchor?: { text: string; dx: number; dy: number };
};
export type TableRule = {
  page: number;
  region: Region;
  descriptionRegion: Region;
  amountRegion: Region;
  classification: string;
};
export type TemplateRules = { fields: FieldRule[]; table?: TableRule };
export type FieldResult = {
  raw: string;
  value: string | null;
  page: number;
  region: Region;
  errors: string[];
};
export type ExtractionResult = {
  fields: Record<string, FieldResult>;
  lines: {
    description: string;
    amountCents: string;
    classification: string;
    confirmedRunningExpense: boolean;
  }[];
  errors: string[];
};

export const EXTRACTABLE_FIELDS = [
  "supplier",
  "invoiceNumber",
  "invoiceDate",
  "deliveryDate",
  "servicePeriodStart",
  "servicePeriodEnd",
  "totalAmountCents",
  "netAmountCents",
  "vatAmountCents",
  "vatRate",
  "quantityLiters",
  "consumptionKwh",
  "meterNumber",
  "priceMicroEuroPerKwh",
  "monthlyBasePriceCents",
  "tariffValidFrom",
  "tariffValidTo",
  "co2CostCents",
  "co2Grams",
  "energyContentKwh",
  "emissionFactorMicrogWh",
  "annualAllocatableAmountCents",
  "annualRateMicroCentsPerM2",
];

export function normalizeGermanDecimal(raw: string): string {
  let value = raw
    .trim()
    .replace(/\s|€/g, "")
    .replace(/(?:EUR|Euro|kWh|kg|g|l|L|%|µ€)$/i, "");
  if (value.includes(",")) {
    if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+),\d+$/.test(value))
      throw new Error("Ungültiges deutsches Zahlenformat.");
    value = value.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(value))
    value = value.replace(/\./g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(value))
    throw new Error("Keine eindeutige Zahl erkannt.");
  return value;
}

export function normalizeField(
  raw: string,
  format: FieldFormat,
  unit?: string,
): string {
  if (format === "TEXT") {
    if (!raw.trim()) throw new Error("Text fehlt.");
    return raw.trim();
  }
  if (format === "DATE") {
    const value = raw.trim();
    const parts = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(value);
    const iso = parts
      ? `${parts[3]}-${parts[2].padStart(2, "0")}-${parts[1].padStart(2, "0")}`
      : value;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(iso) ||
      !Number.isFinite(new Date(iso).getTime()) ||
      new Date(iso).toISOString().slice(0, 10) !== iso
    )
      throw new Error("Ungültiges Datum.");
    return iso;
  }
  const value = normalizeGermanDecimal(raw);
  if (format === "CENTS") return toScaledInteger(value, 2).toString();
  if (format === "MICRO_EURO") return toScaledInteger(value, 6).toString();
  if (format === "GRAMS")
    return (
      unit === "kg" ? toScaledInteger(value, 3) : toScaledInteger(value, 0)
    ).toString();
  const scaled = toScaledInteger(value, 3);
  if (format === "PERCENT" && (scaled < 0n || scaled > 100_000n))
    throw new Error("Prozentsatz muss zwischen 0 und 100 liegen.");
  return fromScaledInteger(scaled);
}

export function regionValid(region: Region) {
  return (
    [region.x, region.y, region.width, region.height].every(Number.isFinite) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= 1.001 &&
    region.y + region.height <= 1.001
  );
}
function inside(word: OcrWord, region: Region) {
  const x = word.region.x + word.region.width / 2;
  const y = word.region.y + word.region.height / 2;
  return (
    x >= region.x &&
    x <= region.x + region.width &&
    y >= region.y &&
    y <= region.y + region.height
  );
}
export function anchorMatches(page: OcrPage, text: string): Region[] {
  const clean = (value: string) =>
    value.toLocaleLowerCase("de-DE").replace(/\s+/g, " ").trim();
  const wanted = clean(text);
  if (!wanted) return [];
  const found: Region[] = [];
  for (let i = 0; i < page.words.length; i++) {
    let phrase = "";
    for (let n = i; n < Math.min(page.words.length, i + 12); n++) {
      phrase += (phrase ? " " : "") + page.words[n].text;
      if (clean(phrase) === wanted) {
        const words = page.words.slice(i, n + 1);
        const x = Math.min(...words.map((w) => w.region.x));
        const y = Math.min(...words.map((w) => w.region.y));
        found.push({
          x,
          y,
          width: Math.max(...words.map((w) => w.region.x + w.region.width)) - x,
          height:
            Math.max(...words.map((w) => w.region.y + w.region.height)) - y,
        });
      }
    }
  }
  return found;
}

export function validateRules(rules: TemplateRules) {
  if (
    !rules ||
    !Array.isArray(rules.fields) ||
    rules.fields.length > 40 ||
    !rules.fields.length
  )
    throw new Error("Mindestens eine Feldregel erforderlich (maximal 40).");
  const used = new Set<string>();
  for (const rule of rules.fields) {
    if (!EXTRACTABLE_FIELDS.includes(rule.field) || used.has(rule.field))
      throw new Error("Ungültiges oder mehrfach definiertes Feld.");
    used.add(rule.field);
    if (
      !Number.isInteger(rule.page) ||
      rule.page < 1 ||
      !regionValid(rule.region) ||
      ![
        "TEXT",
        "DATE",
        "CENTS",
        "DECIMAL",
        "PERCENT",
        "GRAMS",
        "MICRO_EURO",
      ].includes(rule.format)
    )
      throw new Error("Ungültige Feldregion oder Format.");
    if (
      rule.anchor &&
      (!rule.anchor.text?.trim() ||
        !Number.isFinite(rule.anchor.dx) ||
        !Number.isFinite(rule.anchor.dy))
    )
      throw new Error("Ungültiger Textanker.");
    // Reject constructs that can cause unbounded backtracking; expressions only
    // filter a bounded field region and may not execute code.
    if (
      rule.pattern &&
      (rule.pattern.length > 160 || /[{}*+]|\\[1-9]|\(\?/.test(rule.pattern))
    )
      throw new Error(
        "Textmuster unterstützt nur einfache, begrenzte Muster ohne Wiederholungsoperatoren.",
      );
    if (rule.pattern) new RegExp(rule.pattern, "u");
  }
  if (
    rules.table &&
    (!regionValid(rules.table.region) ||
      !regionValid(rules.table.descriptionRegion) ||
      !regionValid(rules.table.amountRegion) ||
      !Number.isInteger(rules.table.page) ||
      rules.table.page < 1)
  )
    throw new Error("Ungültige Tabellenregion.");
}

export function templateMatches(document: OcrDocument, markers: string[]) {
  return (
    markers.length > 0 &&
    markers.every((marker) =>
      document.text
        .toLocaleLowerCase("de-DE")
        .includes(marker.toLocaleLowerCase("de-DE")),
    )
  );
}

export function extractInvoice(
  document: OcrDocument,
  rules: TemplateRules,
): ExtractionResult {
  validateRules(rules);
  const fields: Record<string, FieldResult> = {};
  const errors: string[] = [];
  for (const rule of rules.fields) {
    const page = document.pages.find((page) => page.page === rule.page);
    let region = rule.region;
    let error = "";
    if (rule.anchor && page) {
      const matches = anchorMatches(page, rule.anchor.text);
      if (matches.length !== 1)
        error = "Textanker fehlt oder ist nicht eindeutig.";
      else
        region = {
          ...region,
          x: matches[0].x + rule.anchor.dx,
          y: matches[0].y + rule.anchor.dy,
        };
    }
    const selected =
      !error && page ? page.words.filter((word) => inside(word, region)) : [];
    let raw = selected
      .map((word) => word.text)
      .join(" ")
      .trim();
    if (rule.pattern && raw) {
      const matches = [...raw.matchAll(new RegExp(rule.pattern, "gu"))];
      if (matches.length !== 1)
        error = "Textmuster liefert keinen eindeutigen Treffer.";
      else raw = matches[0][1] ?? matches[0][0];
    }
    let value: string | null = null;
    if (!error && raw) {
      try {
        value = normalizeField(raw, rule.format, rule.unit);
      } catch (e) {
        error = e instanceof Error ? e.message : "Ungültiger Wert";
      }
    }
    if (!raw && rule.required && !error)
      error = "Pflichtfeld wurde nicht erkannt.";
    if (selected.some((word) => word.confidence > 0 && word.confidence < 0.8))
      error = error || "OCR-Erkennung unsicher; Wert prüfen.";
    fields[rule.field] = {
      raw,
      value,
      page: rule.page,
      region,
      errors: error ? [error] : [],
    };
    if (error) errors.push(`${rule.field}: ${error}`);
  }
  const lines: ExtractionResult["lines"] = [];
  if (rules.table) {
    const table = rules.table;
    const words =
      document.pages
        .find((page) => page.page === table.page)
        ?.words.filter((word) => inside(word, table.region)) ?? [];
    const amounts = words.filter((word) =>
      inside(word, {
        ...table.amountRegion,
        y: table.region.y,
        height: table.region.height,
      }),
    );
    const rows: OcrWord[][] = [];
    for (const word of amounts) {
      let row = rows.find(
        (row) => Math.abs(row[0].region.y - word.region.y) < 0.008,
      );
      if (!row) {
        row = [];
        rows.push(row);
      }
      row.push(word);
    }
    for (const row of rows) {
      const raw = row.map((word) => word.text).join(" ");
      const description = words
        .filter((word) =>
          inside(word, {
            ...table.descriptionRegion,
            y: row[0].region.y - 0.005,
            height: Math.max(row[0].region.height, 0.01) + 0.01,
          }),
        )
        .map((word) => word.text)
        .join(" ");
      try {
        lines.push({
          description: description || "Rechnungsposition",
          amountCents: normalizeField(raw, "CENTS"),
          classification: table.classification,
          confirmedRunningExpense: false,
        });
      } catch {
        errors.push(`Tabellenbetrag „${raw}“ ist nicht eindeutig.`);
      }
    }
    if (!lines.length) errors.push("Keine Tabellenzeilen erkannt.");
  }
  const values = Object.fromEntries(
    Object.entries(fields).map(([key, result]) => [key, result.value]),
  );
  errors.push(...validateInvoiceValues(values));
  if (
    lines.length &&
    values.totalAmountCents &&
    lines.reduce((sum, line) => sum + BigInt(line.amountCents), 0n) !==
      BigInt(values.totalAmountCents)
  )
    errors.push(
      "Summe der Tabellenzeilen stimmt nicht mit dem Gesamtbetrag überein.",
    );
  return { fields, lines, errors };
}

export function validateInvoiceValues(
  values: Record<string, string | null | undefined>,
) {
  const errors: string[] = [];
  if (
    values.servicePeriodStart &&
    values.servicePeriodEnd &&
    values.servicePeriodEnd < values.servicePeriodStart
  )
    errors.push("Leistungsende liegt vor Leistungsbeginn.");
  if (
    values.totalAmountCents &&
    values.netAmountCents &&
    values.vatAmountCents &&
    BigInt(values.netAmountCents) + BigInt(values.vatAmountCents) !==
      BigInt(values.totalAmountCents)
  )
    errors.push("Netto + Umsatzsteuer stimmt nicht mit Brutto überein.");
  if (values.netAmountCents && values.vatRate && values.vatAmountCents) {
    const expected = roundFraction(
      BigInt(values.netAmountCents) * toScaledInteger(values.vatRate),
      100_000n,
    );
    if (expected !== BigInt(values.vatAmountCents))
      errors.push(
        "Umsatzsteuersatz und Steuerbetrag stimmen nicht überein (bei mehreren Sätzen den Gesamtsatz leer lassen).",
      );
  }
  return errors;
}
