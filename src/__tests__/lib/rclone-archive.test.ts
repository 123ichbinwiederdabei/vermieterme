import { afterEach, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { RcloneArchiveTransport, storageTestSettings, archiveBackend } from "@/lib/archive-transport";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const files = new Map<string, { id: string; bytes: Buffer }>();
let rootId = "root";
let calls: string[][] = [];
const config = async () => "[VermieterMe-Archive]\ntype = onedrive\ndrive_id = drive\nroot_folder_id = root\n";
const strip = (s: string) => s.replace(/^VermieterMe-Archive:/, "");
async function execute(args: string[]) {
  calls.push(args);
  const [command, first, second] = args;
  if (command === "lsjson") {
    if (args.includes("--stat")) {
      if (!strip(first)) return Buffer.from(JSON.stringify({ ID: `drive#${rootId}`, IsDir: true, Name: "VermieterMe" }));
      const file = files.get(strip(first))!;
      return Buffer.from(JSON.stringify({ ID: `drive#${file.id}`, IsDir: false, Size: file.bytes.length }));
    }
    return Buffer.from(JSON.stringify([...files.entries()].map(([Path, f]) => ({ ID: `drive#${f.id}`, Path, Name: Path.split("/").at(-1), IsDir: false, Size: f.bytes.length }))));
  }
  if (command === "cat") return Buffer.from(files.get(strip(first))!.bytes);
  if (command === "copyto") {
    expect(args).toContain("--immutable"); expect(args).toContain("--checksum");
    const bytes = await readFile(first); const dest = strip(second);
    if (files.has(dest)) throw new Error("immutable conflict");
    files.set(dest, { id: `item-${files.size}`, bytes }); return Buffer.alloc(0);
  }
  if (command === "moveto") {
    expect(args).toContain("--immutable"); const source = strip(first), target = strip(second);
    if (files.has(target)) throw new Error("occupied");
    files.set(target, files.get(source)!); files.delete(source); return Buffer.alloc(0);
  }
  throw new Error("Unexpected command");
}
beforeEach(() => {
  files.clear(); calls = []; rootId = "root";
  Object.assign(process.env, { ONEDRIVE_ARCHIVE_BACKEND: "rclone", RCLONE_ARCHIVE_REMOTE: "VermieterMe-Archive", RCLONE_ARCHIVE_CONFIG: "/private/rclone.conf", RCLONE_ARCHIVE_DRIVE_ID: "drive", RCLONE_ARCHIVE_ROOT_ID: "root" });
});
afterEach(() => { for (const key of ["ONEDRIVE_ARCHIVE_BACKEND", "RCLONE_ARCHIVE_REMOTE", "RCLONE_ARCHIVE_CONFIG", "RCLONE_ARCHIVE_DRIVE_ID", "RCLONE_ARCHIVE_ROOT_ID"]) delete process.env[key]; });
it("uploads immutable bytes, verifies SHA-256 and retries without a second file", async () => {
  const storage = new RcloneArchiveTransport(execute, config); const bytes = Buffer.from("original");
  expect(await storage.uploadImmutable("drive", "root", "Krandorf/2026/Rechnungen/Wasser/original.pdf", bytes)).toBe("item-0");
  expect(await storage.uploadImmutable("drive", "root", "Krandorf/2026/Rechnungen/Wasser/original.pdf", bytes)).toBe("item-0");
  expect(calls.filter(a => a[0] === "copyto")).toHaveLength(1);
  await expect(storage.uploadImmutable("drive", "root", "Krandorf/2026/Rechnungen/Wasser/original.pdf", Buffer.from("changed!"))).rejects.toThrow("SHA-256");
  expect(files.get("Krandorf/2026/Rechnungen/Wasser/original.pdf")?.bytes).toEqual(bytes);
});
it("moves one original by stable Graph ID and keeps R001 when creating R002", async () => {
  const storage = new RcloneArchiveTransport(execute, config), bytes = Buffer.from("statement revision 1");
  const id = await storage.uploadImmutable("drive", "root", "Entwuerfe/draft.pdf", bytes);
  expect(await storage.moveImmutable("drive", "root", id, "Freigegeben/R001.pdf", hash(bytes))).toBe(id);
  await storage.uploadImmutable("drive", "root", "Freigegeben/R002.pdf", Buffer.from("statement revision 2"));
  expect(files.get("Freigegeben/R001.pdf")?.bytes).toEqual(bytes);
  expect(files.has("Entwuerfe/draft.pdf")).toBe(false);
});
it("rejects occupied move targets even when their bytes are identical", async () => {
  const s = new RcloneArchiveTransport(execute, config), bytes = Buffer.from("same");
  const id = await s.uploadImmutable("drive", "root", "draft.pdf", bytes);
  await s.uploadImmutable("drive", "root", "issued.pdf", bytes);
  await expect(s.moveImmutable("drive", "root", id, "issued.pdf", hash(bytes))).rejects.toThrow("occupied");
  expect(files.size).toBe(2);
});
it("blocks stale or misbound roots before mutation and rejects path escapes", async () => {
  const s = new RcloneArchiveTransport(execute, config);
  await expect(s.uploadImmutable("other", "root", "invoice.pdf", Buffer.from("x"))).rejects.toThrow("binding");
  await expect(s.uploadImmutable("drive", "root", "../outside.pdf", Buffer.from("x"))).rejects.toThrow("path");
  await expect(s.uploadImmutable("drive", "root", "folder\\outside.pdf", Buffer.from("x"))).rejects.toThrow("path");
  rootId = "other-root";
  await expect(s.uploadImmutable("drive", "root", "invoice.pdf", Buffer.from("x"))).rejects.toThrow("rooted");
  expect(calls.some(a => ["copyto", "moveto"].includes(a[0]))).toBe(false);
});
it("fails readback corruption and never marks a partial upload verified", async () => {
  const s = new RcloneArchiveTransport(async args => args[0] === "cat" ? Buffer.from("corrupt") : execute(args), config);
  await expect(s.uploadImmutable("drive", "root", "invoice.pdf", Buffer.from("original"))).rejects.toThrow("SHA-256");
});
it("binds activation checks to the runtime transport and exact root", () => {
  const target = { propertyId: "property", driveId: "drive", rootItemId: "root", objectFolder: "Krandorf" };
  const before = JSON.stringify(storageTestSettings(target)); process.env.RCLONE_ARCHIVE_ROOT_ID = "changed";
  expect(JSON.stringify(storageTestSettings(target))).not.toBe(before);
  process.env.ONEDRIVE_ARCHIVE_BACKEND = "graph"; expect(storageTestSettings(target)).toEqual(target);
  process.env.ONEDRIVE_ARCHIVE_BACKEND = "unknown"; expect(() => archiveBackend()).toThrow("Unknown");
});

it("requires a dedicated config and detects changed config targets", async () => {
  const s = new RcloneArchiveTransport(execute, async () => (await config()).replace("root_folder_id = root", "root_folder_id = other"));
  await expect(s.uploadImmutable("drive", "root", "invoice.pdf", Buffer.from("x"))).rejects.toThrow("configuration differs");
  const shared = new RcloneArchiveTransport(execute, async () => (await config()) + "[Shared]\ntype = local\n");
  await expect(shared.request("drives/drive/items/root")).rejects.toThrow("configuration differs");
  expect(calls).toHaveLength(0);
});
it("accepts rclone synthetic root stats without inventing a remote item ID", async () => {
  const s = new RcloneArchiveTransport(async args => args[0] === "lsjson" && args[1] === "VermieterMe-Archive:" && args.includes("--stat") ? Buffer.from('{"IsDir":true,"Name":""}') : execute(args), config);
  expect(await s.request("drives/drive/items/root")).toMatchObject({ id: "root", folder: {} });
});
