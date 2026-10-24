# 2026-10-23 — Projects over the save limit open, pause saving, and show what's large

Branch `fix/over-limit-projects`, from main at 8276c8c2 (#178's merge). Worktree `nebula_nodes-over-limit`. Backend, frontend, agent tool, docs. No package installed, no paid provider call, `MAX_PROJECT_BYTES` still 16 MiB.

## What and why

Before this, a project over 16 MiB was a dead end. Load graph refused a plain `.nebula` over 16 MiB. A project could still end up stored over the limit: a switch writes the live canvas into the project it leaves, with no size check. Once that happened the project wouldn't open again (the open path 413'd), and every autosave after that failed.

Justin, Q118 (option a), verbatim: "Let Load graph open bigger .nebula files (up to the 512 MiB it already allows for a bundle) as a new project. A project over 16 MiB still can't be saved, so the canvas says so, and you remove what you don't need until it saves. GM writes that state's lines."

GM - Design's layout and lines, verbatim. Header: "Saving paused · {size} MB", in Save failed's warning colour, clickable, tooltip "This project is over the 16 MB save limit. Click to see what's large." One region notice: "Saving paused. This project is {size} MB, over the 16 MB limit." with "See what's large". The panel: "Saving paused"; "This project is {size} MB. Make it {over} MB smaller and it saves again by itself. Until then, changes stay only in this tab."; "Download a copy"; "Largest first"; the top 10 rows; "{n} smaller items, {size} MB in all". Once it saves: "Saving again. This project is {size} MB." Load graph: "Opened {filename}. It's {size} MB, over the 16 MB save limit." with "See what's large". On leaving, the browser's own prompt. And "#178's TOO-LARGE LINE: yes, it goes."

## What changed

- **Load graph** reads a plain `.nebula` up to `GRAPH_BUNDLE_MAX_IMPORT_BYTES` (528 MiB, the bundle ceiling) instead of 16 MiB (`inspectGraphFileWithinLimit`). The shape walk's limits all stay: 10,000 nodes, 50,000 wires, depth 64, 1,000,000 values. The picked file's name rides along (`GraphFileSelection.name`, `LoadedGraph.fileName`). After the import, GraphFileActions calls `noteLoadedGraph(fileName)`. If the project is over the limit, that shows GM's Load graph line and pauses saving.
- **The paused state** is in `projectStore`: `saveStatus: 'paused'`, `savePaused: { bytes }`, `sizeNotice`, `sizePanelOpen`, plus `openSizePanel`, `closeSizePanel`, `dismissSizeNotice`, `noteLoadedGraph` and `downloadProjectCopy`.
  - `flush` measures the snapshot before sending. If it is over the limit, nothing is sent: no retry, no backoff.
  - Each change is measured again on the autosave debounce (600 ms). `markDirty` and `saveForeignEdit` keep the header on "Saving paused".
  - At the limit or under, a normal save goes out. Once it lands: "Saving again. This project is {size} MB.", the header goes back to "Saved", and the panel closes.
  - `applyProject` measures what it loaded. A project stored over the limit opens paused and clean.
- **The header** (`ProjectWorkspaceControls`) shows a `<button>` with Save failed's class (`#e6a395`), GM's tooltip, `aria-haspopup="dialog"` and `aria-expanded`. It opens the panel and is reachable by Tab.
- **The notice** (`SavePausedNotice`) sits in a new region slot, `save-paused`, just under `project-switch`. It uses the canvas notice's surface and spring, the reading-time hold, Dismiss, and the pause while the pointer or focus is on it. Nothing stays in the band.
- **The panel** (`ProjectSizePanel`, in the deferred RegionNotices chunk, portalled to body) follows GM's layout.
  - It stays within the Inspector's lines (`floatingTopLimit(16)` / `floatingBottomLimit(16, …)`), at the right edge, 340 px wide.
  - Rows show the name as the canvas shows it (the title, or the type when there is none), a dimmer part, and the size right-aligned in MB to one decimal. No ids appear.
  - Nodes that share a name get a dimmer type label, with a dot before the part so the two dim words read apart.
  - A node row selects the node and pans to it (`requestCanvasNodeFocus`). The Run history row opens the Run History dock. The other non-node rows are plain text.
  - Esc closes the panel and focus goes back to where it came from. If that element is gone, focus goes to the header status.
  - It springs in on the region's tuned `linear()` spring, and has no motion under reduced motion.
