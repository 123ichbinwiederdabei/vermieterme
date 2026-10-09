import path from "node:path";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { documentFile } from "@/lib/document-archive";
import { mcpBaseUrl, mcpSigningSecret } from "@/lib/mcp/config";

const audience = "vermieterme:document-download";
export async function documentDownload(documentId: string) {
  const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId }, include: { archive: true } });
  const bytes = await readFile(documentFile(document.fileName));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (!document.fileHash || document.fileHash !== hash) throw new Error("Original document checksum is missing or changed");
  const token = await new SignJWT({ hash }).setProtectedHeader({ alg: "HS256" }).setIssuer(mcpBaseUrl()).setAudience(audience).setSubject(documentId).setIssuedAt().setExpirationTime("10m").sign(mcpSigningSecret());
  return { download_url: `${mcpBaseUrl()}/api/document-download?token=${encodeURIComponent(token)}`, file_id: document.id, file_name: downloadName(document), mime_type: document.mimeType, sha256: hash, expiresInSeconds: 600 };
}
export async function downloadedDocument(token: string) {
  const { payload } = await jwtVerify(token, mcpSigningSecret(), { issuer: mcpBaseUrl(), audience, algorithms: ["HS256"] });
  if (!payload.sub || typeof payload.hash !== "string") throw new Error("Invalid document grant");
  const document = await prisma.document.findUniqueOrThrow({ where: { id: payload.sub }, include: { archive: true } });
  const bytes = await readFile(documentFile(document.fileName));
  if (document.fileHash !== payload.hash || createHash("sha256").update(bytes).digest("hex") !== payload.hash) throw new Error("Document hash mismatch");
  return { document, bytes, downloadName: downloadName(document) };
}

function downloadName(document: { category: string; originalName: string; archive: { relativePath: string } | null }) {
  return document.category.startsWith("billing") && document.archive?.relativePath.includes("/Freigegeben/") ? path.posix.basename(document.archive.relativePath) : document.originalName;
}
