// @vitest-environment node
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createKrandorfFixture, fixturePng } from "../../../test-support/krandorf-fixture";
const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
import { previewDomainChange, commitDomainChange } from "@/lib/domain-changes";
import { MicrosoftGraph, MicrosoftGraphError } from "@/lib/microsoft-graph";
import { runMicrosoftImport } from "@/lib/microsoft-import";
import { processNextInvoiceJob } from "@/lib/invoice-jobs";
import { createInvoiceTemplate, testInvoiceTemplate, publishInvoiceTemplate, applyBillingCalculation } from "@/lib/mcp/lifecycle";
import { persistOriginal, processArchive, retryDocumentArchive, documentFile } from "@/lib/document-archive";
import { previewBillingPeriod, renewBillingApproval, issueBillingPreview, previewStatementSend, sendStatementPreview, validateBillingPeriod } from "@/lib/billing-workflow";
import { processNextBackgroundJob, scheduleBackgroundJobs } from "@/lib/background-jobs";
import { buildTenantStatement } from "@/lib/billing-statement";
import { configuredAllocation } from "@/lib/configured-allocation";
import { documentDownload, downloadedDocument } from "@/lib/document-download";
import { intakeDocument } from "@/lib/document-intake";
import { DOCX_MIME } from "@/lib/document-types";
import { buildEnergyPreview } from "@/lib/energy-preview";
import type { OcrDocument, TemplateRules } from "@/lib/invoice-extraction";

let folder: string;
let fixture: Awaited<ReturnType<typeof createKrandorfFixture>>;
let sourceId: string;
const audit = { userId: "test-user", requestId: "chatgpt-test", reason: "Explicit independent original review" };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const original = Buffer.concat([fixturePng, Buffer.from("original-water-2025")]);
const values: Record<string, string> = { supplier: "Wasserwerk Muster", invoiceNumber: "W-2025-1", invoiceDate: "2025-12-31", servicePeriodStart: "2026-10-01", servicePeriodEnd: "2026-12-31", totalAmountCents: "11900", netAmountCents: "10000", vatAmountCents: "1900", vatRate: "19" };
function ocr(input: Record<string, string>): OcrDocument {
  const words = Object.entries(input).map(([key, value], index) => ({ text: key.toLowerCase().includes("date") || key.startsWith("servicePeriod") ? value.split("-").reverse().join(".") : key.endsWith("Cents") ? `${(BigInt(value) / 100n).toString()},${(BigInt(value) % 100n).toString().padStart(2, "0")}` : value, confidence: 0.99, region: { x: 0.1, y: index * 0.08, width: 0.8, height: 0.04 } }));
  return { text: words.map((w) => w.text).join("\n"), pages: [{ page: 1, words }] };
}
const rules: TemplateRules = { fields: Object.keys(values).map((field, index) => ({ field, page: 1, region: { x: 0, y: index * 0.08, width: 1, height: 0.06 }, format: field.endsWith("Cents") ? "CENTS" : field === "vatRate" ? "PERCENT" : field.toLowerCase().includes("date") || field.startsWith("servicePeriod") ? "DATE" : "TEXT", required: true })) };
class Cloud extends MicrosoftGraph {
  files = new Map<string, { path: string; bytes: Buffer }>();
  sends = 0;
  failUpload = false;
  ambiguous = false;
  sent = false;
  async request(endpoint: string) {
    if (endpoint.includes("/delta")) return { value: [{ id: "water-item", name: "water.png", file: { mimeType: "image/png" }, eTag: "v1" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive/items/inbox/delta?token=1" };
    if (endpoint.endsWith("/send")) { this.sends++; if (this.ambiguous) throw new MicrosoftGraphError(503); this.sent = true; return {}; }
    if (endpoint.includes("/messages/")) return { id: "draft", isDraft: !this.sent };
    return { id: "root", name: "VermieterMe", folder: {} };
  }
  async download(_drive: string, id: string) { return id === "water-item" ? original : this.files.get(id)!.bytes; }
  async uploadImmutable(_drive: string, _root: string, relative: string, bytes: Buffer) {
    if (this.failUpload) throw new MicrosoftGraphError(403);
    const found = [...this.files.entries()].find(([, file]) => file.path === relative);
    if (found) { if (hash(found[1].bytes) !== hash(bytes)) throw new Error("immutable conflict"); return found[0]; }
    const id = `cloud-${this.files.size}`; this.files.set(id, { path: relative, bytes: Buffer.from(bytes) }); return id;
  }
  async moveImmutable(_drive: string, _root: string, id: string, relative: string, expected: string) {
    if (this.failUpload) throw new MicrosoftGraphError(403);
    const file = this.files.get(id)!; expect(hash(file.bytes)).toBe(expected);
    const occupied = [...this.files.entries()].find(([other, file]) => other !== id && file.path === relative);
    if (occupied) throw new Error("immutable conflict");
    file.path = relative; return id;
  }
  async createMailDraft() { return "draft"; }
}
const cloud = new Cloud();
async function drain() { for (let count = 0; count < 50 && await processNextBackgroundJob(cloud); count++) { /* persistent worker */ } }
beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "vermieterme-chatgpt-"));
  process.env.UPLOAD_DIR = path.join(folder, "uploads");
  const url = `file:${path.join(folder, "test.db")}`; await writeFile(path.join(folder, "test.db"), "");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  state.db = new PrismaClient({ datasources: { db: { url } } });
  fixture = await createKrandorfFixture(state.db, "chatgpt");
  await state.db.cost.updateMany({ where: { billingPeriodId: fixture.period.id, costCategoryId: { not: fixture.categories.WATER } }, data: { enabled: false } });
  await state.db.documentStorage.create({ data: { propertyId: fixture.property.id, driveId: "drive", rootItemId: "root", objectFolder: "Krandorf", enabled: true } });
  const source = await state.db.microsoftImportSource.create({ data: { propertyId: fixture.property.id, kind: "ONEDRIVE", driveId: "drive", folderId: "inbox", costCategoryId: fixture.categories.WATER, section: "WASSER", enabled: true, autoBook: true, createdBy: audit.userId } }); sourceId = source.id;
}, 60_000);
afterAll(async () => { await state.db?.$disconnect(); delete process.env.UPLOAD_DIR; if (folder) await rm(folder, { recursive: true, force: true }); });

