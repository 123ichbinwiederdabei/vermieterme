import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { invoiceArchivePath, archiveName } from "@/lib/document-paths";
import { categoryCode } from "@/lib/invoice-categories";
import { recordHash } from "@/lib/mcp/entities";
import { MicrosoftGraph } from "@/lib/microsoft-graph";

const extensions: Record<string, string> = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "message/rfc822": ".eml" };
export const uploadsDirectory = () => path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "data", "uploads"));
export function documentFile(fileName: string) {
  if (path.basename(fileName) !== fileName || /[\\/]/.test(fileName)) throw new Error("Invalid stored document filename");
  return path.join(uploadsDirectory(), fileName);
}
export async function persistOriginal(bytes: Buffer, mimeType: string, originalName: string, propertyId: string, category = "invoice") {
  if (!extensions[mimeType] || !bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Unsupported or oversized original document");
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const existing = await prisma.document.findFirst({ where: { fileHash } });
  if (existing) {
    if (existing.propertyId && existing.propertyId !== propertyId) throw new Error("Identical document belongs to another property");
    return existing;
  }
  const fileName = `${randomUUID()}${extensions[mimeType]}`;
  await mkdir(uploadsDirectory(), { recursive: true });
  await writeFile(documentFile(fileName), bytes, { flag: "wx" });
  try {
    const result = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.document.findFirst({ where: { fileHash } });
      if (duplicate) {
        if (duplicate.propertyId && duplicate.propertyId !== propertyId) throw new Error("Identical document belongs to another property");
        return duplicate;
      }
      return tx.document.create({ data: { propertyId, category, fileName, originalName: originalName.slice(0, 255), mimeType, size: bytes.length, fileHash } });
    });
    if (result.fileName !== fileName) await unlink(documentFile(fileName));
    return result;
  } catch (error) { await unlink(documentFile(fileName)).catch(() => undefined); throw error; }
}

export async function enqueueJob(kind: string, dedupeKey: string, payload: Record<string, unknown>) {
  return prisma.backgroundJob.upsert({ where: { dedupeKey }, create: { kind, dedupeKey, payloadJson: JSON.stringify(payload) }, update: {} });
}

export async function queueDocumentArchive(documentId: string, propertyId: string, exactPath?: string) {
  const storage = await prisma.documentStorage.findUnique({ where: { propertyId } });
  if (!storage?.enabled) return null;
  const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  const bytes = await readFile(documentFile(document.fileName));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (document.fileHash && sha256 !== document.fileHash) throw new Error("Stored original hash mismatch");
  if (document.propertyId && document.propertyId !== propertyId) throw new Error("Original belongs to another property");
  if (!document.fileHash || !document.propertyId) await prisma.document.update({ where: { id: document.id }, data: { fileHash: sha256, propertyId } });
  const invoice = await prisma.costInvoice.findFirst({ where: { propertyId, OR: [{ documentId }, { attachments: { some: { documentId } } }], revisions: { none: { status: "CONFIRMED" } } }, include: { costCategory: true }, orderBy: { confirmedAt: "desc" } });
  const relativePath = exactPath || (["contract", "lease", "stammdaten"].includes(document.category) ? `${storage.objectFolder}/Vertraege_und_Stammdaten/${archiveName(path.parse(document.originalName).name)}__${archiveName(documentId)}${path.extname(document.fileName)}` : invoiceArchivePath({ objectFolder: storage.objectFolder, documentId, extension: path.extname(document.fileName), invoice: invoice ? { ...invoice, code: categoryCode(invoice.costCategory), categoryName: invoice.costCategory.name } : undefined }));
  const prior = await prisma.documentArchive.findUnique({ where: { documentId } });
  if (!exactPath && prior?.relativePath.includes("/Rechnungen/")) return prior;
  if (prior?.status === "VERIFIED" && prior.relativePath === relativePath && prior.sha256 === sha256) return prior;
  const archive = await prisma.documentArchive.upsert({ where: { documentId }, create: { documentId, storageId: storage.id, relativePath, sha256, size: bytes.length }, update: { relativePath, sha256, size: bytes.length, status: "PENDING", error: null } });
  const key = `archive:${archive.id}`;
  const job = await prisma.backgroundJob.findUnique({ where: { dedupeKey: key } });
  await prisma.backgroundJob.upsert({ where: { dedupeKey: key }, create: { kind: "ARCHIVE", dedupeKey: key, payloadJson: JSON.stringify({ archiveId: archive.id }) }, update: job?.status === "PROCESSING" ? {} : { status: "QUEUED", attempts: 0, availableAt: new Date(), error: null } });
  return archive;
}

