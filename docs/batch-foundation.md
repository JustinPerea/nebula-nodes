# Batch text source

Add **Batch** from the node palette, open its settings, and enter one item per
line. Connect **Items** to a text-compatible downstream input, then press
**Run**. Each item travels through the connected workflow separately. Editing
the source and browsing results never start generation.

- **By line** trims whitespace and omits empty lines. **None (entire text is one item)** preserves
  one nonempty item exactly as authored.
- **Item cap** defaults to 10 and accepts 1–25. Exceeding it rejects the run
  before any handler starts; it does not silently discard items.
- Repeated lines are separate item positions. Provider execution can charge
  per item. A warm rerun reuses each position's compatible cache entry.
- Use the previous/next controls to inspect results. The connected output
  stays the last completed scalar result; browsing does not rewire the graph.
- Run History keeps captured item labels and recipes. **Rerun** executes that
  saved recipe even after the live Batch text changes. Press Canvas **Run** to
  use the current source instead. Stop or failure retains successful earlier
  results in that run's history.

Reload restores the current node's gallery from matching local run history.
Graph files preserve Batch settings, connections and the canonical output;
the complete gallery belongs to local run history and is not transported in a
graph bundle.

## Archived branch reconciliation

This restores the useful single-text foundation from `feat/batch-cross-pair`
at `2d7634d3ca39880cdf4fc5b67b9a5cf96612f63c`, on the current invocation-context
scheduler. The old branch and `archive/batch-cross-pair-2026-07-22` tag remain
preserved. Its obsolete baseline/engine changes were not merged wholesale.
The retained node ID is `batch`, output handle is `set`, and authoring keys
are `display_name`, `items_text`, `split_mode` and `batch_size_cap`.

Cross/Pair joins, cost estimates, Compare Grid and failure-rate policies are
separate future work. Independent iterator axes continue to reject ambiguous
joins before paid work.

## Verification

Native Chrome on an isolated local backend verified palette creation,
Inspector authoring, Batch → Preview with seven colors, first/next/last
navigation, connection/gallery persistence after reload, editing without a
run, and frozen-recipe rerun after editing the source. A subsequent explicit
Canvas run used the new two-item source and kept earlier history.

Automated coverage checks downstream cascades, duplicate-position cache
identity, frozen replay, separate PNG artifacts/manifests, progress/error
attribution, overflow preflight, cancellation/failure retention, and parser
parity. Store/component tests check immutable labels, stale events after
reload, cloning/undo, media/download identity, and graph-file compatibility.
Provider execution uses mocked transport and real local artifacts; no paid
generation or provider adherence is claimed.

Final local gates: 2,692 backend tests; 1,116 frontend tests in 113 files;
full frontend lint, TypeScript/production build and bundle budget; all 255
node contracts and generated-reference parity. The maintained browser smoke
script was syntax checked; native Chrome supplied the browser evidence.
