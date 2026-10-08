import { NextResponse } from "next/server";
import { exchangeAuthorizationCode, rotateRefreshToken } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const form = new URLSearchParams(await request.text());
    const grantType = form.get("grant_type");
    const tokens = grantType === "authorization_code"
      ? await exchangeAuthorizationCode(form)
      : grantType === "refresh_token"
        ? await rotateRefreshToken(form)
        : (() => { throw new Error("Unsupported grant_type"); })();
    return NextResponse.json(tokens, { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
  } catch (error) {
    return NextResponse.json({ error: "invalid_grant", error_description: error instanceof Error ? error.message : "Token exchange failed" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
