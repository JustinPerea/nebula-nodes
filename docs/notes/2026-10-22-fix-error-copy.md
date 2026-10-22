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

- **(Resolved in round 3: GM's heading, a reason by kind, the raw text behind Details.)** **CommonsDetail "analysis failed" Retry** shows the asset's raw `last_error` (`components/commons/CommonsDetail.tsx`). It is the analyzer's text, not a request's. Needs GM's line (and maybe a backend reason code like the uploads').
- **(Resolved in round 3 for every route the person's UI calls: GM's "That {thing} isn't there anymore." line.)** **Backend 404 details that are not written copy** pass through as the reason, e.g. "Character 'c1' not found", "collection not found". They are the backend's `detail` for a refusal, so they show under the heading. Writing them (or mapping by status) is a backend copy pass.
- **Agent-only Commons routes** (`/add`, `/add/upload`, `/borrow`) keep their raw detail: agents read them, the UI doesn't call them.
- **The intake copy table is in one place (coordinator, before merge).** The build kept it twice: `backend/commons/person_copy.py` INTAKE for the URL route and `frontend/src/lib/commonsApi.ts` UPLOAD_REASONS for each refused upload file. The upload route is person-only (`human_dep`), so each refused file now carries its line as `person` (from INTAKE) next to `reason` and `error`, and the frontend shows it; UPLOAD_REASONS is gone. A code newer than the frontend still shows its line. GM's 4xx fallback and 413 line are written on both sides of the wire, so `test_the_frontend_says_the_same_words_for_the_lines_both_sides_use` pins them equal. Tests first: the two backend upload tests (no `person` field) and the frontend upload test's newer-code case (it showed the fallback) failed before the change.
- **(Resolved in round 3: rewritten to GM's pattern.)** **Evaluation's other refusals** (`backend/commons/evaluation.py`, e.g. "Need at least 45 distinct perceptual-hash clusters; found 12. No batch created.", "File is still dataless after download.") were already sent as written; they read technical. For GM.
- **Some UI tests time out under full-suite load** (Settings, NodeLibrary, CommandPalette, GraphFileActions, ResultsGallery, ModelPicker, CommonsDetail: 5 s timeouts and lazy chunks not landing in time); the 7 files pass alone (139/139). Timing, not copy.

### Review (round 2)

- **Three confirmed findings, all fixed, tests first.**
  - **A refused canvas delete showed the backend's raw text with the node id** ("Couldn't delete the node. Cannot delete n3: it has unresolved World Labs paid state…", or "…Node 'n3' not found"). The canvas guards nodes it knows hold paid state, so this is the race (the record lands after the check) or a node another window removed. Fix, both person paths that delete a node: `backend/main.py` `_ensure_node_deletable` (the canvas DELETE and the canvas undo/redo, POST /api/graph/restore) and `delete_graph_node`'s 404 now use GM's split, as `routes/commons.py` `refuse()` does: "People get the written line and agents keep the specific detail." `_person_reads_reply()` is a browser page (Origin or Sec-Fetch-Site, the same signal as `_from_a_browser`) with no agent marker, with or without the person token, so a plain tab reads the line too. It picks words, never authority. Person lines (mine, for GM): "This node has a World Labs start that isn't settled yet. Check Marble, then settle it before you delete the node." and "That node isn't on the canvas anymore." Agents, MCP, the CLI and scripts keep "Cannot delete n3: …" and "Node 'n3' not found" word for word (J; the apply and agent-undo routes need the id when they remove several nodes). The canvas also treats a 404 on delete as done (`deleteCLIOriginNode`): the person wanted it gone and it is, as restore already treats an already-gone node.
  - **An analyze failure took the short reason beside a Retry that only saves.** The notice now asks the store whether its Retry redoes the failure: `saveErrorRetry` on the draft entry, set only by `failSave` (a save), cleared by any other `patch` of `saveError` (analyze, uploads, the brief). Undo and redo had the same problem (failSave, but the toolbar Retry saves, it doesn't undo again), so they pass `{ retry: false }`; they also showed the edit request's heading "Couldn't save the board." and now show their own ("Couldn't undo the change." / "Couldn't redo the change."). Save failures keep GM's short line.
  - **The raw Commons refusal text was never logged.** The backend configures no logging, so `routes.commons` inherits the root's WARNING and both `logger.info` calls were dropped at run time (the tests only passed because they lowered the level). `log_refusal()` logs at WARNING, and `log_safe()` strips every URL's sign-in part, query and fragment first, so a signed link the person pasted (`?sig=…`) never reaches the terminal.
- **Tests that failed first** (logs in the scratchpad `error-copy-2/red-review2-*.log`): `backend/tests/test_node_delete_person_copy.py` (new, 9 tests: 5 failed, the person/plain-tab/desktop delete, the 404 and the canvas undo all read the raw text; the 4 agent/CLI/script tests passed, as they should); 3 new tests in `backend/tests/test_commons_person_copy.py` (no level lowered: nothing logged for the bad filters, the refused upload, or the signed URL); `tests/store/graphStore.errorCopy.test.ts` "a delete answered 404 …" (the node stayed); 4 analyze cases in `MoodboardStudioErrorCopy.test.tsx` (the short line); "a failed undo …" in `MoodboardStudioBoard.test.tsx` (it read "Couldn't save the board." over "Nebula didn't respond."). All pass after the fix.
- **Live check (review):** backend 8795 through `iso.sh` (no keys), Vite 5795 with `VITE_NEBULA_BACKEND_PORT=8795`, 8000-8010 and 5173 blocked (CDP plus the dead proxy), canary 8799 unreachable, **0 blocked attempts**. At 1440x900 and 1280x800: the canvas delete raced for real (the page's DELETE held at CDP while the node took a World Labs recovery id on the backend, then let go): the alert read "Couldn't delete the node. This node has a World Labs start that isn't settled yet. Check Marble, then settle it before you delete the node." and the node stayed. Analyze answered 503 (CDP fulfilled it; it never reached the backend): "Couldn't analyze the board." over "Nebula didn't respond. Try again."; then a save 503: "Couldn't save the board." over "Nebula didn't respond." beside Retry, and Retry saved. Over HTTP: an agent header and `nebula delete` (CLI, `--url` 8795) still print "Cannot delete n1: it has unresolved World Labs paid state…"; the backend log had the upload, bad-filters and URL refusals at WARNING, the URL as `https://127.0.0.1:9/a.png` with its `?sig=…#frag` gone. Nothing paid ran; no node was run.
- **Gates after the review fixes:** backend 9638 passed, 71 skipped; vitest 4653 passed, 13 failed in 7 files under full-suite load (the same 7 timing-out files as before), and those 7 files alone pass 139/139; `tsc -b` clean; lint clean; build budget 356,600 bytes raw (limit 512,000).
- **Open (resolved in round 3: Retry redoes the failed action or is hidden):** the toolbar Retry still shows after an analyze or undo failure (they set `saveState: 'error'`) and saves the board; pressing it clears the notice without redoing the action. Pre-existing; hiding it, or making it redo the failed action, is a small follow-up for GM to decide.

## Headings for GM to read

"One-line" = the error's message in an alert, toast, tooltip, node error or status text ("<heading> <reason>"). "Two-line" = heading over reason (FailureLines or the popover). "Retry" = shown next to a retry button, so the reason is the short form. Lines are in `frontend/src` unless named.

**Runs and the canvas**
- `lib/api.ts:69` Couldn't check the run. (one-line, run status)
- `lib/api.ts:76` Couldn't cancel the run. (one-line) — GM's
- `lib/api.ts:89` Couldn't unlock the node. (one-line; the button is "Checked Marble — unlock") — round 3, GM's rule
- `lib/api.ts:111` Couldn't forget the recovery safeguard. (one-line; the button is "Checked Marble — forget") — round 3, GM's rule
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
- `lib/api.ts:762` Couldn't analyze the board. / `:772` Couldn't save your brief. (round 3, GM's) / `:778` Couldn't delete the board. (two-line)
- `lib/api.ts:800`, `hooks/useStudioAssetMove.ts:80` Couldn't move the board. / Couldn't move the character. (two-line)
- `MoodboardStudioView.tsx:627` Couldn't upload {filename}. / `:637, 665` Couldn't upload the image. (two-line)
- `hooks/useAssetDelete.ts:40` Couldn't delete the {board|character|style}. / `:58` Couldn't restore the {…}. (undo toast one-line; the Assets panel two-line)
- `lib/trash.ts:55` Couldn't load Recently deleted. / `:61` Couldn't restore the {…}. / `:66` Couldn't delete the {…} for good. / `:73` Couldn't empty Recently deleted.
- Conflicts: "This board changed in another window. Reload to get the latest version." (`lib/moodboardEdits.ts:56`, GM's) and "This character changed in another window. Reload to get the latest version." (`lib/characterEdits.ts:12`, mine, same voice)

**Projects** (`lib/projects.ts`, one-line in the project store; Project home shows them beside Try again, retry)
- `:89` Couldn't load your projects. / `:90` Couldn't load the project. / `:92` Couldn't create the project. / `:94` Couldn't open the project. / `:96` Couldn't save the project. / `:98` Couldn't rename the project. / `:100` Couldn't delete the project. / `:102` Couldn't restore the project. / `:104` Couldn't delete the project for good. / `:108` Couldn't empty Recently deleted. / `:110` Couldn't load the cover choices. / `:113` Couldn't set the cover. / `:117` Couldn't recover the project.

**Notes, Updates, proposals** (one-line)
- `lib/canvasPins.ts:19` Couldn't load the notes. / `:24` Couldn't save the note. / `:33` Couldn't delete the note.
- `lib/agentNotes.ts:181` Couldn't load the updates. / `:191` Couldn't mark the updates as read. (round 3, GM's) / `:203` Couldn't dismiss the update.
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
- `lib/chatCancellation.ts:33` Couldn't stop the reply. (chat system line); reason when the socket closed first: "The connection dropped before Nebula confirmed the stop. The reply may still be running." (round 3, GM's)

**Commons** (`lib/commonsApi.ts`; banners and notices two-line or one-line as the screen shows them)
- `:152, 162, 224` Couldn't load the reference. / `:154` Couldn't check the Commons status. / `:155` Couldn't load the collections. / `:157` Couldn't create the collection. / `:159` Couldn't save the collection. / `:161` Couldn't load the references.
- `:169` Couldn't upload the files. / `:134-138` Couldn't upload {filename}. (per file, two-line) / `:172` Couldn't add that URL. / `:174` Couldn't import the moodboards.
- `:175` Couldn't load the linked folders. / `:176` Couldn't link the folder. / `:177` Couldn't save the ignore list. / `:178` Couldn't rescan the folder.
- `:180` Couldn't save the reference. / `:181` Couldn't accept the reference. / `:183` Couldn't save the correction. / `:185` Couldn't add the region. / `:187` Couldn't save the region. / `:188` Couldn't reanalyze the reference. / `:190` Couldn't reanalyze the stale references. / `:191` Couldn't delete the reference. / `:193` Couldn't post the comment.
- `:194` Couldn't load the Commons settings. / `:196` Couldn't save the Commons settings. / `:198` Couldn't load the vocabulary candidates. / `:199` Couldn't start the worker. / `:200` Couldn't stop the worker. / `:197` Couldn't export the ZIP. (round 3, GM's)
- `:220` Couldn't load Blind labeling. / `:222` Couldn't prepare the held-out set. / `:227` Couldn't save the accents. / `:229` Couldn't save your labels. (banner one-line; leave popover two-line, retry) / `:233` Couldn't seal the labels. / `:236` Couldn't close the batch.
- `:240` Couldn't load Agent review. / `:242` Couldn't grade the reference. / `:244` Couldn't save your corrections.
- Upload reasons (`lib/commonsApi.ts:127`): too_large "That's too large to save." (GM's 413 line); unsupported_type "Nebula can't read that file type. Use JPG, PNG, WebP, GIF, HEIC, MP4 or MOV."; unreadable "That file couldn't be read. It may be damaged."; unknown_collection "That collection isn't there anymore. Reload to get the latest collections."; any other code: GM's fallback.

**Backend lines the person reads** (`backend/commons/person_copy.py` unless named; agents get the specific text)
- `:17` "Those filters didn't work. Clear them and try again." (GM's) / `:18` "That setting isn't available. Reload to get the latest settings." (GM's) / `:21` "That value doesn't work for this setting. Reload to get the latest settings."
- `:22` "Nebula can't read that folder. Check that it exists and that Nebula can open it." / `backend/commons/evaluation.py:40` "A file in that folder couldn't be read. Check that it opens, then scan again."
- `:27` INTAKE: the four upload reasons above, plus fetch_failed "Nebula couldn't get that URL. Check the address, or save the image and upload it." and blocked "Nebula can't fetch that address. Use a public image URL."
- `backend/commons/folders.py:96` "Choose the folder itself, not a shortcut to it." (round 3, GM's) / `:99` "That isn't a folder. Check the path and try again."
- `backend/commons/records.py:14` "That region is outside the image. Draw it again." / `:267` "Write a comment first." / `:273` "That region isn't on this reference anymore. Reload to get the latest version."; a bad op or region status (only a broken client sends one) gets GM's fallback.
- `backend/main.py` (review, rewritten in round 3): a refused canvas delete or undo says "This node is still waiting on World Labs." then the control that clears it (GM's pattern; the four lines are under "Round 3 lines for GM") / a node already gone: "That node isn't on the canvas anymore." (mine; the canvas itself now treats that as done).
- Moodboard undo/redo failures name their own action: "Couldn't undo the change." / "Couldn't redo the change.", over the full reason.

## Round 3: GM's heading review

GM - Design owns the copy. GM's review of the headings list, verbatim where quoted: name the action after "the button label clicked"; "'settle' and 'start' are internal. Write it as: 'This node is still waiting on World Labs. Check the job in Marble, then {the node's actual button label} before you delete it.'"; a Retry has to redo the failed action, or not show; the Commons analysis failure gets "Couldn't analyze this reference." over a reason by kind, with the raw text behind "Details"; a 404 the person reads says "That {thing} isn't there anymore. Reload to get the latest {things}."; and the Blind labeling refusals follow the pattern "what's needed, the count, what to do". GM also said again: "People get the written line and agents keep the specific detail."

### What changed and why

- **Headings (GM's words).** `lib/api.ts` "Couldn't unlock the node." and "Couldn't forget the recovery safeguard." (named after the buttons the person clicked, see Decisions); "Couldn't save your brief."; `commonsApi` "Couldn't export the ZIP."; `agentNotes` "Couldn't mark the updates as read."; `chatCancellation` reason "The connection dropped before Nebula confirmed the stop. The reply may still be running."; `commons/folders.py` "Choose the folder itself, not a shortcut to it.". The headings list above is updated in place.
- **Item 1, World Labs delete refusal (`backend/main.py` `_ensure_node_deletable`).** The backend knows which record holds the node, so the line names the control that clears that record (lines below). Order when several hold it: a start still in flight, then an ambiguous start, then a recovery record, then IDs in the node's params. Person only; agents, MCP, the CLI and scripts keep "Cannot delete n3: …" with the id, unchanged. (Review: the same lines now cover Clear canvas, opening or making a project, replacing the graph, restoring a bundle and Run History's forget; an ID in a node's params names that node's own fields. See "Review (round 3)".)
- **One shared refusal helper (`backend/services/refusal_copy.py`, new).** Round 2 had the person/agent split twice (`main.py` `_person_reads_reply` and `routes/commons.py` `refuse`). Now one module decides who reads a reply (`person_reads`: the Commons actor, or the request's headers) and holds GM's 404 line (`gone`, `gone_from_trash`, `not_found`). `main.py`, `routes/commons.py`, `routes/render_exports.py`, `routes/video_edit_preview.py` and `services/canvas_pins.py` use it. The specific text the person didn't read is logged at WARNING on `nebula.refusals` (URLs without their sign-in part, query or fragment), as round 2's review asked.
- **Item 3, the board and Character toolbar Retry.** The draft store records what failed (`retry`: save, analyze, undo or redo, and for undo/redo the step's id, `retryStep`). The board's Retry runs that action again: analyze re-runs the analysis (no PUT, no edit), undo re-sends the same restore (the same step, not the next one), redo the same. Retry is hidden when nothing it can do redoes the failure: an upload or brief failure, or an undo/redo whose step is no longer the next one (a later edit dropped it). Review: when an upload, brief or no-project line replaces a failed save, that save is still owed, so the toolbar keeps a Retry that saves (see "Review (round 3)"). A hidden Retry means the line keeps GM's full reason (WRAP rule). The Character studio only fails saves through its toolbar, so its Retry shows for a save failure and nothing else.
- **Item 4, Commons analysis failure.** The kind is decided where the analysis fails, not guessed from text at render time: `commons/analysis_errors.py` (new) classifies a reader's exception (`httpx` 5xx/408/429, transport errors, timeouts, connection errors: unavailable; else other), the claude reader's result (`commons/reader.py`: can't start, timed out, no result event: unavailable; an `is_error` result whose text says overloaded/5xx/timeout: unavailable, a refusal: unreadable, else other; a result with no structure: unreadable), the worker (`commons/worker.py`: image won't load: unreadable; validation: other) and intake's video probe (unreadable). It is stored in `assets.last_error_kind`, an additive column (`commons/db.py` ADDED_COLUMNS; schema stays "4": an old database gains the column on open, an old binary ignores it). A row from before the column says the kind its `last_error` names (`classify_text`, by this backend's own message prefixes). `last_error` itself is unchanged. The detail (`components/commons/CommonsDetail.tsx`) shows GM's heading over the reason, keeps Retry, and puts the raw `last_error` inside a native `<details>` "Details" that starts closed (keyboard: Tab to it, Enter opens).
- **Item 5, 404s.** Every 404 a person's screen can hit says GM's line with the thing named the way the UI names it; agents keep the specific text. Which routes: listed under "Round 3 lines for GM". Things in Recently deleted say "That {thing} isn't in Recently deleted anymore. Reload to get the latest list.", and acting on a trashed board or character says "That {thing} is in Recently deleted. Restore it, then try again." (a move: "… Restore it first, then move it.").
- **Item 6, Blind labeling refusals (`commons/evaluation.py`, `commons/review.py`).** Rewritten to GM's pattern; old -> new under "Round 3 lines for GM". Checks only a broken client can trip (a label field out of range, a bad accent shape) say GM's fallback line to the person and log the specific one. Agents keep the old specific text.
- **Agent support.** No new tool (copy and one additive field). `asset.last_error_kind` (unavailable, unreadable, other) is in the Commons asset JSON that `commons_get` / `nebula commons get <id>` already return; documented in `backend/mcp_server.py` (commons_get docstring), `docs/MCP-SETUP.md` (Commons bullet, and a new "Refusal text: the person's line, your detail" section: agents keep the specific text when they send an agent marker) and `skills/nebula/SKILL.md`. Tested: agents, the CLI and scripts get the old specific text on every converted route (`backend/tests/test_error_copy_round3.py`).

### Decisions not in GM's message

- **Button labels for item 1 and the two headings.** GM's example was "unlock the run"; the buttons say "Checked Marble — unlock" (the status bar, an ambiguous start) and "Checked Marble — forget" (Run History, a recovery record), and what they unlock or forget is the node's paid-start lock. So the headings are "Couldn't unlock the node." and "Couldn't forget the recovery safeguard." (Run History calls the record a "World Labs recovery safeguard"). For GM to confirm.
- **Item 1 has four states, so four lines.** Only two have a button. An ID in the node's params is cleared by emptying two fields (no button), so that line names the fields. A start still in flight has nothing to click: "Let its run finish, then delete it." (no "Check the job in Marble"; the job isn't settled yet). For GM.
- **429 counts as "didn't respond"** (unavailable): a rate limit is the service saying it can't answer now, and a Retry later is the right move.
- **Schema stays v4.** The column is additive and derived for old rows, so no version bump or migration step was needed; `tests/test_commons_db.py`'s historical DDL now leaves the column out and checks it is added.
- **404s left as they are, on purpose:** requests that already allow a 404 and handle it (`fetchCharacter`, `fetchMoodboard`, `lookupStoredAsset` GETs), the canvas node delete (a 404 is "done"), the project store's recover (404 handled), blob, output and thumbnail files (a broken image, not a line), agent-only routes (`/api/graph/apply`, `/api/graph/run`, the agent's describe-node routes, Commons borrowings and Commons proposals), the Replicate version lookup and `current_project` (no person path reaches a 404 there).
- **Undo/redo failure keeps `dirty` as it was**: the failed write was a restore, not an edit, so it doesn't mark the board unsaved.

### Tradeoffs

- ~~An upload or brief failure that replaces a save failure hides Retry until the next edit.~~ Reversed in review: that left the board saying Error with unsaved edits and no button (autosave waits while it says Error). The toolbar now keeps a Retry that saves while a save is still owed; the notice keeps the upload's own full line and no Retry of its own.
- The kind for pre-column rows comes from text, so a row whose `last_error` was written by a version with different wording says "Something went wrong during analysis." That is GM's catch-all, and Retry still works.

### Tests (written first; each failed on the old code)

Red logs are in the session scratchpad (`error-copy-3/red-backend.log`, `red-frontend.log`).

- Backend, new `backend/tests/test_error_copy_round3.py` (76 tests: the four World Labs lines and the agent text, every converted 404 as the person and as an agent, the in-trash lines, the helper is the one in use, Commons 404s, the folder shortcut line, Blind labeling lines with their counts, broken-client checks get the fallback) and `backend/tests/test_commons_analysis_error_kind.py` (23 tests: worker, reader and video-probe kinds, an old database gains the column and derives kinds, the asset detail carries the field). Red: **77 failed, 22 passed**; the 22 were the agent-keeps-the-specific-text tests, which pass on the old code as they should.
- Frontend: `tests/lib/errorCopy.sweep.test.ts` (new headings), `tests/lib/chatCancellation.test.ts`, `tests/commonsApi.errorCopy.test.ts` (ZIP), `MoodboardStudioErrorCopy.test.tsx` (analyze failure: short line and Retry analyzes again with no PUT; a failure no Retry redoes: no Retry, full reason), `MoodboardStudioBoard.test.tsx` (failed undo: Retry re-sends the same restore and no save; failed redo the same; Retry hidden once the step is gone), `CharacterStudioErrorCopy.test.tsx` (Retry saves again; a non-save failure: no Retry), `CommonsDetail.test.tsx` (each kind's reason, unknown and missing kinds, Details closed then open, no Details without `last_error`). Red: **31 failed, 223 passed** in 7 files.
- Existing tests updated to the new copy: `test_node_delete_person_copy.py` (the in-flight line), `test_commons_person_copy.py` (folder and absolute-path lines), `test_commons_db.py` (historical DDL).
- After: the two new backend files pass (76 + 23), the 7 frontend files pass (254).

### Live check

Isolated backend on 8781 through `iso.sh` (temp HOME, every NEBULA_* root in the scratchpad, no keys), Vite on 5781 with `VITE_NEBULA_BACKEND_PORT=8781`. 8000-8010 and 5173 blocked (CDP `Network.setBlockedURLs` plus the dead proxy), canary 8799 unreachable, **0 blocked attempts**. Narrow CDP Fetch interception failed only the request each check names. At 1440x900 and 1280x800, **44 PASS, 0 FAIL**:

- Blind labeling prepare on a three-image folder: "Couldn't prepare the held-out set. Blind labeling needs at least 45 references that look different from each other. You have 3. Add more, then try again." (one line, no status code).
- Commons detail, a reference with a stored `unavailable` failure and one from an old-style row whose text derives `unreadable`: "Couldn't analyze this reference." over "The analysis service didn't respond." / "The analyzer couldn't read this image.", Retry beside it, Details closed (raw text not visible); Tab to Details and Enter showed the raw `last_error`. Retry re-queued the reference (the worker was stopped, so nothing ran).
- Board analyze answered 503 (CDP): "Couldn't analyze the board." over "Nebula didn't respond." beside Retry; Retry ran analyze again (the page sent analyze twice, no PUT).
- Board undo of a weight change answered 503: "Couldn't undo the change." over "Nebula didn't respond." beside Retry; Retry re-sent the same restore, the weight went back, no PUT.
- A board deleted behind the page: "Couldn't analyze the board." over "That board isn't there anymore. Reload to get the latest boards.". Over HTTP the browser got GM's line and an agent header and a script got "Moodboard '<id>' not found"; a character the same.
- No page errors, nothing paid ran. Servers stopped by port, scratch state deleted.

### Open items

- The Blind labeling intro copy (not a refusal) still says "near-duplicate clusters"; it now disagrees in tone with the refusal ("references that look different from each other"). For GM.
- `deleteProviderRecovery`'s store can still alert a thrown non-request error's own text (no request was made; rare). Small follow-up.
- `tests/test_agent_guardian.py::test_registration_racing_the_backend_kill_is_still_reaped` failed once in a full backend run under load and passes alone; a race in the test, not this change.

### Review (round 3)

- **Four confirmed findings, all fixed, tests first.**
  - **Clear canvas, opening a project, replacing the graph and restoring a bundle still showed GM's rejected words** ("Couldn't clear the canvas. Cannot clear the canvas while a World Labs paid start is settling. …"). Round 3 had only rewritten the per-node delete. `backend/main.py` `_reject_graph_replacement_during_paid_start` (all four callers) and the lifecycle fence in `_paid_graph_mutation` (a start another process holds, same "settling" words; every graph mutation goes through it) now go through `refusal_copy.refusal`: agents keep "Cannot {action} while …" word for word, the person reads one of the lines under "Round 3 lines for GM" (by the state that holds the canvas, the action left out because the heading names it). Checking every path that refuses for the same reason turned up one more the person clicks: Run History's "Checked Marble — forget" while the node's start is still in flight ("…paid start is still settling"); it now says "This node is still waiting on World Labs. Let its run finish, then try again." One function, `_paid_state_person(state, subject=, then=)`, writes all of them, the node lines included, so the two can't drift.
  - **A failed board or Character save lost its only Retry** when an upload, brief or no-project line replaced it (the store clears `retry` on any other `saveError`), while the toolbar said Error, the edits stayed unsaved and autosave waited. A save is still owed, so a Retry that saves redoes the action that failed: `MoodboardStudioView` shows the toolbar Retry for `saveState === 'error' && dirty && retry == null` too (its `retryFailed` already saves when `retry` is null); `CharacterStudioView` passes the toolbar `saveState === 'error' && (retry === 'save' || (retry == null && dirty))`. The store is unchanged, so the upload/brief/no-project line keeps its full reason and no Retry of its own.
  - **Agent review's daily-cap refusal was wrong with the cap at 0** ("Commons has made all 0 of today's analysis calls. Try again tomorrow, …": none were made, and tomorrow fails the same way) and named the cap, not the calls, when the cap was lowered below today's calls. `commons/review.py` `_reserve` now says the calls made and the cap, and with the cap at 0 says it needs at least 1 and where to raise it. Agents keep "Daily model call cap reached.".
  - **A World export node's delete refusal named fields it doesn't have** ("Resume Operation ID and Existing World ID"; its only one is "Resume Export Operation ID"). `_recovery_field_labels` reads the labels from `node_definitions.json` (`node_registry`) for the recovery IDs the node actually holds (policy order); the old fixed text is only a fallback for a node with no labelled field. The canvas-wide "params" line uses the same function over the canvas's nodes.
- **Tests that failed first** (logs: scratchpad `error-copy-3/red-review-backend.log`, `red-review-frontend.log`). Backend: **13 failed** on the round-3 code, each on the old copy: 3 in `tests/test_commons_review.py` (cap 0, cap 5 with 12 calls, cap 3 with 3 calls: "made all {cap}"), 10 in `tests/test_error_copy_round3.py` (the export node's field, a World node holding only one ID, clear canvas and open project as the person for each of three states, the lifecycle fence, restoring a bundle); the 18 new agent/CLI/script tests passed, as they should. One more, written after reading the forget route: "forgetting a recovery while its start runs" failed on the "settling" text. Frontend: **2 failed** (`MoodboardStudioErrorCopy.test.tsx` "keeps the toolbar Retry, and Retry saves the board again", `CharacterStudioErrorCopy.test.tsx` "keeps the toolbar Retry, and Retry saves again": no Retry button). All pass after the fix.
- **Live check (review):** backend 8781 through `iso.sh` (temp HOME, every NEBULA_* root in the scratchpad, no keys, `NEBULA_COMMONS_REVIEW_CALL_BUDGET=2`), Vite 5781 with `VITE_NEBULA_BACKEND_PORT=8781`; 8000-8010 and 5173 blocked (CDP `Network.setBlockedURLs` plus the dead proxy), canary 8799 unreachable, **0 blocked attempts**; **30 PASS, 0 FAIL** at 1440x900 and 1280x800. A World export node holding a recovery ID (nothing ran): opening another project from Projects read "Couldn't open the project. A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you try again."; Clear canvas (confirm, then the alert) read "Couldn't clear the canvas." over the same line at both sizes, and the node stayed; over HTTP an agent header and a script still got "Cannot clear the canvas while unresolved World Labs paid state exists. …", and a node DELETE as the page got "This node is still waiting on World Labs. … “Checked Marble — forget” in Run History before you delete it." (agent: "Cannot delete n1: …"). After forget the node deleted (the forget route empties its ID). Board: a save answered 503 (CDP), then an upload answered 503: "Couldn't upload ref-02.png." over the full "Nebula didn't respond. Try again.", the toolbar still said Error with one Retry; Retry sent the save and the weight landed, the notice and Retry went. Agent review with the cap at 0: "Couldn't grade the reference. Agent review needs at least 1 analysis call a day. …"; cap 2 with 3 calls seeded: "Commons has made 3 analysis calls today, and the daily cap is 2. …"; the meter didn't move (checked before each click that no call could go out). No page errors. Servers stopped by port, state deleted.
- **Gates after the review fixes:** backend **9770 passed, 71 skipped**; vitest **4677 passed, 8 failed** in 6 files under full-suite load (6 "Test timed out in 5000ms" plus 2 waits, in CommonsDetail, CommandPalette, ModelPicker, ResultsGallery, NodeLibrary and Settings tests), and those 6 files alone pass **121/121**; `tsc -b` clean; lint clean; build budget **356,601 bytes raw** (limit 512,000).
- **Agent support:** no new tool. Agents, MCP, the CLI and scripts keep every specific refusal word for word (tested for clear canvas, open project, restore, forget, node delete and the daily cap); the person/agent choice is still the one helper, `services/refusal_copy.py`.
- **Open items:** the canvas silently keeps a node with a recovery record when the person presses Delete (`graphStore` `nodeHasProviderSafety`, no request, no message; pre-existing, seen live), so the node line is mostly reached through a race or the undo path; a short line there would help. "Checked Marble — unlock"'s refusals (`provider_start_guard.acknowledge`: "Cannot acknowledge a World Labs paid-start ambiguity while that provider handshake is still active", "…ambiguity changed; refresh…") and the run-start refusals still use internal words; a follow-up for GM. The Character Studio's no-project case was checked by its test only (the live app always has a project open).

## Round 3 lines for GM

**New button-label headings**
- `lib/api.ts:89` "Couldn't unlock the node." (button: "Checked Marble — unlock")
- `lib/api.ts:111` "Couldn't forget the recovery safeguard." (button: "Checked Marble — forget")

**Item 1, a refused canvas delete or undo (`backend/main.py`, by what holds the node)**
- An ambiguous start: "This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you delete it."
- A recovery record: "This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you delete it."
- An ID in the node's params: "This node is still waiting on World Labs. Check the job in Marble, then clear the node's {fields} before you delete it.", {fields} being the labels of the IDs the node holds: a World node "Resume Operation ID and Existing World ID" (or just the one it holds), a World export node "Resume Export Operation ID" (review).
- A start still in flight: "This node is still waiting on World Labs. Let its run finish, then delete it."
- Run History's "Checked Marble — forget" while that node's start is still in flight (review): "This node is still waiting on World Labs. Let its run finish, then try again."

**Item 1, the whole canvas (review): Clear canvas, opening or making a project, replacing the graph, restoring a bundle.** The screen's heading names the action ("Couldn't clear the canvas.", "Couldn't open the project."), so the line leaves it out:
- A start still in flight: "A node is still waiting on World Labs. Let its run finish, then try again."
- An ambiguous start: "A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you try again."
- A recovery record (also the rare case where Nebula couldn't journal one it read from the canvas): "A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you try again."
- An ID in a node's params: "A node is still waiting on World Labs. Check the job in Marble, then clear the node's {fields} before you try again."

**Item 4, a failed Commons analysis** (heading "Couldn't analyze this reference.", Retry kept, raw text behind "Details")
- unavailable (network, timeout, connection error, provider 5xx, 408, 429, overloaded; reader couldn't start or gave no result) -> "The analysis service didn't respond."
- unreadable (image or video won't load, the model refused, or a result with nothing readable) -> "The analyzer couldn't read this image."
- other (anything else, an unknown kind, or none) -> "Something went wrong during analysis."

**Item 5, 404s the person reads** ("That {thing} isn't there anymore. Reload to get the latest {things}." unless noted; agents keep the specific text)
- Canvas: graph node PUT, model, label, layout; cinema and execute-node node lookups; node delete; pins -> "That node isn't on the canvas anymore." (round 2's line, kept)
- Runs `/api/runs/{id}` -> run/runs; shots -> shot/shots; render jobs -> render/renders; export and preview sources -> "That video isn't there anymore. Reload to get the latest outputs."
- Projects -> project/projects; trashed project restore/purge -> "That project isn't in Recently deleted anymore. Reload to get the latest list."
- Characters -> character/characters; boards -> board/boards; styles -> style/styles; moving a stored asset -> board/character/style; Recently deleted restore/purge of an asset -> "That {board|character|style} isn't in Recently deleted anymore. Reload to get the latest list."; acting on one in Recently deleted -> "That {…} is in Recently deleted. Restore it, then try again." (move: "… Restore it first, then move it.")
- Proposals (canvas and asset: get, withdraw, accept/reject) -> proposal/proposals
- Personal agents -> agent/agents; connected apps -> app/apps; Updates -> update/updates; notes -> "That note isn't there anymore. Reload to get the latest notes."
- Commons: collections -> collection/collections; references -> reference/references (and comments on one); a linked folder -> "That folder isn't linked anymore. Reload to get the latest folders."; a collection member -> "That reference isn't in this collection anymore. Reload to get the latest references."; a region -> "That region isn't on this reference anymore. Reload to get the latest version." (round 2); Blind labeling -> "That reference isn't in this held-out set. Reload to get the latest references."

**Item 6, Blind labeling and Agent review refusals, old -> new** (`backend/commons/evaluation.py`, `backend/commons/review.py`)
- "Need at least 45 distinct perceptual-hash clusters; found {n}. No batch created." -> "Blind labeling needs at least 45 references that look different from each other. You have {n}. Add more, then try again."
- symlinked folder -> "Choose the folder itself, not a shortcut to it."; a symlink inside it -> "A file in that folder is a shortcut. Replace it with the file itself, then scan again."
- over 5,000 files -> "Blind labeling can scan up to 5,000 files. That folder has more than 5,000. Choose a smaller folder, then try again."
- not a regular file -> "Blind labeling can only scan image and video files. Remove anything else from that folder, then try again."
- "File is still dataless after download." -> "A file in that folder is still only in iCloud. Download it in Finder, then try again."
- file size cap -> "Each file can be up to 500 MB. A file in that folder is larger. Remove it, then try again."
- source changed during scan -> "A file in that folder changed while Nebula scanned it. Try again."
- video with no keyframes -> "A video in that folder has no frames Nebula can read. Remove it, then try again."
- over 256 MB of images -> "Blind labeling can read up to 256 MB of images from one folder. That folder has more. Choose a smaller folder, then try again."
- relative path -> "Enter the folder's full path, starting with /."
- a batch already exists -> "This library already has a held-out set. Continue its labels." (sealed or closed: "This library already has a held-out set, and it is {sealed|closed}. Nebula can make only one held-out set per library for now.")
- library already has references -> "Blind labeling has to choose its references before any are added. This library already has {n}. Prepare the held-out set in a library with no references yet."
- no batch -> "There's no held-out set yet. Prepare a folder first."
- "Reference not found." -> "That reference isn't in this held-out set. Reload to get the latest references."
- integrity checks (three) -> "The held-out set doesn't match what was saved, so Nebula stopped and changed nothing."
- labels sealed -> "These labels are sealed, so they can't change."; closed batch -> "This held-out set was closed as assisted review, so its blind labels can't change."
- accent count -> "Mark between 1 and 100 accent points, or check “I don’t see any accent colors”."; accents saved -> "This reference's accents are already saved, so they can't change."; palette first -> "Save this reference's accents before you label its palette."
- keywords -> "Each reference can have up to 12 keywords. This one has {n}. Remove some, then save again."
- seal incomplete -> "Sealing needs every field labeled on all 15 references, with no review flags left. Finish them, then seal."; count -> "Sealing needs exactly 15 references. This held-out set has {n}."; unfinished -> "Sealing needs all 15 references labeled. {done} of 15 are done. Finish the rest, then seal."
- closed can't seal -> "This held-out set was closed as assisted review, so it can't be sealed."; agent-graded -> "The agent graded some of these references, so they can't be sealed as blind labels. Close them as assisted review instead."
- close needs confirmation -> "Confirm that these labels become assisted review, then close the batch."; sealed has nothing to close -> "These labels are sealed as blind ground truth, so there's nothing to close."
- Agent review: closed -> "This held-out set is closed, so the agent can't grade it again."; graded once -> "The agent has graded this reference once already. Nebula grades each reference only once."; budget off -> "Agent review is off on this Nebula. Start it with a call budget (NEBULA_COMMONS_REVIEW_CALL_BUDGET), then try again."; budget used -> "Agent review can grade {budget} references, and it has graded {used}. Restart Nebula with a larger call budget to grade more."; daily cap -> "Commons has made {calls} analysis calls today, and the daily cap is {cap}. Try again tomorrow, or raise Analysis calls per day in Settings." (review: was "made all {cap}", wrong when the cap was lowered below today's calls), and with the cap at 0 -> "Agent review needs at least 1 analysis call a day, and Settings has it at 0. Raise “Analysis calls per day”, then try again." (review; GM's rewrite after #168); not graded yet -> "Wait for the agent to grade this reference before you review it."
- Kept as they were: "Labels changed in another window. Reload before saving." and "A grading attempt is still running. Close after it finishes."

## Round 3b: Retry that retries, and the last internal words

Branch `fix/error-copy-3b`, from `a42ef37a` (#168's head). GM - Design owns the copy. GM, verbatim: "Never show raw error.message strings in UI."; "when the surface already has a retry button, the reason line drops its "try again". The button is the retry."; "make Retry redo the failed action, never a different one. If that's more than a small change, hide Retry for those failures instead. A Retry that does something else is a defect."; "People get the written line and agents keep the specific detail. Keep it that way."; ""settle" and "start" are internal."; the delete line "This node is still waiting on World Labs. Check the job in Marble, then {the node's actual button label} before you delete it."; and the pattern "say what's needed in plain words, give the count, then what to do."

### What changed and why

- **Projects' Try again redoes the failed action (item 1).** `store/projectStore.ts` records what failed beside every error (`errorRetry`: list/load, open, create, rename, delete, restore, purge, empty Recently deleted, cover, save) and `retry()` redoes exactly that. `projectRetryOffer(state)` tells `ProjectHome` what the button does: `redo` (the short line: the button is the retry), `reload` (Try again only reloads the saved projects, so the full line stays, which says so), or `none` (no Try again, full line). A refusal the backend made for good (`RequestFailedError` with a 4xx `canTryAgain` says no to) never offers Try again. Per failure:
  - Listing at startup or after a refresh: Try again lists again (redo). Kept as before. Review: a startup load refused for good (a 4xx) keeps Try again too, in the `reload` form with the whole line (see "Review (round 3b)").
  - Open answered 5xx or lost: Try again lists the saved projects, then opens that same project; if the first open had landed it shows it without a second open (redo).
  - Open refused (World Labs state, a 404, a params stop): the full line, no Try again.
  - Create whose reply was lost after the canvas was reserved: "Could not confirm the project change. Try again to reload saved projects safely." Try again reloads (`reload`, full line) and never creates twice. A create stopped before it was sent (a failed flush): Try again creates it (redo).
  - Rename, cover pin: Try again sends the same rename / pin (redo).
  - Delete, restore, delete for good, empty Recently deleted: Try again lists first, then redoes it only on what is still there (a delete that already landed sends nothing and shows the undo; a restore of something gone shows no Try again). Deleting the open project with no reply keeps "Could not confirm the project was deleted. Try again to reload saved projects safely." (`reload`).
  - Autosave: the canvas "Save failed · Retry" now calls `retrySave()` (it used to run Projects' list retry); its tooltip is the save's own short line. A later failure of another kind doesn't change what the save Retry does (`saveError` is kept apart from `error`).
  - Params-version stops that need a reload, a rebuild or a restart: no Try again. The recovered-project line and "follow another window" failures: Try again reloads (`load`).
- **Retry sweep (item 2), every retry button in the frontend, with its verdict:**
  - Projects Try again: fixed (above).
  - Canvas workspace controls "Save failed · Retry": fixed (saves; was a list reload).
  - Settings Try again: OK (re-reads settings, the failed action). Settings tab load boundary: no button.
  - Mask painter Try again (`DeferredPanels`): OK (loads it again); its line lost its "try again" (WRAP): "Couldn't load the mask painter. Check your connection." Other deferred boundaries: no button.
  - Chat model picker "Retry model discovery": OK (re-fetches the catalog).
  - Board and Character toolbar Retry and notices: OK (round 3).
  - Board/Character/Assets "Retry loading": fixed, hidden while no project is open (it ran `verifyProject` with nothing to verify, a no-op).
  - Commons detail analysis Retry: OK (re-analyzes). Cinema reference upload Retry: OK (re-uploads the same file, gated by `canRetry`). Create chips Retry / Attach again: OK. Cinema shot "Retry connection": OK (re-sends the handoff). Run History "Retry failed": OK (re-runs the failed run).
  - Undo in the delete toast (`UndoDeleteToast`): fixed. It showed any later delete's failure beside the earlier delete's Undo; `useAssetDelete` now keeps `deleteError` (the Studio notice) apart from `undoError` (the toast), and the toast shows only Undo's own failure, short (Undo redoes it).
  - Recently deleted (`AssetTrash` list): no retry button; it showed a thrown error's message, now `failureMessage` (a request's own line).
  - Agent notes corner, Commons leave popover: no retry button / OK (rounds 1-2).
- **Forget and unlock never show a raw message (item 3).** `graphStore.deleteProviderRecovery` throws `FailureNotice` (new in `lib/errorCopy.ts`: a written heading and reason) instead of `Error('Wait for the active run to finish before clearing recovery safety.')` and `Error('That durable provider recovery checkpoint is no longer current.')`. Run History and the status bar's unlock show `failureMessage(error, heading)`: a request's own line, the store's written one, or GM's general line, never another error's message.
- **World Labs refusals raised with a code at the source (item 4).** `ProviderStartConflictError` carries `reason` (busy, active, ambiguity, capacity, changed, recovery, params, cancelled) and `limit`/`fields`; `ProviderRecoveryCapacityError` carries `limit`. Each raise site sets them. `main.py` `_start_refusal` words the person's line from the code, never from the text, and `refusal_copy.refusal` gives agents, the CLI, MCP and scripts the exact old text. Same checks, same statuses (409). Lines under "Round 3b lines for GM".
- **Canvas Delete key on a held node (item 5).** It used to drop the press without a word. `graphStore.refuseHeldNodeDelete` puts "Couldn't delete the node." and the same per-state line the backend sends into the canvas's own notice (`undoNotice`), once per press; nothing is sent. `Canvas.tsx` uses React Flow's `onBeforeDelete` (store `allowCanvasDelete`), so the guard runs before React Flow removes the node's wires (before, a press dropped the wires of a node it kept). One source: the lines live in `lib/worldLabsWaiting.ts`, and `backend/tests/test_error_copy_round3b.py` pins them equal to `_paid_state_person`. Agent delete is untouched.
- **The canvas notice shows the whole line (found live).** The notice cut the line to one row with an ellipsis ("…Check the job…"), hiding the step, and left after 6 s. A notice with no button now wraps (`.canvas-undo-notice--message`) and stays for its reading time (`lib/canvasNoticeHold.ts`: at least 6 s, 2 s + 18 characters a second; about 11 s for the delete line). Notices with Undo/Redo are unchanged. This also fixes the wire-sync failure notices, which used the same one-row style.
- **Blind labeling intro (item 6).** Old: "Scan a local folder before importing it. Choose 15 references and 30 tuning references from distinct near-duplicate clusters, spread across subfolders. The held-out clusters stay quarantined." New: "Scan a local folder before you import it. Nebula picks 15 references to label and 30 to tune with, choosing references that look different from each other and spreading them across subfolders. It never uses the 15, or anything that looks like them, as examples."
- **Agent support.** No new tool or route: agents keep every specific text word for word (tested over HTTP, MCP stdio and the CLI). `docs/MCP-SETUP.md` (a paragraph under "Refusal text") and `skills/nebula/SKILL.md` say the World Labs refusals keep their exact text for agents. `backend/mcp_server.py` unchanged; its INSTRUCTIONS name only real tools.

### Decisions not in GM's message

- **A create is never redone blind.** A lost create reply may have made the project; a second create would make a second one. Its Try again reloads, and the line says that, so it keeps the full line (GM: hide or keep the full reason when Try again doesn't redo).
- **Delete-type redos list first.** Redoing a delete, restore, purge or empty blindly could act on something another window already changed; listing first keeps the redo to what is still there.
- **"Couldn't delete 2 nodes."** when a multi-select press holds a held node, with the canvas-wide line ("A node is … before you try again."). GM's words cover one node; for GM to confirm.
- **The notice's reading time** (18 characters a second) is mine; for GM.
- **The Run start "cancelled before it started" 409** keeps its text for everyone: it names no World Labs state and carries a run id (listed for GM).

### Tradeoffs

- `retry()` is a dispatch on the recorded action rather than a per-call closure, so the store stays serializable and testable; each action's redo lives beside the action.
- The notice now grows to three lines at 1280 for the delete line; it sits above the bottom toolbar and never covers the canvas controls.

### Tests (written first; each failed on the old code)

Red logs in the session scratchpad (`error-copy-3b/red-*.log`).
- Projects: `frontend/tests/projectStore.retry.test.ts` (16 tests, every failure above) red **14 failed, 2 passed** (the two that passed: the listing retry, and a delete whose reply was lost after it landed, which the old relist already handled); `ProjectHome.test.tsx` and `ProjectWorkspaceControls.test.tsx` (+1 each) red **2 failed, 24 passed**.
- Forget/unlock: `frontend/tests/providerRecoveryCopy.test.tsx` (5) red **4 failed, 1 passed** (the request's own line already passed); `RunHistoryPanel.test.tsx` pin updated to GM's general line.
- Delete key: `frontend/tests/store/graphStore.heldNodeDelete.test.ts` (5) red **5 failed**.
- Backend: `backend/tests/test_error_copy_round3b.py` (12: each start code for the person and the agent, both capacities, the codes set at the source, unlock in flight / changed / another process, forget changed, canvas capacity and race, and the frontend notice pinned to the backend's words) red **11 failed, 1 passed** (the pin passed because `worldLabsWaiting.ts` was written with the backend's words first).
- Intro: `tests/commonsEvaluation.test.tsx` (+1) red **1 failed, 6 passed**. Sweep: `tests/components/retrySweep.round3b.test.tsx` (4) and the mask painter line in `DeferredRetryPanels.test.tsx`, red **5 failed, 6 passed**.
- Notice (found live): `tests/components/CanvasUndoNotice.test.tsx` (+2) red **2 failed, 3 passed**.
- Fixtures updated to the new shapes (they failed in the full run, then passed): `AssetTrash.test.tsx` (the purge mock now throws what `purgeTrashed` really throws, a `RequestFailedError`), `DeferredLoadFailure.test.tsx` (the mask painter line), `App.canvasFocus.test.tsx` (an error fixture now carries its `errorRetry`, as the store always sets one).

### Live check

Isolated backend on 8783 through `iso.sh` (temp HOME, every NEBULA_* root in the scratchpad, no keys or tokens in its environment), Vite on 5783 with `VITE_NEBULA_BACKEND_PORT=8783`. 8000-8010 and 5173 blocked (CDP `Network.setBlockedURLs` plus the dead proxy `127.0.0.1:9`), canary 8799 unreachable, **0 blocked attempts**. Narrow CDP Fetch interception failed only the two requests named below. Nothing paid ran (the World Labs export node only carried a recovery ID). **38 PASS, 0 FAIL** at 1440x900 and 1280x800:
- Projects, open answered 503 (once): "Couldn't open the project. Nebula didn't respond." beside one Try again; Try again opened that same project (two open requests, both for it) at 1440 (Live B) and 1280 (Live A).
- An environment node wired to a World Labs export node holding a recovery record. Delete key on the export node: the notice "Couldn't delete the node. This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you delete it.", whole (wrapped, not clipped), still up after 6.6 s; no delete request reached the backend; both nodes and the wire stayed, at both sizes. The backend's own refusal for the page is the same line; an agent gets "Cannot delete n2: …".
- A refused open (Live B while A holds the record): "Couldn't open the project. A node is still waiting on World Labs. … before you try again." whole, no Try again, A still open, at both sizes. Over HTTP the page read that line; an agent header and a script got "Cannot switch projects while unresolved World Labs paid state exists. …".
- Run History "Checked Marble — forget" with the request failed offline (CDP): "Couldn't forget the recovery safeguard. Couldn't reach Nebula. Check your connection and try again."; the record stayed.
- A forget for an older job: the page got "This node is waiting on a newer World Labs job. Reload to see it, check it in Marble, then use “Checked Marble — forget” in Run History."; an agent got "World Labs recovery checkpoint changed; refresh before deleting the newer checkpoint".
- MCP stdio (63 tools): `open_project` and `remove_from_canvas` returned the exact "Cannot switch projects …" and "Cannot delete n2: …". CLI `nebula project open` and `nebula delete`: the same texts, exit 1.
- No page errors, no status code on screen. Servers stopped by port, state deleted.

### Gates

- Backend whole suite (`iso.sh`): **9782 passed, 71 skipped**.
- Vitest whole suite: first run **20 failed / 4700 passed** in 11 files; 17 were load timeouts (those files pass alone) and 3 were stale fixtures this round's changes broke (`AssetTrash.test.tsx`, `DeferredLoadFailure.test.tsx`, `App.canvasFocus.test.tsx`, fixed above). Second whole run: **4708 passed, 12 failed** in 5 files under full-suite load (CommandPalette, ResultsGallery, GraphFileActions, NodeLibrary, Settings: 5 "timed out" plus waits); those 5 files alone pass **127/127**.
- `tsc -b` clean; lint clean; `vite build` + budget **358,908 bytes raw** / 107,530 gzip (limit 512,000).

### Review (round 3b)

Two findings from the adversarial review, each checked by a refuter. Tests first: 4 new tests in `frontend/tests/projectStore.retry.test.ts` red **4 failed, 17 passed** on the uncommitted change (the fifth new test, a plain busy run keeping its Try again, is a guard and passed before and after); after the fix 21/21.
- **A 4xx at startup hid Try again and stranded the screen.** `initialize()` sent its failure through `showError`, which drops the retry for any refusal for good. A 4xx on the startup load (the active project deleted between the listing and its read, so its read gets a 404; or a refused recovered copy) left the Projects screen with no Try again while `initialized` stayed false, so New project, Open and Delete did nothing; only a page reload got out, and that throws away the unsaved work the recovered copy was keeping. Now `initialize()` always keeps Try again: a refusal for good gets `{ action: 'load', full: true }` (the `reload` form, with the whole line, since Try again only reads the saved projects again), anything else keeps `{ action: 'load' }`. Test: listing resolves, the active project's read rejects 404; offer is `reload`, and Try again lists again and reaches `initialized: true`.
- **A World Labs hold on the canvas got a Try again that could never work.** Opening another project, making a new one, or deleting the open project while a node holds an unconfirmed World Labs start (or Nebula couldn't confirm a World Labs run) is refused in the browser by `canSwitchProject()`, without a request. It showed "Finish or stop the current run …" (naming a run that may not exist, never World Labs or the unlock button) beside a Try again that redid the same check and failed every time until the person pressed “Checked Marble — unlock”. Now `activate()` (open and create, before and after the flush) and `remove()` (the open project) check for the hold first and show the backend's own line for that state, from `lib/worldLabsWaiting.ts` (`SOME_NODE_WAITING_UNLOCK`, already pinned to the backend's words): "Couldn't open the project." / "Couldn't create the project." / "Couldn't delete the project." + "A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you try again." No Try again (a `WorldLabsHold` error counts as refused for good), nothing sent. A run that is only going keeps the busy line and its Try again: that one can succeed once the run ends (tested). The same button label clears both kinds of hold (the status bar shows “Checked Marble — unlock” for an unconfirmed start and for an unconfirmed run), so one line covers both.
- **Live check (review fixes)**, isolated backend 8783 + Vite 5783 (`VITE_NEBULA_BACKEND_PORT=8783`), 8000-8010 and 5173 blocked (CDP `Network.setBlockedURLs` plus the dead proxy), canary 8799 unreachable, **0 blocked attempts**, nothing paid (the hold was written into the isolated guard file; unlock is a local request). **29 PASS, 0 FAIL** at 1440x900 and 1280x800: a startup read of the open project answered with the backend's own 404 body (replayed once by CDP Fetch) showed "Couldn't load the project. That project isn't there anymore. Reload to get the latest projects." whole beside Try again; Try again read it again and loaded the cards, and Open worked. With the hold on the open canvas, Open, New project and Delete (the open project) each showed GM's line whole with no Try again and sent no open, create or delete; after “Checked Marble — unlock”, Open went through. Screenshots in the session scratchpad (`error-copy-3b/review-fix/shots/`).
- **For GM:** the Projects lines for a hold, listed under "Round 3b lines for GM".

### Open items

- A recovered copy that the backend refuses for good (for example too large) is sent again by every Try again at startup and refused again; the screen keeps the whole line and Try again, but the only way past it is a reload, which drops that unsaved copy. This is how it was before round 3b; dropping the copy without asking would be worse. Needs a decision (offer "Continue without the copy"?).
- The status bar's "Paid start needs review." and the ambiguity/uncertain warnings (`AMBIGUITY_MESSAGE`, `WORLD_LABS_STATUS_UNCERTAIN_WARNING`) still use "paid start": status text, not refusals. For GM.
- `handlers/worldlabs.py` run errors ("paid-start safety hold …") are a node's run error, outside this round.
- `/api/quick` and `/api/execution-cancellations` 409s are agent-only; 5xx details stay (the person reads GM's no-response line).
- The Projects screen still shows the store's own written lines ("Finish or stop the current run …", "Could not confirm …" with "Could not", and the follow/params lines that put a reason in parentheses). Written, not raw, but older wording; for GM.
- A backend delete refusal (a race past the canvas guard) still alerts, while the guard uses the notice; one mechanism would be tidier.

## Round 3b lines for GM

Old -> new. Old is what the person read before (the guard's own text); agents, MCP, the CLI and scripts still get it word for word.

**Starting a run (Run, and anything that starts World Labs work)**
- "Fresh paid {kind} start is already active for node 'n2' in run 'r'" / "Fresh paid World Labs start is already active in run 'r'" / "… in another Nebula backend process" / "Cannot replace a paid-start intent owned by another backend" -> "A node is still waiting on World Labs. Let its run finish, then try again."
- "Fresh paid {kind} start is safety-locked after an ambiguous provider response for node 'n2'; check Marble and explicitly unlock that hold" -> "A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you try again."
- "Fresh World Labs start blocked because Nebula already has a recovery checkpoint for node(s): n2. Restore or explicitly delete the checkpoint before starting new paid work." -> a record: "A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — forget” in Run History before you try again."; an ID in the node's fields: "A node is still waiting on World Labs. Check the job in Marble, then clear the node's {field labels} before you try again."
- "World Labs paid-start safety journal is at capacity; resolve an existing recovery or ambiguity before starting more paid work" and "provider recovery journal is at capacity; resolve an existing checkpoint before starting more paid work" -> "Nebula can track up to {n} World Labs jobs that are still waiting, and this run would go over that. Check them in Marble, clear some with “Checked Marble — unlock” or “Checked Marble — forget” in Run History, then try again."

**Canvas edits**
- "provider recovery journal is at capacity; resolve an existing checkpoint before importing more paid state" -> the capacity line with "this change".
- "World Labs recovery checkpoint changed; use a new graph mutation identity" -> "A node's World Labs job changed while Nebula saved the canvas. Reload, then try again."

**"Checked Marble — unlock"** (heading "Couldn't unlock the node.")
- "Cannot acknowledge a World Labs paid-start ambiguity while that provider handshake is still active" -> "This node is still waiting on World Labs. Let its run finish, then try again."
- "World Labs paid-start ambiguity changed; refresh before acknowledging the newer hold" -> "This node is waiting on a newer World Labs job. Reload to see it, check it in Marble, then use “Checked Marble — unlock”."
- Another backend holding the lifecycle -> "A node is still waiting on World Labs. Let its run finish, then try again."

**"Checked Marble — forget"** (heading "Couldn't forget the recovery safeguard.")
- "World Labs recovery checkpoint changed; refresh before deleting the newer checkpoint" -> "This node is waiting on a newer World Labs job. Reload to see it, check it in Marble, then use “Checked Marble — forget” in Run History."
- Store (no request): "Wait for the active run to finish before clearing recovery safety." -> "Let the run finish, then try again."; "That durable provider recovery checkpoint is no longer current." -> "That recovery safeguard isn't there anymore. Reload to get the latest run history."; any other error -> "That didn't work. Try again, or reload if it keeps happening."

**Canvas Delete key on a held node** (new; before, nothing was said)
- "Couldn't delete the node." + "This node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you delete it." / "… use “Checked Marble — forget” in Run History before you delete it."; several nodes: "Couldn't delete 2 nodes. A node is still waiting on World Labs. … before you try again."

**Projects screen, World Labs hold on the open canvas** (review; no request is made)
- "Finish or stop the current run and let pending edits finish before switching projects." (opening another project, New project) -> "Couldn't open the project." / "Couldn't create the project." + "A node is still waiting on World Labs. Check the job in Marble, then use “Checked Marble — unlock” before you try again." No Try again.
- "Finish or stop the current run before deleting the open project." -> "Couldn't delete the project." + the same line. No Try again.
- Kept for a run that is only going (no hold): the two "Finish or stop …" lines, with Try again.

**Other**
- Mask painter: "Could not load the mask painter. Check your connection and try again." -> "Couldn't load the mask painter. Check your connection." (Try again beside it).
- Blind labeling intro: see item 6 above.
- Kept: "run 'x' was cancelled before it started" (a Stop that beat the run; no World Labs state).

## GM's read of round 3 (after #168) and what 3b took from it

- **Confirmed by GM**, verbatim: "#168 "Round 3 lines for GM" read in full. All four of your calls are confirmed: 1. "Couldn't unlock the node." / "Couldn't forget the recovery safeguard." 2. The four state versions, plus the canvas-wide "A node is still waiting on World Labs." set. 3. The two Recently deleted lines. 4. The cap-0 case." And: "Everything else stands as written, including the Blind labeling old → new list and the 404 set."
- **The cap-0 line**, GM's rewrite: "Agent review needs at least 1 analysis call a day, and Settings has it at 0. Raise “Analysis calls per day”, then try again." (`backend/commons/review.py`; the test in `test_commons_review.py` failed first on the old line).
- **The silent Delete notice** uses the node line for its state that already exists, as GM asked ("Don't add a new one"): `lib/worldLabsWaiting.ts` holds the backend's words, pinned equal by `test_error_copy_round3b.py`.
- **Open item (GM, not for now):** ""Checked Marble — unlock" and "Checked Marble — forget" are clumsy as button labels. If you touch them again, "I've checked Marble — unlock" or a two-step "Unlock…" with the Marble reminder in the confirm would read better."
- **Possibly the same note for GM:** the Commons status tooltip from #161 ("Library analysis is paused: Analysis calls per day is set to 0 in Settings, so it reads nothing. Raise it to resume.") and the daily-cap refusal ("…or raise Analysis calls per day in Settings.") name the setting the same way GM just rewrote; GM said everything else stands, so they are unchanged.