it("requires independent labels, two examples and a held-out original before automatic publication", async () => {
  const template = await createInvoiceTemplate({ costCategoryId: fixture.categories.WATER, section: "WASSER", supplier: values.supplier, name: "Testlayout", rules, markers: ["Wasserwerk Muster"] }, audit) as { id: string };
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const expected = { ...values, invoiceNumber: `EXAMPLE-${i}` };
    const doc = await persistOriginal(Buffer.concat([fixturePng, Buffer.from(`independent-${i}`)]), "image/png", `sample-${i}.png`, fixture.property.id);
    const invoice = await state.db.costInvoice.create({ data: { propertyId: fixture.property.id, costCategoryId: fixture.categories.WATER, section: "WASSER", totalAmountCents: 0n, status: "DISCARDED" } });
    await state.db.invoiceExtractionJob.create({ data: { documentId: doc.id, invoiceId: invoice.id, ocrJson: JSON.stringify(ocr(expected)), status: "REVIEW_REQUIRED" } });
    samples.push({ documentId: doc.id });
    await expect(testInvoiceTemplate(template.id, samples, audit)).rejects.toThrow("Independently confirmed");
    const preview = await previewDomainChange("confirm_invoice_sample", { documentId: doc.id, expected, role: i === 2 ? "HOLDOUT" : "TRAINING" }, audit);
    expect(await state.db.invoiceVerifiedSample.count({ where: { documentId: doc.id } })).toBe(0);
    await commitDomainChange(preview.previewId, true, audit);
  }
  expect(await testInvoiceTemplate(template.id, samples.slice(0, 2), audit)).toMatchObject({ passed: false });
  await expect(publishInvoiceTemplate(template.id, audit)).rejects.toThrow();
  expect(await testInvoiceTemplate(template.id, samples, audit)).toMatchObject({ passed: true, published: true });
});

