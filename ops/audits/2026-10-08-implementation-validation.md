# Krandorf billing and invoice workflow implementation

The implementation follows the 8 October [billing audit](2026-10-08-krandorf7-billing-audit.md). The audit describes image 14; its original findings and reproduction evidence are retained unchanged. The new branch starts from the recovered live source, commit `527b9f3d985145d97d673130bfa2ca046df71451`.

## Delivered behavior

Each billing period now has invoice sections for heating, household electricity, water, waste, wastewater and property tax. Uploads remain attached to their invoice. Google Vision extraction produces review proposals; confirmation is explicit. Visual invoice templates support normalized regions, anchors, formats, repeated table rows, supplier/layout markers and canonical sample expectations. Publication requires a passing test of the saved rules. Published versions and confirmed invoices are immutable; changes create revisions.

The Google adapter uses the MtBaCo portal's existing service-account binding and PDF bucket. A separate durable worker claims jobs, retains OCR coordinates, applies published templates and retries transient failures. Unknown or ambiguous layouts require review. Confirming an oil invoice creates a FIFO delivery/lot revision; confirming a tariff applies its exact gross prices to the chosen property contract, retaining prior tariffs in the invoice's audit data.

All billing flows consume server-calculated results. Tenant applications and PDFs use final cent strings. Applying a category appends a snapshot, allocations and oil consumptions; a separate head selects its current revision. Issuance checks category completeness, blockers, freshness and financial coverage, then freezes each tenant's statement. Corrections preserve the old statement and ledger. Confirmed zero charges need a reason.

## Audit findings addressed

| Finding | Implemented correction |
| --- | --- |
| 1 — Manual costs and incomplete statements | Exact-cent manual inputs; all six preview/apply paths; confirmed invoice pools; complete-category issuance gate. |
| 2 — Standard heating bypass | Standard heating and central hot water remain blocked pending their domain implementation. |
| 3 — Heating evidence | Structured, reviewed §§2/11 evidence, dates and protected documents; building topology validation for §2. |
| 4 — Missing CO₂ values | Mandatory evidenced values, including legitimate zero values; opening/delivery controls and immutable lot corrections; PDF disclosure. |
| 5 — CO₂ tiers | Exact rounding to 0.1 kg/m² and shortened-period thresholds. |
| 6 — Wastewater key | Equal thirds including the owner; lease coverage checked during occupancy. |
| 7 — Property tax | Evidence-backed rental component over the two rented residential areas; assessment cap and owner exclusions. |
| 8 — Tenant changes | Electricity intervals retain the actual tenant and require boundary readings; documented estimated readings are disclosed. Supported heating exceptions use area/time; standard individual heat consumption remains blocked. |
| 9 — Snapshot scope/history | Category-scoped heads, append-only calculations/consumptions, retained source inputs/policy and immutable issued statements. |
| 10 — Heating operating costs | Maintenance/chimney/emissions invoice pool and a separate heating-plant electricity role. |
| 11 — Electricity precision | Integer milli-kWh × micro-euro products retained through aggregation before final cent allocation. |
| 12 — Zero-use base price | Payable base price remains in totals; an undefined consumption key blocks application. |
| 13 — Validity | Contract, meter, tariff and tenancy interval intersections and coverage/overlap checks. |
| 14 — Plant provenance | Tariffs/readings/plant calculation retained in the source fingerprint and invalidation paths. |
| 15 — Duplicate/excluded charges | Invoice-versus-meter electricity conflict guard; eligible, excluded, owner and tenant amounts conserve the full cost. |
| 16 — Tenant billing visibility | Issued revisions only; occupancy/status filters and isolated list failures. |

The browser checks also exposed a tax-settings request race that could overwrite entered amounts. Loading now disables editing, cancels old requests and validates exact amount precision. A consumed oil lot in an unissued draft can receive an evidence revision without mutating its earlier applied consumption; issued periods require a correction period.

## Validation

Validation uses an isolated Node 22 container, disposable migrated SQLite databases and synthetic documents. Production records are never test fixtures.

- Unit/API/integration suite: 121 tests across 21 files. Tests include category conservation, tenant-change consumption, precision, CO₂ boundaries, snapshot revisions, durable OCR review and a full v3 backup round trip.
- Root and tenant-app TypeScript checks.
- ESLint: no errors; two existing hook-dependency warnings in tenant access/navigation components.
- Production Next.js build and OCR worker bundle.
- Six Playwright browser tests. The invoice workflow uploads across all categories, draws/tests/publishes extraction rules, processes cached OCR through the actual worker, confirms invoices, applies all categories and issues a statement. It also compares PDF bytes before and after changing tenant metadata.
- Authenticated Google Vision smoke checks against a synthetic PNG and PDF both succeeded; temporary PDF bucket objects were cleaned. Credential values were neither logged nor stored in Git.
- The Docker context check confirms the tenant cent-format source required by the tests is included while private documents, database files and uploads are excluded. A full release-image build has not been performed on this capacity-constrained server.

## Recovery and production status

A consistent SQLite backup, uploads archive and verification manifest are retained privately under `/root/backups/vermieterme/2026-10-08-invoice-workflows`. Integrity, foreign keys, all five uploaded documents and their hashes were verified. The new migration passed on a separate backup copy and preserved existing records, apart from its intentional category/exact-cent/freshness backfill. The original image 14 started against an isolated restored old database, returned HTTP 200 for its login page and read the expected user/property/document/snapshot counts.

The live VermieterMe service and its data remain unchanged. The [release guide](../invoice-workflows-release.md) describes worker configuration, migration/rollback, the October cutover and the actual invoice, reading, agreement, tax and HeizkostenV evidence still needed before a real statement can be issued. The backup must be refreshed during the production write pause before a later deployment. The software does not invent missing evidence or infer a statutory exception from absent meters.
