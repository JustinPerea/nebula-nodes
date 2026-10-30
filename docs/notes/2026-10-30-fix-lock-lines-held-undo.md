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
  P15, P16, the three-press test, H1 (L-5), P16 echo-first; round14 Q2b, Q7,
  Q8, Q9, Q11, Q12; round15 M5 and the typing-between test; round16 P7) pin
  the drop. For GM (question 4).
- Two other restored tests differ from their old text: E2's restore carries
  n1 as it was deleted (the later typing happened while it was off the
  canvas), and P14's agent load drops the held press with the dropped line
  and no Codex notice (the node had already left at Delete, so the load
  changed nothing on the canvas).
- **Tests.** The 65 tests in the 7 files #195 rewrote are restored to the
  held behaviour: canvasDeleteInFlightUndo.round11 (11), heldUndoBound.round12
  (11; H10–H12 now read the 15 s line), heldUndo.round13 (21), round14 (12),
  round15 (6), round16 (3; "control (r14 Q10)" is silent now), round18 (1,
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
