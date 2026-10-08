# Nebula Nodes UI improvement audit — 2026-10-07

The next UI pass should make it easier to finish a task without losing the draft, the selected object, or the result's context. Keep the current restrained dark appearance and concentrate on layout, continuity, discovery and truthful feedback.

## Scope and evidence

- Published `main`: `362d201b46caf9e6d956353d5d1ff4107a0883b7`, fetched and verified on this date.
- Isolated branch: `codex/ui-audit-2026-10-07`. Application code was not changed during the original audit.
- Native Chrome inspection used a separate local preview, temporary backend state, empty real credentials, 12 locally drawn synthetic image outputs, one prompt and a two-shot Cinema scene. Generation was blocked in the preview; no model or agent was run.
- Browser checks covered Canvas, node search, Create draft navigation, grid/list results, onboarding, Cinema layout, and shot override controls at 100% and 200% zoom. Captures were 2400 × 1690 physical pixels; this was a desktop browser test, not a phone or Electron test.
- A temporary backend API probe used an unknown synthetic credential field to check empty-key removal semantics. No real account or credential was read or changed.
- Real Commons stayed disabled. The active development checkout, running app, private libraries and parallel Brand Lab work were left alone.

Evidence labels below: **Browser** means observed in the synthetic local UI; **Source** means traced through current repository code without reproducing the failure at runtime; **Design** means an improvement proposed from the observed product experience. These are not live-provider results.

## Prioritized repairs

### 1. Preserve unfinished Create work — P1, Browser + Source

**Observed:** Entering a prompt and increasing variations from one to two, returning to Canvas, and reopening Create produced an empty prompt and one variation. Existing Canvas nodes remained. Running-job persistence does not preserve this unfinished composer state.

**Change:** Keep prompt, model, parameters, references and quantity in a session draft. Resume the draft when returning; make starting over an explicit action. A Canvas selection can offer to populate the composer without silently replacing a draft.

**Evidence:** `frontend/src/components/create-studio/CreateView.tsx:47–75`; conditional studio mounting in `frontend/src/App.tsx:289`.

**Acceptance:** A configured draft survives Canvas/History navigation. Explicit reset clears it. Navigating or restoring the draft sends no generation request and preserves earlier runs.

### 2. Give results a bounded scrolling layout — P1, Browser + Source

**Observed:** Twelve results fit in the normal grid, but switching to List clipped the gallery toolbar and the first/last items. Scrolling over the list did not reveal the missing content. At 200% zoom, the grid also clipped its toolbar and results, while the wrapping composer covered much of the remaining gallery. Hovered result actions overlapped the composer.

**Change:** Keep the result toolbar stationary and give the cards a dedicated scrolling region. Reserve the actual composer height rather than a fixed padding amount. Use compact list rows with a bounded thumbnail, metadata and actions. Ensure the composer can itself scroll or collapse at short heights.

**Evidence:** `frontend/src/styles/create-studio.css:35–42`; `frontend/src/styles/create-gallery.css:120–174`, `256–275`.

**Acceptance:** With 30 synthetic results, a multiline prompt, normal/short viewports and 200% zoom, the first and last cards, result filters, and Generate remain reachable without overlapping controls.

### 3. Make reference intake visible and safe — P1, Source

**Problem:** Create reference uploads have no pending/error state; a failure only reaches the console. Generate is available while an upload is pending and captures only references that have already completed. In Cinema, upload completion closes over an older shot and entire scene; applying that scene can overwrite newer edits, shots or results.

**Change:** Show pending, accepted and failed reference chips with retry/remove. Prevent submission until intended attachments are ready. Apply Cinema upload results to the latest scene by stable node/shot ID, updating only the reference field; do not replace the old scene snapshot.

**Evidence:** `CreateView.tsx:161–167`, `188–193`; `CreateComposer.tsx:38`; `cinema-studio/CinemaShotPanel.tsx:70–90`; `CinemaStudioView.tsx:113–117`; `CinemaSharedControls.tsx:84–120`; `store/graphStore.ts:4105–4131`. Component paths are under `frontend/src/components/`.

