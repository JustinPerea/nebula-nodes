# fix/ratchet-followups-221: PR #221 review 2 follow-ups (test-only)

Branch from origin/main c892dca2 (the #221 merge). Test-only, apart from one
test-only export in graphStore.ts (`resetDeletedSceneEditsForTests`, which app
code never reaches). NIT-3 (shuffled order fails on base) is out of scope.

## LOW-1: deleteLandedRatchet names every way to race a delete's answer

The wait-before-Undo rule is inverted, as the review suggested. Before, it
listed forbidden waits (a bare `await sleep|wait|delay|pause(…)` or a
`new Promise(setTimeout)`). Now, in one block, a delete, then **any** wait,
then an Undo, with no landing between them, is named.

- **Delete:** deleteNode, deleteNodes or deleteSelected, or the Delete or
  Backspace key (`{ key: 'Delete' }` in fireEvent, `{Delete}` in user-event's
  keyboard).
- **Undo:** `.undo()`, Cmd or Ctrl+Z (fireEvent `{ key: 'z', metaKey | ctrlKey }`,
  user-event `{Meta>}z`), or a click on an Undo button (a "Undo" string,
  `/undo/i`, or an `undo…` variable).
- **Wait:** any await, or a fake-timer advance (`advanceTimersByTime`,
  `runAllTimers` and the rest, awaited or not).
- **Landing:** an awaited deleteLanded; an awaited waitFor or waitUntil whose
  callback expects "Deleted the node." (a matcher's value not under `.not`,
  or one side of `===`); or an awaited findBy… of it. The notice text
  anywhere else is no longer a landing. That was the review's
  `.not.toBe('Deleted the node.')` plant.
- **Order** is decided by source position, not by statement, so
  `await act(async () => { deleteNode(); await sleep(300); })` then Undo is
  named, and so is a sleep and an Undo inside one act(). The scan skips
  functions under the block that it doesn't run in place: a test's body, or
  an `it.each` row's arrow. act() callbacks are read in place. Without that,
  a describe body read a delete in one test and an Undo in a later test as
  one sequence (graphStore.fix4).
- **Flag rule:** it now also reads `waitUntil`. There, `!x.deleted` and
  `=== false` wait for false. It also reads `{ deleted: true }` in the
  callback (toMatchObject, objectContaining).
- **New opt-out** `delete-landed-wait: off, <reason>` waives only the wait
  rule, and the flag rule still applies. It is used by 8 files whose fake
  answers each DELETE at once, or only when the test calls `answer()` by
  hand: heldUndo.round12 (Bound), 13, 14, 15, 16, lateRestoreCount,
  noticeFollowsStacks and undoRestoresDeletes. Their wait is `settle()`, a
  fixed count of timer turns. The review's (f) scan found that no wall-clock
  deadline decides these answers, so a runner stall can't move them. The
  inverted rule names 99 sites in those files. Converting them would change
  what the held-Undo tests test (most press Undo during the hold on purpose).
- **Still a documented gap:** a delete, wait or Undo inside a helper function
  the test calls. The deleteAndWait helpers now call deleteLanded themselves
  (LOW-3).

Proof: 9 temp files under tests/zzplant/, one per review (d) form:

- act-wrapped sleep;
- waitFor on the node count;
- waitUntil on the flag;
- `toMatchObject({ deleted: true })`;
- `.not.toBe` notice;
- Delete key with a sleep then Cmd+Z;
- `advanceTimersByTimeAsync`;
- user-event Delete with a sleep then an Undo-button click;
- act with a setTimeout then Ctrl+Z.

All 9 are named by the repo scan at head. The base ratchet (origin/main)
names none of them. The plants are deleted. The real repo scan passes. The
fixtures went from 31 to 70 cases.

## LOW-2: regionNoticesReadyRatchet matches mounts by local binding

`moduleUse` (tests/helpers/ratchetSource.ts) now records a default import as
the binding `default`. It also returns `localsOf(exports)` and the module's
namespace bindings. The region ratchet matches a JSX or createElement tag in
four ways:

- by any local name bound to a mount export (an alias, a default import
  under any name, or a destructure-rename from `await import`, `default`
  included);
- by the export's own name;
- as `<N.NoticeRegion/>` or `<M.default/>` on a namespace binding (`import * as`,
  `const M = await import(…)`, vi.importActual);
- through test helpers that re-export a mount. Any non-test module under
  tests/ counts: `export { … } from`, `export *`, `export * as M`, or an
  import exported again, followed through chains of helpers.

The prefilter now also accepts a template-literal App import and a
re-exporting helper's file name.

Proof: 6 temp plants. Five are review (d)'s: the renamed named import, the
renamed default import, `<M.default/>`, `<N.NoticeRegion/>` and the
destructure-rename. The sixth is a helper re-export,
`export { NoticeRegion as Harnessed }`. All 6 are named at head, and the
base ratchet names none. The file's tests went from 34 to 54.

## LOW-3: deleteAndWait helpers

In graphStore.fix21stops, fix22 and fix22b, the helpers now call
`await deleteLanded(useGraphStore)`. After that they keep the toast-text
wait and the `sleep(20)`. The #221 note's sentence that claimed this already
happened is corrected.

## NIT-1: resetDeletedSceneEditsForTests

The reset now also clears three more things:

- `landingsOut`: a person's save still out names a node and carries an
  `apply` that an agent clear's Undo and the reconnect copy would put on the
  next test's node of the same id;
- runs (`forgetRunsOfReplacedGraph`: the current run and other tabs' node
  marks);
- `forgetPersonPlaced()`.

These are all node-keyed, and a canvas replacement drops each of them. The
doc now names what is still not cleared: the write queue, the replacement
report and the steps in flight, all canvas-wide. Every test file that calls
the reset is in the gate run below.

## NIT-4

- region: `beforeAll(() => { return regionNoticesReady(); })` (and
  `return await …`) now pass. A block that returns the preload (the
  component) is still named, because vitest would call it as teardown.
  Before, any awaited preload in a block passed.
- sceneEdits: `afterEach(reset)` registered inside a beforeAll is **not** a
  false fail. A probe test on vitest 4.1.11
  (`beforeAll(() => { afterEach(() => { ran += 1 }) })`, then two tests)
  saw the hook run 0 times. The rule stays, with that reason in its comment
  and a pinned caught case.

## Mutations (each reverted)

| Mutation | Fixtures failing |
|---|---|
| deleteLanded: the notice string anywhere is a landing | 3 |
| deleteLanded: functions under a block not skipped | 2, plus the repo scan |
| deleteLanded: waits only sleep/wait (old list) | 5 |
| region: local bindings ignored | 5 |
| region: namespace tags ignored | 6 |
| region: re-exporting helpers ignored | 5 |
| region: a block `return` of the helper not accepted | 2 |
