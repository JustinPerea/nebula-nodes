# Design Proposal — `g-queue-history-manager`

> Status: **awaiting sign-off** (user chose "plan first" for this gap). No code until approved.

## Problem
No persisted run/job history and no queue manager. This is the §2b "History / Provenance / Queue" surface. Parts of its spirit already shipped (asset + canvas search, gallery delete, Toolbar cancel-execution).

## Proposed scope — phased
**Phase 1 (this PR): a session Run-History panel.** A dockable panel listing each graph/node run with status + duration + node count, plus Cancel (active run) and Clear (history). Frontend-only, additive.
**Phase 2 (later): persistence + re-run/retry.** Persist across reload (localStorage or a backend usage log) and add per-run re-execute / retry-failed. (Backend persistence overlaps the deferred cost/usage gap — do them together.)

## Decisions needed (my recommendation in **bold**)
- **D1 — job granularity:** per-**RUN** **(rec)** vs per-node. Per-run matches the existing `graphComplete`/`error` event model and the run-level Toolbar cancel; per-node would need a new backend job model. Start per-run.
- **D2 — persistence:** **session-only in Phase 1** **(rec)**; localStorage/backend in Phase 2. Avoids a premature persistence/data-model decision.
- **D3 — actions:** Phase 1 = **view + Cancel (reuse existing) + Clear** **(rec)**; re-run + retry-failed in Phase 2.
- **D4 — surface:** **dockable panel + launcher** **(rec)** (consistent with the Assets/Node-Library chrome) vs a slide-over.
- **D5 — asset search:** the gap lists "asset search," but it's **already covered** by canvas search (PR #12) + the Assets panel search (PR #7). **Drop it from this gap** **(rec)**.

## Approach (Phase 1)
- A store slice `runHistory: RunRecord[]` accumulated in `handleExecutionEvent`: a run opens on `executeGraph`/`executeNode`/`executeCluster` and closes on `graphComplete` (ok) or `validationError`/`error` (failed), capturing `{ startedAt, durationSec, nodesExecuted, status, trigger }`. Reuses the same signals the job-notifications feature (PR #8 era) already reads.
- A `RunHistoryPanel` (dockable, newest-first) with status dot + duration; "Cancel" shown while `isExecuting` (reuses `resetExecution`/the existing cancel path); "Clear".
- A launcher button + `panels.history` in uiStore.

## Risk: **low–medium**
Phase 1 is additive frontend-only. The main risk is scope creep into per-node/persistence — explicitly deferred to Phase 2.

## Effort
Phase 1: **M** (store slice + panel + launcher + tests).

## Test plan
Unit: the run-record reducer (open/close on the event sequence; ok vs failed). Browser e2e: run a graph → a record appears with correct status/duration; Cancel mid-run; Clear empties it.
