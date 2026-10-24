# 2026-10-24 — A browser TypeError no longer says the server isn't answering

Branch `fix/typeerror-not-connection`, from main at c9e1ff3d (#189 merged).

No question went to Justin: this is a bug found during the GM copy batch, fixed under his standing rule to complete fixes as soon as we run into them. No copy changed; the existing lines are reused.

## What changed and why

- **The bug.** `copyForError` (frontend/src/lib/errorCopy.ts) said "Nebula's server isn't answering. Make sure it's running, then try again." for any TypeError, through `isConnectionFailure` (`error instanceof TypeError || AbortError`). That check was written for fetch's own rejection, but `copyForError` runs on any thrown error, and plenty of browser-side failures are TypeErrors too: `JSON.stringify` of a BigInt or a cycle, reading a property of undefined or null, a bad argument to a DOM API (`new URL('x')`, `URL.createObjectURL`). The person was told to restart a server that was fine. ChatPanel's `isBackendUnavailableError` did the same (`instanceof ConnectionLostError || instanceof TypeError`) and showed "Nebula backend offline" with the start-backend hint.
- **The fix is where fetch is called.** A no-answer becomes a `ConnectionLostError` at the fetch call. Everything downstream relies on that class, never on `instanceof TypeError`.
  - New `fetchUrl(url, init, heading)` in lib/backend.ts: plain fetch for a URL apiFetch doesn't make (asset links, public URLs), with no Nebula headers, no person token and no discovery replay. Its no-answer becomes a ConnectionLostError under the heading, and the caller's own abort passes through. apiFetch's own `send` now uses it, so there is one classifier.
  - The raw-fetch sites that feed copy now use it: MeshPreview (3D preview), worldDownload, worldSplat and canvasSelection (Download outputs). The first three had copies of the same try/catch; canvasSelection had a fourth variant.
  - New `isNoAnswer(error, signal)` in errorCopy.ts: a ConnectionLostError, or an AbortError the caller didn't ask for. `copyForError` (and so `failureCopy`, `failureMessage`, `failureUnder`) uses it, as do providerReadinessStore and cinemaMotion, which used to call `isConnectionFailure` on whatever their try block threw.
  - ChatPanel's check drops `|| error instanceof TypeError`.
  - `isConnectionFailure` keeps its fetch-site meaning and is now used only on fetch's own rejection: in `fetchUrl`, and on the Commons call's body read (commonsApi, "the connection dropped while the body was arriving").
  - `ConnectionLostError` still extends TypeError. The class comment now says a TypeError is not one.
- **Audit of every raw fetch in frontend/src (8 calls).** apiFetch's send and the four asset sites now go through fetchUrl. Three were left alone because their failures never reach copy: the discovery probe (backend.ts `probeBackendBaseUrl`, which turns any failure into "not this port"), the bundle asset fetch in graphFile.ts (it logs and skips the asset), and LottieRenderer (it clears the animation). They don't feed copy, so they don't need classifying. No XMLHttpRequest or EventSource. The two WebSockets (wsClient, ChatPanel's /ws/chat) report through onclose and never reach copyForError.
- **Audit of the consumers.** There are 7 files that call isConnectionFailure/copyForError and many failureMessage/failureCopy callers. They all now go through isNoAnswer except the two fetch-site uses above. `instanceof TypeError` meaning offline was only in errorCopy.ts and ChatPanel.tsx.

## Decisions not in the spec

- **fetchUrl lives in lib/backend.ts, beside apiFetch and backendAssetUrlSync.** Routing the asset links through apiFetch would have been wrong: apiFetch joins an API path to the discovered base, adds the params/tab headers and the person token, and replays GETs against a rediscovered backend. An asset link is already a full URL.
- **An AbortError the caller didn't ask for still means no answer.** The spec kept this, and apiFetch already converts such an error into a ConnectionLostError. Small change: the asset sites used to rethrow any AbortError. They now convert one the caller didn't ask for, as apiFetch does. In practice nothing changes, because each of those sites aborts only through its own controller.
- **The ChatPanel message checks stay** ("failed to fetch", "load failed", "network", "status failed: 50x"). They are outside this bug. See open items.

