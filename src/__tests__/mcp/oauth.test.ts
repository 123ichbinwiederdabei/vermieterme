import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientCreate: vi.fn(), clientFind: vi.fn(), codeCreate: vi.fn(), codeFind: vi.fn(), codeUpdateMany: vi.fn(),
  refreshCreate: vi.fn(), refreshFind: vi.fn(), refreshUpdate: vi.fn(), refreshUpdateMany: vi.fn(), userFind: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {
  mcpOAuthClient: { create: mocks.clientCreate, findUnique: mocks.clientFind },
  mcpAuthorizationCode: { create: mocks.codeCreate, findUnique: mocks.codeFind, updateMany: mocks.codeUpdateMany },
  mcpRefreshToken: { create: mocks.refreshCreate, findUnique: mocks.refreshFind, update: mocks.refreshUpdate, updateMany: mocks.refreshUpdateMany },
  user: { findUnique: mocks.userFind },
}}));

import { exchangeAuthorizationCode, oauthMetadata, protectedResourceMetadata, registerClient, rotateRefreshToken, validateAuthorizationRequest } from "@/lib/mcp/oauth";
import { sha256 } from "@/lib/mcp/crypto";

describe("MCP OAuth 2.1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_BASE_URL = "https://mieter.example.test";
    process.env.MCP_SIGNING_SECRET = "a-test-secret-that-is-definitely-long-enough";
    process.env.ADMIN_EMAIL = "admin@example.test";
  });

  it("publishes resource-bound OAuth metadata with PKCE S256", () => {
    expect(oauthMetadata()).toMatchObject({ code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    expect(protectedResourceMetadata()).toMatchObject({ resource: "https://mieter.example.test/mcp", authorization_servers: ["https://mieter.example.test"] });
  });

  it("registers only public clients with valid redirect URLs", async () => {
    mocks.clientCreate.mockImplementation(({ data }) => ({ ...data, createdAt: new Date("2026-09-19T00:00:00Z") }));
    await expect(registerClient({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "none" }))
      .resolves.toMatchObject({ client_name: "ChatGPT", token_endpoint_auth_method: "none" });
    await expect(registerClient({ redirect_uris: ["http://attacker.example/callback"] })).rejects.toThrow(/redirect_uris/);
  });

  it("requires exact registered redirect, resource, and PKCE S256", async () => {
    mocks.clientFind.mockResolvedValue({ id: "c1", redirectUrisJson: JSON.stringify(["https://chatgpt.com/callback"]) });
    const params = new URLSearchParams({ response_type: "code", client_id: "c1", redirect_uri: "https://chatgpt.com/callback", code_challenge: "challenge", code_challenge_method: "S256", resource: "https://mieter.example.test/mcp", scope: "vermieterme:read" });
    await expect(validateAuthorizationRequest(params)).resolves.toMatchObject({ clientId: "c1", scopes: ["vermieterme:read"] });
    params.set("redirect_uri", "https://evil.example/callback");
    await expect(validateAuthorizationRequest(params)).rejects.toThrow(/redirect URI/);
  });

  it("consumes an authorization code only once", async () => {
    const verifier = "a-long-enough-pkce-verifier";
    mocks.codeFind.mockResolvedValue({
      id: "code1", clientId: "c1", userId: "u1", redirectUri: "https://chatgpt.com/callback",
      scopesJson: JSON.stringify(["vermieterme:read"]), resource: "https://mieter.example.test/mcp",
      codeChallenge: sha256(verifier), consumedAt: null, expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.codeUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mocks.userFind.mockResolvedValue({ id: "u1", email: "admin@example.test" });
    mocks.refreshCreate.mockResolvedValue({});
    const form = new URLSearchParams({ code: "raw-code", client_id: "c1", redirect_uri: "https://chatgpt.com/callback", code_verifier: verifier });
    await expect(exchangeAuthorizationCode(form)).resolves.toMatchObject({ token_type: "Bearer" });
    await expect(exchangeAuthorizationCode(form)).rejects.toThrow(/already used/);
  });

  it("rotates refresh tokens and rejects replay", async () => {
    mocks.refreshFind.mockResolvedValue({
      id: "refresh1", clientId: "c1", userId: "u1", scopesJson: JSON.stringify(["vermieterme:read"]),
      resource: "https://mieter.example.test/mcp", revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.refreshUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mocks.refreshUpdate.mockResolvedValue({});
    mocks.refreshCreate.mockResolvedValue({});
    mocks.userFind.mockResolvedValue({ id: "u1", email: "admin@example.test" });
    const form = new URLSearchParams({ refresh_token: "raw-refresh", client_id: "c1" });
    await expect(rotateRefreshToken(form)).resolves.toMatchObject({ token_type: "Bearer" });
    await expect(rotateRefreshToken(form)).rejects.toThrow(/already used/);
  });
});
