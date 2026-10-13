# Personal agents

A personal agent is **your own** coding agent (your Claude Code, Codex or Gemini, or any agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview)), running with your login, settings,
memory and MCP servers, and shown in Nebula's chat panel. Nebula starts it, gives it Nebula's canvas tools for the
session, and shows its replies, tool calls, plan and approval requests.

They differ from Nebula's built-in **Claude Code** and **Codex** chats ([CHAT-SETUP.md](CHAT-SETUP.md)). Nebula runs
those with a private profile: no hooks, no user MCP servers, and for Codex no network in its shell. A personal agent
keeps everything it normally has.

```mermaid
sequenceDiagram
  participant You as Chat panel (you)
  participant N as Nebula backend
  participant A as Your agent (ACP over stdio)
  participant M as nebula MCP server (started by your agent)
  You->>N: send (person token)
  N->>A: spawn, initialize (fs and terminal declined)
  N->>A: session/new with the nebula MCP server + the path of a session token file
  A->>M: starts it; it reads the token file, and canvas tools count against the outside budget
  N->>A: session/prompt
  A-->>You: text, thoughts, tool calls, plan
  A->>You: permission request: Allow once / Deny card
  Note over N,A: /clear, switching agent, closing the tab, switching it off in Settings, 30 min idle, a crash or backend shutdown: the process tree is killed and the token revoked
```

## The options

| Agent | What it brings | How Nebula starts it | Needs |
|---|---|---|---|
| Claude (your setup) | Your Claude Code login and plan, `~/.claude` settings, **hooks**, **MCP servers**, memory and skills | `npx -y @agentclientprotocol/claude-agent-acp@0.84.0` | Node.js 22+ next to `npx`; signed in to Claude Code in a terminal |
| Codex (your setup) | Your Codex login and `~/.codex` config, its own sandbox settings | `npx -y @agentclientprotocol/codex-acp@2.0.0` (with `CODEX_PATH` set to your `codex` when found) | Node.js; signed in to Codex in a terminal |
| Gemini (your setup) | Your Gemini CLI login and settings | your installed `gemini --acp` (Nebula doesn't install it) | the `gemini` CLI |
| Hermes | Your Hermes agent | `hermes acp` | **Not startable yet**: it needs a Nebula profile first |
| Custom | Any ACP agent | the absolute path or command name and arguments you enter | the binary |

The adapter versions are pinned exactly and were at least 14 days old when pinned (checked on registry.npmjs.org on
2026-10-13). npx runs with `npm_config_before` set to 14 days ago, so what the adapter pulls in (for example
`@openai/codex`) is held to the same age. Bumping a pin is a code change in `backend/services/personal_agents.py`.

Agents are **off** until you switch them on in **Settings > Preferences > Personal agents**. Only agents whose status
is *Ready* show in the chat picker. Statuses: Ready, Off, Not installed, Needs a newer Node.js, Not set up yet.

Nebula finds binaries without a shell. It checks your `PATH`, then `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.bun/bin`, `~/.cargo/bin`, `~/.asdf/shims`, the newest
`~/.nvm` node and fnm's default. Only if those all miss does it ask your login shell for its `PATH` (once, no `-i`, 3
second timeout).

## Safety notice (shown once before the first start)

Nebula won't start a personal agent until you accept this:

- **It isn't sandboxed.** The agent keeps its own shell, network and file access, its memory, and its own model keys and
  billing. Nebula declines the ACP `fs` and `terminal` capabilities, but that only means the agent can't use
  *Nebula* for those. It still has its own.
- **Nebula only limits its Nebula calls.** Runs it starts through Nebula's tools count against the shared budget for
  agents outside Nebula's chats (Settings > Preferences > Agent spending), with a line for each agent that spent in the
  last 24 hours. Per-run limits and
  proposals apply as for any outside agent. What the agent spends on its own model is between you and its provider.
- **Approval cards appear only when the agent asks.** Nebula shows *Allow once* and *Deny*. It never picks "always
  allow" or "always reject", since either would write a rule into the agent's own config. A card with no answer
  in 120 seconds is denied. If the agent offers only "always allow", the card can only deny.
- **Canvas content can travel.** Anything on your canvas that the agent reads (prompts, selections, outputs) can be
  remembered by it and reused in its other conversations and channels. Prompt injection in canvas content reaches an
  agent that has a shell.
- **The Claude adapter loads your hooks and MCP servers.** They run as they would in your terminal.

