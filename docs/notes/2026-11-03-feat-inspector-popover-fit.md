# feat/inspector-popover-fit

GM r68 (2026-11-03): the unpinned Inspector beside a node grows to fit its
content. Rounds 1 and 2 were frontend only, with `Inspector.tsx` untouched;
Round 3 adds the preview's stored size (backend `/api/uploads`, the
Inspector's preview `<img>`).

## The rule as built

- **Content fit.** The panel's height is the height that shows its whole
  body: the panel less its body's viewport (header, foot row, borders), plus
  the body's padding, plus the content's own height. The content sits in a
  new wrapper, `.node-inspector-popover__content`, which is a flow root so its
  sections' margins stay inside its height. The wrapper has a height of its
  own whatever the panel's height is, so the panel shrinks as well as grows.
  The old overflow read (`scrollHeight - clientHeight`) could only grow it.
- **Floor.** 300 px (`POPOVER_MIN_HEIGHT`).
- **Cap.** 12 px clear of the floating top chrome (the header and the
  selection toolbar, whichever is lower) and 12 px clear of the bottom bar
  (`POPOVER_CHROME_CLEARANCE`). Both lines are measured from the live rects
  every frame. The bottom line is the new `floatingBarLimit` in
  `lib/bottomBar.ts`. `floatingTopLimit` takes an optional gap. Past the cap,
  the body scrolls under its fade.
- **Removed.** `POPOVER_SPARE_LINE`, the palette exception (`holdsPalette`,
  `swatchCount`) and `PALETTE_RESIZE_MS`. The spring's attribute is now
  `data-content-resizing`.
- **Low node.** On placement (open, another node, the node moved), the panel
  keeps its height and shifts up to the bar's line. It only gets shorter once
  it reaches the top line.
- **Spring.** A height change from the content on the same node, with the
  node's position unchanged, runs on the existing 360 ms layout spring (a
  sampled `linear()` spring), using the same rules as before: rigid wins when
  the node moves mid-spring, and reduced motion jumps. Only the node's
  left/top count as a move, so its card growing when a preview lands still
  springs.
- **First frame.** A layout effect measures once more after each new frame is
  committed. A panel that just opened takes its content's height before it is
  painted, so it never shows a frame at 300 px.
- **Pinned.** No change: it still starts at 440 px, keeps the person's own
  size, and stays above the notice band.

## Decisions that need a look

1. **The cap ignores the notice band.** GM's "about 660 px at 1440x900" only
   fits the bar's line. Measured live: toolbar to 142, bar from 828, giving
   154 to 816, which is 662 px. The band's line (766) would give 612. So the
   unpinned panel's bottom line is now the bar minus 12, and a panel grown to
   the cap reaches into the reserved band (766 to 820). A notice showing then
   can sit over its foot row. This supersedes GM's 2026-10-23 round 2 band
   rule for the unpinned panel only, and the `NodeInspectorBand` tests were
   updated to match. If the band should still count, use
   `floatingBottomLimit` and a 12 px gap, which caps the panel at about
   612 px.
2. **The top holds on content changes, even near the bottom.** r68 says both
   "shifts up to fit before it shrinks" and, for height changes, "anchored at
   the top, so the file row doesn't move under the pointer". I applied
   shift-up to placement, and the top hold to content changes. Once the
   content changes height, the top stays where it is until the node moves.
   The bottom edge grows as far as the bar's line, and the rest scrolls. In
   the first live run, before the hold, an upload on a low node moved the file
   row up 131 px under the pointer.
3. **Text Input isn't a 300 px panel any more.** Its body needs 334 px (the
   old spare-line rule gave it 334 too), so it grows to 334. The floor shot
   uses Image Input, whose body needs 161 px (the panel stays at 300).
4. **Top clearance went from 8 to 12 px** for the unpinned panel (r68's
   "12 px clear of each"). The pinned panel keeps 8.

## Live check (1440 wide, isolated backend 8968, Vite 5968, no provider calls, Run never clicked)

- Style Reference at 1440x900: 531 px (needs 531), body doesn't scroll.
  After an upload: it springs from 531 to 630 (overshoot to 631.2, then it
  settles), the top stays at 185.5, the file row stays at 346.9, and the
  bottom stops at 816 (12 px over the bar).
- Style Reference at 1440x700: 462 px, from 154 to 616 (12 px clear of each),
  body scrolls.
- Node near the bottom (top 784): the panel shifts up to 285 to 816 and stays
  531 px. After an upload: top and file row unchanged, body scrolls.
