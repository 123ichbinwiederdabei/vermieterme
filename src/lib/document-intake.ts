import { prisma } from "@/lib/prisma";
import { persistOriginal, queueDocumentArchive } from "@/lib/document-archive";
import { assertDraftPeriod, invalidateProperty } from "@/lib/billing-freshness";
import { recordLifecycleAudit } from "@/lib/mcp/entities";
import type { AuditContext } from "@/lib/domain-changes";
import { DOCX_MIME } from "@/lib/document-types";

export async function intakeDocument(bytes: Buffer, mimeType: string, name: string, metadata: Record<string, unknown>, context: AuditContext) {
  if (mimeType === DOCX_MIME && (metadata.costInvoiceId || metadata.heatingOilDeliveryId)) throw new Error("DOCX evidence cannot be imported as an invoice or oil delivery original");
  const invoice = metadata.costInvoiceId ? await prisma.costInvoice.findUniqueOrThrow({ where: { id: String(metadata.costInvoiceId) } }) : null;
  const period = metadata.billingPeriodId ? await prisma.billingPeriod.findUniqueOrThrow({ where: { id: String(metadata.billingPeriodId) } }) : null;
  const tenant = metadata.tenantId ? await prisma.tenant.findUniqueOrThrow({ where: { id: String(metadata.tenantId) }, include: { unit: true } }) : null;
  const delivery = metadata.heatingOilDeliveryId ? await prisma.heatingOilDelivery.findUniqueOrThrow({ where: { id: String(metadata.heatingOilDeliveryId) }, include: { tank: { include: { heatingSystem: true } } } }) : null;
  const ids = [invoice?.propertyId, period?.propertyId, tenant?.unit.propertyId, delivery?.tank.heatingSystem.propertyId, metadata.propertyId ? String(metadata.propertyId) : undefined].filter((id): id is string => !!id);
  if (!ids.length || new Set(ids).size !== 1) throw new Error("Provide one unambiguous property for the document associations");
  const propertyId = ids[0];
  await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
  if (invoice && invoice.status !== "DRAFT") throw new Error("Confirmed invoice attachments are immutable");
  if (period) await assertDraftPeriod(period.id);
  if (invoice?.billingPeriodId) await assertDraftPeriod(invoice.billingPeriodId);
  if (delivery?.documentId) throw new Error("Delivery already has an immutable source document");
  const original = await persistOriginal(bytes, mimeType, name, propertyId, String(metadata.category || "invoice"));
  const document = await prisma.$transaction(async (tx) => {
    const row = await tx.document.update({ where: { id: original.id }, data: { propertyId, ...(tenant && !original.tenantId ? { tenantId: tenant.id } : {}), ...(period && !original.billingPeriodId ? { billingPeriodId: period.id } : {}) } });
    if (invoice) await tx.invoiceAttachment.upsert({ where: { invoiceId_documentId: { invoiceId: invoice.id, documentId: row.id } }, create: { invoiceId: invoice.id, documentId: row.id }, update: {} });
    if (delivery) await tx.heatingOilDelivery.update({ where: { id: delivery.id }, data: { documentId: row.id } });
    await recordLifecycleAudit({ ...context, action: "INTAKE_ORIGINAL", entityType: "Document", itemRef: row.id, after: row }, tx);
    return row;
  });
  await queueDocumentArchive(document.id, propertyId);
  if (invoice) await invalidateProperty(propertyId);
  return document;
}
