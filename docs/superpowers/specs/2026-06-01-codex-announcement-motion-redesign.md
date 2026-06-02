# Codex Announcement — Motion Redesign & Iteration Loop

- **Date:** 2026-06-01
- **Status:** Proposed (awaiting approval)
- **Project:** `hyperframes/codex-chat-announcement/`
- **Relationship to existing docs:** Complements `design.md` (brand tokens unchanged). Supersedes the **16s duration** and **CSS-mockup** approach in `.hyperframes/expanded-prompt.md` (will update that file during implementation).

## Context

A HyperFrames announcement video — *"Codex is now a chat option in Nebula Nodes."* The current best (v16) has drifted to **32s** (brief said 16s) and, across 15 prior versions, fought pacing/readability/camera-alignment without converging. Observed problems in v16:

- 2× too long; every beat drags.
- Dead-corner composition — 50–60% of most frames is empty black.
- Camera pans don't confidently center their subject (the v14/v15 "alignment" battle).
- Oversized ghost **"NEBULA NODES"** wordmark dominates the graph scenes; stray orange glow with nothing attached; graph nodes too small to read.
- Only the final lockup is clean.

## Goal

A confident, **readable** announcement that authentically looks like Nebula Nodes (Slava), with Firecrawl-grade **motion craft**. **Readability is the #1 bar:** every text beat must be large enough and held long enough to read and understand what's happening.

## Non-goals

- Not changing brand identity — stays **dark Slava**; orange is a **focus/active signal only** (never a background wash).
- Not reproducing literal live-app behavior — captured real UI is **composed/arranged for clarity** ("components don't have to act like they're in the app").
- No light / Firecrawl palette.

## Locked decisions

1. **Dark Slava UI**, tokens per `design.md`.
2. **Use REAL captured Nebula UI** as the visual source (authentic look), composed freely for the video.
3. **Firecrawl = MOTION reference only** — entrances/exits, sequence & timing, transforms, state transitions, feedback/interaction, easing, springs, looping/ambient motion, polish, performance. **Not** palette or UI.
4. **Readability first.** Length serves readability — target **~18–22s** (down from 32), tuned by the loop. Never compress text below a comfortable reading hold.
5. **Iterate autonomously in batches** (≈3 render→critique→fix rounds), then a montage check-in. Final sign-off by user.

## Motion system (Firecrawl technique → beat)

| Firecrawl motion technique | Where it lands |
|---|---|
| Mask-faded edges on every texture | Dot-matrix canvas + the ghost wordmark → **kills the hard oversized-wordmark artifact** |
| Two-tone kinetic headline, tight tracking, word stagger | Opener + final lockup (decelerate reveal, not `steps(1)` snap) |
| Ambient shine sweep (~3.5s) on idle cards | Chat panel + node cards stay alive between beats |
| Ping ring (scale→fade+blur) + 1s orange border-pulse | "Codex connected" status; the active node (orange = focus signal) |
| Rotating conic-gradient border | Generation node = "processing" (no spinner) |
| Tactile press (~100ms scale+shadow) | Codex tab click + send button |
| Toast pop-in (0.3s from 80%, faster out) | The ✓ result rows |
| Directional swipe transitions | Scene-to-scene exits (replace generic fades) |

**Easing/spring (GSAP):** emphasized `cubic-bezier(0.2,0,0,1)` and Vaul's `cubic-bezier(0.32,0.72,0,1)` for panel slides via `CustomEase`; `back.out` for settles (sparing); sub-300ms feedback; **transform/opacity only** (GPU); mask-faded edges on all textures.

## Beat sheet (readability-first, ~20s)

One primary message per beat; no crowding.

- **S1 Hook (0–4s):** real empty canvas; one BIG readable headline; chat panel slides in (Vaul ease); ambient dot drift + panel shine. Hold to read.
- **S2 Reveal (4–9s):** focus chat panel; agent selector `Claude / Codex / Daedalus`; **Codex** activates (orange border-pulse + ping); status resolves to `Codex · ChatGPT`; one readable line — *"Use your ChatGPT subscription."* Hold.
- **S3 Proof (9–16s):** graph builds **fast + orchestrated** (real node cards stamp, edges draw, orange pulse travels the path — not 2.4s/node); caption *"Codex builds and wires the graph"*; ✓ result rows pop in. Comfortable hold to comprehend.
- **S4 CTA (16–20s):** calm lockup; two-tone *"Codex is now in Nebula Nodes"*; support line; agent pills; `Available now`.

## Asset capture (real UI) — first implementation step

- Start Nebula dev server (background; normal browser per project convention), Slava skin, 1920×1080.
- Capture clean stills: (a) empty canvas (verify/refresh existing), (b) chat panel + agent selector with Codex active, (c) a real connected node graph.
- Crop/clean into `assets/real-ui/`. **Show captures to user before compositing** (fidelity check-in).
- Copy/labels adapt to what the real app actually shows.

## Iteration loop

1. Edit `index.html` (timeline + composition).
2. `npm run check` — fix all errors; review inspect warnings.
3. `npm run render` → MP4.
4. `ffmpeg` full-duration contact sheet + full-res frames at suspect beats → **score against the rubric**.
5. Fix → repeat (~3/batch) → montage check-in.

Deterministic (same HTML → same MP4). Framework specifics via `npx hyperframes docs <topic>`; install skills with `npx skills add heygen-com/hyperframes` if needed.

## "Looks right" rubric (priority order)

1. **Readability** (TOP) — text large + held long enough to read.
2. **Comprehension** — clear what's happening at each beat.
3. **Composition** — balanced; no dead-corner framing.
4. **Camera** — every pan centers its actual target.
5. **Fidelity** — looks like the real Nebula Nodes (Slava) UI.
6. **Motion quality** — deliberate entrances/exits/ambient/transitions; velocity-matched.
7. **Zero artifacts** — no stray glows, hard-cut textures, oversized ghost layers.
8. **Pacing** — tightened from 32s without hurting #1.

## Risks / notes

- Real chat panel may not show all three agents in one clean shot → compose from real chrome.
- HyperFrames skills may not be installed in-session → fall back to `npx hyperframes docs`.
- Render is ~1 min/iteration → bounds loop speed; batch accordingly.
