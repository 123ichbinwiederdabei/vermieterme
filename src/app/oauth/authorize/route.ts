import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { issueAuthorizationCode, validateAuthorizationRequest } from "@/lib/mcp/oauth";
import { mcpBaseUrl } from "@/lib/mcp/config";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  let parsed: Awaited<ReturnType<typeof validateAuthorizationRequest>>;
  try {
    parsed = await validateAuthorizationRequest(params);
  } catch (error) {
    return NextResponse.json({ error: "invalid_request", error_description: error instanceof Error ? error.message : "Invalid authorization request" }, { status: 400 });
  }
  const session = await auth();
  if (!session?.user?.id) {
    const callbackUrl = encodeURIComponent(request.url);
    return NextResponse.redirect(`${mcpBaseUrl()}/login?callbackUrl=${callbackUrl}`);
  }
  if (!session.user.email || session.user.email.toLowerCase() !== process.env.ADMIN_EMAIL?.toLowerCase()) {
    return oauthErrorRedirect(parsed.redirectUri, parsed.state, "access_denied", "Only the configured VermieterMe administrator can authorize MCP access.");
  }
  try {
    const code = await issueAuthorizationCode({ ...parsed, userId: session.user.id });
    const redirect = new URL(parsed.redirectUri);
    redirect.searchParams.set("code", code);
    if (parsed.state) redirect.searchParams.set("state", parsed.state);
    redirect.searchParams.set("iss", mcpBaseUrl());
    return NextResponse.redirect(redirect);
  } catch (error) {
    return oauthErrorRedirect(parsed.redirectUri, parsed.state, "server_error", error instanceof Error ? error.message : "Authorization failed");
  }
}

function oauthErrorRedirect(redirectUri: string, state: string | null, error: string, description: string) {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", error);
  redirect.searchParams.set("error_description", description);
  if (state) redirect.searchParams.set("state", state);
  redirect.searchParams.set("iss", mcpBaseUrl());
  return NextResponse.redirect(redirect);
}
