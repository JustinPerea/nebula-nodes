# Cinema layout and controls — 2026-10-08

Fourth UI repair slice, on isolated `codex/cinema-layout-controls` from published main `94baa0e6`. Completes item 5 and the Cinema keyboard portion of item 7 in [the UI audit](ui-improvement-audit-2026-10-07.md).

## Result

Cinema opens with collapsed scene settings and a summary of the saved model, aspect ratio, film look, palette and character references. All four connected input roles have named source controls with actual connected-output context. View on Canvas resolves the surviving connection, selects its source and centers it through the existing focus controller; inspecting a pending source never runs it.

The selected preview sits beside the prompt and primary actions on desktop. Scene controls have bounded scrolling; compact and short views use a reachable scrolling body with smaller previews and shot cards. Authoring updates keep the current scroll position. Selecting another shot resets the desktop editor to its prompt and preview. Scene-wide Generate all belongs to the toolbar; selected-shot generation and variations belong to the shot editor.

Palette and film look can be edited for an individual shot. Untouched fields continue to inherit current scene values; Reset to scene removes only that override. Named shot presets own their grade, so inherited custom sliders or LUTs cannot flatten them in the actual renderer. Empty custom controls display the renderer's neutral defaults without authoring a grade. Inherited summaries show actual colors, strength, method and film look; an unused saved palette reference image is not presented as an applied palette.

Native selection buttons support arrows, Home/End and Enter/Space. Alt + arrows and explicit earlier/later buttons reorder while retaining selected-shot identity and focus. Pointer drag remains available. Deleting a selected shot chooses its next surviving neighbor, or the previous shot at the end. Selection is scoped to the scene, including when two scenes reuse shot IDs.

## Acceptance

| Check | Evidence |
| --- | --- |
| Shared settings stay collapsed initially and retain accurate saved values | Component tests for disclosure, saved/unknown model values, references and visible upload recovery |
| Prompt, generation and art direction remain reachable | Native Chrome at 100% and verified 200% zoom, with six synthetic shots and both populated/empty previews |
| Authoring cannot jump the compact body back to the rail | Native prompt and palette-strength edits at 200%; regression tests restrict rail scrolling to selection/order changes |
| Shot palette/look edits and Reset preserve unrelated data | Actual graph-store tests retain siblings, outputs, variations, connections and frozen run history; native scene look change preserves the selected shot override, then Reset restores current inheritance |
| Named presets reach the deterministic image pipeline correctly | Backend handler tests exercise local image artifacts/pixels with a mocked base provider; named/partial/custom look and palette resolution cases |
| Keyboard selection/reorder retains useful focus and stable identity | Component keyboard tests, native arrows/Enter/Space and Alt + Right/Left; reordered shot retains its edited prompt and earlier image |
| Connected sources use the exact output and retain pending connections | All four role/component focus tests, stale/disconnected/import guards and native Camera Rig selection/centering |
| Edits, Reset, selection, reorder and inspection never generate | Execution spies; isolated native fixture ended with zero generation and handoff requests, seven nodes, six edges, original six-shot order and both earlier images intact |

Final gates passed: **3,479 backend tests** and **1,391 frontend tests in 144 files**, full lint/style guards, TypeScript and production build/budget. Build budget: 314,213 bytes raw / 87,739 bytes gzip; 37 JavaScript assets passed the eval guard. Independent review covered the layout, inheritance, focus and renderer contract, then checked the final inherited summaries. Existing FastAPI lifecycle deprecation and deferred large-chunk warnings remain unchanged. Staged whitespace and credential/protected-file scans passed.

## Scope and proof limits

Native browser verification used frontend 5220/backend 8050 with temporary synthetic state, locally drawn logos, blank provider keys and execution-blocking middleware. Private fixture data and JSON proof stay outside Git. The owned preview tab and servers were closed afterward. No paid generation, OAuth, real provider settings, user graph, Commons activation, dependency installation or packaged Electron operation was used. This implementation is committed locally; publication is a separate step.

Upload recovery/admission and saved-recipe history are covered by the integrated component/backend suites. This slice does not add native file-dialog or live-provider proof. Remaining UI work: discovery/readiness, onboarding, complete recipe comparison and shared workspace chrome.

Implementation details: [shot controls](cinema-shot-controls-notes.md), [shared layout](cinema-shared-layout-notes.md), [keyboard contract](cinema-keyboard-contract-notes.md).
