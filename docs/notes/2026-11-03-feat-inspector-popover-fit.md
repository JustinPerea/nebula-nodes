# feat/inspector-popover-fit

GM r68 (2026-11-03): the unpinned Inspector beside a node grows to fit its
content. Frontend only. Nothing in `Inspector.tsx` changed.

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
