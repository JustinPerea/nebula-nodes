# 2026-10-23 — Notice region, round 3: a late count, a held Inspector, one-line notices

Branch `fix/notice-region-round3`, from main `13158a11` (after #179). Frontend only: no backend file changed. No package installed, no paid provider call.

## What changed and why

GM - Design answered #179's five questions. Answers 1 ("Keep it") and 3 ("Leave it") change nothing. The rest is built as GM wrote it.

- **A. A late restore count is never lost.** GM: "Yes, show it as a plain notice with no button, using the standard timeout, under the newer notice: "1 proposal from the restored node couldn't be reopened." / "{n} proposals from the restored nodes couldn't be reopened." Losing that count silently is the one thing to avoid."
  - The store has a second, separate line, `lateNotice` (graphStore.ts `LateNotice`, set by `lateCount`). It is not the canvas notice, so it never replaces the newer one. It has no `offer` and no `entry`, so the store's offer rule (`withLiveNotice`) never reads it and it never counts as an Undo/Redo.
  - `sendRestore`'s `answerNotice`: when the "Restored …" line can't show (another notice came since, or its Redo no longer applies), the count goes to the late line instead of nowhere. The agent-undo path does the same: before, a count that arrived after "Undid Claude Code's edit" was gone was dropped too.
  - The words: `lateRestoreText` (lib/deleteNotice.ts). GM's two proposal lines are verbatim, picked by the proposal count. The pin lines and the line for both are GM's follow-up, verbatim too: "1 pin from the restored node couldn't be re-attached." / "{n} pins from the restored nodes couldn't be re-attached.", and for both "1 pin and 2 proposals from the restored nodes couldn't be restored." (built as "{p} pin(s) and {q} proposal(s) from the restored nodes couldn't be restored.", each noun following its own count).
  - The region has a new slot, `'late'`, right after `'notice'` (lib/noticeSlots.ts), so it draws under the newer notice. `CanvasLateNotice` renders it on every screen, like the canvas notice's written lines.
  - It uses the standard hold (`noticeHoldMs`, 6 s for this line), pauses while the pointer or focus is on it, and keeps the region's Dismiss (×) like every written line. The hold logic is now one hook, `hooks/useNoticeHold.ts`, which `CanvasUndoNotice` uses too.
  - Unchanged when nothing newer happened: "Restored the node. 1 proposal couldn't be reopened." with Redo (a test and the live check pin it).
- **B. The Remotion tray publishes its top edge.** GM: "Yes, the Remotion tray publishes its top edge, the same as the canvas bar and the composer." `.remotion-editor-view__timeline` carries `data-bottom-bar` and uses `useBottomBarClearance`, so notices sit 8 px above it. With no composition open there is no tray, and nothing is published.
- **C. Notices capped at 560 px.** GM: "Two-line notices: keep notices to one line in the copy. Cap their width at 560 px, and let a rare second line overlap a panel's edge while it shows. Don't grow the band."
  - One token on the region, `--notice-max-w: 560px` (noticeRegion.css), plus a zero-specificity default for any row: `:where(.notice-region__slot) > *`.
  - Each item's own width rule reads the token too, so a narrower rule still wins (the Commons room for the project-switch toast, the pin toast's 420 px). That covers: the canvas notice (was 520), the proposal bar and its run-later notice (620), the project-switch toast (640, three rules), the person-required line (620), the board toast (already 560), the asset trash and Projects toasts (no cap before).
  - The proposal bar is one of the stack items (round 2 moved it into the region's top slot), so it is capped too, as the spec asked to check. At 1280 with the Agent log open it was already under 560. At 1440 it is now 560 instead of 620.
  - `--notice-h` and the band are unchanged (54 px).
- **D. The Inspector holds the toolbar's line.** GM: "The Inspector jumping on deselect: hold it. A panel shouldn't move unless someone moves it. While it's open, use the lower of the two top lines (the toolbar's) whether or not the toolbar is showing."
  - The selection toolbar's React Flow Panel (the `data-top-bar` marker since #179's review) now keeps the toolbar's height when it is empty: `min-height: var(--selection-toolbar-h)` (50 px: 38 px buttons, 5 px padding, a 1 px border). The toolbar reads the same token. Empty, the Panel is 0 px wide, so it covers nothing. Its `pointer-events` were already `none`.
  - `floatingTopLimit` counts a part by its height alone (it used to skip a 0-wide box). So the line is measured from the Panel's position, live, whether or not the toolbar shows, and a resize still moves it.
  - The pinned Inspector reads the same line, so it holds too (one test).