**Acceptance:** Delay or fail an upload. Pending/error states stay visible, no job starts with a missing intended reference, and prompt edits, shot additions/deletions, connections and new outputs made during the upload survive its completion.

### 4. Make Settings load/save/removal trustworthy — P1, Source + synthetic API

**Problem:** Failed settings loading only logs an error, then enables the form and Save. Saving the initial blank/default fields can overwrite non-secret settings. Clearing a browser provider key submits an empty string, which the backend ignores while returning `saved`. The synthetic API probe confirmed the field remained configured after an empty-string update.

**Change:** A persistent load/error/retry state must precede editing and saving. Mark unsaved changes and make dismissal predictable. Provide an explicit provider-scoped Remove action with deletion semantics and refresh connection readiness after success.

**Evidence:** `frontend/src/components/panels/Settings.tsx:85–125`, `174–190`, `492–505`; `backend/main.py:2499–2521`.

**Acceptance:** A failed GET cannot submit defaults. Retry retains intended edits. Removing one synthetic key stays removed after reopening and leaves other providers untouched. Errors remain actionable instead of disappearing after a short timer.

## Product and visual improvements

### 5. Put the selected Cinema shot at the center — P2, Browser + Source + Design

**Observed:** The expanded shared settings and shot rail consumed most of the initial screen. The large empty preview pushed the prompt and actions below the fold; reaching them required scrolling the lower panel. At 200% zoom the shared band and rail left no visible selected-shot panel. Checking both override boxes revealed no controls to edit their values.

**Change:** Collapse scene-wide settings into a summary with an expandable inspector. Keep the selected preview and prompt together with clear shot/scene generation scope. Reveal editable palette/look controls when overridden, show inherited values, and offer Reset to scene. Reuse the existing app's control shapes, spacing, focus treatment and accent for sliders/selects; the current Cinema controls look inconsistent with Canvas/Create.

**Evidence:** `frontend/src/styles/cinema-studio.css:14–28`, `95–147`; `frontend/src/components/cinema-studio/CinemaShotPanel.tsx:49–67`, `235–244`.

**Additional source gap:** The Studio summarizes only connected `character_refs`; Character, Camera Rig and Reference Set also affect execution. Show named source chips and a View on Canvas action for all active inputs (`CinemaStudioView.tsx:58–81`; `backend/handlers/cinema_scene.py:327–333`, `420–425`).

**Acceptance:** Selected-shot content stays usable at short heights and 200% zoom. Edit one shot's look without changing siblings; shared changes respect overrides; reset restores inheritance. All connected input roles are inspectable. Opening controls or navigating never generates.

### 6. Improve node discovery and setup context — P2, Browser + Source + Design

**Observed:** Searching “animate a logo” returned a completely blank library with no empty-state explanation or recovery. The category list exposed the internal label `3d-gen`. Rows otherwise offer names with little help distinguishing overlapping models or routes.

**Change:** Share search vocabulary across the library, Create picker and command palette: name, provider, category, descriptions and task terms. Add concise capability/input summaries and provider filters. Show an explicit no-results state with suggested searches. Distinguish configured, verified and unavailable connections, with a direct setup action. Keep models browsable before connecting a provider.

**Evidence:** `frontend/src/components/panels/NodeLibrary.tsx:76–84`, `211–231`; category label map in the same file. Create and command search already consider more metadata (`frontend/src/lib/createModels.ts:49–57`; `commandPalette.ts:81–88`).

**Acceptance:** Provider/category/task terms return useful, consistent results. Empty searches explain the outcome and offer recovery. Adding or inspecting a node never starts generation.

### 7. Make result actions work beyond hover — P2, Browser visibility + Source

