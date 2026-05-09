# SLAVA RESTRAINT // DESIGN SYSTEM

**Codename:** `slava-restraint`
**App skin class:** `body.app-slava-restraint`
**Implementation:** `frontend/src/styles/slava-restraint.css`
**Status:** default-candidate, not yet default
**Last audited:** 2026-05-07

**Companion notes:** [Dot Matrix Aesthetic](./DOT_MATRIX_AESTHETIC.md)

---

## 0. Purpose

Slava Restraint is the visual and interaction direction intended to become Nebula Nodes' default skin once the product behavior is stable.

The design goal is not a themed veneer. Slava should become the product's operating system: the canvas, nodes, panels, chat, toolbar, settings, inspector, handles, and image surfaces should feel like one quiet working environment.

The current app still has older base CSS in `panels.css`, `nodes.css`, `canvas.css`, and Hermes-specific overrides. Slava must remain scoped under `body.app-slava-restraint` until it becomes default.

---

## 1. Principles

1. **Restraint over decoration.** The graph, previews, and connections are the heroes. Chrome should sit behind the work.
2. **Glass, not slabs.** Panels and tool surfaces use dark translucent glass with blur, thin edges, and low contrast.
3. **One accent.** Orange is reserved for primary action, focus, active selection, connection catch states, and important alerts. It is not a decorative wash.
4. **Monochrome first.** Normal UI state uses black, white, alpha, and edge tokens. Category colors stay quiet and functional.
5. **Same center, no drift.** Handles, nodes, and motion states must not introduce positional surprise. Visual morphs are allowed; layout drift is not.
6. **Controls have contracts.** Buttons, icon buttons, fields, disclosure rows, and composers should consume shared Slava tokens instead of local one-off sizing.
7. **Motion is soft and bounded.** Use Vaul/M3-style deceleration for panel and catch motion. Motion should clarify state, not advertise itself.

---

## 2. Token Source Of Truth

The canonical runtime tokens live in:

`frontend/src/styles/slava-restraint.css`

All new Slava styling should consume the `--sr-*` tokens below. If a value is repeated in more than two visible components, promote it to this token table before adding another hard-coded value.

### Canvas And Surfaces

| Token | Value | Use |
|---|---:|---|
| `--sr-canvas` | `#000000` | App/canvas ground |
| `--sr-canvas-elevated` | `#060607` | Deep elevated media/modal ground |
| `--sr-canvas-phosphor` | `#C9CAC8` | Reference dot/phosphor anchor |
| `--sr-canvas-dot-color` | `rgba(201, 202, 200, 0.15)` | Slava React Flow dot matrix |
| `--sr-canvas-dot-color-soft` | `rgba(201, 202, 200, 0.075)` | Future secondary dots |
| `--sr-canvas-dot-step` | `16px` | Dot matrix spacing mirrored by `Canvas.tsx` |
| `--sr-canvas-dot-size` | `1.2px` | Dot radius mirrored by `Canvas.tsx` |
| `--sr-glass` | `rgba(22, 22, 24, 0.66)` | Default panel surface |
| `--sr-glass-raised` | `rgba(28, 28, 31, 0.78)` | Toolbar, raised chrome |
| `--sr-glass-strong` | `rgba(36, 36, 40, 0.86)` | Node card/media surfaces |
| `--sr-edge` | `rgba(255, 255, 255, 0.06)` | Default hairline |
| `--sr-edge-strong` | `rgba(255, 255, 255, 0.12)` | Active/strong hairline |

### Ink

| Token | Value | Use |
|---|---:|---|
| `--sr-ink` | `rgba(255, 255, 255, 0.92)` | Primary text |
| `--sr-ink-bold` | `#FFFFFF` | Emphasis/active text |
| `--sr-ink-light` | `rgba(255, 255, 255, 0.55)` | Secondary labels |
| `--sr-ink-meta` | `rgba(255, 255, 255, 0.40)` | Metadata |
| `--sr-ink-faint` | `rgba(255, 255, 255, 0.20)` | Tertiary hints/disabled |

