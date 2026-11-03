# feat/cursor-expression (2026-11-03)

Agent cursor Phase 2, "Expression": the visible thoughts. Built on GM - Design's
cursor spec (`.planning/private/cursor-design.md` §1, §2, §3's reduced-motion
rules, §6 Phase 2), GM r49 (build inputs) and GM r54 (default say lines and
timing). The branch is cut from `fix/cursor-followups` (#219) at 274ffc30,
because #219 hadn't merged. It stays clear of the carry/preview/layout code
that #219 round 3b is changing.

## What each action draws

The halo replaces the drop shadow (§1): a copy of the arrow in the agent's
colour, blurred by an SVG `feGaussianBlur` (stdDeviation 3), at 30%. Most
states show there.

| Action | Live | Reduced motion (still frame) |
|---|---|---|
| move | nothing | nothing |
| look | the halo dims to 18%; a blurred 90° arc sweeps one turn (1.4 s) | dimmed halo |
| think | the halo breathes, scale 1 → 1.12 and 30% → 14%, 1.1 s each way on a spring | steady halo |
| type | a caret at the end of the card's text field, blinking at 1.06 s while text arrives, solid while held, gone 0.4 s after the state ends. At a port (`n2.prompt`), a 2 px underline under that row's label. With neither on screen, the caret ends the say pill | steady caret or underline |
| click | the arrow presses to 0.88 and springs back; a ring blooms from the tip (r 4 → 20, stroke 2 → 0.5, opacity 0.7 → 0) | nothing |
| drag | the wire is React Flow's own `getBezierPath`, from the port to an end that trails the tip on a lag spring; the arrival presses and rings like click | no wire, nothing |
| run | the halo gives way to a thin 120° arc orbiting the arrow for one turn (1.2 s) | a full thin circle for 1.2 s |
| propose | dashed halo; mark slot: the ghost card's dashed outline | the same |
| wait | dashed halo; mark slot: the pin's badge with its note glyph | the same |
| error | one sideways shake, ±4 px on a low-damping spring; the halo flashes red once (400 ms) | a red halo for the gesture's length |

## The state machine (`lib/agentCursorExpression.ts`)

Pure, with no React or DOM.
- **Held states** are look, think, type, propose and wait. Each shows from the cursor's arrival until the agent's next event. look, think and type also end when the cursor goes idle (20 s). propose and wait wait for the person.
- **Gestures** are click, drag's arrival, run and error. Each plays once from arrival. look's sweep is a gesture inside its held state.
- **A new action with a look of its own replaces the current one at once.** A bare `move` (or an unknown action, which the store reads as move) holds a held state to at least 0.4 s. This is how "at least 0.4 s" and "replaces at once" are read together: only an event with no look of its own can be the "end" of a short tool call.
- **The same held action again carries on.** The breath doesn't restart, and a second type event counts as a keystroke.
- **A landing nobody watched plays no gesture.** That covers a hidden tab, a replay and a stall. A held state still shows.
- **Timers:** the view re-renders only at `nextChangeAt`. Nothing runs per frame for the expression.

## Default say lines (`lib/agentCursorSays.ts`, GM r54)

Every template is in that module and pinned word for word by
`tests/agentCursorSays.test.ts`. The agent's own say always wins. Defaults are
display only: the aria-label and the Agent log keep the agent's words.

- look: Looking at “Brief” / Looking here
- think: Thinking
- type: Writing the prompt for “FLUX.2” / Changing “Resolution” on “FLUX.2” (a port's row) / Changing “Resolution” / Writing
- drag: Connecting “Brief” to “FLUX.2” / Connecting to “FLUX.2” / Connecting (to a spot, only with a start) / none
- run: Started “FLUX.2” / Started a run
- propose: Waiting for your OK
- wait: Waiting for your answer
- error: Couldn’t run “FLUX.2” / Couldn’t change “FLUX.2” / Couldn’t do that
- move, click: none

**Error cause (r54 item 2).** The cause is known from the event's `did`: the agent's last action, which every person-form event carries with its age. `errorCause` reads it as follows:
- `Ran` or `Tried to run` on the same node within 60 s is a run.
- `Changed`, `Renamed`, `Added`, `Connected`, `Disconnected`, `Moved` or `Removed` on the same node within 60 s is a change.
- Anything else is unknown.

The backend's own refused-run event (`main.py`, `shows="error"`) already sends its own say, so the defaults only matter for an agent's `point_at --action error`. The 60 s window is a build value (`AGENT_CURSOR_ERROR_CAUSE_MS`).

**Drag to a spot (r54 item 3).**
- The layer draws a wire only when the event has a `from` (`dragging = action === 'drag' && from !== undefined`).
- Every backend drag carries an origin (`main.py`, the connect routes).
- So a drag with a start is always a wire being pulled, and "Connecting" shows.
- `nebula point 120,40 --action drag` with no `--from` draws no wire: the cursor only moves, so it shows no line, like move.

**Names over the say cap.** A line longer than 140 characters (the backend's `MAX_SAY_CHARS`) cuts its names in the middle, evenly, then passes each through `nodeNameList`.

**Timing (r54).**
- An agent's say holds for max(3 s, 60 ms × characters), at most 8 s (`AGENT_CURSOR_SAY_HOLD`). Characters are counted as code points.
- Default lines follow the same rule, except think, propose and wait. Those three have no timer and hold as long as their state; propose's and wait's also stay through idle.
- look's sweep (1.4 s) ends inside the normal 3 s hold, so look takes the normal hold.
- The Agent log's "still current" check for a replayed say still uses 3 s (`AGENT_SAY_MS`). It is unchanged, out of scope here.

## Constants (`lib/agentCursorTuning.ts`, GM r49 ask 1)

Every (t) number lives in this one module, each with its spec line beside it:
- Phase 1's bow, duration, land spring, lean and lean spring, moved here from the planner. The planner re-exports them under their old names.
- Phase 2's values.

The layer passes them to CSS as custom properties (`cursorSpringVars`), so a retune is a one-line diff. Values the spec doesn't number are marked "build":
- the press spring;
- the ring spring;
- the breath curve;
- the shake spring;
- the wire's lag spring;
- the arcs' radius and stroke;
- the dashed halo's grow and dash;
- the flash peak;
- the mark centred on its (14, 14) offset.

## Springs only

- **Press and shake:** `impulseCurve` integrates the spring from rest with a kick and samples it into a CSS `linear()` that leaves 0, peaks at 1 and returns to 0, so one animation plays one press, or one shake.
- **Sweep, orbit and ring:** these use `stepCurve`.
- **Flash:** the fade spring.
- **Breath:** a critically damped curve each way, running `alternate`.
- **The caret's blink:** it holds each half, so its curve changes nothing. `agentCursorCss.test.ts` still finds a spring on it.

## Other decisions and surprises

- **The red is `--sr-danger-ink`, not `--sr-danger`.** In Slava, the bare `--sr-danger` alias is the orange accent. The destructive-colour ratchet (`agentPresenceFollowups.ratchet.test.ts`) refuses it there, and it also refuses a raw red.
- **The lean stays as built** (14° × tanh…): GM's prototype peaks are 6°, 12° and 14°. GM r49 says "10°". The two disagree, so this is flagged, not changed.
- **The mark slot overlaps the pills' left padding.** At (14, 14) from the tip, the 12 px box overlaps the name and say pills' left padding, which start at (15, 17). It paints above them (`z-index: 1`) and never over their text, because the text starts 9 px in.
- **The dashed halo reaches about 4 px above the tip.** It is the arrow grown 1.45× about its middle. The column step's arrow-top clearance doesn't count it, so GM may want a smaller grow.
- **Default lines change the layout.** A cursor that acts with no say now has a say pill (look, think and so on), so column steps take the say step. Four layer tests used `look` as an act with no visual. They now use `click`, because look draws and says.
- **The wire.** It is solid, 2 flow units wide like an edge, with the lag spring at k 900 / c 55. The first try, k 140 / c 19, left the end about 130 px behind at full speed, which looked detached.
- **The type caret.** It is drawn in flow coordinates beside the cursor (`FieldMark`), so it rides with its node and zooms with the card's text. It is measured with a mirror of the field at the state's start and on each keystroke (the node's data changing), never per frame.

## Dev-only states driver (GM r49 ask 2)

- **What it does.** `?cursorStates=1` on the dev server plays look, think, type, run, propose, wait and error on the first node, 3.2 s each, then loops. It sends local events to the presence store, so there are no backend or provider calls. `window.nebulaCursorStates.play('think')` shows one state on demand.
- **How it stays out of the build.** It is imported dynamically behind `import.meta.env.DEV`. `scripts/check-dev-only-code.mjs` runs as part of `npm run build` and fails if any of its markers reach `dist`. A planted marker made the check fail, as it should.

## Checks

- tsc, eslint and both style guards are clean.
- vitest ran on an explicit list of 52 files (`tests/agentCursor*`, `tests/agentPresence*`, `tests/presenceFollowups*`): 907 passed.
- New tests: `agentCursorExpression.test.ts` (each action, the hold rule, unwatched landings, the caret, the curves) and `agentCursorSays.test.ts` (r54's lines word for word, error cause, drag to a spot, middle cut, hold timing). `agentCursorLayer.test.tsx` gains Phase 2 per-action tests and 14 in-layer default-say and hold tests.
- 27 mutations, every one killed. One survived at first (the wait mark's glyph removed), and the test now checks the glyph.
- Backend, isolated: 7 files, 435 passed, including the "no backend string says wire" sweep. The new help text says "connection".
- `npm run build` passes the budget at an entry of 447,816 bytes raw. No Phase 2 string is in the entry. The dev-only check passed.

## Live (isolated backend 8966, Vite 5966, Chrome on a throwaway profile, 1440 × 900)

- Each state was driven with the real `nebula point --action` and shot at 1440, with a crop, live and under reduced motion. Filmstrips were taken for look, think and run (a frame every 100 ms). Shots are in the session scratchpad, `prB/live/shots`.
- Of 46 shots, 43 md5s are distinct. The three equal pairs are expected: live and reduced type (solid caret), propose and wait don't move.
- Five cursors (three thinking, two looking): 181 frames in 3 s, p95 16.7 ms, none over 20 ms. A 2 s trace showed Paint at 1.2 ms in total. `will-change` is `auto` on every resting cursor.
- The driver cycled look, think, type, run, propose, wait and error.
- The network guard's log held canaries only.
