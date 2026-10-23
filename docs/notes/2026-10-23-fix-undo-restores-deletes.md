# 2026-10-23 — Undo puts back everything a delete removed

Branch `fix/undo-restores-deletes`, from main at 54bf7cd6 (after #173). Worktree `nebula_nodes-undo-restores`. Backend, frontend and agent docs. No package installed, no paid provider call.

## What and why

Round 3f kept a confirm on every canvas delete because undo was incomplete. `DELETE /api/graph/node` also detaches the node's canvas pins and closes the open proposals that touch it. Cmd+Z put back the node, its params, outputs and edges, but left the pins detached and the proposals closed.

GM - Design's call (3g answers, item 1): "Delete: choose a), make undo complete. While a) builds, ship c) so the Delete key doesn't start asking on every delete. It asks only when a node has pins or open proposals; the toolbar, menu and Inspector paths keep the confirm until a) lands. When a) lands, every path becomes "Deleted {n} nodes." / "Deleted the node." with Undo. One condition: reopen a proposal only if it's still valid against the restored graph. If one can't be reopened, the Undo notice says so: "Restored {n} nodes. 1 proposal couldn't be reopened.""

This branch is a). Every canvas delete path deletes at once and shows GM's notice with Undo. Undo puts the pins back on their node and reopens the proposals that still pass Accept's checks.

### How it works

- **Removal records.** Every node delete now makes one record per node: `{id: "rm_<16 hex>", nodeId, pins, proposals}`. That covers `DELETE /api/graph/node`, `apply_graph_edit` removes (agents, MCP, CLI) and the removals inside a restore (redo).
  - The record comes back in the delete answer (`removal`), the apply and restore answers (`removals`), and the graphSync's `edit.removals`, so a person's undo of an agent's edit has it too.
  - The canvas keeps the records on the undo step (`UndoSnapshot.removals`, `ForeignEdit.removals`). The restore that brings the nodes back names them again (`POST /api/graph/restore` body `removals`). The agent's own `POST /api/graph/apply/undo` keeps them on its `EditRecord`.
- **The backend re-checks every item** (`main._undo_removals`). The list says where to look, never what to do.
  - A pin is re-attached only when all of these hold:
    - it is still detached;
    - its persisted `detachedBy` is this removal's id;
    - its `detachedFrom` is a node this restore actually brought back.
  - It goes back at its old anchor and position (`attachedPosition`). A pin whose attachment changed since (detached again by an import or a clear, so its `detachedBy` is gone) or that was deleted is left as it is and reported in `pinsLeft`. An agent's reply to a detached pin is not an attachment change, so that pin still goes back, reply and all (pins have no move action).
  - A proposal is reopened only when all of these hold:
    - its `closed_by` names this removal;
    - it is still closed by an invalidation (not accepted, dismissed or expired);
    - it hasn't passed its expiry;
    - it is in the active project;
    - it fits the open caps (3 per agent, 12 in all);
    - it passes Accept's own checks against the restored graph: `_refuse_overwriting_later_edits`, `_stage_proposal` and `_refuse_changed_runs`.
  - Asset (cover) proposals follow the same rule: `_follow_cover_proposals` tags `closed_by` during the delete's graphSync, and `_asset_reopen_misfit` checks them.
  - A forged or stale record (wrong id, someone else's pin, an unrelated proposal) matches nothing and changes nothing. A malformed `removals` body is a 400.
- **A restart.** Pins live in the catalog, so `detachedBy` and `attachedPosition` persist and pins come back after a restart. Canvas proposals are memory-only, so a proposal named in a record but gone after a restart counts as "couldn't be reopened".
- **Several nodes sharing a proposal.** `closed_by` is a removal→node map. A proposal closed by one delete and touching a node deleted later picks up the later removal too. Undoing only one of them leaves the proposal waiting, not counted. Undoing the other then reopens it.
- **Redo deletes again.** The redo's restore makes fresh records, the canvas merges them into the inverse step (`mergeRemovals`), and the next undo names the new ones.
- **Announcing it.**
  - Two new journal and event kinds: `pin.reattached` and `proposal.reopened`.
  - Browsers get `proposalOpened` (the bar and ghost come back), and expiry is scheduled again.
  - The agent's Update note is un-resolved (`AgentNotes.reopen_proposal`), so Review comes back.
  - The restore and undo answers carry `reattached`, `pinsLeft`, `reopened` and `notReopened` (`{id, reason}`).
  - The agent's undo message reads, for example, "Undone: put back 1. Also 1 pin back on its node; reopened 1 proposal."
  - `nebula undo` prints "Back on its node: …", "Reopened: …" and "Couldn't reopen X: reason".
  - `nebula watch` hints after `proposal.reopened`: "— waiting for the person again (nebula proposal X --wait)".
  - The docs are updated: `docs/MCP-SETUP.md` (remove_from_canvas, the events table, undo, a paragraph on removal records) and `skills/nebula/SKILL.md`. The MCP tool docstrings for `remove_from_canvas`, `undo_canvas_edit` and `get_proposal` grew additively; INSTRUCTIONS is unchanged.

### The canvas side

- The confirm is gone from the selection toolbar, the Delete/Backspace keys (`Canvas` `onBeforeDelete` → `allowCanvasDelete`, which now only keeps the World Labs held-delete refusals), the context menu and the Inspector. There is no command palette delete.
- Every delete shows "Deleted the node." / "Deleted {n} nodes." in `CanvasUndoNotice` (`role="status"`) with Undo. The notice's Undo runs the same undo as Cmd+Z.
- Undo shows "Restored the node." / "Restored {n} nodes." with Redo. When a backend node comes back, the line waits for the backend's answer so it can add "1 proposal couldn't be reopened." / "{n} proposals couldn't be reopened.".
- Redo shows "Deleted…" with Undo again.
- The person's undo of an agent's delete keeps its existing line, with GM's sentence appended when something couldn't reopen: "Undid Claude’s edit. 1 proposal couldn't be reopened."
- **Create Studio.** Its result delete removes canvas nodes too, so it gets the same notice. `StudioNotice` now shows the Undo button off the canvas (`CanvasUndoNotice`'s `messagesOnly` hides only foreign-edit and entry-less notices). Its count includes the orphaned input nodes the delete takes with it, so one result card can say "Deleted 2 nodes."
- **`frontend/src/lib/deleteConfirm.ts` is deleted.** No caller is left. Round 3f's delete-confirm tests in `errorCopy.round3f.notices.test.tsx` are removed, with a pointer to `undoRestoresDeletes.test.tsx`. If 3g's interim c) (the Delete key asks only when a node has pins or open proposals) lands first, merging it into this branch is a modify/delete conflict on that file. This branch wins: delete the file and the confirm, since a) is what c) was waiting for.