- **E. The fade over "idle".** GM: "Start the fade only once the body actually overflows by more than one line, or give the body room for one more line before it scrolls."
  - I built the second: the floating Inspector takes up to one more line (`POPOVER_SPARE_LINE`, 44 px) before its body scrolls.
  - Why not the first: in GM's setup the body lacked 34 px, and the State value sat 12 px past the body's bottom edge. With the fade turned off, "idle" would still be cut off by the clip, just without a fade. Only room makes it readable.
  - The panel takes the line only within the top line and the band. In a short window it scrolls under the fade as before. A body that lacks more than one line (Nano Banana: 169 px) stays at 300 px and keeps its 12 px fade (checked live).
- **Agent support.** This is layout and notice behaviour only. Agents read no notice, toast or position. Their undo answers already report what couldn't be put back: MCP `undo_canvas_edit` returns `pinsLeft` (`{id, reason, code}`, code "another-model" among others) and `notReopened` (`{id, reason}`), and the `nebula undo` CLI prints both (backend/cli/formatter.py). Nothing to add to MCP, the CLI, docs/MCP-SETUP.md or skills/nebula/SKILL.md.

## Decisions not in the spec

- **Under = below.** The region's stack draws top to bottom, so "under the newer notice" is the slot after `'notice'`, nearest the bar. The newer notice moves up one row while the late line shows.
- **Two late counts add up** on the one late line (the counts sum, and the text is rebuilt). They never replace each other.
- **Opening another project clears the late line**, with the old notice (`loadProjectGraph` already cleared `undoNotice`). A project switch can't start while a restore is in flight (`canSwitchProject` waits for pending graph writes), so no count is lost that way.
- **The late line keeps the × Dismiss.** GM's "no button" is read as no Undo/Redo. Every written line in the region has the ×, which makes it keyboard-dismissable (round 3f: "non-blocking, dismissable"). Flagged for GM below.
- **The spare line is kept while open.** Once the panel takes the line, it keeps that height until the Inspector closes or shows another node, even if the content gets shorter. The first build tried to give it back, and live it went back and forth between 324 and 334 px. The Inspector root's height leaves out margins that fold through it, so "fits with room to spare" can't be measured exactly. Keeping the height is stable and matches "a panel shouldn't move unless someone moves it". The next open starts at 300 px.
- **The video editor's timeline (EditorView) is not changed.** It is not a tray: it shares the column with the preview (flex 1 against 1.8), so publishing its top would put notices in the middle of the screen. A question for GM below.

## Tradeoffs

- **Two notices are taller than the band.** With the late line showing, the newer notice sits one row above the band and can cover the lower edge of a panel that stops at the band, as GM accepted with "Don't grow the band". Live at 1280x800, "Deleted the node." with Undo sat at 620-666, over an Inspector's foot row if one were open there. Undo stays topmost.
- **A rare second line** (a 560 px notice that wraps) also reaches 16-20 px above the band, as GM said.
- **The Inspector can be up to 44 px taller than 300** when that is all its body lacks. In GM's setup it is 334 px and its top moves up 34 px to stay above the band. That happens when it opens, not while it is open.
- **One frame at 300 px.** The body is measured on the frame after it renders, so an Inspector that takes the spare line shows at 300 px for one frame (during its entrance) and then grows.

## Surprises

