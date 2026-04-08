# IRIDev — LLM Working Notes

> Source of truth policy: if this doc conflicts with code, **code wins**.

## Purpose
IRIDev is the IRI browser automation worker for 180 Snacks.

It owns:
- Auth-state login bootstrap and run-time browser session loading.
- Deterministic UI navigation to generate/export the target IRI report.
- Download capture and artifact persistence.
- Run metrics and failure screenshots.

It does **not** own downstream normalization/Airtable sync. That is `ExcelToAirtableDev`.

## Current execution contract
CLI:
- `npm run run -- --mode=download`
- `npm run run -- --mode=dom`
- `npm run run -- --mode=network`

Auth precondition:
- `playwright/.auth/iri.json` must exist (`npm run auth:setup` creates it).

Output artifacts:
- `artifacts/downloads/*` (for download mode)
- `artifacts/raw/*` (payload summaries)
- `artifacts/metrics/*`
- `artifacts/screenshots/*` (especially on failure)

## Current download flow (as implemented)
The generated flow currently targets report:
- `(BP226) US Costco Small Vendor Report_PREMIUM_Copy DAILY VERSION`

Navigation sequence:
1. Landing page
2. Open grid/library
3. Open report entry
4. More → Export
5. `#iterate` → Select All
6. Export + OK
7. Open inbox panel
8. Click report row/icon in inbox and capture Playwright `download` event
9. Save into `artifacts/downloads`

## Reliability notes from recent failures
Observed failures were mostly Playwright locator visibility conflicts:
- Locators matched hidden duplicate DOM nodes (menus/panels) and timed out with `element is not visible`.

Current mitigation in code:
- Prefer `:visible` scoped locators for key actions (`More`, export menu, inbox target).
- Explicit waits and scroll-into-view for inbox export row.
- Context-level download listener so downloads from spawned pages/tabs are still captured.

## Read-only guard policy
After report generation actions are completed, read-only network guard is installed to reduce accidental write actions.

Guard behavior:
- Blocks non-safe requests except allowlisted patterns used for session/auth continuity.

## Responsibilities boundary
- IRIDev: extraction/download automation and run artifacts.
- ExcelToAirtableDev: parse XLSX, normalize rows, validate, and sync to Airtable.
- 180SnacksRTSDev: human-operated runtime shell that orchestrates running both tools.

## Near-term roadmap
1. Make selectors resilient to small UI text/style changes (fallback selectors).
2. Add explicit inbox/report readiness checkpoints before click-to-download.
3. Add structured step logs for each click/wait stage.
4. Add retry strategy specifically for export menu and inbox row click.
5. Keep mode-level metrics stable for run-over-run reliability tracking.
