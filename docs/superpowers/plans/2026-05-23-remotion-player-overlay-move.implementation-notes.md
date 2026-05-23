# Plan 2.3.a — Implementation Notes

Running log of decisions, deviations, and tradeoffs made during execution of
`docs/superpowers/plans/2026-05-23-remotion-player-overlay-move.md` on branch
`feat/remotion-player-overlay-move` (parented at `a514e36`, plan committed at
`de681d1`). Eleven implementation commits between `669ff72` and `87cffce`.

Format: one section per task. Each section lists `Decisions outside the spec`,
`Changes`, `Tradeoffs`, and `Deferred` items.

---

## T1 — uiStore.isKeyframeRecording + toggleKeyframeRecording (commit `669ff72`)

Clean execution. No deviations from plan template. Implementer noted a minor
pre-existing inconsistency in code review: `setSelectedTrackItem` uses block-body
style while adjacent setters use inline arrow body — pre-existing, not introduced
by T1. Left as-is.

---

## T2 — updateTrackItemSpatial graphStore action (commit `6e72f46`)

### Decisions outside the spec

- **Parameterized `seedRemotionWithItem` with optional `remotionId` (default `'r1'`).** The
  plan template's debounce test (test 5) used `'r1'` like the other tests. But
  `maybePushUndo` keeps module-level state (`lastUndoNodeId`, `lastUndoPush`); by
  the time test 5 ran, the debounce window for `'r1'` was still open from tests 1-4,
  so the first call's `pushUndo` would be silently skipped and `undoAfter -
  undoBefore` would be `0`, failing the assertion. Using a fresh nodeId
  (`'r-undo-test'`) for test 5 resets the tracker. The helper change supports this
  without forking the function.
- **Added explicit `undoStack: [], redoStack: []` reset in the seed helper's
  setState.** Defensive — the `beforeEach` already replaces full state with
  `INITIAL_GRAPH_STATE` which has empty stacks, but making the seed function
  self-contained means future tests don't depend on the beforeEach to clear
  stacks.

### Changes outside the spec

- **Test 5 grew an undo round-trip assertion** (`state.undo()` then read x === 0).
  The spec only asked for the debounce assertion; the extra check verifies the
  undo path actually restores — a stronger assertion of the maybePushUndo intent.
  Code reviewer flagged that this works today only because
  `updateTrackItemSpatial` always produces a fresh `manifest` reference inside
  `set()`. If a future change ever mutates the manifest in place, the round-trip
  would silently pass while undo broke. Not fixed; noted as a forward-looking
  risk.

### Tradeoffs

- **Type annotation `Partial<TrackItem['spatial']>` vs `Partial<SpatialTransform>`.**
  Both are equivalent (TrackItem['spatial'] resolves to SpatialTransform). Kept
  `Partial<TrackItem['spatial']>` so graphStore.ts doesn't need a new import.
  Reviewer noted `Partial<SpatialTransform>` is marginally more readable.

### Deferred

- Action signature placement: spec said "directly below `updateTrackItemProps`";
  actual placement landed below `updateTrackItemTime` (which itself sits directly
  below `updateTrackItemProps`). Functionally equivalent; flagged but not fixed.

---

## T3 — data-track-item-id on 5 CSS-driven renderers (commit `a469ac5`)

### Decisions outside the spec

- **Added vi mocks for `Img` (from 'remotion'), `Video` (from '@remotion/media'),
  and `Lottie` (from '@remotion/lottie') in
  `renderers.dataTrackItemId.test.tsx`.** The plan only specified the
  `useCurrentFrame` mock. Without the additional component mocks, the renderers
  blow up outside a Composition/VideoConfig context — JSDOM rendering fails. The
  `Lottie` mock follows precedent from `LottieRenderer.test.tsx`; the `Img` and
  `Video` mocks are new but justified by the same constraint.

### Deferred

- **No test for LottieRenderer's `[loading lottie…]` branch.** Code reviewer
  flagged this as the only Important gap. The production code IS correct for that
  branch — only test coverage is missing. The 7 prescribed tests cover the happy
  path + empty-state for all 5 renderers. The loading branch is identical JSX,
  so risk of silent regression is low. Defer to a fast follow-up if it becomes a
  real concern.
- **No happy-path test for VideoRenderer** (the empty-state test covers the
  attribute mechanism; the happy path uses identical JSX). Reviewer noted as
  Minor.

---

## T4 — PlayerOverlay + SelectionBox scaffolding (commits `7b6d97c`, `674c6dd`)

### Decisions outside the spec

- **SelectionBox `setRect` uses an equality guard** instead of the spec template's
  unconditional `setRect({...})`. The spec template had a `useEffect` with no deps
  array that called `setRect` with a new object literal every render. Without an
  equality guard, every render would call `setRect` with a new object reference;
  React's `Object.is` on two distinct object literals (even with identical
  values) returns false → re-render → effect runs → `setRect` called again →
  infinite loop. The implementer added a four-property strict-equality check; if
  values match, return the previous reference so React bails out. This is a real
  plan-template bug fix, not gold-plating.
  - **Note:** T5 replaces this guard with a different mechanism — the spatial
    subscription causes intentional re-renders, and the useEffect gets an
    explicit `[trackItemId, spatial]` deps array. The T4 guard is gone after T5.
- **Added `document.elementsFromPoint` no-op stub to `frontend/tests/setup.ts`.**
  JSDOM doesn't implement `elementsFromPoint`. The spec's PlayerOverlay tests
  use `vi.spyOn(document, 'elementsFromPoint')`, which throws if the property
  doesn't exist. The stub is guarded (`if (typeof document.elementsFromPoint
  !== 'function')`) so future JSDOM versions that ship the API won't be shadowed.

### Changes outside the spec

- **Follow-up commit `674c6dd`:** Added a `beforeEach` `document.querySelectorAll`
  cleanup to PlayerOverlay tests, mirroring SelectionBox tests. Manual cleanup
  inside tests was vulnerable to assertion-throw leaks. Code reviewer flagged
  this; we applied the fix to be belt-and-suspenders.

### Deferred

- **`.remotion-selection-box` has no explicit `z-index`** — reviewer flagged as
  Minor. Works today because of natural DOM ordering inside the editor view's
  z=50 stacking context. Could be brittle if a renderer adds `transform` or
  `will-change` in a future task.
- **Inline `style` on `<Player>` is redundant** with the `__player-frame` CSS that
  now sets the same width / max-width / aspect-ratio. Reviewer flagged. Not
  removed because there's no breakage; touching it would also be a deviation.

---

## T5 — coordinates.ts + SelectionBox body drag (commits `a97e482`, `6b403a4`)

Cleanest task of the plan. Zero deviations in the main commit.

### Decisions outside the spec

- **Subscribed SelectionBox to `spatial` via a Zustand selector** (this WAS in
  the plan template — flagged here only because the rationale is non-obvious to
  future readers). Without the subscription, SelectionBox would not re-render
  when `updateTrackItemSpatial` mutates state, so the box would not visually
  follow the layer during drag. The subscription value isn't read directly — its
  only job is being listed in `useEffect`'s dependency array so the effect
  re-runs and re-queries `getBoundingClientRect`. The comment in the code calls
  this out.
- **`e.stopPropagation()` on pointerdown in SelectionBox body** prevents
  PlayerOverlay from also running its hit-test handler. The spec's risks table
  mentions a different mitigation strategy (pointerdown records intent,
  pointermove cancels, pointerup deselects only on no-move). The implementation
  uses `stopPropagation` + `setPointerCapture` instead — achieves the same
  outcome (no deselect during drag) with fewer states to track.

### Changes outside the spec

- **Follow-up commit `6b403a4`:** Made `coordinates.test.ts` environment-agnostic
  by replacing `document.createElement('div')` with a plain object that
  implements `getBoundingClientRect`. Reviewer noted the original test only
  passed because vitest runs from `frontend/` (with the jsdom environment). If
  the test ever ran from the repo root, it would fail with `ReferenceError:
  document is not defined`. The fix removes the DOM dependency entirely —
  `screenToComposition` only calls `.getBoundingClientRect()` on its argument,
  so a plain object with that method is sufficient.

### Tradeoffs

- **No `pointercancel` handler.** Drag state in `dragRef` leaks if the OS takes
  over a gesture (phone call interrupt on mobile, browser zoom on desktop).
  Reviewer flagged as Minor. Deferred to 2.3.b — the resize handle handlers will
  need the same treatment, so consolidating then makes sense.
- **No dead-zone for the `moved` flag.** A 1-pixel optical-mouse jitter would
  register as a drag, dispatching `updateTrackItemSpatial` and creating an undo
  entry for what felt like a click. Reviewer flagged as Minor. A 4-pixel
  dead-zone (`Math.abs(d) > 4`) would eliminate this. Deferred to 2.3.b.

### Deferred

- **Browser-resize / parent-layout-shift handling.** SelectionBox follows
  `spatial` changes (intentional layer motion) but doesn't re-query rect on
  window resize or parent layout reflow. T5's scope doesn't cover this; will
  matter if the editor view gets resizable panes.

---

## T6 — Properties Panel Transform section (commits `4349ee8`, `ff55ff3`)

### Decisions outside the spec

- None initially. The implementer followed the plan template verbatim.

### Changes outside the spec

- **Follow-up commit `ff55ff3`:** Removed the `remotion-properties-panel__transform-section`
  CSS class from the Transform `<section>`. The plan template added it, but there
  was zero corresponding CSS rule anywhere in `frontend/src/styles/`. Per the
  project's YAGNI principle ("don't add abstractions beyond what the task
  requires"), removed. Any future task needing Transform-specific styling can
  re-add it alongside the rule.

### Deferred

- **DRY refactor of three (soon nine) similar input rows.** Position X/Y/Z share
  structure; 2.3.b adds Scale X/Y/Z; 2.3.c adds Rotation X/Y/Z. Reviewer
  suggested extracting a `<SpatialAxisInput axis label value onPatch />` helper
  as the first commit of 2.3.b before adding Scale fields. Not done in 2.3.a —
  three copies of similar code is acceptable; nine copies would not be.
- **`data-spatial-axis` vs `aria-label` for test selectors.** Reviewer noted
  `aria-label="Position X"` is strictly better (accessibility + test discovery
  via `getByRole`). Kept the custom data attribute for parity with the spec
  template; consider switching when the DRY refactor lands.

---

## T7 — Puppeteer smoke Step 15 (commits `fabe792`, `87cffce`)

### Decisions outside the spec

- None. T7 was implemented verbatim and the smoke passed `[done] all 15 steps
  passed` on first run.

### Changes outside the spec

- **Follow-up commit `87cffce`:** Two minor hygiene additions per code reviewer:
  - 2-line comment before the `afterDrag.x <= textItem.beforeX` assertion
    documenting that `beforeX === 0` depends on the existing step ordering. If a
    future step inserts a mutation between Steps 13 and 15, the assertion needs
    re-reading.
  - Reset `selectedTrackItemId` to `null` after the screenshot, so any future
    Step 16+ doesn't inherit a stale SelectionBox in the DOM.

### Tradeoffs

- **`await sleep(300)` after `setSelectedTrackItem` and after `mouse.up`.** The
  300ms is consistent with the rest of the file but is conservative — React +
  Zustand state updates probably settle in under 50ms. Kept the longer sleep for
  test stability; could be tightened in a future pass.
- **Drag uses 2 intermediate moves (`+100`, `+200`) with `steps: 5` each = 10
  total pointermove events.** This is the spec template's choice. A single
  `mouse.move(+200, { steps: 10 })` would work equivalently because
  `setPointerCapture` ensures all pointermoves reach the SelectionBox handler.
  Two legs adds nothing over one, but the comment in the code accurately
  explains the intent.

### Deferred

- **No `y`-axis assertion.** For a purely horizontal drag, `afterDrag.y` should
  equal `beforeY` (or be within rounding tolerance). Asserting this would catch
  a regression where the drag handler incorrectly propagates `dyComp` when it
  should be zero. The current x-only assertion covers the primary feature claim.
  Reviewer flagged as Minor.

---

## Cross-task observations

### Cross-task consistency

- **Undo discipline.** Every mutation action in graphStore (updateTrackItemProps,
  updateTrackItemTime, updateTrackItemSpatial) uses `maybePushUndo(set, get,
  remotionNodeId)`. The 500ms debounce window means a drag gesture collapses to
  one undo entry. The new action follows the established pattern exactly.
- **Renderer attribute placement.** All 5 CSS-driven renderers carry
  `data-track-item-id` on EVERY `AbsoluteFill` return (happy + all empty-state
  branches). IsometricBlockRenderer is consistently excluded across T3 (no
  attribute), T4 (overlay won't hit-test it), and T6 (Properties Panel Transform
  still renders for IsoBlock since the panel is componentType-agnostic).
- **Pointer-events discipline.** SelectionBox outline is `pointer-events: none`
  (visual only); body is `pointer-events: auto` (drag target); PlayerOverlay is
  `pointer-events: auto` (click-to-select target). This layering means clicks on
  the box body get the drag handler, clicks elsewhere on the overlay get the
  hit-test, and clicks outside the overlay reach native page content.

### Reviewer feedback patterns

- Across all 7 tasks, code reviewers flagged ~12 items. 0 were Critical. 4 were
  Important (3 fixed in follow-up commits, 1 documented as deferred). 8 were
  Minor (0 fixed, all noted).
- The "Important" issues each took 1-2 commits to fix and never required
  re-architecting. Pattern: each was about test hygiene (isolation, environment
  portability) or removing speculative additions (orphan CSS class).

### Plan-template flaws caught during execution

1. **T2 debounce test reused nodeId 'r1'** — required parameterizing the seed
   helper.
2. **T4 SelectionBox `useEffect` without deps array** — would infinite-loop in
   production without the equality guard.
3. **T4 `tests/setup.ts` missing elementsFromPoint stub** — JSDOM doesn't
   implement it, so `vi.spyOn` throws.
4. **T5 coordinates test depended on JSDOM unnecessarily** — fixed by making the
   mock a plain object.
5. **T6 orphan `__transform-section` CSS class** — speculative class with no
   rule.

These were all caught by the code-quality reviewers, not the implementers'
self-review. Worth folding into future plan templates if Plan 2.3 generates them.

### Deferred to 2.3.b or later

Concise punch list for the next phase planner:

- LottieRenderer loading-state test (T3 gap)
- VideoRenderer happy-path test (T3 gap)
- SelectionBox pointercancel handler (T5 reviewer)
- SelectionBox dead-zone for the `moved` flag (T5 reviewer)
- Extract `<SpatialAxisInput axis label value onPatch />` before adding Scale
  fields (T6 reviewer)
- Consider switching `data-spatial-axis` selector to `aria-label` (T6 reviewer)
- Y-axis assertion in smoke Step 15 (T7 reviewer)
- Browser-resize handling for SelectionBox (T5 deferred)
- Comment / refactor manifest-reference-update invariant the T2 undo round-trip
  test silently depends on (T2 reviewer)

### Pre-existing items NOT touched

Per plan invariants, the following were not addressed despite reviewer
mentions:

- `CrabMark.tsx` inline-style lint warning (every reviewer flags it; pre-existing)
- WebSocket/undici unhandled error in `graphStore.trackItemCRUD.test.ts` (every
  reviewer notes the "1 error" count; pre-existing test-harness noise)
- WebGL context errors during Steps 10-15 of the smoke (expected in headless
  swiftshader mode)

---

## Pre-merge fix — Content bounding box (commit TBD)

### Bug

The SelectionBox outline covered the entire Player canvas instead of tracing the
layer's actual screen bounds. Root cause: `data-track-item-id` lives on the
`<AbsoluteFill>` root, which is always full-composition-size.
`getBoundingClientRect` on that element returns the full Player rect regardless
of the layer's `spatial.x/y` — the `translate3d` transform is applied to the
inner content element, not the `AbsoluteFill`.

### Fix — dual-attribute approach

Added a second attribute `data-track-item-content-id` on the inner content
element (the one that receives the `translate3d` transform) in each renderer's
happy path:

- **TextRenderer** — added directly to the inner `<div>` (already accepts HTML attrs)
- **SVGRenderer** — added directly to `<Img>` (Remotion's `Img` passes through HTML attrs)
- **ImageRenderer** — added directly to `<Img>`
- **VideoRenderer** — wrapped `<Video>` in `<div data-track-item-content-id>` because `@remotion/media`'s `Video` component destructures only its own props and does not forward arbitrary HTML attributes
- **LottieRenderer** — wrapped `<Lottie>` in `<div data-track-item-content-id>` for the same reason (`@remotion/lottie`'s `Lottie` destructures only `LottieProps`)

`SelectionBox.useEffect` now queries `data-track-item-content-id` first, falling
back to `data-track-item-id` when no content element is found. The fallback
exists for empty/loading states (e.g. `[no svg source]`, `[loading lottie…]`)
where only the `AbsoluteFill` root is rendered — those states have no content
element yet, so the full-canvas rect is the best available bound and is still
correct for triggering selection.

### Scope

`data-track-item-id` on `<AbsoluteFill>` is unchanged — `PlayerOverlay` still
uses it for `document.elementsFromPoint` hit-testing, which correctly targets the
full canvas overlay.

### Tests added

- `renderers.dataTrackItemId.test.tsx` — new `describe` block asserting
  `data-track-item-content-id` is present on TextRenderer, SVGRenderer (happy),
  and ImageRenderer (happy). Video/Lottie happy paths skipped (require media
  context; empty-state coverage is sufficient).
- `SelectionBox.test.tsx` — existing three `layerEl` setups now also set
  `data-track-item-content-id` so tests exercise the new code path. New
  `describe('SelectionBox — content-id fallback')` block verifies the `??`
  fallback: when only `data-track-item-id` is present (no content-id), the box
  still renders at the correct position.