### Accent

| Token | Value | Use |
|---|---:|---|
| `--sr-accent` | `#FF5A1F` | Primary action, focus, selected/catch state |
| `--sr-accent-hover` | `#ff6b34` | Primary action hover |
| `--sr-accent-soft` | `rgba(255, 90, 31, 0.10)` | Soft alert/focus fill |
| `--sr-accent-border-soft` | `rgba(255, 90, 31, 0.22)` | Quiet accent/error divider |
| `--sr-accent-border-muted` | `rgba(255, 90, 31, 0.28)` | Notice border |
| `--sr-accent-border` | `rgba(255, 90, 31, 0.34)` | Default accent/error border |
| `--sr-accent-border-medium` | `rgba(255, 90, 31, 0.36)` | Stop/destructive border |
| `--sr-accent-border-strong` | `rgba(255, 90, 31, 0.45)` | Strong chip/error border |
| `--sr-accent-hover-soft` | `rgba(255, 90, 31, 0.16)` | Soft hover fill for stop/destructive controls |
| `--sr-on-accent` | `#0A0A0B` | Text/icon on accent |

### State Tokens

| Token | Value | Use |
|---|---:|---|
| `--sr-warning` | `#F5C518` | Warning badges and node warnings |
| `--sr-warning-soft` | `rgba(245, 197, 24, 0.12)` | Warning surface when needed |
| `--sr-error` | `var(--sr-accent)` | Error text/catch alert |
| `--sr-error-soft` | `var(--sr-accent-soft)` | Error surface |
| `--sr-error-border` | `var(--sr-accent-border)` | Error border |
| `--sr-danger` | `var(--sr-error)` | Destructive action alias |
| `--sr-danger-soft` | `var(--sr-error-soft)` | Destructive action surface |
| `--sr-danger-border` | `var(--sr-error-border)` | Destructive action border |
| `--sr-success` | `rgba(110, 231, 183, 0.90)` | Future success state |
| `--sr-success-soft` | `rgba(110, 231, 183, 0.12)` | Future success surface |
| `--sr-pending` | `var(--sr-ink-light)` | Future pending state |
| `--sr-pending-soft` | `rgba(255, 255, 255, 0.06)` | Future pending surface |
| `--sr-disabled-opacity` | `0.48` | Disabled fields |
| `--sr-disabled-opacity-strong` | `0.36` | Disabled primary/icon actions |
| `--sr-disabled-opacity-muted` | `0.50` | Disabled secondary actions |

### Typography

| Token | Value | Use |
|---|---|---|
| `--sr-ui` | `Inter`, `Helvetica Neue`, Helvetica, Arial, sans-serif | UI/body/control text |
| `--sr-mono` | `JetBrains Mono`, `IBM Plex Mono`, `SF Mono`, Menlo, monospace | Wordmark, IDs, metrics, model IDs |
| `--sr-type-micro` | `9px` | Tiny IDs/carets/chip labels |
| `--sr-type-meta` | `10px` | Metadata, wordmark, loading labels |
| `--sr-type-label` | `11px` | Field labels, inspector/settings labels |
| `--sr-type-body` | `12px` | Compact body/chrome text |
| `--sr-type-control` | `13px` | Inputs, primary controls, active rows |
| `--sr-type-action` | `14px` | Compact text/icon actions |
| `--sr-type-title` | `15px` | Panel/chat titles |
| `--sr-type-icon` | `var(--sr-icon-size)` | Back-compat alias for standard icon size |
| `--sr-type-icon-lg` | `var(--sr-icon-size-lg)` | Back-compat alias for large icon size |
| `--sr-line-tight` | `1` | Icon buttons/titles |
| `--sr-line-compact` | `1.2` | Node labels/model rows |
| `--sr-line-meta` | `1.4` | Metadata/error descriptions |
| `--sr-line-body` | `1.45` | Composer/body input |
| `--sr-line-bubble` | `1.48` | Chat bubbles |
| `--sr-line-relaxed` | `1.5` | Logs/long mono rows |