## Tradeoffs

- **A connection that drops while a body is downloading.** The answer came, then the body read fails with fetch's TypeError. On the asset sites (MeshPreview, worldDownload, worldSplat, canvasSelection) this keeps the connection line: `readBoundedAssetResponse` classifies it at the read (see Review). Through apiFetch callers, a failing `response.json()` now reads GM's general line ("Try again, or reload if it keeps happening.") rather than the connection line. Those bodies are small and the backend runs on this computer, so this is rare. Both lines tell the person to try again, and neither points them at the wrong fix. The Commons calls keep the connection line for it (their body read is classified at the call). Classifying every `response.json()` would mean wrapping the Response that apiFetch returns. A body-stream TypeError ("body already used") is a bug, not a dropped connection, so that wrapper would also need the bodyUsed check. Left as an open item.

## Surprises

- 12 assertions in 8 existing test files had apiFetch mocks reject with a bare `TypeError('Failed to fetch')`, which the real apiFetch never throws. Their assertions only passed because of this bug. They now reject with `ConnectionLostError` (what apiFetch throws), and two tests that pinned the old behaviour now pin the new one: the errorCopy kind table, and commonsEvaluation's "a fetch error that didn't come through the API".
- When the backend is stopped in a plain browser tab, it reads "Nebula's backend isn't running. Start it, then reload." (BACKEND_NOT_RUNNING_COPY, discovery's no-answer line), not CONNECTION_LOST_COPY. Both are ConnectionLostErrors, and this was already the behaviour.

## Tests

- Tests first. On unchanged code, 16 new or changed tests failed across 6 files:
  - tests/lib/errorCopy.typeError.test.ts (new): BigInt, cycle, property-of-undefined and bad-URL TypeErrors gave the connection line instead of the general one. `isNoAnswer` and `fetchUrl` didn't exist. canvasSelection and worldDownload gave the connection line for a `URL.createObjectURL` TypeError after the answer.
  - MeshPreview: a createObjectURL TypeError read "Couldn't load the 3D preview. Nebula's server isn't answering…".
  - errorCopy.round3c2 (Cinema handoff): a TypeError after the answer read "…Nebula didn't respond." instead of "Couldn't confirm the video connection."
  - kreaConnection and providerReadinessStore: a non-fetch TypeError gave the connection line.
  - ChatPanel.offline: a TypeError showed "Nebula backend offline" instead of "Claude status unavailable".
- Each converted site is pinned both ways: a rejected fetch gives the connection line (or a ConnectionLostError, for worldSplat, whose viewer writes its own line), and a non-fetch TypeError after the answer gives the general line. `isConnectionFailure` still recognises fetch's own TypeError.
- Agent support: this is browser-only copy classification. No MCP tool, `nebula` CLI text, INSTRUCTIONS paragraph, docs/MCP-SETUP.md or skills/nebula/SKILL.md text changes. The diff touches only frontend/src and frontend/tests.

## Live check

- Isolated stack: backend on 8797 and Vite on 5797 with `VITE_NEBULA_BACKEND_PORT=8797`, temp HOME and NEBULA_* roots through iso.sh, no keys. The assigned builder port 8791 was taken by another session's `python -m http.server`, which I left alone. Puppeteer at 1280x800 and 1440x900. CDP blocked 8000-8010 and 5173, and the dead-proxy layer was on (a canary on 8798 couldn't be reached). **Blocked request attempts: 0.**
- A real path with a non-fetch TypeError: the page answered `/api/agents/claude/status` with `null` (injected in the page, never sent to the backend), so ChatPanel's `status.installed` throws a TypeError in the browser. The chat header read "Claude status unavailable", titled "Couldn't check Claude status. Try again, or reload if it keeps happening.", with no "Backend offline" and no "isn't answering".
- I then stopped the backend. The same panel read "Nebula backend offline", titled "Couldn't check Claude status. Nebula's backend isn't running. Start it, then reload.". 7/7 checks passed.