it("imports, OCR-books once, uses invoice year and freezes two archived PDFs plus an immutable correction", async () => {
  await runMicrosoftImport(sourceId, cloud); await runMicrosoftImport(sourceId, cloud);
  expect(await state.db.importedSourceItem.count()).toBe(1);
  const imported = await state.db.importedSourceItem.findFirstOrThrow();
  await state.db.invoiceExtractionJob.updateMany({ where: { invoiceId: imported.invoiceId! }, data: { ocrJson: JSON.stringify(ocr(values)) } });
  expect(await processNextInvoiceJob()).toBe(true); await processNextInvoiceJob();
  expect((await state.db.costInvoice.findUniqueOrThrow({ where: { id: imported.invoiceId! } })).status).toBe("CONFIRMED");
  await drain();
  const invoiceArchive = await state.db.documentArchive.findUniqueOrThrow({ where: { documentId: imported.documentId } });
  expect(invoiceArchive.relativePath).toContain("/2025/Rechnungen/Wasser/");
  expect(cloud.files.get(invoiceArchive.itemId!)!.bytes).toEqual(original);
  const financial = await state.db.leaseFinancialPeriod.findFirstOrThrow({ where: { tenantId: fixture.tenants[0].id } });
  const proposed = await previewDomainChange("revise_financial_period", { id: financial.id, sourceDocumentId: fixture.document.id, monthlyColdRentCents: "28800", monthlyGeneralOperatingAndHeatingPrepaymentCents: "18700", monthlyElectricityPrepaymentCents: "4100", monthlyFlatRateCents: "0" }, audit);
  await expect(commitDomainChange(proposed.previewId, false, audit)).rejects.toThrow("Bestätigung");
  const saved = await commitDomainChange(proposed.previewId, true, audit);
  expect(await commitDomainChange(proposed.previewId, true, audit)).toEqual(saved);
  await applyBillingCalculation(fixture.period.id, "MANUAL", fixture.categories.WATER, undefined, audit);
  const statement = await buildTenantStatement(fixture.period.id, fixture.tenants[0].id, { draft: true });
  expect(statement.totalPrepaymentCents).toBe("68400"); // 3 * (187 + 41), once.
  expect(await validateBillingPeriod(fixture.period.id)).toMatchObject({ ready: true });
  const preview = await previewBillingPeriod(fixture.period.id, audit); expect(preview.documents).toHaveLength(2);
  await expect(issueBillingPreview(preview.previewId!, true, audit)).rejects.toThrow("archiviert");
  await drain();
  expect(await issueBillingPreview(preview.previewId!, true, audit)).toMatchObject({ status: "ARCHIVING" });
  cloud.failUpload = true; await drain();
  expect(await state.db.statementRevision.count()).toBe(0);
  cloud.failUpload = false;
  for (const document of preview.documents) await retryDocumentArchive(document.documentId);
  await drain();
  await state.db.domainChangePreview.update({ where: { id: preview.previewId! }, data: { expiresAt: new Date(0) } });
  await expect(issueBillingPreview(preview.previewId!, true, audit)).rejects.toThrow("abgelaufen");
  const renewed = await renewBillingApproval(preview.previewId!, audit);
  expect(renewed.previewId).not.toBe(preview.previewId);
  const released = await issueBillingPreview(renewed.previewId, true, audit);
  expect(await issueBillingPreview(renewed.previewId, true, audit)).toEqual(released);
  const r001 = await state.db.statementArtifact.findMany({ where: { status: "ISSUED" } });
  const originals = await Promise.all(r001.map(async (a) => { const doc = await state.db.document.findUniqueOrThrow({ where: { id: a.documentId } }); return readFile(documentFile(doc.fileName)); }));
  expect(originals.every((bytes) => bytes.subarray(0, 4).toString() === "%PDF")).toBe(true);
  const correction = await previewDomainChange("revise_billing_period", { billingPeriodId: fixture.period.id }, audit);
  const newPeriod = await commitDomainChange(correction.previewId, true, audit) as { id: string };
  await applyBillingCalculation(newPeriod.id, "MANUAL", fixture.categories.WATER, undefined, audit);
  const newPreview = await previewBillingPeriod(newPeriod.id, audit); await drain();
  await issueBillingPreview(newPreview.previewId!, true, audit); await drain(); await issueBillingPreview(newPreview.previewId!, true, audit);
  expect(await state.db.statementRevision.count({ where: { revision: 2 } })).toBe(2);
  for (const [index, artifact] of r001.entries()) {
    const doc = await state.db.document.findUniqueOrThrow({ where: { id: artifact.documentId } });
    expect(await readFile(documentFile(doc.fileName))).toEqual(originals[index]);
    expect((await state.db.documentArchive.findUniqueOrThrow({ where: { documentId: doc.id } })).relativePath).toContain("R001.pdf");
  }
  const link = await documentDownload(r001[0].documentId);
  expect(link.file_name).toContain("R001.pdf");
  expect((await downloadedDocument(new URL(link.download_url).searchParams.get("token")!)).bytes).toEqual(originals[0]);
  await expect(downloadedDocument(new URL(link.download_url).searchParams.get("token")! + "tampered")).rejects.toThrow();
}, 60_000);