### Iconography

Slava uses `lucide-react` for interface icons. Icons inherit `currentColor` from their control state; do not set per-icon colors unless the icon is a data/state swatch.

| Token | Value | Use |
|---|---:|---|
| `--sr-icon-size-sm` | `12px` | Disclosure/caret glyphs paired with meta text |
| `--sr-icon-size` | `16px` | Default toolbar, media, log, and compact action icons |
| `--sr-icon-size-lg` | `18px` | Primary composer/send icon |
| `--sr-icon-stroke` | `1.75` | Lucide stroke weight for Slava |

Rules:
- Icon-only controls keep their box size from control tokens; icon size never determines hit area.
- Icons use `aria-hidden` when the button/link already has a text label, `aria-label`, or `title`.
- Prefer Lucide before adding custom SVG. Custom SVG is reserved for product marks, generated previews, and domain-specific visuals that Lucide does not cover.

### Spacing

| Token | Value | Use |
|---|---:|---|
| `--sr-space-1` | `4px` | Tiny internal gaps, hairline offsets |
| `--sr-space-2` | `8px` | Small gaps, compact padding |
| `--sr-space-3` | `12px` | Default panel/chrome vertical rhythm |
| `--sr-space-4` | `16px` | Default panel horizontal rhythm |
| `--sr-space-5` | `20px` | Larger content separation |
| `--sr-space-6` | `24px` | Major stack separation |

Rule: use 4px-grid spacing unless a value tracks a functional geometry such as a handle center, edge path, or media aspect.

### Radius

| Token | Value | Use |
|---|---:|---|
| `--sr-radius-panel` | `12px` | Panels, chat, modals |
| `--sr-radius-node` | `8px` | Standard node cards |
| `--sr-radius-control` | `8px` | Buttons, fields, compact surfaces |
| `--sr-radius-control-lg` | `10px` | Composer well, bubbles, thinking blocks |
| `--sr-radius-pill` | `999px` | Pills, toolbar, close buttons |

Rule: do not introduce new radii unless the object is circular, media aspect-specific, or a React Flow handle.

### Control Geometry

| Token | Value | Use |
|---|---:|---|
| `--sr-control-h-xs` | `24px` | Close/info icon buttons |
| `--sr-control-h-sm` | `28px` | Segmented controls/tool buttons |
| `--sr-control-h-md` | `34px` | Standard fields/actions |
| `--sr-control-h-lg` | `42px` | Composer well/resting input |
| `--sr-control-pad-x` | `10px` | Default control x padding |
| `--sr-control-pad-y` | `7px` | Default control y padding |

Controls should be visually compact but not hard to hit. Icon-only buttons should keep their visible surface stable; do not let icon glyph size change the control box.

### Header Actions

Panel and node header actions share one quiet contract:
- Class contract: `panel__header-action` for panels/popovers and `model-node__header-action` for node chrome.
- Box: `--sr-control-h-xs` square hit area.
- Icon: Lucide, `--sr-icon-size`, `--sr-icon-stroke`, `currentColor`.
- Rest: transparent surface, `--sr-ink-meta`, subdued opacity.
- Hover/focus: `--sr-surface-control-hover`, `--sr-edge-strong`, `--sr-ink-bold`.
- Use for close buttons, small header utility actions, and direct media actions like download. Do not introduce floating circular media controls unless there are several related tools that need a temporary toolbar.

### Control Surfaces

| Token | Value | Use |
|---|---:|---|
| `--sr-surface-control` | `rgba(0, 0, 0, 0.30)` | Field/control base |
| `--sr-surface-control-hover` | `rgba(255, 255, 255, 0.05)` | Hover |
| `--sr-surface-control-active` | `rgba(255, 255, 255, 0.10)` | Active/selected control |
| `--sr-surface-control-focus` | `rgba(0, 0, 0, 0.45)` | Focused field well |

### Effects