**Problem:** Export, use-as-input, Canvas and delete actions appear only while hovering a card. CSS `display:none` removes them from keyboard navigation; the video expand button has the same issue. Image fullscreen is separately reachable through its full-card button. The Lightbox declares a modal but does not take/trap focus or restore its opener. Cinema shot cards are focusable pseudo-buttons without Enter/Space handlers.

**Change:** Give cards a persistent, compact action menu plus focus/touch equivalents. Reuse the app's panel focus-management pattern for fullscreen. Use a native shot-selection button with a separate remove action and keyboard reordering.

**Evidence:** `frontend/src/styles/create-gallery.css:262–315`; `frontend/src/components/create-studio/Lightbox.tsx:31–49`; `frontend/src/components/cinema-studio/CinemaShotsRail.tsx:67–75`.

**Acceptance:** Tab reaches every result action without pointer hover. Fullscreen contains focus; Escape returns to the result. Enter/Space selects shots. Touch does not require hover. Destructive and generation actions never run just from focus or selection.

### 8. Repair onboarding to match the current app — P2, Browser + Source

**Observed:** The Node Library and Create steps appeared as centered cards without highlighting the rail controls. The tour still says “138 nodes.” Source selectors target launchers replaced by the Workspace Rail.

**Change:** Anchor steps to stable selectors on current controls, derive catalog copy from the current definitions, and teach one useful task. Keep the tour optional and provide consistent dialog focus/return behavior.

**Evidence:** `frontend/src/components/onboarding/OnboardingOverlay.tsx:14–17`, `49–58`; `frontend/src/components/WorkspaceRail.tsx:88–108`.

**Acceptance:** Each step highlights its live control at normal and compact layouts; no stale counts; keyboard focus stays within the tour and returns to its opener when dismissed.

### 9. Show dependable handoff feedback — P2, Source

**Problem:** Cinema's Send to motion displays “Sent” even when backend node creation fails and returns `null`. On success, the user stays in Cinema without a clear way to find the new destination.

**Change:** Confirm the returned node ID before reporting success, show pending/error/retry, and offer View video node that returns to Canvas focused on the connected destination. Explain that the action creates a connected video node and retains explicit generation.

**Evidence:** `frontend/src/components/cinema-studio/CinemaShotPanel.tsx:121–147`; `frontend/src/store/graphStore.ts:2338–2367`.

**Acceptance:** Failed creation never announces success. A successful handoff creates exactly one node/edge, navigation focuses it, and no generation request is sent until explicitly requested.

### 10. Give results context and a comparison workflow — P2, Browser + Source + Design

**Implemented locally, 2026-10-08:** recorded model/time, expandable frozen recipes and connected inputs, pinned two-result comparison and explicit draft reuse/Undo. Ordinary execution now retains immutable output provenance. Tests, native-control limitations and synthetic browser evidence: [result context and comparison](result-context-comparison-2026-10-08.md).

**Observed:** The gallery presents media with no model, time, prompt or recipe caption; similar images are hard to identify. Prompt/time metadata exists in gallery items but is dropped when rendering cards.

**Change:** Add a compact model/time caption with expandable recipe details, side-by-side comparison and Reuse settings. Reusing should populate a draft; generating remains a separate explicit action. Earlier snapshots and run history stay immutable.

**Evidence:** `frontend/src/lib/createGallery.ts:67–73`; `frontend/src/components/create-studio/ResultsGallery.tsx:121–129`; `ResultCard.tsx:103–177`; `Lightbox.tsx:83`.

**Acceptance:** Identify and compare two similar results, inspect their recipes, and reuse one without automatically generating or replacing an earlier result.

### 11. Unify navigation and control hierarchy — P3, Browser + Source + Design

**Observed:** Canvas has a rail, top Canvas/Editor switch and bottom toolbar; Create and Cinema have separate headers and return/history controls. The visible studio Canvas return buttons worked. Extra Canvas/Editor controls remain mounted behind both studios and exposed in the accessibility tree; their Canvas handler only handles Editor mode. Canvas also exposes both Fit View and Fit to screen, and some tooltips contain backend terms such as `cli_graph`.

