import { randomUUID } from "crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createVermieterMeMcpServer } from "@/lib/mcp/server";
import { mcpBaseUrl, mcpResource } from "@/lib/mcp/config";
import { verifyAccessToken } from "@/lib/mcp/crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function challenge() {
  const metadata = `${mcpBaseUrl()}/.well-known/oauth-protected-resource`;
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${metadata}", scope="vermieterme:read"` },
  });
}

async function handle(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return challenge();
  const token = authorization.slice(7);
  let identity;
  try { identity = await verifyAccessToken(token); }
  catch (error) {
    console.warn("MCP authorization failed", error instanceof Error ? error.message : "unknown error");
    return challenge();
  }
  const requestId = request.headers.get("x-request-id") || randomUUID();
  const server = createVermieterMeMcpServer(identity, requestId);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request, { authInfo: {
    token, clientId: identity.clientId, scopes: identity.scopes,
    expiresAt: identity.expiresAt, resource: new URL(mcpResource()), extra: { userId: identity.userId, email: identity.email, requestId },
  }});
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
