# Backend release review — October 7, 2026

- Fresh review found iterator manifest metadata was read from the final live node for every item. Earlier artifacts could therefore receive the last item's effective seed or timeline, despite their files remaining immutable.
- Retain a deep copy of each successful invocation's effective params and iterator context with its output snapshot. Manifest records use that invocation's metadata, including when a later item fails or execution is cancelled. The ordinary Canvas node still retains the latest runtime params.
- The cache previously retained only output maps. A minimal optional effective-params field now accompanies its existing output API, so warm runs can retain the original artifact settings. Cache metadata is independently copied and never replaces a submitted saved recipe or live node params. Legacy/manual cache entries without metadata retain the existing submitted-params fallback.
- Artifact file rebinding and batch history output contracts are unchanged. This records the settings observed after the actual handler; it does not claim to reconstruct provider settings that handlers never expose.
- Added cold two-item and partial-failure regressions for distinct prompts/seeds/timelines, plus a warm replay proving settings survive cache rebinding and later nested Canvas edits without running the handler again.

Validation: 119 focused backend tests passed (iterator, cache, manifests, frame extraction, engine and Cinema ports) using the existing parent Python environment and this worktree's backend source. This includes real local FFmpeg frame extraction. No provider calls or dependency changes. Linux CI paths use the existing temporary test sandbox; the FFmpeg integration skips explicitly when its binaries are absent.

## Final local release gates

- Full backend suite: **2,442 passed** after the lineage and import-ownership repairs.
- Full frontend suite: **997 passed across 105 files**, including suspended import/graphSync and saved Create rerun/Stop regressions.
- Full frontend lint, TypeScript/production build and bundle budget passed: 297,021 startup bytes raw / 83,040 gzip, with 34 JavaScript assets eval-free.
- All 254 node contracts, provider inventory and generated model-reference parity passed. The inventory remains informational; enforcing its coverage baseline is a separate backlog item.
- Updated capture/utility/screenshot helpers pass syntax checks. Browser acceptance and the native chooser completion limitation remain documented in the original audit reports; no additional native completion or paid-provider proof is claimed.
- Staged source, test and documentation credential scan returned no credential matches. One initial substring match came from the CSS `mask-background` property, not a credential; the scan now requires a token boundary. Private browser captures, local test logs and user state are outside the commit.

- Graph import now rejects with HTTP409 while the backend run registry owns a running or cancelling graph/Cinema task. The existing World Labs paid-state replacement guard remains in force. The active-run check and graph commit contain no await, so an ordinary task cannot be admitted between them on the application's event loop. A requested Stop does not release the fence until cleanup is terminal.
- Four async HTTP regressions use the actual execute/Cinema endpoints, engine and registry with held local handlers. Rejected imports retain the graph and send no replacement graphSync; both successful completion and fully drained cancellation allow a later import. This protects graph import from other clients in the same backend process; it does not claim to fix the broader stale-wire direct graphSync flow or coordinate ordinary runs across independent server processes.

Companion validation: 166 focused tests passed (import execution guard, cancellation, Cinema shot and CLI API) in 2.00 seconds. No provider calls; the test settings and output/state roots are synthetic and sandboxed.
