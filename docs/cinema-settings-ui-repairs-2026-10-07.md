# Cinema uploads and Settings recovery — 2026-10-07

Second repair slice from [the UI audit](ui-improvement-audit-2026-10-07.md), on the isolated `codex/ui-audit-2026-10-07` branch.

## Delivered

- Cinema reference intake uses stable scene/shot ownership with visible filenames, progress, failures, Retry and Remove. Accepted references patch the latest reference list; newer prompts, model/look edits, shot order, additions, outputs, connections and frozen history remain intact.
- All files reserve pending state before any request. Current generation entrypoints check unresolved references before queue/history mutation. Shared references block all shots; a composition reference blocks its owning shot while independent siblings remain available. Saved historical replay continues to use its captured recipe. Upload completion, retry, removal, editing and refresh never generate.
- Files/controllers stay in page memory. Reload converts pending metadata to interrupted errors with explicit removal and reattachment; metadata never enters saved graph parameters or run recipes. Deletion, retyping, import and clear invalidate old requests even when IDs return. Navigation and clearing history retain current authoring ownership.
- Scene PUTs serialize/coalesce and protect newer authoring from older echoes. Runtime media merges by stable shot ID. Failed imports resume interrupted scene saves; an explicit successful-import WebSocket signal discards old saves and upload ownership even if HTTP confirmation is lost. Tagged replacement trusts incoming positions/empty outputs and removes earlier frontend-only nodes/edges; ordinary synchronization keeps its existing merge behavior. Backend authoring updates preserve canonical shot runtime so an older request cannot erase a newer completed result. Whole-scene execution merges only produced shot output into current authoring, including cached/Batch paths; current variations, edits and surviving/new shot ports remain. Stopping a run preserves settled shots and updates their downstream done/error ports. Complete produced artifacts stay in frozen Cinema history even when a shot was removed from the live scene.
- Settings loads saved values before enabling editing or Save. Failed loads expose Retry. Unsaved drafts survive panel dismissal/unmount in volatile memory, with explicit Discard; page reload discards them. Failed writes retain edits and visible recovery. Successful writes with failed readiness refresh offer a GET-only retry.
- Browser provider keys have explicit scoped Remove. Removal preserves unrelated key drafts/settings and Krea MCP consent, updates configured readiness, and returns no credential value. Empty key text retains the configured key; removal is a distinct action. App ignores older readiness responses.

## Acceptance evidence

| Check | Evidence |
| --- | --- |
| Late/out-of-order upload completion retains newer scene/shot edits, outputs, edges and frozen history | Deferred coordinator tests against the real graph store, plus functional component callback tests |
| Remove/delete/retype/clear/same-ID import cannot resurrect a reference | Delayed responses intentionally ignore AbortSignal; target and attempt ownership still reject them |
| Pending/failed references block all current-recipe entrypoints; sibling/other-target/frozen-replay scope remains intact | Direct graph, node, downstream, cluster, concurrent-cluster and shot admission tests; no new history or queued state on rejection |
| Restored interruptions survive terminal-owner settlement before graph hydration | Fresh module/store boot with a real persisted owner, terminal settlement and later authoritative graph hydration |
| Run-history clearing retains current upload ownership | Pending upload completes after clearing only history, without generation |
| Scene saves preserve newer authored/runtime state, Inspector edits, same-ID replacement and failed-import recovery | Delayed HTTP/WebSocket persistence regressions; backend stale-authoring, cancelled/unexecuted output, cache and Batch invocation regressions; delayed frontend result/live-port/history checks |
| Failed/pending Settings loads cannot save defaults; stale loads cannot replace edits | Deferred Settings/App response-ownership tests |
| Scoped Remove preserves unrelated edits/readiness and does not repeat a successful write on refresh failure | Frontend deferred mutation tests and isolated backend route tests |
| Visible Settings load error → Retry → masked form; failed Remove → retry → updated count, retained unsaved edit | Native Chrome on temporary synthetic state, no real credentials |
| Cinema shot edits and film look survive selection and page reload | Native Chrome plus inspection of the same isolated backend graph |
| Actual upload contract accepts an image and rejects malformed bytes | Temporary backend HTTP: valid PNG 200; malformed PNG 415 with detail |

Final integrated gates passed on the final source:

- Backend: 3,425 tests passed; 12 existing FastAPI lifecycle deprecation warnings.
- Frontend: 136 files / 1,298 tests passed, full lint/style guards, TypeScript and production build.
- Build budget: 312,628 bytes raw / 87,305 bytes gzip; 37 JavaScript assets passed the eval guard.
- Independent review cleared the scoped upload, Settings, persistence, result-history and partial-cancellation contracts. Staged whitespace and protected-file/credential scans passed.

## Proof limits

The preview used private temporary state on frontend 5215/backend 8045, a fake provider key and generation-blocking middleware. The temporary servers and owned browser tab were closed afterward. Existing app instances and the parallel checkout were untouched. Private screenshots and JSON proof remain outside Git.

The native file chooser did not appear through computer use. Native file selection remains unverified; pending/error/retry/remove behavior was verified with component/deferred tests and actual backend response checks. No provider, OAuth consent, agent execution, real Commons store or packaged Electron action occurred.

Client cancellation cannot undo a write already committed by the server. Scene authoring synchronization now protects canonical runtime; the explicit successful-import signal handles a lost HTTP acknowledgement when its WebSocket event is received. This slice does not add a backend graph revision protocol for a lost response and lost socket event, or arbitrary already committed same-ID writes across replacement. Failed final scene writes release the temporary browser overlay and a later explicit edit retries; successful writes without a matching socket echo release it after five seconds.

Remaining UI work: selected-shot layout and real override controls, truthful motion handoff, keyboard shot selection, discovery/readiness, onboarding, recipe comparison and shared workspace chrome. These repairs remain local until merge/push is requested.
