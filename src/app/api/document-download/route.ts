import { downloadedDocument } from "@/lib/document-download";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const { bytes, document, downloadName } = await downloadedDocument(new URL(request.url).searchParams.get("token") || "");
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": document.mimeType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response("Invalid or expired document link", { status: 403 }); }
}
