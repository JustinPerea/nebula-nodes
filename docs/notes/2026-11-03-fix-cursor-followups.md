# fix/cursor-followups (2026-11-03)

Follow-ups to the agent cursor column work (#211): two rule changes from design
review, plus the low findings and nits from review 9. Round 2 (#219 review 1,
GM - Design r24) replaced the first version of both rules; this note describes
the round 2 rules.

## 1. Column order: a stable insert, never above its own target

`deStackLayout` (`frontend/src/lib/agentCursorLook.ts`) lays out each final
column like this:

- **Which cursors are full.** With more than 3 members, the two earliest
  arrivals are full and the third arrival is the count. Folding is by latest
  arrival, as before.
- **Their order, a stable insert (r24 Q1).** In arrival order, each full
  cursor goes in just before the first one already placed that aims more than
  16 canvas units below it, or last if there is none. Cursors aimed within 16
  of each other keep arrival order, so fuzz never reorders them. The 16 was
  screen px until round 3c; it is canvas units now, like the target chain
  (r62), so the two agree at any zoom. Joins and steps stay screen px.
- **Their slots.** The top one sits on its own target. Each next one sits at
  `max(the one above + its real step, its own target)`. So no cursor is above
  its target (r23 item 1), and none is more than 2 steps + 32 px below it.
- **The count** sits exactly one step under the last full cursor, with no gap.
- **The x.** The column is drawn at its earliest arrival's x. Its id
  (`StackSpot.column`) is still that arrival's key, though that cursor is no
  longer always on top.

The first version kept the earliest arrival on top. Review 1 found it pulling
later members up to 318.8 px below their targets (the mirror of review 9's
bug). Its property test hid this: its "gap" counted the head's own offset.

**Property tests** (`expectColumnsCapped`). They work from the drawn spots
alone, for every final column:

- every member is at the column's x;
- the full cursors are in insert order, each exactly at the rule's slot;
- none is above its target, or more than the real steps above it + 32 px
  below it;
- the count sits exactly a step under the last full cursor.

Because the slot is checked exactly, a cursor "at its target" can't pass as
"a step under it" (review 1, LOW-3). The suite runs this over review 8's fuzz,
review 9's fuzz (seed 9911) and review 1's fuzz (seed 424242, 20,000 sets).
`CURSOR_FUZZ_STATS=1` prints that last fuzz's stats:

- 58,373 full cursors, 40,746 of them on their target;
- worst offset 145.65 px below a target, which is 2 × 65 + 15.65;
- worst offset beyond the steps above: 16.0 px, within the 32 px bound;
- 8,002 columns where a later arrival went in above an earlier one.

Each of these variants of the layout fails all three property tests:

- the 1df7094b rule;
- no insert;
- the count with the old gap formula;
- a pushed member put at its target plus a step;
- a member put at its own x.

`expectColumnsJustified` still catches over-merging.

**The first-pass shape-meet join is not redundant.** With it removed, 739 of
50,000 random sets lay out differently. It stays, pinned by an example.

## 2. A carry is an arrival only when it changes the target chain

A cursor's **target chain** is the other cursors linked to it through targets
16 canvas units apart, at zoom 1, from targets alone (GM - Design r24 Q2).
When a node move changes a carried cursor's chain, the backend gives that
cursor a new arrival. A node moving with all its cursors keeps their places,
however far it goes.

- **Backend.** `AgentPresence.carry_nodes(positions)` runs on every graph
  sync, called from `main._carry_cursors` at the end of
  `_broadcast_graph_sync`.
  - It stores the node positions, and compares each cursor's chain at the old
    positions with its chain at the new ones.
  - It sends `agentPresenceArrival` to person tabs only (`broadcast_browser`).
  - A node target counts as the tab's point for it: the header's middle, 44
    down (`resolveAnchor`), sized from the browser's view report. A handle
    counts as its node's header point, on both sides (round 3c, r62: the tab
    draws it on the port, but its chain point is `chainPoint`).
  - A replaced graph forgets the positions (`forget_graph`, in the same
    sync). A cleared graph has no nodes to compare.
  - The positions are read from `cli_graph` when the carry runs, not from the
    sync's export, so overlapping syncs can't hand it an older graph.
- **Every route.** `update_positions` has three callers: the layout route
  (drag, arrange, `nebula move`), `apply_graph_edit` (`nebula apply`,
  edit_canvas) and `_restore_graph` (undo/redo). Each one syncs, so each one
  carries. Review 1 found that before, apply and undo/redo never carried, so a
  live tab and a reload disagreed. Each route has a test. Another test pins
  the hook's one call site and the list of callers.
- **No running total.** The old running total of carried distance is gone, and
  with it the stale-total bug: drag +10, undo, drag +10 used to make an
  arrival.
- **The tab** never decides arrival on a carry.
  - The tab's own path is gone: `arrivesNow`, its carry anchor, the +0.5,
    `AGENT_CURSOR_ARRIVAL_RADIUS`.
  - A carried cursor keeps its place until `agentPresenceArrival` changes its
    rank.
  - Joins (16 screen px, arrow and label overlaps) stay the tab's. The chain
    decides arrival only.
  - The tab previews a carry instead (round 3, below).

## 2b. The carry preview (round 3, GM - Design r47 Q1)

