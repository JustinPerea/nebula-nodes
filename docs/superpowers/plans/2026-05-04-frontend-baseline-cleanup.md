# Frontend Baseline Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a clean baseline on `main` — zero ESLint errors, zero TypeScript errors, `npm run build` produces `dist/`, all tests pass — so future feature branches inherit a healthy starting state.

**Architecture:** Diagnosed root cause: `NodeData` lacks an index signature, so `Node<NodeData>` cannot satisfy `Record<string, unknown>` (the @xyflow/react generic constraint). This single architectural mismatch cascades into ~40 of the 52 TS errors across `graphStore.ts`, `nodeDefinitions.ts`, `graphFile.ts`, `Canvas.tsx`, `Toolbar.tsx`. Fix this first; remaining errors collapse to a small surgical set. Plus: 17 ESLint errors (unused-vars, empty blocks, `any`, React-hooks rule violations) and 2 TS errors from missing `model-viewer` JSX intrinsic declaration.

**Tech Stack:** React 19, TypeScript 5.x, Vite, ESLint, @xyflow/react, vitest. Python 3.12 (backend, only touched in Task 8 for setup-doc pin).

**Branch:** `chore/frontend-baseline-cleanup` (off `main` at `d58abf1`).
**Worktree:** `/Users/justinperea/Documents/Projects/nebula_nodes/.worktrees/chore-frontend-baseline-cleanup`.

**Out of scope:** any feature work, refactoring beyond what's needed to clear errors, repairing pre-existing logic bugs that aren't lint/type errors. If a fix surfaces a deeper architectural issue (e.g., the `IsValidConnection` typing fight), document it as a follow-up but don't expand scope.

**Decision authority for the implementer:** when fixing a TS error has multiple valid approaches, prefer the SMALLEST change that compiles cleanly. Type assertions (`as X`) are an acceptable last-resort if the alternative requires significant refactoring. Document each `as` cast with a one-line `// reason: ...` comment.

---

## Error inventory (snapshot 2026-05-04)

**ESLint (17 errors + 4 warnings):**

| Rule | Count | Files |
|---|---|---|
| `@typescript-eslint/no-unused-vars` | 7 | Canvas, RerouteNode, ChatPanel (3), graphStore, graphStore.test |
| `react-hooks/set-state-in-effect` | 4 | ConnectionPopup, AgentLog, ChatPanel, Settings |
| `no-empty` | 4 | ChatPanel (3), api.ts |
| `@typescript-eslint/no-explicit-any` | 2 | Inspector, graphStore.test |
| `react-hooks/refs` | 1 | ChatPanel:522 |
| `react-hooks/exhaustive-deps` | 4 (warnings) | ChatPanel (2), Inspector (2) |

**TypeScript (52 errors):**