## Review

- Two refuters confirmed one regression, found on the asset sites: a connection that dropped while a 3D model, world or SPZ was streaming lost the connection line. fetchUrl classified only fetch()'s own rejection. The body read in `readBoundedAssetResponse` rejected with fetch's plain TypeError, which copyForError no longer treats as no-answer, so the person saw "Couldn't load the 3D preview. Try again, or reload if it keeps happening." On main that case said "…Nebula's server isn't answering…".
- Fix, at the read (lib/boundedAsset.ts): only the `reader.read()` and `arrayBuffer()` rejections are wrapped. A TypeError there becomes a ConnectionLostError under the caller's heading (new optional `{ heading }` argument: MeshPreview's, worldDownload's, worldSplat's LOAD_WORLD, canvasSelection's DOWNLOAD_OUTPUTS). `getReader()` on a locked body, and a used body (new `bodyUsed` check before `arrayBuffer()`), stay plain TypeErrors, because they're bugs. An AbortError comes back unchanged. A caller that passes no heading (graphFile, which only logs) gets a heading-less ConnectionLostError, and failureMessage supplies the catch's own heading.
- Same path, older bug: canvasSelection's `catch {}` around the read turned every failure into "Node … is too large for the ZIP", a dropped connection included. It now rethrows anything that isn't AssetByteLimitError, so the toolbar shows "Couldn't download the outputs." with the connection line. The too-large lines are unchanged. This was the third open item and is closed.
- Tests first: 6 new tests failed on the pre-review code. In tests/lib/boundedAsset.bodyDrop.test.ts (new): the read gave a plain TypeError, not ConnectionLostError (2 tests). downloadWorldAsset read the general line, fetchWorldSplatBytes threw a plain TypeError, and downloadSelectedOutputs said "Node n1 is too large for the ZIP." In MeshPreview.test.tsx, the preview read the general line for a stream that errors mid-body. Three guard tests passed before and after: a locked body, a used body and an AbortError mid-read are not reclassified.
- Live check (backend 8791, Vite 5791, `VITE_NEBULA_BACKEND_PORT=8791`, iso.sh env, no keys; CDP blocks 8000-8010 and 5173 plus the dead-proxy layer, canary on 8798 unreachable). A stand-in server on 8791 sent headers and 4 KB of a 200 KB body, then dropped the socket. Chrome reported `ERR_CONTENT_LENGTH_MISMATCH`, and the real fetchUrl + readBoundedAssetResponse in the page gave a ConnectionLostError with the connection line under each heading (3D preview, 3D model download, world). A full answer followed by the browser's own `URL.createObjectURL` TypeError gave the general line. With nothing on 8791, fetchUrl gave the connection line. 8/8 checks. **Blocked request attempts: 0.**
- Surprise (dev only): in dev the page's base is '' and asset links go through the Vite proxy. When the upstream drops mid-body, Vite's proxy leaves the page's response hanging rather than erroring, so the live check fetched the stand-in directly, as the desktop shell reaches the backend. With the backend stopped, an asset link through the proxy is a 502 ("Nebula didn't respond. Try again."), as on main.

## Open items

- A body read that fails after the answer, through apiFetch: see Tradeoffs.
- ChatPanel's `isBackendUnavailableError` message checks are mostly dead now. The status calls go through apiRequest, so their errors never carry "Failed to fetch" or "status failed: 50x". The "network" substring could flag a 4xx whose written reason contains that word. Worth replacing with `kind`/`status` in a follow-up. A 502 from the Vite proxy (`RequestFailedError` status 502) isn't read as offline today.
- Dev only: Vite's proxy hangs the page's response when the backend drops mid-body (see Review). Not this bug, and the desktop shell doesn't use the proxy.

