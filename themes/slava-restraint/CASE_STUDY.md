# Slava Restraint Case Study

**Project:** Nebula Nodes  
**Skin:** `slava-restraint`  
**Status:** default skin checkpoint  
**Primary files:** `frontend/src/styles/slava-restraint.css`, `frontend/src/components/Canvas.tsx`, `frontend/src/components/nodes/ModelNode.tsx`, `frontend/src/components/panels/*`

## Summary

Slava Restraint turns Nebula Nodes from a prototype-style node editor into a quieter creative operating surface. The work started as visual polish, but it became a full UI system pass: canvas texture, panel chrome, chat, node surfaces, image nodes, handles, edge endpoints, agent telemetry, settings, and motion rules now share one scoped token system.

The skin is intentionally still scoped under `body.app-slava-restraint` even though it is the default. Default and Hermes remain selectable, and Slava-specific regressions are guarded by CSS scope checks plus a browser screenshot suite.

## Direction

The visual language is restrained dark glass, monochrome interface states, a single orange accent, and dot-matrix hardware feedback. The goal is not retro decoration. The graph, generated media, and user text remain the primary objects; chrome sits behind them.

Core principles:
- Dark translucent glass instead of heavy slabs.
- Dot matrix as state and atmosphere, not full-screen noise.
- Orange only for primary action, focus, selection, connection catch, and important alerts.
- Lucide icons with tokenized size/stroke.
- No positional surprise: React Flow layout transforms are never animated.
- Motion is bounded, with reduced-motion fallbacks for loops, handles, and entrances.

## Before / After

### Canvas

Before, the default line grid made the app feel like a generic flow editor. Slava replaces that with a low-weight dot matrix background and a small bottom wordmark treatment. Empty canvas states now feel intentional without competing with nodes.

Evidence:
- `output/slava-screenshot-check/01-slava-desktop.png`
- `output/slava-screenshot-check/15-empty-canvas.png`
- `output/slava-screenshot-check/14-mobile-slava.png`

### Nodes

Standard node cards were tightened into glass surfaces with tokenized spacing, radius, type, state, and category treatments. Text nodes and sticky notes are now surface-first: the content owns the card, and secondary actions moved into header actions.

Evidence:
- `output/slava-screenshot-check/08-inspector-text-node.png`
- `output/slava-screenshot-check/11-inspector-sticky-note.png`
- `output/slava-screenshot-check/12-slava-popovers-and-states.png`

### Image Surfaces

Image nodes moved closer to the Flora reference: the image owns the card instead of sitting inside a heavy nested container. Header actions are subtle and inline instead of floating oversized media buttons. Image dragging no longer starts a browser image drag in Slava; it moves the node surface.

Evidence:
- `output/slava-screenshot-check/03-image-surface-selected.png`
- `output/slava-screenshot-check/09-inspector-image-file.png`

### Handles And Edges

The handle work was the technical anchor of the pass. The final version uses a stable 20x20 hit zone with pseudo-elements:
- Rest: quiet 9px white dot.
- Hover/connecting: glass circle with plus glyph.
- Connecting: orange catch ring.
- Cursor magnetism moves only painted pseudo-elements, not React Flow layout.
- Edge endpoints compensate to the visible rest-dot center, avoiding idle gaps.

The main rule that came out of this work: inside React Flow, never animate layout-critical transforms. Use opacity, color, border, shadow, filter, SVG dash offset, or child pseudo-element transforms that do not replace React Flow positioning.

Evidence:
- `output/slava-screenshot-check/01-slava-desktop.png`
- `output/slava-screenshot-check/12-slava-popovers-and-states.png`

### Chat

Chat now shares the panel system instead of looking like a separate legacy modal. The composer is one visual field with an inline arrow action, and the suite covers empty, message, image-reference, busy/stop, error, chip, and cancellation states.

Evidence:
- `output/slava-screenshot-check/04-chat-empty-rest.png`
- `output/slava-screenshot-check/05-chat-message-image.png`
- `output/slava-screenshot-check/06-chat-busy-stop.png`
- `output/slava-screenshot-check/07-chat-error-chips.png`

### Inspector And Settings

Inspector controls now use a shared render contract for static and dynamic params. The settings panel has correct layering over chat, API keys are collapsed by default, and skin switching is verified from a fresh browser profile.

Evidence:
- `output/slava-screenshot-check/02-settings-api-expanded.png`
- `output/slava-screenshot-check/08-inspector-text-node.png`
- `output/slava-screenshot-check/09-inspector-image-file.png`
- `output/slava-screenshot-check/10-inspector-model-warning.png`
- `output/slava-screenshot-check/11b-inspector-dynamic-controls.png`

### Agent Log

Agent Log moved from a default visible panel into an opt-in telemetry surface. It starts hidden, can be enabled from Settings, stays collapsed by default, supports dragged positions, preserves viewport anchoring on resize, and uses compact telemetry rows.

Evidence:
- Covered by `npm run check:slava-screenshots` interaction assertions.

## Verification

Run from `frontend/`:

```bash
npm run lint
npm test
npm run build
npm run check:slava-screenshots
```

The screenshot suite writes local captures to:

```text
output/slava-screenshot-check/
```

Those PNGs are generated artifacts and are ignored by git. Regenerate them when packaging screenshots or reviewing the skin visually.

The current suite covers:
- Fresh default skin and Settings skin switching.
- Slava CSS scoping and active body classes.
- Desktop, mobile, and empty canvas captures.
- Chat rest/message/image/busy/error states.
- Inspector text, image, model warning, sticky note, and dynamic controls.
- Mesh modal, context menu, connection popup, executing state, reroute node.
- Panel layering, chat drag/resize, agent log enable/drag/resize/reset.
- Image-surface node drag behavior.
- Handle hover, magnetism, center lock, edge endpoint alignment, and reduced-motion behavior.

## Known Caveats

### Computer Use permission

Computer Use is currently blocked until macOS Automation/Accessibility permissions are refreshed. The browser screenshot suite is passing, but visible-window manual testing should be repeated after Codex/Terminal is restarted and macOS permissions are active.

### Live drag-to-create

Native library drag-to-create is awkward to automate in the headless CDP harness because synthetic drag/drop events are not trusted like real browser drags. The code path remains simple (`application/nebula-node` drag payload -> Canvas drop -> `addNode`).

Manual visible-browser QA on 2026-05-09 passed in Comet/Chrome-family browsers: `Text Input` drags from the Utility group, shows the Slava preview, and lands on the canvas under the cursor. Safari did not drag reliably in the same pass. Treat Chrome-family browsers as the current verified target for Slava drag-to-create.

Manual check:
1. Open `http://localhost:5173/`.
2. Open the Nodes panel.
3. Drag `Text Input` from the library onto the canvas.
4. Confirm the Slava drag preview appears and a text node lands under the cursor.

### Visual review

The automated suite checks structure, state, and screenshots, but final promotion still benefits from a human pass over the generated PNGs:
- Text density at mobile width.
- Whether dot matrix density feels too faint/too busy on the user's display.
- Whether the off-canvas Nodes/Chat launchers leave enough room for active graph work.

## Related Notes

- [Design System](./DESIGN.md)
- [Dot Matrix Aesthetic](./DOT_MATRIX_AESTHETIC.md)
- [Motion Suite](../../docs/portfolio-motion-suite.md)
