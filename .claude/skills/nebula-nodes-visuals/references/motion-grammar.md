# Motion grammar + Slava brand

## Firecrawl is the MOTION reference — never the palette

Firecrawl's launch videos are the inspiration for *how things move*, not how they look. Borrow the motion; keep Nebula's dark Slava identity.

| Firecrawl technique | Where it lands in a Nebula video |
|---|---|
| Mask-faded edges on every texture | Feather dot-grid / ghost layers to transparent so nothing hard-cuts |
| Two-tone kinetic headline, tight tracking, word stagger | Intro + CTA cards (decelerate reveal, not a snap) |
| Ambient shine sweep (~3s) across idle cards | A light bar sweeping the chat panel so still frames breathe |
| Ping ring + 1s orange border-pulse | The active node / a selected tab — orange as a *focus signal* |
| Tactile press (~100ms scale+shadow) | Cursor clicks (tab, send, chat icon) |
| Directional swipe / blur-through transitions | Scene changes (empty→chat, dock→wire) — never generic fades |

Plus craft on top: emphasized decelerate easing (`power3.out`), `back.out` for settles (sparingly), sub-300ms feedback, transform/opacity-only for smoothness, **impact → linger → release** rhythm so beats land.

## Slava brand tokens

- **Canvas** `#050506` / `#000000`; elevated glass `rgba(22,22,24,.66)`.
- **Accent** `#ff5a1f` — a **focus/active-state signal only**. Never a background wash. (This is the line that keeps it Slava, not Firecrawl-light.)
- **Ink** `rgba(255,255,255,.94)` primary, `rgba(255,255,255,.62)` secondary.
- **Type** Inter (UI/display), JetBrains Mono / IBM Plex Mono (labels, counters, status).
- Typed edges in the graph are colored by data type (Text = purple) — authentic, keep it.

## Cards bookend the story

Open and close on the **same glass card** treatment (blur(28px) glass, subtle border, big two-tone headline), carrying the **nebula-mark logo** (the dot-matrix orb — crop it from the empty-canvas capture with ffmpeg). Open over the live canvas (the card's backdrop-blur frosts the canvas behind it for depth); close over a near-black backdrop. This gives a strong brand bookend and a clean screenshot-able end card.

## The proven beat sheet (~26s)

The Codex announcement's structure, which read well. Adapt the content; the shape transfers.

1. **Intro card** (0–2.9) — glass card over the blurred live canvas: "A new agent just joined the canvas." Word-staggered reveal, hold, blur out.
2. **Pan down + click chat** (2.7–4.6) — empty canvas; cursor enters high and **pans down** to a chat icon at the toolbar; click-ring.
3. **Open + pick agent** (4.4–7.4) — chat opens (grow-in); a short caption sets the message; cursor moves to the agent tab while the **zoom rides the cursor** in for readability; hard-cut the tab to active.
4. **Type + send** (7.5–11.9) — cursor to input, slides off, prompt **types in** (clip-path reveal, caret tracking); cursor to send, click; hard-cut to the sent/"thinking" state.
5. **Reply** (11.6–15) — brief digest (status `thinking…` + busy), then the reply **types out line-by-line in ONE bubble** (`\n` → real line breaks; hard-cut between line states).
6. **Dock + wire** (15–20.3) — the chat **docks to its top-right home** (scale-down + slide) as the graph builds on the canvas beside it: **node1 → node2 → wire 1-2 → node3 → wire 1-3**, hard cuts, ease-out, no per-node zoom.
7. **CTA card** (20.5–26) — glass card with the nebula mark: "Codex is now in Nebula Nodes" + support line + agent pills + "Available now."

Pacing: total ~20–26s. Tighten dead air and sluggish camera moves; never compress the reading time (readability is rubric rule #1).

## Lessons paid for in iterations (so you don't repeat them)

- **Real UI > mockups.** The whole thing reads as authentic because it's the live product, captured.
- **Full-frame backdrops that share identical chrome** let you transition without the app shell jumping — and sidestep per-element camera-alignment bugs.
- **Readability is the bar that kept resurfacing.** Small chat text drove zoom-ins; a too-tall panel created dead space — capture the panel sized so content fills it.
- **Cross-fades between near-identical frames flash; cuts don't** (see hyperframes-gotchas — this fixed the "flashing" the user kept seeing).
- **Carets and cursors must track**, captions must clear the content they sit near, and intentional zoom must be marked — all small things that each cost a review cycle.
