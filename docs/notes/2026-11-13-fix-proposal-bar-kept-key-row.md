# The proposal bar hides its Accept key row on a kept canvas

Follow-up to #203. A kept canvas (#199) holds every control first, and `withKeyLock` hands its props back
unmarked there, so #203 made each Run surface drop its screen-reader missing-key line. The proposal bar still
drew its visible "You can accept this after you add your Hugging Face token" row. It now asks the same rule
(`isKeyLocked` on the props `withKeyLock` returned) and draws no row while the canvas is kept. Accept's title is
the kept line, as before.

The row comes back with the canvas through the bar's existing row path: `useLeave(..., 'row')` for the leave and
`notice-row-in` (with the reduced-motion fade) for the entrance, marked `data-entering` only when it changes under
an open proposal, as the kept-note rows do. A row that arrives with the card stays part of the card's own
entrance. No new animation.

`notReadyShown` and `notReadyBarLines` take `acceptRowShown`. When it is false, a node row that the bar would
have merged into the Accept line is dropped, not shown in its own "You can run Idol after..." words. The `isKeyLocked`
call moved above the early return in `ProposalBar.tsx` so the row's hook runs on every render.

Decisions and surprises:
- GM said to keep the "N nodes can't run here yet" count row and the other per-node rows as they are. The count
  still counts the key-locked node. A kept canvas with four or more not-ready nodes shows the count and no Accept row.
- No shipped node has a `missingKeyLine` today, so the shot keys Idol's route in the page the way
  `tests/helpers/keyedSpace.ts` does for tests.
- Agent-facing text (MCP, CLI) is unchanged: the backend refusal line is not touched.

Tests: `tests/ProposalBar.test.tsx` (kept hides the row and holds Accept with the kept line; canvas back returns
it, `data-entering`; not kept unchanged), and the motion-by-kind ratchet in
`tests/agentPresenceFollowups.r6.test.tsx` lists the row.