- **#178's too-large line is gone.** `editsSavedTooLargeLine` was removed, and every download now reads the Load graph line. `editsFileReopens` fails on size only past the bundle ceiling (the addendum is in #178's notes).
- **"Download a copy"** (`saveProjectCopyToFile`) uses the same plain `.nebula` writer as the edits download and names the file "{project}.nebula". Save graph's bundle still refuses a graph.json over 16 MiB, so it can't be used here.

## Decisions

- **The measure.** The spec said "compact JSON". The backend's check is `json.dumps(snapshot, allow_nan=False, ensure_ascii=False)` with Python's default separators (", " and ": "), UTF-8. I kept the backend's measure as it is, so no limit moves, and moved it into `services/project_size.py`. The frontend's `lib/projectSize.ts` counts the same bytes from `JSON.stringify`'s text in one pass: UTF-8 length, plus one byte per `,` and `:` outside strings, plus the difference in Python's float spelling. Python writes an exponent below 1e-4 (`1e-05`, `1.2345e-05`) and two-digit exponents (`1e-07`), where JavaScript writes `0.00001` and `1e-7`. `backend/tests/fixtures/project_size_cases.json` holds three cases written from plain `json.dumps`: non-ASCII, escapes, a data URL, run history, a draft, those floats, and 14 nodes with one name. It pins both sides to the same totals and rows. One edge case can differ: a lone UTF-16 surrogate. JavaScript escapes it, and Python's encode would fail on it. If the two measures ever differ, the backend's 413 carries its number, and the tab pauses on that number (below).
- **The 413.** `limit: "projects"` already means the 500-project count cap (`ProjectLimitError`), not the size. A size refusal now answers `{"detail", "limit": "size", "sizeBytes", "limitBytes"}` (`ProjectSizeRefusal`). The frontend reads it as `RequestFailedError.overSaveLimit` / `.sizeBytes`. `storageLimit` stays `projects | storage | null`, so #178's "too large" reason still triggers (413 with no store limit).
- **MiB shown as "MB".** The limit is 16 MiB (16,777,216 bytes) and reads "16 MB". Sizes are MiB with one decimal. Over the limit a size rounds up, so it never reads as the limit or under: 16 MiB + 1 byte reads "16.1". At or under the limit it rounds down. `{over}` is the size minus the limit, rounded up, so it never reads 0.0 while still over. Rows round to the nearest tenth. `displaySize`, `overBy` and `rowSize` on the frontend; `megabytes`, `over_by`, `row_size` (since the review) and `limit_text` on the backend.
- **The part mapping**, from the fields in a saved node (`project_size.node_parts`):
  - "Text": `data.params` (prompts, notes, every value), minus `data:` URLs.
  - "Embedded files": the `data:` URL strings inside `data.params` (a painted mask, say).
  - "Stored outputs": `data.outputs`, `data.batchOutputs`, `data.batchVariants`.
  - "Node data": the rest of the entry (id, position, name, model, run state, ports, error, run notes).
  - A row is named by its largest part; a tie goes to the earlier part in that list.
  - **Not nodes:** "Run history" (the project's `runHistory`: a record stays when its node is deleted, so it isn't a node's part; the dim label is "{n} runs"); "Wires" (every connection, "{n} wires"); "Create draft"; "Project settings" (the rest: view, session id, keys and separators). Every byte is in a row.
- **The breakdown is computed twice.** The panel computes it from the tab's snapshot, because a paused tab's edits aren't on the backend. The tool computes it from the backend's view (stored project plus the live canvas). Both run the same algorithm, and the shared fixture pins it.
- **Which path does what with a size 413:**
  - The open project's own autosave refused for its size → paused, on the backend's number (`sizeOffset` remembers how much more the backend counted, so each change isn't sent just to be refused again). Never "Save failed", never the Couldn't-save screen.
  - A recovered copy of a project that is no longer open (another window took it; a params-version stop) → #178's screen. If the copy is over the limit by our own measure, it is held there without being sent (`recoverPendingWork` measures first). If the backend still refuses it (`limit: "size"`), it gets the same "These edits are too large for Nebula to save." reason.
  - The count caps (`limit: "projects"`, `"storage"`) are unchanged.
- **Project switching.** Before this, the person's Open or New project flushed and switched, and an agent's switch saved the canvas into the project it left, or kept a recovered copy. Both of those sends would be refused for size now. While paused with unsaved edits:
  - The person's Open or New project → #178's screen ("These edits are too large for Nebula to save. Download them so nothing is lost, or continue without them."). Nothing is sent. After the choice, the open or create the person asked for runs (`heldEditsReopen` / `heldEditsCreate`).
  - An agent's switch → the same screen, nothing sent, and after the choice the tab loads the project the agent opened. No switch toast shows on this path.
  - Paused with nothing unsaved (a project stored over the limit, not touched) just switches.
- **Leaving.** The unload prompt was already armed while `dirty`, and paused-with-edits is dirty, so the browser prompt fires there. Paused with nothing unsaved doesn't prompt, because there is nothing to lose. No other state got a new prompt.
- **Load graph during its own import.** Found in the live check: the import's graphSync can reach the tab before the HTTP answer. That fires an autosave, which paused with GM's generic line a moment before the Load graph line replaced it. Now a pause entered while a graph import is still in flight stays quiet, and `noteLoadedGraph` says it with the file name.
- **Backend opening.** The open route skips the size check (`size_checked=False`), so a project stored over the limit opens and the canvas pauses. Every save path still checks.
- **"As a new project".** As first built, Load graph replaced the open project's canvas for every file. Justin settled it in Q120 (a); see "Q120" below.

## The agent tool

- MCP `project_size(project_id="current")`, read-only, and its CLI twin `nebula project size [id] [--json]`, both over `GET /api/projects/{id}/size`.
- They return the project (id, name, open), `sizeBytes`, `limitBytes`, `size` / `limit` text, `overLimit`, `savingPaused` (over and open), `overByBytes`, `largest` (top 10, with node ids, name, definitionId, part label, bytes, size), `smaller` (count, bytes, size), and a `note` when paused. The note says to trim with edit_canvas or remove_from_canvas (`nebula apply`), to ask the person before deleting their work, that it saves again by itself, and that run history clears only from the person's Run History panel.
- It is listed in INSTRUCTIONS, `docs/MCP-SETUP.md` and `skills/nebula/SKILL.md`. To keep INSTRUCTIONS under its 3,000-character cap (2,999 now), three existing lines were shortened, with no meaning lost.
- Agents got no new delete power. They trim with the tools they had, under the same approvals.
- **An agent's edit that would leave the open project over the limit is refused**, 413 `limit: "size"`, with its own text naming `project_size`. Before this nothing refused it: only the tab's autosave 413'd. The routes covered: add node, node-and-connect, update node, `/api/graph/apply`, `/api/graph/import` (non-person), cluster, and since the review an agent's undo (`/api/graph/apply/undo`), `/api/graph/restore` from anyone but the person, and the CLI's connect and rename.
  - On a paused project, edits that make it smaller go through, and edits that grow it are refused with "already over … Edits that make it smaller go through (remove_from_canvas, shorter params); ask the person before deleting their work."
  - The person's own edits and Load graph are never refused for size.
  - Not covered: accepting a proposal (the person's act), the model-change route (person-only: it calls `require_person`, so the check would skip it anyway) and layout moves (a move changes only a few digits of a position).

## Tests (tests first)

- **Backend, red on the base:** 14 failed, 11 passed (`test_project_size.py`, `test_project_size_tools.py`, and the updated #178 refusal test). The failures:
  - no `services.project_size` (×3);
  - no `limit` in the size 413;
  - the size route 404;
  - no `overLimit` / `largest`;
  - agent edits answered 200, not 413 (×3);
  - a project stored over the limit answered 413 on open;
  - no MCP `project_size` (×2);
  - #178's test missing `limit`.
- **Frontend, red on the base:** 5 tests failed, and 3 new files couldn't load (29 tests).
  - The 5: Load graph refused a 16 MiB+ JSON, #178's line ×2, `editsFileReopens` at 16 MiB, GraphFileActions not calling `noteLoadedGraph`.
  - The 3 files: `projectSize.test.ts` (9), `savePaused.store.test.ts` (11), `SavePaused.test.tsx` (9), all with no `lib/projectSize`, no `ProjectSizePanel`, no `SavePausedNotice`.
  - The live check found one more. "A Load graph whose own sync lands first …" failed with the guard taken out, then passed.
- **Green:** the focused gates below.

## Live check

The script is `scratchpad/over-limit/live/live.mjs`. Setup:
- isolated backend on 8782 (temp HOME and every NEBULA_* root in scratch, no keys, httpx limited to loopback) and Vite on 5782 (`VITE_NEBULA_BACKEND_PORT=8782`);
- `/api/health` and the project list checked through the Vite proxy first;
- Puppeteer with 8000-8010 and 5173 blocked by CDP `setBlockedURLs`, plus a dead proxy with a loopback bypass for 5782 and 8782 only (canary 8799 unreachable).

The file was a real-shaped `.nebula` of 18.8 MiB: six Text Input nodes with long text (7, 6, 4, 1.6 and 0.2 MiB, plus a tagline). A `.nebula` has no run history. It was loaded through Canvas actions > Load graph (the input fallback, so Puppeteer's file chooser can drive it).

**39 of 39 passed:**
- The notice read "Opened Big campaign.nebula. It's 18.9 MB, over the 16 MB save limit." with See what's large, in the save-paused slot.
- The header read "Saving paused · 18.9 MB" in rgb(230, 163, 149), with GM's tooltip, focusable, Enter opens the panel.
- The panel had the heading, "This project is 18.9 MB. Make it 2.9 MB smaller and it saves again by itself. …", Download a copy, Largest first, and rows Brief 7.0 / Script draft 6.0 / Interview transcript 4.0 / Notes (Text Input) 1.6 / Notes (Text Input) 0.2 / Project settings 0.0 / Tagline 0.0. No ids. It sat within the top and bottom lines (150..545 within 150..666) and stayed on screen at 1440.
- A row click selected "Interview transcript" and panned the canvas.
- Download a copy wrote "Glass campaign.nebula" (19.7 MB).
- No PUT was sent while paused.
- An MCP stdio session listed `project_size` as read-only. It returned savingPaused true, 18.9 MB of 16 MB, Brief first with its node id, on the paused project, and 0.0 MB not paused on a second project.
- A reload while paused fired the browser's beforeunload. Staying kept the paused canvas.
- Deleting one Notes node moved the size to 17.3 MB with nothing sent, and the panel line followed. Deleting Brief brought "Saving again. This project is 10.2 MB.", "Saved", and the panel closed.
- One PUT went to the isolated backend (200), and the stored project is the trimmed canvas. MCP then read 10.2 MB, not paused.
- A reload once saved: no prompt.
- 0 requests reached 8000-8010 or 5173.

Screenshots for GM: `gm-panel-1280.png`, `gm-header-1280.png`, `gm-loadgraph-notice-1280.png`, with 1440 copies in `live/shots/`.

## Gates

- Backend, focused (21 files: size, tools, #178 refusals, first-turn, MCP and CLI reads, MCP tools, graph apply/cluster/import guard, node-and-connect, CLI graph, projects, switching, context, open/save event loops, projectsChanged, asset rehome): **374 passed**.
- Frontend, focused vitest (29 files: the new ones, Load graph, graph files, #178, ProjectHome, header, project store and retry, unsaved edits, the notice region suite, error copy for projects, run history): **394 passed**.
- `npx tsc -b` clean. `npm run -s lint` clean.
- `npx vite build && node scripts/check-build-budget.mjs`: passed at 378,209 bytes raw / 113,913 gzip, against 372,624 on the base (+5,585: the measure, the lines and the store's paused state are in the entry; the panel and notice are in the deferred RegionNotices chunk). `dist/` deleted.

## Open items

- **Bundles over 16 MiB**: the `.nebula.zip` restore still refuses a graph.json over 16 MiB (`RESTORE_MAX_GRAPH_BYTES`), and Save graph's bundle refuses to write one. Only plain `.nebula` files over the limit open. Raising the bundle's graph limit wasn't asked.
- **Download a copy** holds the canvas only: a `.nebula` has no run history or Create draft.
- **Not covered for agent growth**: proposal accept and the model route (both the person's), and layout moves (above).

## Review

- Five confirmed findings, each with a test that failed first, then the fix:
  1. **The agent-edit size check's shortcut** skipped measuring when the catalog file plus the new canvas was under the limit. The catalog is written compact and the save check measures with ", " and ": ", so a stored history of short values measures up to 1.5x its catalog bytes, and an agent edit could leave the project over with a 200. The bound is now `(catalog_bytes * 3 + 1) // 2` (compact JSON has at most one separator per two bytes). Red: `test_a_stored_history_full_of_separators_doesnt_slip_past_the_shortcut` answered 200 (8 KiB limit, stored runHistory `[[0]*1400]`, catalog plus canvas under the limit).
  2. **An agent's undo and restore weren't checked.** `_restore_graph` now calls the check before committing, which covers `POST /api/graph/apply/undo` (`undo_canvas_edit`, `nebula undo`) and an agent's `POST /api/graph/restore`. The person's Cmd+Z is never refused, because the check skips the person. A refused undo changes nothing, and its token still works once there is room. Checking every path turned up two more, the CLI's `connect` and `rename` (`POST /api/graph/connect`, `PUT /api/graph/node/{id}/label`), which now try the edit on a copy first (`_guard_agent_growth_past_save_limit`). The model route calls `require_person`, so agents never reach it and it needs no check. Red: the undo answered "undone" 200; an agent's restore 200; connect 200 (the rename was never reached). MCP-SETUP.md's route list names them.
  3. **A save that failed while resuming kept `savePaused`.** The header then read "Saving paused · 18.9 MB", with the over-limit tooltip, for a project under the limit. Now a failure that isn't about the size drops the pause, the panel and a paused notice's "See what's large" (it would open nothing). The header reads "Save failed · Retry", then "Unsaved changes" on the next edit. GM's "Saving again" still comes with the save that lands (`resumePending`). Red: `savePaused` stayed `{ bytes: 16977523 }`; and "over the limit again after a failed save" reused the old notice id. The live check found the dead notice, then the test pinned it.
  4. **"Continue without them" wasn't true when the edits were the open project's own canvas.** That covers the person's Open or New project and an agent's switch while paused. The backend's switch keeps the live canvas's nodes, wires and settings in the project it leaves, and only what this tab alone had is lost. The first half of the finding (the hold before the run and World Labs checks) was refuted; the order in `activate()` is unchanged. `unsavedEdits.keptIn` now names that project, and the confirm says so with a **draft line** (`keptConfirmLine`): "Continue without them? The nodes, wires and settings stay in “{project}”. Run history and anything else only this tab has since the last save can't be recovered after this." A stale tab's copy and a params-version stop keep GM's line. Red: the store held `{ reason }` with no `keptIn`; the confirm read GM's "can't be recovered" line.
  5. **The agent tool rounded rows down** (6.7 for a 6.796 MiB row) while the panel rounds to the nearest tenth (6.8). The tool now uses `project_size.row_size` for rows and the "smaller" total, halves up like `Math.round`. The project total keeps `megabytes`. The fixture's new `rowSizes` (including the 7,126,427-byte case and the exact ties 262,144 and 786,432) pins both. Red: backend only (no `row_size`). The frontend's `rowSize` already matched, so its new fixture test passed from the start.
- One more, from the review's unverified list (fixed by the coordinator, test first): **a tab without the person's token got the agents' size text.** A canvas tab whose person token is from before Nebula restarted has no agent marker and isn't the person, so its Load graph or cluster add over the limit answered the agents' 413, which the canvas would show as the reason. The guard now answers a caller with no agent marker with the person gate's 403 `person_required` and the same `detail`, as `_person_only_refusal` does: the tab shows GM's reconnect line with the text behind Details, and once reconnected its Load graph isn't refused. An agent's answer is unchanged (413 `limit: "size"`, no `code`). Red: `test_a_tab_without_the_persons_token_is_asked_to_reconnect_not_shown_the_agents_text` got 413. MCP-SETUP.md's line on which refusals carry a `code` names it.
- **Live check** (8782/5782, isolated as above, 18.5 MiB file with a 6.796 MiB Brief and a 3.884 MiB transcript), `review-live/review.mjs`, **17 of 17 passed**:
  - MCP `project_size` and the panel gave the same row sizes (Brief 6.8, Script draft 6.0, Interview transcript 3.9, Tagline 0.0).
  - With the project's PUT blocked, deleting Brief brought the header to "Save failed · Retry", not paused, at 1280 and 1440. The panel and the paused notice were gone. The next edit read "Unsaved changes".
  - Unblocked, Retry saved: "Saving again. This project is 11.6 MB." and "Saved".
  - Paused again with edits, Open of another project gave #178's screen. The confirm named “Glass campaign”, and after "Continue without them" the stored Glass campaign did hold Brief, Script draft and the rest.
  - 0 requests reached 8000-8010 or 5173.
  - New screenshot for GM: `gm-kept-confirm-1280.png`.
- **Gates after the review:**
  - Backend, focused (20 files: size, tools, #178 refusals, restore, undo ×3, rename, connect and the other CLI routes, MCP tools, events, proposals, presence, spend): **763 passed**.
  - Vitest, focused (13 files): **248 passed**.
  - `tsc -b` and lint clean.
  - The build budget passed at 378,697 bytes raw / 114,108 gzip. `dist/` was deleted afterwards.

## GM's answers (2026-10-23)

- **The kept-in confirm**, GM's line, verbatim: "Continue without them? “{project}” keeps its nodes, wires and settings. Run history since the last save, and anything else only this tab has, will be lost." The stale-tab and params-version stops keep the original line.
- **Rows under 0.1 MB aren't listed** ("0.0 MB" tells nobody anything): they fold into "{n} smaller items, {size} MB in all", which shows even when every row is tiny. The panel (`listedRowCount`) and `project_size` (`listed_count`) list rows of 0.1 MiB and up, at most ten; the shared fixture's `listedRows` pins both. Red: the backend had no `listed_count`, the frontend no `listedRowCount`, and the panel listed ten rows with "0.0 MB".
- **The Load graph notice** (moved up from the next light round, since #182 was still open): "Opened {filename}. It's {size} MB, over the save limit." The limit is in the panel.
- **A save that fails some other way while paused**: no change. A new test pins GM's check that Save failed's Retry on a project over the limit again goes back to paused by itself and sends nothing. It passed on the code as built.
- Every other panel choice was approved as built. MiB stays labelled "MB".
- When the folded rows' total rounds to 0.0, the line drops its size: "14 smaller items" (GM's (b)). `project_size` keeps its `smaller.size` for agents.

## Q120 (2026-10-23)

Justin, Q120 (option a), verbatim: "Files over the limit open as a new project named after the file. The open project is left as it was. Files under the limit still replace the canvas, as today."

- **Which files: the backend's save check decides.** Load graph imports into the open project with `refuseOverSaveLimit: true`. `/api/graph/import` then measures the candidate graph as a project of its own (`_refuse_graph_over_save_limit_on_its_own`: the canvas export, as `project_size.snapshot_bytes` measures a stored project, with no run history) and, if it is over the limit, answers 413 `limit: "size"` before anything changes. On that 413 the tab makes the new project and imports there without the flag. The tab doesn't decide with its own measure: the import adds fields to dynamic nodes and changes ids, so it can be off by tens of KB either way (both reviews). A first build skipped the flagged try when the tab measured over, sparing a big file its second upload; the second review showed that could open a file just under the limit as a new project, so it was dropped. A file really over the limit is uploaded twice (about 10 s each for 17 MB through the dev proxy). The open project's run history doesn't count: a file under the limit whose load still takes the open project over it replaces the canvas and pauses, as before.
- **The name.** `projectNameForFile` (lib/projectSize): the file name without `.nebula.zip`, `.nebula`, `.json` or `.zip`, control characters as spaces, at most 120 code points (the backend's `project_name` rule), or "Untitled project" when nothing is left. The backend allows two projects with one name, so a second load of the same file makes a second "Big campaign".
- **Order.** Load graph reads and checks the file first. Then `createProject(name, then)` creates the project, and `then` imports the file into it. The create flushes the open project's own edits first, as any switch does, so the open project keeps what it had and nothing of the file. A bundle's assets are restored before the create; they go to `output/<timestamp>/restored-*` either way, which isn't per project.
- **Paused with unsaved edits.** When the open project is itself paused with edits only in this tab, the create waits behind #178's screen, as New project does. `then` waits with it (`heldEditsCreate.then`), so after the person's choice the new project opens and the file loads. It never runs when the create doesn't land (refused, a run still going, a params version change).
- **No project open** (Projects not loaded): the file replaces the canvas, as before.
- **Review fixes.**
  - Try again after a create that was turned away (a run still going, a WorldLabs hold, a save that failed first) kept only the name, so it would have made an empty project and dropped the file. The create retry now carries `then`.
  - When an agent's switch brought #178's screen back while the create waited behind it, `holdRefusedEdits` cleared the person's create. A create that loads a file now survives that; after the choice it still runs.
  - When Projects was busy (a rename, a save's answer), the create returned without a word. Load graph now waits for Projects to be idle before it creates. If the create still returns without opening, without #178's screen and without its own line on Projects (Projects not loaded, say, after an agent's switch it couldn't follow), the canvas says "Couldn't load the graph. Try again, or reload if it keeps happening." (the general line under Load graph's heading, GM's).
  - A tab whose person token is from before Nebula restarted: the flag's refusal is the person gate's 403 `person_required` for it (an agent still reads the 413), so it doesn't make an empty project it then can't load into.
  - Hardening: a create waiting behind #178's screen is cleared when a project opens, and a waiting create and a waiting open replace each other (the latest ask wins), so a stale create can't run later in place of an open.
  - Left as it is: when a create's answer is lost (the network drops after the backend commits), Try again reloads the projects and the new project opens empty. "Couldn't confirm the project change." says so, and Load graph opens the file again.
- **Agents.** No agent tool loads a file: agents make a project with `new_project` and build with `nebula apply`, and their growth past the limit is refused (`_refuse_agent_growth_past_save_limit`). Nothing to add for MCP.

Backend test: `test_load_graph_can_ask_to_be_refused_when_the_file_is_over_the_limit_on_its_own` (over, near the limit as stored, and under; red without the flag's handling).

Tests, each red before its change except the regression guards (a refused create, a small file): `projectSize.test.ts` (the name, 3); `savePaused.store.test.ts` (then after the switch; a refused create loads nothing; held edits then the load; Try again keeps the load; an agent's switch keeps it); `GraphFileActions.test.tsx` (the 413 then a new project, the canvas never replaced first; the line when a create returns silently; no line when it waits or has its own; waits for Projects; a small file replaces, flagged; no project open, unflagged). The backend test also covers the stale tab and an agent.

Live check (`q120-live/live.mjs`, isolated backend 8783 + Vite 5783, no keys, 8000-8010 and 5173 blocked; 20 passed):
- From "Glass campaign" (one node), Load graph on a 17 MB `Big campaign.nebula`: "Big campaign" opens with the file, GM's line "Opened Big campaign.nebula. It's 17.1 MB, over the save limit.", the header "Saving paused · 17.1 MB", the backend lists it as active, and Glass campaign's stored snapshot is still its one node. Nothing is saved to the new project.
- In that project, an edit and then Load graph on the big file again: #178's screen; after "Download your edits", a second "Big campaign" opens with the file, about 12 s later (a 17 MB upload through the dev proxy).
- Back in Glass campaign, a 308-byte file replaces its canvas, no project is made, and Glass saves it, as before.
- A first run timed out at the second project. It shared the machine with a build and the full suite; alone it passed.

## For GM

- New choices to check:
  - The panel heading is in the header's warning colour.
  - A × Close button sits beside it.
  - Non-node rows have dim count labels: "{n} runs", "{n} wires".
  - Tiny rows read "0.0 MB".
  - "1 smaller item" is singular.
  - A dot separates a duplicate's type label from its part ("Notes  Text Input · Text").
  - Two more part labels I named for real fields: "Embedded files" (`data:` URLs in a node's settings) and "Node data" (the rest of the entry).
- The notice uses the canvas notice's reading-time hold, not the 6 s Undo hold, because its line is long.
- Screenshots: `gm-panel-1280.png`, `gm-header-1280.png`, `gm-loadgraph-notice-1280.png`.
- **A line to write (review):** the "Continue without them" confirm when the held edits are the open project's own canvas, whose nodes, wires and settings stay in that project. The draft in `unsavedEditsCopy.ts` `keptConfirmLine`: "Continue without them? The nodes, wires and settings stay in “{project}”. Run history and anything else only this tab has since the last save can't be recovered after this." Screenshot: `gm-kept-confirm-1280.png`.
