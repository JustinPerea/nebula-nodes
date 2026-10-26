# 2026-10-21 — Leaving the Commons with unsaved labels asks first

Branch `feat/commons-leave-popover`, from main `66221141` (after #163). Uncommitted (the coordinator commits). No paid provider call, no package installed, no backend file changed.

## What changed and why

- **The brief.** #163 kept unsaved Commons labels by holding every exit and disabling the Commons' Back, Projects, tabs and More, with the reason "The Commons has unsaved changes: save or discard them first." as a title. GM - Design (visual design and copy) decided the person-facing treatment, built here as written:
  1. "Tabs and More need no guard: moving between sections of the same Commons is not leaving."
  2. "Real exits ask instead of being disabled": a popover anchored to the clicked button, with "Your labels aren't saved." and "Save and leave" (primary), "Discard and leave", "Stay".
  3. The popover runs each panel's own save or discard, then leaves.
  4. A save in progress makes a leave wait; it reads "Saving…" after about 300 ms. A failed save shows "Couldn't save your labels." and the reason. Agent review's running state gets its own ask.
  5. "Unsaved" shows beside each panel's Save, and the tab gets a dot.
  6. The project-switch toast doesn't time out while a switch is held behind the Commons.
- **Tabs and More (1).** I lifted the state, not the fallback. Blind labeling and Agent review now **stay mounted once opened**, hidden while another section shows (`.commons-panel-slot` with `hidden`; shown, it is `display: contents`, so each panel stays the view's grid item). Their drafts live as long as the Commons, and so does a grading run. This is lifting the panels' lifetime to `CommonsView`, which owns them, instead of copying each draft into a store. It was the smaller and safer change. The drafts are spread over two components each (the batch, the open reference's form, the crosshair, the editing toggle), and Agent review's grading loop would have needed lifting too, or a tab switch would stop it. Tabs and More are enabled again. `setCommonsUnsaved` now reflects the panels' reported work, not whether a panel is mounted: it is true while a draft is unsaved, a label write is in flight, or Agent review is grading.
  - A panel coming back into view reloads what may have changed meanwhile, but only when no draft is open. For example, an agent grade turns Blind labeling's Seal into the assisted close. Before, a fresh mount did that. Agent review skips its 5 s poll while hidden.
- **The panel contract (3)** is `onWork(work | null)` in `components/commons/commonsLeave.ts` (lazy, in the Commons chunk), replacing `onDirtyChange`. The panel reports `{ unsaved, saving: Promise<SaveResult> | null, running, save(), discard(), stop() }`.
  - Blind labeling's `save` is the open step's own button: Save accents & reveal labels before the palette shows, Save labels after. Its `discard` is "Discard unsaved changes".
  - Agent review's `save` is "Save corrections & next" (its accept), and its `discard` is "Discard changes".
  - `lib/commonsUnsaved.ts` stays a plain module (no store field, nothing renders from it). It gains three small pieces: `whenCommonsClean`, `setCommonsLeaveAsk` (registered by `CommonsView`) and `askBeforeLeavingCommons`, the corner's way to ask.
- **Real exits (2).**
  - The Commons' Back and Projects are enabled, with no "save or discard" title. `WorkspaceHeader` loses `homeBlocked` and gains `onHome`, `backRef`, `backBusy` and `homeBusy`.
  - A click calls `useCommonsLeave().request`. If nothing is open it goes at once. If a save is in flight it waits for it. Otherwise it asks.
  - The Updates corner's Show, See all and Review call `askBeforeLeavingCommons(clickedButton, step)`. The step runs again only after a leave. The corner's list stays open under the popover: its outside-click close skips `[data-leave-popover]`. Its buttons now pass the clicked element, and they read "Saving…" through `BusyButton` and `LeaveBusyContext`.
  - `goToCanvas`, `goHome` and `reviewAssetProposal` still refuse while unsaved. That is now only the net under any caller that didn't ask.
  - A Review on a **Commons** ask from inside the Commons no longer refuses or asks. It opens the reference in All, another section of the same Commons, so (1) applies.
- **Browser Back or an in-app hash change (2).** The existing hashchange hold stays. `CommonsView` pushes `oldURL` back, and the popover now opens anchored to Back. The leave is `history.back()`, run once the Commons is clean. After the refused Back, history is `[…, E, #commons*]`, where E is the entry they went back to. One Back from there lands on E: the canvas entry for Back, or `#brand` for a typed hash. The `#commons` entry is now forward, so one more Back goes further back and never into the Commons. This is tested in jsdom with the real `history.back()`: the entry before, then the canvas entry, then `#commons`. Leave lands on `?entry=canvas`, and the next Back on `?entry=before`. It was checked live too.
- **In flight (4).**
  - **A save already in progress.** The leave waits with no popover. After `BUSY_AFTER_MS` (300 ms) the clicked control reads "Saving…" with `aria-busy="true"` (Back, Projects, or the corner button). If the save fails, the popover opens with "Couldn't save your labels." and the reason, above the three buttons. If it succeeds, the leave goes; if something else is still open (the other panel's draft, a grading run), the popover asks about that. Save and leave in the popover marks its own button the same way, and stays open with the failure line if it fails.
  - **Agent review grading: leaving stops it**, so it asks. I read the panel and the backend. `CommonsReview.generate()` is a frontend loop: one `POST /api/commons/review/items/{n}/propose` per pending reference, and each route call (`commons/review.py` `propose`) grades just that one. Nothing on the backend goes on to the next. When the panel unmounts its loop breaks, and the remaining references stay pending until the person presses "Generate remaining grades" again. So the popover reads "Agent review is still running." with "Stop and leave" (primary) and "Stay". Stop and leave stops the loop: no further grade is asked for. The one already in flight can't be called back, since it is metered once and already running. It finishes on the backend and its grade is kept (status `ready` or `failed`, as for a crash). When labels are unsaved too, the popover shows "Your labels aren't saved." with the second line "Agent review is still running.", and both leaves stop the run.
- **Visible state (5).**
  - "Unsaved" shows in the panel's muted ink (`#6d7a63`, its own `small` and `p` colour on the light form card) beside each panel's Save. It uses the section eyebrow's letterforms (10 px, uppercase, 1.5 px tracking): #157's heading pattern.
  - The tab that holds unsaved labels gets a 6 px dot in `--sr-warning`, the app's attention dot (`settings-row__dot--warn`), not orange. "· Unsaved" goes in its accessible name as visually hidden text: "Blind labeling · Unsaved". Agent review's tab gets the same mark when its corrections are unsaved, so the state shows from any section.
  - At 1280 with the Updates chip, Blind labeling folds into More, and More carries the dot. Its name is then "More: Blind labeling · Unsaved".
- **The toast (6).** `ProjectSwitchToast` keeps no timer when a switch arrived while the Commons was showing (a held switch, #163). Its 15 s start once the person leaves the Commons. A switch that already reached the canvas times out as before.
- **Motion and focus.**
  - The popover springs in on the corner's POP spring (`springCssVars()` from `lib/springs.ts`, `--spring-pop` and `--spring-pop-ms`), with opacity and a 0.97 scale. There is no animation under `prefers-reduced-motion`.
  - Focus moves to the primary choice when it opens, and Tab and Shift+Tab stay among its buttons. Escape and Stay return focus to the clicked control, or to Back when that control is gone. A press outside is Stay: focus stays where the press put it, or goes back to the control when the press landed on nothing focusable.
  - The ring is the app-wide neutral `--sr-focus-outline` from the global `:where(… :focus-visible)` rule. No `outline: none` was added; `focusRingCss.test.ts` passes.
- **Reuse.** The popover reuses the toolbar menu's anchoring. I moved `ToolbarMenuPopover`'s placement and dismissal (outside press, resize) into `components/asset-move/anchoredPopover.ts` (`useAnchoredPopover`, `placeBeside`). Both the Move and More menus and the leave popover use it now. It adds `start`, `end` and `auto` alignment and opens above when there's no room below. The menus keep `end`, as before. The popover takes the menu's surface and the Commons' `commons-button` classes. It is a menu with a message, so it's `role="alertdialog"` (like `CommonsCloseBatch`), not `role="menu"`.

## Decisions not in the spec

- **Preparing the held-out set no longer holds the Commons.** Before, Blind labeling reported "busy" for any request, and Prepare (a folder scan that can take minutes with iCloud downloads) held every exit. Under the new rule, a leave during Prepare would have read "Saving…" for minutes. Prepare isn't a label save, and it finishes on the backend. So only label writes count as `saving`: accents, labels, seal, and Agent review's accept. After review, the scan also outlives the panel (see Review below), so leaving mid-scan loses neither its batch nor its error.
- **Both panels at once.** Save and leave saves every panel holding a draft, in turn, and Discard and leave discards each. Either one stops a grading run.
- **A second click on the same control is Stay** (the toggle the toolbar menus have). The browser's Back while the popover is open keeps it open.
- **The popover sits above the toast**: z-index `--sr-layer-modal-control` (61) against the toast's 60, so a toast can never cover it.
- **The toast over the Commons stays clear of the form column.** Live at 1280, the toast's right edge reached 4 px into the labeling panel's form card. Save itself was clear, but a longer project name would have reached it. Over the Commons (`body:has(.commons-view)`) the centered toast caps its width at `100vw − 2 × (418 + 8) px`: 428 px at 1280, 588 px at 1440. 418 px is the form column's 390 px plus the panel's 28 px padding. It wraps to two lines when longer. It stays bottom-centre, as it is everywhere else, so I didn't need to move it above an anchor.
- **Row and card-text clicks** (a corner row's Enter, a card's text) anchor the popover to the row. Those aren't buttons, so they don't swap their text to "Saving…".

## Budget

- `npx vite build && node scripts/check-build-budget.mjs`: main **504,194** raw / 148,010 gzip. This branch **505,041** raw / 148,384 gzip (**+847 B**). The entry grew by the shared anchoring (the toolbar menu is in the entry), the header's busy and onHome props, the toast's held state and its uiStore read. The popover, the controller and the panels are in the lazy `CommonsView-*` chunk (74,727 → 82,480 bytes). The corner's changes are in the deferred `AgentNotesCorner-*` chunk (27,197 → 27,915 bytes).

## Tradeoffs

- A hidden Agent review panel keeps its 5 s poll timer, but skips the request while hidden.
- While both panels are open, the Commons holds two batches in memory. They are small JSON objects.
- The corner's Saving… mark covers its buttons only (Show, Review, See all), not rows.

## Surprises

- `queryByText` still finds a hidden panel's text, so the tests check `toBeVisible()`.
- Inside `act`, an async save's state never flushes until the callback returns. A test that awaits the traversal inside `act` deadlocks; it polls with `waitFor` instead.
- The React Compiler lint (`react-hooks/refs`, `react-hooks/immutability`) refuses a ref passed into a `useState` initializer, and a prop ref written in an effect unless its name ends in `Ref`. So the controller keeps its own "latest work" box, and the panels take `draftRef`.

## Agent support

- Nothing agents call changes: no MCP tool, CLI command, `docs/MCP-SETUP.md`, `skills/nebula/SKILL.md` or INSTRUCTIONS change. The 3,000-character cap is untouched. Agents' and the system's exits (`open_project`, a second tab's conflict stop, the capability turning off, imports, node focus and the rest) stay held exactly as #163 built them, with no popover. Live, a real MCP stdio session's `edit_canvas`, `post_note`, `moodboard_create`, `propose_asset_change` and `open_project` all returned as before while the person's Commons was unsaved.

## Tests (written first)

- New `tests/commonsLeave.test.tsx` (22) runs the real `CommonsView` with stand-in panels on the contract. It covers:
  - enabled tabs and More, and the draft surviving Inbox and Settings
  - the tab's dot and name, and More's name
  - Back and Projects enabled with no title
  - the exact copy, the button order and the focus
  - Escape, Stay and a press outside as Stay, with focus back
  - Save and leave and Discard and leave running the panel's own save and discard, then leaving, and with two panels
  - Projects asking, then going home
  - the failure line
  - the 300 ms "Saving…" with `aria-busy`, then leaving, and its failure opening the popover
  - Agent review running: Stop and leave, and that a section switch doesn't stop it
  - real `history.back()` landing on the entry before, then one more Back staying out
  - Stay on browser Back
  - a `#brand` hash change
  - the corner's ask
- New `tests/commonsLeavePanels.test.tsx` (8) runs the **real** Blind labeling and Agent review inside `CommonsView`. It covers drafts across sections, "Unsaved" beside each Save, Save and leave sending the real label write, a failed write keeping the draft with the reason, Discard and leave, and a real grading loop stopped by Stop and leave (no second `propose`).
- New `tests/projectSwitchToastHeld.test.tsx` (2): no timer while held in the Commons, 15 s on the canvas, and the canvas case unchanged.
- Changed `tests/AgentNotesEveryScreen.test.tsx`, the "from the Commons with unsaved labels" block. Its expectation changed from refusal to asking. See all, Show and Review on moodboard and project asks now ask, anchored to the clicked button, and go once they leave. A Commons ask opens without asking.
- **On main, 43 of 102 failed** across the 6 files:
  - every commonsLeave test (no popover; `askBeforeLeavingCommons is not a function`; tabs disabled)
  - every commonsLeavePanels test (the panels unmount; no `.commons-unsaved`; no alertdialog)
  - the held toast case (it was gone at 15 s)
  - the 6 corner cases (`setCommonsLeaveAsk is not a function`)
  - the #163 view and flag stand-ins on the new contract
- **#163 tests adjusted**, only where GM changed the expectation or the panel contract moved:
  - `commonsUnsavedExitsView.test.tsx`: "Projects is disabled with the reason" became "stays enabled and asks; after saving it goes". Its stand-in panel speaks `onWork`.
  - `commonsUnsavedFlag.test.tsx`: the stand-in speaks `onWork`; the expectations are unchanged.
  - `commonsUnsavedExits.test.ts` (the stores' holds) is unchanged and passes.
- After the build, the 40 related files (Commons, corner, studios using the toolbar menu, header, toast, entry split, focus-ring sweep) passed: **559/559**.

## Live check

- An isolated backend on **8793** (temp HOME, every NEBULA_* root under the scratch dir, only the listed variables, so no keys or tokens are inherited; `NEBULA_COMMONS_ENABLED=1`, and a throwaway person token through stdin). Vite on **5793** with `VITE_NEBULA_BACKEND_PORT=8793`; I checked that the proxy reached the isolated listing.
- Chrome ran with a dead proxy that let through only those two ports (a canary on 8799 was unreachable), plus CDP `setBlockedURLs` for 8000-8010 and 5173. **Blocked attempts: 0.**
- I seeded two projects and a Blind labeling batch from 70 local generated images. A real MCP stdio session added a text node, posted an update naming it, made a board and asked to send its notes (a Review). No keys, no paid call.
- **43/43 checks passed, with no page errors.** At 1440×900 and 1280×800:
  - **Markers.** "Unsaved" shows beside Save labels. The tab shows a dot and its name is "Blind labeling · Unsaved", also from All. The draft survived All, Inbox and Settings. At 1280, More carries the dot and its name is "More: Blind labeling · Unsaved".
  - **Popover from Back.** It shows the copy and the order, and focus starts on Save and leave. A press outside is Stay.
  - **Keyboard only.** From Projects, Tab reaches Back, and Enter opens the popover. Focus goes Save and leave → Discard and leave → Stay → back to Save and leave; Shift+Tab goes to Stay. The focused button shows the 2 px neutral ring, and Escape returns focus to Back.
  - **Projects (1440, 1280) and Back (1280).** The same popover, anchored to each.
  - **The corner's Show on canvas, Review and See all.** Each opens the popover anchored to it, the list stays open, and Stay returns focus to the button.
  - **Browser Back.** It stays on `#commons` and opens the popover at Back.
  - **A save in progress.** With Chrome's network latency at 2.5 s on Save labels, a click on Back opened no popover. Back read "Saving…" and was busy at about 300 ms, then went to the canvas.
  - **An agent's `open_project` while unsaved.** The person stayed with the label, the toast showed, and it was still there after 17 s. It covered neither the popover nor Save labels at 1440 or 1280 (Save scrolled to the bottom, the middle and the toast's own line). After Save and leave, the person was on Beta's canvas with the toast; it was there at 12 s and gone at about 15 s.
  - **A failed save.** Another write bumped the batch first, the real "another window" case. Save and leave then showed "Couldn't save your labels." with "Labels changed in another window. Reload before saving." above the three buttons (1440 and 1280). Discard and leave then left.
  - **Browser Back, then Discard and leave.** It landed on the entry they went back to (`?entry=canvas`, no hash, the canvas in the app), and one more Back did not bounce into the Commons.
- Screenshots are in `scratchpad/commons-leave/shots/`:
  - `01-unsaved-markers-1440.png`, `02-tab-dot-from-all-1440.png`, `03-unsaved-markers-1280.png`
  - `04-popover-back-1440.png`, `05-popover-keyboard-1440.png`, `06-popover-projects-1440.png`, `07-popover-projects-1280.png`, `08-popover-back-1280.png`
  - `09`–`11-popover-corner-*-1440.png`, `12-popover-browser-back-1440.png`, `13-back-saving-1440.png`
  - `14-toast-held-popover-1440.png`, `15-toast-held-popover-1280.png`, `16-toast-held-17s-1440.png`, `17-toast-on-canvas-1440.png`, `18-toast-gone-1440.png`
  - `19-failure-1440.png`, `20-failure-1280.png`, `21-browser-back-left-1440.png`
- **Not checked live: Agent review's running state.** Grading needs a provider call, and none may run. The real panel's loop and Stop and leave are covered in `commonsLeavePanels.test.tsx`.

## Open items

- For GM:
  - The tab's dot uses the attention yellow (`--sr-warning`, the Settings row's warn dot). If GM wants a neutral ink dot instead, it's one token.
  - The corner's popover opens under the clicked button and can cover the next update in the list while it's up.
  - When labels are unsaved and Agent review is running, the popover shows both lines: "Your labels aren't saved." with "Agent review is still running." under it. That second line is new placement of GM's existing copy.
- The panels' own "Unsaved changes · save before changing reference" status line stays as it was, under the new "Unsaved" marker.

## Review

- **Four confirmed findings, each pinned by a test that failed first, then fixed.**
  - **The held toast never timed out after leaving by Projects.** Projects keeps `viewMode: 'commons'` behind it (#163), and the toast decided "in the Commons" from `viewMode` alone, so after Save and leave by Projects it stayed pinned with no timer. It now counts the Commons as showing only when Projects isn't (`screen !== 'home'`), the rule App uses (Projects wins). Its 15 s start on Projects as on the canvas. Tests: `projectSwitchToastHeld.test.tsx` gained "starts its 15 s once the person leaves the Commons by Projects" and "times out after 15 s from Projects even with the Commons behind it" (both failed: `switchNotice` still set after 15 s). The first existing case now sets `screen: 'workspace'`, which it had relied on by accident.
  - **A Prepare's error was lost if the person left mid-scan, and a reopened Commons let them start a second scan.** The reviewer's fix was to hold the leave on the scan again, as #163 did. I didn't: that brings back the minutes-long "Saving…" on Back for a scan that isn't a save, and GM's rule for long backend work (Agent review: leave freely when it keeps running and the person can come back to it) fits a scan better. So the scan now outlives the panel. `CommonsEvaluation` keeps the running scan at module level (in the lazy Commons chunk). A Blind labeling mounted while it runs takes it up: the folder is filled in and the button reads "Downloading and scanning…", disabled, so no second scan can start. Its batch or its error (role="alert", the panel's own notice) reaches the first panel mounted after it settles. Leaving mid-scan still goes at once. Tests: two in `commonsLeavePanels.test.tsx` (both failed on the old code: the error was missing, and the reopened form was enabled). This is a decision for Justin or GM if they'd rather hold the leave.
  - **A failed Save and leave wasn't announced.** The failure lands in place in the open popover with focus still on Save and leave, and nothing was live. The reason is now `role="alert"`, keyed by each opening of the popover so the same reason after a second failed attempt is inserted fresh and announced again. A new `seq` on `LeaveAsking` does the keying. Test: "announces a failed Save and leave…" in `commonsLeave.test.tsx` (failed: no alert).
  - **Escape stopped working after a press on the popover's text.** The text isn't focusable, so the press dropped focus to the page, outside the panel's key handler. The panel now has `tabIndex={-1}`: a press on its text or padding focuses the panel, so Escape (Stay) and the Tab loop keep working. A mouse press shows no ring (not `:focus-visible`), so no CSS was needed. Test: "Escape still stays after a press on the popover's text, and Tab stays among its buttons" (failed: focus was on the body). jsdom doesn't move focus on a press, so the test focuses the nearest `[tabindex]` ancestor the way the browser does.
- **Review live check** (backend 8793, Vite 5793 with `VITE_NEBULA_BACKEND_PORT=8793`, the same isolation and dead-proxy blocking, canary 8799 unreachable; a real MCP stdio session; 72 locally generated images): **23/23 checks passed, no page errors, blocked attempts to 8000-8010/5173: 0.**
  - With Chrome's latency at 3 s, Prepare on a bad folder, then Back: left at once with no popover. Back in Blind labeling, the backend's reason showed as an alert, Prepare was enabled again, and the backend had one prepare request.
  - With latency at 6 s, Prepare on the image folder, Back, then straight back to Blind labeling: "Downloading and scanning…", disabled, the folder kept. The batch then showed, and the backend had seen one more prepare request (two in all), so no second scan.
  - At 1440 and 1280: a press on the popover's line focused the panel with no ring, Tab went to Save and leave, and after a press on the padding Escape was Stay with focus back on Back.
  - A save refused by another window's write: the reason sat in a `role="alert"` inside the open popover, with focus on Save and leave. A second Save and leave inserted a fresh alert.
  - `open_project` from the MCP session while unsaved: held, toast showing. Projects' popover and the toast didn't collide at 1280 or 1440. Save and leave by Projects landed on Projects with the toast. It was still there at 12 s and gone at 15.3 s.
  - Screenshots in `scratchpad/commons-leave/review/shots/`: `r01-scan-failed-while-away-1440.png`, `r02-scan-still-running-1440.png`, `r03-pressed-line-1440.png`, `r03-pressed-line-1280.png`, `r04-failure-alert-1440.png`, `r05-projects-popover-toast-1280.png`, `r05-projects-popover-toast-1440.png`, `r06-projects-with-toast-1440.png`, `r07-projects-toast-gone-1440.png`.
- **Budget after review:** 505,075 raw / 148,404 gzip (+34 B raw over the first build; the toast is in the entry). 6,925 B under the cap. `CommonsView` is 82.94 kB.
- **Gates after review.** Backend: 9,616 passed, 71 skipped, 0 failed (18 min 12 s; no backend file changed). Frontend whole suite: 4,259 passed and 13 failed of 4,272, in 7 of 348 files (8 of the 13 were "Test timed out" under load, the rest findBy lookups giving up). Those 7 files rerun alone: 136/136 (CommonsDetail, CommandPalette, ModelPicker, ResultsGallery, GraphFileActions, NodeLibrary, Settings). `tsc -b` clean, lint clean, build and budget passed.
- **Agent support:** nothing agents call changed. No MCP tool, CLI command or doc moved, and the MCP INSTRUCTIONS cap isn't touched.

## Gates

- **Frontend, `npx vitest run` (whole suite).** It ran while the backend suite also ran, so the machine was loaded. **4,196 passed and 70 failed of 4,266, in 33 of 348 files.** 58 of the 70 were "Test timed out", and the rest were findby lookups that gave up under load.
  - Rerunning those 33 files on their own: 406 of 427 passed and 21 failed (13 timeouts), in 9 files.
  - Each of those 9 files run by itself passed, 156/156: CommonsDetail 1, CommandPalette 3, ModelDiscovery.integration 4, ModelPicker 11, ResultsGallery 8, ConnectionPopup 16, GraphFileActions 25, NodeLibrary 20, Settings 68.
  - The 7 Commons-leave and #163 files together: 129/129.
- **`npx tsc -b`:** clean.
- **`npm run -s lint`:** clean (inline style guard: 208 files; CSS scope guard: 4).
- **`npx vite build && node scripts/check-build-budget.mjs`:** passed. **505,041 raw / 148,384 gzip**, against main's 504,194 / 148,010: +847 B raw, 6,959 B under the 512,000 cap. The lazy `CommonsView` chunk is 82.50 kB and `AgentNotesCorner` is 27.92 kB.
- **Backend** (`iso.sh .venv/bin/python -m pytest -q -p no:cacheprovider`): **9,616 passed, 71 skipped**, 0 failed, in 23 min 2 s. No backend file changed.

## GM's review of the screenshots (round 2)

GM approved the popover, its copy, focus, primary and the toast stacking, with these changes, all built test first:

- **A failure that saving again can't fix drops Save and leave.** GM: "when the reason is a conflict ... Save and leave can't succeed. Offering it as the primary invites a second failure." So a conflict shows "Discard and leave" / "Stay", with focus on Stay (where the person can reload). A failure that can be retried (network, server) keeps Save and leave as the retry.
  - How a failure is classed: the Commons API now throws `CommonsRequestError` (`lib/commonsRequestError.ts`) with the HTTP status, including 401 for no session. `saveFailure()` in `commonsLeave.ts` marks a failure `retry` when there was no answer (a plain error: a lost connection), the status is 5xx, or it is 408 or 429 (GM, a follow-up: a timeout or a rate limit works on a second try). Every other 4xx can't be fixed by saving again. Every `EvaluationError` (a changed revision, a closed or sealed batch, a grade not ready) reaches the browser as 409.
  - The popover focuses its first choice on every opening, keyed by its `seq`, not only when it first appears. A failure landing in an open popover would otherwise leave focus on the removed Save and leave.
- **The panels' status line is shorter.** "Unsaved changes · save before changing reference" (Blind labeling) and "Unsaved corrections · save before changing reference" (Agent review) now read "Save before changing reference". "UNSAVED" beside Save already gives the state.
- **The corner's popover opens left of the Updates list or card** (GM: "if it's cheap"). `placeOutside` in `anchoredPopover.ts` puts it left of `.agent-notes-panel` / `.agent-note-card`, level with the clicked button. With no room on the left it falls back to the usual place.
- **The chip's unread ring (GM's question B).** It has always been the newest unread author's colour (`--an-newest`, since afc2c31c; #157 changed only when it shows). The "lime" GM remembered is Claude Code's author colour. GM chose to keep that rule, fix the comment that called it "the lime unread ring", and add a floor, because agents choose their colours (any `#RRGGBB`): the ring must clear 3:1 on the header, the focus ring's bar. `lib/unreadRing.ts` keeps a colour that clears it, and otherwise draws the smallest tint toward white that does. The chip sets `--an-ring`; the dots in the chip are unchanged. All eight built-in colours (`agent_presence.py`) already clear 3:1 and are unchanged. The test derives the header backdrop from `--sr-glass` over `--sr-canvas`, so the constant can't drift from the CSS.
- **Kept as built (GM):** the tab dot in `--sr-warning`; both lines when labels are unsaved and Agent review runs, labels first; the scan outliving the panel.
- **Review of round 2** (read-only reviewer plus a live check on 8794/5794, two real MCP sessions, 49/49 checks, 0 blocked requests): no defects. It ran a real conflict (an API write bumped the revision), a dropped connection, the corner popover left of the list and card at both widths, and an agent coloured #3A1F5C, whose ring drew as #6b5785 (3.05:1) while its dot kept the author colour. One cosmetic nit, fixed test first (`tests/anchoredPopoverReplace.test.tsx`): a failure landing in an open popover made it larger without placing it again, so at 1280 its gap to the Updates list shrank from 6 to 2 px. `useAnchoredPopover` now takes a `revision` (the opening's `seq`) and places the panel again when it changes. GM's later note (408 and 429 retry) is in the bullet above.
