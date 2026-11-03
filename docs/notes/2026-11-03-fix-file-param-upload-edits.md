# fix/file-param-upload-edits

Found in #208 round 8c. The Inspector's file-param upload (`param.type === 'file'`)
wrote `{ ...activeNodeData.params, [key]: filePath, _previewUrl, _fileName }` in the
upload's `.then`, from the params the pick's render saw. Two faults:

- An edit made while the file uploaded was reverted when the upload landed, whether
  the person made it or an agent did (MCP `edit_canvas`, `nebula set`).
- The write skipped the provider snap (`snapParamDefaults` and `snapHidden`) that
  every other edit runs.

## Change

- `Inspector.tsx`: `writeParamNow` is now `writeParamsNow(nodeId, key, patch)`. It
  reads the node's params from the store when the write lands, merges several keys,
  snaps, and writes them in one `updateNodeData` call. One store update means one
  undo step, as before. There are no undo labels for param edits, so nothing about
  the label changed. `writeParamNow` stays as a one-line wrapper, so the palette's
  call site doesn't move.
- `writeEdit` takes the node id it writes to. Before, it always wrote to
  `activeNode.id`.
- The upload moved into `uploadIntoParam(nodeId, paramKey, file)`, built like
  Extract's palette:
  - it reads the project, the graph generation and the node's definition when the
    file is picked, and drops the write if any of them changed;
  - a ticket per node and param means only the newest pick lands. An older upload
    that answers later is dropped, including its failure notice;
  - a node that is gone gets nothing.
  Dropped writes say nothing. The palette's drop note is GM's copy for the palette,
  and an upload has no such copy yet.

## Decisions

- The provider snap reads the wires and the settings from the pick's render (the
  same closure the palette uses). The params are read fresh. A wire changed during
  the upload would change only which route the snap reads.
- The edit lock is the store's job: `updateNodeData` with params is gated while
  following or offline (EDIT_GATES), so the landing write needs no lock check of its
  own.
- No shipped node has a file param that controls another setting (no `visibleWhen`
  or `defaultBy` keyed on a file param), so the snap does nothing on today's
  catalog. The test uses FLUX.2 with its Model made a file param to prove the snap
  runs.

## Audit (stale params spread after an await)

The ratchet scans every spread of `…params` (and every spread inside a
`params: {…}` value) across `frontend/src`. A second throwaway scan listed every
`params:` written inside a `.then` or after an `await`.

- Fixed: `Inspector.tsx` file upload (the only real instance).
- Kept as is:
  - `GraphFileActions.tsx` `params: node.data.params` is the body of
    `/api/graph/import` being sent, not a write to the store.
  - `graphStore.ts` `requestUniversalModel` (the `params: node.data.params` send) and
    `addNode`'s `params: defaults` POST are request bodies too.
  - `configureOpenRouterModel` and `fetchReplicateSchemaAndConfigure` already read
    the node inside `set()` and keep edits made since the request
    (`withEditsSinceRequest`).
  - `cinemaUploads.finish` writes through `updateScene` with a fresh read.
  - `CharacterStudioView`'s `onAppendReferences` uses a `setDraft` updater.
  - Moodboard uploads go through `commitOps`.
  - The canvas and chat drops create nodes on the backend, so they spread nothing.
