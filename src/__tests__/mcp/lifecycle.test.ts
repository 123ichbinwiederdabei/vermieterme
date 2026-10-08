import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/energy-preview", () => ({ buildEnergyPreview: vi.fn() }));

import { assertPublicDownloadUrl } from "@/lib/mcp/lifecycle";

describe("MCP document upload safety", () => {
  it("rejects non-HTTPS and loopback download URLs", async () => {
    await expect(assertPublicDownloadUrl("http://files.example.test/document.pdf")).rejects.toThrow(/public HTTPS/);
    await expect(assertPublicDownloadUrl("https://127.0.0.1/document.pdf")).rejects.toThrow(/private network/);
    await expect(assertPublicDownloadUrl("https://[::1]/document.pdf")).rejects.toThrow(/private network/);
  });
});
