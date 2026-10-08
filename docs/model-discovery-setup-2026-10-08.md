# Model discovery and provider setup — 2026-10-08

Implements UI audit item 6 on `codex/model-discovery-setup`, based on published main `ffcd5bf8`.

## Behavior

- Nodes, Create and command search share catalog-backed names, friendly categories, supported providers, port metadata, model options, capability notes and common task terms. “Animate a logo” finds image-capable video outputs. Create keeps its existing input/support exclusions.
- Nodes and Create filter every declared provider route, including FAL alternatives and direct Meshy routes. Filtering never changes a recipe's active connection. Rows show actual input/output summaries and their current connection status; `3d-gen` is displayed as 3D Generation.
- Empty searches explain the outcome and offer recovery. Models remain browsable and addable before connecting.
- Separate setup buttons open the matching API-key field, Krea sign-in card or Nous instructions. They preserve the selected Create model, prompt, graph, connections and run history.
- Saved credentials are explicitly marked unverified until Check connections. Checks use the existing read-only health endpoint; raw transport/provider errors are omitted. Successful credentials do not promise model entitlement, credits or generation success.
- Verification expires after five minutes and is invalidated when credentials change. Older responses cannot restore stale statuses or settings caches. No browsing/setup/filtering action initiates verification or generation.
- Readiness follows actual saved routes: configured direct keys take precedence, legacy Ideogram Reframe without resolution uses FAL, and Krea API-token/sign-in modes retain their separate billing connections. Paper, Cinema and Nous retain their local/base-model/OAuth prerequisites.

## Acceptance evidence

| Check | Evidence |
| --- | --- |
| Consistent task/provider/category search | Shared helper, Library, Create and command tests; native Chrome task searches on all three surfaces |
| Recovery and disconnected browsing | Library/Picker/command tests; native empty-state suggestion recovery and disconnected Kling addition |
| Targeted setup without draft loss | Settings and integrated Create tests; native API fields focused from Library and Picker, with the original Nano Banana prompt/model retained |
| Explicit credential checking, failure and retry | Store/Settings tests; native synthetic successful check, unavailable backend and retry |
| Route, freshness and request ownership | Resolver/store/Settings tests for direct/FAL, saved Krea modes, missing legacy fields, expired/future checks and late replies |
| Keyboard and compact layout | Native Library setup reached by Tab/Enter at 200%; Picker labels, wrapped summaries and separate setup visible at 200% |
| Graph preservation and no generation | Private fixture retained all seven earlier nodes and six edges after adding n8; zero generation requests and three explicit health requests in the final fixture run |

Final gates: **1,475 frontend tests in 148 files passed**, lint (including style guards), TypeScript/production build/budget, and node contracts for all 255 definitions. Independent reviews found the route/freshness inconsistencies above; both were corrected and covered. Backend code and provider handlers were unchanged; the Cinema baseline passed all GitHub CI jobs before this branch began.

Native verification used frontend 5222/backend 8052, temporary synthetic state and execution-blocking middleware. Credential results were stubbed; no real provider, OAuth account or user settings were checked. The controlled Chrome clock differed from the host, so final synthetic check timestamps matched the observed browser clock; mismatched/future timestamps correctly remained unverified. Screenshots and proof JSON remain outside Git under the private audit folder. The owned tab/servers were closed afterward. Physical mobile devices and packaged Electron were not tested.

This slice is committed locally. Onboarding (item 8), full recipe comparison (item 10), and shared workspace chrome (item 11) remain outstanding.
