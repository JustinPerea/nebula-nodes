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

## Reader extract-1, who may read, person corrections (round 3)

`extraction/reader.py` is prompt version `extract-1`. It calls `commons.reader.read_image` with its own
`system_prompt`, `schema` and `message` (all three optional there; left out, reader-1 is unchanged), so the
command's flags, the scrubbed environment, the no-tools check on the init event, the timeout, the tree kill and
the error kinds are Commons' own. Tests build both commands and compare them argument by argument: only the
values after `--system-prompt` and `--json-schema` differ. The model id is `commons.reader.MODEL_ID`, the image
goes through `composite_on` and `encode_png(max_edge=1568)` as in Commons, and the palette is listed as
`P<index> hex share`, no few-shots. reader-1's field text is imported (everything before its `regions` line) and
its validator is called on the output for the reader-1 part.

What a read stores: `structure.read` = `{origin, model, prompt_version, read_at, reader_1, regions, text,
spacing}` with fractions turned into whole pixels of the original image in code (`box_px`, `size_px`,
`outer_margin_px`, gap `px`), every size and spacing value marked `estimate: true`. A reference to a region id
that doesn't exist is dropped (a text run's region becomes null, a gap is dropped). The model's `shows` go to
`record.shows` through the existing builder (origin `model`, status `proposal`, evidence must exist).
Code then crops each region's box from the original and measures it: `structure.measured.region_measures[id]`
(top 4 palette entries, value range, `from_model_box: true`), and `structure.measured.region_gaps`: the pixel
gap for every pair of regions whose boxes don't overlap and whose spans overlap on exactly one axis (side by
side gives an `x` gap, stacked gives a `y` gap). That includes pairs with a third region between them; it is not
a nearest-neighbour list. `region_measures` is now a map (it was an empty list in measure-only records; the
measurer writes `{}`).

Replacing a read: `apply_read` keeps corrections as they are, replaces `structure.read`, the region measures and
gaps and the model-origin shows, keeps person and agent shows, and clears `read_requests` (the read answers them).
New model shows skip ids that a kept show or a stored correction already names, so an old correction can't land
on a new statement.

Known limit: corrections that point into the old read by id (`structure.read.regions.r1.role`,
`...text.t2.content`) are kept and apply to whatever region or run has that id in the new read, because ids are
r1.. and t1.. in order. A person should look at their corrections after reading again. Corrections to a model
show (`shows.s1.statement`) can't misapply this way (see above); they are skipped when the show is gone.

Who may start a read: only the person. The page's "Read with Claude" opens an inline confirm and sends nothing
until Read is pressed; `POST /api/records/{id}/read` (token, Origin and Host guards like every POST) runs it under
one lock per server (a second request gets 409), and a record that has a read needs `again: true`. The CLI's
`python -m extraction read <record>` needs `sys.stdin.isatty()` and `sys.stdout.isatty()` and the word `read`
typed; there is no `--yes`; without a terminal it refuses with a sentence pointing at the page. No MCP tool reads:
`extraction_request_read(record, reason)` appends `{actor: "agent", at, reason}` to `read_requests` (reason at
most 300 characters, at most 20 waiting; refused beyond that rather than dropping an older one) and the page
shows each above the Read button. A test asserts that no extraction MCP tool mentions the reader, and that
`mcp_server.py` doesn't import it. `read_requests` is absent on records saved earlier; they load.

The read can take minutes, so the server asks the model first and applies the result to a fresh load of the
record, so a correction made meanwhile is kept (tested). A failed read changes nothing and answers 502 with a
plain sentence per error kind.

`serve --fake-reader FILE` (development only) answers every read with that file's structured output through
`validate_read`/`apply_read` and records `model: "fake-reader"`; no process is spawned. It refuses to start unless
`EXTRACTION_ALLOW_FAKE_READER=1` is set too, so a normal launch can't reach it. The page marks a fake reading three
ways: a "Fake reading" chip beside the status, a notice in the read section saying the development reader wrote it,
and "fake reader" origin tags on its values.

A read request from an agent never starts a read: the page calls the read endpoint only from the confirm's Read
button (`requests.test.tsx` checks there is one call site), and loading a folder, opening a record or dropping the
same image again run no reader (`test_a_pending_request_never_starts_a_read_on_its_own`). Fixtures: `tests/fixtures/extraction/landing.png` (made by a throwaway PIL script)
and `fake_read_landing.json`. The reader tests replace `read_image`'s default spawn with one that raises, so a
test that forgets to inject a fake fails instead of calling `claude`.

Corrections: `POST /api/records/{id}/corrections` takes `{folder, corrections}`; the actor is always "person" and
any actor in the body is ignored. The page edits a region's role and label, a text run's words and weight and a
show's statement; each saves one correction and shows "you". The page renders the `effective` view and tags each
value from the saved record's corrections.

