import { describe, expect, it, vi } from "vitest";
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
    ]));
    expect(tools.find((tool) => tool.name === "delete_item")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((tool) => tool.name === "list_items")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "upload_document")?._meta?.["openai/fileParams"]).toEqual(["file"]);
    await client.close();
    await server.close();
  });
});
