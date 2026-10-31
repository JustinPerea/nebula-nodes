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
9. **First load.** The planner and the look rules live in the deferred `AgentCursorLayer` chunk (13.1 KB, was 4.0 KB). The eager store gained only the action list (a 9-line module), the session fields and their validation: the entry grew 514 bytes raw.

## The ten actions

- One list, in this order everywhere: `move, look, think, type, click, drag, run, propose, wait, error`.
  - `backend/services/cursor_actions.py` holds it. It has no imports, so the CLI's `--action` choices don't load `agent_presence` (about 65 ms per call).
  - `frontend/src/lib/agentPresenceActions.ts` is the frontend copy, re-exported by `wsClient.ts`. It's a module of its own because many tests mock `../src/lib/wsClient` with only `wsClient`. A value import from wsClient would throw under those mocks.
- One refusal sentence, GM's (round 2), built by `cursor_actions.refusal(value)`: `“hover” isn’t an action Nebula knows. Use one of move, look, think, type, click, drag, run, propose, wait or error.` It echoes the value the agent sent (a non-string as its JSON, cut at 40 characters with an ellipsis).
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
- A failure building the person form never silences the agent form or fails the route (round 2): `main._person_form` logs it to `nebula.presence` and sends the agent form to everyone.
- `person_form` returns the event object itself when nothing differs. `_broadcast_presence` then makes today's one-argument `broadcast_raw` call. Otherwise it calls `broadcast_raw(person, others=event)`, the split that already exists for the person and other sockets.
- Target-less events (`_say_agent_action`, the Agent log only) have one form, and they never create a session slot.

## Sessions

- **Where a session comes from** (`presence_session`, first valid one wins):
  1. An in-app chat's agent token. Its registry record has `session`, the workspace session id that Nebula sets when it mints the turn token, never the agent. It becomes `chat:<id>`.
  2. `X-Nebula-Agent-Session`. It is the MCP server's one-per-process `secrets.token_hex(8)`, or `NEBULA_AGENT_SESSION`. The header already existed for scene reads; presence only reads it.
  3. `X-Nebula-Cursor-Session`, a new header that only presence reads. The CLI sends `cc-<sha256(CLAUDE_CODE_SESSION_ID)[:16]>` when `NEBULA_AGENT_SESSION` is unset.
     - I checked the variable in the real environment of a Claude Code Bash call. A subagent sees its parent's value, and no per-subagent id exists, so a session and its subagents share one CLI cursor unless each lane sets `NEBULA_AGENT_SESSION`. The docs say so.
     - `CODEX_COMPANION_SESSION_ID` is also present, but it is copied from the Claude id, so it isn't used. No Codex session variable is verified.
  4. None. That gives one cursor per agent, as before.
- **Validation.** Every source must match `^[A-Za-z0-9_.:-]{1,64}$`. Anything else is dropped, and the next source is tried.
- **Display only.** The session is read in `presence_session` and used only by `person_form` and the slot table. It never reaches:
  - `identify()` or `AgentIdentity`;
  - the colour;
  - `person_gate` (its `AGENT_MARKER_HEADERS` are unchanged);
  - `scene_keys`;
  - `agent_spend`;
  - the token mint.
  - The CLI never puts its derived value in `X-Nebula-Agent-Session`, because that header keys scene-read guards.
- **The key.** It is `hmac_sha256(per-process secret, agent id + "\0" + raw)[:12]`. It's opaque, it differs per agent and per backend process, and it never contains the raw id.
- **Numbers** (round 2). A session's slot is made on its first event with a target, with the lowest number none of its agent's live slots holds. The slot keeps that number while it lives. The no-session cursor takes part too, and counts as 1 when it holds 1. It carries no `session` while it's number 1, so an agent with one plain cursor stays byte-identical on person tabs as well.
- **When a cursor leaves** (its number is then free). The backend and the tab use the same rules:
  - no event for 120 s: the backend's `PRESENCE_TTL_SECONDS`, the tab's `AGENT_CURSOR_EXPIRE_MS` (a test reads both files and pins them equal, with the idle time and the cap);
  - its node anchor goes: `forget_graph` (the canvas cleared or replaced, as a /clear that clears the canvas does) drops every slot on a node, and `forget_node` drops a slot whose node is deleted with no last known spot. Both match what happens to the agent's own cursor in `_agents`, and the tab's `forgetGraph`;
  - the cap pushes it out (below).
  - The backend drops expired slots lazily, on the agent's next event, which is the only time a number is given.
