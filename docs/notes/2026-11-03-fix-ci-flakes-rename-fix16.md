# fix/ci-flakes-rename-fix16

Two frontend test flakes. Both were test races, not product races. Behaviour
is unchanged: the only product edit is a tests-only reset hook in graphStore
(see "The leak, closed").

## 1. pr198Fix23Ui "a rename during a try"

Failed once in CI on PR #216 at 2e5dbf93 (run 41584394316, attempt 1). The test
expected the stop line to read "Renamed" and got "Opening".

### Cause

`NoticeRegion` mounts `RegionNotices`, which is a deferred chunk
(`lib/deferredChunks.ts` `DeferredRegionNotices`, through `deferredAtOnce`). The
test rendered the region before the chunk had loaded, so this is what happened:

1. `render()` suspends inside act(). The import resolves later, and React
   renders the retry on its own scheduler, outside act(). RTL's `waitFor` also
   turns the act environment off while it waits.
2. `findByText(SHOT2('Opening'))` sees that commit's DOM and resolves. RTL
   then drains with a single `setTimeout(0)`.
3. The commit's passive effects are still queued on the scheduler (in Node
   that means `setImmediate`, run in 5 ms slices). Those effects include every
   zustand hook's `useSyncExternalStore` subscription in `SceneStopLines`.
4. The test then calls `act(() => setState(...))` twice and reads the DOM
   synchronously (`tests/pr198Fix23Ui.test.tsx:67-70` before the fix). No
   component has subscribed yet, so nothing re-renders and the line still says
   "Opening", with an enabled "Try again".

On a busy runner the scheduler's tasks fall behind RTL's `setTimeout(0)`.
Locally they usually win, which is why the file passed 3/3.

The product is not affected. When the subscription effect runs, it checks the
store again and re-renders with the current name. The test just asserted
before React had finished mounting.

### Repro

I made a copy of the file that delays React's scheduler with
`vi.hoisted(() => { globalThis.setImmediate = (fn, ...a) => setTimeout(() => realSetImmediate(fn, ...a), 20) })`:

- Before the fix: 3 of 3 runs failed, with the exact CI message ("Opening" plus
  "Try again").
- After the fix, with the same stall: 3 of 3 runs passed (5 of 5 in an
  earlier run).

### Fix

`tests/helpers/regionNoticesReady.ts` preloads the chunk. Each file calls it
with `beforeAll(regionNoticesReady)`. Once the chunk is in, `lazyWithPreload`
hands React the module synchronously, so `render()` commits the notices and
runs their effects inside act().

Watch out for `beforeAll(() => DeferredRegionNotices.preload())`. It returns
the component, and vitest calls a returned function as teardown. That fails the
suite with "Cannot destructure property 'canvas'". Always await the preload;
never return it.

### Same class elsewhere

Twelve test files render `<NoticeRegion>` and none of them preloaded the
chunk. All of them now do: pr198Fix19/20/21/22/22Focus/23Ui,
noticeRegionStack, lateRestoreCount, noticeMessageBesideUndo.round8,
agentPresenceFollowups.r27/r29, and
src/components/moodboard-studio/MoodboardStudioBoard.test.tsx. That last one
calls `DeferredRegionNotices.preload` inline, because tsc's app project
includes `src/` and shouldn't pull in `tests/`.

### Ratchet

`tests/regionNoticesReadyRatchet.test.ts` scans `tests/` and `src/`. Any test
file that renders `<NoticeRegion` must call `beforeAll(regionNoticesReady)` or
the inline awaited preload. The ratchet also checks its own detector, including
the returned-preload teardown trap.

Mutation check: I deleted `beforeAll(regionNoticesReady);` from
pr198Fix23Ui.test.tsx. The ratchet failed and named that file. Then I restored
the line.

## 2. graphStore.fix16: "nothing unsaved…" and "400: the clash prompt…"

Both failed after about 3 s on PR #204 at ed15f0d6 (run 41591009433, attempt
1).

### Cause

In "nothing unsaved", the test deleted the node and then waited for
`h.state.deleted` to be true before pressing Undo
(`tests/store/graphStore.fix16.test.ts:383` before the fix). The fake backend
sets that flag when the DELETE arrives (`withRestore`, the
`DELETE /api/graph/node/n1` branch). It answers about 2 ms later, after
`emit` and `sleep(2)`. So the flag is no sign that the delete landed.

While a delete is in flight, the product drops an Undo by design. GM r18
option (c) says: "Nothing was undone. Your last change was still saving."
(`stepHistory`, `pressHitsDeleteInFlight`, `src/store/graphStore.ts:8983`.)
The delete only stops being in flight in `applyDeleteAnswers` then
`settleStep`, after the answer. If the test's 5 ms poll landed in that gap, the
Undo was dropped, no restore was sent, and `deleted === false` never came, so
the test timed out at 3 s.

The 400 test failed as a knock-on. The neighbouring tests "values the same once
it is back" and "a restore from another window" restore while the delete is in
flight. When they lose the race, the scene's unsaved edits stay in the
module-level `deletedSceneEdits` (keyed `n1`, same canvas revision). The next
test's `backend()` emits `n1`, `restoreDeletedScenes` merges the leaked
`s2: mine on s2` into it, and that save takes the 400 refusal the test had
queued. A debug dump of the failing 400 test showed exactly that put:
`["s1:codex s1","s2:mine on s2","s3:c"]`, status 400. The test's own s3 save
never saw a 400.

Running only "values the same", "nothing unsaved" and the two 400/413 tests,
with the stall, reproduces CI's exact pair: "nothing unsaved" and "400" fail.