- Image Input: 300 px (floor). Text Input: 334 px.
- Reduced motion: no transition, and the height jumps.
- Pinned: 440 px, ending at 766 (the band's line).

## Round 2 (GM r72)

- **The cap is the notice band's line now, not the bar's.** GM r72: "Cap to
  the BAND line, not the bar: the reserved notice band wins; a notice
  covering Run/Duplicate/Delete is the overlap r57 rules out. Unpinned only;
  pinned keeps its rule." The unpinned panel's bottom line is
  `floatingBottomLimit(..., FLOATING_CHROME_CLEARANCE)`: 12 px above the band.
  `floatingBottomLimit` gained an optional `clearance` (default 0, so every
  other caller is unchanged), and `floatingBarLimit` is gone. The
  `NodeInspectorBand` assertions that the band is never covered are back for
  the unpinned panel (now with the 12 px gap), and the pinned panel is pinned
  to the band's line itself (no clearance), so giving it the clearance fails
  a test.
- **The band measured live is 54 px, not 42.** At 1440x900 the band's top is
  766 (bar 828, minus the 8 px gap, minus 54), so the line is 754 and the room
  is 154 to 754: 600 px. GM's "~612" was an estimate. The content-fit tests
  now use the measured 54 px band.
- **One toolbar+12 top line.** `lib/bottomBar.ts` exports
  `FLOATING_CHROME_CLEARANCE` (12) and `floatingChromeTopLine(gutter)`, the
  only source for that line; the popover calls it, and PR C 2b's resize
  ceiling should too. A source test checks the popover passes no clearance to
  `floatingTopLimit` itself.
- **The order rule is in the code.** Next to the r68 reference in
  `measurePopoverFrame`: "don't move what's under the pointer" comes before
  the fit. Shift-up only on placement (open, another node, the node moving);
  after a content change the top holds and the extra scrolls.
- **Two content-fit fixtures got smaller** so they still test what they
  meant to under the lower cap: the top-anchored grow adds 50 px, not 100,
  and the rigid-wins test grows to 340 px of body, not 400.

### Round 2 live check (1440 wide, isolated backend 8968, Vite 5968, no provider calls, Run never clicked)

- Style Reference at 1440x900: top 186, bottom 717, 531 px (body fits).
  After an upload: springs to 568 px, top still 185.56, bottom 754 (12 px
  above the band at 766, 74 px above the bar), the file row stays at 346.9,
  and the body scrolls (453 of 602).
- Style Reference at 1440x700: top 154, bottom 554, 400 px, 12 px clear of
  the toolbar and of the band (566), body scrolls (285 of 416).
- Node near the bottom (node 784 to 840): shifted up to 223 to 754, 531 px.
  After an upload: top, bottom and file row unchanged (no spring), the body
  scrolls (416 of 602).
- No request left the lane.

## Round 3 (review 1, GM r82)

- **The open lasts until its content is stable (MEDIUM-1).** From the
  panel's mount, until every `img` in it is `complete` and its measured
  height has then held for 2 frames (`OPEN_STABLE_FRAMES`), capped at 300 ms
  (`OPEN_SETTLE_CAP_MS`), a content change is placement: no held top, so a
  low node shifts up. A settle that moves it runs on the same top-anchored
  layout spring, never a jump. After the open, a change holds the top as
  before (r72). Any step may restart the stable count; only a frame (the rAF
  tick) adds to it, so the before-paint re-measure can't end an open early.
- **The preview has its height before it decodes (the real fix).** Nothing
  stored the dimensions, so `POST /api/uploads` now reads them from the
  image's header with Pillow (`backend/services/preview_size.py`; EXIF
  orientations 5-8 swap width and height, as the browser shows it; Round 3
  said "no pixels decoded", which was wrong for PNG until Round 4). It returns them as `previewSize`, and a node it creates
  (canvas drop, `nebula upload`, MCP `upload_file`) holds them as the private
  param `_previewSize` next to `_previewUrl`. The Inspector's own upload
  stores the same param from the response, and drops the last file's size
  when the new one has none (an animated GIF, an unreadable header). The
  preview `<img>` gets `width`/`height` (`lib/previewSize.ts` validates the
  stored value) and the CSS adds `height: auto`, so the browser lays it out
  at the stored ratio before it loads; once loaded its own ratio wins, so a
  stale size can't distort it. It is a private layout param: agents can't
  write it, like every `_` param (`agent_params.internal_keys`), and it
  isn't shown to them (node params they read leave `_` keys out, and the
  `nebula upload` / MCP `upload_file` answer doesn't carry it). Agents don't
  need it. Their uploads store it the same way the canvas's do. (Corrected
  in Round 4: this said agents read it.) Saved nodes from before have no size and fall back to the
  settle window.
- **A window resize re-places (LOW-1).** A viewport size change drops the
  held top. If a top was held, or a glide is already running, the change
  runs on the spring and the spring is kept on for each further resize
  frame, so the glide follows the resize live. With nothing held, a resize
  still moves the panel at once, as before.
- **Card growth under or over the node springs (NIT-2).** The node card's
  size is tracked apart from its position. When it changes without a move
  and the panel's top or height changes (only possible under or over the
  node, including a flip), the change springs.
- **A reopen starts afresh (LOW-2).** Closing (or another node, or a pin
  toggle) now also ends a running spring, in the open effect's cleanup, so
  an attribute left on from the last open can't carry into the next one.
