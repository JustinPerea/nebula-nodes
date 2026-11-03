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
