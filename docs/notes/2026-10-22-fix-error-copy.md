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
