import { describe, expect, it } from "vitest";
import {
  anchorMatches,
  extractInvoice,
  normalizeField,
  templateMatches,
  validateInvoiceValues,
  validateRules,
  type OcrDocument,
  type TemplateRules,
} from "@/lib/invoice-extraction";

const document: OcrDocument = {
  text: "Lieferant GmbH Rechnung Brutto 1.234,56 Datum 01.10.2026 CO2 123,456 kg",
  pages: [
    {
      page: 1,
      words: [
        {
          text: "Brutto",
          confidence: 0.99,
          region: { x: 0.1, y: 0.2, width: 0.1, height: 0.03 },
        },
        {
          text: "1.234,56",
          confidence: 0.99,
          region: { x: 0.4, y: 0.2, width: 0.15, height: 0.03 },
        },
        {
          text: "01.10.2026",
          confidence: 0.99,
          region: { x: 0.4, y: 0.3, width: 0.15, height: 0.03 },
        },
      ],
    },
  ],
};
const rules: TemplateRules = {
  fields: [
    {
      field: "totalAmountCents",
      format: "CENTS",
      page: 1,
      required: true,
      region: { x: 0.39, y: 0.19, width: 0.2, height: 0.05 },
      anchor: { text: "Brutto", dx: 0.29, dy: -0.01 },
    },
    {
      field: "invoiceDate",
      format: "DATE",
      page: 1,
      required: true,
      region: { x: 0.39, y: 0.29, width: 0.2, height: 0.05 },
    },
  ],
};
describe("invoice design extraction", () => {
  it("extracts selected German money and dates with source regions", () => {
    const result = extractInvoice(document, rules);
    expect(result.errors).toEqual([]);
    expect(result.fields.totalAmountCents.value).toBe("123456");
    expect(result.fields.invoiceDate.value).toBe("2026-10-01");
    expect(result.fields.totalAmountCents.page).toBe(1);
  });
  it("tracks a shifted amount through its label anchor", () => {
    const shifted = structuredClone(document);
    for (const word of shifted.pages[0].words) word.region.y += 0.1;
    const result = extractInvoice(shifted, { fields: [rules.fields[0]] });
    expect(result.fields.totalAmountCents.value).toBe("123456");
  });
  it("requires review for duplicate anchors instead of choosing the first", () => {
    const duplicate = structuredClone(document);
    duplicate.pages[0].words.push({
      ...duplicate.pages[0].words[0],
      region: { x: 0.1, y: 0.7, width: 0.1, height: 0.03 },
    });
    expect(anchorMatches(duplicate.pages[0], "Brutto")).toHaveLength(2);
    expect(extractInvoice(duplicate, rules).errors.join()).toContain(
      "nicht eindeutig",
    );
  });
  it("does not substitute zero for absent CO2", () => {
    const result = extractInvoice(document, {
      fields: [
        {
          field: "co2Grams",
          format: "GRAMS",
          unit: "kg",
          page: 1,
          required: true,
          region: { x: 0.8, y: 0.8, width: 0.1, height: 0.1 },
        },
      ],
    });
    expect(result.fields.co2Grams.value).toBeNull();
    expect(result.errors).toHaveLength(1);
  });
  it("converts kg and unit prices exactly", () => {
    expect(normalizeField("123,456 kg", "GRAMS", "kg")).toBe("123456");
    expect(normalizeField("0,2764 €", "MICRO_EURO")).toBe("276400");
  });
  it("rejects precision loss and invalid dates", () => {
    expect(() => normalizeField("1,234", "CENTS")).toThrow();
    expect(() => normalizeField("31.02.2026", "DATE")).toThrow();
    expect(() => normalizeField("1234,5.6", "CENTS")).toThrow();
  });
  it("checks net, VAT and gross without adding VAT twice", () => {
    expect(
      validateInvoiceValues({
        netAmountCents: "10000",
        vatRate: "19",
        vatAmountCents: "1900",
        totalAmountCents: "11900",
      }),
    ).toEqual([]);
    expect(
      validateInvoiceValues({
        netAmountCents: "10000",
        vatAmountCents: "1900",
        totalAmountCents: "10000",
      }),
    ).toHaveLength(1);
  });
  it("supports aggregate VAT with multiple rates by leaving the total rate unset", () => {
    expect(
      validateInvoiceValues({
        netAmountCents: "20000",
        vatAmountCents: "2600",
        totalAmountCents: "22600",
      }),
    ).toEqual([]);
  });
  it("requires every design marker and rejects unsafe/invalid rules", () => {
    expect(templateMatches(document, ["Lieferant GmbH", "Rechnung"])).toBe(
      true,
    );
    expect(templateMatches(document, ["Lieferant GmbH", "Wasser"])).toBe(false);
    expect(() =>
      validateRules({ fields: [{ ...rules.fields[0], pattern: "(a+)+" }] }),
    ).toThrow();
    expect(() =>
      validateRules({
        fields: [
          {
            ...rules.fields[0],
            region: { x: 2, y: 0, width: 0.1, height: 0.1 },
          },
        ],
      }),
    ).toThrow();
  });
  it("extracts recurring table rows and validates their total", () => {
    const doc: OcrDocument = {
      text: "Wartung",
      pages: [
        {
          page: 1,
          words: [
            {
              text: "Service",
              confidence: 1,
              region: { x: 0.1, y: 0.5, width: 0.15, height: 0.02 },
            },
            {
              text: "100,00",
              confidence: 1,
              region: { x: 0.7, y: 0.5, width: 0.1, height: 0.02 },
            },
            {
              text: "Prüfung",
              confidence: 1,
              region: { x: 0.1, y: 0.55, width: 0.15, height: 0.02 },
            },
            {
              text: "50,00",
              confidence: 1,
              region: { x: 0.7, y: 0.55, width: 0.1, height: 0.02 },
            },
            {
              text: "150,00",
              confidence: 1,
              region: { x: 0.7, y: 0.8, width: 0.1, height: 0.02 },
            },
          ],
        },
      ],
    };
    const result = extractInvoice(doc, {
      fields: [
        {
          field: "totalAmountCents",
          format: "CENTS",
          page: 1,
          required: true,
          region: { x: 0.65, y: 0.78, width: 0.2, height: 0.05 },
        },
      ],
      table: {
        page: 1,
        region: { x: 0.05, y: 0.48, width: 0.8, height: 0.1 },
        descriptionRegion: { x: 0.05, y: 0.48, width: 0.4, height: 0.1 },
        amountRegion: { x: 0.65, y: 0.48, width: 0.2, height: 0.1 },
        classification: "WARTUNG",
      },
    });
    expect(result.lines.map((line) => line.amountCents)).toEqual([
      "10000",
      "5000",
    ]);
    expect(result.errors).toEqual([]);
  });
});
