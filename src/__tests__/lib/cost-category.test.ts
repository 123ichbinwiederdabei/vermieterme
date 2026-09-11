import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { costCategory: { findFirst: vi.fn() } },
}));

vi.mock("@/lib/api-utils", () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number) { super(message); }
  },
}));

import { prisma } from "@/lib/prisma";
import { validateCalculationType } from "@/lib/cost-category";

describe("automatic cost categories", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows manual categories without a uniqueness lookup", async () => {
    await expect(validateCalculationType("MANUAL")).resolves.toBeUndefined();
    expect(prisma.costCategory.findFirst).not.toHaveBeenCalled();
  });

  it("prevents a second automatic heating-oil category", async () => {
    vi.mocked(prisma.costCategory.findFirst).mockResolvedValue({ id: "oil", name: "Heizöl" } as never);
    await expect(validateCalculationType("HEATING_OIL")).rejects.toMatchObject({ status: 409 });
  });

  it("allows the existing category itself when editing", async () => {
    vi.mocked(prisma.costCategory.findFirst).mockResolvedValue(null);
    await expect(validateCalculationType("ELECTRICITY", "electricity")).resolves.toBeUndefined();
    expect(prisma.costCategory.findFirst).toHaveBeenCalledWith({
      where: { calculationType: "ELECTRICITY", id: { not: "electricity" } },
    });
  });
});
