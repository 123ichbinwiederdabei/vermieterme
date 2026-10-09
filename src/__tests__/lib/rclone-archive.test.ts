import { afterEach, beforeEach, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { RcloneArchiveTransport, storageTestSettings, archiveBackend } from "@/lib/archive-transport";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const files = new Map<string, { id: string; bytes: Buffer }>();
let rootId = "root";
let calls: string[][] = [];
const config = async () => "[VermieterMe-Archive]\ntype = onedrive\ndrive_id = drive\nroot_folder_id = root\n";
const strip = (s: string) => s.replace(/^VermieterMe-Archive:/, "");
async function execute(args: string[]) {
  calls.push(args);
  const [command, first] = args;
  if (command === "lsjson") {
    if (args.includes("--stat")) {
      if (!strip(first)) return Buffer.from(JSON.stringify({ ID: `drive#${rootId}`, IsDir: true, Name: "VermieterMe" }));
      const file = files.get(strip(first))!;
      return Buffer.from(JSON.stringify({ ID: `drive#${file.id}`, IsDir: false, Size: file.bytes.length }));
    }
    return Buffer.from(JSON.stringify([...files.entries()].map(([Path, f]) => ({ ID: `drive#${f.id}`, Path, Name: Path.split("/").at(-1), IsDir: false, Size: f.bytes.length }))));
  }
  if (command === "rc") {
    expect(args).toContain("--loopback");
    expect(args).toContain('_config={"Immutable":true,"CheckSum":true}');
    const params = Object.fromEntries(args.filter(a => a.includes("=")).map(a => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
    if (first === "operations/stat") {
      expect(params.fs).toBe("VermieterMe-Archive:");
      const f = files.get(params.remote)!;
      return Buffer.from(JSON.stringify({ item: { ID: `drive#${f.id}`, IsDir: false, Size: f.bytes.length } }));
    }
    if (first === "operations/copyfile") {
      if (params.srcFs === "VermieterMe-Archive:") await writeFile(path.join(params.dstFs, params.dstRemote), files.get(params.srcRemote)!.bytes);
      else {
        expect(params.dstFs).toBe("VermieterMe-Archive:");
        if (files.has(params.dstRemote)) throw new Error("immutable conflict");
        files.set(params.dstRemote, { id: `item-${files.size}`, bytes: await readFile(path.join(params.srcFs, params.srcRemote)) });
      }
      return Buffer.from("{}");
    }
    if (first === "operations/movefile") {
      expect(params.srcFs).toBe("VermieterMe-Archive:"); expect(params.dstFs).toBe(params.srcFs);
      if (files.has(params.dstRemote)) throw new Error("occupied");
      files.set(params.dstRemote, files.get(params.srcRemote)!); files.delete(params.srcRemote); return Buffer.from("{}");
    }
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
  expect(calls.filter(a => a[1] === "operations/copyfile" && a.includes("dstFs=VermieterMe-Archive:"))).toHaveLength(1);
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
  expect(calls.some(a => a[1] === "operations/movefile" || (a[1] === "operations/copyfile" && a.includes("dstFs=VermieterMe-Archive:")))).toBe(false);
});
it("fails readback corruption and never marks a partial upload verified", async () => {
  const s = new RcloneArchiveTransport(async args => {
    if (args[1] === "operations/copyfile" && args.includes("srcFs=VermieterMe-Archive:")) {
      const dir = args.find(a => a.startsWith("dstFs="))!.slice(6);
      await writeFile(path.join(dir, "original"), Buffer.from("corrupt")); return Buffer.from("{}");
    }
    return execute(args);
  }, config);
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

it("requires an actual cloud listing even when root metadata is synthetic", async () => {
  const s = new RcloneArchiveTransport(async args => args.includes("--stat") ? Buffer.from('{"IsDir":true}') : Promise.reject(new Error("cloud permission denied")), config);
  await expect(s.request("drives/drive/items/root")).rejects.toThrow("cloud permission denied");
});

it("uses literal rooted object paths for filenames with filter metacharacters", async () => {
  const s = new RcloneArchiveTransport(execute, config), bytes = Buffer.from("literal filename");
  const relative = "folder/invoice[1]{2}*.pdf";
  await s.uploadImmutable("drive", "root", relative, bytes);
  expect(calls.some(a => a.includes(`srcRemote=${relative}`))).toBe(true);
  expect(calls.some(a => a.includes("--include"))).toBe(false);
  expect(files.get(relative)?.bytes).toEqual(bytes);
});
