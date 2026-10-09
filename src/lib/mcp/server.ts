import { randomUUID } from "crypto";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ListToolsRequestSchema, type Tool, type ToolAnnotations, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DOMAIN_ACTIONS, previewDomainChange, commitDomainChange } from "@/lib/domain-changes";
import { billingWorkspace, renewBillingApproval, validateBillingPeriod, previewBillingPeriod, issueBillingPreview, previewStatementSend, sendStatementPreview } from "@/lib/billing-workflow";
import { buildEnergyPreview } from "@/lib/energy-preview";
import { prisma } from "@/lib/prisma";
import { serializeExact } from "@/lib/billing-v2";
import { retryDocumentArchive, queuePropertyOriginals, testDocumentStorage, resolveOneDriveTarget } from "@/lib/document-archive";
import { testMicrosoftSource } from "@/lib/microsoft-import";
import { documentDownload } from "@/lib/document-download";
import { recordLifecycleAudit } from "./entities";
import { requireMcpScope, McpScopeError, mcpBaseUrl } from "./config";
import {
  createItem, deleteItem, describeEntityType, getItem, listEntityTypes, listItems, updateItem,
} from "./entities";
import {
  applyBillingCalculation, manageCredential, reviewOilFoxCandidate,
  uploadDocument, createInvoiceDraft,
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
  if (error instanceof McpScopeError) return { isError: true, content: [{ type: "text" as const, text: error.message }], _meta: { "mcp/www_authenticate": [`Bearer resource_metadata="${mcpBaseUrl()}/.well-known/oauth-protected-resource", scope="${error.required}", error="insufficient_scope", error_description="Additional authorization required"`] } };
  const message = error instanceof Error ? error.message : "Unexpected MCP tool error";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function withErrors<T extends Record<string, unknown>>(
  handler: (args: T) => Promise<CallToolResult>,
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
  const definitions: Array<Tool & { securitySchemes?: unknown }> = [];
  function register<T extends z.ZodRawShape>(name: string, config: { title?: string; description?: string; inputSchema: T; annotations?: ToolAnnotations; _meta?: Record<string, unknown> }, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) {
    server.registerTool(name, config, handler as unknown as ToolCallback<T>);
    definitions.push({ name, ...config, inputSchema: z.toJSONSchema(z.object(config.inputSchema), { io: "input" }) as Tool["inputSchema"], securitySchemes: config._meta?.securitySchemes });
  }
  const auditContext = (reason: string) => ({ userId: identity.userId, requestId, reason });

  register("list_entity_types", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:read"] }] },
    title: "List VermieterMe entity types",
    description: "Discover every database entity type and whether generic create, update, and delete are allowed.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, withErrors(async () => {
    requireMcpScope(identity.scopes, "vermieterme:read");
    const entityTypes = listEntityTypes();
    return result(`Found ${entityTypes.length} entity types.`, { entityTypes });
  }));

  register("describe_entity_type", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:read"] }] },
    title: "Describe a VermieterMe entity type",
    description: "Inspect fields, exact data types, identifiers, redaction, and allowed actions before reading or writing records.",
    inputSchema: { entity_type: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ entity_type }) => {
    requireMcpScope(identity.scopes, "vermieterme:read");
    const entityType = describeEntityType(entity_type);
    return result(`Described ${entity_type}.`, { entityType });
  }));

  register("list_items", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:read"] }] },
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

  register("get_item", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:read"] }] },
    title: "Get a VermieterMe item",
    description: "Read one sanitized item by opaque reference. For mutable records this also returns a five-minute, single-use mutation token and cascade impact.",
    inputSchema: { item_ref: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ item_ref }) => {
    requireMcpScope(identity.scopes, "vermieterme:read");
    const item = await getItem(item_ref, identity.userId);
    return result(`Loaded ${item.entityType}. Review cascadeImpact before any deletion.`, item as Record<string, unknown>);
  }));

  register("create_item", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Create a VermieterMe item",
    description: "Create any addressable entity using declared scalar fields. Exact decimals and integers must be strings; relation writes are not accepted.",
    inputSchema: { entity_type: z.string().min(1), data: valuesSchema, reason: z.string().min(3).max(1000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ entity_type, data, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    const created = await createItem({ entityType: entity_type, data, reason, userId: identity.userId, requestId });
    return result(`Created ${entity_type}.`, created as Record<string, unknown>);
  }));

  register("update_item", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Update a VermieterMe item",
    description: "Update scalar fields after a fresh get_item call. The mutation token is single-use and rejects stale rows.",
    inputSchema: { item_ref: z.string().min(1), mutation_token: z.string().min(1), data: valuesSchema, reason: z.string().min(3).max(1000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ item_ref, mutation_token, data, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    const updated = await updateItem({ itemRef: item_ref, mutationToken: mutation_token, data, reason, userId: identity.userId, requestId });
    return result(`Updated ${updated.entityType}.`, updated as Record<string, unknown>);
  }));

  register("delete_item", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Delete a VermieterMe item",
    description: "Delete a record after get_item. Set acknowledge_cascade only after the user confirms the reported dependent rows.",
    inputSchema: { item_ref: z.string().min(1), mutation_token: z.string().min(1), acknowledge_cascade: z.boolean().default(false), reason: z.string().min(3).max(1000) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ item_ref, mutation_token, acknowledge_cascade, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    const deleted = await deleteItem({ itemRef: item_ref, mutationToken: mutation_token, acknowledgeCascade: acknowledge_cascade, reason, userId: identity.userId, requestId });
    return result(`Deleted ${deleted.entityType}.`, deleted as Record<string, unknown>);
  }));

  register("revise_financial_period", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Revise a lease financial period",
    description: "Preview an auditable financial revision. Save only with commit_domain_change after explicit user confirmation.",
    inputSchema: { id: z.string(), values: valuesSchema.default({}), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Review this financial revision before saving", await previewDomainChange("revise_financial_period", { id, ...values }, auditContext(reason)));
  }));

  register("apply_billing_calculation", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Apply a replacement billing calculation",
    description: "Build the shared server-side preview, reject blockers, supersede the prior snapshot, and atomically apply exact allocations.",
    inputSchema: { billing_period_id: z.string(), kind: z.string(), cost_category_id: z.string(), zero_reason: z.string().optional(), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ billing_period_id, kind, cost_category_id, zero_reason, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Applied a replacement billing calculation.", { snapshot: await applyBillingCalculation(billing_period_id, kind, cost_category_id, zero_reason, auditContext(reason)) });
  }));

  register("supersede_billing_period", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Revise an issued billing period",
    description: "Preview a correction period while preserving the issued original. Save only with commit_domain_change after confirmation.",
    inputSchema: { id: z.string(), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ id, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Review this correction period before saving", await previewDomainChange("revise_billing_period", { billingPeriodId: id }, auditContext(reason)));
  }));

  register("create_invoice_draft", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Create an invoice draft", description: "Create a draft invoice or a revision draft for a draft billing period.",
    inputSchema: { values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Created an invoice draft.", { invoice: await createInvoiceDraft(values, auditContext(reason)) });
  }));

  register("update_invoice_draft", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Update an invoice draft", description: "Replace draft invoice values or its note; confirmed invoices require a revision draft.",
    inputSchema: { id: z.string(), values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Updated the invoice draft.", { invoice: await updateInvoiceDraft(id, values, auditContext(reason)) });
  }));

  register("confirm_invoice", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Confirm an invoice", description: "Confirm a draft invoice using the same exact validation, evidence, duplicate, tariff, and oil-inventory workflow as the application.",
    inputSchema: { id: z.string(), values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ id, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Confirmed the invoice.", { invoice: await confirmInvoiceDraft(id, values, auditContext(reason)) });
  }));

  register("discard_invoice_draft", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Discard an invoice draft", description: "Mark a draft invoice discarded. Confirmed invoices must be corrected with a revision.",
    inputSchema: { id: z.string(), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ id, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Discarded the invoice draft.", await discardInvoiceDraft(id, auditContext(reason)));
  }));

  register("queue_invoice_extraction", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Queue invoice extraction", description: "Queue asynchronous OCR extraction for a draft invoice; this does not run a worker inline.",
    inputSchema: { id: z.string(), values: valuesSchema.default({}), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Queued invoice extraction.", { job: await queueInvoiceExtraction(id, values, auditContext(reason)) });
  }));

  register("create_invoice_template", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Create an invoice extraction template", description: "Create a draft extraction template, optionally as a new revision series version.",
    inputSchema: { values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Created the invoice template draft.", { template: await createInvoiceTemplate(values, auditContext(reason)) });
  }));

  register("update_invoice_template", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Update an invoice extraction template", description: "Update a draft template and clear its prior test result; published templates require a revision.",
    inputSchema: { id: z.string(), values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Updated the invoice template draft.", { template: await updateInvoiceTemplate(id, values, auditContext(reason)) });
  }));

  register("test_invoice_template", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Test an invoice extraction template", description: "Test three to ten independently confirmed original documents (two TRAINING and one HOLDOUT minimum). Expected values come from confirmed samples, never OCR. Automatically publishes passing rules.",
    inputSchema: { id: z.string(), samples: z.array(z.unknown()).min(1).max(10), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, samples, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Tested the invoice template.", { test: await testInvoiceTemplate(id, samples, auditContext(reason)) });
  }));

  register("publish_invoice_template", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Publish an invoice extraction template", description: "Publish a draft template only after its current rules and markers pass expected-value testing.",
    inputSchema: { id: z.string(), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ id, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Published the invoice template.", { template: await publishInvoiceTemplate(id, auditContext(reason)) });
  }));

  register("correct_electricity_reading", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Correct or delete an electricity reading",
    description: "Update or delete a cumulative electricity reading while retaining the mandatory audit record.",
    inputSchema: { id: z.string(), action: z.enum(["update", "delete"]), values: valuesSchema.default({}), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ id, action, values, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    if (action !== "update") throw new Error("Readings require an audited correction; historical deletion is disabled");
    return result("Review the reading correction", await previewDomainChange("correct_electricity_reading", { id, ...values }, auditContext(reason)));
  }));

  register("review_oilfox_candidate", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
    title: "Review an OilFox delivery candidate",
    description: "Set a detected oil-delivery candidate to pending, confirmed, or ignored with an audit reason.",
    inputSchema: { id: z.string(), status: z.enum(["PENDING", "CONFIRMED", "IGNORED"]), note: z.string().optional(), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, withErrors(async ({ id, status, note, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Reviewed the OilFox candidate.", { item: await reviewOilFoxCandidate(id, status, note, auditContext(reason)) });
  }));

  register("manage_credential", {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:admin"] }] },
    title: "Rotate or revoke a VermieterMe credential",
    description: "Rotate a tenant access code or revoke a tenant code, session, or linked OAuth account. Secret values are never returned.",
    inputSchema: { kind: z.enum(["tenant_access", "session", "account"]), action: z.enum(["rotate", "revoke"]), id: z.string(), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, withErrors(async ({ kind, action, id, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:admin");
    return result("Credential lifecycle action completed; no secret was returned.", await manageCredential(kind, action, id, auditContext(reason)));
  }));

  const openAiFile = z.object({ download_url: z.string().url(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional() }).strict();
  register("upload_document", {
    title: "Upload a VermieterMe document",
    description: "Persist a ChatGPT-provided PDF or image, or an unchanged DOCX contract with metadata.category=contract/lease/stammdaten. Optionally associate it with a tenant, billing period, oil delivery, or cost invoice.",
    inputSchema: { file: openAiFile, metadata: valuesSchema.default({}), reason: z.string().min(3) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"], securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
  }, withErrors(async ({ file, metadata, reason }) => {
    requireMcpScope(identity.scopes, "vermieterme:write");
    return result("Uploaded the document.", { document: await uploadDocument(file, metadata, auditContext(reason)) });
  }));

  register("billing_workspace", {
    title: "Billing work overview", description: "Read dated tenancies, agreements, enabled costs, periods, allocation rules and archive configuration.", inputSchema: { propertyId: z.string() }, annotations: { readOnlyHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:read"] }] },
  }, withErrors(async ({ propertyId }) => { requireMcpScope(identity.scopes, "vermieterme:read"); return result("Billing workspace", { workspace: await billingWorkspace(propertyId) }); }));
  register("preview_domain_change", {
    title: "Preview a dated business change", description: "Validate a business transaction without saving it. Returns old/new values, effective dates, affected periods and a five-minute confirmation token. Covers properties, tenancy/parties/moves, areas/owner use, agreements, cost rules, tariffs, meters/readings, heating, sources and storage. Use describe_domain_actions to discover required inputs.", inputSchema: { action: z.enum(DOMAIN_ACTIONS), values: valuesSchema, reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
  }, withErrors(async ({ action, values, reason }) => { requireMcpScope(identity.scopes, "vermieterme:write"); return result("Review and explicitly confirm the proposed change", await previewDomainChange(action, values, auditContext(reason))); }));
  register("commit_domain_change", {
    title: "Save a confirmed business preview", description: "Save exactly the reviewed business change. Requires explicit human confirmation; stale/expired previews fail and duplicate commits return the original result. Storage/source changes additionally require admin scope.", inputSchema: { previewId: z.string(), confirmed: z.boolean(), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
  }, withErrors(async ({ previewId, confirmed, reason }) => { requireMcpScope(identity.scopes, "vermieterme:write"); const preview = await prisma.domainChangePreview.findUniqueOrThrow({ where: { id: previewId } }); if (["configure_document_storage", "configure_microsoft_source"].includes(preview.action)) requireMcpScope(identity.scopes, "vermieterme:admin"); return result("Saved confirmed change", { item: await commitDomainChange(previewId, confirmed, auditContext(reason)) }); }));
  register("validate_billing", {
    title: "Validate billing readiness", description: "Run shared completeness, contract, history, meter, FIFO, CO2, cents, deadline and OneDrive archive checks with actionable blockers.", inputSchema: { billingPeriodId: z.string() }, annotations: { readOnlyHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:read"] }] },
  }, withErrors(async ({ billingPeriodId }) => { requireMcpScope(identity.scopes, "vermieterme:read"); return result("Billing validation", await validateBillingPeriod(billingPeriodId)); }));
  register("preview_calculation", {
    title: "Preview shared cost calculation", description: "Calculate a cost category without applying it; returns cents, owner/vacancy shares, evidence and blockers.", inputSchema: { billingPeriodId: z.string(), costCategoryId: z.string(), kind: z.enum(["HEATING_OIL", "ELECTRICITY", "SMALL_WASTEWATER", "MANUAL"]) }, annotations: { readOnlyHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:read"] }] },
  }, withErrors(async ({ billingPeriodId, costCategoryId, kind }) => { requireMcpScope(identity.scopes, "vermieterme:read"); return result("Calculation preview", { calculation: serializeExact(await buildEnergyPreview(kind, billingPeriodId, costCategoryId)) }); }));
  register("preview_billing", {
    title: "Prepare billing PDFs for approval", description: "Validate and generate one immutable PDF per tenancy with a unique preview ID, archive jobs and a short-lived approval token. Fetch each PDF with download_document.", inputSchema: { billingPeriodId: z.string(), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] },
  }, withErrors(async ({ billingPeriodId, reason }) => { requireMcpScope(identity.scopes, "vermieterme:write"); return result("PDF preview for explicit human approval", await previewBillingPeriod(billingPeriodId, auditContext(reason))); }));
  register("renew_billing_approval", { title: "Review an expired billing approval again", description: "Renew a pending archive release with a fresh approval ID for the same immutable PDFs. Rejects changed billing inputs. Review these PDFs again before issue_billing.", inputSchema: { previewId: z.string(), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:approve"] }] } }, withErrors(async ({ previewId, reason }) => { requireMcpScope(identity.scopes, "vermieterme:approve"); return result("Renewed PDF review", await renewBillingApproval(previewId, auditContext(reason))); }));
  register("issue_billing", {
    title: "Issue explicitly approved billing PDFs", description: "Confirm the exact reviewed PDFs. May return ARCHIVING until final OneDrive paths pass byte verification; retry the same preview. Freezes revisions only after successful archive. Requires separate approve scope.", inputSchema: { previewId: z.string(), confirmed: z.boolean(), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:approve"] }] },
  }, withErrors(async ({ previewId, confirmed, reason }) => { requireMcpScope(identity.scopes, "vermieterme:approve"); return result("Billing release status", { release: await issueBillingPreview(previewId, confirmed, auditContext(reason)) }); }));
  register("download_document", {
    title: "View an original receipt or billing PDF", description: "Return a hash-verified file with a ten-minute signed download link and native MCP resource link.", inputSchema: { documentId: z.string() }, annotations: { readOnlyHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:read"] }] },
  }, withErrors(async ({ documentId }) => { requireMcpScope(identity.scopes, "vermieterme:read"); const file = await documentDownload(documentId); return { structuredContent: { file }, content: [{ type: "resource_link", uri: file.download_url, name: file.file_name, mimeType: file.mime_type }] }; }));
  register("preview_statement_send", {
    title: "Preview recipient, message and released PDF", description: "Show exact recipient, subject, body, archived PDF hash and approval token. User must explicitly approve all before send.", inputSchema: { artifactId: z.string(), mailbox: z.string().email(), recipient: z.string().email(), subject: z.string().min(1).max(255), bodyText: z.string().min(1).max(10000), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:approve"] }] },
  }, withErrors(async ({ reason, ...input }) => { requireMcpScope(identity.scopes, "vermieterme:approve"); return result("Review recipient, text and PDF", await previewStatementSend(input, auditContext(reason))); }));
  register("send_statement", {
    title: "Queue explicitly approved statement dispatch", description: "Persist approved Microsoft outbox job. Never automatically resends an ambiguous send response; repeated approval is idempotent.", inputSchema: { previewId: z.string(), confirmed: z.boolean(), reason: z.string().min(3) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:approve"] }] },
  }, withErrors(async ({ previewId, confirmed, reason }) => { requireMcpScope(identity.scopes, "vermieterme:approve"); return result("Durable outbox status", { dispatch: serializeExact(await sendStatementPreview(previewId, confirmed, auditContext(reason))) }); }));
  register("archive_status", {
    title: "Inspect jobs, archive, notices and outbox", description: "Read persistent processing states, pending reviews and changed billing blockers for a property; no secrets.", inputSchema: { propertyId: z.string() }, annotations: { readOnlyHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:read"] }] },
  }, withErrors(async ({ propertyId }) => { requireMcpScope(identity.scopes, "vermieterme:read"); return result("Processing status", serializeExact({ archives: await prisma.documentArchive.findMany({ where: { document: { propertyId } } }), sources: await prisma.microsoftImportSource.findMany({ where: { propertyId } }), reviews: await prisma.invoiceExtractionJob.findMany({ where: { invoice: { propertyId }, status: { in: ["REVIEW_REQUIRED", "FAILED"] } } }), notices: await prisma.billingNotice.findMany({ where: { propertyId, resolvedAt: null } }), dispatches: await prisma.statementDispatch.findMany({ where: { artifactId: { in: (await prisma.statementArtifact.findMany({ where: { billingPeriodId: { in: (await prisma.billingPeriod.findMany({ where: { propertyId }, select: { id: true } })).map((p) => p.id) } }, select: { id: true } })).map((a) => a.id) } } }) }) as Record<string, unknown>); }));
  register("queue_property_originals", { title: "Archive existing property originals", description: "Queue existing receipt/contract originals at the explicitly activated OneDrive target. Check results for missing local files. Does not copy invoices into billing folders or enable storage.", inputSchema: { propertyId: z.string(), reason: z.string().min(3) }, annotations: { readOnlyHint: false, openWorldHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:admin"] }] } }, withErrors(async ({ propertyId, reason }) => { requireMcpScope(identity.scopes, "vermieterme:admin"); const queued = await queuePropertyOriginals(propertyId); await recordLifecycleAudit({ ...auditContext(reason), action: "QUEUE_ORIGINAL_ARCHIVE", entityType: "DocumentStorage", itemRef: propertyId, after: queued }); return result("Original archive jobs", queued); }));
  register("retry_archive", { title: "Retry a failed archive", description: "Retry the same original bytes and path after resolving an upload or permission error.", inputSchema: { documentId: z.string() }, annotations: { readOnlyHint: false, openWorldHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:write"] }] } }, withErrors(async ({ documentId }) => { requireMcpScope(identity.scopes, "vermieterme:write"); return result("Archive retry queued", { job: serializeExact(await retryDocumentArchive(documentId)) }); }));
  register("test_microsoft_source", { title: "Check selected Microsoft permissions", description: "Read the selected mailbox or OneDrive folder before explicitly enabling it. Never reads secrets or activates import.", inputSchema: { sourceId: z.string() }, annotations: { readOnlyHint: true, openWorldHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:admin"] }] } }, withErrors(async ({ sourceId }) => { requireMcpScope(identity.scopes, "vermieterme:admin"); return result("Microsoft preflight", { check: await testMicrosoftSource(sourceId) }); }));
  register("test_document_storage", { title: "Check selected OneDrive archive target", description: "Read the selected drive/root folder before enabling uploads. Upload verification remains mandatory.", inputSchema: { propertyId: z.string() }, annotations: { readOnlyHint: false, openWorldHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:admin"] }] } }, withErrors(async ({ propertyId }) => { requireMcpScope(identity.scopes, "vermieterme:admin"); return result("OneDrive target check", await testDocumentStorage(propertyId)); }));
  register("resolve_onedrive_target", { title: "Inspect cloud archive folder", description: "Resolve the selected user's OneDrive drive/folder IDs and inspect cloud contents before configuring archive. Uses no Windows paths and creates nothing.", inputSchema: { mailbox: z.string().email(), folderPath: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:admin"] }] } }, withErrors(async ({ mailbox, folderPath }) => { requireMcpScope(identity.scopes, "vermieterme:admin"); return result("Resolved cloud targets", await resolveOneDriveTarget(mailbox, folderPath)); }));
  register("describe_domain_actions", { title: "Discover business action inputs", description: "List supported dated actions and required input keys. Financial amounts are integer-cent strings; dates YYYY-MM-DD; IDs from workspace/get_item. Rules require units [{unitId,included,weight,areaM2}], sources kind MAIL/ONEDRIVE and enabled false until tested. confirm_invoice_sample requires independently read expected fields, expectedLines, role TRAINING/HOLDOUT. prepare_krandorf_transition requires propertyId, rules sourceDocumentId, tenantDocuments {tenancyId:contractDocumentId}, optional original billingPeriodId.", inputSchema: {}, annotations: { readOnlyHint: true }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["vermieterme:read"] }] } }, withErrors(async () => { requireMcpScope(identity.scopes, "vermieterme:read"); return result("Business action contract", { actions: {"align_billing_boundary": ["propertyId", "previousPeriodId", "nextPeriodId", "boundaryDate", "replacedPeriodIds", "readingIds"], "defer_contract_transition": ["propertyId", "previousValidFrom", "validFrom", "financialPeriodIds", "ruleIds", "agreementIds", "heatingSystemId"], "create_property": ["city", "street", "zip"], "update_property": ["city", "id", "street", "zip"], "create_unit": ["areaM2", "floor", "name", "propertyId", "sourceDocumentId", "validFrom"], "change_unit_state": ["areaM2", "sourceDocumentId", "unitId", "validFrom"], "create_tenancy": ["firstName", "lastName", "moveInDate", "salutation", "sourceDocumentId", "unitId"], "update_tenant_contacts": ["tenantId"], "end_tenancy": ["moveOutDate", "sourceDocumentId", "tenantId"], "move_tenant": ["moveInDate", "moveOutDate", "sourceDocumentId", "tenantId", "unitId"], "add_lease_party": ["firstName", "lastName", "sourceDocumentId", "tenantId", "validFrom"], "end_lease_party": ["id", "validTo"], "set_financial_period": ["monthlyColdRentCents", "monthlyElectricityPrepaymentCents", "monthlyFlatRateCents", "monthlyGeneralOperatingAndHeatingPrepaymentCents", "sourceDocumentId", "tenantId", "validFrom"], "set_allocation_rule": ["allocationMethod", "costCategoryId", "propertyId", "sourceDocumentId", "validFrom", "units"], "create_cost_category": ["code", "name"], "set_period_category": ["billingPeriodId", "costCategoryId"], "create_billing_period": ["endDate", "propertyId", "startDate"], "split_billing_period": ["billingPeriodId", "splitDate"], "set_electricity_tariff": ["contractId", "monthlyBasePriceCents", "priceMicroEuroPerKwh", "sourceDocumentId", "validFrom", "vatRate"], "create_electricity_contract": ["basePriceAgreementNote", "propertyId", "provider", "validFrom"], "create_electricity_meter": ["contractId", "meterNumber", "role", "validFrom"], "record_electricity_reading": ["meterId", "readingDate", "readingKwh"], "record_heat_reading": ["heatMeterId", "readingDate", "sourceDocumentId", "value"], "record_consumption_reading": ["costCategoryId", "quantity", "readingDate", "sourceDocumentId", "unitId"], "configure_heating_system": ["billingRegime", "consumptionSharePercent", "id", "sourceDocumentId", "validFrom"], "select_active_tank": ["heatingSystemId", "tankId"], "configure_document_storage": ["driveId", "objectFolder", "propertyId", "rootItemId"], "configure_microsoft_source": ["costCategoryId", "folderId", "kind", "propertyId", "section"], "update_landlord": ["id"], "confirm_invoice_sample": ["documentId", "expected", "role"], "set_cost_agreement": ["costCategoryId", "sourceDocumentId", "tenantId", "validFrom"], "record_billing_evidence": ["billingPeriodId", "kind", "sourceDocumentId"], "create_heat_meter": ["heatingSystemId", "meterNumber", "sourceDocumentId", "unitId", "validFrom"], "end_meter_assignment": ["kind", "meterId", "sourceDocumentId", "validTo"], "create_heating_system": ["name", "propertyId", "sourceDocumentId", "unitIds"], "create_oil_tank": ["capacityLiters", "heatingSystemId", "name", "sourceDocumentId", "validFrom"], "record_oil_stock": ["quantityLiters", "readingDate", "sourceDocumentId", "tankId"], "set_oil_opening_balance": ["co2CostCents", "co2Grams", "quantityLiters", "sourceDocumentId", "tankId", "totalAmountCents", "validFrom"], "revise_allocation_rule": ["id"], "revise_financial_period": ["id"], "correct_electricity_reading": ["id", "readingKwh", "sourceDocumentId"], "revise_billing_period": ["billingPeriodId"], "set_property_tax_basis": ["annualAllocatableAmountCents", "annualAssessmentCents", "propertyId", "sourceDocumentId"], "prepare_krandorf_transition": ["propertyId", "sourceDocumentId", "tenantDocuments"]} }); }));
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  return server;
}
