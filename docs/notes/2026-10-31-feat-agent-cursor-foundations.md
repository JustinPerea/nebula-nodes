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

## Round 4

Review 3 (boundary and replay; motion, look and live) and GM's answers to it.

### Backend

- **Pin reply and accept go through `_broadcast_presence` (MEDIUM-1).** The pin resolve reply now sends the person form on the agent's own session, so a session's pin reply lands on that session's cursor, is counted for its number and is replayed to a later tab. Accepting a proposal lands on the cursor of the session that proposed it: the proposal keeps `presence_session` (person-side only, `repr=False`), and `_accepted_person_form` sends the person form only while that session is still live. If it has left, no person frame goes out (no stray cursor is revived); the agent form still goes to agent sockets as before.
- **The proposing session never leaves the person side.** A test reads every agent surface after a session-scoped proposal (agent socket, agent HTTP reads, `_proposal_view`, the journal, the listener and `repr`) and finds no session key.
- **Guard.** An AST test reads `main.py` for a cursor event with a target sent outside `_broadcast_presence` (round 4b widened it; see below). The two left (`target=None`, Agent log only) are counted.
- **B24.** The replay ages `did.secondsAgo` by the time since the event (pinned at 42.5 s).
- **NIT-1, NIT-3.** The hello comment now says what the replay holds (every event built before it, same key and number, so nothing doubles); `SESSION_IDLE_SECONDS` says it's pinned by tests and read by nothing here.
- **NIT-2.** A new agent past `SESSION_AGENT_MEMORY` (256 live agents) gets no slot, so it shows as the plain cursor with no number and isn't in the replay until room frees; no session is dropped. Documented and pinned by a test rather than changed (wording fixed in round 4b, review 4 NIT-4).
- `person_gate.py`, `scene_keys.py`, `person_session.py` and the read boundaries are untouched.

### Motion

- **Kinematic attach (M1).** A cursor resting on a moving node rides it: its position is the node's live position plus a fixed offset, with zero velocity of its own, so it can't overshoot. The settle test uses speed relative to the node. A landing during a drag aims at the node's live spot, not a predicted one, and stops dead when the node stops within 2 px. Measured in tests: 0 px past the stop at 4, 12 and 20 px a frame and on a 20 px nudge; live, 0 px at 5, 12 and 20 px a frame, rest offset exact (110, 44).
- **A person's drag is never a jump.** The layer reads React Flow's `dragging` flag on the anchor node and passes `dragged`, so 12 and 20 px a frame no longer re-plan as jumps (live caught this: frames add up past the jump threshold). A non-person jump (a sync, an undo) still flies.
- **Fling (held action).** A cursor that's still flying when the person lets go fires its held action no later than the drag's end (`AGENT_CURSOR_DRAG_END_SECONDS = 0.03`, two still frames), at the cursor's tip on the node.
- **Two cursors on one dragged node keep their order (L1).** Cursors anchored to the same node move together, and a carried cursor keeps its stamp, so the de-stack order can't swap mid-drag. It loses the stamp only if the ride brings it onto a cursor that isn't on that node. Live: Pair at +10, Pair · 2 at +20 before, after "first speaks again" and through 4 and 12 px a frame drags.
- **StrictMode.** In dev the layer's effect mounts twice; the first unmount used to forget every cursor, so the next event swapped two cursors. The layer now releases on unmount and forgets only at the next read if nothing claimed it again. A test renders under StrictMode.

### Look

- **Name pill edge.** When the pill's fill is under 3:1 against the canvas (Slava `#000`, classic `#111`), it gets a 1 px white ring at 0.4 (`data-edge="both"` or `"classic"`; `pillEdge` in `agentCursorLook.ts`). The 0.35 lightness floor is kept.
- **Finding for GM.** Live, the ring renders anti-aliased because the cursor has `will-change: transform` (its own composited layer): it peaks at 69 on `#000` (2.19:1) and 74 on `#111` (2.13:1). With `will-change` off it is crisp: 102 (3.66:1) and 111 (3.76:1). Out of scope for this round, so not changed.

### Tabs and startup

- **Demoted tab (LOW-1).** When a tab loses the person seat (`personRequired`), `wsClient` dispatches `socketDemoted` and the store drops every session cursor, as if those agents left. Only unnumbered cursors stay, and later events bring in unnumbered cursors (one per name). Live: 7 cursors before, after the refusal only Ink, then Claude, Ink and Pair, no numbers.
- **Startup (LOW-2, N3).** A small entry module, `store/agentPresenceFeed.ts`, subscribes at load and holds presence, replay, demote and graph-clear events (with receive time, at most 64) until the deferred store attaches. A replay clears what was held. The store itself moved to the deferred chunk.
- **LOW-3 / F05.** `secondsAgo` is clamped at zero on receipt. F03 stays as it was (GM).
- Entry: 445,406 → 443,057 B raw (−2,349), 136,800 → 136,044 gzip. `wsClient` chunk 2,448 → 2,499 B; cursor layer chunk 18,565 → 20,435 B; the deferred store 3,112 B.

### Checks (round 4)

