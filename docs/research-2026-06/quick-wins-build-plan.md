# Quick-Wins Build Plan — Nebula Nodes

> Created 2026-06-21. Scopes the 5 "quick-win" gaps (build step 0 from [flora-comfyui-gap-analysis.md](flora-comfyui-gap-analysis.md)) into an executable plan.
> Each item was scoped by an agent that **verified the actual current code** (file:line evidence) and proposed the smallest correct change.
> **All 5 are effort M. All are frontend-only except friendly-errors (small backend classifier). ZERO new npm/PyPI dependencies** — so the 14-day package-age rule is not triggered.
> Verification is manual in a **real browser via the dev server** (per project memory: no Localhost Space), since there is no wired frontend test harness; the one backend item adds pytest coverage.

---

## Decisions adopted (resolving the scopers' open questions)

These were the open questions; I've taken the recommended default for each so the plan is executable. The 🟠-flagged ones are taste calls worth a look before/while building.

| Item | Decision |
|---|---|
| 🟠 Perf | One **"Performance mode"** Settings toggle (`onlyRenderVisibleElements` + MiniMap + Controls), **default ON**. Separate **"Low detail when zoomed out"** toggle, default ON, threshold **0.4**. *(MiniMap+Controls add visible canvas chrome — see flag below.)* |
| Palette | Unmatched query → **"Ask the agent"** fallback row (discoverable). Palette **wins** over the editor's Cmd+K (capture phase). **Alphabetical-by-group** for v1 (defer MRU). Insert nodes at **viewport center**. |
| Notifications | **Default OFF** (never request permission unprompted; enabling is the user gesture that prompts). **30s** fixed long-job threshold. **Whole-graph completion only**. Sound nested under enabled, default off. |
| Errors | Taxonomy: `blocked / auth / quota / rate_limit / timeout / network / invalid_input / unknown`. `blocked` gets a **calmer-but-still-error** treatment. **Raw error always preserved** in an expandable `<details>`. `retryable=true` for rate_limit/timeout/network. |
| 🟠 Onboarding | **One canonical sample graph** (`text-input → imagen-4-generate`, demo prompt). **"Describe what you want"** opens + focuses the chat panel (**no auto-send** — avoids spending an API call on first run). Gate to match the existing splash (Slava). Include a Settings **"Show onboarding again"** re-entry. |

---

## P0.1 — Large-graph canvas performance  ·  effort M  ·  frontend-only

**Why first:** this is a real *jank risk*, not just polish — the canvas mounts `<ReactFlow>` **without** `onlyRenderVisibleElements`, so every offscreen node card (with previews/handles/bars) stays in the DOM and is composited on every pan/zoom frame. At 100+ nodes this is the primary stutter source.

**Current state (verified):** `Canvas.tsx:559-584` — no `onlyRenderVisibleElements`, no `<MiniMap>`, no `<Controls>` (only `<Background>` at 585-592). `canvas.css` already has **orphaned** `.react-flow__controls` styling (25-36) + a minimap mask token (17) — styled but never mounted, so mounting reuses existing theming. `@xyflow/react@^12.10.2` already exports `MiniMap`, `Controls`, `Panel`, `useStore` — **no new dep**. Settings has a working toggle pattern (`agentLogEnabled`) to copy.

**Steps:**
1. `uiStore.ts` — add two persisted booleans (`canvasPerfMode`, `canvasLowDetail`) following the exact `agentLogEnabled` localStorage pattern (keys `nebula:canvas:perfMode`, `nebula:canvas:lowDetail`, both default true).
2. `Canvas.tsx` — add `onlyRenderVisibleElements={canvasPerfMode}` to `<ReactFlow>`. **Single highest-impact line.**
3. `Canvas.tsx` — conditionally render `<Controls />` + `<MiniMap pannable zoomable .../>` (gated on `canvasPerfMode`) after `<Background>`; MiniMap `nodeColor` muted, themed for Slava.
4. LOD: a tiny `<ZoomLodController/>` child reads live zoom via `useStore((s)=>s.transform[2])` and writes `data-lod` on `.canvas-wrapper` (threshold 0.4) — **no per-node re-render**. Must sit inside the ReactFlowProvider context.
5. `canvas.css` — `[data-lod='low']` rules hide node previews/labels + flatten node box; keep handles/edges visible.
6. `Settings.tsx` — two toggle-rows in the existing "Interface" section.
7. Optional: a `<Panel position='bottom-left'>` node-count readout.

