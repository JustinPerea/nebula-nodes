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
  16 screen px below it, or last if there is none. Cursors aimed within 16 px
  of each other keep arrival order, so fuzz never reorders them.
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
    counts as its node's point.
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

- **The preview.** A carried cursor whose chain would change is drawn last in
  the column it is passing: a display-only place after every landed cursor,
  plus its own `since`. So two cursors on one node keep their order (rule
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
  member's label while their targets are still over 16 apart. Round 3 left
  the carry heading the column there, then dropped it to the bottom once the
  targets came within 16. Round 3b (below) draws it last in that band too.

## 2c. Copy: an apply's say (r47)

"moved 1" in round 2's shot was Nebula's own text: the apply's summary,
shown on the agent's cursor. The person's tabs now get person copy, built by
`main._edit_say`. Examples: "Moved 1 node", "Moved 3 nodes", "Added 2 nodes
and 1 connection, moved 1 node". It goes in the person form only
(`_show_agent(person_say=...)`), so it also reaches the Agent log and the
replay. Agents still read the summary ("moved 1") word for word, in the reply,
in `publish_action` and in the agent form's `say`.

## 2d. Round 3b: the overlap band (GM - Design r52 Q1)

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
- **Residual.** A chain preview keeps round 3's rule: last by arrival, then
  the stable insert. A member aimed more than 16 below the carry can still
  sit under it. Within the chain range that takes a column already reaching
  past the carry's target, so it's rare.
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
