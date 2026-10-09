import { isoDay } from "@/lib/energy-billing";

export function archiveName(value: string): string {
  const replacements: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss" };
  const clean = value.replace(/[äöüÄÖÜß]/g, (c) => replacements[c]).normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^[_ .]+|[_ .]+$/g, "").slice(0, 80);
  const result = clean || "Unbekannt";
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(result) ? `_${result}` : result;
}

export function invoiceFolder(code: string, section: string, name: string): string {
  if (code === "HEATING") return `Heizkosten/${({ HEATING_OIL: "Heizoel", WARTUNG: "Wartung", SCHORNSTEINFEGER: "Schornsteinfeger", BETRIEBSSTROM: "Betriebsstrom" } as Record<string, string>)[section] || archiveName(section)}`;
  if (code === "WASTEWATER") return `Kleinklaeranlage/${section === "BETRIEBSSTROM" ? "Betriebsstrom" : "Wartung_Pruefung_Entleerung"}`;
  return ({ WATER: "Wasser", WASTE: "Muell", ELECTRICITY: "Haushaltsstrom", PROPERTY_TAX: "Grundsteuer", BUILDING_INSURANCE: "Gebaeudeversicherung", LIABILITY_INSURANCE: "Haftpflichtversicherung", OTHER: "Sonstige_Betriebskosten" } as Record<string, string>)[code] || archiveName(name);
}

export function invoiceArchivePath(input: { objectFolder: string; documentId: string; extension: string; invoice?: { id: string; status: string; invoiceDate: Date | null; supplier: string | null; invoiceNumber: string | null; code: string; section: string; categoryName: string; costCategoryId?: string } }): string {
  const object = archiveName(input.objectFolder);
  const extension = input.extension.toLowerCase();
  if (![".pdf", ".jpg", ".jpeg", ".png", ".webp", ".eml"].includes(extension)) throw new Error("Unsupported archive format");
  const invoice = input.invoice;
  if (!invoice || invoice.status !== "CONFIRMED" || !invoice.invoiceDate) return `${object}/Eingang/Ungeprueft/Beleg__${archiveName(input.documentId)}${extension}`;
  const day = isoDay(invoice.invoiceDate);
  return `${object}/${day.slice(0, 4)}/Rechnungen/${invoiceFolder(invoice.code, invoice.section, invoice.categoryName)}${!["HEATING", "WASTEWATER", "WATER", "WASTE", "ELECTRICITY", "PROPERTY_TAX", "BUILDING_INSURANCE", "LIABILITY_INSURANCE", "OTHER"].includes(invoice.code) ? `__${archiveName(invoice.costCategoryId || invoice.code)}` : ""}/${day}_${archiveName(invoice.supplier || "Lieferant")}_${archiveName(invoice.invoiceNumber || "Ohne_Nummer")}__${archiveName(input.documentId)}${extension}`;
}

export function statementArchivePath(input: { objectFolder: string; start: Date; end: Date; tenantName: string; tenantId: string; revision?: number; previewId?: string }): string {
  if (!input.revision && !input.previewId) throw new Error("Statement revision or preview identifier required");
  const range = `${isoDay(input.start)}_bis_${isoDay(input.end)}`;
  const name = archiveName(input.tenantName);
  const version = input.revision ? `R${String(input.revision).padStart(3, "0")}` : `P_${archiveName(input.previewId!)}`;
  return `${archiveName(input.objectFolder)}/${isoDay(input.end).slice(0, 4)}/Nebenkostenabrechnungen/${range}/${input.revision ? "Freigegeben" : "Entwuerfe"}/${name}__${archiveName(input.tenantId)}/NKA_${range}_${name}_${version}.pdf`;
}
