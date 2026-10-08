# Live image 14 source recovery

Recovered on 2026-10-08 onto Git commit `6034086` from the retained build source
at `/root/builds/vermieterme-image14`.

The deployed CapRover image is `img-captain-vermieterme:14`, image ID
`sha256:11f62c3ce8065add0f76aa7bd032e3e6e9d134a5cbce8483296ea29d5fcb525e`,
built on 2026-09-12. The image has no Git revision label, so its originating
commit cannot be identified from the image metadata.

The retained source's Prisma schema matches the deployed image byte for byte.
All recovered migration SQL files also match the deployed image byte for byte.
Application source was recovered from the retained build directory with LF line
endings; unrelated line-ending differences were excluded. The deployed route
manifest and compiled server modules corroborate the additional property-tax
routes, manual billing preview, superseded-period handling, and FIFO revision
filter.

Recovered behavior includes:

- Property-tax settings, settings navigation, shared server-side calculation,
  and preview/apply integration.
- Billing-period status and handling of superseded periods in overlap checks
  and operational selections.
- Calendar-year overlap detection for prior-year billing suggestions.
- Heating-oil boundary-day readings, complete tenant financial-period coverage,
  and exclusion of the current period's consumption when previewing a revision.
- The two migrations `20260912150000_property_tax_setting` and
  `20260912160000_billing_period_status`.

The legacy field `annualRateMicroCentsPerM2` stores micro-euro per square metre,
as used by the live form and domain calculation. Its name and persisted units
are preserved to maintain compatibility with existing data.

Verification uses isolated databases and includes the recovered unit tests,
property-tax amount/rate/proration/coverage regression tests, and browser checks
for settings persistence, billing previews, and heating-oil revision pricing.
No production services or data are changed by this recovery.

Validation on 2026-10-08 in an isolated Node 22 container:

- `pnpm test --maxWorkers=1`: 86 tests passed.
- `pnpm lint`: no errors; two existing hook-dependency warnings.
- `pnpm build`: production build and TypeScript checks passed.
- Playwright: all five browser tests passed, using the repository configuration
  with one worker and a temporary start-only override to reuse the verified build.
- `prisma migrate deploy` and `prisma migrate status`: all seven migrations
  applied to a fresh database; resulting schema matches production after
  normalizing SQL line endings.
