# Paper source UI decisions

- Link and reconnect read the current Paper selection only when requested, then freeze the chosen file/page/object IDs in a confirmation form. Refresh always exports the saved identity. A different selection cannot silently retarget it.
- The confirmation form names the object and bounds, asks for 1×/2× resolution, and specifies PNG with the original artwork transparency. Exported pixel dimensions and actual transparency are shown after capture.
- The card preserves and labels the last successful preview while unavailable or missing. Open in Paper reports the supported file navigation fallback and shows the object identity for manual selection.
- Refresh and reconnection apply source state through the graph store; neither calls graph execution. Rerunning with the latest source is a separate history action using the saved recipe.
- Source snapshot hashes, timestamps and previews remain inspectable in the card and run history. UI timestamps show local time, while persistent records retain their original ISO timestamps.
- When Paper has no active selection, manual file/page/object IDs are resolved through a read-only object inspection before the same bounds/export confirmation. IDs are never used to silently guess a matching name.
- Open in Paper invokes the supported native `open_file` tool through the adapter. Its successful response is required before reporting that Paper accepted the file link; object selection remains explicitly manual.
- Paper snapshot URLs use the existing backend asset rebasing helper, including its isolated-port discovery, rather than assuming the frontend shares the backend origin.
- Visual review exposed an obsolete white `--sr-paper` fallback against the current dark Slava text tokens. Source controls, stale-result rerun and history replay now use the canonical dark glass surface tokens with explicit ink/edge colors.
- Latest-source replay is disabled until every linked source has a current successful snapshot. Exact historical replay remains distinct; missing or disconnected current objects cannot become an enabled silent no-op.
- Validation: 58 tests pass across Paper source UI, Paper history, existing history controls and backend asset rebasing. TypeScript compilation, targeted ESLint, inline-style guard and Slava CSS scope guard pass. Browser/live Paper proof is captured by the root integration task separately.