While a node moves, the tab runs the same chain test on the live positions.
That means the person's drag, or any carry it sees.

- **The preview.** A carried cursor whose chain would change is laid out as
  the newest arrival (r24 insert) in the column it is passing: a display-only
  arrival after every landed cursor, plus its own `since`. That isn't the
  literal bottom slot: the insert puts it above a member aimed more than 16
  below its target, which is what the backend does at the drop, so nothing
  moves there (GM r52). So two cursors on one node keep their order (rule
  101). When the chain is back to the one it had (dragged back), the cursor
  is back in its old slot.
  - `CursorField.carriedFrom` holds each carried cursor's target from before
    the carry; `previewed()` compares the two chains in `layout()`.
  - Only a real node move counts. A node measured or resized is no carry
    (the r4i rule, back in `report`).
- **The tab never writes or decides arrival.** At the drop, the backend's
  `agentPresenceArrival` governs and ends the preview. When it agrees (the
  usual case), nothing moves.
  - With no arrival `CARRY_PREVIEW_HOLD_MS` (1.5 s) after the drop, the
    backend disagreed. The preview ends, and the slot glides back on the
    layout spring.
- **One chain definition.** The tab's `targetChains` (agentCursorLook.ts) and
  the backend's `_target_chains` both run the shared fixture
  `backend/tests/fixtures/cursor_chains.json`. It covers exactly 16, 16.01, a
  diagonal 16, transitive chains, a gap that splits a chain, the header
  middle, a short node, and two cursors on one node. The node point is one
  formula on each side: `nodeHeaderPoint`, used by `resolveAnchor`, and
  `_header_point`.
- **Other tabs.** There is no live drag stream: a tab sends node positions
  only at the drop (PUT /api/graph/layout). Other tabs see the move in that
  sync, so the preview runs only in the dragging tab.
- **The overlap band.** On the way in, the dragged cursor's arrow can meet a
  member's label while their targets are still over 16 apart. Round 3b drew
  it at the literal bottom there; round 3c (r62, below) lays it out as the
  newest arrival there too.

## 2c. Copy: an apply's say (r47)

"moved 1" in round 2's shot was Nebula's own text: the apply's summary,
shown on the agent's cursor. The person's tabs now get person copy, built by
`main._edit_say`. Examples: "Moved 1 node", "Moved 3 nodes", "Added 2 nodes
and 1 connection, moved 1 node". It goes in the person form only
(`_show_agent(person_say=...)`), so it also reaches the Agent log and the
replay. Agents still read the summary ("moved 1") word for word, in the reply,
in `publish_action` and in the agent form's `say`.

## 2d. Round 3b: the overlap band (GM - Design r52 Q1; superseded by r62)

Round 3c replaced the literal bottom slot below with the newest arrival's
insert slot (§2e). Kept for the record.

- **Mid-drag.** A carried cursor on a node being dragged that joins a column
  by overlap alone is drawn at the column's bottom. Overlap alone means its
  chain is unchanged but its column has a member it didn't have before the
  carry. `layout()` lays the column out once with each such carry at the
  bottom, compares that with the layout at the pre-carry targets, and keeps
  the bottom slot only for the carries that joined something new. A carry
  that already shared a column with a cursor on another node keeps its slot,
  so a small drag swaps nothing.
- **Why "last" means the bottom here.** A carry coming from above aims more
  than 16 above the members, so the stable insert (r24 Q1) puts it on top
  whatever its arrival is. A later arrival alone wouldn't help. So
  `StackEntry.last` puts it after the inserted members (`deStackLayout`),
  and folding still goes by arrival. While it is set, the carry can sit
  further below its target than the insert allows. That's display only and
  lasts only while the drag does.
- **The drop.** Inside the band the backend counts no arrival (r24), so the
  overlap preview ends at the drop: the drop bumps the layout, and the
  cursor glides once on the layout spring to its arrival-order slot. A chain
  preview still waits for `agentPresenceArrival`, as in round 3.
- **Intended, not a residual (GM r52, r62).** A chain preview is laid out as
  the newest arrival (r24 insert), so a member aimed more than 16 below the
  carry sits under it. That matches the backend's order at the drop, so
  nothing moves there. Since r62 the overlap band does the same. Don't "fix"
  either to the bottom slot.