it("does not resend an ambiguous Microsoft response and rejects duplicate recipient approvals", async () => {
  const artifact = await state.db.statementArtifact.findFirstOrThrow({ where: { status: "ISSUED", revision: 2 } });
  const preview = await previewStatementSend({ artifactId: artifact.id, mailbox: "sender@example.test", recipient: "explicit-test@example.test", subject: "Reviewed test", bodyText: "Reviewed message" }, audit);
  await expect(sendStatementPreview(preview.previewId, false, audit)).rejects.toThrow();
  const dispatch = await sendStatementPreview(preview.previewId, true, audit);
  expect((await sendStatementPreview(preview.previewId, true, audit)).id).toBe(dispatch.id);
  cloud.ambiguous = true; await drain(); expect(cloud.sends).toBe(1);
  const job = await state.db.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `send:${dispatch.id}` } });
  await state.db.backgroundJob.update({ where: { id: job.id }, data: { status: "QUEUED", availableAt: new Date() } });
  await drain(); expect(cloud.sends).toBe(1);
  expect((await state.db.statementDispatch.findUniqueOrThrow({ where: { id: dispatch.id } })).status).toBe("UNCERTAIN");
  cloud.sent = true;
  await state.db.backgroundJob.update({ where: { id: job.id }, data: { status: "QUEUED", availableAt: new Date() } });
  await drain(); expect(cloud.sends).toBe(1);
  expect((await state.db.statementDispatch.findUniqueOrThrow({ where: { id: dispatch.id } })).status).toBe("ACCEPTED");
  await expect(previewStatementSend({ artifactId: artifact.id, mailbox: "sender@example.test", recipient: "explicit-test@example.test", subject: "Again", bodyText: "Again" }, audit)).rejects.toThrow("bereits");
});

