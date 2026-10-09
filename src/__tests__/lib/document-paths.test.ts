import { expect, it } from "vitest";
import { archiveName, invoiceArchivePath, statementArchivePath } from "@/lib/document-paths";
const invoice = { id: "i", status: "CONFIRMED", invoiceDate: new Date("2025-12-31"), supplier: "Müller / Wasser", invoiceNumber: "2025:4", code: "WATER", section: "WASSER", categoryName: "Wasser" };
it("archives by invoice date independently of service or billing year", () => {
  const result = invoiceArchivePath({ objectFolder: "Krandorf", documentId: "doc1", extension: ".PDF", invoice });
  expect(result).toBe("Krandorf/2025/Rechnungen/Wasser/2025-12-31_Mueller_Wasser_2025_4__doc1.pdf");
  expect(invoiceArchivePath({ objectFolder: "Krandorf", documentId: "doc2", extension: ".pdf", invoice: { ...invoice, invoiceDate: null } })).toContain("Eingang/Ungeprueft");
});
it("keeps normalized names collision-safe through document/category/tenancy identifiers", () => {
  expect(archiveName("CON")).toBe("_CON");
  expect(archiveName("../Krändorf\\.." )).toBe("Kraendorf");
  const input = { objectFolder: "Objekt", extension: ".png", invoice: { ...invoice, code: "NEW", costCategoryId: "category-1", categoryName: "Neue Art" } };
  expect(invoiceArchivePath({ ...input, documentId: "one" })).not.toBe(invoiceArchivePath({ ...input, documentId: "two" }));
  expect(invoiceArchivePath({ ...input, documentId: "one" })).toContain("Neue_Art__category-1");
});
it("uses full multi-year ranges and separate previews and revisions", () => {
  const input = { objectFolder: "Krandorf", start: new Date("2024-09-13"), end: new Date("2026-12-31"), tenantName: "Isabella Schart", tenantId: "tenancy-1" };
  expect(statementArchivePath({ ...input, revision: 1 })).toContain("/2026/Nebenkostenabrechnungen/2024-09-13_bis_2026-12-31/Freigegeben/Isabella_Schart__tenancy-1/");
  expect(statementArchivePath({ ...input, revision: 2 })).toContain("R002.pdf");
  expect(statementArchivePath({ ...input, previewId: "p1" })).not.toBe(statementArchivePath({ ...input, previewId: "p2" }));
});
