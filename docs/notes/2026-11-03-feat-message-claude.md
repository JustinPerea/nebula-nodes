# feat/message-claude

The Message box (GM - Design r50 and r55): the person messages a Claude Code
session that listens through the Nebula channel, from a composer in the Agent
log, and reads its replies there. Stacked on PR A (#223,
feat/channel-deliberate-sends).

## Backend

- `services/person_thread.py` holds the thread. Rows are kept on the project
  record (`personThread`, at most 300), so a reload and every tab show the same
  thread. Only the person sends messages. Agents only reply, through
  `reply_to_person` (MCP), `nebula reply` (CLI) or
  `POST /api/canvas/thread/replies`.
- **Read boundary** (Justin, 2026-11-03): every connected agent reads the whole
  thread, the same as pins. That covers the person's messages and every agent's
  replies, through the journal (`person.message`, `thread.replied`) and the read
  tool (`read_thread`, `nebula thread`). The rule is one switch,
  `AGENTS_READ_WHOLE_THREAD`. `visible_to_agent`, `message_event_data` and
  `reply_event_data` all read it, so turning it off narrows the reads, the
  journal and the cursor's say together. Only the listener named in `to` wakes
  (PR A).
- **Hold, not refusal** (r55): the 201st deliberate send to one listener in an
  hour is accepted and saved with `state: "held"`. The box then reads "Sends in
  a few minutes because you’ve sent 200 this hour.". The route marks a message
  held when that listener already had 200 messages this hour (`SendCap`, per
  listener). The listener also reports anything it holds for its own cap (a pin
  or an answer can fill it) with `POST /api/agent/thread/held`, once per
  message. Both come from something Nebula really sees.
- **States from what Nebula saw:** `sent` (saved), then `accepted` once the
  listener pushed it (`POST /api/agent/thread/accepted`, its own messages
  only). The listener reads its messages back from
  `GET /api/agent/thread/inbox`. The journal event only marks the inbox as due
  for the listener it names.
- **Reference rows:** a question, a proposal, an Update, a pin and a pin reply
  add a row only while that agent session listens. The person's pin adds one
  while any session listens. These rows are decoration and never fail the route
  that adds them.
- The person's tabs get `personThread` on a verified hello and when a project
  opens or is created (`_broadcast_projects_changed`). Agent sockets never get
  it.
- The six new non-GET routes join the round-20 fence allowlist. PR A's r55
  commit adds the two `/api/agent/channel` lines too. Drop mine when #223 lands
  in the base.

## Copy command on a first run (coordinator item 2)

`nebula mcp connect claude-code --channel` now also finds the token file that
Claude Code's saved `nebula` entry names (`~/.claude.json` →
`mcpServers.nebula.env.NEBULA_APP_TOKEN_FILE`). The plain connect writes that
entry. Only a path is read, and the token never reaches argv, output, the
clipboard or a log. Symlinks, files over 64 MB, the placeholder and a legacy
inline token are refused. With no saved token at all, the existing error still
stands, because making a token is the person's job in Settings. Auth is
unchanged. `mcp_connect.py`'s printed strings are unchanged (the coordinator's
rule).

## Frontend

- `lib/personThread.ts` holds the pure parts: the state machine
  (`messageStatus`, `nextStatusChange`), `sendingSettleDelay` (300 ms / 400 ms),
  availability and the recipient, the counter, `foldActions`, and r50's strings
  verbatim. `store/personThreadStore.ts` is the eager store, fed from load like
  the log's. It holds rows, listeners, each session's last event and line, the
  draft, the nodes riding along, unread, the announcement and the one send in
  flight.
- `components/panels/MessageBox.tsx` lives in the Agent log's deferred chunk.
  The composer keeps its place in the tree, so focus and the draft survive
  collapse and expand.
- The log's height follows its content: `height: auto` up to 50vh, animated
  with the layout spring through `interpolate-size`. AgentLog writes the
  measured height to `--agent-log-h` on `<body>`, so the docked chat and the
  canvas controls keep clear of it.
- The disabled look of the box's buttons is the shared one
  (`styles/disabled-buttons.css`). The server failure line joins the Try-again
  ratchet.
- Show on a pin row sends `nebula:pin-show` (PinLayer pans to the pin on a
  spring and opens it). Show on an Update row sends `nebula:updates-open` (the
  corner opens its list). Show on a proposal row focuses the card through the
  proposals store. The card stays the only place to Accept.
- The chat bubble and the chat panel read "Personal agent" while a terminal
  session listens.

## Decisions and deviations

- **Folded actions:** these are Agent log entries (memory only) between thread
  rows, so after a reload they show only from then on. Actions after the latest
  row fold too. With an empty thread, the expanded log is the event list as
  before.
