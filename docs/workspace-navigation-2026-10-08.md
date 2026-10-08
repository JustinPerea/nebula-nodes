# Shared workspace navigation and controls

Implemented UI audit item 11 on isolated `codex/workspace-navigation`, above the local discovery, onboarding and result-comparison slices. No main publication was requested. Backend handlers, model definitions, dependencies, real accounts and packaged Electron are outside this change.

## Experience

- Canvas, Create, Cinema, Character, Moodboard, Video editor, Composition and Commons use one active workspace heading. Back names its actual destination; Commons retains its previous-workspace return and unsaved-labeling guard. Covered Canvas controls unmount when a studio is active.
- Canvas keeps Run/Stop visible. Canvas actions groups labeled graph file and layout tools, with Save/Open shortcuts, bounded scrolling, native button focus and Escape returning to its opener. Fit remains in Canvas navigation. Existing execution, import and uncertain-provider-start guards remain enforced.
- Returning restores the selected nodes and previous Canvas camera. Explicit View on Canvas still centers its target. Authoritative graph replacement resets obsolete camera and Cinema shot context; ordinary output synchronization retains both.
- Cinema remembers the inspected shot per scene. Create retains its existing draft/history. Character and Moodboard retain unfinished drafts, completed references and unsent edits across workspace switches. Existing debounce save behavior resumes only for valid dirty drafts; navigation never submits generation.
- Edit video requires a real settled Video result, and activation rechecks current selection, output and import ownership. Video preview Space leaves native navigation, typing and media controls available.

## Ownership decisions

Draft continuity is session memory, not browser-reload persistence. Drafts are separated by asset, scope and resolved backend project identity. A first successful save moves to one canonical draft; the original new-draft route resolves that draft until explicit New starts another epoch. Old asynchronous saves can settle their owning cache without redirecting the active workspace. Unfinished uploads are discarded after leaving; completed references remain.

Moodboard analysis uses a per-draft request token and authoring revision for result, error and busy-state ownership. Switching assets, overlapping requests and first-save ID adoption cannot clear another request or replace newer edits. Character test handoffs retain authored nodes but reject late navigation after leaving or reopening. Graph import fits cancel on any workspace transition, including a quick away/back round trip.

Shared headers wrap in measured auto rows with bounded scrolling, including lazy studio styles. Composition's tool groups wrap. Canvas actions composite the existing glass colors onto a solid base so graph text cannot interfere with labels. The established dark appearance remains.

## Verification

- 1,680 frontend tests in 163 files passed. Coverage includes camera restoration, selected-shot identity, graph replacement versus output hydration, draft aliases, project switching, save/upload/analysis races, late handoffs, keyboard controls and existing generation-admission tests.
- ESLint/style guards, TypeScript, production build/budget and all 255 node contracts passed. Entry bundle: 328,673 bytes raw / 92,009 bytes gzip; 37 JavaScript assets passed the runtime-code-generation scan.
- Independent reviews found and verified the draft ownership repairs, delayed-fit cancellation, actual-video gating, native Space ownership and lazy-style layout fixes.
- Private in-app browser preview on 5228/8058 verified exact Canvas camera/selection restoration, Create draft retention, Cinema Shot 2 retention, unfinished Character/Moodboard drafts, Commons heading/return, and secondary tool focus/Escape. Compact 600×379 inspection showed the menu inside the viewport with scrolling to its final action.
- Final exact graph export remained unchanged: seven synthetic nodes and six connections. Zero generation, provider-check or motion-handoff requests. No paid provider execution was attempted.

The preview initially omitted the separate Moodboard root, exposing a read-only library list. No existing asset was opened or changed; the root was isolated and the preview restarted before Moodboard authoring. Final graph proof compares the fully isolated restarted fixture. Screenshots, fixtures and proof files stay outside Git.

Actual native browser 200% zoom is unverified; compact viewport inspection is not a substitute for that proof. Commons navigation was checked in its unauthenticated fixture state, not against a live library. Temporary viewport overrides, tabs and servers were restored or closed after verification. This slice remains local and unmerged.
