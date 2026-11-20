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
