# Personal agents

A personal agent is **your own** coding agent (your Claude Code, Codex, Gemini CLI or Antigravity, or any agent that speaks the
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
| Gemini (your setup) | Your Gemini CLI login and settings | your installed `gemini`, with the ACP flag its `--help` lists: `--acp`, or `--experimental-acp` on older releases (Nebula doesn't install it) | the `gemini` CLI, and a login Google still serves: a paid Gemini API key or a Gemini Code Assist Standard or Enterprise license. See [Gemini](#gemini-your-setup) |
| Antigravity (your setup) | Your Google AI plan, through Google's own Antigravity ACP server | `agy_acp_server.par` 1.4.1, which Nebula downloads from dl.google.com when you press Download, checks by SHA-256 and never updates | macOS (Apple silicon or Intel); Sign in with Google in Settings. See [Antigravity](#antigravity-your-setup) |
| Hermes | Your Hermes agent | `hermes acp` | **Not startable yet**: it needs a Nebula profile first |
| Custom | Any ACP agent | the absolute path or command name and arguments you enter | the binary |

The adapter versions are pinned exactly and were at least 14 days old when pinned (checked on registry.npmjs.org on
2026-10-13). npx runs with `npm_config_before` set to 14 days ago, so what the adapter pulls in (for example
`@openai/codex`) is held to the same age. Bumping a pin is a code change in `backend/services/personal_agents.py`.

Agents are **off** until you switch them on in **Settings > Preferences > Personal agents**. Only agents whose status
is *Ready* show in the chat picker. Statuses: Ready, Off, Not installed, Needs a newer Node.js, Not set up yet. A row
that isn't ready says what's missing.

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
  rest of `backend/services/credential_catalog.py`, plus `GEMINI_API_KEY`) even if the shell that started Nebula
  exported them. So Claude Code, Codex and Gemini CLI use your own login, not a terminal's API key. The one exception
  is a key you hand over on purpose: "Use my Gemini API key from Nebula" (below). On close Nebula kills the whole process tree, including
  grandchildren, and finishes the kill even if whatever asked for the close is itself interrupted.
- **Output caps.** The session token is replaced with `***` anywhere the agent echoes it, and then output is capped:
  each reply or thinking chunk at 20,000 characters, a turn's reply and thinking text together at 200,000, each tool
  input at 4,000, each tool result at 20,000, and a plan at 50 entries of 500 characters. A chunk over 20,000
  characters is trimmed and later chunks still show; once a turn's text reaches 200,000 characters, the rest of that
  turn's text is dropped. Either way the chat shows one line saying so, once per turn. Tool results have
  no per-turn total yet.

## Using it

1. Switch an agent on in Settings > Preferences > Personal agents (or add a custom ACP agent there).
2. In Chat, open the model picker and choose the agent. Nebula's model and effort lists are hidden: the agent uses
   its own.
3. Send. The first time, read and accept the notice. The first Claude or Codex start can take a while as npx downloads
   the adapter (Nebula waits up to 3 minutes).
4. If it says it needs you to sign in, sign in to that CLI in a terminal and send again. Nebula never runs an agent's
   login flow, with one exception: Antigravity's server keeps its own Google login, so Settings has a Sign in with
   Google button for it (below).

**Model choice.** If the agent offers models or thinking levels for the session (ACP `configOptions` with category
`model` or `thought_level`, or the older `models` list), they show as small menus on their own row under the agent's
name in the chat header once the session starts: "Model for this conversation", "Thinking for this conversation". Picking one calls
`session/set_config_option` (or `session/set_model`) and applies from the next message. Only the person can change it:
the socket message needs the person token. Nebula shows at most four menus of 64 choices each, and only the values the
agent offered are accepted. Session modes are left alone.

## Gemini (your setup)

Before it starts the CLI, Nebula runs `gemini --version` and `gemini --help` side by side (30 seconds at most,
once per installed binary, off the backend's event loop, and never twice at once: a look while one runs reads "still
checking") and uses the ACP flag `--help` lists: `--acp` (v0.64.0 and later; it still lists the old
flag as deprecated) or `--experimental-acp` (older releases such as 0.25.2). A CLI with neither says "Update it".

Then it reads which login the CLI uses, from `~/.gemini/settings.json` and the system settings file that overrides it
(`/Library/Application Support/GeminiCli/settings.json`, or `GEMINI_CLI_SYSTEM_SETTINGS_PATH`). It never changes them,
and from `.env` files it reads only the variable names, never the values. Since 2026-06-18 Google serves Gemini CLI only
with a paid Gemini API key (or a Gemini Enterprise Agent Platform key) or a Gemini Code Assist Standard or Enterprise
license; a free Google account login and Google AI Pro or Ultra no longer work (Google Developers Blog, 2026-05-19). So:

- **Google account login without a Cloud project** (`oauth-personal`, no `GOOGLE_CLOUD_PROJECT`): *Not set up yet*, and
  the row says why and what to do.
- **Google account login with a Cloud project**: *Ready*, with a note that Google serves it only with a Code Assist
  Standard or Enterprise license.
- **API key login** (`gemini-api-key`): *Ready* when `GEMINI_API_KEY` is in the `.env` file the CLI loads
  (`~/.gemini/.env`, say). A key your shell exported doesn't count: Nebula drops it from the agent's environment.
- **Vertex AI, Cloud credentials, a gateway**: *Ready*, billed where that login bills.
- **Not signed in**: *Not set up yet*.

**Use my Gemini API key from Nebula** (off by default, per agent). Turn it on and Nebula starts the CLI with
`GEMINI_API_KEY` set to the key saved in Settings > API keys (Google), and points `GEMINI_CLI_SYSTEM_SETTINGS_PATH`
at a file of Nebula's (`<state dir>/personal-agents/gemini-cli-system-settings.json`, mode 600, no secret in it):
your real system settings plus "API key login". System settings outrank user settings, so your own
`~/.gemini/settings.json` and cached Google login stay as they are. It also sets `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` to
the real `system-defaults.json` (the CLI otherwise looks for it next to the overlay), so an admin's defaults still apply. Google bills that key for every turn the agent
runs, at Gemini API prices; the switch says so. The key is masked like the session token if the agent echoes it.
If your settings enforce another login (`enforcedType`), the switch can't help and says so. Nebula doesn't ask the
CLI to switch logins over ACP: its `authenticate` deletes the cached Google login and rewrites your settings file.

## Antigravity (your setup)

Runs `agy_acp_server.par`, the ACP server Google publishes for editors (the ACP registry's `antigravity-acp` entry;
Zed installs the same one). It's a program, not an npm package, so Nebula downloads it itself, only when you press
**Download** on the row:

- **Pinned.** Version 1.4.1, from the registry entry's dl.google.com URL, with the SHA-256 and size of the archive
  and of each file in it written into `backend/services/antigravity_agent.py`. Google publishes no checksums, so the
  hashes were taken from the download on 2026-10-20 and checked against Google's code signature (Developer ID
  Application: Google LLC, team EQHXZ8M8AV, the same as the `agy` CLI). Nothing is fetched by name or "latest" and
  nothing updates itself. A new version is a code change with new hashes.
