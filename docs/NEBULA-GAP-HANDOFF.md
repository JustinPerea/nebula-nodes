# Handoff — Close Flora gaps in Nebula Nodes

Paste the prompt below into a **new Cursor chat** with workspace root
`/Users/justinperea/Documents/Workspace/Projects/nebula_nodes`.

Keep Nari / Flora character work in the other chat. This chat is for shipping first-class Nebula nodes.

---

## Paste-ready prompt

```
Close high-priority Flora→Nebula model gaps.

Read first (do not skip):
- AGENTS.md (standing Flora gap-audit rule)
- docs/flora-gap-audit.md (baseline + Running Log)
- docs/NEBULA-GAP-HANDOFF.md
- backend/data/node_definitions.json (source of truth for nodes)

Scope for this chat — implement first-class nodes (not universal-node wrappers) in priority order:

1. HIGH — Audio-driven talking head / lipsync
   Flora has Lipsync 2 Pro, Sync 3, VEED Lipsync, Fabric 1.0, Aurora, Kling Avatar v2 Pro.
   Nebula has none. Pick the best BYOK-reachable provider(s) we can actually call (FAL / direct API) and add at least one lipsync or avatar node with typed params.

2. HIGH — Enhancor skin-realism i2i (V3/V4)
   Used in Flora Seedance-Enhancor pipelines for UGC faces. Add if an API endpoint exists we can hit with our keys; otherwise document blocker + closest FAL substitute.

3. MEDIUM — First/last-frame (f2v) video category
   Flora has f2v for Kling, Luma, Seedance, Veo, Hailuo. Nebula has zero FLF nodes. Add at least Seedance and/or Kling f2v following existing video node patterns.

4. MEDIUM — Kling depth (Pro / Edit / Reference / Motion Control)
   We only have Standard tiers. Extend carefully; prefer enum expansion on existing nodes when the same endpoint family allows it.

Rules:
- Follow existing node patterns in backend (execution, ports, env keys) and frontend registration.
- After adding nodes: regenerate docs/MODEL_REFERENCE.md via `node scripts/generate-model-reference.mjs`.
- Check closed gaps off in docs/flora-gap-audit.md Running Log / mark status.
- Do not invent endpoints — verify against provider docs / FAL schemas in docs/.
- Ask before spending on live paid smoke tests if cost is unclear; unit/schema tests are fine.

Start by proposing a short implementation plan for #1 and #2, then implement.
```

---

## Context snapshot (2026-07-25)

- Flora catalog size at audit: ~369 models
- Nebula nodes: 142 in `node_definitions.json`
- Caveats already documented: `nano-banana` enum covers Pro; `runway-video` covers Seedance 2.0 / Happy Horse / Gen-4.5; MiniMax covers Hailuo 2.3; `veo-3` is Veo 3.1
- Nari work is actively using Flora multi-ref (is2i) + will use Enhancor + lipsync later — those gaps are real product pressure, not theoretical