## Decisions, tradeoffs, surprises

- **Structural, not by words.** The ids travel with the edit, and the backend decides from its own state (`detachedBy`, `detachedFrom`, `closed_by`, status, expiry, Accept's checks). A list from a stale tab or a forged body can't attach someone else's pin or reopen an unrelated proposal (`test_a_forged_or_stale_list_attaches_nothing_and_reopens_nothing`).
- **Side effects run before the broadcast.** `_remove_side_effects` detaches and closes before the graphSync goes out, so the sync's `edit.removals` is complete. `_announce_removed_nodes` journals afterwards in the old order, so `node.removed` still comes first.
- **A partially restored shared proposal isn't counted** as "couldn't be reopened". It would come back with the other node, and saying it couldn't would be wrong after the second undo. It is listed nowhere until it reopens or the other node's step is dropped.
- **"No longer fits" is rare in practice.** Anything the person changes after a delete is a later undo step, so Cmd+Z undoes that first. The live check's first try (an API param change in between) undid the change, not the delete. In practice a proposal stays closed because of expiry, a restart or a full open cap. The cap case is the one the live check uses.
- **`reopen` checks status, not `closed_by`.** `_undo_removals` pops the matched removal ids before calling it. An earlier version checked the intersection after that pop and never reopened anything (caught by the shared-proposal test).
- **The journal drops unknown kinds silently.** The new kinds had to be registered in `canvas_events.EVENT_KINDS`, or the events never reached agents.
- **The restore's removals are computed lazily** inside the queued restore task, so a delete that is still in flight (its answer not back yet) has its record by the time the undo is sent (`restoreQueue = restoreQueue.then(() => deleting)`).
- **A record undoes one delete of one node** (second review). Node ids are not unique over time, so nothing matches a record, a proposal's tag or a pin by the bare node id. See "Second review" for how each place is bound.

## Tests (written first, red on 54bf7cd6)

- **Backend** `backend/tests/test_undo_restores_deletes.py`, 24 tests (29 after the review; see Review). On the base, **21 of 21 failed**: 14 `KeyError: 'removal'`, 4 `assert 200 == 400` (bad removals accepted), 2 `KeyError: 'removals'`, 1 `KeyError: 'reattached'`. Three tests were added after the first build:
  - nodes deleted together;
  - the CLI formatter;
  - the shared proposal reworked to the waiting rule.
- They cover the spec's edge cases:
  - several nodes sharing a proposal;
  - a restart;
  - an agent edit after the re-attach;
  - a second tab;
  - expiry;
  - another proposal accepted or dismissed in between;
  - redo then undo again;
  - a pin that was already detached before this delete;
  - a pin deleted since;
  - forged and stale lists;
  - malformed removals (4 cases);
  - an agent's delete undone by the person;
  - the agent's own undo;
  - MCP `remove_from_canvas` then `undo_canvas_edit`;
  - a cover proposal;
  - the CLI output.
- **Frontend** `frontend/tests/undoRestoresDeletes.test.tsx`, 9 tests (11 after the review, plus one in `components/CanvasUndoNotice.test.tsx`). On the base the file failed to import (no `lib/deleteNotice`). With the import stubbed, **9 of 9 failed**. They cover:
  - GM's lines;
  - the context menu, toolbar and Delete key with no confirm;
  - the notice's Undo and its restore body;
  - "couldn't be reopened";
  - redo then undo naming the new removal;
  - Create Studio's delete with Undo in `StudioNotice`;
  - an agent's sync removals and "Undid Claude’s edit. 1 proposal couldn't be reopened."

## Live check

Isolated backend on 8793 and Vite on 5793 (`VITE_NEBULA_BACKEND_PORT`), a temp HOME, and every key, token, `NEBULA_*` and `VITE_*` variable dropped. Puppeteer from the jev-demo driver. 8000-8010 and 5173 were blocked over CDP, plus a dead proxy. Run at 1280x800 and 1440x900.

- **24 PASS, 0 FAIL.** Blocked requests to 8000-8010/5173: 0. Outside requests refused: 0. The canary port 8799 was unreachable. No native dialogs, no page errors.
- Toolbar, Delete key, context menu, Inspector: each deleted at once with "Deleted the node." and Undo as a status, detached the pin and closed the proposal. The notice's Undo (toolbar) and Cmd+Z (the rest) gave "Restored the node.", with the pin back on n1 and the proposal bar up.
- Agent at its open cap: "Restored the node. 1 proposal couldn't be reopened."
- After a backend restart: the pin was back on its node and the lost proposal counted: "Restored the node. 1 proposal couldn't be reopened."
- MCP `remove_from_canvas` answered with its removal. The person's Cmd+Z gave "Undid Claude Code’s edit", and the agent saw the proposal open, the pin anchored and the events `pin.reattached` and `proposal.reopened`.
- The agent's own `undo_canvas_edit`: "Undone: put back 1. Also 1 pin back on its node; reopened 1 proposal."
- After a reload, the node, its pin and the proposal bar were all there.

## Gates

Final run, after the review fixes. The machine was loaded by other sessions (load average around 20).

- **Backend** `pytest -q` (whole suite): **10,214 passed, 71 skipped, 0 failed** in 7 min 31 s. This includes the 5 new review tests; `test_undo_restores_deletes.py` now has 29 tests.
- **Frontend** `npx vitest run` (whole suite): 6 files and 16 tests failed, out of 381 files and 4,927 tests (4,911 passed). 10 of the 16 were "Test timed out"; the rest were slow `findBy` waits in the same files. Rerun alone, those 6 files passed: 137 of 137. None of them touch this change.
  - The first full run after the review fixes caught a real bug: `ProposalBar.test.tsx`, 16 of 17 failed. Its store mock leaves `undoNotice` undefined, and the new hold check read `notice.id` behind a `!== null` test. Fixed (`heldId === notice?.id`), and ProposalBar passes in the full rerun.
  - The first build's run (before the review) had 99 files failing under heavier load. That was 162 timeouts plus one real failure, `SelectionToolbar.test.tsx`, which still expected the delete confirm and was updated.
- `tsc -b`: 0 errors.
- Lint: 0.
- `vite build` plus the budget check: entry 363,233 bytes raw / 109,072 gzip, under 512,000.

## Open items

- **The floating Inspector can cover the canvas notice** at 1280x800 when it opens beside a node low on the screen (live-review shot `cover-restart-1280.png`). This was already the case before this branch, but the notice now carries the delete's only on-screen Undo. A layering fix (notice above the Inspector, or the Inspector avoiding the notice's band) belongs in a small follow-up.

