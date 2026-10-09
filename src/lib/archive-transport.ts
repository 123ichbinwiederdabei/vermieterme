import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MicrosoftGraph } from "@/lib/microsoft-graph";

export type ArchiveTransport = Pick<MicrosoftGraph, "request" | "uploadImmutable" | "moveImmutable">;
export type StorageTarget = { propertyId: string; driveId: string; rootItemId: string; objectFolder: string };
export class RcloneArchiveError extends Error {
  constructor(public retryable: boolean) { super(retryable ? "rclone archive temporarily unavailable" : "rclone archive requires configuration or file review"); }
}
export function archiveBackend() {
  const mode = process.env.ONEDRIVE_ARCHIVE_BACKEND || "graph";
  if (mode !== "graph" && mode !== "rclone") throw new Error("Unknown OneDrive archive backend");
  return mode;
}
export function storageTestSettings(target: StorageTarget) {
  // Runtime target changes invalidate consent checks as well as database changes.
  return archiveBackend() === "graph" ? target : { ...target, backend: "rclone", remote: process.env.RCLONE_ARCHIVE_REMOTE, driveBinding: process.env.RCLONE_ARCHIVE_DRIVE_ID, rootBinding: process.env.RCLONE_ARCHIVE_ROOT_ID };
}
type Item = { ID?: string; Path?: string; Name?: string; IsDir?: boolean; Size?: number };
export type RcloneRunner = (args: string[]) => Promise<Buffer>;
function run(args: string[]): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("RCLONE_")) delete env[key];
  return new Promise((resolve, reject) => execFile(process.env.RCLONE_BINARY || "/usr/local/bin/rclone", args, { encoding: "buffer", maxBuffer: 11 * 1024 * 1024, timeout: 120_000, windowsHide: true, env }, (error, stdout) => {
    // Never include stderr: cloud URLs, configuration paths and tokens are private.
    if (error) reject(new RcloneArchiveError(error.code === 5 || error.killed === true));
    else resolve(stdout);
  }));
}
export class RcloneArchiveTransport implements ArchiveTransport {
  private remote: string;
  private config: string;
  constructor(private runner: RcloneRunner = run, private readConfig: (file: string) => Promise<string> = (file) => readFile(file, "utf8")) {
    this.remote = process.env.RCLONE_ARCHIVE_REMOTE || "";
    this.config = process.env.RCLONE_ARCHIVE_CONFIG || "";
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(this.remote) || !this.config || !process.env.RCLONE_ARCHIVE_DRIVE_ID || !process.env.RCLONE_ARCHIVE_ROOT_ID) throw new Error("Scoped rclone archive runtime is not configured");
  }
  private bind(drive: string, root: string) {
    if (drive !== process.env.RCLONE_ARCHIVE_DRIVE_ID || root !== process.env.RCLONE_ARCHIVE_ROOT_ID) throw new Error("Archive target differs from the scoped rclone runtime binding");
  }
  private location(relative: string) {
    if (relative && relative.split("/").some(p => !p || p === "." || p === ".." || /[\\:\x00-\x1f]/.test(p))) throw new Error("Invalid rclone archive path");
    return `${this.remote}:${relative}`;
  }
  private call(args: string[]) { return this.runner([...args, "--config", this.config, "--retries", "1", "--low-level-retries", "1"]); }
  private id(item: Item) {
    if (!item.ID) throw new Error("OneDrive item identifier missing");
    const separator = item.ID.indexOf("#");
    if (separator < 0) return item.ID;
    if (item.ID.slice(0, separator) !== process.env.RCLONE_ARCHIVE_DRIVE_ID) throw new Error("OneDrive returned an item from another drive");
    return item.ID.slice(separator + 1);
  }
  private async assertConfig() {
    const sections = new Map<string, Record<string, string>>(); let current: Record<string, string> | undefined;
    for (const raw of (await this.readConfig(this.config)).split(/\r?\n/)) {
      const line = raw.trim(); if (!line || /^[#;]/.test(line)) continue;
      const section = line.match(/^\[([^\]]+)\]$/);
      if (section) { if (sections.has(section[1])) throw new Error("Duplicate rclone remote"); current = {}; sections.set(section[1], current); continue; }
      const field = line.match(/^(\w+)\s*=\s*(.*)$/);
      if (!current || !field || field[1] in current) throw new Error("Invalid scoped rclone configuration");
      current[field[1]] = field[2];
    }
    const config = sections.get(this.remote);
    if (sections.size !== 1 || config?.type !== "onedrive" || config.drive_id !== process.env.RCLONE_ARCHIVE_DRIVE_ID || config.root_folder_id !== process.env.RCLONE_ARCHIVE_ROOT_ID) throw new Error("rclone configuration differs from the scoped runtime target");
  }
  private async stat(relative: string): Promise<Item> {
    return JSON.parse((await this.call(["lsjson", this.location(relative), "--stat"])).toString());
  }
  private async list(): Promise<Item[]> {
    return JSON.parse((await this.call(["lsjson", this.location(""), "--recursive", "--files-only", "--no-mimetype", "--no-modtime"])).toString());
  }
  private async verify(relative: string, bytes: Buffer) {
    const actual = await this.call(["cat", this.location(relative)]);
    if (actual.length !== bytes.length || createHash("sha256").update(actual).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw new Error("Archived original size or SHA-256 mismatch");
    const item = await this.stat(relative);
    if (item.IsDir || item.Size !== bytes.length) throw new Error("Archived original metadata mismatch");
    return this.id(item);
  }
  async request(endpoint: string): Promise<Record<string, unknown>> {
    const expected = `drives/${encodeURIComponent(process.env.RCLONE_ARCHIVE_DRIVE_ID!)}/items/${encodeURIComponent(process.env.RCLONE_ARCHIVE_ROOT_ID!)}`;
    if (endpoint !== expected && endpoint !== expected + "/children?$select=id,name,folder,file,size") throw new Error("rclone archive supports only its explicitly selected root");
    await this.assertConfig();
    const item = await this.stat("");
    if (!item.IsDir || (item.ID && this.id(item) !== process.env.RCLONE_ARCHIVE_ROOT_ID)) throw new Error("rclone remote is not rooted at the selected OneDrive folder");
    // Root --stat can be synthetic: listing children must actually reach OneDrive.
    const children: Item[] = JSON.parse((await this.call(["lsjson", this.location(""), "--max-depth", "1"])).toString());
    if (endpoint === expected) return { id: process.env.RCLONE_ARCHIVE_ROOT_ID, name: item.Name || process.env.RCLONE_ARCHIVE_FOLDER_PATH || this.remote, folder: {} };
    return { value: children.map(i => ({ id: this.id(i), name: i.Name, size: i.Size, ...(i.IsDir ? { folder: {} } : { file: {} }) })) };
  }
  async uploadImmutable(drive: string, root: string, relative: string, bytes: Buffer) {
    this.bind(drive, root); this.location(relative);
    if (!relative || !bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Unsupported archive size or filename");
    // Validate the actual remote root on every mutation, not just at activation.
    await this.request(`drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(root)}`);
    const items = await this.list();
    if (items.some(i => i.Path === relative)) return this.verify(relative, bytes);
    const dir = await mkdtemp(path.join(tmpdir(), "vermieterme-rclone-"));
    try {
      const source = path.join(dir, "original"); await writeFile(source, bytes, { mode: 0o600, flag: "wx" });
      await this.call(["copyto", source, this.location(relative), "--immutable", "--checksum"]);
      return await this.verify(relative, bytes);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async moveImmutable(drive: string, root: string, itemId: string, relative: string, sha256: string) {
    this.bind(drive, root); this.location(relative);
    if (!relative) throw new Error("Missing final archive filename");
    await this.request(`drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(root)}`);
    const items = await this.list();
    const original = items.find(i => this.id(i) === itemId);
    if (!original?.Path) throw new Error("Archived OneDrive item is missing from the selected root");
    const bytes = await this.call(["cat", this.location(original.Path)]);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Archived original hash mismatch");
    const occupied = items.find(i => i.Path === relative);
    if (occupied && this.id(occupied) !== itemId) throw new Error("Final archive path is occupied by another item");
    if (original.Path !== relative) await this.call(["moveto", this.location(original.Path), this.location(relative), "--immutable", "--checksum"]);
    const actualId = await this.verify(relative, bytes);
    if (actualId !== itemId) throw new Error("Archive move changed the original item identifier");
    return actualId;
  }
}
export function archiveTransport(): ArchiveTransport { return archiveBackend() === "rclone" ? new RcloneArchiveTransport() : new MicrosoftGraph(); }
