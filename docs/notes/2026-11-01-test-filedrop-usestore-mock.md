# test/filedrop-usestore-mock (2026-11-01)

## What was wrong

`frontend/tests/Canvas.fileDrop.test.tsx` mocked `@xyflow/react` with
`useStore: () => 1`. Real components call `useStore(selector)` and use the
answer as what the selector returns. `AgentNodeMarkLayer` builds a string key
and calls `key.split(';')`, so as soon as its deferred chunk landed during a
test it threw `TypeError: key.split is not a function`. React logged the error,
and `DeferredBoundary` logged "A deferred part of the app failed while
drawing", under whichever test was running. The tests still passed. In the
main CI run for 529665e (Frontend tests, part 2 of 3) that was 60 log lines:
19 file-drop tests and 1 `Canvas.focus` test, 3 lines each.

The same constant mock was in four other tests that render the real `Canvas`:
`Canvas.focus`, `Canvas.continuity`, `canvasRunLockDelete` and
`selectionToolbarTopLine`. `GraphFileActions` and
`GraphFileActions.displayUrls` also mock `useStore` with a constant, but the
one component they render reads a transform and gets one, so they stay as they
were.

## Decisions

- **A fake store, not the real one with a provider.** `tests/helpers/fakeFlowStore.ts`
  keeps one small state (an empty 1280x800 flow at zoom 1: `width`, `height`,
  `transform`, `minZoom`, `maxZoom`, `nodes`, `edges`, the lookups, the
  selection flags). `useStore(selector)` runs the selector against it, and
  `useStoreApi()` returns the same state (`getState`, `setState`). The tests
  mock `ReactFlow` itself, so nothing would fill a real provider's store; a
  fake one keeps the fields these tests used to give `useStoreApi` and stays
  as small as the mock it replaces.
- **Preload the store-reading layers** (`preloadFlowLayers`: the agent mark
  layer and the agent-note outline layer) in `beforeAll`, as App does on idle.
  Before, whether the layer drew depended on when its chunk landed. That is
  why CI logged the error and a local run often didn't: locally the chunk
  usually arrived during the portrait-photo test, while that test's `URL` stub
  stood in for the constructor, so Vite's module loader failed instead ("URL
  is not a constructor", 42 lines) and the layer never drew. Now the layers
  draw in every test against the fake store, so a broken mock fails the same
  way on every run.
- **The roster read never answers in these tests.** Once the mark layer gets
  past render, it reads `/api/canvas/agents` on mount, and the roster store
  reads it again on a graph replacement over the socket. `tests/setup.ts`
  fails a test that sends an unmocked local request, so with the store fix
  alone these tests would have failed whenever the chunk landed mid-test. A
  resolved mock instead updated the layer after the test ("not wrapped in
  act", 31 warnings in `Canvas.continuity`), and mocking `refreshAgentRoster`
  missed the store's own internal call. `fetchAgentRoster` now returns a
  promise that never settles: no request goes out, the roster stays empty and
  nothing updates later. In the file-drop test, `api.fetch` still sees only
  what a drop sends, so the undo test's call counting is unchanged.
- **The portrait-photo test's `URL` stub stays a constructor** (a subclass
  with static `createObjectURL` / `revokeObjectURL`), so module loading during
  that test can't fail.
- No assertion was removed or changed.

## Counts (file-drop test, `--maxWorkers=2`)

Vitest 4's default reporter in an agent session shows no console output, so the
plain command printed 0 lines both before and after; the counts below are with
`--reporter=verbose`.

| run | key.split lines | "URL is not a constructor" lines | stderr blocks |
| --- | --- | --- | --- |
| main | 0 | 42 | 18 |
| main + layers preloaded (CI's timing, on demand) | 72 | 0 | 28 |
| this branch (3 runs) | 0 | 0 | 4 |

The 4 blocks left are `[nebula] Couldn't upload "…". HTTP 503`, the
`console.warn` that `graphStore` writes for each error notice, in the tests that
make an upload fail on purpose.

The other four files: no `key.split` and nothing new on stderr. `Canvas.continuity`
and `canvasRunLockDelete` keep the one "A suspended resource finished loading …
not wrapped in act" warning they already had on main, which comes from another
deferred chunk and is not touched here.
