import { NextRequest } from "next/server";
import path from "path";
import { writeFile, mkdir } from "fs/promises";
import { randomUUID, createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { assertDraftPeriod, invalidateProperty } from "@/lib/billing-freshness";
import type { Prisma } from "@prisma/client";
import {
  apiHandler,
  requireAuth,
  jsonOk,
  jsonCreated,
  ApiError,
} from "@/lib/api-utils";

const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];

export function GET(request: NextRequest) {
  return apiHandler(async () => {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const billingPeriodId = searchParams.get("billingPeriodId");
    const tenantId = searchParams.get("tenantId");
    const heatingOilDeliveryId = searchParams.get("heatingOilDeliveryId");
    const costInvoiceId = searchParams.get("costInvoiceId");

    const where: Prisma.DocumentWhereInput = {};
    if (billingPeriodId) where.billingPeriodId = billingPeriodId;
    if (tenantId) where.tenantId = tenantId;
    if (heatingOilDeliveryId)
      where.heatingOilDelivery = { is: { id: heatingOilDeliveryId } };
    if (costInvoiceId)
      where.OR = [
        { costInvoice: { is: { id: costInvoiceId } } },
        { invoiceAttachments: { some: { invoiceId: costInvoiceId } } },
      ];

    const documents = await prisma.document.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return jsonOk(documents);
  });
}

export function POST(request: NextRequest) {
  return apiHandler(async () => {
    await requireAuth();

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const billingPeriodId = formData.get("billingPeriodId") as string | null;
    const tenantId = formData.get("tenantId") as string | null;
    const heatingOilDeliveryId = formData.get("heatingOilDeliveryId") as
      | string
      | null;
    const costInvoiceId = formData.get("costInvoiceId") as string | null;
    const category = (formData.get("category") as string) || "other";

    if (!file) {
      throw new ApiError("Keine Datei hochgeladen", 400);
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      throw new ApiError(
        "Dateityp nicht erlaubt. Erlaubt: PDF, JPEG, PNG, WebP",
        400,
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new ApiError("Datei zu groß (max. 10 MB)", 400);
    }

    await mkdir(UPLOAD_DIR, { recursive: true });

    const invoice = costInvoiceId
      ? await prisma.costInvoice.findUnique({ where: { id: costInvoiceId } })
      : null;
    if (costInvoiceId && !invoice)
      throw new ApiError("Rechnung nicht gefunden", 404);
    if (invoice) {
      await assertDraftPeriod(invoice.billingPeriodId);
      if (invoice.status !== "DRAFT")
        throw new ApiError(
          "Belege einer bestätigten Rechnung sind unveränderlich",
          409,
        );
      if (billingPeriodId && billingPeriodId !== invoice.billingPeriodId)
        throw new ApiError(
          "Beleg und Rechnung gehören zu verschiedenen Zeiträumen",
          400,
        );
    } else if (billingPeriodId) await assertDraftPeriod(billingPeriodId);
    const ext = path.extname(file.name) || ".bin";
    const fileName = `${randomUUID()}${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    const document = await prisma.document.create({
      data: {
        fileName,
        fileHash: createHash("sha256").update(buffer).digest("hex"),
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        category,
        billingPeriodId: invoice?.billingPeriodId || billingPeriodId || null,
        tenantId: tenantId || null,
        heatingOilDelivery: heatingOilDeliveryId
          ? { connect: { id: heatingOilDeliveryId } }
          : undefined,
        invoiceAttachments: costInvoiceId
          ? { create: { invoiceId: costInvoiceId } }
          : undefined,
      },
    });

    if (invoice) await invalidateProperty(invoice.propertyId);
    return jsonCreated(document);
  });
}
