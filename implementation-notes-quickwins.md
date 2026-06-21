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
