---
name: nebula-nodes-visuals
description: >-
  Create polished motion-design videos for Nebula Nodes — product announcements, feature
  showcases, demo clips, launch/promo videos — by capturing the REAL Slava UI live and
  compositing it with HyperFrames (GSAP) using a Firecrawl-style motion grammar and a
  render → inspect → fix loop. Use this whenever the user wants a Nebula Nodes video,
  announcement, showcase, demo, promo, or "show off / make a clip for [feature]"; whenever
  editing a HyperFrames composition under hyperframes/* for Nebula; or when capturing the
  live Nebula app UI for a video. Covers the capture pipeline (driving the window.__nebula*
  stores), HyperFrames + GSAP gotchas (hard cuts vs cross-fades, deterministic timeline,
  typing/caret, centered-card transforms), the Slava brand + motion grammar, and the
  readability-first quality rubric. Reach for this even if the user doesn't say "HyperFrames."
---

# Nebula Nodes Visuals

Build polished motion-design videos for Nebula Nodes from the **real product UI** — not mockups. The signature move: capture the live Slava interface, composite it in HyperFrames with a Firecrawl-grade motion grammar, and refine through a tight **render → look → fix** loop until it reads cleanly.

This skill is a living playbook. It encodes what was learned building the "Codex is now a chat option" announcement over ~28 iterations. Improve it whenever you learn something new — add to the references, update the rubric, fix the script.

## Start here: the reference implementation

`hyperframes/codex-chat-announcement/` is the canonical, battle-tested example — **copy it, don't start from scratch.**

| File | What it is |
|---|---|
| `index.html` | The whole composition: real-UI `<img>` backdrops + one paused GSAP timeline. The proven template. |
| `assets/real-ui/*.png` | The captured Slava UI states (empty canvas, chat, graph build) at 1920×1080. |
| `capture-codex-states.mjs` | The Puppeteer driver that produced those captures (see `scripts/capture-nebula-ui.mjs` here for the generalized template). |
| `codex-chat-announcement.mp4` | The latest render. |
| `package.json` | `npm run check` (lint+validate+inspect) and `npm run render`. |

**To make a new video:** duplicate that directory, then swap the captured assets, the copy, and the timeline beats. The structure (full-frame backdrops + GSAP timeline + cards) transfers directly.

## The pipeline (this is the loop)

1. **Capture** the real Slava UI live → 1920×1080 PNGs. → `references/capture-pipeline.md`
2. **Compose** in HyperFrames: full-frame backdrops + one GSAP timeline. → `references/hyperframes-gotchas.md`
3. **Check + render**: `npm run check` (fix every error), then `npm run render`.
4. **Inspect**: extract a contact sheet + key frames with ffmpeg and **actually look at them**.
5. **Score against the rubric, fix, repeat.**

> **The inspect step is non-negotiable.** You cannot improve what you don't look at. After every render, build a contact sheet and read it, plus full-res frames at the suspect beats. Most of the quality came from catching problems by eye that lint never flags (dead space, flashing, a caret that didn't track, a misframed pan).

```bash
# contact sheet of the whole video (dense temporal overview)
ffmpeg -y -i RENDER.mp4 -vf "fps=1.25,scale=360:-1,tile=8x4" -frames:v 1 /tmp/sheet.png
# full-res frame at a specific beat
ffmpeg -y -ss 13.5 -i RENDER.mp4 -frames:v 1 /tmp/f_13.5.png
```
Then Read those PNGs and judge them against the rubric below.

## The "looks right" rubric (what the loop converges to)

In priority order — readability wins ties:

1. **Readability** — every text beat is big enough and held long enough to read comfortably (at the size the video will actually be watched, often downscaled for X).
2. **Comprehension** — a first-time viewer understands what's happening at each beat.
3. **Composition** — balanced; no content clinging to a dead corner; intentional negative space.
4. **Camera** — any pan/zoom confidently frames its subject (no overshoot/miss).
5. **Fidelity** — the UI looks like the *real* Nebula product (because it is — captured live).
6. **No artifacts** — no flashing on transitions, no stray glows, no oversized ghost layers, no hard-cut textures.
7. **Pacing** — tight; cut dead air and sluggish camera moves, never the reading time.

## Motion grammar + brand (the look)

- **Firecrawl is the MOTION reference, never the palette.** Borrow its entrances/exits, timing, transitions, focus pulses, ambient micro-motion, and tight easing — not its light/orange-wash UI.
- **Slava is the brand.** Black canvas (`#050506`/`#000`), `#ff5a1f` orange as a *focus/active signal only* (never a background wash), Inter for UI / JetBrains Mono for labels.
- **Bookend with glass cards** (intro + CTA, same treatment) carrying the nebula-mark logo.
- Full detail + the proven beat sheet → `references/motion-grammar.md`.

## Hard-won rules (the ones that bite)

These are inline because forgetting them costs an iteration each. Depth in the references.

- **Use HARD CUTS, not cross-fades, between staged captures.** Consecutive captures (line-by-line typing, node-by-node wiring) share identical pixels except the new element. A cross-fade dips the *whole frame's* alpha at the midpoint → reads as a "flash." A `tl.set()` cut shows only the new element appear. (→ hyperframes-gotchas)
- **Center cards with GSAP `xPercent/yPercent: -50`, not CSS `transform: translate(-50%,-50%)`.** Animating `y`/`scale` in GSAP overwrites the CSS transform → the card jumps off-center.
- **The cursor lives *inside* the scaling stage**, so it stays aligned through zooms. Move it OFF the input before typing (never let it cover the text). Use a click-ring pulse on each click.
- **Typing caret:** reveal the text with `clip-path` (%-based, robust) and animate a separate absolutely-positioned caret's `x` with the SAME `steps()` so it tracks the edge. Do NOT animate `width` to a measured `scrollWidth` — fonts aren't loaded at script time, so the measurement is wrong and the text clips.
- **Mark intentional overflow/zoom** with `data-layout-allow-overflow="true"` or the inspector errors.
- **Determinism only** — no `Math.random()`, `Date.now()`, or network calls; the renderer seeks the paused timeline frame-by-frame.
- **`npm run check` before every render**; fix all errors, review warnings.

## References

- `references/capture-pipeline.md` — driving the live app: the `window.__nebula*` stores, building graphs + chat, hiding clutter, measuring click targets, dev-server/port gotchas, and the capture script.
- `references/hyperframes-gotchas.md` — HyperFrames + GSAP specifics: timeline registration, data-attributes, hard-cut staging, typing/caret, centered-card transforms, the audio pipeline (for when real SFX exist), check/render.
- `references/motion-grammar.md` — the Firecrawl→Nebula motion mapping, Slava tokens, transition vocabulary, and the proven ~26s beat sheet (card → click chat → pick Codex → type → reply → wire → card).
- `scripts/capture-nebula-ui.mjs` — generalized Puppeteer capture template (the proven driver, parameterize per video).

## Deriving a frame.md from a reference video

To capture the **motion half** of a Nebula `frame.md` (HeyGen HyperFrames brand-motion spec) from a reference clip — e.g. a Firecrawl launch video — use the global **`motion-ref`** skill. It watches the video and emits a provenance-tagged `frame.partial.md` (easing, beats, transitions, palette), with every observation classified by the animations.dev motion vocabulary.

Supply Nebula's **static-brand source** — the live-UI capture, which already has exact Slava palette / type / corners — as the merge input, and `motion-ref`'s `synthesize.to_frame(observation, capture_handoff)` produces the full Nebula `frame.md`. **Capture supplies the static half; the reference video supplies the motion half.** See `references/capture-pipeline.md` → "Static-brand handoff" for the JSON shape.