## 2026-10-24 — Second pass: body reads after the answer, and Chat's "backend offline"

On top of 2246aad6, same branch. It closes the first two open items above. Justin's standing rule: complete fixes as soon as we run into them; correct over easy. No copy and no agent-facing string changed.

### What changed and why

- **A body that drops after apiFetch answered.** `fetchUrl` (lib/backend.ts), and so `apiFetch`, now hands out the Response with its whole-body reads classified (`classifyBodyReads`). When `json()`, `text()`, `blob()`, `arrayBuffer()` or `bytes()` rejects with fetch's own TypeError, it becomes a `ConnectionLostError` with that TypeError as its cause. For apiFetch it has no heading: apiRequest's callers and the failure helpers add theirs. A fetchUrl caller's heading is used. Before this, the first pass had made such a read say GM's general line. On main it said the connection line, but only because any TypeError did.
- **What stays as it was:** reading a body that is already used or locked is a bug, so it keeps its plain TypeError (checked with `bodyUsed` and `body.locked` before the read). A JSON SyntaxError, an AbortError and anything the caller throws while handling the body also keep their class, and all of them say the general line.
- **Narrow mechanism:** it is the same Response object. Only the body-read methods and `clone()` are shadowed on that instance, and `clone()` returns a classified clone, so `notePersonRequired`, `noteParamsOutdated` and api.ts's `clone().json()` reads are covered too. Status, headers, url, `bodyUsed`, `instanceof Response` and identity don't change. An answer that isn't a real Response (a test double) is handed out untouched. A plain object's `json()` can throw any TypeError, so it can't be classified safely.
- **Commons call:** its body-read catch asked `isConnectionFailure` (any TypeError). It now asks `isNoAnswer`, so a used body no longer reads as "Nebula's server isn't answering". `isConnectionFailure` is now called only in fetchUrl, on fetch()'s own rejection.
- **Chat's "backend offline":** `isBackendUnavailableError` (ChatPanel.tsx) no longer reads the message. It now checks `isBackendUnreachable` (new, in errorCopy.ts), plus any error that carries the no-answer status (a Commons call's). `isBackendUnreachable` is true for no answer (`isNoAnswer`), or for a gateway's 502/503/504 with no written reason from the backend. The checks for "failed to fetch", "load failed", "network" and "status failed: 50x" are gone. A 4xx whose reason says "network" is now the backend answering.

### Decisions not in the spec

- **Which statuses mean the backend is unreachable:** 502, 503 and 504, and only with no `detail`. Vite's dev proxy answers an empty `502` for a stopped backend (checked in node_modules/vite: `res.writeHead(502)` in its proxy error handler), and other proxies use 503 and 504. The backend's own 503s (HTTPException) always carry a written `detail`, so they count as the backend answering. A 500 is the backend answering too. The old message check named `status failed: 500`, but nothing produces that text any more. apiFetch's own `TRANSIENT_PROXY_STATUSES` still includes 500, because that set only decides whether to rediscover, which is safe to do more often.
- **Where the body reads are classified:** in fetchUrl, not only in apiFetch. The asset sites go through fetchUrl as well, so every Response that Nebula's own fetch hands out behaves the same. readBoundedAssetResponse still classifies its own stream reads. When the error is already a ConnectionLostError, it only adds its heading.
- **Not wrapped:** `formData()`, because it rejects with a TypeError for a body that isn't form data, and nothing calls it on an apiFetch answer. `response.body` stream readers aren't wrapped either. Their one consumer, readBoundedAssetResponse, already classifies its own reads. Wrapping the stream would change its identity and buffering for every caller. Audit: no apiFetch caller reads `response.body`, and there is no SSE or EventSource consumer. The two WebSockets don't go through fetch.

### Tradeoffs

