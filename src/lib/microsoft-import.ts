import { createHash } from "node:crypto";
import { recordHash } from "@/lib/mcp/entities";
import { prisma } from "@/lib/prisma";
import { MicrosoftGraph } from "@/lib/microsoft-graph";
import { persistOriginal, queueDocumentArchive } from "@/lib/document-archive";
import { categoryCode, INVOICE_SECTIONS } from "@/lib/invoice-categories";

export async function testMicrosoftSource(id: string, graph = new MicrosoftGraph()) {
  const source = await prisma.microsoftImportSource.findUniqueOrThrow({ where: { id } });
  const endpoint = source.kind === "MAIL" ? `users/${encodeURIComponent(source.mailbox!)}/mailFolders/${encodeURIComponent(source.folderId)}` : `drives/${encodeURIComponent(source.driveId!)}/items/${encodeURIComponent(source.folderId)}`;
  const result = await graph.request(endpoint);
  await prisma.microsoftImportSource.update({ where: { id }, data: { testedAt: new Date(), testedFingerprint: recordHash({ propertyId: source.propertyId, kind: source.kind, mailbox: source.mailbox, driveId: source.driveId, folderId: source.folderId, costCategoryId: source.costCategoryId, section: source.section }) } });
  return { sourceId: id, accessible: true, name: result.displayName || result.name, kind: source.kind };
}

export async function runMicrosoftImport(id: string, graph = new MicrosoftGraph()) {
  const source = await prisma.microsoftImportSource.findUniqueOrThrow({ where: { id } });
  if (!source.enabled) throw new Error("Microsoft source is disabled");
  const category = await prisma.costCategory.findUniqueOrThrow({ where: { id: source.costCategoryId } });
  if (!(INVOICE_SECTIONS[categoryCode(category)] || ["OPERATING"]).includes(source.section)) throw new Error("Import rule does not match category");
  const base = source.kind === "MAIL" ? `users/${encodeURIComponent(source.mailbox!)}/mailFolders/${encodeURIComponent(source.folderId)}/messages/delta` : `drives/${encodeURIComponent(source.driveId!)}/items/${encodeURIComponent(source.folderId)}/delta`;
  let cursor: string | undefined = source.cursor || base;
  let finalCursor = source.cursor;
  let count = 0;
  while (cursor) {
    const page = await graph.request(cursor);
    const items = (page.value || []) as Array<Record<string, unknown>>;
    for (const item of items) {
      if (item.deleted || item["@removed"] || item.folder) continue;
      const candidates: Array<{ key: string; name: string; mimeType: string; bytes: Buffer; version?: string }> = [];
      if (source.kind === "MAIL") {
        let attachmentCursor: string | undefined = `users/${encodeURIComponent(source.mailbox!)}/messages/${encodeURIComponent(String(item.id))}/attachments`;
        while (attachmentCursor) {
        const response = await graph.request(attachmentCursor);
        for (const attachment of (response.value || []) as Array<Record<string, unknown>>) {
          if (attachment.isInline || !attachment.contentBytes) continue;
          const mimeType = String(attachment.contentType || "");
          if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(mimeType)) continue;
          const bytes = Buffer.from(String(attachment.contentBytes), "base64");
          candidates.push({ key: `${item.id}:${attachment.id}`, name: String(attachment.name), mimeType, bytes });
        }
        attachmentCursor = typeof response["@odata.nextLink"] === "string" ? response["@odata.nextLink"] : undefined;
        }
      } else {
        const file = item.file as { mimeType?: string } | undefined;
        if (!file || !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.mimeType || "")) continue;
        const relative = String(item.name || "");
        // Managed exports carry source IDs and are excluded even if a configured
        // source accidentally includes the archive itself.
        if (/^NKA_|Belegverzeichnis|Versandnachweis|__[a-z0-9-]{20,}\.(pdf|png|jpe?g|webp)$/i.test(relative)) continue;
        if (await prisma.documentArchive.count({ where: { itemId: String(item.id) } })) continue;
        candidates.push({ key: String(item.id), name: relative, mimeType: file.mimeType!, bytes: await graph.download(source.driveId!, String(item.id)), version: String(item.eTag || "") });
      }
      for (const candidate of candidates) {
        if (/^NKA_|Belegverzeichnis|Versandnachweis|__[a-z0-9-]{20,}\.(pdf|png|jpe?g|webp)$/i.test(candidate.name)) continue;
        const existing = await prisma.importedSourceItem.findUnique({ where: { sourceId_sourceKey: { sourceId: id, sourceKey: candidate.key } } });
        if (existing && (!candidate.version || existing.sourceVersion === candidate.version)) continue;
        if (existing) {
          const doc = await prisma.document.findUniqueOrThrow({ where: { id: existing.documentId } });
          if (doc.fileHash !== createHash("sha256").update(candidate.bytes).digest("hex")) throw new Error("Imported source file changed; create an audited invoice revision");
          await prisma.importedSourceItem.update({ where: { id: existing.id }, data: { sourceVersion: candidate.version } });
          continue;
        }
        const document = await persistOriginal(candidate.bytes, candidate.mimeType, candidate.name, source.propertyId);
        if (["billing", "billing_preview"].includes(document.category)) continue;
        const invoice = await prisma.$transaction(async (tx) => {
          let invoice = await tx.costInvoice.findFirst({ where: { propertyId: source.propertyId, status: { not: "DISCARDED" }, OR: [{ documentId: document.id }, { attachments: { some: { documentId: document.id } } }] } });
          if (!invoice) {
            invoice = await tx.costInvoice.create({ data: { propertyId: source.propertyId, costCategoryId: source.costCategoryId, section: source.section, totalAmountCents: 0n, attachments: { create: { documentId: document.id } } } });
            await tx.invoiceExtractionJob.create({ data: { invoiceId: invoice.id, documentId: document.id } });
          }
          await tx.importedSourceItem.create({ data: { sourceId: id, sourceKey: candidate.key, documentId: document.id, invoiceId: invoice.id, sourceVersion: candidate.version } });
          return invoice;
        });
        await queueDocumentArchive(document.id, source.propertyId);
        count += invoice ? 1 : 0;
      }
    }
    cursor = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
    if (typeof page["@odata.deltaLink"] === "string") finalCursor = page["@odata.deltaLink"];
  }
  await prisma.microsoftImportSource.update({ where: { id }, data: { cursor: finalCursor, lastError: null, nextRunAt: new Date(Date.now() + source.intervalMinutes * 60_000) } });
  return { imported: count };
}
