# Paper backend verification

2026-10-01, isolated `paper-linked-source` checkout.

The tests use portable in-memory Paper capture/tool fixtures and temporary
SQLite/media stores. The mounted HTTP checks run against the actual Nebula
FastAPI application. They never edit a real Paper document or invoke a provider.

```sh
cd /Users/justinperea/.codex/worktrees/paper-linked-source/nebula_nodes/backend
/Users/justinperea/Developer/projects/nebula_nodes/backend/.venv/bin/python -m pytest tests/test_paper_sources.py tests/test_paper_routes.py -q
```

Current Paper coverage: **105 checks** across `test_paper_sources.py`,
`test_paper_routes.py`, `test_paper_transport.py` and `test_paper_replay.py`.
The combined Paper/cache/utility/Video QC gate passed **150 tests** before the
three final SDK exception-group regressions were added.

The final **full backend suite passed 2,542 tests** in 61.54 seconds, with 12
inherited FastAPI startup deprecation warnings and exit code 0. This run includes
the final pin, cache, rooted-membership, background-setting, replay and grouped
Paper-error changes. The utility manifest and catalog-count checks pass with the
additive Paper node. No packages were installed or upgraded.

```sh
/Users/justinperea/Developer/projects/nebula_nodes/backend/.venv/bin/python -m pytest tests -q
```

Verified behavior:

- Artwork A and B have distinct immutable paths and SHA-256 hashes. Refreshing
  unchanged PNG bytes does not claim an update or duplicate snapshot history.
- Stable file/page/object IDs survive rename and selection changes. Exact-object
  CLI lookup/export mismatches fail; the adapter never searches for a same-name
  replacement or falls back to selection.
- The CLI checks reciprocal object/ancestor membership rooted on the exact page
  before and after export. Surviving deleted-object metadata cannot masquerade
  as live artwork. The adapter checks the original export path is absolute before
  canonicalizing it. SDK teardown exception groups preserve a validated missing
  state; unrelated failures remain sanitized as unavailable.
- Missing-object and disconnected refresh failures return the last good snapshot
  with a failure state and retain the previous successful-refresh timestamp.
- Explicit reconnect retains source ID/history. Reconnecting back to an earlier
  exact source/snapshot reuses its immutable capture record without duplication.
- A late success or failure cannot replace a newer accepted snapshot/state.
  An obsolete distinct export never enters accepted source history. A fresh
  store instance recovers source identity and both snapshot records.
- Alpha/transparency fields report actual exported pixels, including RGB and
  fully opaque RGBA exports. Export settings record the artwork background;
  there is no unsupported transparent-background override or inferred alpha.
- The handler consumes saved snapshot A after the live source refreshes to B,
  without contacting Paper. Missing bytes, changed bytes and wrong expected
  hashes stop execution.
- Execution requires complete lowercase 64-hex snapshot ID and expected content
  hash. Missing/null/empty/truncated/uppercase/non-hex/non-string fields fail
  before lookup. An ordinary graph cache preseeded with unrelated artwork cannot
  substitute its path or bypass a fresh integrity check of damaged source bytes.
- A real engine run passes A into a deliberately blocked deterministic fixture;
  refreshing to B does not invoke the fixture. That run finishes using A, then an
  explicit second run consumes B through the same edge and recipe version.
- The engine writes an immutable `paper-inputs.json` receipt before dispatch.
  It contains the exact accepted source snapshot, input identity, saved recipe
  and canonical recipe hash. A/B with the same settings share a recipe hash;
  changing a seed changes that hash. Recursive provider-prefixed API-key,
  authorization, bearer-token and client-secret fields are removed from the
  receipt. Earlier receipts and fixture output bytes survive the new run.
- Existing OpenAI image-edit input preparation reads the exact PNG bytes for
  multipart upload; Runway input preparation embeds the exact bytes in a PNG
  data URI. These checks do not submit either provider request.
- Actual mounted refresh/reconnect routes never call `execute_graph`. Snapshot
  delivery serves the exact PNG with immutable caching and rejects damaged files.
- Adopting B in the CLI graph retains downstream A outputs and the saved edge.
  Late run A output/parameter synchronization cannot rewind the live source to A.
- Replaying a compact accepted B run at the same sequence cannot replace full
  `[A, B]` history with `[B]`. Replaying an older A afterward cannot rewind it.
  Graph export reads canonical source-store history/state if a prior compact
  payload already truncated CLI params. This read repairs the rendered history
  and current failure label without contacting Paper or dispatching execution.
- A never-successful link preserves the exact requested IDs with unavailable
  state and no invented names/snapshot. Export renders it idle with no image.
- Open-source HTTP metadata reports the supported file-navigation fallback
  honestly, without claiming exact-object navigation. CLI open normalizes the
  real `open_file` response shape and requires the exact returned file ID;
  a prefix collision such as `file-1` versus `file-10` cannot claim success.
  Exact IDs alone can also open the file before a first successful export has
  supplied readable labels and navigation metadata.

Proof limits: these tests establish the portable transport/snapshot/HTTP/engine
contract. Live Paper export/edit acceptance, browser stale-output rendering,
frontend persisted recipe/run history, and live provider generation require their
separate evidence. The deterministic fixture performs no generative work.

Review-driven changes: tests identified incomplete secret-field filtering in the
new receipt helper and a native-open file-ID prefix match. The implementation
owner repaired both; the regression checks above pass against the final code.