- Mask painter `onSave` (#208 called it low risk and didn't reproduce it): it stays.
  `saveMask` calls `onSave` synchronously, with no await. The modal gets the
  Inspector's newest `onSave` on every render, so `onParamChange` spreads the params
  of the latest render. A test confirms that an agent's edit made while the painter
  is open survives Save.

## Ratchet

`tests/staleParamsSpreadRatchet.test.ts` with `tests/helpers/staleParamsSpread.ts`
(TypeScript AST). It flags a params spread in either of two places:

- inside a `.then`, `.catch` or `.finally` callback, when its root is declared
  outside that callback;
- after an `await` in an async function, when its root is declared before that
  await.

The opt-out is `// stale-params-ok: <reason>`, on the spread's line or the line
above, and it needs a reason. Mutation check: with the old upload code restored,
the check fails on `src/components/panels/Inspector.tsx:1054 (then)
...activeNodeData.params`.

## MCP parity

Agents can set file params: MCP `edit_canvas` params and `nebula set n1 filePath=…`
both apply (checked on an isolated backend), and both refuse `_previewUrl` and
`_fileName` as internal params.

Round 1 found a gap: when an agent set the file after a person's upload,
`_previewUrl` kept the person's image while a run read the agent's file. Round 2
fixes it on the backend (see below), so last writer wins on the file, its preview
and its name, in both orders.

## Round 2 (GM r46)

- **In-flight row.** The upload now runs on usePaletteExtracts' `startPaletteExtract`,
  the same per project, graph and node store as Extract's palette. So it shares the
  #204 timing: "Uploading “name”…" replaces the file's name once the upload has run
  300 ms, and stays at least 400 ms. The control stays enabled and points
  `aria-describedby` at the row. Nothing is announced on a pick; the status region
  stays empty. The name is cut in the middle (`middleTruncate`), and the newest
  pick's name shows.
- **Dropped-upload line.** This reuses the palette's dropped-note mechanism
  (`paletteDropNote` / `setPaletteDropNote`, keyed by project, node and param, and
  shown once through `shownPaletteNotes`). The keys are per param, so a file param's
  note never meets a palette's. The names stayed "palette" so this PR doesn't move
  the palette code another builder is changing; renaming them is a follow-up.
  - A project switch, a graph replace, or an agent's follow switch drops the upload.
    The line is GM's wording, under the param, with no button, and it clears on the
    next pick.
  - A deleted or redefined node hears nothing, and a newer pick is silent.
  - The input's value is now emptied after each pick, so choosing the same file
    again, as the line asks, fires a change.
- **Graph generation.** `canvasGeneration()` reads `canvasReplacementRevision`, which
  moves in four places only:
  - `loadProjectGraph`: a project opened or switched;
  - `loadGraph`: Load graph or an import;
  - `replaceCanvasByClear`: a clear, the tab's own or an agent's, or a sync naming
    another canvas;
  - a graphSync marked `graphReplaced`: an agent's load or restore. A test runs the person's param edit, a node move, another
  node's edit, a node added and one removed, and an agent's `edit_canvas` graphSync.
  The generation stays the same and the upload lands. An agent clear bumps it, and
  the upload is dropped with the line.
- **Orphans.** A dropped upload's file stays in `output/chat-uploads/<sha256>.<ext>`
  on purpose:
  - Nothing lists that folder: no picker, the assets panel (characters, moodboards,
    styles), MCP, the CLI or run history. There is no listing route.
  - The archive route skips that folder.
  - Storage is content-addressed (`/api/uploads` dedups by hash). The same bytes can
    be another node's file, a moodboard image, a Character view or a Style ref, in
    this or any other project. Deleting it on a drop could break those.
- **Preview follows the file (backend).** `services/file_param_preview.py`
  `follow_file_params` runs on every partial params write: the PUT node route
  (canvas pushes and `nebula set`) and `_stage_proposal` (`/api/graph/apply`,
  `edit_canvas`, accepted proposals).
  - When it changes a definition's `file` param and leaves `_previewUrl` out, the
    preview becomes the new file's `/api/outputs` URL if Nebula holds that file, and
    is cleared otherwise.
  - A changed `filePath` that leaves `_fileName` out drops the old name, so the card
    and look_at_canvas show the path's own name and never a stale one.
  - The canvas's own upload sends all three fields and is kept as sent.
  - `CLIGraph.update_params` takes `drop` for the keys that go.
- **Frontend.** The name row shows the name cut in the middle, with the full name
  as its title.
  - With a file but no preview, a quiet "No preview" sits under the name, and the
    frame collapses.
  - `FilePreviewFrame` uses a grid row from 1fr to 0fr on the layout spring and keeps
    the last image inside while it closes. A frame that never had an image isn't
    drawn. Under reduced motion it jumps.
  - The spring curve is the popover's, defined again on the frame. A test keeps the
    two equal, because moving it to `:root` broke the palette's own CSS test.
- **Agent-set names.** For an agent's own upload, the path's base name is the stored
  hash (`777fcd…png`), as GM's base-name rule gives. The name the agent uploaded it
  with is on its own Image Input, not on this node.

## Round 3 (GM r48)

- **Bug 1: no "No preview" while an upload is in flight.** The Inspector hides
  it from the pick (usePaletteExtracts' `working`, not only once the row reads
  "Uploading…"), until the new file lands. A preview the param holds stays in
  its frame meanwhile; with nothing, or a file with no preview, nothing shows
  under the row. Round 2's shot 1 was the second case: n1 held
  `/nowhere/harbour-at-dusk-from-the-north-pier.png` (an agent's earlier set),
  a file with no preview.
- **Bug 2: the dropped line goes on any change to its param.** Keyed on the
  value, not on the path that changed it (`components/panels/fileDropNotes.ts`):
  - the note keeps the param's value at the pick (`PaletteDropNote.file`);
  - a store subscription, installed once by Inspector.tsx, clears it when that
    param's value changes between two states of one canvas (same project and
    graph generation): a pick, an agent's set arriving by graphSync, an undo,
    a redo. A load or replace isn't a change (another canvas's node ids);
  - the Inspector never shows it over a value other than the pick's (a change
    made while the person was in another project, seen when A loads again).
