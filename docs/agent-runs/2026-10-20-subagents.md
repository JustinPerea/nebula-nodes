# Main agent and subagents, 2026-10-20: what the agents do today

Research for Justin, asked through GM - Design on 2026-10-20 ("a main agent that we do our communication with and it's always available. It spins up sub agents that actually do all the work"). Plan v2.7 (`docs/moodboard-canvas-plan.md` §5.11, questions Q44 to Q47) uses it. This is research and testing only; building is not approved.

This file is a sanitized copy of the session's report: the method, numbers, sources and conclusions. The raw logs (MCP traffic, hook records, stream-json and per-run costs) lived in a session scratchpad and are gone. Token-derived ids are written `app:<id>`. Nothing about any board's content is kept; the live tests ran on a fresh canvas on an isolated backend, holding only the nodes the tests added.

## Method

Four passes, and a fifth that checked them:

- **Docs pass.** Claude Code docs from code.claude.com, fetched 2026-10-20 for CLI 2.1.304, plus the changelog.
- **Source pass.** claude-agent-acp 0.84.0 (the version Nebula pins) and 0.94.0, codex rust-v0.163.0, codex-acp 2.0.0 and 2.2.2, the ACP repo at schema-v1.26.0, Hermes v0.22.2, Gemini CLI v0.64.0 and OpenCode v1.19.3.
- **Code map.** Nebula at `a3694264`, in a read-only worktree (git status stayed clean).
- **Live tests.** Claude Code 2.1.304 ran as `claude -p --model claude-sonnet-5-5` against an isolated Nebula backend on 127.0.0.1:8797. `lsof` showed no connection to 8000-8010 or 5173. Total spend was $1.12 of a $3 cap.
- **Verification.** Every claim was checked against the sources, and the numbers were recomputed from the raw logs. Where the check corrected a claim, this copy uses the corrected version.

Test names (T1 to T5, t2b and so on) are the runs in the raw logs.

## The short version

- The idea is sound. Nebula's MCP server is the problem today, not the agents.
- **Fix first:** 32 of Nebula's 36 MCP tools are sync functions that run on the server's event loop. All subagents share one server process. So one subagent waiting on `wait_for_canvas_change` freezes every other Nebula call, the main agent's included. In T1 this deadlocked a two-node task for about 3 minutes. (This is a bug in today's server and is fixed separately on `fix/mcp-tools-nonblocking`.)
- **Attribution works today.** For Claude Code, a `PreToolUse` hook joined with `_meta["claudecode/toolUseId"]` attributed 84 of 84 calls. Codex already sends a thread id on every MCP call. Nebula reads neither.
- **Splitting costs about 2x** for a small task: 1.94x the cost, 2.21x the tokens and 2.2x the wall time (T4).
- **Edits overwrite each other silently** (T5). The "rejected edit" GM expected never happens on the main canvas.
- **Hosted ACP mode is not ready.** The Claude adapter holds the chat turn open while subagents run, and Nebula refuses a second message during a turn. This was read from code and not run live.

## GM's four questions

### Q1. Does the main agent stay responsive while a subagent waits?

**Turn-wise, yes. Tool-wise, not today.**