| Token | Value | Use |
|---|---|---|
| `--sr-blur-panel` | `blur(24px) saturate(140%)` | Panels/chat/agent log |
| `--sr-blur-pill` | `blur(20px) saturate(140%)` | Floating pills |
| `--sr-blur-node` | `blur(20px) saturate(140%)` | Node cards |
| `--sr-shadow-panel` | inset edge + `0 12px 36px rgba(0,0,0,.55)` | Primary glass panels |
| `--sr-shadow-panel-sm` | inset edge + `0 8px 24px rgba(0,0,0,.55)` | Toolbar/agent log |
| `--sr-shadow-popover` | `0 12px 28px rgba(0,0,0,.36)` | Popovers/dropdowns |
| `--sr-shadow-node` | inset edge + `0 8px 24px rgba(0,0,0,.65)` | Standard node cards |
| `--sr-shadow-node-media` | inset edge + `0 10px 30px rgba(0,0,0,.62)` | Image/media surface previews |
| `--sr-shadow-node-media-selected` | category ring/glow + media shadow | Selected media surface |

### Motion

| Token | Value | Use |
|---|---|---|
| `--sr-motion-fast` | `120ms ease` | Hover/focus color changes |
| `--sr-motion-ui` | `140ms ease` | Active state transitions |
| `--sr-motion-handle` | `220ms cubic-bezier(0.32, 0.72, 0, 1)` | Dot-to-circle handle morph |
| `--sr-motion-panel` | `500ms cubic-bezier(0.32, 0.72, 0, 1)` | Panel enter/exit |
| `--sr-motion-emphasized` | `140ms cubic-bezier(0.05, 0.7, 0.1, 1)` | Catch/selection response |

Respect `prefers-reduced-motion`. Any new loop or entrance animation must include a reduced-motion override.

### Focus

| Token | Value | Use |
|---|---|---|
| `--sr-focus-outline` | `2px solid var(--sr-accent-soft)` | Focus-visible outline |
| `--sr-focus-offset` | `2px` | Focus-visible offset |

Focus rings should be visible but low weight. Border color may switch to `--sr-accent` when it does not cause layout shift.

### Node, Handle, And Edge Geometry

Node/media constants now have named Slava tokens because these values are visual contracts, not incidental CSS. Prefer adjusting these tokens before changing the node section directly.

| Token family | Use |
|---|---|
| `--sr-node-pad-*`, `--sr-node-header-*`, `--sr-node-port-*` | Standard node spacing, labels, headers, and port rows |
| `--sr-node-pill-*` | Floating node settings pill geometry, expansion, and motion |
| `--sr-node-enter-*`, `--sr-node-selected-*` | Node entrance and selected halo effects |
| `--sr-node-text-*` | Surface-first text node sizing and editor/preview spacing |
| `--sr-node-image-*`, `--sr-node-media-*` | Image-surface title row, media radius, preview background, and streaming outline |
| `--sr-node-error-*` | Node-local warning/error block geometry |
| `--sr-handle-*` | Dot rest state, full circle, magnetism, active ring, and plus glyph |
| `--sr-edge-*` | Default/selected edge stroke, glow, draw, and flow animation |

Rule: handle and edge token changes require `npm run check:slava-screenshots`, plus a human hover/drag check when the change affects transforms or endpoint alignment.

### Layers

| Token | Value | Use |
|---|---:|---|
| `--sr-layer-panel` | `10` | Normal panels/toolbar |
| `--sr-layer-agent-log` | `11` | Agent log over normal panel layer |
| `--sr-layer-settings` | `30` | Settings over chat |
| `--sr-layer-popover` | `40` | Popovers/context UI |
| `--sr-layer-modal` | `60` | Modal overlay |
| `--sr-layer-modal-control` | `61` | Modal controls |
| `--sr-layer-node-preview` | `1` | Node preview sublayer |
| `--sr-layer-node-header` | `2` | Standard node header over preview |
| `--sr-layer-node-floating` | `3` | Node floating settings affordance |
| `--sr-layer-node-image-ports` | `5` | Image-surface ports/handles |
| `--sr-layer-node-image-header` | `6` | Image-surface title row |
| `--sr-layer-drag` | `10000` | Drag preview |