- **Clear canvas and graph import** still replace the graph without removal records. Their own undo is unchanged by this branch.
- **Pins the person deleted since** are reported to agents (`pinsLeft`) but not in the person's notice. GM's notice only names proposals.
- **`replaces` doesn't survive a restart unless a pin proves it** (second review). The ledger of minted removals and the "this restore undid that removal" memory are in memory, like the undo book. After a restart, a restore that puts a pin back still records what it undid (the pin's persisted `detachedBy` proves it), but a node with no pins brought back across a restart has nothing to prove it. Its next delete then replaces nothing, and an older step naming the spent removal leaves the proposal closed and uncounted. Rare (it needs an undo, a restart, a redo and then an older undo, all on a node with no pin), and it fails safe.
- ~~An agent that reads the person's removal ids off the WebSocket can still name one in a restore of its own.~~ Closed: see "Only the person's restore carries removal records" below.

## Review

Five findings from the adversarial review, each confirmed by a refuter. Each one got a test that failed on the first build, then the fix. Red runs are in `undo-restores/red-review-backend.txt` and `red-review-frontend.txt` in the session scratchpad.

- **Cover proposals read the saved snapshot** (`main._asset_reopen_misfit`). The reopen check didn't pass the live export, so `_cover_images_now` read the stored snapshot. The canvas autosaves after every edit, and that save drops the deleted node's image, so Undo said "1 proposal couldn't be reopened" for a cover that should have reopened. It now checks against `_projects_live_export()`, the same as Accept and the sweep. `_undo_removals` builds that export once per undo. Test: `test_a_cover_proposal_reopens_after_the_canvas_autosaved_the_delete`. It was red with `notReopened: "that image is no longer one of the project's images"`.
- **An agent's undo after the person undid and redid its delete** left the pin detached and the proposal closed, and counted nothing. The redo deleted the node again under a new removal, and the agent's `EditRecord` still named the old one. The same thing happened when the person undid the agent's own undo.
  - Fix: `CanvasUndoBook.renew_removals`, called by `main._renew_kept_removals` after the graphSync of every delete path (DELETE, apply, restore). A node has one live removal, its latest. Every kept edit in the open project that names that node takes the new record. A node the record didn't name is never added. The backend still re-checks every id.
  - This replaces the reviewer's suggested fix, which patched only `_journal_restored_edit`. That would have covered the two linked restores but missed any other path that deletes the same node again.
  - Tests: `test_an_agents_undo_after_the_person_undid_and_redid_its_delete` and `test_an_agents_undo_again_after_the_person_undid_its_undo`. Both were red with `reattached == []`.
- **Cover proposals lost to a restart weren't counted.** A cover proposal closes during the delete's graphSync, after the record is made, so the record never named it. `_follow_cover_proposals` now adds its id to the records' `proposals`, and it runs before the graphSync goes out, so the sync's `edit.removals` carries the id too. The apply path now copies its undo record after the sync.
  - After a restart, `_undo_removals` finds neither book has the id and counts it (`_PROPOSAL_GONE`). Without a restart it reopens once and isn't counted twice.
  - The person's tabs now get `assetProposalClosed` just before the graphSync instead of just after.
  - Tests: `test_a_cover_proposal_lost_to_a_restart_is_counted` and `test_an_agents_cover_loss_after_a_restart_is_counted_in_its_undo`. Both were red because the id wasn't in `removal.proposals`.
