import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireMcpScope } from "./config";
import {
  createItem, deleteItem, describeEntityType, getItem, listEntityTypes, listItems, updateItem,
} from "./entities";
import {
  applyBillingCalculation, correctElectricityReading, manageCredential, reviewOilFoxCandidate,
  reviseFinancialPeriod, supersedeBillingPeriod, uploadDocument, createInvoiceDraft,
  updateInvoiceDraft, confirmInvoiceDraft, discardInvoiceDraft, queueInvoiceExtraction,
  createInvoiceTemplate, updateInvoiceTemplate, testInvoiceTemplate, publishInvoiceTemplate,
} from "./lifecycle";

export type McpRequestIdentity = {
  userId: string;
  email: string;
  clientId: string;
  scopes: string[];
};

const valuesSchema = z.record(z.string(), z.unknown());

function result(summary: string, data: Record<string, unknown>) {
  return { structuredContent: data, content: [{ type: "text" as const, text: summary }] };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected MCP tool error";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function withErrors<T extends Record<string, unknown>>(
  handler: (args: T) => Promise<ReturnType<typeof result>>,
) {
  return async (args: T) => {
    try { return await handler(args); }
    catch (error) { return toolError(error); }
  };
}

export function createVermieterMeMcpServer(identity: McpRequestIdentity, requestId: string = randomUUID()) {
  const server = new McpServer(
    { name: "vermieterme", version: "1.0.0" },
    { instructions: "Read an item with get_item immediately before updating or deleting it. Secret fields are always redacted from results and audit logs. Generic tools only accept scalar fields and never permit primary-key changes; prefer focused tools for billing and invoice workflows." },
  );
  const auditContext = (reason: string) => ({ userId: identity.userId, requestId, reason });

  server.registerTool("list_entity_types", {
    title: "List VermieterMe entity types",
    description: "Discover every database entity type and whether generic create, update, and delete are allowed.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    requireMcpScope(identity.scopes, "vermieterme:read");
    const entityTypes = listEntityTypes();
    return result(`Found ${entityTypes.length} entity types.`, { entityTypes });
  });

  server.registerTool("describe_entity_type", {
    title: "Describe a VermieterMe entity type",
    description: "Inspect fields, exact data types, identifiers, redaction, and allowed actions before reading or writing records.",
    inputSchema: { entity_type: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ entity_type }) => {
    requireMcpScope(identity.scopes, "vermieterme:read");
    const entityType = describeEntityType(entity_type);
    return result(`Described ${entity_type}.`, { entityType });
  }));

  server.registerTool("list_items", {
    title: "List VermieterMe items",
    description: "List sanitized records of one entity type using exact scalar equality filters and cursor pagination.",
    inputSchema: {
      entity_type: z.string().min(1), filters: valuesSchema.optional(), sort_by: z.string().optional(),
      sort_direction: z.enum(["asc", "desc"]).optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, withErrors(async (args) => {
    requireMcpScope(identity.scopes, "vermieterme:read");
    const page = await listItems({ entityType: args.entity_type, filters: args.filters, sortBy: args.sort_by, sortDirection: args.sort_direction, cursor: args.cursor, limit: args.limit });
    return result(`Returned ${page.items.length} ${args.entity_type} items.`, page as unknown as Record<string, unknown>);
  }));

  server.registerTool("get_item", {
    title: "Get a VermieterMe item",
    description: "Read one sanitized item by opaque reference. For mutable records this also returns a five-minute, single-use mutation token and cascade impact.",
    inputSchema: { item_ref: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ item_ref }) => {
    requireMcpScope(identity.scopes, "vermieterme:read");
    const item = await getItem(item_ref, identity.userId);
    return result(`Loaded ${item.entityType}. Review cascadeImpact before any deletion.`, item as Record<string, unknown>);
  }));

  server.registerTool("create_item", {
    title: "Create a VermieterMe item",
    description: "Create any addressable entity using declared scalar fields. Exact decimals and integers must be strings; relation writes are not accepted.",
    inputSchema: { entity_type: z.string().min(1), data: valuesSchema, reason: z.string().min(3).max(1000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ entity_type, data, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    const created = await createItem({ entityType: entity_type, data, reason, userId: identity.userId, requestId });
    return result(`Created ${entity_type}.`, created as Record<string, unknown>);
  }));

  server.registerTool("update_item", {
    title: "Update a VermieterMe item",
    description: "Update scalar fields after a fresh get_item call. The mutation token is single-use and rejects stale rows.",
    inputSchema: { item_ref: z.string().min(1), mutation_token: z.string().min(1), data: valuesSchema, reason: z.string().min(3).max(1000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ item_ref, mutation_token, data, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    const updated = await updateItem({ itemRef: item_ref, mutationToken: mutation_token, data, reason, userId: identity.userId, requestId });
    return result(`Updated ${updated.entityType}.`, updated as Record<string, unknown>);
  }));

  server.registerTool("delete_item", {
    title: "Delete a VermieterMe item",
    description: "Delete a record after get_item. Set acknowledge_cascade only after the user confirms the reported dependent rows.",
    inputSchema: { item_ref: z.string().min(1), mutation_token: z.string().min(1), acknowledge_cascade: z.boolean().default(false), reason: z.string().min(3).max(1000) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ item_ref, mutation_token, acknowledge_cascade, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    const deleted = await deleteItem({ itemRef: item_ref, mutationToken: mutation_token, acknowledgeCascade: acknowledge_cascade, reason, userId: identity.userId, requestId });
    return result(`Deleted ${deleted.entityType}.`, deleted as Record<string, unknown>);
  }));

  server.registerTool("revise_financial_period", {
    title: "Revise a lease financial period",
    description: "Supersede a lease financial period and create an auditable replacement; never edits history in place.",
    inputSchema: { id: z.string(), values: valuesSchema.default({}), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Created a financial-period revision.", { item: await reviseFinancialPeriod(id, values, auditContext(reason)) });
  }));

  server.registerTool("apply_billing_calculation", {
    title: "Apply a replacement billing calculation",
    description: "Build the shared server-side preview, reject blockers, supersede the prior snapshot, and atomically apply exact allocations.",
    inputSchema: { billing_period_id: z.string(), kind: z.string(), cost_category_id: z.string(), zero_reason: z.string().optional(), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ billing_period_id, kind, cost_category_id, zero_reason, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Applied a replacement billing calculation.", { snapshot: await applyBillingCalculation(billing_period_id, kind, cost_category_id, zero_reason, auditContext(reason)) });
  }));

  server.registerTool("supersede_billing_period", {
    title: "Revise an issued billing period",
    description: "Create a replacement billing period, copy cost setup, and supersede the issued original while preserving history.",
    inputSchema: { id: z.string(), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ id, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Created a billing-period revision.", { item: await supersedeBillingPeriod(id, auditContext(reason)) });
  }));

  server.registerTool("create_invoice_draft", {
    title: "Create an invoice draft", description: "Create a draft invoice or a revision draft for a draft billing period.",
    inputSchema: { values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Created an invoice draft.", { invoice: await createInvoiceDraft(values, auditContext(reason)) });
  }));

  server.registerTool("update_invoice_draft", {
    title: "Update an invoice draft", description: "Replace draft invoice values or its note; confirmed invoices require a revision draft.",
    inputSchema: { id: z.string(), values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Updated the invoice draft.", { invoice: await updateInvoiceDraft(id, values, auditContext(reason)) });
  }));

  server.registerTool("confirm_invoice", {
    title: "Confirm an invoice", description: "Confirm a draft invoice using the same exact validation, evidence, duplicate, tariff, and oil-inventory workflow as the application.",
    inputSchema: { id: z.string(), values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ id, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Confirmed the invoice.", { invoice: await confirmInvoiceDraft(id, values, auditContext(reason)) });
  }));

  server.registerTool("discard_invoice_draft", {
    title: "Discard an invoice draft", description: "Mark a draft invoice discarded. Confirmed invoices must be corrected with a revision.",
    inputSchema: { id: z.string(), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ id, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Discarded the invoice draft.", await discardInvoiceDraft(id, auditContext(reason)));
  }));

  server.registerTool("queue_invoice_extraction", {
    title: "Queue invoice extraction", description: "Queue asynchronous OCR extraction for a draft invoice; this does not run a worker inline.",
    inputSchema: { id: z.string(), values: valuesSchema.default({}), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Queued invoice extraction.", { job: await queueInvoiceExtraction(id, values, auditContext(reason)) });
  }));

  server.registerTool("create_invoice_template", {
    title: "Create an invoice extraction template", description: "Create a draft extraction template, optionally as a new revision series version.",
    inputSchema: { values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Created the invoice template draft.", { template: await createInvoiceTemplate(values, auditContext(reason)) });
  }));

  server.registerTool("update_invoice_template", {
    title: "Update an invoice extraction template", description: "Update a draft template and clear its prior test result; published templates require a revision.",
    inputSchema: { id: z.string(), values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Updated the invoice template draft.", { template: await updateInvoiceTemplate(id, values, auditContext(reason)) });
  }));

  server.registerTool("test_invoice_template", {
    title: "Test an invoice extraction template", description: "Test a draft template against one to ten prior OCR documents and retain the exact results.",
    inputSchema: { id: z.string(), samples: z.array(z.unknown()).min(1).max(10), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, samples, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Tested the invoice template.", { test: await testInvoiceTemplate(id, samples, auditContext(reason)) });
  }));

  server.registerTool("publish_invoice_template", {
    title: "Publish an invoice extraction template", description: "Publish a draft template only after its current rules and markers pass expected-value testing.",
    inputSchema: { id: z.string(), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ id, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Published the invoice template.", { template: await publishInvoiceTemplate(id, auditContext(reason)) });
  }));

  server.registerTool("correct_electricity_reading", {
    title: "Correct or delete an electricity reading",
    description: "Update or delete a cumulative electricity reading while retaining the mandatory audit record.",
    inputSchema: { id: z.string(), action: z.enum(["update", "delete"]), values: valuesSchema.default({}), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ id, action, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result(`Electricity reading ${action} completed.`, { item: await correctElectricityReading(id, action, values, auditContext(reason)) });
  }));

  server.registerTool("review_oilfox_candidate", {
    title: "Review an OilFox delivery candidate",
    description: "Set a detected oil-delivery candidate to pending, confirmed, or ignored with an audit reason.",
    inputSchema: { id: z.string(), status: z.enum(["PENDING", "CONFIRMED", "IGNORED"]), note: z.string().optional(), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, status, note, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Reviewed the OilFox candidate.", { item: await reviewOilFoxCandidate(id, status, note, auditContext(reason)) });
  }));

  server.registerTool("manage_credential", {
    title: "Rotate or revoke a VermieterMe credential",
    description: "Rotate a tenant access code or revoke a tenant code, session, or linked OAuth account. Secret values are never returned.",
    inputSchema: { kind: z.enum(["tenant_access", "session", "account"]), action: z.enum(["rotate", "revoke"]), id: z.string(), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ kind, action, id, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:admin");
    return result("Credential lifecycle action completed; no secret was returned.", await manageCredential(kind, action, id, auditContext(reason)));
  }));

  const openAiFile = z.object({ download_url: z.string().url(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional() }).strict();
  server.registerTool("upload_document", {
    title: "Upload a VermieterMe document",
    description: "Persist a ChatGPT-provided PDF or image and optionally associate it with a tenant, billing period, oil delivery, or cost invoice.",
    inputSchema: { file: openAiFile, metadata: valuesSchema.default({}), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"] },
  }, withErrors(async ({ file, metadata, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Uploaded the document.", { document: await uploadDocument(file, metadata, auditContext(reason)) });
  }));

  return server;
}
