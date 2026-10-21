# 2026-10-21 — The Updates corner on every screen, and "Closed: Nebula restarted"

Branch `feat/updates-corner-every-screen`, from main `296e9199` (after #148). Uncommitted (the coordinator commits). No paid provider call, no package installed.

- **What changed and why.**
  - **Q107**, Justin: "a) Show it on every screen, with the open project's Updates (a small follow-up PR)." The Updates corner used to mount only on the canvas. It now mounts once, at App level (`AppAgentNotes`, still a deferred chunk). It shows on the canvas, Projects, Creator Studio, Moodboard Studio, Character, Cinema, Remotion's Composition, the Video editor and the Commons, always with the open project's list. Everything comes with it: unread count, cards, the list, Review and its outcomes, and the live socket ops. One mount means the count and an open list carry across a screen switch.
  - **Q108**, Justin: "a) "Closed: Nebula restarted" (the agent can ask again)." When a moodboard or Commons proposal is open and Nebula restarts, the proposal is lost from memory. Its Update used to settle as "Expired". It now settles as **"Closed: Nebula restarted"**: `asset_proposals.RESTART_OUTCOME`, set in `main._settle_asset_updates`. That function runs on `list_notes`, on a tab's socket connect and on a project switch. `nebula notes` prints `[Closed: Nebula restarted]`.
  - A proposal that really timed out (15 minutes) still reads "Expired". A `get_proposal` on a gone id now answers "decided proposals are kept for 30 minutes, and a restart of Nebula closes open ones: propose again if you still want it". This applies to both canvas and asset ids.
  - **Agent support.** These now say the corner is on every screen and name the restart outcome, with "ask again":
    - the `post_note`, `list_notes`, `propose_asset_change` and `get_proposal` docstrings;
    - docs/MCP-SETUP.md (three places);
    - skills/nebula/SKILL.md.
  - No new tool: Review is a person-only click, and agents already read the outcome through `list_notes` / `nebula notes`. The plan (`docs/moodboard-canvas-plan.md` §5.9) has a Q107 line.
- **Decisions not in the spec.**
  - **No project open: no corner** (on Projects before any project was opened, or after the open project is deleted). Updates are kept with a project, so there is no list to show.
  - **No corner on the brand showcase** (`#brand`). It is a demo page, not a product screen.
  - **Where it sits off the canvas.** Each screen's header keeps an `aria-hidden` slot (`UpdatesSlot`), and the chip centres on it. The card and list drop below the header.
    - Projects: the slot sits just before the Settings gear.
    - Studios and the Commons: the slot is pinned in the header's own right padding (`workspace-header.css`: `padding-right` = gutter + `--agent-notes-chip-w` + column gap; the slot is `position: absolute` on the first row). The header's controls wrap inside the rest of the row.
    - The slot takes room only while the corner shows (`body.agent-notes-shown`).
    - The canvas keeps its own corner and the pill gets no slot (`updatesSlot={false}`).
    - New tokens: `--agent-notes-chip-w`, `--agent-notes-slot-h`, `--workspace-header-pad-x`, `--workspace-header-gap-x`. No pixel nudges.
  - **Layer.** The studios sit on the workspace layer (50), above the canvas corner's 46. Off the canvas, the chip, card and list use `--sr-layer-workspace-overlay` (55), still below modals (60).
  - **Review from any screen.**
    - A canvas Update's "Show on canvas" first goes to the canvas the way that screen's Back does (`lib/goToCanvas.ts`; from Projects it opens the open project first). It then outlines and frames once the canvas has drawn the node.
    - An asset proposal's Review goes to the Projects strip, to Moodboard Studio on that board, or to the Commons detail, from wherever the person is (`assetProposalReview` opens the workspace first when on Projects).
    - The list closes once Review succeeds, so it doesn't sit over the destination. A failing Review keeps it open with its message.
  - **Off the canvas the list's footer names the project** ("kept with Harbor"), since the screen itself may not.
  - **Keyboard.** The chip and card belong to both shortcut scopes (`studioKeys.isStudioShortcutTarget`, `canvasShortcutScope`). With focus on the chip, Moodboard Studio's Cmd+Z still undoes, and the corner never `preventDefault`s it.
  - **Canvas proposals (propose_change) have no restart case of their own.** They post no Update (`post_nebula` has no callers), so the only change is their 404 wording.
- **Tradeoffs.**
  - On the Commons at 1280 wide the toolbar now wraps to two rows (header 86 px instead of 49 px). Its controls had filled the row exactly before the chip took 112+ px. At 1440 it stays one row.
  - The corner is a deferred chunk, so on a cold load it appears a moment after the screen.
- **Surprises.**
  - **Live check at 1280, the Commons.** The first version's slot was a flex item, so it wrapped onto its own line, and the chip landed over "Worker stopped · Start". In Cinema, Remotion and the Video editor (no actions) the slot sat right after the title. Both are fixed by the header-padding rule above (test first).
  - **Live check.**
    - The chip was under the studios (46 < 50): fixed with the overlay layer.
    - The chip missed a header that mounted after it: fixed with the `nebula:updates-slot` event fired by `UpdatesSlot` on mount, resize and unmount.
    - On a scrolled Projects page the chip went off-screen: it now stays at the gutter, and the corner re-places on any scroll.
  - In the harness, the person token from `devserver.py --no-reload` under a pty gave 403s even to harness requests. I switched to a launcher that writes the token to a file, and requests then returned 200. The cause was not looked into.
- **Tests (written first, seen failing).**
  - **Backend: `tests/test_proposal_restart_outcome.py` (11 tests).** 9 failed first:
    - the constant was missing;
    - the restart closed as "Expired";
    - the 404 wording didn't say "restart" / "propose again";
    - the docstrings, MCP-SETUP and SKILL had no restart outcome and no "every screen".
    - The 2 timed-out-stays-"Expired" tests passed by design.
    - `test_asset_proposal_updates.py`'s restart test now expects the new outcome.
  - **Frontend: `tests/AgentNotesEveryScreen.test.tsx` and `tests/App.updatesEveryScreen.test.tsx`.** 18 failed and 13 passed first. The failures:
    - the hidden-without-a-project case;
    - reserved only on the canvas;
    - the Projects→Studio and Projects→Commons Reviews;
    - both Show-from-elsewhere tests;
    - the slot placement;
    - Cmd+Z scope;
    - 7 studios and Projects with no chip;
    - "one corner across switches".
  - **Later additions, each failing first:**
    - list closes after Review (2);
    - scrolled header (chip at -104 px);
    - late-mounting slot (module missing);
    - overlay z-index rule;
    - header padding reservation (3 CSS + 7 App tests).
  - The "kept with Harbor" test was written after its code, not first.
  - `AgentNotesCorner.test.tsx` and `agentNotesLayoutCss.test.ts` were updated.
  - The App test waits up to 10 s (test limit 20 s) for the lazy corner and studios. In the whole run under load (load average about 25) the 1 s default timed out on two studios.
- **Live check.** Isolated backend on 8839 and Vite on 5839 (`VITE_NEBULA_BACKEND_PORT=8839`), with a temp HOME, every NEBULA_* root in scratch and no keys. One MCP stdio agent named "Claude Code". Headless Chromium with 8000-8010 and 5173 blocked (CDP plus a dead proxy).
  - **Placement.** Chip rect against every visible control, at 1440x900 and 1280x800, on Projects, the canvas, Creator Studio, Moodboard Studio, the Commons, Character, Cinema, Remotion and the Video editor: **0 overlaps** on all 18, and the chip is the top element at its centre. At 1280 the studios put it at x 1121-1266, y 4-44, and the canvas at 1119-1264, y 24-64.
  - **Live notes.** The agent posted while the person was on Projects, then Moodboard Studio, then the Commons (1280). Each card showed in about 0.5 s, and the count went 0→1→2→3 unread.
  - **Review.**
    - Projects→Moodboard Studio on the board (strip shown);
    - Commons→Studio;
    - Studio→Projects strip;
    - canvas→Commons detail;
    - Accept from the strip gave "Accepted: the cover changed";
    - "Show on canvas" from the Commons revealed n1.
  - **Restart.** I restarted the isolated backend with a cover proposal open. After the tab reconnected, its Update read "Closed: Nebula restarted" live. `list_notes` gave the same outcome (resolvedBy system), and `get_proposal` returned the new 404 text.
  - **Blocked requests.** 10, all in the deliberate canary probe (5 browser launches × 8000 and 5173). **0 during the run.** Proxy failures during the run: Google Fonts and `localhost:8839` health only. Canary hits: 0.
  - **Console.** A fresh load visiting every screen showed no errors. Early in the run, while I was editing the corner under HMR, React logged "Lazy element type must resolve to a class or function" three times. I couldn't reproduce it on fresh loads.
- **Gates (2026-10-21, load average 20-30 from other sessions).**
  - **Backend whole suite** (iso.sh): 1 failed, 9405 passed, 61 skipped in 38:39. The failure was `test_agent_process.py::test_terminate_agent_process_tree_kills_setsid_grandchild` (process-tree timing); alone, its file passes 4/4. A first attempt was stopped by its 20-minute guard at 35%.
  - **Frontend vitest whole run:** 93 failed, 3847 passed (35 files). 79 of the failures were "Test timed out", and the backend suite was running at the same time.
    - Rerun of those 35 files together: 12 failed, 489 passed.
    - `App.updatesEveryScreen` (2 studios, 1 s findBy) passes 11/11 with its lazy-chunk waits.
    - Each of the other 8 files passes alone: ChatPanel.personal 12, CommandPalette 3, ConnectionPopup 16, GraphFileActions 25, NodeLibrary 20, Settings 68, ModelDiscovery.integration 4, ResultsGallery 8.
  - `tsc -b` rc 0, and `npm run -s lint` rc 0.
  - `vite build` plus the budget passed: **511,253 bytes raw** / 149,457 gzip (747 under 512,000). The corner stays lazy; the eager parts are `UpdatesSlot` and the header class.
- **Review (two confirmed findings, fixed, tests first).**
  - **The corner sat on top of an open chat in the studios.** A chat left open on the canvas stays mounted in the studios. Off the canvas the docked chat went back to the top gutter (x 924-1264, y 16 at 1280x800). That put the chip over the chat's header buttons, and the cards and the list over its body, all on layer 55 with the corner painted later. Fixed in two parts:
    - The corner writes the line it drops from as `--agent-notes-drop-top` on the root. A new layouts.css rule (`body.agent-notes-shown:not(.agent-notes-reserved) .workspace-overlays--studio .chat-panel`) starts the docked chat there, below the header, just as it starts below the chip on the canvas. Before the corner has placed itself, the canvas's chip line is the fallback. The canvas clears the line, and so does the corner going away. The clear is a layout-effect cleanup: a passive one ran after a remounted corner (a project switch) had already set the line, and left it empty. The new test caught that.
    - Off the canvas, a card or the list that would meet the chat (docked or dragged free) now sits just left of it (`cornerRight` with the slot's right edge). The chip stays in its header slot, because moving it would put it over the screen's own controls.
    - Tests that failed first: two `AgentNotesEveryScreen` tests (the card's `--an-right` was 14 and needed at least 364; the drop line was unset) and one `agentNotesLayoutCss` test (the rule was missing). A control test (no chat, so the card stays at its slot) passed before and after.
    - Live check, 8839/5839, chat open. In Moodboard Studio and Create at 1280x800, and Moodboard Studio, Create and Character at 1440x900, the docked chat starts at y 57-60 (below the 49 px header). The chip is at 1121-1266 / 1281-1426, the card at 556-916 / 682-1042 and the list left of the chat: 0 overlaps. The Commons shows no chat. A chat dragged free to (900, 20) at 1280: the card and list moved left of it (532-892). The chip, still in its slot, overlaps that free chat. That is the agreed tradeoff: the person dragged the chat over the header. Back on the canvas the line clears and the chat docks at 72 as before. Blocked requests during the run: 0 (2 in the deliberate canary probe). Canary hits: 0. Proxy failures: Google Fonts only.
  - **Agent docs sent a board's Updates where nobody sees them.** The words now say "every screen ... Moodboard Studio". But a post_note with `board` lands in the board's list, and no screen shows that list (the corner shows only the open project's), not even Moodboard Studio on that board. This gap existed before this PR. Docs-only fix, as the reviewer suggested: the `post_note` `board` bullet, the `list_notes` docstring, docs/MCP-SETUP.md (the tool list and the Updates section, plus a comment on the `--board` example), skills/nebula/SKILL.md and `nebula note`'s help and `--board` flag now say a board's updates are "not on screen yet", and to post without `board` to reach the person. Test that failed first: `test_agents_are_told_a_boards_updates_are_not_on_screen_yet`. Showing a board's list in Moodboard Studio is a bigger change and needs Justin's call (open items).
  - **Surprise.** In the whole backend run, `test_first_turn_cli.py::test_skill_examples_parse` caught my first SKILL.md wording. It had split `` `nebula notes --board` `` across a line break, and the bare `--board` with no argument didn't parse. I rewrapped it as `nebula notes --board <name>` and gave the same argument to MCP-SETUP and the CLI help.
  - **Gates after the review fixes (load average about 25).**
    - Backend whole suite: 1 failed, 9406 passed, 61 skipped (25:32). The one failure was that SKILL example. After the fix, its file plus every test file that reads the agent docs passed: 400 passed (13 files). I didn't rerun the whole suite.
    - Frontend whole `vitest run`: 25 failed, 3919 passed (10 of 333 files failed). Each of those 10 files passes alone: CommonsDetail 1, ChatPanel.personal 12, CommandPalette 3, ModelDiscovery.integration 4, ModelPicker 11, ResultsGallery 8, ConnectionPopup 16, GraphFileActions 25, NodeLibrary 20, Settings 68. 18 of the 25 failures were "Test timed out".
    - `tsc -b` rc 0, and `npm run -s lint` rc 0.
    - `vite build` and the budget passed at 511,253 bytes raw / 149,449 gzip. The raw size is the same as before the review fixes.
- **Open items.**
  - A board's Updates (post_note with `board`) are not shown on any screen. Showing the open board's list in Moodboard Studio next to the project's needs Justin to decide where it lives.
  - A chat dragged free over a studio header sits under the chip (both on layer 55, the corner painted later). The card and the list keep clear of it.
  - A canvas proposal made while the person is on another screen posts no Update, so nothing tells them. Canvas proposals have never posted one.
  - Show/Review's navigation can leave a Commons blind-labeling draft or a Character draft. This is the same as #149's Review: the Commons Back is disabled while labeling is dirty, but a programmatic switch isn't.
  - A transient card can cover page content under it, such as Projects' New project button, for about 4 s.
  - When Review starts on Moodboard Studio for that same board, the strip doesn't take focus.
  - The Commons toolbar wraps to two rows at 1280 (above).

## Header fix (GM review)

- **What changed and why.** GM - Design, relaying Justin's design, rejected the tradeoff above: "treat the two-row wrap at 1280 as a defect, not something to accept". 1280 is a common laptop width, and a taller toolbar pushes the canvas down on the screens with the least room. GM's fixes, in order: (1) below about 1360 px the chip shrinks to its author dots and the count, and the header reserves that compact width; (2) only if a header still wraps at 1280 with the compact chip, that header's lowest-priority items move into an overflow menu. Q107 asked to show the corner without harming each screen, so this is part of the approved build.
  - **(1) Compact chip.** `@media (max-width: 1359px)` hides `.agent-notes-chip__label` (agentNotes.css). The chip keeps its `aria-label` ("Updates, 1 unread"), both dots, the count, its 40 px height and the list it opens. layouts.css now has `--agent-notes-chip-w-full: 145px` and `--agent-notes-chip-w-compact: 85px` (both measured live). `--agent-notes-chip-w` is the full width by default and the compact one under the same media query. The slot and the header padding read only that one token. The corner still writes the chip's measured width into it (a two-digit count widens the chip and the slot). It now measures again on a window resize, because crossing the breakpoint changes the chip's width without a re-render.
  - **(2) The Commons folds two tabs.** With the compact chip the Commons toolbar still needed 1346 px for one row, so it still wrapped at 1280. Blind labeling and Settings now fold into a **More** menu. This happens below 1440 px and only while the chip shows (`body.agent-notes-shown`, commons.css). They are the least-used sections: Blind labeling is an occasional evaluation session and Settings is set once. All, Inbox and Agent review, Add to / Add, and the worker line are what each visit acts on, so they stay. More uses the app's existing toolbar menu. AssetMoveMenu's popover is now exported as `ToolbarMenuPopover`, with an optional `checked` that turns items into `menuitemradio`. The keyboard is the same: arrows, Home/End, Escape or Tab closes and returns focus, and a press outside closes. While a folded section is open, More shows as the active tab and is named "More: Settings".
- **Decisions not in the spec.**
  - **Two breakpoints, both from measurement.** The chip is compact below 1360, as GM said. The Commons folds below 1440, because at 1366 even the full chip wrapped it: it needs 1406 px with all five tabs. With the fold, the Commons header takes about 1 px less than main's below 1360. At 1366 to 1439 it has 101 px to spare.
  - **The canvas follows the same rule.** There is one chip, carried across screens, so at a given window width it looks the same everywhere. Otherwise the word would appear and vanish on each canvas↔studio switch. The canvas corner's placement is unchanged.
  - The card and the list are right-aligned to the slot's right edge, so they line up with the chip at both sizes. Live at 1280: chip right edge 1266, list right edge 1266, list top 57 below the 49 px header.
  - The old token value (112 px) was stale. The chip has measured 145 px since the count and the dots were added. Only the measured inline value had been in use.
- **Tradeoffs.**
  - Below 1440, with a project open, Blind labeling and Settings are one click further away, behind More.
  - At 1440 and up the Commons keeps 34 px to spare with the seeded worker line ("Worker stopped · 1 queued"). A much longer status, such as "Library analysis paused until reference labels are sealed", can still wrap there. On main that status wraps even at 1280.
  - The first-load entry grew by 133 bytes (the shared menu is eager through AssetsPanel).
- **Surprises.**
  - Calling `projectStore.goHome()` inside a Puppeteer `evaluate` gave "Promise was collected". Calling it from a `setTimeout` worked. This was a harness issue only.
- **Tests (written first, seen failing).**
  - `agentNotesLayoutCss.test.ts`: 5 new tests, all 5 failed first.
    - The tokens were missing (`--agent-notes-chip-w-full` was null).
    - `@media (max-width: 1359px)` was missing in layouts.css and in agentNotes.css.
    - commons.css had no `.commons-tabs__more` rule and no `@media (max-width: 1439px)`.
    - One test resolves the token at 1280/1359/1366/1440/1920 (85/85/145/145/145) and checks that the slot and the padding read it.
  - `AgentNotesEveryScreen.test.tsx`, "measures the chip again on a window resize": failed first with `expected '145px' to be '85px'`. A guard that the compact chip keeps its name, two dots and count passed before and after (the label is CSS-hidden).
  - New `commonsTabsOverflow.test.tsx`, 3 tests, all failed first ("Unable to find ... button ... /^More/"). They cover which tabs fold, More outside the tablist, the radio menu, focus on the first item, ArrowDown, choosing Settings (the menu closes, focus returns, the tab is selected, More becomes "More: Settings"), and Escape.
- **Live check.** Isolated backend 8839 and Vite 5839 (`VITE_NEBULA_BACKEND_PORT=8839`), temp HOME, every NEBULA_* root in scratch, no keys. One real MCP stdio agent (NEBULA_AGENT_NAME "Claude Code") posted two Updates through `post_note`, so the chip showed "Updates, 1 unread". Main's frontend came from `git archive origin/main frontend` (d128fb9b; no frontend change since this branch's base). It ran on the same ports, one Vite at a time.
  - Header height in px, main / before this fix / after. Chip width after. Overlaps: chip rect against every text or control in the header. The chip was the top element at its centre in every after row.

    | Screen | 1280x800 | 1366x768 | 1440x900 | 1920x1080 |
    |---|---|---|---|---|
    | Projects | 72 / 72 / 72 | 72 / 72 / 72 | 72 / 72 / 72 | 72 / 72 / 72 |
    | Creator Studio | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 |
    | Moodboard Studio | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 |
    | Character | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 |
    | Cinema | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 |
    | Remotion | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 | 49 / 49 / 49 |
    | Video editor | 51 / 51 / 51 | 51 / 51 / 51 | 51 / 51 / 51 | 51 / 51 / 51 |
    | Commons | 49 / **86** / 49 | 49 / **86** / 49 | 49 / 49 / 49 | 49 / 49 / 49 |
    | Chip width after | 85 | 145 | 145 | 145 |
    | Overlaps after | 0 | 0 | 0 | 0 |

  - **The Commons by size.** At 1280 and 1366 it shows All, Inbox, Agent review and More. At 1440 it shows all five tabs and no More. More opened by keyboard (Enter) under its button (x 436-636, y 43), with focus on "Blind labeling". ArrowDown then Enter opened Settings: the header stayed 49, focus went back to "More: Settings", and the menu closed.
  - Screenshots are in the scratch dir `updates-chip/shots/`: `final-{commons,create,moodboard-editor}-{1280,1440}.png`, `commons-1280-more-open.png` and `after-canvas-1280.png`.
  - **Blocked requests.** 4 in total, all in the deliberate canary probe (8000 and 5173). 0 during the run, and canary hits 0. Proxy failures during the run: only `localhost:8839/api/health` (the page's discovery; only 127.0.0.1 is bypassed). Console: the usual 403 on `PUT /api/settings` without the person link, and connection-refused while the Vite was switched to main's copy.
- **Agents.** Nothing changes for agents. The chip, its name, the list and Review are the same, and the Commons sections are the same tabs behind one more click. No MCP tool, CLI command or doc describes the chip's label or the Commons toolbar layout.
- **Gates (2026-10-21, load average about 11).**
  - `tsc -b` rc 0, and `npm run -s lint` rc 0.
  - `vite build` plus the budget passed: **511,386 bytes raw** / 149,574 gzip (614 under 512,000; +133 from the shared menu).
  - Focused vitest: 15 files (agent-notes, layout CSS, App every-screen, the Commons files, AssetsPanel and studio drafts), **143 passed**.
  - **Whole `vitest run`:** 28 failed, 3970 passed (10 of 337 files failed; 18 of the failures were "Test timed out"). The 10 files rerun together all passed (168): CommonsDetail, ChatPanel.personal, CommandPalette, ModelDiscovery.integration, ModelPicker, ResultsGallery, ConnectionPopup, GraphFileActions, NodeLibrary, Settings. These are the same load-sensitive files as in the earlier runs.
  - **Backend whole suite** (iso.sh; no backend file changed): 1 failed, 9450 passed, 61 skipped in 22:45. The failure was `test_krea_mcp_server.py::test_stdio_bridge_process_connects_to_only_local_discovery_routes`, an anyio deadline on a subprocess under load. Alone, its file passes 5/5.
- **Open items.**
  - At 1440 and up, a long Commons worker status can still wrap the toolbar when main's wouldn't (above).
- **Review (three confirmed findings on the More fold, all fixed).**
  - *Sighted people couldn't see which folded section was open.* More's menu now draws a check and bold text on the checked item (`asset-move.css`, `[role="menuitemradio"]` / `[aria-checked="true"]`). The Move menu never passes `checked`, so it looks the same as before. The reviewer also suggested putting the section's name on the button. I measured that live first: at 1280 there are 33 px to spare, "Settings ▾" needs 17 more and fits, but "Blind labeling ▾" needs 46 more and wraps the header to 86 px. So the button keeps "More", as the reviewer's fallback said. When More's menu is closed, the toolbar shows only that More is active. The menu and the panel show which section is open.
  - *The tablist had no selected tab.* The open folded tab used to get `display: none`, which removed it from the accessibility tree. Now only the closed folded tabs are `display: none`. The open one is hidden on screen only (the clip pattern, `position: absolute`, 1 px), so the tablist still has one selected tab. While the toolbar folds, that tab gets `tabIndex=-1`, so Tab never lands on something invisible. CommonsView works out "folds" the same way the stylesheet does: `(max-width: 1439px)` plus `body.agent-notes-shown`, through `useSyncExternalStore`, a matchMedia listener and a body-class observer. With the chip hidden, no tab ever leaves the Tab order.
  - *Focus fell to `<body>` when crossing 1440.* If More or a folded tab had focus when the window crossed the fold, focus now moves to whichever counterpart is on screen. Going wide, it moves to the open folded tab, or to Blind labeling when neither is open. Going narrow, it moves to More. The blur and the media change can arrive in either order, so a blur to nowhere keeps the mark for two frames. The move waits one frame and only takes focus from `<body>` or from these controls. The same applies when More's menu is open, which closes on resize: focus in the menu counts as More's.
  - Tests first. `agentNotesLayoutCss.test.ts`: the fold test now needs the `:not(.commons-tab--active)` selector; a new test checks that the open folded tab is clipped rather than `display: none`; another new test checks the menu's check mark. All 3 failed first ("missing rule ..."). `commonsTabsOverflow.test.tsx` has 6 new tests with a matchMedia stub whose change event can fire either before or after the blur. Four failed first: the selected folded tab's tabIndex was 0 instead of -1, and three focus tests left focus on `<body>`. Two were guards and passed before and after: no tab leaves the Tab order without the chip, and focus elsewhere is left alone.
  - Live, 8839/5839, the same harness with one real MCP agent ("Updates, 1 unread"). At 1280, with the keyboard, I chose More, then Settings: the header stayed 49, focus returned to "More: Settings", and the accessibility tree showed "All | Inbox | Agent review | Settings*". The menu showed ✓ and bold on Settings only. Shift+Tab from More went to Agent review, skipping the hidden tab. Widening to 1440 moved focus to the Settings tab, and narrowing to 1280 moved it back to More. With Blind labeling open and its menu open, widening closed the menu and focused the Blind labeling tab. Focus on Add stayed on Add across the fold. A new sweep of all 8 screens at 4 sizes matched main's header heights everywhere, with 0 overlaps and the chip on top in every row. Main's numbers come from the earlier sweep: origin/main is still d128fb9b and its frontend is the same. Blocked requests: 0 during the run, and 2 in the deliberate canary probe. Shots: `updates-chip/shots/review-*.png`.
  - Nothing changes for agents.
  - Gates after the review fixes:
    - `tsc -b` rc 0, and lint rc 0.
    - Build and budget passed: 511,386 bytes raw / 149,572 gzip. That is unchanged, because the Commons is a lazy chunk.
    - Focused vitest: 28 files, 243 passed.
    - Whole `vitest run`: 31 failed, 3975 passed. 10 of 337 files failed, with 21 "Test timed out". They were the same 10 load-sensitive files as before, and rerun alone all 10 passed (168).
    - Backend whole suite (iso.sh, no backend file changed): 9451 passed, 61 skipped, 0 failed.