| Code | Count | Meaning | Root cause |
|---|---|---|---|
| TS2344 | 24 | Type X does not satisfy constraint Y | `NodeData` ⊄ `Record<string, unknown>` |
| TS2322 | 16 | Type X not assignable to Y | Same as TS2344, cascade |
| TS2345 | 6 | Argument type incompatible | Same family |
| TS6133 | 4 | Declared but value never read | Underscore-prefix unused vars (TypeScript ignores ESLint's leading-underscore convention) |
| TS2339 | 2 | Property does not exist | `model-viewer` JSX intrinsic missing |

**File concentration (TS):** `graphStore.ts` (18), `nodeDefinitions.ts` (9), `graphFile.ts` (6), `Canvas.tsx` (5), `Toolbar.tsx` (4), `ChatPanel.tsx` (3), `Inspector.tsx` (2), `MeshPreview.tsx` (2), `useIsValidConnection.ts` (2), `App.tsx` (1).

---

## Task 1: Add `NodeData` index signature — clear the cascade

**Why:** Single root cause for ~40 TS errors. `@xyflow/react`'s `Node<TData>` requires `TData extends Record<string, unknown>`. Adding `[key: string]: unknown` to `NodeData` (and `DynamicNodeData`) satisfies this constraint without changing runtime behavior.

**Files:**
- Modify: `frontend/src/types/index.ts` (`NodeData` and `DynamicNodeData` interfaces)

- [ ] **Step 1: Capture the baseline TS error count**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/.worktrees/chore-frontend-baseline-cleanup/frontend
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -cE "^.*error TS"
```

Expected: 52 (record the actual count).

- [ ] **Step 2: Add index signature to `NodeData`**

Open `frontend/src/types/index.ts`. Find the `NodeData` interface (around line 107). Add an index signature:

```typescript
export interface NodeData {
  label: string;
  definitionId: string;
  params: Record<string, unknown>;
  state: NodeState;
  progress?: number;
  outputs: Record<string, PortValue>;
  error?: string;
  keyStatus?: 'ok' | 'missing';
  streamingText?: string;
  streamingPartials?: { index: number; src: string }[];
  // Index signature satisfies @xyflow/react's Node<T extends Record<string, unknown>>.
  // Keeps strong typing on declared properties while permitting the structural constraint.
  [key: string]: unknown;
}
```

Apply the same `[key: string]: unknown` to `DynamicNodeData` (around line 140) — it extends `NodeData` so it inherits the signature, but verify TypeScript is happy with the inheritance.

- [ ] **Step 3: Re-count TS errors**

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -cE "^.*error TS"
```

Expected: significant drop (target: ≤ 12). If the count didn't fall as expected, examine which errors remain — they may indicate the index signature alone wasn't enough (e.g., separate type-narrowing issues exist).

- [ ] **Step 4: Confirm no new errors introduced**

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -E "^.*error TS" | grep -v "Record<string, unknown>" | head -20
```

Read the remaining errors. They should be a smaller, more surgical set (TS6133 unused locals, TS2339 model-viewer, possibly a few isolated TS2322/TS2345 that aren't index-signature-related).

- [ ] **Step 5: Run frontend tests to confirm runtime behavior unchanged**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: same pass/fail count as before this change (no regression).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types/index.ts
git commit -m "fix(types): add index signature to NodeData for @xyflow/react Node<T>

@xyflow/react's Node<TData> generic requires TData extends Record<string, unknown>.
NodeData lacked the index signature, causing TS2344 cascade across graphStore,
nodeDefinitions, graphFile, Canvas, Toolbar (~40 errors).

Adding [key: string]: unknown satisfies the constraint without weakening the
declared property types — strong typing preserved on label, params, outputs, etc.

Expected drop: 52 → ≤12 TS errors."
```

---

## Task 2: Add `model-viewer` JSX intrinsic declaration

**Why:** `MeshPreview.tsx` uses Google's `<model-viewer>` web component. TypeScript needs a JSX intrinsic declaration for it. 2 TS2339 errors will clear.

**Files:**
- Create: `frontend/src/types/model-viewer.d.ts`

- [ ] **Step 1: Confirm the error sites**

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep "model-viewer"
```

Expected: 2 errors at `MeshPreview.tsx:32` and `MeshPreview.tsx:47`.

- [ ] **Step 2: Read MeshPreview.tsx for the actual attribute usage**

```bash
sed -n '25,55p' frontend/src/components/nodes/MeshPreview.tsx
```

Note which props are used (e.g. `src`, `auto-rotate`, `camera-controls`, `alt`, etc.).

- [ ] **Step 3: Create the declaration file**

Create `frontend/src/types/model-viewer.d.ts`:

```typescript
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          alt?: string;
          'auto-rotate'?: boolean | '';
          'camera-controls'?: boolean | '';
          'shadow-intensity'?: string | number;
          'environment-image'?: string;
          'exposure'?: string | number;
          ar?: boolean | '';
          poster?: string;
          loading?: 'auto' | 'lazy' | 'eager';
          reveal?: 'auto' | 'manual';
        },
        HTMLElement
      >;
    }
  }
}

export {};
```

If MeshPreview uses additional attributes not listed, add them (model-viewer's full attribute list: https://modelviewer.dev/docs/index.html — but only declare what we actually use).

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep "model-viewer"
```

Expected: empty.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types/model-viewer.d.ts
git commit -m "fix(types): declare <model-viewer> JSX intrinsic

