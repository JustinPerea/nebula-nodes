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