- In GM's setup, the State value is 16 px text on a 21 px line. The body lacked 34 px: 12 px of "idle", the last section's 10 px margin and the body's 12 px padding. That's why the spare line is 44 px, not the ~30 px a 12 px line would suggest. My first live run used 30, and "idle" stayed hidden.
- `.inspector--embedded` measured 185 px while the body scrolled 219 px. The last section's margin folds through it (see "kept while open" above).
- The Remotion editor's header has two buttons before the title: Home ("Back to projects") and "Canvas". My live script first clicked Home.

## Tests

Red first on `13158a11` (the worktree before any source change): **26 red** across 7 files (`scratchpad/region-round3/red-first.log`, `red2.log`).

- `tests/lateRestoreCount.test.tsx` (new): **14 of 16 red**.
  - Red: GM's lines (4: `lateRestoreText` didn't exist); restore then a quick delete; a new step with no notice of its own; pins on another model; not an offer; two counts add up; an agent's undo; another project clears it; the slot order; the region rendering it under "Deleted the node." with no Undo/Redo; the hold. The last two timed out waiting for a line that never came.
  - Guards that passed: no newer step still says "Restored the node. 1 proposal couldn't be reopened." with Redo; nothing missed means no line.
- `tests/components/RemotionEditor.bottomBar.test.tsx` (new): **2 of 2 red**. The tray had no `data-bottom-bar`, and a stale `72px` stayed published.
- `tests/noticeWidthCap.test.ts` (new): **2 of 3 red**. No token, and 8 rules could be wider than 560 (620, 640, 520 is fine, `calc(100vw - 32px)`, …). Guard: the band keeps `--notice-h` 46 px.
- `tests/components/NodeInspectorBand.test.tsx`: the old "follows the toolbar coming and going" case is replaced by **3 new cases, all red**: holds through deselect and reselect, opened while hidden, the pinned Inspector holds. On the base the Inspector went to 72 (the header's line) when the toolbar went.
- `tests/components/NodeInspectorSpareLine.test.tsx` (new): **2 of 6 red** in its first form (GM's setup: 300 against 300 + the overflow; giving the line back). Guards passed on the base: content that fits stays 300, more than a line stays 300, no back and forth, a short window still scrolls.
  - After the live check I changed two cases. GM's case now uses the 34 px measured live. "Gives the line back" became "keeps the line while open, and a new open starts at 300 px" (see Decisions). Neither changed case was re-run on the base. The first fails there for the same reason as before (the panel never grows).
- `tests/selectionToolbarTopLine.test.tsx`: **2 red**. The empty panel now keeps the line (the old guard said it set none: that is the behaviour GM asked to change), and the token test (no `--selection-toolbar-h`).
- `tests/noticeBand.test.ts`: **1 red**. An empty 0-wide Panel, one toolbar tall, sets the line.

## Live check

Isolated stack on the builder ports:
- backend 8784, through `iso.sh` and `launch_backend.py`, whose network guard refuses every non-loopback request, with a temp HOME and state and no keys;
- Vite 5784 with `VITE_NEBULA_BACKEND_PORT=8784`. The proxy answered with the fresh, empty project list.

Puppeteer, with CDP `Network.setBlockedURLs` for 8000-8010 and 5173 on 127.0.0.1, localhost and [::1], plus the dead-proxy layer. The canary port 8799 was unreachable.

Final run: **31 PASS, 0 FAIL, 0 blocked requests**, 0 refused by the backend guard, no page errors, no native dialogs. Script: `scratchpad/region-round3/live-round3.mjs`. Results: `live-round3-results.json` and `copy-check.json`. Earlier runs failed on the spare-line size (30 px, then the back and forth) and on script steps (opening and leaving the Remotion editor). Each was fixed before this run.

What I saw:
- **GM's cover setup, 1280x800 and 1440x900** (`gm-cover-1280.png`, `gm-cover-1440.png`). Delete a Text Input with a proposal on it, restart the backend, Cmd+Z: "Restored the node. 1 proposal couldn't be reopened." with Redo, unchanged.
  - The Inspector is 334 px (was 300) and ends at the band (666; 766).
  - "idle" is whole at 558-579 inside the body (382-601). The body doesn't scroll (219/219) and has no fade. The foot row is whole and topmost.
- **The fade stays** where the body really has more: Nano Banana's body (354 px of content in 185 px) keeps its 12 px mask, and the panel stays 300 px.
- **The late count** (`gm-late-count-1280.png`). Restore, then at once delete another node, with a proposal that can't reopen.
  - "Deleted the node." with Undo at 620-666. Under it, 8 px apart, "1 proposal from the restored node couldn't be reopened." (role status, only a Dismiss) at 674-720, 8 px above the bar (728).
  - A real click on Undo brought the node back, and the late line stayed. It went on its timeout, about 6 s after it appeared.
- **The held Inspector, 1280x800 and 1440x900** (`gm-hold-1280.png`).
  - Opened on a node near the top, it sat at 150 (the toolbar's line).
  - Deselected: the toolbar went and the Inspector stayed open (the selection cleared in the graph store, as React Flow does). It stayed at 150. Reselected: 150. Every frame was recorded through both, and no frame moved it (spread 0).
  - A resize from 1440x900 to 1280x800 still re-placed it between the lines.
- **The Remotion editor**, 1280x800 and 1440x900 (`gm-remotion-notice-1280.png`, `-1440.png`). The tray is at 480-800 (580-900) and publishes 320 px. The notice ends at 472 (572), 8 px above it, and is topmost. Back on the canvas, the bar published its own 72 px again.
- **A long notice** (the World Labs delete refusal), 1280x800 and 1440x900 (`gm-long-notice-1280.png`): 560 px wide, two lines, 8 px above the bar, band still 54 px. At 1440x900 the proposal bar was 560 px.
- **The copy check:** 38 lines measured in their own notice font in the region at 560 px. 12 don't fit one line (For GM below).

I stopped both servers by port, and the script deleted its state dir.

## Gates

- **`npx tsc -b`**: clean.
- **`npm run -s lint`**: clean (inline style and Slava CSS scope guards passed).
- **Vitest**, the touched files and every file that covers them, `--maxWorkers=3`: **155 files, 2068 tests: 2067 passed, 1 failed**. The failure was `tests/Settings.test.tsx` "focuses krea-mcp setup without signing in": focus was still on the Providers tab when it checked. That file doesn't touch anything this branch changed. Run alone, it passed 73 of 73, so it's a timing flake under load.
- **`npx vite build && node scripts/check-build-budget.mjs`**: passed, 366,649 bytes raw and 110,128 gzip against the 512,000-byte budget (#179 was 366,654). `dist/` was deleted afterwards.
- **Backend**: no backend file changed, so no backend tests ran locally. CI runs the whole suites.

## Review

- **GM's pin and combined late lines were not used** (two reviewers, both confirmed). The first build kept my drafts ("1 pin on the restored node …", "… couldn't be put back.") after GM's follow-up had replaced them. `lateRestoreText` now returns GM's lines verbatim, and its comment says they are GM's. Tests first: `tests/lateRestoreCount.test.tsx` changed to GM's strings (plus a "1 pin and 1 proposal" case) and went **3 of 16 red** on the unfixed code (the pin lines, the line for both, and the store path's pin line), then 16 of 16 green. Not taken from the finding: the node word following the node count in the line for both. No node count reaches the late line (it adds up across restores), so it stays "nodes", as in GM's example (For GM below).
  - Live re-run on 8784/5784, 1280x800: **34 PASS, 0 FAIL, 0 blocked requests** to 8000-8010/5173, 0 refused by the backend guard, no page errors. New checks: the app's own `lateRestoreText` gives GM's four forms, and the pin line and the line for both render in the region's late slot as plain one-line notices (357 and 438 px), 8 px above the bar (`gm-late-pin-1280.png`, `gm-late-both-1280.png`). The copy list now measures GM's lines: all six late lines fit one line at 560 px (widest 457 px), and the same 12 lines as before don't fit.
  - Gates after the fix: `tsc -b` clean, lint clean, vitest `lateRestoreCount` + `undoRestoresDeletes` 38 of 38, build budget passed at 366,649 bytes raw. A shell glob slip also ran the whole vitest suite once: 398 files, 5,068 of 5,068 passed.

## Open items

- The For GM points below.
- The deselect in the live check cleared the selection in the graph store, the same field React Flow clears. Escape tried first didn't give "Inspector open, toolbar gone", and #179's live check found that a pane click closes the Inspector, so the check reached that state through the store. #179 saw it happen in use. The hold doesn't depend on how the toolbar goes: the line is the Panel's box either way.

## For GM

- **Your pin lines, as built** (verbatim from your follow-up):
  - "1 pin from the restored node couldn't be re-attached." / "{n} pins from the restored nodes couldn't be re-attached."
  - Both: "{p} pin(s) and {q} proposal(s) from the restored nodes couldn't be restored.", each noun by its own count, so "1 pin and 2 proposals …", "2 pins and 1 proposal …", "1 pin and 1 proposal …".
  - The line for both always says "nodes", as your example does. The late count adds up across restores (two late answers sum on one line), so no single node count reaches the line. It always covers at least two items, so "nodes" reads right in nearly every case.
- **node / nodes can mismatch the real count.** Your lines are kept as written and picked by the proposal count. Two proposals on one restored node read "2 proposals from the restored nodes", and one proposal among three restored nodes reads "1 proposal from the restored node". Say if you want the node word to follow the node count instead.
- **"No button":** the late line has no Undo or Redo, but it keeps the × Dismiss that every written line in the region has. Say if you want it without the ×.
- **Lines that don't fit one line at 560 px** (measured live in each item's own font):
  - Canvas notice (12 px):
    - "Couldn't delete the node. This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you delete it." (and the "— forget … in Run History" form)
    - "Couldn't delete 3 nodes. A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you try again." (and the "forget" form)
    - "Nebula did not duplicate this fresh paid World Labs node. Add a new node from the Nodes rail when you intentionally want a separate paid operation."
    - "Refresh or reconnect the Paper sources in this saved recipe before rerunning with the latest snapshot. Their last successful snapshots remain in source history."
  - Project-switch toast (13 px), only with the kept-copy sentence:
    - "Claude Code opened “Untitled project”. Your last unsaved changes were kept as a copy in Projects."
    - "Claude Code made a new project, “Untitled project”, and opened it. Your last unsaved changes were kept as a copy in Projects."
  - Person-required line (12 px), all four:
    - "This tab isn't connected as you, so Settings, proposals and chats are locked. Open the link the backend printed at launch (or restart it with --open)."
    - "Nebula couldn't confirm this window is yours, so Settings, proposals and chats are off. Restart the app."
    - "Debug mode: a remote-debugging port is open, so actions only you can take (Settings, proposals, chats) are off."
    - "Desktop dev mode: the Vite renderer is not trusted with your token, so Settings, proposals and chats are off. Set NEBULA_DESKTOP_DEV_PERSON=1 to opt in."
  - These fit: every Undo/Redo line (Deleted, Restored, with their counts, the agent edit lines), all your late lines (proposals, pins, and both, up to "12 pins and 12 proposals …"), and the bare failure headings. Not measured: lines that end in a backend reason ("Couldn't save the graph. {reason}", "Couldn't undo that. {reason}"), whose length depends on the reason.
- **Two notices at once** stand one row above the band, so the newer one can cover a panel's foot row while both show (it stays clickable). That follows "Don't grow the band"; say if the late line should go above the newer notice instead, so the actionable one stays nearest the bar.
- **The Inspector's spare line:** GM's setup now shows a 334 px Inspector (34 px taller, its top 34 px higher) with "idle" readable and no fade. Answer 5 said to send a shot only if the hold or the fade change looks different from what you described. The fade change is the "room for one more line" option, so `gm-cover-1280.png` is there if you want to see the taller panel.
- **The video editor's timeline** (the trim editor, not Remotion) also sits along the bottom, but it shares the column with the preview (flex 1 to 1.8), so it isn't a tray. Notices stay 24 px off the bottom over it. Should it publish its top too?