## What Nebula does guarantee

- **Only you start and control it.** Every send needs this launch's person token. The registry routes
  (`/api/personal-agents*`) are person-only. Permission answers and `close_session` need the person token and must come
  from the chat socket that started the session.
- **One session token per chat.** It allows Nebula's output folder plus a private workspace (the agent's working
  directory, not your project) and spends as `outside:personal:<agentId>`. It is revoked when the session ends for any
  reason: `/clear`, switching agent, closing the chat panel or tab, 30 minutes idle, a crash (including one while
  you stop a turn), a cancel the agent ignores for 10 seconds, or the backend stopping.
- **Settings take effect at once.** Switching an agent off, removing it, or changing a custom agent's command or
  arguments stops every running session of it on the spot: process tree killed, token revoked. That holds for a
  session that is still starting too: it gives up at its next step, never mints a token after the stop and never
  reports itself ready. The next send in that chat says so and starts nothing. Renaming or recoloring leaves it
  running. Each send re-checks Settings before prompting, whether the agent was running already or just started.
- **Where the token lives.** In Nebula's memory, and in one file per session:
  `<state dir>/agent-tokens/<backend pid>/<session id>.token`, mode 0600 in 0700 folders, outside the agent's
  workspace. `session/new` carries only that file's path (`NEBULA_AGENT_TOKEN_FILE` in the `nebula` MCP server's
  environment), never the token. That matters because adapters may put the MCP server's environment on a command
  line: the pinned Claude adapter starts `claude` with `--mcp-config <json>`, which any local account can read with
  `ps`. The `nebula` MCP server reads the file when it starts and keeps the token in its own environment; if the file
  is missing, unreadable, open to other users or malformed, it exits instead of running without a token. The agent's
  own environment doesn't get the token. The file is deleted when the session ends, and a backend start deletes any
  that a crashed backend left (their tokens died with it). Any program running as your macOS user can still read the
  file, or the MCP server's environment (`ps eww`).
- **Cleanup.** The agent runs in its own process group with a scrubbed environment: no Nebula secrets or spending
  tokens, and none of the provider keys Nebula knows by name (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `FAL_KEY` and the
  rest of `backend/services/credential_catalog.py`) even if the shell that started Nebula exported them. So Claude Code
  and Codex use your own login, not a terminal's API key. On close Nebula kills the whole process tree, including
  grandchildren, and finishes the kill even if whatever asked for the close is itself interrupted.
- **Output caps.** The session token is replaced with `***` anywhere the agent echoes it, and then output is capped:
  each reply or thinking chunk at 20,000 characters, a turn's reply and thinking text together at 200,000, each tool
  input at 4,000, each tool result at 20,000, and a plan at 50 entries of 500 characters. A chunk over 20,000
  characters is trimmed and later chunks still show; once a turn's text reaches 200,000 characters, the rest of that
  turn's text is dropped. Either way the chat shows one line saying so, once per turn. Tool results have
  no per-turn total yet.

## Using it

1. Switch an agent on in Settings > Preferences > Personal agents (or add a custom ACP agent there).
2. In Chat, open the model picker and choose the agent. Model and effort are hidden: the agent uses its own.
3. Send. The first time, read and accept the notice. The first Claude or Codex start can take a while as npx downloads
   the adapter (Nebula waits up to 3 minutes).
4. If it says it needs you to sign in, sign in to that CLI in a terminal and send again. Nebula never runs an agent's
   login flow.

Commons (`NEBULA_COMMONS_ENABLED=1`) keeps chat to the built-in Claude and Codex, so personal agents are refused there.

## Not done yet

Reattaching after a reconnect (`session/load`), Hermes profile setup, OpenClaw (it rejects client MCP servers), remote
agents and an HTTP MCP transport, image and file prompts, session modes and model choice, slash commands, environment
variables for custom agents, and more than one personal session per chat panel.

If the backend is killed outright (no cleanup runs), the agent guardian (`services/agent_guardian.py`) kills the
agent's whole process group, as it does for in-app chats, and the token dies with the backend.

Code: `backend/services/acp_client.py` (JSON-RPC over stdio), `acp_events.py` (update mapping), `acp_session.py`
(sessions), `personal_agents.py` (registry and presets), `agent_binaries.py` (binary lookup). Tests drive a stdlib fake
agent, `backend/tests/fixtures/fake_acp_agent.py`.
