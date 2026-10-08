import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import path from "path";
import { mkdir, unlink, writeFile } from "fs/promises";
import { prisma } from "@/lib/prisma";
import { buildEnergyPreview } from "@/lib/energy-preview";
import { serializeExact } from "@/lib/billing-v2";
import { assertDraftPeriod } from "@/lib/billing-freshness";
import { invalidateProperty } from "@/lib/billing-freshness";
import { categoryCode, INVOICE_SECTIONS, LINE_CLASSES } from "@/lib/invoice-categories";
import { extractInvoice, templateMatches, validateRules, type OcrDocument, type TemplateRules } from "@/lib/invoice-extraction";
import { templateHash } from "@/lib/invoice-template-hash";
import { generateAccessCode } from "@/lib/token";
import { recordLifecycleAudit, sanitizeRecord } from "./entities";

type AuditContext = { userId: string; requestId: string; reason: string };

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function templateInput(values: Record<string, unknown>) {
  const rules = values.rules;
  const markers = values.markers;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error("Template rules are required");
  try { validateRules(rules as TemplateRules); } catch (error) { throw new Error(error instanceof Error ? error.message : "Invalid template rules"); }
  if ((rules as Record<string, unknown>).table && !LINE_CLASSES.includes(String(((rules as Record<string, unknown>).table as Record<string, unknown>).classification))) throw new Error("Invalid table classification");
  if (!Array.isArray(markers) || !markers.length || markers.length > 12 || markers.some((marker) => typeof marker !== "string" || !marker.trim() || marker.length > 200)) throw new Error("Provide one to twelve non-empty recognition markers");
  return { rules, markers: markers as string[], name: requiredText(values.name, "Template name"), supplier: requiredText(values.supplier, "Supplier") };
}

export async function createInvoiceDraft(values: Record<string, unknown>, context: AuditContext) {
  const billingPeriodId = requiredText(values.billingPeriodId, "billingPeriodId");
  const costCategoryId = requiredText(values.costCategoryId, "costCategoryId");
  const period = await assertDraftPeriod(billingPeriodId);
  const category = await prisma.costCategory.findUnique({ where: { id: costCategoryId } });
  if (!category) throw new Error("Cost category not found");
  const sections = INVOICE_SECTIONS[categoryCode(category)] ?? ["OPERATING"];
  const section = values.section ? String(values.section) : sections[0];
  if (!sections.includes(section)) throw new Error("Invalid invoice section");
  let revisionOfId: string | null = null;
  let revisionData = {};
  if (values.revisionOfId) {
    const old = await prisma.costInvoice.findUnique({ where: { id: String(values.revisionOfId) }, include: { attachments: true } });
    if (!old || old.propertyId !== period.propertyId || old.costCategoryId !== costCategoryId || old.section !== section || old.status !== "CONFIRMED") throw new Error("Invalid invoice revision");
    revisionOfId = old.id;
    revisionData = { dataJson: old.dataJson, totalAmountCents: old.totalAmountCents, attachments: { create: old.attachments.map((attachment) => ({ documentId: attachment.documentId })) } };
  }
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.costInvoice.create({ data: { billingPeriodId, propertyId: period.propertyId, costCategoryId, section, totalAmountCents: 0n, dataJson: "{}", status: "DRAFT", revisionOfId, ...revisionData }, include: { lines: true } });
    await recordLifecycleAudit({ ...context, action: "CREATE_DRAFT", entityType: "CostInvoice", itemRef: row.id, after: row }, tx);
    return row;
  });
  await invalidateProperty(period.propertyId);
  return sanitizeRecord(created);
}

export async function updateInvoiceDraft(id: string, values: Record<string, unknown>, context: AuditContext) {
  const before = await prisma.costInvoice.findUnique({ where: { id } });
  if (!before) throw new Error("Invoice not found");
  await assertDraftPeriod(before.billingPeriodId);
  if (before.status !== "DRAFT") throw new Error("Confirmed invoices are immutable; create a revision");
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.costInvoice.update({ where: { id }, data: { dataJson: JSON.stringify(values.values ?? {}), note: values.note === undefined ? undefined : String(values.note) } });
    await recordLifecycleAudit({ ...context, action: "UPDATE_DRAFT", entityType: "CostInvoice", itemRef: id, before, after: updated }, tx);
    return updated;
  });
  await invalidateProperty(before.propertyId);
  return sanitizeRecord(row);
}