Do not add local z-index values for panel, chrome, node, or media layers. Add a layer token first.

---

## 3. Component Contracts

### Panel

Applies to library, inspector, settings, agent log, chat, and modals.

- Surface: `--sr-glass`
- Blur: `--sr-blur-panel`
- Radius: `--sr-radius-panel`
- Edge: `--sr-edge`
- Shadow: `--sr-shadow-panel` or `--sr-shadow-panel-sm`
- Header label: `--sr-type-title`, medium weight, normal case
- Body padding: `--sr-space-3 --sr-space-4 --sr-space-4`

Panel chrome must not use saturated color except focus/active/primary actions.

### Toolbar Button

- Text/icon color at rest: `--sr-ink-light`
- Hover: `--sr-surface-control-hover`, `--sr-ink-bold`
- Active: `--sr-surface-control-active`, `--sr-ink-bold`
- Active Slava toolbar cells use a quiet dot-matrix backing and selected border; this visual must stay tied to `toolbar__button--active` and `aria-pressed`
- Icon: Lucide, `--sr-icon-size`, `--sr-icon-stroke`
- Press: small scale is allowed because toolbar is outside React Flow
- Active state must map to actual panel visibility with `aria-pressed`

### Field

- Height: `--sr-control-h-md` unless it is the chat composer
- Surface: `--sr-surface-control`
- Focus surface: `--sr-surface-control-focus`
- Radius: `--sr-radius-control`
- Edge: `--sr-edge`
- Focus border: `--sr-accent`
- Placeholder: `--sr-ink-faint` or `--sr-ink-meta`

No inline field styling. Use classes.

### Button

Primary:
- Background: `--sr-accent`
- Text/icon: `--sr-on-accent`
- Hover: `--sr-accent-hover`
- Shape: pill for primary form submit, control radius for compact icon actions

Secondary:
- Background: `--sr-surface-control`
- Edge: `--sr-edge`
- Hover: `--sr-surface-control-hover`
- Text: `--sr-ink-light` to `--sr-ink-bold`

Destructive:
- Use `--sr-accent-soft` and `--sr-accent`; avoid separate red unless a true error system is added.

### Disclosure Row

Used by API Keys/settings accordions.

- Full-width button
- Height determined by content, but padding from control tokens
- Count/chevron uses `--sr-ink-meta`
- Title uses `--sr-ink-light`
- Hover surface uses `--sr-surface-control-hover`

### Chat Composer

The composer is one visual input well, not a text area next to a separate button.

- Row is the visible field.
- Textarea is transparent and borderless.
- Send arrow is a trailing action inside the well.
- Resting height: `--sr-control-h-lg`
- Send visual size: 32px currently via `--chat-composer-action`
- Placeholder should stay short, e.g. `Message...`
- `Stop` may remain text because it is a different state with higher consequence.

### Node Card

- The preview/content is the card.
- Title/category chrome should float or overlay quietly.
- Category color may appear as a subtle edge/glow, never a filled card ground.
- Selected state may use category color and `--sr-accent` logic, but must not change layout dimensions.
- Image nodes may become surface-first: media owns the space, toolbar appears on hover/selection.
- Text nodes are also surface-first: textarea/text preview fills the card, and secondary text actions such as Enhance move into header actions.
- Text-input port labels may be suppressed when the single text handle is visually obvious; do not spend card height on footer labels.
- Sticky Note uses the same Slava text-surface editor on canvas, backed by its `content` param; its Inspector remains the detailed editor for color and secondary params.

### Handle

- Rest: quiet dot.
- Hover/connecting: full glass circle with plus.
- Centers must stay locked between rest and hover.
- Magnetism is visual-only through CSS variables; it must not change React Flow layout box.
- Do not use `clip-path` for rest state because it shrinks the pointer target.

### Edge