**Risks:** MiniMap/Controls change default chrome (taste); LOD `useStore` must be inside provider; threshold may need tuning; theme for Slava first (only maintained skin).
**Test:** build an 80–150 node graph (Ctrl+D dup), confirm offscreen `.react-flow__node` elements leave the DOM with perf mode on; MiniMap/Controls render + themed in Slava; LOD hides detail past 0.4; toggles persist across reload.

---

## P0.2 — Friendly moderation / safety errors  ·  effort M  ·  backend + frontend

**Why:** multi-provider studios route prompts to hosted models; when a provider returns a moderation/safety rejection the user currently sees the **raw provider HTTP error verbatim** (`engine.py:743-745` emits `ErrorEvent(node_id, error=str(exc))`; nodes show it raw in `DynamicNode.tsx:204` / `ModelNode.tsx:617`). This is the only item with a (small, contained) backend change and it improves trust across every provider with one edit.

**Steps:**
1. **NEW** `backend/execution/error_classifier.py` — pure, exception-proof `classify_error(raw) -> (category, friendly, retryable)`. **Order matters: check `blocked` markers before generic 4xx** (a 400 carrying a moderation marker → blocked). Prefer explicit markers (`moderation_blocked`, `blockReason`, `PROHIBITED_CONTENT`, `content_policy`) over the bare word "safety". Wrap whole body in try/except → `unknown` (truncated raw).
2. `backend/models/events.py` — add optional `category` + `friendly` (+ `retryable`) to `ErrorEvent`; keep raw `error`.
3. `backend/execution/engine.py:743` — classify `str(exc)` in the except block, attach to the emitted `ErrorEvent`. **One edit covers all providers.**
4. `wsClient.ts:8` + `types/index.ts:261` — extend the error event + `NodeData` (`errorCategory`, `errorFriendly`).
5. `graphStore.ts:2726` (`case 'error'`) — write the new fields via `updateNodeData`.
6. **NEW** `frontend/src/components/nodes/NodeError.tsx` — friendly message + distinct `--blocked` treatment + raw in collapsed `<details>`. Use it in **both** `DynamicNode.tsx` and `ModelNode.tsx` (kills drift).
7. CSS `--blocked` modifier in `nodes.css` + `slava-restraint.css` (prioritize — active skin) + `hermes.css` (minimal).
8. **Tests:** `backend/tests/test_error_classifier.py` table-driven over the **exact raw strings** the handlers emit (openai_image, google_gemini, fal_universal, ideogram, replicate, runway "moderation"), incl. the blocked-before-400 case; extend `test_engine.py` with a fake moderation-raising handler.

**Risks:** keyword mis-bucketing (mitigated by explicit-marker priority + always-preserve raw); provider wording drift (graceful → unknown); two node components must both switch to `NodeError`.

---

## P0.3 — Cmd+K command palette  ·  effort M  ·  frontend-only

**Current state (verified):** a Cmd+K handler exists **only** in the video editor (`EditorView.tsx`); `Canvas.tsx` onKeyDown handles Ctrl+Enter/S/O/A/D/Z/C/V; Node Library has its own search. `nodeDefinitions.ts` exports `NODE_DEFINITIONS` (138) + `getNodesByCategory`. `ModelNodeDefinition` has **no description/keywords** (search = displayName + category). `addNode(defId, position)` is async; Toolbar Save/Load dispatch `nebula:save`/`nebula:load` CustomEvents; chat agent listens for `nebula:chat-send`.