export async function confirmInvoiceDraft(id: string, values: Record<string, unknown>, context: AuditContext) {
  const before = await prisma.costInvoice.findUnique({ where: { id } });
  if (!before) throw new Error("Invoice not found");
  const { confirmInvoice } = await import("@/lib/invoice-service");
  const row = await confirmInvoice(id, values, context.userId);
  await recordLifecycleAudit({ ...context, action: "CONFIRM", entityType: "CostInvoice", itemRef: id, before, after: row });
  await invalidateProperty(before.propertyId);
  return sanitizeRecord(row);
}

export async function discardInvoiceDraft(id: string, context: AuditContext) {
  const before = await prisma.costInvoice.findUnique({ where: { id } });
  if (!before) throw new Error("Invoice not found");
  await assertDraftPeriod(before.billingPeriodId);
  if (before.status !== "DRAFT") throw new Error("Confirmed invoices can only be corrected by a revision");
  await prisma.$transaction(async (tx) => {
    const after = await tx.costInvoice.update({ where: { id }, data: { status: "DISCARDED" } });
    await recordLifecycleAudit({ ...context, action: "DISCARD", entityType: "CostInvoice", itemRef: id, before, after }, tx);
  });
  await invalidateProperty(before.propertyId);
  return { deleted: true };
}

export async function queueInvoiceExtraction(id: string, values: Record<string, unknown>, context: AuditContext) {
  const invoice = await prisma.costInvoice.findUnique({ where: { id }, include: { attachments: true } });
  if (!invoice) throw new Error("Invoice not found");
  await assertDraftPeriod(invoice.billingPeriodId);
  if (invoice.status !== "DRAFT") throw new Error("A confirmed invoice cannot be extracted again");
  const documentId = values.documentId ? String(values.documentId) : invoice.attachments[0]?.documentId || invoice.documentId;
  if (!documentId || (!invoice.attachments.some((a) => a.documentId === documentId) && invoice.documentId !== documentId)) throw new Error("Document does not belong to this invoice");
  const existing = await prisma.invoiceExtractionJob.findFirst({ where: { invoiceId: id, documentId, status: { in: ["QUEUED", "PROCESSING"] } } });
  if (existing) return sanitizeRecord(existing);
  const templateId = values.templateId ? String(values.templateId) : null;
  if (templateId) {
    const template = await prisma.invoiceTemplate.findUnique({ where: { id: templateId } });
    if (!template || template.status !== "PUBLISHED" || template.costCategoryId !== invoice.costCategoryId || template.section !== invoice.section) throw new Error("Template does not match the invoice");
  }
  const previous = await prisma.invoiceExtractionJob.findFirst({ where: { invoiceId: id, documentId, ocrJson: { not: null } }, orderBy: { createdAt: "desc" } });
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.invoiceExtractionJob.create({ data: { invoiceId: id, documentId, templateId, ocrJson: previous?.ocrJson ?? null } });
    await recordLifecycleAudit({ ...context, action: "QUEUE_EXTRACTION", entityType: "InvoiceExtractionJob", itemRef: row.id, after: row }, tx);
    return row;
  });
  return sanitizeRecord(created);
}

