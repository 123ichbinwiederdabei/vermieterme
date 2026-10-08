import { createHash, randomBytes } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { mcpResource, mcpSigningSecret } from "./config";

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("base64url");
}

export async function signAccessToken(input: {
  userId: string;
  email: string;
  clientId: string;
  scopes: string[];
  resource: string;
}) {
  return new SignJWT({
    email: input.email,
    client_id: input.clientId,
    scope: input.scopes.join(" "),
  })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(mcpBaseIssuer())
    .setSubject(input.userId)
    .setAudience(input.resource)
    .setIssuedAt()
    .setExpirationTime("15m")
    .setJti(randomToken(16))
    .sign(mcpSigningSecret());
}

function mcpBaseIssuer() {
  return mcpResource().replace(/\/mcp$/, "");
}

export async function verifyAccessToken(token: string) {
  const verified = await jwtVerify(token, mcpSigningSecret(), {
    issuer: mcpBaseIssuer(),
    audience: mcpResource(),
    algorithms: ["HS256"],
  });
  const payload = verified.payload;
  if (!payload.sub || typeof payload.client_id !== "string" || typeof payload.scope !== "string") {
    throw new Error("Invalid access token claims");
  }
  if (!payload.email || typeof payload.email !== "string" ||
      payload.email.toLowerCase() !== process.env.ADMIN_EMAIL?.toLowerCase()) {
    throw new Error("Access token administrator is no longer eligible");
  }
  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : "",
    clientId: payload.client_id,
    scopes: payload.scope.split(" ").filter(Boolean),
    expiresAt: payload.exp,
  };
}

export async function signMutationToken(input: {
  userId: string;
  entityType: string;
  itemRef: string;
  rowHash: string;
  cascade: Record<string, number>;
}) {
  return new SignJWT({
    kind: "mutation_grant",
    entity_type: input.entityType,
    item_ref: input.itemRef,
    row_hash: input.rowHash,
    cascade: input.cascade,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(mcpBaseIssuer())
    .setSubject(input.userId)
    .setAudience(`${mcpResource()}#mutation`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(randomToken(16))
    .sign(mcpSigningSecret());
}

export async function verifyMutationToken(token: string) {
  const { payload } = await jwtVerify(token, mcpSigningSecret(), {
    issuer: mcpBaseIssuer(),
    audience: `${mcpResource()}#mutation`,
    algorithms: ["HS256"],
  });
  if (
    payload.kind !== "mutation_grant" || !payload.sub || !payload.jti ||
    typeof payload.entity_type !== "string" || typeof payload.item_ref !== "string" ||
    typeof payload.row_hash !== "string"
  ) throw new Error("Invalid mutation token");
  return {
    userId: payload.sub,
    jti: payload.jti,
    entityType: payload.entity_type,
    itemRef: payload.item_ref,
    rowHash: payload.row_hash,
    cascade: (payload.cascade || {}) as Record<string, number>,
  };
}
