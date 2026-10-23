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
- **Pins the person deleted since the delete, or a pin an import or a clear detached again since.** Left as they are. Agents are told (`pinsLeft`); the notice says nothing, since GM's line covers proposals only.
