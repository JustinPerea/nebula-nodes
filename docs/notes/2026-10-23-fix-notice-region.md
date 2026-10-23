# 2026-10-23 — Notices above every panel, and an Inspector that stays whole

Branch `fix/notice-region`, from main `43d43186` (the merge of #174, error copy 3g). Frontend only: no backend file changed (the review fix adds one line to the frontend graph store). No package installed, no paid provider call.

## What changed and why

GM - Design looked at the screenshot where the floating Inspector covered "Restored the node. 1 proposal couldn't be reopened." and its Redo, and decided: "move the notice out of the canvas layer. Making the Inspector keep clear would only fix this one panel, and the next panel that floats there would cover it again." And: "Put notices in one app-level region above every panel (above layer 10), bottom-centre, sitting just above the bottom bar. Proposal-bar notices and every 3g canvas notice go there." "A notice with an action never sits under anything, and the region never takes pointer events outside its notices." The separate bug: "the Inspector opened low runs past the bottom edge, so its Run / Duplicate / Delete row is cut off and it overlaps the bottom bar. Clamp it so it stays above the bottom bar inside the viewport. When there's no room below the node, flip it up or shift it, so its foot row is always whole."

- **Why the notice was covered.** `CanvasUndoNotice` rendered inside the proposal bar's React Flow `Panel`, inside `.react-flow`, which is a z-index 0 stacking context. The Inspector is fixed at layer 12, so it drew over the notice, and no z-index inside the canvas could lift the notice out.
- **One app-level region.** `components/NoticeRegion.tsx`, mounted once by `App` beside the screens (every screen but Projects and the brand demo, as before). It is outside `.react-flow` and outside every Studio's stacking context. It holds:
  - on the canvas, the proposal bar's own notice ("Added {agent}'s nodes. Run them when the current run finishes.", now `components/canvas/DeferredRunNotice.tsx`) and the canvas notice with its Undo or Redo;
  - on every other screen, `StudioNotice` (the canvas notice's written lines).
  - It is a deferred chunk (`DeferredNoticeRegion`, replacing `DeferredStudioNotice`), so the first-load entry doesn't grow.
- **Placement.** Bottom-centre. On the canvas it sits 8 px (`--sr-space-2`) above the bottom bar's measured top. With no bar (the Studios) it sits at the bar's own distance from the bottom edge (24 px, `--sr-space-6`), where `StudioNotice` sat before.
  - The bar measures itself. `lib/bottomBar.ts` reads every box marked `data-bottom-bar` (the bar and, while open, its Canvas actions panel). The bar's `Toolbar` publishes the distance from the window's bottom to its top as `--bottom-bar-clearance` on the root, on mount, on resize (ResizeObserver and window resize), and when its actions panel opens or closes. The region's CSS reads that variable. When the bar unmounts, it clears the variable.
  - When the actions panel opens, the notice moves up above it on the undo notice's spring (`--agent-log-spring`), so the two never overlap.
- **Layer.** A new token, `--sr-layer-notice: 58` (slava-restraint.css). See Decisions.
- **Pointer events.** `.notice-region` and its stack are `pointer-events: none`. Each notice keeps `pointer-events: auto`, as `.canvas-undo-notice` and `.proposal-bar` already had. The region spans the window's width above the bar, so a click in its empty space lands on whatever is under it.
- **What a notice does is unchanged.** It keeps its role (status, or alert for an error), its Undo/Redo and Dismiss buttons, its keyboard reach, its tone, its agentColor and its spring entrance. Main has no hold-while-hovered: that is #175's (`fix/undo-restores-deletes`), and it keeps working because this branch doesn't touch the notice's own code.
- **The proposal bar.** Its panel now holds only the bar. `ProposalBar` no longer reads `undoNotice` (`hasUndoNotice` is gone), and it returns nothing without a proposal. Its panel's `gap: 8px` is gone, because the panel only stacked the bar and the notices.
  - Without a fix, the bar and the notices would now overlap, since both sit just above the bottom bar. So the region publishes `--notice-stack-h` (the notices' height plus the 8 px gap), and the bar's panel adds it to its `margin-bottom` (`calc(78px + var(--notice-stack-h, 0px))`). The bar stays above the notices with the same gap as when they shared the panel, so nothing jumps that didn't jump before.
- **Places that measured the old panel for its notices.** The Updates corner's list of things to stop above (`AgentNotesCorner` `BELOW`) and Fit view's chrome (`lib/canvasFit.ts`) used to get the notices through `.proposal-bar-panel`. Both now also read `.notice-region__stack`. An empty stack has no height, so both skip it.
- **The Inspector stays whole.** I fixed two causes.
  1. *Placement* (`NodeInspectorPopover.measurePopoverFrame`):
     - It used to clamp beside-the-node placements to `innerHeight - 16`, so it ran over the bar.
     - Now every placement ends above `floatingBottomLimit`: 16 px off the window's bottom, and 8 px above the bar's measured top when there is a bar.
     - Beside the node, it shifts up. Under the node, it flips above it when under would cross that line, and otherwise shifts.
     - The final left and top are clamped on every placement, so a node at the left edge or above the top edge keeps it inside too. Before, a node off the left edge put it at x = -40.
     - The 300 px height becomes the room there is when the window is shorter than that.
     - The popover already re-places itself every frame, so a resize, a pan, or the bar growing moves it at once.
     - The pinned Inspector replaced its fixed `BOTTOM_GUTTER = 80` with the same measured line. In a window too short for that, it keeps its smallest size, as before.
  2. *The foot row scrolled*. Run / Duplicate / Delete was the last thing in the Inspector's scrolling body. With more than about 300 px of fields, it scrolled out of sight under the body's fade. That cut it off even in the middle of the screen. In GM's screenshot the panel ended at the bar and the row was cut by the scroll.
     - Now the row sits in the popover's foot (`.node-inspector-popover__foot`), outside the scrolling body. The Inspector renders it through `InspectorFoot` (`components/panels/InspectorFoot.tsx`, with its context in `inspectorFootContext.ts`), a portal into the slot the popover provides.
     - The DOM order stays body then foot, so the keyboard order matches the screen.
     - Without a slot (the Inspector rendered on its own in tests), the row stays in place.
- **Other panels that open beside a node or at a point.** I checked them all:
  - **Context menu** (`ContextMenu`): same bug, worse. It opened at the pointer with no clamp at all, so near the bottom its Delete ran under the bar or off the window. I fixed it the same way: measure, then clamp inside the window and above the bar, and again on resize.
  - **Next-step drop picker** (`ConnectionPopup`): it clamped to the window only, so dropped just above the bar it opened over the bar. It now clamps to the same line.
  - **Provider chip popover** (`ProviderSwitcher`): it flipped up only when it ran off the window. It now flips when it would cross the bar.
  - **Asset-move menu** (`anchoredPopover`): it opens in the Assets dock and the Studios, where no bottom bar is on screen. `floatingBottomLimit` would give the same window edge it already uses, so it is unchanged.
  - **Command palette and onboarding**: centred modals, so they are out of scope.
- **Agent support.** None to add. This is layout only: agents read no notice and no position, so there is nothing for MCP, the `nebula` CLI, docs/MCP-SETUP.md or skills/nebula/SKILL.md.

## Decisions not in the spec

- **The notice layer is 58.** It sits above the panels (10), the floating Inspector (12), the Agent log (11), the Updates corner (46, or 55 when it's over a Studio), Settings (30), popovers (40), the Studios (50) and the docks over a Studio (chat 55, Settings 56). It sits below modals (60, 61).
  - Why above popovers: a context menu or the drop picker can open anywhere, including the bottom-centre spot. GM's rule is that a notice with an action never sits under anything, and with #175 the notice carries every delete's only on-screen Undo.
  - Why below 60: a modal dialog that blocks the app (the mesh viewer, a prompt dialog) may cover it, as the brief allows. Some toasts and popovers also use a raw 60 (project switch toast, asset trash toast, moodboard window toast, provider-switcher popover, create gallery). The project switch toast now stacks above the notices instead of covering them (see Review). The others are open items.
  - Raw z-indexes above that (command palette 1000, onboarding 1100, connection banners 10000) are modal or system banners, and they stay above it too.
  - Before, `StudioNotice` sat at a raw 1100, above everything. On the Studios the notice now sits under modals, as GM's rule asks.
- **The region spans the width** (16 px gutters) and centres its stack. It doesn't use `left: 50%` with a transform. That way a wide notice isn't squeezed into half the window, and the click-through has a real empty area to prove.
- **The Canvas actions panel counts as part of the bar, but only over its own width.** The notices are centred, so an open panel always lifts them above it. A floating panel is pushed up only when it is over the panel (see Review). The bar itself stays a band across the whole width.
- **Measured, not a token, for the bar's top.** The bar's height changes with its contents (Stop instead of Run, the paid chip) and its panel opens above it. So JS measures it (`bottomBarTop`), and CSS reads what the bar publishes. Both come from one function.
- **Mount conditions unchanged.** The region doesn't mount on Projects or the brand demo, as before. A notice set there waits, as it did.
- **The Inspector's action block keeps its old indentation** inside the new `<InspectorFoot>`. Re-indenting it would touch the lines #175 changes (the Delete button's handler).

## Tradeoffs

- In GM's setup, the notice now covers part of the Inspector's foot row (Run and Duplicate) for as long as it shows. This follows from both rules: the notice sits just above the bar and above every panel, and the Inspector ends just above the bar. The row is whole and reachable again when the notice goes. It's a question for GM (see open items).
- A popover opened at the bottom-centre spot (a context menu, the drop picker) can be covered by a notice while it shows. That's the price of "never under anything".
- `--notice-stack-h` lifts the proposal bar when a notice appears, as the shared flex panel did. It doesn't animate. It didn't before either.

## Surprises

- The foot row was cut off by the Inspector's own scroll, not by the window edge. The popover never ran past the window (it clamped to `innerHeight - 16`). It ran under the bar, and its 300 px body scrolled the row out of sight. GM's "runs past the bottom edge" was the row disappearing under the body's fade.
- The context menu had no clamp at all.
- In the live check, an agent's edit and its undo move the camera (it follows the agent). The script re-pans the node low after the undo, while the notice holds.
- The three-way merge with #175 is clean. I ran `git merge-file` with base `43d43186` against `origin/fix/undo-restores-deletes` on `CanvasUndoNotice.tsx`, `Inspector.tsx`, `ContextMenu.tsx`, `StudioNotice.tsx` and `errorCopy.round3f.notices.test.tsx`: 0 conflicts each. This branch's only edit to `CanvasUndoNotice.tsx` is one comment line.

## Tests

Written first. All of these failed on `43d43186` before the change: **24 failing** in 9 files (93 others in those files passed).

- `tests/noticeRegion.test.tsx` (new, App-level; the Canvas fixture is a `.react-flow` box holding the real proposal bar). 6 red. Pins that the canvas undo notice with Redo, a `canvasNotice` error, the proposal bar's Run-later notice, and a Studio's notice all render in the one region, with the region outside `.react-flow` and outside the Studio as a direct child of the app root. It also pins one region across a screen switch, and clicks around the region.
  - The click test injects the real stylesheet and checks the computed `pointer-events` (none on the region and its stack, auto on the notice). It then applies the browser's hit-test rule: the pane under the region's empty area gets the click, and the notice gets clicks over it. jsdom does no hit testing of its own, so the live check repeats this with real clicks.
  - On the first red run, the Redo test failed on a different assertion: it found the app's "Saved" status first. I changed it to find the notice by its text. On base it fails because no region exists.
- `tests/noticeRegionLayer.test.ts` (new). 4 red, 1 passing guard (each notice already took pointer events). Pins:
  - the `--sr-layer-notice` token sits above panel, Inspector, Agent log, Settings, popover, workspace and workspace-overlay + 1, and below modal;
  - the `.notice-region` rule: fixed, on that layer, `pointer-events: none`, bottom from `--bottom-bar-clearance`;
  - `.studio-notice` is gone;
  - the proposal panel has no gap and lifts by `--notice-stack-h`.
- `tests/components/NodeInspectorPlacement.test.tsx` (new). 6 red, 5 passing guards (flip above, near the top, right edge, no bar, pinned).
  - Red: GM's setup (ended at 729, under the bar at 729), a node on the bar (784), 1440x900 (852 against 829), a node off the left edge (left -40), a resize to a shorter window (884 against 829), and the bar growing with its actions panel (729 against 480).
- `tests/components/InspectorFootRow.test.tsx` (new, real Inspector inside the real popover). 1 red: there was no foot, and Run / Duplicate / Delete sat inside the scrolling body.
- `tests/contextMenuPlacement.test.tsx` (new). 3 red: bottom 850 against bar 729, right 1470 at a 1280 window, and 650 against a 560 window after a resize.
- `tests/ProposalBar.test.tsx`: "leaves its notices to the app's notice region", 1 red (the panel rendered both notices). The existing "adds without running …, then offers Run" now renders `DeferredRunNotice` beside the bar, where the offer lives now.
- `tests/components/Toolbar.test.tsx`: "publishes where the bar starts, its open Canvas actions panel included", 1 red (no `data-bottom-bar`).
- `tests/ConnectionPopup.test.tsx`: "a picker dropped just above the bottom bar opens above it", 1 red.
  - Its first red run failed on the dialog's name (it is "Add next step" with a next step). After I corrected the name, I re-ran it against the base `ConnectionPopup.tsx`: red, 792 against the bar at 729. The mock's `getBoundingClientRect` also answers for `data-bottom-bar`.
- `tests/components/ProviderSwitcher.test.tsx`: "the chip popover flips above the chip rather than over the bottom bar", 1 red.

## Review

- **Review (2026-10-23), two confirmed findings, both fixed tests first.**
  - *Opening Canvas actions pulled the Inspector off its node.* `bottomBarTop()` took the lowest top of every `[data-bottom-bar]` box over the whole width, so the 310 px centred actions panel (485-795 at 1280) pulled a far-left floating Inspector about 300 px up (to 104), and shrank the pinned Inspector on the left rail from 440 to 388, with no overlap at all. Fix: the panel is marked `data-bottom-bar="panel"`, and `bottomBarTop(span)` / `floatingBottomLimit(gutter, height, span)` skip it when it doesn't overlap the caller's horizontal span. The bar itself is still a full-width band. `measurePopoverFrame` and `measurePinnedFrame` now work out width and left first (they never depended on height) and pass their span. The other callers that clamp to the bar the same way (the context menu, the drop picker, the provider chip popover) pass their span too. `publishBottomBarClearance` passes none, so the centred notices still clear the open panel.
  - *The project switch toast covered the notices.* It sat at a fixed `bottom: 96px` on raw z 60, centred like the region, so it drew over the top 28 px of a notice, buttons included. GM: "A notice with an action never sits under anything." It wasn't new (the old notice sat in `.react-flow` at z 0). Fix: its bottom is now `calc(var(--bottom-bar-clearance, 88px) + var(--sr-space-2, 8px) + var(--notice-stack-h, 0px))`, so it stacks 8 px above the notices, as the proposal bar does, and keeps its old 96 px with no bar and no notice. It moves on its own spring (`--project-switch-spring`, off under reduced motion). The second half: `loadProjectGraph` never cleared `undoNotice`, so the old project's "Claude Code changed the canvas" line and its Dismiss followed onto the new canvas. It now sets `undoNotice: null` with the stacks. A notice for the new project (an Open's warnings) is set after the load, so it still shows.
  - Tradeoff: on the canvas the toast now rests 8 px above the bar (bottom 80) instead of 24 px above it (96).
  - Tests, red first on the uncommitted builder change: **5 red** in 4 files. `NodeInspectorPlacement.test.tsx` "leaves the floating Inspector level with a node on the far left" (top 104 against 421) and "leaves the pinned Inspector on the left rail its full height" (388 against 440); `contextMenuPlacement.test.tsx` "opened on the left while Canvas actions is open in the middle, it stays at the pointer" (254 against 400); `graphStore.projects.test.ts` "clears the canvas notice …" (the notice was still set); `noticeRegionLayer.test.ts` "the project-switch toast … stacks above the notices" (it still read `bottom: 96px`). The existing "follows the bar when it grows" case now marks its panel `panel` and still passes (an Inspector over the panel is pushed above it), and the Toolbar test now pins the `panel` value.
  - Live re-check on 8796/5796 (same isolation, `scratchpad/notice-region/live-review.mjs`): **30 PASS, 0 FAIL**, **0 blocked requests**, 0 refused by the backend guard. The 24 earlier checks again, plus: a far-left node's Inspector stayed at 212-472 x 420-720 with Canvas actions open at 485-795 x 412 (I didn't run the old code live; its jsdom test put it at 104); the pinned Inspector stayed 440 tall; an Inspector over the panel still ended at 404 above its top at 412; after an agent's edit and an agent switching the project, the old notice was gone; with a notice and the switch toast both showing, the toast ended 8 px above the notice (670 against 678), and the notice's Dismiss was topmost; alone, the toast rested 8 px above the bar (720 against 728). Shots: `review-actions-far-left-1280.png`, `review-actions-pinned-1280.png`, `review-actions-centre-1280.png`, `review-switch-toast-notice-1280.png`; `gm-setup-1280.png` and `gm-setup-1440.png` were re-shot (same layout as before).

## Live check

Isolated stack on the builder ports:
- backend 8796, through the scratchpad `iso.sh` and a launcher whose network guard refuses every non-loopback request, with temp HOME and state and no keys;
- Vite 5796 with `VITE_NEBULA_BACKEND_PORT=8796`. Curl through Vite answered with the fresh, empty project list.

In the browser:
- Puppeteer, with CDP `Network.setBlockedURLs` for 8000-8010 and 5173 on 127.0.0.1, localhost and [::1], plus the dead-proxy layer. The canary port 8799 was unreachable.
- **0 blocked requests**, and 0 outside requests refused by the backend guard. No paid call, no native dialog, no page error.
- **24 PASS, 0 FAIL** (`scratchpad/notice-region/live-results.json`).

What I saw:
- **GM's setup at 1280x800 and 1440x900.** A Text Input node low and left of centre, the floating Inspector beside it, and an agent's edit made through the API and undone with Cmd+Z: "Undid Claude Code's edit" with Redo.
  - The notice sits 8 px above the bar (720 against 728; 820 against 828), centred, in the region (z 58), outside `.react-flow`.
  - It overlaps the Inspector (z 12), and `elementFromPoint` at Redo's centre is Redo. A real mouse click on Redo redid the agent's edit.
  - The Inspector ends at 720 (820), above the bar at 728 (828), and its Run / Duplicate / Delete row is whole inside it.
  - Shots: `gm-setup-1280.png`, `gm-setup-1440.png` (for GM).
- **A `canvasNotice` error:** an alert in the region, above the Inspector, with Dismiss topmost at its centre (`canvas-error-notice-1280.png`).
- **A click beside the notice**, inside the region's box (which spans the width): `elementFromPoint` is the React Flow pane. A real click there deselected the node.
- **Canvas actions open:** the notice moved above the panel (404 against its top at 412) (`actions-open-notice-1280.png`).
- **A node above the top edge** (top at -36 px): the Inspector opened beside it at top 16, whole (`near-top-1280.png`).
- **A resize from 1440x900 to 1280x640** with the Inspector open beside a low node: it moved from 517-817 to 260-560, above the bar at 568 (`resized-1280x640.png`).
- **Creator Studio:** an error notice in the same single region, above the Studio (58 against 50), 24 px off the bottom (`studio-notice-1280.png`, `studio-notice-1440.png`).
- **A reload:** one region, and a new notice 8 px above the bar (`after-reload-1280.png`).

I stopped both servers by port and deleted the state dir.

## Gates

- **Backend pytest**, the whole suite through `iso.sh` (no backend file changed): 10212 passed, 71 skipped, 1 failed. The failure was `test_agent_guardian.py::test_sigkilled_backend_leaves_no_agent_or_descendant_behind`, which is timing-based: two child PIDs were still alive at the moment it checked, with the machine heavily loaded. That file re-run alone: 5 passed, and the two PIDs were gone.
- **Frontend `npx vitest run`**, the whole suite: 4911 passed, 79 failed in 39 files. They were timeouts under load: 61 "timed out" lines, in Commons, Cinema, Create, Settings and the Studios. The 39 files re-run alone (`--maxWorkers=3`): 39 files, 501 tests, all passed.
- **`npx tsc -b`**: clean.
- **`npm run -s lint`**: clean, including the inline style and Slava CSS scope guards.
- **`npx vite build && node scripts/check-build-budget.mjs`**: passed, 365,058 bytes raw and 109,337 gzip against the 512,000 budget. The region and the Inspector's foot are in deferred chunks. Only `lib/bottomBar.ts` and the bar's measuring hook joined the entry.

- **After the review fixes (2026-10-23):**
  - Backend pytest, the whole suite through `iso.sh`: 10213 passed, 71 skipped, 0 failed.
  - Frontend `npx vitest run`, the whole suite: 4973 passed, 22 failed in 10 files under load (16 "timed out" lines, plus focus and find-by-role misses in the same slow files). The 10 files run again on their own (`--maxWorkers=3`): 10 files, 170 tests, all passed.
  - `npx tsc -b`: clean. `npm run -s lint`: clean (inline style and Slava CSS scope guards passed).
  - `npx vite build && node scripts/check-build-budget.mjs`: passed, 365,263 bytes raw and 109,402 gzip against the 512,000 budget.

## Open items

- **For GM: the notice over the Inspector's foot row.** In GM's setup the notice covers Run and Duplicate while it shows (`gm-setup-1280.png`). Keep it (it's transient, and the row is whole when the notice goes)? Or should floating panels also stop above a showing notice, as the proposal bar does (`--notice-stack-h`)? That would make them move when a notice comes and goes.
- **For GM: the proposal bar can be covered by a floating panel.** It is still in `.react-flow` (layer 0), so a floating Inspector opened over the bottom centre covers it, Accept included. I didn't move it, as the brief said.
- **For GM: Studio bottom chrome.** On Creator Studio, the notice at the bar's gap sits over the composer's bottom row (the model picker and the count) while it shows (`studio-notice-1280.png`). It sat there before too: `StudioNotice` was at the same spot, at layer 1100. The composer could carry `data-bottom-bar` and publish its clearance like the canvas bar, if GM wants notices above it.
- **Other toasts outside the region:** the project switch toast now stacks above the notices (Review). Still on their own: the canvas pin error toast (`.canvas-pin-toast`, role alert with Dismiss, z 30, fixed bottom 24 px) sits on top of the bottom bar, and a popover (40) can cover it; the asset trash toast (z 60, bottom 24 px, centred) and the moodboard window toast (z 60) sit at the region's no-bar spot, so on a screen without the bar they can cover a notice. Each could join the region, or stack on `--notice-stack-h` the way the switch toast does. GM named the canvas, 3g and proposal notices, so I left these for GM.
- **For GM: the switch toast and the proposal bar.** Both now stack above the notices. The proposal bar is still inside `.react-flow` (z 0), so the toast (z 60) can draw over it when both show; that was so before too.
- **The floating Inspector's top limit** is still the window's 16 px gutter, so a node at the top opens it over the workspace header and selection toolbar (`near-top-1280.png`). That's unchanged from before, but a measured top line like the bottom one would fix it.
- **After #175 merges:** its hold-while-hovered handlers live on the notice element, so they work in the region unchanged. Its `messagesOnly` change (the person's own "Deleted the node." keeps its Undo off the canvas) flows through `StudioNotice` as before.
