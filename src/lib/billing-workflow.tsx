import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { prisma } from "@/lib/prisma";
import { buildEnergyPreview } from "@/lib/energy-preview";
import { buildTenantStatement, type TenantStatement } from "@/lib/billing-statement";
import { BillingV2Pdf } from "@/lib/billing-v2-pdf";
import { domainFingerprint, type AuditContext } from "@/lib/domain-changes";
import { recordLifecycleAudit, recordHash } from "@/lib/mcp/entities";
import { persistOriginal, queueDocumentArchive, documentFile, enqueueJob } from "@/lib/document-archive";
import { statementArchivePath } from "@/lib/document-paths";
import { serializeExact } from "@/lib/billing-v2";
import { daysInclusive } from "@/lib/energy-billing";

export async function billingWorkspace(propertyId: string) {
  return serializeExact(await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { units: { include: { tenants: { include: { financialPeriods: { where: { supersededAt: null } }, parties: true } }, statePeriods: true } }, billingPeriods: { where: { status: { not: "SUPERSEDED" } }, include: { costs: { include: { costCategory: true } }, statementRevisions: true } }, costAllocationRules: { where: { supersededAt: null }, include: { units: true } }, storage: true } }));
}

export async function validateBillingPeriod(id: string) {
  const period = await prisma.billingPeriod.findUniqueOrThrow({ where: { id }, include: { property: { include: { units: { include: { tenants: { include: { costCategoryAgreements: true } } } }, storage: true } }, costs: { where: { enabled: true }, include: { costCategory: true } }, calculationHeads: { include: { snapshot: true } }, evidences: true } });
  const blockers: string[] = [];
  const warnings: string[] = [];
  const checks = ["Belege", "Dubletten", "Regeln und Vertragsgrundlagen", "Eigentümer und Leerstand", "Stromdaten", "Heizkosten und CO₂", "Vorauszahlungen", "Centgenauigkeit", "Perioden und Fristen", "PDF und Snapshot"].map((name) => ({ name, passed: true, blockers: [] as string[] }));
  const fail = (index: number, message: string) => { checks[index].passed = false; checks[index].blockers.push(message); blockers.push(message); };
  if (!period.costs.length) fail(0, "Keine aktiven Kostenarten konfiguriert.");
  for (const cost of period.costs) {
    const head = period.calculationHeads.find((head) => head.costCategoryId === cost.costCategoryId);
    if (!head) { fail(7, `${cost.costCategory.name}: Berechnung oder bestätigte Nullkosten fehlen.`); continue; }
    const preview = await buildEnergyPreview(head.snapshot.kind, id, cost.costCategoryId);
    const index = head.snapshot.kind === "HEATING_OIL" ? 5 : head.snapshot.kind === "ELECTRICITY" ? 4 : 2;
    for (const message of preview.blockers) fail(index, message);
    warnings.push(...preview.warnings);
    if (head.stale || preview.sourceFingerprint !== head.snapshot.sourceFingerprint) fail(7, `${cost.costCategory.name}: Berechnung ist veraltet.`);
    if (BigInt(preview.tenantAmountCents) + BigInt(preview.landlordAmountCents) !== BigInt(preview.totalAmountCents)) fail(7, `${cost.costCategory.name}: Anteile stimmen nicht mit Gesamtkosten überein.`);
  }
  const tenants = period.property.units.flatMap((unit) => unit.tenants.filter((tenant) => tenant.moveInDate <= period.endDate && (!tenant.moveOutDate || tenant.moveOutDate >= period.startDate)));
  for (const tenant of tenants) {
    for (const cost of period.costs.filter((cost) => (cost.totalAmountCents ?? 0n) !== 0n)) {
      const start = tenant.moveInDate > period.startDate ? tenant.moveInDate : period.startDate;
      const end = tenant.moveOutDate && tenant.moveOutDate < period.endDate ? tenant.moveOutDate : period.endDate;
      if (!tenant.costCategoryAgreements.some((agreement) => agreement.costCategoryId === cost.costCategoryId && agreement.validFrom <= start && (!agreement.validTo || agreement.validTo >= end))) fail(2, `Vertragsgrundlage für ${tenant.firstName} ${tenant.lastName}, ${cost.costCategory.name} fehlt.`);
    }
    try { await buildTenantStatement(id, tenant.id, { draft: true, forIssue: true }); }
    catch (error) { fail(6, error instanceof Error ? error.message : "Vorauszahlungen unvollständig."); }
  }
  if (!tenants.length) fail(6, "Keine Mietverhältnisse im Abrechnungszeitraum.");
  const unreviewed = await prisma.costInvoice.findMany({ where: { propertyId: period.propertyId, status: "DRAFT", OR: [{ servicePeriodStart: null }, { servicePeriodStart: { lte: period.endDate }, servicePeriodEnd: { gte: period.startDate } }] }, select: { id: true, invoiceNumber: true } });
  for (const invoice of unreviewed) fail(0, `Ungeprufter Beleg ${invoice.invoiceNumber || invoice.id}: Leistungszeitraum und Klassifizierung bestatigen.`);
  const invoices = await prisma.costInvoice.findMany({ where: { propertyId: period.propertyId, status: "CONFIRMED", servicePeriodStart: { lte: period.endDate }, servicePeriodEnd: { gte: period.startDate }, revisions: { none: { status: "CONFIRMED" } } }, include: { attachments: { include: { document: { include: { archive: true } } } }, document: { include: { archive: true } } } });
  for (const invoice of invoices) {
    const documents = [...invoice.attachments.map((attachment) => attachment.document), ...(invoice.document ? [invoice.document] : [])];
    if (!documents.length) fail(0, `Originalbeleg für ${invoice.invoiceNumber || invoice.id} fehlt.`);
    for (const document of documents) {
      if (!document.fileHash) fail(0, "Originalbeleg benötigt eine geprüfte SHA-256-Prüfsumme.");
      if (period.property.storage?.enabled && document.archive?.status !== "VERIFIED") fail(0, `OneDrive-Archivierung für ${document.originalName} unvollständig.`);
    }
  }
  if (!period.property.storage?.enabled) fail(9, "OneDrive-Ablage muss vor endgültiger Freigabe eingerichtet und aktiviert sein.");
  if (daysInclusive(period.startDate, period.endDate) > 366 && !period.evidences.some((row) => row.kind === "HISTORICAL_LEGAL_REVIEW" && row.confirmedAt)) fail(8, "Historische Sonderperiode benötigt eine dokumentierte rechtliche Prüfung.");
  const deadline = new Date(period.endDate); deadline.setUTCFullYear(deadline.getUTCFullYear() + 1); deadline.setUTCHours(23, 59, 59, 999);
  if (new Date() > deadline && !period.evidences.some((row) => row.kind === "LATE_CLAIM_LEGAL_REVIEW" && row.confirmedAt)) fail(8, "Abrechnungsfrist überschritten: Nachforderung vor Freigabe rechtlich prüfen.");
  const overlaps = await prisma.billingPeriod.count({ where: { propertyId: period.propertyId, id: { not: id }, status: { not: "SUPERSEDED" }, startDate: { lte: period.endDate }, endDate: { gte: period.startDate } } });
  if (overlaps) fail(8, "Aktive Abrechnungsperioden überlappen.");
  return { billingPeriodId: id, propertyId: period.propertyId, checks, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], tenants: tenants.map((tenant) => ({ id: tenant.id, name: `${tenant.firstName} ${tenant.lastName}` })), deadline: deadline.toISOString(), ready: !blockers.length };
}

