# VermieterMe engineering rules

- Keep all billing calculations in shared server-side domain modules. React pages, API serializers, the tenant app, and PDF components must consume calculated results and must not reimplement billing rules.
- Store final money as integer cents. Store electricity unit prices as integer micro-euro per kWh; use full integer precision until final cent allocation. Use Prisma `Decimal`/decimal strings for kWh, litres, and square metres; never use JavaScript floating-point arithmetic for billing.
- Heating-oil inventory is FIFO. Applied billing snapshots and their lot consumptions are immutable; corrections create revisions.
- A tenant change uses an intermediate reading for consumption-based costs. Document every fallback method.
- Section 2 and Section 11 HeizkostenV modes require structured, validated evidence. Standard HeizkostenV billing requires confirmed heat readings at period and tenant boundaries, and 50–70% measured consumption allocation. Missing readings and unsupported central hot-water billing block approval. OilFox measures inventory, not tenant heat consumption.
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

## ChatGPT, Microsoft and document archives

- Use `domain-changes`, `billing-workflow`, `configured-allocation` and `document-intake` for Web/MCP business actions. Short-lived previews are bound to the user and input fingerprint; retries must reuse consumed results.
- Keep OAuth read, write, approve and admin scopes separate. Missing rights require an explicit new consent. Generic CRUD must not mutate billing history, audits, inventory consumption, originals or business master data.
- Archive invoices by invoice date, independently of their service and billing periods. Identify original bytes with SHA-256; never overwrite released PDFs or copy invoices into each statement directory.
- OneDrive server targets use Graph drive/root IDs. Read the cloud contents first; explain the exact live scope and get confirmation before deployment, runtime-secret changes, import activation, OneDrive writes, or productive Krandorf changes.
- OCR regression expectations must come from independent human review of original documents. Publication requires two distinct training originals and a held-out comparison; automatic booking additionally requires an unambiguous match and full invoice/domain validation.
- Persist archive, import and outbox jobs with leases and dedupe keys. Reconcile ambiguous Microsoft sends before any retry; a 202 response proves acceptance only.
- Require verified originals and final archive paths before statement issuance. Keep revision artifacts, receipt indexes and dispatch evidence linked; preserve R001 when producing R002.
- Back up SQLite and original uploads together and verify restoration. Version-4 metadata backups retain audit principals/events without passwords, OAuth tokens or runtime secrets; older metadata backups require isolated migration.