export async function processArchive(archiveId: string, graph = new MicrosoftGraph()) {
  const archive = await prisma.documentArchive.findUniqueOrThrow({ where: { id: archiveId }, include: { document: true } });
  const storage = await prisma.documentStorage.findUniqueOrThrow({ where: { id: archive.storageId } });
  if (!storage.enabled) throw new Error("Document storage is disabled");
  const bytes = await readFile(documentFile(archive.document.fileName));
  if (bytes.length !== archive.size || createHash("sha256").update(bytes).digest("hex") !== archive.sha256) throw new Error("Original size or hash mismatch");
  let itemId: string;
  if (archive.itemId) itemId = await graph.moveImmutable(storage.driveId, storage.rootItemId, archive.itemId, archive.relativePath, archive.sha256);
  else itemId = await graph.uploadImmutable(storage.driveId, storage.rootItemId, archive.relativePath, bytes);
  // A classification may change the desired path while a staging upload runs.
  // Retain the uploaded item ID but verify only the path actually processed.
  const current = await prisma.documentArchive.findUniqueOrThrow({ where: { id: archive.id } });
  await prisma.documentArchive.update({ where: { id: archive.id }, data: { itemId, status: current.relativePath === archive.relativePath ? "VERIFIED" : "PENDING", error: null } });
  return itemId;
}

export async function retryDocumentArchive(documentId: string) {
  const archive = await prisma.documentArchive.findUniqueOrThrow({ where: { documentId } });
  await prisma.documentArchive.update({ where: { id: archive.id }, data: { status: "PENDING", error: null } });
  const job = await prisma.backgroundJob.findUnique({ where: { dedupeKey: `archive:${archive.id}` } });
  if (job?.status === "PROCESSING" && job.leaseUntil && job.leaseUntil > new Date()) throw new Error("Archive job is already running");
  return prisma.backgroundJob.upsert({ where: { dedupeKey: `archive:${archive.id}` }, create: { kind: "ARCHIVE", dedupeKey: `archive:${archive.id}`, payloadJson: JSON.stringify({ archiveId: archive.id }) }, update: { status: "QUEUED", attempts: 0, availableAt: new Date(), leaseUntil: null, leaseToken: null, error: null } });
}

export async function testDocumentStorage(propertyId: string, graph = new MicrosoftGraph()) {
  const storage = await prisma.documentStorage.findUniqueOrThrow({ where: { propertyId } });
  const folder = await graph.request(`drives/${encodeURIComponent(storage.driveId)}/items/${encodeURIComponent(storage.rootItemId)}`);
  if (!folder.folder) throw new Error("OneDrive-Ziel muss ein Ordner sein");
  await prisma.documentStorage.update({ where: { propertyId }, data: { testedAt: new Date(), testedFingerprint: recordHash({ propertyId, driveId: storage.driveId, rootItemId: storage.rootItemId, objectFolder: storage.objectFolder }) } });
  return { propertyId, driveId: storage.driveId, rootItemId: storage.rootItemId, accessible: true, name: folder.name, writeVerification: "First approved upload must pass full byte verification" };
}
export async function resolveOneDriveTarget(mailbox: string, folderPath: string, graph = new MicrosoftGraph()) {
  if (folderPath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid folder path");
  const response = await graph.request(`users/${encodeURIComponent(mailbox)}/drives`);
  const drives = (response.value || []) as Array<{ id: string; name: string }>;
  const targets = [];
  for (const drive of drives) {
    try {
      const item = await graph.request(`drives/${encodeURIComponent(drive.id)}/root:/${folderPath.split("/").map(encodeURIComponent).join("/")}`);
      if (item.folder) targets.push({ driveId: drive.id, driveName: drive.name, rootItemId: String(item.id), path: folderPath, children: (await graph.request(`drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(String(item.id))}/children?$select=id,name,folder,file,size`)).value });
    } catch (error) { if (!(error instanceof Error) || !error.message.includes("(404)")) throw error; }
  }
  return { targets, instruction: "Select exact drive and folder IDs after reviewing cloud contents; no folders created" };
}


export async function queuePropertyOriginals(propertyId: string) {
  const storage = await prisma.documentStorage.findUniqueOrThrow({ where: { propertyId } });
  if (!storage.enabled) throw new Error("Ausgewähltes Archivziel muss ausdrücklich aktiviert sein");
  const documents = await prisma.document.findMany({ where: { category: { notIn: ["billing", "billing_preview"] }, OR: [{ propertyId }, { tenant: { unit: { propertyId } } }, { billingPeriod: { propertyId } }, { costInvoice: { propertyId } }, { invoiceAttachments: { some: { invoice: { propertyId } } } }] }, select: { id: true } });
  const results = [];
  for (const doc of documents) {
    try { const archive = await queueDocumentArchive(doc.id, propertyId); results.push({ documentId: doc.id, archiveId: archive?.id, status: archive?.status }); }
    catch (error) { results.push({ documentId: doc.id, status: "REVIEW_REQUIRED", error: error instanceof Error ? error.message : "Original prüfen" }); }
  }
  return { propertyId, documents: results };
}
