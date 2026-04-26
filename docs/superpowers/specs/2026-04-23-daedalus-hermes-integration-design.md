# Daedalus — Hermes Agent Integration (Design Spec)

**Date:** 2026-04-23
**Author:** Justin Perea + Claude
**Related research:** `~/Documents/Obsidian Vault/Research/topics/hermes-agent-v0.10.md`
**Driving event:** Nous Research + Kimi Moonshot "Hermes Agent Creative Hackathon" — submission due EOD Sunday 2026-05-03. 10 days.
**Goal:** Ship Daedalus as a user-selectable alt-agent in the nebula-nodes chat panel — an iterative, self-critiquing creative generalist powered by Hermes Agent + Kimi K2.6 — alongside the existing Claude chat flow.

---

## 1. Submission Narrative

**Daedalus = "the forge-god made into a creative agent."** A Hermes-powered chat agent that:

1. Plans multi-stage creative pipelines in nebula-nodes (image, video, audio, 3D — not 3D-only).
2. Builds each pipeline as nebula canvas nodes via the `nebula` CLI, live on-screen.
3. Inspects outputs with `vision_analyze` after each stage.
4. Traces detected defects to their earliest affected stage and fixes THERE, not downstream.
5. Logs what worked / didn't into a writable `LEARNINGS.md`, cites those learnings when applying them in later turns.

**Differentiation from Claude-in-nebula:**
- **Axis A (hero):** Iterative self-critique — Daedalus watches its own output, iterates until quality gates pass.
- **Axis B:** Rich creative toolbelt — `vision_analyze`, `delegate_task` (parallel sub-agents), Hermes skills, Kimi K2.6 native multimodal + 262k context.
- **Axis C:** Opinionated craftsman voice — narrates tradeoffs, names tools by reputation, admits limits.

### Demo video outline (45-60s)

1. Open nebula-nodes. Toggle chat-panel agent selector → **Daedalus**. Subtitle: *"Powered by Hermes Agent · Kimi K2.6."*
2. User: *"Build me a looping scene: foggy forest at dawn, camera drifts through. Cinematic."*
3. Daedalus narrates plan. Creates text-input + Imagen + Veo 3.1 (looping) + Preview nodes live on canvas. Applies the existing video-looping heuristic (first-frame = last-frame).
4. First pass runs. Daedalus calls `vision_analyze` on last-vs-first frames: *"Color grade drifted — end is cooler than the start. That breaks the loop."*
5. Traces defect to stage 1 (source prompt), rewrites Imagen prompt with color language baked in, reruns. Clean loop plays.
6. Daedalus: *"Saved a learning: `color grade drifted end-to-start on Veo 3.1 looping clips — always apply color via prompt on the source frame, not post.` Next time I'll remember."*
7. Cut to `~/.hermes/skills/daedalus-learnings/LEARNINGS.md` showing the fresh entry.

Optional Act 3 showing Step Approval mode.

### Why the framing wins the rubric

- **Creativity:** iterative self-critique is the creative act, not the one-shot generation.
- **Usefulness:** a real artifact is made; the learning is reusable.
- **Presentation:** canvas + chat + LEARNINGS.md file make the entire process legible on video.
- **Kimi track qualification:** Kimi K2.6 is pinned as the default model (see §7).

---

## 2. Architecture

```
Chat panel (React)                     Nebula backend (FastAPI)                  Hermes (CLI subprocess)
─────────────────                      ───────────────────────                   ───────────────────────
[Agent selector: Claude|Daedalus] ─► POST /api/chat {agent, message,           
[Autonomy toggle: Auto|Step]              session_id, autonomy}                  
     │                                  ├─ if agent=claude: run_claude()  ──►  claude -p (existing)
     │                                  └─ if agent=daedalus:                  
     │                                     run_hermes(                            
     │                                       message, session_id,                 
     │                                       autonomy)             ────────►  hermes chat -q MSG -Q
     ▼                                       ▲                                    --resume SESSION
[WebSocket /ws: events stream] ◄── text / approval_request / tool_use             --provider openrouter
                                   / learning / result events ◄── stdout parse    --model moonshotai/kimi-k2.6
                                                                                  --skills daedalus-core
                                                                                  (DAEDALUS_APPROVAL env)
```