- `tsc -b` 0; eslint 0; `check:inline-styles` (255 files) and `check:slava-css-scope` (4 files) pass.
- Focused vitest, `--maxWorkers=2`, 130 files in four runs: 524 + 339 + 606 + 552 = 2,021 passed, 0 failed, no timeouts.
- Isolated pytest over the cursor, presence, pin and proposal files: 573 passed (28 files, 10 new in `test_agent_cursor_round4.py`).
- Build and `check-build-budget.mjs` pass (443,057 B raw).
- Mutation checks: backend 8, all caught. Frontend 30 on the first pass, 25 caught; the five survivors got tests or proved equivalent (attaching at arrival, which the settle overwrites). Second pass 6, 3 caught; the two real survivors (co-node shift, no carrier) caught after new tests, one equivalent (carried keyed on node only, same result for node-centre anchors). Third pass 4 (dragged flag, release and claim), all caught.
- Live at 1440 on isolated ports: pin plain and lane 200, propose 201, accept 200; tabs A, B and a later C show the same three cursors (Claude, Claude · 2, Claude · 3), none doubled. Network canary blocked 8000, 8005, 5173, 8840 and outside; 0 page errors.

## Round 4b

Review 4 (boundary and accept; motion, look and live) and GM's answers (r10, r11). The spec's "Rulings from #211 review 4" section is the source.

### The presence exit (GM r11 item 1)

- **Every removal fades.** A cursor the store drops (a prune, a number taken over, a demoted tab, a refused hello, a forgotten token, the cap, a replay that no longer lists it) stays drawn for one exit. The layer keeps the removed cursor's last event and renders it as leaving. The tip, the name pill and the say pill are one element, so they fade together, on the planner's opacity spring (`stepExit`, the same spring idle dimming uses). The cursor stops where it is. Once the fade is at rest, the cursor is forgotten. Under reduced motion it goes in one frame. A frame gap past the stale gap (a hidden tab) ends the exit at once.
- **While it leaves,** it takes no events. It isn't counted for de-stacking: it leaves the field as its exit starts, so another cursor heads for the spot while it fades. It paints under every live cursor, and it isn't announced (`aria-hidden`).
- **Number takeover.** When a live cursor shows the same name, the leaving one hides its pill at once (`data-taken`, `visibility: hidden`). Live, at every frame of the exit, at most one "Swap · 2" pill showed.
- **Return mid-exit.** The same key coming back ends the exit, and the same view continues: the fade reverses on the same spring from where it was, and no second cursor mounts. A return through a replay (a reconnect) is put on its spot and its fade reverses too. The store now keeps counting `seq` across a cursor's exit (`nextSeq`), so a timer keyed on the old seq (idle, say, ripple) never applies to the returning event.
- **Demote is the same exit** (GM r10 item 2: "drops" means the normal exit). Live, a demote of two numbered cursors faded over 46 frames; the real path (a backend restart with a new token) did too, over 46 frames.

### Any person move carries resting cursors (GM r11 item 2)

- A drag sets React Flow's `dragging` flag. A keyboard nudge (arrows, Shift+arrows) and Arrange (the whole canvas or the selection) don't, but all three end in `graphStore.persistNodePositions`. That call now records where the person put each node (`lib/personNodeMoves.ts`, bounded at 2,000 nodes). The layer treats a node at the person's spot as the person's move, so a resting cursor rides it at 0 px. (Round 4c replaced this: a position match also matched a sync or an agent that put the node back on the person's spot, and the record outlived `loadGraph`. See "Round 4c" below.)
- **Jumps are read from the carrier now,** not the de-stacked spot. A step aside is 26 px, past the 24 px re-plan distance, so with the new pill step it would otherwise have flown an arc instead of landing on the land spring. A test pins it.
- At 300% zoom, the tests show 0 px trail and 0° lean for a 20 px Shift nudge, a 5 px nudge and a 300 px Arrange, and a sync still flies. Live, 10 Shift+ArrowRight presses at 300% moved the node 180 flow px. The cursor was 0 frames off its rest offset (0.003 flow px of float noise), had 0 lean frames and was never promoted.

### The accept past the agent memory (GM r11 item 3), and NIT-1

- An agent past `SESSION_AGENT_MEMORY` gets no click: its cursor is the unnumbered one, and nothing ties it to the proposing session. `_accepted_person_form` now calls `person_form(..., live_only=True)`, which lands only on a live slot the session already has, and returns None otherwise. Liveness and the slot come from one clock read, so a TTL running out between two reads can't bring an ended session's cursor back (review 4 NIT-1). On any failure the person gets nothing, never the bare agent form (R15, now pinned).

### The lost token (GM r11 item 4, review 4 LOW-2)

- `wsClient.sayHello` with no token now also dispatches `socketDemoted` for the current socket. A tab that forgot its link after a second 401 drops its numbered cursors on the exit, as on a refused hello. Tested in `personPromote.r29` (no hello sent, one `socketDemoted`). The `this.ws === socket` gate is pinned too: a refusal on a stale socket doesn't demote the tab (review 4 NIT-2, F10).

### The pill edge (GM r10 item 1)

- `will-change` is gone from the CSS. The layer sets it only while a cursor flies (a plan or a landing), and sets `auto` at rest.
- At rest a cursor is drawn on whole device pixels. The pane's offset, the pan and the zoom are all counted, and the device pixel ratio too (2x gives half pixels). The snap is in the drawing only, never in the motion, so nothing drifts.
- **No frame jump at the switch.** The landing aims at the snapped spot (`restOffset`), so the last flying frame and the first at rest differ only by the land spring's own last step. Live, the demote switch moved the pill 0.062 px (the step before it was 0.044 px). Without the aim it would have been up to half a pixel; the layer test's fractional case gives 0.54 px. The promote switch is the flight's first step (1.36 px of motion).
- **Black pill at rest, Restraint.** The ring is crisp: 102 on #000, 3.66:1. On the classic #111 canvas (a diagnostic) it is 111, 3.76:1. Round 4 measured 2.19:1 and 2.13:1 under `will-change`.

### The pill step (GM r10 item 3)

- A later cursor whose target is within 16 px of an earlier one's lands 10 px right and 24 px down (one pill height, 20 px, plus 4). A third goes one more step. `AGENT_CURSOR_PILL` holds the pill's box from the tip, and a test checks it against `agentCursor.css`. The most recently active cursor still paints on top, and each cursor keeps its step offset through a drag (the round 4 carry rules).
- Tests cover 2 and 3 cursors at pill widths of 30, 60 and 140: no pill boxes meet, and no tip is on another cursor's pill, at rest and after a drag. Live with three cursors: 0 pill overlaps at rest, during 51 drag frames and after the drag.
- **For GM:** the arrow's bounding box of each later cursor overlaps the lower-left corner of the earlier pill by about 15 × 13 px. The arrow covers part of the earlier pill's left end (its padding, not the text), and that shows in shot 3. A step of about 14 px right instead of 10 would clear it.
- **The dimmed "Claude" in round 4's shot 4** is the spec's idle state (§3 "Idle": 0.45 after 20 s with no event). It's not a style outside the spec.

### LOWs and NITs

- **L2 (fling at every-other-frame input).** The person's own drag latches the hold on its first jump (`dragged || chase >= 2`). At 60 and 120 Hz with a move every other frame, the action fires within 30 ms of the drag's end (tests).
- **LOW-1 (cursor-event guard), tests only.** The AST guard now catches every shape review 4 found: the quiet helper, `broadcast_browser`, `_broadcast_presence(e, e)`, annotated and tuple assignment, walrus, `{**e}`, `dict(e)`, `e.copy()`, `json.dumps(e)`, an alias, `agent_presence.point`, a literal or f-string dict, a socket's `send_text`, and an event built in one function and sent from another. Review 4's four real edits to `main.py` (G01–G04) now fail it. `conftest.py` also checks behaviour in every test: the ConnectionManager's senders record a targeted `agentPresence` that didn't come through `_broadcast_presence`, and that test fails. The wrappers are installed once per run, so a monkeypatch saves and restores the checked sender. A subprocess test shows the hook failing a stray send. The backend itself doesn't refuse (that would change the boundary; it's for Justin).
- **NIT-2.** R15 and F10 are pinned (above). F11 is pinned too: the feed holds only graph clears and replacements.
- **NIT-3.** The feed keeps the latest replay apart from its bounded ring, so 64 events after it never push it out.
- **NIT-4.** The NIT-2 line above, the feed test's title, and the PR body's guard sentence are fixed.
- **N1.** A test covers the carry rule's "already beside" check: a cursor riding n1 beside a later cursor on a flow point keeps its order through a small drag.

