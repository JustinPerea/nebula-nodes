# 2026-10-22 — Failed requests say written copy, not "Failed to fetch"

Branch `fix/error-copy`, from main `4b7ed7dd` (after #165). Frontend only: no backend file changed, no package installed, no paid provider call.

## What changed and why

- **The brief.** GM - Design (visual design and copy) reviewed #165's screenshots. With a dropped connection, the Commons leave popover's second line and the red banner above Blind labeling both showed the browser's "Failed to fetch". GM: "That is a TypeError message, not copy. ... Never show raw error.message strings in UI. Check the other Commons save paths and the board save too, since the same raw string probably leaks there." GM's copy, used verbatim:
  - Lost connection (no answer at all): "Couldn't reach Nebula. Check your connection and try again."
  - 408, 429 or any 5xx: "Nebula didn't respond. Try again."
  - The popover heading stays "Couldn't save your labels." and Save and leave stays the retry. The backend's own 4xx `detail` strings are written copy and stay as they are.
  - **GM's fallback lines**, sent after the first build, verbatim:
    - "A 4xx where the backend sends no detail: "That didn't work. Try again, or reload if it keeps happening.""
    - "401/403 with no detail: "You don't have access to this anymore. Reload to sign in again.""
    - "413 with no detail: "That's too large to save.""
    - "Keep the action's own heading above these lines where one exists (e.g. "Couldn't save your labels."). The lines give the reason; the heading names what failed. List anything the sweep can't cover with one structural change, and I'll write those lines."
- **One mapping module, `frontend/src/lib/errorCopy.ts`.** It holds GM's lines (`CONNECTION_LOST_COPY`, `NO_RESPONSE_COPY`, `REFUSED_FALLBACK_COPY`, `ACCESS_LOST_COPY`, `TOO_LARGE_COPY`), `failureKind(status)` (`connection` for status 0, `no-response` for 408/429/5xx, `refused` for any other 4xx), `canTryAgain(status)`, `copyForStatus(status, detail)` (no answer, 408/429/5xx, the backend's reason, else GM's fallback line for the status), `copyForError(error, signal)` (a thrown error that isn't an answer: the connection line, else GM's general line), `isConnectionFailure(error, signal)`, `readDetail(response)`, and two error classes: `ConnectionLostError` (a TypeError, status 0, message = the connection line, `cause` = the browser's own error) and `RequestFailedError` (message = copy, plus `status` and the raw `detail`).
- **The words are made where requests are made, not per screen.**
  - `apiFetch` (`lib/backend.ts`) turns a fetch that got no answer into a `ConnectionLostError`. That covers every `apiFetch` caller: each screen that showed `error.message` after a dropped connection now shows the connection line. A few paths call `fetch` directly on an asset URL and skip `apiFetch`; they are listed under open items (the selection toolbar's Download is now fixed, see Review). The caller's own abort comes back exactly as fetch threw it. An AbortError the caller didn't ask for counts as a lost connection.
  - Commons: `commonsApi`'s `call()` (every Commons screen, including the blob and image fetches) throws `CommonsRequestError` with copy as its message. A lost connection is status 0 (`lostConnection`, with the `ConnectionLostError` as cause); 408/429/5xx say the no-response line; another 4xx says the backend's `detail`, or GM's line for the status when it sent none (403, 413, any other). `CommonsRequestError` keeps the raw `detail` for debugging and gains a `kind` getter. A body that drops while it is arriving (`response.json()`/`blob()` rejecting) is a lost connection too.
  - `saveFailure` (`components/commons/commonsLeave.ts`) uses the shared `canTryAgain`, so the retry rule is unchanged: lost connection, 408, 429, 5xx retry; other 4xx don't. Any other error that reaches it (one that didn't come through the API) says the connection line or GM's general line, never its own message.
  - Board: `lib/api.ts` `moodboardError` (create, save PUT, checked edits, analyze, delete, move) says the no-response line for 408/429/5xx and never a status code. A new `loadError` does the same for the board reads (`fetchMoodboards`, `fetchMoodboard`, `lookupStoredAsset`). `lib/trash.ts` `failure` (the board's delete and undo-delete, and every other Recently deleted call) does the same. A 4xx with no reason says GM's line for its status on all of these.
- **Agent support.** Nothing agents call changes: this is frontend copy only. No MCP tool, `nebula` CLI command, backend route or doc (docs/MCP-SETUP.md, skills/nebula/SKILL.md) is affected.

## Decisions not in the spec

- **The structural `apiFetch` change was safe, so I did it.** I checked that no caller depends on the TypeError or its message. That check missed one: the chat panel recognised a downed backend by looking for "failed to fetch" / "network" in the message (see Review). Now no source file reads "Failed to fetch" to decide anything. Deferred-chunk retry handles dynamic imports, not apiFetch. The offline check in `lazyWithPreload` reads `navigator.onLine`, not the error. The graph store's "uncertain create" paths treat any rejection as an unknown result. The new error is still a TypeError, its `name` is `ConnectionLostError`, and callers that check `err.name === 'AbortError'` still get their own abort unchanged.
- **Discovery failures are not converted.** `getBackendBaseUrl`'s "Nebula backend not found on port …" is thrown before any fetch, only in a plain browser tab with port discovery (not the desktop app, not a person link). It names a developer misconfiguration, so I left it and listed it below.
- **Commons 4xx with no readable reason.** Before, this showed "Commons request failed (400)", or FastAPI's list of field errors as raw JSON (`[{"loc":…}]`). The first build said a placeholder of mine ("Nebula couldn't do that."); it now says GM's fallback line for the status.
- **A 4xx with no reason has one line per status, not one per call site.** The first build gave each call site its own fallback ("Save failed.", "Failed to load.", "Couldn't download one of the selected outputs.", "Restore failed."). GM's lines replaced them all, so `copyForStatus` lost its `fallback` argument: a new call site can't invent its own words for the case GM has written.
- **On the board, GM's lines stand alone; backend reasons keep "Save failed:".** The board's notice is one line with no heading of its own, so there is nothing to keep above GM's lines there: "That's too large to save." reads alone, as the connection and no-response lines already did. A backend reason still reads "Save failed: <reason>" (GM approved backend reasons), and FastAPI field lists stay formatted as before ("Save failed: images.0.url: field required"), because the Studio shows them on purpose so the person can fix the field.
- **`saveFailure` no longer shows a stray error's own message.** A failure that isn't a Commons request's (a bug, a body that isn't JSON) used to show its `message` in the popover. It now says GM's general line, and stays retryable. The two tests that faked a conflict with a plain `Error` now throw `CommonsRequestError(…, 409)`, which is what `commonsApi` throws.
- **Character Studio is not changed here**, though it shares `saveFailure` in `lib/api.ts`. The brief scoped the fix to Commons and the board. Its lost connection is fixed by `apiFetch`, but its 5xx still says "Update character failed: 503". Listed below.