export async function createInvoiceTemplate(values: Record<string, unknown>, context: AuditContext) {
  const costCategoryId = requiredText(values.costCategoryId, "costCategoryId");
  const category = await prisma.costCategory.findUnique({ where: { id: costCategoryId } });
  if (!category) throw new Error("Cost category not found");
  const section = requiredText(values.section, "section");
  if (!(INVOICE_SECTIONS[categoryCode(category)] ?? []).includes(section)) throw new Error("Invalid template section");
  const input = templateInput(values);
  let seriesId: string = randomUUID(); let version = 1;
  if (values.revisionOfId) {
    const previous = await prisma.invoiceTemplate.findUnique({ where: { id: String(values.revisionOfId) } });
    if (!previous || previous.costCategoryId !== costCategoryId || previous.section !== section) throw new Error("Template revision does not match");
    seriesId = previous.seriesId;
    const latest = await prisma.invoiceTemplate.findFirst({ where: { seriesId }, orderBy: { version: "desc" } });
    version = (latest?.version ?? 0) + 1;
  }
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.invoiceTemplate.create({ data: { seriesId, version, costCategoryId, section, name: input.name, supplier: input.supplier, rulesJson: JSON.stringify(input.rules), markersJson: JSON.stringify(input.markers), createdBy: context.userId } });
    await recordLifecycleAudit({ ...context, action: "CREATE", entityType: "InvoiceTemplate", itemRef: created.id, after: created }, tx);
    return created;
  });
  return sanitizeRecord(row);
}

export async function updateInvoiceTemplate(id: string, values: Record<string, unknown>, context: AuditContext) {
  const before = await prisma.invoiceTemplate.findUnique({ where: { id } });
  if (!before) throw new Error("Template not found");
  if (before.status !== "DRAFT") throw new Error("Published templates are immutable; create a revision");
  const input = templateInput(values);
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.invoiceTemplate.update({ where: { id }, data: { name: input.name, supplier: input.supplier, rulesJson: JSON.stringify(input.rules), markersJson: JSON.stringify(input.markers), testedHash: null, testResultsJson: null } });
    await recordLifecycleAudit({ ...context, action: "UPDATE", entityType: "InvoiceTemplate", itemRef: id, before, after: updated }, tx);
    return updated;
  });
  return sanitizeRecord(row);
}

export async function testInvoiceTemplate(id: string, samples: unknown, context: AuditContext) {
  const template = await prisma.invoiceTemplate.findUnique({ where: { id } });
  if (!template) throw new Error("Template not found");
  if (template.status !== "DRAFT") throw new Error("Published templates are immutable");
  if (!Array.isArray(samples) || !samples.length || samples.length > 10) throw new Error("Provide one to ten test documents");
  const rules = JSON.parse(template.rulesJson) as TemplateRules;
  const markers = JSON.parse(template.markersJson) as string[];
  const results: Array<Record<string, unknown> & { passed: boolean }> = [];
  for (const sample of samples as Array<{ documentId?: unknown; expected?: Record<string, string>; expectedLines?: unknown[] }>) {
    const documentId = requiredText(sample.documentId, "sample documentId");
    const job = await prisma.invoiceExtractionJob.findFirst({ where: { documentId, ocrJson: { not: null }, invoice: { costCategoryId: template.costCategoryId, section: template.section } }, include: { document: true }, orderBy: { createdAt: "desc" } });
    if (!job?.ocrJson) throw new Error("OCR test document is missing or does not match the template");
    const extracted = extractInvoice(JSON.parse(job.ocrJson) as OcrDocument, rules);
    const mismatches = rules.fields.filter((rule) => rule.required || Object.hasOwn(sample.expected ?? {}, rule.field)).filter((rule) => !sample.expected?.[rule.field] || extracted.fields[rule.field]?.value !== sample.expected[rule.field]).map((rule) => rule.field);
    if (rules.table && (!Array.isArray(sample.expectedLines) || JSON.stringify(sample.expectedLines) !== JSON.stringify(extracted.lines))) mismatches.push("invoice lines");
    results.push({ documentId, fileHash: job.document.fileHash, expected: sample.expected ?? {}, extracted, mismatches, passed: templateMatches(JSON.parse(job.ocrJson) as OcrDocument, markers) && !extracted.errors.length && !mismatches.length });
  }
  const passed = results.every((result) => result.passed);
  await prisma.$transaction(async (tx) => {
    const after = await tx.invoiceTemplate.update({ where: { id }, data: { testedHash: passed ? templateHash(rules, markers) : null, testResultsJson: JSON.stringify(results) } });
    await recordLifecycleAudit({ ...context, action: "TEST", entityType: "InvoiceTemplate", itemRef: id, before: template, after }, tx);
  });
  return sanitizeRecord({ passed, results });
}