### Checks (round 4b)

- `tsc -b` exit 0. `npm run lint` exit 0: eslint, `check:inline-styles` (255 files) and `check:slava-css-scope` (4 files).
- Focused vitest, `--maxWorkers=2`, 133 files in four runs (every test that reads `src/` or `styles/`, plus the cursor, presence, promote, entry-split and graph-store move tests): 562 + 354 + 600 + 552 = 2,068 passed, 0 failed, no timeouts.
- Isolated pytest, 120 files (every file that touches presence, broadcasts, cursors, pins or proposals; the new conftest check ran in each, but review 5 found that a fixture patching `broadcast_raw` before it was installed blinded it for the rest of the run, so it did not hold in all of them; fixed in round 4c), in three runs: 1,227 + 2,140 + 900 passed. One known failure: `test_cli_apply.py::test_arrange_from_the_builder_and_in_the_reply`, the existing order leak after `test_canvas_pins.py`. It passes alone.
- Build budget: pass. The entry is 443,226 B raw and 136,096 gzip (+169 B for `personNodeMoves`, the token demote and the feed's held replay). The cursor chunk is 22,723 B (round 4: 20,435), `wsClient` 2,550 B, the store 3,155 B.
- Mutation checks:
  - Backend: 16, all caught. The AST guard alone catches review 4's G01–G04.
  - Frontend: 29 on the first pass, 28 caught. The survivor, the leaving branch's own `release`, was redundant with the effect's cleanup, so it was removed; with both releases off, the strengthened test catches it.
  - Frontend, after that: 2 more for the whole-pixel landing, both caught.
- Live at 1440, Restraint, on isolated ports: the canary showed 8000, 8005, 5173, 8840 and outside blocked. 0 page errors, and only the canary's two requests were intercepted.

## Round 4c

Review 5 (boundary and exit; motion, look and live) and GM's answers (r12, r13). The spec's "Rulings from #211 review 5" section and line 66 are the source.

### The pill step (GM r12, r13 items 1-3)

- **Straight down, never right.** `stackStepPx` computes the step from the drawn shapes, not a constant: the arrow's path (`AGENT_CURSOR_ARROW_PATH`, the one the layer draws) with its 1.4 px stroke, and the round-ended pills with the 1 px edge ring on the name pill. The step is the smallest whole px that leaves 2 px between the later cursor's arrow and name pill and the earlier cursor's label block.
- **The result is 24 px below a name and 47 px below a name and a say.** GM expected about 26: review 5's table measured the arrow against the pill's rectangle. Against the painted round shape (GM r13 item 1), the wing clears the earlier pill by 2.04 px at 24, and the name pills are exactly 2 px apart with both rings, so 24 is the smallest that holds. A test measures this apart from the module (signed distances sampled along every outline): at least 2 px at the step, under 2 px one px above it.
- **Says count.** The field knows which cursors show a say (`setSay`, including a say fading out, and one shown before the first report). When a say shows or goes, the cursors below glide to their new step on the land spring. Says stay visible for every cursor.
- **Near targets join the column (M2).** A cursor aimed within 16 px of a live cursor's tip (or of a column member's own target, so a chain is one column) lands straight below the column's last cursor, in arrival order. Leaving cursors aren't in the field, so they don't count. A property test covers every integer aim 9 to 16 px away, with 2 and 3 cursors and says on and off: no painted arrow or pill comes within 2 px of another.
- **The node carry is per node position now.** It used to move the other cursors on a node by this cursor's own dx. When two cursors' frames ran in either order, that moved one twice or back, which the old 10 px right step hid but a column (x read from the head's tip) showed as a 4 px lag. Each report now carries the node's drawn position, and each other cursor moves by how far the node moved since its own last report.

### The exit (M1, GM r13 item 4)

- A leaving view keeps the peers count it had when its exit began and never updates its label, so `data-label` and the label's transform hold. The main effect's re-run on `leaving` no longer resets the phase. The say and idle timers stop for the exit. In CSS, a leaving cursor's label and name have `transition: none`, and a say pill's own fade animation is paused, so tip, name and say fade only together on the opacity spring.
- Live, two peers leaving together (the upper with a say), across 47 frames: 0 frames with a layout change, the name pill's own opacity at least 1 throughout, the say's own opacity at least 1, and element opacity 1, then 0.669, then 0.158 on both.

### Takeover (LOW-3, GM r13 item 6)

- `taken` latches for the rest of the exit (derived state in the view). A test takes number 2 over, then demotes the new holder: the old pill stays hidden on every frame, and never two "Claude · 2" show.

### Moves by cause (LOW-2, GM r13 item 5)

- `personNodeMoves` records the move itself: the position object the person's move put on the node. React Flow keeps that object on the node (`applyNodeChanges` assigns the change's position; `adoptUserNodes` spreads the node), so the record matches only while the node holds that very move. Any other move (a sync, an agent, another tab) puts a new object there and flies, even onto the person's spot. No position is compared.
- The person's own undo and redo now record the nodes they move (`applyHistory`). Every canvas replacement (`loadGraph`, `loadProjectGraph`, a replaced sync, a clear) forgets the record.
- Tests for each source: nudge, drop (not drag frames), Arrange, Arrange selected, undo, redo, a sync away and back onto the person's spot, a y-only sync, `loadGraph`, and the LRU refresh.

