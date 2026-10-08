# Cinema motion handoff — 2026-10-08

Third UI repair slice on the isolated `codex/ui-audit-2026-10-07` branch. Addresses item 9 in [the UI audit](ui-improvement-audit-2026-10-07.md).

## Result

Send to motion now shows pending, error/Retry and confirmed connection states for the originating shot, including after switching shots or leaving/reopening Cinema. A settled image is required. View video node returns to Canvas, selects the actual destination, and centers it after measurement. Sending, retrying, reconciliation and viewing never generate.

The backend creates or reuses the exact Cinema shot output → Veo image connection atomically. Existing target parameters, results, sibling connections and earlier run records remain intact. A lost acknowledgement can be retried after restart without another connected destination. Frontend-only scenes create a local node and typed Image edge together, with one undo snapshot.

Deletion/retyping, import and clear revoke obsolete callbacks. Successful HTTP responses can adopt only the verified pair; newer authoritative synchronization that omits that pair wins. Canonical removal of a confirmed motion wire changes feedback to error while other optimistic frontend connections retain their existing merge behavior. Explicit graph replacement also revokes an unfinished destination focus request. Cinema's dynamically declared shot edges now retain their Image type in canonical export and socket events.

## Acceptance

| Check | Evidence |
| --- | --- |
| Failure never reports success; pending blocks repeated activation; explicit Retry uses current media | Component/deferred response tests; native Chrome failed request → Retry → confirmed state |
| Lost acknowledgement and overlapping requests produce one connected destination | Real persisted CLIGraph endpoint tests, including delayed broadcast and reload |
| Shot switching/remount retains ownership; removed/retyped/replaced IDs reject late replies | Deferred component/store tests, including tagged replacement and failed import recovery |
| Newer authoring/results/history survive; edge-only deletion and late HTTP cannot restore removed wires | Actual graph-store regressions; independent peer review |
| Local scene creates one typed pair with undo and no HTTP | Actual graph-store test |
| View selects and centers the destination after measurement; reduced motion and old requests are fenced | Native Chrome selection/centering; viewport-mocked tests for timing and reduced motion |
| Sending/retry/View do not execute models | Execution/provider access guards in endpoint tests; native temporary fixture recorded two handoff requests, one video node/edge, empty video outputs and zero generation requests |

Final gates: **3,465 backend tests** and **1,342 frontend tests in 140 files** passed. Full lint/style guards, TypeScript and production build/budget passed: 314,205 bytes raw / 87,736 bytes gzip; 37 JavaScript assets passed the eval guard. Independent review cleared this slice; the reviewer independently ran 44 handoff/focus cases. Existing FastAPI lifecycle deprecation and deferred large-chunk warnings remain unchanged. Staged whitespace and credential/protected-file scans passed for all 19 changed files.

## Scope and proof limits

Browser checks used frontend 5216/backend 8046 with temporary synthetic state, locally drawn logos, no provider keys, and execution-blocking middleware. Private screenshots and JSON proof stay outside Git. The owned preview servers and tab were closed after validation; the user's app instance and parallel checkout were untouched. No paid provider, OAuth, real Commons store, package installation or packaged Electron operation was used. This branch remains local until publication is requested.

The backend has no graph incarnation token: a previously dispatched request arriving after replacement with the same node ID, shot ID and exact artwork cannot distinguish those incarnations. Client abort does not undo a committed server write. The current-image check, frontend lifetime fences and idempotent existing connection protect the scoped loop; this slice does not add a general graph revision or multi-worker transaction protocol.

Remaining: Cinema selected-shot layout and usable override controls, keyboard shot selection, discovery/readiness, onboarding, full recipe comparison and shared workspace chrome.