### Key architectural decisions

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | CLI subprocess per turn (`hermes chat -q -Q --resume`) | Mirrors existing `claude -p` pattern; minimal re-architecture; ship in days not weeks. Gateway PlatformAdapter is the post-hackathon upgrade. |
| A2 | `moonshotai/kimi-k2.6` as default model | Canonical Kimi for hackathon Kimi track; 262k context fits skills + memories + canvas dump; native vision removes multi-provider juggling. |
| A3 | Daedalus skills ship in repo at `nebula-nodes/.hermes/skills/daedalus-core/` | OSS parity: cloning the repo + running setup gives every user the same baseline Daedalus. Read-only via Hermes `external_directories`. |
| A4 | Learnings live in writable `~/.hermes/skills/daedalus-learnings/LEARNINGS.md` | Personal per-user; agent writes via `skill_manage patch`; upstream contribution via user-authored PRs (learnings graduate into shipped skill over time). |
| A5 | Persona rides inside `daedalus-core` skill (top of SKILL.md) | Non-interactive `-q` mode doesn't honor `/personality` slash commands, but skills preloaded via `--skills daedalus-core` ARE loaded. User's default SOUL.md stays untouched; Daedalus's character is scoped to sessions that load the skill. |
| A6 | Autonomy toggle (Auto-pilot vs Step Approval) as header toggle in chat panel | Maps to `DAEDALUS_APPROVAL=auto\|step` env var passed to each subprocess turn; SKILL.md instructs pause-on-expensive-operation when step mode is on. |
| A7 | Daedalus uses `terminal` tool to call `nebula` CLI for MVP | No custom tool registration needed; pattern-parity with how Claude calls nebula today. Upgrade to typed `nebula_*` tools if latency/visibility suffers. |

---

## 3. Component Boundaries

### New: `backend/services/hermes_session.py`

Public: `run_hermes(message: str, session_id: str | None, model: str = "moonshotai/kimi-k2.6", autonomy: str = "auto") -> AsyncIterator[dict]`

- Same event contract as `run_claude` — yields dicts with a `type` field
- Event types: `session`, `text`, `tool_use`, `tool_result`, `approval_request`, `learning_saved`, `result`, `error`, `done`
- `approval_request` — emitted when Daedalus pauses for user approval in Step mode; payload: `{summary, cost_estimate, action_plan}`
- `learning_saved` — emitted when Daedalus appends to LEARNINGS.md mid-turn; payload: `{topic, entry_preview}`
- Internal: spawn `hermes chat -q MSG -Q --resume SESSION --provider openrouter --model MODEL --skills daedalus-core`, set `DAEDALUS_APPROVAL=auto|step` env var, capture stdout, parse markers (`APPROVAL_REQUIRED:`, `LEARNING_SAVED:`), emit events accordingly.
- Parser fallback: any stdout line not matching a structured marker gets emitted as `text`. Keeps the wrapper resilient to Hermes stdout-format drift.

### Modified: `backend/services/chat_session.py`

- No breaking changes to `run_claude` signature
- Add `AGENT_RUNNERS = {"claude": run_claude, "daedalus": run_hermes}` dispatch at top
- Add shared event types to the module docstring so downstream code stays agent-agnostic

### Modified: `backend/main.py`

- `/api/chat` accepts new `agent` and `autonomy` fields in the request body
- Validation: if `agent=daedalus` and `hermes` binary missing → 503 with `{detail: "Hermes Agent not installed. See docs/HERMES-SETUP.md"}`
- Dispatch: `runner = AGENT_RUNNERS[agent]` then iterate

### Modified: `frontend/src/components/panels/ChatPanel.tsx`

- Header row: agent selector (Claude / Daedalus), autonomy toggle (Auto / Step)
- Daedalus visual treatment: copper/forge accent color (e.g. `#b87333`) vs Claude's indigo
- Approval-request events render as an interactive bubble with Approve / Reject buttons + edit-plan textarea
- `learning_saved` events render as a subtle system line: *"→ Saved learning: [topic preview]"*