- **The canvas's older steps kept a spent removal** (`graphStore.renewStackedRemovals`). Example: an agent deletes a node, the agent undoes, and the person presses Cmd+Z twice. The first Cmd+Z deleted the node again under a new removal, and only that step took the new record. The second Cmd+Z named the old one, so the pin stayed detached and the proposal stayed closed, with no count.
  - Now every stacked step (undo and redo) that names the node takes the new record, wherever one arrives: a restore's answer, this tab's own delete answers, and another tab's or an agent's graphSync `edit.removals`.
  - Tests in `undoRestoresDeletes.test.tsx`: "the agent's delete, its undo, then Cmd+Z twice names the newest removal" and "another tab's undo then redo of this tab's delete renews this tab's step too". Both were red: the old `rm_` was still named.
- **The notice's hold didn't pause** (`CanvasUndoNotice`). The notice left 6 s after it appeared, even with the pointer on it or focus on Undo. Now that the delete confirm is gone, the notice's Undo is the on-screen way back.
  - It now waits while the pointer is over it or focus is inside it (WCAG 2.2.1), and starts a full hold again once both leave. The hold is tracked by notice id, so a new notice starts its own.
  - Undo and Redo got `aria-keyshortcuts` (Meta+Z / Control+Z; with Shift for Redo).
  - Test in `components/CanvasUndoNotice.test.tsx`: "waits while focus or the pointer is on it, then goes after a full hold". It was red because the notice left while Undo had focus.
- **Docs** (additive only): `docs/MCP-SETUP.md` says a removal record's `proposals` also names the cover proposals the delete closed, and that an agent's undo token follows a redo of its delete or an undo of its undo. `skills/nebula/SKILL.md` has one matching sentence. No tool, INSTRUCTIONS or message text changed.
- **Live check, round 2.** Isolated backend on 8793, Vite on 5793 (`VITE_NEBULA_BACKEND_PORT=8793`), temp HOME, no keys. 8000-8010 and 5173 were blocked over CDP plus a dead proxy. Run at 1280x800 and 1440x900. Script: `undo-restores/live-review/live-review.mjs` in the session scratchpad.
  - Result: **26 PASS, 0 FAIL**. Blocked requests: **0**. Outside requests refused by the backend guard: 0. No page errors, no native dialogs.
  - The four person delete paths all passed again.
  - The notice stayed 8 s with the pointer on it, then left a full hold after the pointer moved away. It stayed 8 s with focus on Undo, and Enter restored the node with its pin and proposal.
  - MCP `remove_from_canvas` + `undo_canvas_edit`, then the person's Cmd+Z twice: the pin was back on n1, the proposal open, and the notice read "Undid Claude Code’s edit" with no count.
  - The person's Cmd+Z and Cmd+Shift+Z of an agent's delete, then the agent's own undo over MCP: "Undone: put back 1. Also 1 pin back on its node; reopened 1 proposal."
  - A cover proposal after the canvas autosaved: "Restored the node." and the proposal was open again.
  - The same after a backend restart: "Restored the node. 1 proposal couldn't be reopened."
  - After a reload, the node and its pin were there. There was no proposal bar, since the restart drops canvas proposals; the first live run's check expected one, and that check was wrong.
- **Seen in the live check, not caused by this branch:** at 1280x800 the floating Inspector, open beside a node low on the screen, covers the right end of the bottom notice ("Restored the node. 1 proposal couldn't …"). It is fine at 1440x900. See the open items.

## Merging main after round 3g (#174)

- 3g shipped GM's interim option c): the Delete key asked only when a node had a pin or an open proposal (`lib/deleteConfirm.ts`'s `deleteLosesAttachments`, pinned against the backend's delete through `backend/tests/fixtures/delete_confirm_cases.json`). This branch makes undo complete, so GM's condition for dropping the confirm holds, and the merge takes this branch's side: no confirm on any path. Removed with it: `deleteConfirm.ts`, the fixture and its backend test, `frontend/tests/errorCopy.round3g.deleteKey.test.tsx`, the toolbar-confirm and Delete-key-rule cases in `errorCopy.round3g.test.tsx`, and Canvas.tsx's imports of the three stores that rule read. 3g's other work (ports in quotes, shot wording, the chip, readiness, Gemini Omni) is untouched.
- After the merge: tsc and lint clean; the 3g, 3f, undo, Canvas, SelectionToolbar and notice test files 67 of 67 (frontend) and 92 of 92 (backend).

## For GM

The notice lines as built:

- Any delete (toolbar, Delete key, context menu, Inspector, Create Studio): "Deleted the node." / "Deleted {n} nodes.", with Undo.
- Undo: "Restored the node." / "Restored {n} nodes.", with Redo.
- Undo when something couldn't reopen: "Restored {n} nodes. 1 proposal couldn't be reopened." / "Restored the node. 2 proposals couldn't be reopened."
- Redo: "Deleted the node." / "Deleted {n} nodes." again, with Undo.
- The person's undo of an agent's delete: "Undid Claude’s edit." plus " 1 proposal couldn't be reopened." when one couldn't.
- Create Studio's result delete counts the input nodes it takes with it, so one card can read "Deleted 2 nodes."

What undo still can't restore, and why:

- **Canvas proposals after a backend restart.** Proposals live in memory only. Counted in the notice.
- **Proposals past their 15-minute expiry**, or closed more than 30 minutes ago (pruned). Counted.
- **Proposals when the agent already has 3 open (or 12 are open in all).** Reopening would break the cap. Counted.
- **Proposals that no longer pass Accept's checks** against the restored graph. In practice this is rare, because a change the person makes after the delete is undone first. Counted.
- **Asset (cover) proposals after a restart.** Memory-only like canvas proposals. Counted (since the review fix below).
- **Pins the person deleted since the delete, or a pin an import or a clear detached again since.** Left as they are. Agents are told (`pinsLeft`); the notice says nothing (GM, 2026-10-23: "stay silent. You did that yourself.").
- **New since the second review: proposals closed before a clear, an import or a project switch.** Node ids start again after a clear or an import, so a later "n1" may be another node. Undoing a delete from before one of those still puts the node and its pins back, but its proposals stay closed. Counted: "Restored the node. 1 proposal couldn't be reopened." (reason "the canvas was cleared since" / "the canvas was replaced since").
- **New since the second review: a pin whose node came back as a different model.** It stays detached. Agents are told, and since GM's answer the notice counts it: "Restored the node. 1 pin couldn't be re-attached.", or with proposals "Restored {n} nodes. 1 pin and 2 proposals couldn't be restored." (see "Line 7" below).

