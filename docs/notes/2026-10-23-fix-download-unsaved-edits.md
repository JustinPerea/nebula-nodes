# 2026-10-23 — Download your unsaved edits when Nebula can't keep them

Branch `fix/download-unsaved-edits`, from main at adf5cbe0 (after #175, the complete undo). Worktree `nebula_nodes-unsaved-edits`. Backend (one additive field), frontend and notes. No package installed, no paid provider call.

## What and why

A tab that falls behind (Nebula was updated, another window took the project, an agent switched projects and the save into the old one failed) saves its unsaved edits as a recovered project before it reloads. That copy lives only in the tab's memory. When the backend refused it for good (too large, say), every Try again sent the same copy into the same refusal, and the only way out was a page reload that dropped the edits without saying so. Round 3b found this gap and left it as an open item.

Justin's answer to Q116, 2026-10-23: "a): "Download your edits" plus "Continue without them"." The option he picked: "Offer "Download your edits" (saves them as a .nebula file you can open later) and "Continue without them" (asks first), then load the projects."

GM - Design's copy for a), verbatim: heading "Couldn't save your edits."; reason when too large "These edits are too large for Nebula to save. Download them so nothing is lost, or continue without them."; for other refusals for good, the mapped reason with the same second sentence; buttons "Download your edits" (primary) / "Continue without them"; the confirm "Continue without your edits? They can't be recovered after this." with "Continue without them" / "Cancel" and focus on Cancel; after a download "Your edits are saved as {filename}. Open it from Projects to bring them back.", with GM's note "Use whatever the real reopen path is called."

What changed:

- **The held edits' screen.** `store/projectStore.ts`: `recoverPendingWork` is the one place the copy is sent. When the answer is a refusal a retry can't fix, it marks the copy held (`holdRefusedEdits`), sets `unsavedEdits: { reason }` and throws `EditsRefused`, which every caller stops on. From then on nothing sends the copy again: Projects' load and Try again, a later params-version stop, another window's change and a socket reconnect all leave it alone (`recoverPendingWork` refuses a held copy before sending; `preserveWorkspaceConflict` keeps the screen). `components/projects/UnsavedEditsNotice.tsx` shows GM's heading, reason and the two choices in place of the error line, as `role="alert"` like the screen's errors. New project is disabled until the person chooses.
- **Download your edits.** `downloadUnsavedEdits` writes the held snapshot with `saveEditsToFile` (`lib/graphFileShared.ts`): the graph file writer the app already has (`serializeGraph`, a version 2 `.nebula` JSON file), through the save picker where there is one and as a plain download otherwise. A cancelled picker returns to the two choices with the copy still held. Then the tab lets go of the copy, shows GM's line with the file's name (`role="status"`), and loads the projects. If the stop interrupted an Open whose answer was lost, that open finishes afterwards, as Try again would have done.
- **Continue without them.** It asks first in an in-app dialog (`role="alertdialog"`, `aria-modal`, focus on Cancel, Escape is Cancel, Tab stays inside, never `window.confirm`). Cancel returns to the two choices. Confirm drops the copy, sends nothing about it, and loads the projects.
- **A failure a retry can fix keeps today's Try again** and today's line: no answer, 408, 429, any 5xx (the 507 storage errors, a full disk included).
- **Backend, one additive field.** `ProjectLimitError` now says which store limit it hit, and its 413 answer carries `limit: "projects"` (the 500-project cap) or `limit: "storage"` (the catalog's 128 MiB cap) beside the same `detail` (`main._storage_error_body`). `RequestFailedError.storageLimit` reads it. This is how the screen tells "this copy is too large" from "the store is full" without reading the words.
- **The reader, pulled out.** `readGraphSelection` (`lib/graphFile.ts`) is the part of `loadFromFile` after the picker, unchanged. Load graph still uses it, and the round-trip test now calls it directly.

## Decisions not in the spec

- **The refused-for-good set, read from every `raise` on `POST /api/projects/recover`:**
  - 400: a bad recoveryId, a bad paramsVersion, a bad sourceProjectId, a snapshot that isn't an object, nested too deeply, a non-finite number, a protected file path, bad node/edge/run-history/viewport/session shapes, an unknown or retired node definition, a cycle, a bad project name.
  - 403: a billing change the request may not make (`_refuse_agent_billing_change`); a foreign Host/Origin (LocalRequestGuard). Not when the answer says `code: "person_required"` (see Review): a tab whose person token is stale or missing gets that, and reconnecting fixes it.
  - 409: "Recovery ID already belongs to a different snapshot". This is the route's only 409. It isn't a revision conflict: `/api/projects` isn't among the revision-checked prefixes, and the route is exempt from the params gate. Sending the same copy again gets the same answer.
  - 413: "Project snapshot exceeds the 16 MiB limit", "Project contains too many nodes or connections", "graph payload contains too many values" (the copy is too large: GM's line), and the store limits "Project limit reached" / "Project storage limit reached" (with `limit`: the mapped reason, not "too large").
  - 422: a JSON number out of range (JsonNumberGuard), or FastAPI's body check.
- **The set a retry can fix:** no answer (`ConnectionLostError`), 408, 429, 5xx, including 507 "Project storage is unavailable; the canvas was preserved" and the disk-full 507 (`storage: "full"`). A plain error that isn't a request's also keeps Try again, as before.
- **The rule in code** is the one Projects already used for "refused for good" (`refusedForGood`: a 4xx other than 408/429), from the status, minus a 403 whose `code` is `person_required` (see Review). "Too large" is `status === 413 && storageLimit === null`. No text is read.
- **The mapped reason** is the reason the screen used before (`failureCopy`), made a full sentence (a period added when the backend's detail has none, such as "Project limit reached"). A refusal with no reason of its own (GM's general line, which says "reload") shows only GM's second sentence, as the screen already did for a pending copy.
- **The reopen path's name and place.** The app reopens a `.nebula` file with "Load graph", under "Canvas actions" in the canvas toolbar (also Ctrl/⌘ O and the command palette). Projects has no open-file action. Load graph replaces the open canvas, so the line says to use a new project: "Your edits are saved as {filename}. Open it with “Load graph” under “Canvas actions” in a new project to bring them back."
- **The filename.** The project's name made safe for a file name (control characters and `/ \ : * ? " < > |` become spaces, spaces collapse, leading and trailing dots and spaces go, at most 80 characters, "Untitled project" if nothing is left), then " - unsaved edits.nebula". Example: "Glass campaign - unsaved edits.nebula". The save picker can rename it; the line shows the name the person chose.
- **The format: `.nebula` (version 2 JSON), not the `.nebula.zip` bundle.** Both open with Load graph. The spec asks for a `.nebula` name, and the plain file needs no asset fetches at the moment the person is trying to rescue their work.
- **The writer is in the startup entry.** `serializeGraph`, its types and the save-picker helper moved from `lib/graphFile.ts` (a deferred chunk) to `lib/graphFileShared.ts`, and `graphFile.ts` re-exports them. The notice is eager too, with Projects home. This screen shows up when Nebula was updated under the tab, which is exactly when an old build's deferred chunk may be gone. That costs a few kB of entry: 367,657 bytes raw, under the 512,000 budget.
- **No automatic reload after a download during an update stop.** That stop normally reloads the tab at once. After a download it shows "Nebula was updated while this tab was open. Reload the tab to use the update. Your saved work is kept." instead, so GM's line saying where the file went stays on screen (and a plain download isn't cut short). After Continue without them it reloads as before.
- **When the person chooses, the canvas counts as handled** (`lastSaved` is the held snapshot, the same thing a successful recovery does), so a later stop doesn't copy the same edits again.
- **The beforeunload check (spec item 6):** the existing prompt already covered this screen. Every path that holds a copy leaves `dirty` true, and the prompt asks whenever `dirty` is set (and the tab isn't reloading for an update). Nothing needed changing. Tests now pin it: the prompt asks while the screen shows and stops asking once the person has chosen. Live, a reload during the screen got the browser's prompt, and staying kept the screen and the copy.

## Tradeoffs

- A `.nebula` file holds the canvas (nodes, wires, params, outputs, the view). It has no run history and no Create draft, so those don't come back. They are usually what made the copy too large.
- Images and other outputs are referenced by their URL on this Nebula, not packed into the file. They show again on this machine. On another machine, or after the outputs folder is cleared, they're missing (Save graph's `.nebula.zip` carries them).
- If the canvas itself (not its run history) is past one of Load graph's limits (16 MiB of JSON, 10,000 nodes, 50,000 wires, 1,000,000 values), the file is still written, so nothing is lost, but Load graph can't open it. Since the review, the line after the download says so instead of promising Load graph brings the edits back.
- A plain download (no save picker) can't report a cancel or where the file went. The line names the suggested file, and the browser decides the folder. Chrome, Edge and the desktop app have the picker. Where the picker throws anything other than a cancel, it falls back to the plain download, as Save graph does.
- While the screen shows, an agent opening another project still tries the handoff: the tab saves the canvas into the project it came from. If that works, the edits are saved and the screen goes. If not, the tab sends one fresh copy, and a refusal shows the screen again. That's one send for each agent switch, never a loop.

## Surprises

- The recover route has no "revision conflict" a retry would resolve: its only 409 is a recovery ID reused for another snapshot.
- In the live check, Puppeteer's element-handle clicks (`ElementHandle.click`, locators) stalled once the page held an 18 MB run history. Coordinate clicks (`page.mouse.click`) worked at once. The page itself stayed responsive; this is a driver quirk, not an app one.
- The store's own project-count and catalog-size limits are 413s too, which is why the backend needed to say which limit it was.

## Agent support

Agents never hold a tab's unsaved edits and can't see this screen: it is the person's own tab state. So nothing is added to MCP or the `nebula` CLI. Agents and the CLI read `detail`, which is unchanged word for word. The new `limit` field only rides along on the store's 413s (an agent's `new_project` at the 500-project cap gets it too, and ignores it). The MCP INSTRUCTIONS and `skills/nebula/SKILL.md` don't change. Since the review, a project-snapshot billing refusal for a request with no agent marker (the CLI without `NEBULA_AGENT_NAME`, curl, a tab not connected as the person) also carries `code: "person_required"`, with `detail` unchanged. `docs/MCP-SETUP.md` says so under the Krea billing rules. An agent with a marker gets exactly what it got before.

## Tests (written first; red on adf5cbe0)

- Backend `backend/tests/test_unsaved_edits_refusals.py` (5): red **3 failed, 2 passed**. The three store-limit tests (count, catalog size, a create at the count limit) failed on the missing `limit`. The two guards passed: a copy that's too large stays a 413 with its detail and no `limit`, and a storage failure stays a 507. The catalog test first hit the read limit (507) because its limit was set too low. After fixing its setup it was run again on the base source (the two source files reversed for one run) and failed on the missing field. Logs: `unsaved-edits/red-backend.log`, `red-backend-2.log`.
- Frontend (logs: `unsaved-edits/red-frontend.log`), red **24 failed, 3 passed**:
  - `tests/graphFile.unsavedEdits.test.ts` (5, all red): the filename, the round trip through the real reader (same nodes, wires, params, outputs, view), the picker's chosen name, a cancelled picker, the plain download.
  - `tests/unsavedEdits.store.test.ts` (19: 16 red, 3 green): too large shows GM's screen and the copy is never sent again (startup load, Try again, another window, an update); another refusal's mapped reason; the project limit isn't "too large"; no reason of its own; download writes the held copy, names the file and loads the projects; a cancelled save keeps the copy; Continue drops it and sends nothing; the unload prompt; an update stop (screen at once, no reload after a download, reload after Continue); an agent switch; a lost Open finishing afterwards. The 3 that passed on the base are the guards that a retry-fixable failure (503, no answer, 507) keeps Try again.
  - `src/components/projects/ProjectHome.unsavedEdits.test.tsx` (6, all red): heading, reason, buttons and alert role with no Try again; Download is primary; the confirm (alertdialog, focus on Cancel, Cancel returns focus, Escape, confirm, no `window.confirm`); Tab stays in the confirm; disabled while busy; GM's line after a download as a status.
- All pass after the change (5 backend, 30 frontend).

## Live check

Isolated backend on 8782 through `iso.sh` (temp HOME, every NEBULA_* root in `unsaved-edits/live/state`, no keys or tokens, outside network refused in the process), Vite on 5782 with `VITE_NEBULA_BACKEND_PORT=8782`, checked through Vite's proxy first. 8000-8010 and 5173 were blocked in Chrome with CDP `Network.setBlockedURLs` plus the dead proxy (`127.0.0.1:9`, bypass only 5782 and 8782). The canary 8799 was unreachable. **0 blocked attempts.** Nothing paid ran. **32 PASS, 0 FAIL** (`unsaved-edits/live/live.mjs`, results in `live/results.json`).

- A real too-large copy: the open project's canvas plus 400 run records repeating the graph, 18.5 MB of run history. Its autosave was refused 413. A second person window opened another project, and the tab read "The active project changed in another window. Try again to save your unsaved edits as a recovered project." Try again sent one recover, answered 413, and the tab showed GM's screen: "Couldn't save your edits." / "These edits are too large for Nebula to save. Download them so nothing is lost, or continue without them." / "Download your edits" (primary) and "Continue without them". It was an alert, with no Try again, and fit at 1440x900 and 1280x800. Tab reached "Download your edits". No second recover went out while it showed.
- A reload during the screen got the browser's leave-page prompt. Staying kept the screen and the copy.
- A cancelled save picker kept the two choices. Without a picker, the download landed as `Glass campaign - unsaved edits.nebula` (889 bytes, version 2, both nodes and the edited value). The line read "Your edits are saved as Glass campaign - unsaved edits.nebula. Open it with “Load graph” under “Canvas actions” in a new project to bring them back." The projects loaded, and there was still only one recover.
- New project, then Canvas actions > Load graph with that file: the canvas came back with both nodes and the edited value.
- An agent opened another project while the canvas held a too-large edit. The handoff save was refused, one recover was answered 413, and GM's screen showed (not "couldn't follow it"). "Continue without them" opened GM's confirm, an in-app modal with focus on Cancel and no native dialog. Enter on Cancel went back to the two choices, with focus on the button. Confirm loaded the projects, sent nothing more, and the edit is in no project.
- A failure a retry can fix: the backend was stopped while a small edit waited. Try again read "Couldn't recover the project. Nebula's server isn't answering. Make sure it's running." beside Try again (no GM screen). With the backend back, Try again saved "Glass campaign (recovered)" and loaded the projects.
- Screenshots for GM (1280x800 and 1440x900): `unsaved-edits/live/shots/gm-screen-1280.png`, `confirm-1280.png`, `after-download-1280.png`, and the 1440 pairs.
- Servers were stopped by port and the state dirs deleted afterwards.

## Gates

- Backend, whole suite (`iso.sh .venv/bin/python -m pytest -q -p no:cacheprovider`): **10262 passed, 71 skipped**, 0 failed (4:27). A first run at background priority crawled under a load average near 30 and was stopped. This run was at normal priority.
- Frontend `npx vitest run`, whole suite, under a load average near 30 at background priority: 4581 passed and 243 failed in 59 files. 206 of those were "Test timed out in 5000ms", plus worker and hook timeouts and their knock-on lookups. Those 59 files, run again alone at normal priority: **59 files, 930 tests passed**, 0 failed.
- That full run came before one last small store change: a tab that already reloaded once for an update keeps the rebuild line after a download. After that change, `tests/unsavedEdits.store.test.ts` and `tests/paramsVersionReload.test.ts` were run again: 43 passed.
- `npx tsc -b`: clean. `npm run -s lint`: clean.
- `npx vite build && node scripts/check-build-budget.mjs`: passed, **367,657 bytes raw** (110,335 gzip) against the 512,000 budget.
- Final gates on the finished code (the build above ran before the last store change), focused files only; CI runs the whole suites:
  - Backend: `test_unsaved_edits_refusals.py`, `test_projects.py`, `test_params_version_gate.py`, `test_project_open_event_loop.py`, `test_saved_graph_upgrades.py`, `test_krea_billing_routes.py` (every file that touches the store limits or the recover route): **162 passed**, 0 failed.
  - Vitest `--maxWorkers=3`, 26 files (the three new ones, every projectStore and graphFile test, ProjectHome, GraphFileActions, paramsVersionReload, the error-copy projects/sweep/raw-message guards, the switch toast, commonsUnsavedExits, App.workspaceNavigation, App.updatesEveryScreen): **26 files, 349 tests passed**, 0 failed.
  - `npx tsc -b`: clean. `npm run -s lint`: clean.
  - `npx vite build && node scripts/check-build-budget.mjs`: passed, **367,675 bytes raw** (110,347 gzip) against 512,000. `dist/` deleted afterwards.

## Open items

- A canvas past Load graph's limits (16 MiB of JSON, 10,000 nodes, 50,000 wires or 1,000,000 values) downloads fine, and the line now says Load graph can't open it, but nothing in the app can open it either. It's rare (run history is the usual bulk). Raising the reader's limits, or a reader for big files, would close it.
- A tab that isn't connected as the person sees the backend's billing refusal on Projects, beside Try again and the reconnect banner. That text is written for agents ("propose the change instead with propose_change (`nebula propose`)"). HEAD showed the same text there. A person's line for it is GM's call (see For GM). Answered: GM's line 3 (see "GM's lines" below).
- Load graph replaces the open canvas without asking. The line steers people to a new project, but an "Open in a new project" action on Projects would be the natural reopen path. For GM and Justin.
- A failure writing the file at all (not a cancel) keeps the two choices with no line. The writer falls back to a plain download, so this is near unreachable. GM's copy doesn't cover it. Answered: GM's line 2 (see "GM's lines" below).

## Review (2026-10-23)

Four confirmed findings, each with a test that failed first, then the fix. Red: backend **3 failed, 6 passed** (`unsaved-edits/review-red-backend.log`); frontend **15 failed, 31 passed** across the four files (`review-red-frontend.log`, plus the cancelled-picker test re-run after its first version passed on the old code for the wrong reason).

- **A stale person token is not a refusal for good.** After Nebula restarts, a tab holds an old person token. If its recovered copy changes how a node is billed, the backend refused it with a plain 403, and the tab held the edits with no Try again, though reconnecting would fix it. Now `_refuse_agent_billing_in_project` (autosave, the handoff save and the recovered copy) answers a request with no agent marker with `code: "person_required"` beside the same `detail`, word for word, as the Stop gate already does for anonymous callers. An agent's refusal is unchanged (no `code`). The canvas reads `code` (`RequestFailedError.code`, from `readFailureBody`), shows its reconnect banner, and `refusedForGood` keeps Try again for it. After the person opens the fresh link in the same tab, Try again sends the same recoveryId and it saves. I kept the backend's detail rather than swapping in the person-required sentence: the billing tests read it for unmarked requests (`test_krea_billing_routes.py`), and MCP-SETUP promises scripts the specific text. `docs/MCP-SETUP.md` now says snapshot refusals carry the code. Tests: three backend (no token, stale token, autosave; plus an agent keeps the plain refusal), two store tests (person_required keeps Try again and the same copy saves; a 403 with no code is still held), and one real-HTTP test.
- **A file Load graph won't open no longer says it will.** `saveEditsToFile` now returns `{ name, reopens }`. `editsFileReopens` checks the file the way Load graph does: its size against 16 MiB, then the same shape walk (`assertGraphComplexityWithinLimits`: nodes, wires, values, depth) on the parsed file. The limits and the walk moved from `graphFile.ts` into `graphFileShared.ts`, so there's one copy of them and the startup entry doesn't pull in the deferred chunk; `graphFile.ts` re-exports them. The file is still written either way. When it won't reopen, the line reads "Your edits are saved as {filename}. The file keeps them, but it's too large for “Load graph” to open." (not GM's copy yet; see For GM). The file is now written compact, as the backend measured it, so indenting can't push it past 16 MiB. Tests: a 10,001-node held copy through the real writer in the store, every limit at and past its edge, the compact form, and the line in ProjectHome.
- **The `limit` field is pinned through a real answer.** New `tests/unsavedEdits.limit.test.ts` sends real `Response`s through `readFailureBody`, `requestError` and the project client, with no source change for this one: `limit: "projects"` / `"storage"` and its absence, and `code`. It also runs the store end to end, checking that a store-limit 413 gets the mapped reason and not "too large". Those `limit` tests passed on the old code (the plumbing worked; nothing pinned it).
- **Focus no longer drops to the page body.** When the notice goes, ProjectHome moves focus to the saved line after a download, or to the page heading after Continue without them, but only if focus was lost. Both take `tabIndex={-1}`, with the neutral ring from the keyboard and none from a click. After a cancelled save picker, the notice gives focus back to Download your edits. The first version waited a frame. Live, headless Chrome runs no frames for a background tab, and focus stayed on the body. The effect runs after the notice is gone anyway, so it now focuses at once.
- **Live check** (backend 8782, Vite 5782 with `VITE_NEBULA_BACKEND_PORT=8782`, temp HOME and state, no keys, 8000-8010 and 5173 blocked with CDP plus the dead proxy, canary 8799 unreachable): **21 PASS, 0 FAIL, 0 blocked attempts**, nothing paid (`unsaved-edits/live-review/review-live.mjs`, `results.json`).
  - A too-large copy: Tab, then Enter on Download your edits. Headless Chrome's own save picker cancels at once, and that came back to the two choices with focus on Download. Without the picker, Enter downloaded the file, and focus landed on the saved line (the next Tab went to Search projects).
  - A copy with 1,000,001 values: the backend answered 413, and GM's screen showed. The download wrote all the values, and the line said Load graph can't open the file. Load graph's own reader refused it ("Graph contains more than 1,000,000 values.").
  - Continue without them, from the keyboard: the confirm opened on Cancel, Shift+Tab reached its Continue without them, and focus then landed on the page heading.
  - A stale token: the backend restarted with a new token, and the tab switched a Krea node to the plan. The recover got a 403 and the reconnect banner showed, with Try again and no held screen. After the fresh link opened in the same tab, Try again got a 200, and "Glass campaign (recovered)" kept the switch.
  - Screenshots: `unsaved-edits/live-review/shots/after-download-focus-1280.png`, `-1440`, `after-download-too-large-1280.png`, `-1440`, `after-continue-focus-1280.png`, `person-required-1280.png` (taken at 1440x900). Servers stopped and the state and downloads deleted.
- **Gates** (focused; CI runs the whole suites):
  - Backend, 15 files: `test_unsaved_edits_refusals`, `test_projects`, `test_params_version_gate`, `test_project_open_event_loop`, `test_saved_graph_upgrades`, `test_krea_billing_routes`, `test_billing_choice`, `test_moodboard_agent_actions`, `test_retired_nodes`, `test_graph_apply`, `test_asset_proposals`, `test_codex_session`, `test_run_billing_params`, `test_agent_workspaces`, `test_project_switching`. **367 passed**, 0 failed.
  - Vitest `--maxWorkers=3`, 24 files (the four edits files, ProjectHome, every graphFile and projectStore file, GraphFileActions, paramsVersionReload, the error-copy projects, sweep and raw-message guards, retrySweep 3b, the switch toast, commonsUnsavedExits, App.workspaceNavigation, personSession): **537 passed**, 0 failed. An earlier run under a load average of 44 timed out one GraphFileActions test at 5 s; it passed alone, 25 of 25, and in the final run.
  - `npx tsc -b`: clean. `npm run -s lint`: clean.
  - `npx vite build && node scripts/check-build-budget.mjs`: passed, **368,399 bytes raw** (110,565 gzip) against 512,000. `dist/` deleted afterwards.

## GM's lines (2026-10-23)

GM - Design answered Q116 with five lines; all five are built verbatim, curly quotes included. The lines themselves are listed under "For GM" below.

### What changed

- **Line 1, a download Load graph can't open.** `editsSavedTooLargeLine` in `unsavedEditsCopy.ts` is now GM's line. The branch that picks it (`reopens: false` from `editsFileReopens`) stays as it is, because Q118 is still open.
- **Line 2, a download that couldn't be written.** This needed a real failure path first. Before, `saveBlobWithPicker` fell back to a plain download whenever anything in the picker path threw. A failure after the person had picked a file (`createWritable`, `write`, `close`, for example `QuotaExceededError`) now aborts the partial file and throws `SaveFileWriteError`, but only for `saveEditsToFile` (`{ reportWriteFailure: true }`). Save graph keeps its old fallback. A picker that fails before a file is chosen still falls back to a plain download.
  - The store marks `unsavedEdits` with `downloadFailed: true`. `UnsavedEditsNotice` keeps the "Couldn't save your edits." heading and both buttons, with GM's line as the body, and the copy stays held.
  - A cancelled picker goes back to the two choices with no line, as before.
  - A retry after a failure works: the next download clears the flag and writes the same copy.
- **Line 3, a person-only refusal, classified by `code` only.** `RequestFailedError` (and everything built on it) now takes its reason from `copyForAnswer(status, detail, code, reason?)`: a 4xx with `code: "person_required"` always reads GM's line, whatever words the backend or the caller wrote. `failureDetails(error)` hands back the agents' text for Details. Answers read by hand use `readRefusal(response)` plus `copyForAnswer`.
- **Line 3's Details.** Projects, a node's card and the chat panel put the agents' text behind the existing `ErrorDetails` "Details" toggle, which starts closed.
  - Projects: the error line sits in `.project-home__error-text`, with `projectErrorDetails(state)` keyed to the line it belongs to, so the text can't stay behind under a different error.
  - Node card: `errorPerson` holds GM's line, `error` holds the agents' text, and `errorProviderText` is set.
  - Chat: a `SystemLine` with `details`.
- **The banner.** `personRequiredMessage()`'s default case (`not-connected`) is now GM's line. `PersonRequiredBanner.tsx` was not edited. The desktop shell's own lines are unchanged.
- **Backend.** A new `_person_only_refusal(detail)` in `main.py` returns the old `HTTPException(403, detail)` when the request carries an agent marker (`X-Nebula-Agent`, `X-Nebula-Client` or `Authorization: Agent`), and `PersonGateError(403, detail, PERSON_REQUIRED)` when it doesn't. The `detail` is the same string either way.
  - Three catch sites rethrew or inspected `HTTPException` only, so each now also catches `PersonGateError`: `_require_run_spend_approval` (so it still forgets the run), `_undo_refused_change` and `_check_style_write` (which still rewrites its propose wording and keeps the status).
  - `_refuse_agent_billing_in_project` no longer needs its own try/except: the shared helper now does the marker check.

### person_required places

Backend callers, read one by one. Changed (each one is now `raise _person_only_refusal(...)`):

| Refusal | Routes that reach it | Test |
|---|---|---|
| `_refuse_agent_billing_change`: provider switch, Krea billing mode, notes to generators | PUT `/api/graph/node/{id}`; POST `/api/graph/node`, `/node-and-connect`, `/cluster`, `/import`, `/restore`; POST/PUT `/api/presets` (through `_check_style_write`); the run gate `_refuse_agent_billing_in_run` (POST `/api/execute`, `/execute-node`, `/quick`, `/cinema/generate-shot`); the project snapshot paths (`/api/projects/recover`, PUT `/api/projects/{id}`, the handoff save), which already had the code since the review | one test per route, two cases each (forged origin, stale person token) in `test_person_required_routes.py`; snapshot paths by the guard test there and `test_unsaved_edits_refusals.py` |
| `_check_run_approval`: "Only the person's canvas starts a run they approved…" | POST `/api/execute` / `/execute-node` with an `approvalId` | `test_a_run_the_person_approved_started_from_a_tab_not_connected_as_them` |
| `_require_spend_approval`: over the agent spending limits | POST `/api/execute`, `/execute-node`, `/api/graph/run`, `/quick` | `test_a_run_over_the_agent_spending_limit` (three routes) |
| `_reader_spend_hold`: a Moodboard read over the limits | POST `/api/moodboards/{id}/read` | new test in `test_moodboard_reader_routes.py` (two cases) |

Each test asserts two things. An agent with a marker gets exactly `{"detail": …}`, as before. An unmarked request gets exactly `{"detail": same, "code": "person_required"}`. Nothing changed and nothing ran.

Read and left alone, with the reason:
- `/api/graph/apply` (`apply_graph_edit` calls the billing check): it is agents only, so a marker is always there.
- 403s on proposal accept and reject keys: the caller already passed `require_person`, which carries the code.
- "The person doesn't need to propose" and the 403s on agent-only routes: the caller is the person, so this line doesn't fit.
- Commons `human_dep`: Bearer auth. A tab without the token never sends, and a stale token gets a 401, not a 403.
- Krea connector `local_origin`, zoom telemetry, output restore: origin checks, not person checks.
- `require_person` routes and Stop: they already carried the code.

Frontend places that now show line 3 for a `person_required` code:
- Projects, under "Couldn't recover the project." (recover, autosave, handoff save, a params-version stop, an agent switch), with Details.
- A node's card, for every refused start (`markNodesErrored` at all five refused-start catch sites: run, run node, quick, the cinema shot, an approved run), with Details. The heading is "Couldn't run the node.".
- The chat panel, for a WebSocket error with that code: a system line with Details, without the "Warning:" prefix. The banner is still reported.
- One-line surfaces get line 3 with no Details. The agents' text goes to the console (`warnFailure`). They are:
  - Every `apiRequest` / `requestError` caller: Settings, toasts, notices, Enhance prompt, assets.
  - The proposal bar. For a `person_required` 403 it now reads line 3 instead of "Only the canvas can accept/reject this. Reload the page.", which still shows for a 403 without the code.
  - The Krea connection (`kreaJson` reads only `code`).
  - Cinema motion (`refusalReason`).
  - The graph store's backend rejections (`backendRejectionReason`).
- `code` now travels through `ExecutionStartRejectedError`, the canvas proposal errors and the asset proposal errors.
- Not changed:
  - Param-edit PUTs: console only, plus the banner, as before.
  - The chat's own local authority check: there is no request and no code.
  - Uploads and the Paper source: not person-gated.
  - Commons: see above.

### Tests (written first)

- Backend, red on the base source: **32 failed, 1 passed** (`unsaved-edits-gm/red-backend.log`). Every failure was the missing `{'code': 'person_required'}`; the agent half of each test already passed. The one that passed is the guard that the snapshot paths still say person_required. Green: 67 passed (the new file, the moodboard reader routes, the unsaved-edits refusals).
- Frontend, red: **22 failed, 72 passed** across 10 files (94 tests). The 28 new or changed tests split into 22 red and 6 guards that passed on HEAD: no code means no Details, a cancelled picker shows no line, Save graph keeps its fallback, and similar (`unsaved-edits-gm/red-frontend.log`). Green: 94 passed.
  - New: `tests/personRequiredLines.test.ts` (10) and `tests/personRequiredCards.test.tsx` (2).
  - Added to: `ChatPanel.commons` (1), `graphStore.errorCopy` (1), `canvasProposalsStore` (2), `ProjectHome.unsavedEdits` (4), `unsavedEdits.store` (4), `graphFile.unsavedEdits` (2).
- Old tests that pinned the old text, now updated: `tests/lib/enhancePrompt.test.ts` (a person-gate refusal now reads line 3) and `tests/components/PersonRequiredBanner.test.tsx` (GM's banner text, exact).
- Fixture changes:
  - `test_billing_choice.py`, `test_moodboard_brief_precedence.py` and `test_moodboard_reader_source.py` call the refusal internals with no request, which now reads as "no agent marker". They now set `main.current_request_headers` to an agent marker, so they keep pinning the agent's answer.
  - The new internal `SaveFileWriteError` message reads "Couldn't write the file." so the error-copy sweep (`errorCopy.round3e`) stays clean.

### Live check

Isolated backend on 8782 through `iso.sh` (temp HOME, every NEBULA_* root in a temp state dir, no keys, the person token over stdin) and Vite on 5782 with `VITE_NEBULA_BACKEND_PORT=8782`, checked through Vite's proxy first. 8000-8010 and 5173 were blocked with CDP `Network.setBlockedURLs` plus the dead proxy, and the canary 8799 was unreachable. **0 blocked attempts.** No page errors, no dialogs, nothing paid. **22 PASS, 0 FAIL** (`unsaved-edits-gm/live/gm-live.mjs`, `live/results.json`, `live/run.log`).

1. **Line 1.** A held copy with 1,000,001 values was refused 413. The download wrote it, and the line read GM's line 1 verbatim with the real filename. The file holds the edit.
2. **Line 2.** A save picker whose write throws `QuotaExceededError` gave the same heading with line 2 as the body, both buttons enabled and Download primary, still an alert. The partial file was aborted, nothing was downloaded in its place, and no recover was sent. A retry with a plain download then wrote the same edits and loaded the projects.
3. **Line 3 on Projects.** A stale person token made the recover of a Krea billing switch come back 403 `person_required`. Projects read "Couldn't recover the project." plus line 3, with Try again (not the held screen). Details was closed and holds the agents' billing text; once opened it shows that text. The banner read GM's line exactly. After the fresh link opened in the same tab, Try again saved the recovered copy.
4. **Line 3 on a node card** (the other place). A second tab with no token started a text node with an `approvalId` and got 403 `person_required`. The card read "Couldn't run the node." plus line 3, with Details closed holding "Only the person's canvas starts a run they approved…", and Details opened. The banner showed there too. No run started.
- Screenshots in `unsaved-edits-gm/live/shots/`:
  - `line1-too-large-1280.png` / `-1440.png`
  - `line2-not-written-1280.png` / `-1440.png`
  - `line3-details-closed-1280.png`, `line3-details-open-1280.png`
  - `banner-1280.png`
  - `node-card-person-required-1280.png`, `node-card-details-open-1280.png`
- Servers stopped by port (8782 and 5782 are free), and the state and downloads dirs deleted.

### Gates (focused; CI runs the whole suites)

- Backend, 74 files: every file that touches billing, spend, approvals, presets, moodboard reads, the graph routes, proposals, MCP and CLI surfaces, the error copy or the unsaved-edits refusals, plus the readers of MCP-SETUP (`iso.sh … pytest -q`). **3316 passed, 32 skipped**, 0 failed.
- Vitest `--maxWorkers=3`, 70 files (every file that touches errorCopy, the stores, ProjectHome, graphFile, ChatPanel, proposals, kreaConnection, cinemaMotion, enhancePrompt, personSession and the banner, plus the error-copy sweeps): **70 files, 1066 passed**, 0 failed.
- `npx tsc -b`: clean. `npm run -s lint`: clean.
- `npx vite build && node scripts/check-build-budget.mjs`: passed, **370,967 bytes raw** (111,292 gzip) against 512,000 (+2,568 bytes over the review build). `dist/` deleted afterwards.

## GM's lines, round 2 (2026-10-23)

GM - Design's reply, verbatim: "1. Yes, add app versions. Also, line 3 shouldn't depend on the notice being there, since it can be dismissed." Browser line 3: "This change needs your OK, and this tab isn't connected as you. Open the link Nebula printed when it started, then try again." App line 3: "This change needs your OK, and this window isn't connected as you. Quit Nebula and open it again, then try again." App banner: "This window isn't connected as you, so Settings, proposals and chats are locked. Quit Nebula and open it again." "The browser banner stays as I sent it." "2. No Details on one-line surfaces. The agents' text going to the console is right there." "3. Keep "Couldn't run the node." It's true, and the line under it says why." Items 2 and 3 needed no change.

What changed:
- `errorCopy.ts`: `PERSON_REQUIRED_COPY` is the new browser line 3. A new `PERSON_REQUIRED_APP_COPY` holds the app line 3. `personRequiredCopy(desktop = inDesktopShell())` picks one of them.
  - `copyForAnswer` uses it. That covers every `RequestFailedError`, `ExecutionStartRejectedError`, the Krea, proposal, Enhance prompt and cinema paths, and every answer read by hand.
  - `failureDetails` accepts either line, so Details keeps the agents' text in the app too.
- `ChatPanel.tsx`: the chat's person line (the one place that used the constant directly) now calls `personRequiredCopy()`.
- `personSession.ts`: in the app, `personRequiredMessage()`'s not-connected case is GM's app banner. That is the case where the shell gave a token and the backend refused it. The browser banner and the shell's own reasons (debug port, dev renderer, unconfirmed window) are unchanged. `PersonRequiredBanner.tsx` is untouched.
- Classification is still by `code` only. Nothing else changed: Details stays where the first lane put it, and one-line surfaces still have none. No backend change, no desktop change, and no MCP or CLI change: this is copy on person surfaces, and agents still get their own words (`detail`).

The desktop flag: `inDesktopShell()` in `personSession.ts`, which already existed. It is true when the preload bridge (`window.nebulaDesktop`, from `desktop/preload.cjs`) has an `apiBaseUrl`. It's the same check `personSession` uses to take the token from the shell instead of a link, and the one the Commons error copy already reads (`commonsSessionCopy(inDesktopShell())`). `errorCopy.ts` now imports it from `personSession.ts`. That makes no cycle: `personSession` imports only `devBackendPort`. Not used: `paperDesktop.isDesktopMode()` (it checks `shell === 'electron'`, for Paper links), a build constant, or the file: protocol.

The answer to GM's question is in "For GM" below. The code behind it:
- (a) `desktop/main.mjs` decides `person` once at launch (`decidePersonToken`). `sidecar.mjs` writes it to the backend's stdin right after the spawn. `person_session.initialize()` reads one line (5 s deadline). On any failure it leaves no session for the whole launch: `set` happens once, stdin is then closed, and there's no fallback token. A sidecar that exits mid-session is not restarted (`showDisconnectedState`), and a Dock reopen reuses the same sidecar. The renderer's `refreshPersonCredential()` asks the same shell again and gets the same token.
  - Tests that pin it: `backend/tests/test_person_session.py` (`test_stdin_failure_leaves_no_person_at_all`, `test_stdin_eof_or_timeout_fails_closed`, `test_stdin_mode_never_falls_back_to_a_generated_token`; 31 passed here) and `desktop/tests/sidecar.test.mjs` "a real backend reads the stdin token: only it unlocks a person-only route" (a wrong token gets 403, the shell's gets 200). Not run here: it imports `ws`, and this worktree has no `desktop/node_modules`, which can't be installed. `desktop/tests/person-token.test.mjs` ran: 7 passed, with a temp HOME and key variables unset.
- (b) In the app, `wantsPersonHeader` is true for every request. `apiFetch` awaits `personCredential()` (the shell lookup) before `fetch`, and `wsClient.sayHello` awaits `personTokenForSocket` before the hello. `desktopCredential()` sets `desktopReason` before its promise resolves. So no refusal can arrive before the reason is known. New guard test: `tests/lib/backend.test.ts` "sends nothing to its sidecar until a slow shell lookup lands, then sends the token". It passes on 01ad81d4 too, because it pins existing behaviour that the answer to GM relies on.

Surprise: in case (a) the window believes it holds the person's token: the shell gave one, so `holdsPersonCredential()` is true. Its camera then counts as the project's view, and that save is refused like every other person-only one. The live screenshot's header reads "Unsaved changes" after a zoom. That's consistent with the window being locked, and it's left alone for the desktop pass.

Tradeoff: in the app, line 3 is chosen by the flag alone, not by the shell's reason, as the spec asked. With a debug port open, line 3 says to quit and reopen while the banner names debug mode. Raised with GM in "For GM".

### Tests (written first; red on 01ad81d4)

- **21 failed, 70 passed** across 9 files (91 tests) before the build (`unsaved-edits-gm2/red-frontend.log`). Every failure was the copy: the old line 3 or the browser banner where the new line or app line was expected.
  - New, 8 tests: `tests/personRequiredLines.test.ts` +5 (4 red; the guard that the shell's own reasons and the browser banner stay passed), `tests/components/PersonRequiredBanner.test.tsx` +1 (red), `tests/personRequiredCards.test.tsx` +1 (red), `tests/ChatPanel.commons.test.tsx` +1 (red). Each sets the preload's bridge on `window` the way the shell does.
  - Updated to the new browser line 3 (red until the build), 14 tests: `personRequiredLines` (8), `personRequiredCards`, `ChatPanel.commons`, `canvasProposalsStore`, `enhancePrompt`, `graphStore.errorCopy`, `unsavedEdits.store` (1 each). `ProjectHome.unsavedEdits`'s fixture string was updated too. It passed either way, because that component renders the line it is handed.
- Green after the build: 91 passed.
- Plus the guard above in `tests/lib/backend.test.ts` (passes on both; 54 passed in that file).

### Live check

Builder ports, isolated: backend 8782 through `iso.sh` (temp HOME, every NEBULA_* root in a temp state dir, no keys, person token over stdin, outside network refused) and Vite 5782 with `VITE_NEBULA_BACKEND_PORT=8782`. The proxy was checked first (an empty project list). 8000-8010 and 5173 were blocked with CDP `Network.setBlockedURLs` plus the dead proxy, and the canary 8799 was unreachable. **0 blocked attempts.** No page errors, no dialogs, nothing paid, no Electron. **19 PASS, 0 FAIL** (`unsaved-edits-gm2/live/gm2-live.mjs`, `results.json`, `run.log`).
- **Browser tab without the link.** An approved run of a free text node was refused 403 `person_required`. The card read "Couldn't run the node." plus the new browser line 3, with Details closed and holding the agents' text. The banner read GM's browser banner exactly.
- **App mode.** No Electron. The bridge the preload would expose was defined before the page loaded (`evaluateOnNewDocument`), frozen, pointing at the isolated backend.
  - Case (a), a well-formed token this backend doesn't know: the banner came up on its own when the socket's hello was refused, and read GM's app banner. All 23 requests carried the shell's token. The approved run was refused 403 `person_required`, and the card read GM's app line 3 with Details. 8 s later the banner was still there, and after a reload it came back.
  - The same page with the token this backend knows (what a quit and reopen gives): no banner, and a person-only read (`/api/agent/spend`) answered as the person.
  - Case (b), the shell's answer slowed to 4 s: none of the 20 requests reached the backend before it landed, all of them carried the token, and no banner showed.
- Screenshots in `unsaved-edits-gm2/live/shots/`: `browser-line3-and-banner-1280.png` / `-1440.png`, `app-line3-and-banner-1280.png` / `-1440.png`, `app-banner-1280.png`.
- Servers stopped by port (8782 and 5782 free). The state dir was deleted.

### Gates (focused; CI runs the whole suites)

- Vitest `--maxWorkers=3`: every test file that touches personSession, the banner, errorCopy, ChatPanel, `nebulaDesktop` or `person_required`. **60 files, 853 passed**, 0 failed.
- Backend: no backend file changed. `tests/test_person_session.py` (cited above): **31 passed**.
- Desktop: `tests/person-token.test.mjs`: **7 passed**.
- `npx tsc -b`: clean. `npm run -s lint`: clean.
- `npx vite build && node scripts/check-build-budget.mjs`: passed, **372,629 bytes raw** (111,846 gzip) against 512,000. `dist/` deleted afterwards.

## For GM

The lines as built, verbatim:
- Heading: "Couldn't save your edits."
- Reason, too large (the copy's own size, node count or value count): "These edits are too large for Nebula to save. Download them so nothing is lost, or continue without them."
- Reason, any other refusal for good: the backend's reason as a full sentence, then "Download them so nothing is lost, or continue without them." For example "Project limit reached. Download them so nothing is lost, or continue without them." When the refusal gave no reason, just the second sentence.
- Buttons: "Download your edits" (primary, first), "Continue without them".
- Confirm: "Continue without your edits? They can't be recovered after this." Buttons "Continue without them" (red, first), "Cancel" (focused).
- After a download: "Your edits are saved as {filename}. Open it with “Load graph” under “Canvas actions” in a new project to bring them back." (approved by GM, 2026-10-23)
- After a download Load graph can't open (GM's line 1, until Q118 is settled): "Your edits are saved as {filename}. Keep it somewhere safe. It's too large for “Load graph” to open right now, so Nebula can't bring the edits back yet."
- A download that couldn't be written (GM's line 2), the body under the same heading, both buttons kept: "The download didn't save, so your edits are still only in this tab. Check that your disk has free space, then download them again, or continue without them."
- A person-only refusal (GM's line 3, round 2), under "Couldn't recover the project." and wherever else one shows. In a browser tab: "This change needs your OK, and this tab isn't connected as you. Open the link Nebula printed when it started, then try again." In the desktop app: "This change needs your OK, and this window isn't connected as you. Quit Nebula and open it again, then try again." The agents' text is behind Details where the surface has room for it; one-line surfaces have none (your answer, round 2).
- The banner. In a browser tab, as you sent it: "This tab isn't connected as you, so Settings, proposals and chats are locked. Open the link Nebula printed when it started, or restart Nebula with --open." In the desktop app, when its backend refuses the window's token: "This window isn't connected as you, so Settings, proposals and chats are locked. Quit Nebula and open it again." The app's own cases keep their lines (a debug port, the dev renderer, "Nebula couldn't confirm this window is yours, so Settings, proposals and chats are off. Quit Nebula and open it again." since round 3).
- Which one shows is decided by the app's existing desktop flag (the bridge its preload exposes), not by the words of the refusal.
- File name: "{project name} - unsaved edits.nebula".
- During an update stop, after a download, the tab doesn't reload by itself; the existing line "Nebula was updated while this tab was open. Reload the tab to use the update. Your saved work is kept." shows under the saved-as line (GM: right as it is).

Your question (round 2): does quitting and reopening the app fix both cases where its window isn't connected as you? Read from the code (desktop/main.mjs, sidecar.mjs, person-token.mjs, backend/services/person_session.py, frontend/src/lib/personSession.ts and backend.ts) and checked live:
- **The backend refuses the token the window was given.** The app makes one token per launch and hands it to its backend once, as the backend starts. If the backend fails to take it in (the hand-off is missing, garbled or late), the backend runs the whole launch with no token, so nothing counts as you, and it can't take one later.
  - Quit and reopen: **yes, this fixes it.** A new launch makes a new token and a new backend that reads it.
  - Does it fix itself? **No.** Reloading the window, or closing it and clicking the Dock icon, asks the same app for the same token, and the same backend refuses it again. Live: the banner was still there 8 s later and came back after a reload.
  - Anything faster? **No**, not today. Only a new backend helps, and the app has no "restart the backend" action. That would be a desktop-app change, and the desktop pass is deferred.
  - It should be rare. The app writes the token before the backend asks for it, so "late" can't really happen. A failure means that launch went wrong.
- **The backend answers before the window has its token.** This can't happen in today's code. In the app, every request and the canvas connection wait for the app's answer before anything is sent. The reason a lookup failed (a debug port, say) is known before that wait ends. So no refusal can arrive while the lookup is still going, and the banner never shows from it, not even as a flash. Live: with the app's answer slowed to 4 s, none of the 20 requests went out before it, and no banner showed. Nothing for you to rewrite here.
- Your app lines fit case (a) as written.

Still yours to decide:
- **Line 3 with a debug port open or the dev renderer.** In the app, line 3 always says "Quit Nebula and open it again". In those two cases the banner gives the real reason ("Debug mode: …", "Desktop dev mode: …"). Reopening normally, without the debug port, does fix the first. The second is a developer setup. Say if line 3 should differ there.
- **"Restart the app." vs "Quit Nebula and open it again."** Answered in round 3: they match now (see below).
- **Line 3 on a node card** reads under the card's "Couldn't run the node." heading, as you confirmed (round 2: "It's true, and the line under it says why.").

## CI's focus-ring sweep (2026-10-23)

The first CI run failed `tests/focusRingCss.test.ts`: four new `:focus:not(:focus-visible) { outline: none }` rules (the Details summaries on Projects and in chat, the saved line, the heading) cleared the outline without a token ring the sweep could pair. They were redundant: the browser draws its own ring on `:focus-visible` only, so a click or a programmatic focus after a click shows none anyway. Removed; the `:focus-visible` token rings stay. The same run's `DeferredSecondPass` failure (a ⌘K racing the palette chunk) didn't reproduce: it passes alone and in the focused run.

## The palette's ⌘K race (CI, 2026-10-23)

CI failed `DeferredSecondPass` twice on this branch ("a ⌘K that beats the chunk opens the palette once it lands": the second ⌘K left the palette open); it passed locally. The cause is in `CommandPalette.tsx`, not the test: `openPalette()` set `open`, but `openRef`, which the once-subscribed hotkey handler reads, only caught up in a later effect. A ⌘K landing between the palette's render and that effect read it as closed and opened it again. Now the handlers that open and close set the ref at once (the effect still keeps it in step). A new test fires the open and a ⌘K in one `act()`, before React commits: it failed on the old code and passes now. That file: 12 of 12.

## GM's lines, round 3 (2026-10-23)

GM, verbatim: "Line 3 points to the banner's reason in the two dev cases instead of repeating "Quit Nebula…": "This change needs your OK, and this window isn't connected as you. The notice below says why." … For a normal launch, keep "Quit Nebula and open it again, then try again."" and "Change the app's own line to end "Quit Nebula and open it again." "Restart the app" is vaguer, because the window can close while Nebula keeps running in the Dock."

- `personRequiredCopy(desktop, reason)` in errorCopy.ts: in the app, the shell's own reasons `debug-port` and `dev-renderer` (personSession's `personUnavailableReason()`) get `PERSON_REQUIRED_DEV_COPY`; every other app case keeps the app line 3; a browser tab keeps its line. Still picked only for a `person_required` code; Details keeps the agents' text.
- personSession's line for a window the shell couldn't confirm now ends "Quit Nebula and open it again.".
- Tests first in `tests/personRequiredLines.test.ts`: 3 failed on 11d2b0bf (the dev-case line, and the old ending in two places), then pass. The 10 related files: 146 of 146. `npx tsc -b` clean.

## GM's banners, round 4 (2026-10-23)

GM, after #180's copy check: "Person-required banners. These stay up, so a two-line one would sit over panel foot rows the whole time. Please fold these into #178, replacing my earlier banner lines" and "Line 3 stays as built. It still says what to do, and the banner no longer has to." Built verbatim in `personRequiredMessage`:
- Browser: "This tab isn't connected as you. Open the link Nebula printed when it started."
- App: "This window isn't connected as you. Quit Nebula and open it again."
- Debug: "Debug mode: a debugging port is open, so Settings, proposals and chats are off."
- Dev renderer: "Dev mode: the Vite renderer can't use your token. Set NEBULA_DESKTOP_DEV_PERSON=1 to allow it." (developer-only; GM: may wrap)

The shell's line for a window it couldn't confirm, which GM's first list missed, is GM's too (asked and answered): "Nebula couldn't confirm this window is yours. Quit Nebula and open it again." (2 tests red first, then 19 of 19.)

Tests first: `personRequiredLines` and `PersonRequiredBanner` pinned the old banners; with GM's lines expected, 4 failed in `personRequiredLines` (then the component test's 2 once its expectations moved too), then all pass. The 6 related files: 52 of 52.

## Addendum: GM's line 1 goes with Q118 (2026-10-23)

Q118 (Justin: "Let Load graph open bigger .nebula files (up to the 512 MiB it already allows for a bundle) as a new project.") made Load graph read a plain .nebula up to the bundle ceiling, so a held copy over 16 MiB opens again: the canvas pauses saving it until it is trimmed (docs/notes/2026-10-23-fix-over-limit-projects.md). GM: "#178's TOO-LARGE LINE: yes, it goes. The Load graph line covers every case now." So:
- `editsSavedTooLargeLine` ("… It's too large for “Load graph” to open right now …") is removed from `unsavedEditsCopy.ts`, and ProjectHome always shows `editsSavedLine` after a download.
- `editsFileReopens` no longer fails on 16 MiB alone; it fails past the bundle ceiling (`GRAPH_BUNDLE_MAX_IMPORT_BYTES`) or on the shape walk's limits (10,000 nodes, 50,000 wires, depth 64, 1,000,000 values), as before. `SavedEditsFile.reopens` stays for those.
- Tests changed with it: ProjectHome.unsavedEdits ("every download reads the Load graph line, even one past a reader limit"; "GM's line 1 is gone (Q118)") and graphFile.unsavedEdits ("reopens within every limit, and not past one": a 16 MiB value now reopens). They failed on the old code (3 red), then pass.
- A recovered copy that is itself over the save limit is now held on this screen without being sent (recoverPendingWork measures it first); one the backend still refuses for its size (`limit: "size"`) gets the same "These edits are too large for Nebula to save." reason, as before.
