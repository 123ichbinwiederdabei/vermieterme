import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "admin" } }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { billingPeriod: { findUnique: vi.fn() }, $transaction: vi.fn() },
}));
vi.mock("@/lib/energy-preview", () => ({ buildEnergyPreview: vi.fn() }));
import { prisma } from "@/lib/prisma";
import { buildEnergyPreview } from "@/lib/energy-preview";
import { POST } from "@/app/api/billing-periods/[id]/energy-preview/route";
beforeEach(() => vi.clearAllMocks());
it("Applying one MANUAL category does not supersede another category's snapshot", async () => {
  const snapshots = [
    {
      billingPeriodId: "period",
      kind: "MANUAL",
      costCategoryId: "tax",
      status: "APPLIED",
    },
    {
      billingPeriodId: "period",
      kind: "MANUAL",
      costCategoryId: "water",
      status: "APPLIED",
    },
  ];
  const heads = [
    {
      billingPeriodId: "period",
      costCategoryId: "water",
      snapshotId: "water-snapshot",
    },
  ];
  const tx = {
    billingPeriod: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ statementRevisions: [], sourceRevision: 0 }),
    },
    categoryCalculationHead: { findUnique: vi.fn(), upsert: vi.fn() },
    billingSnapshot: {
      updateMany: vi.fn(async ({ where, data }) => {
        for (const row of snapshots)
          if (
            Object.entries(where).every(
              ([key, value]) => row[key as keyof typeof row] === value,
            )
          )
            row.status = data.status;
      }),
      create: vi.fn(async ({ data }) => ({ id: "new", ...data })),
    },
    costAllocation: { deleteMany: vi.fn(), createMany: vi.fn() },
    cost: { upsert: vi.fn() },
  };
  vi.mocked(prisma.billingPeriod.findUnique).mockResolvedValue({
    sentDate: null,
    paidDate: null,
    statementRevisions: [],
    sourceRevision: 0,
  } as never);
  vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
    (callback as unknown as (value: typeof tx) => Promise<never>)(tx),
  );
  vi.mocked(buildEnergyPreview).mockResolvedValue({
    kind: "MANUAL",
    costCategoryId: "tax",
    totalAmountCents: "100",
    blockers: [],
    allocations: [],
    sourceFingerprint: "test",
    details: {},
  } as never);
  const response = await POST(
    new Request("http://local/energy-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "MANUAL", costCategoryId: "tax" }),
    }),
    { params: Promise.resolve({ id: "period" }) },
  );
  expect(response.status).toBe(201);
  expect(snapshots[1].status).toBe("APPLIED");
  expect(heads[0].snapshotId).toBe("water-snapshot");
  expect(tx.billingSnapshot.updateMany).not.toHaveBeenCalled();
  expect(tx.costAllocation.deleteMany).not.toHaveBeenCalled();
  expect(tx.categoryCalculationHead.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({ costCategoryId: "tax" }),
    }),
  );
});
