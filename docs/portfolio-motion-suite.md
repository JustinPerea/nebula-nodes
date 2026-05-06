# Motion Suite — Slava-Restraint skin (nebula_nodes)

> **Portfolio destination**: `justinperea.com` (case study or `/lab` page).
> Surface this when the portfolio polish session begins.

**Started**: 2026-05-05
**Branch**: `ui/explore`
**Skin**: Slava — Restraint (Direction A)
**Status**: 15 of 15 prioritized motion shipments complete (audit in `~/Documents/Obsidian Vault/Research/topics/motion-libraries-2026-05.md`)

---

## What this is

A coordinated suite of tuned micro-interactions on the Slava Restraint skin of `nebula_nodes`. Each interaction picks a calibrated cubic-bezier from a researched preset table (motion.dev, Apple WWDC23, Material 3, Vaul / Sonner). All animate "safe" properties only inside React Flow nodes — a constraint codified after **three failed `transform`-based handle iterations** that became the technical anchor of the case study.

The work is paired with a reusable `motion-design` skill at `~/.claude/skills/motion-design/SKILL.md` and the canonical research note at `~/Documents/Obsidian Vault/Research/topics/motion-libraries-2026-05.md`.

---

## Interactions shipped

### 1. Selected node halo breathe
- **Pattern**: continuous breath (1.6s ease-in-out, infinite)
- **Property**: `box-shadow` (blur 18px → 30px, alpha 28% → 65% via `color-mix`)
- **Curve**: `ease-in-out` (sine approximation for organic breath)
- **File**: `frontend/src/styles/slava-restraint.css` — `@keyframes slava-select-breathe`
- **Why this curve**: ease-in-out approximates sine; gives "alive" pulse, not a strobe
- **Why this property**: `box-shadow` is interpolatable; works inside `.react-flow__node` per the codified rule
- **Reduced-motion**: pinned to mid-point (24px / 45%)

