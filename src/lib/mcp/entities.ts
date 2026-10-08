import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { serializeExact } from "@/lib/billing-v2";
import { signMutationToken, verifyMutationToken } from "./crypto";

type Model = (typeof Prisma.dmmf.datamodel.models)[number];
type Field = Model["fields"][number];
type JsonObject = Record<string, unknown>;

const SECRET_FIELDS = new Set([
  "password", "sessionToken", "token", "refresh_token", "access_token", "id_token",
  "clientSecret", "tokenHash", "codeHash", "codeChallenge",
]);

const PROTECTED_MODELS = new Set([
  "Account", "Session", "VerificationToken", "TenantAccessToken",
  "BillingSnapshot", "CostAllocation", "OilInventoryLot", "OilLotConsumption",
  "ElectricityReadingAudit", "McpOAuthClient", "McpAuthorizationCode",
  "McpRefreshToken", "McpMutationTokenUse", "McpAuditEvent",
]);

// Direct CRUD is deliberately limited to records whose existing UI/API already
// treats them as ordinary mutable data. All other rows remain discoverable and
// readable and are changed only through focused lifecycle tools.
const DIRECT_MUTATION_MODELS = new Set([
  "Property", "PropertyTaxSetting", "Unit", "Tenant", "CostCategory", "BillingPeriod",
  "Cost", "Prepayment", "RentChange", "PdfTemplate", "VpiEntry", "LandlordInfo",
  "HeatingOilTank", "HeatingOilDelivery", "OilStockReading", "ElectricityContract",
  "ElectricityTariff", "ElectricityMeter", "HeatMeter", "HeatMeterReading",
]);

function modelByName(name: string) {
  const model = Prisma.dmmf.datamodel.models.find((entry) => entry.name === name);
  if (!model) throw new Error(`Unknown entity type: ${name}`);
  return model;
}

function delegateForClient(client: unknown, name: string): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const key = name.charAt(0).toLowerCase() + name.slice(1);
  const delegate = (client as Record<string, unknown>)[key];
  if (!delegate || typeof delegate !== "object") throw new Error(`No Prisma delegate for ${name}`);
  return delegate as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

function delegateFor(name: string) { return delegateForClient(prisma, name); }

function keyFields(model: Model) {
  if (model.primaryKey?.fields.length) return model.primaryKey.fields;
  const ids = model.fields.filter((field) => field.isId).map((field) => field.name);
  if (ids.length) return ids;
  if (model.uniqueFields.length) return model.uniqueFields[0];
  throw new Error(`${model.name} does not have an addressable key`);
}

export function encodeItemRef(entityType: string, item: JsonObject) {
  const model = modelByName(entityType);
  const key = Object.fromEntries(keyFields(model).map((name) => [name, item[name]]));
  return Buffer.from(JSON.stringify({ entityType, key }), "utf8").toString("base64url");
}

export function decodeItemRef(itemRef: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(itemRef, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid item_ref"); }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid item_ref");
  const value = parsed as { entityType?: unknown; key?: unknown };
  if (typeof value.entityType !== "string" || !value.key || typeof value.key !== "object") {
    throw new Error("Invalid item_ref");
  }
  const model = modelByName(value.entityType);
  const expected = keyFields(model);
  const key = value.key as JsonObject;
  if (Object.keys(key).length !== expected.length || expected.some((name) => !(name in key))) {
    throw new Error("Invalid item_ref key");
  }
  return { entityType: value.entityType, key };
}

function whereFor(model: Model, key: JsonObject) {
  const fields = keyFields(model);
  if (fields.length === 1) return { [fields[0]]: key[fields[0]] };
  const compoundName = model.primaryKey?.name || fields.join("_");
  return { [compoundName]: key };
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    if ("toFixed" in value && "d" in value && typeof value.toString === "function") return value.toString();
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      SECRET_FIELDS.has(key) ? "[REDACTED]" : sanitizeValue(child),
    ]));
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function sanitizeRecord(value: unknown) {
  return sanitizeValue(serializeExact(value));
}