- The classification goes by "a TypeError from a real Response's body read on a body that wasn't used or locked". For whole-body reads, browsers only reject with a TypeError for a network failure or a used or locked body. Text decoding substitutes bad bytes rather than throwing.
- The patch puts own properties on the Response instance. A subclass would have needed `new Response(body, init)`, which loses `url`, `redirected` and `type`. A Proxy would break `instanceof` checks and private-slot calls (`Response.prototype.json.call(proxy)` throws).

### Surprises

- Chrome words the body-read rejection exactly like fetch()'s own: `TypeError: Failed to fetch`, not "network error". Only the stage tells them apart. The live check confirmed that apiFetch had answered 200 before `json()` rejected.

### Tests

- Tests first. On 2246aad6, 14 new tests failed across 3 files:
  - tests/lib/apiFetch.bodyDrop.test.ts (new), 8 failures: `json()`, `text()`, `blob()` and `arrayBuffer()` on a body that drops mid-read gave a plain TypeError (4). A clone's read did the same. fetchClaudeStatus gave the general line. fetchUrl's read had no heading. Seven guards passed before and after: a used body, a locked body, a JSON SyntaxError, the caller's own abort, a TypeError the caller throws, a test double handed out untouched, and the same object/status/headers/clone/bodyUsed.
  - tests/ChatPanel.offline.test.tsx, 6 failures: a 400 whose reason says "network" read as offline. A plain `Error('Failed to fetch')` read as offline. Empty 502, 503 and 504 answers didn't read as offline (3). An AbortError nobody asked for didn't either. Two guards passed before and after: the backend's own 500, and a 503 with the backend's written reason.
  - tests/commonsApi.errorCopy.test.ts, 1 failure: a used body read as a lost connection. The mid-body drop test passed before and after; the Commons call already classified that case.
- After the change, all 44 tests in those three files pass. The focused run covers every test file that stubs global fetch (and so runs the real apiFetch/fetchUrl) plus the ChatPanel, Commons and errorCopy files: 43 files, 876 tests passed.
- Agent support: browser-only error classification. No MCP tool, `nebula` CLI text, INSTRUCTIONS paragraph, docs/MCP-SETUP.md or skills/nebula/SKILL.md text changes.

### Live check

- Setup: backend on 8793 (iso.sh: temp HOME and NEBULA_* roots, no keys) and Vite on 5793 with `VITE_NEBULA_BACKEND_PORT=8793`. Puppeteer ran at 1280x800 and 1440x900. CDP blocked 8000-8010 and 5173, and the dead-proxy layer was on (a canary on 8798 couldn't be reached). **Blocked request attempts: 0.** 15/15 checks passed.
- In-page answers for `/api/agents/claude/status` only, never sent to the backend. A 400 whose reason said "network" read "Claude status unavailable", titled "Couldn't check Claude status. The network policy on this machine blocks the Claude CLI.", with no "Backend offline". An empty 502 read "Nebula backend offline", titled "…Nebula didn't respond. Try again.".
- With the real answer back, the panel read "Claude not installed". With the backend stopped, it read "Nebula backend offline", titled "…Nebula's backend isn't running. Start it, then reload.", with the start-backend hint.
- A stand-in server on 8793 sent 200 headers and part of the JSON, then dropped the socket. The page sent the status call straight to 8793, as the desktop shell reaches the backend. Through the Vite proxy the page's response hangs instead (first pass). apiFetch answered 200, then `json()` rejected with a ConnectionLostError whose cause was Chrome's TypeError. As a control, the raw fetch's `json()` rejected with a plain TypeError, which is what apiFetch handed out before. `fetchClaudeStatus` and the Chat panel's title both said "Couldn't check Claude status. Nebula's server isn't answering. Make sure it's running, then try again."

### Open items

- First pass's items 1 and 2: closed. Item 3 (Vite's proxy hanging on a mid-body drop) is unchanged and dev only.
