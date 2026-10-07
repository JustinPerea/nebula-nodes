# Create UI repairs — 2026-10-07

First repair slice from the [UI audit](ui-improvement-audit-2026-10-07.md), implemented on the isolated `codex/ui-audit-2026-10-07` branch from published main `362d201b`.

## Delivered

- A session draft preserves prompt, model, parameters, accepted references and variation count across Canvas/History navigation and page reload. Canvas selection seeds a draft once; later selections do not silently replace it. **New draft** resets authoring fields while retaining session identity, graph connections, results and run history.
- Reference intake shows pending and failed files with Retry, Attach again and Remove. Generate is gated both in the composer and the latest-draft handler. Remove/reset erase upload ownership before aborting transport, so late responses cannot reattach a discarded file. Uploads may finish while Create is closed; a page reload marks unfinished uploads as interrupted and requires explicit recovery.
- The gallery has a stationary toolbar, a dedicated results scroller and a composer footer that reserves its actual height. Compact List rows and naturally sized Grid cards expose named actions without hover. Download choices expand inside the card and support keyboard navigation. Fullscreen contains focus and restores its opener, including output-removal cases.
- Model/node labels and available prompt excerpts provide basic orientation. The single Slava Restraint appearance remains.

## Acceptance

| Check | Evidence |
| --- | --- |
| All composer fields survive navigation; explicit Style applies once; reset preserves graph/history | Seven integration regressions with the real draft/upload coordinator and controlled composer inputs |
| Reload preserves draft and converts pending uploads to interrupted errors; storage failure preserves in-memory edits | Nine draft-store regressions; native reload retained the multiline prompt, two variations and accepted reference |
| Attach authors pending chips before requests; pending/failed refs prevent button, shortcut and stale-handler launches | Composer and CreateView regressions with deferred synthetic upload responses |
| Completion retains newer edits; retry/remove/reset cannot resurrect obsolete references | Deferred upload coordinator/integration regressions; late transport responses intentionally ignore abort |
| Prompt enhancement cannot overwrite edits or a closed/reset composer | Real Composer lifecycle regressions with deferred enhancement responses |
| First/last results and actions are reachable; toolbar and composer remain separate | Native Chrome, 30 locally drawn logo outputs, multiline draft and reference, Grid/List at 100% and 200% zoom |
| Fullscreen closes with Escape, contains Tab and restores the originating result | Native last-result check showed 30/30, Shift-Tab stayed inside, Escape returned to its fullscreen button; targeted focus/removal regressions |
| Real backend upload accepts an image and reports malformed-image failure | Isolated local HTTP probe: valid PNG returned 200 plus usable reference; malformed PNG returned 415 plus detail |

Final frontend suite: **129 files, 1,225 tests passed**. Lint, inline-style and Slava scope guards, TypeScript/production build/build budget, and `git diff --check` passed. Independent final review found no introduced blocker.

## Proof limits and remaining work

Browser inspection used private temporary backend state, an empty credential set and generation-blocking middleware. No provider or agent executed. At 200% zoom, the footer can require its own scroll to reach controls; it does not cover the gallery. Screenshots are retained privately outside the repository.

The native file picker did not appear through this computer-use environment after pointer/keyboard attempts. Native file selection is therefore unverified. Pending/error/retry/remove rendering and admission are covered by component integration tests; accepted-reference reuse was checked in the browser, and upload response contracts were checked against the real isolated backend.

The remaining audit includes Settings load/save/key removal, Cinema upload ownership and selected-shot layout, truthful motion handoff, node discovery, onboarding, recipe comparison and shared navigation. Packaged Electron is out of scope. Main, real workspace data and the parallel development checkout were not changed.
