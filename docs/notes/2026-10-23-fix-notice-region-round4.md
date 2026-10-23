# 2026-10-23 — Notice region, round 4: GM's trims, late lines above, the trim timeline

Branch `fix/notice-region-round4`, from main `fc1f772b` (after #180). Frontend only: no backend file changed. No package installed, no paid provider call.

## What changed and why

GM - Design answered #180's "For GM". The person-required banners are #178's and are not touched here.

- **Late lines drop the node word.** GM: "LATE LINES: drop the node word, which fixes the mismatch for good."
  - `lateRestoreText` (lib/deleteNotice.ts) now gives GM's lines, verbatim: "After the restore, 1 proposal couldn't be reopened." / "After the restore, {n} proposals couldn't be reopened.", "After the restore, 1 pin couldn't be re-attached." / "After the restore, {n} pins couldn't be re-attached.", and for both "After the restore, {p} pin(s) and {q} proposal(s) couldn't be restored.", each noun by its own count ("1 pin and 2 proposals", "2 pins and 1 proposal", "1 pin and 1 proposal").
  - The × Dismiss stays (GM: "Keep the × Dismiss.").
- **The late line goes above the newer notice.** GM: "With two notices showing, put the late line above the newer one, so the notice with a button stays nearest the bar."
  - In lib/noticeSlots.ts, `'late'` moves from after `'notice'` to right before it. The stack is now, top to bottom: proposal, run-later, person-required, project-switch, project-home, pin, board, asset-trash, late, notice. Nothing else moved, and a test pins the whole order.
  - The band doesn't depend on the order. It is a fixed box (one notice and its gap) on the region's bottom line (noticeRegion.css `.notice-region__band`, lib/bottomBar.ts `noticeBand`). No CSS selector or script reads the slot order: I searched for `data-notice-slot` and sibling selectors.
- **Trims to one line at 560 px.** GM: "TRIMS to one line at 560 px (about 80-85 characters)". Each line lives where #180's notes said:
  - World Labs delete refusals: `heldDeleteText` (lib/worldLabsWaiting.ts), used by `refuseHeldNodeDelete` (graphStore.ts).
    - "Couldn't delete the node. It's waiting on World Labs. Check Marble, then unlock it."
    - Forget form: "Couldn't delete it. It's waiting on World Labs. Check Marble, then forget it in Run History." This is GM's fallback heading ("If that still wraps, use "Couldn't delete it." as the heading."), because the full-heading form wraps (see Decisions).
    - "Couldn't delete {n} nodes. One is waiting on World Labs. Check Marble, then unlock it."
    - Forget form for several: "Couldn't delete them. One is waiting on World Labs. Check Marble, then forget it in Run History." It still wraps (For GM).
    - More than one held (added after review, see Review): "Couldn't delete them. They're waiting on World Labs. Check Marble, then unlock them." when every node is held, "Couldn't delete them. {k} are waiting on World Labs. Check Marble, then unlock them." when only some are, and the same forget forms ("… then forget them in Run History."). For GM.
  - Paid World Labs duplicate refusal (graphStore.ts `WORLD_LABS_UNSAFE_CLONE_MESSAGE`): "Couldn't duplicate a paid World Labs node. Add a new one from the Nodes rail instead."
  - Paper recipe refresh (graphStore.ts `rerunHistoryWithLatestPaperSource`): "Refresh this recipe's Paper sources, then run it again. Their last snapshots are kept."
  - Project-switch toast's kept-copy forms (projectStore.ts `switchMessage`): "Claude Code opened “{name}”. A copy of your unsaved changes is in Projects." / "Claude Code made “{name}” and opened it. A copy of your unsaved changes is in Projects." The agent's name is still whatever the code puts there (`actorName`, or "An outside app"). The two lines without a kept copy are unchanged.
- **The trim editor's timeline publishes its top edge.** GM: "TRIM EDITOR TIMELINE: yes, it publishes its top edge. A notice should never sit over a timeline being edited, even one that shares its column."
  - `Timeline` (components/editor/Timeline.tsx) carries `data-bottom-bar` on `.editor-tl` and takes a `ref`. EditorView calls `useBottomBarClearance([timelineRef], hasTimeline)`, the same way the Remotion tray does, so notices sit 8 px above the timeline.
  - The empty editor ("Connect a video upstream to edit.") has no timeline and publishes nothing. Leaving the editor clears the value, and the canvas bar publishes its own again.
