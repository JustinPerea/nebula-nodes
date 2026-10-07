# Batch UI restoration decisions

- Restored the manual text Batch source as a current canvas card with the historic `set` output handle. Its scalar Text declaration uses the current invocation scheduler; the archived `VariantSet` port/type migration is not being revived.
- Item editing stays in the existing Inspector to preserve one parameter editing/persistence path. The card exposes its item count, first eight items, explicit run behavior, current cap and an over-cap warning without truncating the authored recipe.
- Result browsing is component-local and keyed to node ID plus owning run ID. It never changes the canonical port output, node parameters, saved recipe or provider calls. Both ModelNode (including Preview) and DynamicNode receive the shared preview behavior.
- During execution the carousel shows the current result count and disables browsing; it does not attribute a previous snapshot label to a live result. Completed and failed runs can display their retained successful snapshots.
- Downloads and image reference drag payloads use the visible selected snapshot. Structured World/spatial previews and existing mask/image comparison controls retain their original renderers.
- The only visual treatment follows the existing Slava appearance. New scoped CSS does not reintroduce alternate themes.
- Completed snapshot browsing ignores any leftover partial text/image streams, keeping the visible label and snapshot consistent even after interrupted execution.
- Peer review caught Mask Painter rebuilding a selected historical mask preview from the live latest upstream image. Batch browsing now renders the selected produced mask artifact and uses that exact URL for downloads; ordinary mask editing retains the live source/paint composite.

## Verification

- 29 new Batch UI tests pass: seven-color source/count/output, explicit Inspector path, parsing/cap warnings, both node renderers, node/run resets, live/error behavior, selected media/structured representations, image comparisons, visible-asset downloads, historical mask preview identity and unchanged canonical outputs/history.
- 59 focused tests pass across Batch, art-direction cards, representation viewers and before/after comparison. TypeScript, touched-file ESLint, inline-style guard, Slava CSS guard and `git diff --check` pass. Final whole-feature checks remain the integrating agent's responsibility.
