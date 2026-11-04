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

## Round 2b (GM r70)

#216 had no newer head than f6f077b4. I merged main at c892dca2 (#221). Its
new regionNoticesReady ratchet flagged #216's
`tests/noticeRegionDrag.round3k.test.tsx`, which now loads the chunk first.

- **1, the fold:** the working header now uses the settled chip's class,
  so the two look the same. Settling keeps the element, the class, the
  left edge, the height and the gap to the row above. The fold does rise
  on screen, by the reply's height, because the reply arrives below it and
  the thread stays scrolled to the bottom. With no actions yet, the status
  still stands alone as a plain line, not a chip, since there is nothing
  to open.
- **2, the ceiling:** `lib/bottomBar.ts`. `floatingTopLimit(gutter, gap =
  BOTTOM_BAR_GAP)` has #226's signature, as the coordinator asked, so the
  two PRs merge cleanly. `chromeTopLimit(span, gap = CHROME_CLEARANCE,
  floor)` adds the overlap rule on top of it. Over the slot, or with no
  span, it returns floatingTopLimit's line. Otherwise it returns the other
  top bars' line. The toolbar's Panel carries `data-toolbar-slot` and
  reserves `--selection-toolbar-slot-w: 960px`, centred on the Panel: the
  empty Panel is 0 px wide, and the widest toolbar I measured is 896 px (a
  model node at 1440). `--agent-log-top-chrome` (the Updates row) is now
  + 12 px, and acts as the floor. A stored height is clamped when the log
  opens.
