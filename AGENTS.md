# VermieterMe engineering rules

- Keep all billing calculations in shared server-side domain modules. React pages, API serializers, the tenant app, and PDF components must consume calculated results and must not reimplement billing rules.
- Store final money as integer cents. Store electricity unit prices as integer micro-euro per kWh; use full integer precision until final cent allocation. Use Prisma `Decimal`/decimal strings for kWh, litres, and square metres; never use JavaScript floating-point arithmetic for billing.
- Heating-oil inventory is FIFO. Applied billing snapshots and their lot consumptions are immutable; corrections create revisions.
- A tenant change uses an intermediate reading for consumption-based costs. Document every fallback method.
- Section 2 and Section 11 HeizkostenV modes require structured, validated evidence. Standard HeizkostenV billing without heat-consumption data and central hot-water billing are blocked for now.
- Use versioned Prisma migrations. Production runs `prisma migrate deploy`, never `prisma db push`.
- Before changing production data or services, create and verify a recoverable backup.
- Run unit/integration tests, lint, production build, and Playwright browser tests before deployment.
- Reuse the existing VermieterMe form, table, card, dialog, colour, spacing, and typography patterns.

## Local validation and Git hygiene

- Use the Node major version in `.nvmrc` and `corepack pnpm` to honor the pinned `packageManager` version in `package.json`.
- Run `corepack pnpm test`, `corepack pnpm lint`, and `corepack pnpm exec tsc --noEmit` for application changes. `corepack pnpm test:e2e` builds the production app and runs the browser tests against the disposable `prisma/e2e.db` database; it resets that database.
- Check schema/migration parity with `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code`, using a local SQLite `DATABASE_URL`. Repair drift with a new migration; do not rewrite existing migrations.
- Preserve existing uncommitted work before reorganizing it, use a `codex/` branch, and stage explicit paths in coherent commits. Document unfinished feature foundations instead of presenting them as complete.
- Keep environment secrets, SQLite files and sidecars, generated builds, and test reports out of Git and Docker contexts. Keep `.env.example` tracked.
- A local cleanup does not authorize a push or deployment. Retain existing branches unless their removal was requested.
