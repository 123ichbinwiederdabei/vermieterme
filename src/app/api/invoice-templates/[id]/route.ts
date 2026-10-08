import { apiHandler, requireAuth, jsonOk, ApiError } from "@/lib/api-utils";
import { templateHash } from "@/lib/invoice-template-hash";
import { prisma } from "@/lib/prisma";
import {
  extractInvoice,
  templateMatches,
  type OcrDocument,
  type TemplateRules,
} from "@/lib/invoice-extraction";

export function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const template = await prisma.invoiceTemplate.findUnique({ where: { id } });
    if (!template) throw new ApiError("Vorlage fehlt", 404);
    return jsonOk(template);
  });
}
export function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const template = await prisma.invoiceTemplate.findUnique({ where: { id } });
    if (!template) throw new ApiError("Vorlage fehlt", 404);
    const rules = JSON.parse(template.rulesJson) as TemplateRules;
    const markers = JSON.parse(template.markersJson) as string[];
    const hash = templateHash(rules, markers);
    if (body.action === "test") {
      if (template.status !== "DRAFT")
        throw new ApiError("Veröffentlichte Vorlage ist unveränderlich", 409);
      if (
        !Array.isArray(body.samples) ||
        !body.samples.length ||
        body.samples.length > 10
      )
        throw new ApiError("Ein bis zehn Testbelege erforderlich", 400);
      const results = [];
      for (const sample of body.samples as Array<{
        documentId: string;
        expected: Record<string, string>;
        expectedLines?: unknown[];
      }>) {
        const job = await prisma.invoiceExtractionJob.findFirst({
          where: {
            documentId: sample.documentId,
            ocrJson: { not: null },
            invoice: {
              costCategoryId: template.costCategoryId,
              section: template.section,
            },
          },
          include: { document: true },
          orderBy: { createdAt: "desc" },
        });
        if (!job?.ocrJson)
          throw new ApiError(
            "OCR-Testbeleg fehlt oder passt nicht zur Vorlage",
            400,
          );
        const document = JSON.parse(job.ocrJson) as OcrDocument;
        const extracted = extractInvoice(document, rules);
        const mismatches = rules.fields
          .filter(
            (rule) =>
              rule.required || Object.hasOwn(sample.expected ?? {}, rule.field),
          )
          .filter(
            (rule) =>
              !sample.expected?.[rule.field] ||
              extracted.fields[rule.field]?.value !==
                sample.expected[rule.field],
          )
          .map((rule) => rule.field);
        if (
          rules.table &&
          (!Array.isArray(sample.expectedLines) ||
            JSON.stringify(sample.expectedLines) !==
              JSON.stringify(extracted.lines))
        )
          mismatches.push("Rechnungspositionen");
        const passed =
          templateMatches(document, markers) &&
          !extracted.errors.length &&
          !mismatches.length;
        results.push({
          documentId: sample.documentId,
          fileHash: job.document.fileHash,
          expected: sample.expected,
          extracted,
          mismatches,
          passed,
        });
      }
      await prisma.invoiceTemplate.update({
        where: { id },
        data: {
          testedHash: results.every((result) => result.passed) ? hash : null,
          testResultsJson: JSON.stringify(results),
        },
      });
      return jsonOk({
        passed: results.every((result) => result.passed),
        results,
      });
    }
    if (body.action === "publish") {
      if (template.status !== "DRAFT" || template.testedHash !== hash)
        throw new ApiError(
          "Vorlage muss mit erwarteten Werten erfolgreich getestet werden",
          409,
        );
      return jsonOk(
        await prisma.invoiceTemplate.update({
          where: { id },
          data: { status: "PUBLISHED", publishedAt: new Date() },
        }),
      );
    }
    throw new ApiError("Unbekannte Vorlagenaktion", 400);
  });
}