### The conftest guard (M3 and MEDIUM-1, LOW-1); tests only

- The checks are installed before any fixture (`pytest_runtest_setup`, tryfirst) and at the top of every `monkeypatch.setattr`. A bound copy of the class's own sender that a monkeypatch undo leaves on `main.manager` is dropped before and after each test. (The first try checked the wrapper's marker first; a bound method reads its function's marker, so the stale copy was never dropped. A mutant pins the order.)
- **Content as well as route.** No person-only frame (an `agentPresence` carrying `session`, or an `agentPresenceReplay`) may reach a socket that isn't the person's canvas. This is checked on the real senders, on every instance-level stand-in (wrapped as it goes in, signature kept), and on Starlette's `WebSocket.send_text`/`send_json` (so the hello's replay is checked against `browser_connections`). The route check stays.
- The stricter check found two stand-ins in `test_canvas_pins.py` that dropped `others=` when forwarding. They now forward it.
- An AST rule (`person_only_sends`) lists every person-only send in `main.py`. The only one is the replay in `websocket_endpoint`, inside the branch where `manager.promote(...)` verified the hello. The parse and walk are cached and the fixpoints stop early: the main guard went from about 1.5 s to under 1 s here (review 5 measured 6 s on its machine).
- Subprocess tests, run with `NEBULA_TEST_SHARD` stripped: each cursor file passes alone; a patching fixture can't blind the check; the check is in before the first fixture, even when the fixture itself imports `main`.
- The backend boundary is unchanged: no diff in `person_gate.py`, `scene_keys.py`, `person_session.py`, `main.py` or `services/`.

### NITs

- B1: `live_only` at exactly the TTL lands, and a moment past it doesn't. F5: a closed socket's late no-token answer doesn't demote the tab. The draw-time snap: a fractional pan at rest, and a ride's end, both on whole device pixels. `nextSeq`: an idle cursor whose say had ended comes back mid-exit neither idle nor spent. F9-F12: the name shows through a plain exit, no status role, the wire drops on the first exit frame, and a leaving cursor reads no hover boxes.

### Checks (round 4c)

- `tsc -b` exit 0. `npm run lint` exit 0.
- Focused vitest, `--maxWorkers=2`, 143 files in four chunks (every test that reads `src/` or `styles/`, the cursor, presence, promote and move tests, and the files main brought in). First run: 710 + 369 + 620 + 613 passed, with 2 failures. `round21Lines` matched the new leaving rule as the say rule, so the rule moved below the base one. The new property test hit vitest's 5 s timeout in the big run, so it now samples more coarsely and has a 30 s limit. Rerun of those two chunks: 711 + 614. Total 2,314 passed.
- Isolated pytest: 125 focused files (cursor, presence, pin, proposal, `cli_apply` and the round 4b list) 4,326 passed; a sample of 19 unrelated files, including 5 websocket ones, 671 passed. Each cursor file alone: sessions 53, review2 29, round4 40, round4c 24. The full suite wasn't run here (CI runs it); a partial run before it was stopped found only the pin stand-in, fixed above.
- Build budget: pass, 443,707 B raw and 136,243 gzip. The cursor chunk is 25,104 B (4b: 22,723).
- Mutation checks:
  - Frontend: 30, all caught. They include review 5's survivors (F1, F3, F5, F9-F12, the snap, `nextSeq`) and every round 4c change.
  - Backend: 15. B1 is caught. The first run left 4 survivors; new tests pin them, and they are now caught. The two early installs each survived alone (the stale-copy cleanup covers for them), so a probe now pins "in before the first fixture". Two AST survivors are pinned by new shapes ("replay's cursors alone", "bound later").