- **The 14-day rule.** 1.4.1 was published 2026-10-17, under 14 days old when pinned. The first-party exception
  applies: Google's own signed binary, from Google's own domain, for a person who already runs Google's `agy` and the
  Gemini API (Justin, 2026-10-20).
- **Checked before it runs.** The archive is hashed while it downloads and refused, with nothing installed, if its
  size or hash is off. Only the two expected files are taken out, each hashed again, then moved into place at once.
  A launch goes ahead only while the files still match what was checked; anything else reads "changed, download
  again".
- **Where.** `<state dir>/agent-binaries/antigravity-acp/1.4.1/`, about 400 MB. **Remove download** deletes it. The
  server keeps its own settings and conversation history under `~/.gemini/antigravity-acp/` (or `$GEMINI_HOME`), as
  it does for Zed; removing the download leaves those.
- **Platforms.** macOS on Apple silicon and Intel. Elsewhere the row says there's no download for it.

**Sign in.** The server keeps its own Google login in the macOS Keychain, separate from the `agy` CLI's, so signing in
to `agy` doesn't carry over. Press **Sign in with Google**: Nebula starts the server and asks it to sign in
(ACP `authenticate`, `oauth-personal`); the server opens Google's sign-in page in your browser and waits up to 5
minutes for it. The row also shows the link, in case the browser didn't open. The login goes from Google to Google's
server to the Keychain; Nebula never sees, reads or stores it, and keeps only "signed in: yes". **Cancel sign-in**
stops the server. After that, every chat start asks the server to reuse its stored login, with the browser turned
off, so a chat never opens a sign-in page: if the login is gone, the chat says to sign in again in Settings.
**Sign out** asks the server to delete its stored login (ACP `logout`).

