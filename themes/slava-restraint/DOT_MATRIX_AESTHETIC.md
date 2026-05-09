# Slava Dot Matrix Aesthetic

Reference video: `/Users/justinperea/Desktop/Drop/rjj-_c2Kd3clVf67.mp4`

This note captures the visual direction we want to fold into Slava as we continue implementing the UI. The intent is not to make the app feel like a decorative retro game. The intent is to borrow a restrained, hardware-limited visual language and apply it where it reinforces the canvas, motion, system feedback, and object states.

## Source Language

- 1-bit dithering: dot patterns stand in for shading, density, and atmosphere.
- Dot matrix / LCD aesthetic: visible pixel/dot structure, sparse lit cells, strict alignment.
- Digital halftone: larger forms are built from repeated dots with density shifts.
- Retro wireframe / vector display: thin plotted lines for paths, orbits, routes, and system traces.
- Pixel-solid foreground: important subjects can remain chunky and direct while the environment stays dithered.

## Observations From The Reference

- The background is very dark, nearly flat, with subtle large tonal blocks.
- Dot fields are sparse, not full-screen noise.
- Dither objects appear as quiet scenery: nebula clouds, platforms, circles, skyline bars, terrain, smoke, or stars.
- Foreground objects use blocky, solid pixels and high contrast.
- White dots carry structure; accent color appears sparingly.
- The reference moon is a luminance/density gradient, not one flat color: low dots sample around `#4E4F4D`/`#5F605E`, mid dots around `#90918E`/`#A7A8A5`, bright dots around `#CDD0C6`, and rare compressed highlights near `#F7F9F3`.
- Motion feels mechanical and stepped, but not jittery.
- Vector lines are occasional overlays, not the base texture.
- Empty space is important. The style works because the canvas is not saturated.

## Application Areas

### Canvas Background

Goal: replace the current line-grid first impression with a dot matrix field.

- Use a low-opacity dot grid as the base canvas texture.
- Keep pan/zoom behavior stable and non-distracting.
- Add density variation only at large scale, not under every node.
- Avoid making dots compete with React Flow handles or edge endpoints.

Implementation candidates:
- CSS radial-gradient dot matrix on the React Flow pane.
- Optional second sparse dot layer with larger spacing.
- Very faint vignette or tonal blocks only if readability stays high.

### Empty Canvas And Ambient Scenery

Goal: use the aesthetic to make empty space feel intentional.

- Add sparse dither clusters that read like a nebula: asymmetric dot clouds, denser core regions, terminal-like star dust, and low-opacity halftone veils.
- Keep scenery out of primary interaction paths.
- Avoid explanatory text in the canvas.

Implementation candidates:
- Canvas pseudo-layer for ambient nebula clusters.
- Dithered wordmark/status region near the existing bottom wordmark.
- Optional "system field" pattern when no nodes are present.

### Node Loading And Placeholder States

Goal: make state changes feel like hardware feedback instead of modern skeleton loading.

- Replace smooth skeletons with dot-fill reveal or stepped pixel shimmer.
- Use dotted progress fields inside empty preview wells.
- Keep loading motion calm and reduced-motion safe.

Implementation candidates:
- Dot-matrix loading mask for image/video/mesh preview placeholders.
- Stepped opacity animation using `steps()`.
- Sparse dot activity ticks in node headers.

### Panels And Shadows

Goal: make panels feel less generic glass and more terminal hardware without reducing legibility.

- Keep panels readable and glassy.
- Use dithered falloff selectively around panel edges or empty areas.
- Do not add heavy texture inside form controls or message text areas.

Implementation candidates:
- Optional dithered shadow overlay behind major panels.
- Dot-edge separator treatment for empty panel states.
- Terminal-density empty states for Agent Log and Inspector.

### Agent Log

Goal: make Agent Log feel like telemetry.

- Represent events as compact terminal rows.
- Use small dot ticks or pulse cells for activity.
- Use mono metadata and sparse separators.

Implementation candidates:
- Dotted activity rail.
- Event severity/state dots.
- Collapsed Agent Log could show a faint single-line activity trace.

### Edges And Execution Motion

Goal: keep the current readable curves, then add retro-technical feedback only when useful.

- Default edges stay quiet and clean.
- Selected/running edges can show sparse particles or dot pulses.
- Avoid replaying edge animation on node drag.

Implementation candidates:
- Dotted pulse overlay during execution.
- Vector-display style edge highlight for active paths.
- Small endpoint glow that aligns with handle dot centers.

### Inspector And Media Empty States

Goal: use halftone as the system's "nothing here yet" language.

- Empty media previews can show dithered blocks instead of blank boxes.
- Inspector empty state can use subtle dot geometry rather than large text.
- Avoid decorative illustrations.

Implementation candidates:
- Dither placeholder for missing image/audio/mesh outputs.
- Dot matrix "no selection" surface.
- Sparse preview diagnostics for unsupported media.

### Toolbar And Active Controls

Goal: controls should feel like lit cells, not flashy buttons.

- Active toolbar buttons can brighten like LCD pixels.
- Hover states can reveal a slight dot texture in the control well.
- Icon clarity still wins over texture.

Implementation candidates:
- Active state dot backing. Implemented for Slava toolbar buttons in `frontend/src/styles/slava-restraint.css`, with screenshot assertions in `scripts/slava-screenshot-check.mjs`.
- Tiny matrix tick marks for grouped toolbar separators.
- Stepped hover transition only where it feels intentional.

## Implementation Order

1. Canvas dot matrix background. Implemented in `frontend/src/components/Canvas.tsx` and `frontend/src/styles/slava-restraint.css`.
2. Empty canvas ambient nebula clusters. Deferred for a separate visual pass; do not ship until the density bands and motion are tuned outside the main Slava polish loop.
3. Dot-matrix loading and placeholder states.
4. Agent Log telemetry treatment.
5. Active/running edge dot pulses.
6. Panel empty-state dither.
7. Toolbar active-cell refinements. Implemented with active dot backing, selected-cell border treatment, and `aria-pressed` coverage.

## Design Rules

- Scope implementation under `body.app-slava-restraint`.
- Keep productive surfaces readable first.
- Use dots for atmosphere, state, and system texture, not decoration everywhere.
- Preserve Slava's single accent color model.
- Do not introduce full-screen noise.
- Respect `prefers-reduced-motion`.
- Do not animate React Flow layout-critical transforms.
- Do not let the dot grid make handles, edges, or text harder to read.

## Candidate Tokens

Runtime tokens now exist for the first canvas pass:

```css
--sr-canvas-phosphor: #C9CAC8;
--sr-canvas-dot-color: rgba(201, 202, 200, 0.15);
--sr-canvas-dot-color-soft: rgba(201, 202, 200, 0.075);
--sr-canvas-dot-step: 16px;
--sr-canvas-dot-size: 1.2px;
```

These additional tokens do not exist yet; add them only when implementation needs them.

```css
--sr-dither-size: 2px;
--sr-dither-step: 8px;
--sr-dither-opacity: 0.10;
--sr-vector-line: rgba(255, 255, 255, 0.18);
--sr-vector-line-soft: rgba(255, 255, 255, 0.08);
```

## Acceptance Criteria

- The canvas reads as dot matrix, not line grid.
- Nodes, handles, edges, and panels remain more important than the texture.
- Dots stay locked to the canvas world during pan/zoom or intentionally stay screen-fixed, but never feel accidentally drifting.
- Reduced motion has no pulsing, shimmering, drift, or particle movement.
- Slava screenshot checks include at least one dot-background assertion once implemented.
