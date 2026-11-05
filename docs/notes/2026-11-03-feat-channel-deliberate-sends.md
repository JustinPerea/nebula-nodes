# feat/channel-deliberate-sends

PR A for the agent-canvas demo (Justin's top priority, 2026-11-03): the
channel foundation the Message box (PR C) builds on. Brief:
`demo-prA-channel-brief.md`; GM's box spec r50, "Pacing", "Unavailable and
failure states" and "Recipient".

## Decisions taken here (not in the brief)

- **A deliberate push ends a gated window.** The brief says deliberate sends
  skip the gated-window hold and are never refused for pacing. The only
  refusal Nebula makes is the Q42 gate (`tool_started`), so a pin or message
  pushed into a window that kept running would have had its own turn's edits
  refused. `_take_deliberate` sets `_window_at = None`. The cost, documented:
  a change turn still running when it goes is freed to edit (Claude Code
  queues the push for the next turn). A request typed in the terminal is
  still refused inside a window: Nebula can't see the terminal. Docs say so.
- **The pin's 1 s merge stays.** It is batching, not pacing, and the brief
  named only min_gap, window_min and the gated-window hold. A message and an
  answer have no merge.
- **Everything passive rides along, however recent.** Before, a pin batch
  left edits from the last 8 s for a gated push of their own. The brief says
  waiting passive items ride along, so the deliberate push takes all edits,
  every proposal decision (gated ones too) and every run end. The test that
  pinned the old rule is turned round
  (`test_an_edit_made_just_before_a_pin_goes_rides_with_it`).
- **Deliberate pushes never enter `_history`.** Their own deque
  (`_deliberate_history`) for the 200/hour cap. So a passive push keeps its
  30 s spacing from the last passive push, never from a message (tested).
- **At the cap, a waiting pin stops holding gated pushes** (`_pins_wait`
  checks the cap). Otherwise a capped pin would hold edits for up to an hour.
- **The meta wake of a deliberate push** is the most specific thing it
  carries: `message`, else `answer`, else `pin`. INSTRUCTIONS name all three
  (4,070 of the 4,096 characters with the server's own instructions).
- **Answers are read back, never journaled.** `question.answered` carries only
  the set id (agent_questions: the typed text is never journaled). The
  listener reads the set with `GET /api/canvas/questions/{id}` as the asker
  (owner-only route) in a task of its own (4 s bound), then pushes it. A
  failed read still pushes, saying to call `get_answers`. "Own" is per
  session: sets this process's `ask_person` made (like own proposals). A set
  the agent waits for in `get_answers`, or has read, never pushes.
- **`person.message` is addressed by `listenerId`,** a random id Nebula gives
  each listener entry (`ch_<16 hex>`), not the session key or raw session:
  the journal is readable by every agent, and session keys are the person's
  form only. Text is cleaned like a pin's (multiline kept), 2,000 chars max.
  The event's text is in the journal like a pin's; PR C decides whether that
  is right for the box (the GM spec has every session's rows on the thread).
- **Readiness lives in the backend** (`services/channel_listeners.py`): the
  listener beats every 15 s from a task that runs for the whole session (so
  "stopped" stays visible after the listener ends), DELETEs at session end
  (shielded, 1 s), and lapses after 45 s. Not connected = no entry.
- **`--channel` doesn't ask before writing.** The listen file is Nebula's own
  session-only file; an unchanged file isn't rewritten and other servers in
  it are kept. With no token given it reuses the token file the config
  names, so the GM "Copy command" line (`nebula mcp connect claude-code
  --channel`, no token flag) works on a second run.
- **MCP parity:** a new read tool `channel_status` (in CHANGE_TURN_TOOLS and
  NEBULA_MCP_TOOLS), not a new part of `start_here` (its size is budgeted).

## Not done / for PR C

- The route that posts a message (`person.message`) and `reply_to_person`.
  PR C should refuse at the route when the cap is hit (the backend can count
  per listener; the listener holds, never drops, the 201st).
- `question.dismissed` doesn't wake (the brief named only answers).
- No frontend changes: tabs receive `channelListeners`; the store is PR C's.
- Nebula can't tell whether Claude Code delivers a push (dev flag missing,
  Team org switch off): "listening" means Nebula pushes. Documented.

## Tests

- `backend/tests/test_mcp_channel_deliberate.py` (new): the brief's cases on
  the fake clock, plus messages, answers and the listener's read-back.
- `backend/tests/test_channel_readiness.py` (new): states, sessions, TTL,
  tab messages, gates, MCP `channel_status`.
- `backend/tests/test_agent_connect.py`: `--channel` connect, twice,
  disconnect, legacy token, refusals, print, parser, copy rules.
- `backend/tests/test_mcp_channel.py`: 29 tests encoded the old pin pacing
  (pins waiting for min_gap and the window). Each was rewritten to the new
  rule, keeping its probe's intent where it still applies (passive limits now
  tested with edits; fuzz invariants exempt deliberate wakes from "ungated
  into an open window").
- Named isolated run (60 files: the channel, connect, readiness, MCP tool,
  MCP-SETUP and three ratchet files): 1,897 passed, 1 failed. The failure,
  `test_a_person_tab_gets_the_replay_on_its_hello_and_no_one_else_does`, was
  real: the agentPresenceReplay must stay the last hello sync. The
  channelListeners sync now goes after questionsSync, before the person's
  pins, and that file passes.
- Mutation check of the deliberate/passive split (12 mutants on
  `mcp_channel.py`, against the deliberate and channel test files): 11
  killed. The survivor, "a passive push ends a window too", is equivalent:
  an ungated passive push only goes when no window is open.

## Round 3 (review 1 of #225, the channel half)

- **HIGH-1 (two lenses rated it MEDIUM): a deliberate push starts an
  ungated-turn span.** `_take_deliberate` cleared the window but left no
  trace of the turn it started: the push never entered `_history` and never
  touched `last_call`, so the agent still read as idle, and a gated change
  push 8 s after a nudge opened a window inside the message's own turn
  (probe P6: message at 100, nudge at 101, change push at 109, the turn's
  `edit_canvas` at 112 refused). Now every ungated push (a deliberate one,
  and an accept or its own run's end, which had the same gap) sets
  `_turn_at`; `_ungated_turn` reads it with the window's own heuristic
  (`_turn_end`, factored out of `_window_end`: at least `window_min` after
  the push, `window_idle` after its last call, never while a call runs).
  While it is open no gated push goes (`_ready`, `take_push`'s ride-along
  and `next_check`'s gated times). An ungated push due meanwhile (an
  accept) still goes, without the edits (they would gate it).
- Chosen over the reviewers' minimum (`last_call = at`), which still lost
  when Claude thought for more than 20 s. The gap that stays: past the
  first minute, a pause of more than 20 s with no Nebula call reads as the
  turn's end. Module docstring and MCP-SETUP say so.
- Cost, accepted: after an accept or its own run's end, a gated change now
  waits up to a minute (the turn's guess) instead of the 30 s spacing.
- Tests turned round (each to the new rule, intent kept): the pin-never-
  waits probe (171.5 / 205 instead of 145 / 180), the failing pin check
  (the edit at 160.001), the cap test (61.5), the passive-limits test (a
  short turn heuristic so it still measures the 30 s spacing), the mixed
  batch (a short heuristic so both still meet at the spacing), and the live
  `test_a_pin_and_an_edit_reach_the_session_and_the_gate_holds` (now the
  edit first, gated and refused, then the pin, which frees the turn).
- New: P6, a turn that keeps calling, a call running in the turn, the pin
  and accept variants, and an accept inside the message turn going without
  the edits.
- **LOW-3 survivors pinned:** 101 messages in one read (counted, "81 more
  messages not listed", never dropped) and a `person.message` from an agent
  actor (never wakes).
- **NIT-1 (reply_to_person in the gated wording)** belongs to #225, where
  the tool lives.
- Mutations (deliberate + channel files): 8 mutants on the span and the two
  survivors, 8 killed. The one that first survived (take_push's ride-along
  ignoring the span) is now killed by the accept-inside-the-turn test.

## Round 3, item N (Justin, 2026-11-03: channel listeners require a token)

- `POST/DELETE /api/agent/channel` (`main._channel_caller`) take only a
  verified identity, which only a valid agent token gives. A name alone
  gets `401` with GM r81's line and `X-Nebula-Code: listener_no_token`. An
  unknown or revoked token is stopped earlier, by the token middleware
  (`agent_workspaces.AgentWorkspaceContext`); for this one path it now
  answers with r81's "isn’t valid anymore" line and
  `listener_token_invalid` instead of its generic line. The route's own
  "token presented" branch is unreachable today (any token the middleware
  passes is verified): a mutation there survives as equivalent.
- The identity is the token's, so a name header beside one agent's token
  never registers it as another (tested).
- With no tokenless listener, the LRU half of boundary LOW-1 is closed in
  `channel_listeners.py`: ids are an HMAC of (agent, session) under a
  launch secret (a lapse or eviction keeps the id), and entries are capped
  per agent (8) as well as in all (64).
- The MCP server prints the refusal once on stderr after "error: " and
  `channel_status` shows it as `thisServer.registerError`. The listener
  keeps running (pins and edits still reach it through the journal, as on
  main); only the person's messages, which name a listener id, can't.
- End to end: `tests/test_agent_connect.py` makes a Settings token, reads
  its token file the way the server does at start (NEBULA_APP_TOKEN_FILE),
  and runs the server's own beat against the app: registered and verified.
  Tokenless: refused, one stderr line. Revoked: r81's second line.
- Mutations: 6; 4 killed at first, the stderr-once mutant killed after the
  test ran three beats, the token-presented branch equivalent (above).

## Round 4 (review 2 of #225, Justin 2026-11-04)

- **J4, the deliberate span ends on the reply.** A deliberate push (message,
  pin, answer) opens a span (`_turn_at`, now with `_reply_due_at`) that no
  gated push crosses until this session's own reply reaches the person, or
  `DELIBERATE_SPAN_CAP` (600 s, the `deliberate_span` limit) after the push.
  It replaces the 20-second-idle end for that span (review 2 LOW-5: a 70 s
  think with no Nebula call no longer lets a gated push refuse the turn's
  edit). Passive ungated spans (an accept, its own run's end) keep the
  window heuristic and never shorten a deliberate one. A later deliberate
  push restarts the cap.
- **What counts as the reply** (decision not in the brief): a saved
  `reply_to_person` (`{reply}`) or a saved `resolve_pin` (`{pin}`). A pin's
  answer is its reply in the Message box (a pinReply row, which GM r89.1
  now counts as a reply), and the push tells Claude to answer a pin with
  resolve_pin; without it a pin's span would hold the person's edits for 10
  minutes every time. A refused or failed call doesn't end it. Another
  agent's reply doesn't (only this process's own tool calls are seen), and
  neither does `nebula reply` from a shell: the listener's feed leaves out
  its own agent's events, so the cap ends that span. MCP-SETUP says to
  answer a push with the tool.
- After the reply the next gated push gates as before, which includes the
  usual `agent_quiet` (20 s) after the agent's last call.
- **J3:** `_channel_caller` refuses a verified in-app turn token
  (`agent_registry`) with 401 `listener_in_app_token` and a line in r81's
  form (copy for GM below). Only `app:` identities listen.
- **Boundary LOW-1:** revoking an app in Settings drops its listener
  entries at once (`ListenerBook.drop_agent`) and broadcasts
  `channelListeners`. Settling that listener's messages in flight is #225's
  (the thread lives there).
- **Boundary NIT-2:** MCP-SETUP and `channel_status` no longer say
  `--channel` makes the token: it reads the file Settings saved.
- Tests turned round to J4 (intent kept, each now replies, then measures
  the gated push 20 s after the reply): P6, the turn that keeps calling,
  the call in flight, the pin turn (ended by resolve_pin), the cap test,
  the passive-limits test (`deliberate_span=2`), and test_mcp_channel's
  pin-never-waits probe (the edits now go at the cap, 711.5). New: the long
  quiet for message, answer and pin; the reply ends it; a refused reply,
  another tool or a failed resolve_pin doesn't; another agent's
  thread.replied doesn't; the cap; next_check at the cap; a later message
  restarts the cap and an accept never shortens it. Readiness: the in-app
  token refused on POST and DELETE; revoke drops only that app's entries
  and tells the tabs.
- Mutations: 13 of 13 killed (span heuristic, reply no-op, refused reply
  counts, passive push shortens, cap not restarted, resolve_pin left out,
  next_check, cap off, J3 check off, prefix ignored, revoke keeps, drop
  takes every agent, no broadcast).
- Gate: 51 named files isolated (every test that reads MCP-SETUP, SKILL.md,
  mcp_channel or channel_listeners, plus round20 fence, unprivileged
  marker, ci shard, cli_api, agent_questions): 1,721 passed, 9 skipped.
  `person_gate.py` untouched.

## Round 4b (coordinator, 2026-11-04: a shell reply ends the span; GM r94)

- **The gap closed.** `nebula reply` from the listening session's own shell
  carries the same Settings token, so it is the same identity and Claude's
  reply. It used to leave the span to the 10-minute cap, because the
  listener's feed leaves out its own agent's events. Now the listener learns
  of every reply saved under its token, whatever the route.
- **How, and why this way.** The listener's long-poll sends `ownReplies=1`.
  `/api/canvas/events` then keeps the caller's own events of one kind only,
  `thread.replied` (`canvas_events.OWN_REPLY_KIND`, a `keep_own` set on
  `matches`/`read`/`wait`). The listener ends the span on a `thread.replied`
  whose actor is an agent with its own id (`ChannelState.agent_id`, set from
  the beat's answer, `listener.agent.id`, the `app:<id>` of its token).
  Considered and rejected:
  - A per-listener "replied" flag the listener polls: a second channel to keep
    in step with the push loop, and it misses the order of events.
  - `self=1` on the listener's poll: its own edits would reach its feed and
    read as the person's changes.
  - Matching on the reply's `session`: shell calls carry no MCP session, and
    the token is already the identity Justin named.
  Why it holds: a refused reply (no token, paced, a bad body) is never
  journaled, so it can't end the span. Another token has another actor id.
  A reply made before the listener has registered (`agent_id` None) ends
  nothing. A journal gap loses the event and leaves the span to the cap,
  which is the safe direction.
- **The tool's own event.** A tool reply ends the span when its answer
  comes back, and its `thread.replied` arrives a moment later. If a newer
  message had started a new span meanwhile, that late event would end it.
  The tool's reply id is remembered (`_tool_reply_ids`, at most MAX_OWN),
  and its event is skipped once.
- A shell reply also counts as the agent's call at that moment
  (`last_call`), like the tool's. The next gated push waits `agent_quiet`
  after it.
- `thread.replied` is PR C's kind. On this branch the tests add it to
  `EVENT_KINDS` with monkeypatch. PR C must journal it for every saved
  reply, with the `replyId` even when the thread is narrowed.
- An older backend refuses `ownReplies` (422, unknown parameter). The
  listener and the backend ship from the same repo, so that pairing doesn't
  happen.
- **GM r94:** the in-app listener line now reads "Nebula couldn’t connect
  this listener because it uses an in-app agent’s token, and only a token
  from Settings › Connect your agent can listen. Copy one there, then run
  this command again." Constant, readiness test and MCP-SETUP updated.
- Docs: MCP-SETUP's J4 paragraph no longer says to answer with the tool,
  and `ownReplies` is listed with the events query.
- Tests: the route keeps only the caller's own `thread.replied` with the
  opt-in (and wakes a waiting poll); the poll sends it; the beat sets
  `agent_id` (none without a token); an own shell reply ends the span;
  another token's reply, a person-kind actor or an unregistered listener
  don't; the tool's late event doesn't end a newer span, but a later shell
  reply does.
- Mutations: 16 of 16 killed (own reply ignored, any agent ends it, None id
  matches, kind check dropped, tool id not remembered, dedupe skips all,
  not counted as a call, poll param dropped, beat id not set, keep_own
  keeps all, keep_own ignored, route ignores or always applies the opt-in,
  wait drops it on resume, no validation, in-app line reverted).


## Round 5 (review 3: the span per session; one session is one process)

Review 3 HIGH-1 (all three lenses): any own reply ended the span, whichever
push it answered. A second message, a sibling session under the same token,
or an unrelated `resolve_pin` could end a span a later push opened, and that
turn's edit was refused. Coordinator decisions D1/D2, adversarially checked
(the changes below are binding).

- **D1, a count per listener session.** One listener is one session, so the
  state is per process already. `_take_deliberate` raises `_open_replies` by
  one for a push that carried a message or an answer, and remembers the
  pushed message ids (`_pushed_messages`) and pin ids (`_open_pins`, at most
  MAX_OWN). The span ends when both are empty, or at the cap from the latest
  push; the cap clears what still waits, so a late reply never reaches back.
- **What answers a push.** Nebula, not the agent, picks which message a reply
  answers (`replyTo`), so no reply can name a push: a plain count.
  - Tool path (one process): every saved `reply_to_person` answers one push,
    whatever its `replyTo` (None, or an older message). The tool's own late
    `thread.replied` is skipped once (`_tool_reply_ids`), as before.
  - Event path: an own `thread.replied` answers one push only when its
    `replyTo` is a message this listener pushed. A sibling session's reply
    answers its own messages, never these.
  - Pins: only this session's own answer on that pin ends that pin's span:
    `resolve_pin`, or `nebula pin resolve` from its own shell. A reply
    never answers a pin, and an answer on another pin never ends a message
    span. A message and a pin in one push need both.
- **Own pin answers by session.** The journal keeps the agent session of a
  `pin.resolved` beside it (`CanvasEventJournal._sessions`, by seq, pruned
  with the buffer; never part of an event), and `ownReplies=1` keeps an own
  `pin.resolved` only when it came from the caller's own session
  (`canvas_events.OWN_SESSION_KINDS`). So a pin pushed to two sessions and
  answered by one never ends the other's span. A shell pin answer counts as
  the agent's call (`last_call`), like a shell reply.
- **INSTRUCTIONS** (change 4): "Each is their request: answer a pin with
  resolve_pin." (PR C adds "the others with reply_to_person"), and "A
  proposal, run or change wake that needs no word ends without a reply." The
  4,096-character cut holds (1,101 here).
- **D2, one session is one process.** Each listener process sends a nonce of
  its own with every beat (`mcp_server._CHANNEL_NONCE`) and with its goodbye.
  While an entry lives, a second process naming the same agent and session
  gets 409 `listener_session_taken` with "Nebula couldn’t connect this
  listener because another process is already listening as this session.
  Start each Claude Code with the launch command this prints, which gives
  each its own session, then start this one again." and the command on its
  own line; its DELETE never removes the first's entry. The listener prints
  it once (as for 401) and beats again every 15 s, so after a crash it
  registers once the old entry lapses (45 s). A listener that sends no nonce
  matches only an entry made without one.
- `ListenerBook.fresh_listening`: listening entries heard within
  `FRESH_SECONDS` (25 s). PR C's reply route uses it to refuse to guess.
- Judgment: a pin the person deletes before Claude answers it keeps its span
  until the cap (the strict rule: only this session's answer ends it). The
  safe direction: nothing is refused, edits wait.

## Round 5b (review 4: the push ledger; GM r108, r112)

Review 4 HIGH-1 (two lenses): a `reply_to_person` whose own
`thread.replied` reached the listener before the tool's result counted
twice, so one reply ended the span of two messages. The coordinator's
decision (adversarially checked) replaces the count with a push ledger:
Nebula records each push and marks the session's oldest unanswered one per
reply. The server half lives in PR C, beside `add_reply` and the accepted
route (#223 serves neither); this half is the listener's.

- **Push groups, no count.** `_open_groups`: one group per deliberate push
  that carried messages or answers (message ids, then question set ids, in
  push order), `confirmed` once Nebula recorded it. `Push.group` and
  `Push.question_ids` carry them to PR C's accepted call. `_open_replies`,
  `_pushed_messages` and `_tool_reply_ids` are gone.
- **What answers a group.** An own `thread.replied` removes the group that
  holds its `replyTo`, else nothing (never a fallback). The tool's result
  does the same; when its `replyTo` names no group and isn't one already
  answered (`_answered_ids`, so its echo coming first is harmless), Nebula
  never heard of the push, and the oldest unconfirmed group is answered.
  So one reply answers one push in either order.
- **A journal reset** (Nebula restarted, its ledger with it) marks every
  group unconfirmed and `groups_to_resend` hands them to PR C's listener
  once. **The first good beat** (`ChannelState.beat_answered`) takes
  Nebula's `openPushes` once per process: a listener restarted in the same
  session starts with those groups, confirmed, and the span from the
  latest. `beat_answered` returns True on news (first beat, a new listener
  id), and the beat loop then nudges the listener.
- **GM r108 a:** the person deleting a pin this session was pushed ends
  its span (`pin.removed`).
- **GM r112.5, a successor on the same session** (review 4 live LOW-1): a
  409 `listener_session_taken` is first taken for a restart's leftover
  entry. The listener prints "Nebula is waiting for this session’s previous
  listener to time out, then this one connects by itself." once, shows
  nothing (no `registerError`), and asks again every 5 s. Past 60 s still
  refused, it is a real second process: Nebula's line (GM r108 string 4)
  then goes to stderr after "error: " and to `channel_status`.
- **NIT-2:** a refused or unanswered beat is tried again every 5 s
  (`CHANNEL_RETRY_SECONDS`), not every second; the docs say so.
- **NIT-3:** `FRESH_SECONDS` is two beats plus a beat's timeout (35 s), so
  one missed beat never makes a live listener stale. A crashed leftover
  can then count as fresh for 35 s instead of 25 s, which only matters to
  a terminal started without the launch command's session.
- **LOW-4 (helper):** `ListenerBook.taken_by_another` for PR C's inbox,
  accepted and held routes.
- GM r108 string 4 is in `SESSION_TAKEN_LINE`. The command on its own line
  is still `nebula mcp connect claude-code --channel` (the server can't
  print the launch command: it names the person's token file path).

Checks: see the PR body's Round 5b section.