it("rejects stale previews and unknown historical areas, preserving independent originals", async () => {
  const preview = await previewDomainChange("update_property", { id: fixture.property.id, street: "Reviewed", zip: "92431", city: "Neunburg" }, audit);
  await state.db.property.update({ where: { id: fixture.property.id }, data: { street: "Concurrent change" } });
  await expect(commitDomainChange(preview.previewId, true, audit)).rejects.toThrow("verändert");
  const same = await persistOriginal(original, "image/png", "duplicate.png", fixture.property.id);
  expect(await state.db.document.count({ where: { fileHash: same.fileHash } })).toBe(1);
  await state.db.unitStatePeriod.create({ data: { unitId: fixture.units[0].id, validFrom: new Date("2026-11-01"), areaM2: "80", ownerOccupied: false, sourceDocumentId: fixture.document.id } });
  const units = await state.db.unit.findMany({ where: { propertyId: fixture.property.id }, include: { tenants: true } });
  await expect(configuredAllocation({ propertyId: fixture.property.id, categoryId: fixture.categories.WATER, units, start: fixture.period.startDate, end: fixture.period.endDate, amountCents: 39000n, sourceType: "TEST" })).rejects.toThrow("Historischer Wohnungszustand");
});

it("recovers expired persistent leases and reports permission/delta faults without duplicate imports", async () => {
  await state.db.backgroundJob.create({ data: { kind: "MICROSOFT_IMPORT", dedupeKey: "expired-import", payloadJson: JSON.stringify({ sourceId }), status: "PROCESSING", leaseToken: "old", leaseUntil: new Date(0) } });
  await drain(); expect(await state.db.importedSourceItem.count()).toBe(1);
  const fault = new class extends MicrosoftGraph { async request(): Promise<Record<string, unknown>> { throw new MicrosoftGraphError(410); } }();
  await state.db.backgroundJob.create({ data: { kind: "MICROSOFT_IMPORT", dedupeKey: "delta-reset", payloadJson: JSON.stringify({ sourceId }) } });
  await processNextBackgroundJob(fault);
  expect((await state.db.microsoftImportSource.findUniqueOrThrow({ where: { id: sourceId } })).cursor).toBeNull();
  await scheduleBackgroundJobs();
  expect(await state.db.backgroundJob.count({ where: { kind: "BILLING_NOTICES" } })).toBeGreaterThan(0);
  // Direct upload verification is also callable without a worker claim.
  const archive = await state.db.documentArchive.findFirstOrThrow(); await processArchive(archive.id, cloud);
});


it("requires a confirmed tenant-boundary heat reading and distributes heat by measured use", async () => {
  const property = await state.db.property.create({ data: { street: "Heat test", zip: "92431", city: "Test" } });
  const unit = await state.db.unit.create({ data: { propertyId: property.id, name: "One measured unit", floor: "EG", areaM2: "80", shares: 1 } });
  const first = await state.db.tenant.create({ data: { unitId: unit.id, salutation: "Frau", firstName: "First", lastName: "Tenant", moveInDate: new Date("2026-10-01"), moveOutDate: new Date("2026-11-15") } });
  const second = await state.db.tenant.create({ data: { unitId: unit.id, salutation: "Herr", firstName: "Second", lastName: "Tenant", moveInDate: new Date("2026-11-16") } });
  const system = await state.db.heatingSystem.create({ data: { propertyId: property.id, name: "Standard measured heat", consumptionSource: "HEAT_METERS", billingRegime: "STANDARD_HEIZKOSTENV" } });
  const meter = await state.db.heatMeter.create({ data: { heatingSystemId: system.id, unitId: unit.id, meterNumber: "HEAT-1", validFrom: new Date("2026-10-01") } });
  await state.db.propertyCostAllocationRule.create({ data: { propertyId: property.id, costCategoryId: fixture.categories.HEATING, validFrom: new Date("2026-10-01"), allocationMethod: "HEIZKOSTENV", consumptionSharePercent: 60, sourceDocumentId: fixture.document.id, units: { create: { unitId: unit.id, included: true } } } });
  for (const [readingDate, readingValue] of [["2026-10-01", "0"], ["2027-01-01", "100"]]) await state.db.heatMeterReading.create({ data: { meterId: meter.id, readingDate: new Date(readingDate), readingValue, confirmed: true, sourceDocumentId: fixture.document.id } });
  const units = await state.db.unit.findMany({ where: { propertyId: property.id }, include: { tenants: true } });
  const calculate = () => configuredAllocation({ propertyId: property.id, categoryId: fixture.categories.HEATING, units, start: new Date("2026-10-01"), end: new Date("2026-12-31"), amountCents: 10000n, sourceType: "MEASURED_HEAT" });
  await expect(calculate()).rejects.toThrow("Grenzablesungen");
  const boundary = await state.db.heatMeterReading.create({ data: { meterId: meter.id, readingDate: new Date("2026-11-16"), readingValue: "90", confirmed: false, sourceDocumentId: fixture.document.id } });
  await expect(calculate()).rejects.toThrow("Grenzablesungen");
  await state.db.heatMeterReading.update({ where: { id: boundary.id }, data: { confirmed: true } });
  const result = await calculate();
  expect(result.tenantAmountCents).toBe(10000n);
  expect(result.allocations.filter((row) => row.tenantId === first.id).reduce((sum, row) => sum + BigInt(row.amountCents), 0n)).toBe(7400n);
  expect(result.allocations.filter((row) => row.tenantId === second.id).reduce((sum, row) => sum + BigInt(row.amountCents), 0n)).toBe(2600n);
});