- **State strings:** the lines keep GM's literal "Claude" ("Waiting for
  Claude", "Claude is working · …", the lock lines). Row labels and the live
  region use the agent's cursor label ("Claude · 2 replied. …").
- **Questions:** one question with options answers in one click (the mock). A
  set of several questions, or several choices, gets "Send answers". A question
  with no options gets "Answer", which opens the Agents panel's form.
- **"Working" line:** the latest event's log or say line from that session. A
  bare move keeps the previous line.

## Surprises

- `tests/setup.ts` refuses unmocked requests. A frontend refetch on a project
  switch broke App tests, which is why the backend now sends the sync on open.
- In a background tab, ResizeObserver and rAF are throttled, so a measured
  height is stale until the tab is in front. This only affected the live
  harness.

## Round 2 (GM r61)

Merged #216's round 3k (f6f077b4) first. The only text conflict was
AgentLog's imports. #216's rules hold for the box's log: folded for the card,
the log is its header's height. Only while a give is in force does the shown
height bound it. A collapse by the person still shows the header, the
preview and the composer, as r50 asked.

- **A, the run's fold:** the run is the latest message with no reply yet.
  While its session works on it, or Nebula waits on it, the status row is the
  header of the fold that holds the run's actions ("› Claude is working ·
  Cooler sky"). It is always the last row. With nothing folded yet, the status
  row stands alone at the end. The fold keeps its id when the reply lands, so
  it stays where it is and stays open or shut, and it reads "› 2 actions"
  above the reply. "Sent" and the held line stay under the message, since
  they are settled lines, not news.
- **B, the locked look:** the field row's border is drawn on a `::before`
  layer at `--sr-disabled-opacity` (0.48). The placeholder and the "/" key
  get the same opacity. The lock line sits outside the row and is never
  dimmed. The field stays focusable and aria-disabled.
- **1, resize:** the handle sits on the edge away from the one the log is
  pinned by (the top edge when docked). It is a focusable separator, and the
  arrow keys move it 16 px. A drag writes an inline height (`data-sized`,
  kept in `localStorage` as `nebula:agentLog:h`), clamped to at least the
  header, one row and the composer, and at most the log's bottom less
  `--agent-log-top-chrome` (the Updates chip row: 72 px). A double-click or
  the toolbar's layout reset gives the height back to the content. The
  measure the card and the docked chat read is the height with no give: the
  person's height, or the box's own height while `--agent-log-give` is 0,
  otherwise the last one. `--agent-log-h` on `<body>` now comes from that
  measure, not from a separate observer. The give's floor now includes the
  composer, so a squeeze never clips it.
- **3, names:** waiting, working, stopped and dropped-at-send lines use the
  session's cursor label. The stopped line names the session that stopped
  most recently. "Connect Claude Code…" stays literal.
- **4, questions:** an answered set drops its buttons and shows "You chose
  “…”." (every choice named, joined with commas and "and"). A set of one
  question with no options is answered from the composer: Answer sets an
  "Answering “…”" chip with × Remove and focuses the field. The answer takes
  the questions API's 1,000-character limit. Sending calls the questions
  store's send, which is `question.answered`, never a thread message. Only
  offline locks it, since no listener is needed. A set that mixes such a
  question with others keeps the Agents panel's form. A typed answer's quiet
  line, "You answered “…”.", is my wording: GM gave only "You chose".
- **Budget:** round 1's 6,647 B entry growth was `lib/personThread.ts`
  (5,628 B: Rollup can't split a module the eager store shares with the
  deferred box), `store/personThreadStore.ts` (2,690 B) and small change.
  The box-only half moved to `lib/personThreadBox.ts` (the Agent log's
  chunk). In the entry, `lib/personThread.ts` is now 3,047 B and holds only
  what the store needs. The entry went from 472,411 B to 469,727 B.
- **CI ratchets (round 1's failures):** the `{e.message}` allowance moved
  with the row to `AgentLogEntryRow.tsx`. An "other" send failure now reads
  `failureMessage` (`otherFailureLine`). The store keeps the failure's kind
  and recipient, and the box writes r50's lines with the label. The field's
  ring is drawn on its row (`:has(.message-box__field:focus-visible)`),
  which is registered in `focusRingCss`'s CLEARED list.

### Surprises

- jsdom has no layout. The resize tests use a cascade model over
  `layouts.css` then `messageBox.css` (`tests/helpers/logCascade.ts`,
  generalized from #216's round-3k test). They mock the log's
  offsetHeight/clientHeight and resolve token probes.
- The sized rule's `100vh` term doesn't matter in practice: with no give,
  `max(shown-h, …)` is the person's height already, and the JS clamp sets
  the maximum.
- At full height (top at 72 px), the resized log covers the right end of the
  selection toolbar at 1440. GM may want a lower ceiling.