export async function publishInvoiceTemplate(id: string, context: AuditContext) {
  const before = await prisma.invoiceTemplate.findUnique({ where: { id } });
  if (!before) throw new Error("Template not found");
  const hash = templateHash(JSON.parse(before.rulesJson), JSON.parse(before.markersJson));
  if (before.status !== "DRAFT" || before.testedHash !== hash) throw new Error("Template must pass expected-value tests before publication");
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.invoiceTemplate.update({ where: { id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    await recordLifecycleAudit({ ...context, action: "PUBLISH", entityType: "InvoiceTemplate", itemRef: id, before, after: updated }, tx);
    return updated;
  });
  return sanitizeRecord(row);
}

export async function reviseFinancialPeriod(id: string, values: Record<string, unknown>, context: AuditContext) {
  const original = await prisma.leaseFinancialPeriod.findUnique({ where: { id }, include: { components: true, flatRateCoverages: true } });
  if (!original) throw new Error("Financial period not found");
  const components = Array.isArray(values.components) ? values.components as Array<Record<string, unknown>> : original.components;
  const normalized = components.map((component) => ({
    costCategoryId: String(component.costCategoryId),
    monthlyAmountCents: BigInt(String(component.monthlyAmountCents)),
  }));
  const prepayment = BigInt(String(values.monthlyPrepaymentCents ?? original.monthlyPrepaymentCents));
  if (normalized.reduce((sum, component) => sum + component.monthlyAmountCents, 0n) !== prepayment) {
    throw new Error("Prepayment components must exactly equal the total monthly prepayment");
  }
  const flatRateCoverages = Array.isArray(values.flatRateCoverages)
    ? values.flatRateCoverages.map((entry) => ({ costCategoryId: String(typeof entry === "string" ? entry : (entry as Record<string, unknown>).costCategoryId) }))
    : original.flatRateCoverages.map((entry) => ({ costCategoryId: entry.costCategoryId }));
  const revised = await prisma.$transaction(async (tx) => {
    await tx.leaseFinancialPeriod.update({ where: { id }, data: { supersededAt: new Date() } });
    const replacement = await tx.leaseFinancialPeriod.create({ data: {
      tenantId: original.tenantId,
      validFrom: values.validFrom ? new Date(String(values.validFrom)) : original.validFrom,
      validTo: values.validTo === null ? null : values.validTo ? new Date(String(values.validTo)) : original.validTo,
      monthlyColdRentCents: BigInt(String(values.monthlyColdRentCents ?? original.monthlyColdRentCents)),
      monthlyPrepaymentCents: prepayment,
      monthlyGeneralOperatingAndHeatingPrepaymentCents: BigInt(String(values.monthlyGeneralOperatingAndHeatingPrepaymentCents ?? original.monthlyGeneralOperatingAndHeatingPrepaymentCents)),
      monthlyFlatRateCents: BigInt(String(values.monthlyFlatRateCents ?? original.monthlyFlatRateCents)),
      reason: values.reason === undefined ? original.reason : String(values.reason || "") || null,
      revisionOfId: original.id, revisionReason: context.reason, createdBy: context.userId,
      components: { create: normalized },
      flatRateCoverages: { create: flatRateCoverages },
    }, include: { components: true, flatRateCoverages: true } });
    await recordLifecycleAudit({ ...context, action: "REVISE", entityType: "LeaseFinancialPeriod", itemRef: replacement.id, before: original, after: replacement }, tx);
    return replacement;
  });
  return sanitizeRecord(revised);
}

export async function applyBillingCalculation(billingPeriodId: string, kind: string, costCategoryId: string, zeroReason: string | undefined, context: AuditContext) {
  const original = await assertDraftPeriod(billingPeriodId);
  const preview = await buildEnergyPreview(kind, billingPeriodId, costCategoryId);
  if (preview.blockers.length) throw new Error(preview.blockers.join(" "));
  if (BigInt(preview.totalAmountCents) === 0n && !zeroReason?.trim()) {
    throw new Error("Null costs must be explicitly confirmed with zero_reason");
  }
  const period = await prisma.billingPeriod.findUnique({ where: { id: billingPeriodId } });
  if (!period) throw new Error("Billing period not found");
  if (period.sentDate || period.paidDate) throw new Error("Sent or paid billing periods cannot be changed");
  const before = await prisma.billingSnapshot.findMany({ where: { billingPeriodId, costCategoryId: preview.costCategoryId } });
  const snapshot = await prisma.$transaction(async (tx) => {
    const current = await tx.billingPeriod.findUnique({ where: { id: billingPeriodId }, include: { statementRevisions: true } });
    if (!current || current.sourceRevision !== original.sourceRevision || current.statementRevisions.length || current.status === "SUPERSEDED" || current.sentDate || current.paidDate) {
      throw new Error("Source data changed after the preview; calculate again");
    }
    const previous = await tx.categoryCalculationHead.findUnique({ where: { billingPeriodId_costCategoryId: { billingPeriodId, costCategoryId: preview.costCategoryId } } });
    const created = await tx.billingSnapshot.create({ data: {
      billingPeriodId, costCategoryId: preview.costCategoryId, kind: preview.kind,
      sourceFingerprint: preview.sourceFingerprint,
      sourceJson: JSON.stringify(serializeExact({ inputs: preview.sourceData, fingerprint: preview.sourceFingerprint, zeroReason: zeroReason || null })),
      revisionOfId: previous?.snapshotId ?? null,
      resultJson: JSON.stringify(serializeExact(preview)), appliedBy: context.userId,
    }});
    await tx.categoryCalculationHead.upsert({
      where: { billingPeriodId_costCategoryId: { billingPeriodId, costCategoryId: preview.costCategoryId } },
      update: { snapshotId: created.id, stale: false },
      create: { billingPeriodId, costCategoryId: preview.costCategoryId, snapshotId: created.id },
    });
    if (preview.allocations.length) await tx.costAllocation.createMany({ data: preview.allocations.map((row) => ({
      billingPeriodId, costCategoryId: preview.costCategoryId, unitId: row.unitId, tenantId: row.tenantId,
      periodStart: new Date(`${row.periodStart}T00:00:00.000Z`), periodEnd: new Date(`${row.periodEnd}T00:00:00.000Z`),
      amountCents: BigInt(row.amountCents), quantity: row.quantity ?? null, distributionKey: row.distributionKey,
      calculationBasis: row.calculationBasis, sourceType: row.sourceType, sourceReferenceId: row.sourceReferenceId ?? null,
      snapshotId: created.id,
    })) });
    await tx.cost.upsert({ where: { billingPeriodId_costCategoryId: { billingPeriodId, costCategoryId: preview.costCategoryId } },
      update: { totalAmountCents: BigInt(preview.totalAmountCents), reviewed: false, enabled: true },
      create: { billingPeriodId, costCategoryId: preview.costCategoryId, totalAmount: 0, totalAmountCents: BigInt(preview.totalAmountCents), reviewed: false },
    });
    if (preview.kind === "HEATING_OIL") {
      if (period.revisionOfPeriodId) await tx.categoryCalculationHead.deleteMany({ where: { billingPeriodId: period.revisionOfPeriodId, costCategoryId: preview.costCategoryId } });
      const rows = serializeExact(preview.details.fifoRows) as Array<{ lotId: string; consumedLiters: string; amountCents: string; co2CostCents: string; co2Grams: string }>;
      if (rows.length) await tx.oilLotConsumption.createMany({ data: rows.map((row) => ({
        lotId: row.lotId, snapshotId: created.id, quantityLiters: row.consumedLiters,
        amountCents: BigInt(row.amountCents), co2CostCents: BigInt(row.co2CostCents), co2Grams: BigInt(row.co2Grams),
      })) });
    }
    await recordLifecycleAudit({ ...context, action: "APPLY_CALCULATION", entityType: "BillingSnapshot", itemRef: created.id, before, after: created }, tx);
    return created;
  });
  return sanitizeRecord(snapshot);
}

export async function supersedeBillingPeriod(id: string, context: AuditContext) {
  const before = await prisma.billingPeriod.findUnique({ where: { id }, include: { statementRevisions: true, costs: true } });
  if (!before) throw new Error("Billing period not found");
  if (!before.statementRevisions.length || before.status === "SUPERSEDED") throw new Error("Only the current issued billing period can be revised");
  const after = await prisma.$transaction(async (tx) => {
    const row = await tx.billingPeriod.create({ data: {
      propertyId: before.propertyId, startDate: before.startDate, endDate: before.endDate,
      copiedFromId: id, revisionOfPeriodId: id, revisionReason: context.reason,
      costs: { create: before.costs.map((cost) => ({ costCategoryId: cost.costCategoryId, totalAmount: 0, totalAmountCents: cost.totalAmountCents, enabled: cost.enabled, reviewed: false, distributionKeyOverride: cost.distributionKeyOverride })) },
    } });
    await tx.billingPeriod.update({ where: { id }, data: { status: "SUPERSEDED" } });
    await recordLifecycleAudit({ ...context, action: "REVISE", entityType: "BillingPeriod", itemRef: row.id, before, after: row }, tx);
    return row;
  });
  return sanitizeRecord(after);
}

export async function correctElectricityReading(id: string, action: "update" | "delete", values: Record<string, unknown>, context: AuditContext) {
  const before = await prisma.electricityReading.findUnique({ where: { id } });
  if (!before) throw new Error("Electricity reading not found");
  const previousJson = JSON.stringify(sanitizeRecord(before));
  if (action === "delete") {
    await prisma.$transaction(async (tx) => {
      await tx.electricityReadingAudit.create({ data: { meterId: before.meterId, action: "DELETE", previousJson, reason: context.reason } });
      await tx.electricityReading.delete({ where: { id } });
      await recordLifecycleAudit({ ...context, action: "AUDITED_DELETE", entityType: "ElectricityReading", itemRef: id, before }, tx);
    });
    return { deleted: true };
  }
  const after = await prisma.$transaction(async (tx) => {
    await tx.electricityReadingAudit.create({ data: { readingId: id, meterId: before.meterId, action: "UPDATE", previousJson, reason: context.reason } });
    const row = await tx.electricityReading.update({ where: { id }, data: {
      readingDate: values.readingDate ? new Date(String(values.readingDate)) : undefined,
      billingEffectiveDate: values.billingEffectiveDate === null ? null : values.billingEffectiveDate ? new Date(String(values.billingEffectiveDate)) : undefined,
      readingKwh: values.readingKwh === undefined ? undefined : String(values.readingKwh),
      reason: values.readingReason === undefined ? undefined : String(values.readingReason),
      note: values.note === undefined ? undefined : String(values.note || "") || null,
    }});
    await recordLifecycleAudit({ ...context, action: "AUDITED_UPDATE", entityType: "ElectricityReading", itemRef: id, before, after: row }, tx);
    return row;
  });
  return sanitizeRecord(after);
}

export async function reviewOilFoxCandidate(id: string, status: "PENDING" | "CONFIRMED" | "IGNORED", note: string | undefined, context: AuditContext) {
  const before = await prisma.oilDeliveryCandidate.findUnique({ where: { id } });
  if (!before) throw new Error("Oil delivery candidate not found");
  const after = await prisma.$transaction(async (tx) => {
    const row = await tx.oilDeliveryCandidate.update({ where: { id }, data: {
      status, note: note === undefined ? undefined : note || null, reviewedAt: new Date(),
    }});
    await recordLifecycleAudit({ ...context, action: "REVIEW", entityType: "OilDeliveryCandidate", itemRef: id, before, after: row }, tx);
    return row;
  });
  return sanitizeRecord(after);
}

export async function manageCredential(kind: "tenant_access" | "session" | "account", action: "rotate" | "revoke", id: string, context: AuditContext) {
  if (kind === "tenant_access") {
    const before = await prisma.tenantAccessToken.findUnique({ where: { tenantId: id } });
    const after = await prisma.$transaction(async (tx) => {
      if (action === "revoke") await tx.tenantAccessToken.deleteMany({ where: { tenantId: id } });
      else {
        const code = generateAccessCode();
        await tx.tenantAccessToken.upsert({ where: { tenantId: id }, update: { token: code }, create: { tenantId: id, token: code } });
      }
      const row = action === "revoke" ? null : await tx.tenantAccessToken.findUnique({ where: { tenantId: id }, select: { id: true, tenantId: true, createdAt: true } });
      await recordLifecycleAudit({ ...context, action: action.toUpperCase(), entityType: "TenantAccessToken", itemRef: id, before, after: row }, tx);
      return row;
    });
    return { success: true, credential: after };
  }
  if (action !== "revoke") throw new Error(`${kind} credentials can only be revoked`);
  if (kind === "session") {
    const before = await prisma.session.findUnique({ where: { id } });
    if (!before) throw new Error("Session not found");
    await prisma.$transaction(async (tx) => {
      await tx.session.delete({ where: { id } });
      await recordLifecycleAudit({ ...context, action: "REVOKE", entityType: "Session", itemRef: id, before }, tx);
    });
  } else {
    const before = await prisma.account.findUnique({ where: { id } });
    if (!before) throw new Error("Account not found");
    await prisma.$transaction(async (tx) => {
      await tx.account.delete({ where: { id } });
      await recordLifecycleAudit({ ...context, action: "REVOKE", entityType: "Account", itemRef: id, before }, tx);
    });
  }
  return { success: true };
}

const ALLOWED_UPLOAD_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
  }
  return true;
}