export async function previewBillingPeriod(id: string, context: AuditContext) {
  const validation = await validateBillingPeriod(id);
  if (!validation.ready) return { ...validation, previewId: null, documents: [] };
  if (await prisma.statementArtifact.count({ where: { billingPeriodId: id, status: "PREPARED" } })) throw new Error("Endgültige Fassung bereits in Archivprüfung. Dieselbe Freigabe fortsetzen oder mit renew_billing_approval erneut prüfen.");
  const fingerprint = await domainFingerprint();
  const period = await prisma.billingPeriod.findUniqueOrThrow({ where: { id }, include: { property: { include: { storage: true } } } });
  const storage = period.property.storage!;
  const previewId = randomUUID();
  const documents = [];
  for (const tenant of validation.tenants) {
    const statement = await buildTenantStatement(id, tenant.id, { draft: true, forIssue: true });
    const bytes = await renderToBuffer(<BillingV2Pdf statements={[statement]} reference={previewId} />);
    const relativePath = statementArchivePath({ objectFolder: storage.objectFolder, start: period.startDate, end: period.endDate, tenantName: tenant.name, tenantId: tenant.id, previewId });
    const document = await persistOriginal(bytes, "application/pdf", path.basename(relativePath), period.propertyId, "billing_preview");
    await queueDocumentArchive(document.id, period.propertyId, relativePath);
    const artifact = await prisma.statementArtifact.create({ data: { billingPeriodId: id, tenantId: tenant.id, previewId, fingerprint, statementJson: JSON.stringify(statement), documentId: document.id, createdBy: context.userId } });
    documents.push({ artifactId: artifact.id, documentId: document.id, path: relativePath, tenantId: tenant.id });
  }
  // Artifacts/documents are deliberately outside the input fingerprint.
  const postFingerprint = await domainFingerprint();
  await prisma.domainChangePreview.create({ data: { id: previewId, userId: context.userId, action: "ISSUE_BILLING", payloadJson: JSON.stringify({ billingPeriodId: id, artifactIds: documents.map((d) => d.artifactId) }), fingerprint: postFingerprint, impactJson: JSON.stringify({ validation, documents }), expiresAt: new Date(Date.now() + 30 * 60_000) } });
  return { ...validation, previewId, documents };
}

