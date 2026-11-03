# fix/cursor-followups (2026-11-03)

Follow-ups to the agent cursor column work (#211): two rule changes from design
review, plus the low findings and nits from review 9.

## 1. A cursor never sits above its own target

The column still orders by arrival, but each tip now takes
`max(prev.tip.y + step, its own target.y)` (`deStackLayout`,
`frontend/src/lib/agentCursorLook.ts`). A later member whose slot would sit
above where it points is drawn at its target, and the members below it shift
down. That can leave a gap in the column. The 3-slot cap, the count drawn last
and the gliding slot changes stay as they were.

The (0, 60, 0, 0) example now lands at `[0, 60, 60+S, 60+S]`. Before, the
second cursor was drawn at S, above its target at 60.

**Property tests** (`agentCursorLook.test.ts`, `expectColumnsCapped` and
`expectColumnsJustified`):

- In every final column, each drawn tip is at or below its own target
  (screen-down).
- It is at most 2 steps plus the gaps above it below that target.
- Every merge is justified (catches over-merging): a column joins only cursors
  whose reach boxes met at some point in the sweep.

They run over review 8's fuzz, the random fuzz, and a new 20,000-set fuzz
(seed 9911). In that fuzz, over 10,000 sets join a column and over 1,000
leave a gap.

**The first-pass shape-meet join is not redundant.** With it removed, 739 of
50,000 random sets lay out differently: a cursor that meets a column only at
its pushed position is left out. The join stays, and a pinned example covers
it: a at (38, 114), b at (57, 157) and c at (50, 155) all join column a, at
x 38 and y 114, 157 and 199.

## 2. A carried cursor counts as arriving now

A node move can carry a cursor (one that points at the node) into another
column. The backend then counts that as a new arrival for the column.

- **Backend.** `AgentPresence.carry_nodes(moved)` adds each slot's node
  movement to a running total. Past `ARRIVAL_RADIUS` (16 flow px), the slot
  gets a new `since`, its total resets, and `slot.event["since"]` updates, so
  replays agree. `PUT /api/graph/layout` calls `_carry_cursors` after the
  graph sync. That sends `agentPresenceArrival` to person tabs only
  (`broadcast_browser`).
- **Tab.** `store.arrive()` takes the new `since` (`arrivalKnown`), and the
  layer wakes the cursor. Before the backend's message comes, the tab already
  treats a carried cursor as arriving (`arrivesNow`): carried past the same
  16 px radius (`AGENT_CURSOR_ARRIVAL_RADIUS`, pinned equal to the backend's
  value by a test) and meeting the column. The cursor goes after the column's
  members, so the backend's later `since` moves nothing.
- A carry within the radius is no arrival: the cursor keeps its place in both
  the backend and the tab.

## 3. Low findings

- **LOW-1 (since creep).** `_same_spot` compares a new target with the slot's
  arrival spot (`anchor`), not the last target. Small steps can't walk a
  cursor away while it keeps its old `since`. When a node is deleted, the
  anchor moves with the target to the fallback point.
- **LOW-2 (ties).** `_arrival(now)` returns `max(int(now*1000), last + 1)`, so
  backend arrivals are strictly increasing and never tie. For arrivals the
  backend has stamped (`known`), the tab drops its local `landedSeq`; if two
  `since` values are still equal, the order falls back to the session key.
- **LOW-3/4.** New tests cover the carried `arrivesNow` path and the
  rank-change branch of `report` (which now also fires when `known` changes).
- **LOW-5 (log de-dupe).** Every person-form presence event carries an
  `eventId` (`<boot hex>-<seq>`), and the log de-dupes on it alone. A real
  repeat in the same millisecond is two lines. An event with no id is always
  listed.
- **LOW-6.** At the 3-slot cap, a say checks right, then left, against every
  foreign cursor's whole drawn block, including one that is being carried. If
  both sides are taken, the say holds (the 600 ms cap and the log fallback are
  unchanged).
- **NIT.** `countExiting` is keyed by column (each count's exiting group), not
  by member key, so the head and the count's member leave together.

## The `since` clock

`since` stays on the wall clock (epoch ms). The tab compares it with the
presence events' `at`, which is also wall-clock time, and a monotonic clock
can't be compared across processes or after a restart. `_arrival` makes it
strictly increasing, so a clock that steps back (NTP) can't reorder arrivals
or make them tie.

## Agents

Nothing changes for agents. `eventId` and `agentPresenceArrival` exist only in
person forms and on person sockets. `conftest.person_only_frame` flags both,
and the tests check that agent reads of cursors are the same before and after
a carry. No MCP tool or doc changed: `docs/MCP-SETUP.md` and contract 07
describe `_say_agent_action`, which is unchanged and has no `eventId`.

## Testing notes

- `where()` in the layer tests reads where cursors are drawn. `landed()`
  wakes no other cursor, because a landing stamp is always the newest. So a
  test that checks a column's order after a landing should pan once to wake
  every cursor; otherwise a wrong `since` can hide behind spots drawn
  earlier. The carried-arrival test does this. Without the pan, the mutants
  that turn off `arrivesNow` or drop the half-millisecond survived.
- A cursor carried over several members during one drag is marked as
  arriving again each time it meets a new one. It still ends after all of
  them, as the backend counts it.