- **Agent support: none needed.** This round is layout and the person's copy only. I checked each string for an agent-facing twin:
  - The World Labs delete lines: the backend sends the person its own line (`_paid_state_person`, "This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you delete it.") and agents the specific text ("Cannot delete n1: it has unresolved World Labs paid state. …", through refusal_copy). Both stay word for word.
    - The frontend's copies of the backend lines (`NODE_WAITING_*`, `SOME_NODE_WAITING_*`) stay too: backend/tests/test_error_copy_round3b.py pins them equal.
    - The canvas no longer shows those lines. It shows GM's. When the backend refuses a delete the canvas didn't know was held (a stale tab), `deleteRefusalText` maps the backend's two lines to GM's. This is the "frontend's mapping" the spec asked for. No backend string was split, because none is shared between the person and an agent.
  - The duplicate refusal, the Paper line and the switch toast are frontend-only. No backend, MCP, CLI or docs string matches them. Agents have no duplicate tool, and the switch toast is built in the tab from the `projectSwitch` fields.
  - Left alone on purpose:
    - every agent-facing refusal (`_ensure_node_deletable`'s specific text, `_start_refusal`'s);
    - the backend's person lines that GM didn't trim: the "active" form "Let its run finish, then delete it." and the "params" form "clear the node's {fields} …", which still show after "Couldn't delete the node.";
    - the project-screen hold line ("Couldn't open/delete the project. A node is still waiting on World Labs. …", projectStore `worldLabsHold`);
    - docs/MCP-SETUP.md and skills/nebula/SKILL.md (they don't mention these lines).

## Decisions not in the spec

- **The forget form, measured.** I measured it live in the canvas notice's own font (12 px -apple-system), in the region at 560 px, with its × (table below). "Couldn't delete the node. … forget it in Run History." is 543 px of text in 504 px of room, so it wraps. So I used GM's fallback heading: "Couldn't delete it. …" is 500.4 px, one line, with 3.6 px to spare. Live, the notice is 556 px wide on one line at both sizes.
- **The forget form for several nodes.** "Couldn't delete 3 nodes. … forget it in Run History." wraps (556.9 px), and so does the 12-node form (562.2 px). I applied the same pattern, "Couldn't delete them.", as the spec says. That one still wraps (540.1 px in 504 px). I kept it because it is the rule as given, and listed it for GM with the options.
- **The unlock forms keep their count.** "Couldn't delete {n} nodes. … unlock it." fits up to 3-digit counts (491.7 px for 100 nodes), so it never needs the short heading.
- **The backend path maps to the same lines.** When every refused node gave one of the backend's two trimmed lines, the person reads GM's whole line (`heldDeleteText`). Among other reasons (a held node and "A run is going."), the held node's reason becomes GM's sentence after the counted heading ("Couldn't delete 2 nodes. One is waiting on World Labs. Check Marble, then unlock it. A run is going."). The other reasons are kept as given. An unconfirmed start wins over a recovery record, as on the canvas. The match is exact text equality, which the backend parity test keeps true.
- **The project-switch lines without a kept copy are unchanged** ("Claude Code made a new project, “{name}”, and opened it."). GM trimmed the kept-copy forms only. So the made-and-kept line now reads "made “{name}” and opened it" while the made-only line still says "made a new project, …". Listed for GM.

## Tradeoffs

- **The trim editor's notice now sits over the transport row.** The transport (Play, Trim, Speed, Cut, Vol, the timeline zoom, Render Preview, Export) sits between the preview and the timeline. A notice 8 px above the timeline lands on it.
  - With no clip selected, it covered "Adjust volume / mute" and the timeline zoom (−, 1.0×, +) at 1280x800, and the zoom at 1440x900, for as long as it showed.
  - With a clip selected, the transport wraps to two rows and the notice sat in the empty middle of the second row, covering nothing.
  - Before, the notice sat 24 px off the bottom, over the timeline's tracks. This follows GM's line ("never over a timeline being edited") and is listed for GM.
- **The forget line for one node fits with 3.6 px to spare** in this font. A different system font could tip it to two lines.

## Surprises

- **Every kept-copy switch toast still wraps, even with a short name.** The toast has room for about 407 px of 13 px text beside its "Back to “…”" button and ×. "Claude Code opened “Live G”. A copy of your unsaved changes is in Projects." is 466.5 px. GM said "a long project name may still wrap, which is fine", but no name is short enough. Without a Back button (a switch from Projects with nothing open) it wraps too. For GM.
- **A third test pinned the old duplicate words.** tests/graphStore.projects.test.ts had `stringContaining('separate paid operation')`. It surfaced in the neighbouring run after the build, and now expects GM's line. It wasn't run red on `fc1f772b`, but it's the same string as the runHistory case, which was.
- **CDP flakes under load.** Two live runs aborted on Puppeteer's "Promise was collected" (the machine's load average was 15-20). The script now retries that one CDP error up to 3 times and counts the retries: the final run retried once.

## Tests

Red first on `fc1f772b` (no source changed yet): **31 red of 116** across 6 files (`scratchpad/region-round4/red-first.log`).