**Steps:**
1. **NEW** `lib/commandPalette.ts` — `PaletteCommand` type (id, title, subtitle, group ∈ Nodes/Actions/View/Agent, `perform(ctx)`, `enabled`, `keywords`) + `buildCommands(ctx)`. `ctx` carries `screenToFlowPosition`, `fitView`, toolbar thunks.
2. Node commands from `getNodesByCategory` → `addNode(def.id, viewport-center)`.
3. Lift `CATEGORY_LABELS` out of `NodeLibrary.tsx` into shared `constants/categories.ts`.
4. Action commands: Run=`executeGraph` (enabled when not executing & nodes>0), Save/Load=events, Fit=`fitView`.
5. **NEW** `lib/toolbarActions.ts` — extract `handleClear`/`handleImportCLI`/`handleResetLayout` so Toolbar + palette share one impl (Clear/CLI/Reset may defer to later).
6. View commands: `enterCreateView`, `togglePanel(...)`, `setSkin(...)`. Omit enter-editor (needs entity id).
7. Agent command: switches palette to agent-input mode → dispatch `nebula:chat-send`; an **"Ask the agent"** row catches unmatched queries.
8. **NEW** `CommandPalette.tsx` — `createPortal` overlay, **capture-phase** `document` keydown for ⌘/Ctrl+K (so it wins over EditorView), Esc/arrows/Enter, grouped substring filter (Actions+View first, Nodes last).
9. Mount in `App.tsx` inside `ReactFlowProvider`, outside the isCanvas guards; gate canvas-only commands via `enabled`.
10. **NEW** `styles/command-palette.css` (default + `body.app-slava-restraint`), z-index 1000 (beats panels at 30).

**Risks:** EditorView Cmd+K precedence (capture + stopPropagation, keep `b` split key); node search is displayName+category only (keywords map later); extracting Toolbar callbacks must preserve behavior; z-index must clear chat-bloom FX.

---

## P0.4 — Job notifications  ·  effort M  ·  frontend-only

**Current state (verified):** zero `Notification`/`document.title`/`visibilitychange` usage in `frontend/src`; completion is signaled only by a node-state flip in `graphStore.ts`. Backend **already emits** `graph_complete` with `duration` + `nodesExecuted`. **Key correctness wrinkle:** there is **no terminal "failed" event** — failures arrive as per-node `error` / `validationError`.

**Steps:**
1. **NEW** `lib/jobNotifications.ts` (pure, no React): permission flow (`'Notification' in window` guard), `notifyJobComplete({ok,durationSec,nodesExecuted})`, tab-title badge while `document.hidden`, runtime favicon-dot badge (try/catch → title-only fallback), optional WebAudio beep (no asset). Export a pure `shouldNotifyFor({hidden,durationSec,threshold,enabled})` for unit testing.
2. `shouldNotify = document.hidden || durationSec >= 30`. Fire `new Notification(...)` with `tag:'nebula-job'` + `onclick: window.focus`.
3. Wire `graphStore.ts` `graphComplete` (2741): fire `notifyJobComplete({ok:!runHadError,...})`. Track a per-run **`runHadError`** flag (set in `error`/`validationError`, reset at job start) — **guarantees exactly one notification/run**. `validationError` sets `isExecuting:false` with no following `graphComplete`, so fire directly there too.
4. App.tsx coordinator effect subscribes to `isExecuting` transitions → `startTitleFlash()` (badge only shows while hidden). Keep working-badge concern out of the store.
5. `uiStore.ts` — `notificationPrefs {enabled,sound}` (default `enabled:false`), single key `nebula:notifications`; setter triggers `ensureNotificationPermission()` on enable.
6. `Settings.tsx` — "Job notifications" toggle + nested "Completion sound" (shown when enabled).
7. Guards: `typeof window` + feature-detect; denied permission → degrade to title/favicon; AudioContext created/resumed on enable gesture; idempotent under StrictMode.