- **Q1: one name for a file param, everywhere.** `/api/uploads` now records
  each upload's sent name by stored (hash) name in `upload-names.json` in the
  state folder (`backend/services/upload_names.py`; newest name for the same
  bytes; capped at 5,000; a sent name that is itself a hash records nothing).
  `GET /api/uploads/names?file=…` serves it to the canvas
  (`frontend/src/lib/uploadNames.ts`: asked once per stored name, batched, quiet
  on failure; the tab's own upload is remembered without asking).
  - The rule, in `fileParamName` (frontend) and `file_param_name` (backend):
    the node's `_fileName` for filePath, else the record, else the base name,
    and a bare content hash (32+ hex, optional extension) is "Uploaded file".
    A backend test keeps the pattern and the label equal on both sides.
  - Used by the Inspector row and its title, the node face (input cards), the
    in-flight row, the dropped line and the upload failure heading.
  - Agents: `look_at_canvas` (MCP) and `nebula look` (CLI) give `fileName`
    (filePath's) and, with other file params, `fileNames` {param: name}, by
    the same rule. A node with a hash path and no record now reads "Uploaded
    file" where it used to have no name; an input card shows the same.
  - Ratchet: `frontend/tests/fileParamNameRatchet.test.ts` fails on a base name
    taken by hand (`.split(<path sep>).pop()`/`.at(-1)`) anywhere in `src/`
    outside an allowlist with reasons, on `inputFileName(` outside
    lib/fileName.ts, and checks each surface calls the shared function.
- **Dropped uploads are kept on purpose.** Storage is deduplicated by
  content hash, so a dropped upload may be another node's file; nobody
  adds delete-on-drop. (A repo-wide ARCHITECTURE.md is its own task; this
  PR doesn't start one.)
- **Stand-in ratchet (item 5).** `backend/tests/test_stand_in_signatures.py`
  scans every test module for `monkeypatch.setattr(<obj>, "<method>", fn)` on
  `cli_graph`/`CLIGraph`, `manager`/`ConnectionManager` or `agent_presence`
  with a local function or lambda, and requires `**kwargs` or the real
  method's current signature (`inspect.signature`): room for the required
  positionals, and by name every parameter with a default or keyword-only (how
  a new keyword arrives). A class patch counts `self`. Opt-out:
  `# stand-in-ok: <reason>` on the line or above. It reads 20+ live stand-ins
  today with no faults. Mutation: the fence test's update_params stand-in
  without `**kwargs` fails as `stand-in lacks drop`.
