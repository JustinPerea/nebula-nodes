# Chat Panel — Follow-up Backlog

Items deferred during the chat panel build (2026-04-16). Not urgent; park here until we pick them up.

---

## 1. Helper / reference library — assets that Claude AND nodes can consume

### Problem
Users want a library of reusable assets they can plug into graphs. First example: color palettes. The user shared a reference showing a workspace with "Color Palette Extraction" / "Color Palette Blocks" tooling where palettes can be fed into an image-generation pipeline as either a text string (hex codes + weights) or a rendered image.

The shape generalizes beyond palettes — likely also prompt templates, reference images, saved style blocks, logo marks. A single "Helpers" library with typed entries that know how to render themselves into multiple input formats.

**Re-confirmed 2026-04-19:** user restated this as "a reference section of images and notes that both claude and nodes can see as reference". Key insight that sharpens the design: **Claude needs read access too, not just node inputs**. So the store needs a CLI/skill surface Claude can query (`nebula helpers list`, `nebula helpers show <id>`) in addition to the node-drop UX, and images must be addressable as vision blocks Claude can read inside a chat turn.

### Design sketch
- **Data model:** each helper has `{id, kind, label, tags, assets}` where `assets` is a map of output form → value. E.g. a palette entry has `assets.text = "#F5F4E3 60%, #B2B3B3 15%, …"` and `assets.image = "<url to rendered palette PNG>"`.
- **UI:** new panel next to Nodes/Chat — browseable, searchable, tag filter. Drag an entry onto the canvas → drops as a `text-input` or `image-input` node preloaded with the appropriate asset, based on which form the user wants (possibly pick via a small popup on drop).
- **Storage:** start with a JSON file at `backend/data/helpers.json`. CRUD endpoints: `GET/POST/PUT/DELETE /api/helpers`.
- **CLI parity:** `nebula helpers list`, `nebula helpers add`, `nebula helpers use <id>` so Claude can pull helpers into graphs too.

### Open questions
- Do palettes render server-side (Pillow) or client-side (canvas)? Server-side is simpler and means the image form is a real file on disk that any image-input node can consume without re-rendering.
- Who creates helpers? Just the user, or can Claude save a helper after generating something the user liked (via a "favorite this" action)?
- Versioning? If a user edits a palette, does it break graphs that reference it by ID?

### Estimated scope
Medium. New backend resource, new panel component, drop handler. Design thinking required up front to avoid painting ourselves into a corner with the asset-form model.

---

## 2. Drag-node-to-chat — richer reference than plain ID (follow-up)

### What shipped in v1 (2026-04-16)
Drag the `@n1` chip on a node header into the chat textarea → inserts `@n1` as text. Claude resolves the short ID via the nebula CLI. Works for all CLI-created nodes.

### What's left for v2
- User-manually-created nodes have UUIDs, not short IDs. The chip currently inserts `@<uuid-8> (label)` for those, which Claude can't resolve via the CLI because those nodes aren't in the cli_graph. Fix: either (a) sync frontend-created nodes into cli_graph too, so every node has a short ID Claude can address, or (b) send a structured reference alongside the text message so the backend can inject full node context.
- Drop a node's **image output** into chat → send the actual image as a vision block to Claude so it can literally see the output. Needs structured refs + vision attachment in the WebSocket protocol.
- Visual polish: when dragging, show a preview chip that follows the cursor; show a drop zone highlight on the textarea.

---

## 3. Auto-layout for Claude-created graphs

### Problem
When Claude runs `nebula create` repeatedly, nodes end up in a horizontal line (see backend/main.py `export_graph_for_frontend`: `x = 300 * i, y = 100`). For branching topologies (one text-input feeding three image models) this is ugly and hard to read. The user wants graphs that look "pretty by default."

### Two paths
**(a) Teach Claude via skill content.** Add layout conventions to `~/.claude/skills/nebula/SKILL.md`: "place input nodes on the left, output nodes on the right, stack parallel branches vertically at 220px spacing, avoid crossing edges." Fast to try, fragile — Claude may drift, positions have to be computed per-turn.

**(b) Backend auto-layout pass.** Run a graph layout algorithm on every `graphSync` broadcast and override positions. Candidates:
- **dagre** — classic layered DAG layout. Python port: `networkx` + custom layered algorithm, or call out to JS `dagre` via a subprocess. Simpler: port the algorithm (it's ~200 lines for the core).
- **elk-py** — more layout options but heavier.
- **Custom** — since nebula graphs are small DAGs, a basic "longest-path layering + within-layer barycenter ordering" gets 90% of the value in <100 lines.

Consistent, but **steals user-chosen positions**. Mitigation: track per-node `pinned` flag; any node the user manually drags gets pinned and is excluded from layout passes.

### Research needed before implementing
- Does the user care about position stability during incremental graph edits? (If Claude adds one node, does the whole graph get re-laid-out, or only the new node placed relative to existing ones?)
- How do we handle hybrid graphs where user dragged some nodes and Claude added others?
- Is the dagre port worth it, or is the "place relative to existing neighbors" heuristic (already partially in the `maxX + 300` code in graphStore.ts:209) good enough if we make it smarter about y-stacking for branches?

### Estimated scope
Medium. Most cost is in decision-making and position-stability edge cases. Implementation itself is bounded.

---

## Disposition log

| Date | Item | Status |
|------|------|--------|
| 2026-04-16 | Helper library | Parked. Need design spike. |
| 2026-04-19 | Helper library | Re-confirmed by user; sharpened scope (Claude must read too, not just nodes). Still parked pending design spike. |
| 2026-04-16 | Drag-to-chat v2 (UUID + vision) | Parked. v1 shipped with short-ID-only. |
| 2026-04-16 | Auto-layout | Parked. Needs research on position stability + layout algo choice. |
