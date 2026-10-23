# 2026-10-23 — Notice region, round 2: a reserved band, one stack, and notices that clear

Branch `fix/notice-region-round2`, from main `84621738` (after #176, the app-level notice region, and #175, the complete undo). Frontend only: no backend file changed. No package installed, no paid provider call.

## What changed and why

GM - Design answered the five open questions from #176, approved the stale-notice fix, and added one more. Its words are quoted below and were built as written.

- **Continuation.** A first builder did most of this branch and stopped at a usage limit, leaving it uncommitted with no notes. What I found and what I changed is under "From the previous builder" below.
- **1. A reserved notice band.** GM: "Floating panels stop above a reserved notice band, whether or not a notice is showing. The band is the region's height for one notice plus its gap, measured like the bottom line. The panels never move when a notice comes or goes, and a notice never covers Run / Duplicate / Delete."
  - The region now always holds an empty, invisible box, `.notice-region__band` (`data-notice-band`). It is one notice plus its gap tall (`--notice-h` 46 px + `--notice-gap` 8 px = 54 px) and sits on the notices' bottom line.
  - `floatingBottomLimit` (lib/bottomBar.ts) measures that box. A floating panel now ends at the bar's top, minus the bar's 8 px gap, minus the band. With no bar (a Studio), it ends at the band's own top.
  - Every floating panel #176's clamp covers gets it: the floating and pinned Inspector, the context menu, the next-step drop picker (ConnectionPopup) and the provider chip popover. The asset-move menu (`anchoredPopover`) never used the clamp. It opens in the Assets dock and the Studios, at its anchor, so it is unchanged.
- **2. The proposal bar moves into the region.** GM: "Yes, move the proposal bar into the region, stacked above the notices. Accept / Reject are decisions and must never sit under a panel. The order from the bottom up is notices, then the proposal bar."
  - `ProposalBar` no longer renders in a React Flow `Panel` inside `.react-flow`. It portals into the region's top slot.
  - It still mounts with the canvas, so it shows only there. Its role (region "Proposal from {agent}"), focus target, keyboard, Show / Reject / Accept, agent colour, spring entrance and count/pager are unchanged.
  - `--notice-stack-h` and `.proposal-bar-panel` (with its `margin-bottom: calc(78px + …)`) are gone, because the stack does that spacing now.
  - `lib/canvasProposalReview.ts` (Review from Updates) now finds the bar with `.proposal-bar:not(.proposal-bar--notice)`. The run-later notice shares the bar's class and its stack, so a bare `.proposal-bar` could have found the wrong one.
- **3. Every toast joins the region.** GM: "Yes, all three toasts join the region. One region, one stack, and nothing else draws toasts."
  - Each toast keeps its own state, timers, hold, role, buttons and spring. It renders through `<InNoticeRegion slot=…>`, a portal into its slot in the region (lib/noticeSlots.ts). Each toast's own `position: fixed`, `z-index`, `bottom` and `translateX(-50%)` are gone; its entrance keyframes keep the same spring with a plain `translateY`.
  - Moved into the region:
    - the canvas pin error toast (`.canvas-pin-toast`, role alert);
    - the asset trash toast (`.asset-trash__toast`; it was portalled to `document.body`);
    - the moodboard toast (`.moodboard-board-toast`). One toast now serves both the Board and the List view. The `inWindow` prop and `--window` class are gone;
    - the project-switch toast;
    - the Projects screen's Undo toast (`.project-home__toast`);
    - the "This tab isn't connected as you" line (`.person-required`, fixed at z 10000 before).
  - The region now mounts on every screen, Projects and the brand demo included, so the Projects toast has somewhere to go. On those screens it holds toasts only. A canvas notice set there still waits for the workspace, as before.
  - To make that work, the region itself (`components/NoticeRegion.tsx`, a few boxes, plus `styles/noticeRegion.css`) is in the startup entry. Its own notices are a deferred chunk (`RegionNotices`, replacing `DeferredNoticeRegion`). That way a toast that shows at first paint already has its slot.
- **4. Creator Studio's composer publishes its top edge.** GM: "Yes, the composer publishes its top edge the way the canvas bar does, and notices sit 8 px above it on Creator Studio."
  - `.create-view__composer-area` carries `data-bottom-bar` and publishes `--bottom-bar-clearance` through the same hook as the canvas bar, `hooks/useBottomBarClearance.ts`. The Toolbar's inline effect moved into that hook. The variable clears when the Studio closes.
- **5. A measured top line.** GM: "Yes, use a measured top line. Floating panels stop below the workspace header and the selection toolbar, whichever is lower, plus the same 8 px gap."
  - The workspace header (`.canvas-tabs-wrap`) and the selection toolbar carry `data-top-bar`. `floatingTopLimit(gutter)` returns the lowest bottom edge among them, plus 8 px. It is measured every time it is called, so the toolbar coming or going and a resize move the line.
  - The floating Inspector uses it as its top limit. It re-places every frame, so it follows at once. When the room between the top line and the band is shorter than 300 px, the panel gets shorter and its body scrolls (6).
  - The pinned Inspector uses the line too. In a window too short for its smallest size, the lines give way (the bottom one first), as before.
- **6. The clamped Inspector's body scrolls.** GM: "Let the body scroll, with a 12-16 px fade at its bottom edge so the cut reads as scrollable instead of broken. The foot row stays fixed."
  - The body was already a `ScrollFade` above the fixed foot row (#176), but its cue was the app's general 28 px fade, which hid a whole field.
  - `scroll-fade.css` now reads `--scroll-fade-size` (default 28 px, so every other panel is unchanged). The Inspector body sets it to `--sr-space-3` (12 px) and `scroll-padding-bottom` to the same value, so a field reached by Tab scrolls fully clear of the fade.
- **7. A notice whose button no longer applies clears.** GM: "The stale-notice fix is approved as you describe it: a notice whose button no longer applies clears when a new undo step lands."
  - The rule lives once, in the store. The graph store is now created through `noticeFollowsStacks`, a small middleware around both its own `set` and `useGraphStore.setState`.
  - On any update that touches `undoStack`, `redoStack` or `undoNotice`: if the resulting notice has an offer (`undo` or `redo` with an `entry`) and that entry is not the top of its stack, the notice becomes `null` in the same update.
  - Notices without an offer (notify errors, refusals, info lines, an import's notes) are never touched. An undo or redo that sets the notice for the step it just moved passes the rule, since the entry is on top.
  - A late answer can't bring a stale notice back. `sendRestore`'s `answerNotice` builds the "Restored …" notice and drops it if `offerApplies` fails (its `inverse` is no longer on top of the redo or undo stack).
    - The foreign-edit tail (`shown.id === notice.noticeId`) is unchanged and still right. A notice the invariant cleared is `null`, and a newer one has another id, so the count is never appended to the wrong line. A test pins that.
  - The delete path's own guard is tightened from `undoStack.includes(undoStep)` to `undoStack.at(-1) === undoStep`, so "Deleted the node." never arrives with an Undo that wouldn't undo it.
  - The `actionable` selector in `CanvasUndoNotice` stays as a guard. It also covers the Studio's `messagesOnly` case.
- **Agent support.** Items 1-6 are layout only, and agents read no notice, toast or position, so there is nothing to add to MCP, the `nebula` CLI, docs/MCP-SETUP.md or skills/nebula/SKILL.md. The proposal bar's move doesn't change what agents read or do: proposals, Review, Accept and Reject still go through the same store and endpoints, and the Updates feed is untouched (canvasProposalReview tests pass, and a live Accept accepted the proposal). Item 7 is UI-only notice behaviour; agents' undo answers don't change.

## Decisions not in the spec

- **The band's measure: a shared token, measured as a box.** Both the notices' CSS and the band read `--notice-h` (46 px). That is the tallest one-line item: a toast's 32 px buttons, 6 px padding and 1 px border. Every item in the stack has at least that height.
  - The band box is `--notice-h + --notice-gap` tall, and the clamp measures the box, never a number in JS. If GM changes a notice's height, the token moves the band with it.
  - Measured live: the band is 54 px and its foot is 8 px above the bar, at 666-720 at 1280x800 and 766-820 at 1440x900.
- **The band applies to every floating panel, not only those whose span meets the region's.** A notice is centred, but its width follows its text: from about 170 px ("Imported. One note.") to the full width between the 16 px gutters (a long error). A span-aware band would let a panel off to the side grow into the band. That panel would then move, or be covered, when a long notice came. GM's rule says panels "never move when a notice comes or goes".
  - The Canvas actions panel stays span-aware as before. A panel off to the side measures the band from the bar's line, not from the region's lift over the open actions panel.
- **One stacking order, top to bottom** (`NOTICE_SLOTS`): proposal bar, the proposal's run-later notice, the person-required line, the project-switch toast, the Projects Undo toast, the pin error toast, the board toast, the asset trash toast, and at the bottom the canvas notice (Undo/Redo, errors).
  - Bottom up, the reasoning is: the notice about the person's last canvas step sits nearest the bar; then toasts about the person's own last action elsewhere; then lines about the app and the agents; then the proposal's notice; and the decision bar on top, per GM 2.
  - The order comes from the slots, never from which item mounted first.
- **The fade stays 12 px** (`--sr-space-3`), the bottom of GM's range, so it hides as little of a field as possible. It goes away when the body is scrolled to its end: ScrollFade sets `data-scroll-more` only while there is more below. It has no motion of its own.
- **The top line is the floating and pinned Inspector's only.** The context menu, the drop picker and the provider chip popover open at the pointer or their chip, on the popover layer (40). That is above the header and the selection toolbar, which they can't slide under. Moving them below the toolbar would pull a menu away from the pointer. The Inspector is on layer 12, under the selection toolbar, which is why it needed the line.
- **The person-required line** moved from z 10000 to the notice layer (58), like every toast, so a modal (60) can now cover it.
- **Toasts not moved**, each checked:
  - "Agent log hidden · Show again" (`.agent-log-hidden-notice`) stays in the log's own spot. Justin's Q38 answer put it "in the log's spot for 6 s", and keyboard focus moves to it from the log. It's a question for GM, below.
  - The backend-connection and provider-recovery banners are top-of-window system banners, not bottom toasts.
  - The Settings notice bar sits inside the Settings panel, the moodboard board notices sit at the top of the board, and node overlays (Jev, mesh, world viewers) and the Cinema shot error sit inside their own boxes. None of these is an app-level toast.
- **Other Studio screens** (GM 4: "treat each the same way"):
  - Creator Studio has the only bottom composer.
  - Moodboard (Board and List), Character, Cinema and Commons have their toolbars at the top and nothing at the bottom, so notices stay 24 px off the bottom there.
  - The Remotion video editor has a 320 px timeline tray along the bottom. That is a work surface, not a bar, so I didn't make it publish (question for GM below).

## Tradeoffs

- **Panels now stop 54 px higher on the canvas** (62 px above the bar's top, against 8 before). That's the band, as GM asked. A low node's Inspector shifts up beside it, and in a short window it gets shorter and scrolls.
- **The band is one notice tall.** A taller stack (two lines, a toast plus a notice, or the proposal bar) still sits over a panel's lower part while it shows. GM built the band as one notice, and the For GM section asks about the proposal bar.
- **A multi-line notice** (an import's warnings, `pre-line`) is taller than the band, so its top can reach into a panel above it while it shows.
- **All slots share the region's 16 px gutters and centring.** The moodboard toast used to centre over the board column (between the rail and the panel). It now centres in the window.

## Surprises

- The previous builder had done all seven parts, with tests written first, and stopped before the notes, the live check, the related test runs and the build.
- A test outside its new files still listed the removed class: `tests/canvasFit.test.ts` "keeps fitted nodes above an open proposal bar" put chrome on `.proposal-bar-panel`. It failed once the class was gone. Fit view itself reads `.notice-region__stack`, which now holds the bar, so the test moved to that class (and its cleanup list too).
- "Restored the node. 1 proposal couldn't be reopened." is easy to make live. Delete a node with a canvas proposal on it, restart the backend (canvas proposals live in memory), then press Cmd+Z.
- In GM's setup the clamped Text Input body still cuts the State row (now under a 12 px fade). It scrolls now, and the cut reads as a fade.

## Stack writers checked (part 7)

Every write goes through the middleware, so each of these keeps the rule. I listed them from every `undoStack:` / `redoStack:` in `store/graphStore.ts`. Nothing else writes either stack (no in-place push/pop/splice anywhere in `src`).

- `pushUndo` (and through it `beginUndoStep`, `updateNodeData`'s debounced steps, deletes, adds, wires, duplicates, arrange): pushes a snapshot and clears `redoStack`.
- `cancelUndoStep`: pops a step that turned out empty.
- `foreignEditStep` (an agent's edit from graphSync): pushes the agent's entry and clears `redoStack`. A `graphReplaced` sync with no edit empties both.
- `stepHistory` (undo / redo): moves the entry, sets the new notice in the same update.
- `sendRestore` failure: puts the step back and sets an error notice (no offer).
- `addNodeAndConnect`: pushes its snapshot and clears `redoStack`.
- `loadGraph`, `loadProjectGraph` (project switch, also sets `undoNotice: null`), `clearGraph`: replace or empty the stacks.
- The store's initial state.

## From the previous builder

- **Found.** Uncommitted changes in 35 tracked frontend files, plus these new files: `components/InNoticeRegion.tsx`, `components/RegionNotices.tsx`, `hooks/useBottomBarClearance.ts`, `lib/noticeSlots.ts`, `styles/noticeRegion.css` and six new test files. Its scratch held `red.txt` (red counts on `84621738`) and a copy of the old region CSS. There were no notes and no live check.
- **State by part.**
  - Parts 1-7 were all built, and each had tests written first.
  - Done in this session: `tsc -b` and lint (clean), the related test files (one stale test, fixed), the build budget, the live check and these notes.
- **Changed of its work.** `tests/canvasFit.test.ts` (see Surprises). The rest stands as it left it. I re-read each part against the spec and GM's answers and confirmed it live.
- **Red first, re-checked.** I didn't trust `red.txt`. I exported `84621738`'s `frontend/` into scratch with `git archive`, linked this worktree's `node_modules`, copied the new and changed tests in and ran them there. The worktree itself was never reverted. The counts match `red.txt` exactly (below).

## Tests

Run against `84621738`'s code: **39 failed, 9 passed** across 7 files. The 8th file, `noticeRegionLayer.test.ts`, failed as a whole because `styles/noticeRegion.css` doesn't exist on the base.

- `tests/noticeFollowsStacks.test.tsx` (new): **7 of 10 red**.
  - Red: restore then a quick delete (the notice was still `{ id: 2, … }` with the DELETE pending); an agent's edit notice with Undo, then the person's step; "Undid Claude Code's edit" with Redo, then a new step; a graph replaced; a late restore answer after a new step (the notice came back); an agent's undo answer while its notice is gone; the component still rendering the line after a new step.
  - Passed on the base (guards, they can't be red): a notify error stays after a new step; without a new step, the late answer still says "Restored the node. 1 proposal couldn't be reopened." with Redo; undo, redo, undo each show their own notice and button.
- `tests/noticeBand.test.ts` (new): **8 of 9 red**. Reasons: `floatingTopLimit is not a function`, and the bottom limit read 721 against 667 (no band). Guard: "without a region on screen, nothing changes".
- `tests/components/NodeInspectorBand.test.tsx` (new): **9 of 9 red**. The Inspector ended at 721 against the band at 667 (821 against 767 at 1440x900). Its top was 32, 41 or 101 against the line at 149.
- `tests/contextMenuPlacement.test.tsx`: the new case, **1 red** (721 against 667). The 4 earlier cases passed.
- `tests/noticeRegionStack.test.tsx` (new): **12 of 12 red**.
  - Not in the region: the pin, asset trash, board, project-switch, Projects and person-required toasts, and the proposal bar.
  - Also red: the order; the toast-root list (the scan found 4 roots, not 5: the board toast's class was a template string then); the stylesheet scan (7 rules placed a toast themselves); and `--notice-stack-h` still in use.
- `tests/components/CreateView.bottomBar.test.tsx` (new): **1 of 1 red**. The composer had no `data-bottom-bar`.
- `tests/inspectorBodyFade.test.tsx` (new): **1 of 2 red**. The fade was a fixed 28 px. Guard: the body is the scrolling viewport with the foot outside it (true since #176).
- `tests/noticeRegionLayer.test.ts` and `tests/noticeRegion.test.tsx`: updated for the region's CSS file and the bar with no panel. On the base, the layer file fails to load.
- `tests/canvasFit.test.ts`: one case moved from `.proposal-bar-panel` to `.notice-region__stack` (not red-first; it kept an existing check working).

## Live check

Isolated stack on the builder ports:
- backend 8784, through `iso.sh` and `launch_backend.py`, whose network guard refuses every non-loopback request, with a temp HOME and state and no keys;
- Vite 5784 with `VITE_NEBULA_BACKEND_PORT=8784`. The proxy answered with the fresh, empty project list.

Puppeteer, with CDP `Network.setBlockedURLs` for 8000-8010 and 5173 on 127.0.0.1, localhost and [::1], plus the dead-proxy layer. The canary port 8799 was unreachable. **0 blocked requests**, 0 refused by the backend guard, no page error, no native dialog. **34 PASS, 0 FAIL** (`scratchpad/region-round2/live-results.json`, script `live-review.mjs`).

What I saw:
- **GM's setup, at 1280x800 and 1440x900.** A Text Input low and left of centre, deleted with a proposal on it, the backend restarted, then Cmd+Z: "Restored the node. 1 proposal couldn't be reopened." with Redo.
  - The node's floating Inspector opened to its right and ended at the band (666; 766). Its Run / Duplicate / Delete row (609-643; 709-743) was whole, clear of the notice (674-720; 774-820), and each button was topmost.
  - Redo was topmost, and a real click on it deleted the node again.
  - Shots for GM: `gm-cover-restart-1280.png`, `gm-cover-restart-1440.png`.
- **The band.** With and without a notice, the Inspector stayed at exactly the same box (573,366 260x300). The notice sat 8 px above the bar.
- **The proposal bar** sat in the region's top slot, outside `.react-flow`, 8 px above "Imported. One note.". Over an Inspector, Accept and Reject were topmost, and a real click on Accept accepted the proposal (a free text node; nothing ran).
- **Toasts.**
  - The Projects Undo toast sat in the region, 24 px off the bottom, centred, with Undo topmost.
  - The pin error toast and the person-required line stacked above a canvas error notice, 8 px apart, with no overlap.
  - After an agent switched the project, its toast sat 8 px above a notice, and the notice 8 px above the bar.
  - Not exercised live: the asset trash and moodboard toasts (component tests pin both in the region).
- **Creator Studio.** The notice sat exactly 8 px above the composer's measured top (602 against 610.5; 702 against 710.5). Shots: `gm-studio-notice-1280.png`, `gm-studio-notice-1440.png`. Back on the canvas, the bar published its own clearance again (72 px).
- **Near the top.** A node under the header: the Inspector opened at 150, which is the selection toolbar's bottom (142) plus 8.
- **The scrolling body.** A Nano Banana Inspector (body 185 px tall, 309 px of fields): a 12 px mask while there was more below, gone at the end, the foot row unmoved. Tab from the last field in view to "Image Size" scrolled the body (scrollTop 121) and put the field fully inside it.
- **Stale notice.** Restore, then a quick delete of another node. The notice went "Restored the node.|Redo" → none → "Deleted the node.|Undo". It never showed a Restored line without its Redo.
- **Click-through.** A click beside the notice, inside the region's box, landed on the canvas and deselected the node.
- **Resize.** From 1440x900 to 1280x800 with the Inspector open, it stayed between the top line and the band.
- **Reload.** One region with its band, and a notice 8 px above the bar.

I stopped both servers by port and deleted the state dir.

## Gates

- **`npx tsc -b`**: clean.
- **`npm run -s lint`**: clean (inline style and Slava CSS scope guards passed).
- **Vitest, the touched files and those that cover what changed** (97 files: everything importing the moved components, the region, the bottom bar, Fit view, the Updates corner, review, deferred chunks, the CSS files, plus every graphStore and undo/notice file for the store middleware), `--maxWorkers=3`: **97 files, 1201 tests, all passed**.
- **`npx vite build && node scripts/check-build-budget.mjs`**: passed, 366,637 bytes raw and 110,142 gzip against the 512,000 budget. That is 1.6 KB more than #176's 364,996, for the region's boxes and its CSS now in the entry. `dist/` was deleted afterwards.
- **Backend**: no backend file changed, so no backend tests ran locally. CI runs the whole suites.
- **After the review fixes:**
  - `tsc -b`: clean.
  - Lint: clean.
  - Vitest, the 44 files that touch or cover the shortcut scopes, the selection toolbar, Canvas, the Studios, the Inspector, the region and its toasts, with `--maxWorkers=3`: **44 files, 518 tests, all passed**.
  - Before that, a slip in my shell command passed a test file's text as filters, so a much wider run happened: **394 files, 5037 tests, all passed**.
  - Build budget: passed at 366,654 bytes raw and 110,133 gzip, against the 512,000-byte budget. `dist/` was deleted afterwards.

## Review

- **Three confirmed findings, each fixed with a test that failed first.** All three came from moving things out of their screen's DOM tree or from what gets measured. React portals keep React's tree but not the DOM's, and the screens' key handlers listen on the document and check the DOM with `closest()`.
  1. **Canvas keys from the proposal bar or the pin toast.** With focus on the bar (Review from Updates focuses it) or on one of its buttons, Cmd+Z, Shift+1, Cmd+= and Cmd+Enter did nothing, because the bar is no longer inside `.canvas-wrapper`. The pin toast's Dismiss had the same problem.
     - Fix: `lib/canvasShortcutScope.ts` now counts `.notice-region` as canvas-owned. A field or dialog in the region still keeps its keys, because that check runs first. Off the canvas both handlers still stop at their `viewMode` check.
     - Red first: `tests/lib/canvasShortcutScope.test.ts` (new case, `expected false to be true`). `tests/noticeRegionStack.test.tsx` "focus in the region leaves the screen its keys" also went red: it uses the real ProposalBar and PinComposer in the real region.
  2. **Moodboard Studio keys from its toasts.** With focus on the board toast or the asset trash toast, Cmd+Z, Shift+Cmd+Z and Cmd+S were ignored. Both toasts now portal outside `.moodboard-studio-view`.
     - Fix: `studioKeys.ts` also accepts `[data-notice-slot="board"]` and `[data-notice-slot="asset-trash"]`. I named only those two slots, as the reviewer suggested, so a line from another screen in the region (the person-required line) does not pick up the Studio's keys. A test pins this.
     - Red first: the stack test above, plus `MoodboardStudioBoard.test.tsx` "with focus on the toast in the notice region, Cmd+Z is still the Studio's". That test renders the real NoticeRegion beside the Studio, deletes a card, focuses the toast's Dismiss and presses Cmd+Z (`expected false to be true` on `defaultPrevented`).
  3. **The top line followed the selection toolbar's entry.** `data-top-bar` was on `.selection-toolbar`, which enters with `translateY(-6px) scale(0.98)`. `getBoundingClientRect` includes that transform, so the line started 6.5 px high and eased down, and a top-clamped Inspector moved with it.
     - Fix: the marker moved to React Flow's `Panel` around the toolbar (`Canvas.tsx`). The Panel passes extra props to its div and is never transformed vertically. With nothing selected it is 0 px tall, and `floatingTopLimit` skips it.
     - Red first: `tests/selectionToolbarTopLine.test.tsx` (new) renders the real Canvas, Panel and SelectionToolbar. It failed with `expected true to be false` because the toolbar carried the marker. Its second case is a guard and passed on the old code: the empty panel sets no line.
- **Live, on 8784/5784.** Same isolation as above: `live-findings.mjs`, CDP blocking plus the dead proxy, canary unreachable. **14 PASS, 0 FAIL, 0 blocked requests**, 0 refused by the guard, no page errors and no dialogs. Results are in `scratchpad/region-round2/live-findings-results.json`.
  - At 1280x800 and 1440x900, from no selection to a selection, the toolbar's own bottom moved 6.5 px over its entry (135.5 to 142). The measured line held at 150 on every frame. The page clicked Settings on the toolbar's first frame, so the Inspector opened during the entry. Its layout top was 150 on every frame. The only movement left is its own `slava-panel-enter` entrance.
  - A real click on the bar's "See what Accept writes" left focus on that button. Cmd+Z then brought back a node deleted from the selection toolbar, and Shift+1 fitted the view. Both keys were handled (`defaultPrevented`) with the target in the region.
  - In Moodboard Studio's List view, removing #1 showed "Removed #1 · Undo" in the board slot, outside the Studio. With focus on its Dismiss, Cmd+Z brought the image back (2 tiles) and Cmd+S was the Studio's (prevented, no browser save). Shots: `shots/top-line-1280.png`, `top-line-1440.png`, `canvas-keys-from-bar-1280.png`, `studio-toast-focus-1280.png`.
  - Also seen: an Inspector left open on a node that was then deselected moves up to the header line (72) when the toolbar goes. It moves back to 150 in one frame when the toolbar returns. That is the measured line doing its job ("the toolbar coming or going moves it at once"). Since the fix it is one step, with no ease.
- **Other key handlers, checked.** Only the canvas (`isCanvasShortcutTarget`) and Moodboard Studio (`isStudioShortcutTarget`) decide by which screen focus is in. The other document and window key listeners don't check that: Cmd+S/O in GraphFileActions, the command palette, the video editors (VideoPreview only skips controls) and Character Studio, which has none. Moving their toasts doesn't affect them.

## Open items

- The asset trash and moodboard toasts weren't driven live (their state is local to their screens). Component tests pin both in the region.
- The For GM questions below.

## For GM

- **What was built against each answer.**
  1. A band one notice plus its gap tall (54 px), always reserved. Floating panels stop above it, never move when a notice comes or goes, and a notice never covers Run / Duplicate / Delete (`gm-cover-restart-1280.png`, `-1440.png`). It applies to every floating panel, not only those over the region's span, because a notice's width follows its text and a long one spans the window.
  2. The proposal bar is in the region, on top of the stack, above the notices. Accept and Reject are topmost over any panel.
  3. Every toast is in the one stack: the canvas pin error toast, the asset trash toast, the moodboard toast (the List view's window toast is the same toast now), the project-switch toast, the Projects screen's Undo toast, and the "This tab isn't connected as you" line.
  4. Creator Studio's composer publishes its top edge, and notices sit 8 px above it (`gm-studio-notice-1280.png`, `-1440.png`). No other Studio has a bottom composer or bar (see the Remotion question below).
  5. A measured top line: below the header or the selection toolbar, whichever is lower, plus 8 px, for the floating and pinned Inspector.
  - The "one more": the clamped body scrolls under a 12 px fade, which goes away at the end of the scroll. The foot row stays fixed, and Tab scrolls a hidden field fully into view.
- **The stacking order, bottom up:** the canvas notice (Undo/Redo, errors), the asset trash toast, the board toast, the pin error toast, the Projects Undo toast, the project-switch toast, the person-required line, the proposal's run-later notice, and the proposal bar on top.
- **Question: the proposal bar over the foot row.** The band is one notice tall, so the proposal bar (about 106 px) stands above it. In your setup the Inspector ends at the band, and an open proposal bar then covers its whole foot row: Run, Duplicate and Delete at 601-665 under the bar at 560-666 (`gm-proposal-gm-setup-1280.png`; also `shots/proposal-over-inspector-1280.png`). Accept stays clickable. Keep it so (the bar is a decision waiting, and it goes when decided)? Or should panels also stop above the bar while one is open, which means they move when a proposal arrives?
- **Question: the late answer's count.** When the person moves on (a new undo step) before the restore's answer arrives, the "Restored the node. 1 proposal couldn't be reopened." line no longer shows at all, because its Redo would do nothing. So the count of proposals that couldn't be reopened isn't shown for that step. Should it show as a plain line with no button instead?
- **Question: "Agent log hidden · Show again".** It's a toast-like line with an action, but it sits in the log's own spot (bottom right) by Justin's Q38 answer, and keyboard focus moves to it when the log is hidden from the keyboard. I left it there. Should it join the region too?
- **Question: the Remotion editor's timeline.** It is a 320 px tray along the bottom, a work surface, not a bar. Notices sit 24 px off the bottom, over its tracks, while they show. Should the timeline publish its top edge like the composer (notices would then sit over the player)?
- **Not covered by your answers:** with the band, panels on the canvas stop 54 px higher than before, and a short window shortens the Inspector sooner. The moodboard toast now centres in the window rather than over the board column.
