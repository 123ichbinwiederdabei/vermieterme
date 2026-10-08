import { revokeToken } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const form = new URLSearchParams(await request.text());
  const token = form.get("token");
  if (token) await revokeToken(token);
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