- Live at 1440, Restraint, ports 8780 and 5780. The canary showed 8000, 8005, 5173, 8840 and outside blocked; `blocked.log` holds only canary lines. 0 page errors.
  - Three cursors: steps of 24 and 24, dx 0, 2.0 px clear, 4 px between pills; the same through 61 drag frames and after.
  - With a say in the middle: steps of 24 and 47, the glide over 16 in-between frames (3.7 px per frame at most), and back to 24 when the say ends.
  - Near targets 10 px apart: one column, step 24.
  - Exit strip: as above.

## Round 4d

GM's r14 (the step) and r15 (answers to review 6), and review 6's findings. The spec's "Rulings from #211 review 6" section and line 66 are the source.

### The step (r14)

- The later arrow's painted top (stroke included) sits 4 px (`AGENT_CURSOR_STACK.gapPx`) under the bottom of the earlier cursor's whole label block. The block is the name pill with its 1 px ring, plus the say pill while one shows. All of it is computed from `AGENT_CURSOR_PILL` and the arrow's points. That gives 42 px below a name and 65 px below a name and a say.
- GM wrote "about 39 and about 65". The 39 measures from the tip point (1.5) instead of the painted top (0.8), and leaves out the ring. Measured consistently, both numbers come from one rule: the painted arrow top sits 4 px under the painted block bottom.
- The 2 px painted check stays as the floor.

### No foreign overlap anywhere (r15 item 1, review 6 HIGH-2 and LOW-2)

- **Joining.** `deStackLayout` places cursors in arrival order, in screen px. A cursor joins a column when either holds:
  - its target is within 16 px of a member's target (targets only; the tip clause is gone);
  - its shape at its own target meets any placed cursor (`cursorsMeet`): painted closer than 2 px, or either arrow inside what the other owns. A cursor owns the box from its arrow's top to 4 px under its label block, across its arrow and pills. An arrow in there reads as that label's owner.
- **Placement.** It goes straight below the column's lowest label block. If that spot meets another placed cursor, that cursor's column joins this one and the cursor steps on past it. Each step moves down past the cursor it met, so the loop ends.
- **Pill widths.** Widths come from text metrics on an `OffscreenCanvas`, with no layout read: the name's and say's text in the CSS font, the padding, and 2 px of margin. Where there's no canvas (jsdom), they're estimated on the wide side. Live, the estimates came out 2.5 to 5 px over the measured widths.
- **Review cases.** (0,19) and (0,30,15) now step 42/42. (0,60,0,0) puts the later two under the 60 px cursor. A target on another cursor's name pill to the right joins that column.
- **Fuzz.** 160 random sets of 2 to 5 cursors, at zooms 0.25 to 3, with random arrival order and says. Checked apart from the module (signed distances and the CSS numbers): no pair comes within 2 px, and no arrow sits inside a foreign unit.

### Nothing jumps (r15 item 2)

- Each spot carries a signature: the members it sits under, with their says. When the signature changes (a say, a join, a leave), the layer passes `shifted` to `stepMotion` and the cursor glides on the land spring.
- When a chain splits, every cursor that has to move glides together. A test covers the four-member chain from review 6 with its second member leaving. The two below glide 42 px, the step between them never closes, and no frame moves 12 px.
- A middle member leaving closes up under its fading self, as GM ruled.

### Zoom (r15 item 4, review 6 MEDIUM-1)

