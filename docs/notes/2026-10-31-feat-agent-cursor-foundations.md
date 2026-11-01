# Agent cursor, foundations (feat/agent-cursor-foundations, 2026-10-31)

Phase 1 of the redesigned agent cursor: GM - Design's cursor spec, §3, §4 and §6 item 1. Justin asked for Cua's form of expression and movement, not a copy, with today's calm timing. None of Cua's artwork, palette, constants, names or frames is used; the numbers are GM's.

## The decisions, and how each was built

1. **Where a session comes from.** In-app chats: Nebula's own chat session, from the agent token's record (never the agent). An MCP server: one random id per process. The CLI: `NEBULA_AGENT_SESSION` if set, else a hash of `CLAUDE_CODE_SESSION_ID` (verified in a real Claude Code Bash call), else none (one cursor per agent, as before). Details under "Sessions". Chat titles don't exist in Nebula yet, so in-app chats are numbered like every other client.
2. **Display only.** The session is read in `presence_session` and used only by `person_form` and the slot table. Identity, colour hue, the person gate, scene keys, spend and the token mint never see it. Validation: optional, at most 64 of `[A-Za-z0-9_.:-]`, else dropped. Tabs get a 12-hex HMAC key, never the raw id.
3. **Numbering (changed in round 2, GM's review).** Among live sessions: a new session takes the lowest number no live session of its agent holds, and the plain "Claude" counts as 1. A live session keeps its number until its cursor leaves, so nothing renumbers under the person. The backend is the one place that numbers; tabs show its number and drop a cursor whose number the backend has given to another (that cursor has left). At most 8 live sessions per agent; the oldest idle one goes first, else the oldest. The frontend store caps at the same 8. Round 1 numbered by first appearance for the backend's life, which let a lone chat read "Claude · 4" after a few /clears.
4. **Read boundary: holds.** What agents read is byte-identical apart from the action values they send themselves. Evidence under "The read boundary", plus the live check below.
5. **Actions at the boundary.** The route, MCP `point_at` and the CLI's `--action` refuse anything but the ten with GM's sentence, which echoes the bad value: `“hover” isn’t an action Nebula knows. Use one of move, look, think, type, click, drag, run, propose, wait or error.` The frontend reads an unknown action as `move`.
6. **Emitters.** Table under "The backend's own edits". Any param value change shows `type` on person tabs, whether it comes through PUT, edit_canvas or apply; a rename stays `click` (GM, round 2). The shown action reaches person tabs only; agents keep reading what they did.
7. **Agent surface.** `point_at` has the action list in its docstring; `nebula point --action` takes the ten; `docs/MCP-SETUP.md`, `skills/nebula/SKILL.md` and the README are updated in this change.
8. **Copy limits.** No Cua artwork, palette, constants, names or frames. Every number is GM's or derived from GM's.
9. **First load.** The planner and the look rules live in the deferred `AgentCursorLayer` chunk (4.0 KB on main; 18,488 B after round 3). The entry grows by the presence store's session handling (keying, drop-by-number, the 8 cap, `cleanSession`, `cursorAction`, the replay): +1,161 B raw over main after round 3 (+514 in round 1, +622 in round 2). The ten-action list (86 B) sits in the `wsClient` chunk, 2,362 → 2,448 B, which index.html preloads but the budget script doesn't count, so true first-load growth is about 1,247 B. Figures under "Gates".

## The ten actions

- One list, in this order everywhere: `move, look, think, type, click, drag, run, propose, wait, error`.
  - `backend/services/cursor_actions.py` holds it. It has no imports, so the CLI's `--action` choices don't load `agent_presence` (about 65 ms per call).
  - `frontend/src/lib/agentPresenceActions.ts` is the frontend copy, re-exported by `wsClient.ts`. It's a module of its own because many tests mock `../src/lib/wsClient` with only `wsClient`. A value import from wsClient would throw under those mocks.
- One refusal sentence, GM's (round 2), built by `cursor_actions.refusal(value)`: `“hover” isn’t an action Nebula knows. Use one of move, look, think, type, click, drag, run, propose, wait or error.` It echoes the value the agent sent (a non-string as its JSON), cleaned and cut (review 2, LOW-1): a lone surrogate, a control character (ESC and its terminal sequences, NUL), a format character (zero-width, the bidi overrides such as RLO) or any other Unicode C* code point becomes U+FFFD, and the cut at 40 characters (`text_cut.safe_cut`) never splits a character, so an emoji ZWJ sequence stays whole or goes whole. A 100 KB value is only read to 160 code points. Round 2's echo let a lone surrogate turn the route's 422 into a 500 and passed ESC and RLO through to MCP and CLI output. The one function serves the route, MCP and the CLI, and a test drives each.
- `POST /api/canvas/cursor` refuses any other value with a 422 and that sentence. A non-string value gets the same 422.
  - The route checks the action before `_pointed`. Before this change, a list or object `action` reached `_pointed`'s dict lookup and failed with a 500.
- MCP `point_at` keeps `action: str = "move"` (no `Literal`), so the agent gets Nebula's own sentence rather than pydantic's report, prefixed `point_at: `. It refuses before any request. The docstring says what each action means.
- The CLI's `nebula point --action` checks with a type function that raises the same sentence; its metavar lists the ten. The default is unchanged: `drag` with `--from`, else `move`.
- The frontend reads an unknown action as `move` (`cursorAction` in the store), so a newer backend never breaks an older tab.
- The Agents panel's verb for a bare point is unchanged: only `move` and `look` name one. The eight others name nothing, so the agent's previous action carries, as `click` and `drag` already did. New panel verbs would be GM's copy.

## Two forms of one cursor event

The backend now builds two forms of each cursor event.

- **Agent form.** It is what `point()` returns and stores. It goes to every socket that isn't the person's canvas, and it is what `active()`, the snapshot, the roster and the start bundle read. It's the same as before, key for key and in the same order. The only difference: `action` can be any of the ten, and only when the agent sent that value itself.
- **Person form.** `AgentPresence.person_form` builds it, and it goes only to `manager.browser_connections` (the sockets a verified hello promoted). It is the agent form with up to three changes:
  - `action` is the shown action, the action a backend edit really was;
  - it gains `session: {key, ordinal}`;
  - for a line said in place, `target` is that session's own cursor.
- A failure building the person form never silences the agent form or fails the route (round 2): `main._person_form` logs it to `nebula.presence`. The person's tabs then get the agent form with this session's real number when its cursor is already live (`AgentPresence.session_tag`, a read that makes no slot), else nothing for that event (review 2, NIT-3). Never the bare agent form: a tab reads an event with no session as the plain cursor, number 1, and would drop whichever session holds 1. No input is known to make `person_form` fail; this is the guard's shape, tested with a forced failure.
- Since round 3 every person form carries `session`, so `_broadcast_presence` calls `broadcast_raw(person, others=event)`, the split that already exists for the person and other sockets. With no person form (the failure above) it calls `broadcast_others(event)`. The agent-log-only events (no target) have one form and use the one-argument call.
- Target-less events (`_say_agent_action`, the Agent log only) have one form, and they never create a session slot.

## Sessions

- **Where a session comes from** (`presence_session`, first valid one wins):
  1. An in-app chat's agent token. Its registry record has `session`, the workspace session id that Nebula sets when it mints the turn token, never the agent. It becomes `chat:<id>`.
  2. `X-Nebula-Agent-Session`. It is the MCP server's one-per-process `secrets.token_hex(8)`, or `NEBULA_AGENT_SESSION`. The header already existed for scene reads; presence only reads it.
  3. `X-Nebula-Cursor-Session`, a new header that only presence reads. The CLI sends `cc-<sha256(CLAUDE_CODE_SESSION_ID)[:16]>` when `NEBULA_AGENT_SESSION` is unset.
     - I checked the variable in the real environment of a Claude Code Bash call. A subagent sees its parent's value, and no per-subagent id exists, so a session and its subagents share one CLI cursor unless each lane sets `NEBULA_AGENT_SESSION`. The docs say so.
     - `CODEX_COMPANION_SESSION_ID` is also present, but it is copied from the Claude id, so it isn't used. No Codex session variable is verified.
  4. None. That gives one cursor per agent, as before.
- **Validation.** Every source must match `^[A-Za-z0-9_.:-]{1,64}$` (`cursor_actions.SESSION_RE`, the one copy the backend, the CLI and the MCP server read). Anything else is dropped, and the next source is tried.
  - **An invalid `NEBULA_AGENT_SESSION` counts as unset for the cursor** (review 2, NIT-1; the docs said so, the code didn't). The CLI and the MCP server still send it as given in `X-Nebula-Agent-Session`, so scene-read keys (which take any value up to 80 characters) are exactly as before. When it isn't a valid cursor session, the CLI also sends its Claude Code session in `X-Nebula-Cursor-Session`, and the MCP server its own per-process id, so the cursor is the one an unset value gives. Round 2's CLI skipped the cursor header whenever the variable was set, valid or not, so an invalid value landed on the agent's plain cursor.
- **Display only.** The session is read in `presence_session` and used only by `person_form` and the slot table. It never reaches:
  - `identify()` or `AgentIdentity`;
  - the colour;
  - `person_gate` (its `AGENT_MARKER_HEADERS` are unchanged);
  - `scene_keys`;
  - `agent_spend`;
  - the token mint.
  - The CLI never puts its derived value in `X-Nebula-Agent-Session`, because that header keys scene-read guards.
- **The key.** It is `hmac_sha256(per-process secret, agent id + "\0" + raw)[:12]`. It's opaque, it differs per agent and per backend process, and it never contains the raw id.
- **Numbers** (round 2). A session's slot is made on its first event with a target, with the lowest number none of its agent's live slots holds. The slot keeps that number while it lives. The no-session cursor takes part too, and counts as 1 when it holds 1. Since round 3 (GM) every event a person tab gets carries `session: {key, ordinal}`, the plain cursor's too, so a tab never works out a number for itself; the agents' form never carries it.
- **When a cursor leaves** (its number is then free). The backend and the tab use the same rules:
  - no event for 120 s: the backend's `PRESENCE_TTL_SECONDS`, the tab's `AGENT_CURSOR_EXPIRE_MS` (a test reads both files and pins them equal, with the idle time and the cap);
  - its node anchor goes: `forget_graph` (the canvas cleared or replaced, as a /clear that clears the canvas does) drops every slot on a node, and `forget_node` drops a slot whose node is deleted before the tab ever reported where it was drawn. A node deleted after that re-anchors its cursors where it was, and they stay (review 2, NIT-2: the docs said any delete). Both match what happens to the agent's own cursor in `_agents`, and the tab's `forgetGraph`. The tab doesn't drop a cursor on a node delete; it drops it when another session of the agent takes its number, or at 120 s. `docs/MCP-SETUP.md` now lists the four cases exactly;
  - the cap pushes it out (below).
  - The backend drops expired slots lazily, on the agent's next event, which is the only time a number is given.
- **Replay on connect** (round 3, GM). When a person tab's hello is verified, the backend sends that tab alone `agentPresenceReplay`: every live cursor's latest person form (session, number, agent, last target, action, say), oldest first, each with `replay: true` and `secondsAgo`. A drag's `from` is left out, and a node that went is gone from it as from the agents' copy. It is the last of the syncs a verified hello gets, built at that moment, so it holds every cursor event already sent to the socket. The tab replaces its cursors with the list (cursors it drew from the agents' form before its hello are the same cursors under another key, so a reconnect never doubles one), draws each where it is with no flight, and dates each by its age, so a say shows only while current. The next event moves it normally. A socket without a verified hello never gets it: a test compares a no-hello socket's messages with and without live sessions, key for key.
- **One source of numbers.** Only the backend numbers. A tab's clock and prune interval can lag the backend's by a moment, so when a cursor arrives with a number another cursor of its agent still shows, the tab drops that other cursor: the backend gave its number away because it left. Two cursors never read the same name.
- **A session that comes back after leaving is a new one.** It takes the lowest free number, which may differ from its old one. Round 1's 64-number memory per agent is gone.
- **The agent memory** (review 2, LOW-2; GM r5). At most 256 agents keep slots (`SESSION_AGENT_MEMORY`). Past that, the least recently seen agent whose cursors have all left goes; an agent with a live cursor is never pushed out, so its numbers never change under the person. When all 256 are live, a new agent gets no slot: its events go out with no session, the plain agent cursor, until room frees. Round 2 evicted by recency alone, so 256 other agent names inside two minutes renumbered a live agent's sessions and the tab showed two cursors with one name. The tab now also drops by number when a cursor it already shows comes with a new number, not only for a new cursor. A test pins the LRU order (N7): an agent seen again moves to the back.
- **Cap.** An agent has at most 8 live slots (`SESSIONS_PER_AGENT`). A ninth removes the least recently seen slot before it is numbered, so it takes the number that frees. Round 2's "the oldest idle one, else the oldest" was the same rule written twice: a slot is idle when it was last seen 20 s or more ago, so whenever one is idle, the least recently seen slot is idle. Review 2's mutant N5 ("ignore idle") survived because it is equivalent; the filter is gone, and a test pins that a younger idle session goes before older active ones. The frontend store has the same cap on cursors per agent: past it, the cursor heard from longest ago goes.
- **A backend restart** (review 2, LOW-5; GM r5: a one-time rename is acceptable, with no line or announcement). Slots and the HMAC secret live in the process, so a restarted backend has no live cursors and new keys. Each tab reconnects, sends its hello, and gets an empty replay, which replaces what it showed: every cursor goes at once, in every tab. Sessions then come back numbered in the order they speak again, so a name can change once ("Claude · 2" becoming "Claude"), the same in every tab. Round 2 kept the old cursors until they expired, so one session could show twice for up to 120 s. Proved live (below).
- **Say in place.** `POST /api/canvas/cursor` with only `say` answers exactly as before (the agent's last cursor, from `here()`), and so does the agent form. The person form uses the session's own last target. With none, it uses the middle of the view, never another session's cursor.
- `forget_node` and `forget_graph` re-anchor or drop slot targets the same way they handle agent cursors.

### Chat titles: none exist yet

The coordinator's rule was: in-app chats use their title, cut at 20 characters, taken from Nebula's own chat store. But Nebula has no chat titles. `ChatPanel` holds one untitled chat in component state, and its header shows "Chat" plus the first 8 characters of the session id. No chat store exists.

So in-app chats get numbered names, like every other client, and nothing beyond `{key, ordinal}` reaches a tab. When titles exist, the backend can put the same `session.key` on the chat stream's `session` event, so a tab can match its own chat to the cursor. That stays person-only and isn't part of this change.

## The read boundary (holds)

What an agent can read today, and what this change does to it:

| Path | After this change |
|---|---|
| `/ws` to a non-person socket | The agent form, byte-identical (tested against a hand-built dict in the old key order) |
| `GET /api/canvas/snapshot` (`nebula look`, `look_at_canvas`) | `_agents` is still per agent and stores the agent form |
| `GET /api/agent/start` (`nebula context`, `start_here`) | Same |
| `GET /api/canvas/agents` (`nebula agents`, `list_agents`) | Unchanged; no session or number |
| `POST /api/canvas/cursor` response | Unchanged (only the refusal text for a bad action is new) |
| `GET /api/canvas/events`, the MCP channel | Carry no presence data, unchanged |
| MCP `tools/list` | The `point_at` description changed on purpose |

The tests named `test_decision_4_…` in `backend/tests/test_agent_cursor_sessions.py` pin it. Sessions arrive from each source, then the agent bytes and the reads are compared with and without session headers. They fail if `session` or `ordinal` shows up in anything an agent reads.

## The backend's own edits

`_show_agent` gained `shows`, the action the person's tabs draw. `action` stays the value agents read.

| main.py route | Agent form | Person form |
|---|---|---|
| upload: add input node | click | click |
| `create_canvas_proposal` | click | **propose** |
| `create_graph_node` | click | click |
| `connect_graph_nodes` | drag | drag |
| `create_node_and_connect` | drag / click | drag / click |
| `update_graph_node`: a param or prompt change | click | **type** (an empty change only moves the cursor: click) |
| `rename_graph_node` | click | click |
| `update_graph_layout` (an agent moved a node) | move | move |
| `delete_graph_node` | click | click |
| `apply_graph_edit` (`nebula apply`, MCP `edit_canvas`): the focus node's params changed | click | **type** |
| `apply_graph_edit`: the focus node added, renamed or moved | click | click |
| `delete_graph_edge` | click | click |
| `run_graph`, one target | click | **run** |
| `_refused_cli_run` ("“X” can't run.") | click | **error** |
| `_say_agent_action` (no target) | click | one form |
| `POST /api/canvas/cursor` | the agent's own | the same, plus the session |

- GM's round 2 rule: any param value change is `type`, through PUT, edit_canvas or apply, because it sets a value. A rename stays `click` for Phase 1.
- The refused run maps to `error`, not `click` ("the rest as they are"), because GM's `error` row describes exactly this event. Until Phase 2 both draw the same ripple.

## The frontend: motion and look

All of it is in the deferred `AgentCursorLayer` chunk: `lib/agentCursorPlanner.ts` (pure motion, no React or React Flow, so Phase 3's screen layer can reuse it) and `lib/agentCursorLook.ts` (names, fills, ink, the name/say rule, no stacking). Both are in `DEFERRED_MODULES`. `AgentCursorLayer.tsx` is rewritten on them.

- **Path.** One quadratic arc bowed 10% of the chord, at most 120 px, straight under 24 px. It bows away from the person's pointer when that is within 200 px of the middle of the path, otherwise toward screen-up. The layer keeps one window `pointermove` listener for this and for the name on hover.
- **Time.** `T = clamp(380 + 170·ln(1 + D/200), 380, 900)` ms, D in screen px. Progress is a critically damped spring with ω = 6.64 / T.
- **Landing.** At p = 0.80 the position and velocity hand over to `AGENT_CURSOR_LAND_SPRING` (k 260 / c 26).
- **Arrival is the tip at the target** (round 2, GM). The planner reports `arrived` once the land spring has the tip within 2 screen px of the live target (`AGENT_CURSOR_ARRIVE_PX`); the phase stays `travel` until then. The ripple and the drag wire's end both key off that, so the ripple never blooms in mid-air and the wire stays on until the tip is at the port (round 1 fired both at the hand-off, 130-170 px early on a drag). On the arrival frame the wire's end is set to the tip itself.
- **Long chords** (round 2, GM: follow-through ≤ 2 px on any chord; round 3, GM: accepted as measured). With GM's land spring (ζ ≈ 0.8) no velocity clamp alone gets there: from 600 px out it overshoots about 8 px even starting at rest. So past p = 0.80 the hand-off waits until `landFollowThroughPx` predicts 2 px or less (the arc keeps flying meanwhile). Moves up to about 1,500 px already predict under 2 px at 0.80 and are unchanged (the live table below). Rest times then: 967 ms at 2,000 px, 1,050 ms at 2,940 px, 1,067 ms at 3,000 px, 1,200 ms at 6,000 px. GM accepted these as measured, with no new spring constants: a 5K display (2560 × 1440 CSS px) is about 2,940 px corner to corner, the realistic worst case on one screen, and about 1,050 ms is within "about a second"; 6,000 px can't happen on one screen. A planner test pins 2,940 px (and the 5K diagonal) at 1,050 ms or less, so a change that makes it slower fails.
- **A target that keeps moving** (GM r5, review 2 N2). The action fires at first arrival: the first step the tip is within 2 px of where the target is now. Round 2 needed the land spring to settle, and its lag (0.1 s × the target's speed) held the ripple until a drag stopped (3.5 s live). The land spring now damps the speed relative to the target (feed-forward from the target's own velocity, measured per frame, and glided across the frame's substeps), so a dragged node is caught with no steady lag; on a still target nothing changes. After it fires the cursor stays attached at that offset and rides along with the drag until its next event; a newer event ends the ride and drops the old action's look. A jump of the target past 24 px in one frame (a sync) is still a new place to fly to.
- **Already there** (review 2, N3). A move whose chord is under 2 screen px fires on the next step, not after the 380 ms progress spring.
- **Crossing flights** (round 2, GM; round 3, GM r5 for three or more). When a new flight overlaps flights still in progress, `bowAgainst` rates each side by the room it leaves against every one of them (the closest approach of the new arc's middle, p 0.2-0.8, sampled in screen px). It keeps the default side when that is clear by 24 px (`AGENT_CURSOR_CROSS_PX`), else takes the other side if it has more room, else stays on the default side. Round 2 flipped once on any graze and never checked the flipped side, so a third flight could share the second's arc and meet it tip to tip.
- **A tab coming back** (round 2, GM; round 3, GM r5 and review 2 M1). An event older than its move would take (`Date.now() - receivedAt` past the move's duration, or the entrance for a first sighting) snaps the cursor to its latest target: no replayed flight, no ripple, no wire. The say shows only if it is still current (younger than `AGENT_SAY_MS`); otherwise the name only. A flight already under way when the tab hid lands the same way: the layer counts each `visibilitychange` to hidden, and a frame after one, or any frame gap over 0.25 s (`AGENT_CURSOR_STALE_GAP_SECONDS`), lands the tip with no arrival. GM: "the tip lands, and that's all." 0.25 s is 15 frames at 60 Hz, past any jank the eye follows as motion (a heavy frame is 30-100 ms) and short enough that a return never shows a move as now. Round 2's catch-up over 2 s reported an arrival, and under 2 s ran the remaining substeps in one frame, so the ring bloomed seconds late on return (live: 5 s).
- **No layout reads per frame** (round 2). The layer caches the pane's rect and bumps a layout epoch on viewport change, ResizeObserver and window resize (round 2 also bumped it on arrival; round 3 drops that, since nothing else moves then and the cursor's own boxes go when it rests: a mutant removing it survived because it was redundant). Hover boxes are read once per epoch, not per pointermove; a flying cursor skips hover, and hover is re-tested when a cursor lands. A test counts `getBoundingClientRect` calls. Round 3 (review 2, L1): the boxes are also dropped when the tip has moved since they were read, so a resting cursor that follows its node (a drag by the person, a sync, another agent) is hit-tested where it is. Round 2's notes said hover "can't go stale under a still pointer"; through a follow move it could.
- **No allocation per substep** (round 2). The substep mutates position, velocity and target in place.
- **Fixed 120 Hz step.** GM's measured numbers are what the prototype's own math gives at 120 fps (its hand-off velocity is a one-frame difference, so it lands differently at 60 fps). The planner steps at a fixed 1/120 s inside each frame and carries the remainder, so every display lands like GM's measurements. Tests check 30, 60 and 144 fps land the same.
- **Re-planning.** A new event, or a live target that moves more than 24 px from where the move aimed, re-plans from the current position and velocity. The new arc leaves along the current motion; when the cursor is fast the tangent reaches up to `speed / (2ω)` (capped at the chord) so the speed carries over with no jump.
- **Entrance.** A first sighting starts 64 px back along the line to its first target (up-left with no line) at opacity 0, and both spring in.
- **Idle.** Dims to 0.45 after 20 s on the fade spring (k 170 / c 26); pruned at 120 s as before.
- **Lean.** `14° × tanh(vx / 700) × min(1, speed / 250)` on a k 180 / c 22 spring, upright at rest.
- **Lean rest snap** (round 2, GM's review). Once the tip is at rest, a lean under 0.1° turning slower than 3°/s snaps to 0, and the loop sleeps (`AGENT_CURSOR_LEAN_REST`). Why 3°/s: from upright, the lean spring (ω ≈ 13.4 rad/s, ζ ≈ 0.82) swings at most 0.031 s × v further, so 3°/s leaves under 0.1° unshown, and with the 0.1° it may already have the snap skips under 0.2°, a fraction of a pixel at the arrow's tail. With it, moves of 400 px and longer sleep the frame the tip rests; round 1's 0.05° and 0.5°/s kept the loop running 70 to 130 ms longer for nothing visible. A 100 px move still runs about 100 ms past the tip's rest, because its lean is still about 0.8° then.
- **Reduced motion.** A snap to the target, upright, with opacity set at once: no pickup leg, no ripple, no wire. CSS turns off the label and name transitions and the say and ripple animations.
- **Springs only.** `agentCursor.css` has no stock easing left. The wire uses `--agent-cursor-soft` (SPRING_SOFT) and the ripple `--agent-cursor-ring` (k 170 / c 26), both sampled by `springLinear` once and set on the layer root. The say pill's way in, the name's show and hide and the label shift reuse the existing `--agent-cursor-say-fade` curve. Opacity and the idle dim moved to the JS fade spring.
- **Constants.** New: `AGENT_CURSOR_LAND_SPRING`, `AGENT_CURSOR_LEAN_SPRING`, `AGENT_CURSOR_FADE_SPRING` and the planner's thresholds. `AGENT_CURSOR_SPRING` is unchanged (pins, ghosts, the camera and the offline spring-back share it), and a test now pins its values. `AGENT_DRAG_SPRING` is removed: nothing imports it any more.
- **Names.** "Claude", then "Claude · 2", "Claude · 3" by the backend's ordinal; the tab only shows it. `sessionName` also takes a chat title (cut at 20 graphemes with `Intl.Segmenter`, so an emoji or accent is never split), but nothing passes one yet. The agent's name renders in `<bdi>`, so a right-to-left name can't reorder " · 2".
- **Fills** (round 2, GM's rule). Each session keeps its agent's hue and chroma and steps OKLCH L by 0, −0.10, +0.10, −0.20, +0.20, cycling after five (`AGENT_CURSOR_SESSION_LIGHTNESS`). A step that would go above 0.92 or below 0.35 is clamped to that edge if the edge is at least 0.05 from every L in use, else mirrored across the base (clamp first since round 3b, GM r7). A result within 0.05 of a session already used takes the next unused offset. Chroma lowers only to stay in sRGB.
  - **The band holds session 1 too** (round 3, GM). A base outside 0.35–0.92 is pulled to the nearer edge before any stepping. So no fill is ever `#ffffff`, and black, invisible on the dark canvas, starts at L 0.35 (`#3a3a3a`); `#000000` and `#030303` share that fill.
  - Near either end of the band the clamped and mirrored offsets fold onto each other (from L 0.85, +0.20 clamps onto the 0.92 that +0.10 took and mirrors onto the 0.65 that −0.20 took), so no unused offset is clear. Then the build steps on by 0.10 inside the band, nearest first (GM confirmed in round 3). Pinned lists: black gives 0.35, 0.45, 0.55, 0.65, 0.75; base 0.85 gives 0.85, 0.75, 0.92, 0.65, 0.55; base 0.4 gives 0.4, 0.35, 0.5, 0.6, 0.7; white gives 0.92, 0.82, 0.72, 0.62, 0.52.
  - White's list moved by 0.02 from round 2's 0.92, 0.8, 0.7, 0.6, 0.5: round 2 stepped from white's own L 1, and pulling it to 0.92 first, as GM's rule says, steps from 0.92. GM confirmed the rule's list, with no snapping to a 0.10 grid.
  - Live: Claude `#FF6B9A`, Claude · 2 `#db4a7c` (−0.10), Claude · 3 `#ffa8be` (+0.10).
- **Name text colour.** The higher-contrast of `#0b0b0c` and white against the fill. GM's "≥ 4.5:1" can't always hold with `#0b0b0c`: on fills near luminance 0.19 (for example `#138c03`) both inks give about 4.42 to 4.48:1, so the build falls back to `#000000` there. Every built-in colour still gets `#0b0b0c`, as today. (The prototype's 0.35 luminance threshold would give white on Claude orange at 2.70:1.)
- **The name and say rule.** With 2 or more cursors on the canvas the name is always on, moving or not, and the say pill sits under it and never jumps (round 2, GM). With one cursor the round 1 rule stands: the name hides while it moves and shows on hover and for 1.5 s on a first sighting; with the name hidden, the say pill moves up 24 px into its slot. Hover is hit-tested from the window pointer, since the layer keeps `pointer-events: none` (a CSS ratchet pins it). Focus has nothing to land on until Phase 3's name button.
- **No stacking** (round 2, GM; round 3, GM r5: physical arrival). Cursors are placed in the order they visibly landed on their spots, not the order their events came: the one that lands second moves aside, whichever was sent first. A cursor still on its way ranks after every landed one, the one due to land soonest first. Each starts at its target and, while it is within 16 screen px of an earlier cursor's placed tip and not already 10 px down-right of it, steps 10 px down and right. Testing placed tips, not targets, means a cursor aimed just up-left of an earlier tip can't land on it. A cursor keeps its stamp while its target stays within 16 px of the spot it was stamped at (review 2, L2: round 2 compared with the last report, so a node dragged slowly carried its stamp along and took the spot of a cursor already there). Recency only sets paint order: the most recently active cursor paints on top.
- **A cursor that leaves takes its place with it** (found live in round 3). When several cursors leave in one commit (a restart's empty replay), each one's cleanup woke the others, and a cursor already cleaned up could run one more frame and stamp its old spot again: a ghost entry no cursor owned, which pushed the next cursor on that spot 10 px aside. A leaving cursor now stops its loop for good before it forgets its place.
- **Drag.** Its second leg starts once the cursor has nearly stopped at the source port, so it visibly touches the port before pulling the wire.

### Interim visuals until Phase 2

| Action | Draws |
|---|---|
| click, type, run, propose, wait, error | today's ripple on arrival (the tip within 2 px), now on the k 170 / c 26 spring |
| drag | today's two legs, the straight dashed wire held to the tip until it reaches the port, then the ripple |
| move, look, think | nothing extra |
| anything else | the store reads it as `move` |

## Tests touched

- New, backend: `backend/tests/test_agent_cursor_sessions.py` (32 tests; 43 after round 2). Round 2 replaced the first-appearance test with live numbering and added: a lone chat after three /clears, 2 leaving and a new one taking 2, live numbers never changing, the cap taking a freed number, the TTL and cap agreeing with the tab, the orchestrator docs, GM's refusal on all four surfaces, `type` for a param change through apply and PUT (and `click` for a rename, an add and a no-key PUT), the person-form failure guard, the agent-memory bound, the agent-marked socket never promoted (M3, now a bounded run), the shared capture fixture and a guard over every test fake.
- **Round 2: every `broadcast_raw` fake takes `others=`.** Review 1 found 40 more fakes (41 files) that took no keyword arguments, so a two-form presence event raised inside `_show_agent` and vanished silently in those tests. All now take `**_kw`. `backend/tests/conftest.py` gains a shared `broadcast_capture` fixture (records the person form and `others`), and an AST guard test fails if any test file's `broadcast_raw` fake can't take `others=`.
- Round 3: backend, a refused clear keeps the new chat at 2; the replay (numbers 1 and 3 where they are, TTL, oldest first, no drag origin, no node that went, a re-anchored target, the 8 cap); the person form always numbered with the agent form unchanged; a real hello over `websocket_endpoint` (bounded, no TestClient socket) getting the replay last, a second hello getting the same keys, and no replay for no hello, a wrong token or an agent-marked socket, with a no-hello socket's messages compared key for key. Frontend: the band for session 1 and the three lists, the 2,940 px rest pin, the store's replay (numbers, dating, no duplicate on reconnect, a normal next move, the cap, junk), the layer's replay snap mid-flight, and the replayed say timer. The layer test's `cancelAnimationFrame` stand-in now cancels, as a browser does: the no-op let a stale frame's closure plan a flight.
- **Round 3, review 2 and GM r5.** Backend (`backend/tests/test_agent_cursor_review2.py`, new): the echo (surrogates, ESC, RLO, ZWJ, NUL, a 100 KB value, a family straddling the cut) through the function, the route (422, never 500), MCP and the CLI; live agents keeping their numbers past the agent cap and a new agent getting the plain cursor; the LRU order (N7); the cap taking the least recently seen; an invalid `NEBULA_AGENT_SESSION` in the CLI and MCP (scene header as given, cursor as if unset); one session rule for all three; a failed person form carrying the live session's real number, or nothing; `session_tag`. `test_agent_cursor_sessions.py`: the LRU test rewritten for the live-agent rule, the person-form failure test for NIT-3, and the guard's self-test. Frontend: the planner's stale gap and no arrival on a catch-up, a move to the spot it rests on (and "already there" in screen px at zoom 3 and 0.25), first arrival on a moving target and the ride, a still target landing exactly, a jump still flying, a dragged resting cursor never flying an arc (5, 15 and 23 px a frame), the side with the most room against 2, 3 and 4 flights; the layer's hidden-tab landing (1.5 s and 5 s, a 150 ms hide, a drag's wire, a 300 ms stall and a 200 ms slow frame), the stale threshold at its duration, the moving-target ripple and ride, the newer event dropping the old look, de-stacking by physical arrival (and the cursor due first aiming at the spot while both fly), the slow-drag stamp, the stamp radius at zoom 0.5, a cursor that leaves taking its stamp, hover after a follow (pointer kept, and pointer moved to the new spot), and the cache drops; the store's drop-by-number on a changed number.
- **The `broadcast_raw` fake guard is now a runtime check** (review 2, LOW-3). `backend/tests/conftest.py` wraps `pytest.MonkeyPatch.setattr` and `pytest_runtest_call`: after any setattr, and when a test's body ends, whatever sits at `main.manager.broadcast_raw` must bind `({}, others=None)`. That covers `functools.partial`, a class with `__call__`, lambdas, keyword and string-path setattr, and a direct assignment left in place, which the old AST guard missed; a self-test covers each. The two wrappers in `test_graph_writes_stay_in_project.py` now forward `**kw`. Limit: a narrow fake installed by direct assignment and restored inside the same test body is never seen. All 74 test files that touch `broadcast_raw` pass under it.
- Frontend, round 2: planner (rest snap, true arrival, long chords, crossing flights, in-place substeps), look (GM's lightness rule across the built-ins and the extremes, grapheme cuts, the name rule with 2+, de-stacking by first arrival against placed tips), CSS ratchets (`pointer-events: none`, the −24 px say slot, the 4 px gap, the hidden name's opacity 0), and the layer (ripple and wire at the tip, places kept, name in flight with 2+, the hidden-tab snap, a `getBoundingClientRect` counter, hover re-test, `<bdi>`).
- New, frontend: `agentPresenceSessions`, `agentCursorPlanner`, `agentCursorLook`, `agentCursorCss` and `agentCursorLayer`.
- **The straight-line pin, replaced on purpose.** `agentCursor.test.ts` kept its 300 px block, renamed "the shared agent-motion spring (pins, ghosts, camera)", because pins, ghosts and the camera still run on that spring. It now also pins the spring's values. The cursor's own pin is an arc pin in `agentCursorPlanner.test.ts`: 300 px from rest takes 536 ms, bows 30 px toward screen-up, has under 1 px of follow-through, is at rest within 1 s, leans about 11° and ends upright.
- `frontend/tests/AgentRosterCorner.test.tsx`: one test added. With two live sessions of one agent, the roster still shows one row, the newest.
- **Two fixtures.** The `broadcast_raw` stand-ins in `backend/tests/test_round16_labels.py` and `backend/tests/test_error_copy_round3e.py` took no keyword arguments.
  - A param edit and a refused run now send two forms (`broadcast_raw(person, others=event)`).
  - Their stand-in raised a TypeError, which `_show_agent` swallowed, so the tests saw no event.
  - Both now take `**kw` and record the person form.
  - Every other test file that patches `broadcast_raw` (72 files, 2,835 tests) passed unchanged.

## Live check against GM's numbers

How it ran:
- An isolated backend on 8780: temp HOME, its own settings, state and output paths, no keys, and a person token passed on stdin.
- Vite on 5780 with `VITE_NEBULA_BACKEND_PORT=8780`. A curl through 5780 reached the isolated backend (same boot id).
- Headless Chrome at 1440 × 900 behind a dead proxy, with only 5780 and 8780 bypassed, and CDP blocking 8000-8010, 5173, 8840 and 5840.
- A canary proved 8000, 8005, 5173 and an outside host were all unreachable. After it, zero requests were blocked or left loopback.

Presence was driven with `POST /api/canvas/cursor` and agent headers, and with the real CLI (`python -m cli --url http://127.0.0.1:8780 point 200,200 --as Claude --action run`). The cursor's DOM transform was read every frame (60 Hz). Horizontal moves at zoom 1, the person's pointer away from the path.

| Move | Land spring at rest (planner) | GM | Follow-through | GM | Peak lean | GM |
|---|---|---|---|---|---|---|
| 100 px | 467 ms | 465 ms | 0.16 px | 0.2 px | 6.2° | about 6° |
| 400 px | 733 ms | 721 ms | 0.63 px | 0.6 px | 12.3° | 12° |
| 500 px | 750 ms | | 0.73 px | | 12.8° | |
| 900 px | 833 ms | 823 ms | 1.24 px | 1.3 px | 13.8° | 14° |
| 1500 px (diagonal) | 900 ms | | 1.97 px | | 14.0° | |

- The first column is the planner's land spring coming to rest, not a DOM reading (review 1 caught the old label). Round 2 measures the tip at rest in the DOM (the last frame its position changes), and it gives the same values (table below).
- Those times are within one 60 Hz frame (17 ms) of GM's.
- The bow measured 10, 40, 50, 90 and 120 px toward screen-up, which is 10% of the chord, capped at 120.
- Round 1: the lean's last fraction of a degree ran on a little longer. The loop slept once the lean was under 0.05°, at 650, 817, 833, 967 and 1000 ms. Round 2's rest snap fixes that (below).
- **Name hidden while moving:** 0 frames showed the name in flight. During a move with a say line and two cursors on the canvas, the label read `say` in flight and `name+say` once landed.
- **Two sessions:** an HTTP session became "Claude", fill `#FF6B9A`. The CLI's session became "Claude · 2", fill `#ffa8be` (+0.10 L). Both had ink `#0b0b0c`. Their keys and numbers were the same across three page loads on one backend.
- **Refusals:**
  - `--action hover` from the CLI was refused, listing the ten.
  - `action: "hover"` over HTTP got a 422 with "action must be one of move, look, think, type, click, drag, run, propose, wait, error".
- **Reduced motion:** the move drew one frame at the start and the next at the target. There were 0 frames in between, the lean was 0 and there was no ripple.
- **What agents read, live:**
  - A plain `/ws` listener (no person hello) got 14 presence events, none with `session`. Their actions were only the ones the agents sent: move, look, run.
  - `GET /api/canvas/snapshot` and `GET /api/canvas/agents` carried no session or number.

### Round 2 live check (the rest snap and live numbering)

The final run used the shared guarded launcher (`serve_isolated.py`: temp HOME, settings, state and output, no keys, a socket guard in the backend process). Its blocked log held only the canary lines and "canary ok". The browser side was as before: Vite on 5780 with `VITE_NEBULA_BACKEND_PORT=8780`, a dead proxy, CDP blocking 8000-8010, 5173, 8840 and 5840; the canary showed 8000, 8005, 5173 and an outside host blocked, then 0 requests were blocked or left loopback. No run, no provider call and no chat agent. The cursor layer's own frame requests were counted (its `tick`, picked out by its stack), so a sleeping loop shows as no more requests.

| Move | Tip at rest (DOM) r1 → r2 | Follow-through r1 → r2 | Peak lean r1 → r2 | Loop's last request r1 sleep → r2 |
|---|---|---|---|---|
| 100 px | 467 → 467 ms | 0.16 → 0.16 px | 6.21 → 6.21° | 650 → 552 ms |
| 400 px | 733 → 733 ms | 0.63 → 0.63 px | 12.27 → 12.27° | 817 → 700 ms |
| 500 px | 750 → 750 ms | 0.73 → 0.73 px | 12.84 → 12.84° | 833 → 736 ms |
| 900 px | 833 → 833 ms | 1.24 → 1.24 px | 13.78 → 13.78° | 967 → 801 ms |
| 1500 px (diagonal) | 900 → 900 ms | 1.97 → 1.87 px | 13.96 → 13.94° | 1000 → 867 ms |

- Every rest time, follow-through and peak lean is within one 60 Hz frame of round 1. The long-chord deferral, true arrival and crossing rule leave moves up to 1,500 px unchanged (the 1500 px follow-through is 0.1 px lower, a frame's phase).
- The loop's last request is followed by one more frame. On 400 px and longer that frame is the one the tip comes to rest on; on the 1500 px move the loop asked for 54 frames and none after 867 ms. On 100 px it runs about 100 ms past the tip's rest, while the lean (0.76° then) settles.
- **Arrival:** a 600 px click's ripple mounted with the tip 1.14 px from the target; no frame had a ripple with the tip farther than 2 px.
- **Drag:** the wire showed for 21 frames; on its last frame the tip was 2.3 px from the port, and the wire's end at let-go was 1.2 px from it (round 1: 130-170 px short).
- **Three sessions, 2 leaves, a new one takes 2.** Three HTTP sessions of "Claude" read "Claude" `#FF6B9A`, "Claude · 2" `#db4a7c` and "Claude · 3" `#ffa8be`. 1 and 3 spoke every 15 s; 2 stayed quiet. The tab dropped 2 by 120 s, with 1 and 3 unchanged throughout. A new session then read "Claude · 2", and 1 and 3 still read "Claude" and "Claude · 3". With 2+ cursors the label never read `say` alone: the name stayed on.
- A plain `/ws` listener got 37 presence events, none with `session`; the snapshot and roster carried no session or number.
- Shots: the 1500 px filmstrip with the loop asleep, and the three-session sequence, in the PR.

### Round 3 live check (the replay on connect, black and white)

The same guarded launcher, a fresh backend, the same blocks; blocked log: the canary lines and "canary ok" only; 0 requests blocked or off loopback after the canary. No run, no provider call, no chat agent.

- Tab A open; three sessions of "Claude" read "Claude", "Claude · 2", "Claude · 3". 2 went quiet and left at 120 s; 1 and 3 kept going.
- **Tab B opened mid-session** showed "Claude" and "Claude · 3" at the same spots with the same fills as tab A (session keys, names and fills identical), with no flight.
- **A new session** then read "Claude · 2" in both tabs.
- **Black and white:** two agents the person made with `#000000` and `#ffffff` (app tokens), two sessions each: Ink `#3a3a3a` and `#555555` (L 0.35, 0.45), Chalk `#e4e4e4` and `#c4c4c4` (L 0.92, 0.82).
- **The say pills (GM's check).** The first black-and-white shot showed "Ink · 2"'s say pill much fainter than the others. That frame was taken about 3 s after the says, mid fade-out, not mid-entrance: a rerun measured all four at 3.15 s in `agent-cursor-say-out` at opacity 0.17 to 0.26. Settled (1.4 s after the says), all four are the same: text `#ececee` on the pill's `#18181b`, opacity 1, contrast 15.02:1, no animation running. The pill's colours don't depend on the session's fill, so there is no per-session contrast to fix. The shot was retaken settled, with the library panel closed.
- A plain `/ws` listener got 26 presence events, none with `session`, and no replay; the snapshot and roster carried no session, number or replay.

### Round 3 final live check (review 2 and the restart)

Same launcher and blocks (`serve_isolated.py`, the person token on stdin, three boots in all: each blocked log held only the canary lines and "canary ok"); 0 requests blocked or off loopback after the browser canary. Shots in the PR.

- **Two tabs agree.** Three sessions live in tab A, then tab B opened: both read "Claude", "Claude · 2", "Claude · 3" with the same keys, spots and fills.
- **Black and white.** Ink `#3a3a3a` / `#555555`, Chalk `#e4e4e4` / `#c4c4c4`, settled.
- **A click on a dragged node.** The person dragged the node 12 px left and 6 px down per step while the click flew: the ring mounted once, when the tip reached the moving node, and the cursor then rode along at that offset for the rest of the drag.
- **A hidden tab.** Hidden 200 ms into a 900 px click (`visibilityState` hidden), shown 5 s later: the tip was on the target on the first frame back, no ring mounted (a MutationObserver saw none), every wire at opacity 0.
- **A backend restart with two tabs open** (LOW-5). Before: A "Claude", B "Claude · 2" in both tabs. The backend was stopped and started again through the launcher with the same person token. Both tabs reconnected and dropped every cursor (0 cursors within 1.5 s). B spoke first, then A: both tabs read B "Claude", A "Claude · 2", each once, at their own spots. The one-time rename GM accepted, the same in every tab.
- **Found live, fixed:** after the restart's empty replay, a cursor alone on a spot was drawn 10 px aside. The cursors that left had each woken the others in their cleanup, and one already cleaned up ran a last frame that stamped its old spot again. A leaving cursor now stops its loop before it forgets its place; a layer test pins it, and the rerun had no offset.
- An agent `/ws` listener got 11 presence events in the main run and 4 in the restart run, none with `session`, and no replay.

## Gates

- `tsc -b --noEmit`, eslint, `check:inline-styles`, `check:slava-css-scope`: clean.
- Focused vitest: 99 files, 1,165 tests passed. The set covered:
  - every changed test;
  - every cursor, presence, pin, proposal, roster and agent-log test;
  - every test that reads the changed modules or springs;
  - every ratchet that walks `src/` or `styles/`.
- Focused pytest (isolated): 37 files, 1,007 tests passed. The set covered:
  - the new session tests and every presence and presence-follow-up test;
  - the MCP tools, channel, offline and projects tests, and every CLI test;
  - agent start, agent status, the canvas proposals, round 16 labels and error copy 3e;
  - `test_unprivileged_marker.py` and `test_ci_shard.py`.
- `vite build` then `check-build-budget.mjs`: passed. The entry is 444,759 bytes raw (136,600 gzip). The same build of origin/main gives 444,245 raw (136,421 gzip), so this change adds 514 bytes. Main is already about 444 KB, not the 355.7 KB recorded after #164. The cursor chunk went from 4.0 KB to 13.1 KB.

- **Round 2**, run once at the end: `tsc -b --noEmit`, eslint, `check:inline-styles` and `check:slava-css-scope` clean. Focused vitest (`--maxWorkers=2`): 99 files, 1,218 tests passed, 0 errors. Focused pytest (isolated): 91 files, 2,635 tests passed (round 1's 37 files, the 41 files whose `broadcast_raw` fakes changed, and the tests that read the changed docs). `vite build` then `check-build-budget.mjs`: passed; the entry is 444,867 bytes raw (136,615 gzip), 108 more than round 1 and 622 over main. The deferred cursor chunk is 16.4 KB (13.1 KB in round 1).

- **Round 3**, run once at the end, one heavy run at a time (this Mac's load average was 12 to 30):
  - `tsc -b --noEmit`, eslint, `check:inline-styles` and `check:slava-css-scope`: clean.
  - Focused vitest (`--maxWorkers=2`, from an explicit zsh array): 121 files, every cursor, presence, roster and agent-log test and every test that reads `src/` or `styles/` from disk, run in four chunks with the JSON reporter: 2,089 tests passed, 0 failed, 0 errors. (A first single run was cut off by its 25-minute limit under load, with tests timing out after minutes; the chunked rerun is the gate.)
  - Focused pytest (isolated): 137 files in four runs of at most 37: the 74 files that touch `broadcast_raw` in two runs (2,033 and 875 tests), and 63 more that read presence, cursor actions, the CLI client, MCP `point_at` or the docs (998 and 853). 4,758 passed, 1 failed: `test_cli_apply.py::test_arrange_from_the_builder_and_in_the_reply` fails whenever `test_canvas_pins.py` runs before it in one process. The same pair fails the same way on main (1944d052) and on 4fccb34a, so it is an existing order leak, not this change; it passes alone (27 of 27).
  - `vite build` then `check-build-budget.mjs`: passed. The entry is 445,406 bytes raw (136,815 gzip), 1,161 over main's 444,245 (round 3 adds 539: the store's `withEvent`, the replay and the drop-by-number on a changed number). The `wsClient` chunk is 2,448 B (main 2,362: the action list), preloaded but not counted by the budget script, so first load grows about 1,247 B. The deferred cursor chunk is 18,488 B.

## Mutation checks

Each mutant changed one line and ran the focused tests. All 21 were caught.

- **Planner.** Caught:
  - the hand-off moved to 0.60;
  - the duration clamp removed;
  - the bow side flipped;
  - the lean's speed term unclamped;
  - the lean's tanh dropped;
  - reduced motion keeping a lean;
  - `AGENT_CURSOR_SPRING` edited.
- **Look and store.** Caught:
  - the name shown while moving;
  - the ink pick inverted;
  - the frontend cap raised to 9.
- **Sessions.** Caught:
  - every new session numbered 2;
  - numbers counting down;
  - the backend cap raised to 9;
  - the cap pruning the newest.
- **Actions.** Caught:
  - the route's own check removed (a list action then reached `_pointed` and failed with a 500);
  - presence accepting any string;
  - MCP `point_at` skipping its check.
- **Boundary.** Caught:
  - the session copied into the agent form;
  - the raw session id used as the tab key;
  - the CLI sending the raw Claude Code id;
  - the run emitter showing `click`.
- **Two mutants survived the first pass, and the tests were tightened:**
  - "The cap prunes the newest" survived because every refresh in the cap test shared one clock time, so the oldest and the newest tied. The test now steps the clock.
  - "Presence accepts any string" survived because the route checks first. A direct test of `AgentPresence.point` now pins the backstop.

### Round 2

- **Against the round 1 commit (070c123c).** Every round 2 behaviour test was run on 070c123c with only the test files swapped in. All 10 section 1 tests and all 16 behaviour tests for review 1 and GM's answers fail there (the shared-fixture test errors, since the fixture doesn't exist). Pure pins (the lightness offsets, the agent-memory bound, the promote guard) pass there by design: they hold values round 1 already had right.
- **Section 1 mutants: 17, all caught.** The rest snap at round 1's 0.05° or 0.5°/s, ignoring velocity, or not zeroing the lean; the next number as the highest live + 1; a TTL that never frees a number; a graph clear or node delete keeping a session's slot; the cap evicting after numbering; the cap pruning the newest; the backend cap at 9; the session leaking into the agent form; the tab dropping no cursor on a shared number; the tab's plain cursor not counting as 1 (survived once; a reverse test now pins it); the tab's expiry at 90 s; and the CLI help losing its cursor section or the point help its session line.
- **Review 1 and GM mutants: 48.** 47 caught. One survived and was dead code: the `#ffffff` guard after the lightness rule could never fire (the 0.92 cap and the white-base rule already keep L under 1), so it was removed and a comment says why. "Stack order by last event" survived first; a layer test where a small shift keeps the stack order now catches it. Caught, among others: arrival at the hand-off, a 20 px arrival radius, long chords handing off at 0.8, no crossing flip, a 4 px crossing radius, per-substep allocation, the offsets reordered, the band max at 1, no fallback step, the name hidden in flight with 2+, a code-point title cut, de-stacking against targets, the stale snap removed, the pane rect read every frame, hover boxes read per pointermove, no hover re-test on landing, the wire letting go short of the port, the wire and ripple at the hand-off, no `<bdi>`, the layer taking pointer events, the say slot at −20 px, apply's value change showing `click`, apply's rename showing `type`, the person-form failure propagating, a refusal that echoes nothing or is uncut, generic CLI and MCP refusals, an unbounded agent memory, a narrow fake coming back, the shared capture dropping `others`, and a promote that ignores the agent marker (M3, now a bounded run).

### Round 3

- **Against round 2 (4fccb34a).** With each changed source file put back to 4fccb34a and the new tests in place, all six checks fail: the band for session 1, the store's replay and no-fallback numbers, the layer's replay snap, the replayed say's timer, the backend's replay and always-numbered person form, and the hello sending the replay. The 2,940 px rest pin and the refused-clear test pass there by design: they pin behaviour GM accepted as built.
- **Mutants: 24.** 21 caught on the first pass. Three survived and got tests: the replay ignoring the TTL (expiry is lazy, so a test now lets every cursor go quiet with no later event), the replay newest first (events shared a clock time; the test now steps it), and the replay using the kept target over a re-anchored one (a test deletes the node with a last known spot). All 24 are now caught. Among them: no band clamp, floor or ceiling only, session 1 kept raw, the follow-through cap at 1 px (the rest pin catches the slower rest), the tab numbering the plain cursor 1 again, the replay keeping the tab's old cursors, the replay flag dropped, the replay not dated by its age, a drag origin kept, no cap, the seq restarting, the layer flying a replayed cursor, the say timer from mount, the person form numbering only sessions, the replay's flag, age, node names, an empty replay, and the replay sent to a socket without a verified hello.

### Round 3, section 2 (review 2, GM r5) and the final items

- **Against 4fccb34a.** Every source file this round changed went back to 4fccb34a at once, the changed test files ran without `-x`, and each new or changed test was read off: 56 fail there. The ones that pass there pin behaviour round 2 already had: the LRU order and the cap's choice (N5, N7), a valid `NEBULA_AGENT_SESSION` sent alone, the refused clear, a newer event dropping the old look, the stale threshold at the move's duration, the cache drops on view changes, the stamp radius at zoom 0.5, a jump re-planning, arrival only after the hand-off, the 2,940 px pin, `arcGapPx` in screen px, the 1,500 px follow-through, review 2's three-flight case (the four-flight test fails there), prune per key, and four layer tests whose bodies only moved. Two parametrized cases pass there by design (a family straddling the cut and a 100 KB plain value: round 2 already kept them clean); their own tests fail there. The wrapper fix in `test_graph_writes_stay_in_project.py` is a test change.
- **Mutants, first pass: 64, 13 survived.** The survivors either got a test or proved to be dead code:
  - tests: a hide under 0.25 s (kills "no visibility listener" and "a hide doesn't make the gap stale"); hover after a follow with the pointer moved to the new spot (L1: the round 2 test passed on 4fccb34a); the stamp radius at zoom 0.5 (R12b); the cursor due to land first aiming at the spot while both fly (ETA order); the side with the most room against a second flight, and a crowded side kept when the other is worse (L3, "first flight only" and "always flip"); "already there" at zoom 3 and 0.25 (N3 in flow px);
  - removed as dead code: the cap's idle filter (N5: the least recently seen slot is idle whenever any is), the wake on landing (a landed cursor's stamp is the newest, so no other landed cursor moves, and flying ones are awake), the wake on tab return (a flight under way has a frame pending, which runs on return), and the layout invalidation on arrival (nothing else moved; the cursor's own boxes go at rest, and the name can't show while it settles).
- **Final run: 60 mutants, 58 caught, 2 equivalent.** Caught, among others: every echo rule, a live agent evicted, the agent memory FIFO, the cap taking the newest, each CLI and MCP session rule, each NIT-3 path (bare form, bare form without a slot, broadcast to everyone, `session_tag` ignoring the TTL or the session), the three replay survivors of round 3 section 1, the runtime guard off, the catch-up arriving, the stale gap at 2 s, 1 s and 0.05 s, the catch-up ringing or keeping the wire, the stamp against the last report, de-stacking by event order, the ghost stamp, every L3 rule, the ride, the feed-forward, the glide, the jump threshold, N3, the store's drop-by-number, and review 2's R1-R12. Equivalent:
  - the lightness fallback farthest first (R13): 0 differences over 10,001 bases × sessions 1-10, because the two candidates are equally near;
  - a resting cursor re-planning on any drag, not only a jump: with feed-forward the tip never trails a dragged target by 24 px (tested at 5, 15 and 23 px a frame), so the `jumped` guard never decides.

### Round 3b (GM r7: clamp first)

- **The case.** In round 3's hidden-return shot "Claude · 5" read darker than "· 4". The live script had named its agent by an unverified `X-Nebula-Agent: Claude` header, which gets an external colour (`#FF6B9A`, L 0.7226), not Claude's `#E8825A` (L 0.7104). From 0.7226, +0.20 is 0.9226, 0.0026 past the band; mirrored it landed on · 4's 0.5226, so it stepped on to 0.4226, the darkest of the five. The real Claude never reaches the edge (0.710, 0.610, 0.810, 0.510, 0.911).
- **The rule (GM r7).** Each offset takes the first that works: the value itself; past an edge, the edge (0.35 or 0.92) if it is at least 0.05 from every L in use; the value mirrored across the base; then the step on by 0.10. Symmetric on both sides. The pink base now gives 0.7226, 0.6226, 0.8226, 0.5226, 0.92 (`#ffd9e2`), so · 5 is the lightest.
- **What moved.** Black and white are unchanged (the clamp lands on the base, which is taken). Two pinned lists change, as the rule says: base 0.85 is now 0.85, 0.75, 0.92, 0.65, 0.55 (was 0.85, 0.75, 0.65, 0.55, 0.45), and base 0.4 is 0.4, 0.35, 0.5, 0.6, 0.7 (was 0.4, 0.5, 0.6, 0.7, 0.8): from 0.40 it is −0.10 that clamps to 0.35, sitting exactly 0.05 under the base. −0.20 clamps for bases from 0.50 to 0.55; the low-side test uses 0.52 (0.52, 0.42, 0.62, 0.35, 0.72), and 0.47 shows the clamp refused for room (−0.20 mirrors to 0.67).
- **Tests.** The pink base's five L values and fills, with · 5 the lightest and · 4 the darkest; the low-side clamp at 0.52 and the refused clamp at 0.47; the real Claude's five fills pinned in order. Against the round 3 code three tests fail (the new one, and the two holding the 0.85 and 0.4 lists).
- **Mutants: 18, 13 caught, 5 equivalent.** Caught: no clamp at either edge, the clamp without its gap check at either edge, the wrong edge at either side, mirror before clamp at the floor, an in-band value skipping the gap check, the old placement in the order, the index off by one, the order starting one later, and two swaps in the offset table. Equivalent, each with 0 differences over 100,090 base × session pairs (bases 0 to 1 by 0.0001 and the edges, sessions 1-10): mirror before clamp at the top, no mirror at the top, no mirror at the floor, `>=` for `>` and `<=` for `<`. The mirror never decides a result: past the top, −d came first and holds base − d or found it not clear; past the floor, base + d is what +d, next in the order, takes anyway. It stays because it is GM's rule 3, with a comment saying so. At the edge itself, the value and the clamp are the same number.
- **Gates.** `vitest --maxWorkers=2` over `agentCursorLook`, `agentCursorLayer` and `agentCursorPlanner`: 3 files, 152 passed. `tsc` 0, `eslint` on the two touched files 0, `check:inline-styles` pass.
- **Live (8780/5780, serve_isolated.py).** The harness minted one verified `claude` runner token in-process, and a verified app was made with `#FF6B9A`. Five sessions of each, all awake: DOM and pill pixels match exactly. Claude `#E8825A` 0.710, `#c6633b` 0.610, `#ffa887` 0.810, `#a4451b` 0.510, `#ffd8c9` 0.911. Pink `#FF6B9A` 0.723, `#db4a7c` 0.622, `#ffa8be` 0.823, `#b8265f` 0.523, `#ffd9e2` 0.920. The blocked log held only the canary lines and "canary ok".

### Round 3c (GM r8: a clamp needs 0.07, no mirror)

- **The rule (GM r8).** Each offset takes the first that works: the value itself, if it is inside the band and at least 0.05 from every L in use; past an edge, the edge, if it is at least 0.07 from every L in use; else the next unused offset. When none works, L steps on by 0.10 inside the band, nearest first. The general gap stays 0.05; only a clamp needs 0.07. `AGENT_CURSOR_SESSION_BAND` now carries `clampGap: 0.07`. Gaps compare with `>=` and a 1e-9 epsilon, so a gap of exactly 0.07 is never flipped by rounding.
- **The mirror is gone.** The fallback branch also mirrored, as its first guess before stepping on; it now starts from the offset pulled into the band. That start is never kept: 57,354 fallbacks over the sweep all found a clear step. Proof of no other change: the r3b code with only the clamp gap raised to 0.07, mirror kept, against the new code: 0 differences over 100,050 base × session pairs (bases 0 to 1 by 0.0001 and the edges, sessions 1-10).
- **What moved against d04dc1a7.** 4,000 of 100,070 pairs, 800 bases, all from the 0.07 rule, in four ranges (each a clamp whose gap is 0.05 to under 0.07):
  - bases 0.4000-0.4199: −0.10 clamped to 0.35, 0.05-0.0699 under the base. Now refused; the five step up. 0.40 is 0.4, 0.5, 0.6, 0.7, 0.8 again (was 0.4, 0.35, 0.5, 0.6, 0.7).
  - 0.5000-0.5199: −0.20 clamped to 0.35, under 0.07 from · 2. Now · 4 takes +0.20 and · 5 steps on (0.50: 0.5, 0.4, 0.6, 0.7, 0.8; was 0.5, 0.4, 0.6, 0.35, 0.7).
  - 0.7501-0.7700: +0.20 clamped to 0.92, under 0.07 from · 3's base + 0.10. Now · 5 steps on down (0.77: 0.77, 0.67, 0.87, 0.57, 0.47; was ..., 0.92).
  - 0.8501-0.8700: +0.10 clamped to 0.92, under 0.07 from the base. Now all step down (0.851: 0.851, 0.751, 0.651, 0.551, 0.451).
  - Unchanged: 0.85 (0.85, 0.75, 0.92, 0.65, 0.55; gap exactly 0.07), pink #FF6B9A (0.7226, 0.6226, 0.8226, 0.5226, 0.92; gap 0.097), 0.52 (0.52, 0.42, 0.62, 0.35, 0.72; gap exactly 0.07), 0.47 (0.47, 0.37, 0.57, 0.67, 0.77), black (0.35, 0.45, 0.55, 0.65, 0.75), white (0.92, 0.82, 0.72, 0.62, 0.52) and Claude's five.
- **Tests.** The band constant with `clampGap`; the 0.40 list re-pinned; a boundary test: the clamp taken at exactly 0.07 (0.85 and 0.92 − 0.07 at the top, 0.42 at the floor, 0.75 for +0.20) and refused just under (0.851, 0.419, 0.751); 0.519 beside the 0.52 low-side case. The every-base invariant (0.35-0.92, at least 0.05 apart) still holds. Against d04dc1a7's code 4 tests fail.
- **Mutants: 14, 10 caught, 4 equivalent.** Caught: the clamp gap at 0.05; `>` with no epsilon (the 0.42 case: 0.42 − 0.35 is exactly 0.07); `>=` with no epsilon (0.92 − 0.07 is 0.8500000000000001, gap 0.06999999999999995); the clamp removed at both edges, at the top, at the floor; the floor or the top clamp using 0.05; the clamp without a room check; the step-on removed. Equivalent, 0 differences over 111,030 pairs: the step-on starting at 0.20 (those are the offsets, already refused), the step-on trying up first, in-band values held to 0.07, and the mirror put back.
- **Gates.** `tsc -b` 0, `eslint` on the two touched files 0, `check:inline-styles` pass. `vitest --maxWorkers=2` over `agentCursorLook` and `agentCursorLayer` (the two test files that import it): 2 files, 84 passed.

## Left for Phase 2 and Phase 3

- **Phase 2 (expression):**
  - the halo states;
  - the press and ring;
  - the error shake;
  - the caret and the param underline;
  - the real bezier wire on a lag spring;
  - the mark slot for `propose` and `wait`;
  - the default say lines.
  - The arrow's shape and the halo in place of the drop shadow (GM §1) also land with the halo.
- **Phase 3 (anywhere):**
  - the screen layer;
  - DOM anchors on the Moodboard panel and Studio;
  - the hand-off flight between canvas and panel;
  - the point-at-it rule at panel and canvas edges, with the name as a button (which also gives the name its focus state);
  - the pill flips;
  - launcher parking with activity dots.
  - Then Characters and Styles.

## Open

- **Chat titles.** Nebula has no chat titles yet, so an in-app chat shows "Claude · 2", not "Claude · Lighting pass". When titles exist, the chat stream's session event can carry the same session key, and only the person's tabs would read it.
- **Session numbers** go among live sessions since round 2 (decision 3, GM's review). Settled in round 3:
  - a /clear whose canvas clear is refused (a run going) leaves the old chat's cursor live, so the new chat reads "Claude · 2" beside it and keeps 2 after the old one leaves. GM: as built, no borrowing. A test pins it;
  - a fresh tab no longer shows a gap: the replay on connect gives it every live cursor with its number.
- **Name text fallback.** GM to confirm `#000000` for the narrow band of mid-luminance fills where neither `#0b0b0c` nor white reaches 4.5:1.
- **Subagents share a cursor.** They see their parent's `CLAUDE_CODE_SESSION_ID`, so a session and its subagents share one CLI cursor unless each sets `NEBULA_AGENT_SESSION`. Over MCP they share the parent's server, so its one cursor. Round 2 documents it for orchestrators in `nebula --help` (a closing section), `nebula point --help`, `nebula agents --help`, the `point_at` docstring, `skills/nebula/SKILL.md` and `docs/MCP-SETUP.md`: what happens without it, and how to give each lane its own (`NEBULA_AGENT_SESSION=lane-a nebula point …` on every call the lane makes).
- **MCP and CLI together.** An agent that uses both under one name shows two cursors unless both set the same `NEBULA_AGENT_SESSION`. This is documented.
- **Two actions from Nebula's own edits:**
  - A rename stays `click` for Phase 1 (GM, round 2); any param value change is `type`.
  - A refused run shows `error`. GM's error row describes exactly that event.
  - Neither looks any different until Phase 2.