- **Tests** (`agentCursorLayer.test.tsx`, round 4e block):
  - "a drag through the overlap band into a column keeps the carry last,
    with no flip" checks every frame from 284 down through the band
    (304-327) into the chain: d and e never move, a only goes down, and
    once a is under e it stays under.
  - "a drop inside the overlap band glides once to the backend's arrival
    order" drops at 314 and checks:
    - the glide starts at the drop;
    - no frame steps more than 20 px;
    - a changes direction at most once (the spring's overshoot);
    - a ends at the top with d and e under it;
    - nothing moves through the 1.5 s hold.
- **Mutations.** Each variant below fails the tests listed with it.
  - No overlap preview: both new tests.
  - `last` ignored in `deStackLayout`: both new tests.
  - Last by arrival only, not the bottom: both new tests.
  - Overlap preview kept past the drop: the drop test, and "a carry with no
    backend arrival is no arrival".
  - No relayout at the drop: the drop test.
  - Every dragged carry drawn last, with no join check: "B rides n1 with C
    ... a small drag swaps nothing" and "(0, 19): 2 px clear ...".

## 2e. Round 3c (#219 review 2, GM - Design r62)

- **Handle targets, one chain formula (review 2 MEDIUM).** A cursor on a
  port is drawn on the port, but for the chain it counts as its node's
  header point on both sides: the backend's `_target_point` always did, and
  the tab now feeds `previewed()` the same point (`chainPoint` in
  agentCursorMotion.ts; `FieldEntry.chainOff` holds the offset, which a carry
  keeps since the node moves whole). Before, a carry onto a port cursor's
  drawn point previewed a chain change the backend never counted, and glided
  1.5 s after the drop; a second tab disagreed meanwhile. The shared fixture
  has a port case, run through `chainPoint` in the tab and `_target_point` in
  the backend.
- **The band takes the newest arrival's slot (r62 Q1 (b)).** During a live
  drag, a carry that joins a column by overlap alone is laid out as the
  newest arrival, the slot the r24 insert gives it: the bottom unless a
  member aims more than 16 canvas units below its target, then above that
  member. `StackEntry.last` is gone. So the band and chain range give one
  slot, and a straight drag moves the carry's slot one way only.
  - What this means for a carry from above: it aims more than 16 above every
    member in the band, so the insert puts it at the head there, on its own
    target, and the members step under it. In chain range it goes under the
    members within 16, and under those more than 16 below once it is within
    16 of them. Review 2's trace (d at 344, e at 384) now goes head, middle,
    bottom: one way, where it went bottom, middle, bottom before.
  - A drop inside the band still ends the band preview at the drop and lays
    the carry out by the backend's arrival order, with one glide when that
    differs (r52's accepted motion). With the insert in both, it rarely
    does: it differs only when the drag pushes a member it already shared a
    chain with onto a new one (the "arrival order differs" test).
  - The join check reads the carry's column at its own arrival, not as the
    newest: that slot moves it down the column and could make the very join
    it then previews (a 4 px drag swapped a chained pair before this).
- **Units (r62).** The chain test and the insert's 16 are both canvas units;
  joins and slot steps stay screen px (label geometry). The fixture has
  zoom 2 and zoom 0.5 cases; the tab's fixture test also lays them out and
  checks the insert agrees with the chain. The property tests' bound is 2
  steps + 32 canvas units (32 × zoom screen px).
- **LOW-3 (backend).** `carry_nodes(positions, placed)`: a node with no stored
  position keeps the box it had. `_display_positions` computes its spot from
  its siblings, so a sibling's first drag or a delete shifted it with no
  move, and could send a false arrival. An open canvas never moves it for
  that either (only a sync's `moved`). Its first stored position is its first
  move. Residual, not new: a reload draws such a node at its newly computed
  spot while the live tab and the carry keep the old one, until it is moved.
- **NIT-1.** A node deleted mid-drag ends its drag (`CursorField.nodeGone`, as
  a drop), so its preview settles after the hold and the timer stops; the
  layer's unmount clears the timer (`dispose`).
- **NIT-2.** `AgentPresenceArrivalEvent`'s doc names the chain rule.
- **LOW-2 (mutants).** Each surviving mutant from review 2 now fails a test:
  band rule 101 (two carries on one node through the band), the own-event
  `carriedFrom.delete` (a nudge of its own during the hold ends the
  preview), `forget()` keeping `carriedFrom` (no wake when the hold ends),
  a `known`-only change (a tie re-sorts by key), the backend's TTL filter in
  `carry_nodes` (an expired cursor joins no chain), and `_show_agent`'s
  `person.pop("log")` (a direct `_show_agent` call with a log and a
  `person_say`).
- **Tests changed to r62.** Round 3b's "a drag through the overlap band ...
  keeps the carry last" asserted d and e never move and a stays under them.
  Under r62 a heads the column in the band, so it now asserts a's slot only
  moves down and ends at the bottom. "a drop inside the overlap band glides
  once" asserted a glide at the drop; the newest arrival's slot there is the
  head, a's arrival-order slot too, so it now asserts nothing moves. The
  glide moved to its own test, in the geometry where the orders differ.

## 2f. Round 3d (GM - Design r65)

GM kept head-then-bottom and the join check at the carry's own arrival, and
asked for the move to be pinned.

- **One glide, one landing.** In the d/e-at-344 case a passes both members in
  one move. All three start gliding on the same frame and keep pace (the land
  spring is linear, so their progress matches). But rest was decided per
  cursor, at 0.2 px: d and e (25 px to go) came to rest on frame 19, and a
  (101 px) only on frame 30. Now `CursorField.restGate` holds every cursor
  gliding in one column off its rest until all of them are within the rest
  distance and speed. Then they all land on the same frame (`stepMotion`'s
  `restGate`, `CursorMotion.nearRest`). It is read once per column per
  frame, before any of them steps, and a member whose loop stopped doesn't
  hold it. It applies to every column glide (says, joins, leaves), not just
  carries. Under reduced motion the move is one frame, as before.
- **Wobble.** Back and forth across 328 (16 from d), with steps in between
  that stay on one side: each crossing is one unbroken run of member frames,
  a step that crosses nothing moves no member, and the slot always follows
  where the hand is. Hysteresis on the preview set alone can't show, because
  the band and chain range both lay the carry out as the newest arrival. The
  slot comes from the insert, and hysteresis there is caught.
- **The 4 px swap** is its own test now ("a 4 px drag of a chained pair makes
  no join of its own").

## 2g. Round 3e (GM - Design r66): the rest gate's two bounds

- **Nothing visible waits for the hold.** A held cursor keeps its landing
  open, so it is drawn at its spring position (unsnapped, still moving by
  hundredths of a pixel) and lands within the rest distance, with no visible
  snap. Audit of what reads rest:
  - Hover re-test on landing (the name for a still pointer): **was keyed to
    rest**. It ran only in the loop's at-rest branch. It now runs on the
    cursor's own rest (`ownRest` in the view's loop), held or not. Test: "a
    cursor held by the column draws its spring position, and a still pointer
    hovers it on its own rest".
  - Drawing: `apply()` draws `m.pos` while landing and snaps to whole pixels
    at rest. The held cursor draws its spring position, as asked, and lands
    from within 0.2 px of its slot (same test).
  - Name shown while moving: `isMoving` is speed-based (over 30 px/s), and a
    held cursor is under 2 px/s. None.
  - Say pill: `sayRoom` reads `isMoving` and positions, never rest. None.
  - The 20 s dim: a timer from the event's age. None.
  - The action's look (ripple): fires on the planner's `arrived` (within 2 px,
    while `awaiting`). Every plan sets `awaiting`, and it is cleared only
    with an arrival or a finish, so the `!m.landing` fallback never waits on
    a held landing. None.
  - Column floor, `crossing`, the zoom path for a glide, `landed()`, the loop
    sleeping: they read `landing`, but nothing visible. None.
- **The cap.** A cursor waits at most `AGENT_CURSOR_REST_HOLD_MAX_MS` (300 ms,
  with the motion tuning in agentCursorPlanner.ts) past its own rest, then
  lands on its own (`CursorField.restGate`, `heldSince`). A column glide's
  members land within about 220 ms of each other, so a plain move never
  reaches it. A drag that keeps moving the carry's node keeps its glide off
  rest: the spot is the column's bottom, but the spring's carrier keeps
  moving. Test: 2 s of wobble inside d's chain, where d and e each wait close
  to 300 ms and never past it.

## 2h. Round 3f (#219 review 3, GM - Design r75)

- **No snap on the gate's frame (r75.1).** The rest gate is read from the
  last frame's steps, so a spot that moved on the gate's frame (a crossing, a
  say, a join or a leave, or the 300 ms cap firing then) was landed on in one
  frame: 101 px for a, 25 for d and e. `stepMotion` no longer forces a
  landing. With the gate open (`true`) a cursor rests as it does with no
  column, on the step it is within the rest distance and speed on this
  frame; held (`false`) it doesn't. So it lands only if it is still near rest
  after this frame's steps, as GM approved, and review 3's two near-equivalent
  mutants (the forced landing, gate-true `mayRest`) can't exist. Tests: the
  reviewer's probe, k = 0 to 49 frames after r65's head-to-bottom move, and
  r66's wobble crossing back on each of frames 20 to 60 (the cap's frames
  among them). No frame moves a cursor more than its spring step: the
  largest step the land spring takes in the clean glide (a about 11.7 px, d and e
  about 2.9), with 2% for a glide that reverses.
- **A wobble back mid-glide glides (r75.2).** In `hold()`, a gliding member
  that the column floor would push more than a pixel past its own slot is
  crossing: it glides to its slot on the layout spring instead of being set
  on the floor (37.6 px in one frame before). A push toward its own slot (a
  glide that ends on the floor, a head leading its column down) still holds,
  and so does a push in lockstep (a fraction of a pixel a frame); measuring
  the push past the slot keeps those. A crossing member is drawn under every
  live cursor (`data-crossing`, `z-index: -1` inside the layer's own stacking
  context), so the one above draws on top while it passes and the labels
  overlap cleanly. Crossing now ends when the glide ends however it ends,
  including when the cursor heads its column. This also covers the merge
  crossing that existed before (a member gliding past the one now above it):
  it draws under that one too. The same push fixed a 34 px floor jump in the
  test setup's band entry. Tests: back 0, 1 and 2 frames into the glide (in
  the k probe), the paint order on each such frame, and r65's wobble test
  extended with reversals 1, 2 and 3 frames after a crossing, both ways.
- **The band in chain space (r75.3).** The newest-arrival band slot now needs
  a member that is both new to the carry's drawn column and new to its column
  read in chain space, each cursor at its chain-input point (a port cursor at
  its node's header point, r62). A carry that meets a port cursor's drawn tip
  joins its column in plain arrival order, which is what the backend's
  arrival order gives at the drop, so nothing moves there. For node cursors
  the two spaces are one, so every node-cursor case is as before. The
  backend needed no change: `carry_nodes` counts an arrival from the chain
  alone and never reads drawn overlap, so at the drop a drawn overlap is
  plain arrival order already. Agents read nothing new.
- **Shared traces.** `cursor_chains.json` has a `traces` list: a carried
  onto h's drawn tip from above, the left and below, and onto h's node
  header, at zoom 0.5, 1 and 2. The backend drops at every path point through
  `carry_nodes` (a arrives exactly from `arrivalFrom` on: never for the tip,
  within 16 of the header); the tab drags along the path and checks a's slots
  and that nothing moves at the drop or through the hold.
- **From below** (for GM): onto the tip from below, a's slot changes once
  mid-drag, `[1, 0]`. In the band a aims more than 16 below h, so the r24
  insert puts h above it; within 16 a heads by arrival. That is the insert's
  own geometry, the same for any cursor, and the backend's order at the drop
  is the same, so nothing moves there. Before this round the same approach
  stayed at slot 1 and swapped at the drop. From above and from the left a's
  slot never changes.
- **Review 3's LOWs and NITs.**
  - R4 (stopped loop): a member whose node is deleted mid-glide holds no one;
    d and e land within a frame of their own rest.
  - C3/C4 (chainOff only): a node widened under a port cursor on its left
    moves its chain point only. That now bumps the layout and wakes the other
    cursors (they could lay out before it reported, and then sleep). Test: a
    carry previewed under c leaves the preview once n1's header moves away.
  - N2: the delete's frame sets the preview's wait (was left to the earlier
    carry's timer).
  - R6: gone with r75.1's change (gate-true rest is the code now); the
    mutants that remain there (no rest on true, gate ignored) are killed.
  - NIT, double hover read: a held landing that is still near rest, or lands
    from there, doesn't mark the hover boxes stale; it reads them once, on
    its own rest.
  - NIT, `heldSince`: cleared when the cursor lands.
  - NIT, `draggedNodes`: a node whose every cursor is forgotten mid-drag is
    dropped from it.
- **A test the band rule needed.** The drawn-column condition had no test
  (a mutant that dropped it survived): a and f share a chain, and a carry
  takes f's label onto a port cursor's header point in chain space while that
  cursor is drawn far off. a keeps its order with f.

## 2i. Round 3g (#219 review 4, GM - Design r85)

- **The band joins in canvas units (r85 rule b).** The band's chain-space
  read (`before` and `after` in `CursorField.layout`) runs deStackLayout at
  zoom 1 (`BAND_ZOOM`) whatever the view's zoom, so its join is the zoom-1
  join, a fixed radius in canvas units, as the chain's 16 is. In screen px
  it grew as 1/zoom in canvas units: below about 0.6 a carry on a port
  cursor's drawn tip reached that cursor's node header (120 to 160 canvas
  units off), took the newest-arrival slot mid-drag, and swapped back at the
  drop (42 to 45 screen px). Drawn overlap still forms the column at any
  zoom, in plain arrival order (r75.3). The backend needed no change:
  `carry_nodes` has no zoom and reads only the 16-unit chain, in canvas
  units.
- **Traces.** `cursor_chains.json` gains 17 traces, which Python and the tab
  both run: zoom 0.25 and 0.1 onto the fixture's port tip from above, the
  left and below, and onto a node header from above; and a left input near
  the header (port box at y 62 on a 280 x 180 node) at 0.25, 0.5 and 1 from
  the same three sides. Paths move one screen px a frame (at most 2 canvas
  units), the last 40 canvas units 2 a frame. The tab side checks the slots,
  and that the 60 held frames and the drop move nothing; both sides assert the
  zoom set and the y-62 port. The two reviewers' probes are tests too
  (PROBE3, PROBE4, PROBE5 and the live lens's PROBE5, 28 cases): no bottom
  slot on the tip, the held frames still, nothing moving at the drop. One
  exception, written into the test: PROBE4 from the left passes 14 under the
  header on its way, which is in the header's chain (a real arrival if
  dropped there), so `[0, 1, 0]` there is the r65 path both ways.
- **The floor reads this frame's position (review 4, drag LOW-1).** `hold()`
  returns early while the member above is still due to step in this frame,
  so the floor is never read from last frame's position. That member's
  `holdBelow` holds this one once it has stepped, in the same frame. Tests:
  every frame's callbacks in reverse order (a flag in the test's rAF stub)
  for r75.1's 50 k-probes, r75.2's crossing marks, and PROBE2 (only the
  carry is marked in r65's head-to-bottom glide, e - d stays one step).
- **A push on a member at rest can be a crossing too (my call, for GM).**
  The reverse-order k = 0 probe still jumped d 8.59 px after the guard:
  the frame that moved a ran after d's, so d never started its glide, and
  on the next frame the floor set d, at rest on its slot, 8.6 px down in one
  frame. A push of more than a pixel past a member's own slot is now a
  crossing whether it glides or rests: at rest it stays on its slot, drawn
  under the member above, until that one is a step over it again. Pushes in
  lockstep (under a pixel a frame) and pushes toward its own slot (a head
  leading its column down) still hold, as before. This is review 4's X4
  mutant becoming the code; re-adding the `m.landing` guard now fails the
  reverse-order k = 0 tests. Flagged for GM because r75.2 spoke of a
  "member mid-glide".
- **A crossing mark ends on a caught-up or stale frame (review 4, layout
  LOW-1).** `field.snapped(key)` clears the crossing mark and the hold's
  start on the caught-up branch (a stall or a hidden tab) and the stale or
  replayed snap, which never went through `hold()`. Tests: the reviewer's
  PROBE1 (1 s with no frames mid-crossing) and the same with d's event
  replayed meanwhile.
- **Crossings keep column order (r85 NIT).** A crossing cursor's z-index is
  `calc(-1 - var(--agent-cursor-crossing-depth, 0))`; the depth is the number
  of members above its slot, set from the layer. So two crossing at once draw
  the upper on top, never by DOM order. Test: d and e both marked in
  `[a, d, e]`, with e after d in the DOM.
- **Mutant pins (review 4, layout LOW-2).** X4: see above. B3: a test where
  the carry's chain-space column already holds a port cursor before the
  carry and its drawn column takes it in mid-drag (no band slot). F2: one of
  two cursors on a dragged node forgotten on the frame before the drop; the
  drop still starts the arrival wait. X8: killed by the reverse-order r75.2
  test now that a member can be judged in `holdBelow`. H2 and H3: equivalent
  (marking the hover boxes stale one frame later changes nothing, since the
  boxes are re-read only on a step's rest). They are gone with the code they
  mutated, see the next item.
- **Hover boxes by distance (NIT F4).** The stillHeld comment claimed a held
  landing moves by hundredths of a pixel, which is false on a moving aim (a
  node being dragged). The boxes now record where the tip was drawn when
  they were read, and they are stale on rest once it is more than
  `HOVER_STALE_PX` (1 screen px) off that spot. A held landing still reads
  once (review 3's NIT-1 test). One held on a moving aim re-reads when it
  rests. The `wasHeld`/`stillHeld` inference and its two mutants are gone.
- **`before` at zoom 1 too.** The first mutation run left one survivor: the
  band's `before` read at the view's zoom. A test pins it: at zoom 0.25 a
  carry already drawn in a point cursor's column, but outside the zoom-1
  join, takes the band slot when it comes into that join (r62), then glides
  back once at the drop (r52).
- **Round 3g checks.** tsc and `npm run lint` pass. The build and the budget
  check pass: entry 447,836 B raw of 512,000. Vitest, explicit list of 123
  files (`--maxWorkers=2`; cursor, log and presence tests, every test that
  reads `src/` or styles from disk, the six ratchets): 2,523 passed. Backend,
  isolated, 9 files: 371 passed. `person_gate.py` is byte-identical to main.
  Mutation: 36 of 36 killed (14 for this round's code, 22 of review 4's on
  today's code), after the `before` pin. Live (headless Chrome, isolated
  backend on 8780, guarded): a carry dropped on a port's tip at 0.25 and
  0.1, on an output and on a left input. a heads h's column from the frame
  they join, nothing moves while held or after the drop (0.00 px over 5,000
  to 7,000 frames each), and no arrival is counted. In Chrome the crossing
  z-index computes to -1 - depth.

## 2j. Round 3h (CI after round 3g)

CI's "Frontend tests (part 3 of 3)" failed two of r17's zoom tests on
df0f53e8: setViewport 1 → 0.5 (b to c 40.89 px) and the pinch (41.62 px),
both under the 42 px step, on the first carry of the zoom.

- **Cause: the zoom's carry read the clock once per cursor, not r85's
  band.** BAND_ZOOM is read only while a node is dragged, and the zoom tests
  drag nothing, so r85 and r17 don't conflict. The zoom's store subscription re-ticks each
  resting cursor, and one that is woken but hasn't stepped, at
  `performance.now()`. Each read is a little later than the one before:
  b stepped at t and c at t + a few µs, and each advanced `frameTime`. When
  c held itself, round 3g's "wait for the member above to step in this
  frame" (drag LOW-1) found `steppedAt(b) !== frameTime` with b's `dueAt`
  older than `frameTime`, so it took b for one still to step. b's
  `holdBelow` had already skipped c for the same reason, so c kept its
  zoom-1 canvas offset: 42.06 canvas units at zoom 0.972 is 40.89 px. The
  frame after, c was back on the floor.
- **Why the local runs passed.** The tests' frames run on their own clock
  (1/60 s a frame, about 2,367 ms by that test), while `performance.now()`
  is the worker's real clock. That's Node's own clock, not jsdom's. Locally
  the worker had run about 1.8 s when it got to that test, behind the frame
  clock, so `frameTime` never moved and the gate let c through. On CI's
  slower runner the worker's clock had passed 2,367 ms. Measured locally:
  perfNow 1,802 to 1,826 against frameClock 2,367. The file was in round
  3g's list and the merge with main changed no cursor code. Removing r3g's
  `upDue` line passes the CI trace again, so the gate is the trigger. In a
  browser the same thing happens: an event's clock is always past the last
  frame's timestamp, and each read is later.
- **Fix.** `CursorField.carryTime()`: a zoom's carry steps every cursor at
  the frame it happens in (`frameTime`), one value for all of them. It reads
  the clock only before any frame has run. A glide still steps no time
  (`lastTime`). `frameTime` stays on the frames' timeline, so a carry no
  longer sets it past the next frame's timestamp.
- **Test.** The three r17 zoom runs again, with `performance.now()` as a
  browser has it: 4 ms past the last frame and later on each read. Without
  the fix they fail with CI's exact numbers (40.891583397633724 and
  41.619971450617356). The r17 body is shared (`zoomGlide`) and its
  assertions are unchanged.
- **r89 item 2 is kept.** The crossing rule at rest in `hold()` is
  untouched, and the reverse-order and r75/r85 traces pass.
- **Mutation.** 3 of 3 killed (the carry reads the clock per cursor; the
  zoom tick back on `performance.now()`; only resting cursors on the
  carry time). The 4th, which drops `resting ||`, is equivalent: a resting
  cursor's `lastTime` is always null.
- **Not covered.** With every `performance.now()` read (React's included)
  stepping 3 ms or more, which is about 3 s of wall time for a 60-frame
  test, one frame still meets. That happens before the fix too and comes
  from the say's 600 ms cap reading wall time while the frames run on
  their own clock. CI's real timings (about 70 ms a test) don't reach it.
- **Round 3h checks.** tsc and `npm run lint` pass. The build and the budget
  check pass: entry 471,107 B raw of 512,000. Vitest, an explicit list of
  22 files (every test that names the cursors, plus the three ratchets),
  `--maxWorkers=2`: 825 passed. Backend, isolated, 5 files: 169 passed. No
  live run: the change is only on a zoom's carry, and r3g's held and
  after-drop shots have no zoom.

## 2k. Round 3i (review 5, GM r95)

- **A. MEDIUM-1, a zoom before a woken cursor's first frame (r3h regression).**
  The zoom branch reset `lastTime` only for a resting cursor, so a cursor
  an event had just woken (frame pending, `lastTime` null) kept the carry's
  time, the field's `frameTime`. When every cursor had rested, that was the
  last frame anyone drew, seconds old: the next frame's dt passed the 0.25 s
  stall gap and stepMotion landed it with no flight and no ring. Fixed as the
  reviewer proposed: `fresh = resting || lastTime === null` steps at
  `carryTime()` and resets `lastTime` for both. Checked the other paths: a
  carry tick only ever sets `lastTime` to its own `time` argument, which is
  now `carryTime()` (then reset) or a gliding cursor's own last frame time.
  The one remaining way to keep an old `lastTime` is a loop stopped on
  `!resolved` (node not drawn), which predates r3h and lands on its next
  frame by design. R5PROBE_B is kept as a test, all three cases (2 s idle with
  a zoom, the no-zoom control, 100 ms idle with a zoom): over 15 frames in
  flight, first step under 40 px, ring shown.
- **B. NIT-2, frame timestamps behind `frameTime`.** Two changes. (1)
  `carryTime()` before any frame returns 0, not a clock read: one value for
  the whole carry and never past the next frame's timestamp. In practice
  this branch can't run (a cursor has no motion until its first rAF tick,
  which sets `frameTime`), so it is pinned on the field directly (M18). (2) A
  rAF tick sets `frameTime` to its own timestamp; a carry tick never moves
  it. Negative dt: stepMotion and stepExit already clamp it (planner
  `Math.max(0, dtSeconds)` on every use, `liveVel` only for dt > 0), so no
  step runs backwards; I added no second clamp. Tests: a frame stamped
  behind `frameTime` (bumped 50 ms ahead, or the clock moved back 40 ms) at
  2, 6, 10 and 14 frames into the head-to-bottom glide, both rAF orders:
  `e - d` stays the step, only the carry is marked, no frame passes the
  spring step. And the hand-back case (k = 0-3, reversed) with the same
  skews.
- **C. LOW-1/LOW-2, an at-rest crossing mark after a stall or a replay.**
  The caught-up branch and the stale/replay branch now set `steppedAt` and
  run `holdBelow` after `apply()`, as every other frame does. `hold()`
  recomputes an at-rest member's mark from scratch, so d's mark ends when a
  lands. R5PROBE_A is kept as a test for both paths (stall, replay of a's
  event): the at-rest mark is found first, then cleared, with no depth
  variable left.
- **D. drag-live LOW-1, GM r95 (binding).** `CursorField.inOrder()`: while
  any member of a column of two or more glides on the land spring (landing,
  no plan, stepped within 100 ms so a stopped loop doesn't count), every
  member gets `data-column-order` and the depth variable; CSS draws it at
  `-1 - depth`, the same scale as crossings, so the head is on top and the
  DOM order decides nothing. Every `apply()` recomputes it and repaints any
  other member whose state changed, so landing on a caught-up or stale path
  clears it too. Flights (arc) and rides don't order a column; a cursor alone
  in its column doesn't either. Tradeoff: while a column glides, all its
  members sit under unmarked cursors of other columns and under the wire
  layer (as crossings already did). Columns don't overlap other columns, so
  nothing new shows. Test: r65's head-to-bottom, landed, then the carry back
  from the bottom slot to the head past e and d, both rAF orders: a draws
  over each member wherever their labels are within a step, d over e, and no
  column order or depth is left after the glide. Plus: a lone flight, a
  flight's arc into a column, and a stopped loop (R4 test) order nothing.
- **E. NIT-1.** M13 pinned: at zoom 2 a rest 0.8 canvas units on re-reads its
  boxes (1.6 px), at 0.25 a rest 3 units on doesn't (0.75 px). M18 pinned
  (B). M4 and M6 are equivalent, as review 5 says: `dueAt` is deleted at
  tick start and re-set to `frameTime` on request, so a member that stepped
  this frame never has `dueAt < frameTime`; and `snapped` dropping
  `heldSince` is redone by restGate/hold on the next step because
  `m.landing` is null.
- **drag-live NIT-1 (a member at rest under a riding head trails it a frame
  when its rAF runs first): not fixed.** The member reads the head's spot
  from the head's last `report()`. Fixing it means moving a member that has
  already stepped this frame once the head reports (a second step, which
  holdBelow's rule forbids), or holding at-rest members under a riding head,
  which turns a ride into a glide (`landing` set, a wake) and only works for
  downward rides. Neither is cheap and safe. The lag is 3-6 px inside a
  36-40 px step, with no label overlap, and the rule is older than this PR.
- **Mutation (19 mutants, 3 test files).** Killed 14: A1 (r3h reset only at
  rest), B2 (carryTime clock read, M18), C1, C2, D1-D8 (inOrder off, no
  repaint of others, lone column ordered, flights order, stopped loop
  glides, depth only when crossing, CSS rule gone, ordered at rest too), E1
  (M13). Survived 5, all equivalent or unreachable: A2 (`fresh = resting`:
  `tick(null)` sets `lastTime` to null anyway), B1 (`frameTime` only moves
  forward: a rAF timestamp behind it can't happen once the carry no longer
  reads the clock; no test scenario tells them apart), B4 (a carry moving
  `frameTime`: its time is always `frameTime` or a glide's own last frame,
  equal in practice), C3 (`steppedAt` on the caught-up frame: the member
  under reads the up's `dueAt`, already deleted), M4, M6.
- **Live** (isolated backend 8780, Vite 5780, headless Chrome, throwaway
  profile, 8000-8010/5173/8840/5840 blocked; blocked.log canary lines only,
  no off-host requests). A ctrl+wheel sent as the click event's POST
  returns, after d rested 2.5 s: 8 of 8 flew (24-27 moving frames; review
  5 had 6 of 8 snapped), and with a ring poll 6 of 6 rang 441-469 ms in, at
  the flight's end. The carry dragged back out of the band at 1440 (s9):
  a overlapped e (12.1, 11.8 px) and then d with z a -1, d -2, e -3: 0
  frames with the upper drawn under. Position, second tab and reload agree
  (a -262, d 44, e 86). The 1024 run didn't get its cursors on screen
  (driver issue, the session lookup timed out), so it isn't counted.
- **Round 3i checks.** `tsc -b --noEmit` and `npm run lint` pass. pr_tests
  (the PR's test files plus every source-reading test, 116 files): 4,092
  passed. land_checks with test_agent_cursor_followups: tsc, the three
  ratchets (103), isolated pytest over 30 files (1,125 passed, 1 skipped),
  person_gate unchanged. Every agentCursor*/cursor* file (7): 637 passed.
  The zoom tests (342) with `performance.now()` skewed +4, +50, -4 and -50 ms
  from the frame clock: all pass. Build and budget: entry 471,107 B raw
  (146,495 gzip) of 512,000.

## 3. Low findings

- **LOW-1 (since creep).** `_same_spot` compares a new target with the slot's
  arrival spot (`anchor`), not the last target. When a node is deleted, the
  anchor moves to the fallback point. A test covers that now: before, deleting
  the line left the tests passing.
- **LOW-2 (ties).** `_arrival(now)` returns `max(int(now*1000), last + 1)`, so
  backend arrivals strictly increase. For the backend's arrivals (`known`),
  the tab drops its `landedSeq`, and ties fall back to the session key.
- **LOW-5 (log de-dupe).** Every person-form presence event carries an
  `eventId` (`<boot hex>-<seq>`), and the log de-dupes on it alone.
- **LOW-6.** At the 3-slot cap, a say checks right, then left, against every
  foreign cursor's whole drawn block, moving ones included.
- **Review 1, NIT-1 (cap hold bounce).** A hold set by the cap's strict check
  went back to waiting on the next frame: that frame's check ignores moving
  cursors. The cap then started over while the blocker kept moving. Now a cap
  hold checks strictly. It shows on a side as soon as that side is strictly
  clear, or goes to the log when the cap is up.
- **Review 1, NIT-1 (backend).** The dead write `slot.event["since"]` is gone,
  because the replay sets `since` itself.
- **NIT.** `countExiting` is keyed by column.

## The `since` clock

`since` stays on the wall clock (epoch ms). The tab compares it with the
presence events' `at`, which is also wall-clock time, and a monotonic clock
can't be compared across processes or after a restart. `_arrival` makes it
strictly increasing, so a clock that steps back can't reorder arrivals.

## Agents

Nothing changes for agents. `eventId` and `agentPresenceArrival` exist only in
person forms and on person sockets. The route tests check, for the layout
route, apply and restore, that agents read the same cursors before and after a
carry. No MCP tool or doc changed.

## Testing notes

- `where()` in the layer tests reads where cursors are drawn. `landed()`
  wakes no other cursor, so a test that checks a column's order after a
  landing pans once to wake every cursor.
- `fieldOf()` in the layer tests reads the layer's `CursorField` through a
  cursor view's props, for bookkeeping no frame shows (`heldSince`,
  `draggedNodes`).
- Session keys in the layer tests must be hex (`session('h', …)` makes no
  session): the r75.3 traces call h `c` there.
- Live frame sampling in headless Chrome needs `--disable-gpu-vsync
  --disable-frame-rate-limit` (and the backgrounding flags); without them rAF
  ran at about 5 fps, which hides one-frame jumps.
