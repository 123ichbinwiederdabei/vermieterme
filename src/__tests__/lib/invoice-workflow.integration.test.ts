// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createKrandorfFixture,
  fixturePng,
} from "../../../test-support/krandorf-fixture";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "test-user" } }),
}));
import { confirmInvoice } from "@/lib/invoice-service";
import { buildEnergyPreview } from "@/lib/energy-preview";
import { buildTenantStatement } from "@/lib/billing-statement";
import { POST as apply } from "@/app/api/billing-periods/[id]/energy-preview/route";
import { POST as issue } from "@/app/api/billing-periods/[id]/issue/route";
import { POST as reviseLot } from "@/app/api/heating-oil/route";
import { POST as revise } from "@/app/api/billing-periods/[id]/revise/route";
import {
  GET as exportBackup,
  POST as restoreBackup,
} from "@/app/api/backup/route";
import { processNextInvoiceJob } from "@/lib/invoice-jobs";
import { googleInvoiceOcr } from "@/lib/google-invoice-ocr";
vi.mock("@/lib/google-invoice-ocr", () => ({ googleInvoiceOcr: vi.fn() }));

let folder: string;
let fixture: Awaited<ReturnType<typeof createKrandorfFixture>>;
function migratedClient(name: string) {
  const databasePath = path.join(folder, `${name}.db`);
  // Prisma Migrate requires the SQLite file to exist before applying the
  // migration chain on Windows.
  writeFileSync(databasePath, "");
  const url = `file:${databasePath}`;
  execFileSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
  );
  return new PrismaClient({ datasources: { db: { url } } });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (body: unknown) =>
  new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
async function invoice(
  code: string,
  section: string,
  total: string,
  extras: Record<string, string> = {},
  lines?: Array<{
    classification: string;
    amountCents: string;
    description: string;
  }>,
) {
  const row = await state.db.costInvoice.create({
    data: {
      billingPeriodId: fixture.period.id,
      propertyId: fixture.property.id,
      costCategoryId: fixture.categories[code],
      section,
      totalAmountCents: 0n,
      attachments: { create: { documentId: fixture.document.id } },
    },
  });
  await confirmInvoice(
    row.id,
    {
      values: {
        supplier: `${code} Test`,
        invoiceNumber: row.id,
        invoiceDate: "2026-12-31",
        servicePeriodStart: "2026-10-01",
        servicePeriodEnd: "2026-12-31",
        totalAmountCents: total,
        ...extras,
      },
      ...(lines ? { lines } : {}),
    },
    "test-user",
  );
  return row;
}
beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "vermieterme-workflow-"));
  state.db = migratedClient("original");
  fixture = await createKrandorfFixture(state.db, "integration");
  await mkdir("data/uploads", { recursive: true });
  await writeFile(
    path.join("data/uploads", fixture.document.fileName),
    fixturePng,
  );
}, 60_000);
afterAll(async () => {
  await state.db.$disconnect();
  if (fixture)
    await rm(path.join("data/uploads", fixture.document.fileName), {
      force: true,
    });
  await rm(folder, { recursive: true, force: true });
});

