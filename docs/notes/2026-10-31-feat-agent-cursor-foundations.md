# Agent cursor, foundations (feat/agent-cursor-foundations, 2026-10-31)

Phase 1 of the redesigned agent cursor: GM - Design's cursor spec, §3, §4 and §6 item 1. Justin asked for Cua's form of expression and movement, not a copy, with today's calm timing. None of Cua's artwork, palette, constants, names or frames is used; the numbers are GM's.

## The decisions, and how each was built

1. **Where a session comes from.** In-app chats: Nebula's own chat session, from the agent token's record (never the agent). An MCP server: one random id per process. The CLI: `NEBULA_AGENT_SESSION` if set, else a hash of `CLAUDE_CODE_SESSION_ID` (verified in a real Claude Code Bash call), else none (one cursor per agent, as before). Details under "Sessions". Chat titles don't exist in Nebula yet, so in-app chats are numbered like every other client.
2. **Display only.** The session is read in `presence_session` and used only by `person_form` and the slot table. Identity, colour hue, the person gate, scene keys, spend and the token mint never see it. Validation: optional, at most 64 of `[A-Za-z0-9_.:-]`, else dropped. Tabs get a 12-hex HMAC key, never the raw id.
3. **Numbering.** By first appearance, per agent, for the backend process's life, so every tab agrees on "Claude · 2". At most 8 live sessions per agent; the oldest idle one goes first, else the oldest. The frontend store caps at the same 8.
4. **Read boundary: holds.** What agents read is byte-identical apart from the action values they send themselves. Evidence under "The read boundary", plus the live check below.
5. **Actions at the boundary.** The route and MCP `point_at` refuse anything but the ten with a message that lists them; the CLI's `--action` has the ten as choices. The frontend reads an unknown action as `move`.
6. **Emitters.** Table under "The backend's own edits". The shown action reaches person tabs only; agents keep reading what they did.
7. **Agent surface.** `point_at` has the action list in its docstring; `nebula point --action` takes the ten; `docs/MCP-SETUP.md`, `skills/nebula/SKILL.md` and the README are updated in this change.
8. **Copy limits.** No Cua artwork, palette, constants, names or frames. Every number is GM's or derived from GM's.
9. **First load.** The planner and the look rules live in the deferred `AgentCursorLayer` chunk (13.1 KB, was 4.0 KB). The eager store gained only the action list (a 9-line module), the session fields and their validation: the entry grew 514 bytes raw.

## The ten actions

- One list, in this order everywhere: `move, look, think, type, click, drag, run, propose, wait, error`.
  - `backend/services/cursor_actions.py` holds it. It has no imports, so the CLI's `--action` choices don't load `agent_presence` (about 65 ms per call).
  - `frontend/src/lib/agentPresenceActions.ts` is the frontend copy, re-exported by `wsClient.ts`. It's a module of its own because many tests mock `../src/lib/wsClient` with only `wsClient`. A value import from wsClient would throw under those mocks.
- `POST /api/canvas/cursor` refuses any other value with a 422: `action must be one of move, look, think, type, click, drag, run, propose, wait, error`. A non-string value gets the same 422.
  - The route now checks the action before `_pointed`. Before this change, a list or object `action` reached `_pointed`'s dict lookup and failed with a 500.
- MCP `point_at` keeps `action: str = "move"` (no `Literal`), so the agent gets Nebula's own message rather than pydantic's report: `point_at: action must be one of … (you gave "hover")`. It refuses before any request. The docstring says what each action means.
- The CLI's `nebula point --action` uses argparse `choices`, which lists the valid values when a bad one is given. The default is unchanged: `drag` with `--from`, else `move`.
- The frontend reads an unknown action as `move` (`cursorAction` in the store), so a newer backend never breaks an older tab.
- The Agents panel's verb for a bare point is unchanged: only `move` and `look` name one. The eight others name nothing, so the agent's previous action carries, as `click` and `drag` already did. New panel verbs would be GM's copy.

## Two forms of one cursor event

The backend now builds two forms of each cursor event.

- **Agent form.** It is what `point()` returns and stores. It goes to every socket that isn't the person's canvas, and it is what `active()`, the snapshot, the roster and the start bundle read. It's the same as before, key for key and in the same order. The only difference: `action` can be any of the ten, and only when the agent sent that value itself.
- **Person form.** `AgentPresence.person_form` builds it, and it goes only to `manager.browser_connections` (the sockets a verified hello promoted). It is the agent form with up to three changes:
  - `action` is the shown action, the action a backend edit really was;
  - it gains `session: {key, ordinal}`;
  - for a line said in place, `target` is that session's own cursor.
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
- **Numbers.** Each new session of an agent gets the next number, by first appearance, on its first event with a target. The number holds for the backend process's lifetime, so every tab agrees on "Claude · 2". The no-session cursor takes part too. It carries no `session` while it's number 1, so an agent with one plain cursor stays byte-identical on person tabs as well.
  - Memory is bounded. Each agent keeps its last 64 numbers (least recently seen go first), and 256 agents are remembered. A forgotten agent starts again at 1.
