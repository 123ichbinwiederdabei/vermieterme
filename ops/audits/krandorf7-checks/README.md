These are isolated requirements reproductions for the 8 October 2026 billing audit. They exercise actual domain functions and one API route with mocked Prisma responses and synthetic invoices, readings, tenants, and snapshots. They do not access production data.

The `.ts.txt` suffix keeps the intentionally failing audit fixtures outside normal TypeScript compilation and test discovery. To reproduce from the repository root with installed dependencies and the cached Node 22 Docker image:

```bash
audit_dir=$(mktemp -d /tmp/vermieterme-audit.XXXXXX)
cp ops/audits/krandorf7-checks/requirements.test.ts.txt "$audit_dir/requirements.test.ts"
cp ops/audits/krandorf7-checks/snapshots.test.ts.txt "$audit_dir/snapshots.test.ts"
cp ops/audits/krandorf7-checks/vitest.config.mjs "$audit_dir/vitest.config.mjs"
ln -s /app/node_modules "$audit_dir/node_modules"
docker run --rm --cpus=1 --memory=1500m \
  --mount "type=bind,src=$PWD,dst=/app,readonly" \
  --mount "type=bind,src=$audit_dir,dst=/audit" \
  --mount type=tmpfs,dst=/app/node_modules/.vite-temp \
  -w /app node:22-bookworm-slim \
  node node_modules/vitest/vitest.mjs run --config /audit/vitest.config.mjs
```

At audited commit `527b9f3`, expect 13 failed checks and two passing checks, with exit status 1. The command writes machine-readable results into the temporary directory. Failures express the required behavior; they should become passing checks as the billing defects are repaired. No production database or Docker volume is mounted.
