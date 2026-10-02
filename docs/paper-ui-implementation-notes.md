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

## Desktop artwork navigation follow-up

- The installed Paper desktop source explicitly handles `paper://file/<file>/<page>/<object>` by focusing a visible window, forwarding the full route, and activating its file tab. This differs from MCP `open_file`, which leaves an already-open file's page unchanged.
- The existing native `shell:openExternal` bridge now admits only that exact Paper artwork route, using the source request's 1–128 character ASCII ID alphabet. Matching the original canonical URL rejects credentials, ports, alternate Paper actions, query/hash variants, control characters, encoded separators and traversal normalization. HTTP, HTTPS, mailto and sender validation retain their existing behavior.
- Native bridge tests inject a mock shell to verify exact dispatch, rejection before launch, and sender rejection; they do not claim to launch Paper.
- Validation: `node --test desktop/tests/file-bridge.test.mjs` passes all 139 tests, including the existing HTTP/HTTPS/mailto and sender/bridge invariants.

- The source card now derives desktop and HTTPS object links from the saved file/page/object IDs. Browser anchors run in the original click gesture; Electron prevents default navigation and invokes the existing native bridge. Failed native launch leaves the visible web link and source state intact. Neither path reads current selection, refreshes artwork, nor runs a recipe.
- Real browser fallback click verified the bound object URL and visible artwork. The guest browser cannot edit or inspect selection without a Paper login. The browser automation security policy blocked desktop `paper://` navigation; no workaround was attempted, so desktop activation remains a manual acceptance check.
- Focused frontend lifecycle/desktop-mode/source-state checks pass (66). TypeScript, production build/budget, targeted ESLint and both CSS guards pass. Reload keeps 7 source snapshots, the same edge and all 4 earlier run records.
