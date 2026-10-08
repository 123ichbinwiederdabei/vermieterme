export function GET() {
  return new Response("VermieterMe private MCP server. OAuth 2.1 with PKCE is required. Access is restricted to the configured administrator.", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
