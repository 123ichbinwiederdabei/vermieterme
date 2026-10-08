# Invoice workflows and Krandorf billing

The new billing workspace has six invoice sections. Upload documents, extract or
enter the values, compare them with the original and explicitly confirm the
invoice. Only confirmed invoices enter a calculation. Applied calculations are
append-only; corrections create invoice, inventory and statement revisions.

## OCR setup

The web app queues durable jobs. Run a second instance of the same release image
with `INVOICE_WORKER_MODE=1`, sharing the same `/app/data` SQLite/uploads volume.
Run only one worker for this personal deployment. Both instances must use the
same release and migration directory. Keep the web app's normal health check;
the worker does not expose HTTP.

Reuse the MtBaCo portal's existing Google Vision service-account binding:
`GOOGLE_VISION_SERVICE_ACCOUNT_JSON_B64`, or its mounted credential path through
`GOOGLE_APPLICATION_CREDENTIALS`. PDF OCR additionally needs the portal's
`GOOGLE_VISION_GCS_BUCKET`. Transfer bindings through the service configuration;
never put their values in Git, deployment logs, screenshots or the build context.
The service account needs Vision access and object read/write/delete access to
that bucket. Images use document-text detection. PDFs use asynchronous Vision
processing with objects isolated under `vermieterme/<job>/<attempt>/`.

Configure a bucket lifecycle expiry rule limited to the `vermieterme/` prefix
(e.g. one day). Successful/failed operations clean their attempt's objects;
expiry removes leftovers after a worker crash. Preserve the portal's other
prefixes. Jobs have a ten-minute lease and bounded transient retries. Results
remain proposals until reviewed. An unmatched layout keeps its OCR text and
coordinates so a template can be created without running OCR again.

## Templates

Upload a sample within its category and section and run OCR. Open
“Rechnungsvorlagen”, create a template, select the regions in the original and
specify formats, optional anchors and expected normalized values. Amounts in
test expectations use cents, unit prices use micro-euro; quantities are decimal
strings. Test against representative samples before publishing. Published
versions are immutable. A changed layout creates a new version; confirmed
invoices retain their old extraction and review history.

Repeated table rows have separate description/amount regions and an explicit
classification. Expected rows must match during testing. Mixed repair or
replacement invoices still require a reviewer to classify every line. Conflicts,
missing required fields, inconsistent VAT/gross values and duplicate invoice
candidates require resolution before confirmation.

## Production rollout and rollback

1. Record the current service configuration and image digest in a private
   release directory. Pause writes and stop the old app/worker briefly. Use
   SQLite's backup API (not a plain copy of an open database) to create a
   consistent database backup, and archive all uploads with hashes.
2. Verify SQLite `integrity_check` and `foreign_key_check` on the backup. Extract
   the upload archive into an isolated directory and compare hashes. Keep the
   original image and confirm that an isolated copy starts against the restored
   old database. A JSON export alone does not contain uploads or auth records.
3. Rehearse `prisma migrate deploy` on a copy of that backup. Verify record counts,
   old statement payloads, inventory/consumptions, upload hashes and all foreign
   keys. Do not use `prisma db push`. The migration classifies existing category
   IDs, adds water, converts exactly representable legacy amounts and marks
   existing calculation heads stale. It does not manufacture invoice evidence.
4. Run unit/integration tests, lint, the production build, Playwright and the
   worker build against the release. Start the new web app and worker only after
   the recoverable backup and migration rehearsal pass. Confirm login, category
   workspace, document access and a synthetic OCR job. Remove only synthetic
   documents and cloud objects that are not referenced by a billing record.
5. If rollback is needed, stop both services. Restore the matching database and
   uploads archive, verify hashes/integrity, and start the recorded old image.
   Do not run the old image against a partially migrated database or roll back
   source alone.

The v3 JSON backup includes invoice templates/attachments/jobs, tax settings,
agreements, calculation heads, immutable snapshots/lot consumptions and statement
revisions. Its import accepts an otherwise empty migrated database and requires
uploads to be restored and verified first. The bootstrap water category is
replaced by the backup's category records.

## Evidence required for the live property

Preserve 80/200/110 m², household meters 35863079 and 32983031, plant meter 5388519
and the separate existing electricity advances. Prepare the 01.10.2026 cutover
from the open 13.09.2026 period with a reason and boundary readings. Do not move
previously accounted dates silently.

Correct the property address fields from `Krandorf` / `7` /
`92431 Neunburg vorm Wald` to `Krandorf 7` / `92431` /
`Neunburg vorm Wald` before issuing documents.

The five legacy oil lots need invoice-supported CO₂ values, including documented
zero values where applicable. Establish and confirm the actual HeizkostenV
exception evidence and its validity. Three recorded units do not qualify for the
§2 two-unit mode. Standard heat-consumption allocation and central hot-water
billing remain blocked until their domain implementation exists.

Upload actual water and waste invoices, eligible wastewater/heating operating
invoices, the tax assessment and its isolated rental residential component.
Confirm the wastewater lease coverage and the electricity base-price agreement.
Repairs and renewal remain owner-only. A metered plant electricity charge and
an invoice charge for the same electricity cannot both be applied. Confirm zero
costs with a reason, then apply every category and issue the statement. Tenant
views expose issued revisions only.