MeshPreview.tsx uses Google's <model-viewer> web component; TypeScript
needs a JSX.IntrinsicElements declaration to recognize it. Declares
only the attributes MeshPreview uses (src, auto-rotate, camera-controls, etc.)."
```

---

## Task 3: Audit + fix remaining TS errors after the cascade clears

**Why:** After Task 1 + Task 2, TS error count should be ≤ 12. These remaining errors are likely TS6133 (unused locals — including any underscore-prefixed ones) and a few isolated TS2322/TS2345 that aren't fixed by the index signature. Address each.

**Files:** vary based on remaining errors

- [ ] **Step 1: Re-survey remaining TS errors**

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -E "^.*error TS" > /tmp/ts-errors-after-task-2.txt
wc -l /tmp/ts-errors-after-task-2.txt
cat /tmp/ts-errors-after-task-2.txt
```

Note the count and the specific errors.

- [ ] **Step 2: Categorize each remaining error**

For each error in `/tmp/ts-errors-after-task-2.txt`, classify into one of:
- (A) **Real bug:** the code is doing something type-incorrect that's also runtime-wrong. Fix the logic.
- (B) **Type system imprecision:** the code is correct but TS can't prove it. Add a type guard, type narrowing, or a tightly-scoped `as` cast with a `// reason:` comment.
- (C) **Library type bug:** @xyflow/react or another library has wrong types. Workaround with a cast + comment referencing the upstream issue if known.
- (D) **Genuine dead code:** delete it.

- [ ] **Step 3: Address each error one at a time**

For each error, make the smallest change that compiles. After each fix:

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -cE "^.*error TS"
```

Verify the count drops by 1 (or by N if a single fix cascades).

- [ ] **Step 4: Address TS6133 unused locals specifically**

If any TS6133 errors remain after the cascade, decide per-instance:
- If the variable is genuine dead code: DELETE.
- If it's in-progress feature scaffolding: COMMENT OUT the binding entirely (`// const _thinkingBodyRef = useCallback(...)`) so neither TS nor ESLint sees it. Add a `// TODO(<feature-name>): wire up — scaffolded YYYY-MM-DD` comment immediately above.
- DO NOT use the underscore-prefix strategy. TypeScript's `noUnusedLocals: true` does not honor it (this is what tripped Task 0.2 in the prior plan).

- [ ] **Step 5: Final verification**

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -cE "^.*error TS"
```

Expected: 0.

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | tail -5
```

Expected: empty output (no errors).

- [ ] **Step 6: Commit (one commit per logical group of fixes)**

For each cluster of related fixes (e.g. all TS6133 cleanups, or all `as` casts in graphStore), commit separately:

```bash
git add <files>
git commit -m "fix(types): <short description of the cluster>

<details: which errors fixed, what approach, any 'as' casts justified>"
```

---

## Task 4: Clear ESLint unused-vars (7 errors)

