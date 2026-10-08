import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  decodeItemRef, describeEntityType, encodeItemRef, listEntityTypes, recordHash, sanitizeRecord,
} from "@/lib/mcp/entities";

describe("MCP entity policy registry", () => {
  it("discovers every Prisma model and defaults internal models to protected read-only access", () => {
    const entities = listEntityTypes();
    expect(entities.map((entity) => entity.name)).toContain("Property");
    expect(entities.map((entity) => entity.name)).toContain("McpAuditEvent");
    expect(entities.find((entity) => entity.name === "BillingSnapshot")).toMatchObject({ readable: true, update: false, delete: false, protected: true });
    expect(entities.find((entity) => entity.name === "Property")).toMatchObject({ create: true, update: true, delete: true });
  });

  it("describes exact fields while marking secrets non-writable", () => {
    const user = describeEntityType("User");
    const password = user.fields.find((field) => field.name === "password");
    expect(password).toMatchObject({ secret: true, writable: false });
  });

  it("round-trips opaque references including composite identifiers", () => {
    const itemRef = encodeItemRef("HeatingSystemUnit", { heatingSystemId: "hs1", unitId: "u1" });
    expect(decodeItemRef(itemRef)).toEqual({ entityType: "HeatingSystemUnit", key: { heatingSystemId: "hs1", unitId: "u1" } });
  });

  it("redacts nested secrets and serializes exact numeric values", () => {
    const value = sanitizeRecord({ id: "x", password: "hash", nested: { access_token: "secret", amount: 12n } });
    expect(value).toEqual({ id: "x", password: "[REDACTED]", nested: { access_token: "[REDACTED]", amount: "12" } });
  });

  it("hashes records deterministically independent of object key order", () => {
    expect(recordHash({ b: "2", a: "1" })).toBe(recordHash({ a: "1", b: "2" }));
  });
});