### 2. Handle hover fade
- **Pattern**: hover transition (200ms one-shot)
- **Property**: `opacity` / `border-color` / `box-shadow`
- **Curve**: `cubic-bezier(0.32, 0.72, 0, 1)` (Vaul's drawer curve — iOS-style "ease-out heavy")
- **File**: `frontend/src/styles/slava-restraint.css` — `.react-flow__handle` rule
- **Why this curve**: asymmetric (Material 3 deprecated symmetric to "legacy"); fast accel + long settle
- **Why this property**: same React Flow safe rule

### 3. Edge mount draw
- **Pattern**: SVG entrance (280ms one-shot, plays on edge mount)
- **Property**: `stroke-dashoffset` (100 → 0)
- **Curve**: `cubic-bezier(0.05, 0.7, 0.1, 1)` (Material 3 *emphasized-decelerate* — the M3 spec curve for "incoming elements")
- **Files**:
  - `frontend/src/components/edges/TypedEdge.tsx` — added `pathLength={100}` to BaseEdge
  - `frontend/src/styles/slava-restraint.css` — `@keyframes slava-edge-draw`
- **Pattern detail**: `pathLength="100"` SVG attribute normalizes any bezier path so a single `stroke-dasharray: 100` works regardless of actual path length.
- **Edge case handled**: keyframe at 100% jumps `stroke-dasharray: none` so subsequent `.animated` (executing-edge marching ants) state isn't blocked by the static dash.
- **Identity preserved**: xyflow keeps DOM identity stable per edge ID, so the animation doesn't re-fire on node-drag re-renders. One-shot per edge instance.
- **Reduced-motion**: `animation: none` + `stroke-dasharray: none`

### 4. Toolbar button press feedback
- **Pattern**: tap feedback (80ms press / 220ms release)
- **Property**: `transform: scale`
- **Press curve**: 80ms `ease-out` (immediate snap)
- **Release curve**: `cubic-bezier(0.34, 1.56, 0.64, 1)` 220ms (back-ease — briefly exceeds scale 1.0 around 65% progress, settles to 1)
- **File**: `frontend/src/styles/slava-restraint.css` — `.toolbar__button` rule
- **Why this combo**: snap on press = tactile commit; back-ease release = "pop" without keyframing past 1.0
- **Why this property**: toolbar lives **outside** React Flow, so `transform` is safe (no xyflow inline-transform conflict)

### 5. Panel mount entrance
- **Pattern**: mount choreography (500ms one-shot, plays on every fresh mount)
- **Property**: `opacity` + `transform: scale + translateY`
- **From**: opacity 0, scale 0.96, translateY +8px
- **To**: opacity 1, scale 1, translateY 0
- **Curve**: `cubic-bezier(0.32, 0.72, 0, 1)` (Vaul's drawer curve — same as #2 but at the longer **Drawer** preset duration)
- **File**: `frontend/src/styles/slava-restraint.css` — `@keyframes slava-panel-enter` applied to `.panel` base
- **Surfaces**: Library, Inspector, Settings, Chat — all inherit `.panel` base class
- **Why direction-agnostic**: panels are draggable so we can't assume left/right/top side. Fade + slight scale + lift gives "emerging from surface" without committing to a side.
- **Why `animation-fill-mode: backwards`**: keeps the from-state applied during any animation-delay and avoids a one-frame flash of the to-state in some browsers
- **Why this property**: panels live **outside** React Flow, so `transform` is safe
- **Asymmetry note**: mount-only animation (hide is instant unmount). Symmetric exit would require an `exiting` state in the uiStore + `setTimeout` on unmount; deferred as a follow-up.
- **Reduced-motion**: `animation: none`

### 6. Connection snap (catch)
- **Pattern**: state-driven transition (140ms one-shot when `.connecting` / `.connectingto` is added by xyflow)
- **Property**: `box-shadow` (orange ring spread 0 → 4px) + `border-color` (white → `var(--sr-accent)`)
- **Curve**: `cubic-bezier(0.05, 0.7, 0.1, 1)` (M3 emphasized-decelerate — same as #3)
- **File**: `frontend/src/styles/slava-restraint.css` — `.react-flow__handle.connecting` rule
- **The interpolation trick**: rest-state box-shadow is **two layers** — `0 0 0 0 transparent, 0 1px 4px rgba(0,0,0,0.6)`. The first transparent zero-spread layer is a *placeholder slot* so the connecting state's two-layer shadow can interpolate cleanly. Without it, browsers can't tween from a 1-shadow list to a 2-shadow list and the orange ring snaps in instead of fading.
- **Asymmetric timing**: catch (entering `.connecting`) uses 140ms M3 decel for tactile commit; release (returning to rest) uses the slower 200ms Vaul curve from the base handle rule. Snappier in, settled out.
- **Why this property**: stays inside the React Flow safe-property rule
- **Audit quote**: *"Make this a 140ms accel-out so it reads as a catch instead of a state flip."*

### 7. Inspector content swap
- **Pattern**: key-driven remount choreography (120ms one-shot on every node-selection change)
- **Property**: `opacity` (0 → 1) + `transform: translateY` (4px → 0)
- **Curve**: `cubic-bezier(0.05, 0.7, 0.1, 1)` (M3 emphasized-decelerate — same as #3 / #6)
- **Files**:
  - `frontend/src/components/panels/Inspector.tsx` — added `key={selectedNodeId}` to `.panel__body`
  - `frontend/src/styles/slava-restraint.css` — `@keyframes slava-inspector-swap`
- **Pattern detail**: React's `key` prop forces unmount/remount when its value changes. Adding `key={selectedNodeId}` to `.panel__body` makes the body subtree remount on every node-selection change → CSS animation fires on every fresh mount. Component-level state (modelSearch, showInfo, favorites) lives in the parent Inspector component which doesn't remount, so it survives.
- **Why this isn't applied to all panels**: only Inspector has nodeId-keyed content. Library / Settings / Chat are all "show whatever the panel is for" without a per-node identity, so no swap needed.
- **Co-existence with panel mount**: when first opening Inspector, both `slava-panel-enter` (500ms outer) and `slava-inspector-swap` (120ms inner) play simultaneously — the body's faster fade is invisible underneath the panel's longer opacity ramp. Subsequent node-selection changes only trigger the body swap.
- **Reduced-motion**: `animation: none`

### 8. Connector handle dot → circle reveal (the closing-the-loop one)
- **Pattern**: state-driven shape transformation (220ms one-shot on hover; 140ms on `.connecting` / `.connectingto`)
- **Properties animated**: `clip-path` (size), `background-color` (fill), `border-color` (ring), `box-shadow` (drop-shadow), `+` glyph `opacity` (twin pseudo lines)
- **Curve**: `cubic-bezier(0.32, 0.72, 0, 1)` (Vaul) for hover; `cubic-bezier(0.05, 0.7, 0.1, 1)` (M3 emphasized-decel) for `.connecting` catch
- **File**: `frontend/src/styles/slava-restraint.css` — `.react-flow__handle` rule + hover/connecting overrides
- **From** (rest): clip-path `circle(4.5px at center)`, bg white, transparent border, transparent box-shadow, `+` opacity 0
- **To** (hover/connecting): clip-path `circle(10px at center)`, bg dark glass, white 1px ring, drop-shadow, `+` opacity 1
- **Why `clip-path` is the breakthrough**: it's a **paint-only** CSS property. Unlike `transform`, it doesn't compose with React Flow's inline `transform: matrix()` on the handle. The layout box stays 20×20 throughout — the center literally cannot drift, since clip-path only changes which pixels are painted.
- **The "three failures" payoff**: this is the same dot-to-circle reveal that crashed and burned three times earlier in the session. v1 (radial-gradient swap) had visual state mismatch. v2 (`scale` + `transform-origin: 50% 50%`) measured a 15.3px center drift no matter the origin. v3 (per-direction pseudo-element edge anchoring) tripped a browser cascade bug. v4 succeeds because clip-path bypasses the entire transform composition problem.
- **Hit-area trade-off**: `clip-path` DOES restrict pointer events, so the click target at rest is the visible 9px dot. Smaller than the iOS 44pt minimum, but matches the "small mark, intentional click" aesthetic. The hover trigger (cursor entering the dot) is the proxy for connection-drag intent.
- **The pattern that bound it together**: the box-shadow placeholder slot pioneered in #6 is reused here — both rest and hover state shadows are 2-layer lists so the drop-shadow can fade in without count mismatch.
- **Reduced-motion**: not yet guarded — clip-path animation is mild enough not to require it, but worth adding alongside the next sweep.

### 9. Symmetric panel exit
- **Pattern**: delayed unmount choreography (500ms one-shot when panel visibility flips false)
- **Property**: `opacity` + `transform: scale + translateY`
- **From**: opacity 1, scale 1, translateY 0
- **To**: opacity 0, scale 0.96, translateY +8px
- **Curve**: `cubic-bezier(0.32, 0.72, 0, 1)` (Vaul's drawer curve — same as #5 mount entrance)
- **Files**:
  - `frontend/src/hooks/useDelayedUnmount.ts` — reusable delayed unmount hook returning `{ shouldRender, exiting }`
  - `frontend/src/styles/slava-restraint.css` — `@keyframes slava-panel-exit`, `.panel--exiting`, `.chat-panel--exiting`
  - `frontend/src/components/panels/NodeLibrary.tsx` — delayed exit wiring
  - `frontend/src/components/panels/Settings.tsx` — delayed exit wiring
  - `frontend/src/components/panels/Inspector.tsx` — delayed exit wiring plus cached selected-node render data
  - `frontend/src/components/panels/ChatPanel.tsx` — delayed exit wiring for the non-`.panel` chat surface
- **Pattern detail**: React normally removes closed panels immediately, so CSS never gets a chance to animate out. `useDelayedUnmount` keeps the DOM mounted for 500ms after `visible=false`, applies an exit class, then removes it after the keyframe completes.
- **Inspector edge case handled**: clicking empty canvas clears `selectedNodeId` at the same time it hides the Inspector. The panel now caches the last valid selected node/data and renders that cached content during the exit window, so the panel animates out instead of disappearing instantly.
- **Chat edge case handled**: ChatPanel uses `chat-panel` rather than the shared `panel` class, so Slava scopes an explicit `.chat-panel.chat-panel--exiting` selector that reuses the same exit keyframes.
- **Why this property**: panels live outside React Flow, so `transform` is safe here.

### 10. Slava skin switch mask
- **Pattern**: transient root mask during body-class skin swaps (220ms one-shot)
- **Property**: `opacity` + `filter: blur() brightness()`
- **Curve**: `cubic-bezier(0.32, 0.72, 0, 1)` (Vaul)
- **Files**:
  - `frontend/src/lib/skins.ts` — detects when Slava is the previous or next skin and adds a short-lived `app-skin-switching-slava` body class
  - `frontend/src/store/uiStore.ts` — skips animation on initial persisted-skin application
  - `frontend/src/styles/slava-restraint.css` — `@keyframes slava-skin-switch-mask`
- **Pattern detail**: the mask only runs for transitions where Slava is entering or leaving. Initial page load stays static so persisted Slava does not flash.
- **Scope note**: the transient selector is intentionally body-level rather than nested under `.app-slava-restraint`, because it must survive the exact frame where the Slava body class is being removed. The class is only added by Slava-aware switch logic.
- **Reduced-motion**: `animation: none`

### 11. Library item drag preview
- **Pattern**: custom drag ghost overlay following native HTML5 drag (140ms entrance, ~80ms cursor lag)
- **Property**: viewport-fixed portal with `transform: translate3d(var(--drag-x), var(--drag-y), 0)`, `opacity`, `filter`, and shadow
- **Curves**: 140ms `cubic-bezier(0.05, 0.7, 0.1, 1)` for entrance; 80ms `cubic-bezier(0.32, 0.72, 0, 1)` for follow lag
- **Files**:
  - `frontend/src/components/panels/NodeLibrary.tsx` — hides the native drag image for Slava, tracks drag coordinates, renders the overlay through `createPortal`
  - `frontend/src/styles/slava-restraint.css` — `.slava-library-drag-preview` styles and reduced-motion guard
- **Pattern detail**: the existing `application/nebula-node` drag/drop path stays intact. Slava only replaces the browser ghost with a controlled overlay, so canvas drop semantics are unchanged.
- **Scope note**: the preview state is only created when `skin === 'slava-restraint'`. Default and Hermes keep the native drag ghost.
- **Reduced-motion**: `transition: none` + `animation: none`

### 12. Node mount on canvas
- **Pattern**: one-shot node entrance on fresh React Flow node mount (220ms)
- **Property**: wrapper `opacity` + `filter`; card pseudo-layer `box-shadow` bloom
- **Curve**: `cubic-bezier(0.05, 0.7, 0.1, 1)` (Material 3 emphasized-decelerate)
- **Files**:
  - `frontend/src/hooks/useSlavaNodeEntrance.ts` — returns a temporary `model-node--entering` class only when the node mounts while Slava is active
  - `frontend/src/components/nodes/ModelNode.tsx` — applies the shared entrance class
  - `frontend/src/components/nodes/DynamicNode.tsx` — applies the shared entrance class
  - `frontend/src/styles/slava-restraint.css` — `@keyframes slava-node-enter-opacity`, `@keyframes slava-node-enter-bloom`
- **Pattern detail**: React Flow owns the positioned outer node, so the entrance avoids `transform`. The visible "scale" read comes from a shrinking category-colored shadow bloom around `.model-node__card`, while the node fades/sharpens into place.
- **Scope note**: existing nodes do not animate merely because the user switches into Slava. The hook checks the active skin only at node mount time.
- **Reduced-motion**: `animation: none`

### 13. Library category expand
- **Pattern**: state-driven accordion reveal for node-library categories
- **Property**: `grid-template-rows` height tween on the item group; item `opacity` + `transform: translateY`
- **Curves**: 240ms `cubic-bezier(0.32, 0.72, 0, 1)` for the height; 180ms `cubic-bezier(0.05, 0.7, 0.1, 1)` for individual item arrival
- **Files**:
  - `frontend/src/components/panels/NodeLibrary.tsx` — keeps Slava category items mounted in a `.panel__items` wrapper while Default/Hermes keep the old conditional render path
  - `frontend/src/styles/slava-restraint.css` — `.panel__items` grid-row accordion plus 30ms stagger on the first visible items
- **Pattern detail**: CSS can only animate collapse if the content stays mounted, so Slava gets a wrapper with `grid-template-rows: 0fr → 1fr`. Collapsed groups also set `pointer-events: none` so hidden draggable items do not interfere.
- **Scope note**: Default and Hermes are unaffected at render level, not just CSS level.
- **Reduced-motion**: `transition: none`

### 14. Dot-matrix loading indicators
- **Pattern**: looping loader identity mark (960ms stepped beam)
- **Property**: dot `background-color` + `box-shadow` list
- **Curve**: `steps(4, end)` so the beam moves as a crisp dot-matrix scan rather than a generic spinner
- **Files**:
  - `frontend/src/styles/slava-restraint.css` — `@keyframes slava-dot-matrix-beam`, Slava overrides for `.model-node__loading-spinner` and `.chat-panel__chip-spinner`
- **Pattern detail**: replaces the stock rotating border spinners with a 4×4 dot grid whose bright column scans left to right. In model nodes, the animated part is a child pseudo-element and only animates `background-color` / `box-shadow`, preserving the React Flow safe-property rule. The Slava toolbar Stop button also swaps its icon for the same dot matrix while the graph is executing, making the loading identity visible even when node rows complete quickly.
- **Scope note**: Default and Hermes keep their existing spinner treatments.
- **Reduced-motion**: `animation: none`

### 15. Slava edge dash-march
- **Pattern**: executing-edge flow polish
- **Property**: SVG `stroke-dasharray` + `stroke-dashoffset`
- **Curve**: 900ms `cubic-bezier(0.42, 0, 0.2, 1)` infinite
- **Files**:
  - `frontend/src/styles/slava-restraint.css` — `.react-flow__edge.animated .react-flow__edge-path`, `@keyframes slava-edge-dash-march`
- **Pattern detail**: Slava animated edges use an uneven dash cadence (`6 4 2 4`) instead of the base even barber-pole dash. The eased cycle gives the edge a quieter pulse while still reading as active flow.
- **Scope note**: base canvas and Hermes dash behavior are untouched.
- **Reduced-motion**: inherited from the Slava edge reduced-motion guard

---

## The codified React Flow rule (the technical anchor)

After three failed `transform`-based connector handle iterations:
1. **Iteration 1** — radial-gradient swap (visual state mismatch)
2. **Iteration 2** — `scale` + `transform-origin: 50% 50%` (visible center drifted relative to React Flow's parent transform)
3. **Iteration 3** — pseudo-element edge anchoring (browser cascade bug)

…we proved:
- React Flow puts an inline `transform: matrix(...)` on every node and handle for positioning
- Any animation that mutates `transform` on `.react-flow__node` or `.react-flow__handle` fights xyflow's positioning math
- Even with `transform-origin` set to center, scale + RF's translate composition produces measurable center drift

**The rule**: inside React Flow, animate **opacity / color / box-shadow / filter / border-color** ONLY. To fake "scale-in", use `box-shadow: 0 0 0 Npx <accent>` width as the proxy. Edges (SVG paths in a separate layer) animate fine.

This rule is now codified in:
- `~/.claude/skills/motion-design/SKILL.md`
- `slava-restraint.css` rule comments (where applicable)

---

## The seven-row spring preset table (research output)

The vocabulary used across this suite. From canonical primary sources only — motion.dev, Apple WWDC23, Material 3, Vaul, Sonner.

| Preset | When | motion.dev syntax | CSS fallback |
|---|---|---|---|
| **Snappy** | buttons, hover scales, icon presses | `{ duration: 0.25, bounce: 0.15 }` | `200ms cubic-bezier(0.32, 0.72, 0, 1)` |
| **Smooth** | generic state, color, opacity | `{ duration: 0.4, bounce: 0 }` | `300ms cubic-bezier(0.2, 0, 0, 1)` (M3 emphasized) |
| **Drawer** | sheets, drawers, side panels | `{ duration: 0.5, bounce: 0.1 }` | `500ms cubic-bezier(0.32, 0.72, 0, 1)` (Vaul) |
| **Bouncy** | toasts, success states | `{ duration: 0.5, bounce: 0.3 }` | (need spring lib) |
| **Cinematic** | page transitions, hero reveals | `{ visualDuration: 0.6, bounce: 0.05 }` | `600ms cubic-bezier(0.05, 0.7, 0.1, 1)` (M3 emphasized-decel) |
| **Drag-release** | gesture end, scrubber settle | `{ duration: 0.4, bounce: 0.2, velocity }` | (need spring lib) |
| **Micro** | hover background, focus ring | n/a | `120ms cubic-bezier(0.4, 0, 0.2, 1)` |

**Underrated finding**: motion.dev's `visualDuration` separates *perceived* completion from *physics* completion — the bouncy tail happens *after* the eye reads "arrived." Closest thing Motion has to a tuned-spring shortcut, and it's not in any preset table because it doesn't need one.

---

## Suggested case-study framing for justinperea.com

**Title options**:
- "Tuning motion on a node editor — a four-part suite"
- "Three failures, one rule: how I learned to animate inside React Flow"
- "A motion suite for nebula_nodes"

**Story structure**:
1. **Hook** — the cliff-edge: 3 hover-animation iterations all failed, even though Puppeteer measurements showed centers locked
2. **The dig** — vault check + 3 parallel research agents → canonical motion.dev / Apple WWDC23 / Material 3 / Sonner-Vaul source extraction
3. **The vocabulary** — the 7-row preset table; what "tuned" actually means physically (stiffness/damping/mass) and perceptually (`visualDuration`, bounce)
4. **The rule** — the React Flow constraint that bit us 3 times; the codified safe-property list; the box-shadow-as-proxy trick
5. **The applied suite** — 7 supporting interactions with side-by-side before/after video, curve diagrams
6. **The closing arc** — return to the connector handle. The same dot-to-circle reveal that crashed three times earlier now ships via `clip-path`. **This is the case study's narrative payoff** — the rule we discovered ("never transform inside `.react-flow__node`") forced us to find a paint-only path; `clip-path` is that path. The visual that opened the journey closes it.
7. **Closer** — the `visualDuration` discovery; what the next 7 audit items will look like

**Visuals to capture before publishing**:
- Side-by-side video for each of the 8 interactions (before = stock; after = tuned)
- The dot → circle reveal in slow motion (the closing-arc piece — make it *the* hero shot)
- Annotated curve diagram comparing Vaul / M3 emphasized-decel / back-ease / sine
- Screenshot of the React Flow handle bounding box vs disc center (the math vs perception gap from v2)
- The 7-row preset table as a styled component on the page itself (live, hoverable)

**Pull quotes** (high-value):
- *"Math says centers are equal but measurement shows a 15.3px offset"* — diagnostic moment from v2
- *"`visualDuration` separates perceived completion from physics completion. The bouncy tail happens AFTER your eye reads 'arrived.'"* — research finding
- *"Inside React Flow: animate opacity, color, box-shadow, filter, border-color only. Never transform."* — the rule
- *"`clip-path` is paint-only. The layout box never changes. The center literally cannot drift."* — the closing-arc resolution

**`/lab` micro-interaction studies** (could ship as standalone demos before the full case study):
- Each of the 8 interactions as an isolated CodeSandbox / Stackblitz embed
- The 7-row preset table with live hoverable triggers
- A "spring playground" sliding stiffness/damping and showing the resolved curve

---

## Related artifacts (paths)

- **Code**:
  - `frontend/src/styles/slava-restraint.css` — Slava motion suite + reduced-motion guards
  - `frontend/src/components/edges/TypedEdge.tsx` — `pathLength={100}` for edge draw (#3)
  - `frontend/src/components/panels/Inspector.tsx` — `key={selectedNodeId}` on `.panel__body` (#7)
- **Research**:
  - `~/Documents/Obsidian Vault/Research/topics/motion-libraries-2026-05.md` — canonical full research artifact
  - `~/Documents/Obsidian Vault/Research/_hot.md` (entry 2026-05-05)
  - `~/Documents/Obsidian Vault/Research/_index.md` (motion-libraries-2026-05 row)
- **Skill**:
  - `~/.claude/skills/motion-design/SKILL.md` — decision matrix + preset table for cross-project reuse
- **Activity log**:
  - `~/.claude/activity/2026-05-05.log` — chronological trace of all seven shipments + research sessions
- **Branch**: `ui/explore` (isolated from `main`; merge gating on full audit completion or skin selection)

---

## Open follow-ups

The prioritized Slava motion audit is complete: 15 of 15 shipped.

Full audit table at `~/Documents/Obsidian Vault/Research/topics/motion-libraries-2026-05.md` → "Application: nebula_nodes" section.

Remaining work should be treated as QA, capture, and case-study packaging rather than unshipped motion scope.

---

_Living document — update as more interactions ship._
