import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { DOCX_MIME, originalExtension } from "@/lib/document-types";
import {
  apiHandler,
  requireAuth,
  jsonOk,
  jsonCreated,
  ApiError,
} from "@/lib/api-utils";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  DOCX_MIME,
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

    if (!ALLOWED_TYPES.includes(file.type) || !originalExtension(file.type, category)) {
      throw new ApiError(
        "Dateityp nicht erlaubt. Erlaubt: PDF, JPEG, PNG, WebP; DOCX nur als Vertrags-/Stammdatennachweis",
        400,
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new ApiError("Datei zu groß (max. 10 MB)", 400);
    }

    const { intakeDocument } = await import("@/lib/document-intake");
    const session = await requireAuth();
    return jsonCreated(await intakeDocument(Buffer.from(await file.arrayBuffer()), file.type, file.name,
      { propertyId: formData.get("propertyId") || undefined, billingPeriodId, tenantId, heatingOilDeliveryId, costInvoiceId, category },
      { userId: session.user.id, requestId: randomUUID(), reason: "Web-Belegimport" }));
  });
}