export async function renewBillingApproval(previewId: string, context: AuditContext) {
  const previous = await prisma.domainChangePreview.findUniqueOrThrow({ where: { id: previewId } });
  if (previous.action !== "ISSUE_BILLING" || previous.userId !== context.userId || previous.consumedAt) throw new Error("Nur eigene offene Freigaben können erneuert werden");
  if (await domainFingerprint() !== previous.fingerprint) throw new Error("Grundlagen verändert; neue fachliche Vorschau erforderlich");
  const { billingPeriodId } = JSON.parse(previous.payloadJson);
  const validation = await validateBillingPeriod(billingPeriodId);
  if (!validation.ready) throw new Error(validation.blockers.join(" "));
  const renewed = await prisma.domainChangePreview.create({ data: { userId: context.userId, action: previous.action, payloadJson: previous.payloadJson, fingerprint: previous.fingerprint, impactJson: previous.impactJson, expiresAt: new Date(Date.now() + 30 * 60_000) } });
  await recordLifecycleAudit({ ...context, action: "RENEW_BILLING_APPROVAL", entityType: "DomainChangePreview", itemRef: renewed.id, before: { previewId }, after: { previewId: renewed.id } });
  return { ...validation, previewId: renewed.id, documents: JSON.parse(previous.impactJson).documents, instruction: "Erneut genau diese unveränderten PDFs prüfen und ausdrücklich bestätigen." };
}

