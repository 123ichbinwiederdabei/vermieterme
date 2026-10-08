import { ImageAnnotatorClient } from "@google-cloud/vision";
import { Storage } from "@google-cloud/storage";
import type { OcrDocument, OcrPage } from "@/lib/invoice-extraction";

type Annotation = {
  text?: string | null;
  pages?: Array<{
    width?: number | null;
    height?: number | null;
    blocks?: Array<{
      paragraphs?: Array<{
        words?: Array<{
          confidence?: number | null;
          symbols?: Array<{ text?: string | null }>;
          boundingBox?: {
            vertices?: Array<{ x?: number | null; y?: number | null }>;
            normalizedVertices?: Array<{
              x?: number | null;
              y?: number | null;
            }>;
          };
        }>;
      }>;
    }>;
  }>;
};

function credentials() {
  const encoded = process.env.GOOGLE_VISION_SERVICE_ACCOUNT_JSON_B64;
  if (encoded) {
    let json: Record<string, string>;
    try {
      json = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new Error(
        "Google OCR-Anmeldedaten sind nicht gültig konfiguriert.",
      );
    }
    if (
      json.type !== "service_account" ||
      !json.client_email ||
      !json.private_key
    )
      throw new Error("Google OCR-Servicekonto ist unvollständig.");
    return {
      credentials: {
        client_email: json.client_email,
        private_key: json.private_key,
      },
      projectId: json.project_id,
    };
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS)
    throw new Error("Google OCR-Anmeldedaten fehlen.");
  return {};
}

function pagesFrom(annotation: Annotation, firstPage: number): OcrPage[] {
  return (annotation.pages ?? []).map((page, index) => ({
    page: firstPage + index,
    words: (page.blocks ?? [])
      .flatMap((block) =>
        (block.paragraphs ?? []).flatMap((paragraph) =>
          (paragraph.words ?? []).map((word) => {
            const normalized = word.boundingBox?.normalizedVertices;
            const vertices = normalized?.length
              ? normalized
              : (word.boundingBox?.vertices ?? []);
            const xs = vertices.map(
              (v) => (v.x ?? 0) / (normalized?.length ? 1 : page.width || 1),
            );
            const ys = vertices.map(
              (v) => (v.y ?? 0) / (normalized?.length ? 1 : page.height || 1),
            );
            return {
              text: (word.symbols ?? []).map((s) => s.text ?? "").join(""),
              confidence: word.confidence ?? 0,
              region: {
                x: Math.min(...xs),
                y: Math.min(...ys),
                width: Math.max(...xs) - Math.min(...xs),
                height: Math.max(...ys) - Math.min(...ys),
              },
            };
          }),
        ),
      )
      .filter(
        (word) =>
          word.text && Number.isFinite(word.region.x) && word.region.width > 0,
      ),
  }));
}

export async function googleInvoiceOcr(
  bytes: Buffer,
  mimeType: string,
  jobId: string,
  attempt: number,
): Promise<OcrDocument> {
  const options = credentials();
  const client = new ImageAnnotatorClient({ ...options, fallback: true });
  if (mimeType !== "application/pdf") {
    const [response] = await client.documentTextDetection({
      image: { content: bytes },
    });
    if (response.error?.message)
      throw new Error("Google OCR hat die Bildverarbeitung abgelehnt.");
    const annotation = response.fullTextAnnotation as Annotation | undefined;
    if (!annotation?.text) throw new Error("Kein Rechnungstext erkannt.");
    return { text: annotation.text, pages: pagesFrom(annotation, 1) };
  }
  const bucketName = process.env.GOOGLE_VISION_GCS_BUCKET;
  if (!bucketName) throw new Error("Google OCR-PDF-Bucket fehlt.");
  const storage = new Storage(options);
  const bucket = storage.bucket(bucketName);
  const prefix = `vermieterme/${jobId}/${attempt}/`;
  try {
    await bucket
      .file(`${prefix}input.pdf`)
      .save(bytes, { contentType: "application/pdf", resumable: false });
    const [operation] = await client.asyncBatchAnnotateFiles({
      requests: [
        {
          inputConfig: {
            mimeType: "application/pdf",
            gcsSource: { uri: `gs://${bucketName}/${prefix}input.pdf` },
          },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          outputConfig: {
            gcsDestination: { uri: `gs://${bucketName}/${prefix}output/` },
            batchSize: 10,
          },
        },
      ],
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const [response] = await Promise.race([
      operation.promise(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Google OCR timeout")),
          300_000,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    if (!response)
      throw new Error("Google OCR-PDF-Verarbeitung fehlgeschlagen.");
    const [files] = await bucket.getFiles({ prefix: `${prefix}output/` });
    const entries: Array<{ page: number; annotation: Annotation }> = [];
    for (const file of files.filter((file) => file.name.endsWith(".json"))) {
      const [data] = await file.download();
      const payload = JSON.parse(data.toString("utf8")) as {
        responses?: Array<{
          context?: { pageNumber?: number };
          fullTextAnnotation?: Annotation;
          error?: { message?: string };
        }>;
      };
      for (const row of payload.responses ?? []) {
        if (row.error?.message)
          throw new Error("Google OCR konnte eine PDF-Seite nicht lesen.");
        if (row.fullTextAnnotation)
          entries.push({
            page: row.context?.pageNumber ?? entries.length + 1,
            annotation: row.fullTextAnnotation,
          });
      }
    }
    entries.sort((a, b) => a.page - b.page);
    const document = {
      text: entries.map((entry) => entry.annotation.text ?? "").join("\n\n"),
      pages: entries.flatMap((entry) =>
        pagesFrom(entry.annotation, entry.page),
      ),
    };
    if (!document.text.trim())
      throw new Error("Kein Rechnungstext im PDF erkannt.");
    return document;
  } finally {
    // Only delete this job's isolated objects. Deployment documentation also
    // requires expiry for leftovers from interrupted workers.
    await bucket.deleteFiles({ prefix, force: true }).catch(() => undefined);
  }
}