- **Cap.** An agent has at most 8 live slots (`SESSIONS_PER_AGENT`). A ninth removes the oldest slot idle for 20 s or more, else the oldest overall. A slot older than the 120 s TTL is dropped on the agent's next event, and its number stays. The frontend store has the same cap on cursors per agent: past it, the cursor heard from longest ago goes.
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
| `apply_graph_edit` | click | click |
| `delete_graph_edge` | click | click |
| `run_graph`, one target | click | **run** |
| `_refused_cli_run` ("“X” can't run.") | click | **error** |
| `_say_agent_action` (no target) | click | one form |
| `POST /api/canvas/cursor` | the agent's own | the same, plus the session |

- A rename is typed text, but it stays `click`: the decision named only param and prompt edits. It's one argument to change.
- The refused run maps to `error`, not `click` ("the rest as they are"), because GM's `error` row describes exactly this event. Until Phase 2 both draw the same ripple.

## The frontend: motion and look

All of it is in the deferred `AgentCursorLayer` chunk: `lib/agentCursorPlanner.ts` (pure motion, no React or React Flow, so Phase 3's screen layer can reuse it) and `lib/agentCursorLook.ts` (names, fills, ink, the name/say rule, no stacking). Both are in `DEFERRED_MODULES`. `AgentCursorLayer.tsx` is rewritten on them.

- **Path.** One quadratic arc bowed 10% of the chord, at most 120 px, straight under 24 px. It bows away from the person's pointer when that is within 200 px of the middle of the path, otherwise toward screen-up. The layer keeps one window `pointermove` listener for this and for the name on hover.
- **Time.** `T = clamp(380 + 170·ln(1 + D/200), 380, 900)` ms, D in screen px. Progress is a critically damped spring with ω = 6.64 / T.
- **Landing.** At p = 0.80 the position and velocity hand over to `AGENT_CURSOR_LAND_SPRING` (k 260 / c 26). The tool's action (today's ripple) fires at the hand-off, as in the prototype.
- **Fixed 120 Hz step.** GM's measured numbers are what the prototype's own math gives at 120 fps (its hand-off velocity is a one-frame difference, so it lands differently at 60 fps). The planner steps at a fixed 1/120 s inside each frame and carries the remainder, so every display lands like GM's measurements. Tests check 30, 60 and 144 fps land the same.
- **Re-planning.** A new event, or a live target that moves more than 24 px from where the move aimed, re-plans from the current position and velocity. The new arc leaves along the current motion; when the cursor is fast the tangent reaches up to `speed / (2ω)` (capped at the chord) so the speed carries over with no jump.
- **Entrance.** A first sighting starts 64 px back along the line to its first target (up-left with no line) at opacity 0, and both spring in.
- **Idle.** Dims to 0.45 after 20 s on the fade spring (k 170 / c 26); pruned at 120 s as before.
- **Lean.** `14° × tanh(vx / 700) × min(1, speed / 250)` on a k 180 / c 22 spring, upright at rest.
- **Reduced motion.** A snap to the target, upright, with opacity set at once: no pickup leg, no ripple, no wire. CSS turns off the label and name transitions and the say and ripple animations.
- **Springs only.** `agentCursor.css` has no stock easing left. The wire uses `--agent-cursor-soft` (SPRING_SOFT) and the ripple `--agent-cursor-ring` (k 170 / c 26), both sampled by `springLinear` once and set on the layer root. The say pill's way in, the name's show and hide and the label shift reuse the existing `--agent-cursor-say-fade` curve. Opacity and the idle dim moved to the JS fade spring.
- **Constants.** New: `AGENT_CURSOR_LAND_SPRING`, `AGENT_CURSOR_LEAN_SPRING`, `AGENT_CURSOR_FADE_SPRING` and the planner's thresholds. `AGENT_CURSOR_SPRING` is unchanged (pins, ghosts, the camera and the offline spring-back share it), and a test now pins its values. `AGENT_DRAG_SPRING` is removed: nothing imports it any more.
- **Names.** "Claude", then "Claude · 2", "Claude · 3" by the backend's ordinal. `sessionName` also takes a chat title (cut at 20 characters), but nothing passes one yet.
- **Fills.** Each session keeps its agent's hue and steps OKLCH lightness 0, +0.10, −0.10, +0.18, repeating, lowering chroma only to stay in sRGB.
- **Name text colour.** The higher-contrast of `#0b0b0c` and white against the fill. GM's "≥ 4.5:1" can't always hold with `#0b0b0c`: on fills near luminance 0.19 (for example `#138c03`) both inks give about 4.42 to 4.48:1, so the build falls back to `#000000` there. Every built-in colour still gets `#0b0b0c`, as today. (The prototype's 0.35 luminance threshold would give white on Claude orange at 2.70:1.)
- **The name and say rule.** The name hides while the cursor moves. It shows when 2 or more cursors are on the canvas, on hover, and for 1.5 s on a first sighting. With the name hidden, the say pill moves up 24 px into its slot; with both, the name sits above the say. Hover is hit-tested from the window pointer, since cursors keep `pointer-events: none`. Focus has nothing to land on until Phase 3's name button.
- **No stacking.** A later cursor whose target is within 16 screen px of an earlier one's lands 10 px down and right per earlier cursor. It compares original targets: a moved spot 10 px diagonally is 14.1 px away, still inside 16, and would push twice. "Later" is by last event, so the most recently active cursor also paints on top.
- **Drag.** Its second leg starts once the cursor has nearly stopped at the source port, so it visibly touches the port before pulling the wire.

### Interim visuals until Phase 2

| Action | Draws |
|---|---|
| click, type, run, propose, wait, error | today's ripple on arrival, now on the k 170 / c 26 spring |
| drag | today's two legs, the straight dashed wire, then the ripple |
| move, look, think | nothing extra |
| anything else | the store reads it as `move` |

## Tests touched

- New, backend: `backend/tests/test_agent_cursor_sessions.py` (32 tests).
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

| Move | Settled (position at rest) | GM | Follow-through | GM | Peak lean | GM |
|---|---|---|---|---|---|---|
| 100 px | 467 ms | 465 ms | 0.16 px | 0.2 px | 6.2° | about 6° |
| 400 px | 733 ms | 721 ms | 0.63 px | 0.6 px | 12.3° | 12° |
| 500 px | 750 ms | | 0.73 px | | 12.8° | |
| 900 px | 833 ms | 823 ms | 1.24 px | 1.3 px | 13.8° | 14° |
| 1500 px (diagonal) | 900 ms | | 1.97 px | | 14.0° | |

- Settle times are within one 60 Hz frame (17 ms) of GM's, because the DOM is sampled per frame.
- The bow measured 10, 40, 50, 90 and 120 px toward screen-up, which is 10% of the chord, capped at 120.
- The lean's last fraction of a degree runs on a little longer. The loop sleeps once the lean is under 0.05° at 650, 817, 833, 967 and 1000 ms. On the 1500 px move that is about 1 s, with the position already still at 900 ms.
- **Name hidden while moving:** 0 frames showed the name in flight. During a move with a say line and two cursors on the canvas, the label read `say` in flight and `name+say` once landed.
- **Two sessions:** an HTTP session became "Claude", fill `#FF6B9A`. The CLI's session became "Claude · 2", fill `#ffa8be` (+0.10 L). Both had ink `#0b0b0c`. Their keys and numbers were the same across three page loads on one backend.
- **Refusals:**
  - `--action hover` from the CLI was refused, listing the ten.
  - `action: "hover"` over HTTP got a 422 with "action must be one of move, look, think, type, click, drag, run, propose, wait, error".
- **Reduced motion:** the move drew one frame at the start and the next at the target. There were 0 frames in between, the lean was 0 and there was no ripple.
- **What agents read, live:**
  - A plain `/ws` listener (no person hello) got 14 presence events, none with `session`. Their actions were only the ones the agents sent: move, look, run.
  - `GET /api/canvas/snapshot` and `GET /api/canvas/agents` carried no session or number.

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
- **Session numbers never reset** within a backend process (decision 3). After a few new chats, a lone chat can read "Claude · 4". GM may prefer numbering among live sessions.
- **Name text fallback.** GM to confirm `#000000` for the narrow band of mid-luminance fills where neither `#0b0b0c` nor white reaches 4.5:1.
- **Subagents share a cursor.** They see their parent's `CLAUDE_CODE_SESSION_ID`, so a session and its subagents share one CLI cursor unless each sets `NEBULA_AGENT_SESSION`. This is documented.
- **MCP and CLI together.** An agent that uses both under one name shows two cursors unless both set the same `NEBULA_AGENT_SESSION`. This is documented.
- **Two actions from Nebula's own edits:**
  - A rename stays `click`, because the decision named only param and prompt edits.
  - A refused run shows `error`. GM's error row describes exactly that event.
  - Neither looks any different until Phase 2.
