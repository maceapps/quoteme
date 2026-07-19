# QuoteMe recovery baseline

Complete this checklist before any production schema migration or bulk repair.

## Back up the dataset

1. In Google Drive, copy `QuoteMe — Register`.
2. Copy `QuoteMe — Documents/Timesheets/QuoteMe — Timesheets`.
3. Download both copies as `.xlsx` files.
4. Download the `QuoteMe — Documents` folder or record a Drive inventory containing each file's ID, name, MIME type, parent, modified time, and trashed state.
5. Store the backup date, signed-in Google account, spreadsheet IDs, row counts, and Drive folder ID with the backup.

Do not rename the live folders or spreadsheets during backup. The current application discovers them by name.

## Reconciliation checks

Record these values before and after a migration:

- Quote and invoice row counts, including deleted rows.
- Highest quote and invoice numbers.
- Sum of quote and invoice totals.
- Active, complete, archived, and deleted record counts.
- Job, worker, and timesheet row counts.
- Timesheet totals grouped by worker, job, and week.
- Duplicate quote/invoice numbers.
- Duplicate `(jobId, workerId, weekStart)` timesheets.
- Missing or malformed `DataJSON`.
- Missing job/worker IDs and broken Doc/PDF links.
- Drive files that are not referenced by a Sheet row.

Ambiguous records must be reported for manual resolution. A migration must not guess and then delete its source evidence.

## Current invariants

- Job, worker, and timesheet IDs are immutable.
- A timesheet is unique by job, worker, and Monday week start.
- New timesheets require an active job and active worker.
- New quotes and invoices require a job.
- Human quote/invoice numbers are display identifiers; the current implementation still uses them as row keys.
- `DataJSON` contains the complete editable payload while selected workflow fields also exist in dedicated columns.
- Generated Docs and PDFs are artifacts; their links are stored in spreadsheet rows.
- Deleted quotes/invoices remain in the register with a JSON tombstone.
- Permanently deleted jobs and timesheets currently clear their spreadsheet rows.

## Restore rehearsal

Restore copies into a separate Drive folder and verify:

1. Headers and row counts match the backup record.
2. `DataJSON` parses for all expected records.
3. Totals and highest document numbers reconcile.
4. Referenced Drive file IDs or links resolve.
5. No restored copy is given the live app-managed spreadsheet name inside the live app folder.

Keep at least one known-good backup until the replacement schema has completed a full retention period.
