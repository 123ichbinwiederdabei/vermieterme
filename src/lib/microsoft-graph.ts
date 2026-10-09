import { createHash } from "node:crypto";

type GraphObject = Record<string, unknown>;
export class MicrosoftGraphError extends Error {
  constructor(public status: number, public retryAfterSeconds = 0) { super(`Microsoft Graph request failed (${status})`); }
}
let cached: { token: string; expires: number } | undefined;

async function graphToken(): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const client = process.env.Application_client_ID;
  const tenant = process.env.Directory_tenant_ID;
  const secret = process.env.CLIENT_SECRET_VALUE;
  if (!client || !tenant || !secret) throw new Error("Microsoft Graph runtime secrets are not configured");
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client, client_secret: secret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new MicrosoftGraphError(response.status);
  const result = await response.json();
  if (typeof result.access_token !== "string") throw new Error("Microsoft token response is incomplete");
  cached = { token: result.access_token, expires: Date.now() + Number(result.expires_in) * 1000 };
  return cached.token;
}

export class MicrosoftGraph {
  constructor(private tokenProvider: () => Promise<string> = graphToken) {}
  async request(endpoint: string, method = "GET", body?: unknown): Promise<GraphObject> {
    const url = new URL(endpoint, "https://graph.microsoft.com/v1.0/");
    if (url.origin !== "https://graph.microsoft.com" || !url.pathname.startsWith("/v1.0/")) throw new Error("Invalid Microsoft Graph endpoint");
    const response = await fetch(url, {
      method, headers: { Authorization: `Bearer ${await this.tokenProvider()}`, "Content-Type": "application/json", Prefer: 'IdType="ImmutableId"' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) throw new MicrosoftGraphError(response.status, Number(response.headers.get("Retry-After") || 0));
    return response.status === 204 || response.status === 202 ? {} : await response.json();
  }
  async download(driveId: string, itemId: string): Promise<Buffer> {
    const item = await this.request(`drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`);
    if (!item.file || Number(item.size) > 10 * 1024 * 1024) throw new Error("Not a supported file or file exceeds 10 MB");
    const url = new URL(String(item["@microsoft.graph.downloadUrl"]));
    if (url.protocol !== "https:") throw new Error("Invalid Microsoft download URL");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new MicrosoftGraphError(response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== Number(item.size) || bytes.length > 10 * 1024 * 1024) throw new Error("Microsoft download size mismatch");
    return bytes;
  }
  async ensureFolder(driveId: string, parentId: string, name: string): Promise<string> {
    const base = `drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}`;
    try {
      const item = await this.request(`${base}:/${encodeURIComponent(name)}`);
      if (!item.folder) throw new Error("Archive path is occupied by a file");
      return String(item.id);
    } catch (error) {
      if (!(error instanceof MicrosoftGraphError) || error.status !== 404) throw error;
    }
    try {
      const item = await this.request(`${base}/children`, "POST", { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
      return String(item.id);
    } catch (error) {
      if (!(error instanceof MicrosoftGraphError) || error.status !== 409) throw error;
      const item = await this.request(`${base}:/${encodeURIComponent(name)}`);
      if (!item.folder) throw new Error("Archive path is occupied by a file");
      return String(item.id);
    }
  }
  async uploadImmutable(driveId: string, rootId: string, relativePath: string, bytes: Buffer): Promise<string> {
    const parts = relativePath.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || /[\\:]/.test(part))) throw new Error("Invalid archive path");
    const name = parts.pop()!;
    let parent = rootId;
    for (const folder of parts) parent = await this.ensureFolder(driveId, parent, folder);
    const base = `drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}`;
    const verify = async (id: string) => {
      const actual = await this.download(driveId, id);
      if (createHash("sha256").update(actual).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw new Error("Archive file already exists with different bytes");
      return id;
    };
    try { const item = await this.request(base); return await verify(String(item.id)); }
    catch (error) { if (!(error instanceof MicrosoftGraphError) || error.status !== 404) throw error; }
    const session = await this.request(`${base}:/createUploadSession`, "POST", { item: { "@microsoft.graph.conflictBehavior": "fail", name } });
    const uploadUrl = new URL(String(session.uploadUrl));
    if (uploadUrl.protocol !== "https:") throw new Error("Invalid upload session URL");
    let itemId = "";
    const chunkSize = 10 * 320 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      const response = await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(chunk), headers: { "Content-Length": String(chunk.length), "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${bytes.length}` }, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new MicrosoftGraphError(response.status);
      const result = await response.json();
      if (result.id) itemId = String(result.id);
    }
    if (!itemId) throw new Error("Upload session did not return a file identifier");
    return verify(itemId);
  }
  async createMailDraft(mailbox: string, recipient: string, subject: string, bodyText: string, fileName: string, bytes: Buffer): Promise<string> {
    const base = `users/${encodeURIComponent(mailbox)}/messages`;
    const inline = bytes.length < 3 * 1024 * 1024;
    const item = await this.request(base, "POST", { subject, body: { contentType: "Text", content: bodyText }, toRecipients: [{ emailAddress: { address: recipient } }], ...(inline ? { attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: fileName, contentType: "application/pdf", contentBytes: bytes.toString("base64") }] } : {}) });
    if (!item.id) throw new Error("Microsoft draft identifier missing");
    if (!inline) {
      const session = await this.request(`${base}/${encodeURIComponent(String(item.id))}/attachments/createUploadSession`, "POST", { AttachmentItem: { attachmentType: "file", name: fileName, size: bytes.length, contentType: "application/pdf" } });
      const url = new URL(String(session.uploadUrl));
      if (url.protocol !== "https:") throw new Error("Invalid attachment upload URL");
      const chunkSize = 10 * 320 * 1024;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        const response = await fetch(url, { method: "PUT", body: new Uint8Array(chunk), headers: { "Content-Length": String(chunk.length), "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${bytes.length}` }, signal: AbortSignal.timeout(60_000), redirect: "error" });
        if (!response.ok) throw new MicrosoftGraphError(response.status);
      }
    }
    return String(item.id);
  }
  async moveImmutable(driveId: string, rootId: string, itemId: string, relativePath: string, sha256: string): Promise<string> {
    const bytes = await this.download(driveId, itemId);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Archived original hash mismatch");
    const parts = relativePath.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || /[\\:]/.test(part))) throw new Error("Invalid archive path");
    const name = parts.pop()!;
    let parent = rootId;
    for (const folder of parts) parent = await this.ensureFolder(driveId, parent, folder);
    try {
      const target = await this.request(`drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}`);
      if (String(target.id) !== itemId) throw new Error("Final archive path is already occupied; revision cannot overwrite it");
    } catch (error) { if (!(error instanceof MicrosoftGraphError) || error.status !== 404) throw error; }
    await this.request(`drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`, "PATCH", { name, parentReference: { id: parent }, "@microsoft.graph.conflictBehavior": "fail" });
    if (createHash("sha256").update(await this.download(driveId, itemId)).digest("hex") !== sha256) throw new Error("Moved original hash mismatch");
    return itemId;
  }
}