### New files shipped with repo

- `nebula-nodes/.hermes/skills/daedalus-core/SKILL.md` (persona directive at top, playbook below)
- `nebula-nodes/.hermes/skills/daedalus-core/metadata.json`
- `docs/HERMES-SETUP.md` — user-facing install + configure walkthrough

### Explicit non-goals (MVP — post-hackathon if time)

- Streaming token-by-token output from Daedalus (CLI mode returns complete turn; upgrade via gateway adapter later)
- Cross-agent handoff mid-conversation (no "hand this to Daedalus" mid-thread)
- Cron-scheduled Daedalus jobs (gateway-only feature)
- Voice mode (ElevenLabs TTS is a Hermes plugin but not needed for hackathon)
- Custom typed `nebula_*` tools via `tools/registry.py` — terminal tool is enough for MVP
- Gateway PlatformAdapter — deferred to post-hackathon

---

## 4. Data Flow — One Daedalus Turn

### Auto-pilot mode

1. User types message in chat panel, sends. Frontend POSTs `{agent: 'daedalus', message, session_id, autonomy: 'auto'}`.
2. Backend reads current `hermes_session_id` from chat state (null for first turn).
3. Backend spawns:
   ```
   hermes chat -q "<message>" -Q \
     --resume <session_id> \
     --provider openrouter --model moonshotai/kimi-k2.6 \
     --skills daedalus-core
   ```
   Env: `DAEDALUS_APPROVAL=auto`.