- **Tests (LOW-2, LOW-3, LOW-4).** `NodeInspectorContentFit.test.tsx` (40):
  a content change 1 and 2 frames after opening a low node shifts it up on
  the spring; images gate the open; an image that never loads stops placing
  at 300 ms; two opens give 154-754 both times; another node is a new open;
  a reopen starts afresh; the resize glide; the old survivors (body padding
  via a stubbed `getComputedStyle`, move plus content change in one frame,
  no spring when the height doesn't change, the held top clamped under a
  taller toolbar, the 300 px floor on a held top, under-the-node never
  holds, `CONTENT_RESIZE_MS` against the CSS spring's 360 ms); card growth
  and a flip on the spring. `InspectorPaletteRows.test.tsx` renders the
  real Inspector in the popover again: its palette sits in the measured box,
  and Add on the real control grows the panel on the spring with the top
  held. `Inspector.fileUpload.test.tsx`: the stored size, the dropped stale
  size, broken values, and `height: auto`. Backend: sizes in the response
  and on a created node, EXIF turns, none for sound or documents or an
  unreadable header, and agents can't write it.
- **NIT-1.** The orphaned "Where the floating Inspector opens" docblock is
  folded into `measurePopoverFrame`'s, and the `panels.css` spring comment
  now says when the top moves (r72, r82).
- **Mutations.** Frontend 24 of 25 killed. The survivor (not clearing the
  stored need on close) is equivalent now: the frame is cleared on close,
  and the first step of an open measures no need. Backend 4 of 5 killed;
  the survivor (reading a size for every upload kind) is equivalent, since
  Pillow reads no size from sound or documents.

### Round 3 live check (1440 wide, isolated backend 8968, Vite 5968, no provider calls, Run never clicked)

- Style Reference, node at 784 (zoom 400%, the card runs past the bottom).
  Empty, first open after a page load: placed at 223 to 754 (531 px). The
  first-load late layout (about 10 px) lands during the open and settles on
  the spring, top and height together, with no scroll left.
- Upload through the Inspector (a 1200x900 PNG): `_previewSize` stored as
  1200x900, and the `<img>` carries those attributes. The open had ended, so
  the top held at 223 and the body scrolls (r72).
- Cache off, page reloaded, first open: 154 to 754 (600 px) from the first
  painted frame, no spring; the body scrolls 117 px (602 px of content in
  a 485 px viewport). Second open:
  the same, 154 to 754.
- With the stored size removed, cache off: also 154 to 754 on frame one
  (the local image arrived before the first measure), so the settle
  backstop wasn't exercised live; the unit tests cover it.
- Resize 900 to 700 to 900 in 20 px steps, nothing held: the panel follows
  at once, 600 to 400 (154 to 554, band 566) and back to 600.
- Held top, then a resize: collapsing the preview holds the top (154 to
  685, 531 px). At 700 it is placed afresh on the spring: 154 to 554
  (400 px). Back at 900, with nothing held any more: 223 to 754 (531 px),
  placed afresh at once.
- Blocked log: canary lines only. No request left the lane.


## Round 4 (review 2, GM r87)

- **The foot row's hairline (MEDIUM-1, GM r87 cue (b)).** While the body can
  scroll further down (ScrollFade's `data-scroll-more`), the foot row's top
  edge shows a 1 px line in the Restraint border token (`--sr-edge`, the
  panel's own edge), drawn as the foot's `::before` in
  `slava-restraint.css`. It is gone at the end of the scroll. It comes on
  `SPRING_POP` and goes on `SPRING_SOFT` (`lib/springs.ts`, sampled to
  `linear()`; the vars sit on the foot, `FOOT_SPRINGS`), and reduced motion
  jumps. The 12 px fade stays. It reads the scroll position only, so it
  shows wherever the cut falls, including between fields (the 1440x900 and
  1440x820 low Style Reference cases, where the fade alone changed 291 and
  0 px).
- **No pixel decode for the preview size (MEDIUM-2).** `preview_size` no
  longer calls `getexif()`, which loads a PNG whose EXIF isn't ahead of
  its pixel data. It parses the EXIF block the header already holds
  (`image.info["exif"]`: JPEG APP1, WebP EXIF, a PNG eXIf before IDAT) with
  `Image.Exif().load()`. A size over `Image.MAX_IMAGE_PIXELS` is not
  reported (Image.open only refuses twice that). The upload route runs it
  in `asyncio.to_thread`. Measured on a 9000x9000 PNG (258 KB): peak RSS
  went from 15 to 327 MB with the old call, and from 16 to 18 MB now.
- **Closing clears the frame (LOW-2).** The frame state is set to null in
  the render where the panel is closed (not in an effect, which the
  `set-state-in-effect` lint rule refuses), so a reopen never paints the
  last open's frame, and a node with no card on screen shows nothing.
- **A stale `_previewSize` is dropped (NIT-2).** The size belongs to the
  file it was read from. `_normalize_image_input_params` drops it when the
  preview now names another file (an import from outside the output root)
  or none. A merge that names another file through `PUT /api/graph/node`
  or `/api/graph/apply` without sending a size drops it too
  (`_drop_preview_size_on_file_change`). The Inspector's own upload sends
  the new size with the file, and a file without one (the Inspector deletes
  it locally, so nothing is sent) now loses the old size on the backend too.
- **Docs (NIT-1).** `_previewSize` is a private layout param: agents can't
  write it and it isn't shown to them. The Round 3 text above, the module
  docstring and the PR body are corrected.
- **Survivors pinned (LOW-1).** A zoom (the card moves and grows in one
  frame) and a resize in the same frame as a move both stay rigid. EXIF
  orientations 1-8, a bomb header, a broken EXIF block, the pixel ceiling
  and the worker thread each have a test.
- **Mutations.** Frontend 14 of 14 killed. Backend 18 of 20 killed; the two
  survivors are equivalent: the `<= 0` guard (Pillow refuses a zero width
  or height at open, checked for PNG, GIF and BMP), and the Image Input
  check in the drop helper (no other node type gets `_previewSize`).

### Round 4 live check (isolated backend 8968, Vite 5968, no provider calls, Run never clicked)

- Style Reference with an uploaded image, node at 784. 1440x900: 154 to
  754, 117 px left to scroll, the cut just under the "Strength" label, its
  slider (687 to 721) under it. Hairline opacity 1, `rgba(255, 255, 255, 0.06)`, 1 px,
  across the foot. 40 px down: still 1. At the end: 0, and it eased out
  over about 26 frames (1, 0.95, 0.84, ... 0); back at the top it eased in
  (0, 0.03, 0.10, ... 1). Reduced motion: 1 to 0 and back in one frame.
- 1440x820: 154 to 674, 197 px left, the cut in the gap between fields.
  Hairline 1; at the end 0.
- Blocked log: canary lines only. The page's own canary requests were all
  blocked.


## Round 5 (review 3, GM r92)

- **A preview landing is growth, not a move (MEDIUM-1, GM r92 Q1).** A move
  is now read from the React Flow node's own box (its rect's left/top) and
  the canvas's transform (`.react-flow__viewport`), not from the card
  (`nodePlace` in `NodeInspectorPopover.tsx`). When an Image Input's preview
  lands, the node's top padding grows, so the card's top moves 36.6 px inside
  a node that hasn't moved. A change in the card's size or in its offset
  inside the node is growth: beside the node, the top is held (as for a
  content change), and the height springs. Under or over the node, the panel
  still follows the card on the spring and holds no top (r82). A drag, an
  agent move, an undo, a pan or a zoom (even one about the node's own corner,
  through the transform) all still re-place the panel at once, and so does a
  window resize. A node with no React Flow box falls back to reading its card.
- **The hairline waits for the open to settle (LOW-1, GM r92 Q3).** While the
  open hasn't settled (every image complete, then 2 stable frames, 300 ms at
  most), the popover carries `data-opening`, and the line's rule requires
  `:not([data-opening])`. After that, it shows on the pop spring if there is
  more to scroll. The open is tracked in state (`settledFor`), and it is
  reset while rendering when the panel closes or another node opens.
  **Beyond the brief:** the rule also requires `:not([data-content-resizing])`.
  Live, the empty Style Reference's overflow didn't come from the open's
  layout. It came from the open's own layout spring: the panel springs from
  521 to 531 px for the content's late 10 px, and the body overflows by the
  spring's lag for about 10 frames. The open had already settled after
  2 frames, because the height it needs held. Without that second condition
  the line still rose to 0.57. A growth spring that ends with more below now
  shows the line once the spring stops.
- **The pinned Inspector keeps the hairline (NIT-1, GM r92 Q2).** It waits for
  the same open (the content's own height counts as stable there). A test pins
  it, and a source test checks that no foot rule names `pinned`.
- **Backend survivors pinned (LOW-2).**
  - B3: a CLI PUT of `_previewUrl` alone drops the size.
  - B4: the PUT's own save is checked by reloading the persisted graph.
  - B5: the normalizer keeps the size for the served URL, the file under the
    current root and the same file under a moved root.
  - These tests run with `OUTPUT_ROOT` set to the test's temp folder. Otherwise
    the canvas sync's normalizer imports the outside-root upload, and its own
    save and preview hide the rule under test.
- **The preview follows the file (NIT-2).** `_drop_preview_size_on_file_change`
  is now `_preview_follows_file`. When an agent or the CLI names another
  `filePath` without a `_previewUrl`, the preview becomes the new file's
  served URL. If the file isn't under the output root, the preview is removed,
  and the canvas sync's normalizer imports the file and gives it one. Clearing
  the file clears the preview. The Inspector's own upload still sends its URL
  and size, and they are kept as sent.

### Round 5 live check (isolated backend 8968, Vite 5968, Run never clicked)

- Image Input upload from the Inspector, with the pointer on the file row:
  - 1440x1000 and 1440x900 behave the same way. The node stays at 158.1 while
    the card goes from 200.0+75.5 to 235.3+221.6.
  - The panel top holds at 192 in every frame (90 frames).
  - The height springs from 300 to 486: 310.8, 329.7, ... 488.6 (overshoot),
    486.
  - The file row stays at 308, and the pointer is over it in every frame.
- Empty Style Reference, first and second open: 10 frames with
  `data-scroll-more`, and the line's opacity is 0 in every frame.
- Long body (Topaz Generative Enhance, 20 fields):
  - `data-opening` is set for the first 2 frames, with the line at 0.
  - The line then rises on the pop spring from frame 4 and rests at 1.
  - The panel spans 154 to 754 at 1440x900 and 154 to 854 at 1440x1000.
- Blocked log: canary lines only.
- Gates: tsc and lint pass. vitest on 126 listed files: 3918 passed.
  `land_checks.sh` passes, with pytest at 1178 passed and 1 skipped (30 files).
  `person_gate.py` is unchanged. Build budget: 471,068 bytes raw (cap 512,000).
- Mutation check: frontend 14 of 14 killed (11 in the component, 3 in the
  CSS); backend 8 of 8 killed.

## Round 5b (GM r98)

- **The hairline holds its state through a height spring.** Round 5 hid the
  line with CSS while `data-content-resizing` was set. GM r98 replaces that
  with a hold. `NodeInspectorPopover.tsx` now decides when the line shows and
  marks the foot with `data-more-below`, which the CSS draws. No rule hides it
  on the popover's open or spring marks, and a source test checks this.
  - During the open, the line is off.
  - When a spring starts, the line's current state is latched
    (`lineHeldRef`), so a line that's on stays on and a line that's off stays
    off.
  - When the spring rests (the `CONTENT_RESIZE_MS` timer), the latch is
    released and the body is read again. The line then goes to the new state
    on the pop or soft spring.
  - A move that ends a spring (rigid wins) releases the latch at once.
  - Each step runs its spring decision first and updates the line after, so
    a spring that starts in a frame latches the line from before that frame.
  - The body is read with `hasMoreBelow` (`lib/scrollMore.ts`), the formula
    ScrollFade's fade also uses (moved out so ScrollFade.tsx exports only
    components).
  - The open still starts off and stays off: a spring that starts during the
    open latches "off".
  - A newly selected node resets the line while rendering, so it never shows
    the last node's line for a frame.
- **Where it can matter.** With the window size fixed, an image landing under
  a body that already scrolls doesn't spring at all. The panel is already as
  tall as its room, and the top is held, so its box doesn't change (live
  case D below). The hold applies to the springs that do run with the line
  on: a window resize's glide of a held top, and a shrink to fit (a file
  cleared, "No preview" collapsing). In the shrink, the body stops
  overflowing on the spring's first frame, so a line read live would go
  early. The jsdom tests model GM's case as a shrink and then a growth in one
  spring: the "No preview" row goes and the image lands mid-spring. The line
  stays 1 throughout and ends at the rest state.