- Default edge: quiet white/gray stroke.
- Selected/connecting edge: accent/category emphasis.
- Edge animation should not replay on node drag.
- Edge endpoints should visually meet handle/dot centers, not the outer circle edge.

### Mesh/Media Modal

- Modal uses Slava panel surface/radius/shadow.
- Close control uses icon-button contract.
- Download uses primary button contract.
- Media viewer background uses `--sr-canvas-elevated`.

---

## 4. State Model

Every interactive Slava component should define these states explicitly:

| State | Visual rule |
|---|---|
| Rest | Low contrast, monochrome |
| Hover | Slight surface lift, no layout shift |
| Focus | `--sr-focus-outline`, `--sr-accent` border when applicable |
| Active/Pressed | Subtle scale only outside React Flow; otherwise color/surface only |
| Selected | `--sr-surface-control-active` or node category glow; no geometry shift |
| Disabled | Lower opacity; no hover transition |
| Loading/Executing | Dot-matrix or subdued progress; avoid spinners where Slava has dot loaders |
| Error | `--sr-error-soft`, `--sr-error-border`, `--sr-error` |
| Warning | `--sr-warning-soft`, `--sr-warning` |
| Success | `--sr-success-soft`, `--sr-success` |
| Pending | `--sr-pending-soft`, `--sr-pending` |

---

## 5. Allowed Exceptions

These may stay inline or local because they are data/geometry, not design theme values:

- Panel positions: `left`, `top`, drag state
- React Flow handle/edge positions
- Dynamic category colors and port colors
- Progress width
- Media dimensions/aspect ratios
- CSS variables set from pointer magnetism
- Generated object URLs and dynamic preview URLs

These should not stay inline:

- Static colors
- Static radii
- Static padding/gaps
- Static font sizes
- Static button/field styles
- Static backgrounds

---

## 6. Current Audit

### Strong

- Slava has a scoped `--sr-*` token system.
- Panels/chat/toolbar/settings/inspector are now mostly using shared contracts.
- Core Slava typography, line-height, state, and disabled values are tokenized.
- Slava now has a Lucide icon contract with size/stroke tokens. Toolbar, panel close buttons, disclosure chevrons, chat controls, agent log, and media controls use it.
- Panel and node header actions now share the same quiet 24px action contract.
- Text input/output nodes now use a surface-first Slava layout with Enhance moved to a header icon action.
- Node, image-surface, handle, and edge geometry now use named Slava tokens instead of local one-off constants.
- Default node visuals for handles, media actions, loading/progress, text previews, reroute dots, and dynamic model badges are now scoped away from Slava; Slava owns those states directly.
- Connection popovers and context menus now have Slava-scoped glass styling instead of inheriting the old panel palette.
- Context menu, connection popup, and chat panel shell visuals are now split so old Default backgrounds/borders/radii do not apply globally to Slava.
- Lower-level settings, inspector, and chat message/control visuals are now split from shared panel structure so Slava owns token-backed controls directly.
- Chat resize rails, chat header metadata, and legacy chat selector/accent visuals are now scoped away from Slava.
- Agent log is hidden unless enabled in Settings and starts collapsed so it does not compete with chat by default.
- Slava panel/chrome/node/media z-index values are named layer tokens.
- Slava toolbar active cells now have dot-matrix selected backing and automated `aria-pressed`/active visual coverage.
- Default base visuals are now split away from Slava for the highest-impact shared shells: panels, toolbar, node cards, node state borders, node headers, ID chips, preview wells, and mesh modal chrome.
- Default canvas visuals in `canvas.css` are scoped away from Slava; Slava owns React Flow canvas variables, selection, controls, and animated edge treatment.
- Default agent log and skin picker visuals are scoped away from Slava; only their layout/structure contracts remain shared.
- The chat composer has a proper component contract.
- Chat rest, message, busy/stop, error, and image-chip states are now deterministic screenshot fixtures.
- Inspector controls now share one data-driven render contract for static and dynamic params, with stable `data-inspector-*` markers for visual checks.
- Handles have clear rest/hover/connecting rules and target-size protection.
- Settings now has clear disclosure and visibility behavior.
- Mesh modal and Inspector no longer rely as heavily on inline visual styles.
- Component inline styles have been audited; remaining cases are dynamic geometry, data colors, progress width, edge styling, or effect coordinates.
- `npm run check:inline-styles` guards against new static inline visual styles in `frontend/src/components`.
- `npm run check:slava-screenshots` captures desktop/settings/image-surface/chat rest-message-busy-error-chip states/Inspector text-file-model-sticky states/popover-loading-reroute/mesh-modal/mobile/empty-canvas Slava screenshots into `output/slava-screenshot-check`.

