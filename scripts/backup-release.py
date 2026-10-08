#!/usr/bin/env python3
"""Create and verify a private SQLite + uploads backup without changing the source."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--data-dir", type=Path, required=True)
parser.add_argument("--backup-dir", type=Path, required=True)
args = parser.parse_args()
args.backup_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
os.chmod(args.backup_dir, 0o700)
source_file = args.data_dir / "vermieterme.db"
backup_file = args.backup_dir / "vermieterme.db"
source = sqlite3.connect(source_file.resolve().as_uri() + "?mode=ro", uri=True)
backup = sqlite3.connect(backup_file)
try:
    source.backup(backup)
    if backup.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise RuntimeError("SQLite integrity verification failed")
    if backup.execute("PRAGMA foreign_key_check").fetchall():
        raise RuntimeError("SQLite foreign-key verification failed")
    tables = [row[0] for row in backup.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    counts = {name: backup.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in tables}
    referenced = {row[0] for row in backup.execute("SELECT fileName FROM Document")}
finally:
    source.close()
    backup.close()
os.chmod(backup_file, 0o600)
uploads = args.data_dir / "uploads"
files = sorted(path for path in uploads.rglob("*") if path.is_file()) if uploads.exists() else []
manifest = {}
for file in files:
    if file.is_symlink():
        raise RuntimeError("Upload symlink requires explicit backup handling")
    manifest[str(file.relative_to(uploads))] = hashlib.sha256(file.read_bytes()).hexdigest()
if not referenced.issubset(manifest):
    raise RuntimeError("Database references missing uploads; backup is incomplete")
archive = args.backup_dir / "uploads.tar.gz"
with tarfile.open(archive, "w:gz") as tar:
    for file in files:
        tar.add(file, arcname=str(file.relative_to(uploads)), recursive=False)
os.chmod(archive, 0o600)
with tempfile.TemporaryDirectory(prefix="restore-check-", dir=args.backup_dir) as restored:
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(restored, filter="data")
    actual = {str(file.relative_to(restored)): hashlib.sha256(file.read_bytes()).hexdigest() for file in Path(restored).rglob("*") if file.is_file()}
    if actual != manifest:
        raise RuntimeError("Restored uploads do not match the backup manifest")
    if any(hashlib.sha256((uploads / name).read_bytes()).hexdigest() != digest for name, digest in manifest.items()):
        raise RuntimeError("Uploads changed during backup; repeat before using it")
verification = {"verified": True, "tableCounts": counts, "uploadHashes": manifest, "databaseSha256": hashlib.sha256(backup_file.read_bytes()).hexdigest(), "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
report = args.backup_dir / "verification.json"
report.write_text(json.dumps(verification, indent=2) + "\n")
os.chmod(report, 0o600)
print(json.dumps({"verified": True, "tables": len(counts), "uploads": len(manifest), "referencedUploads": len(referenced), "backupDirectory": str(args.backup_dir)}))
