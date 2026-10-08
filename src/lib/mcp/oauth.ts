import { prisma } from "@/lib/prisma";
import { mcpBaseUrl, mcpResource, MCP_SCOPES, parseScopes } from "./config";
import { randomToken, sha256, signAccessToken } from "./crypto";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function oauthMetadata() {
  const base = mcpBaseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...MCP_SCOPES],
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [mcpBaseUrl()],
    scopes_supported: [...MCP_SCOPES],
    resource_documentation: `${mcpBaseUrl()}/mcp/docs`,
  };
}

export async function registerClient(input: Record<string, unknown>) {
  const redirectUris = Array.isArray(input.redirect_uris)
    ? input.redirect_uris.filter((uri): uri is string => typeof uri === "string")
    : [];
  if (!redirectUris.length || redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
    throw new Error("redirect_uris must contain valid HTTPS or loopback callback URLs");
  }
  const method = String(input.token_endpoint_auth_method || "none");
  if (method !== "none") throw new Error("Only public PKCE clients are supported");
  const clientId = randomToken(24);
  const client = await prisma.mcpOAuthClient.create({
    data: {
      id: clientId,
      name: typeof input.client_name === "string" ? input.client_name.slice(0, 200) : null,
      redirectUrisJson: JSON.stringify(redirectUris),
      tokenEndpointAuthMethod: method,
    },
  });
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

function isAllowedRedirectUri(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      ((url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") && url.protocol === "http:");
  } catch {
    return false;
  }
}

export async function validateAuthorizationRequest(params: URLSearchParams) {
  if (params.get("response_type") !== "code") throw new Error("Only response_type=code is supported");
  const clientId = required(params, "client_id");
  const redirectUri = required(params, "redirect_uri");
  const codeChallenge = required(params, "code_challenge");
  if (params.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 is required");
  const resource = required(params, "resource");
  if (resource !== mcpResource()) throw new Error("Invalid resource");
  const client = await prisma.mcpOAuthClient.findUnique({ where: { id: clientId } });
  if (!client || !(JSON.parse(client.redirectUrisJson) as string[]).includes(redirectUri)) {
    throw new Error("Unknown client or redirect URI");
  }
  return {
    clientId,
    redirectUri,
    codeChallenge,
    scopes: parseScopes(params.get("scope")),
    resource,
    state: params.get("state"),
  };
}

function required(params: URLSearchParams, name: string) {
  const value = params.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function issueAuthorizationCode(input: Awaited<ReturnType<typeof validateAuthorizationRequest>> & { userId: string }) {
  const code = randomToken(32);
  await prisma.mcpAuthorizationCode.create({
    data: {
      codeHash: sha256(code), clientId: input.clientId, userId: input.userId,
      redirectUri: input.redirectUri, scopesJson: JSON.stringify(input.scopes),
      resource: input.resource, codeChallenge: input.codeChallenge,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    },
  });
  return code;
}

export async function exchangeAuthorizationCode(form: URLSearchParams) {
  const code = required(form, "code");
  const clientId = required(form, "client_id");
  const redirectUri = required(form, "redirect_uri");
  const verifier = required(form, "code_verifier");
  const record = await prisma.mcpAuthorizationCode.findUnique({ where: { codeHash: sha256(code) } });
  if (!record || record.clientId !== clientId || record.redirectUri !== redirectUri ||
      record.consumedAt || record.expiresAt <= new Date() || sha256(verifier) !== record.codeChallenge) {
    throw new Error("Invalid or expired authorization code");
  }
  const consumed = await prisma.mcpAuthorizationCode.updateMany({
    where: { id: record.id, consumedAt: null }, data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) throw new Error("Authorization code already used");
  const scopes = JSON.parse(record.scopesJson) as string[];
  return issueTokenPair(record.userId, clientId, scopes, record.resource);
}

export async function rotateRefreshToken(form: URLSearchParams) {
  const raw = required(form, "refresh_token");
  const clientId = required(form, "client_id");
  const current = await prisma.mcpRefreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!current || current.clientId !== clientId || current.revokedAt || current.expiresAt <= new Date()) {
    throw new Error("Invalid or expired refresh token");
  }
  const claimed = await prisma.mcpRefreshToken.updateMany({
    where: { id: current.id, revokedAt: null }, data: { revokedAt: new Date() },
  });
  if (claimed.count !== 1) throw new Error("Refresh token already used");
  const replacement = await issueTokenPair(current.userId, clientId, JSON.parse(current.scopesJson), current.resource);
  await prisma.mcpRefreshToken.update({
    where: { id: current.id }, data: { replacedBy: sha256(replacement.refresh_token) },
  });
  return replacement;
}

async function issueTokenPair(userId: string, clientId: string, scopes: string[], resource: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email || user.email.toLowerCase() !== process.env.ADMIN_EMAIL?.toLowerCase()) {
    throw new Error("The authorizing administrator is no longer eligible");
  }
  const refreshToken = randomToken(48);
  await prisma.mcpRefreshToken.create({ data: {
    tokenHash: sha256(refreshToken), clientId, userId, scopesJson: JSON.stringify(scopes), resource,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  }});
  return {
    access_token: await signAccessToken({ userId, email: user.email, clientId, scopes, resource }),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  };
}

export async function revokeToken(raw: string) {
  await prisma.mcpRefreshToken.updateMany({
    where: { tokenHash: sha256(raw), revokedAt: null }, data: { revokedAt: new Date() },
  });
}