- **One source of numbers.** Only the backend numbers. A tab's clock and prune interval can lag the backend's by a moment, so when a cursor arrives with a number another cursor of its agent still shows, the tab drops that other cursor: the backend gave its number away because it left. Two cursors never read the same name.
- **A session that comes back after leaving is a new one.** It takes the lowest free number, which may differ from its old one. Round 1's 64-number memory per agent is gone; 256 agents with live slots are kept (least recently seen go first).
- **Cap.** An agent has at most 8 live slots (`SESSIONS_PER_AGENT`). A ninth removes the oldest slot idle for 20 s or more, else the oldest overall, before it is numbered, so it takes the number that frees. The frontend store has the same cap on cursors per agent: past it, the cursor heard from longest ago goes.
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
- **Long chords** (round 2, GM: follow-through ≤ 2 px on any chord). With GM's land spring (ζ ≈ 0.8) no velocity clamp alone gets there: from 600 px out it overshoots about 8 px even starting at rest. So past p = 0.80 the hand-off waits until `landFollowThroughPx` predicts 2 px or less (the arc keeps flying meanwhile). Moves up to about 1,500 px already predict under 2 px at 0.80 and are unchanged (the live table below). Rest times then: 967 ms at 2,000 px, 1,067 ms at 3,000 px, 1,200 ms at 6,000 px. GM also asked for rest under 1.0 s, which these springs can't give past about 2,000 px; that is open below.
- **Crossing flights** (round 2, GM). When a new flight overlaps another cursor's flight still in progress and their arcs pass within 24 px (`AGENT_CURSOR_CROSS_PX`, sampled along both), the later-starting one bows to the other side, same 10% / 120 px cap.
- **A tab coming back** (round 2, GM). An event older than its move would take (`Date.now() - receivedAt` past the move's duration, or the entrance for a first sighting) snaps the cursor to its latest target: no replayed flight, no ripple, no wire. The say shows only if it is still current (younger than `AGENT_SAY_MS`); otherwise the name only.
- **No layout reads per frame** (round 2). The layer caches the pane's rect and bumps a layout epoch on viewport change, ResizeObserver, window resize and arrival. Hover boxes are read once per epoch, not per pointermove; a flying cursor skips hover, and hover is re-tested when a cursor lands, so it can't go stale under a still pointer. A test counts `getBoundingClientRect` calls.
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
- **Fills** (round 2, GM's rule). Each session keeps its agent's hue and chroma and steps OKLCH L by 0, −0.10, +0.10, −0.20, +0.20, cycling after five (`AGENT_CURSOR_SESSION_LIGHTNESS`). A step that would go above 0.92 or below 0.35 mirrors. A result within 0.05 of a session already used takes the next unused offset. Chroma lowers only to stay in sRGB.
  - A white base shows as L 0.92 for session 1, so no fill is ever `#ffffff`.
  - **Added, for GM to confirm:** near either end of the band the mirrored offsets fold onto each other (from L 0.85, +0.10 and +0.20 mirror to 0.75 and 0.65, which −0.10 and −0.20 already took), so no unused offset is clear. Then the build steps on by 0.10 inside the band, nearest first. Results: base 0.85 gives 0.85, 0.75, 0.65, 0.55, 0.45; base 0.4 gives 0.4, 0.5, 0.6, 0.7, 0.8; white gives 0.92, 0.8, 0.7, 0.6, 0.5.
  - Black (L 0) mirrors up, but sessions 1 and 2 (`#000000` and `#030303`) look almost the same: OKLCH L 0.10 is still nearly black. The names tell them apart.
  - Live: Claude `#FF6B9A`, Claude · 2 `#db4a7c` (−0.10), Claude · 3 `#ffa8be` (+0.10).
- **Name text colour.** The higher-contrast of `#0b0b0c` and white against the fill. GM's "≥ 4.5:1" can't always hold with `#0b0b0c`: on fills near luminance 0.19 (for example `#138c03`) both inks give about 4.42 to 4.48:1, so the build falls back to `#000000` there. Every built-in colour still gets `#0b0b0c`, as today. (The prototype's 0.35 luminance threshold would give white on Claude orange at 2.70:1.)
- **The name and say rule.** With 2 or more cursors on the canvas the name is always on, moving or not, and the say pill sits under it and never jumps (round 2, GM). With one cursor the round 1 rule stands: the name hides while it moves and shows on hover and for 1.5 s on a first sighting; with the name hidden, the say pill moves up 24 px into its slot. Hover is hit-tested from the window pointer, since the layer keeps `pointer-events: none` (a CSS ratchet pins it). Focus has nothing to land on until Phase 3's name button.
- **No stacking** (round 2, GM: "the later one" is the cursor that arrived later). Cursors are placed in the order they came to their spots. Each starts at its target and, while it is within 16 screen px of an earlier cursor's placed tip and not already 10 px down-right of it, steps 10 px down and right. Testing placed tips, not targets, means a cursor aimed just up-left of an earlier tip can't land on it. A cursor's arrival stamp resets only when its own target moves more than 16 px, so two cursors on one spot keep their places when either acts. Recency only sets paint order: the most recently active cursor paints on top.
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
- **Session numbers** go among live sessions since round 2 (decision 3, GM's review). Two edges remain:
  - a /clear whose canvas clear is refused (a run going) leaves the old chat's cursor live for up to 120 s, so the new chat reads "Claude · 2" beside it, and keeps 2 after the old one leaves;
  - a tab gets cursors only from events after it loads (no replay on connect, as before this change). A session live on the backend but quiet since the tab loaded holds its number unseen, so a fresh tab can show "Claude" and "Claude · 3" with no 2, for up to 120 s.
- **Long chords rest past 1.0 s.** Follow-through is 2 px or less on every chord, but with GM's land spring the rest is 967 ms at 2,000 px, 1,067 ms at 3,000 px and 1,200 ms at 6,000 px. Under 1.0 s on those would need a stiffer, more damped land spring for long chords (new numbers from GM), or a lower duration cap. The deferral also moves the hand-off past p = 0.80 on those chords only.
- **Lightness fallback.** GM's rule leaves no clear offset near the band's ends (light bases like L 0.85, dark ones like 0.4); the build steps on by 0.10 inside the band. GM to confirm, and to say whether near-black sessions 1 and 2 (`#000000`, `#030303`) need a bigger first step.
- **Name text fallback.** GM to confirm `#000000` for the narrow band of mid-luminance fills where neither `#0b0b0c` nor white reaches 4.5:1.
- **Subagents share a cursor.** They see their parent's `CLAUDE_CODE_SESSION_ID`, so a session and its subagents share one CLI cursor unless each sets `NEBULA_AGENT_SESSION`. Over MCP they share the parent's server, so its one cursor. Round 2 documents it for orchestrators in `nebula --help` (a closing section), `nebula point --help`, `nebula agents --help`, the `point_at` docstring, `skills/nebula/SKILL.md` and `docs/MCP-SETUP.md`: what happens without it, and how to give each lane its own (`NEBULA_AGENT_SESSION=lane-a nebula point …` on every call the lane makes).
- **MCP and CLI together.** An agent that uses both under one name shows two cursors unless both set the same `NEBULA_AGENT_SESSION`. This is documented.
- **Two actions from Nebula's own edits:**
  - A rename stays `click` for Phase 1 (GM, round 2); any param value change is `type`.
  - A refused run shows `error`. GM's error row describes exactly that event.
  - Neither looks any different until Phase 2.