**Risks (the trickiest is failure detection):** no terminal fail event → the `runHadError` flag + direct `validationError` notify must be exact or you miss/double-fire; favicon canvas taint (try/catch fallback); permission needs user gesture (enable click); two localStorage readers must agree on one key/shape; AudioContext gesture rule; StrictMode double-mount.

---

## P0.5 — Onboarding / first-run experience  ·  effort M (high severity)  ·  frontend-only

**Current state (verified):** only a static empty-canvas splash (`Canvas.tsx:594-611`, aria-hidden, "drag a node from the library to begin"); `uiStore` default viewMode `'canvas'`; no tour/sample/welcome anywhere. Nebula's multi-surface power is invisible to a new user.

**Steps:**
1. `uiStore.ts` — persisted `hasOnboarded` (key `nebula:onboarded`) + session `onboardingActive`/`onboardingStep` + actions `startOnboarding`/`next`/`prev`/`finishOnboarding`.
2. **NEW** `constants/sampleGraph.ts` — `buildSampleGraph()` **factory** (fresh `uuidv4()` per load) seeding `text-input` (demo prompt) → `imagen-4-generate`, wired `text→prompt`, using the exact local node shape from `graphStore.ts:948-953`. **⚠ verify the `type` strings against the registered `nodeTypes` map and that `imagen-4-generate` is the real node id before finalizing.**
3. **NEW** `components/onboarding/OnboardingOverlay.tsx` — welcome card (step 0: "Take the tour" / "Load a sample graph" / "Describe what you want" / Skip) + spotlight tour (steps 1..N) highlighting the **always-mounted** panel-launcher buttons (`.panel-launcher--nodes/create/chat/moodboard/character`) via getBoundingClientRect + box-shadow "hole". Handle null targets gracefully (auto-advance).
4. `graphStore.ts` — `loadSampleGraph()` near `loadGraph` → builds + loads + dispatches `nebula:graph-nodes-added` so Canvas auto-fits.
5. `App.tsx` — render `{isCanvas && <OnboardingOverlay/>}`; trigger `startOnboarding()` inside GraphHydrator's **empty-canvas** branch only, guarded by `!hasOnboarded && !onboardingActive` (idempotent under StrictMode). Never trigger on a non-empty graph.
6. `Canvas.tsx:594` — suppress the static splash while `onboardingActive`.
7. **NEW** `components/onboarding/onboarding.css` — use Slava CSS vars (`--sr-accent` etc.), `pointer-events:auto` controls + Skip/Escape (a11y).
8. Settings "Show onboarding again" → `startOnboarding()`.

**Risks:** sample-graph node `type` strings must match registered types (verify first); seeded graph is frontend-only until a backend sync (acceptable for a demo); spotlight targets only exist when isCanvas (null-guard); StrictMode idempotency; overlay must be keyboard-focusable + skippable.

---

## Suggested execution order

Independent enough to do in any order, but this sequences by risk/leverage and keeps related files from colliding:

1. **P0.1 perf** — isolated, biggest felt win + risk fix, pure frontend warm-up.
2. **P0.2 friendly errors** — the only backend touch; lands the shared `NodeError` component + classifier + tests.
3. **P0.3 command palette** — larger surface (new lib files); touches Toolbar/NodeLibrary refactors.
4. **P0.4 notifications** — self-contained; the `runHadError` logic in graphStore is the one careful bit.
5. **P0.5 onboarding** — depends on a verified sample-graph node id; nice capstone (also the highest-severity gap).

**Cross-cutting conventions all five reuse:** the `agentLogEnabled` toggle pattern (uiStore localStorage + Settings "Interface" row), Slava-first skin theming, and verify-in-a-real-browser (no Localhost Space).

### Portfolio note (Design Engineer track)
The command palette and the onboarding spotlight tour are both self-contained, polished micro-interactions — candidates for a `/lab` write-up on justinperea.com if they land well. The before/after-of-an-empty-canvas onboarding is a nice "first 30 seconds" story.