export async function assertPublicDownloadUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("File download URL must be a public HTTPS URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("File download URL must not resolve to a private network");
  }
  return url;
}

export async function uploadDocument(file: { download_url: string; file_id: string; mime_type?: string; file_name?: string }, metadata: Record<string, unknown>, context: AuditContext) {
  const url = await assertPublicDownloadUrl(file.download_url);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`File download failed (${response.status})`);
  const mimeType = file.mime_type || response.headers.get("content-type")?.split(";")[0] || "";
  if (!ALLOWED_UPLOAD_TYPES.has(mimeType)) throw new Error("Allowed file types: PDF, JPEG, PNG, WebP");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_UPLOAD_BYTES) throw new Error("File exceeds 10 MB");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("File exceeds 10 MB");
  const extByMime: Record<string, string> = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
  const fileName = `${randomUUID()}${extByMime[mimeType]}`;
  const uploadDir = path.join(process.cwd(), "data", "uploads");
  const filePath = path.join(uploadDir, fileName);
  await mkdir(uploadDir, { recursive: true });
  await writeFile(filePath, bytes, { flag: "wx" });
  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.document.create({ data: {
        fileName, originalName: String(file.file_name || `chatgpt-${file.file_id}`).slice(0, 255),
        mimeType, size: bytes.length, category: String(metadata.category || "other"),
        billingPeriodId: metadata.billingPeriodId ? String(metadata.billingPeriodId) : null,
        tenantId: metadata.tenantId ? String(metadata.tenantId) : null,
        heatingOilDelivery: metadata.heatingOilDeliveryId ? { connect: { id: String(metadata.heatingOilDeliveryId) } } : undefined,
        costInvoice: metadata.costInvoiceId ? { connect: { id: String(metadata.costInvoiceId) } } : undefined,
      }});
      await recordLifecycleAudit({ ...context, action: "UPLOAD", entityType: "Document", itemRef: row.id, after: row }, tx);
      return row;
    });
    return sanitizeRecord(created);
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
}