it("migrates, conserves every category, appends snapshots and freezes issued statements", async () => {
  const originalLot = await state.db.oilInventoryLot.findFirstOrThrow({
    where: { tankId: fixture.tank.id },
  });
  const revisedLot = await reviseLot(
    request({
      action: "reviseLot",
      lotId: originalLot.id,
      revisionReason: "CO₂-Beleg geprüft",
      co2CostCents: "10000",
      co2Grams: "2680000",
      co2EvidenceReference: fixture.document.id,
    }),
  );
  expect(revisedLot.status, await revisedLot.text()).toBe(201);
  expect(
    await state.db.oilInventoryLot.findUnique({
      where: { id: originalLot.id },
    }),
  ).toEqual(originalLot);
  await invoice("HEATING", "WARTUNG", "11900", {
    netAmountCents: "10000",
    vatAmountCents: "1900",
    vatRate: "19",
  });
  await invoice("ELECTRICITY", "TARIF", "0", {
    contractId: fixture.contract.id,
    tariffValidFrom: "2026-10-01",
    priceMicroEuroPerKwh: "276400",
    monthlyBasePriceCents: "1000",
  });
  await invoice("WATER", "WASSER", "39000");
  await invoice("WASTE", "GEBÜHREN", "30000");
  await invoice("WASTEWATER", "WARTUNG", "36000", {}, [
    { classification: "WARTUNG", description: "Wartung", amountCents: "30000" },
    {
      classification: "REPARATUR",
      description: "Pumpe ersetzt",
      amountCents: "6000",
    },
  ]);
  await invoice("PROPERTY_TAX", "BESCHEID", "120000", {
    annualAllocatableAmountCents: "28000",
    taxBasisNote:
      "Nur 80+200 m²; Grundstück, Garten, Garage und Vermieteranteil abgezogen",
  });
  const kinds: Record<string, string> = {
    HEATING: "HEATING_OIL",
    ELECTRICITY: "ELECTRICITY",
    WATER: "MANUAL",
    WASTE: "MANUAL",
    WASTEWATER: "SMALL_WASTEWATER",
    PROPERTY_TAX: "MANUAL",
  };
  for (const [code, kind] of Object.entries(kinds)) {
    const preview = await buildEnergyPreview(
      kind,
      fixture.period.id,
      fixture.categories[code],
    );
    expect(preview.blockers, code).toEqual([]);
    expect(BigInt(preview.totalAmountCents), code).toBe(
      BigInt(preview.tenantAmountCents) + BigInt(preview.landlordAmountCents),
    );
    const response = await apply(
      request({ kind, costCategoryId: fixture.categories[code] }),
      params(fixture.period.id),
    );
    expect(response.status, await response.text()).toBe(201);
    const repeated = await buildEnergyPreview(
      kind,
      fixture.period.id,
      fixture.categories[code],
    );
    expect(repeated.sourceFingerprint, code).toBe(preview.sourceFingerprint);
  }
  const firstAllocation = await state.db.costAllocation.findFirstOrThrow({
    where: { costCategoryId: fixture.categories.WATER },
  });
  const applied = await apply(
    request({ kind: "MANUAL", costCategoryId: fixture.categories.WATER }),
    params(fixture.period.id),
  );
  expect(applied.status).toBe(201);
  expect(
    await state.db.costAllocation.findUnique({
      where: { id: firstAllocation.id },
    }),
  ).toEqual(firstAllocation);
  expect(
    await state.db.billingSnapshot.count({
      where: { costCategoryId: fixture.categories.WATER },
    }),
  ).toBe(2);
  const response = await issue(request({}), params(fixture.period.id));
  expect(response.status, await response.text()).toBe(201);
  const frozen = await buildTenantStatement(
    fixture.period.id,
    fixture.tenants[0].id,
  );
  expect(frozen.draft).toBe(false);
  expect(frozen.totalActualCents).toBe("83462");
  expect(frozen.totalPrepaymentCents).toBe("60000");
  const oldSnapshots = await state.db.billingSnapshot.findMany();
  const oldConsumptions = await state.db.oilLotConsumption.findMany();
  await state.db.tenant.update({
    where: { id: fixture.tenants[0].id },
    data: { firstName: "Geändert" },
  });
  await state.db.leaseFinancialPeriod.updateMany({
    data: { monthlyColdRentCents: 100000n },
  });
  await state.db.categoryCalculationHead.updateMany({ data: { stale: true } });
  expect(
    await buildTenantStatement(fixture.period.id, fixture.tenants[0].id),
  ).toEqual(frozen);
  expect(
    (
      await apply(
        request({ kind: "MANUAL", costCategoryId: fixture.categories.WATER }),
        params(fixture.period.id),
      )
    ).status,
  ).toBe(409);
  const revision = await revise(
    request({ reason: "Belegkorrektur" }),
    params(fixture.period.id),
  );
  expect(revision.status).toBe(201);
  const correction = await revision.json();
  const heating = await buildEnergyPreview(
    "HEATING_OIL",
    correction.id,
    fixture.categories.HEATING,
  );
  expect(heating.totalAmountCents).toBe("61900");
  expect(
    (
      await apply(
        request({
          kind: "HEATING_OIL",
          costCategoryId: fixture.categories.HEATING,
        }),
        params(correction.id),
      )
    ).status,
  ).toBe(201);
  expect(
    await state.db.billingSnapshot.findMany({
      where: { id: { in: oldSnapshots.map((row) => row.id) } },
    }),
  ).toEqual(oldSnapshots);
  expect(
    await state.db.oilLotConsumption.findMany({
      where: { id: { in: oldConsumptions.map((row) => row.id) } },
    }),
  ).toEqual(oldConsumptions);
  expect(
    await buildTenantStatement(fixture.period.id, fixture.tenants[0].id),
  ).toEqual(frozen);
}, 60_000);

