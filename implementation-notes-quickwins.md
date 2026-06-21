# Implementation Notes — Quick-Wins Batch (2026-06-21)

Running log of decisions/changes/tradeoffs while building the 5 quick-wins (plan: `docs/research-2026-06/quick-wins-build-plan.md`). Branch: `quick-wins-batch`.

## Conventions reused across all 5
- Persisted UI prefs follow the `agentLogEnabled` pattern in `uiStore.ts` (localStorage key + `load*`/`persist*` helpers + state field + setter).
- Settings toggles copy the `.settings__toggle-row` markup in `Settings.tsx` "Interface" section.
- Slava is the only maintained skin — theme there first; default/hermes minimal.
- No new dependencies (verified React Flow already exports MiniMap/Controls/Panel/useStore).

---

## P0.1 — Large-graph canvas performance

**Status:** code-complete; `tsc -b --noEmit` clean; eslint clean on changed files. Browser verify pending the consolidated pass.

> Note: `npm run lint` fails on a PRE-EXISTING `check:inline-styles` violation in `BrandShowcaseView.tsx` (not in this changeset; brand surface is deprecated per memory). eslint passes on all files I touched.

Decisions:
- Two persisted toggles, both default **ON**: `canvasPerfMode` (`nebula:canvas:perfMode`) = `onlyRenderVisibleElements` + MiniMap + Controls; `canvasLowDetail` (`nebula:canvas:lowDetail`) = hide node preview media past zoom 0.4.
- LOD via a `<ZoomLodController>` child of `<ReactFlow>` that reads zoom with `useStore((s) => s.transform[2])` (re-renders only on zoom *number* change, not pan; component returns null so no DOM diff) and writes `data-lod` on the `.canvas-wrapper` via a ref. Avoids re-rendering every node.
- LOD hides the whole `.model-node__preview` block (heaviest = images/video) + port labels; keeps handles/edges/header visible so topology stays readable.
- Confirmed Canvas is mounted inside `<ReactFlowProvider>` (App.tsx:184) so `useStore` works.
- Reused the orphaned `.react-flow__controls` CSS already in `canvas.css`; added MiniMap theming (default + Slava) and a small node-count `<Panel>`.

Open/!flagged: MiniMap+Controls change default canvas chrome (taste call surfaced to user; defaulting ON per plan).

---

## P0.2 — Friendly moderation / safety errors

**Status:** code-complete; 43 backend tests pass (22 new classifier + 21 engine); `tsc -b --noEmit` clean; my eslint clean.

Decisions:
- New `backend/execution/error_classifier.py` — pure, never-raises `classify_error(raw) -> (category, friendly, retryable)`. Categories: blocked/auth/quota/rate_limit/timeout/network/invalid_input/unknown. **blocked checked before generic 4xx** (a 400 with a moderation marker → blocked). unknown → truncated raw (140 chars). retryable=True for rate_limit/timeout/network.
- `ErrorEvent` gains optional `category`/`friendly` (raw `error` unchanged). `main.py` camelize is generic → no edit needed (single-word keys pass through).
- `engine.py:743` except block classifies and attaches; **one edit covers all providers**.
- Shared `frontend/.../nodes/NodeError.tsx` replaces the raw-error `<div>` in BOTH `DynamicNode` and `ModelNode`; shows friendly message + raw in a collapsed `<details>` (nothing lost). `blocked` gets a calmer amber/muted treatment (still an error state, not a red failure).
- CSS: `--blocked` modifier + details styling in `nodes.css` (default) and `slava-restraint.css` (active skin). Skipped `hermes.css` (deprecated; base error rule still applies).

Found (out of scope, flagged via spawn_task): `ModelNode.tsx` has 3 PRE-EXISTING `react-hooks/rules-of-hooks` violations (conditional `useGraphStore`/`useMemo` after an early return). Not introduced by me (confirmed on committed version); latent because `npm run lint` bails on the inline-styles check before eslint runs.

---

## P0.3 — Cmd+K command palette

**Status:** code-complete; `tsc -b --noEmit` clean; eslint clean on changed files.

New files: `lib/commandPalette.ts` (PaletteCommand type + `buildCommands(ctx)` + `filterCommands`), `components/CommandPalette.tsx` (portal overlay + global hotkey), `styles/command-palette.css` (default + Slava). Modified: `App.tsx` (mount inside ReactFlowProvider, gated `!isBrandShowcase`).

Decisions / deviations from the scoper spec:
- **DEVIATION:** scoper said "palette wins globally" over the editor's Cmd+K. I chose the opposite — the palette *yields* in `editor`/`remotion-editor` views (the editor's Cmd+K = cut-clip-at-playhead is core muscle memory). The hotkey handler checks `useUIStore.getState().viewMode` and bails in those views. Cleaner than capture-phase fighting and preserves editor UX.
- Commands: all 138 nodes (insert at viewport center via `screenToFlowPosition`), Actions (Run/Save/Load/Fit — Save/Load reuse the existing `nebula:save`/`nebula:load` CustomEvents the Toolbar already listens for), View (Create view, panel toggles, skins), Agent ("Ask the agent…" → sub-mode → dispatches `nebula:chat-send`, which auto-sends; correct here since the user explicitly typed a query).
- **Did NOT** extract Toolbar's handleClear/handleImportCLI/handleResetLayout (scoper's "may defer") — avoids touching working Toolbar flows for v1. So no Toolbar/NodeLibrary edits at all.
- eslint react-hooks rules forced two refactors: precomputed `indexById` map instead of a mutated render counter; derived `safeSelected` at render + resets moved into the keydown handler instead of `setState`-in-effect.
- v1 ordering is alphabetical-by-group (Actions/View/Agent/Nodes); MRU deferred.

---

## P0.4 — Job notifications

**Status:** code-complete; `tsc -b --noEmit` clean; eslint clean; 8 vitest tests pass.

New: `lib/jobNotifications.ts` (pure glue — prefs, permission, `shouldNotifyFor`, OS Notification, tab-title + favicon badge, WebAudio beep), `tests/jobNotifications.test.ts`. Modified: `graphStore.ts`, `uiStore.ts`, `Settings.tsx`, `App.tsx`.

Decisions:
- **Default OFF** — enabling is the user gesture that requests Notification permission (`setNotificationPrefs` calls `ensureNotificationPermission()` + `primeAudio()` on enable). Never prompts unprompted.
- **Failure detection** (the tricky bit — no terminal "failed" event): module-level `currentRunHadError` in graphStore, reset in `resetExecution()` (the single shared entry point all execute* methods call), set true in the `error` and `validationError` cases. `graphComplete` notifies `ok: !currentRunHadError`; `validationError` notifies `ok:false` directly (it ends the run with no following graphComplete). Exactly one notification per run.
- `shouldNotify = tab hidden || duration >= 30s` (fixed 30s constant). Whole-graph completion only (not per-node).
- Working-badge coordinator lives in an App.tsx effect subscribing to `isExecuting` transitions (keeps the concern out of the store); badge only shows while `document.hidden`; restores on focus/visible.
- Favicon dot drawn on a runtime canvas, fully try/catch-guarded → title-only fallback if the SVG taints the canvas. All `Notification`/`document`/`AudioContext` access feature-detected + guarded.
- No import cycle: `jobNotifications` is a leaf (imported by both graphStore and uiStore; imports neither).
