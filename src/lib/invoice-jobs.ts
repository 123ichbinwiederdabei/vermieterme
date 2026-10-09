import { readFile } from "node:fs/promises";
import { documentFile } from "@/lib/document-archive";
import { prisma } from "@/lib/prisma";
import {
  extractInvoice,
  templateMatches,
  type OcrDocument,
  type TemplateRules,
} from "@/lib/invoice-extraction";
import { templateHash } from "@/lib/invoice-template-hash";
import { confirmInvoice } from "@/lib/invoice-service";
import { eligibleForCategory, categoryCode } from "@/lib/invoice-categories";
import { googleInvoiceOcr } from "@/lib/google-invoice-ocr";

export async function processNextInvoiceJob() {
  const now = new Date();
  const job = await prisma.invoiceExtractionJob.findFirst({
    where: {
      OR: [
        { status: "QUEUED", availableAt: { lte: now } },
        { status: "PROCESSING", leaseUntil: { lt: now } },
      ],
    },
    orderBy: { createdAt: "asc" },
    include: { document: true, invoice: true },
  });
  if (!job) return false;
  if (job.invoice.status !== "DRAFT") {
    await prisma.invoiceExtractionJob.update({
      where: { id: job.id },
      data: { status: "CANCELLED", leaseUntil: null },
    });
    return true;
  }
  const claim = await prisma.invoiceExtractionJob.updateMany({
    where: { id: job.id, status: job.status, attempts: job.attempts },
    data: {
      status: "PROCESSING",
      attempts: { increment: 1 },
      leaseUntil: new Date(now.getTime() + 600_000),
    },
  });
  if (claim.count !== 1) return true;
  try {
    const ocr = job.ocrJson
      ? (JSON.parse(job.ocrJson) as OcrDocument)
      : await googleInvoiceOcr(
          await readFile(
            documentFile(job.document.fileName),
          ),
          job.document.mimeType,
          job.id,
          job.attempts + 1,
        );
    const templates = await prisma.invoiceTemplate.findMany({
      where: {
        costCategoryId: job.invoice.costCategoryId,
        section: job.invoice.section,
        status: "PUBLISHED",
      },
      orderBy: { version: "desc" },
    });
    // Only the newest published version of each design participates in matching.
    const series = new Set<string>();
    const matching = templates.filter((template) => {
      if (series.has(template.seriesId)) return false;
      series.add(template.seriesId);
      return templateMatches(ocr, JSON.parse(template.markersJson));
    });
    const template = job.templateId
      ? await prisma.invoiceTemplate.findUnique({
          where: { id: job.templateId },
        })
      : matching.length === 1
        ? matching[0]
        : null;
    if (
      template &&
      (template.costCategoryId !== job.invoice.costCategoryId ||
        template.section !== job.invoice.section ||
        template.status !== "PUBLISHED")
    )
      throw new Error("Rechnungsvorlage passt nicht zur Kostenart.");
    const result = template
      ? extractInvoice(ocr, JSON.parse(template.rulesJson) as TemplateRules)
      : {
          fields: {},
          lines: [],
          errors: [
            matching.length
              ? "Mehrere Rechnungsvorlagen passen. Vorlage auswählen."
              : "Keine veröffentlichte Rechnungsvorlage passt. Vorlage anlegen oder manuell erfassen.",
          ],
        };
    let reviewReason: string | null = null;
    const sources = await prisma.importedSourceItem.findMany({ where: { invoiceId: job.invoiceId } });
    const autoBook = sources.length > 0 && await prisma.microsoftImportSource.count({ where: { id: { in: sources.map((s) => s.sourceId) }, enabled: true, autoBook: true } }) > 0;
    if (autoBook && matching.length === 1 && template && !result.errors.length && template.testedHash === templateHash(JSON.parse(template.rulesJson), JSON.parse(template.markersJson))) {
      try {
        const tests = JSON.parse(template.testResultsJson || "[]") as Array<{ passed: boolean; role: string; fileHash: string }>;
        if (tests.length < 3 || !tests.every((t) => t.passed) || tests.filter((t) => t.role === "TRAINING").length < 2 || !tests.some((t) => t.role === "HOLDOUT") || new Set(tests.map((t) => t.fileHash)).size !== tests.length) throw new Error("Independent template validation missing");
        const category = await prisma.costCategory.findUniqueOrThrow({ where: { id: job.invoice.costCategoryId } });
        const values = Object.fromEntries(Object.entries(result.fields).map(([key, field]) => [key, field.value || ""]));
        if (!values.supplier || !values.invoiceNumber || !values.invoiceDate || !values.servicePeriodStart || !values.servicePeriodEnd || !values.netAmountCents || !values.vatAmountCents || !values.vatRate) throw new Error("Supplier, number, dates and tax evidence must be unambiguous");
        if (["TARIF", "HEATING_OIL", "BESCHEID"].includes(job.invoice.section)) throw new Error("Contract, tariff, tank or residential tax basis requires confirmed association");
        if (result.lines.length && result.lines.some((line) => !eligibleForCategory(categoryCode(category), line))) throw new Error("Non-allocatable or uncertain invoice positions require review");
        const activeLease = await prisma.invoiceExtractionJob.count({ where: { id: job.id, status: "PROCESSING", attempts: job.attempts + 1, leaseUntil: { gt: new Date() } } });
        if (!activeLease) return true;
        await prisma.user.upsert({ where: { id: "system:invoice-worker" }, create: { id: "system:invoice-worker", name: "Automatic invoice worker" }, update: {} });
        await confirmInvoice(job.invoiceId, { values, ...(result.lines.length ? { lines: result.lines } : {}) }, "system:invoice-worker");
      } catch (error) { reviewReason = error instanceof Error ? error.message : "Automatic validation failed"; }
    }
    await prisma.invoiceExtractionJob.updateMany({
      where: { id: job.id, status: "PROCESSING", attempts: job.attempts + 1 },
      data: {
        status: "REVIEW_REQUIRED",
        leaseUntil: null,
        ocrJson: JSON.stringify(ocr),
        templateId: template?.id ?? null,
        resultJson: JSON.stringify(result),
        error: reviewReason,
      },
    });
  } catch (error) {
    const transient =
      /timeout|temporar|unavailable|429|503|ECONN|deadline/i.test(
        error instanceof Error ? error.message : "",
      );
    const retry = transient && job.attempts < 2;
    // Provider errors may contain request details: persist a sanitized message.
    await prisma.invoiceExtractionJob.updateMany({
      where: { id: job.id, status: "PROCESSING", attempts: job.attempts + 1 },
      data: {
        status: retry ? "QUEUED" : "FAILED",
        leaseUntil: null,
        availableAt: new Date(Date.now() + 30_000 * (job.attempts + 1)),
        error: retry
          ? "Google OCR vorübergehend nicht erreichbar; erneuter Versuch folgt."
          : "Extraktion fehlgeschlagen. Konfiguration/Datei prüfen oder Werte manuell erfassen.",
      },
    });
  }
  return true;
}