- **3, strings:** `answeredQuote` splits the line so the CSS cuts only the
  words. I added "Arrow keys resize; Enter fits the content." to the
  tooltip, because house tooltips list keys ("Select shot. Arrow keys
  change shots; Alt + arrow keys reorder.").
- **4, the handle:** `describeHandle` writes aria-valuenow, -valuemin and
  -valuemax (px) on each measure, since the height follows the content
  until the person sets it. React doesn't render those attributes.
- **5, the budget:** `lib/personThreadCompose.ts` holds SEND_HEADING, the
  Sending… timings, sendFailure, postMessage, newClientId,
  sendingSettleDelay, mergeMissing, otherFailureLine, `setDraft` and
  `sendMessage`. They were the store's `setDraft` and `send`. The entry
  went from 469,727 B to 468,192 B. What stays, by declaration (B):
  sanitizeRow 1,260, sanitizeListener 392, cleanAgent 184, mergeRows 151,
  sessionKeyOf 124, KINDS 82 (lib/personThread.ts, 2,300). The store adds
  the socket handler 444, receiveRows 356, noteActivity 296, the store 232,
  initial 173, replyAnnouncement 106, receiveSync 105, the open-clears-
  unread subscription 104 and terminalListening 65 (1,955). All of it is
  the wake path. `tests/personThreadEntry.r70.test.ts` keeps the eager
  modules from importing the compose half or the API.
- **6:** `.agent-log__status--name` overrides the telemetry's lowercase.

### Open for GM

- There is no You row after a typed answer: an answer goes to the
  questions API, not the thread. The cut words are in the DOM (a screen
  reader reads them whole), but a sighted person can't see the rest. A
  `title` with the full answer would fix that if GM wants one.


## Round 2c (GM r73)

Neither origin/main (c892dca2) nor #216 (f6f077b4) had moved, so there
was nothing to merge.

- **1, the tooltip:** the handle's title is now GM's sentence, word for
  word: "Drag or use the arrow keys to resize. Double-click or press Enter
  to fit the content."
- **2, the You row:** the boundary rule is Justin's and stays as it is.
  Every connected agent reads the thread, and an answer goes only to the
  agent that asked. So the row is never a thread row, a message, a journal
  field, an MCP or CLI field, or a socket field. `answerRows`
  (lib/personThreadBox.ts) derives it in the person's tab. It comes from
  each thread question row whose set the questions store holds as
  answered, with typed words and no option picked, and it sits at the
  set's `closedAt`. `foldActions` places it among the rows after its
  question. After a reload, `questionsSync` (closed sets are kept 30
  minutes, the same as the card's "You answered" line) brings the set
  back, so the row comes back too. Option picks get no row. The card keeps
  "You answered “…”.". When the answer is the last thing in the thread,
  it scrolls into view the way a row does, but it never raises "New
  reply". The collapsed preview shows it when it is the latest.
- **3, the cut:** `cutAtWord(text, fits)` is the one cut for the chip and
  "You answered". It returns the whole text if it fits. Otherwise it
  returns the longest run of whole words that fits with its ellipsis,
  after dropping any trailing space or punctuation (`\p{P}`), and it
  searches the word boundaries by halving. `useWordCut` in MessageBox
  measures the element. With every word in it, the flex item's box is as
  wide as its line allows. Each candidate is then measured with a Range,
  in fractional px.

### Surprises

- Chrome lays out "shots…" (an s followed by an ellipsis) 0.42 px
  narrower than it paints it (range 246.77, box 246.34). Other endings
  match exactly. With the ellipsis inside the clipped span, the span's
  CSS ellipsis took the final "s" ("…three shot… ”"). The ellipsis now
  renders as its own text after the span (`cutParts`). `fits` measures
  the words plus the ellipsis's own width.
- A ResizeObserver delivers a first call on `observe()`. That second
  measure ran with the "…" sibling already taking space, and it shrank
  the cut to "three…". The room now adds the width of a shown "…"
  sibling, and a test runs the observer twice.
- Whole-px `scrollWidth <= clientWidth` gave the same wrong answer
  (247 vs 246) for a cut that fits, so it measures with a Range instead.
- The r2b open point (no You row) is resolved by item 2.

### Checks

- tsc and lint are clean.
- vitest: 145 files, 4,059 of 4,060 passed. The one failure was a timing
  test in agentCursorLayer (22 ms) under load, and it passed when run alone.
- Backend, isolated: 13 files, 512 passed. `person_gate.py` is
  byte-identical to main.
- Mutations: 12 of 12 killed. One survived until the test's line width
  was tightened to 276 px, so that dropping the "…" sibling's width
  changes the cut.
- The entry is 468,192 B raw, unchanged.

## Round 3 (review 1: boundary, MCP parity, live UX; GM r79; Justin's token rule)

Merged feat/channel-deliberate-sends twice (faa21ab4 for round 3's
ungated-turn span, 4cfd894d for item N). #226 isn't on origin/main
(no `floatingChromeTopLine`), so item M (the resize ceiling) is skipped.
GM r79.7 / boundary LOW-2 are not built (held).

- **D, MEDIUM-2:** `person_thread.trim` drops agent rows first, then
  settled person rows, and never a sent or held message (one still in
  flight). Replies are paced per agent (`ReplyPace`: 5 in a row, then one
  every 2 s, 256 agents kept). Past it: 429 `replies_rate_limited`,
  `Retry-After`, `retryAfter`, and a line that says when ("…you can reply
  again in 2 s…"). Nothing is saved. The pace is taken after the body
  checks, so a malformed call doesn't spend a reply.
- **E, r79.1:** a reply's own cursor say (within 10 s, same agent and
  session label, the reply's first sentence) is never an action:
  `isReplyEcho` keeps it out of `foldActions`, and `noteActivity` doesn't
  turn it into the working line. The Agent log still lists it.
- **F, boundary MEDIUM-1:** `agent_view(row, viewer_id)` keeps a question
  row's `questionId` and agent for everyone, and its `questions` only for
  the asker. The person's tab draws the text from its own store.
- **G, r79.2:** the working line is the event's say, else its `log`
  (a no-note `edit_canvas` now sends "Changed “Prompt” on “Hero shot”",
  "Changed 3 settings on …", "… and 2 more nodes"), else the did line.
  A terse form ("changed 1", "moved 2") is skipped. Ratchet test.
- **H, r79.3:** `runOrigin` replaces `runMessage`. The working fold sits
  under whatever woke Claude last: a message, a pin note row, a typed
  answer's You row, or the card of an option pick. It ends on a later
  reply (a pin: also its pinReply). Passive wakes read plain "N actions".
- **I, r79.4 + LOW-2 + L2:** the pill names the newest unseen agent row
  ("New reply", "New question", "New proposal", "New note"; a pinReply
  reads "New reply") and jumps to it. The person's rows, pins, answers and
  folds never raise it. A resize while read at the bottom stays at the
  bottom (`onScroll` tells a reflow from a scroll by the size change), and
  the thread has `overflow-anchor: none`.
- **J, r79.5:** answering or closing a set writes its `outcome`
  ({status, closedAt, answers}) onto the thread's question row,
  person-only (`agent_view` drops it). The card and the You row read it
  after any reload. Not open with no answer known: no buttons, "This
  question is closed.".
- **K, r79.6:** withdrawn while the person types: the chip goes, the draft
  stays, and the field's describedby line is "Claude withdrew the
  question. Send again to post your answer as a message every agent can
  read." An answer racing the withdrawal gets 409 "already withdrawn"; the
  store closes the set, nothing else is sent, and the same line shows.
- **L:**
  - LOW-1 (boundary): closed by item N in #223 (HMAC ids, per-agent cap).
  - NIT-1: `hold` never re-marks an accepted row; docstring says so.
  - LOW-3 (mcp): `receiveSync` counts replies missed while the socket was
    down as unread (same project, panel closed), without announcing them.
  - LOW-4: `nebula channel [--json] [--as]` is channel_status's CLI twin.
  - NIT-2: the cut keeps a closing bracket or quote whose opener it keeps.
  - NIT-3: an unnamed agent reading the thread gets "Name yourself with
    NEBULA_AGENT_NAME or --as to read the thread".
  - NIT-4: a reply names the message it followed (`replyTo`, the latest
    accepted message to that session's listeners); only that one and
    earlier ones read answered. Rows from before keep the old rule.
  - C/NIT-1 (parity): the gated-turn refusal and INSTRUCTIONS name
    reply_to_person.
  - LOW-6 survivors: pinned in test_person_thread_round3.py.
- **N (Justin):** the inbox, accepted and held routes take the same
  token-only caller as registering. Tests use real agent tokens.

### Surprises

- The live harness's simulated listener imported `mcp_server` and called
  `serve_channel` directly, which skips `__main__`'s
  `load_app_token_file()`, so it was refused as tokenless. The real entry
  loads the file first; the harness now does the same.
- `trim(rows, limit=MAX_ROWS)` bound the limit at definition time, so a
  test's monkeypatch did nothing. It reads the constant at call time now.

### Checks

- tsc and lint clean. vitest: 150 files (disk readers, everything touching
  the box, log or questions, and main's three ratchets), 4,162 passed.
- Backend, isolated: 27 files, 918 passed. `person_gate.py` is
  byte-identical to main.
- Mutations: backend 12 of 12 killed, frontend 13 of 13 killed.
- Entry 469,331 B raw / 145,840 gzip (+1,139 B).
- Live at 1440x900 with a real Settings token file: the tokenless listener
  is refused with r81's line; the working fold under a pin note and under
  an option-pick card; "This question is closed."; the withdrawn line with
  the draft kept and no push; "New question" and its jump; a node-anchored
  reply with no trailing fold. Six shots, six distinct md5s.
