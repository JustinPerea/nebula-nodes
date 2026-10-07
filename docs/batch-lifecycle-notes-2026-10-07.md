# Batch lifecycle and metadata decisions

## Shared contracts

- `VariantScope` keeps an invocation index, display label and ordered source-item lineage. Lineage uses the backend's `source_node_id`, `source_label`, `index` and `item_label` keys.
- `NodeData.batchOutputs`, `batchVariants` and `batchRunId` are runtime preview fields. Canonical node outputs remain scalar; these fields do not belong in recipe params or execution snapshots.
- Execution events add optional attribution. Older iterator events without attribution remain supported.
- `RunRecord.batchVariants` stores per-node attribution alongside the existing immutable cumulative `batchOutputs`.

## Persistence tradeoff

`recordRunBatchOutputs` replaces one node's output collection and optional attribution atomically. It independently clones and freezes the stored data, retains other nodes and earlier runs, and never changes the saved recipe. A replacement event with absent or invalid metadata removes that node's previous labels, avoiding misattribution.

`sanitizeVariantScope` and `sanitizeVariantScopes` accept untrusted storage or WebSocket values. They require nonnegative safe integer indices and the documented string/lineage shape, copy only known fields, and require the metadata collection to match the output count when supplied. Collection scope indices must equal their zero-based successful-output positions; duplicated, reordered or skipped indices are rejected. An invalid item rejects the entire metadata collection rather than shifting labels onto the wrong result.

Optional metadata corruption does not discard otherwise valid run history. Loading removes malformed, orphan or count-mismatched metadata independently per node, deeply freezes accepted metadata, and persists the cleaned history. Legacy output collections without metadata continue to load. Empty output/metadata collections are valid paired results.

## Store review findings for integration

- The engine emits `executing` per item. Reset preview ownership once for a new run, not for each invocation of the same run.
- Seed terminal ownership from loaded historical records so late old events cannot rewind results after reload.
- Strip runtime collections from undo snapshots; restore the current collection with the current scalar output instead of resurrecting an old run's gallery.
- Fresh duplicates and pasted nodes must clear runtime collections and their run owner.
- A matching or empty server output preserves the local gallery. A different nonempty scalar output invalidates gallery attribution until the matching collection is known.
- Graph-file export/import retains recipe and canonical scalar results. Full per-item collections belong to persisted Run History; graph files do not implicitly acquire UI runtime fields.
- Run History calls fanout execution counts “steps” because one canvas node can execute repeatedly. Ordinary execution records retain “node(s)”. Saved result labels and lineage come only from validated run metadata, never edited live source params; legacy collections use “Result N”.

## Validation

- `runHistory.batchMetadata.test.ts`, `runHistory.test.ts`, `RunHistoryPanel.test.tsx` and `BatchRunInspection.test.tsx`: 98 passing tests, covering sanitation, immutable recording, legacy compatibility, terminal-history reload, execution count labels and saved lineage after source edits.
- TypeScript application check passed with `--noEmit --incremental false`.
- ESLint passed for the shared source files, history presentation components and touched test files.
- No provider calls, browser automation, packages or commits were performed by this subtask.