- Steps are screen px. With the signature unchanged, the spot moving on its carrier (a zoom, the column's head carried by its node) carries the tip kinematically.
- A resting cursor is placed in the zoom's own frame. The store subscription runs the loop right away when the zoom changed, instead of waking it for the next frame. Live, the first build without this showed steps of 37 to 53 px while zooming, one frame late.
- A cursor carried by a node with a new stamp joins on `targetsMeet` (the same rule), not the old 16 px.

### Says (r15 item 3, review 6 LOW-1)

- **Appearing.** A new say pill mounts hidden (`data-say-wait`; CSS sets `animation: none; opacity: 0`). The loop keeps running until the room under it is clear: no resting or landing cursor meets the cursor with its say, measured at their drawn positions. Then the attribute goes and the say fades in on its own animation.
  - There's a 600 ms cap.
  - Cursors that are flying don't count. That exclusion has no test: the F24 mutant survives.
  - Live, the say waited 13 to 14 frames (about 230 ms), and showed when the cursor below was 64.4 of its 65 px down.
- **Leaving.** A say that goes fades out first; the cursors below close up after.
- **Reduced motion.** Everything is instant: no wait.
- A say waiting through a hidden tab, or through a snap, shows on the next frame.

### The conftest guard (review 6 MEDIUM-1, LOW-1, N1, N4); tests only

- Markers are read with `is True`. A Mock makes up the marker attribute, so 16 files' AsyncMock stand-ins used to pass as already checked.
- Stand-ins are wrapped in `_CheckedStandIn`, a proxy:
  - a call runs both checks, then the stand-in;
  - attribute reads and writes go to the stand-in, so `await_args` and `assert_awaited_once_with` still work.
- `send_bytes` is wrapped, and bytes are decoded.
- The header no longer claims the check can't be blinded. LOW-1's other routes (a class patch, `mock.patch.object`, a thread after the call phase) are named as gaps, with the AST guards covering `main.py`.
- **AST (LOW-2, N2).** `person_only_sends` now also reads:
  - a dict with a `"session"` key built from presence (a literal `agentPresence` type, or a spread);
  - `e["session"] = ...` on a bound name;
  - `dict(type="agentPresenceReplay", ...)`;
  - either branch of an `if`;
  - a loop over a list of person-only frames;
  - `self.x`;
  - `functools.partial(sender, ...)` and `getattr(manager, "<sender>")`.

  There are 12 new person-only shapes and 3 new allowed shapes. `main.py` still has exactly one person-only send, the replay after `promote`.
- **personNodeMoves (LOW-3).** A test for each clear (a replacing sync, an agent's clear, a project load), and a y-only undo.
- The backend boundary is unchanged: no diff in `main.py`, `services/`, `person_gate.py`, `scene_keys.py` or `person_session.py`.

### Checks (round 4d)

- `tsc -b` exit 0; `npm run lint` exit 0.
- **Focused vitest.** `--maxWorkers=2`, 143 files in four explicit arrays: every test that reads `src/` or `styles/`, plus the cursor, move and promote files. 731 + 369 + 624 + 614 = 2,338 passed. The cursor files were rerun after the last layer change: 272 passed.
- **Isolated pytest.**
  - 125 focused files: 4,346 passed and 1 failed. The failure is `test_cli_apply::test_arrange_from_the_builder_and_in_the_reply`, an order flake after `test_canvas_pins::test_websocket_sends_pins_after_graph_sync`. It fails 1 run in 4 with main's own conftest and tests too, so it isn't from this PR. A socket closed mid-send seems to leave `websocket_endpoint` without its `disconnect`. That's in `main.py`, which is out of scope here, so it's noted, not fixed.
  - Each cursor file alone: sessions 53, review2 29, round4 40, round4c 42, canvas_pins 39.
  - The 16 AsyncMock files: 1,110 passed.
- **Build budget.** Pass: 443,707 B raw and 136,226 gzip. The cursor chunk is 29,081 B (4c: 25,104).
- **Mutation checks.**
  - Frontend: 30 run.
    - Caught: all but two. That includes P3 to P6 (review 6's survivors) and the same-frame zoom carry.
    - F10 (no merge on hit) was equivalent, so I removed that code.
    - Not caught: F9 (no arrow-to-arrow distance) and F24 (flying cursors count for a say's room). F9 is equivalent: the pills hang right-below every arrow, so two arrows can't come close without a pill or an owned box meeting first. F24 has no test.
  - Backend: 18, all caught. They include review 6's C15 (bytes decode), A2 and A5, the proxy, the `is True` marker and every new AST reader.
  - N3's four redundant conftest layers are equivalent mutants (review 6 agreed) and weren't re-run.
- **Live at 1440, Restraint, on 8780 and 5780.**
  - The canary blocked 8000, 8005, 5173, 8840 and outside. `blocked.log` holds only canary lines, and there were 0 page errors.
  - Three cursors: steps of 42 and 42, dx 0, least painted gap 4.8 px, 0 pairs meeting. The same through 67 drag frames.
  - Zoom: from 1 to 0.5 the steps were 41.999 to 42.001 px over 41 frames; from 0.5 to 2 the same.
  - A say on the top cursor: hidden for 13 to 14 frames while the second glided to 65, then faded in.
  - A say on the middle cursor: steps of 42 and 65, with the glide over 17 in-between frames at 2.67 px per frame at most. Back to 42 and 42 after.
  - Near targets 10 px apart: one column, step 42. (0,30,15): steps of 42 and 42.
  - The node library panel a new project opens with still covers the node's left side in shots 3 and 5.

## Round 4e

Review 7 (one MEDIUM, three LOWs that each broke a GM rule) and GM's r17. The spec's "Rulings from #211 review 7" section is the source.

### The head moves (review 7 MEDIUM-1, LOW-1)

- A spot change counts as a ride only when it comes from a zoom or a node being carried. When the head moves by its own event (a new target inside its stamp radius), the layer bumps that cursor's `revs`, and the cursors below see it as a layout change and glide on the land spring.
- **The column floor.** Each frame, a landed cursor in a column can't sit closer than one step under the cursor above it, as drawn: `floor = above.y + step(above's say)/zoom`, and its downward speed is at least the above's. A resting cursor whose above is flying or landing is turned into a landing cursor so the floor holds it too. The above pushes its members on the same frame it steps (`holdBelow`), only if they've stepped this frame or have no frame pending, so nobody moves twice in one frame. This is the structural fix for LOW-1 as well: the members no longer depend on which view's frame runs first.
- The floor skips a cursor whose last step ran at another zoom, so a zoom mid-glide rescales it before anything pushes it (mutant E29 pins this).
- Review 7's P1 cases (0,−10), (12,0), (0,10), (−12,−8) are tests: no member moves 12 px or more in a frame (measured at most 1.7), the step never goes under 42, and nothing meets while the head flies. A drag ride stays kinematic. Live, the head moving up gave members at most 1.63 px per frame and a least step of 42.

### Says (review 7 MEDIUM-2, GM r17 items 2 and 3)

- **A say never joins.** Joins use name-only shapes: a target within 16 px, or an arrow meeting a name pill. The step inside a column still counts says (42 under a name, 65 under a say). The fuzz now checks name-only shapes across columns.
- **Waiting for flyers.** A say waits for a flyer whose drawn arrow is inside its room, or whose landing spot is under the speaker (it lists the speaker in its `above`). A flyer passing through doesn't count. P3 and P5 are tests, and they pin F24 (now E6 and E7).
- **The room.** A cursor blocks a say only when it meets the speaker with its say but not without it, at the cursors' drawn positions and real widths, with their says as painted. The cursor right below waits the say until it's a full say step (65) down.
- **Left flip.** When the right side touches a foreign cursor, the say tries the left of its own arrow: on the say row, its right edge 4 px left of the tip (`AGENT_CURSOR_SAY_LEFT_GAP_PX`). A left say owns its own box (`sayUnit`); the arrow and name keep theirs.
- **The log.** If both sides are blocked, the say waits up to 600 ms, then leaves the canvas (`data-say-wait="log"`) and comes back when a side clears, if it's still current. The Agent log already shows says: a cursor event's line is `event.log || say`, and the backend sets `log` only when it adds words the bubble leaves out. So no new copy was needed. A say in the log keeps the 65 px under its cursor reserved, so the column doesn't jump when it returns.
- Inside its own column, the review 6 rule holds: the cursors below glide first, then the say fades in.
- Under reduced motion, the say skips the wait and goes straight to its side or the log.

### Column cap (GM r17 item 1)

- A column draws at most 3 cursors (`AGENT_CURSOR_COLUMN_DRAWN`). With 4 or more members, the third slot is a count cursor: a neutral arrow and pill (`#52525b`) reading "2 more" or "3 more". Hovering lists the names (up to 3, then a count line). Its aria-label starts with the visible text ("2 more: Pair · 3, Pair · 4"). It isn't focusable because the other cursors aren't either: all of them are `role="status"` with no tabindex.
- **For GM:** the latest arrivals fold into the count. When columns merge, each part keeps its drawn cursors. Folded cursors fade out (opacity 0, `aria-hidden`, no say).
- In an upward chain a folded cursor's target can sit above its slot, but it isn't drawn. No drawn cursor rests more than 2 steps below its target, tested at zooms 0.25 to 3.
- When members leave, the count opens back into full cursors on the spring. An opening cursor isn't held by the floor while it rises into its slot. Live, it moved at most 6.6 px per frame.

### Zoom during a glide (review 7 MEDIUM-3)

- `CursorMotion.lastZoom` records the zoom each step ran at. While landing, a changed zoom rescales the offset from the live spot and the velocity by `lastZoom/zoom`, so steps stay in screen px.
- The zoom subscription now steps gliding cursors too, on the same frame (dt 0), not only resting ones.
- Tests start the zoom one frame after a say, through `setViewport`, keyboard zoom and pinch.

### Font load (review 7 MEDIUM-4)

- The widths memo depends on a `fontVersion` that the layer bumps on `document.fonts` `loadingdone`, and an effect calls `document.fonts.load()` for each name and say. `textWidthPx` rebuilds its canvas context if the `OffscreenCanvas` constructor changes. There are still no per-frame layout reads.
- Tested with a mocked FontFaceSet and a stub canvas, with a Greek name. Live, the Greek pill's reserved width went from 133 px before the load to 139 after it, against 136.4 drawn, with the cursor below 5 px clear.

### Boundary guards (review 7 LOW-A, LOW-B, NITs), tests only

- **The AST rule.** Any dict literal or `dict()` call with a `"session"` key is flagged unless its `"type"` is a literal outside the person-only set. It also reads:
  - aliases, lambdas, partials and `getattr` of person-only functions;
  - stored partials, and sender aliases through an if-expression or a dotted name;
  - `getattr` with a variable;
  - `update`, `setdefault`, `|=` and `|` on a session dict;
  - subscripts, spreads and `.encode()`.
  `SENDERS` adds `send_bytes` and `send`.
- **LOW-B.** Each of the four one-sided readers is pinned from both sides. There are new person-only shapes, plus 8 allowed shapes with ids.
- **NITs.** A stand-in skips wrapping only if it really is a checked wrapper. `_CheckedStandIn` has `__delattr__` and a `<checked …>` repr. Bytes frames decode with `json.loads(bytes(data))`, which covers bytearray, a BOM, UTF-16 and UTF-32, and falls back to a replace-decode for bad UTF-8.
- There's no diff in `main.py`, `services/`, `person_gate.py`, `scene_keys.py` or `person_session.py`. Agent reads and the POST `/api/canvas/cursor` response are unchanged.

### NIT-1 and NIT-2

- **NIT-1.** The layout runs once per frame for all views. It's cached on the field, keyed on a version (bumped by any target, stamp, label or arrival change), the zoom, and the unlanded cursors in eta order. Mutant E27 (no version in the key) is caught.
- **NIT-2.** The 4.8 px is on purpose. The step is `ceil(label block bottom + 4 − arrow top)`, and the arrow's painted top is at 0.8 px, so whole-px steps add 0.8 px. Whole-px steps keep the pills on the pixel grid, so they stay crisp. Under a say the block ends at the say pill, which has no ring, so the painted gap there is 5.8 px (review 7's number). GM r16 accepted 42 and 65, so I kept them and didn't tighten.

### Checks (round 4e)

- `tsc -b` exit 0; `npm run lint` exit 0.
- **Focused vitest.** `--maxWorkers=2`, 144 files in four explicit arrays (every test that reads `src/` or `styles/`, plus the cursor, move and promote files): 779 + 376 + 632 + 599 = 2,386 passed.
- **Isolated pytest.**
  - 125 focused files: 4,383 passed and 1 failed. The failure is the same `test_cli_apply::test_arrange_from_the_builder_and_in_the_reply` order flake as round 4d, and the file passes alone (27 passed).
  - Each cursor file alone, with `NEBULA_TEST_SHARD` stripped: sessions 53, review2 29, round4 40, round4c 79, canvas_pins 39.
- **Build budget.** Pass: 443,707 B raw and 136,226 gzip, so the entry is unchanged. The cursor chunk is 35,605 B (4d: 29,081).
- **Mutation checks.**
  - Frontend, 29 of 29 caught (E1 to E29). They cover:
    - the floor, the push and the one-move-per-frame gate;
    - the head's own event read as a ride;
    - flyers, both inside the room and landing under the speaker (F24);
    - others' says (M4) and others' widths (M5);
    - the 600 ms cap (M1), the left flip, the log and its return;
    - the full-step wait, a say joining, the cap and which cursors fold;
    - the opening hold, the zoom rescale and same-frame zoom;
    - the font re-measure, the 2 px margin (M2) and canvas under-measure (M3);
    - the count wording and its aria, folded visibility, the layout cache key, the left say's own box, and the floor's zoom check.
  - Backend, 23 of 23 caught (B7 to B33). B21 (sender aliases read through one branch only) survived the first run, so I added an alias shape in the other branch, and it's caught now.
- **Live at 1440, Restraint, on 8780 and 5780, with the node library closed.**
  - The canary blocked 8000, 8005, 5173, 8840 and outside, with 0 page errors. The 11 shots have no md5 duplicates, and I opened each one.
  - Three cursors: steps of 42 and 42, least gap 4.8 px, 0 pairs meeting.
  - The say strip:
    - frame 0 before the say: step 42;
    - frame 1, mid-glide: 58.35 with the say hidden;
    - frame 2: 65 and 42 with the say in;
    - 17 frames waiting, never under 42, members at most 3.4 px per frame.
  - A middle say: steps of 42 and 65.
  - The head moving up: least step 42, members at most 1.63 px per frame, the head 1.42.
  - Count cursor: "2 more" with aria "2 more: Pair · 3, Pair · 4", and its hover list shows both names. Opening back, cursors moved at most 6.6 px per frame, ending at 42 and 42.
  - Left flip: the say drew left of its arrow, beside a foreign cursor, with 0 pairs meeting.
  - Wait then log: waiting at 250 ms, in the log at 900 ms (the Agent log line shows it), and back on the canvas on the right once the room cleared.
  - Greek name after the font loaded: the reserved width went from 133 to 139 px against a drawn pill of 136.4, with the cursor below 5 px clear.

## Round 4f

GM signed off round 4e's design in r18, with one change and one addition. The spec's "Rulings from #211 round 4e" section is the source.

### A say in the log keeps no room (r18 item 3)

- The layout counts only what is drawn. The view now tells the field a say is there only while it waits for its room or shows (`setSay` sets it with each say state). A say in the Agent log counts as none, so the cursor below settles back at a name step (42).
- **Coming back.** From the log, once another column no longer blocks a side, the say goes back to waiting as a new say does:
  - its wait clock starts again;
  - the layout counts it, so the cursors below glide down to the say step on the land spring;
  - then it fades in, right or left by the 4e rules.
  
  The 600 ms cap and the log fallback are unchanged. Under reduced motion, it decides at once.
- **For GM.** A say that waits and then goes to the log moves the cursors below twice: down while it waits, then back up to 42 once it's in the log. Both moves are glides on the spring.

### A folded member's say is in the log only (r18 item 1)

- A cursor folded into the count cursor draws no say, and the layout keeps no room for it. The count cursor draws none either. The Agent log lists it, as it lists every say.
- **For GM: unfolding.** When the member unfolds into a full cursor while its say is still current (within the say's 3 s), the say shows by the normal order: it waits for its room, then fades in. That's the natural reading of the spec, since an unfolded cursor is a full cursor.
- The layer also wakes a cursor's loop when it starts or stops drawing its say, as it does for idle. The mutant without this wake survives, and it's equivalent: in every unfold the member above glides, and the column floor wakes the one below.

### Checks (round 4f)

- `tsc -b` exit 0; `npm run lint` exit 0.
- **Focused vitest.** `--maxWorkers=2`, the same 144 files: 781 + 376 + 632 + 599 = 2,388 passed (the cursor files alone: 284).
- **Build budget.** Pass: the entry is unchanged at 443,707 B raw (136,254 gzip).
- **Isolated pytest:** not re-run. No backend or test file changed.
- **Mutation checks:** 6 of 6 caught (G1 to G6):
  - G1, the log keeps its room;
  - G2, the say shows at once on return;
  - G3, the old wait clock is kept on return;
  - G4, a folded member draws its say;
  - G5, a render re-reserves a logged say;
  - G6, the say never comes back from the log.
- **Live at 1440, Restraint, on 8780 and 5780, with the library closed.** The canary blocked everything else, and there were 0 page errors. The shots have no md5 duplicates, and I opened each one. Puppeteer's own Chrome download is no longer in its cache, so this run used the installed Chrome (156).
  - **Back from the log** (strip):
    - frame 0, in the log: the step is 42, with no gap;
    - frame 1, the right blocker gone: the say waits while the cursor below glides (46.5);
    - frame 2: the step is 65 and the say is in.
    
    The say showed after 18 frames at a 65.08 px step. The least step was 42 throughout, and the member moved at most 3.8 px per frame.
  - **Folded say:** four cursors, so the count reads "2 more". The fourth one's "Reading the brief" is in the Agent log, no say is on the canvas, and nothing moved.