it("processes durable OCR jobs once, retains proposals for review and never applies costs", async () => {
  const row = await state.db.costInvoice.create({
    data: {
      billingPeriodId: fixture.period.id,
      propertyId: fixture.property.id,
      costCategoryId: fixture.categories.WATER,
      section: "WASSER",
      totalAmountCents: 0n,
    },
  });
  const job = await state.db.invoiceExtractionJob.create({
    data: { invoiceId: row.id, documentId: fixture.document.id },
  });
  vi.mocked(googleInvoiceOcr).mockResolvedValue({
    text: "Wasserwerk Muster",
    pages: [{ page: 1, words: [] }],
  });
  expect(await processNextInvoiceJob()).toBe(true);
  const result = await state.db.invoiceExtractionJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  expect(result.status).toBe("REVIEW_REQUIRED");
  expect(result.attempts).toBe(1);
  expect(JSON.parse(result.resultJson!).errors[0]).toContain(
    "Keine veröffentlichte",
  );
  expect(
    (await state.db.costInvoice.findUniqueOrThrow({ where: { id: row.id } }))
      .status,
  ).toBe("DRAFT");
  expect(await processNextInvoiceJob()).toBe(false);
});

it("exports and restores all invoice, FIFO and statement history into an isolated empty database", async () => {
  const response = await exportBackup();
  const backup = await response.json();
  expect(backup.version).toBe(3);
  const expected = backup.data;
  await state.db.$disconnect();
  state.db = migratedClient("restored");
  const restored = await restoreBackup(request(backup));
  expect(restored.status, await restored.text()).toBe(200);
  const exported = await (await exportBackup()).json();
  for (const key of Object.keys(expected))
    expect(exported.data[key], key).toEqual(expected[key]);
  const statement = await buildTenantStatement(
    fixture.period.id,
    fixture.tenants[0].id,
  );
  expect(statement.totalActualCents).toBe("83462");
  expect((await restoreBackup(request(backup))).status).toBe(409);
}, 60_000);

it("revises consumed oil evidence for an unissued draft without changing its applied ledger", async () => {
  const draft = await createKrandorfFixture(state.db, "draft-oil");
  const lot = await state.db.oilInventoryLot.findFirstOrThrow({
    where: { tankId: draft.tank.id },
  });
  const applied = await apply(
    request({ kind: "HEATING_OIL", costCategoryId: draft.categories.HEATING }),
    params(draft.period.id),
  );
  expect(applied.status, await applied.text()).toBe(201);
  const ledger = await state.db.oilLotConsumption.findMany({
    where: { lotId: lot.id },
  });
  const values = {
    action: "reviseLot",
    lotId: lot.id,
    revisionReason: "CO₂-Rechnungswert korrigiert",
    co2CostCents: "12000",
    co2Grams: "2680000",
    co2EvidenceReference: draft.document.id,
  };
  expect((await reviseLot(request(values))).status).toBe(409);
  const revision = await reviseLot(
    request({ ...values, billingPeriodId: draft.period.id }),
  );
  expect(revision.status, await revision.text()).toBe(201);
  expect(
    await state.db.oilInventoryLot.findUnique({ where: { id: lot.id } }),
  ).toEqual(lot);
  expect(
    await state.db.oilLotConsumption.findMany({ where: { lotId: lot.id } }),
  ).toEqual(ledger);
  const reapplied = await apply(
    request({ kind: "HEATING_OIL", costCategoryId: draft.categories.HEATING }),
    params(draft.period.id),
  );
  expect(reapplied.status, await reapplied.text()).toBe(201);
  expect(
    await state.db.billingSnapshot.count({
      where: { billingPeriodId: draft.period.id },
    }),
  ).toBe(2);
  expect(
    await state.db.oilLotConsumption.findMany({ where: { lotId: lot.id } }),
  ).toEqual(ledger);
});