**Change:** Adopt one workspace header/return pattern, remove covered controls from the active accessibility/focus order, and keep the selected object and previous viewport on return. Label the primary task action; group secondary file/layout actions under a small menu. Use product language for Clear/Import. Improve the legibility of task labels and status text while keeping decorative wordmarks quiet; measure specific contrast/size problems before broad token changes.

**Evidence:** `frontend/src/App.tsx:301`; `frontend/src/components/CanvasTabs.tsx:31–47`; native Canvas/Studio trees; `frontend/src/components/panels/Toolbar.tsx`; `frontend/src/styles/slava-restraint.css`.

**Acceptance:** Every workspace has one accurate active label and working return route. Hidden chrome cannot receive keyboard focus. Selected nodes, draft, runs and viewport survive switching. Secondary tools remain discoverable with labels/shortcuts.

## Suggested order

1. **Protect work:** Create draft, reference-upload patches/status, Settings loading/removal, truthful motion handoff. These prevent lost edits or misleading success.
2. **Make the main loop usable:** Results scrolling/actions and Cinema selected-shot layout/overrides. Retain explicit generation and immutable history.
3. **Help people find and understand things:** Discovery/readiness, onboarding, recipe captions/comparison, consistent workspace chrome.

The first small UI slice can be Create draft preservation plus the bounded gallery and visible result actions. The Cinema upload race and Settings guard should be treated as correctness repairs alongside that visual work, rather than waiting for a redesign.

## Prior repairs and remaining proof limits

The already repaired bottom-left control placement, dark/collapsible minimap, studio docks, Save/Load ownership, viewport-bounded model picker and removal of alternate themes were not counted as outstanding defects. No alternate appearance is proposed.

The original audit does not claim live provider generation, native file-dialog success, Commons activation or Electron delivery. Application code and tests were not modified or run for that review; evidence was the current source, the listed native browser checks and the synthetic Settings API probe.

## First repair slice — 2026-10-07

- Implemented item 1 (Create draft preservation) and item 2 (bounded result browsing).
- Implemented the Create portion of item 3 (pending/error/retry/remove references and Generate admission) and item 7 (persistent actions/fullscreen focus). Cinema upload/shot controls remain outstanding.
- Added model/node labels and available prompt excerpts from item 10; full recipe inspection, comparison and Reuse settings remain outstanding.
- Verified with 1,225 frontend tests, lint, TypeScript/production build/budget, and native Chrome with 30 synthetic results at 100% and 200% zoom. No paid provider was called.
- Full acceptance and proof limits: [Create UI repair acceptance](create-ui-repairs-2026-10-07.md). Settings, Cinema, discovery, onboarding and shared navigation remain in the audit queue.

## Second repair slice — 2026-10-07

- Implemented the Cinema portion of item 3: stable upload ownership, visible per-file recovery, interrupted reload handling and generation admission. Converted authoring to latest-state field patches and protected browser/backend scene persistence against stale writes. Results, edges and frozen history remain intact.
- Implemented item 4: guarded Settings loading, volatile unsaved drafts, visible retry, scoped browser provider-key removal and readiness response ownership.
- Final integrated checks passed: 3,425 backend tests, 1,298 frontend tests in 136 files, full lint, TypeScript/production build/budget, independent review and staged whitespace/credential scans.
- Verification and proof limits: [Cinema and Settings repair acceptance](cinema-settings-ui-repairs-2026-10-07.md). The native chooser is still unverified; no paid provider, real credential, packaged Electron or main publication was used.
- The next correctness item is truthful Send to motion feedback (item 9); Cinema selected-shot layout/override controls and keyboard selection also remain. Discovery, onboarding, full recipe comparison and shared workspace chrome are still outstanding.

## Third repair slice — 2026-10-08

