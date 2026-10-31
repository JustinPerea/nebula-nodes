# fix/lock-lines-held-undo (follow-up to PR #198)

Base: main at 38bb573a (the #198 merge). Scope: GM's pr198 r39 (items 1 to 3)
and r40 (items 1 to 3), and review 24's NIT-1 and NIT-2.

## 1. Selected controls out of the disabled rule (GM r39 item 1)

- **The checked Settings switch.** `styles/disabled-buttons.css` no longer has
  a `:checked` rule. A checked, enabled switch keeps settings.css's on look
  (the accent track, the white thumb) and never meets a disabled token.
  - A switch that is actually locked (disabled: Settings while it saves, a
    personal agent's switch while busy) takes one disabled look whether it
    is on or off: the `--sr-disabled-fill` track, the thumb in
    `--disabled-label`, no shadow, `opacity: 1` (settings.css's 0.48 dimming
    is dropped, as the shared rule drops each style's own). The thumb keeps
    its place, so on and off still read apart. "Never orange but disabled"
    (review 2 L-4) still holds.
- **The chosen Remotion anchor cell.** The `[data-active='true']` disabled
  rule is gone. Enabled, the chosen cell keeps remotion-editor.css's filled
  accent. Locked (the canvas lock's fieldset), it takes the cell's own
  disabled look, the same as every other locked cell: transparent, the
  disabled edge.
- Their enabled look is unchanged, for GM's pressed-state sweep.
- **Every other selected state that uses a disabled token** (a sweep of all
  CSS for aria-pressed, aria-checked, aria-selected, aria-current,
  `:checked`, `--active`, `--selected`, `--chosen`, `--on`, `[data-active]`,
  `[data-selected]`, against `--disabled-fill`, `--disabled-label`,
  `--disabled-fill-label`, `--sr-disabled-ink`, `--sr-disabled-fill`,
  `--sr-disabled-edge` and the 0.42/0.55/0.62 values):
  - `:is(.cinema-shot-panel__variation--active):is(:disabled, …)`,
    `:is(.cinema-shared-controls__chip--active):is(:disabled, …)` and
    `:is(.project-home__cover-choice[aria-pressed='true']):is(:disabled, …)`.
    All three already require the locked state (GM's own rule for
    image-only buttons and the film-look chip: the selected one keeps its
    outline in the shared grey while locked). Left as they are, pinned in a
    test, and listed for GM (question 1).
  - `.workspace-rail__item--active` uses `rgba(255, 255, 255, 0.1)` (and the
    slava rule `--sr-surface-control-active` with that fallback). That is the
    app's common active surface, not a disabled token, so the ratchet reads
    0.1 only through `--sr-disabled-fill`'s name. Not changed.
  - Nothing else found.
- **The ratchet** (`tests/selectedNotDisabled.r39.test.tsx`): any rule in any
  sheet whose selector names a selected state and whose body uses a disabled
  token or value must also require a locked state (`:disabled`,
  `[disabled]`, aria-disabled, the lock marks, the held look). A second test
  pins the three locked selected marks above, so the switch or the anchor
  can't come back as one.
- Tests that changed because the rule changed: agentPresenceFollowups.r2
  (no `:checked` rule; the locked switch's own rule), the ratchet's
  `NO_LABEL` entry for the anchor (no selected mark).

## 2. Run-lock lines (GM r39 item 2, r40 item 3)

- **One table, one helper** (`lib/runLock.ts`): `RUN_LOCK_VERBS` and
  `runFinishesLine(verb)` ("You can <verb> when the run finishes.").
  `runFinishesLine` moved here from useBackendOffline.
- **canvasLock has no default run line.** `RunLock` is now
  `{ run?: undefined } | { run: boolean; runTitle: string }`, so TypeScript
  refuses a run lock without its own line; `RUN_LOCK_REASON` is gone. tsc
  named every site that relied on the default; each now names its verb.
- **The lines, per control:**

  | Control | Line |
  |---|---|
  | Context menu: Run This Node, Duplicate, Delete | "You can run it / duplicate it / delete it when the run finishes." |
  | Inspector: Run, Duplicate, Delete | the same |
  | Selection toolbar: Run, Duplicate, Delete | "… it …" for one node, "… them …" for several |
  | Selection toolbar: Arrange (needs two) | "You can arrange them when the run finishes." |
  | Cinema's toolbar Generate (Generate all) | "You can generate this shot when the run finishes." |
  | A model node's next step | "You can run it when the run finishes." |
  | "Rerun with latest source" on a model node | "You can rerun it when the run finishes." (Run history's verb) |
  | Run history's Forget | "You can forget this run when the run finishes." |
  | Run history's Clear | "You can clear the run history when the run finishes." |
  | Canvas actions: Arrange nodes | "You can arrange the canvas when the run finishes." |
  | Canvas actions: Load / Import / Clear | "You can load a canvas / import a canvas / clear the canvas when the run finishes." |
  | Canvas actions: Save | "You can save the canvas when the run finishes." |
  | Canvas actions panel's line over the Graph group | "You can save, load, import or clear the canvas when the run finishes." |
  | The Delete key, Cmd+Z, Cmd+Shift+Z while this tab runs | "Couldn’t delete “X”. You can delete it when the run finishes." ("them" for several), "Couldn’t undo. You can undo when the run finishes.", "Couldn’t redo. …", "Couldn’t delete the connection. You can delete it …" |
  | Adding a connected node while a run goes | "You can add it when the run finishes." after "Couldn’t add …" (see section 3's merge) |

  The first five rows' verbs and Cinema's, the next step's, Forget's,
  Auto-layout's, Load's, Import's and Clear's are GM's. The rest are on GM's
  pattern, for GM (question 2).
- **Found and left (not this tab's run lock):** Cinema's shot panel
  "Another run is using shared inputs. Wait for it to finish or stop it."
  (an overlapping run's admission, not this tab's run), the import and
  preparation locks ("Wait for the graph import to finish.", "Wait for
  generation preparation to finish."), Cinema's shot lines ("Wait for “Shot
  2” to finish.", "Wait for the running shots to finish.", GM r3/r4), Commons'
  "Wait for the grade in progress to finish.", and
  `deleteProviderRecovery`'s "Let the run finish, then try again." (a thrown
  refusal under its heading).
- **Agent-facing refusals:** the backend's "Cannot clear the canvas while a
  run is active. Wait for the run to finish or stop it first." (and switch
  projects, delete the open project; main.py `_removal_person_line` /
  16774) are agent text in MCP-SETUP.md's table; none reuses the person
  string. Unchanged.
- **The deferred run notice** (`DeferredRunNotice`): a state line, read live
  (`deferredRunLine`). It names the held nodes that are still on the canvas
  by their card titles, in canvas order, through `nodeNameList`; "it" when
  none has a name (all deleted meanwhile).
  - While a run goes (or is starting): "You can run “X” when the current run
    finishes." [Run] is disabled with that same line as its tooltip;
    [Dismiss] stays enabled.
  - When the run finishes, the same element's line swaps to "You can run
    “X” now." and [Run] enables. No toast, no timer.
  - A canvas replace clears it as before (canvasProposalsStore, unchanged).
  - The names come from a selector that joins the card titles into one
    string, so an unrelated canvas change doesn't re-render the notice.
- **Tests** (`tests/runLockLines.r39.test.tsx`, 17): the table, canvasLock's
  missing default (and a source check), each surface rendered (context
  menu, selection toolbar one and several, the Canvas actions panel with
  Save and its line, Run history's Forget and Clear, Cinema's Generate, a
  model node's next step), the refusals, a source scan (no old line in
  code; every `.act(` / `lockedAction(` call with `run:` carries
  `runTitle`), and the deferred notice: the lines, the live swap in place
  with no toast, a starting run, a rename while it waits, several names, a
  deletion down to "it", Dismiss while the run goes, and the add-a-node
  refusal. Updated for the new words: ProposalBar, noticeRegion,
  noticeRegionStack (the deferred line), pr198Fix5CopyUi, pr198Fix6Ui, pr198Fix7Ui, Toolbar.execution,
  components/Toolbar, RunHistoryPanel, canvasRunLockDelete,
  graphStore.fix4/5/6, errorCopy.namedLine (its reviewed hand-built lines).
- **Docs:** MCP-SETUP.md's paragraph on a run's lock quotes the new lines.

## 3. Undo held on a Delete (GM r39 item 3, r40 items 1–2)

- **The r18 refusal is gone.** `stepHistory`'s `pressHitsDeleteInFlight`
  early return (5f33e484, GM r18 option (c)) is removed. An Undo pressed
  while its Delete is on its way is held like any other press
  (`HeldPress.onDelete`), with nothing said. When the Delete answers it
  restores, with the usual "Restored the node." (GM r40 item 1). The node
  still leaves the canvas at once and a failed Delete still brings it back
  unselected (r18's other rulings stand).
- **Delete refused:** the node comes back with the Delete's own failure line;
  the held press is dropped with no "Nothing was undone" and no skipped
  count (`runHeldPresses`' taken-off branch skips `skipPress` for an
  `onDelete` press). The presses after it still count.
- **Restore refused or failed** (a refusal, or its own 15 s timeout):
  "Nebula couldn’t bring back “X”. Try Undo again." (`bringBackFailedText`,
  lib/deleteNotice). X is read from the cards when the answer arrives
  (`namesBroughtBack`: the card title on the canvas, the step's copy for a
  node off it), by the shared name-list rule for several nodes ("“Brief”
  and “Note”", from 4 "4 nodes"). This replaces "Couldn't undo that." and
  the timeout line only for a press held on a Delete
  (`applyHistory(..., { heldOnDelete })` → `sendRestore`'s `heldLine`).
- **No Delete answer within 15 s (`HOLD_LIMIT_MS`, `giveUpHeld`):** the same
  line, read live (GM r40 item 2, option c). The press is dropped, so a late
  Delete answer is an ordinary step and never restores by itself; the next
  Undo press does.
- **Two presses on two deletes (`undoneLater`):** a press may apply beneath
  a settled step that a later held press of the same batch undoes. Delete
  n1, Cmd+Z, delete n3, Cmd+Z, with n3 answering first, now undoes both (as
  before r18); without it both presses were dropped.
- **Unchanged, and a difference from the pre-5f33e484 tests:** since r18 the
  delete's step is placed at the press of Delete, so a step that settles
  above it while the Delete is on its way (an agent's edit, the person's
  typing) is the newer edit, and review 11 M-1's rule drops the bound press
  with "Nothing was undone. Your last change was still saving." when the
  answer lands. Before r18 the delete's step re-pushed above it and the
  press restored the node. Those tests (round12 H1, H5; round13 P11, P14,
  P15, P16, the three-press test, H1 (L-5), P16 echo-first; round14's cases
  2b, 7, 8, 9, 11 and 12; round15 M5 and the typing-between test; round16 P7) pin
  the drop. For GM (question 4).
- Two other restored tests differ from their old text: E2's restore carries
  n1 as it was deleted (the later typing happened while it was off the
  canvas), and P14's agent load drops the held press with the dropped line
  and no Codex notice (the node had already left at Delete, so the load
  changed nothing on the canvas).
- **Tests.** The 65 tests in the 7 files #195 rewrote are restored to the
  held behaviour: canvasDeleteInFlightUndo.round11 (11), heldUndoBound.round12
  (11; H10–H12 now read the 15 s line), heldUndo.round13 (21), round14 (12),
  round15 (6), round16 (3; the control for round 14's case 10 is silent now), round18 (1,
  adapted: no pre version). New `tests/heldUndoOnDelete.r39.test.tsx` (12):
  the main path for a Text node and for a Cinema scene (silent wait, one
  restore POST, "Restored the node."); a refused Delete, one node and two;
  two deletes, two presses, the second Delete refused (the first restores,
  the second is silent); a refused restore with the live name; a rename
  while the restore POST is out (the line uses the new title); two and four
  nodes; a restore with no answer in 15 s; the Delete's 15 s give-up, then
  the late answer (no restore, no POST), then the next press (restores); the
  scene's give-up names the scene.
- **Not covered:** the give-up line names the front press's nodes only;
  presses queued behind it are dropped without a count. A restore that
  errors with no answer at all (not the 15 s timeout) still counts as done,
  as before.

## 4. Review 24 NITs

- **NIT-1** (pr198Fix25Held's first test, flaky under load). The 150 ms are
  now measured from the press, stamped synchronously just before the click
  (`pressAt`), never from the MutationObserver's "held" stamp, which is a
  microtask after act() has started the hook's timer. The timer starts
  after the press, so `grey.at - pressAt >= 149` holds under any load; a
  late stamp only lengthens the gap. The events' order is asserted too
  (held before grey). The second test measures the same way, and its "no
  grey" branch now reads the release by the order of events: released
  before 150 ms from the press means the timer was cleared, so no grey.
  - 50 consecutive passes of the file while a second vitest
    (heldUndo.property.round17, the ratchet and graphStore.fix25,
    `--maxWorkers 4`) ran in a loop beside it: 50/50.
- **NIT-2** (the `!important` ratchet's gaps). The check is now one
  function (`importantPaintOnLocked`), used on every sheet and on the
  reviewer's crafted cases:
  - PAINT: `background` and every longhand (`background-image` included),
    `color`, `border` and every longhand (the shorthand included),
    `outline` and its longhands, `box-shadow`, `opacity`.
  - LOCKED: `[disabled]` added.
  - A locked compound anywhere in the selector counts (a label or an icon
    inside a locked button), not only the subject.
  - The crafted test: the reviewer's eleven cases (plus an `:is()` with a
    child combinator) are caught; `:not(:disabled):hover` and an uncovered
    class are not.
  - On main it catches nothing new: the only lock-gated `!important` paint
    outside the shared file is Cinema's text-field rule (textarea, select,
    inputs; not buttons).

## Proof

- **New tests on 38bb573a** (the new files copied into a base worktree,
  `runLock.ts` with them): `selectedNotDisabled.r39` fails 4 of 7,
  `runLockLines.r39` 13 of 16 (the add-node test was added after),
  `heldUndoOnDelete.r39` 12 of 12, and the restored held-undo files 64 of
  146. The ratchet's crafted cases pass on the base (the check lives in the
  test); mutation is their proof.
- **Mutations:** 27 for sections 1, 2 and 4, all killed (each run against
  the seven files that hold their tests); 9 for section 3, all killed.
  - Section 1, CSS: a `:checked`-only switch rule, the dimmed switch, the
    kept thumb, a chosen-anchor rule.
  - Section 1, the ratchet: a selected state using a disabled token, and
    one using a disabled value.
  - Section 2, the lines: canvasLock's default restored, a wrong verb on
    each surface, "it" for several, the old panel and Clear lines, the
    deferred line's fixed tooltip, a starting run ignored, never "now",
    names fixed at Accept, no "it" fallback, the old refusals.
  - Section 4: the old PAINT list, no `[disabled]`, the subject only.
- **Gates:**
  - `tsc -b` and lint: clean.
  - Full vitest: 8,565 passed and 3 failed of 8,568. Two of the failures
    were the deferred notice's old copy in ProposalBar and noticeRegion
    (plus a graphStore mock without `nodeCardTitle`). Those are fixed, and
    the four files now pass, 69/69, noticeRegionStack included. The third
    was MoodboardStudioView's "Undo on a kept color", a 5 s timeout under
    load in a file this branch doesn't touch; it passes alone.
  - vite build and `check-build-budget.mjs`: 444,626 bytes raw and 136,507
    gzip, +381 and +86 over the base (444,245 / 136,421).
  - Full backend, isolated: 12,236 passed, 71 skipped and 1 deselected
    (`test_chat_personal_ws.py::test_session_reused_then_closed_by_the_person`,
    which passes alone), rc 0.
- **Live** (fake backend on 8797, Vite 5797 with
  `VITE_NEBULA_BACKEND_PORT`, 8000–8010 and 5173 blocked, canary to 8001
  refused, 0 attempts): 14/14 in the final run. One earlier run failed
  "refused" once (the bring-back line came before the delete's failure
  line). It passed in each of 4 reruns since; the cause is not confirmed,
  but the 15 s timer under load is the likely one.
- **Shots** (1440 wide, no duplicate md5): in the scratchpad's
  `lock-lines/shots/`.

## MCP and agents

Agents can't press the person's Undo, and the lock lines are tooltips and
canvas notices: no MCP tool, CLI output or channel text changes, and the
backend is unchanged. MCP-SETUP.md describes the person's canvas for agents,
so its two paragraphs (a Cmd+Z during a delete, and a run's lock lines) are
updated. SKILL.md has no copy of either. Nothing else agent-visible.

## Questions for GM

1. **Locked selected marks.** The switch and the anchor no longer have a
   selected look while locked (the locked look covers it). Three locked
   selected states still keep a grey mark, by your earlier image-only and
   chip rule: Cinema's selected variation, the selected film-look chip and
   the pinned cover choice. Keep them, or fold them into the pressed-state
   sweep the same way?
2. **Lines on your pattern but not in your list:** the Inspector's and the
   selection toolbar's Run, Duplicate and Delete ("it", or "them" for
   several selected), the selection toolbar's Arrange ("You can arrange
   them…"), Save ("You can save the canvas…"), the Canvas actions panel's
   group line ("You can save, load, import or clear the canvas when the run
   finishes."), Run history's Clear ("You can clear the run history…"),
   "Rerun with latest source" ("You can rerun it…", Run history's verb), the
   add-a-node refusal ("Couldn't add “X”. You can add it when the run
   finishes."), and the refusals after a Delete key or Cmd+Z ("Couldn’t
   delete “X”. You can delete it when the run finishes.", "Couldn’t undo.
   You can undo when the run finishes."). Right as they are?
3. **Cinema's Generate.** The run-locked Generate is the toolbar's "Generate
   all" (it generates every shot); the shot panel's Generate shot has no
   run lock (its own blocks). It reads your line, "You can generate this
   shot when the run finishes." Keep it, or "You can generate the shots when
   the run finishes."?
4. **A newer edit lands while the Delete is on its way.** Since r18 the
   delete's step is placed at the Delete, so an agent's edit or the
   person's typing that settles before the answer is the newer step. The
   held Undo is then dropped with "Nothing was undone. Your last change was
   still saving." when the answer lands (review 11 M-1: never undo someone
   else's edit instead), where before r18 it restored the node. Keep the
   drop, or should a held Undo on a Delete always restore that Delete,
   beneath a newer edit?
5. **The 15 s give-up with presses queued behind it.** The line names the
   front press's nodes; any later presses in the batch are dropped without a
   count. Fine?
6. **A switch disabled while it saves** (Settings' switches during their
   save, a personal agent's while busy) counts as locked, so a switch the
   person just turned on shows the locked look until the save answers.
   Right, or should a save in flight keep the on look?

GM answered all six on PR #205 (round 1, below): keep 1 and add the anchor;
2 yes, but the key-press refusals drop "Couldn’t …"; 3 "the shots"; 4 keep
the drop; 5 fine; 6 the held rule.

# Round 2 (PR #205, GM's round 1 answers)

## 1. The Remotion anchor keeps a locked selected mark

A locked chosen anchor now has the shared grey selected mark (border and a
1 px inset ring in `--sr-disabled-ink`), as the variation, the chip and the
cover choice do. Without the mark, the chosen cell went transparent like
the others, so you couldn't tell which one was chosen. The rest of the cell
keeps the locked cell's look (unfilled, no extra dimming). It is pinned in
`selectedNotDisabled.r39` as the fourth reviewed mark.

## 2. Key-press refusals: the lock line alone

`runLockedLine` and `runLockedWiresLine` now return only the lock line:
- "You can delete “Brief” when the run finishes."
- "You can delete “A”, “B” and “C” when the run finishes." (the name-list
  helper; "the node" with no name, "3 nodes" with no names)
- "You can undo when the run finishes." and "You can redo …"
- "You can delete the connection when the run finishes." ("the 2
  connections" for several)

The add refusal is "You can add “Text Input” when the run finishes." and,
during an import, "… when the import finishes.". It now goes out through
`refuseAdd`, so no "Couldn't add" heading comes before it. `addIt` has left
the table.

## 3. Generate all

"You can generate the shots when the run finishes." (`generateShots`).
During an import it is disabled too, and now says "You can generate the
shots when the import finishes." (before, it fell back to its enabled
title).

## 4. Kept as built

The drop when a newer edit lands during the Delete, and the 15 s give-up.

## 5. The held switch

`SettingsSwitch` in `panels/settings/Switch.tsx` is one switch for every
Settings switch (`SwitchRow` uses it). With `saving`:
- The caller shows the person's new position.
- The switch is held through `useHeldLook`: aria-disabled at once, and
  `data-held-pending` for 150 ms, which the shared switch rule now skips
  (`:not([data-held-pending])`), so it keeps its enabled look.
- After 150 ms it gets `data-held-look` and the locked look, with the thumb
  where the person put it.
- A press while it is held does nothing.
- `disabled` stays a lock of its own (the locked look at once).

Where it's used:
- **Demo zoom telemetry** (Storage). It shows the value being saved while
  the PUT is out (`telemetryTo`). A failed save shows the saved value
  again.
- **Personal agents** (both switches). The switch the person pressed shows
  its new position (`switching`). Every switch in the section is held while
  the section is busy, so a quick save greys none of them (before, all of
  them went grey at once). The section's `run` now awaits the list reload
  before the hold ends, so the switch never flips back to its old position
  between the save and the reload.

Both paths are tested in Settings and ChatPanel.personal (slow: held, then
locked, then enabled again; quick: no grey ever; failed: put back), plus the
cascade in lockLines.pr205r1.

## 6. A reason already on screen is no tooltip

This is a rule of the helper, `canvasLock`'s `shown` option, not a
one-off. A control passes the line it sits beside (its id and text). When
the reason the lock would give as its tooltip is that text, whichever lock
gave it, the control gets no `title` and `aria-describedby` points at the
line. Any other reason keeps its tooltip: following, offline, a different
line, an enabled control. It is applied in `act`, so `lockedAction`, which
starts from `act`, keeps it. Users:
- **The deferred run notice's [Run].** [Dismiss] shows, sits on top and is
  enabled (live check: elementFromPoint at its centre is [Dismiss]).
- **Cinema's Generate shot and Generate N**, beside the line under their
  row (shared inputs, or a reference issue).

The Canvas actions panel's group line is not the Load, Import and Clear
tooltips (each names its own verb), so those keep theirs.

## 7. The lines left alone, on the pattern

`lib/runLock` now has `LOCK_WAITS` (run, import, preparing, grade,
otherRun, runningShots) and `lockLine(verb, wait | { finishes })`.
`runFinishesLine` is `lockLine(verb, 'run')`.
- **Cinema shared inputs** (the line under Generate shot and Generate N):
  "You can generate this shot when the other run finishes or after you stop
  it."; during an import, "You can generate this shot when the import
  finishes."
- **Cinema's shot lines**, each by its control's verb:
  - The shot's ×: "You can remove “Shot 2” when it finishes." GM's line said
    "generate this shot", but the control is the ×, which removes the shot
    (question 1).
  - The Delete over several scenes: "You can delete them when the running
    shots finish."
  - The scene's own Delete, also GM r3's and on the same pattern: "You can
    delete “Opening” when it finishes."
  - "Stop the run first." / "Stop the runs first." stay. They already say
    what unlocks (question 2).
- **The import:**
  - Canvas actions: the group line, plus each control's own: "You can load
    a canvas when the import finishes.", "You can import a canvas …",
    "You can clear the canvas …", "You can save the canvas …".
  - The canvas Run: "You can run the graph when the import finishes."
  - A video result's Edit: "You can edit this video result when the import
    finishes."
  - Create's thrown refusal, as a standalone line: "You can start the
    generation when the import finishes."
- **The preparation:** the same Canvas actions controls, "… when Nebula
  finishes preparing the run."
- **Commons:** a save refused while a grade is being written: "You can save
  this review when the grade finishes."
- **deleteProviderRecovery** (a thrown refusal, no single control): "You
  can forget the recovery safeguard when the run finishes.", standalone.

Not moved:
- The backend's agent refusals, as ruled.
- Run-blocked refusals that explain what is running: "Couldn’t undo. It
  would remove “Shot 2”, which is still running. Stop the run first." and
  the scene's "Couldn’t delete “Scene”. “Shot 2” is still running. …". The
  backend's 409 says the same words (main.py `_removal_person_line`), so a
  frontend-only change would split them (question 3).
- Lines outside GM's list: "Wait for this result to sync with the backend"
  (a model node's next step before its id syncs), "Wait for reference
  uploads to finish before generating." (Cinema), and canvasFollow's "Wait
  for “X” to open." (GM's own).

MCP-SETUP.md's run-lock and shot × paragraphs quote the new lines.

## 8. CI on f6a793de: graphStore.fix16

Two tests failed in CI: "nothing unsaved: the person’s delete and Undo …"
and "400: the clash prompt is the only line …". The cause is a race in the
test harness, not a product regression:
- The fake backend marks n1 deleted when the DELETE arrives, echoes, then
  answers 2 ms later. The tests waited for `h.state.deleted` and then
  pressed Undo (or restored from another window). On a slow runner that
  falls between the backend recording the Delete and this tab getting its
  answer.
- The earlier test, "the values the same once it is back", restores the
  node from another window in that window. Its delete step then waits for
  an echo that can't come, stays in flight until the 15 s limit, and leaks
  into the next tests (module state). In "nothing unsaved" the leaked step
  leaves the Delete's own step with a snapshot that lacks n1, so the held
  Undo finds nothing to change and is dropped ("Nothing was undone …").
- The LOW-2 test then fails behind it.

Reproduced by widening the backend's 2 ms in a scratch copy:
- 38bb573a (before round 1): 3 tests fail at 4 ms, 4 at 5–60 ms, the same
  two among them.
- f6a793de: 1 at 4 ms, 3 at 5–60 ms.

So this is not round 1's held Undo: the base fails at least as easily,
where its Undo is refused outright.

The fix:
- The tests wait for the Delete's answer in this tab, not only for the
  backend to record it. `deleteAnswered` waits until the delete's step
  leaves flight, using `stepInFlightForTests`, a read-only test hook in
  graphStore.
- fix17 and fix18 had the same pattern; each now waits the same way.
- With the fix, fix16 passes at 2, 4, 8, 60 and 200 ms; fix16+17+18 pass
  28/28.

Product note: a delete whose node another window restores before the
answer arrives keeps its step in flight for 15 s. That is pre-existing and
unchanged here (question 4).

## Round 2 questions for GM

1. The shot's ×: "You can remove “Shot 2” when it finishes." Your line said
   "generate this shot when “Shot 2” finishes", but this control removes
   the shot and Shot 2 is the shot itself. Right, or other words?
2. "Stop the run first." / "Stop the runs first." (a Stop is here) stay as
   they are. Do they move to "You can … after you stop the run."?
3. The refusals that explain what is running ("Couldn’t undo. It would
   remove “Shot 2”, which is still running. Stop the run first.") stay,
   since the backend's 409 shares their words. Leave them?
4. A delete whose node another window restores before its answer keeps a
   held Undo waiting up to 15 s (seen in the fix16 race). Worth a fix of
   its own?

# Round 2, continued (review 1 of PR #205, GM's r2 answers)

## 9. Held undo (review 1)

- **LOW-1, a Delete partly refused.** `putBackFailedDeletes` now takes the
  refused nodes out of the step's removed set (`forgetRemoved`, through
  the successor chain). The restore and both bring-back lines name only
  what left. A multi-node Delete brings its refused nodes back only once
  every DELETE has answered, so the give-up can't fire with a node already
  back. The reviewer's give-up variant can't happen; the line is true when
  it is said.
- **LOW-2, the intermittent live failure.** The harness now records when
  each DELETE's answer reached the page (CDP `Network.responseReceived`).
  An answer under 14 s is judged as "no bring-back line". One after 15.5 s
  is judged as the give-up order, and one in between only by its end
  state. The order in the product: only `giveUpHeld` (the 15 s timer) and
  a refused restore write the bring-back line, and the failing run sent no
  restore. That is the give-up, after the answer slipped past 15 s under
  load. With GM r2 item 1 (below), both orders now end on the same screen.
- **LOW-3 → GM r2 item 2**, below.
- **NIT-1, a press handed on from its Delete.** When the `changesNothing`
  branch hands a held press to the step below, its `onDelete` is
  recomputed for that step (`isDeleteInFlight(below)`). A refused restore
  of the edit below now says "Couldn’t undo …", not the bring-back line.
  Test: two Deletes and two presses; a plain sync puts the first node back
  as it was, so its step changes nothing. The mutant without the fix fails
  it. `giveUpHeld`'s `pressTarget(front) === step` conjunct can't fail:
  `waitFor` sets `heldFor` to the front press's target, and the timer
  checks `heldFor === step`. With the fix, `onDelete` always matches that
  target. The conjunct stays as a guard; its mutant is equivalent.
- **NIT-2, round11 cascades.** Its `afterEach` answers every DELETE still
  on its way, then `forgetHeldHistoryForTests()` (the canvas-replacement
  reset, `forgetStepsInFlight`). Proof: a scratch copy whose first test
  hangs mid-hold (1.5 s timeout). Old `afterEach`: 12 of 14 failed. New:
  only the hang (13 of 14 pass).
- **NIT-3**: the PR body says 64 restored tests (64 of 146 fail on base).

## 10. GM r2 item 1: a late refusal after the give-up

The give-up line records its notice id (`giveUpShown`). When that step's
Delete answers with a refusal, `giveUpTakeover` runs after the answer's own
lines are written. It puts the newest of them in the give-up line's place,
with the same notice and the same id, and puts the other place back as it
was. With no line of its own, the give-up line just goes. A late ok
doesn't take over: the node is still off and Undo does bring it back. Its
"Deleted the node." (with Undo) replaces the line as before, also true.
Tests cover both places (the undo notice; the message beside an error) and
the late ok. Live: `giveuprefused`, the give-up at 15 s, then the Delete's
line in notice 12, alone.

## 11. GM r2 item 2: the newest synced copy

`carrySyncedCopy` writes the copy Nebula synced while a node's Delete was on
its way (`heldCopies`, review 17's M-2) into the Delete's step and the steps
re-pushed in its place. The held Undo and an Undo pressed later both restore
from that step, so one change fixes both paths, main's included. It isn't a
follow-up; it's about 40 lines.

The live check found a second gap. The real backend syncs its graph without
the node after the agent's sync and before the DELETE's answer, and that
sync replaced the copy with "gone". When a sync shows a node gone while its
Delete is on its way, the copy it had now goes into the step first
(`noteHeldCopies`). The FakeNebula tests send the syncs in that order now;
the mutant without the fix fails both. Live: `agentedit` (held) and
`agenteditafter` (main's path): "Agent renamed"/AGENT on the canvas and in
Nebula, one restore.

Not carried: wires an agent drew to the node while its Delete was on its
way. The restore brings back the step's wires, as before.

## 12. GM r2 item 3: the command palette

- The items are "Run canvas", "Save canvas" and "Load canvas". "graph"
  stays as a search keyword.
- `PaletteContext.running`: while this tab's run goes (or starts), a row
  the run locks carries `lockLine` ("You can run the canvas when the run
  finishes.", "You can save the canvas …", "You can load a canvas …").
- The row stays in place and disabled. The line is its secondary text
  (`.command-palette__item-lock`), `aria-describedby` points at it, and
  `aria-label` is the title alone so the line isn't read twice. There is
  no tooltip.
- A canvas lock's own title (following, offline) wins over the line.
- disabled-buttons.css greys the row and its line with the shared ink at
  opacity 1. The old 0.4 dimming is overridden, and the keyboard highlight
  stays.
- Live: the three rows, ArrowDown-selected, rgba(255, 255, 255, 0.55) at
  opacity 1 (shot).
- Other old names, left for GM (question 5): Canvas actions' "Save graph",
  "Load graph" and "Import CLI graph" (its heading reads "Graph"), and the
  shortcuts sheet's "Run graph", "Fit the graph" and its "Graph" group.
  The CLI's help text says "Load graph" for the canvas action.
  docs/notes are history.

## 13. GM r2 item 4: Cmd+D and Cmd+V

`duplicateSelected` and `pasteClipboard` say their line during a run, in the
undo notice where Delete's, Undo's and Redo's show:
- "You can duplicate “Brief” when the run finishes." Several are named by
  the shared rule, as Delete's are ("“Brief” and “Note”").
- "You can paste when the run finishes."

Cmd+V with nothing copied stays silent, as it is with no run. The menu and
toolbar Duplicate controls are disabled with their own titles, as before.

## 14. GM r2 item 5: a wire dropped during a run

Drawing a wire between two nodes isn't run-locked: `onConnect` and
`isValidConnection` don't read `isExecuting`. So the drag goes on. A drop
on empty canvas during a run opens no picker. It says "You can add a node
when the run finishes." (`sayRunLocked`) in the key-press line's place.

A picker already open when a run starts closes on a press and says the same
line. Live: with no run the same drag opens the picker; during a run there
is no picker, the line shows, and no wire is drawn (shot).

## 15. Review 1's lock-line NITs

- **NIT-1, the selected ratchet.** `SELECTED` now also matches `.is-active`
  (and `.is-selected` and the like), `--checked`, `--pressed`, `--current`
  and `[data-state|checked|pressed]`. `DISABLED_TOKEN` matches
  `--(sr-)disabled-opacity*`. `DISABLED_VALUE` matches either rgb() syntax
  with a fraction or a percentage. There are 12 crafted cases, the
  reviewer's survivors among them, plus the same with a lock and an
  enabled look. No new offenders in the app.
- **NIT-2, the !important ratchet.** `PAINT` gains `fill`, `stroke`,
  `filter` and `-webkit-text-fill-color`, matches `! important` and
  ignores case. It also counts a locked ancestor of any kind when the
  subject is a button or a covered class (`fieldset:disabled
  .proposal-bar__button`). There are 10 new cases, 2 of them negatives.
  No new offenders.
- **NIT-3, the deferred notice's exit.** It keeps the line it last showed
  through its exit: "now", with [Run] enabled. The freeze is keyed on
  `deferredRun` itself, because on the render where it goes, useLeave
  hasn't marked it leaving yet; the first try overwrote the frozen line on
  that render.
- **NIT-4, Canvas actions.** Round 2 item 7 had already given a Create
  launch its own wait ("when Nebula finishes preparing the run") on Load,
  Import, Clear and the group line. What was left: with both a run and a
  launch going, the group line said "preparing" while each control said
  the run. The run now leads.

## Round 2, continued: questions for GM

5. "Graph" left elsewhere: Canvas actions' "Save graph", "Load graph" and
   "Import CLI graph" under a "Graph" heading, and the shortcuts sheet's
   "Run graph", "Fit the graph" and "Graph" group. Rename them to canvas,
   as the palette now is?
6. The palette's Run, Save and Load locked by an import or a Create launch
   (not a run) are disabled with no line, as before. Should they say the
   import's or the preparation's line the same way?
7. On this skin the palette's keyboard highlight (`rgba(0, 0, 0, 0.06)` on
   the near-black panel) is barely visible on any row, locked or not
   (pre-existing; see the palette shot). Worth its own fix?

## Round 2 proof

- **tsc -b and lint:** rc 0.
- **vite build and the budget:** pass; 444,836 B raw, 136,619 B gzip.
- **Full vitest** (maxWorkers 4, load average 17–45): 8,626 tests in all.
  - 4 failed: a 300 s timeout in the round-17 property test (31 s alone),
    and 3 load flakes (the ratchet, modalStyles.round11, NodeLibrary).
  - 1 worker failed to start (graphStore.connectedStep).
  - Each of those passes alone: 84/84, 9/9, 35/35.
  - The run before the last test edits found 4 real failures, now fixed,
    each one this round's ruled change:
    - round21Store: `sayRunLocked` is listed as not an edit.
    - round23Surfaces: Save canvas is a look-only row.
    - errorCopy.namedLine: three reviewed "Couldn’t …" run-lock lines are
      gone since answer 2.
    - agentPresenceFollowups.r1: Generate shot's reason line is on screen,
      so no tooltip, with aria-describedby (r1's rule).
- **New and changed tests on f6a793de:** 27 fail.
  - heldUndo.pr205r2: 6/6 (they also need the new test hook).
  - heldUndoSyncedCopy: 4/5 (not the control).
  - lockLines.pr205r2: 12/15 (not the no-run controls).
  - ChatPanel.personal: 2.
  - agentPresenceFollowups.r1: 1.
  - selectedNotDisabled: 2.
  - The ratchet case tables pass on the base by design, since they test
    the test's own patterns; their mutants carry the proof.
- **Mutation:** 71 mutants (round 2's 37, and 34 for this part) on each
  guard's own files, with --retry=2, counted against a clean baseline
  (0 failures).
  - The first pass killed 67. Four survived, each missing a test:
    - cinemaNoShown: its test is agentPresenceFollowups.r1.
    - agentsNoAwaitReload: added "the hold lasts until the reload
      answers".
    - carryOff: added the order where the Delete answers before the
      "gone" sync.
    - paletteGreyOff: it mutated the aria branch the rows don't use; now
      the `:disabled` branch, read through the cascade on a rendered row.
  - Rerun: all 4 killed, so 71/71.
  - The Canvas drop guard was mutated live: without it, the picker opened
    and no line showed (FAIL); with it, PASS.
  - The equivalent mutant (`pressTarget(front) === step`) is explained in
    section 9.
- **Live** (8797/5797, isolated, canary to 8001 refused, 0 reached
  8000–8010/5173): 25/25 on the final code.
  - Covered: deferred, keypress, switch, heldundo (text and scene),
    restorefail, refused (answered in 830 ms), giveuprefused, agentedit,
    agenteditafter, palette, wiredrop, duplicate (Cmd+D, Cmd+V) and giveup.
  - 17 shots in scratchpad/lock-lines/shots2/; md5 `uniq -d` is empty.

# Round 3 (GM r3 and r4, review 2)

## 16. CI: the MCP-SETUP run-lock paragraph

CI failed on c85a6ae8 in the backend doc sweep: the "A run this window
started" bullet said "wire" and called the connected add locked. It's
rewritten with neither word, wrapped at 76, and covers what changed below
(the key presses' lines, the palette rows, the import and Create waits, and
that adding a node or connecting isn't locked by a run).

## 17. GM r3: names and the palette

- "Canvas" everywhere the person reads "Graph" for this canvas: the Canvas
  actions heading and group, "Save canvas", "Load canvas", "Import CLI
  canvas" (and its title), the shortcuts sheet's "Run canvas", "Fit view"
  and its "Canvas" group, the unsaved-edits dialog's “Load canvas”. The
  agent-visible "Load graph" in mcp_server.py, the CLI help, skills/nebula
  and MCP-SETUP now say "Load canvas".
- The palette's panel rows are in sentence case ("Toggle node library").
- `RUN_LOCK_VERBS.runCanvas` is "run the canvas"; `runGraph` and `addNode`
  are gone. `sendToMotion` is new.
- `canvasWait(state)` in lib/runLock picks the wait that locks a canvas
  command: this tab's run or its start, then Create's launch
  ("preparing"), then an import. `canvasWaitLine` says its line. The
  palette's rows, the Cmd keys and the toolbar all read it, so a row locked
  by an import says "You can run the canvas when the import finishes."
- The keyboard highlight is the selected-row surface
  (`--sr-surface-control-active`), and a locked row keeps it: the disabled
  rule greys its text only.
- Review 2 lines LOW-1: the input is a combobox (`aria-controls`,
  `aria-activedescendant`, `aria-autocomplete="list"`), the list a listbox
  with groups, each row an option with `aria-selected`. A locked row is
  `aria-disabled`, never native disabled, so ArrowUp/Down reach it and its
  line is read; Enter on it does nothing (`run` refuses `enabled === false`).

## 18. GM r4 item 1: an agent's edit during a Delete is its own step

`carrySyncedCopy` still writes the agent's synced copy into the Delete's
step, so the restore brings back what Nebula had. It also records the
delete-time copy and the synced one, and `placeForeignUnder` makes that
change a step of its own (with `foreignEditStep`, as `applyHeldCopies`
does) directly under the Delete's step once the Delete answers. The first
Undo restores the node with the agent's edit; the next says "Undid Codex’s
edit." and puts back what the person had; the person's older steps never
revert the agent's edit without saying so. A sync of this tab's own (an
echo) makes no agent step. Live: `agentstep`.

## 19. GM r4 item 2: a restored node is selected

The person's own Undo that brings nodes back selects them and only them, as
a paste does, whatever the step's copy held.

## 20. GM r3 item 4: the agent's connections

The carried copy brings its connections as Nebula synced them, when the
copy is someone else's (an agent's). A connection stays as the step had it
when it isn't CLI-backed, when this tab is still writing it, or when either
end wasn't in that sync. `snapshotNext` drops a connection whose other end
is gone by the Undo. This replaces section 11's "Not carried".

## 21. GM r4 item 3: the connected add during a run

Adding a node and connecting two are each allowed during a run, so the
wire drop's picker opens and its add works (section 14's refusal and its
line are gone, in Canvas, ConnectionPopup and `addNodeAndConnect`). An
import still refuses it. For agents nothing changes: the backend's
`/api/graph/node-and-connect` never had a run lock. Live: `wiredrop3`.

## 22. GM r4 items 4–5

- Cmd+Enter, Cmd+S and Cmd+O during a wait say the palette's lines ("You
  can save the canvas when the run finishes."), on the canvas and from the
  Canvas actions panel. Cmd+Enter now always prevents the browser default.
- The toolbar Run's title while a run is starting is "You can run the
  canvas when the run finishes." (review 2 NIT-2).
- Send to motion during an import: "You can send it to motion when the
  import finishes."

## 23. Review 2, held Undo

- **MEDIUM-1:** the confirm loop carries the synced copy before it drops the
  typing never sent, and the copy keeps a rename still on its way
  (`labelsInFlight` at the copy's time and at the carry). Tested on both
  paths (held Undo, Undo after the answer) in both sync orders.
- **LOW-1 (P11):** "Try Undo again" stays only while its Delete's step is
  next in line. `giveUpStaysTrue` (store middleware) takes it off when a
  newer step lands above, outside a Delete's own answer, so a late ok never
  finds it there. A replaced canvas takes it off through the same rule, so
  `forgetStepsInFlight` no longer resets it.
- **NIT-2:** tests for M4 (P7, the agent's move), M7, M9, M10, M12 and M14.
  M7 isn't reachable since round 18 (a Delete's nodes leave the canvas when
  it's pressed), so its test sets that state by hand; the walk stays as the
  guard. M12 is reached through the stale-canvas refusal while a cut-off
  write answers. M14 is now the code itself: no reset, the middleware does
  it. M18 is equivalent (section 9).

## 24. Left for the wording batch

Not changed here; listed for GM's batch with file:line: the Delete failure
line ("Couldn't delete the node." then the reason: main's #198 path,
graphStore.ts `deletionHeading`), round 2's questions 1–4, the waits
outside the "You can … when …" shape (cinema uploads, "Wait for this result
to sync with the backend", the project-open wait), the "graph" error
headings of Save/Load/Import canvas, "View video node" during an import,
and the picker's silent press during an import.

## Round 3 proof

- **tsc -b and lint:** clean. vite build plus the budget: passed (445,066
  bytes raw, 136,710 gzip).
- **Full vitest (4 workers, final code):** 8,678 of 8,679 passed, Errors 0.
  The one failure, modalStyles.round11, timed out under load and passes
  alone (4/4).
  - The first full run had 6 unhandled errors: Toolbar.test's store mock
    lacked `sayRunLocked`, which the Canvas actions keys now call. The mock
    has it, and the test asserts both lines for each wait.
- **Full isolated backend:** 12,237 passed, 71 skipped, 0 failed (45 min).
- **New tests on c85a6ae8** fail where they test new behaviour:
  canvasKeys 4/5, heldUndo.pr205r3 16/25, heldUndoGiveUp 2/7, lockLines
  14/15, Toolbar's three key cases, connectedStep's "during a run". The
  ones that pass on the base are the controls, MEDIUM-1's "gone sync first"
  order (the bug was the other order), and guards over code the base
  already had or that only a mutant breaks (M7, M9, M10, M12, P7, the
  other-end and both-ends connection cases, the stack rewrite).
- **Mutation:** 46 mutants on each guard's own files (--retry=2, clean
  baseline). The first pass killed 38. The 8 survivors:
  - `!isOwnEcho` in the agent-step check was redundant (`copy.foreign` is
    only ever someone else's) and is gone. Its replacement mutant (no
    `copy.foreign` check) is equivalent: `foreignEditStep` makes no step
    without an origin.
  - The own-copy edge mutant was equivalent as written; the carry is now
    an `if (copy.foreign)` block, and that mutant is killed.
  - The `there` rule and the snapshot's dangling-connection filter: new
    tests (both ends deleted together; the other end checked on the canvas
    at the Undo, before any sync). Both killed.
  - The carried copy's `selected` was dead (the restore selects) and is
    gone.
  - "Keep the line while the step is on top": new test, killed.
  - The late-ok-not-on-top takeover was redundant with `giveUpStaysTrue`
    (the line goes when the newer step lands) and is gone.
  - The store's run refusal returning: new connectedStep test, killed.
  - Rerun of the changed guards: 10 of 11 killed, 1 equivalent (above).
- **Live** (8797/5797, isolated, canary to 8001 refused, 0 requests reached
  8000–8010/5173): 11/11 on the final code. palette3, paletteimport, cmds,
  wiredrop3 (picked "GPT Image 1": added and connected during the run),
  deletefail, agentstep ("Restored the node.", selected alone, then
  "Undid Codex’s edit." with the typed value back here and in Nebula).
  - 6 shots in scratchpad/lock-lines/shots3/; md5 `uniq -d` is empty.

# Round 4 (GM r5 and r6, review 3)

## 25. GM r5: the canvas failure lines and the import waits

- The three failure headings: "Nebula couldn’t load the canvas.",
  "Nebula couldn’t save the canvas." (lib/graphFile, GraphFileActions) and
  "Nebula couldn’t import the CLI canvas." (Toolbar). The reason follows
  each, as before.
- The connection-drop picker, pressed during an import, adds nothing and
  says the store's line in a status row: "You can add “GPT Image 1” when
  the import finishes." (`addNodeLine` in lib/runLock, which the store's
  refusal now uses too). The line goes when the import ends.
- "View video node" during an import is disabled with "You can view the
  video node when the import finishes." (`RUN_LOCK_VERBS.viewVideoNode`);
  Send to motion keeps its own line.

## 26. GM r6 item 5: three more names

"…Save your canvas first to keep a copy." (the Clear confirm), "The CLI
canvas is empty. Build one with the nebula CLI first." and the run
history's "Full canvas".

## 27. Review 3 MEDIUM-1: an agent's rename after the person's

`noteHeldCopies` took `renaming` from the copy before it, so a rename that
had landed kept winning over a later agent rename, and the Undo brought
back the person's name. It now records `renaming` only while the label is
in flight (`labelsInFlight.get(id)`). The other fields that carry forward
do so on purpose: `foreign` and `moved` (Nebula's later syncs, the
person's own echoes included, still hold the agent's edit and move, so the
newest copy is still theirs to name) and `links` (below), which keeps each
earlier edit with its own copy. Tested in both sync orders (the reviewer's A3 and
A3b), with a control where the person's rename is still on its way.
Live: `renamelate`.

## 28. GM r6 item 1 and review 3 LOW-1: one step per agent edit

Each sync that carries someone else's edit to a held node is a link in the
copy's `links` (origin, the synced node, its connections, the order
Nebula sent it). Two syncs of the same edit id fold into one link; any
other edit, by the same agent or another, is its own link, as
`foreignEditStep` makes one step per sync outside a Delete (it never
merges). `carrySyncedCopy` turns the links into a chain, each step's
before being the previous one's after, the newest ending where the
restore puts the node; `placeForeignUnder` makes the steps under the
Delete's step in Nebula's order, so Undo takes the newest first ("Undid
Claude’s edit." then "Undid Codex’s edit."). Each step carries its own
edit id, so each Undo names its own edit to Nebula (LOW-1). A Delete
Nebula refuses leaves the node, and the same links become steps on the
canvas (`placeEarlierLinks`). Live: `twoagents`.

## 29. GM r6 items 2–3: one selection

`selectionFollows` sets the UI's selected node (the Inspector, its ring and
the "…" pill) to what a Paste, Duplicate, Undo or Redo brings: the one
node, or none when it brings several. Any Undo or Redo that brings nodes
back selects them, agent steps included. Live: `ring` (one ring after
Paste and after an Undo).

## 30. GM r6 item 4: the highlighted row's edge

Every highlighted palette row, locked or not, has
`box-shadow: inset 0 0 0 1px var(--sr-ink-meta)` (white at 0.40): 3.66:1
on the panel, 3.05:1 on the highlight surface. The locked row keeps its
grey label inside it. Live: `edge`.

## 31. GM r6 item 6 and review 3's other items

- MCP-SETUP: Cmd+Enter during Create's launch runs, as the toolbar's Run
  and the palette's do; Cmd+S and Cmd+O say the wait.
- LOW-2: tests for U6, U7 and U17 (all killed). U16 and U18 stay guards:
  - U16 (save and restore `landingsForNextStep`/`sceneLinesBeforeSync`
    around `placeForeignUnder`): a sync sets them and consumes them in the
    same synchronous call (`foreignEditStep` clears them first), and
    `placeForeignUnder` runs only from the Delete's answer, so today they
    are always null there. The guard keeps a future path that leaves them
    set from feeding a sync's landings to an agent step.
  - U18 (`if (!chain)`): a step re-pushed in the Delete's place holds the
    same delete-time copy, so building the chain again gives the same
    chain. The guard keeps the chain from the Delete's own step.
- NIT-1 (the round 3 note on dropping the `copy.foreign` check was
  inaccurate): with no origin, `foreignEditStep` makes no step, but it
  still notes the node's changed keys as touched by an unknown source
  (`noteForeignTouches`, kind "unknown") and clears the sync's landings and
  scene lines. So the mutant is not a no-op, and no test catches it
  (rerun: survived). The one difference a person could see: a sync with
  no origin (a reconnect's) that changed the label of a node held by a
  Delete Nebula then refused. Outside a Delete that sync marks the label
  as changed by someone unknown; here the canvas takes it without a mark,
  so NodeLabel's dropped-rename line would still name the agent who
  renamed it before. The mutant's way matches the rest of the app, but it
  would also mark the person's own echoes. Not changed; left as a
  question below.
- names-palette-keys NIT-1: "Wait for it to finish." (cinemaScene.ts) is
  in the wording batch list with GM's ruling, "You can <verb> when it
  finishes."

## 32. Agents

Agent-visible behaviour changed; the tools didn't. When the person deletes
a node an agent is editing, each of the agent's edits stays its own step
(never merged with another agent's), an agent's rename after the person's
is kept, and any Undo or Redo selects what it brings back. MCP-SETUP's
remove_from_canvas bullet says so; the CLI and the MCP tools need no change
(the restore is the person's, through the same endpoints).

## Round 4 proof

Full suites run in CI after the push; on this Mac only tsc, lint and the
changed and related files ran (2 workers).

- **tsc -b and lint:** clean.
- **Related vitest (239 files):** 3,527 of 3,530 passed, Errors 0.
  - graphStore.batchPreview (2): its uiStore mock lacked `selectNode`,
    which Paste and Duplicate now call. The mock has it and the test
    asserts the call with the copy's id; 11/11.
  - agentPresenceFollowups.ratchet timed out at 120 s under load; alone,
    51/51.
  - The files changed after that run started (heldUndo.pr205r4,
    lockLines.pr205r3, ConnectionPopup, CinemaMotionHandoff): 80/80. The
    other ten files that mock uiStore don't reach `selectionFollows`:
    91/91.
- **Related backend (58 files, isolated):** 2,329 passed, 9 skipped, 0
  failed.
- **New tests on f553ac94:** heldUndo.pr205r4 fails 12 of 16; the 4 that
  pass are the A3c control and the U6p, U7p and U17 guards. Also failing
  there: lockLines' two edge tests, batchPreview's two selection asserts,
  ConnectionPopup's import line, CinemaMotionHandoff's "View video node",
  and the heading and name tests in graphFile, GraphFileActions, Toolbar
  and runHistory.
- **Mutation (each guard's own files, --retry=2, clean baseline):** 30
  mutants, 27 killed. U16 and U18 stay guards (section 31). The NIT-1
  mutant survives (section 31).
- **Live** (8797/5797, isolated; a canary to example.com aborted by
  interception, the canary to 8001 refused, 0 requests reached
  8000–8010/5173): 12/12 on the final code: edge, failures, picker,
  videonode, renamelate, twoagents, ring.
  - The first full run was 11/12: the ring's Undo half found no Delete to
    undo. That run didn't log whether the Delete key had removed Temp 4,
    so the cause isn't known. With that logged, ring alone was 6/6 and the
    next full run 12/12, and both logged that the Delete had removed the
    node.
  - 12 shots in scratchpad/lock-lines/shots4/; md5 `uniq -d` is empty.

## Round 4 question for GM

A sync with no origin (a reconnect's) that renames a node held by a Delete that
Nebula then refuses: should the name it brings count as changed by
someone unknown, as it does outside a Delete? Today it doesn't, so a later
dropped rename's line names the agent who renamed it before.

# Round 5 (GM r7 and r8, review 4)

## 33. Review 4 MEDIUM-1: a restore's hold with two agent edits

When an Undo's restore holds a node, the syncs put its connections on the
canvas at once (only its content waits), so an agent's connection gets its
step when its sync lands. Round 4's `placeEarlierLinks` then rebuilt the
connections from each earlier edit at the end of the hold, which left the
canvas at the older edit's connections and added a second step.

- Earlier links take connections by the newest copy's rule: their own only
  when the hold kept them off (`wires`, a refused Delete); on a restore's
  hold the canvas's stay. The newest copy's own rule on that path is now
  `carriedEdges` too, so all of a hold's links follow one rule.
- One step per edit, in Nebula's order: a link remembers the step its own
  sync made (`bindHeldLinks`), and its held node change joins that step at
  the end of the hold (`setLinkStep`). An edit whose sync made no step (a
  value) gets a new one, under the steps later edits' syncs made.
- Tests: the reviewer's R1 and R1b (canvas equal to Nebula after the hold
  and after each Undo and Redo, one step per edit, each Undo naming its own
  edit), R6 and R12, and an earlier link's connection the newest takes off.
- Live `restorehold`: 5 of 5.

## 34. GM r7 item 1: "someone" for a sync with no origin

A sync with no origin (a reconnect's) that changes a held node is now a
link of its own with no origin. As outside a hold, it makes no step and
marks what it changed as made by someone unknown (`noteForeignTouches`),
and it is never folded into an agent's step: the last step of a hold is
the last link's, whoever's it is (no `foreign` carried from an earlier
agent any more). A run's own write-back (no origin, `runParams`) stays
nobody's change, as outside a hold. Each link keeps the person's rename in
flight at its sync, so a stale label is never anyone's change.

Tested on four paths that agree: no hold, a refused Delete, a restore's
hold and a Delete that goes through. In each, the name is "someone"'s
(`lastForeignToucher` unknown; the dropped rename's line is the unknown
one) and Codex's step holds only Codex's change. Also: an earlier agent
rename is never credited with a reconnect's rename, and a run's write-back
leaves the value's toucher as it was.

The dropped rename's unknown line is GM's round 17 wording, "This node was
renamed “X” while Nebula was offline, so your rename to “Y” wasn't saved.";
it has no word "someone". Not changed; asked below.

Undo still puts back a step's whole node (lib/canvasUndo `applySlice`), as
it does for every step: undoing Codex's step after a reconnect's rename
takes the name back too, held or not. Making Undo revert only the step's
own fields would change every kind of step; asked below.

## 35. GM r7 item 2 and GM r8 item 3: the canvas reads

- "Nebula couldn’t load the canvas. This file is damaged or isn’t a Nebula
  canvas."
- The startup, Retry and follow read (`fetchCLIGraph`) is headed "Nebula
  couldn’t load the canvas." too; its reason tells it apart.
- Still "graph" in lines this PR shows next to a canvas heading (listed,
  not changed): `graphSizeLine` ("This graph is 3.2 MB. Nebula opens graphs
  up to 50 MB.", after the save or load heading), "Graph contains more than
  N nodes." / "… edges." (save), `skippedFilesLine` ("Graph saved without 1
  of its files. It may be missing when the graph is opened somewhere
  else."), and the file pickers' "Nebula Node Graph" and "Nebula Node Graph
  Bundle". Several of these use a straight '.

## 36. GM r8 items 1–2: several nodes back

- `selectNode(id, { keepPin: true })` for what Paste, Duplicate, Undo and
  Redo select: several nodes back leave a pinned Inspector pinned and open,
  showing its empty state. The person's own clearing still unpins.
- A real multi-selection keeps main's look: each node draws its ring and
  "…" pill from its canvas selection, and the UI's single selection is
  null, so the node clicked before draws none. Pinned by rendering each
  card after an Undo that brings two back.

## 37. GM r8 item 4: forced colours

`@media (forced-colors: active)`: the highlighted row has `outline: 1px
solid Highlight` (offset −1px, inside the row), and a locked row's label
and line are `GrayText`. The cascade test helper now leaves forced-colors
blocks out of the normal cascade; a test reads that block on its own.
Live, with forced colours emulated: the outline is the system Highlight on
a locked and an unlocked row, and the locked label is GrayText.

## 38. Review 4's other items

- LOW-1 tests: the chain's intermediate connections (a later agent changes
  them), R9 (order across nodes), R8 (an agent step's Undo keeps the
  selection).
- NIT-1 (M7): with the newest link in `placeEarlierLinks`, its step is made
  there and the last step finds nothing left, unless something came after
  the last link (now always the person's own echo). Near-equivalent;
  survives.
- M9 (the newest step ending at its link's node, not the carried copy):
  they differ only by what the person's own echo after the last link
  carries, and `mergeSyncedNode` already keeps the person's own values in
  both. A test pins the case (Nebula takes Codex's rename, then the
  person's typing, then the Delete: Redo keeps the typing); survives as
  equivalent there.
- The NIT-1 gate (`if (last)`: with no links, a hold's own echoes make no
  call to `foreignEditStep`): with no links every sync was the person's
  own, so marking its changes as someone's would be wrong, but the canvas
  already equals those echoes, so no key differs and nothing is marked.
  Equivalent in every case found; survives.
- NIT-2 (M26, `return` → `continue`): equivalent; the node can't come back
  inside the loop.
- Lines NIT-1: a test for GraphFileActions' own save heading. NIT-2: a test
  that Cmd+Enter runs during Create's launch. NIT-3: MCP-SETUP quotes both
  lines in full.
- The live harness waits, before every key press, until the canvas is
  online and unlocked (review 4: the client marks the isolated backend
  offline for a moment under load).

## 39. Agents

Agent-visible: an agent is no longer credited, in a dropped-rename or kept
line, with a change a sync with no origin made while a node was held; and
an agent's edit to a node a restore holds stays one step with Nebula's
connections. No tool, CLI command or doc wording for agents changed except
MCP-SETUP's Cmd+S/Cmd+O quote (NIT-3).

## Round 5 proof

Full suites run in CI. On this Mac: tsc, lint, and the changed and related
files at 2 workers. Every npm and npx call after the coordinator's
update-notifier rule ran with NO_UPDATE_NOTIFIER=1 and
npm_config_update_notifier=false; the ones before it in this round didn't.

- **tsc -b and lint:** clean.
- **Related vitest (262 files):** 4,086 of 4,087 passed, Errors 0, no
  timeouts. The one failure was the disabled-look ratchet: the forced
  colours GrayText rule was outside disabled-buttons.css. It moved there;
  the ratchet and lockLines pass (70/70), and the 18 files that read the
  CSS pass (317/317). The files changed after that run: 83/83.
- **Related backend (34 files: the MCP-SETUP readers and
  test_agent_knowledge, isolated):** 1,089 passed, 9 skipped, 0 failed.
- **New tests on 96fdb9d8:** they fail where they test new behaviour (R1,
  R1b, GM r7's held paths, the pinned Inspector, the forced-colours rule,
  the reason and the startup heading, batchPreview's keepPin). Those that
  pass there are guards over code only a mutant breaks (R6, R12, the
  earlier link, the chain, R8, R9, the run write-backs, the save heading,
  Cmd+Enter) and controls.
- **Mutation (each guard's own files, --retry=2, clean baseline):** 27
  mutants, 24 killed. M7, M9 and the NIT-1 gate survive (section 38).
- **Live** (8797/5797, isolated; the example.com canary aborted by
  interception and the 8001 canary refused before anything else ran, 0
  requests to 8000–8010/5173): 16/16. restorehold 5/5, ring 3/3 (the
  harness waited out 1–3 offline blips per run; no press was refused),
  reason, someone, forcedcolors (rerun after the CSS move: 6/6).
  - 5 shots in scratchpad/lock-lines/shots5/; md5 `uniq -d` is empty.

## Round 5 questions for GM

1. The dropped rename's unknown line reads "This node was renamed “X” while
   Nebula was offline, …" (round 17). Keep it, or "Someone renamed this
   node “X” …"?
2. Undo puts back a step's whole node. Should undoing an agent's step keep
   a later change someone else made to the same node (a reconnect's
   rename), for every kind of step?

## 40. Review 5 MEDIUM-1: a held change never goes under the person's step (GM r10 item 1)

- Round 5 joined a held node's change into the step its own sync made, or
  put it under later edits' steps, even when the person had taken a step
  on that node during the hold (typing). That step's snapshot lacks the
  agent's change, so its Undo took the agent's rename off too, and the
  agent's Undo brought the undone typing back.
- `setLinkStep` now joins or inserts only where every step above the place
  is a later edit's (`editStepSeq`: a step Nebula's later edit made) or a
  slice step that leaves the node alone. The person's typing is a snapshot
  of the whole canvas, so it holds every node, the held one included. Else
  the change goes on top as its own step (GM r10 (a)): O1t gives
  `[F(Claude) connection, own, F(Claude) rename]`, and the three Undos take
  back the rename, the typing and the connection, each alone.
- The slice-step clause is defensive: during a restore's hold the person's
  add waits behind the restore (its OwnAdd lands after the hold), and every
  agent step a sync makes has a seq. No test reaches it, and the mutants
  that drop it (and the OwnAdd params check) survive.
- Other splices checked: `placeForeignUnder` puts a Delete's chain directly
  under the Delete's own step. That step's snapshot already carries the
  agent's change (`carrySyncedCopy`), and the steps above it were taken
  while the node was off the canvas, so none holds it. Unchanged.

## 41. Review 5 LOW-1 to LOW-3

- LOW-1: one rule for the person's rename in flight (`heldLabel`): the
  newest copy, the earlier links and a Delete's chain each keep
  `labelsInFlight`, else the rename on its way at that copy's sync. The
  newest copy had no such rule, so Codex's value sync was credited with the
  stale label and its Redo wrote it back.
- LOW-2: a run's write-back never folds into a sourceless sync's link (nor
  the reverse), so it stays nobody's and is rebased; a fold keeps
  `runParams`.
- LOW-3: `editStepSeq` orders steps across nodes too: a held change goes
  under the lowest later step of any node, so two held nodes edited in
  alternation give four steps in Nebula's order. The Delete chain's steps
  and a sync's own step carry their seq the same way.
- NIT-1: O9 (the newest chain step ends where the carried copy does, not at
  its link's node) and O11 (the no-link gate: the person's own rename under
  a restore stays theirs) are tests now. Section 38's "equivalent" was
  wrong for both. O9 kills M9. With LOW-1's rule the newest copy keeps the
  rename in flight, so O11 no longer differs under the gate's mutant: with
  no links every sync was the person's own and nothing on the node differs
  now, so the gate is near-equivalent again.
- Mutants that survive and why: a sync's step with no held link taking no
  seq (every sync during a hold makes a link for each held node, so that
  branch only runs with no hold, where nothing is placed); the Delete
  chain's steps taking no seq (no held change has been found to land under
  one: the Delete's own step is above them and holds its node); the newest
  copy's carried `renaming` (the rename's PUT waits behind the restore, so
  `labelsInFlight` still has it at the hold's end).
- NIT-2: `undoCodexKeepsRename` is `undoCodexStepWholeNode`, and it asserts
  the name goes back with the value (whole-node Undo, GM's follow-up PR).
- "wasn’t" in the three dropped-rename lines, and their tests.

## 42. GM r9 item 2 and r10 item 4: the canvas lines

- Size: "This canvas is N MB. Nebula opens canvases up to M MB."
- Limits: "The canvas has more than N nodes." / "… N connections."
- Skipped files: "Nebula saved the canvas without 1 of its files. It may be
  missing when the graph is opened somewhere else." (and "without N … They
  may be"). The rest of the line is kept as the brief says, so it still
  says "graph" after "canvas": a question for GM below.
- Pickers: "Nebula canvas" (Load) and "Nebula canvas bundle" (Save); the
  extensions are the same.
- The shape walk's four reasons (`assertGraphComplexityWithinLimits(value,
  use)`): one `GraphStructureLimitError` with two fields, `reason` (the
  person's line, by where the check ran) and `detail` (the engine's exact
  words, which the console log now prints). Save: "It’s too complex to
  save. Undo your last change, then try again." (values, depth) and "Part
  of it holds a value Nebula can’t save. Undo your last change, then try
  again." (non-finite, circular). Load: "This file is too complex to open."
  and "Part of this file holds a value Nebula can’t read." `editsFileReopens`
  runs the open check (it only reads true or false).
- Where the checks run: Save canvas (save), Load canvas's plain file and
  bundle (open), and the edits download's "will Load canvas open it". The
  CLI import (`fetchCLIGraph`) runs none of them, so nothing changes there;
  no check sits under another heading.
- Not this error, but the same limits under "Nebula couldn’t load the
  canvas.": a bundle's restore answers with the backend's own words
  ("graph.json is nested too deeply", "… contains too many values", "…
  contains a non-finite number", "… contains too many nodes", and the
  other `graph.json …` checks). Left as they are; a question for GM.
- Agents keep the engine's reasons: their writes get the backend's own
  ("graph payload is nested too deeply", pinned by a new backend test), and
  `load_graph_file` keeps its agent wording ("This graph is N MB …").
- The other three: "The canvas changed before this could finish. Check
  it, then try again.", "A canvas import interrupted the connection. Try
  again when the import finishes.", "The upload stopped because a canvas
  import started. Try it again or remove it." GraphFileActions' fallback
  file name is "the canvas".

## 43. GM r10 items 2–3: the pinned Inspector with no node

- The pinned popover stays on the screen when no node is selected, and the
  embedded Inspector draws its "No node selected" empty state, so the
  screen agrees with the store.
- One rule for every way the shown node goes: a store subscription clears
  the UI's selection with the pin kept when the node leaves the canvas (an
  Undo, an agent's delete, a sync). The person's Delete, a refused Delete's
  put-back, a reopen (Load canvas, another project) and an agent's focus
  request for a missing node keep the pin too now; before, they unpinned.
  Clearing the selection the person's way (clicking the empty canvas)
  still unpins.

## 44. Lines NIT-1 and NIT-2

- A test now checks that the lock line itself matches the forced-colours
  GrayText rule, not only the row.
- The "someone" shot: GM r9 item 1 kept the passive line, which has no word
  "someone". The round 6 shot is named for what it shows
  (`ll-r6-dropped-rename-unknown-passive-wasnt-1440.png`).

## 45. Agents

Agent-visible: the order and shape of the person's Undo steps for an
agent's edit made during a hold (Nebula's order across nodes; an edit the
person typed over is its own step above their typing). MCP-SETUP says so,
and that a pinned Inspector keeps its pin with "No node selected". No tool,
CLI command or answer shape changed; agents' error reasons are the
engine's, as before.

## Round 6 proof

Full suites run in CI. On this Mac: tsc, lint, and the changed and related
files at 2 workers, every npm and npx call with NO_UPDATE_NOTIFIER=1 and
npm_config_update_notifier=false.

- **tsc -b and lint** (with check:inline-styles and check:slava-css-scope):
  clean, rerun after the last edit.
- **Related vitest (276 files):** 4,269 of 4,269 passed, Errors 0, no
  timeouts. The 8 files changed after that run: 154/154.
- **Related backend (8 files, isolated):** 618 passed.
- **New tests on ce621ab5:** 54 of 242 fail, each where it tests new
  behaviour (the held step on top, the order across nodes, the newest
  copy's rename, the run fold, the pinned Inspector, the canvas lines and
  pickers). Those that pass there are guards over code only a mutant
  breaks (O9, O11, the lock line's GrayText) and controls.
- **Mutation (each guard's own files, clean baseline):** 39 mutants, 33
  killed. The six survivors are explained in sections 40–42.
- **Live** (8797/5797, isolated; the non-localhost canary aborted by
  interception and the 8001 canary refused before anything else ran, 0
  requests to 8000–8010/5173, nothing run or accepted against a provider):
  18/18. restoretype 5/5 (stack [Claude, own, Claude]; Undo 1 takes off
  the rename only, Undo 2 the typing, Undo 3 the connection; the canvas
  matches Nebula after each), restorehold 2/2, pinseveral, pinpaste, both
  limit lines, the pickers, the passive dropped-rename line.
  - 10 shots in scratchpad/lock-lines/shots6/; md5 `uniq -d` is empty. In
    the Save-limit shot the Brief card reads "[object Object]": the harness
    put a too-deep value in its text to make the canvas too complex.

## Round 6 questions for GM

1. The skipped-files line now starts "Nebula saved the canvas without N of
   its files." The rest of the line, kept from main, still says "graph".
   Reword that part too?
2. A bundle's restore details from the backend ("graph.json is nested too
   deeply" and the like) still show under the load heading as they are.
   Give them person lines, or keep them?
3. The CLI import runs no shape checks, so it has no line for them.