- `tests/lateRestoreCount.test.tsx`: **12 of 17 red**.
  - GM's lines: 3 cases (proposals, pins, both).
  - The store paths that show the line: 5 (quick delete, new step, pins on another model, two counts adding up, an agent's undo).
  - The slot sits right above `'notice'`, and `'notice'` is last.
  - New: the whole stack order is pinned, so nothing else moves.
  - The region draws it before (above) the newer notice, with only a Dismiss. The hold test waits on GM's text.
  - Guards that passed: not an offer, nothing missed, no newer step, another project clears it, nothing missed means no line.
- `tests/store/graphStore.heldNodeDelete.test.ts`: **11 of 12 red**.
  - GM's lines on the canvas's own refusal: 5 old cases with new words, plus 2 new ones (the count stays in the unlock heading for 3 nodes; an unconfirmed start wins).
  - New: the backend's refusal mapped to GM's lines, 4 cases (forget, unlock, both held, a held node beside another reason).
  - Guard that passed: a line GM didn't trim ("Let its run finish, then delete it.") stays the backend's.
- `src/store/projectStore.switch.test.ts`: **4 of 25 red**. The kept-copy store path now expects GM's exact line. New: both kept-copy forms, and an unnamed script's kept-copy line. Guards that passed: the two forms without a copy are unchanged.
- `tests/components/EditorView.bottomBar.test.tsx` (new): **2 of 2 red**.
  - The timeline carries `data-bottom-bar`, publishes 280 px, and clears on unmount.
  - The empty editor has no bar and clears a stale `72px`.
- `tests/graphStore.runHistory.test.ts`: **1 red**. All three duplicate paths (paste, duplicate selected, duplicate node) say GM's line.
- `tests/graphStore.paperSource.test.ts`: **1 red**. The Paper refusal is GM's line.
- After the change: the 6 files, **116 of 116** passed.

## Live check

Isolated stack on the builder ports:
- backend 8784, through `iso.sh` and `launch_backend.py`, whose network guard refuses every non-loopback request, with a temp HOME and state and no keys;
- Vite 5784 with `VITE_NEBULA_BACKEND_PORT=8784`. The proxy answered with the fresh, empty project list.

Puppeteer, with CDP `Network.setBlockedURLs` for 8000-8010 and 5173 on 127.0.0.1, localhost and [::1], plus the dead-proxy layer. The canary port 8799 was unreachable.

Final run: **40 PASS, 0 FAIL, 0 blocked requests** to 8000-8010/5173, 0 refused by the backend guard, no page errors, no native dialogs, 1 CDP retry. Script: `scratchpad/region-round4/live-round4.mjs` (copied from round 3's). Results: `live-round4-full-results.json`, `live-run4.log`. Screenshots are in `scratchpad/region-round4/`. Nothing was run, and the World Labs node was only added, never run.

What I saw:
- **The late line above "Deleted the node."**, 1280x800 and 1440x900 (`late-above-1280.png`, `-1440.png`).
  - A real delete gave "Deleted the node." with Undo. Then the store's late line, in the app's own `lateRestoreText` words: "After the restore, 1 proposal couldn't be reopened."
  - At 1280 the late line was at 620-666 and the newer notice at 674-720, 8 px apart, with the bar at 728. At 1440: 720-766, 774-820, bar at 828.
  - The late line is role status with only Dismiss. Undo is topmost, and a real click on it brought the node back while the late line stayed.
  - The app's `lateRestoreText` gave all seven forms verbatim.
- **Each trimmed canvas notice**, 1280x800 and 1440x900.
  - World Labs delete refusals, through the canvas's real refusal: the store held a World Labs record for the node (no request), and Delete was pressed. Each refused node stayed.
    - unlock, 1 node: one line, 520.7 px (`refusal-unlock-1-*.png`);
    - forget, 1 node: "Couldn't delete it. …", one line, 556.4 px (`refusal-forget-1-*.png`);
    - unlock, 3 nodes: one line, 534.5 px;
    - forget, 3 nodes: "Couldn't delete them. …", two lines, 560 px, not cut (`refusal-forget-3-*.png`).
  - Duplicate refusal, through the real path (Cmd+D on a World Labs Environment node that was never run): one line, 546.1 px. Nothing was duplicated (5 nodes before and after).
  - Paper line, through the store's `notify` (driving it needs a Paper source and a saved run): one line, 528.8 px.
- **The project-switch toast with a kept copy**, through the store's `switchNotice` and the real toast. "Claude Code opened “Live G”. A copy of your unsaved changes is in Projects." with "Back to “Spare”", and "Claude Code made “Live G” and opened it. …" with no way back. Both are GM's text, 552 px wide (560 at 1440), and both on **two lines** (Surprises).
- **The trim editor** (`trim-editor-notice-1280.png`, `-1440.png`, `trim-editor-clip-selected-*.png`).
  - The timeline is marked and publishes 240 px (276 px at 1440). The notice ends 8 px above it (552 vs 560.2, 616 vs 624.5) and is topmost.
  - What it covers: see Tradeoffs.
  - Back on the canvas, the bar published its own 72 px again.
- **The measurement table**, each line in its own notice font in the region at 560 px (`measure-560.tsv`, `measure-560.json`):

| Line | Font | Text px | Room px | Lines |
|---|---|---|---|---|
| Couldn't delete the node. … then unlock it. | 12 px | 464.7 | 504 | 1 |
| Couldn't delete the node. … then forget it in Run History. | 12 px | 543.0 | 504 | 2 |
| Couldn't delete it. … then forget it in Run History. | 12 px | 500.4 | 504 | 1 |
| Couldn't delete 3 nodes. One is waiting … unlock it. | 12 px | 478.5 | 504 | 1 |
| Couldn't delete 12 nodes. … unlock it. | 12 px | 483.8 | 504 | 1 |
| Couldn't delete 100 nodes. … unlock it. | 12 px | 491.7 | 504 | 1 |
| Couldn't delete 3 nodes. … forget it in Run History. | 12 px | 556.9 | 504 | 2 |
| Couldn't delete 12 nodes. … forget it in Run History. | 12 px | 562.2 | 504 | 2 |
| Couldn't delete them. … forget it in Run History. | 12 px | 540.1 | 504 | 2 |
| Couldn't duplicate a paid World Labs node. … | 12 px | 490.1 | 504 | 1 |
| Refresh this recipe's Paper sources, … | 12 px | 472.8 | 504 | 1 |
| After the restore, 1 proposal couldn't be reopened. | 12 px | 285.9 | 504 | 1 |
| After the restore, 12 pins and 12 proposals couldn't be restored. | 12 px | 360.6 | 504 | 1 |
| Claude Code opened “Untitled project”. A copy … | 13 px | 523.1 | 406.6 | 2 |
| Claude Code made “Untitled project” and opened it. A copy … | 13 px | 600.2 | 406.6 | 2 |
| Claude Code opened “Live G”. A copy … | 13 px | 466.5 | 406.6 | 2 |

  "Room" is the text's own box in a 560 px notice, after the × (and, for the toast, a Back button). In the table, a one-line row's room is the 504 px a full-width canvas notice gives; the TSV records each row's own box. All six late forms fit (widest 360.6 px).

I stopped both servers by port, and the script deleted its state dir.

## Gates

- **`npx tsc -b`**: clean.
- **`npm run -s lint`**: clean (inline style and Slava CSS scope guards passed).
- **Vitest**, the touched files and every file that covers them (round 3's list, plus every test importing a changed module, plus the new file): 175 files, `--maxWorkers=3`.
  - **2,300 tests: 2,282 passed, 18 failed.**
  - The 18 were in 6 files this branch doesn't touch: Settings, GraphFileActions, NodeLibrary, CommandPalette, ConnectionPopup and ModelDiscovery.integration. They were 5 s timeouts and focus checks under load.
  - Run alone (`--maxWorkers=2`), those 6 passed **142 of 142**.
- **`npx vite build && node scripts/check-build-budget.mjs`**: passed, 366,690 bytes raw and 110,143 gzip against the 512,000-byte budget (#180: 366,649). `dist/` was deleted afterwards.
- **Backend**: no backend file changed. The tests that read the changed frontend files ran: test_error_copy_round3b (the parity pin), test_params_version_gate, test_projects_changed, test_reference_set and test_video_qc_nodes. **64 passed, 13 skipped.**

## Review

- **"One is waiting" when more than one was (fixed).** The review found that when two or more nodes held World Labs state, the line still said "One is waiting on World Labs. … unlock it." `heldDeleteText` was never told how many were held. That happened both on the canvas's own refusal (two selected, both with a recovery record) and when the backend refused both deletes from a stale tab: `deleteRefusalText` dropped the duplicate reason before counting. Clearing the one node the line pointed to still left the delete refused.
  - The fix: `heldDeleteText(count, unlock, held = 1)`. `refuseHeldNodeDelete` passes `held.length`, and `deleteRefusalText` counts the held reasons before it removes duplicates. One shared `heldSentence` now builds the held sentence for both the whole line and the "among other reasons" case, which replaces `heldReason`. One held reads as before. Every node held reads "They're waiting … unlock them." Some held reads "{k} are waiting … unlock them.". I also covered the some-held case (3 selected, 2 held), because it had the same "One is" bug.
  - The heading. Live at 560 px, "Couldn't delete 2 nodes. They're waiting on World Labs. Check Marble, then unlock them." is 506.6 px of text in 504 px, so it wraps. "Couldn't delete 100 nodes. 12 are waiting …" wraps too (511.4 px). I applied the spec's wrap rule: every form with more than one held node takes "Couldn't delete them.". The unlock forms then fit (490.1 px at most, 489.3 px for "100 are"). The forget forms still wrap: "They're … forget them in Run History." is 568.5 px and "2 are …" is 554.3 px, the same as the one-held forget form. The backend's "among other reasons" line keeps the store's counted heading ("Couldn't delete 3 nodes. 2 are waiting on World Labs. Check Marble, then unlock them. A run is going."). That line was already several sentences.
  - Tests: in tests/store/graphStore.heldNodeDelete.test.ts, **6 of 17 red first**: three on the canvas path (2 of 2 held with forget, 2 of 2 held with unlock, 2 of 3 held), and three on the backend path (both held, the same held line twice, 2 held among 3 refused). Each received "One is waiting … it". One existing case, "an unconfirmed start wins", has both nodes held, so it now expects "They're waiting". A new case pins "One is waiting" with the count kept when only 1 of 2 is held. After the fix: **18 of 18**.
  - Live check: builder ports, backend 8784 and Vite 5784, isolated as above. Script `scratchpad/region-round4/live-review.mjs`, results in `live-review-results.json` and `measure-review-560.json`, screenshots `review-*-1280.png` and `review-*-1440.png`. The canvas's real refusal ran at 1280x800 and 1440x900: the store held the nodes, and Delete was pressed. Both unlock forms (2 of 2, 2 of 3) and "One is" (1 of 2) showed on one line. Both forget forms showed on two lines, not cut, at 560 px. Every refused node stayed. The app's own `deleteRefusalText` gave the backend-path lines. **31 PASS, 0 FAIL, 0 blocked requests** to 8000-8010/5173, the canary unreachable, 0 refused by the backend guard, no page errors or dialogs. Both servers were stopped and the state dir deleted.
  - Gates after the fix:
    - vitest: the held-delete file plus every test reading the World Labs lines (errorCopy.round3c.statusBar, providerRecoveryCopy, projectStore.retry, CanvasUndoNotice, ProjectHome, graphStore.errorCopy, errorCopy.sweep), 8 files, **273 of 273**;
    - backend `test_error_copy_round3b.py` (the parity pin): **12 passed**;
    - `npx tsc -b` and `npm run -s lint`: clean;
    - build budget: passed, 366,690 bytes raw and 110,149 gzip. `dist/` was deleted.

## Open items

- The For GM points below.

## For GM

Round 4b answered every point that was here (see "GM's answers on #181 (round 4b)" below): the forget tail, the several-node lines, the forget fallback for one node, the switch toast's three lines and the trim editor's transport. GM: "Merge on green." What is still open after measuring GM's lines live:

- **Two several-node forget forms still wrap at 560 px.** "Couldn't delete them. They're waiting on World Labs. Check Marble, then use Run History." is 509.1 px of text in 504 px, so it shows on two lines (not cut). "… 100 are waiting … use Run History." wraps too (508.3 px). Every other several-node line fits. Built as GM wrote them.
- **The kept-copy switch toasts wrap with a Back button.** A switch away from an open project always offers "Back to “{previous}”", and a kept copy means one was open. Beside "Back to “Spare”" and the ×, the text has 362 px. "Claude Code opened “Live G”. Your edits are saved as a copy." is 371.4 px, so it wraps by about 9 px; the made form (434.7 px) wraps too. Without a Back button both fit. GM's "about 58 characters" came from round 4's 407 px, which I measured beside a shorter stand-in button ("Go back"); with the real button it is closer to 55. Built as GM wrote them.
- **The rendered preview in the trim editor (from the round 4b review).** The notice now sits on the preview's bottom edge, which is also where the rendered video shows its native controls after Render Preview. I made the rendered picture stop above the notice band, like a floating panel, so the controls are never covered; it is 52 px shorter than the source picture. The other options: put the notice over the transport (round 4's line) only while the rendered file shows, or let a notice cover the controls until it is dismissed. Which does GM want? The timecode readout moved to the preview's top edge for the same reason.

## GM's answers on #181 (round 4b)

Same branch, from committed head `317a88b3`. Frontend only: no backend, MCP, CLI or docs string changed. GM's answers, verbatim where quoted.

### What changed and why

- **The trim editor's transport publishes its top edge too.** GM: "Trim editor: yes, publish the transport's top edge as well, so notices sit over the preview's bottom edge. Cut, Vol and zoom are being used while someone edits."
  - `EditorTransport` (components/editor/EditorTransport.tsx) carries `data-bottom-bar` on `.editor-transport` and takes a `ref`. EditorView calls `useBottomBarClearance([transportRef, timelineRef], hasTimeline)`. The bar's top is the higher of the two, so notices sit 8 px above the transport.
  - The hook's ResizeObserver watches both, so the clearance follows the transport when a selected clip adds the Speed / Vol inspector and the row wraps to two rows, and the window resize listener covers a resize. The empty editor has neither and publishes nothing.
- **The one-node forget form is unchanged.** GM: "The one-node fallback is fine as measured." It stays "Couldn't delete it. It's waiting on World Labs. Check Marble, then forget it in Run History."
- **GM's lines for several nodes** (`heldDeleteText` in lib/worldLabsWaiting.ts). Every line for several nodes is headed "Couldn't delete them.":
  - all held, unlock: "Couldn't delete them. They're waiting on World Labs. Check Marble, then unlock them."
  - some held, k ≥ 2, unlock: "Couldn't delete them. {k} are waiting on World Labs. Check Marble, then unlock them."
  - some held, k = 1, unlock: "Couldn't delete them. One is waiting on World Labs. Check Marble, then unlock it." This is GM's newest line. It replaces round 4's counted "Couldn't delete {n} nodes. One is waiting on World Labs. Check Marble, then unlock it." for this case, built as GM wrote it, so the count is no longer shown even though the counted line fitted.
  - every forget form for several nodes ends "Check Marble, then use Run History." (GM: "Use the same tail on every forget form that wraps, so the single-node one stays as it is."): "Couldn't delete them. One is waiting on World Labs. Check Marble, then use Run History.", "Couldn't delete them. They're waiting on World Labs. Check Marble, then use Run History.", "Couldn't delete them. {k} are waiting on World Labs. Check Marble, then use Run History."
  - The separate `heldSentence` helper is gone: `heldDeleteText` builds every form itself.
- **The project-switch toast** (projectStore.ts `switchMessage`), GM's three lines:
  - "Claude Code opened “{name}”. Your edits are saved as a copy."
  - "Claude Code made and opened “{name}”. Your edits are saved as a copy."
  - "Claude Code made and opened “{name}”." (made, no copy). This also settles round 4's open point: the made-only line now matches the made-with-copy one.
  - Opened with no copy is unchanged ("Claude Code opened “{name}”."). The agent's name is still `actorName`, or "An outside app".
- **Agent support: none needed, confirmed again.** These are the person's lines only.
  - The toast is built in the tab from the `projectSwitch` fields. The backend's only similar text is its canvas-event journal summary (`main.py`, "made and opened project “…”"), which agents read and which was already worded that way. Unchanged.
  - The World Labs delete lines: the backend's person lines (`NODE_WAITING_*`, pinned by test_error_copy_round3b.py) and its agent text are word for word as before. Only the canvas's mapping of them changed.
  - docs/MCP-SETUP.md and skills/nebula/SKILL.md don't mention any of these lines.

### Decisions not in the spec

- **A held node among other reasons (the backend path) now leads with GM's line.** Before: "Couldn't delete 2 nodes. One is waiting on World Labs. Check Marble, then unlock it. A run is going." Now: "Couldn't delete them. One is waiting on World Labs. Check Marble, then unlock it. A run is going." (and "Couldn't delete them. 2 are waiting … unlock them. A run is going.", "Couldn't delete them. One is waiting … then use Run History. A run is going.").
  - Why: GM dropped the count from every several-node held line, even the one that fitted. With the old heading, the same held node read two different ways depending on which path refused it (the canvas's own refusal or a stale tab's backend refusal). Now the held part always reads the same, and the person still sees every other reason after it. The person selected the nodes, so the count adds little, and the line is several sentences either way.
  - `deleteRefusalText` now returns `heldDeleteText(...)` plus the other reasons whenever any reason is a held one. When no node is held, the store's counted heading stays ("Couldn't delete 2 nodes. A run is going."). That is GM's generic refusal pattern, not a World Labs line, and a test pins it.
- **The live toast check now uses the real Back button.** Round 4 measured the toast beside a "Go back" stand-in and set no previous project on the made form. A switch with a kept copy always has a previous project, so this round shows all three toasts with "Back to “Spare”", as the app draws them.

### Tests (red first on `317a88b3`)

Tests changed first, source untouched: **19 red of 49** across 3 files (`scratchpad/region-round4b/red-first.log`).

- `tests/components/EditorView.bottomBar.test.tsx`: **3 of 4 red**. It now renders the real `EditorTransport` (no longer mocked).
  - Both the transport and the timeline carry `data-bottom-bar`, and the clearance is the transport's (324 px, not the timeline's 280 px). Red: the transport had no attribute.
  - A selected clip shows the inspector, and when the transport's ResizeObserver fires with its new two-row top the clearance follows (364 px). Red: the transport wasn't observed.
  - A window resize measures the transport again. Red: 280 px.
  - Guard that passed: the empty editor has no bar and clears a stale value.
- `tests/store/graphStore.heldNodeDelete.test.ts`: **9 of 20 red**. The canvas path now expects GM's "Couldn't delete them. One is waiting … unlock it." (3 nodes and 2 nodes, 1 held), and "use Run History." on every several-node forget form (one, all, k = 2). The backend path expects the same lines, and the "among other reasons" forms lead with them. New: a held forget line among another reason. Guards that passed: one-node lines, the untrimmed "Let its run finish" line, and the new "other reasons only keep the counted heading".
- `src/store/projectStore.switch.test.ts`: **7 of 25 red**. The three lines, verbatim, through `switchMessage` and through the store paths that show them (an agent's new project, a recovered copy, a new project opened from Projects), plus an unnamed script's kept-copy line. Guard that passed: opened with no copy is unchanged.
- After the change: the 3 files, **49 of 49**.

### Measurements (live, 560 px, the canvas notice's font)

Each line in its own notice, in the region at 1280x800 (`scratchpad/region-round4b/measure-560.tsv`, `.json`). Canvas notices are 12 px -apple-system with 504 px for text beside the ×. The switch toast is 13 px -apple-system.

| Line | Text px | Room px | Lines |
|---|---|---|---|
| Couldn't delete the node. It's waiting … unlock it. | 464.7 | 504 | 1 |
| Couldn't delete it. It's waiting … forget it in Run History. | 500.4 | 504 | 1 |
| Couldn't delete them. They're waiting … unlock them. | 490.1 | 504 | 1 |
| Couldn't delete them. 2 are waiting … unlock them. | 475.9 | 504 | 1 |
| Couldn't delete them. 12 are waiting … unlock them. | 481.4 | 504 | 1 |
| Couldn't delete them. 100 are waiting … unlock them. | 489.3 | 504 | 1 |
| Couldn't delete them. One is waiting … unlock it. | 461.7 | 504 | 1 |
| Couldn't delete them. One is waiting … use Run History. | 502.1 | 504 | 1 |
| **Couldn't delete them. They're waiting … use Run History.** | **509.1** | 504 | **2** |
| Couldn't delete them. 2 are waiting … use Run History. | 494.9 | 504 | 1 |
| **Couldn't delete them. 100 are waiting … use Run History.** | **508.3** | 504 | **2** |
| Couldn't delete them. One is waiting … unlock it. A run is going. (backend path) | 546.4 | 504 | 2 |
| Claude Code opened “Live G”. Your edits are saved as a copy. (with Back to “Spare”) | 371.4 | 362 | 2 |
| same, no Back button | 371.4 | 371.4 | 1 |
| Claude Code made and opened “Live G”. Your edits are saved as a copy. (with Back) | 434.7 | 362 | 2 |
| same, no Back button | 434.7 | 434.7 | 1 |
| Claude Code made and opened “Live G”. (with Back) | 244.8 | 244.8 | 1 |
| Claude Code opened “Untitled project”. Your edits … (with Back) | 428.0 | 362 | 2 |
| Claude Code made and opened “Untitled project”. Your edits … (no Back) | 491.3 | 484 | 2 |

- **Fit on one line:** both one-node lines; every unlock form for several nodes (all held, k = 2, 12, 100, k = 1); the forget forms for k = 1 (502.1 px, 1.9 px to spare) and k = 2 to 99 (494.9 px for k = 2).
- **Wrap (GM's wording kept, listed in For GM):** the all-held forget form (509.1 px), the forget form at k = 100 (508.3 px), and the kept-copy switch toasts beside their Back button. The backend's line with another reason wraps too, as it did before: it was already several sentences.

### Live check

Isolated stack on the builder ports:
- backend 8784, through `iso.sh` and `launch_backend.py` (its network guard refuses every non-loopback request), with a temp HOME and state and no keys;
- Vite 5784 with `VITE_NEBULA_BACKEND_PORT=8784`. The proxy answered with the fresh, empty project list.

Puppeteer, with CDP `Network.setBlockedURLs` for 8000-8010 and 5173 on 127.0.0.1, localhost and [::1], plus the dead-proxy layer. The canary port 8799 was unreachable.

Final run: **48 PASS, 0 FAIL, 0 blocked requests** to 8000-8010/5173, 0 refused by the backend guard, no page errors, no native dialogs, 2 CDP retries ("Promise was collected" under load). Script: `scratchpad/region-round4b/live-round4b.mjs` (copied from round 4's, which is untouched). Log `live-run3.log`, results `live-round4b-full-results.json`, screenshots `round4b-*.png`. Nothing was run, and the World Labs node was only added, never run.

Two earlier runs: the first stopped on a typo in my script (the trim-editor step). The second failed 5 trim-editor checks on a check I wrote too strictly: I asked for the notice's bottom to sit at or above the preview's bottom. The column's gap is 10 px and the notice's is 8 px, so the notice ends 1.8 px below the preview, in the gap, still clear of the transport. The check now asks that the notice cross the preview's bottom edge and end above the transport. The app's code didn't change between runs.

What I saw, at 1280x800 and 1440x900:
- **The trim editor** (`round4b-trim-editor-no-clip-*.png`, `round4b-trim-editor-clip-selected-*.png`, `round4b-trim-editor-resize-1280.png`). The transport and timeline are both marked.
  - No clip selected: the transport is one row (38 px, top 512.2 at 1280, 576.5 at 1440). The notice is at 458-504 (522-568 at 1440): 8 px above the transport, across the preview's bottom edge (502.2 / 566.5), on top, covering no transport or timeline control. The clearance is 288 px (324 px).
  - A clip selected: the Speed / Vol inspector wraps the transport to two rows (80 px, top 485.2 / 549.5). The notice, still showing, moved up with it to 431-477 (495-541), again 8 px above it and covering nothing. The clearance is 315 px (351 px).
  - Resize 1440x900 → 1280x800 with the clip selected and a notice showing: measured again, the same 8 px.
  - Back on the canvas, the bar published its own 72 px again. The empty editor ("Connect a video upstream to edit.") published nothing.
- **The several-node lines**, through the canvas's real refusal (the store held World Labs records for the nodes, with no request, and Delete was pressed; every refused node stayed):
  - all held, unlock: one line, 546.1 px wide;
  - some held k = 2, unlock: one line, 531.9 px;
  - some held k = 1, unlock: one line, 517.7 px;
  - some held k = 1, forget: one line, 558.1 px;
  - some held k = 2, forget: one line, 550.9 px;
  - all held, forget: two lines, 560 px, not cut;
  - one node, forget (unchanged): one line, 556.4 px.
  - The app's own `deleteRefusalText` gave the same lines for the backend path, the held line first among other reasons, and the counted heading when no node is held.
- **The three switch toasts**, through the store's `switchNotice` and the real toast, each with "Back to “Spare”" and Dismiss (`round4b-switch-*.png`):
  - opened with a copy: GM's line, on two lines;
  - made with a copy: GM's line, on two lines;
  - made: GM's line, on one line (434.9 px).

I stopped both servers by port, and the script deleted its state dir.

### Gates

- **Vitest**, the 3 touched files and every file that covers what changed, `--maxWorkers=3`, 25 files: the switch toast, notice region and switch-toast tests, ProjectHome, App navigation, the editor tests (EditorView, Remotion, VideoPreview, Toolbar, tests/editor/), the World Labs and error-copy tests (CanvasUndoNotice, providerRecoveryCopy, projectStore.retry, errorCopy.round3c.statusBar, errorCopy.rawMessageGuard, errorCopy.round3e.sweep, graphStore.errorCopy, graphStore.projects), noticeBand, noticeRegionLayer and selectionToolbarTopLine. **293 of 293 passed.**
- **`npx tsc -b`**: clean.
- **`npm run -s lint`**: clean (inline style and Slava CSS scope guards passed).
- **`npx vite build && node scripts/check-build-budget.mjs`**: passed, 366,612 bytes raw and 110,127 gzip against the 512,000-byte budget. `dist/` was deleted afterwards.
- **Backend**: no backend file changed. The tests that read the changed frontend files ran (test_error_copy_round3b, the parity pin; test_projects_changed; test_params_version_gate): **33 passed**.

### Review

- **The notice covered the preview's own readout and, after Render Preview, the video's controls (fixed; one choice for GM).** With the transport publishing its top edge, the notice sits on the preview's bottom 44 px. That is where the timecode readout ("00:00:00:00 / 00:00:05:00", plus "Rendered") sat, at `bottom: 8px`, centred, so the notice hid it entirely. After Render Preview the rendered video shows native controls on its bottom edge, and the notice covered the middle of its scrubber. My round 4b live check only looked at the transport, timeline and preview edges, so it missed both.
  - The readout now sits on the preview's top edge (`.editor-preview__hud`, `top: 8px`, EditorView.css).
  - While the rendered preview shows, the picture stops above the notice region's reserved band, the way floating panels already do (GM, round 2: "Floating panels stop above a reserved notice band, whether or not a notice is showing"). VideoPreview measures it with `floatingBottomLimit` and writes `--notice-band-inset` on the preview. Only the video reads it, as `max-height` and `margin-bottom`, so the preview keeps its size and the transport and timeline don't move. A first try padded the preview instead, and that pushed the transport down 18.5 px when the rendered file appeared. The source preview has no controls and keeps its full height under the notice, as GM asked. The inset is measured again when the preview changes size (transport wraps, window resize) and cleared when the source preview comes back.
  - This is my choice, not GM's: the review offered two other options, the round 4 line (the notice over the transport) while the rendered file shows, or accepting the covered controls until the notice is dismissed. The first puts the notice back on Cut / Vol / zoom, which GM's answer moved it off, and the second hides the scrubber while a persistent notice shows. The cost of mine: the rendered picture is 52 px shorter than the source one, so it shrinks a little when Render Preview finishes. Listed for GM.
  - Tests, red first on the round 4b change: new `tests/components/VideoPreview.noticeBand.test.tsx`, **3 of 4 red** (`scratchpad/region-round4b-fix/red-first-final.log`). The readout rule has `top: 8px` and no `bottom` (red: `bottom: 8px`). The rendered preview writes a 52 px inset for the 1280x800 boxes, and only the video's rule reads it (red: no inset). A resize measures it again (22 px) and the source preview clears it (red: no inset). Guard that passed: the source preview gets no inset. After the change: **4 of 4**.
  - Live, 8784/5784, isolated as above, with a real 5 s local test clip (ffmpeg `testsrc2`) served from the temp output root, so the readout and the video's controls render (`scratchpad/region-round4b/live-round4b-fix.mjs`, `MODE=editor`, log `live-fix-run4.log`). **18 PASS, 0 FAIL, 0 blocked requests** to 8000-8010/5173, 0 refused by the backend guard, no page errors. The trim editor checks now also need the readout to show (hit-tested on top) and to clear the notice. Source preview, both sizes, with no clip and with a clip selected: the readout is at 110-130, the notice at 458-504 (1280) and 522-568 (1440), as before. Rendered preview: the video ends at 449.2 / 422.2 (1280, one and two transport rows) and 513.5 / 486.5 (1440), 8.8 px above the notice's top each time. The controls are drawn and uncovered, the readout shows "Rendered", and the transport and timeline sit exactly where they were with the source preview. Back to the source preview: no inset. Shots: `round4b-trim-editor-rendered-{no-clip,clip-selected}-{1280,1440}.png`; the `round4b-trim-editor-*` source shots were retaken with the real clip.
  - Gates after the fix: vitest **99 of 99** in 12 files (the editor, App navigation, Remotion tray, uiStore, tests/editor, noticeBand and noticeWidthCap tests); `npx tsc -b` clean; `npm run -s lint` clean; build budget passed, 366,612 bytes raw and 110,126 gzip; `dist/` deleted. No backend file changed and no backend test reads these files.

### Open items

- The two wrapping forget forms and the kept-copy toasts beside their Back button (For GM, above). Built as GM wrote them.
- The rendered preview's 52 px inset (Review, above, and For GM).
- Seen in the shots, already there before this branch: the "Rendered" tag in the readout has no style or gap, so it reads "00:00:05:00Rendered". Not changed here.