- Implemented item 9: dependable motion handoff feedback, confirmed typed connection, idempotent retry and View video node with Canvas selection/centering. Sending and navigation never generate.
- Protected handoff ownership against shot switching, deletion/retyping, replacement, stale HTTP and canonical edge-only removal. Earlier results/history remain intact; local scene handoff has one undo snapshot.
- Final checks passed: 3,465 backend tests, 1,342 frontend tests in 140 files, lint/TypeScript/production build/budget and independent review. Native Chrome verified failure/retry/connection/focused return with synthetic logos and no generation.
- Acceptance and protocol ceiling: [Cinema motion handoff](cinema-motion-handoff-2026-10-08.md). Cinema selected-shot layout/override controls and keyboard selection are the next slice; discovery, onboarding, recipe comparison and shared workspace chrome remain.

## Fourth repair slice — 2026-10-08

- Implemented item 5: selected-shot preview/prompt layout, collapsed bounded scene settings, editable palette/look overrides, Reset to scene and all four named connected input roles with View on Canvas.
- Implemented the Cinema keyboard portion of item 7: native selection, arrows/Home/End, explicit and Alt-arrow reordering, stable selection/focus after reorder/delete. Editing no longer scrolls the compact body back to the rail.
- Corrected the renderer contract so a named shot film-look preset owns its grade instead of inheriting scene custom values/LUTs. Partial overrides continue to inherit; edits preserve earlier outputs, connections and frozen run history and never generate.
- Final checks passed: 3,479 backend tests, 1,391 frontend tests in 144 files, lint/TypeScript/production build/budget and independent review. Native Chrome at 100%/200% verified controls, inheritance/reset, keyboard reorder and source selection with synthetic artwork and zero generation requests.
- Acceptance and proof limits: [Cinema layout and controls](cinema-layout-controls-2026-10-08.md). Discovery/readiness (item 6) is the next slice; onboarding, full recipe comparison and shared workspace chrome remain outstanding.

## Fifth repair slice — 2026-10-08

- Implemented item 6: shared task/provider/category search, friendly labels, actual input/output summaries, supported-route provider filters and useful empty-state recovery across Nodes/Create/commands.
- Added current connection feedback and separate targeted Settings setup without replacing the Create draft or changing saved recipes. Verification is explicit, sanitized, expires and rejects replies from older credential revisions; browsing and setup never generate.
- Corrected readiness for legacy Ideogram Reframe fallback, direct-key precedence, saved Krea billing modes and keyless local/OAuth prerequisites. Models remain browsable and addable while disconnected.
- Final gates passed: 1,475 frontend tests/148 files, lint/style guards, TypeScript/production build/budget, all 255 node contracts and independent review. Native Chrome normal/200% checks used synthetic connections, retained seven earlier nodes/six edges and sent zero generation requests.
- Acceptance and proof limits: [Model discovery and setup](model-discovery-setup-2026-10-08.md). Onboarding (item 8), full recipe comparison (item 10) and shared workspace chrome (item 11) remain outstanding.

## Sixth repair slice — 2026-10-08

- Implemented item 8: a current optional five-step tour, stable rail/chat targets, catalog-derived count and measured bounded placement. Safe Start browsing replaces destructive welcome sample loading.
- Added modal focus/background/shortcut ownership, opener/Help restoration and predictable navigation/reopening without graph, draft, recipe or run changes. Delayed startup hydration yields to new work, studio navigation and active/completed tours.
- Final checks passed: 1,523 frontend tests/151 files, lint/style guards, TypeScript/production build/budget, all 255 node contracts and independent review. Native Chrome normal/200% exercised every live target, navigation/dismissal and Create draft retention. Seven synthetic nodes/six edges stayed unchanged with zero generation or connection checks.
- Acceptance and proof limits: [Onboarding repair](onboarding-current-navigation-2026-10-08.md). Full recipe comparison (item 10) and shared workspace chrome (item 11) remain outstanding.
