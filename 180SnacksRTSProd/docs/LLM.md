# 180SnacksRTSDev — LLM Working Notes

> Source of truth policy: if this doc conflicts with code, **code wins**.

## Purpose
180SnacksRTSDev is the human-operated runtime shell that orchestrates pipeline execution:
1. IRIDev extraction/download
2. ExcelToAirtableDev normalize/sync

This project is intentionally a thin orchestration/UI layer, not the place for report parsing logic.

## Current runtime behavior
- Sequential pipeline execution with live status/log output.
- One active run at a time.
- Displays row confirmation status from ExcelToAirtable logs (e.g., `5000/5000 rows uploaded`, with updated-row monitor).
- Pipeline project directories are configurable via environment variables:
  - `IRI_DIR` (default: `IRIDev`)
  - `EXCEL_DIR` (default: `ExcelToAirtableDev`)
  This allows Dev→Prod folder-copy workflows without code edits when folder names change.
- `server.js` loads a committed `.envsoft` file from the RTS project root on startup for non-secret defaults (for example: folder names like `IRIDev` / `IRIProd`).
- `server.js` then loads local `.env` (if present) so private per-machine overrides can stay out of git.
- Cleanup at end of every run (success or failure):
  - Delete `.xlsx` in `${IRI_DIR}/artifacts/downloads` (or default `IRIDev/...`)
  - Delete `.xlsx` in `${EXCEL_DIR}/artifacts` (or default `ExcelToAirtableDev/...`)

## UI baseline guardrails
Runtime canvas structure and interactions should remain stable unless explicitly changed.

### Grouping and visibility
- Pipeline visuals are a single movable cluster rooted at `#pipelineGroup`.
- `#branchTree` remains hidden until run starts.

### Branch geometry + layering
- One main trunk + two side branches (Services + Execution Logs).
- No trunk tail below lower branch endpoint.
- Branch lines behind cards; cards stay legible/solid.

### Interaction model
- Canvas drag pans world.
- Wheel zoom is pointer-centered and clamped.
- Dragging any pipeline card drags full `#pipelineGroup`.
- Interactive controls remain usable while drag behavior exists.

## Architecture & orchestration ideas (moved from repo root proposal)
The long-term direction is a modular worker architecture while keeping deterministic contracts.

### Service boundaries
- `iri-extractor` (IRIDev): browser extraction + raw artifact emission.
- `excel-normalizer` (ExcelToAirtableDev): normalize workbook into canonical rows.
- `airtable-writer` (ExcelToAirtableDev phase/current): idempotent destination sync.
- `pipeline-orchestrator` (this runtime today, future dedicated service): step coordination/retries/state.

### Contract-first orchestration
Prefer versioned JSON envelopes with:
- `specVersion`, `runId`, `tool`, `status`
- explicit artifact URIs
- step metrics and error metadata

Downstream tools should consume artifacts by contract/manifest, not by guessed file paths.

### Profile-driven scalability
To support multiple workbook formats + multiple Airtable destinations:
- Input profile: header detection, row typing, date extraction strategy.
- Destination profile: field mappings, coercions, upsert key policy.

### Artifact/run structure direction
Prefer run-scoped artifacts:
- `artifacts/runs/<runId>/extract/*`
- `artifacts/runs/<runId>/normalize/*`
- `artifacts/runs/<runId>/load/*`
with a run `manifest.json` that declares every artifact and checksum.

### Reliability and idempotency priorities
- Extraction retries for transient UI/network failures.
- Deterministic normalization with clear reject artifacts.
- Airtable idempotent upserts based on stable record keys.
- Structured metrics at run and step levels.

## Near-term roadmap
1. Keep RTS as human-visible orchestration shell while contracts stabilize.
2. Add clearer step-level state transitions and retry surfaces in UI.
3. Evolve toward dedicated orchestrator service once multi-tool scaling requires it.
4. Keep docs aligned with code behavior after each pipeline flow change.
