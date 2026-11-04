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

## Round 3b (GM r83: copy, and the Updates-card check)

Every string is in #225's own files, so #223 needed no change and no commit.

- **r83.1 working-line edit labels** (`main._edit_log_line`): one node
  names up to three settings ("Changed “Prompt”, “Seed” and “Size” on
  “Hero shot”"), from four it counts ("Changed 4 settings on “Hero shot”").
  Several nodes are named and their settings dropped ("Changed “Hero shot”
  and “Sky”"), from four "Changed 4 nodes". The "and N more nodes" hybrid
  is gone. The caller now passes the other nodes as (verb, name).
  Decision not in r83: several nodes keep the verb they all share ("Moved
  “Hero shot” and “Sky”"); mixed verbs read "Changed". A setting with no card
  label is still counted, never named by its key ("Changed a setting on …").
- **r83.2-4:** the pace refusal, the unnamed reader's line, and "reply to
  the person with reply_to_person" in the gated refusal, verbatim.
- **r83.5 CLI:** the no-listener line with the command on its own line,
  " · {reason}" on listener rows, and the empty and too-long reply errors
  (n with a comma). Curly apostrophes in "Replied in the person’s Message box."
  and "No messages in this project’s thread yet." Thread rows keep "(n7)".
- **Ratchet:** #204's test_flag_parens_copy isn't on this branch. A sibling
  check in test_person_thread_round3 scans cli/commands/thread.py for
  straight apostrophes, a colon that introduces a command, and a reason in
  parens. Run against this tree, #204's own checks find nothing in
  thread.py except the "(n7)" row parens GM keeps.
- **MCP parity:** reply_to_person's docstring and MCP-SETUP quote the
  pace line, the unnamed-reader line, `nebula channel`'s output and the edit
  labels.
- **CHECK (shot 6): harness, not a bug.** Every ask posts its own Update
  (`_post_question_update`; the route refuses the ask if it can't). The
  corner shows one card at a time and holds each for 4 s, with the next
  queued behind it. In the shot, "Updates 1" is the new question's unread
  Update and the badge is its open question. The card on screen was the
  earlier question's, re-texted when that question closed during its hold.
  Pinned by test_a_new_question_posts_its_own_update_while_an_answered_one_reads_past_tense.

### Checks (round 3b)

- tsc and lint are clean. vitest: 148 files on an explicit list (every
  disk-reading test, main's three ratchets, the errorCopy, failureLines and
  tryAgainLines tests, and the box, thread and log tests): 4,347 passed.
- Backend, isolated: 57 files (the named tests plus every test that reads
  MCP-SETUP or SKILL.md), 2,000 passed. `person_gate.py` is byte-identical
  to main.
- Mutations: the label builder 10 of 10 killed (M10, a removed node left out
  of the names, survived at first; a test now covers it). The copy strings 6
  of 6 killed.
- Entry: 469,331 B raw / 145,840 gzip, unchanged.

## Round 4 (review 2; Justin 2026-11-04 J1-J4; GM r89)

Merged feat/channel-deliberate-sends at 5ec108a4 (#223's round 4: J4's
span-until-reply, J3, revoke drops listeners). Item M of round 3 (the
resize ceiling) is still skipped: #226 hasn't merged. GM r89.2 (the
unverified reply author) is moot after J1 and not built.

- **J1, replies take a Settings token.** `POST /api/canvas/thread/replies`
  refuses a name alone or nothing (`401 reply_no_token`), an in-app turn
  token (`reply_in_app_token`), and the token middleware answers a revoked
  token on that path with `reply_token_invalid`. The pace keys on the token
  agent only (rotating names can't post at all). The listener's own routes
  (`/api/agent/thread/*`) now get r81's `listener_token_invalid` from the
  middleware too (parity NIT-2).
- **J2, the CLI reads NEBULA_APP_TOKEN_FILE** (`nebula_api.app_token_from_file`)
  when no token is in the environment, with the MCP server's strict reader,
  keeping the token in process memory only and failing closed. Decision not
  in the brief: the shell gets the path because the launch command
  `--channel` prints now starts with `NEBULA_APP_TOKEN_FILE=<path>` (the
  path only); the MCP config's env reaches only the MCP server, never
  Claude's Bash. A reply from a session with no listener of its own (the
  shell's cursor session differs from the MCP process's) answers for every
  listener of that token agent (`_reply_listener_ids`), and the reply row
  takes the session of the message it followed, so it reads as the same
  "Claude Code" and settles it.
- **`--channel` after a revoke** (parity LOW-2): a missing or bad listen
  file falls through to the file Claude Code's saved server names; only
  with none does the old error stand.
- **J4's #225 half:** reply_to_person's docstring says the reply ends the
  turn's span ("reply when you're done"); SKILL.md and MCP-SETUP say to
  answer a push with the tool (a shell reply settles the message but the
  listener never sees it, so the span runs to its 10-minute cap).
- **Boundary LOW-1, messages in flight:** the revoke route settles that
  listener's `sent`/`held` messages as `dropped` in every project and
  broadcasts them; the box shows the existing send-time line
  (listenerDroppedLine) under the message and never treats it as an open
  run. Decision: reuse that GM line rather than invent one.
- **Boundary LOW-2:** the inbox reads every project (open first; each
  message names its `projectId`), and accept/hold mark a message wherever
  it was sent (`_write_all`). The listener re-arms its inbox on a `gap` or
  `reset` and after a read that failed all INBOX_TRIES. Decision: a
  message sent before a switch is still pushed; Claude acts on the canvas
  open now, as with any request.
- **Live L1:** a reply Nebula refuses after the pace (409 no project, 503)
  gives its slot back (`ReplyPace.refund`). **B7:** a test pins the burst
  cap after a long quiet. Mutant "refund past the burst" is equivalent
  (take re-caps the bucket).
- **Parity NIT-3:** `nebula reply` counts characters as the server does
  (text_length of shown_text). **Live L3:** an unnamed, tokenless `nebula
  thread` prints r83.3's line without a request; a tokenless `nebula
  channel` prints a new line (below) instead of "You have no listener".
- **Frontend (GM r89, parity LOW-3/LOW-4/NIT-1; details in the builder's
  notes):** `countsAsReply` is the one rule for pill, badge and
  announcement (pinReply counts). Answered or closed in another tab: the
  chip goes, the draft stays, the named-cause line shows, the first Enter
  is held (the line goes to the polite region) and the next posts; the
  hold applies to withdrawn too. A set that vanished with no known cause
  gets no line and Enter posts (F13: no GM line for an unknown cause; GM
  to confirm). `availabilityLabel` is the one label source for the
  placeholder, aria-label and stopped line (not connected and offline with
  no listener: "Claude Code"). The shared cut appends closers for openers
  left open ("Changed “Prompt” on “Hero…”"), treats straight quotes as
  self-pairing and apostrophes inside words as letters; the fold chip uses
  it. The echo guard compares whitespace-collapsed text. The keyboard
  shortcuts list still says "Message Claude" for "/" (not the composer).

### Strings for GM (new or changed)

- Reply refusals (agent-facing): see MCP-SETUP; the three lines are in
  person_thread (REPLY_NO_TOKEN_LINE, REPLY_IN_APP_LINE, REPLY_BAD_TOKEN_LINE).
- In-app listener refusal (#223): channel_listeners.IN_APP_TOKEN_LINE.
- CLI: NO_TOKEN_CHANNEL_LINE; the token-file errors in nebula_api.
- Person-facing: the two another-tab lines (r89.3 verbatim), "Message
  Claude Code" when not connected, the cut fold chip.

### Checks

- tsc and lint clean. vitest: 145 files on an explicit list (every test
  that reads files from disk, main's ratchets, every MessageBox,
  personThread, messageBoxLog, personThreadEntry, agentQuestionsStore and
  AgentLog test), 4,052 passed.
- Backend, isolated: 77 files (every test reading MCP-SETUP, SKILL.md or
  the channel, thread, CLI and connect modules, plus round20 fence,
  unprivileged marker, ci shard, cli_api, agent_questions), 2,478 passed,
  9 skipped. `person_gate.py` byte-identical to main in both worktrees.
- Mutations: backend + dropped state 25 of 26 killed (one equivalent);
  frontend (builder) 26 of 27 killed (one equivalent); #223 13 of 13.
- Entry 469,467 B raw / 145,915 gzip (+136 B).
- Live at 1440x900 (8967/5967, isolated, Settings token minted through the
  person route, the real `nebula` CLI and the simulated listener): the
  tokenless reply refused with J1's line; `nebula channel` from the shell
  sees the listener; a token reply through the CLI from another cursor
  session settles the message (replyTo set, same session); the locked
  placeholder "Message Claude Code"; the answered-in-another-tab line, the
  held first Enter and the posting second; a pin answer counted in the
  badge ("1 unread reply") and announced; the cut fold chip "Changed
  “Prompt” on “Hero…”"; a revoke locks the box at once and the CLI's
  token-file error. Five shots, distinct md5s, nothing intercepted.

## Round 4b (coordinator 2026-11-04: a shell reply ends the span; GM r94)

### A reply under the listener's own token ends its span, by any route

- Justin's rule: the deliberate span ends on Claude's reply, and `nebula
  reply` from the listening session's own shell is that reply (the same
  Settings token, so the same identity). Round 4 left it to the 10-minute
  cap, because the listener's feed leaves out its own agent's events.
- The mechanism is #223's (its notes, round 4b, say why this design over a
  polled flag, `self=1` or session matching). The listener's long-poll asks
  for `ownReplies=1`, so `/api/canvas/events` keeps the caller's own
  `thread.replied` and nothing else of its own. The listener ends the span
  on one whose actor is its own agent id (from the beat's answer).
- This branch's part: every saved reply is journaled now, whatever the read
  switch. Narrowed, the event carries only `{replyId}`, an id that says
  nothing of the text (the old form sent no event at all, so a narrowed
  thread would have left the span to the cap). A refused reply (no token,
  in-app, revoked, paced, a bad body, no project) returns before the
  journal, so it can't end the span. Another token's reply has another
  actor id.
- A tool reply's own late event is skipped once by its reply id (#223), so
  it can't end a span a newer message started.
- Docs and help no longer say to answer with the tool: the
  `reply_to_person` docstring, the `nebula reply` help, SKILL.md and
  MCP-SETUP say either route ends the span under your token.
- Tests (test_person_thread_round4, through the real routes, the real CLI
  command with a token file, and a ChannelState fed by
  `/api/canvas/events?ownReplies=1`): a CLI reply under the listener's
  token ends its span (and counts as its call); a paced CLI reply (429) and
  a tokenless one (401) don't, and journal nothing; another token's reply
  doesn't, its own after it does; narrowed, the event keeps only `replyId`
  and still ends the span. The three #223 listener tests, ported to this
  branch's inbox flow (`sent()`).

### GM r94

- F13: a question set this tab no longer holds now holds the first Enter
  too, with "This question is closed. Send again to post your text as a
  message every agent can read." (`GONE_ELSEWHERE_LINE`, cause `gone`); the
  second Enter posts. The same when the set leaves the store while an
  answer is sent. Typed answer text never goes out as a public message on
  one silent Enter. (`QUESTION_CLOSED_LINE`, "This question is closed.",
  is the row's own line and stays.)
- The shortcut sheet's "/" reads `Message ${availabilityLabel(...)}`,
  "Message Claude Code" with nothing connected and the session's cursor
  label otherwise. One source: the availability helpers moved from
  personThreadBox to personThread (already in the first load) and
  `useMessageAvailability` to the store, which the Message box uses too.
  personThreadBox re-exports them. Importing personThreadBox into the sheet
  directly had cost 7 KB of entry (its top-level calls keep it whole).
- A quoted answer that ends its line already ending in . ? or ! drops the
  sentence's period: "You answered “From the other tab.”" and "You chose
  “Keep it?”" (`closingPeriod`, on the last quote only). The typed row's
  words cut short end in the ellipsis, so they keep "”." (`afterCut`).
- Collapsed log: an answer on a pin previews as "Claude Code replied to
  your note". Round 4c (GM r97): the expanded row matches, "Claude Code
  replied to your note on “FLUX.2”", and a canvas note drops "on the
  canvas" ("…replied to your note").
- Agent-facing lines, GM r94 verbatim, each command on its own line:
  REPLY_NO_TOKEN_LINE (three lines), REPLY_BAD_TOKEN_LINE (two),
  REPLY_IN_APP_LINE, the CLI's NO_TOKEN_CHANNEL_LINE (three), the empty
  NEBULA_APP_TOKEN_FILE line; #223's in-app listener line. Codes
  unchanged. A ratchet test pins each.
- Round 4c (GM r97): the token-file failure takes r94's shape, the reason
  as a clause after the variable, the command on its own line: "Nebula
  couldn’t read this agent’s token because NEBULA_APP_TOKEN_FILE points to
  a file that doesn’t exist. Copy a new one from Settings › Connect your
  agent, then run this command." + `nebula mcp connect claude-code
  --channel`. The clause lives on TokenFileError.clause (one per reason);
  str() stays the short reason the MCP server logs.

### Checks (round 4b)

- Backend, isolated: the gate's 77 files, 2,488 passed, 9 skipped; the 45
  files that touch the events journal, 1,644 passed, 9 skipped.
  `person_gate.py` byte-identical to main in both worktrees.
- Frontend: tsc and lint clean; vitest on the gate's 146 files, 4,068
  passed, plus KeyboardShortcuts (4). Entry 470,365 B raw / 146,262 gzip
  (+898 B on round 4).
- Mutations: backend 11 of 11 killed (narrowed reply not journaled, its
  text leaked, the listener ignoring its own reply end to end, any agent's
  reply ending it, the route ignoring ownReplies, a paced reply journaled,
  and each r94 line reverted); frontend 11 of 11 (F13's hold, its send
  race, the gone line, the period rule's three ways, the cut's period, the
  typed row, the collapsed text, the sheet's label). #223's round 4b: 16
  of 16.
- Live at 1440x900 (8967/5967, isolated, the real `serve_channel` listener
  with a Settings token file, the real `nebula` CLI): the shortcut sheet
  reads "Message Claude Code"; the message push opens the span, a
  tokenless shell reply is refused with r94's three lines and leaves it
  open, and `nebula reply` under the token file ends it (the listener's own
  state, read through the harness); an answer "Is golden hour too warm?"
  reads "You answered “Is golden hour too warm?”"; the collapsed log
  previews a pin answer as "Claude Code" / "replied to your note". Three
  shots, distinct md5s, nothing intercepted, no page errors.


## Round 5 (review 3; coordinator D1-D3, adversarially checked; GM r100)

Merged #223's round 5 (c43b3115) as ee0e96fe. The INSTRUCTIONS conflict
kept #223's text and added "the others with reply_to_person" (#223 can't
name a tool it doesn't serve). The budget is still within 4,096 with the
server's instructions.

### D1: a reply names the message it answers, never a session

- `reply_event_data` carries `replyTo` in both forms (narrowed:
  `{replyId, replyTo}`), never a session key or listener id, because
  `thread.replied` reaches every agent's feed. #223's listener decrements
  its count only for an own `thread.replied` whose `replyTo` is a message
  it pushed. Tests from #223 were ported to this branch's inbox flow
  (`sent()`), plus an assert on this branch's INSTRUCTIONS.
- `nebula pin resolve` from the session's shell ends only that session's
  pin span (LOW-2 parity). The route passes the caller's session into the
  journal (#223's `_sessions`), and the test covers one pin pushed to two
  sessions.

### D2: the shell is its listener's session

- `launch_command` adds `NEBULA_AGENT_SESSION="cc-$(uuidgen)"`, after the
  token file and before `claude`. Each shell evaluates it per launch, it
  matches `SESSION_RE`, and the printed text holds no literal id. Two
  launches give two listener ids (live and test) and two cursors labelled
  per session (test).
- `_reply_listeners`: this session's own entry first. Else the agent's
  one fresh listening entry (heard within 25 s, so a crashed leftover
  never blocks). With two or more fresh entries, none: `replyTo` is None
  and the answer's `note` is `reply_unmatched_line` (`nebula reply` prints
  it to stderr).
- The cursor that flies is the taking listener's session (GM r100.1):
  `_person_form(..., session=)`. With no message answered it is the
  caller's own. The echo match (review 3 live MEDIUM-1) follows, because
  the say now comes from the listener's own cursor session.

### D3: one token order

- `nebula_api._token_source` uses the MCP server's order:
  `NEBULA_AGENT_TOKEN`, then `NEBULA_APP_TOKEN_FILE` (unless
  `NEBULA_AGENT_TOKEN_FILE`), then `NEBULA_APP_TOKEN`. `with_identity` and
  `has_token` share it. A bad file fails closed even with a good
  `NEBULA_APP_TOKEN`. The order test is flipped, and new tests cover the
  bad file, `has_token`, the B2 guard (a personal agent's token file
  leaves the app file unread) and the per-path cache (B1).

### GM r100

- q1 is above. The cursor flies on the open canvas, even when the reply
  lands in another project's thread.
- q2: the person's own send springs the thread to the sent row
  (`lib/scrollSpring.ts`, SPRING_SOFT, a jump under reduced motion). The
  person's wheel, touch, pointer or key ends it where it is. Three effects
  had to agree:
  - the r50 jump and the ResizeObserver both skip while the spring runs;
  - the send effect is declared before r50's, so a send's commit springs
    and never jumps;
  - a reduced-motion jump that landed at once leaves nothing marked
    springing.
  The pill stays for agent rows only; the person's send clears it.
- q3: `add_reply` picks the latest accepted message for the session's
  listeners across every project, by (acceptedAt, at), in one store
  transaction. The reply goes to that message's thread. Its `nodeId` is
  dropped there, since the node was checked on the open canvas. With no
  message and no project open it is refused with r100's line (`409
  no_project`), and the pace is refunded. When the project is not the
  open one, `_post_reply_elsewhere` posts a Nebula Update on the open
  project, "Claude Code replied in “Coast”.", with an Open action
  (`thread.open`, a new op in the closed ACTIONS set). The frontend:
  - `receiveRows` counts another project's replies into `unreadElsewhere`;
  - the sync that opens that project makes them its unread (0 when the
    log is open);
  - Open (`lib/threadOpen.ts`, in the Updates corner's deferred chunk)
    opens the project, goes to the canvas and opens the Agent log with
    focus on its header.

### Review 3's LOWs and NITs

- LOW-4: each row has a `rev`, raised by every change (`_bump`).
  `mergeRows` keeps the higher rev. `syncRows` merges a same-project sync
  and keeps rows newer than the snapshot, so a stale sync can't drop a
  received reply or move a message state back.
- LOW-1 (live): `[data-resizing]` lifts the 50vh cap as `[data-sized]`
  does, so the first drag tracks the pointer. Live, the log went from 450
  to 824 px during the first drag.
- NIT-1 (parity): `cutAtWord` keeps a possessive apostrophe that closes no
  quote ("the dogs’…").
- NIT-2 (parity): `channel_status` with no agent token doesn't ask Nebula:
  `token: false`, `listeners: null`, and `detail` is the `nebula channel`
  line.
- NIT-1 boundary / LOW-5 parity: MCP-SETUP quotes r97's token-file line
  and lists its clauses.
- NIT-2 live: the no-project refusal is in because-form (r100).
- NIT-1 live: `has_token` (D3).
- LOW-6 survivors: B1, B2, B6, B7, B13 and F5, F6 each have a test.
- Judgment calls:
  - a pin the person deletes keeps its span until the cap;
  - an empty project name reads "another project" in the Update;
  - the Update's action label is "Open".

### Checks (round 5)

- Backend, isolated: the gate's 18 files, 914 passed. `land_checks`: tsc
  ok, ratchets 161 passed, 29 pytest files with 1,118 passed and 1
  skipped, gate ok. `person_gate.py` is byte-identical to main.
- Frontend: tsc and lint are clean. vitest on the explicit 19-file list,
  239 passed. `pr_tests`: 119 files, 3,873 passed. Entry 476,057 B raw
  (+494 on the committed merge).
- Mutations: backend 24 of 24 killed (23 on the first pass; "node kept
  elsewhere" was then killed by a test added for it). Frontend 21 of 21
  killed (19 on the first pass; the sanitize rev and the spring's own
  scroll events were then killed by tests added for them).
- Live at 1440x900 (8967/5967, isolated, two simulated `serve_channel`
  listeners on one Settings token file, the `nebula` CLI):
  - B's reply left A's span open; A's shell reply closed it;
  - A's shell reply flew A's own cursor, labelled "Claude Code";
  - the person's send sprang through 26 distinct scroll positions to the
    bottom;
  - the first drag tracked the pointer;
  - a reply after a switch to Harbor landed in Coast's thread with
    "Claude Code replied in “Coast”." in Harbor's Updates, and Open
    returned to Coast with the log open;
  - the other way posted "Claude Code replied in “Harbor”." in Coast.
  Five shots, distinct md5s, nothing intercepted, no page errors.

## Round 5b (review 4; the push ledger; GM r108, r110, r112)

Merged #223's round 5b (fa659a0f): the listener's push groups, the
successor wait and `taken_by_another`.

### The push ledger (coordinator decision, adversarially checked)

- **Where it lives.** `services/push_ledger.py`, beside `add_reply` and
  the accepted route, which are both in this PR (#223 serves neither).
  That's the split rule's tiebreak: the shared server ledger goes where
  `add_reply` lives.
- **Keyed by (agent id, raw session)**, never by a listener id or a
  cursor's session key. Both are HMACs under a secret each backend process
  makes, so they change on a restart or eviction.
- **Recording.** The listener reports each push (POST
  `/api/agent/thread/accepted` with `messageIds` and `questionIds`).
  - A message counts when this call accepted it or it was already
    accepted for this agent.
  - A question set counts when the caller asked it and it's answered.
  - A retry with the same id set records nothing.
- **Claiming.** A reply claims the session's OLDEST pickable open push
  whose project still exists. `replyTo` is that push's newest message id,
  else its first question set id.
  - claim, then settle once the row is committed, else release: a failed
    save leaves the push open, and two racing replies take two different
    pushes.
  - Oldest first follows the order Claude Code answers queued pushes in.
- **The cap mirrors the listener's** (`DELIBERATE_SPAN_CAP`, 600 s; a test
  keeps them equal). Once the session's last push is older than the cap
  its pushes are dropped, so a push after a longer gap starts a new
  period.
  - The decision's "periods split where the gap is over the cap" falls out
    of that rule.
  - A separate split loop was dead code (the mutation run showed it), so
    it's gone.
- **Restart.** The ledger is memory only. A listener restarted in the
  same session gets `openPushes` on the first beat of its new nonce. After
  a Nebula restart, the listener sends its groups to Nebula again
  (`groups_to_resend`).
- **Architecture:** sessions are a convenience boundary inside one token,
  not an auth boundary. Any holder of the token can name any session. The
  ledger only keeps one Claude Code's replies from settling another's
  pushes by mistake. (The repo has no ARCHITECTURE.md, so this note is the
  record; the same sentence is in push_ledger's docstring.)

### Where a reply goes (GM r112.2, review 4 MEDIUM-1)

- **Answers a push in another project:** it goes to that project's
  thread, with one "replied in" Update on the open project.
  - `nodeId` is ignored there: no 422, no cursor flies (GM r108 b), and
    the answer's `note` says "Nebula posted this reply in “Coast” but
    didn’t point at n3 because that project isn’t the one open, so your
    cursor stayed where it was."
- **Answers nothing:** a follow-up in the open project's thread, with no
  Update. Ten follow-ups after an answered message post 0 Updates.
- **No project open:** GM r110's refusal (below).

### GM r112.1: one Update per agent and project while unread

- `agent_notes.post_replied` updates the same note id in place, with the
  latest time, moved to the top.
  - "Claude Code replied in “Coast”." becomes "Claude Code replied 3 times
    in “Coast”." from the second reply on.
  - Two projects give two Updates. Once read, the next reply starts a new
    one.
- The agent's 6-a-minute Updates limit applies, shared with its
  post_note. Past it, the Update is left as it is (its count lags) and the
  reply is saved.
- An unnamed project reads “Untitled” (GM r108 d). The Open action now
  carries `replyId`, which `thread.open` requires.

### Routing, nonce and restart (review 4 LOW-4 and the restart probe)

- **The restart probe was real.** The inbox matched `to.listenerId`, an
  HMAC under a per-process secret, so after a Nebula restart a message
  "Sent" before it was never read.
  - Message rows now carry `route` = sha256(agent \0 session)[:32]. The
    inbox, accepted and held routes match by it, falling back to the
    listener id for rows saved before routes.
  - `route` never leaves the backend: it's stripped from the person's and
    the agents' views.
  - Revoke settles in-flight messages by agent id, so it works after a
    restart too, and drops the agent's ledger entries.
- **Nonce:** the inbox, accepted and held routes take `?nonce=` and answer
  409 `listener_session_taken` when another process holds the session.
  The listener sends its nonce on all three.

### GM r108 / r110 / r112 strings and the rest

- **GM r110 / CI fix (eebe52f0):** the refusal, the `reply_to_person`
  docstring, MCP-SETUP and SKILL.md all say "Nebula couldn’t post this
  reply because no project is open. Open one with open_project, then reply
  again.", and say to open the project the message came from, never an
  unrelated one.
  - A sweep test checks SKILL.md, MCP-SETUP, every MCP tool description and
    INSTRUCTIONS for "ask the person to open one". It reads SKILL.md, so
    land_checks picks it up.
- **String 3** is in `reply_unmatched_line`; string 4 came with #223.
  - In both, "this command" is still `nebula mcp connect claude-code
    --channel`: the server can't print the real launch command, because it
    names the person's token file path.
- **String 6:** threadOpen's lines are because-form, with "Try again."
  only where it helps.
  - "this Update doesn’t say which project it’s in" and "its project is
    in Recently deleted" are my reasons for the two cases GM's list didn't
    cover; flagged.
  - The apostrophe ratchet now covers every line an Updates action throws
    (threadOpen, canvas and asset proposal review, goToCanvas,
    AgentNotesCorner); their straight apostrophes are curled.
- **D1:** a module-level store subscription clears a "Back to “X”" toast
  as soon as the open project becomes X, by any route.
- **D2:** Open focuses the reply's row (tabIndex -1 only while it is
  focused).
  - The ring is inset (offset -2px), with 4/6 px of room given back by
    negative margins, so nothing moves.
  - Live: the ring was inside the thread's scroll area and below the
    header.
- **c:** the Open button's accessible name is "Open Claude Code’s reply in
  “Coast”".
- **r112.3:** a pin answer's cursor say folds into the pin reply row.
- **r112.4:** the press writes the rendered height before `data-resizing`
  lifts the cap, and the drag's own bound is the max-height while
  dragging.
- **Test 17:** only a message id a reply names clears messages.
- **Launch command:** `cc-$(date +%s)-$$` replaces uuidgen (POSIX; a test
  runs the printed assignment in `sh`). MCP-SETUP says the command is for
  macOS, Linux and WSL.
- **INSTRUCTIONS:** `reply_to_person` is back in the gated list. "
  (experiment)" was dropped to stay under the 4,096-character cut.
- **NITs:**
  - the MCP-SETUP symlink clause, plus a test that every token-file clause
    is listed;
  - syncRows keeps a row at the snapshot's newest time;
  - `_token_source`'s docstring;
  - unread-elsewhere counts each reply id once.

## GM r115 wording (2026-11-04)
- The reply-elsewhere note says "…because that project isn’t open, so your cursor stayed where it was." ("isn’t the one open" cut).
- A thread whose project is in Recently deleted is a lock, so its line says what unlocks it: "Nebula couldn’t open this thread because its project is in Recently deleted. Restore the project to open it." (`threadOpenLine`'s `unlock` argument).
- Merge with main (#219's person_say): the person's bubble shows the count, the Agent log the named line; the log is dropped only when it would repeat the bubble. GM agreed.

## Round 5c (the final review's push-ledger findings, 2026-11-04)
- **MEDIUM-1:** the ledger's one shared `MAX_KEYS=256` LRU is now `MAX_KEYS_PER_AGENT=8` (as `channel_listeners.MAX_PER_AGENT`): an agent's churn evicts only its own keys. `accept()` counts a re-report of an already accepted message only when the row's `route` equals the caller's (agent and session); the route is stable across a restart, so the restart re-report still works. **Not done:** refusing to record for a session with no live listener entry. After a Nebula restart the listener's `accepted` report can arrive before its first beat has made an entry, and that report is the restart re-report, so the refusal would break it. (a) and (b) close the probe on their own.
- **LOW-1:** the 10 minutes end the protected turn only. The ledger keeps an unanswered push `KEEP_SECONDS` = 24 h (long enough for a session to come back to a task, short enough that a forgotten push doesn't outlive the day), or until answered. Pickable pushes are still the latest period (a gap over the cap to the previous push starts a new one, as before), so an abandoned old push doesn't take a later reply. `open_pushes` (what a restarted listener is told) stays within the cap.
- **LOW-2:** `ListenerBook` remembers listeners that expired, ended (DELETE) or beat `stopped` (`take_gone`); the sweep, the beat and the DELETE route settle those routes' in-flight messages as `dropped` (`PersonThread.drop_route`), which the box already words with `listenerDroppedLine`. No new copy. Round 3 decided a message sent before a lapse still reaches the listener when it comes back, so these rows keep a server-only `lapsed` flag and `revive_route` sends them again when the same agent and session beats `listening` again. A revoked agent's rows (`drop_for`) never come back.
- **LOW-3:** past 64 pushes in a session, answered ones go first, then unanswered ones past the span; 64 unanswered in span refuse the new record. The listener holds a deliberate push (`MAX_OPEN_PUSHES` = 64, held like the runaway cap, goes when a reply answers one or the span ends) so that refusal is only a backstop. The runaway test now answers each push, since 200 unanswered in 200 s is exactly what holds.
- **NIT-1:** `nebula reply --node` prints "Your cursor went to X." only when the saved reply kept the node; otherwise it prints the server's `note`. **NIT-2:** in MCP-SETUP.

## Round 5d (one message, delivered once, 2026-11-04)
- **What was wrong (the round 5c check, MEDIUM-A):** 5c settled a lapsed listener's row as `dropped` ("send it again") and still revived it on a comeback, so a person who resent got two copies, or two sessions got the same request.
- **Three states now.** (1) **Lapsed:** the beat expired, the agent and session may still return. The row stays `sent` with a person-visible `lapsed` flag (`PersonThread.lapse_route`); the box says "{label} stopped listening. It’ll get this message if it reconnects from the same terminal." (`listenerLapsedLine`, GM r117: neutral, no button, no resend wording). When the same agent and session beats `listening` inside the window, `revive_route` clears the flag and the inbox serves the message once. (2) **Dropped (final):** the window ended, the listener ended (DELETE) or stopped on purpose, it was evicted for room (9th session for an agent, or past the overall cap; `ListenerBook._evict` now adds it to the gone list), or the token was revoked. `drop_route` / `drop_for` set `dropped` and clear `lapsed`; only a dropped row shows `listenerDroppedLine`. `revive_route` only touches a `sent` + `lapsed` row of the exact route, so a dropped row never comes back.
- **The window** (as built in 5d, superseded by 5e below: now 10 minutes) was `channel_listeners.LAPSE_WINDOW_SECONDS` = 24 h = `push_ledger.KEEP_SECONDS`. The listener book had no bound of its own (the listener id is an HMAC of agent and session for the backend process, so it never expires). The book keeps `_lapse_until` per (agent, session) and `next_deadline` covers it, so the sweep wakes at the window's end.
- **The race (LOW-A):** the book forgets a lapse (pending or open) the moment the same agent and session beats again, and `main._listener_settle_lock` orders the settle (lapse marks and final drops) against a beat's own settle and revive. A beat that finds its window already ended settles the drop first, then revives nothing. A row can't be dropped while its listener listens inside the window.
- **Also:** `lapsed` is the person's form; agents' `read_thread` never carries it (`_PERSON_ONLY_KEYS`). With the 24-hour ledger keep, a reply Claude sends unprompted hours later is taken as answering the oldest unanswered message and lands in that project. That is by design.
- **Not changed:** `person_gate.py`, the gate, read boundaries, the spend guard. The box's status line sits in the thread's existing layout; a height change when a lapsed line becomes the dropped line is not animated separately (the thread's scroll spring handles the position). Flag if GM wants a dedicated height spring.

## Round 5e (lapse window, the row's height spring, 2026-11-04)
- **The lapse window is 10 minutes, not 24 hours** (coordinator's decision). `channel_listeners.LAPSE_WINDOW_SECONDS = push_ledger.DELIBERATE_SPAN_CAP` (600 s); `push_ledger` rather than `mcp_channel` so the listener book doesn't import the channel server (a test pins that the two caps are equal). A lapse means the process stopped beating; beats go on while Claude works, so it isn't a long task. With 24 hours a killed terminal would leave the person reading "…It’ll get this message if it reconnects…" for a day. Ten minutes covers a quick reconnect; then the row drops for good and a resend is offered, so still never a double delivery. `push_ledger.KEEP_SECONDS` (24 h, reply matching) is unchanged. Ratchet: `test_the_lapse_window_is_the_sends_span_cap`. MCP-SETUP.md states the window beside the dropped-row paragraph.
- **A status line's height change springs (GM r117).** `StatusView` (MessageBox.tsx) wraps the line in `.message-box__status-wrap`, which holds the line's measured height (layout effect plus a ResizeObserver on the line, ignoring a 0 from a hidden ancestor) and transitions it: `height 420ms var(--agent-log-spring)`, the box's own spring; reduced motion lists it with `transition: none`. The first measure goes from `auto`, so a row arriving doesn't animate; only a swap (lapsed to dropped, sent to delivered, any text change) does. The line's 4px gap moved from `margin-top` to `padding-top` so the measured height includes it. The box's existing size observer (`size` ref, `springScrollTo` path) keeps a thread read at the bottom pinned while the height moves. A line appearing from nothing or going to nothing is not animated (not asked).
- **Tests** (`MessageBox.r5e.test.tsx`): the wrapper's CSS carries the transition; reduced motion has `none`; the lapsed and the dropped lines both sit in the wrapper holding their measured heights; the thread stays at the bottom across observer callbacks as the content grows. Mutations: removing the transition fails the CSS test; dropping the inline height fails the wrapper test. Both restored.
