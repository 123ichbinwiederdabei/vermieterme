# VermieterMe engineering rules

- Keep all billing calculations in shared server-side domain modules. React pages, API serializers, the tenant app, and PDF components must consume calculated results and must not reimplement billing rules.
- Store money as integer cents. Store electricity prices as integer cents per kWh. Use Prisma `Decimal`/decimal strings for kWh, litres, and square metres; never use JavaScript floating-point arithmetic for billing.
- Heating-oil inventory is FIFO. Applied billing snapshots and their lot consumptions are immutable; corrections create revisions.
- A tenant change uses an intermediate reading for consumption-based costs. Document every fallback method.
- Section 2 and Section 11 HeizkostenV modes require structured, validated evidence. Standard HeizkostenV billing without heat-consumption data and central hot-water billing are blocked for now.
- Use versioned Prisma migrations. Production runs `prisma migrate deploy`, never `prisma db push`.
- Before changing production data or services, create and verify a recoverable backup.
- Run unit/integration tests, lint, production build, and Playwright browser tests before deployment.
- Reuse the existing VermieterMe form, table, card, dialog, colour, spacing, and typography patterns.