export async function issueBillingPreview(previewId: string, confirmed: boolean, context: AuditContext) {
  if (!confirmed) throw new Error("PDF-Vorschau muss ausdrücklich bestätigt werden");
  const preview = await prisma.domainChangePreview.findUniqueOrThrow({ where: { id: previewId } });
  if (preview.userId !== context.userId || preview.action !== "ISSUE_BILLING") throw new Error("Ungültige Freigabevorschau");
  if (preview.consumedAt) return JSON.parse(preview.resultJson!);
  if (preview.expiresAt <= new Date()) throw new Error("Freigabevorschau abgelaufen");
  const input = JSON.parse(preview.payloadJson) as { billingPeriodId: string; artifactIds: string[] };
  const validation = await validateBillingPeriod(input.billingPeriodId);
  if (!validation.ready) throw new Error(validation.blockers.join(" "));
  const drafts = await prisma.statementArtifact.findMany({ where: { id: { in: input.artifactIds } } });
  if (drafts.length !== input.artifactIds.length || new Set(drafts.map((d) => d.tenantId)).size !== validation.tenants.length || !validation.tenants.every((t) => drafts.some((d) => d.tenantId === t.id))) throw new Error("Vorschau-PDFs unvollstandig");
  for (const draft of drafts) {
    const archive = await prisma.documentArchive.findUnique({ where: { documentId: draft.documentId } });
    if (archive?.status !== "VERIFIED") throw new Error("PDF-Vorschau ist noch nicht vollständig archiviert");
    const current = await buildTenantStatement(input.billingPeriodId, draft.tenantId, { draft: true, forIssue: true });
    if (recordHash(current) !== recordHash(JSON.parse(draft.statementJson))) throw new Error("PDF-Vorschau stimmt nicht mit aktuellem Ergebnis überein");
  }
  const archivePeriod = await prisma.billingPeriod.findUniqueOrThrow({ where: { id: input.billingPeriodId }, include: { property: { include: { storage: true } } } });
  if (await domainFingerprint() !== preview.fingerprint) throw new Error("Abrechnungsgrundlagen seit Vorschau geändert");
  const pending = [];
  for (const draft of drafts) {
    const previous = archivePeriod.revisionOfPeriodId ? await prisma.statementRevision.findFirst({ where: { billingPeriodId: archivePeriod.revisionOfPeriodId, tenantId: draft.tenantId }, orderBy: { revision: "desc" } }) : null;
    const revision = (previous?.revision || 0) + 1;
    const statement = JSON.parse(draft.statementJson) as TenantStatement;
    const finalPath = statementArchivePath({ objectFolder: archivePeriod.property.storage!.objectFolder, start: archivePeriod.startDate, end: archivePeriod.endDate, tenantName: `${statement.tenant.firstName} ${statement.tenant.lastName}`, tenantId: draft.tenantId, revision });
    const archive = await queueDocumentArchive(draft.documentId, archivePeriod.propertyId, finalPath);
    await prisma.statementArtifact.update({ where: { id: draft.id }, data: { revision, status: "PREPARED" } });
    if (archive?.status !== "VERIFIED" || archive.relativePath !== finalPath) pending.push({ documentId: draft.documentId, path: finalPath });
  }
  if (pending.length) return { issued: false, status: "ARCHIVING", previewId, pending, message: "Freigegebene PDF-Pfade werden vor Ausstellung geprüft. Dieselbe bestätigte Freigabe danach wiederholen." };
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.domainChangePreview.findUniqueOrThrow({ where: { id: previewId } });
    if (current.consumedAt) return JSON.parse(current.resultJson!);
    if (await domainFingerprint(tx) !== preview.fingerprint) throw new Error("Abrechnungsgrundlagen seit Vorschau geändert");
    const period = await tx.billingPeriod.findUniqueOrThrow({ where: { id: input.billingPeriodId }, include: { statementRevisions: true, calculationHeads: true } });
    if (period.statementRevisions.length || period.status === "SUPERSEDED") throw new Error("Ausgestellte Abrechnung ist unveränderlich");
    const issued = [];
    for (const draft of drafts) {
      const previous = period.revisionOfPeriodId ? await tx.statementRevision.findFirst({ where: { billingPeriodId: period.revisionOfPeriodId, tenantId: draft.tenantId }, orderBy: { revision: "desc" } }) : null;
      const revision = (previous?.revision || 0) + 1;
      const row = await tx.statementRevision.create({ data: { billingPeriodId: period.id, tenantId: draft.tenantId, revision, revisionOfId: previous?.id, payloadJson: draft.statementJson, snapshotIdsJson: JSON.stringify(period.calculationHeads.map((head) => head.snapshotId)), issuedBy: context.userId } });
      issued.push({ ...row, artifactId: draft.id, documentId: draft.documentId });
      await tx.statementArtifact.update({ where: { id: draft.id }, data: { revision, status: "ISSUED" } });
    }
    await tx.billingPeriod.update({ where: { id: period.id }, data: { billingDate: new Date() } });
    await recordLifecycleAudit({ ...context, action: "ISSUE_BILLING", entityType: "StatementRevision", itemRef: period.id, after: issued }, tx);
    await tx.domainChangePreview.update({ where: { id: previewId }, data: { consumedAt: new Date(), resultJson: JSON.stringify(serializeExact(issued)) } });
    return serializeExact(issued);
  }, { timeout: 30_000 });
  return result;
}

