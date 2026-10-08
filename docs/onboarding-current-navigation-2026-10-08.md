# Onboarding repair acceptance — 2026-10-08

The optional tour now follows the current Workspace Rail and Chat launcher. It teaches finding a model, connecting its provider, using Create, inspecting Run History and asking the agent. The catalog count comes from the current definitions. This implements UI audit item 8.

## Behavior

- Welcome offers Take the tour, Start browsing and Skip. Start browsing opens Nodes and keeps the graph; the previous destructive Load a sample graph action is removed.
- Help and Settings reopen at welcome. Starting from a studio returns to Canvas so every target exists, without replacing drafts, selection, connections, results or history. It stops preview playback. Settings retains its existing close-before-tour behavior, with current Help as the focus fallback.
- Every step highlights a stable target. Actual card and target measurements determine placement; resize, scrolling, changed card size and target replacement update it. Missing, hidden or offscreen controls keep a usable centered card. Compact cards have bounded scrolling content.
- The labeled dialog contains keyboard focus and blocks workspace shortcuts. The background remains visible but inert. Back, Next, Done, Skip and Escape have consistent focus; dismissal restores the opener or current Help. In-card focus reveals controls in a scrolling card. Background clicks cannot blur the dialog.
- Advancing, leaving or reopening never loads an example, checks a connection, changes a recipe or submits generation. Stale step callbacks after dismissal remain inactive.
- Delayed empty/error startup hydration can only reset panels and automatically open the tour on a still-empty, first-run Canvas. Existing work, a newly entered studio and an active/completed tour take priority.

## Checks

| Check | Evidence |
| --- | --- |
| Five current anchors and current count | Shared tour/rail tests plus native Chrome at 100% and verified 200% zoom. Nodes, Settings, Create, History and Chat each highlighted their live control. |
| Start/advance/back/exit/reopen | Native Take the tour, all five steps, Done, Back to welcome, Skip, Escape and Start browsing; component regressions. |
| Modal focus and shortcuts | Native reverse/forward Tab wrap, Command-K suppression, background click focus retention and Escape to Help. Tests also cover unfocused document/body keys, programmatic focus escape, late portal siblings, prior inert state and cleanup. |
| Draft and graph retention | Native Settings in Create → welcome → Skip → Create retained the exact unfinished prompt and quantity 2. Seven synthetic nodes, six edges and their backend export remained identical; generation, connection-check and handoff counters all stayed zero. Frozen graph/history/results, dirty Create/Settings drafts and eight workspace transitions are also regression-tested. |
| Geometry and stale ownership | Measured-size/edge/compact placement tests, ResizeObserver/scroll changes, disappearance/replacement and exact current-anchor assertions. |
| Startup races | Deferred empty/failure hydration tests preserve new work, studio navigation and active/completed tours while retaining legitimate first-run onboarding. |
| Integration | 1,523 frontend tests in 151 files; lint/style guards; TypeScript and production build/budget; all 255 node contracts. Initial bundle 325,394 bytes raw / 91,278 bytes gzip. Independent reviews cleared focus, copy, geometry and startup ownership. |

## Evidence boundaries

Native inspection used an owned preview on 5224/8054, synthetic logos and public fixture credentials, with generation blocked. No real account, provider operation, user library, original development checkout or packaged Electron was exercised. Startup race, missing-target and cleanup cases are automated regression evidence; screen-reader and phone behavior are not claimed. Motion is absent for positioning and explicitly disabled under reduced motion.

Private captures and before/after proof remain outside Git at `~/.nebula/audits/2026-10-08/onboarding/`: `nodes-normal.png`, `agent-200.png`, `draft-retained.png` and `proof.json`. Owned servers and the owned browser tab were closed; the original browser tab was restored.

The implementation uses existing dependencies and verified primary references: [React layout measurement](https://react.dev/reference/react/useLayoutEffect), [React portals](https://react.dev/reference/react-dom/createPortal), [MDN inert](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert), [ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver), [MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver) and [WAI-ARIA modal dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

Integrated into main on 2026-10-08 with discovery, result comparison and shared workspace navigation. All eleven original UI audit items now have implementation slices; the verification limits above still apply.
