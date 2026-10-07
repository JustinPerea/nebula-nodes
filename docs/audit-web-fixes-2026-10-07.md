# Web/backend audit repairs — 2026-10-07

The seven web/backend findings from the audit are repaired on `codex/audit-web-fixes`, based on published main `998ad87c`. Packaged Electron findings D01–D04 are excluded at the user's request. The active development checkout and its brand-system work were not edited. This report records the original repair acceptance; the release review is recorded in [the release notes](audit-release-review-notes-2026-10-07.md).

| Finding | Repaired behavior | Acceptance coverage |
| --- | --- | --- |
| F01 — Create execution ownership | Create and Cinema jobs use shared run ownership, persistent history and scoped Stop. Conflicting runs of an owned model are blocked; disjoint jobs and intentional Cinema variations remain available. | Authoring reservations, rapid click/shortcut guards, navigation, concurrent ownership, cancellation and stale-event regressions. Native browser navigation/reload/Stop check. |
| F02 — Active run reload | Reload retains a running record and reconciles backend status rather than claiming cancellation. Stop remains available for recovered jobs. | Running/starting/cancelling/completed/failed reconciliation, uncertain status and reload tests; native browser check. |
| B01 — Iterator consumers | Connected downstream work executes once per item. Normal ports retain scalar outputs; history retains every successful batch result separately. | Text/image consumers, static fan-in, fork/join, nested iteration, caps, cache, distinct artifact paths, errors, Stop and batch history persistence. Browser inspection of both downstream text results before and after reload. |
| B02 — Frame Extractor paths | Owned portable video references resolve before extraction, including spaces, Unicode and escaped percent characters. Remote HTTP(S) inputs retain their existing behavior. | Real FFmpeg extraction in all four modes, missing-file errors, remote-input fixtures and path traversal/symlink refusal. |
| B03 — Video duration | Fresh video outputs and cache hits refresh duration metadata. A newly seeded editor uses the replacement video's measured length. | Actual two-second to five-second replacement, editor seed and five-second export; duration/cache regressions. |
| F03 — Saved Cinema ports | Saved shot IDs reconstruct typed Image ports through load, export, import, manual connection and execution validation. Deleted-shot current outputs/wires are pruned; earlier history remains. | File/ZIP round trips, actual graph API restore/reconnect, shot history and invalid-handle/type rejection. |
| F04 — Create required inputs | Picker, Featured and search omit models whose required inputs Create cannot author. Canvas selection and saved-style prefill also block generation with visible guidance. | Required video/audio/second-image/mask/end-frame cases, Canvas definition retention, prefill admission and button/keyboard guards. |

## Decisions affecting batch recipes

Each item starts from the saved recipe, with a separate artifact directory. Successful outputs remain available after later failure or cancellation. A failure stops the remaining items at that node and blocks its consumers. Empty batches settle skipped nodes instead of leaving spinners running.

Nested iteration stays within the declared cap, bounded to 25. Independent iterator joins are rejected before any handler runs; no implicit Cartesian generation is introduced. World Labs recovery-aware operations require separate tracked nodes because one node/run recovery checkpoint cannot own multiple paid-start identities.

Run History's batch disclosure exposes saved text and media links without starting generation. Graph file/ZIP formats continue to save graph state; they do not gain a run-history field. History remains in existing browser persistence.

Paper refresh, immutable source snapshots, explicit rerun, historical recipe parameters and Krea billing choice remain covered by regressions.

## Validation

- Backend: **2,435 tests passed**.
- Frontend: **958 tests across 101 files passed**.
- Full frontend lint, inline-style and CSS-scope guards passed.
- TypeScript production build and bundle budget passed; 34 JavaScript assets are eval-free.
- All **254 node contracts** and generated model reference checks passed.
- Native browser: Create → Canvas → reload retains a running job and Stop; Stop records cancellation; explicit saved-recipe rerun completes without removing prior failed/cancelled records. Text Iterator → Combine Text → Preview produces `hello first` and `hello second`, both accessible in history after reload.
- Media tests use real local FFmpeg. Provider-facing checks use deterministic handlers and fake credentials in isolated state; no new paid generation or live provider compatibility claim is made.

The legacy `check:utility-nodes` script expects servers on its default ports and uses its own CDP browser harness. Its default-port invocation stopped before opening a browser. Native computer-use checks on the isolated preview and the full utility/engine suites provide the relevant acceptance evidence here.

One additional pre-existing limitation surfaced during fixture setup: replacing the backend graph directly through its API can leave old Canvas wires when reused short node IDs have different connections. The additive `graphSync` edge merge is unchanged from the audited main. The existing Import CLI control replaces the complete canvas graph and clears those stale wires; that path was used for the iterator browser check. Automatic replacement semantics remain a separate follow-up.

## Dependencies

Eligible frontend advisory fixes are pinned to compatible versions at least 14 days old, verified against the canonical npm registry. A private dependency install leaves the active checkout's installed packages unchanged. Browserslist's four data overrides satisfy its declared minimum versions; manifest, lock and installed tree agree.

One underlying advisory remains: [source-map-js indexed-map denial of service](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). Its patched version is 1.2.2, published September 30. The user's rule, “Never install or upgrade a package younger than 14 days from its current published version,” prevents installing it yet. Retain 1.2.1 and expose the advisory until the patch is eligible. This is a dependency finding, not evidence of an application exploit.

The final npm audit flags 17 packages (9 in the production view), all through that same underlying source-map-js advisory. No advisory is suppressed. Patch eligibility begins October 14 after the exact registry publication time; October 15 is a safe calendar-date follow-up.