function stableJson(value: unknown) {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") return Object.fromEntries(
      Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])
    );
    return input;
  };
  return JSON.stringify(sort(sanitizeRecord(value)));
}

export function recordHash(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("base64url");
}

function fieldDescriptor(field: Field) {
  return {
    name: field.name,
    kind: field.kind,
    type: String(field.type),
    list: field.isList,
    required: field.isRequired,
    id: field.isId,
    unique: field.isUnique,
    hasDefault: field.hasDefaultValue,
    secret: SECRET_FIELDS.has(field.name),
    writable: field.kind === "scalar" && !field.isReadOnly && !SECRET_FIELDS.has(field.name) &&
      field.name !== "createdAt" && field.name !== "updatedAt" && !(field.isId && field.hasDefaultValue),
  };
}

export function listEntityTypes() {
  return Prisma.dmmf.datamodel.models.map((model) => ({
    name: model.name,
    keyFields: keyFields(model),
    readable: true,
    create: DIRECT_MUTATION_MODELS.has(model.name),
    update: DIRECT_MUTATION_MODELS.has(model.name),
    delete: DIRECT_MUTATION_MODELS.has(model.name),
    protected: PROTECTED_MODELS.has(model.name),
  }));
}

export function describeEntityType(entityType: string) {
  const model = modelByName(entityType);
  return {
    ...listEntityTypes().find((entry) => entry.name === entityType),
    fields: model.fields.map(fieldDescriptor),
    note: DIRECT_MUTATION_MODELS.has(entityType)
      ? "Direct scalar CRUD is available subject to validation and read-before-write grants."
      : "Read-only through generic tools. Use a focused lifecycle tool when one is available.",
  };
}

function scalarField(model: Model, name: string) {
  return model.fields.find((field) => field.name === name && field.kind === "scalar");
}