- **Equivalent mutant removed.** Round 5b first latched with `??=` so a
  restarted spring would keep the first spring's state. Mid-spring, the line
  already shows the held state, so plain `=` does the same. It is now `=`.

### Round 5b live check (isolated backend 8968, Vite 5968, Run never clicked)

Frames were sampled with `getComputedStyle(foot, '::before').opacity` on
every animation frame, on an empty Style Reference beside its node at
y 160.

| Case | Result |
|---|---|
| D. 1440x800, body scrolled 12 px (line on), image lands | 91 frames, no spring (already at the cap, top held), line 1 in every frame, 205 px below at the end |
| E. 1440x850, line off, image lands | 24 spring frames (531 to 550 px) with more below and the line at 0 in each, then it pops to 1 at rest |
| F. Same panel scrolled 12 px (line on), window to 830 | The held top's glide (550 to 530 px), 24 spring frames, line 1 in each, still 1 at rest |
| G. 1440x850 scrolled 12 px (line on), file cleared | 24 spring frames (550 to 531 px), nothing below from the first one, line held at 1. At rest it goes on the soft spring (0.95, 0.84 ... 0) |

- The blocked log has canary lines only. Every off-lane request in the page
  was blocked.

### Round 5b gates

- `tsc -b --noEmit` and lint pass.
- `pr_tests.sh`: 118 files, 3930 tests passed.
- `land_checks.sh` (with `tests/test_upload_drop_files.py`): tsc and the
  ratchets (161) pass. pytest on 30 files: 1178 passed, 1 skipped.
  `person_gate.py` is unchanged.
