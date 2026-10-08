import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import {
  extractInvoice,
  templateMatches,
  type OcrDocument,
  type TemplateRules,
} from "@/lib/invoice-extraction";
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
            path.join(process.cwd(), "data/uploads", job.document.fileName),
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
    await prisma.invoiceExtractionJob.updateMany({
      where: { id: job.id, status: "PROCESSING" },
      data: {
        status: "REVIEW_REQUIRED",
        leaseUntil: null,
        ocrJson: JSON.stringify(ocr),
        templateId: template?.id ?? null,
        resultJson: JSON.stringify(result),
        error: null,
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
      where: { id: job.id, status: "PROCESSING" },
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
