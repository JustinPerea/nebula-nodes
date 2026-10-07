# UI audit repairs — 2026-10-07

The six UI findings are addressed on `codex/audit-web-fixes`, based on published main `998ad87c`, alongside the existing web/backend repairs. The user requested one appearance, so Slava Restraint is now the only supported theme. This report records the original UI acceptance; final release gates are recorded in [the release notes](audit-release-review-notes-2026-10-07.md). The parallel development checkout was not edited; packaged Electron is excluded.

| Finding | Result | Acceptance coverage |
| --- | --- | --- |
| U01 — Bottom-left leftovers | Zoom/fit controls and node count share one bottom-right navigation area, clear of the left rail. Controls remain available with Performance mode off. Compact drawers reserve a separate control row. | Native empty/populated Canvas, compact drawer at 200% browser zoom, performance preference toggle; component regressions. |
| U02 — Light minimap mask | Explicit dark mask, canvas background, borders and controls. Collapse/restore preserves the saved preference; a compact open drawer temporarily hides the map. | Native empty/populated Canvas, collapse/restore and preference toggle; component regressions. |
| U03 — Hidden studio panels | Shared Settings/Chat docks render above Create. Both take focus on opening and close with Escape. Disabled Chat input falls back to an enabled control while connecting; readiness does not steal focus. | Native Settings from the Krea notice and Chat from commands, overlay visibility and Escape; connecting/reopening/focus regressions. Other studio mounting/layers checked in source. |
| U04 — Save/Load no-ops | One persistent controller owns file commands and standard shortcuts across workspaces. Toolbar and palette use shared dispatch and matching availability checks. Successful Load returns to Canvas after backend confirmation, preserving prior run history. | Automated Create/Cinema/Editor/Remotion shortcuts, cancellation, duplicate prevention, viewport retention, atomic import and ownership races. Native Create shortcuts open actual dialogs; completion limitation below. |
| U05 — Clipped model picker | Viewport-constrained modal portal keeps search/provider controls visible while results scroll. Escape closes once, Tab stays inside, and closing restores the opener. | Native 100%/200% zoom; filtering, outside click, Escape and focus regressions. |
| U06 — Unsupported theme layouts | Removed theme picker, theme commands, Hermes stylesheet, tone/bloom controls and agent-triggered theme switching. Old saved choices normalize to Slava Restraint on load. Agent selection, model/provider/session behavior and Auto/Step remain. | Migration and agent-control regressions; native Settings without theme choices and Daedalus retaining the same appearance. |

## Validation

- **993 frontend tests across 104 files passed.**
- Full lint, inline-style and CSS-scope guards passed.
- TypeScript production build and bundle budget passed: 296,784 startup bytes raw / 82,936 gzip; 34 JavaScript assets are eval-free.
- Updated utility/capture/screenshot helpers pass syntax checks. The legacy CDP screenshot harness was not executed; native computer use supplied the live UI checks.
- An independent source review caught and repaired the disabled Chat focus case. No further material UI or command-ownership defect was identified in that review.
- Browser checks used private local state with empty credentials and blocked generation handlers. No generation, OAuth consent, agent message, merge or push occurred. Screenshots and native chooser evidence remain outside Git.
- Backend code was unchanged by this UI repair. Its prior 2,435-test result is recorded in [the web/backend repair report](audit-web-fixes-2026-10-07.md), not rerun as part of this UI-only pass.

## Native file chooser limitation

Save/Open from Create now reach their actual native dialogs instead of silently doing nothing. Dia's native chooser leaves its final Save/Open button disabled in this environment. An independent page opening an unfiltered Save picker with an ordinary `.zip` filename reproduces the disabled Save button in the same private directory. The dialogs were cancelled; an end-to-end native file round trip is not claimed.

The file serializer and restore pipeline are unchanged by this UI repair. Automated tests cover bundle generation and the persistent command controller's routing, cancellation, rejected imports, execution/preparation guards, late ownership changes, and preservation of previous history. Native file completion remains a manual verification item.