- The build passes the budget: 471,093 bytes raw (cap 512,000), 146,511
  gzip.
- Mutation check: 14 of 14 killed (12 in the component, 2 in the CSS). The
  restart mutant was equivalent, and the code now uses `=`.

## Round 6 (review 4, GM r104)

- **The panel's left edge follows a widening card on the layout spring (review 4 MEDIUM-1, GM r104 option a).**
  `left` joins `height` and `top` in the `[data-content-resizing]` transition
  (panels.css). A change of `left` now counts as a shift that starts the
  spring, as `top` and `height` already did. Without that, a card that widens
  with no height change would still move the panel in one frame.
  - Right placement: the panel keeps its 10 px gap, and its left edge follows
    the card's right edge, on the same spring and timing as the height.
  - Left placement: the card's left edge doesn't move, so the panel holds.
  - A real move, pan or zoom is still rigid, because the attribute is cleared
    on a move.
  - A window-resize re-place (r82) that lands mid-spring takes over the spring.
    A flip to the left also springs sideways. The pinned panel never springs.
- **Seen live (worth GM's eye):** the card widens in one frame (52 px at 130 %
  zoom). The panel's edge then catches up over about 22 frames, so mid-spring
  the card runs under the panel's left edge. This is inherent to option (a).
  Option (b) would hold the panel's left edge instead.
