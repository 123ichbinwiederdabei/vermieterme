export const MCP_SCOPES = [
  "vermieterme:read",
  "vermieterme:write",
  "vermieterme:admin",
  "vermieterme:approve",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function mcpBaseUrl() {
  const configured = process.env.MCP_BASE_URL?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MCP_BASE_URL is required in production");
    }
    return "http://localhost:3000";
  }
  const parsed = new URL(configured);
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("MCP_BASE_URL must use HTTPS in production");
  }
  return stripTrailingSlash(parsed.toString());
}

export function mcpResource() {
  return `${mcpBaseUrl()}/mcp`;
}

export function mcpSigningSecret() {
  const value = process.env.MCP_SIGNING_SECRET?.trim();
  if (!value || value.length < 32) {
    if (process.env.NODE_ENV === "test") return new TextEncoder().encode("test-only-mcp-signing-secret-32-bytes");
    throw new Error("MCP_SIGNING_SECRET must contain at least 32 characters");
  }
  return new TextEncoder().encode(value);
}

export function parseScopes(value: string | null | undefined): McpScope[] {
  const requested = (value || "vermieterme:read").split(/\s+/).filter(Boolean);
  const invalid = requested.filter((scope) => !MCP_SCOPES.includes(scope as McpScope));
  if (invalid.length) throw new Error(`Unsupported scope: ${invalid.join(", ")}`);
  return [...new Set(requested)] as McpScope[];
}

export function requireMcpScope(scopes: string[], required: McpScope) {
  if (!scopes.includes(required)) {
    throw new McpScopeError(required);
  }
}

export class McpScopeError extends Error {
  constructor(public required: McpScope) { super(`Missing required scope: ${required}`); }
}