## Second review

A second independent review confirmed five defects, each reproduced (scratch tests in the session scratchpad's `undo-second-review/`). They share one root cause: a removal record was bound to a bare node id, and node ids are not unique over time. An import or a clear restarts CLIGraph's counter at n1, a restore may place any id, and every project has its own n1. The structural fix: **a record reverses exactly one delete of exactly one node, and nothing matches it by node id alone.** Base for this round: 71b4ef66 (the feature plus the merge of main).

### The five findings and their fixes

1. **(medium) Renewal keyed on the node id.** After an import gave n1 out again, `renewStackedRemovals` (canvas) and `CanvasUndoBook.renew_removals` (backend) rewrote an older step that deleted X with the record of a later delete of Y. Undo then put Y's pin on X and left X's own pin detached.
   - Fix: a new `services/node_removals.py` (`RemovalLedger`). It remembers what each removal id was minted for (node id, project, model), and, per node a restore brought back, the removal that restore undid. The next delete of that same node names it: `replaces: <that id>`.
   - Both renewals now swap only items whose id equals `replaces`. A node an import, a clear or a plain add put under the id has consumed nothing, so its delete replaces nothing. `mergeRemovals` drops only the records a fresh one repeats or replaces.
   - `replaces` survives `cleanRemovals` and the restore body's validation (`_restore_removals`, which also checks its shape).
2. **(low) The renewal read the project after an await.** `_renew_kept_removals` read the active project after the delete's graphSync, so a project switch in that window renewed the other project's records.
   - Fix: the record carries `projectId`, set in `_remove_side_effects` right after the mutation, before any await. `renew_removals` matches only kept edits of the record's own project. `_undo_removals` ignores a record that names another project.
   - The restore captures its project inside the mutation too. If another project is open by the time the pins and proposals are checked, it touches nothing and reports each one as "another project is open now". `CanvasPins.reattach` checks the project inside the catalog transaction.
   - Canvas side: the delete answer and the restore answer skip the renewal when the canvas was replaced while they were on their way (the existing `canvasReplacementRevision`). With id-only matching an old project's records can't match anyway, so this is a second guard.
   - Surprise: on the base, a delete answer that landed after a project switch also took the new project's n1 off the canvas. That has been so since before this branch. It now applies no change and shows no notice; the step keeps its records.
3. **(medium) Proposals were tagged across projects and graphs.** `invalidate_referencing` tagged every invalidated proposal that read the node id, whatever its project. After a clear, a later delete of a new n1 and its undo reopened a proposal from the old graph. In another project the proposal was counted as "couldn't be reopened".
   - Fix: only proposals in the delete's own project are tagged, for both the closed ones and the "needs this node too" ones. A record's `proposals` lists only the ones it tagged.
   - `invalidate_all` (clear, import, project open, create or delete) now calls `drop_removal_tags`. The tags move to `dropped_by`, with the reason. Asset proposals get the same call at the same two places (clear, and the replaced-graph branch of `_broadcast_graph_sync`). `_follow_cover_proposals` tags only from records of the cover's own project.
   - A proposal whose tag was dropped is counted in `notReopened` ("the canvas was cleared since" / "the canvas was replaced since") when its delete is undone, so the notice stays honest.
4. **(medium) A forged record spoiled the real undo.** `_undo_removals` kept any record whose node was in `back` and popped `closed_by` entries by removal id alone, before its checks. So `{id: rm_A (real), nodeId: n9 (wrong)}` left the proposal closed and uncounted.
   - Fix: matching is by `(removal id, node id)` pairs (`ProposalBook.closed_by_pairs`, inherited by asset proposals, project-filtered). Nothing is popped any more: the tags stay until the proposal reopens (`reopen` clears them). The "still waiting on another delete" rule reads the tags that don't match this undo's pairs. A record the ledger minted for another node, project or model takes part in nothing but the pin check.
   - `closed_by_removals` (id-only) is gone.
5. **(low) An agent could move the person's pin onto another model.** A restore with `nodes: [{id: n1, definitionId: <another model>}]` and the pin's removal re-attached the pin, and the person's own undo then 409'd.
   - Fix: a pin detached by a delete keeps `detachedDefinition`, persisted with `detachedBy`. It goes back only when the node came back as that model, in the same project, with the same `detachedFrom` and `detachedBy`. Otherwise it is left, with `pinsLeft` reason "its node came back as another model". The check holds after a restart.
   - **Decided:** `detachedBy`, `detachedDefinition` and `attachedPosition` are never shown to anyone. `canvas_pins.public_pin` strips them from `list()` (REST, the person's `canvasPins` socket message, `agent/start`), `for_agents()` (the canvas snapshot and `look_at_canvas`) and the add, resolve and remove answers. The person's canvas never used them. Agents undo through their own `EditRecord`, which the backend holds, so they don't need removal ids.

### Other places that matched by bare node id

- **`removalsFor`** (canvas): a step names only the records of the nodes it brings back as the model each record was made for (`definitionId`).
- **`mergeRemovals`**: by `replaces` and id, not node id.
- **Cover proposals**: project-bound tags and pair matching (above).
- **Persistence across a restart**: a pin carries its own binding (`detachedBy`, `detachedFrom`, `detachedDefinition`). After a restart the ledger is empty, so `verdict` is "unknown". Pins still check their own fields, and a restore that puts a pin back records what it undid, so the node's next delete still says `replaces`. See the open item about nodes with no pins.
- **`pinsLeft` reporting**: only for pins a record bound to this restore names, or a pin whose `detachedBy` matches.
- **The "needs this node too" tag** (found by this round's live check). A proposal closed by the person's delete of X also picked up a tag from the delete of another node an agent had put under X's id, because the rule matched the bare id. The person's undo of X then found it still "waiting" on that other node and left it closed, uncounted.
  - Fix: `RemovalLedger.lineage` names which node sits under an id. A node keeps its lineage through deletes and the undos that bring it back. A node a plain add put there is the generation's own (`g<n>`, bumped by a clear or an import). Anything else a restore put there (no record of its own, or one minted for another node) gets a new one.
  - A proposal keeps the lineage of each node it reads (`Proposal.lineage`, set when it is made). A delete tags it, closing or "needs too", only when it took that very node.
  - Tests: `test_another_node_under_the_id_doesnt_tag_a_closed_proposal` (red on the base and on the first fix), and `test_the_same_node_brought_back_still_tags_a_shared_proposal` (a guard; it passes on both).
- Kept: an open proposal that reads a deleted node id still closes. Every open proposal is the current graph's: a project switch closes them all.

### Record shape now

`{id, nodeId, projectId, definitionId, replaces?, pins, proposals}`. Agents see it in the delete, apply and restore answers and in `edit.removals`. The message texts are unchanged; the docs grew additively. `docs/MCP-SETUP.md` covers the record fields, the binding, the dropped tags, the new `pinsLeft` reasons and the hidden pin fields. `skills/nebula/SKILL.md` has one paragraph, and the `remove_from_canvas` docstring one clause. INSTRUCTIONS is unchanged.

### Tests (written first, red on 71b4ef66)

- **Backend:** `backend/tests/test_undo_removal_binding.py`, 24 tests. Run against an export of 71b4ef66: **22 failed, 2 passed**. The two that passed are guards: "a node an import put under the id replaces nothing", which the base trivially satisfies because it has no `replaces`, and the shared-proposal re-tag. The 22nd failure is the lineage test, added after this round's first live run.
  - 6 failed with a `KeyError` (`projectId`, `replaces`, `detachedDefinition`).
  - 9 failed on the behaviour itself: the pin moved, tags across a clear or another project, a forged record counted, `detachedBy` visible to agents, the race renewed project B's record.
  - 5 failed because the base accepted bad `replaces`, `projectId` or `definitionId` values (`200`, not `400`).
  - 1 failed because the base's restore body dropped the binding fields.
  - Red output: the session scratchpad's `undo-fix/red-backend.txt`.
- `test_undo_restores_deletes.py`: reads `detachedBy` from the stored catalog now (`_stored_pins`), since the API no longer shows it. It also checks the three undo fields are gone after a re-attach.
- **Frontend:** `frontend/tests/undoRestoresDeletes.test.tsx`, 6 new tests plus 2 updated (the older renewal tests' later records now carry `replaces`, as the backend sends them). On the base: **8 of 17 failed**:
  - import reuse: X's step named Y's record;
  - an unrelated `replaces` renewed the step;
  - the model filter;
  - the binding fields dropped by `cleanRemovals` (3 tests: the 2 updated ones and the round-trip);
  - after a project switch, the new project's step renewed and its n1 taken off the canvas (2 tests).
  - Red output: `undo-fix/red-frontend.txt`.
- **The review's own scratch probes, run on the fix:**
  - Pass now: the clear revive (both cases), another project's proposal, and the import baseline.
  - Fail now, as intended: the hijack, forged-record and pin-move probes read `detachedBy` off the agents' pin list, which no longer has it (their asserts are covered by the new tests). The race probe asserts the old wrong renewal.
  - `test_detached_by_survives_a_clear_and_restore_reattaches` (not one of the five) still re-attaches. After a clear, a restore of a same-model node at the same id with the person's real removal puts the pin back. That is also the legitimate path: the person's Cmd+Z of the clear, then of the delete.
  - `test_backend_renewal_after_import_undo_crosses_nodes` still "passes". It feeds X's restore with Y's record, which is what the old canvas did. The fixed canvas never sends that (X's step keeps X's record; `replaces` is the only way a step is renewed). The backend can't tell two same-model nodes under one id apart from a record alone, so a client that sends another node's real record of the same model is trusted that far. See the open item about the WebSocket.

### Live check (second review)

- Isolated backend on 8795 and Vite on 5795 (`VITE_NEBULA_BACKEND_PORT=8795`), a temp HOME, every key, token, `NEBULA_*` and `VITE_*` variable dropped, and outside requests refused by the backend guard. 8000-8010 and 5173 were blocked over CDP plus a dead proxy; the canary port 8799 was unreachable. Shots at 1280x800 and 1440x900. Script: the session scratchpad's `undo-fix/live/live-review.mjs` (round 2's, plus the new checks).
- **First run: 31 PASS, 1 FAIL.** The failure was real: after the forged restores, the person's undo put X and its pin back, but the proposal stayed closed and the notice said nothing. That was the "needs this node too" tag above. Fixed with a test first.
- **Second run: 32 PASS, 0 FAIL. Blocked requests: 0. Outside requests refused: 0.** No page errors, no native dialogs.
  - Round 2's 26 checks all passed again: the four delete paths, the hold, MCP remove and undo, the cover proposal, the restart and the reload.
  - **Import reuse (finding 1).** The person deleted X (n1) from the toolbar. A graph import put Y under n1, and the person pinned Y. Cmd+Z of the import, then Cmd+Z of X's delete: X came back with its own text and its own pin, and Y's pin stayed detached. The notice read "Restored the node. 1 proposal couldn't be reopened.": the import spent X's proposal tag.
  - **Agents can't read the removal id.** The REST pin list (as an agent) and `look_at_canvas` over a real MCP stdio session showed the detached pin without `detachedBy`, `attachedPosition` or `detachedDefinition`.
  - **Forged restores (findings 4 and 5).** As an agent: the person's real removal id under a made-up n9, and the person's pin's removal with a Nano Banana under n1. Nothing was re-attached or reopened, and nothing was counted. The second answered `pinsLeft` "its node came back as another model". The pin stayed detached under the same removal. The agent then removed both nodes.
  - The person's four Cmd+Z back to their own delete then gave "Restored the node.": X back, its pin on it and the new proposal open.

### Gates (second review)

- **Backend** `pytest -q` (whole suite): **10,248 passed, 71 skipped, 0 failed** in 10 min 32 s.
- **Frontend** `npx vitest run` (whole suite): 5 files and 14 tests failed out of 382 files and 4,945 tests (4,931 passed), under load. 9 of them were "Test timed out"; the rest were slow waits in the same files. The 5 files rerun alone passed: 129 of 129. None of them touch this change (CommandPalette, GraphFileActions, NodeLibrary, Settings, ResultsGallery).
- `tsc -b`: 0 errors.
- Lint: 0.
- `vite build` plus the budget check: entry 363,426 bytes raw / 109,187 gzip, under 512,000.

## Third review

- **Review (low): an import cleared the removal ledger too late.** `import_graph` committed the new graph and then awaited `_broadcast_graph_sync`, and only that sync's last line called `node_removals.forget_project`. A delete of the imported n1 landing during the sync's awaits (export, cover proposals, the broadcast, pins, closed proposals) was minted while the ledger still held the old node's entry. So Y's record said `replaces: rm_A` and carried X's lineage, which is finding 1 again, through a race.
  - Fix: the reset moved into the import's `_paid_graph_mutation` block, right after the commit and before any await, as `clear_graph` already did. The call at the end of the sync is gone, not kept as well: a second reset after the awaits would forget a delete-and-undo that landed during the sync, so the node's next delete wouldn't name its removal.
  - Same cause, one more path (found while checking every place ids start again): deleting the open project leaves the unfiled canvas (no project), empty, its ids starting again at n1. The ledger's no-project entries outlived it, and the same API sequence gave a fresh n1's delete an old `replaces`. `delete_saved_project` now resets the no-project ledger in its mutation block. Project open and create don't need it: a project opened brings back its own nodes, and a new project has no entries.
  - Tests (written first, all 3 red on this round's base): `test_a_delete_during_an_imports_sync_replaces_nothing` (Y's record had `replaces`), `test_an_undo_during_an_imports_sync_is_still_remembered` (the late second reset dropped what the undo recorded: `replaces` was None), `test_deleting_the_open_project_starts_the_unfiled_ids_again` (Y's record had `replaces`). The race tests hook `manager.broadcast_raw`, a real await point of the sync. The reviewer's probe file passes now (8 of 8).
  - Backend only; no field agents read changed, so the docs stay as they are. Live check rerun on 8795/5795 below.
  - Live check, rerun on this fix: backend 8795, Vite 5795 (`VITE_NEBULA_BACKEND_PORT=8795`), the same isolation and blocking as the second review, 1280x800 and 1440x900. **32 PASS, 0 FAIL. Blocked requests: 0. Outside requests refused: 0.** It includes the import-reuse chain (X back with its own pin, Y's pin still detached), the forged restores over a real MCP stdio session, and the round-2 checks. The race itself can't be timed from a browser; the tests cover it.
  - Gates: backend whole suite **10,251 passed, 71 skipped, 0 failed** (the 10,248 before plus the 3 new). No frontend file changed this round: `tsc -b` 0 errors, lint 0, `vite build` plus budget 363,426 bytes raw / 109,187 gzip (unchanged), and `undoRestoresDeletes.test.tsx` 17 of 17. The whole vitest suite wasn't rerun.

## Only the person's restore carries removal records

- **The gap (flagged by the third round's fix lane).** Every socket gets the graphSync's `edit.removals`, agents' too. With the second review's bindings an agent's restore naming the person's real record still worked when it brought back the same model under the same id: it re-attached the person's pin (pins are person-only: creating one needs the person, and pins have no move action) and reopened the proposal. The test reproduced it on this branch: `reattached` listed the person's pin.
- **Fix.** `POST /api/graph/restore` ignores `removals` unless the caller is the person (`_is_person_request()`), the same rule it already applies to `edit`. The nodes and wires still go back (anyone may restore); only the pins and proposals don't. An agent's own undo (`POST /api/graph/apply/undo`) is unaffected: it calls `_restore_graph` with the records the backend kept on the edit, never through that field. The only client of the route is the person's canvas (graphStore.ts), so nothing else loses anything.
- Hiding `edit.removals` from agents' sockets instead was the other option. It would change what every socket's graphSync carries, and once agents' restores ignore the records, seeing the ids gives an agent nothing to act with. So the gate is the smaller and stricter change.
- **Tests (written first):** `test_an_agents_restore_cant_use_the_persons_removal_record` (red on this branch: the agent's restore re-attached the pin), and `test_an_agents_own_undo_still_puts_back_what_its_delete_removed` (green before and after). The finding-4 and finding-5 tests that sent a forged record as Claude now send it from a person's tab (a stale or forged list), so they still exercise the (removal, node) pair and model checks instead of passing at the gate; `test_an_agent_cant_move_the_persons_pin_onto_another_model` is now `test_a_stale_record_cant_put_the_pin_on_another_model`.
- **Agents:** docs/MCP-SETUP.md says a restore from anyone but the person ignores `removals` and its answer's four lists stay empty. No agent text changed. skills/nebula/SKILL.md never mentions the restore route (agents use `nebula undo`), so it stays.
- **Live check** (the second review's script, its forged-restore probe changed): it now sends, as an agent, a real removal id under a made-up n9, plus the person's whole real record (id, node, project, model, pins, proposals) with X itself, the same model under the same id. That second one is the restore that used to re-attach the pin. Both answered with all four lists empty. The pin stayed detached under the same removal, the proposal stayed closed, and the person's own Cmd+Z back to their delete then put X, its pin and the proposal back ("Restored the node.").
  - Backend 8795, Vite 5795 (`VITE_NEBULA_BACKEND_PORT=8795`), same isolation and blocking as before, 1280x800 and 1440x900, a real MCP stdio session.
  - Four runs. r4: 31 PASS, 1 FAIL. r5, r6 and r7: **32 PASS, 0 FAIL**. r6 and r7 ran while the whole gate suite was running. Blocked requests: 0. Outside requests refused: 0.
  - r4's one miss: the context menu's Cmd+Z read no notice at all within 8 s, though the node, its pin and the proposal were all back. It didn't come back in the next three runs.
  - A timing probe was added for r6 and r7. On every path the node returns in under 15 ms and "Restored the node." shows 158-188 ms after the keypress, once the backend has answered.
  - The only code path that skips that line is a newer notice taking its place, which is by design, and nothing in this flow raises one. So r4 reads as a one-off stall, not a skipped line. The probe stays in the script so a repeat would say which it was.

- **Gates** (on f8ff0356, with main at 43d43186 merged in):
  - Backend, whole suite in 4 shards: **10,253 passed, 71 skipped, 0 failed** (the 10,251 before, plus the 2 new tests).
  - `tsc -b`: 0 errors. Lint: 0.
  - `vite build` plus the budget check: 363,426 bytes raw / 109,187 gzip, the same as before.
  - Whole vitest suite: **4,945 of 4,945 passed**, 382 files.

## Line 7: a pin on another model is counted (GM, 2026-10-23)

GM approved a)'s lines as built and answered the two pin cases: "6, a pin you deleted after the delete: stay silent. You did that yourself. 7, a pin whose node came back as a different model: count it like proposals. "Restored the node. 1 pin couldn't be re-attached." When both apply: "Restored {n} nodes. 1 pin and 2 proposals couldn't be restored.""

- **Counted by a code, not by words.** Every `pinsLeft` entry now carries a `code` next to its `reason`: `deleted`, `changed`, `another-model` or `another-project` (`canvas_pins.PIN_LEFT_CODES` and `pin_left`, used by every place that leaves a pin). The canvas counts only `another-model` (`pinsOnAnotherModel`), so rewording a reason for agents can't change the notice. The field is additive for agents; the reasons are unchanged.
- **Lines.** `notRestoredText(pins, proposals)`: "1 pin couldn't be re-attached." / "2 pins couldn't be re-attached." alone, "1 pin and 2 proposals couldn't be restored." with proposals (GM's form, my plurals), and the proposal-only line as before. The person's undo of an agent's edit gets the same tail: "Undid Claude’s edit. 1 pin and 1 proposal couldn't be restored."
- **How often it shows.** Rarely, through the person's own canvas: a step names only the records of the nodes it brings back as the model each record was made for (`removalsFor`, second review), so the canvas doesn't send a record for a node that comes back as another model. The line shows when the backend finds the mismatch itself, for example from a record without `definitionId`. A record the canvas filters out is not counted, since the canvas can't tell whether its pin was deleted since (silent) or is still waiting.
- **Tests (written first).** Backend: 4 red on 0acb7ca4 (the PR head before this change), all for the missing `code`. They are `test_a_stale_record_cant_put_the_pin_on_another_model`, `test_a_pin_deleted_since_is_left_and_reported` (both updated), `test_a_stale_record_for_a_pin_a_later_delete_detached_says_changed` (new; the first test of the "changed since" path) and `test_a_pin_in_another_project_is_left_with_its_code` (new). Frontend, `undoRestoresDeletes.test.tsx`: 5 new, 4 red (the lines, the count with deleted and changed pins quiet, pins and proposals together, the agent's edit). The fifth, "a pin left without a code is quiet", is a guard that passes either way. Red output: the session scratchpad's `undo-line7/`.

- **Review** (two lenses, each finding verified):
  - Correctness found nothing. It confirmed the 4 frontend tests are red on 0acb7ca4 by running them on an export, and that every pinsLeft writer goes through `pin_left`, so the code lookup can't raise.
  - The contract lens raised two findings:
    - Refuted: "line 7 effectively never shows", since the note's example (a record without `definitionId`) does reach it.
    - Confirmed, and older than this change: `undo_canvas_edit`'s docstring left out `pinsLeft`, `wired` and `unwired`, and said its `message` tells what was left, which wasn't true for pins.
  - Fixed on every agent surface, tests first (2 red):
    - The undo `message` adds "1 pin left as it is (pin_3: deleted since)".
    - `nebula undo` prints "Couldn't re-attach pin_3: deleted since".
    - The tool docstring lists every field, `pinsLeft` as `{id, reason, code}` with its codes.
    - SKILL.md names the new CLI line.
  - These additions show only when a pin was left. Every existing message is unchanged.
