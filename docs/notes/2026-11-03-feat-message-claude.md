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