**Terms.** The row carries this note: Google's FAQ says using Antigravity through third-party apps "is not supported
under consumer plans", and its Additional Terms let Google suspend the Antigravity and Gemini CLI accounts that do it.
Using a Google AI plan this way is your call and your account's risk.

Commons (`NEBULA_COMMONS_ENABLED=1`) keeps chat to the built-in Claude and Codex, so personal agents are refused there.

## Updating the adapter pins

A GitHub Actions workflow (`.github/workflows/adapter-pins.yml`) checks the two npx adapter pins every Monday. It runs
`backend/scripts/check_adapter_pins.py`, which reads the pins from `personal_agents.py` and asks registry.npmjs.org
for each adapter's releases. It looks for the newest stable release (no prerelease tag, not deprecated) that is newer
than the pin and was published at least 14 days ago. The 14-day rule is there because a bad release is usually
caught and pulled within days.

If there is one, or the pinned version is deprecated or gone from the registry, the workflow opens an issue titled
"ACP adapter updates past the 14-day hold". If its own issue is already open, it updates it instead, and adds a comment
when the versions changed. Only an issue opened by the workflow (author `github-actions`) counts: the repo is public, so
anyone can open one with that title. Trust that issue's description, not its comments, and run the script yourself
before bumping, since it re-checks the registry. When nothing is due it does nothing. The report also says when the next newer release
clears the hold. You can run it any time from the Actions tab, or locally with
`backend/.venv/bin/python backend/scripts/check_adapter_pins.py`.

The workflow never changes a pin. To bump one:

1. Change the version in the preset's args in `backend/services/personal_agents.py`, and the version, publish date and
   check date in its docstring. Update the table above too.
2. Run the ACP tests: `.venv/bin/python -m pytest -q tests/test_acp_client.py tests/test_acp_events.py
   tests/test_acp_session.py tests/test_personal_agents.py tests/test_chat_personal_ws.py
   tests/test_adapter_pins.py` from `backend/`.
3. Do one real turn with that agent in the chat panel, by hand, and check that text, a tool call and an approval card
   come through. The tests use a fake agent, so this is the only check against the real adapter.
4. Close the issue once both pins are current.

## Not done yet

Reattaching after a reconnect (`session/load`), Hermes profile setup, OpenClaw (it rejects client MCP servers), remote
agents and an HTTP MCP transport, image and file prompts, session modes, slash commands, environment variables for
custom agents, more than one personal session per chat panel, and Antigravity on Linux or Windows. Images reach an
agent through the `nebula` MCP tools' results (`view_output`), not the prompt; Nebula reads ACP's
`promptCapabilities.image` and sends it with the session event (`promptImages`) for the moodboard agent reader
(PR10c), and nothing else uses it yet.

Hermes is planned to come in through the API server on its running gateway instead of a separate
profile, so it keeps one memory: [HERMES-GATEWAY-PLAN.md](HERMES-GATEWAY-PLAN.md).

If the backend is killed outright (no cleanup runs), the agent guardian (`services/agent_guardian.py`) kills the
agent's whole process group, as it does for in-app chats, and the token dies with the backend.

Code: `backend/services/acp_client.py` (JSON-RPC over stdio), `acp_events.py` (update mapping), `acp_session.py`
(sessions), `personal_agents.py` (registry and presets), `agent_binaries.py` (binary lookup), `gemini_cli_setup.py`
(Gemini CLI's ACP flag and login), `antigravity_agent.py` (Antigravity's pinned download and sign-in). Tests drive a stdlib fake
agent, `backend/tests/fixtures/fake_acp_agent.py`.