- **New turns start right away.** In T2 the main session always took a new chat message, and a new turn started 0.05-0.08 s after the send. Claude Code runs subagents in the background by default and reports back through a completion notification in a later turn ([sub-agents docs](https://code.claude.com/docs/en/sub-agents), "Run subagents in foreground or background"; changelog 2.1.198, 2026-07-01). Desktop and VS Code have always backgrounded them only since 2.1.302 (changelog, 2026-10-16).
- **The Nebula calls block.** The delay came from the main agent's Nebula calls, which wait behind the subagent's `wait_for_canvas_change`:

| Run | Main agent's `look_at_canvas` | Chat message to first reply text | Cost |
|---|---|---|---|
| t2: shared server, watcher waits 90 s | blocked 82.6 s | 85.0 s | $0.051 |
| t2b: shared server, pin 10 s after chat | blocked 8.3 s (the pin released it) | 11.9 s | $0.049 |
| t2c: watcher has its own inline MCP server | about 19 ms | 5.8 s | $0.132 |

- **Why it blocks:**
  - Subagents share the parent's MCP connection (docs, "Scope MCP servers to a subagent"; T1 saw one server process and one `initialize`).
  - mcp 1.27.0 FastMCP calls sync tools inline on the event loop (`mcp/server/fastmcp/utilities/func_metadata.py` lines 92-95).
  - In Nebula only `run_nodes`, `get_run`, `moodboard_create` and `moodboard_add` are async (`backend/mcp_server.py` lines 570, 593, 877, 903).
  - A fake-backend test reproduced it: a `look_at_canvas` sent 0.5 s after a 6 s wait finished at 6.03 s, the same instant as the wait.
- **The docs line that suggests otherwise.** The docs say subagent MCP calls never auto-background ([mcp docs](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls)). That is true, but on Nebula's server a subagent's wait still blocks the parent. The early reading "it blocks only that subagent" was wrong.
- **It can deadlock (T1).**
  - The main agent waited for a subagent's edit. That wait blocked the subagent's `find_nodes` for 58.77 s.
  - The edit landed about 60 ms before the main agent's second wait (120 s) began, so the wait saw nothing. Self-exclusion would have hidden the edit anyway (see Q2).
  - Wall time was 197.5 s, about 180 s of it waiting. Cost $0.178.
- **Pin timing (t2b).**
  - Pin to the watcher's wait returning: under 50 ms.
  - Pin to the watcher's one-line report: 1.9 s.
  - The pin also freed the main agent's blocked `look_at_canvas`, so the main agent saw the pin itself 1.87 s after it was added, before the completion notification.
  - Pin to the main agent's reply: 5.3 s.
  - With the watcher on its own server (t2c): 20 ms, 6.9 s and 9.3 s.
- **Hosted ACP mode (read from code, not run):**
  - The Claude adapter keeps `session/prompt` open while that turn's background subagents run (claude-agent-acp 0.84.0 `src/acp-agent.ts` lines 666-705, "deferredSettle"; CHANGELOG #870).
  - Nebula's `acp_session.prompt()` refuses a send unless the state is `ready` (`backend/services/acp_session.py` lines 497-499). The chat socket answers a second send with "Another response is active" (`backend/main.py` lines 3133-3149).
  - So a hosted Claude main agent could not take a new chat message until its subagents finish, unless the person cancels.
  - The adapter does end a held turn when the next prompt arrives ("the user moving on outranks the hold"), and it advertises `promptQueueing` and a `_session/steering` extension (`acp-agent.ts` lines 483, 2479, 3890-3895). Nebula uses neither.

### Q2. Do subagents get their own MCP connection, token and identity?

**Claude Code: no. One connection, one token, one cursor, and no agent id on the wire.**

- **One connection.** Subagents share the parent's connection for servers referenced by name. Only servers defined inline in a subagent's `mcpServers` frontmatter connect separately ([sub-agents docs](https://code.claude.com/docs/en/sub-agents#scope-mcp-servers-to-a-subagent)). T1 confirmed it live.
- **No agent id.** Across 84 `tools/call` requests, the only `_meta` keys were `claudecode/toolUseId` and `progressToken` (T1 to T5 MCP logs). clientInfo was `claude-code 2.1.304` for everyone.
- **One identity.**
  - A valid app token always resolves to `app:<id>`, and the `X-Nebula-Agent` name is ignored in that case (`backend/services/agent_presence.py` lines 133-173).
  - The cursor map is keyed by that id (line 248), so every worker on the token moves the same cursor. T1 journaled both nodes under one `app:<id>`, "Claude Code".
  - A hosted agent gets `personal:<agentId>` in the same way (`acp_session.py` lines 245-254).
- **Attribution that works today, with no change to Claude Code:**
  - A `PreToolUse` hook gets `tool_use_id`, `agent_id` and `agent_type`, and it fires inside subagents too ([hooks docs](https://code.claude.com/docs/en/hooks#common-input-fields)).
  - Live, 84 of 84 call toolUseIds matched a hook record. 50 of them carried a subagent `agent_id`; the main agent's calls had null.
- **Self-exclusion hides subagents.**
  - `/api/canvas/events` drops events whose actor id equals the caller's (`backend/main.py` lines 4086-4123; `backend/services/canvas_events.py` lines 222-229).
  - Two MCP sessions on one token: session A's default wait timed out after 8.0 s while session B's edit applied.
  - With `include_self=true`, A saw B's `node.params` 3.7 s into the wait, under A's own actor id. So a main agent can see its workers' edits, but it can't tell them apart from its own.

### Q3. How much does a subagent spend getting its bearings?

**About 17k tokens of starting context, and a few calls when it has to look things up.**

- **Starting context.** All 14 subagents across 9 runs were fresh agents: 13 general-purpose and 1 custom watcher (t2c). None was a fork. A subagent's first request carried about 16.8k tokens, against the main agent's 20.4k. On the first run 0 of those were cached; on later runs about 16.1k were, because the cache carried over between sessions.
- **What loads.** The docs list its own system prompt, the task message, every CLAUDE.md level, a git status snapshot and preloaded skills ([sub-agents docs](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)). It also inherits every MCP tool definition ([prompt-caching docs](https://code.claude.com/docs/en/prompt-caching#subagents-and-the-cache), "its own system prompt and tool set"). It starts its own cache with a 5-minute TTL. A fork reuses the parent's cache, but none was produced, so fork cost is unmeasured.
- **Calls before the real work:**
  - T1 (vague task): 4 calls before `edit_canvas`: 3 `find_nodes` (one under a tool name that doesn't exist) plus `describe_node`. Context grew from 16.7k to 19.7k tokens.
  - T5 (node id given, param name not): both subagents guessed `text` and got an error. One retried with `value`; the other gave up.
  - T5b (param name given) and the T2 watchers: 0 calls.
- **Each lookup subagent processed 56k-100k tokens in all**, mostly cache reads (T4).

### Q4. What does it cost against a single agent?

**About double for a small task (T4, two runs each):**

| | Single agent | Main + 2 lookup subagents |
|---|---|---|
| Cost | $0.056 / $0.061 | $0.104 / $0.123 |
| Tokens | 115k / 140k | 249k / 316k |
| Wall time | 10.9 / 17.5 s (mean 14.2) | 35.8 / 26.2 s (mean 31.0) |
| MCP calls | 9 / 11 | 12 / 12 |

- **Ratios:** 1.94x the cost, 2.21x the tokens, 2.2x the wall time. Every run produced a valid proposal with 3 nodes and 2 wires.
- **Wall time:** splitting added 8.7-24.9 s per run.
- **What the vendors say:** the docs give no ratio. Each subagent "sends its own requests on top of the main conversation's" ([costs docs](https://code.claude.com/docs/en/costs)). Agent teams use about 7x the tokens with teammates in plan mode (same page). OpenAI says Codex subagent workflows "consume more tokens than comparable single-agent runs" ([Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)). Hermes says a parallel batch "typically burns the large majority of a run's total tokens" (Hermes `delegation.md` line 279).
- **Fork test:** setting `CLAUDE_CODE_FORK_SUBAGENT=1` (t4bf1) was a no-op, because fork mode is already on in `-p` since 2.1.302. Fork mode only lets Claude choose a fork, and this prompt asked for two subagents, so all 41 Agent calls used general-purpose. That run cost $0.219, from cache misses.
- **Spend limits hold for every agent checked.** Every subagent counts against the parent's one token (`backend/main.py` lines 1822-1860, `backend/services/agent_spend.py` line 150).

## What each agent supports today

| Agent | Subagents | MCP connection for subagents | Who-made-this-call signal | Over ACP in Nebula |
|---|---|---|---|---|
| **Claude Code 2.1.304** | On, background by default; up to 20 at once | Shared with the parent (confirmed live) | None on the wire. A `PreToolUse` hook gives `agent_id` per `tool_use_id` (confirmed live) | Adapter holds the turn; native child sessions only if the client asks |
| **Codex CLI 0.163.0** | On by default; 6 threads, depth 1 | Each thread starts its own `nebula` process, with the same env and token (likely) | `_meta["x-codex-turn-metadata"]` with `thread_id`, `parent_thread_id`, `subagent_kind` (read in source) | codex-acp shows native child sessions if the client asks |
| **Hermes v0.22.2** | `delegate_task`; 10 parallel, background, depth 1 | Shared, in-process (likely) | None on MCP. The runs API has `subagent.start` / `subagent.complete` with per-child tokens and `cost_usd` | `hermes acp` shows delegation as one tool call |
| **Gemini CLI 0.64.0** | On by default; can't nest | Shared (tools are shallow-cloned) | None | One tool call of kind `think` |
| **OpenCode 1.19.3** | `task` tool; background is experimental | Shared at project scope | None | Only the parent's `task` call. Not a Nebula preset |

### Claude Code: details and sources

- **Fork mode.** On in the terminal since 2.1.232, and in `-p`, the SDK, desktop and VS Code since 2.1.302 (changelog). `CLAUDE_CODE_FORK_SUBAGENT=0` turns it off, and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` makes Claude wait for every subagent (sub-agents docs).
- **`claude -p` waits for background subagents before it exits.** Other background work stops after 10 minutes idle, and `--max-budget-usd` stops background work at the cap ([headless docs](https://code.claude.com/docs/en/headless)).
- **Concurrency.** Up to 20 subagents run at once by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, sub-agents docs).
- **Agent teams.** They exist but are experimental and off by default (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), and they cost much more ([agent-teams docs](https://code.claude.com/docs/en/agent-teams)).
- **Adapter version and CLI.**
  - Nebula pins `@agentclientprotocol/claude-agent-acp@0.84.0` (`backend/services/personal_agents.py` line 77).
  - The adapter runs the Agent SDK's bundled CLI, not the person's `claude`, unless `CLAUDE_CODE_EXECUTABLE` is set (0.84.0 `src/acp-agent.ts` lines 1719-1757, `claudeCliPath()`, which resolves `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`). 0.84.0 depends on `@anthropic-ai/claude-agent-sdk` 0.3.284, whose `claudeCodeVersion` is 2.1.284 (`npm view @anthropic-ai/claude-agent-sdk@0.3.284 claudeCodeVersion`). Nebula doesn't set `CLAUDE_CODE_EXECUTABLE` (no reference in `backend/`); it passes through only if it was set in the environment Nebula was started from (`services/child_env.py` doesn't strip it). `docs/PERSONAL-AGENTS.md` said it "starts `claude`"; that is fixed alongside this record.
  - npm latest is 0.94.0, published 2026-10-19. Under the 14-day package rule it can't be installed before 2026-11-02.
- **Native subagent events.**
  - 0.84.0 sends `subagent_spawned` / `subagent_state_update` only to clients that advertise `clientCapabilities.subagents` or JetBrains AIR's capability (`src/acp-subagents.ts`, `src/native-subagents.ts`).
  - 0.94.0 sends the merged RFD form (`subagent_update` / `session_message`) to a plain `subagents:{}` client like Nebula ([acp-subagents.ts lines 14-30](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.94.0/src/acp-subagents.ts)).
  - Async-task progress, with per-task tokens, goes to AIR clients only.
- **Fallback.** Without the capability, subagent tool calls arrive in the root session tagged `_meta.claudeCode.parentToolUseId` (`acp-agent.ts` line 1546, CHANGELOG #859). Not tested live.

### Codex: details and sources

- **Which Codex runs.** The Nebula codex preset sets `CODEX_PATH` to the person's `codex` (`personal_agents.py` line 384). On the test Mac that was codex-cli 0.163.0.
- **Defaults.** Max threads 6 and depth 1 (`codex-rs/core/src/config/mod.rs` lines 255, 265).
- **MCP per thread.** Each thread owns its MCP runtime, and a subagent starts its servers lazily (`core/src/session/mcp_runtime.rs` lines 379-383; `session.rs` line 1614). So a subagent gets a second `nebula` process with the same token. Read from source, not checked with `ps`.
- **Attribution metadata.** Every MCP call carries `x-codex-turn-metadata` (`core/src/mcp_tool_call.rs` lines 1294-1318; `turn_metadata.rs` lines 275-312). mcp 1.27.0 keeps extra `_meta` keys (`mcp/types.py` lines 62-71, `extra="allow"`), so Nebula should be able to read it. Not tested live.
- **codex-acp.** Native child sessions since 1.7.0 (#419). 2.0.0 and 2.2.2 still use the old event names. In native mode, child permissions carry the child's sessionId ([subagent-sessions.md](https://github.com/agentclientprotocol/codex-acp/blob/v2.0.0/docs/subagent-sessions.md)). Without the capability, the children's work is hidden. codex-acp rejects MCP-over-ACP (`CodexAcpClient.ts` line 936).

### ACP itself

- **The RFD.** "Subagent Sessions" (PR #1992) merged as unstable on 2026-09-30.
  - The client sends `clientCapabilities.subagents: {}`.
  - The agent announces each child with one `subagent_update`: child sessionId, title, state and a cancel capability.
  - The `title` is the "Claude · hero takes" label GM wants.
- **Two caveats in the RFD.** A child's MCP servers and cwd are "not guaranteed to match the parent's". Clients must not add parent and child costs together ([subagents.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/subagents.mdx)).
- **Event names.** Schema v1.26.0 has only `subagent_update`, so Nebula must accept the old names too.

### Hermes, Gemini, OpenCode: details and sources

- **Hermes** (`website/docs/user-guide/features/delegation.md`; `tools/mcp_tool.py` line 460; `gateway/platforms/api_server_runs.py` lines 79-84 and 327-348):
  - Children share the process-global MCP connection and send no identity.
  - The runs stream drops `subagent.tool`, so a child's own tool calls never reach Nebula.
  - The gateway plan maps the two subagent events to one `system` line each (`docs/HERMES-GATEWAY-PLAN.md` line 152). The events carry far more than the plan uses: per-child input, output and reasoning tokens, `cost_usd`, duration, and files read and written.
- **Gemini 0.64.0** (`packages/core/src/agents/local-executor.ts` lines 178-220; `packages/cli/src/acp/acpUtils.ts` lines 202-222). The test Mac ran Gemini 0.25.2, so what Nebula actually gets may differ.
- **OpenCode 1.19.3** (`packages/opencode/src/acp/service.ts` lines 1010-1040). Background subagents also turn on through the general experimental flag (`src/effect/runtime-flags.ts` lines 11-13, 43).

### Nebula's ACP client today

`backend/services/acp_session.py` and `acp_events.py` at `a3694264` drop or refuse subagent traffic in five places:

- It advertises only `fs:false` and `terminal:false` (line 62).
- It drops any `session/update` whose sessionId isn't the root's, and drops all updates while no turn is running (lines 402-404).
- It refuses any permission request outside a turn or with a non-root sessionId (lines 433-435). Native child permissions would be auto-rejected.
- It ignores `_meta` and unknown update kinds (`acp_events.py` lines 225-266).
- With the Claude adapter's held turn, a subagent's completion normally lands inside the turn. The between-turns loss mainly hits Codex and other adapters, or happens after a cancel.

## What this means for "one voice, many hands"

**What holds:**

- **One voice.** A main agent can keep talking while subagents work (T2 turns started in about 50 ms).
- **One spend line.** Every subagent spends under the one app token's limit, for every agent checked.
- **Pins reach whoever waits.** A waiting subagent gets a pin in under 50 ms.
- **Labels are possible.** Each worker can get a "Claude · hero takes" label, from data Claude Code (hook) and Codex (`_meta`) already provide, or from ACP's `subagent_update` title in hosted mode.

**What changes:**

1. **The server must go async before anything else.** A shared server process plus sync tools means one worker's wait stalls everyone, and it can deadlock (T1). Giving the watcher its own inline MCP server works today (t2c), but it is a workaround.
2. **Identity needs a second level.** The token gives the root (`app:<id>`). Each call also needs a task or worker label. Cursors, the journal's actors and self-exclusion must use root plus label. Otherwise the main agent can't wait for its workers, or sees their edits as its own.
3. **Main-canvas edits need conflict checks.** In T5 both edits returned "applied" about 0.29 s apart. A read the node before B wrote, so A reported a stale value, and B won. The journal showed two `node.params` events with the same actor. The main agent found the overwrite only because its prompt told it to check. `/api/graph/apply` takes no base revision (`main.py` lines 8029-8227). Moodboard `/edits` already returns a 409 on a stale `baseVersion` (`main.py` lines 11045-11154). The canvas should match.
4. **The main agent should keep the one pin wait.** If a watcher subagent holds it, the main agent hears about pins late and at the cost of a whole subagent.
5. **Split only big tasks.** For a 3-node task, splitting doubles cost and time. Passing workers exact node ids and param names removes the warm-up calls (T5b: 0 calls).
6. **Shared caps.** All workers on one token share 3 open proposals, and any of them can withdraw another's (`backend/services/canvas_proposals.py` lines 45-47, 561-570). Any worker can resolve any pin (`main.py` lines 4220-4244).
7. **Hosted mode needs its own work.** Nebula has to advertise subagents, keep a child-session roster, accept updates outside a turn, accept child-session permissions, and queue or steer a message sent during a held turn.
8. **AgentLog and the Updates corner don't exist for outside apps yet.** AgentLog is fed only by in-app chat turns (`backend/services/chat_actions.py` lines 19-48). The Updates corner is planned as PR9a (`agent_notes.py`, `note.posted`) and is not on main (`docs/moodboard-canvas-plan.md` §5.9).

## Smallest first step, and what it costs

All estimates are rough. They come from the touch points in the code map, not from a prototype.

| Step | What | Rough size | Why that size |
|---|---|---|---|
| 0 | **Make the 32 sync MCP tools non-blocking** (wrap each body in `anyio.to_thread.run_sync`, the pattern `run_nodes` already uses), plus a test that a wait doesn't block a second call | ~80-150 lines changed, ~0.5-1 day | Mechanical and in one file (`backend/mcp_server.py`). The fake-backend test makes a regression test. Being fixed separately as a bug fix on `fix/mcp-tools-nonblocking` |
| 1 | **Worker label end to end:** an optional `task` param (≤32 characters) on the mutating tools and the wait, sent as `X-Nebula-Agent-Task`. `identify()` adds `task`. Journal actors carry `{id, task}`. Self-exclusion matches root plus task, so a main agent with no task sees its workers. The cursor key becomes `id#task`. The frontend draws "Claude · hero takes" | ~250-400 lines with tests, ~2 days | Touches `mcp_server.py` (lines 96-110, 798-799), `agent_presence.py` (lines 60-68, 133-173, 248), `canvas_events.py` (lines 105-120, 222-229), `main.py` (lines 4114-4115), `agentPresenceStore.ts`, `AgentCursorLayer.tsx` |
| 1b | **Fill the label without the model's help:** read Codex's `thread_id` from `_meta`. For Claude Code, ship an optional `PreToolUse` hook that writes `tool_use_id → agent_id` to a file the MCP server reads | ~100-150 lines, ~1 day | The hook join is proven live (84/84). The Codex `_meta` read still needs a one-call test |
| 2 | **Base revision on `/api/graph/apply`:** an optional `baseRevision` (or per-node revisions), returning a 409 with the current state, like moodboard `/edits` | ~150-250 lines, ~1-2 days | The staging code is already all-or-nothing. The work is a node revision counter and the conflict response |
| 3 | **Hosted ACP subagents:** advertise `subagents:{}`, keep a child roster (both event shapes), accept updates outside a turn and child permissions, queue or steer a send during a held turn. Bump the adapter to 0.94.0 (not before 2026-11-02, the 14-day rule) | ~400-700 lines, ~3-5 days | It touches `acp_session.py`, `acp_events.py`, the chat socket and the chat UI, and it needs live tests per adapter |

**Recommended first step: Step 0, then Step 1.** About 3 days. That fixes the freeze and the deadlock, makes subagent work visible on the canvas and in the journal, and doesn't depend on any agent's unstable features.

## Risks

- **Model-filled labels are unreliable.** In T5 the models guessed param names. A `task` param the model must fill will sometimes be missing or wrong. Step 1b reduces that.
- **Agent-specific hooks drift.** The Claude hook join depends on `_meta["claudecode/toolUseId"]`. That key is undocumented, seen live on 2.1.304 only. The adapter's bundled 2.1.284 may differ.
- **Unstable protocol.** ACP's subagent RFD is unstable, the event names already changed once, and the two adapters disagree today.
- **Cost surprises.** Every split roughly doubles cost on small tasks, and all of it lands on one token's daily limit.
- **Async can expose new races.** Today the sync tools serialize calls by accident. Once they run in parallel, two calls from one process can interleave. The backend's lifecycle lock keeps edits atomic (`main.py` lines 320-345), but any client-side state in `mcp_server.py` (cursor names, URL caches) needs a look.
- **Self-exclusion change.** Changing what counts as "own events" could make an agent see its own edits and loop on them. It needs a test.
- **A wrong doc.** `docs/PERSONAL-AGENTS.md` said the adapter starts the person's `claude`. It starts the bundled CLI, so a fix to the person's install won't reach hosted mode.

## Still unknown, and how to find out

| Unknown | How to find out |
|---|---|
| Hosted ACP: how long the chat stays "prompting" while a subagent runs, and what the frontend shows on a second send | Live run of the Claude preset against an isolated backend and Vite (879x/579x), with a background watcher subagent |
| Interactive-mode behaviour (the main agent's MCP calls auto-background after 2 minutes) | Run an interactive `claude` session against the isolated backend |
| Fork subagent cost | A prompt that asks Claude to fork rather than spawn, then compare first-request cache reads |
| The real cost of an inline-only watcher | Repeat t2c with `disallowedTools: mcp__nebula` on the watcher. The 32.2k vs 16.8k first request in t2c came from 36 duplicate tools, a setup artifact |
| Whether Nebula's FastMCP keeps Codex's `x-codex-turn-metadata` | One Codex call against an MCP server that logs `ctx.request_context.meta` |
| Whether a Codex subagent starts a second `nebula` process | `ps` during a live Codex subagent run |
| Per-child token counts over ACP (`usage_update` per child session) | Advertise `subagents:{}` in a test client and log the updates |
| `resolve_pin` by the main agent, and the frontend chip | Not exercised. Add to the next live run, with Vite and a browser |
| Codex, Hermes, agent teams and adapter 0.94.0 under load | Same harness, one run each. Hermes `subagent.complete` gives per-child tokens and `cost_usd` directly |
| Whether in-process agent-team teammates share the lead's MCP connection | The docs don't say. Check with the logging shim |