### Weak

- Success and pending tokens exist for consistency, but there are few visible states using them yet.
- Default/Hermes base CSS still contains some hard-coded structural/modal values that Slava overrides. The highest-risk canvas/panel/node/control leaks are isolated, but the system is not yet inversion-clean.
- The screenshot script verifies representative structure and image output dimensions, but final default promotion still needs human visual review of the captured PNGs.

### High-Risk Areas

1. `frontend/src/styles/slava-restraint.css` node/media section: now tokenized, but still high-risk because it owns React Flow geometry and hover/drag perception.
2. `frontend/src/styles/nodes.css`: most high-risk node/control leaks are isolated; continue splitting any remaining shared structural rules from Default-only visual values.
3. `frontend/src/styles/panels.css`: major Slava-facing shell/control visuals are split; continue auditing niche Default-only control values and any legacy classes not covered by Slava fixtures.
4. `frontend/src/styles/canvas.css`: visual React Flow defaults are now scoped away from Slava; keep future shared additions structural unless they are explicitly `body:not(.app-slava-restraint)`.
5. `frontend/src/styles/layouts.css` and `skin-picker.css`: Slava-facing visuals are split; keep future shared additions structural unless they are explicitly `body:not(.app-slava-restraint)`.
6. Inspector dynamic controls: now centralized and screenshot-covered, but still high-risk because provider schemas are data-driven.
7. React Flow handles: any transform change can reintroduce perceived drift.

---

## 7. Migration Checklist Before Making Slava Default

1. Continue reducing dependency on Default base visuals by moving lower-level shared structure into neutral layout classes and Slava visuals into Slava tokens.
2. Run `npm run check:inline-styles` before UI commits.
3. Run and review `npm run check:slava-screenshots` for these Slava flows:
   - empty canvas
   - node library open/collapsed
   - inspector with text/image/model nodes
   - settings with API keys collapsed/expanded
   - chat rest/busy/error/image chips
   - connected nodes with handles at rest/hover/drag
   - image surface node hover/selected
   - connection popup and context menu
   - executing node loading/progress state
   - text-surface and sticky-note inline editor
   - reroute node
   - mesh modal
4. Make Slava the default skin only after the above passes.

---

## 8. Implementation Rules

- Scope every Slava selector under `body.app-slava-restraint`.
- Prefer token edits over local component exceptions.
- Keep static visual styling out of JSX inline styles; dynamic geometry/data values are allowed.
- Do not change Default or Hermes behavior while hardening Slava.
- Avoid new global rules unless they neutralize a global bug affecting Slava.
- Do not animate layout-critical React Flow transforms.
- Do not use color as decoration. Color must communicate focus, selection, action, category, or state.
- Do not introduce long instructional text into the UI. Controls should be obvious by shape, icon, label, and state.

---

## 9. Open Questions

1. Should Slava keep Inter as the primary UI font, or switch to a more distinctive grotesk before becoming default?
2. Should orange continue to do both primary and error work, or should error get a separate semantic token?
3. Should image-surface nodes become the canonical node style for all visual outputs?
4. Should the toolbar wordmark remain once Slava is default, or move into a quieter app-level identity surface?
5. Should Default/Hermes remain selectable skins after Slava becomes default, or should Slava become the base CSS and the others become legacy themes?
