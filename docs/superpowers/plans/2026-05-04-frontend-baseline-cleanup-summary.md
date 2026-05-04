# Frontend Baseline Cleanup — Final State

**Date:** 2026-05-04
**Branch:** `chore/frontend-baseline-cleanup`
**Worktree:** `/Users/justinperea/Documents/Projects/nebula_nodes/.worktrees/chore-frontend-baseline-cleanup`
**Merged to main:** pending

## Before

- ESLint: 17 errors + 4 warnings
- TypeScript: 52 errors
- `npm run build`: exits 0 but produces NO `dist/`
- Backend `pip install -r requirements.txt`: fails on Python 3.14 (no pydantic-core wheels)

## After

- ESLint: **0 errors** (4 non-blocking `react-hooks/exhaustive-deps` warnings remain — explicitly out of scope for this plan)
- TypeScript: **0 errors**
- `npm run build`: produces `dist/` with `index.html`, `assets/`, `favicon.svg`, etc. (built in 638ms)
- Backend pytest on Python 3.12: **220 passed**, 0 failed
- Vitest: 17 fail / 29 pass (no regressions — these failures pre-date this work and are unrelated to the cleanup)

## What changed (commit list)

```
b948b78 chore(setup): pin python 3.12 in setup docs (cherry-picked from feat/batch-cross-pair 29cc677)
b75caa2 chore(lint): add reason suffixes to react-hooks disable directives
58690b8 fix(react): resolve set-state-in-effect + ref-during-render lint errors
e3557603 chore(lint): annotate intentional empty blocks (4 errors)
f4a16af chore(lint): replace 'any' with specific types
25dfdf5 chore(lint): clear remaining unused-vars (3 errors)
81bdc22 fix(types): correct misleading applyNodeChanges cast comment
a41feed fix(types): cast unknown[] edges in Toolbar + PortValue outputs in graphFile
0a3afe8 fix(types): narrow Inspector unknown params to ReactNode via Boolean()
3b3face chore(lint): comment out ChatPanel thinking-collapse scaffolding + fix thumbUrl non-null
f2db729 fix(types): resolve Canvas xyflow type mismatches
642e133 fix(types): cast applyNodeChanges return + drop fetchOpenRouterModels import
339ea41 fix(types): add 'meshy' and 'nous' to APIProvider union
f1db348 fix(types): declare <model-viewer> JSX intrinsic
9807eda fix(types): add index signature to NodeData for @xyflow/react Node<T>
1d97ff0 plan: frontend baseline cleanup (supersedes Plan 1 Task 0)
```

15 commits total (excluding the plan commit). Each has a tight scope and a clear message.

## Suppressions documented for follow-up

The baseline cleanup ships with 5 `eslint-disable-next-line react-hooks/set-state-in-effect` directives, all carrying inline `-- reason:` suffixes. Two of them are flagged with `TODO(post-baseline)` markers because the suppressions paper over real anti-patterns that deserve revisit when feature work pauses:

1. **`AgentLog.tsx:85`** — log entry append in effect. TODO: dispatch from store action that sets `isExecuting`, OR consume the existing `nebula:agent-log-entry` custom event.
2. **`ChatPanel.tsx:481`** — Daedalus model fallback validation in watcher effect. TODO: move into the catalog fetch `.then()` so validation happens at load time.

The other 3 (`ConnectionPopup`, `ChatPanel:435`, `Settings:63`) are reset-on-open and async-data-fetching-initiator patterns that don't have a meaningfully cleaner refactor — the suppressions are the right call.

Also: `ChatPanel.tsx:528,533` `_thinkingBodyRef` and `_toggleThinkingCollapsed` are commented out (not deleted) as in-progress feature scaffolding for the thinking-message collapse UI.

## Notable architectural finding

**`NodeData` adding `[key: string]: unknown` was the load-bearing fix.** Cleared 27 of 52 TS errors (all 24 `TS2344` + 3 cascade `TS2322`). This is the pattern to remember: `@xyflow/react`'s `Node<TData extends Record<string, unknown>>` constraint requires an index signature on the data type. Future per-node-type data interfaces (Variant, BatchData, etc. from Plan 1) should include this from the start.

## Notable plan correction

The plan suggested using `declare global { namespace JSX { interface IntrinsicElements { ... } } }` for the `<model-viewer>` declaration. **This pattern does not work in React 19 + Vite + `jsx: "react-jsx"`** — `react-jsx` transform exposes the JSX namespace via the `react` module, not the global namespace. The correct pattern is `declare module 'react' { namespace JSX { ... } }` (module augmentation). Future intrinsic declarations should use module augmentation in this codebase.

## Carryover to feature branches

After this branch merges to `main`, any active feature branch needs a rebase. Specifically `feat/batch-cross-pair` has 3 commits that overlap with this work:

1. `feat/batch-cross-pair@29cc677` — Python pin: this branch already cherry-picked it (`b948b78`). On rebase: `git rebase --skip` or it'll resolve as a no-op.
2. `feat/batch-cross-pair@4a8ccc8` — unused-vars suppression with underscore-prefix: this branch redid the work without underscore-prefix (which TypeScript's `noUnusedLocals` doesn't honor). On rebase: drop with `git rebase --skip` because the work is superseded.
3. `feat/batch-cross-pair@8b4a1cc` — any-types fix: this branch redid the work in `f4a16af`. On rebase: drop with `git rebase --skip`.

After rebase, run `npm run lint && npx tsc --noEmit -p tsconfig.app.json && npm run build` from the feat worktree to confirm baseline inheritance, then resume Plan 1 starting at Task 1 (Variant<T> backend model). Plan 1's Task 0 is fully superseded by this baseline plan.

## Pre-existing concerns flagged but NOT addressed

These are real issues the cleanup work surfaced but stayed out of scope for the baseline plan. Capture for future work:

- **17 vitest failures in `graphStore.test.ts`** — pre-date this work. Test suite needs investigation; likely related to test setup or stale fixtures.
- **`graphFile.ts:107` outputs structural cast** — accepts any-shaped JSON without runtime validation. A schema check (zod or hand-rolled) would harden the deserialization path.
- **4 `react-hooks/exhaustive-deps` warnings** (ChatPanel:1030, ChatPanel:1177, Inspector:65, Inspector:79) — non-blocking, but each is a real missing-dependency that could cause stale-closure bugs.
- **`ConnectionPopup.tsx` reset-on-open could use `key`-based remount** — would eliminate the need for the disable directive, but at the cost of running all effects (focus setup, etc.) on every open.

## Verification commands

To re-confirm green baseline at any time:

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/.worktrees/chore-frontend-baseline-cleanup/frontend
npm run lint            # → 0 errors, 4 warnings
npx tsc --noEmit -p tsconfig.app.json  # → 0 errors
rm -rf dist && npm run build && ls dist/  # → builds, dist/ contains index.html
npx vitest run          # → 17 fail / 29 pass (pre-existing baseline)

cd ../backend
source .venv/bin/activate  # python3.12 venv
python -m pytest        # → 220 passed
```