4. Hermes loads: the `daedalus-core` SKILL (persona + playbook — this is how Daedalus's character gets in; `--skills` preload works in `-q` non-interactive mode, unlike slash commands), user's default `~/.hermes/SOUL.md` (unchanged — user's global), `AGENTS.md` from nebula CWD, `daedalus-learnings/LEARNINGS.md` (visible in `skills_list` at session start), relevant `MEMORY.md`.
5. Daedalus executes turn. Uses:
   - `terminal("nebula create ..."| "nebula connect ..." | "nebula run ...")` — canvas mutations. These trigger our existing `graphSync` WebSocket events so the frontend canvas updates live.
   - `vision_analyze(path, prompt)` — inspects fresh output.
   - `skill_manage patch daedalus-learnings/LEARNINGS.md ...` — appends a learning when a novel insight fires.
   - Optionally `delegate_task("...")` — spawns a sub-agent (e.g. planner vs critic).
6. Hermes completes, prints final text + session ID on stdout.
7. Backend parses stdout: emits events per §3. Wraps up with `done`.
8. Frontend displays final response. Canvas already live-updated during the turn. If `learning_saved` fired, a subtle system line lands in the chat bubble.

### Step Approval mode

Same flow, except:

- `DAEDALUS_APPROVAL=step` passed to subprocess
- SKILL.md directive: "when `DAEDALUS_APPROVAL=step`, before any execution of a node whose estimated cost >$0.01 OR runtime >30s OR triggers an iteration, pause and print `APPROVAL_REQUIRED: <summary>\nPLAN: <action_plan>\nCOST: <est_cost>\n`. Do not continue the turn."
- Backend parses `APPROVAL_REQUIRED:`, emits `approval_request` event with structured fields
- Frontend renders Approve/Reject buttons on the approval bubble
- User clicks Approve → frontend sends a new turn: `"APPROVED: continue."` which Daedalus resumes from (via `--resume` + continuation prompt)
- User clicks Reject → frontend sends `"REJECTED: <optional edit plan text>"` — Daedalus adjusts or asks

Cost/time gating prevents chat-spam from trivial operations (node create, connect): only material actions (expensive `nebula run`, iteration triggers) prompt.

### Turn-end learning capture

- SKILL.md directive: "at end of each turn that produced insight worth saving, use `skill_manage` to append a timestamped entry to `daedalus-learnings/LEARNINGS.md`. Entry format:
  ```
  ## [YYYY-MM-DD slug] Title
  Observed: ...
  Fix: ...
  Confidence: low|medium|high — count of confirmations
  ```
  Print `LEARNING_SAVED: <topic-slug>` on stdout so the frontend can surface it."
- Backend parser converts to `learning_saved` event

### Apply-learning-with-citation

- SKILL.md directive: "at turn start, if LEARNINGS.md contains entries with tags relevant to the current goal, cite them in your plan. Format: `Applying learning [slug]: <one-line restatement>`."
- Makes the learning loop visible in every turn where it pays off

---

## 5. Daedalus Persona & Skill Content

### Persona directive (top of `daedalus-core/SKILL.md`)

The persona lives AT THE TOP of the `daedalus-core` skill rather than as a separate personality file. Rationale: `hermes chat -q` non-interactive mode ignores slash commands, so `/personality daedalus` wouldn't fire — but skills preloaded via `--skills daedalus-core` ARE loaded, and the agent reads the skill content as authoritative guidance for the session.

```
You are Daedalus — the forge-god made into a creative agent.

You build through a canvas called nebula-nodes. You speak
concisely, name your tools by reputation, and never ship a flawed
artifact without saying so.

YOUR SIGNATURE: the iterative loop.
1. Plan the pipeline. State the stages explicitly.
2. Build as nebula nodes via `terminal("nebula create / connect / run ...")`.
3. Inspect outputs with `vision_analyze`. Demand geometric specifics,
   not pattern labels. Use per-cell verdicts for multi-frame outputs.
4. If defective: trace to earliest affected stage, fix THERE, rerun.
5. Max 3 iterations per turn. Beyond that, explain and ask.

OPINIONS (share them in planning):
- Imagen is cleaner than Nano Banana for character faces.
- Veo 3.1 loops only when first_frame = last_frame at the reference level.
- Meshy multi-image-to-3D wants genuinely different views of ONE subject,
  not one image repeated. For single-image 3D: meshy-image-to-3d.
- Color grade is a stage-1 prompt concern on looping clips, not a
  stage-3 post filter — the loop breaks otherwise.

LEARNINGS DISCIPLINE:
- At turn start, scan daedalus-learnings/LEARNINGS.md for entries
  relevant to the current goal. If applied, cite: "Applying learning
  [slug]: <one-line restatement>."
- At turn end, if a novel insight fires (not already in LEARNINGS.md),
  append a new entry via skill_manage patch and print
  LEARNING_SAVED: <slug> on stdout.

AUTONOMY MODE (env DAEDALUS_APPROVAL):
- "auto": run the full pipeline through to a clean output, iterate as
  needed, cap at 3 iterations.
- "step": before any execution with cost >$0.01 or runtime >30s or
  iteration triggers, print APPROVAL_REQUIRED: <summary> with a PLAN
  and COST, then WAIT — do not act. Resume only when the next turn's
  user message starts with "APPROVED:" or "REJECTED:".

Your accent is copper, your temperament is methodical, and you never
forget a lesson twice.
```

### Playbook sections (body of the same `daedalus-core/SKILL.md`, below the persona)

Sections:
1. **Iterative-artist checklist** (restate the loop; explicit max-3 cap)
2. **Pipeline stage tracing** (generalized from pipeline_3d "fix at source"; include canonical stages for image, video, audio, 3D)
3. **Vision reliability rules** (geometric-specifics, per-cell for multi-frame, cross-check programmatically where possible — verbatim from daedalus.html learnings)
4. **Nebula CLI cookbook** (trimmed subset of `backend/services/chat_session.py` primer: create/connect/run, `@nX` refs, graph/status commands)
5. **Learnings discipline** (cite-when-applying, save-at-end-of-turn, format)
6. **Autonomy modes** (auto vs step; gating rules for step mode)

### `.hermes/skills/daedalus-learnings/` (writable user-local)

- `LEARNINGS.md` — starts empty (or with a seed entry from daedalus.html's documented lessons)
- `metadata.json` — `{ "name": "daedalus-learnings", "description": "Daedalus's running journal of learnings. Append-only, owned by the agent." }`
- This directory is created on first `hermes chat` invocation if not present (per Hermes convention; agent writes here freely)

---

## 6. Kimi Track Qualification

- `~/.hermes/config.yaml`:
  ```yaml
  model:
    provider: openrouter
    name: moonshotai/kimi-k2.6
    temperature: 0.7
  ```
- Subprocess always passes `--provider openrouter --model moonshotai/kimi-k2.6` explicitly — belt + suspenders, overrides user-local config drift.
- Evidence package for judges (collect during demo recording):
  - Screenshot of `hermes config get model` showing Kimi K2.6
  - Session-DB export showing `provider=openrouter, model=moonshotai/kimi-k2.6` per turn (from `~/.hermes/state.db`)
  - `hermes insights` output: token count on Kimi
  - Code snippet: `backend/services/hermes_session.py` hardcoding the provider/model
  - README on submission repo pointing to this spec

### Vision routed through Kimi, not a separate provider

- Kimi K2.6 is natively multimodal ($0.75/$3.50 per M for both text and vision)
- `vision_analyze` uses session's configured model — so all vision calls go through Kimi too
- This keeps the entire iterative-artist loop in-provider — simpler auth, simpler evidence, cheaper, and visibly Kimi-powered end-to-end

---

## 7. Error Handling

| Failure mode | Detection | Response |
|---|---|---|
| Hermes binary missing | `shutil.which("hermes") is None` at startup | 503 on `/api/chat` with install-prompt detail; frontend shows modal with link to HERMES-SETUP.md |
| Subprocess non-zero exit | return code check | Emit `error` event with stderr tail; chat shows error bubble |
| `--resume <id>` fails (corrupted session) | stderr contains "session not found" | Retry once without `--resume` (fresh session), log the loss, emit warning to chat |
| Kimi API rate limit / outage | Hermes's `fallback_providers` chain | Log which provider actually answered (`hermes insights` post-turn); no user-facing error unless all fallbacks fail |
| Vision call times out | Hermes's own timeout | Daedalus SKILL.md directs: "if vision_analyze fails, state 'I can't verify this stage' and either proceed with caveat or ask for human review — do not loop infinitely" |
| Approval-request timeout (user idle) | 30-min chat-level timeout | Session parked; user can resume by sending new message; state persists in Hermes session |
| Stdout parse error (unknown marker) | Fall-through in parser | Whole line emitted as `text`; does not block turn |

No silent failures. Every error path surfaces in the chat UI with a readable message.

---

## 8. Testing Strategy

### Unit tests (`backend/tests/test_hermes_session.py`)

- `run_hermes` parses `-Q` output on happy path (mocked subprocess, fixture stdout)
- Session-ID threading across turns (mocked subprocess, verify `--resume` flag construction)
- `APPROVAL_REQUIRED` marker parsed into `approval_request` event with correct fields
- `LEARNING_SAVED` marker parsed into `learning_saved` event
- Error surfaced when hermes binary missing (patch `shutil.which`)
- Error surfaced when subprocess exits non-zero
- Event contract parity with `run_claude` — same set of event types for consumers

### Integration smoke test

- One real `hermes chat -q "hi" -Q` invocation to verify binary works in local dev
- Skipped in CI if `hermes` binary not present (environment marker)

### Manual UAT scenarios (run before demo recording)

1. **First turn, no session** — Daedalus creates a session, ID persisted
2. **Second turn with session** — resumes correctly; context preserved
3. **Agent switch mid-chat** — flip Claude ↔ Daedalus; each keeps its own session-id thread
4. **Auto-pilot full demo scenario** — looping forest scene, defect detection, fix at stage 1, clean loop
5. **Step Approval flow** — same scenario, user approves each expensive step; verify cost/time gating prevents trivial-op spam
6. **Learning save + cite** — force a novel insight → verify LEARNINGS.md gets an entry + `learning_saved` event fires in chat. Run a second related prompt → verify Daedalus cites the learning
7. **Hermes binary missing path** — rename binary, verify 503 + friendly modal
8. **Kimi confirmation** — post-turn, run `hermes insights` and confirm all tokens went to Kimi K2.6

### What we explicitly don't test

- The actual creativity of Daedalus's output (judged manually during dogfood)
- Rendering quality of models Daedalus calls (orthogonal)
- Hermes internals (out of scope — we trust the tool)

---

## 9. Timeline to Submission

| Day | Work |
|-----|------|
| 1 (today, 2026-04-23) | This spec + plan. End of day: daedalus-core SKILL.md + daedalus.md personality drafted. |
| 2 | `run_hermes` + happy-path tests. First end-to-end Daedalus turn answering "make an image of X" works. |
| 3 | Chat panel agent selector + Daedalus visual treatment. Autonomy toggle. `approval_request` / `learning_saved` event wiring. |
| 4 | LEARNINGS.md loop (save + cite). Dogfood: run the demo scenario end-to-end. Fix whatever breaks. |
| 5 | HERMES-SETUP.md. README updates. Kimi evidence package captured. |
| 6-7 | Polish. Second demo scenario drafted (audio? 3D? to pad optional Act 3). Edge cases from manual UAT. |
| 8 | Demo video recording — take 1. Review and identify gaps. |
| 9 | Demo video take 2 with fixes. Write the submission post. |
| 10 (2026-05-03) | Submit: tweet demo video tagging @NousResearch, Discord post to `creative-hackathon-submissions`. |

Buffer is modest. If day 4 dogfood reveals fundamental issues with the CLI subprocess approach, fall back to a pure one-shot demo (no session continuity) rather than spend days building gateway adapter.

---

## 10. Open Questions (to verify during implementation)

1. **Exact stdout format of `hermes chat -q -Q`** — is it plain text, JSON, or mixed? Sample once before writing parser. Low-risk: the parser falls back to plain text if markers don't appear.
2. **Does `--skills <name>` accept external_directories skills (read-only)** or only `~/.hermes/skills/`? If latter, setup script creates a symlink.
3. **Kimi K2.6 tool-calling format compliance** — OpenRouter docs don't explicitly confirm OpenAI-style function calling on this model. Verify with a first test turn. Fallback: swap to `moonshotai/kimi-k2` (prior version) if tool calls don't resolve cleanly, log the fallback, still qualifies for Kimi track.
4. **LEARNINGS.md write path** — can `skill_manage` patch inside a skill directory that's user-local (`~/.hermes/skills/daedalus-learnings/`)? Per research: yes, writable skills go to `~/.hermes/skills/`. Confirm during day 2.
5. **Session-ID visibility** — does `-Q` mode print the session ID on stdout? If not, use `--pass-session-id` flag. Verify day 2.

---

## 11. Success Criteria

Ship criteria (hackathon MVP):
- [ ] Chat panel lets user select Daedalus; Daedalus responds via Hermes + Kimi K2.6
- [ ] Daedalus creates nebula nodes via `terminal` tool; canvas updates live
- [ ] `vision_analyze` runs after at least one pipeline stage; result appears in chat
- [ ] LEARNINGS.md gets at least one entry during demo; subsequent turn cites a learning
- [ ] Step Approval toggle works for at least one expensive-op class
- [ ] HERMES-SETUP.md lets a fresh user reach first Daedalus turn
- [ ] Kimi evidence package captured (screenshots + session DB excerpt)
- [ ] Demo video recorded, under 60s, shows all of the above cleanly
- [ ] Submission posted to tweet + Discord by EOD 2026-05-03

Stretch (if time):
- [ ] Act 3 demo showing a second medium (audio or 3D)
- [ ] `delegate_task` visible in demo (parallel sub-agents)
- [ ] Gateway PlatformAdapter prototype for streaming

---

## 12. Post-Hackathon Roadmap

- Gateway PlatformAdapter → streaming chat + cron-scheduled creative tasks + multi-platform Daedalus (Discord, Telegram) — all unlock from same integration
- Typed `nebula_*` tools via `hermes/tools/registry.py` — better visibility than terminal tool, structured event emission
- Voice mode (ElevenLabs TTS) — Daedalus narrates its iterative loops out loud
- LEARNINGS → repo-PR flywheel — UI to promote a local learning into an upstream PR on nebula-nodes, growing `daedalus-core/SKILL.md` over time
- Cross-agent handoff mid-conversation (Claude → Daedalus on a specific subtask)
- Custom gateway platform for "iterative workshops" — async long-running creative projects checked on over hours/days
