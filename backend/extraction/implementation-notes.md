# Extraction library: implementation notes

What it is: `backend/extraction/` turns still-image bytes into an `extracted-example/1` record (a draft schema)
and keeps it as plain files in a folder the person names. Round 1 measures only; no model reads the image yet.
Callers: `python -m extraction measure|list|show` and the `extraction_*` MCP tools. Nothing here imports `main`,
FastAPI, the Commons store or `commons.activation`, and importing it leaves the state folder alone
(`tests/test_extraction_measure.py` checks that in a fresh interpreter).

## Decisions beyond the brief

- `errors.py` holds `ExtractionRefused` and `StoreRefused`; `intake.py` re-exports the first.
- `intake` stats a `path` (when given) for the mtime and never reads it. `source.size` is the byte count of the
  data for every kind, not only files. `mtime` is UTC ISO to the second.
- `measure.py` calls `measure_image_stats`, which measures the palette again inside. The cost is a second 256 px
  k-means; the palette in the record is `commons.measure`'s, with indexes.
- `shows` evidence ids must exist: `P<index>` from the measured palette, or a region id in `structure.read.regions`.
  The builder drops entries with none that exists, and a correction that adds a show with none is refused.
- A whole show is added with `set` on `shows.<id>` (the id is the caller's); `origin` is the actor, `status`
  `proposal`, `decision_ref` null. `status`, `origin` and `decision_ref` of a show can't be corrected: accepting a
  show as a decision is a person's separate act.
- `structure.read.*` corrections are refused while `read` is null, and the read's provenance (`origin`, `model`,
  `prompt_version`, `read_at`) is never correctable.
- `add_corrections` is all or nothing, returns a copy, and caps a call at 50 corrections, a record at 1000, a
  value at 20,000 characters.
- `effective` skips a stored correction that no longer fits (and lists it under `corrections_skipped`) instead of
  failing, so one bad entry can't hide a record.
- `validate` allows status `proposal` or `approved` (approval fields together); nothing in this round sets approved.
- `store.replace` refuses an approved record. `store.load` takes a record folder or its `record.json`, not a
  folder of records (that is `list_records`). `list_records` shows an unreadable record folder as `{id, error}`.
- The forbidden folders are `~/.nebula` (HOME and the passwd home), `NEBULA_STATE_DIR` and this repo's tree.
  They apply to reads as well as writes. Listing and loading check the same list.
- The MCP read tools (`extraction_list`, `extraction_show`) are not added to the channel's change-turn allowlist.

## Tradeoffs and limits

- Two writers correcting one record at the same moment lose one correction (last rewrite wins); the app has one
  person. A lock file would fix it if that changes.
- Path checks use `realpath` then a lexical `islink` check; a path swapped between the check and the write is not
  defended against (the same limit `services/file_access.py` states).
- The folder guard is a deny list, so a person's own folder inside another app's data is allowed.

## Surprises

- `_measure_file` is cached by path and file version; tests clear it. `measure_image_stats` is the same dict
  byte for byte (`tests/fixtures/extraction/measure_file_v6.json`, made before the split).
- `apply_op` creates missing parents, so a correction to a show that doesn't exist would build a half entry;
  the show checks above stop that.

## Extraction page (round 2)

Run it: `cd backend && python -m extraction serve` prints one line, `http://127.0.0.1:8870/#token=<token>`, and
serves the built page from `frontend/dist-extraction/` (`cd frontend && npm run extraction:build` first; until
then `/` says to build it). For the Vite dev server: `python -m extraction serve --dev` in one terminal and
`npm run extraction:dev` in another, then open the printed address (port 5870, which proxies `/api` to 8870).
`--port` moves the server. The page is its own Vite build (`vite.extraction.config.ts`, entry `extraction.html`),
so the app's startup bundle is unchanged; `src/extraction/importBoundary.test.ts` fails if anything outside
`src/extraction/` imports it.

Guards (one ASGI middleware in `server.py`, before any route): `Host` must be `127.0.0.1:<port>` or
`localhost:<port>` (plus the 5870 pair with `--dev`), else 421. `/api/*` needs `X-Extraction-Token` equal to the
launch token (`hmac.compare_digest`), else 401. An `Origin` header must be exactly the page's own origin, so
`Origin: null` and any other origin are 403, and any POST without an Origin is 403. No CORS headers. The body is
read in the middleware and counted as it arrives: over the image cap plus 256 KiB is 413, by `Content-Length`
or by bytes read. The token lives in the URL fragment, which the browser doesn't send, and is never in a
response body, header or log (uvicorn's access log is off). The page keeps it in `sessionStorage` and clears
the fragment with `history.replaceState`.

Decisions beyond the brief:
- Order of checks is Host, token, Origin, size. A foreign Host never learns whether a token was right.
- The server buffers the whole body (at most about 25.25 MB) before routing, so the route sees a complete form
  and a body with no length can't skip the cap.
- Static files and error replies carry `X-Content-Type-Options`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY` and a CSP (`default-src 'self'`, images from `blob:` and `data:`). The page uses blob
  URLs for renderings because an `<img>` can't send the token header.
- `store.rendering_bytes` is new: it serves `rendering.png` with the same checks as `load` (no symlink,
  regular file, inside the record, a PNG, at most 128 MB, and only for a record that validates).
- Record ids in URLs must match `ex_` plus 16 hex digits before the store sees them. Unknown `/api/*` paths are
  404 JSON; any `/api/*` path needs the token first, even a path that doesn't exist.
- Static serving is a catch-all route checked by `realpath` against `dist-extraction` (symlinks that leave it
  are 404), not `StaticFiles`.
- The dev proxy keeps the browser's Host and Origin (`changeOrigin: false`), so `--dev` accepts the 5870 pair. The
  dev server has no `index.html`, so a proxy `bypass` on `^/$` serves `extraction.html` there instead of a plugin.
- The page remembers the last folder in `localStorage` and opens it on load. The list fetches every record's
  rendering for its 40 px thumbnail (full PNG, cached as a blob URL for the session). A folder with hundreds of
  large records would want a smaller thumbnail file; not done in this round.
- Several images are posted one after another through a promise queue; an image that fails is skipped with the
  server's sentence (prefixed with its name when there are several) and the rest go on. The last good one opens.
- A "Close" button in the record view returns to the drop area. Values from the model are not shown yet, so the
  "code" origin tag sits on every measured and source value.
- `vite.extraction.config.ts` isn't in `tsconfig.node.json`'s include (that file is outside this lane), so it
  isn't type-checked; Vite loads it as is.
