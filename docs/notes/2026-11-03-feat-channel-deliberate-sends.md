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