### Repro

I made a copy whose DELETE answer waits 30 ms instead of 2 ms:

- Before the fix: 3 of 3 runs had 4 failures. They were CI's two tests plus
  "own delete with a clash waiting, then Undo" and "a restore from another
  window", which have the same race.
- After the fix: 3 of 3 runs passed with the 30 ms stall, and 1 of 1 passed
  with a 300 ms stall.

### Fix

`tests/helpers/deleteLanded.ts` waits for the product's own sign that the
delete landed. That sign is the delete's notice (`offer: 'undo'`, `entry` = the
top of the undo stack). It is set in the same synchronous call that ends the
in-flight hold. The flag is still asserted afterwards.

The helper is now used at all four sites in fix16, and at the identical sites
in fix17 ("the person's own delete and Undo") and fix18 ("asked again (the
person's delete and Undo)"). It is also used in fix25 ("a retrying scene
deleted and put back by Undo"). That test waited on the flag and then slept a
fixed 100 ms, which was enough margin until the answer took longer.

With a 150 ms DELETE stall, the before copies of fix17, fix18 and fix25 failed
one test each, and the after copies passed 36/36.

### Ratchet

`tests/deleteLandedRatchet.test.ts`: no test file may `waitFor` a `.deleted`
flag turning true. It checks its own detector too.

Mutation check: I put the old flag wait back into fix16's "nothing unsaved".
The ratchet failed and named `tests/store/graphStore.fix16.test.ts`. Then I
restored the file.

### The leak, closed (coordinator follow-up)

`deletedSceneEdits` survived between tests: the tests reuse id `n1` on one
canvas revision, and `clearCinemaScenePersistence` leaves that map alone. (In
the product, a canvas replacement bumps `canvasReplacementRevision`, which
retires it.) So a test that ends with a deleted scene's edits kept aside hands
them to the next test's `n1`.

The one product change, a test hook: `resetDeletedSceneEditsForTests()` in
`src/store/graphStore.ts`, next to the map. It clears:

- `deletedSceneEdits`;
- the per-node siblings that a canvas replacement clears outside the scene's
  own persistence: `heldCopies`, `deferredParamPushes`, the parked param saves
  (`takeParkedParamSaves`), and `clearAllParamPushTimers` (unsaved param edits
  and the backend scenes they are read against).

Every test file that deletes scene nodes calls it in `afterEach`. That is
fix3, fix4, fix12 to fix25, fix21stops, fix22b and fix24b.

**Proof.** fix16 now ends with a describe that runs in a fixed order
(`shuffle: false`):

- **A** leaves an unsaved `s2: left by A` kept for a deleted `n1`.
- **B** builds a fresh `n1` and expects no PUT and the scene exactly as the
  backend sent it.

With the hook in place, both pass. With the `afterEach` removed, B fails 3/3.
With only `deletedSceneEdits.clear()` dropped from the hook, B fails and shows
the leak itself: `expected ['s1:a','s2:left by A','s3:c'] to deeply equal
['s1:a','s2:b','s3:c']`.

**Ratchet.** `tests/sceneEditsResetRatchet.test.ts` covers any test file that
uses `'cinema-scene'` and deletes nodes. A file counts as deleting if it calls
`deleteNode(s)(`, sets `.deleted = true`, or has `deleted: true`. Each such
file must call `resetDeletedSceneEditsForTests()` in `afterEach`, and the
ratchet checks its own detector. Mutation check: removing the line from fix21
made the ratchet fail and name that file.

**A test the reset exposed.** In fix17, "a line about another node stays
beside the prompt" had passed only on the leak:

- Its own setup (`clashOnS1`) never made a clash. Its typing found no `n1` on
  the canvas, so no save went out. The clash it saw was the one the previous
  test's Redo had kept aside.
- `n1` was missing because the previous test, "the person's own delete and
  Undo … Redo", ended when the card left. That happens on the press, before
  the Redo's restore is even sent.
- The restore's hold on `n1` then ran into the next test and kept that test's
  synced `n1` off the canvas.

With the reset, this failed 4/4. A debug dump at failure showed no fetch calls
at all, and `n1` came back only with Codex's later sync.

The fix: the Redo test now ends once its restore has been sent (`remove`
names `n1`) and answered. fix17's fetch counts requests not yet answered,
then waits one macrotask so the store takes the answer. fix17 then passed
8/8 in a row.

A first try that waited for the backend to be idle in every `afterEach`
instead made another fix17 test flaky ("Codex's edit about the stopped scene
alone", 5 of 8). I dropped it for the targeted wait.

## Load and order runs

I ran pr198Fix23Ui, graphStore.fix16, MoodboardStudioBoard, noticeRegionStack
and lateRestoreCount 4 times with `--maxWorkers=2 --sequence.shuffle`. At the
same time, a parallel vitest was running graphStore.fix14/19/20/21/22,
undoRestoresDeletes and heldUndo.round13. All passed (71/71 each time).

After the follow-up I ran all 35 changed test files plus the four ratchets:
383/383 passed. fix16, fix17, fix18, fix19, fix24, fix25 and pr198Fix23Ui
then passed 3 more rounds (90/90 each) with `--sequence.shuffle.files`, while
a parallel vitest of fix14, fix9, undoRestoresDeletes and heldUndo.round13
loaded the CPU. Test order inside files isn't shuffled, because fix16's A/B
pair depends on its order.

`npx tsc -b --noEmit` is clean, and eslint is clean on every changed file,
graphStore.ts included.
