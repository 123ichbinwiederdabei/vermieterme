import { beforeEach, describe, expect, it } from "vitest";
import { signAccessToken, signMutationToken, verifyAccessToken, verifyMutationToken } from "@/lib/mcp/crypto";

describe("MCP signed tokens", () => {
  beforeEach(() => {
    process.env.MCP_BASE_URL = "http://localhost:3000";
    process.env.MCP_SIGNING_SECRET = "a-test-secret-that-is-definitely-long-enough";
    process.env.ADMIN_EMAIL = "admin@example.test";
  });

  it("round-trips scoped access-token claims", async () => {
    const token = await signAccessToken({ userId: "u1", email: "admin@example.test", clientId: "c1", scopes: ["vermieterme:read"], resource: "http://localhost:3000/mcp" });
    await expect(verifyAccessToken(token)).resolves.toMatchObject({ userId: "u1", clientId: "c1", scopes: ["vermieterme:read"] });
  });

  it("rejects access when the configured administrator changes", async () => {
    const token = await signAccessToken({ userId: "u1", email: "admin@example.test", clientId: "c1", scopes: ["vermieterme:read"], resource: "http://localhost:3000/mcp" });
    process.env.ADMIN_EMAIL = "different@example.test";
    await expect(verifyAccessToken(token)).rejects.toThrow(/administrator/);
  });

  it("binds mutation grants to user, entity, record hash, and cascade preview", async () => {
    const token = await signMutationToken({ userId: "u1", entityType: "Property", itemRef: "opaque", rowHash: "hash", cascade: { Unit: 2 } });
    await expect(verifyMutationToken(token)).resolves.toMatchObject({ userId: "u1", entityType: "Property", itemRef: "opaque", rowHash: "hash", cascade: { Unit: 2 } });
  });
});
