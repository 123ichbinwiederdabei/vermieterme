import { readFile } from "node:fs/promises";
import path from "node:path";
import { apiHandler, requireAuth } from "@/lib/api-utils";
export function GET() {
  return apiHandler(async () => {
    await requireAuth();
    const bytes = await readFile(
      path.join(
        process.cwd(),
        "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
      ),
    );
    return new Response(bytes, {
      headers: {
        "Content-Type": "text/javascript",
        "Cache-Control": "private, max-age=86400",
      },
    });
  });
}