Other decisions: the overlay frame is sized with container query units (`cqw`/`cqh`) so boxes in percentages
land on the drawn image; `validate_read` returns `(read, shows)` and takes `model` and `read_at` keywords;
a fully transparent image is refused before sending (as Commons does); the source section's "Read" row is now
"Added" so it can't be taken for the Claude read. Not done: no Approve button (approval is the Viewer's), no
editing of spacing, reading fields or evidence on the page, no smaller thumbnail file.

## Replace keeps what it doesn't measure (review fix)

`save(replace=True)` used to write a fresh record and carry over only the corrections, so it dropped the reading,
region measures, every show and pending read requests. Now `record.carry_over` keeps the old record and replaces only
what measuring gives again: `rendering`, `source` and `structure.measured` (`REPLACE_RECOMPUTES_TOP` and
`REPLACE_RECOMPUTES_STRUCTURE`). With the image passed in, the reading's regions are measured again; without it the
old region measures stay. A show keeps only evidence ids that still exist; a show left with none is dropped and
returned as `dropped_shows` (the CLI prints them). `dropped_shows` also lists shows that corrections added and
the corrections aimed at any dropped show (they stay in the record and show under `corrections_skipped`).

The keep and recompute lists are declared next to each other (`REPLACE_KEEPS_TOP`, `REPLACE_KEEPS_STRUCTURE`). Because
`carry_over` starts from a copy of the old record, a field added to `build_record` would be kept by default, and a
field that depends on the image would then go stale. `test_extraction_replace.py` therefore fails unless every key
`build_record` makes (top level and under `structure`) is on exactly one list, and it changes the old record before
replacing (stale values in recomputed keys, sentinels in kept keys) to check that recomputed keys refresh and kept keys
hold. An earlier version of this note claimed the old test caught a new field. It didn't: it built both sides from the
same image, so a new image-derived field outside the recompute sets passed.

## Corrections keep the reading's shape; the store writes only what it reads back (round 5)

- `structure.read.*` corrections are leaves only (`record._check_read`): a region's `role` and `label`, a text run's
  `content`, `weight` and `type_style`, a `reader_1.<field>.value` that is text or an enum, and `reader_1.keywords`
  (add or remove one vocabulary word). A whole region, run, box or provenance field is refused with a sentence that
  names what can be corrected. `effective()` skips a stored correction that would leave a region or run without a valid
  box (`read_malformed`) and lists it, for records written before this. `brand` is text or null.
- Caps fit the 5 MB read limit: a value is at most 2,000 characters and 4 levels deep, a stored correction at most
  4,096 bytes as indented in `record.json`, 1,000 per record (about 4 MB). The store also refuses any dump over
  `MAX_RECORD_BYTES` before touching a file, so a record it writes is one it reads.
- Every change to an existing record holds `flock` on `<id>/.lock` (`store._locked`, `O_NOFOLLOW`) across load, change
  and write: `modify`, `correct`, `request_read`, `write`, and `save`. The server's and CLI's read release the lock for
  the model call and apply the reading through `store.modify`, which loads again inside the lock.
- An agent's correction is refused when it touches a show whose origin is "person", or sets a path whose latest
  related correction is a person's, or reverses a keyword a person added or removed. A person can still change an
  agent's work.

## A late answer doesn't replace the record on screen (review fix)

A read or correction can finish after the person opened another record. `App` passes `changeDetail`, which takes an
answer only when its record is still the selected one (`detail.ts`); `lateAnswer.test.tsx` holds it.

## Design sign-off (round 4)

- Each section label carries one origin ("Regions · Claude", "Measured · code"); a row shows a tag only when a
  correction changed it, and a show keeps its own origin when a person or agent added it. The "estimate" pill is
  gone; the "≈ 52 px" value carries `role="img"` and an `aria-label` of "estimated 52 pixels".
- `measured.lightness` is the mean CIELAB L* (0-100, one decimal) of the pixels the palette reads;
  `measured.saturation` is the moodboard's mean (its formula is (max-min)/max, which is HSV saturation, not HSL) divided
  by 255 times 100, and `measured.units.saturation` says "HSV saturation 0-100". `measured.units` names the scales. A record without `units` shows lightness and saturation "of 255",
  and its spread "of 100" so the three lines can't be misread together.
- Region boxes are bare two-tone outlines (1px white inside the edge, 1px black just outside). A role label shows
  on a hovered, focused or selected box. Selecting: click a box, its id button or its row (not a field);
  click again or press Escape to clear. Focus in a row's field counts as hovering that region.
- Outline contrast check: for every colour on a 5-step RGB grid (140,608 colours) the better of the two lines
  holds at least 4.58:1 (WCAG ratio); the white line fails 3:1 above relative luminance 0.30 and the black line
  below 0.10, so the two cover each other. On the 12,312 edge pixels of the landing fixture's boxes the best of the
  two is at least 6.01:1.
