# HyperFrames + GSAP gotchas

HyperFrames renders an HTML file to MP4 by **seeking a paused GSAP timeline frame-by-frame** through headless Chrome. That single fact explains most of the rules: there is no real-time playback, so everything must be deterministic and expressed as timeline state at time `t`.

## Skeleton (copy from the reference `index.html`)

```html
<div id="root" data-composition-id="main" data-start="0" data-duration="26" data-width="1920" data-height="1080">
  …layers…
</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true, defaultEase: 'power3.out' });
  // …build the timeline with absolute times: tl.to(sel, {...}, 5.8) …
  window.__timelines['main'] = tl;   // MUST register, paused, with the composition id
</script>
```
- Root needs `data-composition-id` + `data-duration` (seconds) + dimensions.
- The single timeline is `paused` and registered on `window.__timelines[<id>]`. The renderer seeks it.
- GSAP core only (no plugins) — keep it on the CDN build that's proven (`3.14.2`). Use built-in eases (`power2/3/4`, `back.out`, `sine.inOut`); CustomEase isn't loaded.

## Determinism (or the render is wrong/garbage)

No `Math.random()`, no `Date.now()`/`new Date()`, no network fetches, no reading wall-clock. Every frame must be a pure function of timeline time. (Vary things by index/position instead of randomness.)

## HARD CUTS vs cross-fades — the #1 quality lever

When you stage a sequence from near-identical full-frame captures (line-by-line typing, node-by-node wiring), **cut, don't cross-fade.**

- Cross-fade: `tl.to(prev,{autoAlpha:0,...}); tl.to(next,{autoAlpha:1,...})`. At the midpoint both are ~0.5 alpha → the *entire frame's* shared pixels dim → reads as a **flash** on every step.
- Cut: `tl.set(prev,{autoAlpha:0}, T); tl.set(next,{autoAlpha:1}, T)` at the same `T`. The shared pixels are identical between the two captures, so nothing visibly changes except the new line/node appearing. Clean, "it's happening live."

Reserve cross-fades / blur-throughs for genuine *scene changes* (empty→chat, dock→wire), where the frames really differ.

## Centered cards / elements: GSAP transform conflict

A card centered with CSS `transform: translate(-50%,-50%)` will **jump off-center** the moment GSAP animates its `y`/`scale` (GSAP overwrites the whole `transform`). Center via GSAP instead:
```js
tl.set('.card', { xPercent: -50, yPercent: -50 });   // centering lives in GSAP's transform
tl.fromTo('.card', { autoAlpha:0, y:20, scale:.965 }, { autoAlpha:1, y:0, scale:1, ... }, T);  // y/scale compose cleanly
```
CSS keeps only `left:50%; top:50%`.

## Typing + a caret that tracks the text

Reveal the text with `clip-path` (percentage-based — robust, no measurement), and animate a *separate* caret's `x` with the SAME `steps()` so it rides the reveal edge:
```css
.typed { display:inline-block; white-space:nowrap; overflow:hidden; clip-path: inset(0 101% 0 0); }
.typed-caret { position:absolute; left:0; /* …orange bar… */ }
```
```js
tl.to('.typed', { clipPath:'inset(0 0% 0 0)', duration:1.5, ease:'steps(48)' }, T);
tl.to('.typed-caret', { x: 372 /* ≈ text px width */, duration:1.5, ease:'steps(48)' }, T);
```
**Do NOT** animate `.typed`'s `width` to a measured `scrollWidth`: at script-execution time the web font isn't loaded yet, so the measurement comes up short and the text clips (the inspector flags `clipped_text`). The clip-path + caret-x approach sidesteps measurement entirely — a few px of caret drift is invisible; clipped text is not.

To cover a real input's placeholder while overlaying typed text, lay an opaque rounded rect (matching the field bg) generously over the whole input text area, then the typed text + caret on top.

## Cursor choreography

- Put the cursor (and click-ring) **inside the scaling stage** so they stay pinned to UI targets through zooms. Express targets in capture coordinates (measured via `getBoundingClientRect`).
- **Move the cursor off the input before typing** — never let it sit on the text it's "typing."
- Click feedback = a ring that scales `0.4→1.5` and fades (a small reusable helper). A tactile `scale .82` yoyo on the cursor sells the press.
- "Pan down to a toolbar," "ride the zoom to the tab," etc. read as intent — animate the cursor's path, not teleports.

## Intentional overflow / zoom

Scaling a full-frame stage past 1.0, or a sweep element that overflows its clip, will trip the layout inspector. Mark it intentional: `data-layout-allow-overflow="true"` on the scaling stage (and any clipped sweep container).

## Zoom for readability (and its cost)

Captures are 1920-wide. Zooming the chat stage to ~1.4–1.6 magnifies text for readability but **upscales the raster → slight softness.** Options: accept it; or recapture the panel at a 2× device-scale / larger size for crisp text at zoom. Frame the zoom origin so the content you care about (conversation, input) stays in view.

## Audio (documented for when real SFX exist)

HyperFrames mixes declarative `<audio>` into the MP4 — you never call `.play()`.
- Each `<audio>` **REQUIRES an `id`** or the renderer skips it (silent; lint: `media_missing_id`).
- Timing is declarative: `data-start`, `data-duration` (seconds); `data-volume` 0–1 scales the file.
- Two clips on the same `data-track-index` can't overlap — spread simultaneous SFX across different track indices.
- Verify with `ffprobe` that the render has a non-silent audio stream. (Synthesized SFX read as cheap; prefer real SFX files dropped into the project — then wiring them onto cue points is trivial.)

## Loop commands

```bash
npm run check     # lint + validate + inspect — fix EVERY error before rendering; review warnings
npm run render    # → renders/<name>_<timestamp>.mp4
npx hyperframes docs <topic>   # data-attributes | gsap | compositions | rendering | examples | troubleshooting
```
`check`'s **inspect** step samples ~9 frames and catches text overflow, container overflow, off-canvas, and contrast — read its output, it catches things lint doesn't.