export async function previewStatementSend(input: { artifactId: string; mailbox: string; recipient: string; subject: string; bodyText: string }, context: AuditContext) {
  if (typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > 998 || /[\r\n]/.test(input.subject) || typeof input.bodyText !== "string" || !input.bodyText.trim() || input.bodyText.length > 100_000) throw new Error("Gültiger Betreff und Nachricht erforderlich");
  if (![input.mailbox, input.recipient].every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("Ungültige E-Mail-Adresse");
  const artifact = await prisma.statementArtifact.findUniqueOrThrow({ where: { id: input.artifactId } });
  if (artifact.status !== "ISSUED") throw new Error("Nur freigegebene Fassungen können versendet werden");
  const archive = await prisma.documentArchive.findUniqueOrThrow({ where: { documentId: artifact.documentId } });
  if (archive.status !== "VERIFIED") throw new Error("Freigegebene PDF ist noch nicht archiviert");
  const existing = await prisma.statementDispatch.findFirst({ where: { artifactId: input.artifactId, recipient: input.recipient, status: { in: ["PENDING", "DRAFT_READY", "UNCERTAIN", "ACCEPTED"] } } });
  if (existing) throw new Error(`Versand existiert bereits (${existing.status}); Status abgleichen statt erneut senden`);
  const result = await prisma.domainChangePreview.create({ data: { userId: context.userId, action: "SEND_STATEMENT", payloadJson: JSON.stringify(input), fingerprint: recordHash({ artifact, archive }), impactJson: JSON.stringify({ ...input, documentId: artifact.documentId, sha256: archive.sha256 }), expiresAt: new Date(Date.now() + 30 * 60_000) } });
  return { previewId: result.id, ...input, documentId: artifact.documentId, sha256: archive.sha256 };
}

export async function sendStatementPreview(previewId: string, confirmed: boolean, context: AuditContext) {
  if (!confirmed) throw new Error("Versandvorschau muss ausdrücklich bestätigt werden");
  const dispatch = await prisma.$transaction(async (tx) => {
    const preview = await tx.domainChangePreview.findUniqueOrThrow({ where: { id: previewId } });
    if (preview.userId !== context.userId || preview.action !== "SEND_STATEMENT") throw new Error("Ungültige Versandvorschau");
    if (preview.consumedAt) return tx.statementDispatch.findUniqueOrThrow({ where: { previewId } });
    if (preview.expiresAt <= new Date()) throw new Error("Versandvorschau abgelaufen");
    const input = JSON.parse(preview.payloadJson);
    const artifact = await tx.statementArtifact.findUniqueOrThrow({ where: { id: input.artifactId } });
    const archive = await tx.documentArchive.findUniqueOrThrow({ where: { documentId: artifact.documentId } });
    if (archive.status !== "VERIFIED" || recordHash({ artifact, archive }) !== preview.fingerprint) throw new Error("Versandgrundlage seit Vorschau geändert");
    if (await tx.statementDispatch.count({ where: { artifactId: input.artifactId, recipient: input.recipient, status: { in: ["PENDING", "DRAFT_READY", "UNCERTAIN", "ACCEPTED"] } } })) throw new Error("Versand bereits beauftragt; vorhandene Outbox prufen");
    const row = await tx.statementDispatch.create({ data: { ...input, previewId, createdBy: context.userId } });
    await tx.domainChangePreview.update({ where: { id: previewId }, data: { consumedAt: new Date(), resultJson: JSON.stringify(row) } });
    await recordLifecycleAudit({ ...context, action: "QUEUE_SEND", entityType: "StatementDispatch", itemRef: row.id, after: row }, tx);
    return row;
  });
  await enqueueJob("SEND_STATEMENT", `send:${dispatch.id}`, { dispatchId: dispatch.id });
  return dispatch;
}

export async function statementDocument(artifactId: string) {
  const artifact = await prisma.statementArtifact.findUniqueOrThrow({ where: { id: artifactId } });
  const document = await prisma.document.findUniqueOrThrow({ where: { id: artifact.documentId }, include: { archive: true } });
  const bytes = await readFile(documentFile(document.fileName));
  if (document.fileHash !== (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")) throw new Error("PDF hash mismatch");
  return { artifact, document, bytes };
}
