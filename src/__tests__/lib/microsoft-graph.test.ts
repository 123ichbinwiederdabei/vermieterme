// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { MicrosoftGraph, MicrosoftGraphError } from "@/lib/microsoft-graph";
const graph = new MicrosoftGraph(async () => "test-token");
afterEach(() => vi.unstubAllGlobals());
it("rejects foreign delta endpoints without forwarding credentials", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(graph.request("https://foreign.example/v1.0/messages")).rejects.toThrow("Invalid Microsoft Graph endpoint");
  expect(fetch).not.toHaveBeenCalled();
});
it("retains rate-limit retry hints and never includes provider bodies in errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sensitive provider detail", { status: 429, headers: { "Retry-After": "90" } })));
  await expect(graph.request("drives/drive")).rejects.toMatchObject({ status: 429, retryAfterSeconds: 90 });
  try { await graph.request("drives/drive"); } catch (error) { expect(String(error)).not.toContain("sensitive"); }
});
it("verifies size and SHA-256 for idempotent uploads and refuses changed originals", async () => {
  const bytes = Buffer.from("original invoice bytes");
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).startsWith("https://graph.microsoft.com") ? Response.json({ id: "original", size: bytes.length, file: {}, "@microsoft.graph.downloadUrl": "https://download.example/original" }) : new Response(new Uint8Array(bytes))));
  expect(await graph.uploadImmutable("drive", "root", "invoice.pdf", bytes)).toBe("original");
  await expect(graph.uploadImmutable("drive", "root", "invoice.pdf", Buffer.from("changed bytes"))).rejects.toThrow("different bytes");
});
it("propagates interrupted upload sessions so the persistent job can retry safely", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init?: RequestInit) => {
    if (init?.method === "PUT") return new Response("", { status: 503 });
    if (String(url).endsWith("/createUploadSession")) return Response.json({ uploadUrl: "https://upload.example/session" });
    return new Response("", { status: 404 });
  }));
  await expect(graph.uploadImmutable("drive", "root", "invoice.pdf", Buffer.from("original"))).rejects.toBeInstanceOf(MicrosoftGraphError);
});
it("creates a draft and uploads large attachments before any send", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
    requests.push(String(url));
    if (String(url).endsWith("createUploadSession")) return Response.json({ uploadUrl: "https://upload.example/mail" });
    if (String(url).includes("upload.example")) return new Response(null, { status: 201 });
    return Response.json({ id: "draft-id" });
  }));
  expect(await graph.createMailDraft("mailbox", "recipient", "subject", "body", "billing.pdf", Buffer.alloc(4 * 1024 * 1024))).toBe("draft-id");
  expect(requests.some((url) => url.endsWith("/send"))).toBe(false);
  expect(requests.filter((url) => url.includes("upload.example"))).toHaveLength(2);
});
