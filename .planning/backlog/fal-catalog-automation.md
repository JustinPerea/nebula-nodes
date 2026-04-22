# FAL Catalog Automation — Ideas Inspired by fal-ai-community/skills

Captured 2026-04-22 after reviewing [fal-ai-community/skills](https://github.com/fal-ai-community/skills). That repo is not a direct fit for nebula (their skills call FAL directly from bash and bypass the canvas — opposite of our graph-first architecture), but two patterns are worth stealing.

---

## 1. Gap-analysis mining of their specialized skill list

Their skill taxonomy includes capabilities we don't yet expose as nebula nodes:

- **fal-tryon** — virtual clothing try-on
- **fal-lip-sync** — talking head, lip sync, live portrait
- **fal-restore** — deblur, denoise, face restoration
- **fal-realtime** — ~0.3s streaming image generation
- **fal-train** — custom LoRA training
- **fal-vision** — image segment / detect / OCR / describe
- **fal-video-edit** — remix, upscale, background remove, add audio
- **fal-redesign** — website screenshot → redesign pipeline (interesting pipeline template, not just one node)

### Action
When we do the next node-catalog audit (after OSS v1 settles), cross-reference their specialized list against our `backend/data/node_definitions.json` and pick 1-2 wins per category. Priorities likely: lip-sync (creator use case), restore (cleaning up low-quality user uploads), real-time (live iteration feel).

---

## 2. `nebula discover-fal` — auto-generate node definitions from FAL's model index

Their `search-models.sh` + `get-schema.sh` scripts solve a problem we currently handle by hand: every new FAL model needs a matching nebula node definition written manually. That's the long-tail bottleneck.

### Sketch
- New CLI command: `nebula discover-fal [--query <text>] [--category <cat>]`
- Hits FAL's model search API (same one `search-models.sh` uses).
- For each matching model, fetches its OpenAPI / JSON schema.
- Generates a candidate `node_definitions.json` entry with input/output ports, param types, enums — all auto-derived.
- Outputs a diff-style proposal: "Add these 3 nodes? [y/N]" with pretty-printed schemas.
- On approval, appends to `node_definitions.json` and registers a generic handler (universal FAL handler can already route by endpoint ID — no per-node Python code needed).

### Why it's valuable
- Unblocks long-tail FAL models (hundreds of endpoints) without hand-curation.
- Keeps the canvas-first architecture intact — the generated nodes still execute via our sync_runner + FAL universal handler.
- Catches breaking FAL schema changes if we re-run periodically against existing nodes (drift detection).

### Why it's NOT obvious
- FAL's schema conventions aren't 100% uniform across endpoints; some hand-tuning will still be required for quirky ones (e.g., Nano Banana's snake/camel mix).
- Generated param names may not match our conventions (we'd need a normalization layer).
- Dual-param architecture (`sharedParams` / `falParams` / `directParams`) needs a policy for auto-generated nodes — default probably: treat every auto-gen'd node as FAL-only until a direct provider adds it.

### Estimated scope
Medium. Core discovery + schema-to-node translation is ~300 lines. The polish (diff UI, drift detection, normalization rules) is where the time goes.

---

## Pattern reference

Full repo: https://github.com/fal-ai-community/skills (MIT)

Not adopting their skills wholesale because:
1. Bypasses the canvas (their scripts return URLs, not canvas nodes).
2. Bypasses BYOK routing (expects `FAL_KEY` in shell env; nebula routes keys through Settings UI).
3. Bypasses our execution cache, retry, and graphSync event pipeline.
4. Primer explicitly hard-gates direct CLI calls (`NEBULA_DISABLE_QUICK=1`). A "call FAL directly" skill would push Claude in the opposite direction.

Useful outside nebula (other Claude Code projects doing one-off FAL generations) but not inside it.