function normalizeScalar(field: Field, value: unknown): unknown {
  if (value === null) {
    if (field.isRequired) throw new Error(`${field.name} cannot be null`);
    return null;
  }
  if (field.isList) {
    if (!Array.isArray(value)) throw new Error(`${field.name} must be an array`);
    return value.map((entry) => normalizeScalar({ ...field, isList: false } as Field, entry));
  }
  switch (field.type) {
    case "String": if (typeof value !== "string") throw new Error(`${field.name} must be a string`); return value;
    case "Boolean": if (typeof value !== "boolean") throw new Error(`${field.name} must be boolean`); return value;
    case "Int": if (!Number.isSafeInteger(value)) throw new Error(`${field.name} must be a safe integer`); return value;
    case "Float": if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field.name} must be a finite number`); return value;
    case "BigInt": if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error(`${field.name} must be an integer string`); return BigInt(value);
    case "Decimal": if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`${field.name} must be a decimal string`); return value;
    case "DateTime": {
      if (typeof value !== "string") throw new Error(`${field.name} must be an ISO date-time string`);
      const date = new Date(value); if (Number.isNaN(date.valueOf())) throw new Error(`${field.name} is not a valid date-time`); return date;
    }
    case "Json": return value;
    default: return value;
  }
}

function normalizeData(model: Model, input: JsonObject, mode: "create" | "update") {
  const data: JsonObject = {};
  for (const [name, value] of Object.entries(input)) {
    const field = scalarField(model, name);
    if (!field) throw new Error(`Unknown or relational field: ${name}`);
    const descriptor = fieldDescriptor(field);
    if (!descriptor.writable) throw new Error(`Field is not writable: ${name}`);
    data[name] = normalizeScalar(field, value);
  }
  if (mode === "update" && Object.keys(data).length === 0) throw new Error("No writable fields supplied");
  return data;
}

function normalizeFilters(model: Model, filters: JsonObject | undefined) {
  if (!filters) return undefined;
  const where: JsonObject = {};
  for (const [name, value] of Object.entries(filters)) {
    const field = scalarField(model, name);
    if (!field || SECRET_FIELDS.has(name)) throw new Error(`Unsupported filter: ${name}`);
    where[name] = normalizeScalar(field, value);
  }
  return where;
}

export async function listItems(input: {
  entityType: string; filters?: JsonObject; sortBy?: string; sortDirection?: "asc" | "desc";
  cursor?: string; limit?: number;
}) {
  const model = modelByName(input.entityType);
  const limit = Math.min(Math.max(input.limit || 25, 1), 100);
  const orderField = input.sortBy || (scalarField(model, "createdAt") ? "createdAt" : keyFields(model)[0]);
  if (!scalarField(model, orderField) || SECRET_FIELDS.has(orderField)) throw new Error("Unsupported sort field");
  const rows = await delegateFor(model.name).findMany({
    where: normalizeFilters(model, input.filters), orderBy: { [orderField]: input.sortDirection || "asc" },
    take: limit + 1,
    ...(input.cursor ? (() => {
      const decoded = decodeItemRef(input.cursor);
      if (decoded.entityType !== model.name) throw new Error("Cursor belongs to a different entity type");
      return { cursor: whereFor(model, decoded.key), skip: 1 };
    })() : {}),
  }) as JsonObject[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    entityType: model.name,
    items: page.map((row) => ({ itemRef: encodeItemRef(model.name, row), data: sanitizeRecord(row) })),
    nextCursor: hasMore ? encodeItemRef(model.name, page[page.length - 1]) : null,
  };
}

async function cascadeImpact(entityType: string, key: JsonObject) {
  const result: Record<string, number> = {};
  for (const candidate of Prisma.dmmf.datamodel.models) {
    for (const relation of candidate.fields.filter((field) => field.kind === "object" && field.type === entityType && field.relationFromFields?.length)) {
      const from = relation.relationFromFields || [];
      const to = relation.relationToFields || [];
      if (from.length !== to.length || to.some((name) => !(name in key))) continue;
      const where = Object.fromEntries(from.map((name, index) => [name, key[to[index]]]));
      const count = await delegateFor(candidate.name).count({ where }) as number;
      if (count) result[candidate.name] = (result[candidate.name] || 0) + count;
    }
  }
  return result;
}

export async function getItem(itemRef: string, userId: string) {
  const decoded = decodeItemRef(itemRef);
  const model = modelByName(decoded.entityType);
  const row = await delegateFor(model.name).findUnique({ where: whereFor(model, decoded.key) }) as JsonObject | null;
  if (!row) throw new Error("Item not found");
  const cascade = await cascadeImpact(model.name, decoded.key);
  const mutationToken = DIRECT_MUTATION_MODELS.has(model.name)
    ? await signMutationToken({ userId, entityType: model.name, itemRef, rowHash: recordHash(row), cascade })
    : null;
  return { entityType: model.name, itemRef, data: sanitizeRecord(row), cascadeImpact: cascade, mutationToken };
}

async function audit(input: {
  userId: string; action: string; entityType: string; itemRef?: string; reason: string;
  requestId: string; before?: unknown; after?: unknown;
}, client: unknown = prisma) {
  return delegateForClient(client, "McpAuditEvent").create({ data: {
    userId: input.userId, action: input.action, entityType: input.entityType,
    itemRef: input.itemRef, reason: input.reason, requestId: input.requestId,
    beforeJson: input.before === undefined ? null : stableJson(input.before),
    afterJson: input.after === undefined ? null : stableJson(input.after),
  }});
}

export async function createItem(input: {
  entityType: string; data: JsonObject; reason: string; userId: string; requestId: string;
}) {
  const model = modelByName(input.entityType);
  if (!DIRECT_MUTATION_MODELS.has(model.name)) throw new Error(`${model.name} cannot be created through generic CRUD`);
  const created = await prisma.$transaction(async (tx) => {
    const row = await delegateForClient(tx, model.name).create({ data: normalizeData(model, input.data, "create") }) as JsonObject;
    const rowRef = encodeItemRef(model.name, row);
    await audit({ ...input, action: "CREATE", entityType: model.name, itemRef: rowRef, after: row }, tx);
    return row;
  });
  const itemRef = encodeItemRef(model.name, created);
  return { entityType: model.name, itemRef, data: sanitizeRecord(created) };
}

async function validateMutationGrant(input: { mutationToken: string; itemRef: string; userId: string }) {
  const grant = await verifyMutationToken(input.mutationToken);
  if (grant.userId !== input.userId || grant.itemRef !== input.itemRef) throw new Error("Mutation grant does not match this item or user");
  const decoded = decodeItemRef(input.itemRef);
  if (grant.entityType !== decoded.entityType) throw new Error("Mutation grant entity mismatch");
  const model = modelByName(decoded.entityType);
  return { grant, decoded, model };
}

export async function updateItem(input: {
  itemRef: string; mutationToken: string; data: JsonObject; reason: string; userId: string; requestId: string;
}) {
  const context = await validateMutationGrant(input);
  if (!DIRECT_MUTATION_MODELS.has(context.model.name)) throw new Error(`${context.model.name} cannot be updated through generic CRUD`);
  const updated = await prisma.$transaction(async (tx) => {
    const current = await delegateForClient(tx, context.model.name).findUnique({ where: whereFor(context.model, context.decoded.key) }) as JsonObject | null;
    if (!current) throw new Error("Item not found");
    if (recordHash(current) !== context.grant.rowHash) throw new Error("Item changed after it was read; call get_item again");
    try { await tx.mcpMutationTokenUse.create({ data: { id: context.grant.jti, userId: input.userId, entityType: context.model.name, itemRef: input.itemRef } }); }
    catch { throw new Error("Mutation token has already been used"); }
    const row = await delegateForClient(tx, context.model.name).update({
      where: whereFor(context.model, context.decoded.key), data: normalizeData(context.model, input.data, "update"),
    }) as JsonObject;
    await audit({ ...input, action: "UPDATE", entityType: context.model.name, before: current, after: row }, tx);
    return row;
  });
  return { entityType: context.model.name, itemRef: input.itemRef, data: sanitizeRecord(updated) };
}

export async function deleteItem(input: {
  itemRef: string; mutationToken: string; acknowledgeCascade: boolean; reason: string; userId: string; requestId: string;
}) {
  const context = await validateMutationGrant(input);
  if (!DIRECT_MUTATION_MODELS.has(context.model.name)) throw new Error(`${context.model.name} cannot be deleted through generic CRUD`);
  if (Object.keys(context.grant.cascade).length && !input.acknowledgeCascade) {
    throw new Error(`Deletion has dependent rows: ${JSON.stringify(context.grant.cascade)}. Set acknowledge_cascade=true after confirmation.`);
  }
  await prisma.$transaction(async (tx) => {
    const current = await delegateForClient(tx, context.model.name).findUnique({ where: whereFor(context.model, context.decoded.key) }) as JsonObject | null;
    if (!current) throw new Error("Item not found");
    if (recordHash(current) !== context.grant.rowHash) throw new Error("Item changed after it was read; call get_item again");
    try { await tx.mcpMutationTokenUse.create({ data: { id: context.grant.jti, userId: input.userId, entityType: context.model.name, itemRef: input.itemRef } }); }
    catch { throw new Error("Mutation token has already been used"); }
    await delegateForClient(tx, context.model.name).delete({ where: whereFor(context.model, context.decoded.key) });
    await audit({ ...input, action: "DELETE", entityType: context.model.name, before: current }, tx);
  });
  return { deleted: true, entityType: context.model.name, itemRef: input.itemRef, cascadeImpact: context.grant.cascade };
}

export async function recordLifecycleAudit(input: Parameters<typeof audit>[0], client?: unknown) {
  await audit(input, client);
}
