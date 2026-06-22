# Autonomous Goal Backlog — Flora/ComfyUI gap closure

> The persistent state + protocol for the autonomous build loop. Each iteration picks the top `todo` gap that passes the **autonomous-safe** filter, implements it, runs all gates, has an **independent verifier agent** check it, and (per the user's chosen policy) **auto-merges to `main`** only when gates are green AND the verifier returns PASS. Never merges red.
> Source of gaps: `flora-comfyui-gap-analysis.md` (54 confirmed) + `§2b` additions.

## Loop protocol (per iteration)
1. Read this file → pick the top `todo` gap with `auto: yes`.
2. Branch off latest `main` (`git checkout main && git pull`).
3. Implement the gap (smallest correct change; reuse existing patterns; no new deps).
4. Run gates: `tsc -b --noEmit`, `eslint` (changed files), `check:slava-css-scope`, `vitest run`, `npm run build`; + `pytest` if backend touched. Add tests for new logic.
5. Spawn an **independent verifier agent** (code-reviewer): re-runs gates + adversarially reviews the change against the gap requirement → PASS/FAIL + findings.
6. FAIL → fix → re-verify (max 2 rounds). Still failing → mark `blocked` (with reason) and move on. Never merge red.
7. PASS + green → commit, push, open PR, **auto-merge to main**, delete branch.
8. Update this file (status + one-line note), commit to main.
9. Schedule the next iteration.

## Autonomous-safe filter
- ✅ **auto: yes** — well-scoped, no new dependency (14-day rule), no unresolved product/UX decision, testable, not against the local-first/BYOK thesis.
- ⏸️ **auto: no (flag)** — needs a product/UX decision, a new dependency, is against the thesis (cloud GPU, hosted accounts), is a security-sensitive surface, or is a large/risky engine rewrite. These are listed at the bottom for the user to direct.

## Done (shipped + merged)
- ✅ `g-large-graph-perf` — viewport culling + minimap + controls + zoom LOD (PR #6)
- ✅ `g-friendly-moderation-errors` — error classifier + NodeError (PR #6)
- ✅ `g-command-palette` — ⌘K palette (PR #6)
- ✅ `g-job-notifications` — completion notifications (PR #6)
- ✅ `g-onboarding-firstrun` — welcome + spotlight tour + sample graph (PR #6)
- ✅ `g-elements-asset-library` (Phase 1) — unified Assets panel collapsing 3 palettes (PR #7)

## Queue (auto: yes) — in priority order
1. `g-prompt-improver-builtin` — ✅ `done` (PR #8) — Create "Enhance" button → `POST /api/enhance-prompt` (provider fall-through), non-destructive Undo. Independent verify PASS + browser end-to-end.
2. `g-image-compare-slider` — `todo` — before/after wipe slider (Create gallery/Lightbox first; reusable component).
3. `g-router-node` — ✅ `done` (already shipped) — verified complete: `nodeDefinitions.ts:2006` + `node_definitions.json:2984` (1 input → out1/out2/out3) + `engine.py` handler (local node, copies input to all 3 outputs). No change needed; the "partial" assessment was stale.
4. `g-variation-fanout` — `todo` — Create "Vary" mode on the quantity stepper (Seed/Style/Prompt) + gallery grouping.
5. `g-export-node-multiformat` — `todo` — per-card download format menu + gallery "Download all (ZIP)" + Video Editor export.
6. `g-document-node` — `blocked?` — PDF ingestion needs a PDF lib; re-check for an already-present dep before building, else flag.
7. `g-auto-layout` — `todo` — dependency-aware layout for agent/Create-authored graphs (replace the naive row stagger).
8. `g-node-groups-color-tags` — `todo` — color tags + canvas search + bulk edit (groups/frames may be a follow-up).
9. `g-cinema-per-shot-backend` — `todo` — per-shot generate entrypoint + real variations strip in Cinema Studio.
10. `g-queue-history-manager` — `todo` — global queue/run-history panel (cancel/retry/clear) + asset search.

## Flagged for the user (auto: no — needs a decision / out of autonomous scope)
- `g-llm-tool-calling` (HIGH) — tool/function calling on the 4 LLM nodes; large + shapes the agent story → wants a design call.
- `g-controlnet-structural-conditioning` — needs backend control primitives / likely new model deps.
- `g-subgraphs`, `g-creative-history-branching`, `g-output-provenance-browser` — large engine/data surfaces.
- `g-realtime-collab`, `g-project-sharing`, `g-app-mode-share` — collaboration; OSS-reframe + product decisions.
- `g-cloud-hosted-gpu` — against the local-first thesis (out).
- `g-mcp-server`, `g-public-api`, `g-custom-node-ecosystem` — platform surfaces; security-sensitive / product decisions.
- `g-marketing-ugc-studio` (HIGH) — a whole new studio; product decision.
- `g-i18n` — touches every string; large mechanical, low near-term value.
- `g-elements-asset-library` Phase 2 (`/api/elements` + Save-to-library + @-mention + agent readability) — design-y; revisit after the queue.

## Run log
- **Iter 1** — `g-router-node`: verify-first found it already fully implemented (both registries + engine handler, 3-output pass-through). Marked done, no change.
- **Iter 2** — `g-prompt-improver-builtin` (PR #8, merged): new `POST /api/enhance-prompt` (`services/prompt_enhance.py`, provider fall-through) + Create "Enhance" button (Undo, loading, error). 17 backend + 355 frontend tests green; independent code-reviewer PASS; browser end-to-end verified. Verify-the-output caught a live 401 on the first key → added provider fall-through so a bad key doesn't block the feature. Next: `g-image-compare-slider`.