**Why:** Same 7 unused-vars errors documented earlier. This time, COMMENT-OUT (don't underscore-prefix) any binding kept for in-progress feature work, so TS6133 doesn't fire.

**Files:**
- Modify: `frontend/src/components/Canvas.tsx`
- Modify: `frontend/src/components/nodes/RerouteNode.tsx`
- Modify: `frontend/src/components/panels/ChatPanel.tsx`
- Modify: `frontend/src/store/graphStore.ts`
- Modify: `frontend/tests/store/graphStore.test.ts`

- [ ] **Step 1: Read each error site**

```bash
sed -n '85,90p' frontend/src/components/Canvas.tsx
sed -n '5,8p' frontend/src/components/nodes/RerouteNode.tsx
sed -n '525,615p' frontend/src/components/panels/ChatPanel.tsx | head -120
sed -n '15,22p' frontend/src/store/graphStore.ts
sed -n '90,100p' frontend/tests/store/graphStore.test.ts
```

- [ ] **Step 2: Apply fixes**

For each error:
- Canvas.tsx:86 `hideConnectionPopup` — DELETE (remove from destructure)
- RerouteNode.tsx:5 `_props` — DELETE the parameter. If TypeScript complains about `memo(RerouteNodeComponent)` typing, change to `function RerouteNodeComponent(): JSX.Element` (return-type explicit) so memo can infer.
- ChatPanel.tsx:527 `thinkingBodyRef` — COMMENT OUT entire binding + add `// TODO(thinking-collapse): wire up to JSX — scaffolded 2026-05-04` above
- ChatPanel.tsx:531 `toggleThinkingCollapsed` — same treatment as above
- ChatPanel.tsx:609 `err` in catch — change to bare `catch` (no binding)
- graphStore.ts:17 `fetchOpenRouterModels` — DELETE the import
- graphStore.test.ts:95 `state` — DELETE the parameter from the arrow fn

- [ ] **Step 3: Verify both checkers**

```bash
npm run lint 2>&1 | grep "no-unused-vars"
```

Expected: empty.

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep "TS6133"
```

Expected: empty (the comment-out strategy keeps the code visible without triggering TS).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Canvas.tsx \
        frontend/src/components/nodes/RerouteNode.tsx \
        frontend/src/components/panels/ChatPanel.tsx \
        frontend/src/store/graphStore.ts \
        frontend/tests/store/graphStore.test.ts
git commit -m "chore(lint): clear unused-vars across frontend

7 dead bindings: 5 deleted, 2 commented out (in-progress thinking-message
UI scaffolding in ChatPanel — TODO comments link to feature).

Note: prior attempt used underscore prefix; that satisfies ESLint but
TypeScript's noUnusedLocals still fires TS6133. Comment-out is the
pattern that pleases both."
```

---

## Task 5: Clear ESLint `any` types (2 errors)

**Why:** Same 2 errors. Same approach as Plan 1 Task 0.3 but redo here for clean baseline.

**Files:**
- Modify: `frontend/src/components/panels/Inspector.tsx`
- Modify: `frontend/tests/store/graphStore.test.ts`

- [ ] **Step 1: Read error sites + apply fixes**

For Inspector.tsx:42 — replace `any` with the specific return type of the upstream function (likely `Record<string, unknown>` from `getSettings()`). If narrowing is needed, add a type guard.

For graphStore.test.ts:403 — replace `as any` with `as Node<NodeData>` (or whatever the actual destination type is).

Do NOT use `// eslint-disable-next-line` for these.

- [ ] **Step 2: Verify**

```bash
npm run lint 2>&1 | grep "no-explicit-any"
```

Expected: empty.

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -cE "^.*error TS"
```

Expected: still 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/panels/Inspector.tsx frontend/tests/store/graphStore.test.ts
git commit -m "chore(lint): replace 'any' with specific types

Inspector + graphStore.test no longer use any. Type guards added where
narrowing required."
```

---

## Task 6: Clear ESLint empty-block errors (4)

**Why:** 4 `no-empty` errors in ChatPanel.tsx (3) + api.ts (1).

**Files:**
- Modify: `frontend/src/components/panels/ChatPanel.tsx`
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Read each error site + classify**

```bash
sed -n '395,420p' frontend/src/components/panels/ChatPanel.tsx
sed -n '478,485p' frontend/src/components/panels/ChatPanel.tsx
sed -n '68,75p' frontend/src/lib/api.ts
```

For each empty block:
- If genuinely intentional (swallowed error): replace with `catch { /* swallowed: <reason> */ }` (note the inline comment satisfies the rule).
- If a missing implementation: write the implementation OR add a TODO comment describing what's needed.
- If a no-op stub for an interface: replace with `() => undefined` if applicable.

- [ ] **Step 2: Verify**

```bash
npm run lint 2>&1 | grep "no-empty"
```

Expected: empty.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/panels/ChatPanel.tsx frontend/src/lib/api.ts
git commit -m "chore(lint): annotate intentional empty blocks

Empty blocks (swallowed errors, no-op callbacks) gain explicit comments
explaining intent."
```

---

## Task 7: Clear ESLint React-specific errors (4)

**Why:** 3× `react-hooks/set-state-in-effect` + 1× `react-hooks/refs` (Cannot access refs during render). These are real bugs — `setState` in `useEffect` triggers cascading renders; reading `ref.current` during render is unsupported in React 18+.

**Files:**
- Modify: `frontend/src/components/ConnectionPopup.tsx`
- Modify: `frontend/src/components/panels/AgentLog.tsx`
- Modify: `frontend/src/components/panels/ChatPanel.tsx` (line 522 ref-during-render; possibly other setState-in-effect)
- Modify: `frontend/src/components/panels/Settings.tsx`

- [ ] **Step 1: Read each error site (full surrounding component context)**

```bash
sed -n '30,60p' frontend/src/components/ConnectionPopup.tsx
sed -n '70,100p' frontend/src/components/panels/AgentLog.tsx
sed -n '510,535p' frontend/src/components/panels/ChatPanel.tsx
sed -n '50,75p' frontend/src/components/panels/Settings.tsx
```

- [ ] **Step 2: Apply fixes per pattern**

**setState-in-effect fix patterns:**
- Derive value during render via `useMemo`:
  ```tsx
  // Before
  useEffect(() => { setSomething(deriveSomething(props)); }, [props.x]);
  // After
  const something = useMemo(() => deriveSomething(props), [props.x]);
  ```
- For state that genuinely needs to live in `useState` (e.g. user-controlled, externally-mutated): move the `setState` into an event handler instead of an effect.

**Ref-during-render fix:**
- Move the `ref.current` access into a `useEffect` (post-mount), or into the relevant event handler.

For each component, choose the smallest refactor that resolves the lint error without changing observable behavior. If you can't preserve behavior, ESCALATE — don't ship a behavior change in this baseline plan.

- [ ] **Step 3: Verify lint**

```bash
npm run lint 2>&1 | grep -E "set-state-in-effect|refs|Calling setState|Cannot access refs"
```

Expected: empty.

- [ ] **Step 4: Run vitest to verify behavior preserved**

```bash
npx vitest run 2>&1 | tail -10
```

Expected: same pass/fail as before. If a refactor broke a test, fix the test ONLY if the behavior change is correct; otherwise revert and escalate.

- [ ] **Step 5: Manual smoke test**

Start dev server (`npm run dev`), exercise the affected components:
- ConnectionPopup: hover over a node port, verify popup appears + dismisses correctly.
- AgentLog: open the panel, send a chat turn, verify log entries render.
- ChatPanel: send a message, verify thinking blocks + image attachments work.
- Settings: open settings, change a key, verify save flow.

If any user-visible behavior changed, ESCALATE.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ConnectionPopup.tsx \
        frontend/src/components/panels/AgentLog.tsx \
        frontend/src/components/panels/ChatPanel.tsx \
        frontend/src/components/panels/Settings.tsx
git commit -m "fix(react): resolve set-state-in-effect + ref-during-render lint errors

useEffect-based setState calls refactored to useMemo (sync derivation)
where possible; ref reads moved to effects/handlers.

Manual smoke test: ConnectionPopup, AgentLog, ChatPanel, Settings all
exhibit unchanged user-visible behavior."
```

---

## Task 8: Pin Python 3.12 in setup docs (carry over from Plan 1 Task 0.1)

**Why:** Same fix that landed on `feat/batch-cross-pair`'s commit `29cc677`. Apply to this branch too so when baseline merges to `main`, the doc fix lands too.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Cherry-pick the existing commit OR redo the edit**

Easiest:
```bash
git cherry-pick 29cc677
```

If that fails due to conflicts, manually re-apply per Plan 1 Task 0.1 Step 2:
```bash
sed -i.bak 's|python3 -m venv .venv && source .venv/bin/activate|python3.12 -m venv .venv \&\& source .venv/bin/activate     # 3.13 also works; pydantic-core lacks 3.14 wheels|' README.md
```

- [ ] **Step 2: Verify**

```bash
grep -n "python3.12 -m venv" README.md
```

Expected: line 155 matches.

- [ ] **Step 3: Commit (only if cherry-pick failed)**

If cherry-pick succeeded, the commit is already there. If you re-applied manually, commit:

```bash
git add README.md
git commit -m "chore(setup): pin python 3.12 in setup docs

(Re-application of feat/batch-cross-pair commit 29cc677 to baseline branch.)"
```

---

## Task 9: Final verification — green baseline

**Why:** Confirm everything is clean before declaring the plan done.

- [ ] **Step 1: Frontend lint**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/.worktrees/chore-frontend-baseline-cleanup/frontend
npm run lint 2>&1 | tail -5
```

Expected: `✖ 0 problems` (no errors, no warnings if possible — warnings ok if they're `react-hooks/exhaustive-deps` that require behavior changes).

- [ ] **Step 2: Frontend TypeScript**

```bash
npx tsc --noEmit -p tsconfig.app.json 2>&1 | tail -3
```

Expected: empty output (no errors).

- [ ] **Step 3: Frontend build produces dist/**

```bash
rm -rf dist && npm run build 2>&1 | tail -10
ls dist/
```

Expected: `dist/` directory created with `index.html`, `assets/`. No error output during build.

- [ ] **Step 4: Frontend tests**

```bash
npx vitest run 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Backend tests on Python 3.12**

```bash
cd ../backend && python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python -m pytest -x 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Capture baseline state in a note**

Create `docs/superpowers/plans/2026-05-04-frontend-baseline-cleanup-summary.md`:

```markdown
# Frontend Baseline Cleanup — Final State

**Date:** [date completed]
**Branch:** chore/frontend-baseline-cleanup
**Merged to main:** [date or "pending"]

## Before

- ESLint: 17 errors + 4 warnings
- TypeScript: 52 errors
- npm run build: exits 0 but produces no dist/

## After

- ESLint: 0 errors [+ N warnings if any]
- TypeScript: 0 errors
- npm run build: produces dist/ successfully
- vitest: all pass
- pytest (Python 3.12): all pass

## What changed (commit list)

[paste git log --oneline output here]

## Carryover to feature branches

After this lands on `main`, any active feature branch (e.g. `feat/batch-cross-pair`)
needs a rebase to inherit the cleanup. The 3 commits already on
`feat/batch-cross-pair` (29cc677, 4a8ccc8, 8b4a1cc) overlap with this work and
will likely become no-ops or trivial conflicts during rebase.
```

- [ ] **Step 7: Commit the summary + final wrap-up**

```bash
git add docs/superpowers/plans/2026-05-04-frontend-baseline-cleanup-summary.md
git commit -m "docs: capture frontend baseline cleanup final state

Summarizes the before/after counts and the commit sequence. Notes the
carryover impact on feat/batch-cross-pair (rebase needed)."
```

---

## Self-Review

After completing all 9 tasks:

1. **Spec coverage:**
   - ✅ NodeData index signature (Task 1) — addresses ~40 cascade TS errors
   - ✅ model-viewer JSX intrinsic (Task 2) — 2 TS errors
   - ✅ Remaining TS errors after cascade (Task 3) — surgical
   - ✅ ESLint unused-vars (Task 4) — without re-introducing TS6133
   - ✅ ESLint any types (Task 5)
   - ✅ ESLint empty blocks (Task 6)
   - ✅ ESLint React-specific (Task 7)
   - ✅ Python 3.12 pin (Task 8) — duplicated from Plan 1 Task 0.1
   - ✅ Verification (Task 9) — green baseline confirmed

2. **Placeholder scan:** No "TBD"/"TODO"/"implement later" left in any task. Each step shows exact code or verbatim command. The TODO comments added during Task 4 are intentional content, not plan placeholders.

3. **Type consistency:**
   - `NodeData` interface change in Task 1 is the foundation; Tasks 3/4/5 reference the resulting type structure consistently.
   - `Node<NodeData>` (the @xyflow/react generic) is used consistently in Task 5 (replacing `any` in graphStore.test) and matches Task 1's foundation work.
   - `[key: string]: unknown` index signature notation is the same in NodeData and DynamicNodeData.

---

## Carryover instructions for `feat/batch-cross-pair`

After this branch merges to `main`:

1. Switch to feat worktree: `cd /Users/justinperea/Documents/Projects/nebula_nodes/.worktrees/feat-batch-cross-pair`
2. Rebase: `git fetch origin && git rebase origin/main`
3. Expected conflicts on the 3 cleanup commits (29cc677, 4a8ccc8, 8b4a1cc):
   - `29cc677` (Python pin): drop with `git rebase --skip` if Task 8 already applied it
   - `4a8ccc8` (unused-vars suppression): drop or rewrite — the underscore-prefix strategy was wrong, baseline used comment-out instead
   - `8b4a1cc` (any types): drop with `git rebase --skip` if Task 5 already applied it
4. After rebase, run `npm run lint && npx tsc --noEmit -p tsconfig.app.json && npm run build` to confirm `feat/batch-cross-pair` inherits the green baseline.
5. Resume Plan 1 starting at Task 1 (Backend Variant<T> data model). Plan 1's Task 0 is fully superseded by this baseline plan.
