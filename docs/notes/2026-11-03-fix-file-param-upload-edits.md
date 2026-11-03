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

Agents can set file params today. `describe_node image-input` lists `filePath`
(type `file`). MCP `edit_canvas` params and `nebula set n1 filePath=…` both
applied, checked on an isolated backend. Both refuse `_previewUrl` and `_fileName`
as internal params.

Last writer wins on the file param in both orders:

- The agent writes first, then the upload lands: the upload's `filePath`,
  `_previewUrl` and `_fileName` all land together, consistently (tested).
- The upload lands first, then the agent writes: the agent's `filePath` wins (it is
  what a run reads). But `_previewUrl` keeps the person's upload, because the agent
  can't write it and the PUT and apply routes don't re-derive it.
  - Live result: n1 had `filePath` = blue and `_previewUrl` = orange.
  - So the card and Inspector preview show the old image while a run uses the
    agent's file.
  - `_fileName` is guarded (`inputFileName` matches it to the stored file), but
    `_previewUrl` isn't.

That gap is not caused by this change, and it is a backend fix (re-derive or clear
`_previewUrl` when an agent changes a file param). It is not built here, and it
should be its own PR.
