// @vitest-environment node
import { expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

it("upgrades existing originals and issued snapshots without inventing history or changing IDs", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vermieterme-upgrade-"));
  const schema = path.join(folder, "schema.prisma");
  const migrations = path.join(folder, "migrations");
  const latest = "20261008230000_end_to_end_chatgpt";
  const url = `file:${path.join(folder, "upgrade.db")}`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const deploy = () => execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", schema], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  try {
    await mkdir(migrations);
    await cp("prisma/schema.prisma", schema);
    await writeFile(path.join(folder, "upgrade.db"), "");
    for (const name of await readdir("prisma/migrations")) if (name !== latest) await cp(path.join("prisma/migrations", name), path.join(migrations, name), { recursive: true });
    deploy();
    await db.$executeRaw`INSERT INTO Property (id, street, zip, city, updatedAt) VALUES ('legacy-property', 'Existing', '92431', 'Krandorf', CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO Unit (id, propertyId, name, floor, shares, areaM2, updatedAt) VALUES ('legacy-unit', 'legacy-property', 'EG', 'EG', 1, 80, CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO Tenant (id, unitId, salutation, firstName, lastName, moveInDate, updatedAt) VALUES ('legacy-tenant', 'legacy-unit', 'Frau', 'Original', 'Tenant', 0, CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO BillingPeriod (id, propertyId, startDate, endDate, updatedAt) VALUES ('legacy-period', 'legacy-property', 0, 86400000, CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO Document (id, billingPeriodId, fileName, originalName, mimeType, size, fileHash) VALUES ('legacy-document', 'legacy-period', 'original.pdf', 'Original invoice.pdf', 'application/pdf', 100, 'preserved-original-hash')`;
    await db.$executeRaw`INSERT INTO CostInvoice (id, billingPeriodId, propertyId, costCategoryId, documentId, section, status, totalAmountCents, dataJson, updatedAt) VALUES ('legacy-invoice', 'legacy-period', 'legacy-property', 'krandorf-water', 'legacy-document', 'WASSER', 'CONFIRMED', 11900, '{"original":true}', CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO StatementRevision (id, billingPeriodId, tenantId, revision, payloadJson, snapshotIdsJson, issuedBy) VALUES ('legacy-statement', 'legacy-period', 'legacy-tenant', 1, '{"frozen":"unchanged"}', '[]', 'legacy-user')`;
    const before = await db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM StatementRevision WHERE id = 'legacy-statement'`;
    await cp(path.join("prisma/migrations", latest), path.join(migrations, latest), { recursive: true });
    deploy();
    expect(await db.$queryRaw`SELECT * FROM StatementRevision WHERE id = 'legacy-statement'`).toEqual(before);
    expect(await db.document.findUnique({ where: { id: "legacy-document" } })).toMatchObject({ fileName: "original.pdf", fileHash: "preserved-original-hash", originalName: "Original invoice.pdf", propertyId: null });
    expect(await db.costInvoice.findUnique({ where: { id: "legacy-invoice" } })).toMatchObject({ status: "CONFIRMED", totalAmountCents: 11900n, billingPeriodId: "legacy-period", dataJson: '{"original":true}' });
    expect(await db.unitStatePeriod.count()).toBe(0);
    expect(await db.documentStorage.count()).toBe(0);
    expect(await db.microsoftImportSource.count()).toBe(0);
  } finally { await db.$disconnect(); await rm(folder, { recursive: true, force: true }); }
}, 60_000);
