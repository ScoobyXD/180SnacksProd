# ExcelToAirtableDev — LLM Working Notes

> Source of truth policy: if this doc conflicts with code, **code wins**.

## Purpose
ExcelToAirtableDev is the transformation + sync worker.

It owns:
- Reading raw IRI export XLSX files.
- Normalizing hierarchical report rows into warehouse-level rows.
- Validating normalized output.
- Writing normalized output workbook.
- Optional Airtable synchronization.

It does **not** own browser extraction. That is `IRIDev`.

## Current input model
Primary input is an IRI workbook with:
- A non-data `Index` tab.
- Daily data tabs (typically `1..7`) where date is embedded in Shape text (e.g., `day ending 03-25-2026`).

If `--input` is omitted, runtime auto-selects newest XLSX from:
- `../IRIDev/artifacts/downloads`

## Date extraction model (current)
- Date is parsed from worksheet-linked drawing/control XML (not cell values).
- Per-worksheet date map is built by traversing XLSX internals.
- Accepted phrases include `day ending` / `week ending` with `MM-DD-YYYY` or `MM/DD/YYYY` variants.

## Current normalization behavior
For each daily worksheet:
1. Detect header row containing `Item` and `Venue`.
2. Parse body rows into key/value records.
3. Maintain hierarchical context:
   - carry `currentItem`
   - carry `currentRegion`
4. Emit only warehouse rows.
5. Set `Date` for each emitted row to the sheet-level extracted date.
6. Merge all daily-sheet rows into one combined output dataset.

Totals and non-warehouse summary rows are dropped.

## Current output schema
Current output columns:
1. `Item`
2. `Region`
3. `Venue`
4. `Date`
5. `Dollar Sales`
6. `Unit Sales`
7. `Inventory On Hand`
8. `Average Price per Unit`

Notes:
- `Week Ending Date` is no longer emitted.
- Numeric normalization tolerates accounting and symbol formatting and maps invalid placeholders to `null`.

## Validation gates
Validation runs after output workbook creation and before Airtable sync.
Run fails if any of these are true:
- No warehouse rows produced.
- Any daily worksheet is missing Shape-derived date.
- Any daily worksheet produced zero warehouse rows.
- Any output row has blank `Date`.

When validation fails, Airtable sync is blocked.

## Airtable sync model (current)
Enabled only if `AIRTABLE_SYNC_ENABLED=true`.

Behavior:
- Finds/creates base and table depending on env flags.
- Ensures schema includes normalized output fields (including `Date`).
- Converts output date to ISO (`YYYY-MM-DD`) for Airtable date writes.
- Uses Airtable batch upsert (`performUpsert`) keyed by natural composite fields:
  - `Item + Venue + Date` (Airtable upsert merge keys support at most 3 fields)
- If merge fields match: update record.
- If merge fields do not match: create record.
- Performs a row confirmation check after sync:
  - Counts data rows in the generated normalized workbook (`rowCount - 1` header).
  - Requires Airtable `created` count to match that workbook data row count.
  - Logs `X/Y rows uploaded` plus `updated` count for monitoring.
- Fails run if Airtable reports a silent zero-write (`0 upserted` and `0 rejected`) when rows were attempted.
- Rejects are written to `artifacts/rejects/*.json` and fail the run.
- Emits progress logs during Airtable writes (batch 1, every 50th batch, and final batch).

## Runtime contract
CLI:
- `npm run run -- [--input=<path.xlsx>] [--output=<path.xlsx>]`

Environment:
- Reads `.env` and `.env.local` from this project root.

Artifacts:
- Normalized workbook in `artifacts/`
- Reject logs in `artifacts/rejects/` (if Airtable rejects rows)
- Metrics-style JSON emitted to stdout

## Near-term roadmap
1. Add automated fixture-based tests for per-sheet shape date extraction.
2. Add schema drift detection/reporting when report headers change.
3. Add explicit per-sheet row-count expectations and alert thresholds.
4. Add replay mode for previously downloaded runs.
5. Introduce richer canonical schema fields once business mapping expands.
