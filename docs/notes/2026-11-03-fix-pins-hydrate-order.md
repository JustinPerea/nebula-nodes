# fix/pins-hydrate-order

Follow-ups from PR #218 review 1. All changes are in the frontend.

## MEDIUM-1: a hydrate's listing overwrote a newer push

`frontend/src/store/canvasPinsStore.ts`. Before this change, hydrate awaited
`Promise.all([fetchPins(), pinTextSettling()])`, and a push that came in while
the Unicode chunk was pending was deferred with `pinTextSettling().then(apply)`.
Both waits settle on the same chunk promise. The push's `.then` runs one tick
before hydrate's continuation, so the older listing landed last and hid the
pushed pin. The old comment said "in arrival order, never dropped", which was
not true.

The fix gives every whole-set listing one order (`nextListingOrder`,
`applyListing`):
- A push takes its number when it arrives. A hydrate takes its number when its
  fetch starts.
- A listing that waits for the chunk keeps its number.
- `applyListing` drops any listing numbered before the last one applied.

A push that arrives after the fetch started counts as newer, because every
write on the backend broadcasts the whole set after it commits. If the
fetch's answer already holds that write, the push equals it. If it doesn't,
the answer is older. In both cases, dropping the fetch's answer is right.

A project switch is the same case. The backend pushes canvasPins after
graphSync, and a hydrate that started earlier never replaces one that started
later.

Not covered: `submit` and `remove` change `pins` locally, outside the order.
That is unchanged. The push that follows each write puts them right.

## LOW-1: PinComposer after a failed chunk loads late

`frontend/src/components/canvas/PinComposer.tsx`. PinComposer now subscribes
to `onPinTextLoaded` and renders once more when the data lands. Everything
here that reads the data is computed during render: "N left" (PromptDialog's
`cap.count`), Send note's empty check (the zustand selector runs again on
render), and each kept note's text. So one subscription covers all of them.

I chose this over replacing `kept` in the store's onPinTextLoaded. That would
have refit the kept notes but not the counter, which reads `draft`.

## LOW-2, LOW-3, NIT-1: the ratchet

`frontend/tests/pinTextReadyRatchet.test.ts` now reads each file's syntax tree
with the TypeScript compiler, instead of matching regexes against the text.
The header lists the rules and the known gaps (a helper re-export, and
indirect callers through PinLayer, PinComposer or setState).

Every mutation case is a fixture in the file. I also mutated the checker
itself, one rule at a time, and each mutation failed the fixtures for its
rule. An unchanged real file with r4's wait commented out is flagged too; the
old check missed that.

`tests/lib/errorCopy.sweep.test.ts` now carries an opt-out with a reason. It
takes `pins` as a whole module (`await import(…)`), which the new rule counts
as importing every rule, but it only calls fetchPins, createPin and deletePin.

## MCP parity

Agents never apply a pins listing over another, so the stale-listing race
can't happen on their side:
- look_at_canvas, start_here, `nebula pins` and GET /api/canvas/pins read
  catalog.json when the call is made. There is no client cache that merges
  fetches with pushes.
- `wait_for_canvas_change` and `nebula watch` read the journal by cursor:
  events, not whole sets.
- The channel listener (`mcp_channel.confirm_pins`) only confirms pins it
  already holds, using a GET that starts after their create committed. A pin
  that arrives during a check stays for the next check. A pin deleted after
  the GET answers still goes, which is documented there.

This PR doesn't change what an agent sees. It is frontend-only, and nothing
in the frontend sends computed text: submit sends the raw note.

## Tests

- `tests/canvasPinsStore.hydrateOrder.test.ts`: the review's probe, a push
  before the fetch answers, two hydrates in a row, a hydrate followed by
  pushes, and pushes alone. Each case runs with the chunk pending and with it
  loaded: 10 of 10 pass. The old store fails 4.
- The file uses `vi.doMock` and `vi.resetModules` in each case. A `vi.mock`
  factory's module outlives resetModules, so the first case's loaded chunk
  would otherwise carry over to the next.
- `tests/pinComposer.textLoadedRefit.test.tsx`: the counter goes from
  "27 left" to "29 left" and the kept note from `葛 ❤` to the full form, with
  nothing typed. The old PinComposer fails on both.

## GM's sign-off conditions (pinned in the refit test)

`tests/pinComposer.textLoadedRefit.test.tsx` now runs the full flow twice: at
30 or fewer left (27 -> 29), and with the counter revealed by a note_too_long
refusal (77 -> 79). Each run gets fresh modules (`vi.resetModules` and
`vi.doMock`), so the chunk can fail and then load again. In each run:
- the field keeps focus, its 3-7 selection and its text;
- the polite region stays empty. PromptDialog speaks only when "N left" goes
  down past 30, 10 or 0, and the fallbacks never count fewer characters than
  the data, so a refit only raises the count.

Mutations, each failing both runs:
- the dialog remounted on the refit;
- the caret moved to the end on a redraw;
- the value reset;
- focus moved away;
- an announcement on any count change;
- an announcement whenever the counter shows;
- no refit at all.