- **The preview follows the file, not its name (review 4 LOW-1).**
  - `_preview_follows_file` now compares refs with `_same_ref_file`, not by
    basename. Refs under the output root compare by their root-relative path:
    a served URL (with or without the backend's origin), a path under the
    root, or a path under a root the outputs moved from. Other refs compare by
    the file they resolve to.
  - The name is the fallback only when the old ref no longer resolves to
    anything.
  - The normalizer's `_drop_stale_preview_size` still compares names. There,
    before and after differ only by normalization, or by an import to a
    digest name.
- **Reduced motion (review 4 NIT-1):** `startSpring` returns before it latches
  anything when `prefers-reduced-motion: reduce` matches, and it ends any spring
  still running. The panel jumps (panels.css), so the line reads the body in
  the same frame.
- **The Image Input guard is pinned (review 4 NIT-2).** Audio and Document
  Input `filePath` writes are left as sent: no `_previewUrl` appears, and
  their `_previewSize` stays.

### Round 6 live check (isolated backend 8968, Vite 5968, Run never clicked)

1440x1000, Image Input at 500,200 (canvas zoom 130 %), panel on the right, ref.png uploaded from the Inspector's file control. Per-frame records are in `scratchpad/pr226r6/live-frames.json`.

| Case | Result |
|---|---|
| A. Right placement | Left 770.7 → 822.8 (card right 760.7 → 812.8) over 22 spring frames. The largest step is 7.3 px per frame, against a 52.1 px jump before. Top held at 192, file row y 308 in every frame, height 300 → 488.6 → 486. At rest the gap is 10 px. |
| B. Left placement (node at 1150,200) | Left 880 in every frame. Top 192. The height springs the same way. |
| C. Reduced motion, low node | No `data-content-resizing` frame. The line comes on in the same frame as the jump. |

### Round 6 gates

- `tsc -b --noEmit` and lint pass.
- The 9 Inspector and popover files pass: 159 tests.
- `pr_tests.sh`: 118 files, 3938 passed.
- `land_checks.sh` (with `tests/test_upload_drop_files.py`): tsc and the
  ratchets (161) pass. pytest on 30 files: 1185 passed, 1 skipped.
  `person_gate.py` is unchanged. `test_upload_drop_files.py` alone: 82 passed.
- Build and budget pass: 471,093 bytes raw (cap 512,000), 146,505 gzip.
- Mutation check: 12 of 12 killed (6 frontend, 6 backend).

## Round 6b (GM r107)

Round 6 sprang the panel's edge, but the card still widened in one frame, so
mid-spring the panel covered the card's right edge, its id label and its
output port. Now the card springs too, and the panel follows it.

- **The card's width springs (r107 item 1).** `lib/cardWidthSpring.ts`
  (`useCardWidthSpring`, on the card in ModelNode and DynamicNode). A
  ResizeObserver reads the card's own layout width, so a move, pan or zoom
  never counts as a change. When the width changes from the card's content,
  it runs a Web Animation from the old width to the new one. It uses the
  layout spring (`LAYOUT_SPRING_MS`, `LAYOUT_SPRING_EASING`, which a test
  keeps equal to panels.css's `--inspector-layout-spring`). The animation
  starts in the observer's callback, after layout and before paint, so the
  card is never painted at its new width first. While the spring runs, the
  card carries `data-width-spring`. Under reduced motion the card jumps, and
  so does the panel.
- **The panel follows the card's edge every frame (items 1, 3).** While the
  card it is anchored to carries `data-width-spring`, the panel's
  once-a-frame step commits with `flushSync`. That step runs in
  requestAnimationFrame, before that frame's layout and paint, so the panel's
  edge is where the card's edge is on screen, never a frame behind. The panel
  then carries `data-follows-card`, and panels.css leaves only its height on
  the spring. The panel follows through the frame the card's spring ends in,
  where the card lands from the spring's last overshoot. Only a frame lets go
  of the follow: the re-measure straight after a commit is the same frame.
  Without that last frame, the panel springs its last 0.1 px on its own.
- **No panel jump comes back (item 3).** A card that jumps (no spring on it)
  still moves the panel on the round 6 spring.
- **Preview and port (item 2).** The preview is `width: 100%; height: auto`,
  so it scales with the card and keeps its ratio. Live, it held 1.333 in
  every frame. The port sits on the card's edge. React Flow measures the node
  on each size change, so the wire follows.
- **One frame of wire lag, fixed (found live).** React Flow's own
  ResizeObserver reports before the card's. It has already measured the card
  at its new width by the time the card's spring puts it back at the old
  width. An observer reports a shallower element only once a frame, so React
  Flow would hear of that only in the next frame. For that one frame the wire
  ended 47 px to the right of the port. `useNodeRemeasure` makes the card's
  spring call React Flow's `updateNodeInternals` for the node, forced, as the
  spring starts. The node is then measured at the width the spring starts
  from. `useUpdateNodeInternals` waits a frame, so it doesn't help here.

### Round 6b tests

- `tests/lib/cardWidthSpring.test.tsx` (9 tests):
  - the spring is panels.css's;
  - a 200 → 240 change springs from old to new, marked while it runs, and its own frames start nothing more;
  - a later change springs from where it rested, and shrinking springs too;
  - a first look or a sub-pixel change starts no spring;
  - reduced motion jumps;
  - unmounting mid-spring cancels the spring;
  - `onStart` runs in the same callback, with the spring already on;
  - `useNodeRemeasure` measures the card's React Flow node at once, forced, and does nothing outside a node.
- `NodeInspectorContentFit.test.tsx`, "the card springs its width and the
  panel follows its edge, the gap held every frame (GM r107)". It plays the
  browser frame by frame: time, the step (rAF), the ResizeObserver feeding
  the card's real hook, then the paint (the card at its spring's width, the
  panel by panels.css's transitions).
  - Right placement, with and without the body growing: on every frame,
    `|panel left - card right - 10| <= 1`. While following, the panel's left
    is committed inside the frame's callback. The x/y step ratchet holds. At
    rest the gap is 10, the top stays 192 and the file row is unmoved.
  - Left placement: left stays 830 in every frame.
- The CSS tests name the follow rule, which springs the height only. The
  reduced-motion block names it too, because it is more specific than the
  base rule.

### Round 6b live check (isolated backend 8968, Vite 5968, Run never clicked)

1440x1000, Image Input n1 at 500,200 (zoom 130 %), wired to an Image Compare,
panel on the right, ref.png uploaded from the Inspector. Each record is read
in a ResizeObserver made after the app's own observers, so it shows the frame
as it is painted.

| | Result |
|---|---|
| Card right / panel left | 760.7 / 770.7 → 812.8 / 822.8 over 22 spring frames (peak 813.6 / 823.6). Gap 9.98 to 10.00 in every frame. |
| Steps | Largest per frame: card 7.25 px, panel 7.26 px. Top 192 in every frame. |
| Port, wire | Port centre at card right + 18.25 in every frame. The wire's end sits 5.21 px left of the port centre at the same y in every frame. |
| Preview | Ratio 1.333 in every frame (ref.png is 1200x900). |
| Left placement (n3 at 1150,200) | Card springs (23 frames). Panel left 880 in every frame. |
| Reduced motion | No spring or follow frame. Card, panel and wire jump together in one frame, gap 9.99. |

Seen, not changed: at rest, the output port's handle box (card right + 5 to
+31) sits mostly under the panel, whose edge is at card right + 10. Only part
of the port's dot shows beside the panel. This was already true before 6b
(the same numbers are in round 6's records). Fixing it means widening the
10 px gap, which r104 approved.

### Round 6b gates

- `tsc -b --noEmit` and lint pass.
- The 9 Inspector and popover files: 162 passed. `cardWidthSpring.test.tsx`: 9 passed. The 16 test files that render ModelNode or DynamicNode: 284 passed.
- `pr_tests.sh`: 119 files, 3950 passed. It takes committed test files only, so the new hook test ran on its own, above.
- `land_checks.sh` (with `tests/test_upload_drop_files.py`): tsc and the ratchets (161) pass. pytest on 77 files: 2803 passed, 1 skipped. `person_gate.py` is unchanged.
- Build and budget pass: 472,331 bytes raw (cap 512,000), 147,026 gzip. That is 1,238 bytes over round 6.
- Mutation check: 13 of 13 killed. The mutants: the card jumps; no flushSync; the follow CSS rule removed; the finish frame not followed; the re-measure ends the follow; the card's own frames restart its spring; reduced motion springs; a sub-pixel change springs; onStart is dropped; the re-measure is not forced; the popover ignores the springing card; the reduced-motion line misses the follow rule; the spring constants drift from panels.css.

## Round 6c (GM r111)

The panel now stands clear of the facing port. A port is a drag source, so it can't sit under the panel.

- **The rule.** The panel's edge sits 8 px clear of the outer edge of the facing port's dot. Placed right, that is the node's outputs; placed left, its inputs. With no port on that side, the gap stays 10 px from the card. With several ports, the outermost one counts. The panel never comes nearer the card than 10 px, even when far zoomed out, where a dot sits inside that gap.
- **How the dot is measured** (`lib/facingPort.ts`). The handle's screen box gives the dot's centre and the zoom (screen width over layout width). The skin then gives the dot's own size: the ::before's width (9 px) and `--sr-handle-rest-offset` (drawn 4 px toward the card). These are layout values, not the dot's transform, so a hover moves nothing. A handle with no drawn dot counts as its whole box.
- **Every placement path uses it.** The open, a held top, a window resize's re-place and the follow of a springing card all go through `measurePopoverFrame`. The side is chosen with the port counted. The pinned Inspector docks by the rail and never stands beside a card, so the rule doesn't apply to it.
- **Found live: the port steps out a frame before the card springs.** As the preview lands, the Image Input's card drops its 1 px border, so its output port steps 1 CSS px (1.3 px at 130 %) out from the card's edge. That happens one frame before the card's width spring starts. The panel's left then sprang after it, and for two frames it stood 6.7 px from the dot. Now a port that shifts against a node that hasn't moved is followed in the same frame, by the same path as a springing card (flushSync in the frame, `data-follows-card`). If the card's width changes in the same frame and it wasn't already springing, neither the port follow nor 6b's one-frame carry-over commits: the card's spring starts after the step, from its old width. The panel springs that one frame and follows the card from the next.
- **CI fix (6b broke CI parts 1 and 3).** `useNodeRemeasure` called React Flow's `useStoreApi`, which throws outside a ReactFlowProvider. So every test that renders a node card on its own failed (16 files, 175 tests). Now `Canvas.tsx` gives its nodes the remeasure through `NodeRemeasureContext` (`useFlowNodeRemeasure`, inside the provider). A card outside a canvas reads no context, renders as it did before 6b, and measures nothing. No test was wrapped in a provider to hide this.

### Round 6c tests
- `NodeInspectorPlacement`, "the gap to the facing port (GM r111)", 16 tests:
  - right with an output port, and left with an input port, each at zoom 0.5, 1 and 2;
  - right with no output port, and left with no input port (10 px);
  - several ports (the outermost counts); a hidden port doesn't count; a handle with no dot counts as its box;
  - the 10 px floor; the side is chosen with the port counted;
  - a window resize re-places by the rule; a zoom re-places at once;
  - pinned is unchanged.
- `NodeInspectorContentFit`, GM r107's frame-by-frame ratchet, now with ports:
  - right with an output port: `|panel left - dot outer - 8| <= 1` on every frame of the card's spring;
  - left with an input port: 8 px from the input's dot on every frame;
  - the port stepping 1 px out (the card still; with the card springing in the same frame; with the card springing a frame later, as live): 8 px every frame.
- `cardWidthSpring.test.tsx`: the remeasure tests run on a canvas (`OnCanvas`). New: a card drawn outside a canvas renders, and its spring measures nothing.
- `tests/helpers/houseDots.ts` gives jsdom's handles the skin's dot.

### Round 6c mutation check

19 of 19 killed. The mutants:
- the output port ignored; the input port ignored;
- the dot not read (handle box only); the zoom ignored; the rest offset ignored;
- the innermost port, not the outermost; hidden ports counted;
- no 10 px floor; the side chosen without the port; a clearance of 10, not 8; the wrong side's handles;
- a port shift not followed; a port shift followed in a fresh-widen frame; the follow carried into a fresh-widen frame; a fresh widen counted mid-spring;
- the card needing the React Flow store again (the CI break); the remeasure context ignored; the remeasure not forced; the popover ignoring the springing card.

### Round 6c gates
- `tsc` and lint pass.
- The 9 Inspector and popover files: 183 passed. `cardWidthSpring.test.tsx`: 10 passed.
- Every test file that names ModelNode, DynamicNode, cardWidthSpring or NodeInspectorPopover (59 files, found by grep): 1541 passed.
- `pr_tests.sh`: 175 files, 4674 passed.
- `land_checks.sh`: ratchets 161; pytest on 77 files, 2803 passed and 1 skipped.
- Build and budget pass: 472,506 bytes raw (cap 512,000), 147,118 gzip. That is 175 bytes over 6b.

### Round 6c live check

(1440x1000, isolated backend 8968, Vite 5968, Run never clicked, Image Input wired to an Image Compare, zoom 130 %). The dot's edge is read independently of the app, from the ::before's computed left, width and transform:

| Case | Result |
|---|---|
| Right placement, output port, ref.png uploaded | Panel left minus the output dot's outer edge: 7.98 to 8.00 px in all 103 recorded frames, 21 of them spring frames. At rest the dot is 18.9 px out from the card, and the panel is 26.9 px from the card. |
| Left placement, Image Input (no input port) | The card springs (23 frames). The card's left minus the panel's right is 10 in every frame. |
| Left placement, Image Compare (input ports) | The input dot's outer edge minus the panel's right: 8.01 in every frame (24 frames). |
| Port and wire, preview | As in 6b: the wire's end is 5.21 px from the port centre in every frame, and the preview ratio is 1.333. |