it("imports paginated mailbox attachments once and excludes own billing exports", async () => {
  const source = await state.db.microsoftImportSource.create({ data: { propertyId: fixture.property.id, kind: "MAIL", mailbox: "selected@example.test", folderId: "selected-folder", costCategoryId: fixture.categories.WATER, section: "WASSER", enabled: true, createdBy: audit.userId } });
  const contents = Buffer.concat([fixturePng, Buffer.from("separate-mail-original")]);
  const mail = new class extends MicrosoftGraph {
    async request(endpoint: string) {
      if (endpoint.includes("messages/delta")) return { value: [{ id: "immutable-message" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/mail/messages/delta" };
      if (endpoint.includes("mail/messages/delta")) return { value: [{ id: "immutable-message" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/mail/messages/delta" };
      if (endpoint.includes("page=2")) return { value: [{ id: "duplicate-copy", name: "ordinary__invoice.png", contentType: "image/png", contentBytes: contents.toString("base64") }] };
      return { value: [{ id: "original", name: "original.png", contentType: "image/png", contentBytes: contents.toString("base64") }, { id: "own-export", name: "NKA_2026_R001.pdf", contentType: "application/pdf", contentBytes: contents.toString("base64") }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/attachments?page=2" };
    }
  }();
  await runMicrosoftImport(source.id, mail);
  await runMicrosoftImport(source.id, mail);
  const imported = await state.db.importedSourceItem.findMany({ where: { sourceId: source.id } });
  expect(imported).toHaveLength(2);
  expect(new Set(imported.map((item) => item.documentId)).size).toBe(1);
  expect(new Set(imported.map((item) => item.invoiceId)).size).toBe(1);
  expect(await state.db.invoiceExtractionJob.count({ where: { invoiceId: imported[0].invoiceId! } })).toBe(1);
  expect(await state.db.document.count({ where: { originalName: "NKA_2026_R001.pdf" } })).toBe(0);
});

it("retains and deduplicates DOCX contract originals, archives their exact bytes and links dated financial evidence", async () => {
  const bytes = Buffer.from("PK\u0003\u0004opaque-contract-original");
  const invoicesBefore = await state.db.costInvoice.count();
  const document = await intakeDocument(bytes, DOCX_MIME, "Latest contract.docx", { propertyId: fixture.property.id, tenantId: fixture.tenants[0].id, category: "contract" }, audit);
  const duplicate = await intakeDocument(bytes, DOCX_MIME, "Renamed copy.docx", { propertyId: fixture.property.id, category: "contract" }, audit);
  expect(duplicate.id).toBe(document.id);
  expect(document.originalName).toBe("Latest contract.docx");
  expect(document.fileName).toMatch(/\.docx$/);
  expect(document.fileHash).toBe(hash(bytes));
  expect(await readFile(documentFile(document.fileName))).toEqual(bytes);
  expect(await state.db.costInvoice.count()).toBe(invoicesBefore);
  const archive = await state.db.documentArchive.findUniqueOrThrow({ where: { documentId: document.id } });
  expect(archive.relativePath).toContain("/Vertraege_und_Stammdaten/");
  const cloud = new Cloud();
  await processArchive(archive.id, cloud);
  expect(cloud.files.values().next().value!.bytes).toEqual(bytes);
  const preview = await previewDomainChange("set_financial_period", { tenantId: fixture.tenants[0].id, validFrom: "2027-01-01", sourceDocumentId: document.id, monthlyColdRentCents: "28800", monthlyGeneralOperatingAndHeatingPrepaymentCents: "17500", monthlyElectricityPrepaymentCents: "4100" }, audit);
  expect(preview.financialImpact).toMatchObject({ newMonthlyTotalCents: "50400" });
  const committed = await commitDomainChange(preview.previewId, true, audit);
  expect(await commitDomainChange(preview.previewId, true, audit)).toEqual(committed);
  expect(await state.db.leaseFinancialPeriod.count({ where: { sourceDocumentId: document.id } })).toBe(1);
});
it("rejects DOCX invoice imports before persisting or queuing an original", async () => {
  const before = await state.db.document.count();
  await expect(intakeDocument(Buffer.from("PK\u0003\u0004unreviewed-invoice"), DOCX_MIME, "invoice.docx", { propertyId: fixture.property.id }, audit)).rejects.toThrow("Unsupported");
  await expect(intakeDocument(Buffer.from("PK\u0003\u0004unreviewed-invoice"), DOCX_MIME, "invoice.docx", { propertyId: fixture.property.id, category: "contract", costInvoiceId: "any-invoice" }, audit)).rejects.toThrow("cannot be imported as an invoice");
  expect(await state.db.document.count()).toBe(before);
});
it("uses dated contract-backed consumption rules for electricity base prices and blocks missing meter evidence", async () => {
  const f = await createKrandorfFixture(state.db, "contract-base-consumption");
  await state.db.electricityContract.update({ where: { id: f.contract.id }, data: { basePriceAgreementNote: null } });
  const rule = await state.db.propertyCostAllocationRule.findFirstOrThrow({ where: { propertyId: f.property.id, costCategoryId: f.categories.ELECTRICITY, purpose: "BASE" } });
  await state.db.propertyCostAllocationRule.update({ where: { id: rule.id }, data: { allocationMethod: "DIRECT_CONSUMPTION" } });
  await state.db.propertyCostAllocationRuleUnit.updateMany({ where: { ruleId: rule.id, unitId: f.units[2].id }, data: { included: false } });
  const preview = await buildEnergyPreview("ELECTRICITY", f.period.id, f.categories.ELECTRICITY);
  expect(preview.blockers).toEqual([]);
  const base = preview.allocations.filter((a) => (a as { allocationRuleId?: string }).allocationRuleId === rule.id);
  expect(base.filter((a) => a.tenantId === f.tenants[0].id).reduce((sum,a) => sum + BigInt(a.amountCents),0n)).toBe(1000n);
  expect(base.filter((a) => a.tenantId === f.tenants[1].id).reduce((sum,a) => sum + BigInt(a.amountCents),0n)).toBe(2000n);
  const meter = await state.db.electricityMeter.findFirstOrThrow({ where: { contractId: f.contract.id, unitId: f.units[0].id } });
  await state.db.electricityReading.deleteMany({ where: { meterId: meter.id, readingDate: f.period.endDate } });
  const missing = await buildEnergyPreview("ELECTRICITY", f.period.id, f.categories.ELECTRICITY);
  expect(missing.blockers.join(" ")).toMatch(/Ablesung|Messwert|Zählerstand/);
  expect(missing.allocations.filter((a) => (a as { allocationRuleId?: string }).allocationRuleId === rule.id)).toEqual([]);
});
