import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { issueAuthorizationCode, validateAuthorizationRequest } from "@/lib/mcp/oauth";
import { SignJWT, jwtVerify } from "jose";
import { mcpBaseUrl, mcpSigningSecret } from "@/lib/mcp/config";

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
  const consent = await new SignJWT({ params: params.toString() }).setProtectedHeader({ alg: "HS256" }).setIssuer(mcpBaseUrl()).setSubject(session.user.id).setAudience("vermieterme:oauth-consent").setIssuedAt().setExpirationTime("5m").sign(mcpSigningSecret());
  const labels: Record<string, string> = { "vermieterme:read": "Daten und Belege lesen", "vermieterme:write": "Entwurfe, Berechnungen und bestatigte Stammdaten speichern", "vermieterme:approve": "Bestatigte Abrechnungen freigeben und versenden", "vermieterme:admin": "Microsoft-Quellen, Ablage und Zugang verwalten" };
  const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  return new Response(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VermieterMe Zugriff bestatigen</title><body><main><h1>ChatGPT-Zugriff bestatigen</h1><p>Client: ${escape(parsed.clientId)}</p><p>Diese Berechtigungen werden ausdrucklich erteilt:</p><ul>${parsed.scopes.map((scope) => `<li>${escape(labels[scope])}</li>`).join("")}</ul><p>Stammdaten, Freigabe und Versand benotigen zusatzlich eine konkrete Vorschau und Ihre Bestatigung im Chat.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="consent" value="${escape(consent)}"><button name="decision" value="approve">Diese Rechte erteilen</button><button name="decision" value="deny">Abbrechen</button></form></main></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });

}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id || session.user.email?.toLowerCase() !== process.env.ADMIN_EMAIL?.toLowerCase()) return new Response("Forbidden", { status: 403 });
  try {
    const form = await request.formData();
    const { payload } = await jwtVerify(String(form.get("consent") || ""), mcpSigningSecret(), { issuer: mcpBaseUrl(), audience: "vermieterme:oauth-consent", algorithms: ["HS256"] });
    if (payload.sub !== session.user.id || typeof payload.params !== "string") throw new Error("Invalid consent");
    const parsed = await validateAuthorizationRequest(new URLSearchParams(payload.params));
    if (form.get("decision") !== "approve") return oauthErrorRedirect(parsed.redirectUri, parsed.state, "access_denied", "Authorization declined");
    const code = await issueAuthorizationCode({ ...parsed, userId: session.user.id });
    const redirect = new URL(parsed.redirectUri);
    redirect.searchParams.set("code", code); if (parsed.state) redirect.searchParams.set("state", parsed.state); redirect.searchParams.set("iss", mcpBaseUrl());
    return NextResponse.redirect(redirect, 303);
  } catch { return new Response("Invalid or expired authorization consent", { status: 400 }); }
}

function oauthErrorRedirect(redirectUri: string, state: string | null, error: string, description: string) {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", error);
  redirect.searchParams.set("error_description", description);
  if (state) redirect.searchParams.set("state", state);
  redirect.searchParams.set("iss", mcpBaseUrl());
  return NextResponse.redirect(redirect);
}