## Tradeoffs

- **The raw error is kept, not logged.** It stays as `cause` / `detail` / `status` on the thrown error. I didn't add a `console.warn` in `apiFetch`, because polling paths (status, health) would flood the console while offline.
- **`errorCopy.ts` is in the startup entry**, because `backend.ts` is. It is small: the entry is 356,233 bytes raw, under the 512,000-byte budget.

## Surprises

- **Fetch interception in the live check worked when narrowed.** The memory note says CDP `Fetch.enable` broke cross-origin GETs (PR #87). With patterns limited to the label PUT and the board's own URL, only those requests paused. Preflights and GETs were continued, and nothing else was touched (log below). A fulfilled 503 needs `Access-Control-Allow-Origin` or the page reads it as a lost connection.
- **Puppeteer clip screenshots close the popover.** A clipped screenshot with the default `captureBeyondViewport: true` resizes the viewport, and the anchored popover closes on resize. `captureBeyondViewport: false` fixes it.
- **The Commons tab sometimes needs the hash set twice on a fresh page**, while the capability is still loading. The live script retries.

## Tests

Written first and run on the current code, where they failed (`red.log`): 5 files, 30 failed and 5 passed. The 5 that passed pin behaviour that must not change: a 409's backend words in the banner, the popover and the API, the board's 4xx reason, and the caller's own abort.
- `tests/lib/errorCopy.test.ts`: GM's suggested mapping table, error kind -> line. It failed at import (no module).
- `tests/lib/backend.connection.test.ts`: `apiFetch` with no answer says the connection line, is a `ConnectionLostError` and still a TypeError, and keeps fetch's error as its cause. The caller's own abort comes back unchanged; an abort the caller didn't ask for is a lost connection. It failed at import.
- `tests/errorCopy.commons.test.tsx`: runs the real Commons API and apiFetch; only the browser's fetch is stubbed.
  - The red banner after a lost connection, 503, 502, 429 and 408. On main it read "Failed to fetch" and "Commons request failed (503)".
  - The leave popover's reason line for the same failures, with Save and leave still offered. On main it read "Failed to fetch" and "Commons request failed (5xx/4xx)".
  - A 409 keeps the backend's words, with no Save and leave.
- `tests/commonsApi.errorCopy.test.ts`: status 0 and the cause chain for a lost connection; 408/429/5xx keep their status and raw `detail`; a 4xx with no reason or a FastAPI list says GM's fallback line (403 and 413 their own); the image and blob fetches say the same lines; the caller's abort of an image passes through.
- `src/components/moodboard-studio/MoodboardStudioErrorCopy.test.tsx`: the real `lib/api.ts` and apiFetch.
  - An image edit (`/edits`) and a board field (`PUT`) after a lost connection, 503, 500 and 429. On main: "Failed to fetch", "Save failed: 503".
  - A 4xx keeps "Save failed: <reason>"; a bare 400, 403 or 413 says GM's line for it (main: "Save failed: 400").
- Updated old pins of the raw text:
  - `tests/lib/backend.test.ts` (3 asserts: "connection reset…" / "Failed to fetch" are now the cause of a `ConnectionLostError`).
  - `tests/commonsEvaluation.test.tsx` (a raw `TypeError('Failed to fetch')` reaching `saveFailure` now gives the connection line).
- After the build, the new files: 73 passed.

## Live check

- Isolated stack from this worktree. Backend on 8791 through `iso.sh` (temp HOME, every NEBULA_* root in scratch, no keys). Vite on 5791 with `VITE_NEBULA_BACKEND_PORT=8791`. 8000-8010 and 5173 blocked by `Network.setBlockedURLs` plus the dead-proxy layer; canary 8799 unreachable.
- Seeded a Blind labeling batch from 72 generated local images (15 items, the #163/#165 lanes' `gen.py`), and a global board with two uploaded images.
- CDP Fetch interception failed the label PUT and the board's PUT as `InternetDisconnected`, then as a fulfilled 503.
- Result: 27 PASS, 0 FAIL, 0 page errors, **0 blocked requests** to 8000-8010/5173.
- What I saw at 1440x900 and 1280x800:
  - Commons banner: the connection line, then the no-response line.
  - Popover: heading "Couldn't save your labels.", reason the connection line, then the no-response line, with Save and leave first both times. With the connection back, Save and leave saved and left.
  - Board Studio notice: the connection line, then the no-response line, with Retry offered. Retry with the connection back saved (the backend had the new name).
- **Wrapping, for GM:**
  - The connection line wraps to two lines in the popover at both widths: "Couldn't reach Nebula. Check your connection and / try again." The popover's text column is 294 px.
  - The no-response line fits on one line.
  - Neither line wraps in the banner or the board notice.
  - Shots (sent to GM; kept in the session scratchpad only):
    - `commons-popover-network-1440-zoom.png` and `commons-popover-network-1280-zoom.png` (the wrap)
    - `commons-popover-503-*-zoom.png`, `commons-banner-network-*.png`, `board-network-*.png`, `board-503-*.png`

## Open items

(Answered: GM answered every copy item below in round 2, and round 2 converted every status-code string listed under "Follow-up for GM". See "Round 2: GM's answers" at the end.)

- **For GM (copy):**
  - The connection line wraps in the leave popover at both widths. Keep it as is, shorten it, or widen the popover?
  - The board's FastAPI field-list reasons ("Save failed: images.0.url: field required") are kept as before.
  - The Commons 401 message "no UI session: use a fresh Commons dev link from the backend terminal" (`lib/commonsApi.ts` SESSION_MESSAGE) is developer copy. It is thrown in the browser, not sent by the backend, after a retry with a fresh token also got 401. GM's 401 line says "Reload to sign in again", but in a plain browser tab a reload doesn't bring the session back (it takes a fresh link from the backend terminal); in the desktop app the retry already fetched the shell's token. So it needs its own line.
  - Some backend Commons 4xx details are `str(exc)` or templated (`backend/routes/commons.py`, e.g. `bad filters: {exc}`, `unknown setting {key}`), so not all of them are written copy.
  - The Studio shows MoodboardVersionConflict's "The board changed since it was read (it is at version N)." after three conflicts in a row (`lib/moodboardEdits.ts`).
  - Commons upload per-file errors come from the backend (`components/commons/CommonsView.tsx:419`, `${filename}: ${error}`).
- **Follow-up for GM: the rest of the app still builds status-code strings from answered requests.** A dropped connection is now fixed for every `apiFetch` caller, but a 5xx or a 4xx with no detail still shows these (file:line, what shows on a 503 or a bare 4xx). Each can move to `copyForStatus` / `RequestFailedError` the same way `trash.ts` did. GM's fallback lines now cover the bare 4xx; what each of these needs from GM is whether its action name stays as a heading ("Couldn't accept", "Upload failed") above the line:
  - **Character Studio** (`lib/api.ts`):
    - 667 "Fetch characters failed: 503"
    - 675 "Fetch character failed: 503"
    - 685 "Create character failed: 503"
    - 728 "Update character failed: 503" (the Character save; the Studio shows it like the board's)
    - 736 "Delete character failed: 503"
    - `components/character-studio/CharacterDefinitionPanel.tsx:66` "Upload failed: 503"
  - **Runs** (`lib/api.ts`), shown in run errors and alerts:
    - 82 "Cancel failed: 503 Service Unavailable"
    - 153 "Execute failed: …"
    - 182 "Execute node failed: …"
    - 208 "Generate shot failed: …"
    - 228 "Promote shot variation failed: …"
    - `lib/renderJobs.ts:24` "<action> failed: 503"
    - `store/graphStore.ts:4774` "Shot did not start (<status>)."
  - **Settings and connections** (`lib/api.ts`):
    - 235 "Get settings failed: 503", 245 "Update settings failed: …", 299 "<what> failed: …"
    - 342 "Remove API key failed: …", 359 "Credential update failed: …"
    - 374 "Fetch OpenRouter models failed: …", 391 "Fetch Nous models failed: …"
    - 575 and 581 Claude and Codex status, 591 and 597 Codex ChatGPT login (ChatPanel shows these as a tooltip on its status line, and 625/653 for the Codex login; it no longer reads their words to decide "backend offline", see Review)
    - 620 "Fetch Quiver models failed: …", 646 "Fetch CLI graph failed: …", 652 "Fetch Replicate schema failed: …"
  - **Canvas** (`store/graphStore.ts`), in alerts and node errors:
    - 1426, 3657, 3978, 5050, 5429, 5481 "HTTP 503"
    - 1707 "Backend rejected deletion of <id> (HTTP 503)."
    - 2360 "Backend rejected graph export (HTTP 503)."
    - 2382 "Backend rejected graph clear (HTTP 503)."
    - 2397 "<fallback> (HTTP 503)."
    - Also: `lib/graphFile.ts:1083` "Asset restore failed (HTTP 503)", `components/GraphFileActions.tsx:73` "Import failed: 503" (alert), `lib/canvasView.ts:54` and `lib/canvasSelection.ts:26` (sync; not rendered as far as I saw).
  - **Notes and Updates:**
    - `lib/canvasPins.ts:30, 40, 46` "Couldn't load notes (503)" and similar
    - `lib/agentNotes.ts:192, 207, 216` "Couldn't load updates (503)" and similar (shown by `components/agent-notes/AgentNotesCorner.tsx:604`)
  - **Proposals:**
    - `lib/assetProposals.ts:92, 103` "Couldn't accept (503)", "Couldn't list proposals (503)"
    - `lib/canvasProposals.ts:67, 89` "Couldn't accept (503)", "Couldn't reject (503)"
  - **Projects:** `lib/projects.ts:82` "Project request failed (503)."
  - **Creator Studio:**
    - `lib/createFiles.ts:12, 25` "Reveal failed: 503", "Export failed: 503"
    - `lib/createPresets.ts:45, 62, 77` "Fetch presets failed: 503"…
    - `lib/enhancePrompt.ts:27` "Enhance failed (503)" (shown by `CreateComposer.tsx:74`)
    - `lib/createTranscode.ts:19` "Transcode failed (503)"
    - `lib/uploadReference.ts:22` "Upload failed (503). Please try again."
  - **Chat:** `components/panels/ChatPanel.tsx:843` "Upload failed (503)".
  - **Stores:** `store/moodboardAdapterStore.ts:34` "Moodboard adapters unavailable: 503", `store/pricingStore.ts:31` "Pricing unavailable: 503".
  - **Direct `fetch` (not apiFetch), still raw after a dropped connection:** `components/nodes/MeshPreview.tsx:169` shows the browser's TypeError message (line 190), and on a bad answer "The mesh server returned HTTP 503.". (`lib/worldSplat.ts` and `lib/worldDownload.ts` already say "could not be reached", but on an answer they say "…returned HTTP 503.") The full list of direct `fetch` calls in `frontend/src`: those three, `lib/canvasSelection.ts` (fixed, see Review), `video-editor/components/LottieRenderer.tsx:35` (fails silently, nothing shown) and `lib/graphFile.ts:583` (console only).
  - **Selection toolbar ids:** the Download button's size-limit errors still name internal ids ("Output n1:image exceeds the safe ZIP size limit. Download it separately.", `lib/canvasSelection.ts`). Not a network failure, so left as is.
  - **Discovery:** `lib/backend.ts:207-208` "Nebula backend not found on localhost ports …" (plain browser tab only).
  - **4xx `detail` that may be raw on 5xx:** paths using `detail || \`…\`` show any 5xx body's `detail` (for example "Internal Server Error") as is. The fix above sends 5xx to GM's line on the Commons and board paths only.

## Review

- **Two confirmed findings, both fixed, tests first.**
  - **Chat panel lost its "backend offline" hint.** `apiFetch`'s new `ConnectionLostError` carries GM's line as its message, and the chat panel decided "backend offline" by looking for "failed to fetch" / "network" in the message. With no answer it showed "Claude status unavailable" and the `claude auth login` (or ChatGPT login) advice instead of "Start Nebula backend". Fix: `components/panels/ChatPanel.tsx` now records whether the backend is offline from the error itself when the status check fails (`ConnectionLostError`, any TypeError, or status 0), and keeps the old message checks only for a dev proxy answering 50x. The words it shows are unchanged.
  - **Selection toolbar Download skipped the mapping.** `lib/canvasSelection.ts` `downloadSelectedOutputs` fetches asset URLs directly, so a dropped connection showed "Failed to fetch" as the Download button's tooltip, and a bad answer showed "Could not download n1:image". Fix: it wraps the fetch the way `apiFetch` does (`ConnectionLostError`, cause kept), and a bad answer throws `RequestFailedError` with `copyForStatus` (408/429/5xx -> GM's line, other 4xx -> GM's fallback line for the status, raw ids kept in `detail`).
- **Tests that failed first:** `tests/ChatPanel.offline.test.tsx` (2 tests, Claude and Codex: the hint read "Connect Claude…" / "Connect ChatGPT Account…") and 5 new tests in `tests/lib/canvasSelection.test.ts` (no answer, 503, 429, 404, and the cause chain: "Failed to fetch", "Could not download n1:image", not a `ConnectionLostError`). All pass after the fix.
- **Sweep for the same class of bug:** no other frontend file reads an error's words to tell a lost connection from anything else; the direct-`fetch` list above is now complete.
- **Live check (review):** backend 8791 through `iso.sh`, Vite 5791 with `VITE_NEBULA_BACKEND_PORT=8791`, 8000-8010 and 5173 blocked (CDP plus the dead proxy), canary 8799 unreachable. Narrow CDP Fetch interception failed only the Claude/Codex status GETs and fetch-type GETs of one uploaded image (an `image-input` node restored with that image as its output; nothing paid). At 1440x900 and 1280x800: with the status check failing as a lost connection and as a 503, the chat panel showed "Start Nebula backend" / "Backend offline" with the devserver command, for Claude and for Codex, and no login commands. The Download button's tooltip read GM's connection line, GM's no-response line, and (then) a 404 line of mine, since replaced by GM's fallback. 18 PASS, 0 FAIL, 0 page errors, **0 blocked requests**. Shots stayed in the session scratchpad.


## GM's fallback lines (after the build)

- GM sent the three fallback lines while the build ran. They replace every call-site fallback; `copyForStatus(status, detail)` picks the line by status (`refusedCopy`).
- Tests first: the mapping table in `tests/lib/errorCopy.test.ts` (GM's lines verbatim; 400/404/409/422 with no reason, 401/403, 413), a bare 403 and 413 at the Commons boundary and in `saveFailure`, a stray non-request error in `saveFailure`, the board's bare 400/403/413, and the Download's 404/403. Against the first build's table: 24 failed, 57 passed. After: the 35 related files pass (495 tests).

## Round 2: GM's answers

GM's call on the round-1 open items: "The ~60 places: yes, the action stays as a heading. Pattern: 'Couldn't {verb} {object}.' then the reason line." Two-line surfaces put the heading on line 1 and the reason on line 2; one-line surfaces (alerts, toasts, status text) say "Couldn't {verb} {object}. {reason}" in one string. "Never 'failed:', '(HTTP 503)' or status codes in the UI. Keep them in the console." GM's follow-up: "the person/agent split is right. People get the written line and agents keep the specific detail. Keep it that way." and "A FastAPI field list gets the fallback line."

### What changed and why

- **Structure (`lib/errorCopy.ts`).** A request's error now carries `heading`, `reason` and `kind` (connection / no-response / refused); its `message` is the one-line form, so every surface that already rendered `err.message` got GM's one-line pattern with no change at the display. `RequestFailedError(heading, status, {detail, reason})`, `ConnectionLostError(cause, {heading, reason})` (still a TypeError), `requestError(heading, response)` reads the detail and logs it, `failureCopy(error, {heading, short})` gives the two parts for a two-line surface, `failureMessage` the one-line form, `shortReason` / `shortLine` the WRAP rule. `components/failure/FailureLines.tsx` renders heading and reason (`.failure-lines`, the reason on its own line, `text-wrap: pretty`).
- **One way to call (`lib/apiRequest.ts`).** `apiRequest(heading, path, init, {allow, as})` is apiFetch that names its action: no answer -> `ConnectionLostError` under the heading; an answered failure -> `RequestFailedError` (GM's line for the status, or the backend's written reason), statuses in `allow` come back for the caller. It lives in its own module, not `backend.ts`, so a test that mocks `apiFetch` mocks it too. Every request in `lib/api.ts`, `projects.ts`, `trash.ts`, `canvasPins.ts`, `agentNotes.ts`, both proposal clients, the Creator Studio clients, `renderJobs.ts`, `uploadReference.ts`, `editor/api.ts`, the graph import and the canvas clear go through it.
- **The console, not the UI (GM).** Answered failures are `console.warn('[nebula] <heading> HTTP <status>', detail)` where they are made, once per call site until it works again (`warnFailure` / `requestSucceeded`), so a poll against a backend that is down doesn't warn every tick. A lost connection isn't logged.
- **WRAP rule.** Surfaces with a retry button beside the line take the short reason ("Couldn't reach Nebula. Check your connection." / "Nebula didn't respond."): the Commons leave popover (Save and leave), the board Studio notice and its Retry, the board and Character "Retry loading" blocks, the Character save notice, Project home ("Try again"), Settings ("Try again"), the chat model picker ("Retry model discovery"), Cinema reference uploads (Retry, only while the upload can retry), Create reference chips (Retry / Attach again). GM's 4xx fallback ("That didn't work. Try again, or reload if it keeps happening.") keeps its "Try again" on these surfaces, as asked.
- **text-wrap: pretty** on the leave popover reason, `.commons-notice` (the Commons banner and upload list), the board and Character notices, and `.failure-lines`. The Slava CSS scope guard accepts it (non-visual).
- **Board.** "Couldn't save the board. <reason>" replaces "Save failed: <reason>"; load, create, analyze, keep the brief, delete, move, undo/redo and image upload have headings. A FastAPI field list is not a reason: GM's fallback line for the status, the list kept in `detail` and the console (GM confirmed). After three conflicts in a row: "Couldn't save the board. This board changed in another window. Reload to get the latest version." (no version number); the Character says the same for a character.
- **Commons sign-in loss.** Plain tab: "Your session expired. Open a fresh Commons link from the backend terminal." Desktop app: it still refetches the shell's token silently and, if a 401 still comes back, says GM's access line. Copy only; the token logic is unchanged. The chat's Commons authority uses the same line.
- **Backend person/agent split (`backend/routes/commons.py`, `backend/commons/person_copy.py`).** `refuse(actor, status, specific, person, route)`: an agent (`X-Nebula-Client`) gets the specific text it got before; the person gets written copy and the specific text goes to the log (INFO, logger `routes.commons`). Applied to search filters, intake by URL, linked folders, corrections, regions, comments, settings, Blind labeling prepare and Agent review. Upload results gain a machine `reason` per refused file (`too_large`, `unsupported_type`, `unreadable`, `unknown_collection`); `error` stays (additive), so MCP and CLI output is unchanged. Left raw on purpose: the actor 401 (the UI never renders it; `commonsApi` maps any 401), and the agent-only routes `/add`, `/add/upload` (PathNotAllowed 403, IntakeError 422) and `/borrow` (agents keep the detail).
- **Commons upload per file.** "Couldn't upload {filename}." over the backend's line for the file (`person`, from `backend/commons/person_copy.py` INTAKE; a result with no `person` says GM's fallback), never the backend's raw `error`. The list is its own state now: on 1fc3d846 the refresh after an upload cleared the error at once (the search that worked said `setError(null)`), so these never stayed up.
- **ZIP.** "{name} is too large for the ZIP. Download it on its own." with the node's canvas name, or its type when it has none ("This image…"); never an id. Over the selection total: "Those outputs are too large for one ZIP. Download fewer at a time." (GM's follow-up).
- **App-wide sweep.** Every status-code string in the round-1 list is converted (re-grepped for `failed: ${`, `(HTTP ${`, `HTTP ${`, `statusText`, `Failed to`, `failed (`). GM's verbatim headings are used where GM gave them; the rest follow the pattern and are listed below. The backend-not-found line in a plain tab is GM's "Nebula's backend isn't running. Start it, then reload." (the ports tried stay in `detail` and are logged once).
- **Agent support (J).** No new tool: this changes copy, not capability. MCP (`backend/mcp_server.py`) and the CLI get the same detail as before (tested: search filters and an empty comment as an agent); the upload `reason` field is additive. `docs/MCP-SETUP.md` and `skills/nebula/SKILL.md` are unchanged.

### Decisions not in GM's message

- "Couldn't load your API keys." (GM's example) is the heading for the settings read (`getSettings`), which the Settings panel opens on (Providers, the API keys). The Settings save is "Couldn't save your settings.".
- A run the backend answered with a start status other than "started" (not an HTTP status: "busy", say) says "Couldn't start the run." / "Couldn't run the node." / "Couldn't start the shot." with GM's fallback line; the status goes to the console. On 1fc3d846: "Execution did not start (busy)." / "Shot did not start (busy).".
- The canvas: a refused node create says "Couldn't add {node name}. <reason>" (was "Nebula did not add …"); a refused delete "Couldn't delete the node." / "Couldn't delete N nodes." with each reason once (was "Nebula kept the node because its backend deletion was not confirmed. Backend rejected deletion of n1 (HTTP 409).").
- A 5xx on node create now says GM's no-response line even when its body had words ("Paid-start safety journal unavailable" went to the console). Same rule as everywhere: 408, 429 and 5xx say GM's line whatever the body said.
- The chat's Stop: "Couldn't stop the reply." then a written reason; the backend's text goes to the console (was "Warning: Cancellation failed: <raw>").
- The chat image chip keeps its two short chip lines ("Image > 20MB", "Not an image"); anything else is the backend's written reason or GM's line (was the raw response body or "Upload failed (503)").
- Errors that are not a request's (a thrown Error with its own words) never show their message where a request error was expected: `failureCopy` gives GM's general line under the screen's heading. Where a store keeps one-line strings (projects, Cinema and Create uploads), the WRAP rule applies to the string (`shortLine`).
- Console-only status strings were left as they are (they never reach the person): `graphStore.ts` scene sync, rename, model change, cluster persist and the frontend-only node pushes; `canvasView.ts`; `BackendConnectionStatus.tsx`; the pricing and moodboard-adapter stores (they swallow the error).

### Tests (written first; each failed on the old code)

Red logs are in the session scratchpad (`error-copy-2/red-*.log`).

- `tests/lib/errorCopy.test.ts` round-2 table (parts, kinds, one-line form, short reasons, dedupe, `shortLine`): 20 failed / 100 passed, then 2 more for `shortLine`.
- `tests/lib/backend.connection.test.ts`, `tests/lib/backend.test.ts`: `apiRequest`, backend-not-found line.
- Commons (5 files incl. the new `tests/errorCopy.round2.commons.test.tsx`): 25 failed / 18 passed (session copy, short popover lines, per-file uploads that the refresh wiped).
- Board (`MoodboardStudioErrorCopy.test.tsx`): 15/15 failed. Character (new `CharacterStudioErrorCopy.test.tsx`, `CharacterDefinitionPanel.test.tsx`): 3 + 2 failed ("Update character failed: 503", "Upload failed — retry.").
- ZIP (`tests/lib/canvasSelection.test.ts`): 11 failed / 5 passed.
- App-wide sweep (new `tests/lib/errorCopy.sweep.test.ts`, 55 calls x 503 / no answer / refused with and without a reason, the world preview and download, the chat chip): 158 failed / 9 passed, e.g. "Get settings failed: 503", "Couldn't list proposals (503)", "Internal Server Error", "The spatial preview server returned HTTP 503.".
- Canvas store (new `tests/store/graphStore.errorCopy.test.ts`): 6/6 failed. Graph file restore (`tests/graphFile.test.ts`): 3 failed. Toolbar clear: 2 failed. Mesh preview: 2 failed. Settings, Project home, model picker, Cinema chips: 9 failed. Chat Stop: 2 failed.
- Backend (new `backend/tests/test_commons_person_copy.py`, both actors): 9 failed / 1 passed.
- Existing tests that pinned the old strings were updated to the new copy (e.g. `api.execution`, `api.settings`, `createPresets`, `enhancePrompt`, `assetSaveFailure`, `moodboardEdits`, `cinemaUploads`, `createUploads`, `CreateView.draft`, `AssetsPanel`, `AssetStudioDrafts`, `GraphFileActions`, `graphStore`, `WorldPreview`).

### Live check

Isolated backend on 8795 through `iso.sh` (temp HOME, every NEBULA_* root in the scratchpad, no keys), Vite on 5795 with `VITE_NEBULA_BACKEND_PORT=8795`; `/api/health` through Vite reached it. 8000-8010 and 5173 blocked (CDP `Network.setBlockedURLs` plus the dead proxy), canary 8799 unreachable. Narrow CDP Fetch interception failed only the request each check names. At 1440x900 and 1280x800:

- Project home, projects list 503: "Couldn't load your projects. Nebula didn't respond." beside Try again; Try again then listed them.
- Settings, settings read 503: "Couldn't load your API keys." over "Nebula didn't respond." beside Try again.
- Canvas clear 503: alert "Couldn't clear the canvas. Nebula didn't respond. Try again."
- Commons upload (real backend, three files): "Couldn't upload notes.txt." over "Nebula can't read that file type. Use JPG, PNG, WebP, GIF, HEIC, MP4 or MOV.", "Couldn't upload broken.png." over "That file couldn't be read. It may be damaged.", "Added 1 of 3."; no raw backend text.
- Commons sign-in lost in a plain tab (search answering 401): "Your session expired. Open a fresh Commons link from the backend terminal."
- Blind labeling: the banner "Couldn't save your labels. Couldn't reach Nebula. Check your connection and try again." (one line) and, on a 503, "… Nebula didn't respond. Try again."; the leave popover "Couldn't save your labels." over the short lines, one line each at both widths, Save and leave still offered, then it saved and left.
- Board: "Couldn't save the board." over the short connection line, then "Nebula didn't respond.", Retry offered, then Retry saved (the backend had the new name).
- No status code on screen, no page errors, **0 blocked requests**. 40 PASS, 0 FAIL. Screenshots stayed in the session scratchpad.

### Open items

- **CommonsDetail "analysis failed" Retry** shows the asset's raw `last_error` (`components/commons/CommonsDetail.tsx`). It is the analyzer's text, not a request's. Needs GM's line (and maybe a backend reason code like the uploads').
- **Backend 404 details that are not written copy** pass through as the reason, e.g. "Character 'c1' not found", "collection not found". They are the backend's `detail` for a refusal, so they show under the heading. Writing them (or mapping by status) is a backend copy pass.
- **Agent-only Commons routes** (`/add`, `/add/upload`, `/borrow`) keep their raw detail: agents read them, the UI doesn't call them.
- **The intake copy table is in one place (coordinator, before merge).** The build kept it twice: `backend/commons/person_copy.py` INTAKE for the URL route and `frontend/src/lib/commonsApi.ts` UPLOAD_REASONS for each refused upload file. The upload route is person-only (`human_dep`), so each refused file now carries its line as `person` (from INTAKE) next to `reason` and `error`, and the frontend shows it; UPLOAD_REASONS is gone. A code newer than the frontend still shows its line. GM's 4xx fallback and 413 line are written on both sides of the wire, so `test_the_frontend_says_the_same_words_for_the_lines_both_sides_use` pins them equal. Tests first: the two backend upload tests (no `person` field) and the frontend upload test's newer-code case (it showed the fallback) failed before the change.
- **Evaluation's other refusals** (`backend/commons/evaluation.py`, e.g. "Need at least 45 distinct perceptual-hash clusters; found 12. No batch created.", "File is still dataless after download.") were already sent as written; they read technical. For GM.
- **Some UI tests time out under full-suite load** (Settings, NodeLibrary, CommandPalette, GraphFileActions, ResultsGallery, ModelPicker, CommonsDetail: 5 s timeouts and lazy chunks not landing in time); the 7 files pass alone (139/139). Timing, not copy.

### Review (round 2)

- **Three confirmed findings, all fixed, tests first.**
  - **A refused canvas delete showed the backend's raw text with the node id** ("Couldn't delete the node. Cannot delete n3: it has unresolved World Labs paid state…", or "…Node 'n3' not found"). The canvas guards nodes it knows hold paid state, so this is the race (the record lands after the check) or a node another window removed. Fix, both person paths that delete a node: `backend/main.py` `_ensure_node_deletable` (the canvas DELETE and the canvas undo/redo, POST /api/graph/restore) and `delete_graph_node`'s 404 now use GM's split, as `routes/commons.py` `refuse()` does: "People get the written line and agents keep the specific detail." `_person_reads_reply()` is a browser page (Origin or Sec-Fetch-Site, the same signal as `_from_a_browser`) with no agent marker, with or without the person token, so a plain tab reads the line too. It picks words, never authority. Person lines (mine, for GM): "This node has a World Labs start that isn't settled yet. Check Marble, then settle it before you delete the node." and "That node isn't on the canvas anymore." Agents, MCP, the CLI and scripts keep "Cannot delete n3: …" and "Node 'n3' not found" word for word (J; the apply and agent-undo routes need the id when they remove several nodes). The canvas also treats a 404 on delete as done (`deleteCLIOriginNode`): the person wanted it gone and it is, as restore already treats an already-gone node.
  - **An analyze failure took the short reason beside a Retry that only saves.** The notice now asks the store whether its Retry redoes the failure: `saveErrorRetry` on the draft entry, set only by `failSave` (a save), cleared by any other `patch` of `saveError` (analyze, uploads, the brief). Undo and redo had the same problem (failSave, but the toolbar Retry saves, it doesn't undo again), so they pass `{ retry: false }`; they also showed the edit request's heading "Couldn't save the board." and now show their own ("Couldn't undo the change." / "Couldn't redo the change."). Save failures keep GM's short line.
  - **The raw Commons refusal text was never logged.** The backend configures no logging, so `routes.commons` inherits the root's WARNING and both `logger.info` calls were dropped at run time (the tests only passed because they lowered the level). `log_refusal()` logs at WARNING, and `log_safe()` strips every URL's sign-in part, query and fragment first, so a signed link the person pasted (`?sig=…`) never reaches the terminal.
- **Tests that failed first** (logs in the scratchpad `error-copy-2/red-review2-*.log`): `backend/tests/test_node_delete_person_copy.py` (new, 9 tests: 5 failed, the person/plain-tab/desktop delete, the 404 and the canvas undo all read the raw text; the 4 agent/CLI/script tests passed, as they should); 3 new tests in `backend/tests/test_commons_person_copy.py` (no level lowered: nothing logged for the bad filters, the refused upload, or the signed URL); `tests/store/graphStore.errorCopy.test.ts` "a delete answered 404 …" (the node stayed); 4 analyze cases in `MoodboardStudioErrorCopy.test.tsx` (the short line); "a failed undo …" in `MoodboardStudioBoard.test.tsx` (it read "Couldn't save the board." over "Nebula didn't respond."). All pass after the fix.
- **Live check (review):** backend 8795 through `iso.sh` (no keys), Vite 5795 with `VITE_NEBULA_BACKEND_PORT=8795`, 8000-8010 and 5173 blocked (CDP plus the dead proxy), canary 8799 unreachable, **0 blocked attempts**. At 1440x900 and 1280x800: the canvas delete raced for real (the page's DELETE held at CDP while the node took a World Labs recovery id on the backend, then let go): the alert read "Couldn't delete the node. This node has a World Labs start that isn't settled yet. Check Marble, then settle it before you delete the node." and the node stayed. Analyze answered 503 (CDP fulfilled it; it never reached the backend): "Couldn't analyze the board." over "Nebula didn't respond. Try again."; then a save 503: "Couldn't save the board." over "Nebula didn't respond." beside Retry, and Retry saved. Over HTTP: an agent header and `nebula delete` (CLI, `--url` 8795) still print "Cannot delete n1: it has unresolved World Labs paid state…"; the backend log had the upload, bad-filters and URL refusals at WARNING, the URL as `https://127.0.0.1:9/a.png` with its `?sig=…#frag` gone. Nothing paid ran; no node was run.
- **Gates after the review fixes:** backend 9638 passed, 71 skipped; vitest 4653 passed, 13 failed in 7 files under full-suite load (the same 7 timing-out files as before), and those 7 files alone pass 139/139; `tsc -b` clean; lint clean; build budget 356,600 bytes raw (limit 512,000).
- **Open:** the toolbar Retry still shows after an analyze or undo failure (they set `saveState: 'error'`) and saves the board; pressing it clears the notice without redoing the action. Pre-existing; hiding it, or making it redo the failed action, is a small follow-up for GM to decide.

## Headings for GM to read

"One-line" = the error's message in an alert, toast, tooltip, node error or status text ("<heading> <reason>"). "Two-line" = heading over reason (FailureLines or the popover). "Retry" = shown next to a retry button, so the reason is the short form. Lines are in `frontend/src` unless named.

**Runs and the canvas**
- `lib/api.ts:69` Couldn't check the run. (one-line, run status)
- `lib/api.ts:76` Couldn't cancel the run. (one-line) — GM's
- `lib/api.ts:87` Couldn't unlock the provider start. (one-line)
- `lib/api.ts:108` Couldn't clear the provider recovery. (one-line)
- `lib/api.ts:139`, `store/graphStore.ts:2305, 4589, 4892, 4971` Couldn't start the run. (one-line, node errors)
- `lib/api.ts:153`, `store/graphStore.ts:4666` Couldn't run the node. (one-line, node error)
- `lib/api.ts:169`, `store/graphStore.ts:4780` Couldn't start the shot. (one-line) — GM's
- `lib/api.ts:179` Couldn't use that variation. (one-line)
- `lib/api.ts:576` Couldn't load the canvas. (one-line, CLI import)
- `store/graphStore.ts:2468` Couldn't add {node name}. (alert)
- `store/graphStore.ts:1705, 1711` Couldn't delete the node. / Couldn't delete N nodes. (alert)
- `store/graphStore.ts:1535` Couldn't connect that wire. / Couldn't remove that wire. (undo notice)
- `store/graphStore.ts:2705` Couldn't undo that. / Couldn't redo that. (undo notice; the heading was already there, the reason is now GM's)
- `store/graphStore.ts:2361` Couldn't check the canvas. / `:2383` Couldn't clear the canvas. (console headings; the alert says "Couldn't add {node name}." and the reason)
- `components/panels/Toolbar.tsx:37` Couldn't clear the canvas. (alert)
- `lib/graphFile.ts:24` Couldn't save the graph. / `:25` Couldn't load the graph. (alerts; the Toolbar says "Save graph" / "Load graph"); `components/GraphFileActions.tsx:16, 37` the same two for the import and the save
- `lib/graphFile.ts:1086` Couldn't restore the asset. (alert) — GM's
- `lib/canvasSelection.ts:23` Couldn't share the selection. (console) / `:61` Couldn't download the outputs. (Download button tooltip)
- `lib/canvasSelection.ts:60` "{name} is too large for the ZIP. Download it on its own." / `:59` "Those outputs are too large for one ZIP. Download fewer at a time." (tooltip) — GM's
- `lib/renderJobs.ts:35` Couldn't export the video. / `:43` Couldn't start the render. / `:51` Couldn't check the render. / `:55` Couldn't cancel the render. (one-line)
- `lib/editor/api.ts:22` Couldn't render the preview. (console today)
- `components/nodes/MeshPreview.tsx:168` Couldn't load the 3D preview. (preview status) — GM's; `:261` Couldn't download the 3D model. (status, role=alert)
- `lib/worldSplat.ts:8` Couldn't load the world. / `lib/worldDownload.ts:42` Couldn't download the world. (World modal) — GM's
- `components/nodes/ModelNode.tsx:54` Couldn't download the output. (alert)

**Settings and connections** (one-line unless noted)
- `lib/api.ts:188` Couldn't load your API keys. — GM's; Settings shows it two-line with Try again (`components/panels/Settings.tsx:99`, retry)
- `lib/api.ts:193` Couldn't save your settings.
- `lib/api.ts:288` Couldn't remove the API key. / `:302` Couldn't save the API key.
- `lib/api.ts:320` Couldn't load the OpenRouter models. / `:331` Couldn't load the Nous models. / `:552` Couldn't load the Quiver models. / `:581` Couldn't load the Replicate schema.
- `lib/api.ts:479` Couldn't load the models. (chat model picker, retry: "Retry model discovery")
- `lib/api.ts:516` Couldn't check Claude status. / `:521` Couldn't check Codex status. — GM's (chat status tooltip)
- `lib/api.ts:526` Couldn't start the ChatGPT sign-in. / `:535` Couldn't check the ChatGPT sign-in.
- `lib/api.ts:254` Couldn't load the connected apps. / `:267` Couldn't create the app token. / `:273` Couldn't save the app color. / `:279` Couldn't save the app limit. / `:246, 283` Couldn't revoke the app.
- `lib/api.ts:415` Couldn't load your agents. / `:419` Couldn't save your answer. / `:428` Couldn't save the agent. / `:436` Couldn't add the agent. / `:440` Couldn't remove the agent.
- `lib/api.ts:448-452` Couldn't start the download. / Couldn't remove the download. / Couldn't start the sign-in. / Couldn't stop the sign-in. / Couldn't sign out. (Antigravity)

**Characters and boards**
- `lib/api.ts:596` Couldn't load the characters. (`CharacterLibraryRail.tsx:76`, status text)
- `lib/api.ts:602`, `CharacterStudioView.tsx:236` Couldn't load the character. (two-line, retry: "Retry loading")
- `lib/api.ts:609` Couldn't create the character.
- `lib/api.ts:648`, `lib/characterEdits.ts:12`, `CharacterStudioView.tsx:297` Couldn't save the character. — GM's (two-line notice, retry; toolbar tooltip one-line)
- `lib/api.ts:667` Couldn't delete the character. (two-line)
- `CharacterDefinitionPanel.tsx:66` Couldn't upload {filename}. / `:74` Couldn't upload the image. (status text)
- `lib/api.ts:700`, `MoodboardStudioView.tsx:1361` Couldn't load the boards. (status text)
- `lib/api.ts:706, 823`, `MoodboardStudioView.tsx:343` Couldn't load the board. (two-line, retry: "Retry loading")
- `lib/api.ts:713` Couldn't create the board.
- `lib/api.ts:689`, `lib/moodboardEdits.ts:56` Couldn't save the board. (two-line notice, retry)
- `MoodboardStudioView.tsx:808` Couldn't undo the change. / Couldn't redo the change. (two-line)
- `lib/api.ts:762` Couldn't analyze the board. / `:769` Couldn't keep your brief. / `:778` Couldn't delete the board. (two-line)
- `lib/api.ts:800`, `hooks/useStudioAssetMove.ts:80` Couldn't move the board. / Couldn't move the character. (two-line)
- `MoodboardStudioView.tsx:627` Couldn't upload {filename}. / `:637, 665` Couldn't upload the image. (two-line)
- `hooks/useAssetDelete.ts:40` Couldn't delete the {board|character|style}. / `:58` Couldn't restore the {…}. (undo toast one-line; the Assets panel two-line)
- `lib/trash.ts:55` Couldn't load Recently deleted. / `:61` Couldn't restore the {…}. / `:66` Couldn't delete the {…} for good. / `:73` Couldn't empty Recently deleted.
- Conflicts: "This board changed in another window. Reload to get the latest version." (`lib/moodboardEdits.ts:56`, GM's) and "This character changed in another window. Reload to get the latest version." (`lib/characterEdits.ts:12`, mine, same voice)

**Projects** (`lib/projects.ts`, one-line in the project store; Project home shows them beside Try again, retry)
- `:89` Couldn't load your projects. / `:90` Couldn't load the project. / `:92` Couldn't create the project. / `:94` Couldn't open the project. / `:96` Couldn't save the project. / `:98` Couldn't rename the project. / `:100` Couldn't delete the project. / `:102` Couldn't restore the project. / `:104` Couldn't delete the project for good. / `:108` Couldn't empty Recently deleted. / `:110` Couldn't load the cover choices. / `:113` Couldn't set the cover. / `:117` Couldn't recover the project.

**Notes, Updates, proposals** (one-line)
- `lib/canvasPins.ts:19` Couldn't load the notes. / `:24` Couldn't save the note. / `:33` Couldn't delete the note.
- `lib/agentNotes.ts:181` Couldn't load the updates. / `:191` Couldn't mark the updates read. / `:203` Couldn't dismiss the update.
- `lib/assetProposals.ts:85` Couldn't accept the proposal. / Couldn't reject the proposal. / `:99` Couldn't load the proposals.
- `lib/canvasProposals.ts:56` Couldn't accept the proposal. / `:75` Couldn't reject the proposal.

**Creator Studio** (one-line)
- `lib/createFiles.ts:4` Couldn't show the file in Finder. / `:12` Couldn't save the file.
- `lib/createPresets.ts:44` Couldn't load the styles. / `:54` Couldn't save the style. / `:65` Couldn't delete the style.
- `lib/enhancePrompt.ts:11` Couldn't enhance the prompt.
- `lib/createTranscode.ts:13` Couldn't convert the image.
- `lib/uploadReference.ts:20`, `lib/createUploads.ts:36`, `lib/cinemaUploads.ts:49` Couldn't upload {filename}. (reference chips; retry: Retry / Attach again)

**Chat**
- `components/panels/ChatPanel.tsx:855` Couldn't upload the image. (console heading; the chip shows the reason only, under the file name)
- `lib/chatCancellation.ts:33` Couldn't stop the reply. (chat system line); reason when the socket closed first: "The connection closed before Nebula confirmed it stopped." (mine)

**Commons** (`lib/commonsApi.ts`; banners and notices two-line or one-line as the screen shows them)
- `:152, 162, 224` Couldn't load the reference. / `:154` Couldn't check the Commons status. / `:155` Couldn't load the collections. / `:157` Couldn't create the collection. / `:159` Couldn't save the collection. / `:161` Couldn't load the references.
- `:169` Couldn't upload the files. / `:134-138` Couldn't upload {filename}. (per file, two-line) / `:172` Couldn't add that URL. / `:174` Couldn't import the moodboards.
- `:175` Couldn't load the linked folders. / `:176` Couldn't link the folder. / `:177` Couldn't save the ignore list. / `:178` Couldn't rescan the folder.
- `:180` Couldn't save the reference. / `:181` Couldn't accept the reference. / `:183` Couldn't save the correction. / `:185` Couldn't add the region. / `:187` Couldn't save the region. / `:188` Couldn't reanalyze the reference. / `:190` Couldn't reanalyze the stale references. / `:191` Couldn't delete the reference. / `:193` Couldn't post the comment.
- `:194` Couldn't load the Commons settings. / `:196` Couldn't save the Commons settings. / `:198` Couldn't load the vocabulary candidates. / `:199` Couldn't start the worker. / `:200` Couldn't stop the worker. / `:201` Couldn't export the zip.
- `:220` Couldn't load Blind labeling. / `:222` Couldn't prepare the held-out set. / `:227` Couldn't save the accents. / `:229` Couldn't save your labels. (banner one-line; leave popover two-line, retry) / `:233` Couldn't seal the labels. / `:236` Couldn't close the batch.
- `:240` Couldn't load Agent review. / `:242` Couldn't grade the reference. / `:244` Couldn't save your corrections.
- Upload reasons (`lib/commonsApi.ts:127`): too_large "That's too large to save." (GM's 413 line); unsupported_type "Nebula can't read that file type. Use JPG, PNG, WebP, GIF, HEIC, MP4 or MOV."; unreadable "That file couldn't be read. It may be damaged."; unknown_collection "That collection isn't there anymore. Reload to get the latest collections."; any other code: GM's fallback.

**Backend lines the person reads** (`backend/commons/person_copy.py` unless named; agents get the specific text)
- `:17` "Those filters didn't work. Clear them and try again." (GM's) / `:18` "That setting isn't available. Reload to get the latest settings." (GM's) / `:21` "That value doesn't work for this setting. Reload to get the latest settings."
- `:22` "Nebula can't read that folder. Check that it exists and that Nebula can open it." / `backend/commons/evaluation.py:40` "A file in that folder couldn't be read. Check that it opens, then scan again."
- `:27` INTAKE: the four upload reasons above, plus fetch_failed "Nebula couldn't get that URL. Check the address, or save the image and upload it." and blocked "Nebula can't fetch that address. Use a public image URL."
- `backend/commons/folders.py:96` "Choose a real folder, not a symlink." / `:99` "That isn't a folder. Check the path and try again."
- `backend/commons/records.py:14` "That region is outside the image. Draw it again." / `:267` "Write a comment first." / `:273` "That region isn't on this reference anymore. Reload to get the latest version."; a bad op or region status (only a broken client sends one) gets GM's fallback.
- `backend/main.py` (review): a refused canvas delete or undo: "This node has a World Labs start that isn't settled yet. Check Marble, then settle it before you delete the node." (mine) / a node already gone: "That node isn't on the canvas anymore." (mine; the canvas itself now treats that as done).
- Moodboard undo/redo failures name their own action: "Couldn't undo the change." / "Couldn't redo the change.", over the full reason.
