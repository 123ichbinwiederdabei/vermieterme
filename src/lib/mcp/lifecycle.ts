import { randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import path from "path";
import { mkdir, unlink, writeFile } from "fs/promises";
import { prisma } from "@/lib/prisma";
import { buildEnergyPreview } from "@/lib/energy-preview";
import { serializeExact } from "@/lib/billing-v2";
import { generateAccessCode } from "@/lib/token";
import { recordLifecycleAudit, sanitizeRecord } from "./entities";

type AuditContext = { userId: string; requestId: string; reason: string };

export async function reviseFinancialPeriod(id: string, values: Record<string, unknown>, context: AuditContext) {
  const original = await prisma.leaseFinancialPeriod.findUnique({ where: { id }, include: { components: true } });
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
    }, include: { components: true } });
    await recordLifecycleAudit({ ...context, action: "REVISE", entityType: "LeaseFinancialPeriod", itemRef: replacement.id, before: original, after: replacement }, tx);
    return replacement;
  });
  return sanitizeRecord(revised);
}

export async function applyBillingCalculation(billingPeriodId: string, kind: string, costCategoryId: string, context: AuditContext) {
  const preview = await buildEnergyPreview(kind, billingPeriodId, costCategoryId);
  if (preview.blockers.length) throw new Error(preview.blockers.join(" "));
  const period = await prisma.billingPeriod.findUnique({ where: { id: billingPeriodId } });
  if (!period) throw new Error("Billing period not found");
  if (period.sentDate || period.paidDate) throw new Error("Sent or paid billing periods cannot be changed");
  const before = await prisma.billingSnapshot.findMany({ where: { billingPeriodId, kind, status: "APPLIED" } });
  const snapshot = await prisma.$transaction(async (tx) => {
    await tx.billingSnapshot.updateMany({ where: { billingPeriodId, kind: preview.kind, status: "APPLIED" }, data: { status: "SUPERSEDED" } });
    await tx.costAllocation.deleteMany({ where: { billingPeriodId, costCategoryId: preview.costCategoryId } });
    const created = await tx.billingSnapshot.create({ data: {
      billingPeriodId, costCategoryId: preview.costCategoryId, kind: preview.kind,
      sourceFingerprint: preview.sourceFingerprint,
      sourceJson: JSON.stringify({ fingerprint: preview.sourceFingerprint }),
      resultJson: JSON.stringify(serializeExact(preview)), appliedBy: context.userId,
    }});
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
      const rows = serializeExact(preview.details.fifoRows) as Array<{ lotId: string; consumedLiters: string; amountCents: string; co2CostCents: string; co2Grams: string }>;
      await tx.oilLotConsumption.updateMany({ where: { snapshot: { billingPeriodId, kind: "HEATING_OIL" }, active: true }, data: { active: false } });
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
  const before = await prisma.billingPeriod.findUnique({ where: { id } });
  if (!before) throw new Error("Billing period not found");
  if (before.status === "SUPERSEDED") throw new Error("Billing period is already superseded");
  const after = await prisma.$transaction(async (tx) => {
    const row = await tx.billingPeriod.update({ where: { id }, data: { status: "SUPERSEDED" } });
    await recordLifecycleAudit({ ...context, action: "SUPERSEDE", entityType: "BillingPeriod", itemRef: id, before, after: row }, tx);
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
