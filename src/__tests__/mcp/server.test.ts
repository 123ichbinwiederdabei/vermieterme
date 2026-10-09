import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/api-utils", () => ({
  ApiError: class ApiError extends Error { constructor(message: string, public status: number) { super(message); } },
}));

import { createVermieterMeMcpServer } from "@/lib/mcp/server";

describe("VermieterMe MCP server", () => {
  it("advertises focused schemas and correct safety annotations", async () => {
    const server = createVermieterMeMcpServer({ userId: "u1", email: "admin@example.test", clientId: "c1", scopes: ["vermieterme:admin"] });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "list_entity_types", "get_item", "create_item", "update_item", "delete_item",
      "revise_financial_period", "apply_billing_calculation", "correct_electricity_reading", "upload_document",
      "create_invoice_draft", "update_invoice_draft", "confirm_invoice", "discard_invoice_draft",
      "queue_invoice_extraction", "create_invoice_template", "update_invoice_template",
      "test_invoice_template", "publish_invoice_template", "preview_domain_change", "commit_domain_change", "preview_billing", "issue_billing", "preview_statement_send", "send_statement",
    ]));
    expect(tools.find((tool) => tool.name === "delete_item")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((tool) => tool.name === "list_items")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "upload_document")?._meta?.["openai/fileParams"]).toEqual(["file"]);
    const issue = tools.find((tool) => tool.name === "issue_billing")!;
    expect(issue._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["vermieterme:approve"] }]);
    // SDK listTools strips extension fields on receipt; inspect the raw wire
    // result with a preserving schema to verify ChatGPT's top-level descriptor.
    const wire = await client.request({ method: "tools/list" }, z.object({ tools: z.array(z.object({ name: z.string(), securitySchemes: z.unknown() }).passthrough()) }));
    expect(wire.tools.find((tool) => tool.name === "issue_billing")?.securitySchemes).toEqual(issue._meta?.securitySchemes);
    process.env.MCP_BASE_URL = "https://vermieterme.example.test";
    const denied = await client.callTool({ name: "issue_billing", arguments: { previewId: "test", confirmed: true, reason: "Reviewed" } });
    expect(denied.isError).toBe(true);
    expect(denied._meta?.["mcp/www_authenticate"]).toEqual(expect.arrayContaining([expect.stringContaining("insufficient_scope")]));
    await client.close();
    await server.close();
  });
});
