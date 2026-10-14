# Implementation Notes

## 2026-10-13 — Connect your agent (PR 3 of 3, and BYO-agent Phase 0)

Settings > Preferences > Agent spending > **Connect your agent** and `nebula mcp connect|disconnect <client>`. Config text lives in one place, `backend/services/agent_connect.py`, used by both.

- **The CLI doesn't make tokens.** The person token lives only in the canvas tab (and the backend's memory). Giving the CLI a way to hold it (a flag, an env var, a file) would put it where an agent's shell can read it, and the CLI is what agents run. So the person makes the token in Settings and hands it to the CLI (`NEBULA_APP_TOKEN` or a hidden prompt). The CLI checks it with `GET /api/agent/spend` (401 → refused; not `budget: "app"` → refused) and uses the app's name and limit from there. `--name`/`--daily-usd` only fill in the Settings steps when there's no token yet.
- **Which clients the CLI edits.** Claude Code and Codex: their own `mcp add` (argv list, no shell). Claude Desktop and Cursor: JSON merge of `mcpServers.nebula` only, diff with the token masked, confirm (or `--yes`), timestamped backup (0600), atomic write 0600, invalid JSON never touched. Hermes and OpenClaw: print only. Hermes's `config.yaml` has comments a YAML rewrite would drop, and `hermes mcp add` has no env flag. `openclaw mcp set` refuses while the Gateway runs, and OpenClaw isn't installed here to test against.
- **No clobber through native commands.** The live round trip showed `codex mcp add` silently replaces a server with the same name. The CLI now runs `<client> mcp get nebula` first and stops if one exists (`codex mcp get` exits 1 when missing, checked live).
- **The backend URL in the config** is the socket the request arrived on (`request.scope["server"]`), not the Host header, so it's right behind the Vite proxy and can't be set by the caller.
- **Venv path not resolved.** `backend/.venv/bin/python` is a symlink (and in worktrees `.venv` itself is one). Resolving it would point the client at the base interpreter without the venv's packages.
- **Packaged app**: `checkout_paths` refuses a path under `.app/Contents/` (or a frozen Python). Settings then offers a plain token; the CLI prints why. Left for the desktop pass.
- **App records gained `client` and `color`.** Old stores load (both None). `PUT /api/agent/spend/apps/{id}` takes `dailyUsd` and/or `color`; both are validated before either is saved. Presence uses the color when set, else the old id-derived one. Names already came from the token; the cursor name is still `clean_agent_name` (32 chars, limited character set), so an emoji in an app name doesn't reach the cursor.
- **UI choices.** New agents default to a $5 daily limit (was "shared budget only"): an agent with its own cron jobs should have a cap unless the person removes it. The setup panel shows steps, the config (unwrapped, with Copy), an alternative where one exists (Codex `config.toml` with `tool_timeout_sec = 150`, OpenClaw's one-line Stdio command), and the warnings in a tinted box. Colors can be picked at creation only; the API can change them later but there's no row control yet.
- **Printed shell commands are broken across lines** with backslashes so they read in the panel. A test pastes each into `sh` and compares the argv to what the CLI would run.
- **Docs checked 2026-10-13**: Hermes mcp-config-reference and cli-commands (main), OpenClaw docs/tools/mcp.md, docs/cli/mcp/registry.md and transports.md (main), modelcontextprotocol.io connect-local-servers, code.claude.com/docs/en/mcp, cursor.com/docs/context/mcp, learn.chatgpt.com/docs/extend/mcp (Codex), plus local `claude mcp add --help` (2.1.296) and `codex mcp add --help` (0.160.0). Two things the research note had differently: OpenClaw's current docs no longer show a stdio JSON example with `env` (only the `--env` flag and the `env` field in the transports table), and `openclaw mcp set` is the JSON form.
- **Not run live**: `claude mcp add` itself (a temp HOME would still let Claude Code reach the login keychain; the argv is covered by the shell-argv test and `--help`), Hermes and OpenClaw (OpenClaw isn't installed; Hermes needed `hermes pm repair` in a temp HOME). Codex add/get/remove ran for real in a temp `HOME`/`CODEX_HOME`.
- **Seen in passing, not fixed**: with a settings file of just `{}` the Settings panel says "Settings couldn't load" (the draft reader wants `apiKeys`). The live check used `settings.example.json`.

**Verification.** Backend: 197/197 files green (new `tests/test_agent_connect.py`, 33 tests: golden snippets for all 7 clients, YAML/TOML/JSON parse, shell argv through `sh`, merge + backup + 0600 + no clobber + invalid JSON in a temp HOME, native-command argv and no-replace, person gate on creation, bad client/color makes no token, packaged-app refusal, name and color on the cursor, old store loads, `--print` via subprocess writes nothing). Frontend 202 files / 2169 tests (one unrelated-looking failure in the first full run didn't recur in two reruns), `tsc` clean, lint clean, node contracts pass. Live on isolated backend 8141 + Vite 5261 (temp HOME, state, settings): made Hermes, Claude Code, Codex, OpenClaw and Cursor agents in Settings; started `backend/mcp_server.py` over stdio with the Hermes snippet's own command and env: `get_spend_limits` → `agent: "My Hermes", budget: "app", appDailyUsd: 5`; `point_at` put a purple "My Hermes" cursor on the canvas. CLI in a temp HOME: Claude Desktop merge kept another server and a top-level key, wrote 0600 with a 0600 backup, disconnect removed only nebula; Cursor file created 0600; a fake token was refused. No paid runs.

### Review follow-up (2026-10-13)

- **Desktop app's changing port (major).** The desktop sidecar runs this checkout's venv on a new OS-assigned port each launch, so a config with that launch's `NEBULA_URL` died on the next relaunch. Fix: new `services/backend_address.py`. In desktop mode (`NEBULA_DESKTOP_MODE=1`, which main.mjs already sets) the backend writes its `NEBULA_URL` to `<state dir>/backend-url` (0600, atomic) at startup and removes it at shutdown if a newer launch hasn't replaced it. Desktop configs carry `NEBULA_URL_FILE` instead of `NEBULA_URL`; `mcp_server.py` reads the file on every call (explicit `NEBULA_URL`/`--url` still wins), and the CLI's global `--url` default falls back to it too. Chose the port file over "treat desktop as unsupported" because the right fix was reachable now. Dev backends keep `NEBULA_URL`: their port is fixed, and several dev backends can share `~/.nebula`, where a last-writer-wins file would point configs at the wrong checkout. The file only accepts an http loopback origin with a port, so an edited file can't send the token elsewhere. No sidecar change was needed: it already sets `NEBULA_URL` per attempt.
- **What the CLI writes comes from Nebula.** `GET /api/agent/spend` for an app token now includes `mcpAddress` (`{"url"}` or `{"urlFile"}`), and the CLI writes that. So a desktop config gets the file even when the person passed this launch's `--url`.
- **Token check fails closed.** Only connection refused / timeout count as "unreachable"; any other answer (404, 500, HTML, JSON without `budget`) exits 1 naming the URL. When unreachable, connect writes nothing for command and JSON clients; print-only clients (Hermes, OpenClaw, other, `--print`) still print with a warning.
- **Backups.** When the old file had a nebula entry (disconnect, or connect replacing one), the backup gets that token swapped for `nebula_app_REDACTED_BY_NEBULA_MCP` (byte-level replace, so the rest of the file is kept as it was). Backups still aren't deleted automatically: they exist to undo a bad merge of the person's other servers.
- **Argv.** Codex: `codex mcp add` gets a random `nebula_app_PENDING_<hex>` placeholder; the CLI then swaps the token in inside `$CODEX_HOME/config.toml` (or `~/.codex`), keeps the file mode, inserts `tool_timeout_sec = 150` under `[mcp_servers.nebula]` when that header is unique, and checks with tomllib that the result parses back. On any mismatch it runs `codex mcp remove nebula` and refuses. This also closes the earlier open issue that Codex users had to add the timeout by hand. Claude Code: `claude mcp add`/`add-json` take the token only on argv (checked `--help`, 2.1.296), and editing `~/.claude.json` directly would race a running Claude Code, so I kept argv and added a warning (CLI and Settings): the token is visible in the process list while the command runs. Same-user programs can read the plaintext config anyway.
- **Claude Code disconnect.** `claude mcp remove nebula` now has no `--scope`: per its help it removes the server from whichever scope holds it, which matches `claude mcp get`'s any-scope precheck and clears older local-scope entries.
- **Live check (isolated, ports 8141 then 5261):** started the backend the sidecar's way (uvicorn, `NEBULA_DESKTOP_MODE=1`, person token on stdin). `backend-url` was written 0600, and the Cursor config from Settings had `NEBULA_URL_FILE`. One MCP stdio session: `get_spend_limits` worked on 8141. With the backend stopped the file was gone and the tool said "Nebula isn't running". After restarting on 5261, the same session worked again with no config change. CLI in temp HOMEs: cursor and codex got `NEBULA_URL_FILE`. Codex config.toml has the token once, no placeholder, `tool_timeout_sec = 150`, mode 600. A second codex connect was refused. Disconnect left a backup with no token. Nothing listening gave "nothing was written", and `python -m http.server` on the port gave the HTTP 404 refusal.

### Stale backend-url file (security follow-up, 2026-10-13)

A review of 082a178b found that the backend-url file outlives a crash. It then names a dead port, and any local program that binds that port next would receive every connected agent's app token.

- **Fix: the client checks the address before sending a token.** The file is now JSON, `{"url", "secret"}` (0600), with a secret made fresh each launch and kept in the backend's memory. `backend_address.verified_url` sends a random 32-byte challenge to `GET /api/agent/address-proof`. The backend answers with HMAC-SHA256(secret, challenge), and the client compares in constant time. Only after that does `mcp_server` (every call) or the CLI's `default_url` (once per command) send the token. Anything else at the port gets one unauthenticated GET with a challenge.
- **Why an HMAC challenge and not a pid check.** A pid can be reused, and "a process with that pid is alive" doesn't prove it's the one listening. A program that can read the 0600 file runs as the same user, so it could read the token from the client configs anyway. The check therefore protects against exactly the programs that matter: other users and sandboxed apps.
- **Withdraw matches the secret, not the URL.** Two launches could reuse a port; the secret is unique per launch.
- **No startup cleanup in dev mode.** A dev backend may share the state dir with a running desktop app, so deleting the file there would break that app's agents. With the check, a stale file is harmless: clients say Nebula isn't running.
- **Window left.** Between the check and the token request (milliseconds on loopback), the backend could die and another program could take the port. Each MCP call re-checks, so the window never spans more than one call. A `nebula run --wait` that polls for minutes checks once at the start.
- **Proxies ignored (`trust_env=False`).** While writing the test I confirmed httpx 0.28 routes 127.0.0.1 through `HTTP_PROXY`/`ALL_PROXY` unless `NO_PROXY` lists it. A configured proxy would therefore have seen the agent token. This was true on main too, for the CLI and MCP. The probe, `nebula_api.NebulaAPI`, the CLI's `httpx.Client`, and `mcp connect`'s token check now all ignore environment proxies.
- **`nebula mcp connect` stays usable with a stale file.** The CLI resolves its URL before dispatching, so the first version made `--print` exit 1 whenever the file failed its check (found in review). For `mcp`, a failed check now warns and leaves the URL unset. The token is never checked against that address, `--print` prints a config naming the file, and a real connect writes nothing. A proof containing non-ASCII text is refused as a mismatch: `hmac.compare_digest` raises TypeError on it, which the callers didn't catch.
- **Tests.** Real loopback HTTP servers: a squatter that answers a wrong proof sees only the challenge and no Authorization header, from both the MCP server and the CLI. A stand-in for the backend gets the challenge, then the call with the token, even with a dead `HTTP_PROXY` set. Both tests fail when the check or `trust_env=False` is reverted (mutation-checked). The proof route returns 404 with no file and 400 on a malformed challenge. Startup writes the file with the in-memory secret, and shutdown removes it.

## 2026-10-13 — Review fixes for the in-app agent confinement

Reviewers of the commit above found that Daedalus couldn't run at all, and two smaller leaks.

- **Every in-app Daedalus turn failed (critical).** The confinement change sent Daedalus through the same `/ws/chat` branch as Claude and Codex, which passes `catalog_validated=...`. `run_hermes` had no such parameter, so the call raised `TypeError` before Hermes started, and the chat showed only that error. The full suite still passed: the chat tests swap in fake runners that take `**kwargs`, and the Hermes tests call `run_hermes` directly, so nothing ran main's keywords against the real runner. Fix: `run_hermes` takes `catalog_validated` and drops it, like `effort` and `extra_dirs`. All runners now take the same keywords. New `tests/test_chat_real_runners.py` sends a turn through `/ws/chat` to each real runner (Claude, Codex, Daedalus) and fakes only the process spawn. For Daedalus it checks `-t nebula,nebula_krea,clarify`, the chat's workspace as cwd, and the minted token in env, never in argv or the overlay. For Claude and Codex it checks the workspace and token. The Daedalus case fails with the old code.
- **Daedalus checked live.** I used a throwaway Hermes home (scratch `HERMES_HOME`, `daedalus-core` installed, plus an extra `probe` MCP server) through a `hermes-daedalus` shim on PATH. Nebula ran as an isolated backend on 8132 and a scripted OpenAI-compatible model ran on 5252 (no paid model). Results are in `docs/HERMES-SETUP.md` §6:
  - The model saw only `clarify` and the tool-search bridge, and the bridge held the 26 `mcp__nebula__*` tools.
  - `get_spend_limits` answered Daedalus / budget "chat", so `${NEBULA_AGENT_TOKEN}` expanded.
  - `tool_call` refused `terminal`, `read_file` and the `probe` server's tool, and Hermes never started `probe`.
  - The `daedalus-core` playbook was in the system prompt, and resume kept the same session and workspace.
  - With a forged token, `--list_tools` showed only `clarify`.
- **Codex's prompt still named CLI commands.** `KREA_MCP_PRIMER` said "or `nebula propose`", and with Commons on Codex got the Commons skill's `nebula commons` twins. Its shell has no network, so those can't work. The Krea primer now names only `propose_change`. `commons/skill.md` names only the MCP tools. The CLI twins moved to `commons/skill_cli.md`, which only Claude gets (`COMMONS_CLI_SKILL`; its shell reaches Nebula). The MCP server's instructions use the tools-only text. The Codex prompt test now asserts that no `` `nebula `` or `nebula commons` appears, with Commons on and with a Krea message.
- **Codex `image_generation` is now disabled.** It was on the reviewed list as "image handling". It makes images on the ChatGPT plan, outside the canvas, the spending limits and proposals: the same reason Daedalus lost direct generation. It is in `CODEX_DISABLED_FEATURES` now. Checked against codex-cli 0.160.0: `--disable image_generation` lists it as false, and the real preflight with the new flags returns no refusal. Tradeoff: Codex can no longer draw a quick sketch on its own; it has to use a Nebula node.

**Still open:** Krea's read-only tools weren't seen through Hermes with a connected Krea account (the isolated backend had none, so `nebula_krea` listed 0 tools). A Hermes update can change toolset or bridge behavior, so re-run the §6 check after updating Hermes.

## 2026-10-12 — In-app agents reach Nebula through its MCP server (PR 2 of 3, and person-gate PR B)

Branch `mcp-tools`. Justin's calls: Codex's shell has no network and reaches Nebula only through the Nebula MCP server; Daedalus gets MCP tools only (`-t nebula,nebula_krea,clarify`) from a private workspace and a minted chat token; agents propose any `_kreaAuth` change.

**What each agent gets**

- **Claude:** `clean_mcp_servers` registers `nebula` and `nebula_krea` under `--strict-mcp-config`. The allow-list names every Nebula tool exactly (`mcp__nebula__<tool>`, no wildcards). `NEBULA_MCP_TOOLS` is the list, and `test_agent_mcp_registration.py` compares it to `mcp._tool_manager`, so a new tool can't be called in-app until someone lists it. The token is not in argv: the MCP config holds `${NEBULA_AGENT_TOKEN}` and Claude fills it from the child env. Claude's shell still reaches the backend, so it keeps the CLI for what the tools lack (projects, save/load, keys, `commons fetch`).
- **Codex:** `-c mcp_servers.nebula.*` with `env_vars = ["NEBULA_AGENT_TOKEN","NEBULA_URL"]` and `tool_timeout_sec = 150`. `permissions.nebula-agent.network.enabled = false`. Writes to `<ws>/.codex` and `<ws>/.agents` are denied. The primer (`CODEX_SYSTEM_PRIMER`) says the shell has no network and names no CLI commands.
- **Daedalus:** the managed overlay now holds both servers; `-t` limits Hermes to them plus `clarify`; it runs from `agent_workspace()` (or the chat's workspace) with `--no-restore-cwd` on resume; `/ws/chat` gives it a workspace session and a minted token like the others.
- **The MCP server applies the turn's workspace.** With a token, `mcp_server.py` asks `/api/agent/context` for the workspace and runs inside `workspace_scope`. A missing or relative workspace exits the server rather than running unscoped. `commons_add` resolves relative paths there.

**Decisions not in the ask**

- **`code_mode_host` stays on (departs from the review's `--disable` list).** The first live Codex turn failed: "code-mode host is disabled". The model on this machine (gpt-6.1-sol) routes every tool call, MCP included, through the code-mode host. Probed live with it on: `typeof fetch`, `require` and `Deno` were all `undefined` in its JS, and the backend log showed no probe request. It is in `CODEX_ALLOWED_FEATURES` with that note. Everything else the review named is disabled explicitly.
- **Feature allowlist, checked every turn.** `codex_feature_preflight` runs `codex features list` with exactly the turn's `-c/--enable/--disable` flags, from the turn's workspace, with an empty `CODEX_HOME` (the command refuses `--ignore-user-config` and `--strict-config`) and without the token in its env. Any enabled feature outside `CODEX_ALLOWED_FEATURES`, a disabled name Codex no longer lists, a nonzero exit, a timeout (20 s) or an unreadable listing refuses the turn. A Codex update that adds a default-on feature will block turns until someone reviews it. That is the intent.
- **Codex tools are approved by exact list.** `run_nodes` failed live with "MCP tool call requires approval, but approval policy is never" (it is open-world). `enabled_tools` lists the 22 tools and each gets `approval_mode = "approve"`. No server-wide default.
- **No `trust_level` override.** I tried `-c projects."<ws>".trust_level="untrusted"`; live, with user config loaded, a planted `.codex/config.toml` MCP server still started. Removed. What actually keeps project config out: `--ignore-user-config` (checked live: without it the planted server started; with it, nothing planted started) plus the `.codex`/`.agents` write-deny so a turn can't plant one.
- **Krea allow rules widened** from two tools to every `KREA_READONLY_TOOLS` entry, so the allow-list matches what the Krea server exposes read-only.
- **Daedalus cron jobs are refused, not cleared.** `scheduled_jobs_refusal` reads `~/.hermes/profiles/daedalus/cron/jobs.json`; any enabled job, or a file it can't read, refuses the turn with the `hermes-daedalus cron list/remove` commands. Deleting someone's jobs silently is a human call.
- **Overlay failure refuses the turn.** It used to be a "thinking" note and the turn ran without Nebula's tools. Now it is an error.
- **Daedalus with Commons on is still refused**, token or not (scoped Commons access for Hermes is unverified).
- **Old Daedalus chats can't resume.** They named Hermes' raw session id; `/ws/chat` now refuses ids it didn't issue ("Start a new chat with /clear"), as it already did for Claude and Codex. `test_commons_integration.py` and `test_commons_runner_integration.py` encoded the old pass-through and the old "Daedalus refuses a token" rule; both were rewritten to the new contract, keeping the refusal cases.
- **Primers split.** `NEBULA_MCP_PRIMER` is shared; Claude adds `CLAUDE_CLI_PRIMER`, Codex adds `CODEX_SHELL_PRIMER`. `backend/commons/skill.md` and `.hermes/skills/daedalus-core/SKILL.md` (1.2.0) lead with the MCP tools.

**Gaps and surprises**

- **The MCP tools lack save/load, projects, keys and `commons fetch`.** Codex can't do those in-app now. Daedalus's skill no longer saves projects.
- **Hermes was not live-tested in this commit** (no `daedalus` profile here). The 2026-10-13 review fixes above ran it live with a throwaway profile and found the `catalog_validated` crash.
- **Not tested:** a planted skill that declares an MCP dependency (`skill_mcp_dependency_install` is disabled and `.agents` is write-denied, but no live probe).
- **MCP stdio servers run outside Codex's sandbox.** That is why the server gets the token and the shell doesn't need network.

**Verification:** targeted files green (codex_session + agent_mcp_registration 33, hermes_session 26, chat_isolation_lifecycle + cli_api 158, commons integration 7 + 12). Backend 196/196 files, frontend 198 files / 2138 tests, `tsc` clean, desktop unit tests (connector-vault, credential-service, folder-picker, migration, navigation, paper-links, path-migration, person-token, sidecar) pass; the Electron launch suites (integration, resilience) were not run. Live on isolated backend 8132: a Claude turn and a Codex turn each called `get_spend_limits` (budget "chat", agent named), `edit_canvas` and `run_nodes` on free nodes; the canvas cursor showed the chat agent. In the Codex turn, `curl` to the backend exited 7 and `nebula spend` couldn't connect; the backend log had no shell requests. Sandbox probe (`codex sandbox -P nebula-agent`): loopback curl rc 7, `.codex`/`.agents` mkdir denied, workspace writes allowed. No paid runs.

## 2026-10-12 — MCP tools: build, run and see results from any MCP client (PR 1 of 3)

Branch `mcp-tools`. Justin chose: the MCP server serves outside clients and the in-app agents; tool shape and setup "whatever gives the best results". Plan: three PRs (tools, in-app wiring, `nebula mcp connect`). This is the first.

**Decisions not in the ask**

- **Few batched tools, not one per CLI command.** Anthropic's "Writing effective tools for agents" says more tools don't mean better results and favors consolidated tools for the main workflows. So nine tools, and `edit_canvas` takes the same body as `propose_change`: an agent that learns one can send the other, and a cluster is one call instead of ~15.
- **All or nothing.** `POST /api/graph/apply` stages unwire → remove → add/change (`_stage_proposal`, now with a `base` graph) → rename → move on a clone and commits once through `_commit_graph_candidate_with_recoveries` under `_paid_graph_mutation`. A half-built graph is worse than an error the agent can fix. Proposal limits apply. The route refuses browser callers (403); it is for agents.
- **`_ensure_node_deletable`** was factored out of `DELETE /api/graph/node` so removals in an edit get the same World Labs paid-state guard. Its message now names the node.
- **`_kreaAuth` is allowed in direct edits** (`parse_spec(internal_ok=...)`), checked against the modes the node offers. Without it an agent couldn't put a dual-mode Krea node on the signed-in account; the CLI already allows it. Proposals still refuse underscore params.
- **Waits default to 45 s.** Codex's per-tool timeout defaults to 60 s. `run_nodes` and `get_run` are async and wait in a worker thread so the stdio server keeps answering while they wait.
- **One run target.** `run_nodes` runs one node (with what feeds it) or the whole canvas. Several separate targets would start parallel runs that can share upstream nodes and pay twice.
- **Previews are capped.** `GET /api/graph/node/{id}/preview` reads only files under the output root (external URLs refused, 415), sizes 512/1024/1568, JPEG unless transparent, shrunk until ≤350 KB, because Claude Code caps a tool result at 25,000 tokens. Videos become three frames side by side; image lists up to four tiles. `run_nodes` attaches up to four small previews.
- **One readiness rule.** `services/node_readiness.py` is used by `nebula context`, `GET /api/agent/nodes` (find_nodes) and `GET /api/agent/nodes/{id}` (describe_node). Dual-route nodes list `paramsDirect`/`paramsFal` and which route this machine uses. Definitions have no `description` field, so search matches id and name only.
- **One HTTP layer.** `backend/nebula_api.py` (`NebulaAPI`, `NebulaAPIError`) sends the token and Daedalus marker for both the CLI and the MCP server; the CLI keeps its print-and-exit messages on top. `get_selected_nodes` now sends the agent's name and token like the other tools (it sent none).
- **Instructions are a workflow**, ~210 words plus the commons skill. They keep "agents cannot accept", which a proposals test guards.
- **Found while verifying: the canvas snapshot ignored custom names.** `look_at_canvas` showed "Image Input" for a node an agent had just renamed "Reference" (the snapshot predates renaming). It now shows the custom name, with the model in `model`; `nebula look` prints both.

**Keyless nodes don't count (Justin's call after review).** The smoke test showed a no-key Nano Banana run adding its $0.067 estimate to the session, though it failed before any provider call.
- **First attempt, replaced:** leave nodes without a key out of the estimate, judged from their definitions. The background security review found that this predicted the handlers instead of observing them. `handlers/krea.py` also accepts `KREA_API_KEY`, which no definition lists, so a run the prediction called keyless could bill and slip past the limit. Any mismatch between the prediction and a handler is a way around the limit.
- **What shipped observes instead.** The limit check and the count at start are unchanged. Handlers raise `execution.missing_credential.MissingCredentialError` (a `ValueError`) from their key checks; all 56 are before the handler's first `await`, checked by script, including the Krea/Ideogram helper callers and the four handlers that reuse others. The engine marks that node's `ErrorEvent` `missing_credential`, and `_release_unspent_hold` gives back that node's share of the run's hold (`_spend_holds`, per node, from `Decision.per_node`). A wrong guess can now only over-count, never let a run past a limit.
- **Same class, also fixed:** a request refused after the spend check but before its run started was counted. Now `_return_hold` runs on those exits: run registration failures, World Labs claim failures, a bad `wait` on `/api/graph/run` (validated before the check now), and cinema validation (its check moved after validation).
- **Behavior note:** a keyless run over a limit is still refused with a proposal hint, because only running it shows which key the handler finds.

**Nodes that never reach their provider don't count either (Justin: "Yes do that next").** Covers cache hits, nodes held back by an upstream failure, and nodes a stopped run never started.
- **Observed at the one call site.** `execution/provider_calls.py` keeps, per run, the nodes whose handler was called. The engine marks a node just before `await handler(...)`, its only provider entry point; cache hits return earlier and never get there.
- **Settled when the run ends.** `_settle_hold(run_id)` runs in the `finally` of all five run paths (execute, execute-node, cinema, CLI run, and quick), after the World Labs release. It gives back the share of every counted node not in the called set. A node whose handler was called stays counted even if it failed or was stopped, since a request may have gone out.
- **Untracked means counted.** `take()` returns None for a run without a trustworthy record, and then nothing is given back.
- **Hardened after the background security review** (it flagged a fail-open state drift in `provider_calls.py`). The first version registered every engine run with an id, evicted the oldest past 500, and let `mark()` re-create a missing record. A long agent run pushed out of the table would come back with a partial record, and nodes it had already called would be given back. Now: a run is registered once, in `_place_hold`, when its hold is placed; `mark()` never creates a record; a second registration of the same id (`/api/execute`, `/api/execute-node` and cinema accept a client run id) makes the record untrustworthy; a full table records nothing new; and dropping a hold drops its record. Every one of these keeps the whole count. The fake engines in the spend tests now record each node as called, like the real one.
- **No double refund.** A keyless node's share is popped from the hold when its error arrives, and it is in the called set anyway.
- **Quick runs now carry a run id** (`quick-<hex>`) into the engine so they can be tracked. Nothing else keys on it apart from the run folder's name; no handler reads `execution_run_id`, and quick's event collector ignores it.
- **Tests** use the real engine with the two OpenAI handlers swapped for counting fakes (`test_agent_spend.py`): a cache hit is given back; after an upstream failure only the downstream share is given back; a run where both nodes run keeps both. The cache-hit and upstream-failure tests fail with `_settle_hold` turned off.
- **Live** (isolated backend, no keys, MCP stdio): GPT Image 2 into GPT Image 2 Edit, run on the editor. The generator stopped at its key check, the editor never started, and the session total stayed $0.00. No paid runs.


**Cinema scenes passed the spending check as free (found while testing variations).** `cinema-scene` is defined as `apiProvider: "utility"`, and the estimate skips utility nodes. Its handler calls a paid base image model once per shot through that model's own handler, so an agent could run a whole scene with no limit at all. The bug dates from the spend gate (PR #38).
- **Priced as its base model, once per shot.** `model_pricing.cinema_scene_base` reuses the handler's own `_guard_base_model` and `_build_base_node`, so the price follows what the handler calls. An unreadable scene, or a base the handler refuses, is unpriced. Shots only override seed and strength, which no price row matches on.
- **Counted against the base model.** Priced lines now carry `model`, the definition billed. `decide` keys `by_model` on it, so a per-model limit on Nano Banana covers cinema shots that use it. Proposal payloads keep `price` as `{low, high}`.
- **The default base, Seedream 4.5, has no list price**, so under any limit an agent must propose a default cinema scene. `describe_node` says so (`priceNote`, the unpriced bases computed from the price table); `find_nodes` shows `price: null` instead of "free".
- **Proposals call a cinema scene "paid · <base provider>, per shot"** instead of "free · runs locally". That label is what the person reads before accepting.
- **The canvas matches.** `runScope.ts` mirrors the rule (`cinemaSceneBase`), so the Run chip and "Ask before costly runs" price scenes too; each line's `runs` includes the shots.
- **Variations count once each.** `/api/cinema/generate-shot` with `variations=N` (max 4) runs the whole subgraph N times with the cache off but was priced as one pass. `decide(passes=N)` multiplies every node's share.
- **Left as is:** cinema isolates errors per shot, so a scene whose base has no key finishes with failed shots and stays counted. It over-counts, never under. `find_nodes`/`describe_node` still say `runsWith: "free"` for cinema-scene, though it needs its base model's key.
- **Live** (isolated backend 8124, no keys, MCP stdio): a default-base scene was refused with the proposal hint; a 2-shot Nano Banana scene counted $0.134 (2 × $0.067) under `nano-banana`. On an isolated canvas the Run button read "~$0.13" (screenshot `.playwright-mcp/cinema-run-chip.png`). No paid runs.
- **Mistake while debugging, repaired:** a one-off script imported `main` outside pytest, so it used the real repo-root `settings.json` and wrote `runCostConfirmUsd: 1` and an empty `agentSpend` into it. Both fields were removed again; nothing else changed (checked file times under `~/.nebula` and the repo). If a threshold had been set, the open canvas copies it back on its next settings read; a session budget set that day can't be recovered.

**Verification:** backend 194/194 test files pass (per-file runner), including new `test_graph_apply.py` (9), `test_output_preview.py` (6, one with a real ffmpeg clip) and `test_mcp_tools.py` (8, tools called with HTTP routed into the app). Live on an isolated backend (temp state, no keys, port 8123): a stdio `ClientSession` listed 22 tools and ran find/describe/edit/run/view/spend/remove; a bad wire came back as the validator's message and changed nothing. A real `claude -p` with only this server built a two-node graph, ran it and described the image from the inline preview: 7 Nebula calls, no errors, journaled as "Claude Code". With the canvas open in a browser, an edit showed up live with the agent's cursor and note. No paid runs.

## 2026-10-12 — CLI fixes for agents: spending limits, long runs, missing commands

Branch `cli-agent-fixes`. Justin chose: the person's "Ask before costly runs" threshold applies to agents, a node with no list price needs a proposal, and Settings gets a per-chat-session budget plus per-model limits (per run and per session). Limits apply to agents only; at a limit the agent asks (proposes), it is never silently blocked.

**Decisions not in the ask**

- **The estimate is an upper bound.** It sums the high list price over every node the run includes, batches counted, like the canvas's `summarizeRunScope`. The run cache could skip some nodes, but cache keys depend on upstream outputs and the cache is in memory with a 1-hour TTL, so it can't be predicted. Overcounting asks too often; undercounting would let a run past a limit.
- **Counted at start, not at finish.** A session total includes a run when the gate lets it through, at that estimate. Counting on completion would let an agent start several runs in parallel under one budget.
- **What a "session" is.** In-app Claude/Codex chats: the agent token now carries the chat id (`chat:<id>`), so each chat has its own budget. Everyone else (Hermes, outside agents, scripts) shares one budget per backend launch. A first draft let tokenless callers name their session in an `X-Nebula-Agent-Session` header; a security review pointed out that rotating the header (or the agent name) would reset the budget every run. Budgets are now keyed only by what Nebula itself minted, and the header was removed. Giving Hermes its own budget needs a minted token for it, which also carries workspace authority; not done here. Totals persist to `~/.nebula/agent-spend.json`, pruned to 500 sessions.
- **Person-only settings.** `PUT /api/settings` refuses `runCostConfirmUsd` and `agentSpend` from anything but the person's canvas (same gate as pins), so an agent can't raise its own limit. Other settings still save from anywhere, as before.
- **The threshold moved to settings.json.** It used to live only in browser storage. The browser keeps a copy so the Run button can ask before settings load, and copies a browser-only value to settings once (`runCostConfirm.ts`).
- **Gate after validation.** On `/api/execute` and `/api/execute-node` the spend check runs after graph validation, so an invalid graph reports why it can't run instead of its cost.
- **Desktop.** The packaged renderer can send `Origin: null`, so the connector session header now also goes on `/api/execute*`, `/api/cinema/generate-shot` and settings writes (not reads). Not checked in Electron; that waits for the desktop pass.
- **Long runs.** `/api/graph/run` used to run inside the request; the CLI's 300 s HTTP timeout killed long video runs and printed a traceback. The run is now a background task registered with `execution_runs` (so it fences project switching, appears in reconnect statuses, and `DELETE /api/executions/{id}` stops it). `wait` returns `{status: "running", runId}`; `GET /api/graph/runs/{id}?wait=` collects it. Outputs sync to the graph as each node finishes, so a stopped run keeps them. Without `wait` the request still waits, as before.
- **CLI wait default is 100 s.** Under the usual 120 s agent shell limit; "still running" exits 2, like `watch` and `proposal`.
- **`nebula context`** now mirrors the canvas readiness rule (`kreaConnection.ts nodeKeyStatus`): keys and direct keys, free nodes, Krea account (and how many nodes a sign-in would add), Nous. It lists definition ids, since that's what `nebula create` takes.
- **Tests for other subsystems.** Provider-admission, Krea gateway and quick tests post runs the way an agent does, so the gate refused them. They opt into a `spending_limits_off` fixture (conftest) that patches the limit readers, i.e. the person turned limits off. The gate's own behavior is in `test_agent_spend.py`. Settings tests now default to a saved threshold.

**Follow-up for Justin:** Daedalus's `DAEDALUS_APPROVAL=step` asks in chat, but the backend can't see that `APPROVED:`, so a run over a limit still needs a proposal (two confirmations). A server-side, session-scoped approval would fix it; not built.

**Verification:** backend 191/191 test files pass (run file by file with a 240 s cap after one hung). Frontend 2107 tests, lint, `tsc -b` pass. Live check on an isolated backend + Vite (temp settings, no keys): limits saved from Settings reach `GET /api/agent/spend`; through the CLI, create/connect/disconnect/rename/move/delete/projects work, and a Veo 3.1 run was refused at its $1 model limit with the propose command. The model-limit rows were cramped in the 380 px panel, so their controls moved to their own line. No paid runs.

## 2026-10-12 — Settings UX pass

Justin asked for every item from the Settings review: quick fixes first, then a restructure shown as an HTML mockup before building it.

**Quick fixes (commit 1):**
- **Remove asks first.** It deletes from disk immediately (`DELETE /api/settings/api-keys/{provider}`), unlike every other key edit, so it now takes two presses. The first press arms it and focuses Keep. Escape backs out of the confirm without closing the panel, because the confirm claims Escape in the capture phase (the dock's own Escape listener is native and runs before React's bubble handlers).
- **Remove was 16px** because `.settings__secondary-button` sets `font: inherit` and the key row inherits the body size. Secondary buttons, the cost-confirm select and "Show onboarding again" now use the UI face at the body size. Key and path inputs stay mono.
- **Settings is 400px wide** (it was 24vw, about 307px at 1280). Below 701px it keeps the full-width dock rule.
- **Saving a changed key checks connections.** The Oct 8 rule is that checks run only after an explicit action, never from browsing. Saving a key is that action, so it now runs the same read-only `?refresh=true` check. Saves that change only paths or the Krea default don't. Opening the panel still doesn't check anything, which keeps that rule.
- **Not done, on purpose:** "show Save only when something changed". The restructure removes the footer Save entirely, so building it now would be thrown away. The orange ring on the close button that showed up in the review was a test artifact (a script `.click()` counts as keyboard), not what a mouse click does.

**Restructure (commit 2), built from the approved mockup:**
- **Three tabs (Providers / Preferences / Storage), no footer, no nested scroll.** Tabs follow the WAI-ARIA pattern (roving tabindex; arrows, Home, End), with a pill that slides on the rail spring. A setup link from a node always lands on Providers.
- **Every change saves on its own** (`lib/settingsWrites.ts`). A key saves on **Save key** or Enter; a folder on Enter, blur or picking; a switch or select the moment it changes. Writes go through one serial queue, so two quick edits can't land out of order. The panel shows what the backend confirmed (`saved`), never what was sent. `PUT /api/settings` already merged partial bodies, so the backend didn't change.
- **The store got simpler.** `settingsDraftStore` dropped `draft`/`baseline`/`mutation`/`pendingRefresh` for `saved` plus per-key `keyDrafts`, per-field `pending`/`errors`, one `openRow` and a `notice`. Unsaved key text still survives closing the panel and never touches browser storage.
- **Provider rows come from the node catalog** (`lib/providerCatalog.ts`). Each row says what the key unlocks; the add list sorts by how many nodes a key opens. Search matches provider names and every model a provider runs (via `matchesModelSearch`), so "Veo" finds Google, Vertex, fal, Runway and both Krea routes. Brand words are trimmed from node names ("ElevenLabs TTS" → "TTS") except before a bare version ("Krea 2" and "Ideogram 4" stay whole). MiniMax and Higgsfield got hand-written notes because their node names ("T2V", "Higgsfield") say nothing. `tests/providerCatalog.test.ts` pins the list to the backend's `_CREDENTIAL_PROVIDER_ALLOWLIST` and to every `envKeyName` a node uses.
- **Krea sign-in and Nous are rows too.** Krea's state and polling live in `useKreaConnection`, above the row, because the row remounts when it moves between lists. A pending sign-in or an error opens the row by itself: the fallback "Open Krea sign-in" link can't hide behind ⋯ exactly when the browser blocked the tab. The default for new Krea nodes stays reachable while signed out if it's set to sign-in. Nous is always listed now (it was only shown via a setup link), with the `hermes-daedalus model` instructions in its row.
- **Vertex takes the key file.** Choose or drop the JSON, or paste it. The row validates type/email/project/private key locally and shows the account and project. It never renders the private key.
- **Undo only for newly added keys.** Replacing a key can't be undone, because the old secret is gone. Undo notices stay 10 s (plain ones 6 s). I first tried 6 s for both, and it ran out while I was reading the row's check result.
- **Focus follows a row that moves.** Adding or removing a key remounts the row in the other list; `rowHelpers.focusRowAfterMove` hands focus to the new row's button. Escape backs out one step at a time (confirm → row → search → dock), each claimed in the capture phase.
- **Desktop folder picker.** A new `dialog:choose-folder` IPC (`desktop/folder-picker.mjs`) with sender validation and a sanitized `defaultPath`. The preload exposes only a frozen `folders.choose`.
- **Bug found while verifying: a key's check was thrown away.** Saving dispatches `nebula:settings-saved`. App re-reads settings on it and calls `setSettingsCache`, which always invalidated provider checks, so the check that saving had just started was discarded mid-flight. The rows stayed "Saved". The old panel hid this by waiting for its own refresh before checking. Fix at the source: `setSettingsCache` now invalidates only when the saved keys actually differ (masked values compared, missing = empty). There's a test for the read-back case.
- **CSS.** New `styles/settings.css`, scoped to the theme. All old `.settings__*` rules were removed from `panels.css` and `slava-restraint.css`, keeping the shared `:is(...)` focus rule minus its settings entries. `KreaConnectionCard.tsx` is deleted; `krea-connection.css` keeps only the plan list.
- **Docs.** The 14 API guides, `docs/KREA-MCP.md`, `desktop/README.md` and a README pointer now describe Add key / Save key / ⋯ instead of Save Settings.
- **Checks.** Frontend: 2,104 vitest tests, `tsc`, lint, CSS guards and the production build all pass. Desktop: 287 of 290 pass. The 3 failures are the Electron launch suites (`integration`, `resilience`), which fail on the committed code too (4 failures there, checked by stashing and rebuilding), so they come from this machine's environment, not this change. *(Corrected 2026-10-13: not the environment. The real causes were desktop and web builds sharing `frontend/dist`, isolated launches that weren't isolated, and a harness that counted the dev uvicorn on :8000; see "Desktop launch tests (integration + resilience) pass" below.)* Verified live at 1280×820 with real clicks, using a throwaway Ideogram key (added, checked as "Key rejected", undone), so Justin's real keys were never touched.
- **Missed until CI: two backend tests read the UI source.** `test_settings_ui_covers_all_registry_api_keys` and `test_removal_provider_catalog_matches_settings_ui_and_registry_example` regex the provider keys out of a frontend file. The list moved from `Settings.tsx` to `lib/providerCatalog.ts`, so they matched nothing and failed on PR #37's CI. I hadn't run the backend suite locally because the backend didn't change. Fixed by pointing both at `providerCatalog.ts` (`50712c61`); the full backend suite (3,941) passed locally and in CI before the merge. Lesson: run the backend tests even for a frontend-only change, because backend tests guard frontend files too.
- **Polish after review:** the tab bar sat flush against the header divider; it now has a top margin (`705bef65`).

## 2026-10-12 — Settings from the Projects home

Justin asked for API keys to be reachable from the home page. Before, Settings only rendered inside a project, so a first run had to create a project just to add keys.

- **Same panel, not a copy.** Home renders the shared `<Settings />` dock in `.workspace-overlays--home`; a gear at the right of the home header toggles it (`aria-expanded`, `aria-haspopup="dialog"`). Escape and the close button work as in the workspace, and focus returns to the gear (`usePanelFocus`).
- **Placement.** Home has no rail, so the drawer hangs from the gear (top right, under the header) with the dock's spring, entering downward instead of sliding out of the rail. Reduced motion skips the entrance and fades the exit, like the workspace docks.
- **Dock state across home ↔ project** (`useHomeSettingsDock`). Settings is a left dock, and nothing reset docks on project open. Arriving home closes an open Settings; leaving home restores the drawer the workspace had (usually the Nodes menu) when the dock is still Settings or closed. So Settings opened from home doesn't follow you into the project, and a drawer picked meanwhile is kept.
- **Test change.** `App.canvasFocus.test.tsx` asserted home renders no workspace chrome, including Settings. It now expects Settings (closed) and still checks chat, import, commands and run are absent.
- Checked live at 1280×820: the drawer lines up with the header's right edge, Escape returns focus to the gear, and opening a project with Settings open lands on the canvas with the Nodes menu, not Settings.

## 2026-10-10 — Retire shut-down Google models; Veo on Vertex AI

Google shut down or is about to shut down several models our nodes call (https://ai.google.dev/gemini-api/docs/deprecations, checked 2026-10-10). Merged as PR #35 on 2026-10-12.

**What changed:**
- **Imagen 4 is gone** (shut down 2026-08-17). `imagen-4-generate` is removed from both catalogs and the handlers. A saved node loads as Nano Banana on 2.1 (Google's named replacement) with its aspect ratio and 1K/2K size carried over, titled "Nano Banana (was Imagen 4)" unless the person renamed it. `services/retired_nodes.py` runs on boot restore, project snapshots, graph-file import and `CLIGraph.load`. Creating a new one returns a 400 naming the replacement. The onboarding sample graph and Create's Featured list use Nano Banana instead.
- **Nano Banana 2.1** (`gemini-nano-banana-2.1`) is a model on `nano-banana`: 1K/2K/4K, all 14 aspect ratios. Google documents it only on the Interactions API, so it has its own branch in `handlers/google_gemini.py`. Image URLs go to Google as `{"type": "image", "uri"}` rather than being fetched here. A saved 512 renders at 1K.
- **Gemini Omni** calls `gemini-omni-1.1-flash`. The preview ends 2026-10-22.
- **Veo 3.0, 3.0 Fast and 2.0 options are gone** (shut down 2026-06-30). Saved nodes move to the matching 3.1 model (`RETIRED_PARAMS` in `retired_nodes.py`). Veo 2's 5 s becomes 6 s, the nearest length that doesn't cut the clip short. The 4 s option and seed are now always visible; 4K stays Standard/Fast only.
- **Veo routes, in order:** Vertex AI (`GOOGLE_VERTEX_CREDENTIALS`), then the Gemini API (`GOOGLE_API_KEY`), then fal (`FAL_KEY`).
  - `directKeyName` can now be a list. `frontend/src/lib/directRoute.ts` resolves it for the Inspector, Create, readiness and route display; `model_pricing.route_provider` does the same on the backend. With nothing set, setup points at Vertex.
  - **Vertex:** `services/google_vertex.py` signs an RS256 JWT with the service-account key (via `cryptography`, already a dependency, so no Google SDK) and exchanges it at the fixed `oauth2.googleapis.com/token`. It never uses the key file's `token_uri`. Tokens are cached until 5 minutes before expiry. Express-mode API keys don't cover Veo, which is why this needs a service account. Calls go to `us-central1`, with the project taken from the key.
  - **Vertex models:** the preview model values map to `veo-3.1-generate-001` / `veo-3.1-fast-generate-001` (GA, retiring "Nov 17 2026 or later") and `veo-3.1-lite-generate-001` (preview).
  - **Vertex requests and output:** every request sends `generateAudio: true` and `sampleCount: 1`. No `storageUri` is sent, so videos come back inline. A `gcsUri` answer is downloaded with the same token.
  - **Vertex extension:** it extends from bytes, so a Vertex run's Source URI is the saved file. A Gemini `files/` URI is refused with an explanation.
  - **`veo-3-flf`** also runs on Vertex when the key is set. It maps its fal-shaped params: `auto` aspect ratio is omitted, `"6s"` becomes 6, and `negative_prompt` becomes `negativePrompt`.
  - **fal** moved off the deprecated `fal-ai/veo3` to `fal-ai/veo3.1` and `/fast`. It adds `/image-to-video` when a first frame is wired and `/first-last-frame-to-video` when both frames are. The old fal route sent Google's param names (`aspectRatio`, `"8"`), which fal doesn't read. They're now `aspect_ratio` and `"8s"`. Lite isn't on fal and runs as Fast. Extension isn't offered on fal, so it fails with a pointer to the Google routes.
  - **From 2026-10-22,** a failed Gemini API or fal Veo run appends "add a Vertex key" (`with_vertex_hint`). Nothing is blocked ahead of time, in case either keeps working.
- **Settings:** new "Google Vertex AI (service-account JSON, for Veo)" field. The key is on the credential allowlists (backend and desktop bridge). The health check validates the JSON offline (`configured_unverified`), since a real check needs a token exchange.
- **Image fetches for Veo frames** now go through `fetch_public_media` (public https only, every redirect re-checked). Before, any URL a graph supplied was fetched server-side.
- **Pricing:**
  - `veo-3` rows are model × resolution from Google's per-second with-audio table. The old note claimed the node sends no duration or resolution; it does, through `sharedParams`. The estimators didn't read `sharedParams`, and now both do (`_definition_params`, `definitionParams`), with a shared fixture case.
  - Vertex is priced with the same rows. Vertex lists identical amounts per "count" without saying what a count is; they're read as per second, the higher reading. Unconfirmed.
  - Nano Banana 2.1 rows: $0.0336 / $0.0504 / $0.113 for 1K / 2K / 4K.

**Not verified live:** no paid generations were run. That covers the Vertex request and response shapes (built from Google's model reference), extension from bytes on Vertex, the fal 3.1 endpoints' param names (from fal's model pages), and Nano Banana 2.1 on the Interactions API.

**Follow-up checks (2026-10-11), against the providers' current docs, still no paid runs:**
- **fal:** the `fal-ai/veo3.1` endpoint schemas (OpenAPI) match what we send: `aspect_ratio`, `"8s"`, string `safety_tolerance`, `image_url`, `first_frame_url`/`last_frame_url`. `/fast` has a first-last-frame endpoint too.
- **Nano Banana 2.1:** the Interactions request matches Google's examples and API reference: `response_format` with `type`/`aspect_ratio`/`image_size`, image blocks with `data`+`mime_type` or `uri`, and `store`. Whether any public https image URL is accepted as `uri` isn't spelled out.
- **Vertex request and response:** `predictLongRunning`, `fetchPredictOperation` and `response.videos[]` (inline bytes when no `storageUri`) all match. Google now brands Vertex AI as "Gemini Enterprise Agent Platform"; hosts and paths are unchanged.
- **Vertex fixes:**
  - Fast and Lite stop at 1080p on Vertex (only Standard renders 4K), so 4K with Fast or Lite is refused up front.
  - Frames must be JPEG/PNG, so other formats are converted to PNG.
  - Vertex extends with Lite too, doesn't lock the output to 720p, and accepts any 1–30 s, 24 fps MP4. So Extend Video on Vertex now takes a saved file, a public https URL (≤100 MB) or `gs://`.
- **Lite frames:** Lite's model card says image input "Not supported" while its capability list says image-to-video. Frames are sent and Vertex decides, since a request it rejects should fail clearly at no cost, and the Gemini API route already sends them.
- **IAM:** the role is "Gemini Enterprise Agent Platform User" (`roles/aiplatform.user`, formerly Vertex AI User).
- **Gemini Omni:** inputs are now fetched through `fetch_public_media` (public https only, ≤100 MB), closing the same SSRF shape fixed for Veo.
- **Deprecations:** Google's page names `gemini-omni-1.1-flash` as the Gemini API replacement for the Veo 3.1 previews, alongside the GA models on the Agent Platform.

**Live runs (2026-10-12), on the Mac in browser mode:**
- **fal: passed.** With only `FAL_KEY` set, `veo-3` on Veo 3.1 Fast, 4 s, 720p, no frames, returned a 4.01 s 1280×720 mp4 with an audio track in about 53 s. That combination can only route to `fal-ai/veo3.1/fast` (`fal_veo_route`).
- **Gemini API (Nano Banana 2.1): passed** after Justin topped up the project's prepay credits. A 1K 1:1 request returned a 1024×1024 JPEG through the Interactions branch (`INTERACTIONS_IMAGE_MODELS` in `handlers/google_gemini.py`). The first attempt failed with `RESOURCE_EXHAUSTED: Your prepayment credits are depleted`, while the provider health check reported Google "valid". That check only lists models, which is free, so it can't see prepay balance.
- **Run manifests don't record the route.** `manifest.json`'s `endpoint` is the node definition's static `apiEndpoint` (`execution/engine.py`), so the fal Veo run says `veo-3.1-generate-preview` and the Nano Banana 2.1 run says `generateContent`. Neither was the call made. Left as a follow-up: record the endpoint the handler actually hit.
- **Vertex: skipped.** The goodmachines.ai org enforces `iam.managed.disableServiceAccountKeyCreation` (Google's default for newer orgs), so no service-account JSON key can be made. A service account `nebula-veo` with `roles/aiplatform.user` exists in `goodmachines-gemini`, without a key. Justin chose to merge without a Vertex live run. Anyone on a recent Google Cloud org will hit the same wall, so keyless Vertex auth (ADC with service-account impersonation) is the follow-up if Vertex matters.
- The `veo-3` port notes said extension is "not Lite; output locked to 720p" and Source URI is always a `files/…` URI. Both are Gemini-API-only now; the notes say what each route does.

## 2026-10-10 — Run cost from a curated price table

Justin chose option (a): a curated price table, each price checked against the vendor's page, then a cost chip on Run and a confirm above a threshold. Not committed yet.

**The table** (`backend/data/model_pricing.json`, 56 nodes):
- Every entry has `sources` (https URL plus the quoted price line) and a `checked` date. `validate_pricing` refuses entries without them, values that aren't real node options, utility nodes, and dual-route nodes that don't say whose price it is.
- 47 Krea entries are **generated** by `scripts/sync-krea-catalog.py` from `x-krea-pricing` in Krea's OpenAPI spec (exact USD per request for API-token runs). They carry `generatedBy` and the sync script owns them: it rewrites only those and errors if one collides with a curated entry. 20 Krea models stay unpriced because their price depends on things a node param doesn't capture (reference image count, video reference, billing tier). The script prints why for each.
- 9 entries are **hand-curated**: GPT Image 2 / 2.5 generate and edit (OpenAI calculator rows), Nano Banana (Google), Veo 3.1 direct (Google, per second), Nano Banana via fal (generate and edit), Kling v3 (fal, per second).
- Not priced on purpose: Gemini Omni Flash (per-second rate known, clip length isn't), Imagen 4 (shut down), Veo 3.0/2.0 (shut down), every Krea account run (compute units with no published rate).

**Decisions:**
- **One estimator, two implementations, one test file.** `services/model_pricing.py` and `frontend/src/lib/pricing.ts` both run `backend/tests/fixtures/pricing_cases.json`, so they can't drift. The frontend fetches the table once from `GET /api/pricing` (`store/pricingStore.ts`, loaded in `App.tsx`).
- **Ranges, not guesses.** `auto` quality/size on OpenAI resolves at run time, so those rows are `[low, high]` over the node's own options (GPT Image 2.5 auto/auto is about $0.0047–0.43). Wide, but true.
- **"+" means part of the run has no price.** Edit nodes have `plus: "input images"` (OpenAI bills input image tokens by size), and unpriced paid nodes also open the total. The chip shows "$0.16+", and the tooltip names what's missing.
- **Route-aware.** Dual-route nodes (Veo 3, Ideogram, Meshy) bill whichever key is set. An entry names its `provider`, and the run is unpriced when it routes elsewhere (Veo via fal has no entry yet). Backend `route_provider` mirrors frontend `runRouteProvider`.
- **Batches multiply.** Below a Batch a node runs once per item; below an Iterator up to its cap (the array isn't known until run time). The nearest fan-out above a node decides, matching the engine's rules (it rejects independent joins and caps nested expansion). A cluster run only counts fan-out inside the cluster, since that's all the engine receives.
- **Krea account runs are "billed to your Krea plan"**, not unpriced, and add nothing to the dollar total.
- **The confirm lives in the store**, in `executeGraph` / `executeNode` / `executeCluster`, so every Run path is covered (toolbar, selection bar, ⌘↵, palette, context menu, Inspector, Cinema, accepted proposals). It asks when the *high* estimate reaches the threshold. If the table didn't load, it never asks. Unpriced nodes don't trigger it but are named in the message.
- **Threshold** is a per-browser preference (`nebula:run:costConfirmUsd`, default $1, choices $0.50/$1/$5/$20/Never) in Settings › Interface, next to the other immediate preferences. It isn't a saved backend setting.
- **Proposals got real numbers too.** `cost.estimate` was always `null`. It's now `{currency, low, high, open, unpriced, plan, plus}` (or `null` when nothing is priced), and each node entry has `price`. The proposal bar summary adds "~$0.07", the CLI prints "— $0.07 at list prices", and the MCP docstring and `docs/MCP-SETUP.md` say so.

**Surprises worth knowing:**
- Krea's spec gave MiniMax H3 Max 6,864 price points. Storing all points bloated the pinned catalog to 2.1 MB, so pricing is stored only for models whose dimensions all map onto request fields (353 KB).
- Krea lists Veo durations 5 and 7 in pricing that its own request schema rejects. The generator drops unreachable points rather than shipping rows the validator would flag.
- Gemini 3 Pro Image renders a 512 request at 1K (`allowed_sizes` in `handlers/google_gemini.py`), so the 512 row carries the 1K price.
- Refreshing the Krea spec changed one random seed default in `node_definitions.json` (Krea's spec ships a random example seed). `MODEL_REFERENCE.md` was regenerated for it. Pinning seed defaults in the sync script would stop that churn. Left as a follow-up.
- Lifecycle findings while checking Google's pages: Imagen 4 models shut down 2026-08-17 (our `imagen-4-generate` node calls them); Veo 3.0/3.0 Fast/2.0 shut down 2026-06-30; the Veo 3.1 previews and `gemini-omni-flash-preview` shut down 2026-10-22 (replacement `gemini-omni-1.1-flash`). These are fixed in the entry above.

**Keeping prices current:** curated entries need a fresh source and `checked` date when a vendor changes prices. Run `python scripts/sync-krea-catalog.py --refresh` for Krea. `backend/tests/test_model_pricing.py` fails if any entry stops validating against the node catalog.

## 2026-10-10 — Eight more UX fixes: one bar, shortcuts, renaming, live run status

Justin approved eight from a second UX pass. Seven are done; #5 (cost estimate) is blocked on a pricing source (see below). Not committed yet.

1. **One bar for one node.**
   - With one node selected, the per-node pill ("Add next step / …") no longer floats above it. Its actions (Next step, Edit video, Settings) render inside the selection toolbar.
   - They're portaled, not moved: "Add next step" reads node-local batch-preview state (`displayedOutputs`), so the node keeps the logic. `src/lib/selectionActionSlot.ts` is a tiny store: the toolbar registers a `<span data-node-id>` slot, and the node with that id portals into it.
   - The slot is keyed by node id so a new selection gets a fresh slot. With several nodes selected there is no slot and nodes render nothing extra.
   - `data-node-inspector-anchor` moved to the card, since the pill that used to carry it is gone in this mode.
2. **The Nodes panel doesn't jump.** The top clamp that kept the home menu beside the + now applies to the browse view too, so picking a type grows the panel downward from the same top.
3. **Shortcuts work wherever the canvas owns focus.**
   - The canvas key handler moved from the wrapper's `onKeyDown` to `document`, scoped by `isCanvasShortcutTarget` (`src/lib/canvasShortcutScope.ts`): the body, the canvas, the bottom bar, the rail and the header count; inputs, editables, dialogs and side panels don't.
   - Ctrl+S/O were removed from the canvas handler; `GraphFileActions` already owns them globally.
   - Copy defers to the browser when there's a text selection.
4. **Image inputs fan out.** Several input handles on a text or image surface used to stack at 50%. Each row gets `--port-index` / `--port-count` and sits `--sr-node-surface-port-gap` (28px) apart around the middle.
5. **Cost estimate: blocked, not built.** (Now built from a curated price table; see the next section up.) There's no price data we can trust. Node definitions carry none, and the only prices in the app are OpenRouter/Nous per-token rates and Quiver credits. Most nodes (OpenAI images, fal, Runway, Kling…) have none, and real cost depends on params (quality, size, duration). Inventing a table would show wrong numbers with confidence. Options are in the report to Justin; the "N paid" chip stays as it is.
6. **`?` opens a shortcut sheet.**
   - `src/lib/keyboardShortcuts.ts` is the one list (also used for tooltips via `displayKey`, so ⌘ vs Ctrl is right per platform).
   - `KeyboardShortcuts.tsx` is a modal: Esc or `?` closes, focus returns where it was. It's also in ⌘K as "Keyboard shortcuts".
   - ⌘K's old "Creator Studio" command is retitled "Open Creator Studio" so the two read differently.
7. **Rename in place.**
   - Node titles: double-click, or F2 with one node selected. Enter or clicking away saves, Esc cancels. Blank or the model's own name goes back to the default. The model name stays in the tooltip once renamed.
   - Names live in the backend graph (`CLIGraph.set_label`, `PUT /api/graph/node/{id}/label`), because graphSync overwrites `data.label` from the backend export. A frontend-only rename would revert on the next sync. They're carried through project snapshots and graph-file import too.
   - Rules match on both sides: collapse whitespace, cap at 80 characters (`MAX_NODE_LABEL_LENGTH`).
   - The route sits outside the paid-mutation fence like layout, since names don't affect execution. It journals `node.renamed` (`from`, `to`) for `nebula watch`; renaming to the same name journals nothing.
   - The frontend renames optimistically and rolls back if the PUT fails and nobody renamed it again meanwhile. Local-only nodes (non-`n#` ids) stay frontend-only.
   - Renames aren't undoable yet: undo snapshots only cover params and structure. That's a reasonable follow-up.
   - Project name: double-click it in the header (or Enter/F2 on it) for the same inline field; it calls the existing `projectStore.rename`.
8. **The node says what it's waiting on.**
   - Running nodes show "OpenAI · 6s", then "· 42%" once the provider reports progress, and "Queued" while waiting. Before, they showed "0%" from the moment they started, because the store sets `progress: 0` on start.
   - `runRouteProvider` mirrors the backend's dual-route rule (Ideogram, Meshy, Veo): the model's own key wins when set, else the FAL route. Local tools show no provider.
   - The store stamps `runStartedAt` when a node starts executing; a node that mounts mid-run counts from mount. Undo snapshots clear it with the other run state.

Verification:
- Backend: `tests/test_node_rename.py` (store/broadcast/clear, journal, 404/400, length cap, import) and the full suite, 4134 passed.
- Frontend: new tests for shortcut scope, the shortcut sheet, `renameNode`, `NodeLabel`, project rename and `NodeRunStatus`. The full suite passes (2052), as do tsc and lint.
- Live at 1280×820:
  - The one-node toolbar carries Next step and Settings with no pill.
  - ⇧1 and ⌘− work with focus on the bottom bar.
  - A rename stored `label` on the backend and survived a reload and a project switch; F2 and project-name editing work. The test name was cleared afterward.
  - Faked run states (store only, no provider call) showed "OpenAI · 17s" ticking and "Queued".

## 2026-10-10 — Ten UX fixes: run scope, node chrome, quieter chrome

Justin approved all ten from a UX pass. Not committed yet.

1. **Run says what it will do.**
   - `src/lib/runScope.ts` mirrors the stores' scopes:
     - graph: everything;
     - one node: the node plus every node feeding it (what `executeNode` runs);
     - several nodes: exactly those (what `executeCluster` runs).
   - "Paid" means the definition's `apiProvider` is anything but `utility`.
   - Both Run buttons show an "N paid" chip when it's above 0. The tooltip and an `aria-describedby` line read "Runs 2 nodes · 1 calls a paid provider: GPT Image 2.5".
   - **No "Run selected" on the bottom bar.** The selection toolbar already has Run with the right scope, so a second one would duplicate it. The bar's Run is titled "Run graph." and the selection's "Run selected nodes.", so the two read differently.
   - The selection Run now has `aria-label="Run selected nodes"`. Its title used to be its only name. Tests query by role now.
   - On the orange selection button the chip inherits the button's ink. Grey was unreadable there.
2. **No raw category slugs.**
   - The floating `image-gen` / `utility` label above each card is deleted, not hidden. It only ever rendered in this theme.
   - The header now leads with `NodeTypeIcon`: the Nodes panel's own icon and words, labelled "Image node". The panel and the nodes share `nodeBrowseType` (now exported) and `NODE_BROWSE_ICONS` (`src/lib/nodeBrowseIcons.ts`).
   - Other skins keep their category dot.
3. **One node chrome.**
   - Text and image surfaces share one title: 13px/500, light ink. The text node was 15px/600 white, the image node 13px/500 grey.
   - The empty bordered square on image headers is gone. Its "glyph" var was `none`, so it read as a checkbox. Its four unused `--sr-node-image-icon-*` vars are gone too.
   - The id chip and header actions show on hover, focus or selection on every node, not just image surfaces. Revealed actions keep their 0.62 resting dim, and hovering the action itself lights it.
4. **One way into Creator Studio.**
   - The rail's sparkle button is gone. The header's "Creator Studio" tab stays.
   - Onboarding's "create" step now targets that tab (`data-onboarding-target="create"`). Only one `WorkspaceModeNavigation` renders at a time, so the selector stays unique.
5. **"Saved" settles.**
   - CSS only: when the status is `saved` it holds, fades, then folds its width and flex gap away (2.6s).
   - Saving, unsaved and failed states stay put.
   - It stays in the DOM, so the `role="status"` region still announces it.
   - Reduced motion steps instead of fading.
6. **Zoom shortcuts** on the canvas, same handler as ⌘Z:
   - ⌘/Ctrl = and − zoom (`preventDefault`, so the page doesn't zoom).
   - ⇧1 fits, ⇧0 goes to 100%. These match `event.code`, because Shift turns 1 and 0 into ! and ).
   - The bar's tooltips show the keys, with `aria-keyshortcuts`.
   - Durations live in `canvasFit.ts` (`CANVAS_ZOOM_DURATION` 200, `CANVAS_FIT_DURATION` 300), shared by the bar and the keys.
   - The typing guard now also skips contenteditable.
7. **Wordmark removed.** Gone: `NEBULA(NODES)` above the bar and its narrow-width override. DESIGN.md open question 4 is marked resolved.
8. **The Nodes menu opens beside the +.**
   - The content-sized home menu's top lines up with the open rail's top edge, clamped so it stays on screen.
   - `NodeLibrary` publishes the menu's height (`--node-library-home-height`, via ResizeObserver) for that clamp.
   - The drawer's `transform-origin` now subtracts `--workspace-dock-panel-top`, so it still grows out of the +.
   - Browsing models still uses the full-height dock, so the panel moves up when you pick a type. That's accepted: the content swaps entirely anyway.
   - **Found while doing it:** the origin was only measured when a drawer opened, so resizing the window left it stale. It now re-measures on `resize`.
9. **Smaller bloom.** Rest scale is 0.85 instead of 0.7, so buttons rest at 34px. Measured: the + moves 19px vertically and 4px sideways, about half of before.
10. **Port names on hover.**
    - Text-input and image-surface handles had no labels.
    - The name now appears as a small pill outside the node, on the handle's side, while you hover the handle or drag a wire from or onto it. That uses `:has()` with React Flow's `connectingfrom` / `connectingto` classes.

- **Checked live at 1280×820, 1280×760 and 1280×680:**
  - the paid chip and wording on both Run buttons;
  - header icons ("Text node", "Image node");
  - hover reveals `n1`, Enhance and download;
  - the "Prompt" chip on hover;
  - "Saved" at opacity 0 after settling;
  - no wordmark (`::before` content `none`);
  - menu top equal to shell top (258px) with an 8px gap, an origin of 27px (the + center), clamped to 126px at 680px tall and 206px at 760px;
  - the + travels 19px.
- **Not checked live:** a real ⌘= press in the pane (unit-tested on the canvas handler instead), and the "Saving…" state mid-save.
- **Tests:** 2,032 pass. New tests:
  - `tests/lib/runScope.test.ts`;
  - zoom shortcuts, plus a typing guard, in `Canvas.continuity.test.tsx`;
  - Create-tab onboarding in `WorkspaceRail.test.tsx`.
  The Toolbar `canvasFit` mock gained the duration constants.

## 2026-10-10 — Zoom in the bottom bar, and one radius system

- **Zoom moved into the bottom bar:** `[Run | Canvas actions | − 100% + ⛶]`.
  - The floating zoom pill was 32px tall, the bar 48px and the chat button 42px, and none of them lined up.
  - The percentage is new: the canvas never showed its zoom before. Clicking it resets to 100%.
  - Steps and reset use 200ms animations; Fit uses 300ms (same as the import fit) and the same chrome-aware padding as before.
  - − and + disable at the canvas limits (0.1 and 4).
  - Kept it a plain reset rather than a Fit/100%/50% menu. A menu adds a popover and keyboard handling for little gain, since Fit has its own button.
- **What moved where:**
  - The node count went to the header ("Saved · 2 nodes", mono, meta ink). It hides under 650px along with the save status.
  - `CanvasNavigation` now renders only the optional minimap (still bottom-right). The minimap's corners went from 8 to 14.
  - The chat button is centered on the bar's line: it was 11px low.
- **Phones (≤520px) drop the zoom group.** The longer bar ran 9px under the chat button. Pinch zooms, and Fit view is still in the command palette (rail Search).
- **Radius system: three tiers.**
  - 8 for controls.
  - 14 for anything that floats (bars, panels, drawers, menus, every node card).
  - Pills only for tiny icon chips.
  - Done by raising `--sr-radius-panel` from 12 to 14, which text nodes, drawers and menus already used. The base node card and header moved from `--sr-radius-node` (8) to the panel token, so other node types match image nodes. `--sr-radius-node` stays 8 because buttons use it too.
  - The header home button went 14 → 8: it was a near-circle bulging inside the 14px header.
- **Chat button: a rounded square, follow-up the same day.** Justin asked for it. It's now 48×48 with a 14px corner, exactly the bar's height and baseline (both 712–760px live). Its dotted press layer sits 4px in at 10px. It needs `.panel-launcher.panel-launcher--chat` specificity, because the base launcher rules come later in the file. On a 375px phone it sits 7px from the bar and shares its top and bottom edges.
- **Gone:** React Flow's `<Controls>` and its unthemed `#eee` button borders (the bright dividers).
- **Checked live:**
  - zoom in → 116%, the percentage resets to 100%, Fit fits;
  - bar and chat centers both at 736px; drawer, text node, image node and header all 14px;
  - 375px: bar ends 13px before the chat button, centers aligned.
  - Not checked visually: node types other than text and image (none in the open project). They now use the 14px card by token.
- **Tests:**
  - `Toolbar.test.tsx` has zoom tests: steps, the percentage reset, Fit, and the limits.
  - The old assertion that Fit is *not* on the bar now asserts it is.
  - `CanvasNavigation.test.tsx` is reduced to the minimap.
  - `NodeLibrary` "keeps explicit all-model browsing" failed once under full-suite load and passed 3/3 alone. Flaky, and unrelated.

## 2026-10-10 — Floating rail and attached drawers

Supersedes the 2026-10-09 "Flush-left toolbar" placement and the rail part of "Match toolbar and node radii".

- **What Justin asked for:** a small gap between the page edge and the rail, and on hover a radial bloom out to the right. Two rejected versions on the way there:
  - left edge pinned, only the width growing, which read as stretching right;
  - growing from the center, which moved the left edge away from the page edge.
- **How it blooms.** The shell is laid out at its open size and rests at `scale(0.7)` from the middle of its left edge. On hover, focus or an open drawer, it scales to 1. The left edge stays 8px off the page while the rail grows up, down and to the right.
  - Open: 40px buttons, a 6px inset plus the 1px border, 15px shell radius.
  - At rest it's exactly that at 0.7: 36px wide with 28px buttons.
- **Concentric on every frame.** The white + looked wrong because its 28px button sat 4px from the shell's sides but 11px from its top, and the radii didn't nest. A uniform scale keeps inset and radius in proportion all through the animation. The shell radius is button radius + inset + border.
- **Stable measurements.** The `nav` is the open rail's footprint, never scaled. Canvas fit and pinned inspectors measure a box that doesn't change with hover. The nav takes no pointer events; the shell does, so the hover zone is exactly what's visible. The old `::before` shell, group `translate` and per-button size transitions are gone.
- **Known trade-off.** Buttons far from the vertical center travel when the rail blooms: the + moves up about 40px. You aim after it opens, but a fast click at the resting spot can miss. Ask Justin if it bothers him in use; a smaller bloom (resting scale nearer 1) shrinks the travel. *(Done the same day: rest scale is now 0.85, see "Ten UX fixes".)*
- **Drawer attached to the rail:**
  - The rail stays open while a drawer it opened is showing (`.workspace-rail--open`).
  - The drawer sits 8px from the open shell.
  - The drawer springs sideways out of the button that opened it. `WorkspaceRail` publishes that button's center as `--workspace-dock-origin-y`, measured from layout (`offsetTop`), so a shell still scaling open can't skew it. The drawer mounts a microtask later, so the value is already set.
- **Found while doing it:** the drawer's `transform-origin: left center` had never applied. The theme's generic `.panel` rule has the same specificity and loads later, so drawers grew from their own center. The origin now lives in a theme-scoped rule.
- **Also fixed:**
  - Under the theme, hovering the white + turned it dark, because the generic item hover outranked the primary style.
  - The active button's tooltip is hidden. It used to cover the attached drawer, and the drawer's title already names it.
- **Short windows, touch and phones** never scale; they always show the open rail.
  - Touch uses 44px buttons.
  - Phones use a 4px inset and a 6px gutter.
  - Short windows scroll inside the shell.
- **Motion:**
  - Rail: spring (k 500, c 36: about 1% overshoot, 320ms).
  - Drawer: enters on the toast's spring (420ms) and exits in 220ms, inside the 500ms unmount delay.
  - Reduced motion: no scaling transition, no drawer entrance, and a 120ms fade on exit.
- **Checked live:**
  - rest: 36px wide with 28px buttons, 8px off the edge;
  - open: 54×348 from 36×244, left edge still at 8px;
  - insets of 7px on both axes, 15px radius;
  - drawer 8px from the shell, origin `0px 229px` (+ center minus 16px);
  - 375px touch: 44px buttons, 6px gutter, drawer at 66px.
  Test in `tests/WorkspaceRail.test.tsx`.

## 2026-10-10 — Recently deleted (trash + undo)

- **Both, as one mechanism.** Undo is just "restore the thing you trashed a moment ago", so the toast and the trash share `POST /api/projects/{id}/restore`.
- **Trash inside `catalog.json`**, not a separate file. Moving a project between `projects` and `trash` is then one atomic commit, with no window where it's in both places or neither. Cost: trashed projects count toward the 128 MiB catalog cap.
- **30-day lazy expiry.** Swept on list and before restore, with no background timer. An entry past 30 days that hasn't been swept yet still can't be restored.
- **Dropped the confirm on delete.** It's reversible now, so a confirm would be friction. Confirms remain on Delete forever and Empty.
- **Restore brings it back closed**, even if it was open when deleted. Reopening it is one click and avoids replacing whatever is open now.
- **Trash routes skip the workspace revision.** They never touch the live canvas, and a stale view just gets a 404 for something already gone.
- **First real spring easing in the app.** The toast uses a CSS `linear()` curve computed from a damped spring (k 380, c 30, m 1: about 2% overshoot, 420 ms). The motion tokens were all cubic-beziers until now.
- Live check: delete, toast timeout, restore from the section, Undo from the toast, and two-step Delete forever (gone from `catalog.json`). Ended with Sticker maker open again.
- Small catch: the section heading's accessible name read "Recently deleted1". The count is now `aria-hidden`, with screen-reader text ", 1 project".

## 2026-10-10 — Delete project

- **No delete existed.** The scratch project had to be removed from the catalog by hand (via the store's locked commit), which prompted this.
- **Revision required.** `DELETE /api/projects/{id}` refuses a missing or stale `workspaceRevision`, unlike rename. Destructive, so a stale tab shouldn't be able to do it.
- **Deleting the open project is allowed**, not refused. It's the common case (you just finished with it). It reuses `_paid_graph_mutation` and `_project_replacement_guard` (now takes an action name for the message), empties the live graph and clears the active project. The fences only apply when it's the open one; tidying other projects works mid-run.
- **No outgoing save.** The browser cancels the autosave timer and waits for an in-flight save rather than flushing, so it never writes a project that's about to vanish (a late PUT would 404 and show an error).
- **Recovery fallback.** `/api/projects/recover` used to 404 when its source was gone, which would have stuck a stale tab in a retry loop now that projects can disappear. It falls back to an empty source named "Deleted project".
- **Not done (at the time):** no undo or trash bin (added later the same day, above), and other open windows' Home lists aren't pushed the deletion (opening a deleted card there shows "Project not found"). Media files are kept on purpose.
- Live check: deleted an open throwaway (canvas emptied, no project active, list re-read cleanly) and an inactive one while Sticker maker stayed open with its 2 nodes.

## 2026-10-10 — Agent collaboration: watch, pins, proposals

### Watch (`nebula watch`, `GET /api/canvas/events`)

- **One journal, tagged by project, not reset.** `services/canvas_events.py` keeps a 500-event ring buffer with a process-wide monotonic `seq`. A project switch or import journals `canvas.replaced` (with `reason` and the new `projectId`) instead of wiping the buffer, so a watcher learns that node ids restarted rather than silently seeing ids that now mean other nodes. Every event carries `projectId`. A restart mints a new `journal_id`; a client that sends the old one gets `reset: true`.
- **Moves come from `PUT /api/graph/layout`, not from diffing view reports.** The browser persists positions there when a drag ends, on auto-layout and on paste, so it is the authoritative signal and carries the request's actor. View reports are throttled telemetry and also change during agent-driven animation. Nodes that moved less than 8 px are ignored, and a node with no previous position counts as placed, not moved.
- **Three actors, not two.** `person` needs an allowed browser `Origin`; an identified agent is `agent`; everything else (a CLI without `NEBULA_AGENT_NAME`, curl) is `anonymous`, shown as "Unnamed client". Otherwise an unnamed script's edit would be reported to other agents as the person's.
- **Cursor semantics.** `cursor` is the last seq scanned, including events filtered out for the caller (its own edits, other kinds), so self-filtered events never cause a busy loop. `gap` means the buffer overwrote unread events. `look`'s snapshot returns `events.cursor`, so `look` then `watch --since` has no gap.
- **Runs.** `_emit_and_sync` journals `run.started/finished/failed` after the cancelling early-return; `/api/graph/run`'s private `collect_events` journals too, because it never forwards node events. `run.cancelled` is journaled where `GraphCancelledEvent` is broadcast (`_finalize_cancelled_execution`), since cancelled runs never reach the per-node path. The actor is whoever started the run (`note_run` in `/api/execute`, `/api/execute-node`, `/api/graph/run` and the Cinema shot route). Batch variants repeat node events, so `(run, node, kind)` is deduped until the run's terminal callback.
- **Deviations from the spec.** (1) Each long-poll owns its own `asyncio.Event` instead of one shared signal: an Event binds to the loop that first awaits it, and a shared one breaks when waiters run on different loops (TestClient, or a later worker). `publish` wakes each waiter through its own loop. (2) `summary` is actor-free ("moved n3, n4"); `format_event` adds the actor label, so the line reads `[57] 14:03:08  Person  moved n3, n4` without saying the name twice. (3) `param_changes` skips underscore keys (editor bookkeeping like `_paperSource`). (4) The generic 160-character string cap also applies to run errors, so they are 160, not 200. (5) The import route still calls `_broadcast_graph_sync(graph_replaced=True)` without `reason` (it defaults to `"import"`) because an existing test asserts that exact call.
- **Bounds.** 500 events, 4 KB per event payload (values dropped first, then everything but keys), 160 chars per string, 25 s per wait, 100 per batch, 32 concurrent waiters (HTTP 429 beyond). In memory only, like presence.
- **CLI exit codes.** `watch --once` exits 0 with events, 2 on timeout (600 s default), 130 on Ctrl-C. `nebula` now exits with a handler's integer return value, which watch uses.

### Pins (`nebula pin resolve`, `/api/canvas/pins`)

- **Pins live on the project record, beside `snapshot`.** `catalog["projects"][id]["pins"]` is backend-owned. Autosave (`PUT /api/projects/{id}`) replaces only `snapshot`, so it can never drop a pin, and opening another project brings that project's pins. Every write is one `ProjectStore.transaction()` (the same flock as autosave), and nothing commits when the list didn't change. `CanvasPins` takes a store getter (`lambda: project_store`) so tests that swap `main.project_store` also redirect pins; its read cache is dropped on every write and on any graph replacement.
- **Detach, don't delete.** Deleting a pinned node keeps the pin at the node's last position (`detached: true`, `detachedFrom`), because the note is the person's words and may still matter ("this one was wrong"). An import detaches pins whose node ids are gone; Clear canvas detaches all node pins. Project open/create need nothing: those pins belong to the other project.
- **Person gate (`services/person_gate.py`).** Create and delete refuse any agent marker, even an invalid token, then require a browser `Origin` that passes `origin_allowed`, or in desktop mode a matching `X-Nebula-Connector-Session`. `apiFetch` now sends that header for `/api/canvas/pins` and `/api/canvas/proposals` on the injected desktop backend, as it already did for `/api/krea/`. An unknown `Authorization: Agent` token is already stopped earlier with 401 by the agent-token middleware; either way it never counts as the person. Remaining risk (same as proposals): a same-user local program that forges `Origin` passes. (In-app agents no longer inherit the desktop session; see "Review fixes" below.) This stops confused or prompt-injected agents using their normal tools, not a malicious program.
- **Browser sockets.** `ConnectionManager` records `is_browser` per `/ws` socket (allowed non-null `Origin`, or desktop mode plus the `connectorSession` query) and gains `broadcast_browser`. Pins use `broadcast_raw` (agents may read pins), proposals will use the browser-only path. `backendWebSocketUrl` appends `?connectorSession=` only for `/ws` on the injected desktop endpoint; `/ws/chat` is unchanged.
- **Resolve moves the cursor.** The reply becomes the cursor's `say` (trimmed to 140 by presence) with a `click`, aimed at the node if it is still drawn, else at the pin's spot.
- **`canvasPins` follows `graphSync`.** Sent to each socket right after the initial `graphSync`, broadcast on every pin change and after every graph replacement. Two existing tests asserted the exact message sequence (`test_cli_api` WS test, `test_graph_cluster` import broadcast) and now expect the extra `canvasPins` message.
- **Frontend.** Badges render in a `ViewportPortal`, positioned and counter-scaled through a ref like agent cursors (no inline static styles), top-right of the card and stepping 22 px left per extra pin; pins whose node isn't drawn are skipped until it is. A new pin or a new reply pops 0.6→1 on the cursor spring (only if it is under 8 s old, so a reload doesn't pop everything); reduced motion snaps. The store sanitises incoming pins (unsafe agent colours fall back to the default) and hides optimistically deleted pins even if a stale `canvasPins` still lists them. Only backend ids (`n12`) can carry pins: the node menu item is disabled for UUID nodes the backend hasn't seen. The pane context menu now exists, with a single item.
- **Live check (worktree backend on :8011 with a scratch `NEBULA_STATE_DIR`, Vite on :5181).** Right-click node → note → badge on the card; `nebula look` listed it under PINS; `nebula pin resolve … --as "Claude Code"` turned the badge green, showed the reply in the card and moved the cursor there; Delete in the card removed it; forged CLI creates got 403; a canvas-spot note survived a full reload. The journal showed `pin.added` (person), `pin.resolved` (Claude Code), `pin.removed` (person). Found while checking: the spec's `y + 30` put the badge 8 px above the card, because the node box starts at the category label; it now sits at `y + 38`, on the card's corner.
- **Deviations from the spec.** (1) Pin text also drops Unicode format characters (bidi overrides, zero-width joiners), so the note can't render differently from what agents read. (2) `pin.detached` events carry the reason. (3) The MCP instructions gained only the pins sentence; the proposals builder adds the proposals part. (4) Badge y offset 38, not 30 (above). (5) `nebula pins` also lists resolved pins after the open ones, and the CLI checks the 280-character reply cap before sending.

### Proposals (`nebula propose`, `/api/canvas/proposals`)

- **Staged on a clone, committed the way direct edits are.** `_stage_proposal` runs the proposal through the same `_stage_graph_nodes` / `_stage_graph_edges` / `_validate_params` / `_coerce_params` path as cluster and param edits, on `cli_graph.clone()`. Proposing stages once and throws the clone away, so an invalid proposal is refused before the person ever sees it. Accepting stages again against the current canvas with the dragged positions and commits through `_commit_graph_candidate_with_recoveries` inside `_paid_graph_mutation`. That makes accept all-or-nothing: if anything no longer fits, nothing changes, the proposal closes as invalidated and the response is 409. `_stage_proposal` also returns the run ids mapped to real node ids, which the spec didn't list.
- **The backend never executes on accept.** The accept response returns `runNodeIds`; the browser runs them through `executeNode` (one target) or `executeCluster(withAncestors(...))` (several). Deviation: the spec said `executeCluster(ids)`, but executeCluster runs only the nodes it is given, so upstream inputs that hadn't run would be skipped. Adding the local ancestors matches what Run on a single node does. If a run is already going, the canvas adds the nodes and shows a "Run them when the current run finishes" notice instead of queueing anything paid by itself.
- **No prices, ever.** `summarize_cost` returns `paidRuns`, `freeRuns`, `providers`, `upTo` and `estimate: None`. Paid/free comes from the node definitions; the run set is the targets plus the ancestors from `execution.engine.get_subgraph` that have no outputs yet, and `upTo` is set when any such ancestor is counted (the execution cache may still skip it). The bar says "No price list in Nebula" next to paid counts.
- **Who can accept.** `require_person` (no agent marker; browser Origin or desktop session), plus a per-proposal accept key (`secrets.token_urlsafe(24)`, compared with `compare_digest`) sent only through `broadcast_browser` / the browser socket's `proposalSync`. `Proposal.accept_key` has `repr=False` and `view()` never includes it, so it can't leak through REST, the snapshot, the journal, the CLI or MCP. Remaining risk, documented in MCP-SETUP: a same-user process can forge `Origin` on the `/ws` handshake, and one that can read the backend's environment can find the desktop session. (In-app agents inheriting `NEBULA_CONNECTOR_SESSION` was closed in review; see below.)
- **The person proposing.** A browser caller gets 403 "The person doesn't need to propose; edit directly". In practice it can't be reached, because proposing needs an agent identity and any identity implies an agent marker, which already fails the browser check. It's kept as a guard in case identities change.
- **Memory only, with a `system` actor.** Proposals live in a `ProposalBook` and are lost on restart, like cursors and the journal. Closed ones stay readable for 30 minutes (50 at most), so `nebula proposal <id>` still answers after a decision. Expiry is swept lazily (before every proposal read, the events route and the snapshot) and journaled as actor kind `system`, labelled "Nebula", so an expiry isn't reported as the person's or an agent's action.
- **Invalidation.** Deleting a node a proposal refers to invalidates that proposal. `clear_graph` and any graph replacement (`_broadcast_graph_sync(graph_replaced=True)`: import, project open/create) invalidate all of them, because node ids restart.
- **Refused targets.** Param proposals on a cinema-scene node's `scene` param, and on World Labs nodes with durable recovery state, are refused. Those params go through dedicated recovery-aware routes, and replaying them generically on accept could orphan a recovery.
- **Placement.** Without `position`, new nodes go right of the rightmost referenced node, or the centre of the person's visible area from the presence snapshot. Each one then steps right past any node or earlier ghost it would overlap (ghost box 240×200, 60 gap). The first live check put ghosts on top of the person's nodes, which is why the step exists.
- **Request bodies.** Accept and reject read a raw `Request` body, not a Pydantic model, so an empty body is valid and malformed positions return 422 with a clear message.
- **Frontend.** Ghosts stay out of `graphStore` (in `canvasProposalsStore`), so they never reach autosave, undo, the minimap or execution. Accept adopts the backend's nodes and edges with one `pushUndo`. `ProposalLayer` renders in a `ViewportPortal` with transforms set through refs (like cursors and pins), the stepSpring entry scale (0.92→1, snapped under reduced motion), and dashed SVG wires that follow dragged ghosts. `ProposalBar` sits in a bottom-centre `Panel` 78 px up so it clears the Run / Canvas actions toolbar (also found in the live check). There is deliberately no keyboard shortcut for Accept.
- **Countdown bug.** The bar stays mounted while empty, so `useNow`'s initial `Date.now()` dated from page load and the first countdown read "15:05". It now schedules a `setTimeout(0)` catch-up tick when a proposal arrives. A synchronous `setState` in the effect trips `react-hooks/set-state-in-effect`.
- **Live check (worktree backend on :8011 with a scratch `NEBULA_STATE_DIR`, Vite on :5181, free utility nodes only).** `nebula propose ... --wait` → ghosts and wires in Codex's colour; Show framed them; dragging moved them; forged curl accepts (no key, wrong key, no Origin) got 403; the list response had no key. Accept & run committed at the dragged position and ran the free nodes from the browser; the CLI printed the id map and exited 0; the journal attributed every step to Person.

### Review fixes

- **In-app agents could pass as the person (desktop).** `agent_child_env()` stripped the connector vault key but not `NEBULA_CONNECTOR_SESSION`, so an in-app Claude/Codex/Hermes with a shell could open `/ws?connectorSession=...`, receive accept keys and accept its own proposal, or write pins as the person. Added it to `CONNECTOR_SECRET_ENV_KEYS`; the backend reads it from its own environment, so children never needed it. Test: `test_child_environment_drops_the_desktop_canvas_session`. Person-gate docstring and MCP-SETUP remaining-risk text updated.
- **Accept/reject race.** Accept checked `is_open`, then awaited the request body, then committed and closed. A withdraw, expiry sweep or second tab's accept in that await meant the graph was committed and `close()` raised, giving a 500 with no `graphSync` (or a double commit from two tabs). Now `_ensure_still_decidable` re-checks open + active project after the body read, and nothing awaits from there to `close()`, so asyncio can't interleave another decision. `close()` after commit is also wrapped so a committed graph is always synced. Reject got the same re-check. Chose the re-check over a per-proposal lock because the whole stage → commit → close stretch is already synchronous; a lock would only guard the body read. Test: `test_decision_rechecks_after_reading_the_body` (accept and reject).
- **The person approved values they couldn't see.** The bar listed only param key names, and ghosts showed 3 values cut to 36 characters from the agent-facing view (500-character cap, URL queries stripped). Added `ProposalBook.person_values()` / `person_value()`: the values Accept will write, full text up to 4,000 characters with an explicit "N more characters not shown" marker, URLs whole, data URIs described by size, secret-looking keys shown only as "set". It travels only in the browser-only `proposalOpened` / `proposalSync` messages (`personValues`), never in REST/MCP/CLI. The bar gained "See what Accept writes" (every new node's params, and `from → to` for changes); ring tags show `key: from → to`; ghost cards say "+N more settings" or "Values shortened" when they show less than Accept writes.
- **Accept could overwrite a newer edit.** If a param the proposal sets changed after proposing (the person edited it), accept now fails 409 and invalidates the proposal (`_refuse_overwriting_later_edits`), rather than silently writing the agent's value over theirs. Didn't recompute cost at accept: cost depends only on definitions and the spec's run set, which can't change after proposing; the graph-dependent part (ancestors without outputs) is reported as "up to".
- **New proposal could swap in under the Accept button.** The bar tracked the shown proposal by index over a newest-first list, so a second agent proposing moved the person's click to the new one. Now it tracks the proposal id, sorts oldest first (new ones join the end of the pager), and ignores Accept/Reject for 600 ms after the shown proposal changes on its own (the one being read closed). Used a ref timestamp checked in the click handler rather than a disabled state, to avoid a setState-in-effect. Tests in `ProposalBar.test.tsx`.
- **Examples used a node that doesn't exist.** `topaz-upscale` / `scale` → `topaz-image-upscale` / `upscale_factor`, and `--set n4.prompt` → `--set n4.aspect_ratio=16:9` (on Nano Banana, prompt is an input port, not a param). Fixed in CLI help, BuildError text and MCP-SETUP. `test_documented_examples_are_real_proposals` posts the MCP-SETUP JSON block and the equivalent builder body against the real node definitions.
- **Blocking commands vs. shell time limits.** The in-app primer now says `nebula watch --once --timeout 100` and `nebula propose ... --wait --timeout 100`, and to re-run on exit 2; Claude Code's Bash tool stops commands at 120 s by default. The proposal timeout message now repeats `--timeout`. Codex's shell limit wasn't checked.
- **MCP vs CLI identity.** Without `NEBULA_AGENT_NAME`, the MCP server names itself from the client while the CLI sends no name, so the agent's own CLI edits woke `wait_for_canvas_change` as `anonymous`. Didn't exclude anonymous actors server-side (that would also hide a genuinely different unnamed client); instead the docstring, server instructions and MCP-SETUP say to set the variable, and the tool adds a `note` when anonymous changes arrive and the name isn't set.
- **Tests for pin entry points.** `SelectionToolbar.test.tsx` (Note shown for one backend node, hidden for multi-select and unsaved UUID nodes, click opens the composer) and `PinComposer.test.tsx` (maxLength 280, trimmed submit to the composed target, empty/Cancel never calls the backend, refused create shows a dismissable alert).

### Live browser check (after the workflow)

- **The person's first drag of an agent-made node was invisible to agents.** `nebula create` stores no position; the canvas draws such nodes at an auto-layout spot computed during export. The layout route compared the drop against the stored position, found none, and treated the node as "placed", so the exact demo flow (agent adds a node, person drags it) never produced `node.moved`. The tests missed it because they always created nodes with explicit positions. Fix: the export's layout math is now `_display_positions()`, and the layout route measures moves from where the canvas actually drew the node. Regression test `test_first_drag_of_an_agent_created_node_is_a_move` fails without the fix.
- **Pin cards ran off the right edge.** The card always opened to the right; near the canvas edge the note and reply were cut off. It now measures on open and flips left when there is less than 250 px of room (`data-side` on the pin, CSS in `canvasPins.css`).
- Verified live: `nebula watch --once` woke on the person selecting, moving and deselecting; a note made from the selection toolbar reached a waiting agent and `nebula look`, and `nebula pin resolve` turned the badge the agent's colour with its cursor narrating; a proposal showed ghost node, dashed wire, value ring and the "what Accept writes" list, the ghost was dragged, and Accept created the node where it was dropped without running anything. Five attempts to accept from outside the page (agent header, forged Origin, no headers, both) all returned 403.

## 2026-10-10 — Agent cursors and the canvas snapshot

- Goal: let the person watch agents work on the canvas in real time, and let agents read the canvas without screenshots. Three pieces: a backend presence service (`services/agent_presence.py`), a browser cursor layer, and a browser-to-backend view report.
- **Who gets a cursor.** Identity comes only from request headers: a verified `Authorization: Agent <token>` (in-app Claude/Codex, named by runner), `X-Daedalus-Caller` (Daedalus), or a self-reported `X-Nebula-Agent` name (outside agents; the CLI sends `$NEBULA_AGENT_NAME`). The browser's own requests carry none of these, so a person's clicks never spawn a cursor. Self-reported names are cleaned to 32 safe characters and rendered as text; colours come from a fixed palette, never from the request.
- **Graph routes keep their signatures.** Tests call `create_graph_node(body)` and others directly, so instead of adding a `Request` parameter a small ASGI middleware (`RequestHeadersContext`) puts the headers in a context variable, the same pattern `AgentWorkspaceContext` uses. `_show_agent()` is called after create, connect, node-and-connect, set params, delete node, delete edge, and before a targeted run. It never fails the route.
- **Events.** One new `/ws` message, `agentPresence`, separate from `graphSync`, so cursor traffic never touches graph merging. It arrives after the graph change it describes, so the node already exists when the cursor flies to it. Cursors anchor to `{nodeId, handle?}` rather than coordinates, so they follow a node the person drags. A deleted node's cursor is re-anchored to where it last was.
- **Snapshot follows the selection surface's privacy rules.** Params go through `selection_context._safe_value` (secret-looking keys redacted, data URIs dropped, signed-URL queries stripped), and outputs report only `{type, available}`, never values, matching `nebula selection`. Agents fetch values deliberately with `nebula path` / `nebula graph`.
- **View report.** The browser posts viewport, screen size, node bounds and run states to `POST /api/canvas/view`, throttled to one report per 300 ms (a debounce would starve while a node streams progress). In memory only; `view.stale` after 30 s.
- **Motion.** No animation library is installed, so the cursor runs its own semi-implicit spring per frame and writes `transform` directly (no React re-render per frame). Tuned by measurement, not formula: stiffness 300, damping 24 gives about 6 px of overshoot on a 300 px move and rest in under 0.5 s; ζ ≈ 0.89 had looked fine on paper but overshot under 1 px, which reads as an ease-out. Wires use a slower spring (120/20). The loop sleeps at rest and wakes on React Flow store changes. Reduced motion snaps and skips the ripple.
- **Bugs found while verifying live.** (1) React Strict Mode mounts twice; an `AbortController` made in a ref initialiser stayed aborted after the first cleanup, so every view report was cancelled silently. Now created per mount. (2) React Flow's node box starts at the small category label above the card, so "18 px down" pointed above the card; the cursor now aims `min(44, height/2)` down. (3) The narration bubble wrapped every two words because its absolutely positioned parent shrinks to fit; it now has `width: max-content`.
- **Tests.** The two Canvas test files mock React Flow as a plain div, so they now stub the two new canvas children the same way they stub the toolbar and navigation.
- **Bug found while recording the demo.** `nebula clear` left cursors anchored to node ids that no longer existed, and node ids restart per graph, so after opening another project a cursor anchored at `n2` would land on an unrelated `n2`. Now clearing the canvas and any `graphReplaced` sync (project open, import) drop node anchors on both sides (`AgentPresence.forget_graph`, store `forgetGraph`); coordinate-only cursors survive.
- **Demo video.** Recorded with the dev-only `window.__nebulaCanvas` camera bridge and `__nebulaSuppressFitView` so the camera holds still, inside a two-window stage page (Claude Code panel + Nebula iframe) captured over a CDP screencast at 1920×1080. Every command in the terminal panel really ran; the panel shows trimmed real output. Only the generation wait is sped up, with an on-screen badge. A rerun with an identical prompt returns from Nebula's result cache in 0.02 s, so a retake needs a changed prompt. Scripts live beside the video in `output/demos/agent-cursors/` (gitignored).
- Not done: an edge-of-screen indicator for an agent working off-screen, and per-node highlight in the agent's colour. The snapshot reports `onScreen`, so an agent can check before pointing.
- Validation: backend 3,774 + new tests, frontend 1,970, tsc, lint. Live in the browser pane: `nebula point` glided the cursor onto a node with narration, `--from` drew the wire from n1's output to n2's prompt port, and a plain `nebula set` moved the cursor and narrated "Set quality" with the click ripple.

## 2026-10-10 — GPT Image 2.5 nodes

- Two new nodes, `gpt-image-2-5-generate` and `gpt-image-2-5-edit`, instead of adding a model choice to the GPT Image 2 nodes. Saved graphs keep their exact behaviour, and the 2.5-only params (background, xhigh/max quality) never show on a node that would send them to a model that rejects them.
- One node per operation with a `model` choice of Flare (`gpt-image-2.5-flare`, fast, default) and Sunburst (`gpt-image-2.5-sunburst`, most precise). Unpinned aliases, so the nodes follow OpenAI's updates; the `-2026-09-08` snapshots exist if a pinned run is ever needed.
- Handler: `build_25_body` wraps the GPT Image 2 body builder and adds model, the larger quality set and `background`. The generate/edit handlers take a `build_body` argument, so both models share one SSE path and one org-verification check. That check now names the model that was refused.
- Refused before any request: an unknown model, an unknown quality, and `background: transparent` with `jpeg` output (OpenAI requires png or webp for transparency).
- Sizes: GPT Image 2's list plus `2560x1440`. The 4K options stay but are labelled experimental, because OpenAI calls anything above 2560x1440 experimental. No free-form size field: custom sizes have several rules (multiples of 16, 1:3–3:1, pixel range), and a fixed list can't break them.
- Pricing is the same per token as GPT Image 2 ($5/M text in, $8/M image in, $30/M image out per OpenAI's model pages); xhigh/max cost more only because they produce more output tokens.
- Live check 2026-10-10: one Flare generate (1024x1024, low, transparent, png) through `handle_gpt_image_25_generate` finished in 8.8 s and returned an RGBA PNG with real transparency (67% of pixels fully transparent), so the GPT Image 2 SSE event names parse for 2.5 and `background` works on generations.
- Still not verified live: that `/v1/images/edits` takes `background` for 2.5. It comes from the docs.
- Sources: https://developers.openai.com/api/docs/models/gpt-image-2.5-flare , https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst , https://developers.openai.com/api/docs/changelog (2026-09-08 entry).
- Count pins: registry 301→303 (`test_video_qc_nodes`, AGENTS.md). MODEL_REFERENCE regenerated. No Flora gap entry existed for it.

## 2026-10-09 — Krea workspace nodes, plans and usage (phases 5–7, 9–12)

- Eight nodes in `handlers/krea_workspace.py`: Job History, Node App, Krea Files, Save to Krea Files, Krea Nodes Workflow, Krea Agent, Desktop Apps, Usage. They share one doc (`docs/model-providers/krea/krea-workspace.md`) with a docUrl different from the gateway's, so the catalog sync leaves them alone.
- Billing paths follow what Krea offers. Job History lists only with an API token (MCP has `get_job` but no list), fetches one job on either path. Node App runs on both. Files, Files Save, Krea Nodes, Agent and Desktop are account-only (MCP-only tools). Usage needs a separate enterprise workspace service key.
- `KREA_USAGE_KEY` is a new credential instead of reusing `KREA_API_TOKEN`: Krea's `/usage` refuses personal keys, so a shared field would always fail for most users and hide that difference. Registered everywhere the credential list lives (backend allowlist, desktop vault list and its count test, Settings, readiness labels, provider health). Its health probe is the default 7-day `/usage` read: non-billable, and a 2xx proves the key is a service key. On a busy enterprise workspace that response could be large; it is cached for the normal TTL.
- Typed IDs, never wired, for anything that reaches into the user's own work: Krea Nodes read/update (workflow ID) and Desktop Apps (app UUID, which also changes whenever the app reopens). Same reasoning as Library Manage deletes: a shared recipe must not be able to target someone's projects.
- Node App: the schema is checked with a placeholder URL standing in for media fields before upload, so a bad input fails before any upload or spend. The account path pages `get_node_apps` (up to 20 pages) to find the version, because MCP has no lookup by version ID; only public and workspace-shared apps appear there. When one of several jobs fails, the others are cancelled (`run_jobs`).
- Files Save sends raw bytes the way `write_files_upload` grants ask (POST or PUT, the grant's headers, optional commit URL), https only and without Krea credentials. Multipart grants are refused rather than half-implemented. Tags go on inline text in the same call; uploaded media is tagged afterwards with `tag_files`. Fixed during testing: the first version re-tagged the text file as well.
- Krea Agent loops `wait_for_agent_session` in ≤300 s steps up to the node's wait (default 900 s). Krea has no stop for an Agent turn, so Stop and timeouts only stop waiting; the error says the turn keeps running in Krea and links it.
- Plans (phase 11 UI): `GET /api/krea/plans` and `POST /api/krea/trial` call only `show_plans` / `start_free_trial` through `KreaConnector.call_billing` (fixed two-tool allowlist, empty arguments). `services/krea_plans.py` passes through only the card's fields and keeps links only on krea.ai (plans) or checkout.stripe.com (trial); the frontend re-checks. Plans load on a click, never automatically. The trial is two clicks (start, then open the returned link) so popup blockers cannot eat it and nothing opens a checkout by itself. The live `show_plans` answer for this account had `trial: null`, so the trial's own fields are unknown and the card only uses its presence.
- Unverified live shapes, built from MCP input schemas and handled defensively, need a real run before trusting: `write_files_upload` grant (`uploadUrl`, `method`, `headers`, `commitUrl`, `multipart`), `create_folders` answer (a new folder is created on every run with a folder name; Krea may duplicate or reuse it), `execute_node_app` account answer (MCP structured results are objects, so `{jobs: [...]}` or one job are both accepted), Agent session view keys (`finished`, `timedOut`, `deliverables`, `latestAssistantText`), `list_desktop_apps` answer, `start_free_trial` answer.
- Commit security review (3 findings, all fixed before merging):
  - **SSRF:** media URLs in Krea answers (job results, Files, Agent deliverables) were fetched with redirects followed to any host. An Agent deliverable or a workspace-shared file could have pointed Nebula at `169.254.169.254` or a LAN service. `services/public_url.py` now fetches only public https hosts, checks DNS on every redirect hop, sends no credentials and caps size at 1 GB. `services/output.write_media_bytes` was split out of `materialize_media_value` so the bytes are written through the same extension allowlist. World Labs keeps its own copy of the check (`handlers/worldlabs.py`); merging the two is a follow-up, not done here.
  - **Stored XSS:** SVGs from Krea Files were written to the outputs folder and served from Nebula's own origin, so a script inside one would run with access to the local API. Quiver, fal and Replicate already wrote SVGs the same way, so the fix is in `serve_output`: SVG/HTML/XML outputs get `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; sandbox`, and every output gets `nosniff`. Nothing iframes outputs, and `<img>` rendering is unaffected.
  - **File type:** desktop frame images took their extension from the tool's MIME type, so `text/html` would have been written as `.html`. Frames are now saved only as PNG, JPEG, WebP or GIF.
- Copy fix: the Settings card said "The original Krea tools use API tokens", which stopped being true when those nodes got the account choice.
- Count pins: registry 293→301, desktop credential list 16→17. AGENTS.md said 168 nodes; now 301.
- Validation: 3,657 backend tests (after the security fixes), 1,690 frontend tests, tsc, lint, production build and budget, catalog `--check` (108), 301 contracts. Desktop: 225 pass; the 8 Electron sidecar tests cannot start here because this worktree has no Electron binary installed (`spawn …/electron ENOENT`) and do not touch the changed code.

## 2026-10-09 — Krea full coverage: enhance, 3D, account mode for styles and moodboards

- Scope changed after the audio work: the user asked to connect every Krea capability except API token admin. The phase table lives in `docs/model-providers/krea/krea-full-coverage.md`; this entry covers phases 1, 2 and 4.
- Enhance (18) and 3D (10) came in through the same generator. Enhance outputs Video when the route takes `video_url`, otherwise Image, and is categorized `transform`. Krea's MCP serves every enhance model, including video upscalers, through `enhance_image`. Krea tags every route's primary output `type: model`, so result parsing ignores that tag and uses the route's media type (an earlier mapping of `model`→Mesh broke video outputs).
- The frontend decided "Krea account capable" from an id/endpoint regex limited to image/video, so audio/enhance/3D nodes silently missed the default-mode and sign-in checks. It now reads the definition's `_kreaAuth` param (`supportsKreaAccount`, `usesKreaAccount`, `isKreaAccountOnly`). The engine's credential check and the cache-key revision did the same thing via `catalog_models()`; both now use `services/krea_account.uses_account`.
- `services/krea_account.py` holds the account plumbing for non-generation tools: exact-argument calls validated against the live tool schema, local-media upload, and a run-job helper that cancels on early exit. `krea_mcp_generation.py` was split into reusable `upload_asset` / `poll_job` helpers for this.
- Krea 2 Generate on the account path builds the same body as before, keeps local references as paths, and hands it to the gateway's new `run_gateway` for the matching `krea-image-krea-krea-2-{variant}` route. That reuses discovery, live-schema binding, uploads, polling and cancellation instead of a second Krea 2 implementation. The API-token path is unchanged.
- Account paths refuse controls they cannot honor before any request, rather than dropping them: Style Train (learning rate, batch size, steps, `Default` type, workspace share), Style Search (`filter`, `user`, `liked`). The API path refuses account-only training models (`k1`, `ltx-23-22b`).
- New nodes: Krea Moodboards and Moodboard Create are account-only (`_kreaAuth` with a single `mcp` option, `envKeyName: []`), because Krea's API has no moodboard endpoints. Library Manage renames/deletes styles and moodboards; deletes take only a typed ID and Confirm delete must repeat it (a commit security review caught that a boolean switch let a shared recipe chain Krea Moodboards → delete); renames may still be wired because they are reversible. IDs are restricted to `[A-Za-z0-9_-]` because the API rename puts the ID in the URL path.
- Tool schemas for list/create/update/delete style and moodboard were copied from the live MCP `tools/list` into `tests/fixtures/krea_mcp_tools.json`. Live read-only checks: `list_styles` → `{styles: [], next_cursor: null}`, `list_moodboards` → 11 presets.
- Changed a frontend test that pinned the old rule "legacy Krea nodes stay API-only even when signed in"; it now pins that they follow the saved choice and that old recipes without the param keep the API token.
- 3D export (phase 3, `handlers/krea_export.py`): API-token only because Krea has no MCP export tool. The ZIP is downloaded without credentials and unpacked with explicit checks (no absolute/parent paths, backslashes or symlinks; ≤500 entries, ≤500 MB download, ≤1.5 GB unpacked) instead of `extractall`. PLY is not in Nebula's Mesh allowlist, so a PLY export fills `file`/`files` and leaves `mesh` empty rather than widening the viewer's formats.
- The export node's docUrl is `krea-gateway.md#3d-export`, not the bare gateway doc: `sync-krea-catalog.py` treats every node whose docUrl equals the gateway doc as generated and would delete it on the next refresh.
- Library Manage is categorized `analyzer`, not `utility`: `utility` is reserved for local nodes covered by `docs/utility-node-test-manifest.json`.
- `tests/test_reference_roles.py` fingerprints the original node contracts. Added exact approvals for the prepended `_kreaAuth` param on the three original Krea nodes and the four appended training models, in the same style as the existing approvals, rather than refreshing the baseline.
- Krea `/usage` needs an enterprise workspace service key and refuses personal API keys; that shapes phase 11.
- Count pins: registry 289→293.

## 2026-10-09 — Krea audio models

- Added because the Krea announcement video opens on music generated through Nebula's Krea connector, and the connector could not generate audio. Built on `feat/krea-audio-models` from `main`, separate from the dirty Design-agent checkout.
- Extended the existing generator (`scripts/sync-krea-catalog.py`) to include `/generate/audio/` routes as `audio-gen` nodes with `audio`/`audios` outputs. Enhance (18 routes), 3D (10) and node apps stay out: they need different input/output node shapes, not just another prefix.
- The refresh came from Krea's live OpenAPI (2026-10-09), so it also brought in what Krea changed upstream since the 2026-10-03 pin: new `krea-image-google-nano-banana-2-1`; Ideogram 4.5 Precise `quality` is now `very_low…high` (no `very_high`, so a saved graph using `very_high` will fail schema validation before spend); Gemini Omni Flash 1.1 `reference_videos` max 1→3; Flux 1 Dev's published random seed default changed (Krea regenerates it per fetch — expect this churn on every refresh).
- Account path: Krea MCP exposes `generate_audio` with the same `model`/`input`/`sync` contract as image/video (checked live with read-only `get_model_schema` for `elevenlabs/music-v2.5`, endpointPath `audio/elevenlabs/music-v2.5`). Added that tool to the captured fixture and mapped the `Audio` category.
- Result parsing now labels a tagged `audio` URL as Audio. Before, an `audio` key on a video route would have been materialized as a Video artifact.
- Count pins updated: gateway 74→80, registry 255→261 (`test_video_qc_nodes`). `.claude/skills/krea/SKILL.md` is the older legacy-node skill and was left alone; `.agents/skills/krea/SKILL.md` is the current one and was updated.
- Validation: 3,489 backend, 1,684 frontend, desktop node tests, lint/style guards, production build/budget, catalog `--check`, 261 node contracts and regenerated MODEL_REFERENCE.

## 2026-10-07 — UI audit repairs

- Reuse the isolated `codex/audit-web-fixes` worktree and preserve its existing functional repairs. The parent checkout and its parallel brand-system work stay untouched; packaged Electron remains outside this task.
- The user explicitly removed alternate themes from scope: retain the current Slava Restraint appearance, normalize old saved theme choices, and remove automatic theme changes when switching agents.
- Consolidate canvas zoom/fit controls, count, and minimap at the bottom-right so the navigation rail owns the left edge. Keep zoom/fit and count available independently of the large-graph rendering preference; that preference still controls offscreen rendering and minimap visibility.
- Fix shared workspace layering and graph file-action ownership rather than leaving Create buttons/commands that silently do nothing. Browser checks use isolated empty state and blocked generation handlers.
- Opening Chat can precede socket readiness, so its preferred textarea may be disabled. Focus the next enabled control immediately; later connection readiness must not steal focus from user interaction. Reopening the still-mounted connected dock prefers its enabled composer. Settings and Chat remain nonmodal; the model picker traps Tab.
- Final validation: 993 frontend tests, full lint/inline-style/CSS-scope guards, TypeScript production build and bundle budget pass. Native browser checks cover clean/populated canvas navigation, minimap collapse and performance preference, compact drawer at 200%, picker search/provider visibility at 200%, Settings/Chat above Create, Escape, and Daedalus retaining the same appearance.
- Save/Open shortcuts from Create reach real native pickers. Native file completion remains unverified: Dia leaves Save/Open disabled here, including an independent unfiltered Save probe in the same writable private folder. Cancelled the dialogs; no speculative file-filter change. Automated tests cover routing, serialization, cancellation, guarded atomic import and history retention. The existing screenshot CDP harness was updated and syntax-checked, but not executed; all live UI checks used computer use.

## 2026-10-07 - Web/backend audit repairs

- Reuse the clean managed publication worktree, starting `codex/audit-web-fixes` at published main `998ad87c`. The active Design-agent checkout and its separate brand work remain untouched. Repair the seven web/backend findings; the user explicitly excludes packaged Electron, so the four desktop findings are deferred.
- Use the frozen development lifecycle implementation as a reference for Create/Cinema ownership, Stop, event filtering and reload reconciliation. Selectively port the required behavior rather than merging the dirty development checkout. Preserve published Paper/Krea paths, immutable source snapshots, historical recipe parameters and explicit rerun semantics.
- Verify paid-generation paths with deterministic provider stubs and real local media processing. No new paid jobs are needed. Dependency maintenance uses a separate private install; keep audit evidence and personal state outside Git.
- Iterator repair follows the documented per-item downstream workflow. Preserve scalar port values; carry cumulative batch outputs separately for history and use per-invocation artifact directories so fixed handler filenames cannot overwrite earlier items. Reject independent iterator joins before execution instead of silently inventing Cartesian paid-generation semantics.
- Do not add broad backend locking by node ID: IDs are recipe-local and concurrent Cinema variations intentionally reuse scene nodes. Shared frontend run ownership blocks conflicting Canvas/Create writers while disjoint jobs and explicit Cinema variations remain possible.
- Saved Cinema ports require authoritative reconstruction at both frontend load and backend typed graph ingress/execution validation. Derive Image ports only from persisted scene shot IDs; preserve saved edges and reject removed/fabricated handles rather than accept a wildcard. Create eligibility uses one predicate for normal, Featured and search lists, excluding unsupported required video/audio and second-image inputs while retaining optional alternatives.
- Frontend dependency maintenance uses exact compatible patched versions and canonical npm publication dates. Keep transitive Chai/tinyrainbow on mature compatible versions instead of accepting newly published releases. The only patched source-map-js release is dated 2026-09-30, so retain 1.2.1 until it satisfies the repository's 14-day rule; its advisory remains visible rather than suppressed. Use a private mature npm 11.13.0 CLI after installed npm 11.4.2 fails peer-tree resolution; no global runtime or parent dependencies change.
- Batch success remains accessible through Run History with per-item results, while normal canvas ports continue showing the current scalar result. Preserve immutable cumulative batch results on later failure/Stop and reload. Scene edits prune only deleted-shot outputs on the current Cinema node, consistent with its removed handles/edges; earlier shot/run history remains intact.
- Batch handlers receive the saved initial recipe for each item, then mirror the latest runtime metadata to Canvas. Nested expansion remains bounded by the declared iterator cap (maximum 25); failures stop that node's remaining items and block its consumers, while successful artifacts are settled even on cancellation. World Labs recovery-aware operations are rejected downstream of iterators because one node/run checkpoint cannot safely own several paid recovery IDs; use separate tracked nodes for those operations.
- Independent review caught a remote-video regression introduced by the extractor's local file check. Preserve the existing HTTP(S) input contract while validating missing local/portable paths; four no-network mode tests cover it. Video repair also needs canonical URL decoding for encoded owned output filenames without allowing path traversal.
- Normalize cumulative batch media URLs at the same backend boundary as scalar outputs, including custom output roots. Settle skipped descendants after empty batches or upstream failures so they do not remain queued; retain completed results and other active owners.
- Picker filtering alone does not cover Canvas selections or saved styles. Reuse the eligibility predicate in both the composer button/shortcut and the launch handler before reservation or authoring. Keep the chosen model visible with a Canvas guidance message instead of silently changing its provider.
- Final dependency review found four old browser-data overrides below Browserslist 4.29.0's declared minima. Raise them to the exact supported minima after verifying canonical npm dates; all are older than 14 days. The final audit still flags source-map-js and its dependents, so do not report a clean dependency audit.
- Final validation passes 2,435 backend tests, 958 frontend tests, full frontend lint/style guards, production TypeScript/build/budget, 254 node contracts and generated model reference checks. Native browser checks use an isolated credential-free fixture: a Create job retains Stop across navigation/reload, explicit replay completes with previous records intact, and both iterator downstream results remain inspectable after reload. Real FFmpeg verifies portable/escaped video extraction and replacement duration. No live provider submissions, Electron testing, merge or push.

## 2026-10-07 - Scoped Krea publication and privacy audit

- Publish a squash of the four local Krea commits from a fresh managed worktree based on current GitHub main. This preserves the active parent checkout and live preview and keeps the original local commit metadata out of the new public history. Use the account's verified ID-based GitHub no-reply email for this publication without changing shared Git configuration or previously published history.
- Scanned every introduced or changed blob across the four commits, including earlier revisions: no real credentials, private OAuth links, Krea account/workspace identities or generated test media are present. Keep private test receipts, identifiers and artifacts outside the repository; public validation notes describe the result without account/job/run IDs.
- Extend ignores to cover environment variants, repo-relative connector vaults/state, desktop vault master-key files and private-key/credential files. These are preventive protections for alternate local storage locations; the actual live preview already stores all credentials and outputs outside the repository.
- Fresh code validation passes: 2,389 backend tests, 878 frontend tests and 277 desktop non-GUI tests, plus lint, TypeScript/build/budget, 74-model catalog consistency, 254 node contracts and generated reference checks. The full desktop command reports missing Electron/ws dependencies in the isolated checkout; the separate sidecar suite reuses installed Python/ws with private temporary state. Electron GUI tests are not a passing gate here and were not retried against the user's real Application Support data. Final staged privacy and ignore checks pass.

## 2026-10-07 - Real Krea account generation verified

- The previous disposable preview directory no longer exists, including its OAuth vault and graph state. Restarted the isolated worktree's preview on the same 5203/8033 ports with private persistent state/output under `~/.nebula/previews/krea-provider-20261007`; the active parent checkout remains untouched. Browser graph state from the earlier in-app browser was unavailable, so this test recreates the user's original Kling prompt as a new single-node graph.
- Used native computer use in Dia to Connect Krea, complete equivalent reauthorization through its existing signed-in session, configure Kling 3.0 with account/workspace compute, and click Run once. No API-key fallback, model substitution, cancellation or automatic retry occurred. Parameters were 16:9, 5 seconds, standard mode and audio off.
- One actual account job completed in about 60 seconds. The Nebula run retains the exact recipe, local artifact and complete status; native UI playback and Run History both verified. The H.264 output is 1280 x 720 at 24 fps, 121 frames and 5.041667 seconds, with no audio stream as requested. Full FFmpeg decode passes. Account/job/run identifiers and media remain only in private local evidence.
- Saved the UI evidence outside the repository alongside the private preview. An optional graph ZIP export reached Dia's native save sheet with Save disabled; cancelled that sheet without replacing files. The completed run recipe remains in Nebula's persisted history. This proves one actual Kling account generation; the entire model catalog and other agent hosts were not exercised by this run.

## 2026-10-03 - Authenticated Krea generation contract repair

- The user's first account run failed before submission because the actual authenticated server advertises `generate_image`/`generate_video`, while its current published MCP guide describes `generate`. Live `list_models` also returns `kling/kling-3.0`; the documented `video/kling/kling-3.0` is rejected by live schema lookup. Sign-in succeeded; this was an adapter assumption, not a different Nebula backend.
- Select the discovered generation tool for the saved media category, retaining the generic tool only when that category tool is absent. Resolve the model ID from live catalog entries for the exact bundled category/route and verify the returned schema's model, category and endpoint before any upload or submission. Never dispatch by display name or switch to a different model/provider/billing source. Explicitly request async mode when the tool declares `sync`.
- Factor read-only generation preparation from paid execution so the actual connection can validate the Kling request/tool arguments without submitting a job. Preserve existing history and require the user to rerun explicitly after the backend repair.
- Validation: the user's exact saved Kling params and connected prompt pass bundled/live schemas and discovered `generate_video` arguments. Read-only live discovery resolves all 74 bundled model routes. Restarted only preview backend 8033 with its existing state/output/settings paths; Krea stays connected, two nodes/one edge and both browser run records remain. No live upload/generation/cancellation calls occurred. All 2,389 backend tests pass, including 250 focused Krea checks and sanitized authenticated-tool-schema fixtures with actual PNG/FFmpeg materialization, accepted-job cancellation and no secondary submissions.

## 2026-10-03 - Krea sign-in launch follow-up

- User testing found that Connect prepared OAuth consent but never opened it; the manual sign-in anchor was the only launch action. Open consent from the explicit Connect click, reserving one browser tab synchronously before async client registration, or using the existing guarded desktop external-browser IPC after registration.
- Clear the reserved tab's opener before loading any remote content; only the validated canonical Krea authorization URL can navigate it. Blocked/closed tabs and desktop launch failures retain a prominent manual link with an actionable message. Failed registration or malformed URLs close the blank tab. Pending consent can be explicitly restarted; Settings load, polling and Check never open extra tabs or start generation.
- Live preview verification: clicking Connect opened a new Krea login tab in the Codex in-app browser. Leave login/consent to the user; no account access or generation was performed. The affected Settings/connection gate passes 34 tests, frontend lint and production build/budget pass. The polling test counts relative to initial Settings mounts because its loading state remounts the card.

## 2026-10-03 - Krea account MCP connector

- Support the user's selected scope: one browser OAuth connection for agent model discovery and explicit Canvas/Create generation. Connecting, checking and refreshing credentials never submit a generation.
- Persist `_kreaAuth` on each gateway recipe. Existing recipes default to the API-token/API-balance path; account/MCP recipes use the consent-selected workspace's compute units. A future-node preference cannot rewrite saved runs.
- Use Krea's canonical Streamable HTTP endpoint and advertised OAuth metadata. Implement public native-client registration, PKCE, loopback callback, exact state/issuer checks and persisted expiry ourselves: installed MCP OAuth support drops native metadata and loses expiry/discovery context on restart.
- Keep OAuth tokens out of ordinary settings, graph exports and agent configs. Encrypt the backend vault; desktop protects its master key with existing Electron safeStorage and passes it only to its sidecar. Browser/dev mode uses an owner-only local key and encrypted vault. Desktop fails closed if OS credential storage is unavailable.
- Reuse installed cryptography 50.0.0 and pin it explicitly (PyPI release 2026-07-31, older than 14 days); no package installation or upgrade.
- Agent MCP exposes only model listing/schema tools. Paid media follows Nebula's existing graph execution, cancellation, artifact storage and history instead of bypassing those surfaces.
- Exact authenticated Krea tool schemas are discovered at connection time. Fixture tests cannot establish live account consent or funded generation; keep that validation boundary explicit.
- Real Krea public native-client registration succeeded from the local preview; no account consent or paid job was submitted. Authenticate before claiming live tool compatibility.
- Desktop connector requests require a per-sidecar nonce injected through the trusted preload. `Origin: null` alone is also possible from a sandboxed web iframe, so it cannot identify Electron. The nonce is separate from the vault key and the opaque-origin CORS exception is limited to connector routes.
- Expose that request nonce only to the configured renderer's main frame. Block navigation/redirects to another document and open validated web links in the external browser. A nonce exposed by a preload to a remote page would defeat the HTTP origin restriction.
- Refresh the bearer before each MCP request and pin the accepted connection revision for each job. Reconnecting to a different workspace cannot change an active job's billing identity or send its cancellation using the new connection.
- Extend the backend settings allowlist to persist `kreaConnectionMode`. A real settings API regression checks that saving it survives reload and neither rewrites graph params nor makes provider calls.
- Claude's `--mcp-config` option is variadic; place it before the next option so it cannot consume the user's prompt. Hermes merges a temporary MCP overlay only when no administrator scope exists. Its installed Daedalus profile is missing here, so live Hermes execution is not verified.
- Final checks: 2,373 backend and 870 frontend tests pass, plus 270 desktop credential/sidecar tests and seven new renderer-trust tests. Lint, production build/bundle budget, generated catalog/reference checks and 254 node contracts pass. The desktop GUI suites were not run against the user's real Application Support state; mocked OS encryption/navigation and a real temporary Python sidecar cover the local gate.

## 2026-08-19 - Provider and agent live-acceptance preflight

The paid-provider phase is intentionally split at an explicit budget gate. The
preflight may use authenticated health and model-catalog reads because they do
not create media or consume agent turns; any generation, text completion, or
agent prompt waits for user approval.

Decisions:
- Treat `/api/health/providers?refresh=true` as credential truth. The Settings
  `11/15` header counts configured values and includes the OpenAI key that the
  live health probe rejects, so it is not a validity count.
- Track Nous separately from the 15 Settings credentials because it is backed
  by Hermes OAuth. Daedalus readiness requires both the local executable and
  valid Nous OAuth; neither fact alone proves an agent turn works.
- Use the cheapest node that still exercises each family's real execution and
  output path. Prefer short streaming text, FAL/Replicate Flux Schnell, Runway
  TTS, Meshy text-to-image, and Quiver Arrow 1.1. For direct Ideogram, use the
  transparent async node so the smoke covers image download and persistence,
  not only a metadata helper.
- Separate dollar-denominated usage from Meshy and Quiver account credits. A
  `$1` configured-valid hard cap is deliberately much larger than the roughly
  `$0.058` known success floor so cancellation races and one rerun cannot turn
  a nominal estimate into unapproved spend.
- Do not induce a real provider 429 merely to prove retry behavior. Quiver's
  one-retry `Retry-After` contract is covered deterministically; the live phase
  will prove run-history retry through a controlled failed request and record
  any naturally occurring transient provider retry.
- Missing or rejected credentials are acceptance findings, not permission to
  create keys, change billing, or paste credentials through automation.
- The deterministic audit found complete provider handler coverage, including
  xAI under `test_grok_video_handler.py`, but no equivalent lifecycle contract
  for the Claude CLI bridge. Add the same normalized-event, resume, quick-mode
  gate, failure, and subprocess-cancellation coverage already expected of the
  Codex and Daedalus bridges. This does not replace the approved live turn.
- xAI's current video API documents submit and poll but no cancel endpoint, and
  the handler therefore cancels locally only. Record that explicitly in the
  matrix instead of implying a provider-side cancellation can be proved.
- Claude cancellation emits one terminal `done` event while the async generator
  unwinds, after killing and awaiting the child process; the suspended
  `CancelledError` propagates on the next stream advance. Pin this sequence
  rather than treating the cleanup marker as a swallowed cancellation.
- The live registry mislabeled `ideogram-transparent` and
  `ideogram-edit-prompt` as async-poll even though both direct handlers use the
  synchronous final-response endpoints and immediately download the ephemeral
  image URL. Ideogram's current reference explicitly calls transparent
  generation synchronous; align backend/frontend contracts and generated model
  docs, while leaving actual custom-model training as async-poll.
- `flux-schnell` and `fast-sdxl` had the inverse metadata drift: both were
  labeled sync even though their wrappers call the universal FAL queue
  submit/poll handler. Normalize every non-stream FAL node to async-poll and pin
  the only two streaming exceptions (`gpt-image-2-fal-generate` and `-edit`).
- Meshy's direct `meshy-image-to-3d` handler had drifted away from the shared
  `_poll_meshy_task` loop. Canvas Stop therefore cancelled Nebula's task but did
  not issue Meshy's documented irreversible DELETE for that one path. Route it
  through the shared cancel-aware poller and treat Meshy's `CANCELED` status as
  terminal instead of polling until timeout.
- Gemini Omni background video uses Google's Interactions API, whose current
  first-party contract exposes `POST /interactions/{id}/cancel`. The handler
  previously stopped local polling without calling it; schedule that provider
  cancellation on a detached task once the interaction id is known. Keep Veo's
  older long-running-operation `:cancel` call classified as best-effort because
  Google's current video SDK warns that client abort alone does not stop or
  unbill the service operation.
- ElevenLabs dubbing is the provider's one long-running Nebula audio path. Its
  handler previously cancelled only the local ten-minute poll loop even though
  ElevenLabs documents `DELETE /v1/dubbing/{dubbing_id}` and recommends
  cancelling stuck dubs. On Canvas Stop, schedule that delete on the same
  detached cancellation mechanism as the other async providers.
- FAL queue results (and Replicate non-stream results) exposed provider CDN
  URLs as successful media outputs even though FAL explicitly documents that
  signed URLs expire. Materialize remote/data Image, Video, Audio, Mesh, and SVG
  handler outputs into the bound run directory before caching, manifesting, or
  emitting success. Preserve intentional provider handles such as Veo
  `source_uri` and Meshy `model_url` for downstream API chaining.
- An early shared activity-log append was rejected by the workspace sandbox;
  the later post-repair helper invocation succeeded, so the cancellation and
  durable-output work is now present in the shared 2026-08-19 timeline as well
  as this in-repo record.

## 2026-08-17 - Video QC Suite continuation

Factory completed the preceding reference-role mission, then the user approved a
separate Video QC Suite mission. Factory persisted an architecture and a
63-assertion draft contract, but hit its weekly limit before creating features
or implementation code. The live baseline is therefore 168 nodes with no
`qc-*` entries; the new work starts from the accepted design, not from a partial
implementation.

Decisions:
- Continuation QC found that the original metrics module imported and used
  OpenCV even in `heuristic` mode. Keep OpenCV/skimage pinned for the full
  analyzer suite, but make heuristic metrics independently runnable with
  NumPy/Pillow fallbacks and return an actionable dependency error only when
  the caller explicitly selects `opencv` mode.
- Apply the 45-second vision deadline around the actual request coroutine, not
  only to the internally-created `httpx` client. Reused or test-injected clients
  can otherwise disable timeouts and violate the bounded-provider-work contract.
- Current Google first-party documentation caps inline multimodal requests at
  20 MB. Twelve noisy 960px PNG samples could cross that boundary after base64
  expansion, so advisory inputs are normalized in memory to 768px JPEGs and
  bounded to 13 images/16 MiB of encoded image data before request construction.
- Add a real `video-input` -> QC graph execution test for every analyzer. Direct
  handler tests prove the algorithms, while the engine test proves registry
  lookup, input propagation, run-directory binding, outputs, and terminal event.
- QC cancellation can arrive during metadata probing as well as frame
  extraction or a provider request. Extend the shared ffprobe wrapper's existing
  timeout cleanup to kill and await its child on `CancelledError`, matching the
  ffmpeg cleanup path and preventing an orphaned probe after Canvas Stop.
- Keep one custom `VideoQcNode` frontend component for all four analyzers. They
  have the same annotated-Image plus JSON-Text result surface; four near-copy
  components would add drift without adding capability.
- Treat the checked-in `docs/video-qc-validation-contract.md` as the finalized
  contract. It preserves the accepted modes and outputs while replacing the
  Factory draft's implementation-detail assertions with observable behavior.
- Resolve videos and optional reference images locally. Raw remote URLs are
  rejected before ffmpeg, OpenCV, Pillow, or provider request construction so
  the QC surface cannot reintroduce the SSRF fixed in `23f8333`.
- Heuristic and OpenCV modes are deterministic, keyless local analysis.
  Vision-LLM mode chooses the first configured provider in the accepted order
  Anthropic, OpenAI, Google and uses a bounded non-streaming request. Tests mock
  every provider; no paid live call is part of this milestone.
- Vision responses are advisory data. Each handler validates/coerces returned
  JSON into its own bounded report schema and falls back to an explicit
  unparsed assessment instead of trusting arbitrary provider fields.
- Camera `lens_distortion_estimate` is a measured straight-line deviation proxy,
  not a calibrated physical lens coefficient. A single generated clip without
  calibration imagery cannot truthfully recover optical distortion parameters.
- Preserve the four pre-existing untracked handoff/report/browser-save items
  byte-for-byte. The tracked friction source is `docs/flora-gap-audit.md`; add a
  closure entry there without editing the untracked audit report.
- Boundary extraction must seek one nominal frame before the container duration,
  not one millisecond before it. Low-FPS clips often report duration one frame
  beyond their final decodable PTS; focused synthetic-video tests caught the
  missing final sample before the suite was integrated.
- The existing backend virtualenv lacks the newly declared OpenCV/skimage
  packages. Validation uses the already-provisioned project Conda interpreter;
  requirements remain pinned so a fresh backend install receives them.
- The node-contract checker predated the existing CameraRig and ReferenceSet
  typed ports and failed before evaluating the QC definitions. Its valid-type
  set now mirrors the frontend `PortDataType` union; no node behavior changed.
- The reference-role additive-only regression test compared the entire live
  node set to its historical baseline, which made any future node addition fail.
  It now protects the historical nodes as a subset and still performs the same
  field-by-field additive-role check on every baseline node.
- Security review tightened the 60-second extraction ceiling to cover the whole
  sample batch. A per-frame timeout would have permitted a pathological 12-frame
  input to occupy a worker for up to 12 minutes despite the sample-count cap.
- Factory's proposed OpenCV 4.12 pin requires NumPy below 2.3 on Python 3.9+,
  which conflicts with this repo's NumPy 2.4.4 pin. Use headless OpenCV 4.13.0.92
  instead: its official wheel metadata accepts NumPy 2.x without that upper
  bound, it is over six months old, and it preserves the server-safe headless
  package choice.
- Frontend gates initially appeared to hang because 26,634 files in the ignored
  `frontend/node_modules` tree were macOS dataless placeholders. Restoring the
  exact lockfile tree with offline `npm ci` made lint, build, and all 434 tests
  complete normally; no dependency version or lockfile changed.

Validation (2026-08-18 continuation):
- The expanded focused QC/cancellation group passed 54 tests. The four QC nodes
  each ran through the real `video-input` -> registry -> execution-engine path,
  and the dependency-light project venv passed all four heuristic engine cases.
- The complete backend suite passed 1,528 tests with QC included under the
  available Python 3.12 environment (OpenCV 4.12.0, skimage 0.26.0, NumPy
  2.4.4). The two existing async-poll `AsyncMock` resource warnings remain.
- Frontend passed 440 tests across 55 files, TypeScript/production build, and
  lint with zero errors. The existing ReferenceSet hook warning, Lottie `eval`
  warning, and large-chunk warning remain unchanged.
- All 172 definitions passed the node-contract gate; generated model reference,
  changed-Python compilation, diff whitespace, startup import, registry wiring,
  and credential-prefix scans passed. Current first-party Anthropic, OpenAI,
  and Google references confirm the three vision model IDs/request surfaces.
- A final `pip install -r backend/requirements.txt` attempt in the stale local
  `.venv` was blocked by managed DNS before pip could resolve even an existing
  dependency. No package was partially installed. The exact pinned OpenCV
  4.13 wheel therefore remains an external install proof ceiling; PyPI confirms
  a Python 3.12-compatible macOS ARM64 wheel, while runtime behavior is covered
  locally by OpenCV 4.12 and heuristic mode no longer depends on it.

## 2026-07-23 - Ideogram seven-node contract and route-safety audit

The seven existing Ideogram nodes remain dual-route. The direct path keeps V4
generate/remix plus the provider's V3 edit surfaces; the FAL path keeps V4
generate and the V3 editing endpoints. FAL now publishes a V4 image-to-image
endpoint, but it is not a drop-in replacement for the fixed remix node because
it omits the node's V3 style-reference, style, and negative-prompt controls.

Decisions:
- Filter FAL requests through a per-node allowlist on a copied `GraphNode`.
  Dual-route nodes persist defaults for both providers, so forwarding the whole
  param map could send direct `rendering_speed=DEFAULT` and `resolution` to FAL.
- Preserve the source node for both endpoint injection and Character-bundle
  seed expansion. The previous wrappers wrote `endpoint_id` and sometimes a
  seed into persisted params during execution.
- Reject invalid route enums, counts, strengths, upscale controls, resolutions,
  and character-reference counts before creating a provider client. Both
  current Character routes consume exactly one identity image; FAL otherwise
  ignores extras and the direct route rejects them.
- Surface the current FAL V4 `acceleration` control and no-fee
  `expansion_model=None`, the full current V4 resolution enum, and direct V4
  copyright detection. Keep structured palette/style-code/json-prompt fields
  out of the fixed nodes; `fal-universal` remains the escape hatch for complex
  FAL objects.
- Freeze one FAL JSON body per node and maintain separate FAL and direct gold
  exemplars because their auth, request shapes, execution patterns, and result
  persistence differ.
- Do not run a paid provider smoke in this milestone. The prior 2026-06-10 live
  results remain empirical evidence; this pass is schema, handler, fixture, and
  regression validation.

## 2026-07-22 - Targeted frontend development-dependency remediation

The clean npm audit reported five development-only findings: one low and four
high. `npm audit --omit=dev` remained at zero. A dry-run audit auto-fix would
have changed dozens of packages and selected Vite 8.1.5, which was only six
days old, so the remediation is deliberately narrower.

Decisions:
- Pin direct Vite to 8.0.16, the first non-vulnerable 8.0.x release, instead of
  allowing the caret range to select the too-new 8.1.5 release.
- Override only the vulnerable transitive packages: `@babel/core` 7.29.7,
  `js-yaml` 4.3.0, and `undici` 7.28.0.
- Keep each `brace-expansion` major compatible with its parent minimatch:
  1.1.16 under minimatch 3.1.5 and 5.0.7 under minimatch 10.2.5.
- Pin the existing Browserslist toolchain at 4.28.2 as an explicit development
  constraint and preserve its already-locked data packages. Re-resolving Babel
  otherwise selected five releases between 0 and 13.6 days old even though
  none was required for the security fixes.
- All selected versions were at least 14 days old at installation time. No
  production dependency or Remotion pin changed.
- Regenerate the lockfile with the explicit package policy, then validate from
  a clean `npm ci`; do not run `npm audit fix`.

## 2026-07-22 - GitHub Actions CI baseline

The repository previously had no configured GitHub checks. The first CI
workflow mirrors the local merge gates in three independent jobs.

Decisions:
- Run on pull requests and pushes to `main`; do not change branch protection.
- Keep backend, frontend, and contract jobs independent so a failure names the
  affected surface and does not serialize unrelated work.
- Use Python 3.12 and Node.js 22, with dependency caches keyed by the existing
  requirements and lockfiles.
- Pin official GitHub Actions to immutable commits while documenting their
  release-major tags in comments.
- Do not upgrade pip or run an audit auto-fix in CI. The workflow installs only
  repository-pinned Python requirements and the checked-in npm lockfile.
- Treat the contract inventory as an executable inventory gate. Its 48 known
  exemplar gaps remain visible in logs rather than being reclassified as CI
  failures by this infrastructure-only change.

## 2026-07-22 - Malformed Cinema refs and FileProvider object audit

Four loose refs had Finder-style duplicate names ending in ` 2`: local and
remote-tracking copies for both Cinema branches. Their alternate tips were
preserved by the existing `archive/cinema-per-shot-pre-repair-2026-07-22` and
`archive/cinema-variations-pre-repair-2026-07-22` tags before deleting only the
four malformed ref files. The valid Cinema refs remain at `d4421a8` and
`0a172c9`; `git fetch --prune`, `show-ref`, and `log --all` work afterward.

The repository lives in an iCloud/FileProvider-backed folder. A default
`git fsck --full` blocks when it reaches one of 2,210 dataless loose-object
placeholders. A fresh GitHub mirror restored every remote-reachable object; an
isolated all-ref audit then proved 8,700 branch/tag objects complete and passed
`git fsck --full --no-reflogs --no-cache --no-dangling`. The remaining nine
unavailable blobs belong only to dangling or reflog-only trees, not any current
branch, tag, or index entry.

Decisions:
- Keep the original FileProvider object store untouched. Do not replace it or
  discard reflogs merely to make the default scanner quiet.
- Preserve every current ref in the verified 61 MB recovery bundle at
  `.git/recovery/object-store-2026-07-22/pre-repair-all-refs.bundle`.
- Treat branch/tag connectivity as green, while retaining the default-fsck
  FileProvider limitation as an explicit local-environment risk.

## 2026-07-22 - PR #21 retired-plan reference cleanup

The repository documentation cleanup intentionally removes completed historical
plans and specs. Review found that a small set of retained backlog and
implementation notes still linked to those deleted paths.

Decisions:
- Preserve the historical context in the retained documents, but describe the
  deleted plans as recoverable from Git history instead of leaving dead links.
- Keep the Quiver placement alternatives as decision history while making clear
  that the retired master plan is no longer a live integration target.
- Do not restore any retired plan or spec solely to keep a historical link alive.

## 2026-07-22 - Gemini Omni provider capability guardrail

Google's current Gemini Omni documentation supports stateful video editing via
`previous_interaction_id`, but explicitly excludes video extension. The live
provider test confirmed that an extension-style follow-up reaches Google and
fails with a paid-request 400, while an in-place edit succeeds.

Decisions:
- Keep one backend capability rule as the source of truth. `validate_graph`
  catches direct Text Input plus edit-context graphs before execution starts;
  the Gemini Omni handler repeats the check after inputs resolve so composed or
  otherwise dynamic prompts cannot slip through to the provider.
- Classify only explicit duration-extension language and only when an edit
  context exists (previous interaction, video input, or explicit Edit task).
  Ordinary edit prompts and fresh text-to-video prompts remain valid.
- Return structured validation details from both execution endpoints. Create
  and Canvas already share these endpoints, so both surfaces can show the exact
  capability guidance instead of overwriting it with a generic validation
  message.
- Preserve connected `previous_interaction_id` precedence over the manual
  fallback. The guardrail uses that same resolved value and does not alter the
  request shape for valid edits.

Validation:
- 1,116 backend tests and 392 frontend tests passed. Frontend lint, production
  build, and the 142-node contract gate also passed.
- The Create UI was browser-checked with Gemini Omni selected; the capability
  note is visible alongside the expected Task, Aspect Ratio, and Delivery
  controls. Canvas exact-error behavior is covered at the store layer, and both
  `/api/execute` and `/api/execute-node` return the identical structured error.
- A provider client mock proves the runtime backstop raises before
  `httpx.AsyncClient` is instantiated, so the unsupported request cannot incur a
  paid submit.
- The checked-in `backend/.venv` points at an old repository location and its
  pytest launcher is not runnable. Verification used the existing Miniconda
  Python environment. The managed session also denied Python localhost binds,
  so a live backend restart was not available for browser QA.

## 2026-07-22 - PR #19 provider/runtime merge-readiness review

Independently re-verified the Google Gemini image and Omni contracts plus the FAL Nano Banana 2/Pro schemas before promoting the provider-runtime branch.

Decisions and corrections:
- Keep FAL endpoint slugs independent from Google's direct model lifecycle. The legacy FAL `gemini-3-pro-image-preview` selector remains valid even though Google shut its direct preview model.
- Scope direct Gemini image-size options by model: Flash Lite is 1K-only, Flash supports 512/1K/2K/4K, and Pro supports 1K/2K/4K.
- Scope FAL extreme aspect ratios to Nano Banana 2. Nano Banana Pro supports the common range through 21:9, not 1:4/4:1/1:8/8:1. Web search remains available on both current FAL models.
- Normalize hidden stale values in the execution adapters without mutating saved nodes. Direct Flash Lite falls back to 1K/common aspect ratios; FAL Pro falls back from 0.5K/extreme ratios and drops the Nano Banana 2-only thinking field. Legacy FAL selectors drop modern-only controls.
- Preserve the manual Gemini Omni previous-interaction parameter for pasted IDs, but add a real Text input so the advertised output-to-input chain works in the graph. A connected value takes precedence over the manual fallback.
- Add focused frontend visibility tests and a handler request-shape test to prevent contract drift.

Validation:
- Clean `npm ci`, 1084 backend tests, 390 frontend tests, lint, production build, and the 142-node contract gate passed.
- Capped live FAL Nano Banana 2 smoke returned one 0.5K image with web search disabled.
- Capped live Gemini Omni smoke exercised URI delivery end to end and saved a 3.008-second, 825417-byte video with an interaction ID.
- `npm audit --omit=dev` reports zero production vulnerabilities. The full audit reports five pre-existing development-only findings; this PR does not change the affected toolchain dependencies.
- Existing non-blocking warnings remain: two backend test coroutine warnings and Vite's large-chunk/lottie dependency warnings.

## 2026-07-22: Provider contract refresh and repository recovery

- **Preserved the inherited mixed worktree before editing.** Created `codex/provider-contract-refresh` directly from `main` with all existing modified, deleted, and untracked files still present. This keeps `main` available as the clean upstream baseline without stashing or rewriting unattributed work.
- **Repackaged the checkpoint as a three-level draft PR stack without moving it.** `codex/provider-runtime-safety` starts at the refreshed `origin/main`; `codex/provider-contracts-skills` adds only the portable contracts and repo-backed provider skills; `codex/repository-docs-cleanup` adds only historical-doc retirement, the local-engine research checkpoint, README updates, and implementation notes. The original `codex/provider-contract-refresh` branch remains fixed at `33f15cc` as the recovery checkpoint.
- **Kept the generated model reference with the runtime level.** `docs/MODEL_REFERENCE.md` is generated from the node registry changed by the runtime PR. Moving it to the next PR would make the runtime branch fail its own drift gate, so the generated artifact travels with its source while the portable contract corpus remains isolated in the second level.
- **Treat provider routing and provider schemas as separate responsibilities.** Node-specific model selection belongs in `backend/execution/sync_runner.py`; `backend/handlers/fal_universal.py` must continue forwarding arbitrary endpoint schemas and therefore cannot reserve the generic `model` key globally.
- **Live vendor documentation overrides the bundled provider skills.** The checked-in Gemini and FAL skills are useful routing references but contain preview-era model IDs. Production IDs and response-delivery behavior will be pinned to the current Google and FAL primary documentation and covered by regression tests.
- **Do not combine historical-doc deletion, provider skills, provider contracts, Gemini/FAL features, and cinema changes in one commit.** The inherited worktree mixes these independent concerns. Each scope will be validated and committed separately so it can be reviewed or reverted independently.
- **Use `contracts/fixtures/handlers/` as the only provider-contract fixture source.** The inherited `backend/tests/fixtures/{fal,google,openai}` files were untracked duplicate copies and no test referenced them. Keeping two writable trees already produced a stale Omni fixture, so the duplicates were removed and the contract README now names the portable root as the single golden source.
- **Pin a compatible model-viewer/Three pair instead of bypassing npm peers.** The inherited lock combined `@google/model-viewer@4.2.0` (`three ^0.182.0`) with `three@0.184.0`, so clean `npm ci` failed. Updated to `@google/model-viewer@4.3.1` with `three@0.183.2`; both versions are older than 14 days, satisfy model-viewer and every React Three/Remotion peer range, and are pinned exactly to keep future installs reproducible.
- **Closed the pre-existing brand showcase lint gate while restoring the frontend baseline.** Seven fixed palette swatches used static inline backgrounds. They are now named CSS modifier classes with the same RGB values; no visual behavior changed. The Helix mask also dropped an unused angle parameter; callers may still pass the computed angle, and JavaScript ignores the extra argument.
- **Reconciled provider skill conflict copies instead of committing both versions.** Eleven Finder-style `* 2.md` files were either exact duplicates or older copies. The newer skill files retained later cancellation, streaming, model, and caching guidance; corrupted Claude-to-Codex substitutions were repaired against the executable node registry and current Anthropic documentation before the duplicates were removed.
- **Kept FAL route slugs distinct from direct Google model IDs.** FAL still publishes legacy route names containing `gemini-3-pro-image-preview`, so those slugs and skill filenames remain intact. Direct Gemini and Vertex examples now use the stable `gemini-3-pro-image` model ID.
- **Retired historical milestone plans without breaking live references.** `docs/superpowers/` is superseded by the portable contract corpus and remains recoverable from Git history. The two remaining live references were made self-contained before deletion: the hackathon evidence guide embeds its demo sequence, and the Remotion schema names its implementation as the current runtime contract.
- **Integrated PR #5's image-input validation as a fresh commit on the recovered baseline.** The branch was 50 commits behind `main`, but its single commit transplanted cleanly while retaining the stable Gemini IDs and newer provider routing. The shared loader now fails loudly for missing, unreadable, non-file, and unsupported local image references; remote and data URI behavior remains unchanged.
- **Kept Cinema PRs #15 and #16 review-only.** Both branches have no submitted GitHub review and are eight `main` commits behind. PR #15 needs an explicit terminal error merge when its background task fails, otherwise the final graph sync can restore stale success after the optimistic spinner. PR #16 also lets a promoted thumbnail update `shot.output.imageUrl` without updating the dynamic `shot_<id>` port, so the UI and downstream graph can disagree. Neither branch was merged.
- **Merged the unique local-engine research checkpoint, archived the other stale lines.** The ComfyUI/Flora/Weave comparison was documentation-only and applied cleanly. Fifteen fully merged local branches were safely deleted. Six stale non-worktree branches and both stashes were tagged under `archive/` before their local refs were removed; the stash tags retain the merge commits and their untracked-file parents.
- **Preserved two cloud-backed worktrees instead of forcing deletion.** `feat/batch-cross-pair` had two dirty dev-routing edits; they were security-scanned and committed as `2d7634d` before its archive tag was created. The old frontend-baseline and batch worktree directories could not be removed because both Git deletion and a Trash move blocked on cloud file hydration. Their branch refs, worktree registrations, and archive tags remain intact.
- **Final verification is green with known warnings only.** Backend: 1,111 passed with the two pre-existing AsyncMock coroutine warnings in `test_async_poll_runner.py`. Frontend: 389 tests, lint, inline-style guard, Slava CSS scope guard, and production build passed. Contract parity and generated model-reference checks passed for 142 definitions; the build retained the known large-chunk and `lottie-web` direct-eval warnings.

## 2026-07-22: Cinema PR repair

- **Preserve the review stack before rewriting it.** Tagged the original PR #15 tip `66599b7` as `archive/cinema-per-shot-pre-repair-2026-07-22` and the original PR #16 tip `4468ba1` as `archive/cinema-variations-pre-repair-2026-07-22` before rebasing either branch.
- **A completed `execute_graph` call does not prove the Cinema node executed.** Normal upstream failures are emitted as `ErrorEvent` and `execute_graph` returns without a target `ExecutedEvent`. The per-shot task now requires that target event, captures the first user-facing error, and persists it on the live target shot instead of reading stale success from the request snapshot.
- **Failure reconciliation preserves useful state.** A terminal error changes only the target shot status and error text. Its last successful image, hash, and dynamic output port remain available, and sibling edits made during the slow pass remain untouched under the existing per-node merge lock.
- **Keep the Cinema stack independent from provider work.** The original repair did not duplicate the then-unmerged provider fixes into #15. The final restack inherits those merged fixes, CI, and dependency remediation from `main` while keeping the Cinema diff reviewable on its own.
- **Variation promotion is one scene-plus-port transaction.** PR #16 now promotes through a Cinema-specific backend endpoint guarded by the same per-node lock as generation merges. It persists `selectedVariation`, replaces the canonical shot output without retaining a stale hash/error, updates `shot_<id>`, and broadcasts one graph sync. The frontend mirrors both fields after success and uses the same local operation for frontend-only nodes.

## 2026-06-10 (night) — Full Ideogram direct-API surface: 7 direct-only nodes incl. custom-model training

User wanted EVERYTHING the direct API offers, not just the dual-route nodes. Pulled the full OpenAPI (developer.ideogram.ai/openapi.json), enumerated all 27 endpoints, and wired every current (non-legacy) one. Registry 131 → **138**.

New direct-only nodes (envKeyName IDEOGRAM_API_KEY, apiProvider 'ideogram', no FAL fallback):
- `ideogram-describe` (v4): image → readable `description` + raw `json_prompt` (the v4 structured contract incl. bbox layout when include_bbox on). Category analyzer.
- `ideogram-magic-prompt` (v4, **application/json** not multipart): text → expanded json_prompt. Category text-gen.
- `ideogram-transparent` (v3 generate-transparent): prompt → real-alpha PNG, upscale_factor X1/X2/X4.
- `ideogram-remove-background`: Ideogram's own cutout — deliberately separate node id from the FAL rembg `remove-background`.
- `ideogram-layerize` (layerize-text): returns the clean **base plate** (text stripped); the response is NOT the standard data[] shape — base_image_url/original_image_url/seed, normalized through `_save_first_image({"data":[{"url": base}]})`.
- `ideogram-edit-prompt` (`/v1/edit`): MASKLESS prompt-driven edit, 1+ images (single `image` port leads, multi `images` appends), optional transparent_background. Response schema is V1EditImageObject but the endpoint is NOT marked legacy.
- `ideogram-train-model`: one node = the whole training pipeline (POST /datasets → upload_assets multipart `files` array → train-model → poll GET /models/{id} every 30s, ≤3h, statuses CREATING/DRAFT/TRAINING/COMPLETED/ERRORED/ARCHIVED; requires is_available_for_generation). Outputs `custom_model_uri` + `model_id` Texts.

Closing the loop: `custom_model_uri` directParam added to ideogram-character (v3 generate accepts it) → train-model output wires straight into fine-tuned character generation.

Still consciously unexposed (in ideogram.md): raw json_prompt INPUT on v4 generate (we only OUTPUT it from describe/magic-prompt so far), dataset/model list-get endpoints, per-character-ref masks, all 5 legacy endpoints.

980 backend (+10: per-endpoint body shapes incl. the JSON-vs-multipart split, train full-flow ordering + ERRORED failure, custom_model_uri forwarding) + 347 frontend; parity 138. NOTE: `npm run lint` currently fails on BrandShowcaseView.tsx inline-style violations — that's the user's in-flight brand work, not this session's files (mask-painter/inspector pass the checker).

## 2026-06-10 (evening) — Ideogram direct API (dual-route), Character Studio integration, Mask Painter

Three asks in one pass: stop depending on FAL alone for Ideogram, wire Character Studio into ideogram-character, and give masks an in-app painting UI. Registry 130 → **131** (+mask-painter).

**1. Ideogram direct API — dual-route conversion (not new nodes).** All 7 ideogram nodes now follow the veo-3/meshy dual-route pattern: `envKeyName: [IDEOGRAM_API_KEY, FAL_KEY]`, `directKeyName`, params split into shared/fal/direct. New `backend/handlers/ideogram.py` (multipart/form-data, Api-Key header, SYNC endpoints, ephemeral result URLs downloaded immediately). Schemas all fetched from developer.ideogram.ai OpenAPI (.md suffix trick). Notables:
- **Direct remix rides V4** (`/v1/ideogram-v4/remix`, `image_weight` 1-100) while FAL remix is still v3 — the direct route is a real upgrade, not just margin-avoidance.
- **Param dialects differ per route** and the dual-param architecture was built for exactly this: rendering_speed TURBO/DEFAULT/QUALITY (direct) vs TURBO/BALANCED/QUALITY (FAL); magic_prompt enum vs expand_prompt bool; resolution pixel enums vs image_size presets; v4 generate/remix take no seed/num_images.
- **Router fallback nuance:** direct reframe REQUIRES `resolution`; the router falls back to FAL when it's unset rather than 400ing (`require_param` hook in `_ideogram_router`).
- Skipped on direct: v4 `json_prompt` structured contract, describe/remove-bg/layerize-text/transparent-bg/custom-model training (documented in docs/api-guides/ideogram.md as unwired).

**2. Character Studio → ideogram-character.** Optional `character` input port (Character dataType). `expand_character_inputs` in handlers/ideogram.py reuses `cinema.identity.expand_character` — the SINGLE identity-correctness implementation (trait string VERBATIM prefix, stored views first, per-use overrides appended, max-refs guardrail at 10) — and the sync_runner wrapper applies it to BOTH routes before delegation. Bundle seed lands in params only when the user left seed unset. `reference_images` port went required→optional (refs OR character, enforced in the wrapper with a clear error).

**3. Mask Painter.** New utility node + canvas paint modal:
- Storage contract: `params._maskData` = white-on-black PNG data URI (underscore param rides `_validate_params` like `_characterId`). **Polarity applied at EXECUTION** by the engine branch (`white-edit` FLUX / `black-edit` Ideogram) so flipping the param never requires repainting.
- Engine branch resizes the mask to the source image's EXACT dims (PIL, NEAREST to keep edges hard) — Ideogram 422s on any mismatch.
- Modal exports only the strokes layer (never the photo canvas) → cross-origin upstream images can't taint the export. Paints at natural resolution, CSS-scaled display.
- **UI lives in the Inspector, not a custom canvas node** — deliberate: Canvas.tsx is mid-flight with the user's uncommitted brand-showcase work, and a custom node type would have forced edits there. Inspector section finds the upstream image via edges→source outputs (falls back to image-input `_previewUrl`).
- Added to docs/utility-node-test-manifest.json (the manifest gate requires every utility node covered).

Tests: 970 backend (+21: direct body-shapes per endpoint, router direct/fallback/require_param, FAL-route bundle expansion, mask polarity/resize/error) + 347 frontend; contracts parity 131. The earlier FAL-session contract test pinning `envKeyName == "FAL_KEY"` was updated to pin the dual-route shape instead (intended evolution, not a regression).

## 2026-06-10 (later) — Ideogram editing suite: six capability nodes, not just t2i

User caught that the morning's Ideogram add was text-to-image only while Ideogram's whole pitch includes region editing. Wired the full capability surface as 6 new nodes (registry 124 → **130**), all via FAL (FAL_KEY, existing handler):

- `ideogram-edit` (fal-ai/ideogram/v3/edit) — masked inpaint. **Mask polarity is BLACK = edit, the inverse of FLUX Fill** (verified against developer.ideogram.ai: "Black regions in the mask should match up with the regions of the image that you would like to edit"). Surfaced in the port label ("Mask (black = edit)") and pinned by a registry contract test, since a silent polarity flip would invert every edit.
- `ideogram-remix` (v3/remix) — image+prompt restructure with `strength`.
- `ideogram-reframe` (v3/reframe) — outpaint to a required target `image_size`; schema takes NO prompt (contract-tested).
- `ideogram-replace-background` (v3/replace-background).
- `ideogram-character` (fal-ai/ideogram/character) — consistent identity from reference photos; needed a NEW handler mapping `reference_images` port → `reference_image_urls` (style refs ride the existing `images` → `image_urls`). Style enum here is AUTO/REALISTIC/FICTION (different from the v3 AUTO/GENERAL/REALISTIC/DESIGN).
- `ideogram-upscale` (fal-ai/ideogram/upscale) — `resemblance`/`detail` 1-100; `expand_prompt` defaults FALSE on this endpoint (true elsewhere).

Decisions:
- **v3 endpoints for the editing suite** — probed FAL's OpenAPI: `ideogram/v4/{edit,remix,reframe,replace-background}` all 404; only `ideogram/v4` + `ideogram/v4/lora` exist. The direct Ideogram API has a v4 Remix but FAL doesn't host it yet. Swap slugs when FAL ships v4 editing (node ids stay stable).
- **Skipped params:** `style_codes` / `style_preset` / `color_palette` (array/object types the param UI can't express — reachable via fal-universal), `reference_mask_urls` on character (must count-match refs; awkward in graph UI), v4 LoRA node (needs a loras array; fal-universal covers it).
- All six endpoints return `{images: [...]}` → existing `_parse_fal_output` handles them; no output changes.

949 backend (+3: edit body-shape, character ref-mapping, 7-node registry contract incl. mask-polarity + reframe-promptless pins) + 347 frontend; contracts parity 130; lint/build green.

## 2026-06-10 — Gap-audit remediation: dead DALL·E removal, GPT-5.x/Fable-5/Gemini-3.5 refresh, Ideogram 4 + Runway Upscale, doc sync

Full-session remediation of the comprehensive gap review (4 subagent audits + canonical-source verification). Registry: 123 → **124 nodes** (−dalle-3-generate, +ideogram-v4, +runway-upscale). Tests: 946 backend + 347 frontend, node-contracts parity green.

**Decisions not dictated by the spec:**
- **`dalle-3-generate` removed outright** (not aliased): OpenAI shut down dall-e-2/3 on 2026-05-12, and gpt-image nodes already cover the category. Saved graphs containing it will fail validation — acceptable since the API itself is dead. Also dropped the dall-e branches from `openai_image.py` and the dead `dall-e-2` option from `gpt-image-1-edit`'s enum (caught by the docs subagent).
- **`gpt-4o-chat` keeps its node id** (saved-graph compat) but displayName → "OpenAI Chat"; default model gpt-4o → **gpt-5.4**; new `reasoning_effort` param (gpt-5.x only, default medium). Handler omits temperature/top_p/penalties for gpt-5.x (reasoning models reject them) — guarded in code, not just UI visibleWhen.
- **`claude-chat`**: added claude-fable-5 + claude-opus-4-8; **default stays sonnet-4-6** (cost/perf for graph work). Handler suppresses the extended-thinking block for fable/mythos models (adaptive thinking is always-on there; the param 400s).
- **`gemini-chat` default** 2.5-flash → **3.5-flash** (now the stable frontier model). `gemini-3.1-flash-lite-preview` → stable `gemini-3.1-flash-lite` id. `thinkingLevel` visibleWhen refreshed to the 3.x set incl. 3.5-flash (was stale → param would never show for new models).
- **Runway**: video options += seedance2/seedance2_fast/happyhorse_1_0 (all text-capable per docs); aleph gets a model param (default **stays gen4_aleph**, aleph2 opt-in); image += gemini_image3_pro + gpt_image_2; **new `runway-upscale` node** (magnific_precision_upscaler_v2, schema from runwayml SDK 4.18.0 via opensrc: scaleFactor 2/4/8/16, flavor, sharpen/smartGrain/ultraDetail). gen3a_turbo kept but labeled legacy (dropped from Runway's models table, still priced).
- **Ideogram 4 wired via FAL** (`ideogram/v4`, schema fetched from fal.ai OpenAPI) rather than direct api.ideogram.ai — zero new auth, matches the 40+ existing FAL preset nodes. Direct integration (IDEOGRAM_API_KEY) deferred; key removed from .env.example with the other never-wired keys (BFL/BYTEDANCE/RECRAFT).
- **Sora 2 sunset surfaced in displayName** ("Sora 2 (sunsets Sep '26)") since node defs have no description field — OpenAI kills the Videos API 2026-09-24 and the FAL endpoints proxy it. Plan removal mid-September.
- **Cancellation**: veo.py now schedules a detached `{op_name}:cancel` (standard google.longrunning interface, best-effort) on CancelledError; grok_video.py documented local-only (xAI has no cancel endpoint) matching the MiniMax precedent. The 342e86e claim of "all poll-based providers" had skipped both.
- **Settings UI**: added KREA_API_TOKEN (was un-keyable via UI); removed the BFL field + the dead "FLUX Routing" control — the `routing` setting was persisted but no handler ever read it (scaffolding for an unbuilt BFL-direct path; ROUTING_OPTIONS left in place, emptied).
- **node_definitions.json formatting normalized** to plain `json.dump(indent=2)` — a few hand-compacted option blocks (seedvr resolution etc.) re-expanded; future scripted edits now produce clean diffs.

**Verified-false subagent claims (do NOT "fix" these):** `anthropic-version: 2023-06-01` is still Anthropic's latest API version; `api.dev.runwayml.com` IS Runway's production host.

**Deferred / follow-ups:**
- README still says "seven workspaces" deliberately — brand-showcase is in-flight uncommitted work; its README mention should ride that commit.
- runway-image caps reference images at 3; gemini_image3_pro supports 14 and gpt_image_2 supports 16 — widen when someone needs it.
- Frontend/backend node-def duplication: parity is gated (`npm run check:node-contracts` + backend contract tests) but codegen from the backend JSON is the structural fix — sized as its own session.
- minimax handler still on `api.minimaxi.com` (works; docs now say `api.minimax.io`) — flip after a live smoke.
- Eleven Music (`/v1/music`, model music_v1) is API-ready at ElevenLabs but unintegrated — candidate next node.

## 2026-06-03 — Output storage: Reveal in Finder, Save-to-folder, configurable output dir

Three follow-on features after the user asked where generated images live (answer: `<repo>/output/<UTC-timestamp>/<uuid>.<ext>`, served at `/api/outputs/...`, never auto-deleted).

- **Reveal in Finder** — `POST /api/reveal {url}` resolves via the existing `_output_path_from_ref` (containment-checked under the output root), then `open -R` (macOS) / `xdg-open` (Linux) / `explorer /select,` (Windows) via `asyncio.create_subprocess_exec`. ResultCard gets a FolderOpen button.
- **Save to a default export folder** — new `exportFolder` setting (added to `DEFAULT_SETTINGS` + the `PUT /api/settings` allowlist + a Settings field). `POST /api/export {url}` copies the output file into `exportFolder` (default `~/Downloads`), de-duping the filename on collision. ResultCard gets a FolderDown "Save" button.
- **Configurable output directory** — wired the previously-DORMANT `outputPath` setting (the Settings field + persistence already existed but nothing honored it). `_resolve_output_root()` now sets `OUTPUT_ROOT` from `NEBULA_OUTPUT_ROOT` env > `outputPath` setting > default, at import (applies on restart). **Replaced the `/api/outputs` StaticFiles mount with a dynamic `@app.get("/api/outputs/{rel:path}")` FileResponse route** that serves from `OUTPUT_ROOT` and falls back to `DEFAULT_OUTPUT_ROOT`, so outputs created before a relocation still serve. Starlette `FileResponse` preserves content-type + HTTP Range/206 (video seeking) + HEAD — verified live.

**Review-caught fixes (opus, on the serving-path change):**
- **Critical — startup brick:** once `outputPath` is user-set, the unguarded `OUTPUT_ROOT.mkdir()` at import could crash uvicorn on a bad/unwritable path. Fixed inside `_resolve_output_root()`: anchor relative paths to the repo root, then `mkdir`-or-fall-back-to-default so `OUTPUT_ROOT` is always a usable dir. Live-verified: `NEBULA_OUTPUT_ROOT=/dev/null/nope` boots via fallback instead of bricking.
- **False-green traversal test:** the original `client.get("/api/outputs/../../etc/passwd")` passed only because httpx normalizes `../` client-side, never hitting the guard. Replaced with a direct `serve_output("../../../../etc/passwd")` test that actually exercises the `relative_to` containment (and a server-side `curl --path-as-is` live check → 404).
- Relative `outputPath` was CWD-dependent → anchored to repo root. Dual-root fallback also applied to `convert_to_glb` + `resolve_moodboard_image_path` for consistency. Registered `.webm`/`.glb` mime types.

**Verification:** backend `pytest` 865 passed (twice); frontend `tsc` clean, 322 vitest, build/eslint/css-scope green. Live (running backend): image 200 (image/png), video full 200 + Range 206 (seek), server-side traversal 404, missing 404, no-brick boot on bad path. Commits: 14a4d83 (reveal+export), a53cbb5 (configurable dir), 782b4ef (review fixes).

## 2026-06-03 — Create view Phase 3 (presets / styles library)

Branch `feat/create-view-p2-p3` (same branch as P2). A library of named "styles" — prompt fragment + params + optional model — that pre-fill the composer, plus save-current-as-style. The historical implementation plan was retired in the 2026-07-22 documentation cleanup and remains recoverable from Git history.

**Decisions / non-obvious calls:**
- **Typographic preset cards, no shipped thumbnails.** Higgsfield merchandises styles with auto-playing video tiles; we ship ALL-CAPS name + category over a deterministic per-id Slava gradient. This sidesteps two real constraints at once: (1) shipping binary PNGs through the toolchain is awkward, and (2) the backend serves **only** `OUTPUT_ROOT` (one `StaticFiles` mount) — there's no arbitrary-file route, so a repo-shipped thumbnail isn't directly servable without copying it into the outputs dir at seed time. Real thumbnails are deferred to P4. The one allowed inline style is `PresetCard`'s `--preset-hue` custom property (a dynamic data value — `check:inline-styles` only flags static visual props).
- **First-run seeding is a NEW pattern.** No seeding existed anywhere in the codebase (verified). Added `seed_presets_if_empty()` (idempotent — only when the global store is empty; wrapped in try/except so it can never break boot) reading 12 curated styles from `backend/data/presets/seed.json` (JSON only, no binaries). Placed at the END of `main.py` (Python executes top-to-bottom; the fn must be defined first), running once at import. `conftest.py` sets `NEBULA_PRESET_ROOT` to a temp dir at module-eval time so the boot seeder never writes into the user's real `~/.nebula/presets` during tests.
- **Mirror the store pattern faithfully.** `preset_store.py` clones `moodboard_store.py`. Code review caught that the first cut simplified away three guards the moodboard store has — added back: `_scope_dir`'s `resolve().is_relative_to()` path-containment check, `list`'s per-file `try/except (JSONDecodeError, OSError)`, and the route's `ValueError → 422`. "Reuse verbatim" means *including* the defensive bits.
- **`applyPresetToComposer` rebuilds model defaults on a model switch.** When a preset hints a different model, we re-seed that model's defaults (`buildDefaultParamsForUi`) before overlaying the preset's params, so stale params from the previously-selected model don't leak through. Pure function, unit-tested.
- **Repeated lesson — global-singleton test isolation.** Same trap as P2's cluster route: backend tests must pass in the FULL suite, not just isolation. The preset tests use the module-attribute swap (`monkeypatch.setattr(main, "preset_store", ...)`) + `NEBULA_PRESET_ROOT` sandbox + reference the store through the module (never a stale `from main import preset_store`).

**Verification:** backend `pytest` 847 passed; frontend `tsc` clean, 300 vitest tests, `vite build`, `eslint`, `check:slava-css-scope` green. **Live (isolated uvicorn, temp dirs, port 8001):** boot seeder produced 12 presets (`GET /api/presets` → 200, 12 files on disk); `POST /api/graph/cluster` persisted the cluster to `state.json` (confirming P2 reload-survival) — the user's real `~/.nebula` was never touched.

## 2026-06-03 — Create view Phase 2 (gallery, refs, variations, persistence)

Branch `feat/create-view-p2-p3`. Five sub-features: results gallery/History, reference-image attach, quantity>1 variations, all output types in the stage, and **backend-authored persistence**. Built subagent-driven in batches (Phase A persistence → B/C refs+quantity → D/E gallery+output-alignment) with spec + code-quality reviews. The historical implementation plan was retired in the 2026-07-22 documentation cleanup and remains recoverable from Git history.

**The big reversal — clusters are now persisted (P1 debt closed).** P1 authored clusters client-side (uuid ids, never persisted). P2 flips `authorGenerationCluster` to **backend-first**: it POSTs the cluster to a new additive route `POST /api/graph/cluster` (mirrors `/api/graph/import` but no `clear()`), which adds the nodes/edges to `cli_graph` (assigning `n`-ids, persisting to `state.json` via `_maybe_persist`, normalizing image-input params) and returns them in React Flow shape. The client applies the returned nodes directly + tags model nodes `_createOrigin`. Switching to canvas shows the cluster; it now survives reload.

**Decisions / non-obvious calls:**
- **Tag race (caught in review).** The backend's graphSync WS broadcast usually delivers the new nodes (untagged) to the client store *before* `authorGenerationCluster`'s own `set` runs, so an insert-if-absent merge silently dropped `_createOrigin`. Fixed with an **upsert** that merges only the tag onto already-present nodes (never clobbering their state/outputs) — and a test that pre-seeds the node to actually exercise the ordering (the unit tests mock `wsClient`, so the race was previously untested = false green).
- **image-input accepts `/api/outputs/...` URLs.** The engine passed `filePath` verbatim and FAL's `_to_fal_url` treats any non-`http(s)`/`data:` value as a local disk path — so a served URL broke. Added `resolve_output_ref` (output.py) + an engine `_image_input_output` helper so generated outputs can be reused as references (execution side); the cluster route's `_normalize_image_input_params` handles the persistence side. "Use as input" stores the backend-RELATIVE pathname (not the absolute `http://localhost:8000/...` URL, which would reach external providers unresolved).
- **Gallery is session-scoped.** History is driven by a `generations: {genId, prompt, ts, modelNodeIds}[]` array in `CreateView` (not by scanning `_createOrigin`), so it's reliable in-session. The spec's "All outputs" tab and reload-repopulation are deferred (the canvas persists; the gallery starts fresh after reload). Shipped Grid/List toggle.
- **`deleteGeneration`** removes the model node(s) of a generation plus any now-orphaned `text-input`/`image-input` (an input feeding *other* surviving model nodes is kept). Fires a best-effort backend `DELETE /api/graph/node/{id}` for every id (harmless 404 for any non-cli id) — diverges from sibling delete paths' `CLI_ID_RE` guard, justified because Create clusters are backend-authored now.
- **Cluster-route response built directly, not via full re-export.** Initial impl re-exported the whole graph and filtered to new ids — which failed in the full pytest suite (a sibling test's autouse fixture swaps `main.cli_graph`; root cause proven). Fixed by extracting `_cli_node_to_rf(n, position, all_defs)` (shared by `export_graph_for_frontend` and the route) and looking up the new nodes directly in `cli_graph.nodes`. More robust + avoids export-time normalization side-effects on unrelated nodes.

**Verification:** backend `pytest` 839 passed (twice, order-independent); frontend `tsc` clean, 293 vitest tests, `vite build`, `eslint`, `check:slava-css-scope` all green. Persistence to `state.json` is structurally guaranteed (route → `add_node` → `_maybe_persist`) and covered by the route test. Full browser smoke (gallery progression, persistence-across-reload, use-as-input round-trip) is consolidated with P3 in the verify-and-finish step.

## 2026-06-02 — Create view (Higgsfield-style creation surface), Phase 1

Branch `feat/create-view`. A new full-screen `viewMode: 'create'` surface (4th studio) with a Higgsfield-style bottom-floating composer. Each **Generate** authors a real `text-input → model` node cluster and runs only that cluster via the existing engine. The historical design spec and implementation plan were retired in the 2026-07-22 documentation cleanup and remain recoverable from Git history.

**Architecture — graph-builder (chosen over single-node / hybrid).** `graphStore.authorGenerationCluster(request)` builds nodes/edges and `executeCluster(nodeIds)` POSTs only the cluster to `/api/execute` (reusing `lib/api.executeGraph`). Zero changes to the execution engine, handlers, or node definitions — the surface inherits output rendering, WS streaming, error handling, undo, and canvas editability for free. This is why it's ~640 lines of source for a full creation UI.

**Decisions made beyond the spec:**
- **Local node authoring, not backend-authored.** `authorGenerationCluster` creates nodes client-side (like `addDynamicNode`/paste) in one `set()`, for atomicity + testability + immediate ids. Consequence (verified in live smoke): **Create-authored clusters are client-only and do NOT persist to the backend `~/.nebula/state.json`** — after a generation, `state.json` still held only the pre-existing moodboard node. In-session "fill in" works (nodes are in the client graphStore, render on the canvas, and execute correctly). **Cross-reload durability is NOT wired in P1.** If we want authored clusters to survive a reload, P2 should author via `/api/graph/node-and-connect` (backend-authored, persisted) or push the cluster to the backend graph. Spec §4.3 was updated to reflect this.
- **`_createOrigin` tags model nodes only** (not the `text-input`/`image-input` wiring nodes) — from code review; the P2 results gallery filters on this tag, so tagging input nodes would pollute it.
- **`executeCluster` pre-marks cluster nodes `queued`** (clearing stale `error`/`progress`/streaming fields) before POSTing — from review; without it the stage flashed the previous result on every 2nd Generate.
- **Dropped `cinematic` + `universal` from the picker's `CREATE_MODEL_CATEGORIES`.** `cinematic` = post-process nodes (`cinema-color`/`cinema-look`/`cinema-scene`), not prompt-first generators. `universal` = the 4 dynamic nodes (OpenRouter/Replicate/FAL) — deferred to P4 (they need a model-schema fetch step). v1 picker = `image-gen`/`video-gen`/`audio-gen`/`3d-gen`/`text-gen`.
- **Accent = Slava orange (`--sr-accent`), not Higgsfield lime.** Copy the layout/interactions, render in the house skin.
- **`model-viewer` rendered via the existing `types/model-viewer.d.ts` JSX declaration** (no `@ts-expect-error` — that would be an unused-directive error), mirroring `MeshPreview.tsx`.

**Known debt / deferred:**
- DRY: `buildDefaultParams` (graphStore) duplicates `buildDefaultParamsForUi` (createParams) and the inline logic in `addNode`. Consolidate post-P1 (a shared param-defaults util imported by all three).
- Image-required models (e.g. `runway-video`, `meshy-image-to-3d`) appear in the picker but will fail backend validation without a reference image until P2 adds reference attach — acceptable; surfaces the real validation error.
- P2: results gallery/History, reference-image attach, quantity>1 UI, all output types in the stage. P3: presets/styles library. P4: universal dynamic nodes, generated preset thumbnails, draw/mask, @-mention elements.

**Verification:**
- Gates: `tsc` clean, **288 vitest tests pass** (incl. new createCluster/createModels/createParams/uiStore tests), `vite build` succeeds, `eslint` clean on all new/changed files, `check:slava-css-scope` passes. (`npm run lint` is red on `main` due to **pre-existing** `CrabMark.tsx` inline-style debt — unrelated to this branch.)
- Live smoke (real browser, not lspace): entered Create, opened the model picker (full catalog), typed a prompt, hit Generate → a **real nano-banana image of exactly the prompt** was generated end-to-end (`POST /api/execute → [exec] _run completed → output/.../*.jpeg`). The prompt-faithful output proves the `text-input → model` wiring carried the prompt.
- **Environment gotcha:** background dev servers get reaped (SIGTERM 143) in this harness; when Vite's dev server dies, its `@vite/client` intercepts `console.error` and recursively tries to `send` over the dead HMR socket → a multi-million-line "send was called before connect" storm. This is a Vite-client failure mode, NOT app code. The canvas-cluster screenshot wasn't captured for this reason; the cluster's existence is proven by the unit tests + the successful generation.

## 2026-05-26 — Codex chat agent

- Added Codex as a separate chat runtime rather than overloading the Claude runner. Codex has its own JSONL event stream, auth state, and resume command shape, so a dedicated adapter keeps the existing Claude/Daedalus paths untouched.
- Codex uses the local CLI login state (`codex login status`) instead of storing ChatGPT credentials in Nebula. This follows OpenAI's documented Codex auth model and avoids copying subscription tokens into `settings.json`.
- The Codex runner launches with `workspace-write`, `approval_policy="never"`, and local network enabled so it can call the Nebula CLI/backend without interactive approval prompts while still avoiding the full `--dangerously-bypass-approvals-and-sandbox` path.
- GPT Image 2 generation remains on Nebula's existing OpenAI/FAL nodes. ChatGPT-backed Codex auth is only for the Codex agent brain; Image API calls still require `OPENAI_API_KEY` or `FAL_KEY`.

## 2026-05-26 — Codex skill bootstrap

- Added a repo-backed skill bootstrap to the Codex runner instead of relying on private/global agent skill state. The bootstrap indexes `.agents/skills/*/SKILL.md`, lists available skills, preloads relevant root skill docs based on the user's message, and points Codex to tracked provider docs for exact node/API details.
- Kept preload bounded (`MAX_SKILL_BOOTSTRAP_CHARS`, `MAX_SKILL_DOC_CHARS`) so FAL's large model catalog remains available on disk without bloating every Codex turn.
- `.agents/skills` is not currently committed on `origin/main`; it exists locally as an untracked public-safe bundle. It needs to be added to the repo before the GitHub version has the same Codex/Nebula knowledge.

## 2026-05-26 — Agent connection instructions

- Added Claude auth status parity with Codex via `/api/agents/claude/status`. Nebula still does not collect credentials; it only reports the local CLI's installed/logged-in state.
- Added compact connection instructions inside the chat composer for Claude and Codex. They show the relevant local CLI login/status commands and open automatically when the selected CLI is missing, unavailable, or not logged in.

## 2026-05-26 — Codex announcement HyperFrames video

- Creating the announcement as a standalone HyperFrames composition under `hyperframes/codex-chat-announcement` so it can be rendered independently from the Vite frontend while still matching the Slava UI.
- `npx hyperframes` is not available in the local cache and registry access is blocked in this sandbox, so the work will produce valid composition source and local structural checks rather than a rendered MP4 in this pass.
- The video mirrors the actual Slava chat panel affordance: Claude / Codex / Daedalus selector with Codex active, `Codex · ChatGPT` status copy, dot-matrix canvas, glass panels, orange focus accent, and compact node graph surfaces.

## 2026-05-27 — Backend URL discovery

- Added frontend-side Nebula backend discovery instead of assuming every request and WebSocket lives at `localhost:8000`.
- Discovery checks the same-origin `/api/health` path first, then cached/local localhost candidates on ports 8000-8010, and caches the working base URL in localStorage.
- Kept `VITE_NEBULA_API_BASE` and `VITE_NEBULA_BACKEND_PORTS` as explicit overrides for users who run the backend on a nonstandard fixed port.
- Rewrote local `/api/outputs/...` asset URLs to the discovered backend origin so images, videos, downloads, and restored graph bundles still work when the backend is not on 8000.

## 2026-05-27 — Agent reconnect retry

- Fixed backend discovery treating the same-origin Vite proxy candidate (`""`) as not found even after `/api/health` succeeded.
- Added retry loops for Claude/Codex status checks and the chat WebSocket so a backend that starts after the page loads is picked up without switching tabs or reopening the panel.

## 2026-05-27 — Codex ChatGPT login from UI

- Added a Nebula-launched Codex ChatGPT login path instead of asking users to copy terminal commands first. The backend starts `codex login` and the frontend polls progress/status from the chat panel.
- Treat Codex API-key mode as not connected for the ChatGPT subscription path. The button is intentionally labeled `Connect ChatGPT Account`; starting it runs `codex logout` first, then `codex login`, so an existing API-key login can switch to ChatGPT OAuth cleanly.
- Nebula still does not store OpenAI OAuth tokens. Codex owns the browser/device OAuth flow and caches credentials in its normal local store; Nebula only reads `codex login status`.
- Added a `Device Code` fallback in the UI for machines where the browser callback flow is awkward or blocked.

## 2026-05-27 — GPT Image 2 graph run crash

- Diagnosed the GPT Image 2 "no images" symptom as a backend graph-sync crash before or after the image node, not a Codex auth problem. A long prompt Text output was being probed as if it might be an output file path.
- Hardened output-path normalization so `Path.exists()` / path parsing errors from long plain-text values are treated as "not a file" instead of crashing `/api/graph/run`.
- Verified the regression with the existing long-text output sync test plus the GPT Image 2 handler suite.

## 2026-05-27 — OpenAI API billing guard

- Added an explicit billing acknowledgement guard for OpenAI-direct image nodes (`gpt-image-1-generate`, `dalle-3-generate`, `gpt-image-2-generate`, `gpt-image-2-edit`).
- Frontend graph and node runs now show a native confirmation explaining that these nodes use `OPENAI_API_KEY`, bill the OpenAI API project, and do not use the ChatGPT subscription or Codex ChatGPT login.
- Backend `/api/execute`, `/api/execute-node`, `/api/graph/run`, and `/api/quick` reject unacknowledged OpenAI-direct image runs with HTTP 409, so CLI/agent-triggered runs cannot silently spend API money.
- Human CLI users can deliberately opt in with `NEBULA_ALLOW_OPENAI_API_BILLING=1` for `nebula run` / `nebula quick`; agents do not get that bypass by default.

## 2026-05-27 — CLI graph text output normalization

- While generating media from long prompt text nodes, `/api/graph/run` crashed before downstream image nodes executed because output normalization treated every string output as a possible file path and called `Path.exists()` on the entire prompt.
- Fixed output URL normalization to treat filesystem probes as best-effort: `OSError` from impossible path strings now means "not a media asset", preserving text outputs unchanged.
- Added a regression test so long text-output values do not break CLI graph execution while real output file paths still normalize to `/api/outputs/...`.

## 2026-05-27 — Codex agent ChatGPT-only auth

- Hardened the Nebula Codex runner so `codex exec` only starts when `codex login status` reports `Logged in using ChatGPT`.
- API-key, access-token, unknown, not-installed, and not-logged-in states now return a chat error before any Codex subprocess can run.
- Stripped `OPENAI_API_KEY`, `OPENAI_ACCESS_TOKEN`, and `CODEX_ACCESS_TOKEN` from the Nebula-owned Codex subprocess environment so an inherited shell credential cannot silently flip the agent back to API billing.

## 2026-05-27 — GPT Image 2 visible run feedback

- Diagnosed a Nebula UI feedback gap after adding the OpenAI API billing guard: if the native confirmation was cancelled or suppressed, the run returned before any visible node state changed.
- Node execution now marks the selected execution scope as `queued` immediately after confirmation so GPT Image 2 nodes show visible activity even before the first backend websocket event arrives.
- Queued nodes now render the loading block, and start/validation failures write a visible node error instead of only logging to the browser console.

## 2026-05-27 — Removed API billing confirmation blocker

- Removed the OpenAI-direct image billing acknowledgement as a run blocker. The user decided the confirmation was slowing down normal workflow and was not needed now that Codex-agent auth is ChatGPT-only.
- Frontend Run / Run This Node no longer opens a native confirmation dialog before GPT Image 2 direct execution.
- Backend `/api/execute`, `/api/execute-node`, `/api/graph/run`, and `/api/quick` no longer require `allowOpenAIApiBilling`, so CLI and agent-triggered runs use the same normal validation/execution path.
- GPT Image 2 direct nodes still use `OPENAI_API_KEY` and bill the OpenAI API project; this change only removes the extra acknowledgement gate.

## 2026-05-29 — Soul Cinema (Phase 0 + 1): cinematic pillars + Cinema Studio

Built overnight via a 7-wave dependency-ordered subagent workflow. The historical design spec was retired in the 2026-07-22 documentation cleanup and remains recoverable from Git history. The framing decision: Higgsfield Soul Cinema is a *stack* (cinematic base + Soul ID + Soul HEX + film-look + keyframe handoff), which maps 1:1 onto our node graph — so we add the two genuinely-missing pillars as deterministic local nodes and a multi-shot Studio editor, reusing existing models for everything else.

**Decisions made beyond the spec (collated from wave reports):**
- **`_parse_recraft_color` was extracted into `backend/cinema/color.py`** as the single source of truth and re-imported back into `execution/sync_runner.py` (the old inline def removed), so `from execution.sync_runner import _parse_recraft_color` stays valid for `test_fal_handler.py`. Honors "extract/share, don't duplicate."
- **sRGB↔CIELAB (D65) implemented in pure numpy** rather than adding a color-science dependency (honored "add nothing else but Pillow/numpy", both already pinned in the venv).
- **Grain determinism**: RNG seed derived from a sha256 of the look params + image dims (no wall-clock), so identical inputs → byte-identical noise. Same idea for the whole pipeline → `ExecutionCache`-friendly.
- **`lab-transfer` (default color method)** = Reinhard mean/std match in Lab **plus** a per-pixel nudge toward the nearest target swatch at `strength·0.5`. This is what makes the cool-blue grade keep the forge fires hot orange (visible in the smoke set) instead of a flat global tint.
- **`cinema-scene` stores its spec exactly like `remotion-node` stores its manifest** — `params:[]` in the catalog, the real `CinemaSceneSpec` lives on `data.params.scene` at runtime (there is no `object` param type and adding one was out of scope). The editor writes it via `graphStore.updateScene`.
- **`cinema-scene` base dispatch reuses the full `get_handler_registry` path** (synthesize a GraphNode, invoke the chosen base model's registered closure) rather than the `fal_universal` fallback — a clean internal base→color→look call. Reference images are fed into BOTH `image` (single) and `images` (multiple) ports since edit bases differ (flux-kontext vs nano-banana); handlers ignore ports they don't map.
- **License guard**: an empty/missing or FLUX.1-dev base model is substituted with `seedream-4-5` (commercial-OK) instead of crashing.
- **Per-shot output ports** use `isDynamic:true` + `dynamicOutputPorts` on node data (mirrors `configureOpenRouterModel`) so `useIsValidConnection` resolves them and Send-to-motion can wire a shot into a `veo-3` first-frame input.
- **New `cinematic` category + `palette` param type** required extending the contract validators (`scripts/check-node-contracts.mjs`, `backend/tests/test_node_contracts.py`) and the model-reference generator (`scripts/generate-model-reference.mjs`) — extending the allowed sets, not weakening any shape rule. `docs/MODEL_REFERENCE.md` regenerated (107 nodes).
- **Inspector palette extraction is client-side k-means** (deterministic seeding, 96px downscale) per spec latitude; no backend `/api/cinema/extract-palette` endpoint was added.

**Orchestrator fix after the build (the one bug self-verification couldn't catch):**
- **Port-id mismatch**: frontend `shotPortId()` produced `shot_<id>` while the backend handler produced `shot-<id>`. Unit tests + `tsc` both passed because it's a cross-process string contract. Aligned the **backend** to `shot_<id>` (`backend/handlers/cinema_scene.py` `_output_port_id` + the `test_cinema_scene.py` assertions) — underscore matches the codebase's port-id convention (`video_in`, `first_frame_image`). Re-verified: 55 cinema tests + contract check green.

**Known gaps for the next (interactive) session — needs the live app:**
1. **In-Studio preview round-trip (verify live).** The handler writes finished shot URLs onto `node.params['scene'].shots[*].output` AND returns per-shot port outputs. Canvas per-shot ports + downstream wiring update via the normal executed-output mechanism; the *in-editor* preview reads `scene.shots[*].output.imageUrl`, which only refreshes when the backend re-pushes the node's params via `graphSync` after `cinema-scene` completes. Confirm the backend emits that graphSync (or have the Studio also read from `data.outputs[portId]`).
2. **Live base→color→look end-to-end** was only exercised with a **mocked** base model. Run a real `seedream-4-5`/`nano-banana` scene with character refs against live keys.
3. **Variations strip** is a single-slot placeholder (handler emits one image/shot); populate when multi-output lands.
4. **Send-to-motion** gives only an inline "Sent ✓"; the new `veo-3` node isn't visible until you exit the Studio — consider auto-exit or a toast.
5. **Offline node-create** falls back to `model-node` type for `cinema-scene` (same limitation as `remotion-node`); online graphSync assigns `cinemaSceneNode` correctly.
6. Pre-existing: `backend/.venv` `pytest` console-script has a stale shebang (points at the old `Documents/Projects` path) — run tests via `.venv/bin/python -m pytest`.

**Out of scope (next spec):** Looks/preset library + Studio "Looks" gallery; `soul-cinema` SKILL.md + Codex/Daedalus agent wiring; ffmpeg video film-look; trained-LoRA / PuLID identity modes.

**Smoke proof:** `docs/soul-cinema-smoke/` — 11 PNGs from a real Athens golden-hour still (color transfers, all 5 film presets, 2 full-pipeline grades). All deterministic, generated with no server.

### 2026-05-30 — Fix: named presets were being clobbered by neutral default sliders

First live test surfaced a real bug: a `cinema-look` node with `preset='kodak-portra'` produced a near-unchanged ("just darker") image. Root cause (found via systematic debugging, evidence-first):

- `cinema.look._resolve_params` correctly lets **explicit** float sliders override a preset (this is intentional — per-shot Studio overrides rely on it; `test_explicit_param_overrides_preset` pins it).
- BUT the node always carries its slider params (catalog defaults `grain 0.2 / halation 0.2 / vignette 0.25 / contrast 0 / saturation 0 / temperature 0`), and the frontend forwards them even though `visibleWhen` only *shows* them for `preset==='custom'`. Hiding a control doesn't remove its value.
- So `_build_look` forwarded those neutral defaults as if explicit → they overrode kodak-portra's grade (`temperature 0.18, contrast 0.12, saturation 0.08`) back to **0**, leaving only a uniform vignette darken. Channel evidence: buggy `R−18 G−17 B−15` (uniform darken, no colour) vs correct preset-only `R−2 G−9 B−19` (warm R-vs-B separation).

**Fix at the build sites (intent is known there), not the pillar:**
- `backend/handlers/cinema_look.py::_build_look` — when `preset in PRESETS` (a real named preset), do **not** forward the float sliders; the preset's own bundle stands. `'custom'`/unset still forwards sliders. LUT always honored. (+5 regression tests in `test_cinema_look.py`, red→green; the existing pillar override test still passes.)
- `frontend/.../CinemaSharedControls.tsx` — selecting a preset chip now calls `selectPreset()` which sets `look = { preset: id }` (drops neutral sliders); `'custom'` restores editable sliders. Required making the `CinemaSceneSpec.look` slider fields **optional** (`types/index.ts`) — semantically correct: a named-preset look omits sliders, matching the backend "missing → use preset" behavior.

**Gotcha for re-testing:** `cinema-color`/`cinema-look` are deterministic and cached (`services/cache.py` `ExecutionCache`, in-memory). Re-running a node with identical params returns the cached result — switch the preset (or restart the backend, which clears the cache) to see a fresh render. Also: running a node re-executes its whole subgraph, so re-running a `cinema-look` wired off a `gpt-image-2` node will re-generate the (paid) base image; wire film-look off a static image-input to iterate for free.

**Follow-up (not done, user's call):** the node/scene default preset is `'custom'` (subtle grain+vignette, no colour) — consider defaulting to a named preset like `kodak-portra` so a freshly-dropped node obviously "does the film thing."

### 2026-05-30 — Canvas ↔ Studio parity for character refs

User principle: "what happens in the node view should happen in all views and vice versa." Gap found while testing: an image wired into the `cinema-scene` node's `character_refs` port on the canvas was used by generation (the handler reads `inputs['character_refs']`) but was **invisible** in the Studio's CHARACTER REFS box (which only rendered uploaded `scene.character.refImageUrls`).

- `CinemaStudioView` now resolves canvas edges into the node's `character_refs` port to image URLs (robust to both a generated source — `data.outputs[handle].value` — and a static `image-input` — `data.params._previewUrl`/`filePath`, whose `outputs` may be empty until run) and passes them to `CinemaSharedControls`.
- `CinemaSharedControls` renders connected refs read-only with a 🔗 badge (disconnect on the canvas to remove); uploaded refs keep their × remove button.
- Reverse direction: `CinemaSceneNode`'s card summary now shows the uploaded-ref count (`2 shots · 1 ref`), so refs added inside the Studio are reflected on the canvas (connected refs already show as the edge).
- Verified live: constructed `image-input → cinema-scene:character_refs` via the API and ran the exact resolution logic against `/api/graph/export` → resolved the ref URL; tsc + vite build clean.

### 2026-05-30 — Krea 2 direct provider plan

- Created branch `codex/krea-2-direct-provider` from the current dirty `main` state as requested; unrelated existing worktree changes are being left untouched.
- Scope decision: implement Krea direct API only. FAL Krea endpoints are intentionally skipped for this goal even though they exist, because Krea-native style IDs, moodboards, assets, and style training are not covered equivalently by the generic FAL node.
- Node-family decision: add one main `krea-2-generate` node plus Krea resource wrapper/training/search nodes. This keeps simple prompt-to-image easy while allowing graph-native use of `image_style_references`, `moodboards`, and `styles`.
- Moodboard limitation: verified Krea docs expose moodboard use by ID but no public create/list moodboard endpoints, so Nebula will model moodboards as existing-ID wrapper nodes and direct fallback params.
- Asset handling decision: local or generated images connected as Krea style references will be uploaded internally via `POST /assets`; users should not have to paste URLs for normal graph workflows.
- Shipped direct Krea implementation: `krea-2-generate`, `krea-image-style-reference`, `krea-style`, `krea-moodboard`, `krea-style-search`, and `krea-style-train`.
- `krea-2-generate` accepts raw image style inputs and typed Krea resource objects together; the handler merges them into Krea's documented `image_style_references`, `styles`, and `moodboards` request fields, enforcing max 10 image refs and max 1 moodboard.
- Style training uploads local graph images to Krea assets before calling `/styles/train`, polls `/jobs/{id}`, emits a reusable style object, and optionally shares the style with the API workspace.
- Verification: Krea handler tests, node registry/contract tests, Codex skill bootstrap tests, full backend suite (`827 passed`), frontend production build, and `git diff --check` all passed. No live Krea smoke was run because no `KREA_API_TOKEN` was available in this session.

### 2026-05-31 — Krea agent skill

- Added/expanded the project-local Krea agent skill at `.agents/skills/krea/SKILL.md` so Codex/Daedalus agents know the direct-Krea node IDs, graph wiring patterns, resource wrapper shapes, API key naming, and Krea-specific live-test caveats.
- Kept the skill as one concise `SKILL.md` rather than adding extra docs, because detailed provider research already lives in `docs/model-providers/krea/krea-2.md` and skills should stay lightweight.
- Included the `402` API-balance caveat from live testing: a valid Krea token can authenticate and still fail generation until the separate API balance is topped up.

### 2026-05-31 — Native Moodboard Studio

- User chose Nebula-native moodboards rather than Krea-owned moodboards. Decision: make Moodboard a first-class Nebula resource and port type; Krea is only a downstream adapter.
- First canvas mirror is a custom `nebula-moodboard` node/card with grouped visual state and multiple outputs (`Moodboard`, style brief, negative prompt, images, palette). True React Flow parent/child grouping is deferred because the current graph persistence path does not carry parentId/extent/group metadata.
- Analysis starts as deterministic local extraction: resolve Nebula-local images, extract palettes with the existing CIELAB k-means code, and produce an editable creative-direction object. The schema is intentionally richer than the local analyzer can fully populate so a future vision-model analyzer can fill materials, motifs, and semantic cues without changing stored resources.
- Krea integration consumes native Moodboards by adapting representative images to `image_style_references` and appending the extracted style brief to the prompt. We still keep Krea-owned moodboard IDs as their own `krea-moodboard` wrapper because Krea does not expose public create/list moodboard endpoints.
- Browser smoke used the existing local backend (`127.0.0.1:8000`) and Nebula Vite dev server (`127.0.0.1:5180`) in Chrome. A temporary "Smoke Moodboard" verified library listing, Studio loading, canvas node mirroring, and Analyze output; the temporary moodboard, canvas nodes, and generated test image were removed afterward.
- Follow-up fix: the Studio "Add Images" action no longer relies on a script-triggered `.click()` against a hidden file input. It is now a native file input inside the visible label with the input layered above the styled text, so normal mouse clicks hit browser-native file picker behavior. Drag/drop still uses the same upload path.

### 2026-06-03 — Surface-hardening sweep (lands on `main`)

- **Dead code:** removed two stale Finder "Add Copy" duplicates — `CinemaStudioView 2.tsx` and `CinemaSceneNode 2.tsx`. Both were untracked, older-and-smaller copies; `diff` confirmed each held nothing the real file lacked (`CinemaSceneNode 2.tsx` predated the `refCount` card summary). Repo now has zero `* 2.*` artifacts. Untracked → deletion leaves no git diff, so the work shows only as the files' absence.
- **Real bug surfaced by a lint audit (`TimelineRuler.tsx`):** a *bare* `react-hooks/exhaustive-deps` disable was masking a defect. The thumbnail effect keyed on `[sourceUrl, sourceDuration]`, but its sample set derives from `stepCount` (← `totalOutputDuration`), and `Timeline.tsx` mounts the ruler without a `key`. So editing clips (which changes output duration) shifted the sample times without re-running the effect → placeholder thumbnails. Fix: add `stepCount` to deps. Safe because `getThumbnail` (`lib/editor/thumbnailStrip.ts`) caches by `sourceUrl|time|width`, so a re-sync only fetches genuinely-new times (≤13, capped). Kept the disable (the true dep is the `sourceStepTimes` array, fresh each render) but replaced the bare suppression with a justification comment. Shipped as commit `5647fb7`.
- **Discipline — distinguish "intentional suppression" from "hidden bug":** of the disables a grep flagged as bare, the two `CharacterStudioView` ones were already justified, `MoodboardStudioView`'s loader disable was correct-but-undocumented (got a comment mirroring its Character twin), and only `TimelineRuler`'s was an actual bug. The right move was reading each effect, not papering every disable with a "looks intentional" comment — that would have buried the real defect.
- **Cruft:** dropped a leftover `console.log('[zoom-manifest] init', data)` in `useZoomManifest.ts`. Removing only the log line would orphan the `data` param (→ `no-unused-vars`), so the init call was collapsed to fire-and-forget and the now-vestigial `cancelled` flag removed.
- **Surface otherwise clean:** 0 `as any` / `@ts-ignore` / real `: any`; the ~55 `console.*` calls are deliberate `warn`/`error` in catch handlers; gates green (eslint, `tsc -b`, 322/322 vitest).
- **Process gotcha (shared working tree):** this spanned a live branch. A concurrent session merged `chore/harden-surface` into `main`, deleted the branch, and kept committing to `main` — all in the *same* working tree (it switched this tree's HEAD out from under me). My fix landed on `main` because I checked the HEAD commit but not the branch *name* before committing. Kept on `main` per user (matches the now-trunk-based flow). Lesson: re-verify `git branch --show-current` immediately before committing when a tree may be shared, and isolate parallel work in a `git worktree` rather than switching the shared tree's branch.

### 2026-06-03 — Create P4 polish (branch `feat/create-p4-polish`)

Two features + a post-review hardening pass. All on `feat/create-p4-polish`, not yet merged.

- **Concurrent generations (commit `4b5f08e`):** the Create view can run up to 2 generations at once. Key decision: the global `isExecuting` lock (which Canvas/Toolbar/Inspector rely on for one-at-a-time canvas Run) is left *completely untouched*. New `executeClusterConcurrent(nodeIds)` in `graphStore.ts` is a sibling of `executeCluster` that never reads/sets `isExecuting` and never calls global `resetExecution` — it marks only its own idSet `queued`, POSTs the cluster, and errors only its own nodes on failure. The cap is enforced *Create-locally* (`MAX_CONCURRENT = 2`) via an `activeCount` derived from node states. Layout Y uses a synchronous `genIndexRef` counter (not `generations.length`, which is stale across rapid fires under React batching).
- **Real preset thumbnails (commit `81bba74`):** chose "generate once via the app, commit WebPs" over first-run generation or static placeholders (user's call — it reverses the earlier P3 "no shipped binaries" stance, but the binaries are tiny). `scripts/generate_preset_thumbnails.py` dogfoods `POST /api/quick` (nano-banana) for each of the 12 seed prompts, downscales to 640px WebP (q82, ~6–81 KB each, ~520 KB total), writes `data/presets/thumbnails/<slug>.webp`. `slug_for_preset()` lives in `preset_store.py` as the single source of truth shared by the generator (filename) and the seeder (URL) so they can't drift. Served by a new `GET /api/presets/thumbnails/{slug}` (slug regex + resolve/relative_to traversal guard, `FileResponse`). `backfill_preset_thumbnails()` runs every boot to fix installs seeded before thumbnails existed.
  - *Gotcha during generation:* `/api/quick` returns the output as an **absolute filesystem path**, not a `/api/outputs/...` URL — the first run silently 404'd on download because I built `http://localhost:8000<abspath>`. Fix: read absolute-path refs straight from disk. (The 12 generations had actually succeeded; only the download leg failed.)

- **Post-review fixes (commit `[pending]`):** a code-review pass flagged 4 issues; 3 fixed, 1 deferred.
  - *Fixed — thumbnail URL resolution (the important one):* generated media render through `backendAssetUrlSync` (rewrites `/api/outputs/` → the *discovered* backend origin), but seeded thumbnails were left as relative `/api/presets/thumbnails/...` and only worked in dev by accident (Vite proxy → :8000). They'd 404 whenever the backend isn't same-origin/on-8000 (packaged shell, alt port), with the `onError` gradient masking the failure. Fix: generalized `backendAssetUrlSync`/`isLocalBackendAssetUrl` to a `BACKEND_ASSET_PREFIXES` list covering both `/api/outputs/` and `/api/presets/thumbnails/`; `PresetCard` now resolves `preset.thumbnail` through it.
  - *Fixed — concurrency cap TOCTOU:* `activeCount` can't see a new generation's nodes until they're in the store, so a rapid second click could pass the cap during the `authorGenerationCluster` await. Added a synchronous `launchingRef` counter; the cap gates on `activeCount + launchingRef.current`. (Residual: a sub-render-cycle staleness window remains if `activeCount` lags by a full unit with exact timing — bounded and harmless since the backend handles disjoint node sets; the dominant network-RTT window is closed.)
  - *Fixed — backfill clobber:* backfill matched seeded presets by name and overwrote any thumbnail that differed from the shipped URL — so a user's *global* preset that happened to share a seed name + a custom captured thumbnail would be silently overwritten every boot. Fix: only fill *empty* thumbnails (`if preset.get("thumbnail"): continue`). Also naturally idempotent (post-fill it's non-empty → skipped, no version churn).
  - *Deferred — `graphComplete` clears the global lock unconditionally (KNOWN LIMITATION):* `handleExecutionEvent`'s `graphComplete` case does `set({ isExecuting: false })` regardless of which run emitted it. Since `executeClusterConcurrent` never *sets* the lock, a concurrent Create generation finishing will now *clear* a lock that a canvas Run set — but only if the two overlap (start a canvas Run, switch to Create, generate). Consequence is an early lock release (a second canvas Run could overlap), not data corruption (backend runs are independent per disjoint node sets). A correct fix needs backend run-scoped events (`run_id` on each `ExecutionEvent`, frontend clears only the matching run) — that's a real change to the engine + event types + WS handling, out of scope for this polish pass. Flagged to the user as a follow-up rather than bolting on a fragile attribution-less counter.

- **Gates:** backend `887 passed`; frontend `tsc` clean, `331` vitest (42 files), lint (inline-style + slava-scope + eslint) clean, build clean. Node-def contracts untouched (no node-def changes in P4).

### 2026-06-03 — Image lightbox (same branch, follow-up to user feedback)

User asked to click a result image and see it fullscreen. Added a `Lightbox` component to the Create results gallery.

- **Component:** `Lightbox.tsx` renders into `document.body` via `createPortal` (so it sits above the canvas + every panel; `body` carries `app-slava-restraint`, so the scoped CSS still matches). Closes on Esc / backdrop click / X; `←/→` (and edge chevrons) step through the gallery's viewable items; a "n / N" counter; body scroll locked via a `lightbox-open` class (not an inline style — keeps the `check:inline-styles` guard happy). Clicking the media `__stage` stops propagation so it doesn't close.
- **What's zoomable:** `firstViewableMedia(node)` in `createGallery.ts` (the single source for "what would the lightbox show") returns the completed node's Video (preferred) or Image/SVG, else null — mirroring OutputRenderer's order. `ResultsGallery` builds a `viewable[]` in card order so a clicked card maps to a lightbox index and the arrows step through exactly what's on screen; switching the Session/Canvas tab closes the lightbox (the viewable set changes).
- **Affordances (`ResultCard`):** images get a full-area transparent overlay button (`zoom-in` cursor) so a click anywhere opens the lightbox; **video gets only a corner expand button** (not a full overlay) so the native video controls stay usable. The overlay sits at `z-index:1`; the actions bar was bumped to `z-index:2` so Download/Delete/etc. stay clickable over it.
- **Tests:** `firstViewableMedia` (6 cases incl. video-precedence, SVG-as-image, object `{url}`, not-complete → null); `Lightbox` (image/video render, Esc/backdrop/stage-click, arrow nav + prev hidden at index 0, scroll-lock on/off); `ResultCard` (image → overlay+btn, video → btn only, text/incomplete → neither). Frontend now `347` vitest (44 files); lint + build clean.

### 2026-06-08 — Replicate SSE token streaming (audit gap #2)

Closes the "Replicate real-time streaming (urls.stream)" capability gap. Text/LLM models on Replicate now stream token deltas live in the UI; image/video/audio/mesh models are unchanged (poll as before). **Frontend: zero changes** — the `StreamDeltaEvent → _event_to_camel → streamDelta → node.data.streamingText` pipeline already existed for the chat nodes; only the Replicate handler had to learn to consume the stream.

**Decisions / non-obvious calls:**
- **Auto-detect, no user toggle.** Replicate's own model is "the prediction response carries `urls.stream` iff the model streams" (the legacy `stream: true` request flag is deprecated). So the handler streams when `urls.stream` is present AND an `emit` is wired, else polls. No new node, no new param, no node-def change → contract parity untouched.
- **A dedicated raw-text SSE consumer (`stream_execute_replicate`), NOT the existing `stream_execute`.** Replicate `output` events carry RAW TEXT in `data:` (a token delta); Anthropic/OpenAI/OpenRouter carry JSON. Reusing the JSON path (`json.loads(data)`) would silently drop every non-JSON token. The new consumer concatenates `output` data verbatim (joining multi-`data:`-line events with `\n` per the SSE spec), raises on `error` (surfacing JSON `detail`), and stops on `done`. The existing JSON `stream_execute` is untouched (chat-stream tests stay green). Regression-guarded by a test that feeds `{not valid json` and asserts it's taken verbatim.
- **Handler self-submits; extracted `poll_until_terminal` from `async_poll_execute`.** To inspect `urls.stream` you must create the prediction first — but you can't double-submit. So `async_poll_execute` was split into submit + a public `poll_until_terminal(client, config, task_id, …)` (behavior-preserving; guarded by the existing 15 async-poll/Runway/Replicate tests). The handler now POSTs once, then either streams or calls `poll_until_terminal` on its own client. This rewrote the 5 old replicate tests that mocked `async_poll_execute` (they encoded the old delegate-everything design) into httpx-level tests of the real submit→stream/poll flow. Note: `patch("handlers.replicate_universal.httpx.AsyncClient")` patches the shared `httpx` module singleton, so it also covers the runner's client — convenient for the non-stream tests.
- **Cancel propagation on the streaming branch.** `CancelledError` mid-stream schedules a detached `POST .../predictions/{id}/cancel` (reusing `_cancel_async_poll` + `schedule_detached_cancel`) before re-raising, matching the polling path's upstream-cancel so a cancelled stream doesn't leak a running (billable) prediction.
- **Honest scope:** this helps only Replicate *language-model* nodes — a minority of Nebula's Replicate usage. It's UX polish for text gen, not a broad capability. The SSE 30s idle reconnect (`:408` keepalive / `Last-Event-ID`) is NOT implemented; long-idle generations could truncate — documented as a known limitation, deferrable since v1 targets normal-cadence text gen.

**Verification:** backend `pytest` **927 passed** (was 918 + 9 new replicate/stream-consumer tests, 0 regressions). **Live-verified** against the real Replicate API (`meta/meta-llama-3-8b-instruct`, key loaded from `settings.json`, never printed): a 220-token generation produced **46 delta events over a 2.23s span, time-to-first-token 0.84s, spread across 38 distinct 50ms windows** — genuinely incremental token streaming through the real handler, not a buffered burst. Accumulated text verified as a monotonic prefix; final output routed to the `text` port.

### 2026-06-08 — Veo video extension (audio gap #5), and why reference images were dropped

Closes the "Veo extension" half of gap #5. The `veo-3` node (Google direct path, `backend/handlers/veo.py`) gained a `video` ("Extend Video") input + a `source_uri` output so a clip can be continued in-graph. **Reference images ("ingredients to video") were implemented per the canonical docs, then REMOVED after live testing proved the public API doesn't support them on this key.** This entry is mostly a record of how live verification overturned the docs research — twice.

**What the docs said vs. what the live API does (key loaded from `settings.json`, never printed):**
- **Billing:** metadata probe (models.list) only proved the key *sees* Veo. The first real generation confirmed the project has **paid-tier billing** — text→video succeeded (32s, 2.5 MB). Not a blocker after all.
- **Reference images — docs WRONG twice.** (1) The canonical example nests bytes under `image.inlineData`; live API → **400 "`inlineData` isn't supported by this model."** Switched to the `bytesBase64Encoded` shape the first/last-frame fields already use. (2) That got past the shape error into **400 "Your use case is currently not supported"** — on BOTH `veo-3.1-generate-preview` AND `veo-3.1-fast-generate-preview`. So "ingredients to video" is simply not enabled on the public Gemini API for this AI-Studio key, regardless of request shape. **Decision: remove the `reference_images` port entirely** rather than ship a port that always 400s (shipping-broken = worse than not-shipping). A code comment + the gemini skill document the exact shape to re-add if Google enables the use case.
- **Extension — docs' "biggest risk" materialized, but a working path exists.** The realistic in-graph path (upload a local/downloaded clip via the Files API, pass as `video.uri`) is **rejected: 400 "Input video must be a video that was generated by VEO that has been processed."** Veo only accepts the **original generation's** `files/...` URI, not re-uploaded bytes — even bytes that Veo itself generated. The Files-API-upload path is dead; **removed `_upload_video_to_files`/`_resolve_video_bytes`.** Passing a base generation's own `video.uri` **directly** works (live-verified).

**Design that makes extension usable in-graph:** Nebula downloads + discards the Veo `files/...` URI today, so a downstream node had nothing to extend. Fix: `handle_veo` now also returns `source_uri` (the generation's `files/...` URI) as a second `Video`-typed output. Wire **upstream `veo-3.source_uri` → downstream `veo-3.video`** to continue a clip. The handler accepts only a `files/...` URI on the `video` input (else a `ValueError` tells the user to wire `source_uri`, not the downloaded `video` output). Guards: extension is `veo-3.0`/`3.1` generate+fast only (not lite/veo-2.0), can't combine with `image`/`last_frame`, and `resolution` is force-overridden to **720p** (the API locks extension to 720p). Source URI is valid ~2 days (already noted in the skill).

**Decisions / non-obvious calls:**
- `source_uri` is typed `Video` (not `Text`) so the edge validates straight into the `Extend Video` (`Video`) input; the value it carries is the URI string, which the handler detects by the `generativelanguage.googleapis.com/.../files/` pattern.
- The node now has two `Video` outputs (`video` = downloaded file for normal downstream use; `source_uri` = the extend handle). Labels disambiguate; wiring the wrong one fails with a clear message.
- Reference-image guards/sets (`VEO_REFERENCE_MODELS`, `_image_to_inline_data`) were added then removed in the same session — the git diff won't show them, but they're why the `bytesBase64Encoded`-vs-`inlineData` lesson is recorded here.

**Verification:** backend `pytest` **935 passed** (+8 veo tests, 0 regressions); `check-node-contracts --check` green for **123** node defs (node_definitions.json ↔ frontend nodeDefinitions.ts in sync; `MODEL_REFERENCE.md` regenerated). **Live end-to-end through the SHIPPED handlers:** `handle_veo(base)` returned a clip + `source_uri`; feeding that `source_uri` into `handle_veo(extend)` produced a continued 2.8 MB clip. Reference-image generation confirmed rejected on both 3.1 models (the reason it's not shipped). ~6 paid Veo generations total during verification.

### 2026-06-08 — Review-caught fixes for gaps #2 + #5 (adversarial review pass)

A 16-agent adversarial review (3 dimensions → per-finding verify) surfaced 13 findings, 12 confirmed. Fixed the substantive ones; the trivial/by-design ones are documented. Final: **940 backend tests** (+5), contract green (123), frontend `tsc` clean.

- **Replicate SSE abnormal-close robustness (the one that mattered, medium).** The consumer returned silently-**truncated** text as a *success* if the stream closed before `done` (idle timeout / dropped connection), and swallowed a bare `error` event (no `data:` line). Rewrote the dispatch: a buffered event now flushes at **every** boundary (blank line, next `event:` line, or end-of-stream), a bare `error` raises, and a premature close (no `done`) **fails loud** instead of reporting partial text. Emitted deltas still surface live before the failure. RED→GREEN with 5 new tests (multi-line `data:` join, `id:`/`:`-comment skip, premature-close-raises, trailing-output-flush, bare-error-raises).
- **Replicate `task_id` fail-fast (low).** Self-submit used `submit_data.get("id")` → `"None"` on a malformed 2xx submit (the old `async_poll_execute` path raised via `_get_nested`). Restored fail-fast with an explicit guard.
- **Cancel-test warning (low).** `_cancel_async_poll` was auto-mocked as AsyncMock, so the test's lambda built an un-awaited coroutine (`RuntimeWarning`). Patched it as `MagicMock` — warning gone (suite warnings 3→2; the remaining 2 are pre-existing in `test_async_poll_runner`).
- **Veo `source_uri` ordering guard (low).** The frontend video preview picks the first `Video`-typed output by insertion order; added a test pinning `video` before `source_uri` so a refactor can't silently make the preview select the auth-gated API URL.
- **Doc sync — `veo.md` skill topic file (medium).** It still showed reference images as usable and extension wiring as "feed via a Video port." Added a ⚠️ "NOT EXPOSED IN NEBULA" caveat over the reference-images section and corrected the extension note to `source_uri → Extend Video`. Synced both copies (`.claude/` + `.agents/`).
- **By-design, documented (not changed): `source_uri` is `Video`-typed but carries an auth-gated `files/...` URI.** It must be `Video` so the edge validates into the `Extend Video` (Video) input; wiring it into a *non-Veo* Video sink fails confusingly (401/file-not-found). Mitigated by the port label ("Source URI") + `_note`, and the ordering guard keeps the node's own preview on the playable `video` output. A dedicated `VideoRef` port subtype (frontend `portCompatibility` + colors) is the clean long-term fix — deferred as it's a deliberate mis-wire of a clearly-labeled port, not a main-path bug.
- **Deferred (low, documented limitation): no SSE `Last-Event-ID` reconnect** for Replicate's 30 s idle gap — a long idle now fails loud (above) rather than truncating silently, which is the safe behavior; true reconnect is a follow-up.

### 2026-07-22 — Run-scoped execution lifecycle events

- **Goal selection:** the next autonomous pass is the documented Create/Canvas concurrency race: a `graphComplete` from `executeClusterConcurrent` can currently clear the global Canvas `isExecuting` lock and close the wrong run-history record. Finishing the remaining provider audit would require paid calls and additional credentials, so it is not the next fully autonomous goal without a spend decision.
- **Contract:** every frontend-started graph, node, concurrent Create, and Cinema-shot execution gets a UUID `runId`. The backend accepts it on the request and includes it on all execution WebSocket events. Events without a `runId` remain supported for CLI/legacy callers.
- **Async propagation:** handler-emitted progress/stream events bypass the engine's direct `emit` callback, so tagging only the engine's own event constructors would be incomplete. The backend uses a task-local `ContextVar` while an execution is active and resolves the current `runId` during WebSocket serialization; explicit validation events carry it directly because they occur before `execute_graph` starts.
- **Frontend ownership:** node state updates still apply for all events, but only a lifecycle event whose `runId` matches the active global Canvas run may clear `isExecuting` or close its history record. Concurrent Create/Cinema completions can still notify and clean their own error bookkeeping without touching the global lock. Missing `runId` preserves the prior single-run behavior for backwards compatibility.
- **Verification:** backend `1167 passed` with the same two existing AsyncMock warnings; frontend `397 passed`, lint, TypeScript, and production build passed. The build retains its existing `lottie-web` direct-eval and large-chunk warnings. No paid provider call ran.

### 2026-07-22 — Hunyuan3D contract and freshness pass

- **Goal selection:** Phase 2 provider auditing remains the repository's explicit next milestone, but the complete remaining matrix includes paid live calls. Hunyuan3D is a bounded two-node FAL slice whose live schemas, request bodies, and output contract can be fully reverified without inference spend.
- **Canonical finding:** the live FAL v3 schemas still match Nebula's endpoint, port, parameter, and output mappings. They expose `seed` in the response only, not as an accepted input. The older provider note and image-to-3D skill incorrectly described it as a missing reproducibility knob; both skill mirrors and the audit note are corrected.
- **Runtime hardening:** the fixed Hunyuan wrappers now route through an isolated `GraphNode` copy instead of mutating persisted params with `endpoint_id`. Text-to-3D also rejects prompts over FAL's documented 1024-character maximum before queue submission.
- **Parity scope:** add one gold exemplar covering both nodes plus separate text and four-view image golden request fixtures. Fixture capture runs through the real registry wrappers and FAL universal body builder; no provider request or paid generation is made.

### 2026-07-23 — Final video and Remotion export

- **One lifecycle for both editor surfaces:** final exports run as cancellable, in-memory jobs with `POST` to start, `GET /api/render-jobs/{id}` to poll, and `DELETE` to cancel. This gives the UI truthful progress/cancel/download behavior without pretending the existing fire-and-forget graph execution endpoint can cancel a child encoder.
- **Video Editor formats:** the final renderer reuses `_build_filter_complex` for MP4/H.264, MOV/ProRes 422 HQ, WebM/VP9, and animated GIF. Resolution presets are Source, 1080p, 720p, and 480p; quality presets map to CRF for H.264/VP9 and are intentionally disabled for ProRes/GIF. GIF drops audio at filter construction so it cannot leave an unconnected audio output.
- **Remotion parity contract:** a dedicated Node worker bundles the same `RemotionComposition` the Player imports. One unchanged `inputProps = {manifest}` object goes to both `selectComposition()` and `renderMedia()`, and a shared `compositionDurationInFrames()` function controls Player and renderer duration. Running `remotion-node` now produces a real H.264 MP4 instead of echoing a null video.
- **Cancellation:** ffmpeg and Remotion subprocess wrappers terminate their child process and delete partial output on `CancelledError`. The Remotion worker also connects SIGTERM/SIGINT to `makeCancelSignal()`.
- **Dependency/security decision:** enabling server rendering required `@remotion/renderer` and `@remotion/bundler`. The original 4.0.458 family exposed current `ws`/bundler advisories; 4.0.464 cleared the first range but not later advisories. The full Remotion family was aligned to exact 4.0.479, published 2026-06-17 and therefore outside the 14-day quarantine. `npm audit` then reported zero findings.
- **License boundary:** official Remotion material checked 2026-07-23 says individuals and companies up to three people may use the free license; collaborations/companies of four or more require a Company License. Nebula documents but does not enforce or procure that license.
- **Empirical proof:** a real text-manifest render produced a 5.056 s, 1280×720, 30 fps H.264/AAC MP4. A synthetic one-second source produced valid 854×480 outputs in H.264/AAC MP4, ProRes/PCM MOV, VP9/Opus WebM, and GIF. No provider API or paid call ran.
- **Graph persistence fix found during UI QA:** `video-edit` and `remotion-node` previously kept `clips`/source metadata and `manifest` under undeclared params, so the standard POST/PUT graph API rejected exact editor state. Those runtime fields are now declared as hidden params, following the existing Cinema `scene` pattern, with create/update/reload regression tests.
- **Live app proof on Remotion 4.0.479:** drove the real Vite app against the local backend using the already-generated three-second Gemini clip. A 1080p WebM completed with a download action and ffprobe confirmed VP9/Opus at 1920×1080. A repeated 60.2 s local timeline showed 1% progress, cancelled through the UI, and left no partial file. A persisted one-layer text manifest then rendered through the UI to a 5.056 s H.264/AAC MP4 at 1280×720 and 30 fps; a sampled frame visibly contained the exact `NEBULA EXPORT QA` manifest text. Temporary nodes, outputs, and the test edge were removed afterward, restoring the original eight-node canvas.
- **Review-caught lifecycle fix:** the first popover toggle reset its local job reference whenever it closed. Closing during a render could therefore orphan a still-running encoder. Closing now preserves job ownership and polling; completed jobs expose an explicit New export/New render reset action. A toolbar regression test pins the running-close and completed-reset behavior.
- **Full validation:** backend `1197 passed` with the same two existing AsyncMock warnings; frontend `402 passed`, lint, TypeScript, production build, 142-definition node contracts, generated reference, `git diff --check`, and `npm audit` passed. The existing build warnings remain for `lottie-web` direct `eval` and large chunks.
- **Non-gating harness finding:** `scripts/check-utility-nodes.mjs` repeatedly timed out after the backend logged its unrelated pure-utility graph as completed. This slice does not touch the execution-event/store paths that harness exercises, and the backend/frontend unit suites covering those paths pass. The failure remains an explicit follow-up for the run-history slice rather than an export change hidden in this PR.

### 2026-07-23 — Persistent run history and exact replay

- **Persistence boundary:** the newest 100 Canvas graph, single-node, and selection runs are stored in browser `localStorage` under a versioned envelope. Concurrent Create generations and Cinema shot jobs retain their existing independent lifecycle and are not forced into the single global Canvas history lock.
- **Exact replay contract:** every history record stores the JSON-cloned, deeply frozen request graph after network-boundary normalization. This matters for `video-edit`, whose derived clip speed is part of the backend request. Single-node records additionally retain `targetNodeId`; replay calls `/api/execute-node` with that original target, while graph/selection records call `/api/execute` with their original snapshot. Replaying never replaces or rewinds the live canvas.
- **Reload recovery:** a page reload cannot reconnect to an in-flight backend task, so persisted `running` records recover as `cancelled`. Malformed individual records are dropped and the remainder is rewritten; invalid JSON or an invalid storage envelope is removed. Storage access, quota, and privacy-mode errors are non-fatal.
- **Run isolation:** replay always receives a new UUID and records `sourceRunId` plus `replayAction`. Scoped stale completion events from the source run cannot close the new replay. Matching node IDs on the current canvas still show execution state, but the request payload comes exclusively from saved data.
- **Actions:** complete/cancelled rows show `Rerun`, failed rows show `Retry failed`, and the existing header clear action now removes both in-memory and persisted history. Replay actions are disabled while another global Canvas run owns the execution lock.
- **Carried utility harness timeout resolved:** the browser smoke graph still used nonexistent `/tmp/image-a.png` and `/tmp/image-b.png` placeholders. The newer image-input source guard correctly failed those nodes, leaving downstream image utilities idle while the harness only reported a generic timeout. The harness now uses tracked image/video fixtures, prints node state on timeout, fits all seeded nodes into view, and executes through `graphStore.executeGraph()` instead of bypassing the store with a raw fetch. That live-checks run-ID correlation plus history snapshot open/close, mutates the canvas and reruns the saved 17-node/14-edge snapshot, then reloads the page and confirms both completed records, replay lineage, and original `Alpha` params persist. Nested array outputs retain backend filesystem refs while top-level image outputs are rewritten to `/api/outputs/...`, so assertions compare output identities by filename across that intentional representation boundary.

### 2026-08-18 — Seven-defect adversarial reliability pass

- **Ownership boundary:** `backend/main.py` and `frontend/src/store/graphStore.ts` already contained user-owned QC node mappings. All edits were applied around those mappings and the original diff was preserved.
- **Run-scoped output decision:** handlers keep the stable `get_run_dir()` API, but the engine now binds one collision-proof directory through a `ContextVar`. Async child tasks inherit it, avoiding a risky rewrite across every provider handler. Standalone callers still receive a unique directory per call.
- **Manifest boundary:** manifests are provenance, not request archives. Private keys are omitted, credential-like keys are redacted, embedded data/binary values are replaced, and collections/strings/depth are bounded at `write_manifest()` so direct callers and `/meta` share the same safety boundary.
- **Cache policy:** only Nebula-owned local artifacts are existence-gated. Remote/data/blob values and external absolute paths are not treated as cache-owned files; `/api/outputs/...` and absolute paths beneath `OUTPUT_ROOT` must still exist or the entry is evicted.
- **Graph ingress decision:** imports and additive clusters mutate a persistence-free `CLIGraph` candidate. Node definitions, param shapes/coercion, references, handles, duplicates, and cycles are validated before one `replace_with()` call persists. Invalid requests neither broadcast nor alter the live graph. The file-import UI also keeps its current canvas until the backend returns the validated replacement.
- **Cancellation contract:** frontend-started graph tasks are retained by run ID. `DELETE /api/executions/{runId}` is idempotent, parent cancellation cancels and awaits engine node tasks (allowing existing provider `CancelledError` hooks to fire), `graphCancelled` closes the matching UI history, and both backend and frontend suppress late post-cancel events.
- **Telemetry decision:** demo zoom telemetry is a persisted, explicit opt-in (`zoomTelemetryEnabled`, default false). Both backend endpoints enforce the gate. Enabled sessions use unique archive-eligible directories under configured `OUTPUT_ROOT`; the old top-level hard-coded files are no longer created.
- **Adversarial findings fixed during the pass:** macOS `/var` vs `/private/var` resolution initially excluded valid run files from manifests; the new output directory suffix initially fell outside the archive regex; and the frontend import flow initially cleared local state before backend validation. Each now has a regression or direct contract check.
- **Final verification:** focused combined backend regressions passed, then the available full backend suite passed `1510` tests with the two pre-existing `test_async_poll_runner` AsyncMock warnings. Full collection still stops at the user-owned Video QC suite because this checkout's `backend/.venv` lacks `cv2`; no dependency installation was attempted. Frontend passed `440` tests across `55` files, TypeScript/production build, lint with zero errors, and the `172`-definition node contract. `git diff --check`, changed-Python compilation, a credential-pattern scan, and explicit QC-mapping preservation checks passed. Existing non-gating warnings remain: one `ReferenceSetNode` hook warning, Lottie's direct `eval`, and large Vite chunks.

### 2026-08-18 — Complete audit refresh and live UI pass

- **Live-browser boundary:** the sandbox denied a standalone Python/uvicorn listener, so a temporary Vite-owned ASGI bridge was used only to render the real frontend against the real FastAPI app. It used isolated graph/output roots, was removed after capture, and the original Vite proxy configuration was restored before the final build.
- **Interaction classification:** the browser automation layer could move the pointer but could not carry Nebula's custom `application/nebula-node` HTML drag payload. That automated drop failure is not classified as a product defect; pointer graph authoring remains a manual-browser ceiling.
- **New UI defects:** Run History defaults to `x=-340px` and Reset does not recover it; Nodes and Assets can be simultaneously active with overlapping left-column geometry; Create concatenates FAL and direct params, giving Veo 3.1 duplicate `seed` controls and a React duplicate-key error; node-library definitions are unfocusable drag-only `<div>` elements, so keyboard-only users cannot author a graph.
- **QC environment:** `backend/.venv` still lacks declared OpenCV/scikit-image packages, but the existing Miniconda Python 3.12 environment has them. The actual full backend suite therefore ran successfully there: `1528 passed` with the same two pre-existing AsyncMock warnings. The focused reliability/QC/cancellation slice passed `88` tests.
- **Final verification:** frontend `440` tests, lint (zero errors, one existing hook warning), production build, the `172`-definition node contract, backend `1528` tests, focused backend `88` tests, and `git diff --check` passed. No provider generation or account-consuming agent turn was submitted.

### 2026-08-18 — Live UI defect closure and adversarial follow-up

- **Run History geometry:** the fixed `-340px` default was replaced with a viewport-derived right-edge position. Opening the panel or resizing the viewport repairs stale coordinates, drag movement is clamped with a reachable header, and Reset now restores every panel's geometry while preserving which panels are open.
- **Left-rail ownership:** Nodes and Assets share the same coordinates by design, so opening either now closes the other. This keeps launcher state truthful and avoids introducing a second layout system for only two panels.
- **Create provider route:** Create now follows the Inspector contract: use `directParams` only when `directKeyName` has a configured value, otherwise use `falParams`, always combined with shared params. A final key-based de-duplication boundary prevents malformed catalog data from generating ambiguous controls. Model changes and preset-driven model changes rebuild defaults from the same selected route.
- **Node authoring accessibility:** node definitions are native buttons without removing HTML drag support. Click, tap, or native keyboard activation adds at the current viewport center; the follow-up click event from a double-click is ignored to preserve the old gesture without adding two nodes. Collapsed Slava categories are `aria-hidden` and their items leave the tab order.
- **Live proof:** Run History rendered at `x=988`, width `276`, right `1264` in a 1280px viewport and stayed there after Reset. Opening Assets removed Nodes from the rendered/accessibility tree. Clicking the focusable Text Input button created one Canvas node. Veo 3.1 rendered exactly one Seed input and emitted no duplicate-key console error. The browser-control harness focused the node button with Enter but did not synthesize the browser's native button click; the native keyboard activation contract is therefore pinned by the component test rather than overstated as live harness proof.
- **Environment boundary:** Vite served the real frontend, but this managed sandbox denied the FastAPI TCP listener. The UI checks above are local frontend behaviors and ran in the actual application; backend-dependent asset contents displayed the expected discovery error. No provider request, paid generation, settings write, or user graph persistence mutation was made.
- **Verification:** focused UI tests passed `19/19`; full frontend passed `447` tests across `56` files; full backend passed `1528` tests with the two existing AsyncMock warnings; the 172-definition node contract and TypeScript build passed. Lint first rejected an unscoped focus-ring rule, then Fast Refresh rejected an exported helper in the component module. The skin rule was scoped, the geometry helper moved to `lib/panelPosition.ts`, and lint/build/diff checks passed on rerun.

### 2026-08-18 — Audit follow-up: credential truth, diagnostics, and build budgets

- **One credential source:** provider keys remain exclusive to project-root `settings.json`. All user-facing provider guides, README setup, `settings.example.json`, and the writable `.claude/skills` mirror now point to Settings and explicitly say no restart is required. The optional project `.env` is loaded only for process/path overrides; the Daedalus narrator was changed from `os.environ[OPENROUTER_API_KEY]` to Nebula Settings with Hermes auth as its existing fallback. Contract tests pin exact equality among the 15 catalog keys, Settings fields, settings example, and provider health keys, and prove process environment is not a provider-key fallback.
- **Provider-health policy:** expanded the roster from nine to all 15 Settings credentials plus Nous OAuth. Use documented, non-billable authenticated reads. Never submit generation as a health probe: Higgsfield has no identified safe read and therefore reports `configured_unverified`. Preserve diagnostic truth by separating 401 rejection, 403 authorization, 402 credit exhaustion, 429 rate limiting, and transport/provider errors.
- **Startup payload:** alternate workspaces are route-lazy. Character and Moodboard draft sentinels moved into a small shared module so Assets no longer statically imports both full studios and defeats the split. Remotion, timeline, Lottie, and React Three packages use explicit deferred chunks. Three.js remains one indivisible ~717 kB lazy module, so Vite's generic threshold is calibrated to 750 kB while a stricter post-build gate caps the actual initial entry at 512 kB raw / 160 kB gzip. Current entry: 472,049 raw / 138,242 gzip, down from ~3.53 MB / 912 KB gzip.
- **Lottie tradeoff:** both Vite preview and Remotion export alias `lottie-web` to `lottie_light.js`. That removes runtime code generation and the direct-eval build warning, but expression-authored Lottie animations are intentionally unsupported. The build gate scans every emitted JS asset for `eval(` and `new Function(`; 21/21 are clean.
- **Hook and test hygiene:** `ReferenceSetNode` now computes its fallback params within the memo and depends on stable node data. The async-poll cancellation tests patch the async cancel function with `MagicMock`, eliminating the two unawaited-coroutine warnings without changing runtime cancellation.
- **Venv repair without network:** outbound package resolution stayed unavailable, but complete Python 3.12 distributions existed locally. Repacked their installed files from `RECORD`/`WHEEL` metadata into temporary wheels and installed them into `backend/.venv`, keeping the venv self-contained instead of adding a global `site-packages` path. The first OpenCV 4.12 candidate imported but `pip check` correctly rejected it against NumPy 2.4.4 (`numpy<2.3`); it was replaced with the exact declared OpenCV 4.13.0.92 distribution from the local ComfyUI environment. scikit-image 0.26.0 and its missing SciPy/imageio/tifffile/lazy-loader/networkx dependencies came from the local base Python 3.12 environment. Final unrestricted proof: both key imports resolve inside `backend/.venv`, `pip check` is clean, all 25 QC tests pass, and the live-workspace full suite is 1,544/1,544.

### 2026-08-18 — Release sequencing audit

- Validate the 32 committed-but-unpushed commits from an isolated `git archive`
  before publishing them. That snapshot passed all 1,463 backend tests (the
  baseline comparison test needed read-only access to the original Git object
  database), all 434 frontend tests, lint, and the production build.
- Withhold the fast-forward push because the committed node-contract checker
  predates the committed `CameraRig` and `ReferenceSet` port types. The checker
  fails on those two definitions; its required type-set correction currently
  lives in the uncommitted follow-up batch.
- Preserve the local browser-save evidence while preventing accidental staging.
  Root-only `/test.html` and `/test_files/` ignore rules cover the 9.3 MB saved
  page and generated images without deleting or moving user artifacts.
- The first full follow-up gate caught a second cross-layer mismatch: provider
  credentials intentionally moved from `.env.example` to
  `settings.example.json`, but `scripts/check-node-contracts.mjs` still required
  all 15 keys in `.env.example`. The checker now enforces exact Settings-example
  coverage and rejects provider credentials advertised in `.env.example`,
  matching the existing Python contract tests.
- A clean prospective candidate overlaid every intended tracked/untracked change
  plus the eight corrected `.agents` mirrors on `HEAD`. It passed 1,526 backend
  tests, 447 frontend tests, lint, production build, the initial-bundle/eval
  budget, the 172-definition contract, generated-reference parity, Python/Node
  syntax checks, and validation of all 19 affected provider skill folders. The
  live workspace's larger 1,544 collection includes 18 duplicate tests from four
  ignored Finder `* 2.py` files; those are not part of the release candidate.
- **Managed blocker resolved:** a later unrestricted session applied the eight canonical `.agents` Settings corrections and the OpenRouter/Replicate YAML-description fixes. The OpenAI canonical skill intentionally retains `.agents/skills/gpt-image-2` links rather than copying `.claude`-specific paths. All 22 provider skill folders across both trees validate with `quick_validate.py`, strict provider-guide parity passes, and the live backend suite is fully green.
- **Linux CI shallow-clone repair:** the first pushed release run exposed that
  `test_reference_roles.py` loaded its pre-role baseline with `git show
  c708400`, while `actions/checkout` intentionally provides only the pushed
  commit by default. Replace the history lookup with a checked-in map of
  canonical SHA-256 fingerprints for every baseline node after removing only
  the permitted port `role`/`weight` keys. This keeps the additive-only
  guarantee, permits later new nodes, stays compact, and makes the test
  deterministic in shallow clones and source archives without expanding every
  CI checkout to full repository history.
- **Browser ceiling:** `vite preview` was attempted for a real lazy-chunk browser smoke and failed before launch with `listen EPERM` on `127.0.0.1:4173`; no UI state was used and no screenshot was claimed. Frontend proof is lint + production build + 447 tests; built-chunk runtime remains environment-gated.

### 2026-08-19 — Full UI acceptance: layout persistence and accessible insertion

### 2026-08-19 — Saved-bundle runtime metadata compatibility

- A bundle saved through the native Chrome Save dialog could not be loaded back: completed `gemini-omni-flash` nodes contained `sourceDuration`, `sourceFps`, and `sourceIsVfr` in `params`, but those are runtime ffprobe facts rather than declared provider inputs. Strict import validation correctly rejected them and atomically preserved the empty post-Clear graph.
- Kept strict unknown-parameter validation intact. Runtime probe metadata now uses the existing private-param namespace (`_sourceDuration`, `_sourceFps`, `_sourceIsVfr`) on source/provider nodes. `video-edit` keeps its unprefixed fields because those are declared, durable editor state.
- Both graph serialization and deserialization migrate the three legacy fields only when the node definition does not declare them. This cleans future saves and allows existing v1-v3 bundles—including the UI-audit backup—to reopen.
- The editor reads private metadata first and retains a legacy fallback for already-hydrated nodes. Upload responses keep their existing public response field names; only persisted node params changed.

### 2026-08-19 — Live handler-param synchronization after Canvas runs

- A real Video Input → Video Edit run completed and persisted the edit handler's seeded 60-second clip, but the open frontend still showed `0 clips`. The frontend execution routes only received output events; their post-run handler-param sync updated `cli_graph` without broadcasting the new graph.
- `_sync_params_to_cli_graph` now reports whether values actually changed and deep-copies changed params. Full-graph and single-node Canvas execution send one final `graphSync` only when a handler mutated params, avoiding an unconditional extra graph refresh for ordinary runs.
- Added async regression coverage for both `/api/execute` and `/api/execute-node`; each proves the live broadcast contains the mutated value.

### 2026-08-19 — Silent-source Video Edit rendering

- The first deliberately long local Video Edit failed in 0.2 seconds: the source was a valid silent MP4, but filter construction inferred an audio stream from the clip's unmuted state and referenced nonexistent `[0:a]` input.
- Extended `ProbeResult` with `has_audio`, derived from ffprobe's existing stream list. Video Edit now emits audio filters/maps only when the source actually has audio and at least one clip is unmuted; GIF and all-muted exports continue to omit audio.
- Kept the render helper authoritative for both graph execution and final export. Added regression coverage for audio-bearing, silent, all-muted, and GIF paths.

- **Live reproduction:** a normal FastAPI + Vite pair in Chrome restored the user's 8-node graph, but two nodes were roughly 2,000 flow pixels away and multiple nodes shared exact coordinates. Auto-layout visibly repaired the graph, then a browser reload reverted every arranged position because React Flow changes never reached the persisted CLI graph. Three rapid click/keyboard additions also landed at the same viewport-center coordinate.
- **Persistence boundary:** Canvas drag completion and auto-layout now send positions through one atomic `PUT /api/graph/layout` contract. The backend validates every referenced node and finite coordinate before one `CLIGraph.update_positions()` mutation/persist/broadcast, so a stale or malformed layout cannot partially overwrite the saved graph.
- **Placement tradeoff:** accessible click/tap/keyboard insertion keeps the viewport-center behavior for the first open slot, then searches nearby 320x220 slots. Pending positions are reserved locally until graph-sync materializes them; this closes the real rapid-activation race without waiting for a backend round trip or changing HTML drag/drop placement.

### 2026-08-19 — Command Palette insertion parity

- The live workspace pass found that Command Palette node insertion still used the raw viewport center. Adding Cinema Scene and then Remotion Composition placed them at the same coordinates even though Node Library additions had already adopted collision-aware placement.
- Command Palette now uses the shared `findAvailableNodePosition()` policy and keeps its own pending reservations until graph sync materializes each node. This preserves the intended center-first behavior while making every click/keyboard insertion surface collision-safe.
- A component regression opens the palette twice without allowing either mocked backend addition to resolve into live graph state, then proves both requested nodes receive distinct non-overlapping positions.

### 2026-08-19 — Backend-owned project scope

- The live Assets/Character/Moodboard pass showed real `400` responses for every Project tab: the stores require `projectId`, but no frontend surface had a current-project concept. Presets were worse because `scope=project` without an id silently fell back to global storage.
- Nebula remains a one-local-project-per-backend application, so the backend now owns and exposes that identity at `/api/project`. The default is the stable repository-directory name; `NEBULA_PROJECT_ID` and `NEBULA_PROJECT_NAME` are explicit deployment overrides. Only the safe id and display name are exposed—not the local path.
- All project-scoped list and Preset-create helpers resolve the same identity automatically. Character and Moodboard Studio entry state also retains whether “New” was launched from Global or Project, so new drafts persist into the selected scope instead of silently becoming global.
- Preset storage now rejects a missing project id exactly like Character and Moodboard storage. This converts silent scope corruption into a truthful API error if a future caller bypasses the frontend resolver.

### 2026-08-19 — Backend disconnect truth and recovery

- Stopping the normal FastAPI process left the live Canvas looking fully operational; all 8 nodes remained safely present, but there was no visible indication that runs and backend persistence were unavailable.
- A lightweight health probe now renders a non-blocking offline pill and continues retrying. A successful recovery clears the warning and the cached current-project identity in case the restarted backend belongs to a different checkout.
- Canvas edits remain available while offline; the status copy states that limitation rather than disabling the workspace or implying that local-only edits were persisted.
## 2026-08-19 — first-wave live isolation

- The original 8-node / 5-edge graph is not being imported into the test
  backend after the live wave. Normal graph import remaps node IDs and fits the
  viewport, which would weaken history-linkage and exact-restoration proof.
- Before spend, the normal state file was restored from a byte-identical raw
  snapshot. Live calls use temporary `NEBULA_STATE_DIR` and
  `NEBULA_OUTPUT_ROOT` roots on the normal agent port plus a separate Vite
  origin (`5174`) for isolated localStorage and Run History.
- A UI `.nebula.zip` save is retained as an independent product-level recovery
  path. The initial clear dialog was cancelled until that bundle had been
  written and inspected.

## 2026-08-19 — Nous live credential fallback

- The live Nous node failed with HTTP 401 even though the non-billable model
  check returned valid. The preferred Daedalus profile contained an expired
  agent key, while a later fallback profile was still unexpired; the loader
  ignored Hermes's expiry metadata and always returned the first token.
- Credential selection now scans every pool entry in profile order, rejects
  blank/non-string tokens, and applies token-specific or generic expiry before
  continuing to a fallback. JWT-shaped tokens additionally need an
  `inference:invoke` scope and an `exp` beyond a 60-second safety window;
  legacy opaque Hermes `sk-*` tokens retain metadata-based compatibility.
- Treat persisted profile URLs as untrusted. A credential file may use only
  the canonical Nous HTTPS `/v1` host, so a modified profile cannot redirect
  its bearer. An operator-controlled `NOUS_INFERENCE_BASE_URL` may use another
  HTTPS, non-loopback, no-userinfo host for staging/tests.
- Model and provider-health caches re-read Hermes state before reuse and bind
  entries to a non-secret SHA-256 credential identity. An expired credential
  therefore cannot inherit a five-minute cached-valid result or a cached model
  catalog from another credential/base URL.
- No auth file is refreshed or modified by Nebula. All locally rejected
  credentials remain configured-but-invalid in health; the model proxy returns
  a controlled 401 without sending the rejected bearer upstream.

## 2026-08-19 — Executed output canonicalization

- Live ElevenLabs TTS produced a valid MP3, but its executed event contained an
  absolute path under the disposable `isolated-output` root. The browser-side
  fallback recognized only paths containing a literal `/output/`, so the first
  media load failed; reload worked because persisted graph export independently
  canonicalized the same value.
- Make the backend event boundary authoritative: normalize handler outputs once
  into `/api/outputs/...`, persist that exact scalar/list shape, and broadcast
  the same value. Bare outputs are wrapped as `Any`; shaped types and non-media
  values are preserved. This avoids frontend path-name heuristics and prevents
  broadcast/persist divergence.

## 2026-08-19 — Replicate streamed media data URIs

- Flux Schnell returned through Replicate's `urls.stream` route in about 1.4
  seconds. That branch hardcoded Text, so its `data:image/webp;base64,...` value
  bypassed the engine's existing media materializer and produced an empty
  manifest. Extending only the polling inference path was insufficient.
- Route the complete streamed value through the same output inference as a
  polled result. Well-formed Image, Video, Audio, SVG, and GLTF data URIs now
  receive a media port type; centralized engine materialization remains the
  sole decoder/persistence boundary. Unknown/text data URIs retain Text
  fallback.
- The live retest rendered a persisted 1,024x1,024 WebP and wrote one manifest
  entry without base64. The provider returned a near-white image despite the
  prompt; record that as provider output quality rather than weakening the
  application persistence verdict.
- A later adversarial review found a separate transient leak: before final
  typing, the stream runner broadcast each accumulated SSE `output` value as a
  text delta. A media data URI could therefore cross the WebSocket and appear
  in `streamingText` even though final persistence was redacted, with repeated
  accumulated chunks also creating quadratic traffic. Replicate now supplies a
  tri-state prefix classifier. Plausible `data:` prefixes remain private until
  the header is decisive; recognized media is buffered with zero text-delta
  events, while ordinary and ambiguous text retains its original delta
  boundaries. Final inference and centralized materialization are unchanged.

## 2026-08-19 — Truthful agent attribution and acknowledged cancellation

- Chat action events were globally labeled `hermes` in the frontend even when
  the selected runner was Claude or Codex. `/ws/chat` now stamps every agent,
  tool, and graph-action event with the selected runner (`claude`, `codex`, or
  `daedalus`); the Agent Log validates and displays that source instead of
  inventing one client-side.
- Stop is now a three-state protocol: the backend emits cancellation
  `requested`, waits for the runner cleanup to finish, then emits `confirmed`
  or `failed`. The frontend remains busy and says only “Cancellation
  requested…” until confirmation; “Cancelled.” is reserved for the confirmed
  event, and disconnect/cleanup failures remain visibly failed.
- The first cleanup attempt started each agent in its own OS process group and
  killed that group. Its delayed-grandchild regression inherited the parent's
  group and passed, but the live Claude retest falsified the design: the Bash
  tool created PGID 90706 beneath agent PGID 89999. Stop killed the agent group
  and confirmed while the shell and Python sleep remained orphaned under PID 1
  until natural completion.
- Keep the acknowledged WebSocket/UI protocol, but reject process-group-only
  cleanup as complete. POSIX cleanup must snapshot and kill descendants even
  when they create a new group/session, then verify the discovered processes
  are gone before confirmation. Add a `setsid`/separate-PGID sentinel
  regression; treat any interrupted live follow-up honestly rather than
  repeating an agent turn beyond the approved allowance.
- The initial focused contract passed 42 backend tests and 11 frontend tests,
  but that validation ceiling did not cover re-grouped descendants. It is not
  a release result.
- The replacement POSIX cleanup freezes the root, repeatedly snapshots PPID
  descendants, freezes each newly discovered generation, kills every captured
  PID individually, then refuses to return until `ps` verifies they are gone.
  A deterministic root → child → `setsid()` grandchild test now covers the
  exact separate-session escape that the original inherited-group sentinel
  missed. Verification failure propagates, so the WebSocket reports failed
  instead of confirmed.
- Codex's `login status` preflight is now isolated and uses the same cleanup in
  `finally`; Stop before the main Codex spawn therefore cannot leak the status
  process. Windows continues to use `taskkill /T /F`, the native tree-kill
  primitive, but that branch cannot be runtime-proved from this POSIX lane.
  The revised focused agent group passed 116 backend tests and 11 frontend
  tests across cancellation, source attribution, and WebSocket/UI state.
- Agent attribution is enforced at the WebSocket boundary: the selected runner
  overwrites any runner-supplied `source`, so stale or hostile output cannot
  masquerade as another agent. If the socket disconnects after Stop but before
  confirmation, chat now adds a visible cancellation-failed warning stating
  that backend cleanup was not confirmed; the hidden state transition alone
  was not sufficient user-facing truth.
- The final Daedalus cancellation turn reached the UI and proved corrected
  `daedalus` attribution in the Agent Log, but the isolated backend and Vite
  sessions ended during the interrupted review before Stop/process inspection
  could finish. That one approved cancellation turn was not repeated. The live
  full-descendant result is therefore **inconclusive**, with the deterministic
  separate-session sentinel and verification-failure regressions as the exact
  cleanup proof ceiling.
- A release security pass found a second, implicit cancellation path: a raw
  WebSocket client could send another turn while one was active; the backend
  cancelled the first task, swallowed any cleanup exception, and started the
  replacement without the requested/confirmed protocol. Concurrent sends are
  now rejected until the client explicitly Stops and receives confirmation.
  This keeps process cleanup and user-visible cancellation truth on one path,
  even if a client bypasses the frontend's disabled-Send state.

## 2026-08-21 — Trackpad canvas navigation

- The canvas explicitly disabled React Flow's scroll-panning path, so a
  two-finger trackpad scroll changed zoom instead of translating the viewport.
- Match the Flora-style interaction split: ordinary two-finger scrolling pans
  freely in both axes, pinch remains zoom, and click-drag panning remains
  available. Mouse-wheel scrolling follows the same pan path by design. Keep
  the three React Flow flags in one typed, unit-tested contract so a future
  canvas refactor cannot silently restore scroll-to-zoom.

## 2026-08-21 — Collapsible canvas minimap

- Performance Mode previously made the minimap permanently visible; disabling
  the mode also removed render culling and controls, so it was not a suitable
  minimization path.
- Add a direct 30px minimize affordance inside the expanded minimap and retain
  a 44px restore target above the chat launcher when collapsed. Persist the
  choice independently of Performance Mode so the compact state survives
  reloads without sacrificing large-graph rendering behavior.

## 2026-08-21 — Flora-inspired workspace rail

- Treat the rail as navigation, not a set of independent floating windows. A
  single `leftDock` owns Nodes, Assets, Run History, and Settings; the legacy
  panel visibility fields mirror that authority so the existing panel content
  can be reused without parallel state paths.
- Dock panels are intentionally no longer draggable or resizable. Their stable
  rail-adjacent drawer geometry makes the active destination predictable and
  prevents several left panels from obscuring the graph at once. Chat remains
  an independent bottom-right surface because it supports a simultaneous
  canvas conversation rather than workspace navigation.
- Keep execution and graph-manipulation actions in the bottom toolbar, but move
  Settings out of it. Search opens the existing command palette, Help opens the
  existing onboarding, and Create reuses the existing studio route. Do not add
  Flora icons for Comments, Flows, or Profile until Nebula has real destination
  behavior for them.
- Centralize fit padding around the actual rail, dock drawer, chat, and
  inspector rectangles. The rail and dock are explicitly classified as left
  chrome and chat as right chrome; nearest-edge inference misclassified a
  full-height drawer as top chrome because its top inset is smaller than its
  left inset.

## 2026-08-21 — Flora-style mode-free canvas selection

- Remove the persistent Pan/Select toggle instead of merely defaulting it to
  Select. Empty-canvas left drag now always marquee-selects, while dragging a
  node still moves it. This matches Flora's direct manipulation contract and
  removes the hidden mode that made the same gesture unexpectedly pan.
- Preserve every alternative navigation path: trackpad/two-axis wheel scroll
  pans, pinch zooms, Meta/Control + wheel zooms, middle/right drag pans, and
  Space temporarily turns left drag into pan. Shift remains the additive node
  selection modifier and marquee selection uses partial intersection.
- Keep the whole React Flow gesture configuration in one typed, unit-tested
  `CANVAS_INTERACTION_PROPS` object. This prevents toolbar/state changes from
  silently reintroducing left-drag panning or splitting the interaction model
  across component props.

## 2026-08-21 — Contextual selection actions and shared agent context

- The existing Claude, Codex, and Daedalus agents could inspect the full graph
  through `nebula graph`, but none received the live React Flow selection. Do
  not persist selection inside graph nodes or `.nebula` files. A dedicated
  ephemeral backend store keeps only selected IDs and resolves every read
  against the canonical `cli_graph`, so a deleted/import-replaced node cannot
  survive as a valid selected handle.
- Publish IDs rather than client-authored node data. The backend derives names,
  params, outputs, and touching connections, caps collection/string sizes,
  drops internal fields, and redacts credential-like keys plus every data URI.
  Per-turn chat context is stricter still: it contains only IDs, definition
  metadata, and internal selection topology so parameter text can never be
  promoted into a system instruction.
- A WebSocket chat turn carries its own selected-ID snapshot in addition to the
  continuously published selection. This makes vague references such as
  “change these” atomic at Send time instead of racing a later canvas click.
  Approval follow-ups take a fresh snapshot because the user may legitimately
  change the selection while an agent is paused.
- The repository did not contain an MCP server; MCP appeared only in research
  and roadmap documents. Add a real read-only stdio server rather than calling
  the REST endpoint “MCP.” Pin the maintained official Python SDK v1 line at
  `mcp==1.27.0`: it is old enough for the repository's package-age security
  rule and is locally testable, while the newly released v2 line would add an
  unproved dependency/lifespan migration. The MCP process reads the same
  backend selection endpoint as `nebula selection`.
- The MCP SDK's unconstrained `sse-starlette` dependency currently selects a
  release that requires a newer Starlette than FastAPI 0.115.12 supports. Pin
  the existing `starlette==0.46.2` runtime and the mature
  `sse-starlette==2.4.1` release (which does not impose a base Starlette
  upgrade), plus `pydantic-settings==2.14.0` to avoid the newer release's
  unresolved-lifespan warning against Nebula's pinned Pydantic 2.11 runtime.
  This keeps the optional stdio bridge installable in the main backend
  environment without changing Nebula's HTTP stack.
- Keep the contextual toolbar capability-based. Nebula has real batch run,
  copy, duplicate, dependency-aware arrange, output download, agent, and delete
  behavior, so those are exposed. Do not add Flora-style grouping or shared
  parameter editing until the graph has an actual group model and a validated
  heterogeneous batch-edit contract; decorative controls would create false
  affordances.
- Batch deletion routes through the existing React Flow removal path so one
  undo record, CLI deletion mirror, edge cleanup, and Remotion source pruning
  remain atomic. Batch arrange operates on the selected induced subgraph and
  translates its computed layout back to the selection's existing origin.

## 2026-09-03 — World Labs Environment MVP

- Ship against the public World Labs Marble API and name the capability
  **World Labs Environment**. Atlas remains an adapter target only: its public
  announcement says partner early access, while the published World API does
  not expose an Atlas model identifier. Do not present Marble execution as
  Atlas execution.
- Introduce a first-class structured `World` port rather than coercing the
  provider bundle into `Mesh`. A generated world owns several related assets
  (SPZ resolutions, collider GLB, panorama, thumbnail), provider/world IDs,
  and metric/ground metadata that must remain atomic across graph edges.
- Preserve provider assets in the graph run directory before emitting success.
  Store local paths in the `World` object and in derivative output ports so a
  signed provider URL cannot become a stale successful output. Download every
  returned SPZ resolution plus panorama, collider, and thumbnail; do not put
  API keys or signed query strings into manifests.
- Render `World` with a dedicated, lazily loaded Spark/Three.js viewport.
  The graph card uses a cheap thumbnail/fallback; the expanded viewer loads a
  bounded preview SPZ first and lets the user opt into full resolution. Clean
  up animation frames, controls, renderer, and WebGL resources on unmount.
- Keep generation and export separate. World generation exposes the provider's
  ordinary collider and visual assets; an explicit World Labs Export node owns
  paid HQ-GLB or PLY export requests, polling, local materialization, and its
  own cost-facing parameters.
- Keep World Labs Environment Canvas-only for this MVP. Create Studio currently
  launches concurrent variation runs without Canvas run history or Stop/recovery
  ownership; exposing a paid non-idempotent start there would make lost-response
  and repeated-click ambiguity unrecoverable. Re-enable it only after Create
  adopts the same tracked execution contract.
- Treat accepted World Labs IDs as durable paid-work checkpoints. A
  cancellation-shielded POST handshake captures the provider response, then a
  `providerRecovery` event persists and hydrates the operation/world ID before
  Stop can terminate local polling. Generation advances from
  `resume_operation_id` to a pinned `existing_world_id`; export keeps its
  `resume_operation_id`. Clearing the field, rather than an ordinary rerun, is
  the explicit request for a new paid operation.
- Match history replay to the real billing boundary rather than treating every
  World Labs node as paid. A fresh environment or fresh HQ GLB export is blocked
  unless its exact accepted-operation/world ID is restored, including legacy
  completed records; free PLY conversion remains a normal replay. Checkpoints
  are journaled by exact run/node and hydrated before startup graph-empty guards;
  a fully checkpointed snapshot becomes an explicit **Recover** action that
  resumes/fetches existing paid work without another POST. A journal write
  failure preserves the live ID but emits a durable=false warning that remains
  visible through cancellation; volatile records expose their actual ID but no
  forget action, and cleanup failures return HTTP 507 instead of claiming
  durable deletion.
- Reserve every fresh paid start and every supplied recovery ID before the
  execution task is scheduled. One OS-locked, fail-closed lifecycle boundary
  coordinates all backend processes, pre-admission Stop intent, unresolved
  submission ambiguity, provider checkpoints, and graph mutations. Capacity
  exhaustion refuses new paid work instead of evicting a safety record. This is
  deliberately stricter than per-process task maps: stale tabs, simultaneous
  workers, imported recovery params, or an immediate recovery/fresh-start race
  must not issue a duplicate provider POST.
- Do not replay POST/DELETE graph or execution mutations after backend
  rediscovery. GET/HEAD discovery can safely retry; a mutation with a lost
  response is status-reconciled by its run ID. Frontend execution ownership
  persists through Stop and reconnect until the backend reports a terminal raw
  execution status. Transport-ambiguous provider starts require a Marble check
  and exact run-identity acknowledgement; a stale acknowledgement cannot clear
  a newer hold.
- Treat recovery/ambiguity hydration as merge-only, no-eviction safety state.
  An old snapshot may conservatively over-lock but cannot erase a newer live
  checkpoint. Save, clear/import, undo/redo, deletion, clone, duplicate, and
  paste either block during unresolved paid state or carry the current recovery
  identity. Server-confirmed graph clear is the sole authoritative bulk reset;
  individual recovery deletion is conditional on the exact identity the user
  saw so run-ID reuse cannot clear newer work.
- Bound every untrusted boundary independently: provider downloads are
  streamed and format-validated; SPZ previews are source-bounded, header-
  preflighted, and fully gzip-inflated for CRC/exact-length validation before Spark;
  browser graph JSON and ZIP bundles have byte/shape/member limits; ZIP
  extraction is backend-only and validates the graph before writing assets.
  Restore and graph import remain two HTTP calls, so a network failure between
  them can leave an unreferenced restore directory even though it cannot erase
  or partially replace the current graph.
- Browser GLB viewing is explicit and lazy rather than eager: the model viewer
  mounts only after a bounded 128 MiB fetch, and Blob URLs/resources are cleaned
  up on close. Panorama downloads derive their safe extension from the backend-
  validated local path rather than falsely labeling every image as PNG.
- Structural and mocked-provider verification is intentional for this pass. No
  billable generation or HQ GLB export is required for acceptance; live UI
  proof uses a local SPZ fixture and therefore cannot establish provider-account
  billing, latency, or signed-URL behavior.
- Use one percent-aware portable path policy for graph-bundle collection and
  restore remapping. Unsafe or omitted local references become explicit
  unavailable values with warnings; retaining the old URL could silently bind
  an imported graph to an unrelated same-named output on another backend.
- Emit frontend-created ZIP members with STORE compression. World assets are
  already compressed, and DEFLATE made highly repetitive but valid graph JSON
  exceed the backend's compression-bomb ratio even when every byte and member
  limit was otherwise satisfied.
- The production compile exposed a global entry-budget regression while the
  World viewer itself remained correctly lazy. Keep React/Zustand, React Flow,
  and JSZip in stable named vendor chunks rather than weakening the 512 kB /
  160 kB entry limits. This makes feature-code growth visible again and lets
  browsers cache those shared frameworks independently.
- Spark 2.1.0's generic PLY reader ships an optional `new Function` parser
  compiler plus a non-codegen fallback for CSP-constrained pages. Nebula's
  World viewer accepts only fully preflighted SPZ, so the Vite build transform
  disables that unused compiler in both Spark's main module and embedded worker
  source. The existing all-chunk scanner remains strict—there is no Spark
  exemption—and fails if the pinned dependency changes its markers.

### Final adversarial follow-up

- Exclude both World Labs nodes from the generic one-hour execution-output
  cache. Their durable recovery IDs are the idempotency mechanism; caching the
  original no-ID parameter set would otherwise turn an explicit recovery clear
  into the old result instead of a deliberately fresh operation.
- Treat an export operation's returned `resolution` or `mesh_variant` as
  identity evidence when present. A resumed operation with conflicting live
  settings now fails before download instead of saving a correctly formatted
  but semantically mislabeled asset.
- World previews and graph imports accept asset references only through
  Nebula's `/api/outputs/` boundary (including localhost backend URLs that are
  rebound to the discovered backend). Imported provider/CDN/LAN URLs are
  removed with a warning, preventing a graph file from causing automatic
  cross-origin thumbnail requests or interactive fetches. `marbleUrl` remains
  a separately validated World Labs HTTPS navigation link.
- Fetch SPZ viewer bytes with `cache: no-store`. The output route has no
  immutable-cache contract and files may be archived or deleted independently
  of the graph, so a browser cache must not make a removed World asset appear
  live again after the backend returns it unavailable.
- Persist a pre-provider intent under an OS advisory lock and fsync both the
  replacement file and its parent directory before allowing a paid POST. The
  lock is deliberately shared across World generation, HQ export, recovery,
  graph replacement, and all backend workers; a second local backend therefore
  cannot turn a process-local timing window into duplicate spend.
- Classify provider 3xx, 408, 5xx, malformed success bodies, and transport loss
  as ambiguous acceptance. Only a trustworthy provider ID or a definite client
  rejection releases the fresh-start uncertainty. Ambiguities require an exact
  kind/node/run acknowledgement so a delayed old-tab action cannot erase a
  newer hold.
- Keep pre-admission Stop IDs permanently denied after their inspectable exact
  records are compacted. A fixed 1,048,576-bit, seven-hash Bloom filter was
  chosen to bound storage without unsafe eviction. False positives can
  conservatively reject a novel run ID; false negatives (and therefore delayed
  cancelled-run admission) are not permitted.
- Register per-shot Cinema tasks in the normal execution registry even though
  the frontend intentionally leaves the Canvas-wide execution gate open. This
  gives the task strong ownership, cross-worker Stop observation, and a terminal
  release fallback when cancellation lands before the coroutine's first turn.
  Cinema's nested base dispatcher also uses a strict four-model allowlist so a
  crafted scene cannot invoke a World handler below top-level admission.
- Validate port data types on the backend for direct connect, import, and
  clustering, using the same contract as the frontend: exact types, `Any`, and
  the intentional Image/Mask interchange are compatible. A structured `World`
  value cannot be wired into an Image or Text input through a raw API payload.
- Register `.spz` as `application/octet-stream` explicitly. The live macOS UI
  proof exposed a platform MIME mapping to `text/plain`; SPZ has no registered
  standard media type, and an opaque binary response avoids proxy or download
  clients interpreting compressed Gaussian-splat bytes as text.

## 2026-09-03 — World Labs live defect closure

- Preserve a blank string only for optional numeric parameters during backend
  coercion. The World node intentionally uses `seed: ""` as its Random sentinel;
  required numeric fields still reject blanks instead of weakening validation.
- Treat a returned backend rejection as authoritative, and a lost response
  after mutation dispatch as ambiguous. Node creation falls back to a
  frontend-only UUID only when backend discovery fails before any mutation is
  sent. HTTP 400/409/503 responses leave the canvas unchanged; a lost or
  malformed post-dispatch response reconciles through graph export/graphSync or
  keeps an uncertainty fence that blocks another create until sync/reload. This
  prevents both rejected-node ghosts and commit-then-response-loss duplicates.
- Route one selected node through the existing target-node execution contract,
  whose backend derives the authoritative ancestor closure. Multi-node selection
  remains an intentionally induced cluster. This keeps an upstream prompt in a
  single selected World run without changing multi-selection semantics.
- Reset raw Marble scenes from their transformed capture origin, not a splat
  density center. For `marble_raw_opencv`, the position is
  `[0, +groundPlaneOffset, 0]` facing Three.js `-Z`; sampled geometry bounds are
  limited to speed, control limits, clipping, and unknown-frame fallback.
- Do not traverse every splat twice on the browser main thread. Navigation
  bounds use at most 8,192 stratified indexed reads from `PackedSplats`; the
  Canvas/camera stay mounted while quality or Orbit/Fly mode changes, and only
  initial world load or explicit Reset repositions the camera. A decode that
  resolves after unmount receives a second terminal dispose.
- Keep the World surface inside Nebula's Slava token language while strengthening
  keyboard focus locally, including an inset ring on the actual WebGL canvas
  that cannot be clipped by the stage. Keep every quality variant reachable
  through a narrow-screen scroller, place the aria-modal viewer above the global
  recovery banner, and collapse Open in Marble to a centered icon on compact
  layouts.
- Reused the completed Mediterranean rooftop output for browser QA and made no
  additional paid World Labs request. A temporary default World node was added
  through the real node library, verified as backend ID `n4`, then deleted after
  confirming there was no local UUID ghost; the original three-node graph and
  two edges were restored.

## 2026-09-04 — Atlas-ready spatial foundation

- Keep Atlas absent from the executable public catalog. World Labs currently
  publishes Atlas only as select-partner early access, with no public model ID,
  endpoint, pricing, limits, cancellation, idempotency, or asset contract. The
  foundation therefore uses local schemas, fixtures, and backend-authoritative
  capability states; a frontend flag or configured Marble key cannot enable an
  Atlas request.
- Extend Nebula around provider-neutral, versioned spatial values rather than
  adding `atlas` to the Marble model enum. Existing `World` schema v1 graphs
  remain schema v1 on import and are adapted to v2 in memory. Persistence
  canonicalizes their supported fields and local assets instead of retaining
  opaque provider metadata.
- Separate authoring primitives from future billable provider tasks. Camera
  pose/path, spatial context, and sensor descriptions are deterministic local
  nodes. Future Atlas generation, reconstruction, reframing, and simulation
  adapters remain unavailable until an official versioned contract is installed
  and entitlement can be verified without starting billable work.
- Treat paid-operation admission, recovery identity, cache bypass, and quick-run
  eligibility as one backend registry. Per-operation billing conditions and
  recovery parameter names live in policy data so a new provider operation
  cannot silently skip the lifecycle classifier.
- Accept absolute paths only while they resolve inside the configured Nebula
  output root, then canonicalize them to `/api/outputs/...`; persisted spatial
  values never retain provider URLs or machine-specific paths.
- World Labs Export consumes the original Marble World v1. Adversarial review
  found that importable World v2 session metadata cannot authenticate a provider
  resource ID, so v2 export fails before HTTP until an adapter supplies a
  backend-verified resource binding. Local v1-to-v2 adaptation remains available.
- Keep the provider guide focused on the executable Marble workflow and make
  `docs/spatial-foundation.md` the canonical architecture/boundary reference.
  Document schema-ready values separately from implemented producers so the
  presence of depth, point-cloud, sensor-stream, or World-v2 contracts cannot
  be mistaken for a callable Atlas capability.

## 2026-09-05 — Spatial adversarial corrections

- Final-source verification checkpoint: 1,973 backend tests in 41.80s; 737
  frontend tests across 81 files; production build/budget, generated model docs,
  and diff checks passed. Inspected actual saved ZIP: graph.json and both image
  members present. Native Save/Load dialog remains the outstanding observed-UI
  acceptance gap; normal Dia use needs a quiet user-approved interaction window.

- Legacy parity closeout found two remaining edges: browser version lookup
  could skip invalid canonical values for a snake alias; backend null splat
  entries could skip control/trim validation. Both boundaries now reject these
  inputs consistently. 58 focused browser/import and 29 backend contract tests
  pass. Full pre-closeout checkpoint: 1,973 backend, 736 frontend, build passed.

- Native Dia testing stopped when CUA reported user activity; no further
  interaction with that browser. A temporary integration test exercised real
  saveToFile ZIP generation and real backend restore with picker I/O captured
  by the test. It exposed mapping.requestUrl persisting absolute backend URLs,
  which caused SpatialContext to be discarded. Restore mappings now preserve
  portable paths. The live archive test passes with nine nodes/six edges,
  correct context pose n7, zero warnings, and restored image HTTP 200. Added
  separate-origin regression to repo tests. Native file-dialog behavior remains
  unverified; archive bytes exist at the temporary runtime spatial-live.nebula.zip.

- Normal-browser save verification could not start: Chrome is unavailable to
  CUA. Source inspection found graph save revoked fallback Blob URLs immediately
  unlike World downloads. Applied the same 1s deferred cleanup with finally
  removal, and regression-check scheduled revocation. This closes a potential
  asynchronous download race; it is not a claim about the in-app save root cause.

- Rendered remaining six actual preview components in a temporary-only Vite
  fixture page (depth map/sequence, point cloud, stream, session, World v2).
  Screenshots show complete cards; links deliberately use synthetic paths and
  no decoding/provider proof is claimed. Depth-sequence metric labels now say
  first resolution/encoding because later frames can legitimately differ.

- World v2 now rejects contradictory MIME roles in both parsers: splats must
  declare their matching SPZ/PLY family, panorama/thumbnail supported raster
  media, colliders glTF. Generic octet-stream remains accepted for untyped
  local bytes. This is metadata consistency, not proof of byte-level validity;
  decoders must still validate content before interactive rendering.

- Depth cards now expose convention/byte order, scale/offset formula, and
  invalid sample policy as three bounded property chips so compact-card metric
  truncation cannot hide them. Added a rendered component assertion. Full
  regression after sensor/depth/cache/fit/import changes: 1,973 backend tests,
  732 frontend tests across 81 files. Production build/budget checks passed.

- Depth maps now require explicit sample scale/offset, invalid-sample sentinel
  (null means no finite sentinel), axial versus ray-distance convention, and
  byte order (including container-defined for encoded containers). Decoded
  distance = sample * scale + offset in the declared unit; nonfinite samples
  are always invalid. This tightens unreleased draft data without guessing
  defaults. It does not implement or attest an image/raw-depth decoder.

- SensorStream now requires an embedded SensorRig snapshot. Stream rigId,
  sensorId, modality, and coordinate system are checked against that snapshot
  in both parsers. This tightens the unreleased v1 foundation contract; older
  draft fixtures without a rig must be regenerated, not silently assigned one.
  It validates stream-to-rig binding, not physical calibration or provider truth.

- Added docs/spatial-foundation-acceptance.md as a requirement-by-requirement
  evidence ledger. Corrected the architecture status from shipped to acceptance
  in progress. Remaining semantic issues are explicit: depth decoding, sensor
  reference binding, media conformance, rendered fixtures, and live file save.
  Focused capability/policy/admission/start-guard regression: 86 passed.

- Extended file-import regression across all ten spatial port types: a boolean
  schema version drops only the invalid output, retains its node, and returns
  a warning. All 41 graph-file tests pass. Existing tests cover valid plain-JSON
  spatial round trips. Actual Save button was clicked, but no observable saved
  artifact/confirmation was available in the in-app browser; do not count that
  click as proof of completed disk save or load.

- Cache-identity follow-up: engine regression executes two identical Camera
  Pose nodes twice with a shared cache and requires each output ID match its
  node; all 26 cache tests pass. Restarted only isolated backend PID 6854
  (replacement PID 23204), which restored nine nodes/six edges. Two actual
  canvas runs now preserve n1/n2/n4/n7 identities and context n9 anchors n7.
  Screenshot shared. This proves backend restart restoration and cached rerun,
  not yet the user-facing file save/load round trip.

- Actual Spatial Context run exposed cross-node cache aliasing: default Camera
  Pose n7 reused output ID n4. Local spatial author cache keys now include node
  identity because pose/path/rig/anchor IDs derive from it. Other nodes retain
  their prior content-key behavior. Live restart/retest remains required.

- Canvas fit previously reserved side panels but omitted the top canvas tabs
  and bottom execution toolbar. Added their measured bounds to shared fit
  padding with the existing 24px safety gap, plus a regression for both edges.

- Actual isolated 5175 canvas QA: rechecked the two-pose Camera Path output
  (strictly ordered 1s/2s, duration 1s), then added and ran Camera Pose -> Sensor
  Rig -> Spatial Value Validate through the canvas Run control. Both downstream
  cards show one RGB sensor in nebula-world. Shared screenshots of both flows.
  Cluster ingress correctly rejected cross-cluster existing-node references
  before the self-contained cluster was submitted. No provider calls were made.
  Fit-to-screen makes six spread-out nodes small and top canvas chrome overlaps
  the path header; assess viewport fit/occlusion during remaining visual QA.

- Post-alias full regression checkpoint: 1,968 backend tests passed in 65.97s;
  720 frontend tests passed across 81 files. Production TypeScript/Vite build,
  bundle-budget/eval checks, generated model reference check, and diff whitespace
  check passed. Build still warns about the deferred Spark vendor chunk size.
  These checks do not close the remaining contract audit or canvas acceptance.

- Collider camel/snake aliases now both undergo URI validation, with null
  camel-case values falling back to the legacy spelling. This aligns backend
  adaptation with browser imports and prevents hidden invalid alias values.

- Legacy splat aliases now validate every supplied asset even when an earlier
  alias wins. Null aliases do not reserve a resolution; the first non-null
  valid asset wins. Browser validation also checks reserved variant names on
  null entries, matching the backend. Added regression cases on both sides.

- Default Camera Pose nodes now share the catalog's `nebula-world` frame, so
  separately authored default poses compose into a path or rig.
- Graph candidate writes reject non-finite JSON and roll back only newly seeded
  recovery records on a failed graph commit. Once atomic rename succeeds, a
  directory fsync error is surfaced as a durability warning while memory adopts
  the committed disk state.
- Raw graph ingress applies bounded recursive validation before staging; float
  coercion also rejects non-finite values. Schema versions reject booleans and
  quaternion normalization uses a stable norm. Thumbnail-only World values are
  invalid, and World summaries include spatial-context reference assets.
- Optional spatial nulls normalize to absent fields in both browser and backend.
  Successful execution now verifies referenced spatial files exist before
  emitting or caching a result, including legacy World assets.
- Verification checkpoint: 213 focused backend tests passed on 2026-09-05.
  Frontend Vitest is still running through iCloud-backed dependencies; full
  regression and rendered UI acceptance remain pending.

## 2026-09-05 — Regression runtime recovery

- The repository's installed frontend dependencies failed before test collection
  (`aria-query` destructuring and JSDOM constructor errors). A disposable runtime
  at `/tmp/nebula-spatial-verify.siqQGO` was installed from the existing lockfile
  with lifecycle scripts disabled; package versions and repository dependencies
  were not changed.
- That runtime passed all 717 frontend tests across 81 files. The production
  build exposed the missing spatial union in `PortValue.value`; adding the
  actual spatial types fixed TypeScript. Production build and bundle checks
  then passed (34 JavaScript assets eval-free).
- Regenerated MODEL_REFERENCE.md from the 179-node catalog and verified the
  generator's check mode. Full backend run: 1,960 passed, five older fixtures
  failed after stricter handler/port admission and catalog growth. Fixtures now
  use registered nodes and substitute canonical provider handlers at their
  source, preserving the identity gate during offline cache tests.
- Browser verification found the existing 5173 preview blank. The clean runtime
  on 5175 renders the node library and a locally added Camera Pose node; a
  screenshot was shared. Backend is offline, so this is rendering evidence only,
  not end-to-end execution acceptance. Legacy canonicalization parity and the
  remaining contract findings still require closure.

- Legacy World v1 output persistence and execution now reconstruct a validated
  field allowlist. Unknown provider fields, opaque billing objects, and supplied
  navigation URLs cannot carry signed URLs into graph/cache records. The Marble
  navigation link is derived from the World ID on both backend and browser.
  Cache rebinding continues to verify the referenced physical files while the
  structured value remains portable. Focused canonicalization/cache/import
  regression: 71 tests passed.
- Browser legacy asset URLs now reject query strings as well as fragments,
  matching the unsigned spatial reference contract. Localhost output URLs
  without a query still normalize to portable paths. The 60 focused frontend
  World/spatial/import tests pass after this correction.
- Full backend regression completed after canonicalization and fixture fixes:
  1,966 tests passed in 40.87 seconds. This does not close the remaining schema
  acceptance parity findings or substitute for backend-connected UI execution.
- Legacy browser parsing now uses the backend's 64-entry splat-map ceiling and
  preserves insertion order/first alias occurrence. Oversized maps and invalid
  asset bundles reject rather than silently truncating or filtering assets.
  Missing splats, malformed asset/semantics containers, unsupported coordinate
  frames, and nonpositive scales reject at the browser boundary. Import removes
  the invalid output with its existing warning instead of persisting a partial
  World. Viewer tests now require valid local splats in their valid fixtures.
- Browser metadata validation now matches backend ID/model/label bounds using
  Unicode code points; 61 focused frontend tests pass.
- Started an isolated backend at 8000 with state/output under
  `/tmp/nebula-spatial-backend.ZuuVFf` and settings pointed to an absent file
  there. Through the real 5175 canvas, created backend node n1 and executed
  Camera Pose successfully. Screenshot QA found the structured card inherited
  photographic header overlap and a pale theme; spatial CSS now uses a dark
  readable card and a more-specific zero-overlap rule. A subsequent screenshot
  confirmed title and output no longer overlap. This proves the single local
  node flow; multi-node spatial flows remain to be verified.

## 2026-10-01 — Paper source loop

- Built only in the managed `paper-linked-source` worktree from parent HEAD; parent uncommitted work and brand-lab remain independent.
- Use the currently installed official Paper CLI (`~/.paper/bin/paper mcp`); no new dependency, copied credential, watcher, or provider run on refresh. Transport and snapshot lifecycle are separate.
- Paper tools export one explicit file/page/object. Token contentHash is not an artwork revision; snapshots record observed PNG bytes, SHA-256, capture time, bounds, scale, actual alpha and transparency. An artboard export can be opaque even when a nested object is transparent.
- Keep immutable content-addressed PNGs and metadata in the isolated output root. SQLite request sequences reject late exports/errors and preserve histories across backend restarts. Failed reconnect retains the old binding until a successful export.
- The source handler resolves only the snapshot pinned into the submitted recipe. Existing handlers read/upload local owned media; no cloud provider is given a localhost preview URL.
- File/page link is the honest Open in Paper fallback: installed tools expose open_file, but no object-select/navigation tool. No object navigation claimed.
- Browser downstream proof will use an explicitly labeled deterministic fixture; paid provider execution is a separate unproven limit.

- Added an accepted `paper-inputs.json` receipt inside each Paper-backed backend run directory before dispatch: original snapshot descriptor, stable SHA-256 recipe revision, nodes/settings/edges. Credential field names are excluded; actual API key dictionaries never enter the receipt. Frontend history retains exact submitted snapshots and outputs for replay and inspection.
- Browser acceptance exposed derived video duration/FPS metadata falsely invalidating a just-finished run; exclude those observed-output fields from recipe revisions, while retaining real prompt/model/settings/connection changes.

- Explicit rerun exposed a source-history regression: trimmed request-only snapshot arrays were being merged back into the live canvas/source. Preserve equal-sequence live source records on graph sync and canonical source histories on backend export; run receipts remain pinned to one input.
- Added the source to the utility test manifest and advanced the intentional catalog-size assertion to 180 after the full backend suite caught both old catalog baselines.

- Live deletion returned a surviving Paper tombstone (same ID/name/size, null parent, no children) and a blank PNG instead of an error. The adapter must validate reciprocal ancestor membership to the exact page before and after export. The disposable fixture retains that early blank capture in history; repeated acceptance checks use the corrected adapter, without erasing earlier test evidence.
- Historical replay uses an explicit `preserveGraphParams` request flag: execute saved settings, keep live edited params, and retain output/recovery writes. Ordinary runs still persist handler-derived metadata. The backend guard is required because a frontend-only preservation rule would be undone by graph sync.
- The deterministic local fixture copies the immutable PNG before its artificial delay. Refresh to C during a B run kept C current and completed against B. This proves input pinning and deterministic compositing, not paid-provider generation or identical generative motion.
- Unchanged-refresh copy says no new snapshot; it no longer implies an already-stale output became current.

### Paper execution pins: final backend review

- The snapshot store allows an optional expected hash for preview delivery. Execution now requires both snapshot ID and content SHA-256 to be complete lowercase 64-hex strings before lookup; an incomplete saved recipe cannot silently omit its promised hash.
- Paper sources bypass the ordinary graph output cache so every run verifies the original immutable snapshot bytes. A preseeded unrelated cached success cannot substitute artwork or hide damaged source bytes.
- The complete backend suite passed 2,482 tests before this final pin-validation adjustment. The affected Paper/cache/utility/Video QC gate passed 108 tests after the adjustment; this distinction keeps the full-suite evidence tied to the code actually tested.

- Installed export schema has no transparent-background override. Export settings record `background: artwork`, and actual PNG alpha/transparency is measured separately. The card makes no promise to strip an opaque artboard background. Earlier disposable captures retain their earlier intent metadata.

### Paper final backend validation

- Final stabilized code, including replay preservation and SDK grouped-error handling, passed the complete backend suite: 2,542 tests, exit 0, 61.54 seconds, 12 inherited FastAPI startup deprecation warnings. This supersedes the earlier pre-tightening full-suite ceiling.
- Fixture protocol checks now include the exact page-root reciprocal ancestor chain before and after export. Export settings describe native artwork background; no unsupported transparent-background override is recorded, and actual alpha remains derived from PNG bytes.

### 2026-10-01 — Paper desktop navigation follow-up

- The installed Paper 0.5.13 app ships a `paper://file/<file>/<page>/<object>` deep-link parser. Its main handler restores/focuses the window; the tab handler forwards the full page/object route even for an already-open file. This is a separate capability from MCP `open_file`, which cannot select an object or activate an existing tab.
- Open in Paper now follows that desktop link directly in the click gesture. Electron routes it through the existing native external-link bridge. A visible HTTPS Open source link targets the same bound object and remains available when a browser has no protocol handler.
- Links are derived from validated stable IDs instead of imported `openUrl` strings. Opening does not read selection, refresh, mutate source records, or execute a recipe; existing snapshot metadata stays immutable.
- The real HTTPS fallback click opened the bound file/page/object route and displayed the logo. Browser automation blocked `paper://` navigation by security policy; no alternate desktop launch was attempted. Actual desktop activation/selection remains unverified. This browser is a guest viewer: artwork is visible, but editing/selection API verification requires an existing Paper login. No sharing/access setting changed.
- After opening and reloading, the same source hash, last refresh time, 7 source snapshots, 2 nodes, 1 edge and 4 run-history entries remain. Focused frontend lifecycle/desktop-mode/state checks pass (66), native bridge checks pass (139), and TypeScript/build/budget, targeted ESLint and CSS guards pass.

### 2026-10-01 — Paper feature demo

- The user personally confirmed that Open in Paper takes them to the desktop app, then requested a 40-second captioned landscape demo. The desktop transition uses edited real captures of the source link and its native Paper destination; it is not a continuous automated protocol-launch recording.
- Demo captures use separate local ports 5191/8021 and `output/paper-demo`, preserving the original acceptance graph, history and runtimes. The downstream result is the visibly labeled deterministic video fixture; no paid generation, package installation or provider credentials are used.
- Captured the real pink logo link/run, changed only the disposable Paper artwork to cyan, refreshed its source, captured the stale pink result, explicitly reran the saved recipe with the latest source, and captured the cyan result plus both history entries. Restored the editable Paper artwork to its original pink after capture. The demo's immutable cyan snapshot remains available independently.
- The video composition, captures and verification evidence live in `videos/paper-linked-source`. Use the already installed HyperFrames 0.8.41 renderer and its existing browser; the published version is older than 14 days. Source captures are actual UI plates with designed captions and editorial reframing.

### 2026-10-01 — Scoped publication to GitHub main

- The user authorized publishing the Paper feature and demo to GitHub main. The original isolated feature branch includes 60 unpublished ancestor commits from other development, so publication uses a second managed worktree based on current `origin/main` (`07b3c957`). Only the two Paper commits and the verified demo are ported; the parent Design-agent checkout and other active brand-system session remain intact.
- Main lacks the unrelated general file bridge, native dialogs and chat-workspace guards. The port keeps main's alert/confirm conventions, adds a narrow frozen Paper-link IPC namespace, and validates the native exported PNG with a standalone Paper path guard. No unrelated feature family is pulled into this change.
- The scoped-main backend passes all 2,129 tests. A fresh native Paper export through the new guard returns the actual original pink PNG at 480 × 360 with transparency and its expected SHA-256. The native tool writes to Downloads; the transport accepts that ordinary export path instead of assuming temporary-only output.
- Full frontend passes 818 tests in 86 files, lint, TypeScript, production build and bundle budget. The 180-node contract gate, provider inventory and generated model reference checks pass. The original development-worktree test counts elsewhere in these notes describe that earlier checkout, not main's smaller test baseline.
- The 40-second 1080p captioned demo is included on GitHub with its editable composition, actual UI plates and verification evidence. Native Paper plates exclude unrelated project tabs; uncropped originals stay local. The final movie contains 1,200 frames and passes full decode and encoded-frame visual review.
- Desktop validation: 267 non-UI tests pass; after the documented desktop build, all four Electron integration checks and the single-instance check pass. Two preexisting resilience assertions count every uvicorn process on the machine and expect zero, so the four preserved preview/service processes prevent those assertions from passing. No running service was stopped and no test was weakened.
- The scoped changed-file credential scan found only an inherited CSS class substring in Canvas, already present on origin/main; added-line and staged-artifact scans found no credentials. Dependency symlinks and raw native screenshots are excluded from publication.

### 2026-10-02 — GitHub README cleanup

- Reuse the managed `paper-main` worktree at current GitHub main; leave the active parent Design-agent checkout and untracked demo project untouched. Publication contains documentation and one image only.
- Keep the README frontmatter schema and existing banner for possible external portfolio consumers, but shorten the descriptions and remove stale node/provider/test counts. Replace repeated catalog, workspace, architecture and agent tables with focused links to their existing guides.
- Put Paper Source near the top with a frame from the already reviewed sharp demo. The image depicts the demo's actual UI and saved outputs; it is not new acceptance evidence or a new provider run. Link the existing published demo source rather than add another large movie to Git.
- Move contributor commands into GitHub's standard `CONTRIBUTING.md` and add a user-facing Paper setup guide. Keep the requirement that refresh only captures artwork and marks results out of date; a saved recipe must be rerun explicitly.
- Quickstart uses Python 3.12 (the CI target), Node 24 (compatible with the checked frontend/desktop lockfiles), and root-relative commands in separate terminals. This corrects the old Node 18 requirement and ambiguous working-directory instructions without installing or changing dependencies.
- Review corrected the first-run example to the exact GPT Image 2 library name, qualified staleness to changed artwork, and made the cross-page reconnect instructions explicit. Contributor pytest commands set the backend import path rather than rely on test collection order.
- Validation: the README is 114 lines instead of 483; all 31 relative links/images resolve, frontmatter parses with the retained schema, the 1920 × 1080 PNG is valid, and GitHub's Markdown API renders all three edited guides. No application code or dependencies change, so no application suite is rerun for this documentation edit.

### 2026-10-03 — Krea image/video provider catalog

- The user confirmed the broader Krea image/video catalog, using one Krea API key. Reuse the isolated worktree on `codex/krea-provider` from published main; the active Design-agent checkout and untracked Paper demo stay independent.
- Krea already has Settings, credential, health and legacy Krea 2/style integration. The missing piece is its third-party model catalog, not another key field. Use explicit Krea-backed model definitions instead of silently choosing a provider based on which keys happen to be present.
- The official public OpenAPI snapshot advertises 33 image and 41 video generation routes. Generate first-class definitions and exact model controls/ports from those schemas for Canvas and compatible Create workflows. Preserve the existing six nodes and their saved graph IDs. Other advertised enhancement, audio and 3D routes remain outside this image/video scope.
- Bundle the schema snapshot needed by those routes so offline graph creation and execution do not depend on live documentation availability. Keep a refresh/check script and source URL/hash with the catalog; regenerate MODEL_REFERENCE from the canonical Nebula registry. API schemas establish documented compatibility, not live generation proof for every model.
- Shared Krea gateway transport validates model-specific requests before submission, uploads local media including immutable Paper snapshots, retains plural image/video outputs, and polls/cancels jobs using Krea only. Model paths are bound to bundled definitions, never user-supplied URLs. Saved graph IDs and recipes pin the selected Krea route.
- Update the outdated only-Krea-2 guide/skill scope and incorrect Turbo path, while retaining legacy style/moodboard guidance. Show an accessible Provider filter in Create's existing model picker so the new catalog is easy to find. No package installation or credential copying is part of the implementation.
- Promote the already installed transitive `jsonschema` dependency to an explicit `4.26.0` pin for request validation. The canonical PyPI publication date is 2026-01-07, safely older than 14 days; no package is installed or upgraded.
- Gateway ports are optional wire alternatives to the same required control values; schema validation enforces required fields before uploads or paid submission. This avoids the existing graph validator requiring a wire even when the field is set in a control. Nullable scalar types and nested numeric choices need normalization for ordinary numeric/enum controls, rather than JSON textareas.
- An additional `artifacts` output retains typed local previews alongside primary image/video arrays. Bind one run directory for all artifacts. Keep provider credentials out of artifact-download requests, and request upstream cancellation on Stop/timeouts rather than silently resubmit.
- Review caught Create's `_variant` cache discriminator in requests for seedless models. Strip that one engine-owned field before provider validation, preserving it in graph/cache state and retaining strict rejection of other unknown fields. Empty optional enums are omitted only when their schema does not admit an empty value.
- Control review found numeric enum selections became strings, and optional values appeared to have defaults that the API never declared. Preserve option value types in Create and Canvas; show blank numeric fields and explicit Default/Choose states when there is no schema default. Clearing an optional choice removes it from the request.
- Keep three advanced routes Canvas-only in Create: Runway Gen-4 Image needs tagged reference objects, H3 camera controls needs a structured trajectory, and Flux Video Edit needs source video. Create's image-only attachments and scalar controls cannot supply those inputs. Cinema's base-model dispatcher has a separate four-model allowlist and is not expanded by this provider catalog.
- Preserve original non-Krea registry formatting in the generator, as well as existing definition values. Catalog checks/regeneration remain offline; refresh alone never submits generation. Live QA uses isolated ports 5203/8033 with temporary state/output/settings and no provider credentials.
- Review found plural outputs were usable in live graph edges but not collected by bulk download or graph ZIP save. Return portable owned output references for plural media and typed artifacts, preserving the existing absolute-path singular port convention. Cache rebinding must retain those portable references while owning fresh copies in each later run; old run artifacts remain untouched.
- HTTP media URL validation is self-contained because plain `jsonschema` installs can omit optional URI-format checkers. Reject malformed input/upload/result URLs before use without adding URI-extra dependencies. The explicit schema validator still checks required fields, bounds, enums, and JSON structure.
- Final validation: all 2,290 backend tests and 844 frontend tests pass, along with frontend lint, TypeScript/production build and bundle budget, offline catalog/reference checks, and all 254 node contracts. All 180 original definitions remain identical; 26 local documentation links resolve.
- Real browser QA verified Krea provider filtering, model selection without generation, blank/provider-default controls, and Canvas node creation with typed media/JSON ports. Deterministic execution uses mocked Krea HTTP with real PNG and FFmpeg/ffprobe media validation, downstream uploads, provider cancellation requests, and two-run cache/manifest checks. No paid Krea generation or workspace-wide live model availability is verified.

### UI repair details

# Single supported appearance — 2026-10-07

- Removed alternate theme registry, Settings picker, command-compatible theme setter, and unsupported Hermes runtime CSS. Slava Restraint is the sole supported appearance; the existing readonly `skin` state stays available to Canvas/node/Inspector rendering code, avoiding unrelated renderer changes.
- Startup now rewrites any saved `nebula:skin` value to Slava, removes legacy Hermes tone storage, and clears obsolete theme/tone/transition/bloom body classes. Storage failures still return/apply Slava. Historical design/research folders remain as provenance; the public Hermes portrait remains because the screenshot suite uses it as fixture artwork.
- Daedalus selection keeps its original agent/session/model/provider and Auto/Step controls. Removed only the old theme-switch/tone/bloom side effects and their UI. Agent switches no longer change app appearance.
- Removed the obsolete theme-setter call from capture and utility/screenshot helpers and updated the capture reference. Replaced the screenshot guard's deleted-picker switching sequence with supported-appearance, legacy-reload migration, Settings/no-picker, and Daedalus appearance checks. Only syntax-checked this browser guard; no browser automation ran for this task.
- Included root-requested Settings changes: Performance mode copy now mentions minimap only, plus `usePanelFocus(visible && shouldRender, ...)` wiring and dialog metadata. The delayed-unmount condition ensures the DOM ref exists before focus is requested; Settings remains a nonmodal dock. Unit regression verifies Escape close/opener restoration.
- Targeted gate: 61 tests across 6 matched files passed (skins, ChatPanel appearance, Settings, uiStore, palette); TypeScript, touched-file ESLint, CSS scope guard, inline-style guard, and diff whitespace checks passed. No paid jobs, package edits, browser actions, Electron work, or commits.

# U04: Graph file commands across workspaces

- Moved Save/Load ownership out of the Canvas-only Toolbar into one headless `GraphFileActions` component mounted once under App's persistent ReactFlowProvider. Root added the App import/mount; this agent did not edit App.tsx.
- Toolbar buttons and CommandPalette use shared `requestGraphSave` / `requestGraphLoad` dispatchers. Only the controller registers event listeners, preventing duplicate dialogs during StrictMode or view changes.
- Standard Cmd/Ctrl+S/O are also handled at document level in every workspace, including Editor/Remotion where Cmd+K is intentionally reserved. Skip defaultPrevented events so Canvas's existing React keyboard handler dispatches only once. This document handler runs before the legacy Editor window-level Cmd+S no-op; editor shortcut ownership stays unchanged.
- Kept the existing `saveToFile` / `loadFromFile` pipeline unchanged: portable bundles, asset restoration, browser/native file-dialog behavior, warnings, and backend-first atomic graph import still use their existing implementations.
- Added shared admission predicates for execution and Create preparation ownership (`createLaunchingIds`); Save retains its paid-start ambiguity restriction. Palette and Toolbar disabled states match controller checks. Load rechecks ownership after the file picker and after response JSON so an active or preparing generation cannot have its live frontend graph/workspace reset by a delayed callback.
- After successful Load, show Canvas and clear obsolete editor target/selection/playback state. Do not call previous editor exit cleanup against newly imported node IDs. Prior run history remains intact. Existing fit-to-loaded-graph behavior stays.
- Retain the last real Canvas viewport while another workspace is mounted, because ReactFlow may reset its transform on Canvas unmount. Saves from Create/Cinema serialize that viewport.
- Removed alternate-theme command generation and `setSkin` / `SkinId` caller plumbing, coordinated with audit_frontend's Slava-only theme change.
- Validation: 77 tests passed across GraphFileActions, Toolbar execution, CommandPalette, command data, graphFile, Cinema roundtrip, and Cinema deleted-shot history suites. TypeScript build, touched-file ESLint, and git diff --check passed. Tests cover Create/Cinema commands without a Toolbar, standard file shortcuts in Create/Cinema/Editor/Remotion, Canvas shortcut delegation, picker cancellation, backend rejection, duplicate-dialog prevention and listener cleanup, and execution/preparation admission both before and during asynchronous Load phases.
- No browser actions, paid jobs, package changes, commits, or parent-checkout edits by this agent.

- Model selection now uses a viewport-constrained portal dialog. Search and provider controls stay outside the scrolling results; Escape closes once, Tab stays inside the modal, and closing restores its opener. Settings/Chat docks restore focus without trapping it.
- At compact widths an open drawer reserves a separate navigation row; its minimap temporarily hides without changing the saved collapse preference. This avoids moving the old left-edge overlap to the right edge.

### 2026-10-07 — Ordered backlog delivery

- Begin with the audited web/backend and single-appearance UI changes, using the existing isolated worktree based on published main. The parent Design-agent checkout, local diverged main and isolated Brand Lab remain untouched. Review and publish this change before selectively bringing over the existing QC truthfulness and acknowledged Create-save fixes; the larger Commons feature is a separate integration.
- A fresh release review found that batch manifests could assign the last invocation's handler-enriched parameters to earlier outputs. Correct effective-parameter snapshots, including cached invocations, before publication; preserve saved recipes and previous artifacts. Detailed review repair evidence is recorded in `docs/audit-release-review-notes-2026-10-07.md`.
- The persistent file controller also needs a shared import reservation: a late HTTP-response check cannot undo an earlier replacement broadcast. Reserve immediately before import, refuse generation admission while it settles, and add a backend active-run check before commit so another client cannot replace a running graph. Saved Create reruns must carry their immutable Create origin so gallery Stop and capacity counting remain available.
- Release gates use the existing installed dependencies and isolated test state. Full frontend/backend checks, node contracts, generated reference parity, staged credential scan and GitHub CI precede merge. Packaged Electron remains outside the user's chosen scope; the previously documented browser native chooser completion limitation is not treated as resolved.
- Final local release gates passed 2,442 backend tests and 997 frontend tests in 105 files, full lint/build/budget, all 254 node contracts and generated-reference parity. The staged scan found no credentials; its initial `sk-` substring hit was part of a CSS mask variable and was corrected with a token-boundary check. Current source and review evidence are included; private captures/state remain excluded.

### 2026-10-07 — Selective QC and Create-save integration

- Bring over the existing parent fixes as a second scoped change, using selected hunks rather than merging Design-agent or copying its complete CreateView. Preserve the newly published audit lifecycle/import fences, Krea selection and single supported appearance. Commons, agent-profile, desktop bridge and isolated brand work remain separate.
- Unmeasured identity/expression QC results must be unavailable, not zero-valued passes. OpenCV face geometry/edge metrics remain named proxies with coverage and provenance; valid vision-model numeric reports are advisory and must not be described as semantic quality proof.
- Create result saving must await the existing export API and acknowledge only a nonempty saved path. Pending, cancellation, error and retry remain distinct. Replace style-name window.prompt with the shared in-app text-entry dialog; await preset persistence before refreshing the library. Keep the existing web export service and downloads intact.
- Regression coverage must exercise the real CreateView-to-ResultCard save delegate and a deferred preset write, as component-only mocks would miss a swallowed export rejection or premature library refresh. No provider calls or packages are needed for these ports.
- Independent review also found stale export acknowledgements when the same Canvas node replaces its output URL. Scope ResultCard save state/timers to node and media identity and guard each request: completing an old export must not mark a replacement output saved, display its error, or unlock a newer export. The old export may still finish; the UI reports only its current artifact.
- Final local gates passed all 2,471 backend tests, 1,015 frontend tests in 107 files, full frontend lint and production build/budget, 254 node contracts and generated-reference parity. The build budget measured 297,021 bytes raw / 83,042 bytes gzip with 34 eval-free JavaScript assets. These are isolated local checks; native browser picker completion remains a separately documented limitation.

- The next art-direction slice remains separate. Camera Rig and Reference Set currently have no typed generation consumers. Their first Cinema integration should translate explicit prompt guidance and ordered reference images, label its limits, and verify outgoing requests. Character strength support must be checked per actual consumer; the existing Identity Edit fidelity injection is absent from its exact FAL Nano Banana 2 Edit schema and needs correction in that slice. No new generation-control mapping is adopted by this QC/save port.

### 2026-10-07 — Cinema art-direction consumers

- Implement in the isolated release worktree from published main. Add optional typed Camera Rig and Reference Set inputs to Cinema, including its existing single-shot path. Source edits and disconnections only change graph state; generation still requires Run/rerun, and saved recipes retain their frozen inputs and earlier outputs.
- Camera Rig becomes explicitly labeled prompt guidance. Reference Set priorities determine stable image order; zero excludes, duplicate URLs share one delivered image with all associated roles in an indexed prompt legend. Keep serialized weight keys and stored identity-strength values compatible with existing files.
- Disable unsupported semantic identity-strength controls rather than presenting a model adherence knob. Remove unsupported Identity Edit fidelity injection after checking the exact current FAL schema. Keep real local palette-transfer strength enabled.
- Current adapter inspection exposed a deeper reference bug: Seedream's Cinema base dispatches text-to-image even when images are supplied, while generic FAL mapping can emit singular and plural image fields together. Correct the reference-aware base routing and request fields, and cap the final image list against the actual selected adapter/model before any provider submission. Preserve the original no-reference text-to-image route.
- Request verification also found that Seedream 5 Lite has no seed and Identity Edit has no mask input. Omit unsupported outbound seed/fidelity/strength fields without changing saved parameters. Preserve the legacy Mask port/edges, label its limitation, and reject a nonempty mask before submission. Restrict Seedream's seed and Auto 3K UI choices to the variants that support them; evaluate visibility against declared defaults without writing defaults into saved state.
- The custom Cinema card previously exposed only its Character Refs handle despite a declared Character input. Render all four declared inputs with separate labeled rows. Position each Reference Set role's handle within its own row. Native Chrome on isolated ports 5211/8041 verified both new click-to-connect paths, camera editing and connection persistence on reload; no generation was requested. A Vite hot-reload wire offset disappeared on a fresh page reload; no unrelated global edge renderer was changed.
- The full backend run found the legacy role-metadata baseline intentionally freezes five changed node definitions. Preserve that historical guard with exact approved-delta assertions, rather than excluding those nodes or replacing their baseline fingerprints.
- Peer review caught a reverse-model switch: a saved Seedream 5 Lite Auto 3K value must not disappear visually when switching to 4.5 while remaining in the request. Show the retained choice explicitly as unavailable, allow a valid replacement, and reject unsupported sizing before transport. Keep the saved value until the user chooses its replacement.
- Final transport review found that hidden saved base parameters could replace the validated Cinema prompt/reference list in FAL's request builder. Reject only those reserved input fields within Cinema before submission, retaining the source recipe and leaving the shared builder unchanged. Character expansion now defers its cap check to Cinema's final adapter check so its conservative original-Gemini limit is described accurately.
- Treat an omitted model selector as its adapter default, but reject explicitly stored empty or non-string selectors. Previously the cap helper treated these as defaults while the actual adapter dispatched an unknown route. Preserve the invalid saved value for explicit correction, with zero provider calls.
- Final local gates passed 2,634 backend tests and 1,030 frontend tests in 109 files, full frontend lint and TypeScript/production build, 254 node contracts and generated-reference parity. The build budget measured 298,478 bytes raw / 83,355 bytes gzip with 34 eval-free JavaScript assets. Provider payloads and saved replay were verified with mocked transport and real local PNG artifacts; native Chrome verified typed connections, editing without generation and reload persistence. No paid generation or image-adherence claim is part of this evidence.

### 2026-10-07 — Archived Batch branch reconciliation

- Reuse the isolated release worktree from published main `9cd707bf`; inspect the clean archived `feat/batch-cross-pair` branch at `2d7634d3` without altering that checkout or the parent Design-agent work. Its 33 commits include 17 obsolete baseline-cleanup commits and 16 Batch commits; the first-class Batch source and carousel are absent from current main.
- Restore the single-text Batch foundation through the current invocation-context scheduler rather than merging its older engine, cache, events and store over current lifecycle/artifact safeguards. Retain the original `batch` ID, `set` handle and authoring parameter keys. Current scalar Text ports remain authoritative; separate per-item results and lineage describe fan-out without migrating all port types.
- Bound Batch expansion with the existing 1–25 item-cap convention (default 10), rejecting overflow before downstream calls rather than silently truncating supplied items. Source edits and carousel navigation remain free of generation; Run and saved rerun retain their current explicit admission and immutable history.
- Cross/Pair joins, failure-rate policies, cost estimates, Compare Grid and provider pricing are later slices. Preserve the original archived branch/tag as historical evidence and document exactly which Plan 1 behavior was recovered and tested.

- Keep carousel selection local to each rendered node/run; it never changes canonical outputs, downstream inputs or saved parameters. Hydrate only the latest owning history record whose last result matches the current scalar output, comparing objects independent of key order. Known terminal run IDs remain fenced after reload; cloning clears galleries and undo preserves the current execution result.
- A selected Mask Painter result must display its captured produced artifact. Reconstructing a composite from live upstream inputs can show a different Batch item than its label/download; retain live composite editing only outside result browsing.
- Frontend JavaScript trim and Python strip disagree on BOM and control separators. Use the exact ECMAScript trim set for backend line parsing, with regression coverage; whole-text mode remains byte-preserving.
- Native Chrome verified creation/Inspector authoring, seven-item Batch-to-Preview execution, red/orange navigation, end clamping, connection/gallery reload, source edits without generation, frozen seven-item rerun after live source changed to two items, and an explicit current-source run. All browser execution was local utility work without provider credentials.
- The first aggregate gate exposed three catalog inventory fixtures that needed the new Batch local-execution/utility entry and count 255, plus an unrelated intermittent Settings loading test failure. The unchanged frontend suite then passed all 1,107 tests; final suite gates are recorded after the remaining history presentation and utility-manifest changes.
- Final local gates passed all 2,692 backend tests and 1,116 frontend tests in 113 files, full frontend lint and TypeScript/production build, all 255 node contracts and generated-reference parity. The entry budget measured 303,577 bytes raw / 84,895 bytes gzip with 34 eval-free JavaScript assets. The maintained legacy browser smoke script was syntax checked; native Chrome supplied the actual browser evidence.
- Run History now describes fanout counts as execution steps, displays captured item labels/lineage, and falls back to numbered results for legacy or malformed metadata. Metadata array indices must match output order; malformed metadata is discarded without losing otherwise valid outputs/recipes. The complete archived Cross/Pair roadmap remains separate.

## 2026-10-07 — Selective Commons integration

- User approved the next integration after readiness commit `5a935731`. Start from published main `6f7e7155` in clean managed release worktree, branch `codex/commons-integration`. Preserve parent dirty work, existing current features, real library/linked folders and human reader/evaluation decisions. Real activation, backup/restart, model calls and publication are separate from implementing the inactive integration.
- Bring across only committed Commons domain/UI and security modules plus their regressions. Exclude research outputs, prototypes, old themes, unrelated desktop changes and whole-file replacements of current runner/App/store behavior. Compose current Krea MCP and Daedalus dispatch with the scoped authority/workspace design.
- Commons defaults off through strict `NEBULA_COMMONS_ENABLED=1` opt-in. A non-storage capability response allows UI discovery; all real Commons routes and lazy runtime factories fail before state access while disabled. Startup must not mint human authority, recover jobs or scan links when disabled.
- Agent turns use backend-owned opaque conversation IDs and revoke scoped tokens before done/cancellation acknowledgement. Existing raw Claude/Codex conversation IDs must start a new chat with `/clear`; prior files/history remain on disk. Enabled Commons admits only Claude/Codex because Daedalus has no verified private file profile. Default-off Daedalus retains its existing contract.
- Independent lifecycle review found second-send validation could finish an active response, done could precede drainer settlement, and malformed envelopes could bypass cleanup. Move admission before validation, distinguish completed resource cleanup from transport draining, and clean up on every WebSocket exit. Regression tests use fake runners/transports only.
- Existing HTTP test fixtures used non-loopback Host values. Update them to loopback so lifecycle/Krea regressions exercise the route behind the new local request guard; do not widen the production Host allowlist.
- The historical human actor key is retained for record compatibility, while user-facing comments, API authority errors and reader guidance refer to the local user instead of a fixed personal name. This is a presentation change, not a real-store migration.
- Final integration gates passed 3,357 backend tests and 1,183 frontend tests in 126 files, full lint/TypeScript/production budget, 255 node contracts and generated-reference parity. Independent review closed actual Krea decoded-media and Paper export/snapshot read gaps. Native Chrome verified default-off discovery and synthetic opt-in artwork/comment persistence plus canvas/chat-draft preservation; zero analysis calls. Staged secret/whitespace checks passed; local-only publication boundary and real activation remain explicit.

### 2026-10-07 — Create UI continuity and result browsing

- Start the UI improvement backlog with one complete Create slice: durable unfinished composer drafts, bounded result browsing, keyboard/touch result actions and visible reference-upload lifecycle. Keep the current single appearance and existing shared generation/history ownership. Cinema and Settings repairs remain separately scoped follow-ups.
- Reuse the attached isolated release worktree at published main 362d201b. The dirty Design-agent checkout, real backend, credentials, Commons store and parallel Brand Lab remain untouched. Existing installed dependencies suffice.
- Draft state is session-scoped and persisted in origin-local browser storage. Initial Canvas selection seeds only a draft that does not yet exist; returning to Create resumes it. Explicit Styles handoff still applies once. New draft resets composer state, not the session ID or historical runs, and cannot generate.
- Uploads belong to the draft rather than the mounted Create component. Persist only pending/error metadata and accepted backend references; File objects and AbortControllers remain transient. A reload converts pending uploads into an interrupted state requiring reattachment/removal. Per-item attempt identity fences removed, reset or retried uploads, while functional updates preserve later prompt/model edits.
- Gate generation both in the composer controls/keyboard path and immediately before job reservation against latest draft/upload state. Pending or failed intended references require resolution before generation; no upload, navigation or draft restoration may submit a model job.
- Put reference tray and composer in a bounded footer in normal layout flow, so wrapped controls reserve their real height. Keep gallery toolbar stationary and cards in their own scrolling region. Short-height views must retain reachable results and composer, with compact list rows and explicit action/focus affordances.

- Native Chrome exposed compressed implicit Grid rows despite passing unit tests. Split the bounded scroll viewport from natural card content, set max-content rows, and fit artwork inside a fixed aspect preview; rechecked 30 results in Grid/List at 100% and 200%.
- Final proof: 129 frontend files / 1,225 tests, lint/style guards, TypeScript/build/budget and independent review passed. Native draft navigation/reload/reset and fullscreen focus passed; 200% footer scroll keeps controls reachable.
- Upload proof boundary: real isolated HTTP upload accepted valid PNG and rejected malformed PNG with 415 detail. The native file picker did not appear through computer use, so pending/error/retry/remove UI was verified with component integration/deferred responses rather than claiming native picker success. No provider/agent calls, real workspace mutation, dependency installs or main merge.

### 2026-10-07 — Cinema uploads and Settings recovery

- Continue the UI backlog in the same isolated branch. Cinema upload completions must append references to the latest scene/shot by stable identity, preserving newer edits, outputs, connections and saved history. Convert authoring callbacks to functional field updates; graph replacement and target deletion revoke pending upload ownership even when IDs are restored.
- Keep upload metadata separate from saved graph parameters and run recipes. Files/controllers are transient; reload shows interrupted references requiring explicit attachment/removal. Gate current-recipe generation against shared and selected-shot uploads, while an unrelated sibling shot and frozen historical replay retain their existing admission behavior.
- Settings must load successfully before saved fields can be edited or written. Preserve unsaved drafts in page memory across panel unmount, never browser storage; provide visible load/write errors and explicit read retry. Removing a provider key is a dedicated, idempotent provider-scoped DELETE and preserves other keys/settings and Krea MCP consent.
- No new packages, provider calls, packaged Electron changes, real credentials or parent checkout changes are needed. Broader Cinema layout/override controls and the remaining discovery/onboarding polish stay in later slices.
- Independent review exposed two lifecycle boundaries: clearing run history must retain current upload ownership, and terminal-owner settlement before graph hydration must retain restored interrupted metadata. Prune unknown restored targets only after authoritative graph hydration; target deletion and explicit replacement still revoke requests immediately.
- Serialize/coalesce Cinema scene persistence and temporarily protect newer authoring from stale WebSocket echoes. Suspend pending scene saves during import; resume on a failed import while retaining fresh runtime media. Accepted replacement discards the old suspension. A five-second bound releases successful writes without socket acknowledgements; client abort cannot undo a server commit.
- Browser echo protection alone could hide canonical data loss: a delayed whole-scene PUT can replace fresher completed shot media on the server. Preserve backend-owned output, variations and selected variation by stable shot ID when applying Cinema authoring edits. Graph import remains the separate authoritative replacement path.

- A successful graph import now tags its authoritative WebSocket update. This invalidates old upload/save ownership and fully replaces frontend nodes/edges even if HTTP acknowledgement is lost; ordinary synchronization remains a merge. Browser key values trim before Save, so whitespace-only fields follow the displayed blank-key preservation behavior.

- Reverse synchronization also needs the same ownership boundary: whole-scene generation now merges only actually produced shot outputs into current authoring. A private execution marker distinguishes produced data from untouched/cancelled snapshot fields, including cache hits and Batch invocation clones. Canonical/live ports exclude removed shots while complete produced artifacts remain in frozen Cinema run history. Other handlers retain their existing synchronization.
- Peer review caught a partial-cancellation mismatch: a settled shot could display its new image while its downstream port still held the old one. Terminal synchronization now commits both produced shot runtime and its matching done/error port, including disk reload, while retaining unrelated siblings.
- Final integrated gates passed: 3,425 backend tests and 1,298 frontend tests in 136 files, lint/style guards, TypeScript/production build/budget, independent review and staged whitespace/credential scans. Native synthetic Chrome verified Settings recovery/removal and Cinema authoring reload; native file selection remains unverified. No paid calls, real credentials, parent checkout changes or publication occurred.

### 2026-10-08 — Dependable Cinema motion handoff

- Continue in the clean isolated UI branch at f74d3413. Keep this slice to motion handoff feedback, connection confirmation, retry ownership and Canvas destination focus; broader Cinema layout/overrides stay separate.
- A dedicated Cinema endpoint creates or reuses the exact shot-to-Veo image connection atomically. Its existing graph edge is durable retry identity, avoiding duplicate destinations after lost HTTP acknowledgements without adding a credential or operation registry. Source artwork must still match the requested settled result. Existing target authoring/results remain intact.
- Page-memory feedback belongs to the source node and shot across panel navigation. Deletion/retyping/import/clear revoke obsolete callbacks; accepted HTTP responses adopt only the verified pair, never a full graph snapshot. Frontend-only scenes create a local node and typed Image edge together with an undo snapshot.
- Sending, retrying, reconciling and viewing a video node never submit generation. View uses a volatile Canvas focus request consumed after mounting and measuring the target, rather than an event fired while Canvas is absent.
- Review found a delayed successful HTTP reply could restore a pair deleted in newer authoritative synchronization even if the original creation event was lost. Capture a volatile graph-sync revision per attempt; an intervening sync that omits the exact pair requires explicit idempotent retry. Retyped targets reject before any edge adoption.
- Native synthetic testing passed failure → Retry → connected destination → Canvas selection/centering with no generation requests. It also exposed Cinema shot edges exporting as Any despite their Image contract; correct the canonical exporter so socket and HTTP confirmation agree.
- Final review caught canonical edge-only removal being retained by the generic optimistic-edge merge. Drop only previously confirmed server motion wires omitted by the new snapshot; preserve other frontend optimistic edges. Graph replacement also clears unmeasured focus ownership so reused IDs cannot redirect it.
- Final gates passed 3,465 backend tests and 1,342 frontend tests in 140 files, lint/style guards, TypeScript/build/budget and independent review. Native Chrome validated failure/retry, the Image wire and focused destination with one idle video node, empty video outputs and zero generation requests. Temporary fixtures/proof stay outside Git; no real app/settings/providers or main publication were touched.

### 2026-10-08 — Cinema selected-shot layout and controls

- Start from published main `94baa0e6` on isolated `codex/cinema-layout-controls`; keep the parallel Design-agent checkout and real app untouched. Preserve the established dark appearance and explicit generation.
- Use a collapsed scene summary with an expandable, bounded settings inspector. Desktop puts the selected preview beside its prompt and actions; compact/short layouts use a reachable scrolling body and smaller rail instead of spending the whole viewport on shared controls.
- Expose all four connected Cinema input roles by source identity, including connections awaiting an output. View on Canvas must resolve the surviving connection before selecting and centering its actual source; inspection never executes upstream models.
- Palette/look overrides edit only the selected shot through latest-state functional patches. Reset removes that override and restores inheritance. An explicitly selected named shot preset must not inherit scene custom sliders/LUT that clobber its grade; unmodified partial overrides keep their existing inheritance contract.
- Replace pseudo-button shot cards with native selection buttons and separate remove/reorder actions. Preserve selected shot identity and useful focus through reorder/delete; provide keyboard navigation and an explicit reorder equivalent.

- Independent review found authoring updates could scroll the compact body back to the rail. Key that effect by selected identity and ordered IDs rather than every shot-object change. Bound the shared settings/upload band so recovery rows cannot consume the selected editor.
- Match visible defaults and summaries to actual rendering: missing custom look scalars resolve to zero, legacy palette fields resolve to current defaults, and a saved source image without palette swatches does not claim an applied reference palette. Unknown saved model/method values remain exact rather than silently appearing as a known choice.
- Final gates passed 3,479 backend tests and 1,391 frontend tests in 144 files, lint/style guards, TypeScript/production build/budget and independent review. Native Chrome at 100% and verified 200% zoom exercised selection, explicit inheritance/reset, prompt/strength edits, Alt-arrow reorder and connected-source Canvas centering. All seven synthetic nodes, six edges and earlier images survived with zero generation requests. Temporary fixtures/proof remain outside Git; owned servers/tab were closed, with no real workspace/provider change or publication.

### 2026-10-08 — Model discovery and provider setup clarity

- User approved merging/pushing Cinema first; remote main is verified at `ffcd5bf8`. Continue the next slice in isolated `codex/model-discovery-setup`, preserving the parallel checkout, real app/settings and packaged Electron exclusion.
- Share source-backed search vocabulary across Nodes, Create and command search: friendly categories/providers, actual ports, catalog model options and existing capability notes. Task aliases explain user intent without inventing per-model guarantees. Keep Create's existing required-input exclusions.
- Keep the catalog browsable before setup. Separate adding/selecting a model from its setup action. Open Settings at the relevant credential or connection while preserving the draft, graph and earlier history.
- Presence means configured, not verified. Existing read-only provider checks run only after explicit Check connections. Session status must expire and reject old responses after credential changes; never expose raw provider exception details. A successful credential probe does not promise model entitlement or successful generation.
- Resolve actual credential routes rather than vendor labels: configured direct keys retain precedence over FAL, Krea token/sign-in modes remain distinct per saved recipe, and keyless Paper/Cinema/Nous nodes retain their other prerequisites. This slice changes discovery and feedback, not execution admission or saved billing modes.
- Independent review found legacy Ideogram Reframe lacking resolution still executes through FAL. Readiness now honors that exception; catalog rows use the defaults addNode saves, while selected recipes use their actual saved params. Supported-route filters include direct/FAL alternatives without changing the active route.
- Settings verification counts and model labels share one timestamp validity predicate. Expired/future checks are never counted as verified; one shared expiry timer clears displayed verification without another request. Fresh Settings loads also reject older credential-cache revisions while preserving dirty drafts.
- Native browser proof used private synthetic connections on 5222/8052, never real accounts. The controlled browser clock differed from the host; matching fixture timestamps were required to exercise successful verification. Initial mismatched timestamps remained unverified as intended. Final fixture proof preserved seven existing nodes/six edges after adding n8, with zero generation requests and three explicit connection checks.
- Final checks: 1,475 frontend tests/148 files, lint/style guards, TypeScript/production build/budget, 255 node contracts and independent reviews passed. Native normal/200% checks covered search, recovery, setup focus/draft retention, explicit check failure/retry, separate keyboard setup and disconnected addition. No backend handler, dependency or Electron changes.

### 2026-10-08 — Onboarding for the current workspace

- Continue the UI queue on isolated `codex/onboarding-current-navigation`, based on the local discovery slice. Keep the parallel checkout, real accounts and packaged Electron out of scope.
- Teach one passive five-step workflow using stable rail/chat targets: find a model, connect its provider, use Create, inspect earlier runs and ask the agent. Derive the catalog count from current definitions; moving through the tour never checks credentials, edits a graph or starts generation.
- Replace the destructive welcome sample-graph action with Start browsing. Reopening from a studio returns to Canvas so the targets exist, stops preview playback and retains graph selection, editor identities, drafts, connections and earlier runs.
- Portal the dialog outside the app so background content can be inert while its controls remain visible in the spotlight. Contain keyboard navigation and workspace shortcuts, restore the opener or Help when it has unmounted, and measure the real card/target rather than assuming a fixed height. Missing/replaced targets retain a usable centered tour.
- Independent review found a delayed initial hydration failure could reset panels and pull someone out of a newly entered studio. Gate first-run reset and onboarding together on the latest empty Canvas, incomplete onboarding and no active tour. User work/navigation wins over a delayed empty/error response.
- Native background clicking exposed focus loss to the page without a focus-in event. Keep background pointer-down from blurring the card and capture otherwise-unfocused keyboard events; Escape still dismisses and workspace shortcuts stay blocked. Let in-card focus scroll its own bounded content at high zoom, and fall back to Help when initial body focus cannot be restored.
- Final gates passed: 1,523 frontend tests/151 files, lint/style guards, TypeScript/production build/budget, all 255 node contracts and independent reviews. Native Chrome normal/200% verified every live target, navigation, background focus and Create draft retention. Seven synthetic nodes/six edges and exact graph export survived with zero generation or connection checks. Private proof stays outside Git; owned servers/tab were closed and the original browser state was restored. This slice remains local.

### 2026-10-08 — Result context and comparison

- Continue on isolated `codex/result-context-comparison` above the local discovery/onboarding commits. Keep this slice to gallery context, two-result comparison and explicit draft reuse; no publication, provider calls, dependencies or Electron changes.
- Live nodes can contain edited parameters and stale Create-origin captions. Attribute an artwork only to a terminal saved run whose actual result outputs match; inspect its frozen recipe and resolved inputs. Unrecorded artwork shows current settings explicitly and cannot claim saved-recipe reuse.
- Comparison pins output URLs and their context at selection, independently of later node edits/reruns, filters or deletion. Keep existing history and graph connections intact. Copy one result into a new draft revision with one variation, preserving its saved provider route; invalidate old uploads/asynchronous composer work. Provide Undo for the previous ready draft until further authoring changes it.
- Independent review found ordinary runs never retained `resultOutputs`; fixture-only metadata would have hidden a broken real loop. Record every owned executed node’s output immutably, including generated upstream prompt/reference values, before terminal settlement. Reject unknown nodes, unowned and terminal writes. Preserve Paper/Cinema freshness and existing replay semantics.
- Keep the gallery mounted for the whole Create visit so deleting the last live result cannot discard a pinned comparison. Other dual-provider recipes still use current configured credentials; make that visible in recipe details. Krea’s explicitly saved access mode remains pinned. Undo restores ready references and warns when unfinished attachments were revoked.
- A primary-input-only disclosure would undercount Kling start/end frames. Keep every connected input in frozen display metadata, while admitting only recipes that Create can reproduce without dropping ports. Count recovered image inputs explicitly; parameter-based references remain in saved settings.
- Final gates passed: 1,575 frontend tests/156 files, lint/style guards, TypeScript/production build/budget, 255 node contracts and independent review. Synthetic browser reuse/Undo, focus and comparison preserved the exact seven-node/six-edge graph with zero generation/check/handoff requests. Desktop geometry and compact layout were inspected; native Chrome/Dia control prevented actual 200% zoom proof, and the wide in-app screenshot clipped to its visible panel. Those limits are recorded rather than treated as passed visual checks.
- Captured the full normal-width gallery in native Dia after final source verification. Modal/reuse interactions remain proven in the in-app browser; actual native 200% zoom remains open. Close owned preview tabs/servers and restore the original browser state before handoff; no fixtures or screenshots enter Git.

### 2026-10-08 — Shared workspace navigation and controls

- Continue the approved UI queue on isolated `codex/workspace-navigation`, based on local result comparison commit `139b2019`. Keep the parallel Design-agent checkout, real running app/accounts and packaged Electron untouched; no publication is requested.
- Consolidate the active workspace identity and Canvas return pattern, remove covered Canvas/Editor controls from studio keyboard focus, and make secondary Canvas file/layout actions discoverable in a bounded menu. Preserve explicit Run/Generate, selected objects, drafts, saved history and prior Canvas viewport.
- Inspection exposed real continuity gaps beyond the covered controls: Canvas remount refits, Cinema resets its selected shot, and Character/Moodboard unmount drops invalid or pending-autosave drafts. Preserve those values in volatile UI/draft state by object identity; authoritative graph replacement resets Canvas camera/shot context, while explicit View on Canvas still owns target centering.
- Use one shared heading/return component inside each existing workspace layout. Commons retains its dirty-labeling guard and actual prior-workspace return. Canvas identifies itself with a heading and one contextual Edit video action; file/layout tools use an ordinary-button disclosure, with Fit retained only in Canvas navigation. No new animation or global appearance changes are needed.
- Independent review caught fixed-height rows and lazy stylesheet ordering that would undo wrapped headers. Give shared headers measured auto rows, bounded scrolling and stronger scoped layout rules; wrap Composition's inner tool groups. The secondary-actions surface composites existing glass onto the Canvas base so graph text cannot interfere with menu labels.
- Review required canonical draft aliases after a first save, persisted per-draft analysis ownership and resolved project IDs in cache keys. A new/saved asset now has one mutable draft, overlapping responses cannot clear another request's busy state, and a reconnect to another project cannot save the previous project's draft into it. Explicit New starts a new epoch; pending Canvas handoff navigation yields to later studio changes.
- Fence delayed graph-import fitting on any workspace transition, including a quick away/back round trip. Enable Edit video only for the selected settled node's actual Video output. Video preview keyboard playback yields to native controls and prevented events.
- The synthetic preview initially omitted the separate Moodboard-root override, which allowed a read-only list of existing library entries. No existing entry was opened or edited; add the override and restart before Moodboard authoring verification. Screenshots and fixtures remain outside Git.
- Final gates passed: 1,680 frontend tests/163 files, lint/style guards, TypeScript/production build/budget, all 255 node contracts and independent reviews. Synthetic browser checks retained Create/Character/Moodboard drafts, Cinema selection and exact Canvas camera, with seven nodes/six edges unchanged and zero generation/check/handoff requests. Compact menu/headers were inspected at 600×379; native browser 200% zoom remains unverified. No dependency, backend handler, real asset/account or packaged Electron change; local slice only.

### 2026-10-08 — Approved UI integration

- User approved merge and push of the four completed UI slices. Fresh remote main is ffcd5bf8; the isolated checkout fast-forwards main to e78ad4f3 without changing the parallel Design-agent checkout. Keep the tested commit history intact and update acceptance-document integration status. No new application code, dependency or Electron change is needed.
- Retain the final 1,680-test/lint/TypeScript/build evidence for the identical application tree. Current generated-reference parity, 255 node contracts and informational provider inventory pass. Publication requires a final outgoing credential/private-artifact scan and exact remote-hash verification; GitHub CI is checked separately from local validation.

### 2026-10-08 — Compact workspace sidebar

- User requested removing the unused vertical space in the Canvas sidebar. Work from published main 3ef2d9a5 in the existing isolated checkout; preserve Design-agent and Brand Lab.
- The rail stretches because both top/bottom are fixed and its groups use space-between. Fit its height to the actual controls, preserve top/left position, width, destinations, click targets and keyboard/onboarding identity. Short windows use tighter gaps/padding and 40px controls; exceptionally short windows need bounded scrolling with native title/accessibility labels instead of clipped custom tooltips. No action or generation behavior changes.
- Browser drawer/resize checks exposed a related existing Fit View bug: the built-in control captured padding during render and retained a closed compact drawer's width, moving the graph offscreen. Measure current chrome when Fit is clicked and fall back to the rail reservation when a covering drawer leaves no canvas area. This small scope addition keeps the graph usable during sidebar navigation; graph data and generation remain untouched.
- Independent review caught a classic-scrollbar clipping risk in the very-short narrow rail. Restore the 56px rail width only at the scrolling breakpoint to reserve the app's 8px scrollbar space while preserving 40px buttons and the derived drawer offset.
- Verification: 53 focused navigation/fit/rail/Commons/Canvas continuity and focus tests plus 36 onboarding tests passed; lint, TypeScript and production build/budget passed. Synthetic browser checks measured 426px desktop and 390px narrow rail height, all eight actions visible at 379px window height, and keyboard access at 300px height. Drawer dismissal and covering-drawer Fit both retain seven visible graph nodes. Exact exported seven-node/six-edge graph stayed unchanged, with zero generation, provider-check or handoff requests. Private screenshots/fixtures remain outside Git; this slice stays on codex/compact-sidebar pending merge.

### 2026-10-09 — Flora interface comparison

- The user redirected the next UI pass into a read-only Flora/Nebula comparison. Reuse the isolated checkout on published application tree cba5bbb1; do not integrate the parallel Design-agent/Brand Lab work or change application code.
- Separate observed signed-in Flora screens from official documented contracts, and separate synthetic Nebula browser proof from source-derived risks. Keep account/project identifiers and screenshot/fixture artifacts outside Git. Native browser input became unreliable during additional Flora panel inspection; do not report failed automation as competitor defects.
- Live compact-window inspection reproduced a pinned Inspector covering navigation. The shell does scroll at 300px height, so reject the initial clipping hypothesis. Existing Create comparison/Use as input and compatible connection creation are foundations to extend, not missing features to rebuild.
- Recommend repairing control overlap first, then selected-result next steps, canvas intake safety, scope/reference disclosure and workflow previews. Preserve Paper snapshot/history semantics and explicit execution throughout. Log the separately verified imported-mesh capture gap under the standing Flora scouting rule; no model integration is included.
- Verification: source review corrected the compact-drawer expectation and unchanged-Paper refresh case. The synthetic graph exports match exactly; generation/provider-check/handoff counters all stayed zero. The interactive comparison changes stages and fits a 320px viewport without horizontal overflow; temporary servers and the preview link were removed. Only the report, gap log and these notes are staged, with a clean credential/private-artifact scan. No application tests were rerun for this documentation-only audit.
### 2026-10-09 — Contextual canvas next steps

- Implement the first two Flora audit recommendations: keep pinned Inspector clear of navigation and expose compatible next steps beside a selected result. Defer canvas upload, broader run disclosure and workflow previews.
- Reuse typed catalog compatibility and the atomic create/connect endpoint. Confirm the pair before dismissing the picker, expose pending/failure state, and record one structural undo entry. Preparing a step never executes it.
- Limit contextual actions to current canonical media outputs. Older batch previews remain browsable but cannot silently connect the current artifact in their place.
- Capture a short silent walkthrough of the actual UI using a private public-logo fixture. Keep footage and synthetic backend state outside Git; show preparation and an explicit Run control without paid generation.

- Independent review found lost acknowledgements could permit duplicate backend pairs. Quarantine uncertain creation until an exact canonical sync or authoritative graph replacement; definite client rejections permit retry. Require a typed confirmed edge from the fully atomic backend endpoint.
- Saved provider configuration loads lazily through read-only settings/status requests. Fence late responses against newer connection changes; browsing/setup never checks a credential or executes a recipe.
- Restrict the contextual button to backend-synced canonical Image/Video outputs; previous batch artifacts and unsynced local sources remain inspectable. Existing drag-to-empty menus retain their original placement and wiring direction.
- Inspector uses shared drawer geometry, retains pin/drag/resize preferences, and temporarily yields when a drawer covers compact canvas space. Normal short windows retain bounded body scrolling.
- Existing global Undo/Redo is a local structural restoration; later authoritative backend sync can restore CLI changes. This pre-existing persistence limitation remains outside this slice, and the demo does not claim durable backend Undo.
- Final visual review exposed an over-tall compatible picker. Cap it at 560px within the viewport and widen it to 360px so all three intents fit together; only the model list scrolls. Keep these rules scoped to the existing appearance.
- Final gates passed 1,761 frontend tests in 167 files, 34 focused backend tests, 255 catalog contracts, lint/style guards and TypeScript/production build/budget. Browser preparation preserved both earlier logos and prompt edges, confirmed one new Image connection and left its video output empty, with zero generation/check/handoff requests. Keyboard destination focus and 800×600/800×300 Inspector geometry passed.
- Deliver a silent 28-second walkthrough from high-resolution real UI captures plus phone-friendly picker and Inspector screenshots. The public-logo fixture, media composition and visual proof stay outside Git; no paid generation, real credentials, parent checkout changes or publication are included.

### 2026-10-09 — Scroll affordances in Canvas panels

- User requested a bottom fade to make clipped panel content visibly scrollable. Add one shared scroll viewport primitive to the actual list/body owners; keep fixed panel headers and navigation outside its mask.
- Show the 28px fade only while more than one pixel remains below the viewport. Remove it at the end, when content fits or when hidden. Observe viewport/content size, DOM changes, font and image load, and scrolling so expanded sections and native Inspector resizing update the cue.
- Use a content mask rather than a positioned overlay, preserving pointer/keyboard behavior and the existing DOM layout. Keep the rightmost scrollbar strip fully visible. No generation or stored workspace state changes are included.
- Apply it to the compatible-node picker, pinned/unpinned Inspector, Nodes browser, Assets list, Run History list, Settings body/provider list and Agent Log. Keep semantic list elements and existing refs intact; exclude code previews and studio galleries from this Canvas-panel slice.
- Independent review found Assets filters and History safeguards can overflow their outer bodies in very short windows. Give those actual outer scrollers their own cue as well; each parent/inner list measures its own remaining content independently.
- Verification passed 123 focused tests in six files, including 12 overflow/lifecycle/ref/focus regressions, plus lint/style guards, TypeScript and production build/budget. Opening this chat in the desktop app restored the built-in browser attachment. Live review at 987×792 confirmed the Nodes list fades while content remains below, clears its mask at the end, and stays unmasked for fitting Paper results. Fresh screenshots are saved outside Git in the private audit folder. The synthetic graph retained three nodes and two edges, with zero generation/check/handoff requests; other panels and the separate native Chrome timeout were not visually verified in this follow-up.

### 2026-10-09 — Chat provider, model and effort picker

- Replace the primary agent tabs with a compact model picker that distinguishes account/provider setup from actual model and effort choices. Continue in the owned isolated worktree on `codex/chat-model-picker`; leave the parallel Design-agent checkout and packaged Electron untouched.
- Verify current installed CLI capabilities and official subscription/authentication contracts before exposing subscription-backed choices. Codex model/effort options must come from its live read-only catalog, rather than app model-name guesses; opening the picker and changing selections never start a chat turn or media generation.
- Preserve the current conversation display and canvas while applying new selections to the next explicit send. Keep credentials in the existing local auth mechanism; do not copy tokens into browser storage or introduce API-billing fallback under a subscription label.

- Authentication boundary: this feature controls each installed, unmodified CLI and uses its existing login. Nebula adds no Claude OAuth flow or credential collection. Label Claude as “Claude Code” and show the actual CLI auth mode; inherited API authentication must not be described as subscription billing. Anthropic explicitly permits end users signing into their own unmodified CLI, while its third-party credential-routing restrictions remain applicable; this change does not establish a hosted/commercial subscription service. Primary sources: https://code.claude.com/docs/en/legal-and-compliance and https://code.claude.com/docs/en/authentication. Codex local/open-source app-server discovery uses its read-only catalog; https://learn.chatgpt.com/docs/app-server.
- Each provider remembers only its selected model and effort in browser storage. A retired saved choice remains visible and blocks send until the user chooses a supported setting. Changing the provider starts a new runner session while retaining displayed messages; changing a model or effort resumes the same conversation on the next explicit send.

- Picker layout: a portal keeps the popover clear of panel clipping, a short independent model scroller keeps thinking controls visible, and native radio groups use a radio-aware Tab boundary. Live review showed the outer 480px cap faded the final effort row; allow a natural height up to 520px within the viewport, so all available effort chips remain visible at the normal desktop size. Keep raw internal plan codes out of the picker; distinguish subscription/CLI connection from API, bearer-token or cloud-provider billing.
- Verification so far: the full frontend suite passed 1,779 tests before the later component cases; the final focused Chat suite passes 34 cases, including rejected-choice refresh with no resend, stale choice recovery, Commons scope, resume/history, billing modes and keyboard behavior. Lint and production build/budget pass. Live browser review at 987×792 verified actual Claude/Codex catalogs, saved choices across provider switches, Tab containment and Escape returning to the model trigger. Screenshots stay outside Git. Catalog probes and UI review sent no model turn, and synthetic canvas generation/check/handoff counters stayed zero; message forwarding and resume are tested with fixtures rather than paid turns.

- Backend catalogs initialize the installed CLI without a user message: Claude’s initialization model list and Codex’s paginated `model/list` after `account/read(refreshToken:false)`. Live metadata-only probes returned 11 permitted Claude choices and seven Codex choices. No thread, turn, prompt, tool call, credential refresh or new login was dispatched.
- Explicit choices receive a fresh typed model/effort check inside the tracked response task before workspace acquisition, capability minting or runner startup. Stop/disconnect waits for discovery process cleanup. Unsupported/retired choices fail with machine-readable codes; missing runtime defaults require a choice rather than guessing. Runtime efforts including `max`/`ultra` pass through, and a null default effort omits the CLI effort override. Legacy callers omitting both fields retain their existing runner defaults.
- Discovery gets no Nebula graph/private-library capability. Claude disables tools, configured MCP servers, hooks and persistence while retaining ordinary CLI-owned authentication; effective API/bearer/cloud authentication clears subscription-plan metadata. Fable remains excluded by both public ID and resolved alias. Codex explicitly disables configured MCP names, plugins/hooks/apps and remote control for metadata discovery. Its installed CLI rejects an obsolete user setting under strict parsing, so discovery uses ordinary parsing with those explicit overrides; managed policy can still constrain configuration, and CLI cache/metadata writes remain CLI-owned. Nebula does not copy credentials or modify global auth/configuration.
- Backend verification passed 160 focused tests across catalog, API, runner/resume, workspace, authority, process and selection contracts. Four blocked-discovery transport tests cover Stop/disconnect for both CLIs before any turn authority exists; two cleanup-failure cases require cancellation failure without a false confirmation or raw private diagnostics. Existing FastAPI lifecycle deprecation warnings are unchanged; real conversation execution remains fixture-tested rather than a paid live turn.

### 2026-10-09 — Type-first node discovery

- Continue in the owned isolated worktree on `codex/type-first-node-menu`, above the locally reviewed Chat picker. The parent Design-agent checkout and packaged Electron remain outside scope; no merge or publication is requested.
- Fresh signed-in Flora inspection confirmed a compact Add Node menu with media types and direct search. Clicking Image creates a default unrun draft immediately, rather than only opening its apparent submenu; undo restored the empty canvas and no generation was started. Nebula will retain an explicit named-node choice after browsing a type, preserving provider readiness and avoiding silent model defaults.
- Use Image, Video, Audio, Text, Import and 3D as primary browse choices, with Workflow and Tools for existing graph controls and other capabilities. Keep Search all models immediately available; retain the complete model catalog, task/provider search, setup actions and click/drag insertion. Classification uses actual definitions, keeping sources and incidental thumbnail/metadata outputs from masquerading as generation types.
- Type navigation, filters, Back and clearing search change only discovery UI state. Import browses existing Paper/file source nodes and does not itself upload, export or refresh. A selected model is still added through the existing authoring path; nothing generates until an explicit run.
- Browse media models before their editing/helper groups, while retaining the complete catalog's existing group order and collapse preferences. Filtered/type views start expanded and allow real per-context collapsing; a new query expands its own matching results. A recovery test exposed an absent-category collapse mismatch: render treated a missing entry as collapsed but the first toggle kept it collapsed. Align the store's toggle fallback with the rendered default so the first click opens newly introduced or partially restored categories.
- Independent review caught focus loss when an empty-state button removes itself; Clear filters and suggestions now focus the persistent search field. Short windows use compact controls and reserve an 80px inner result viewport, letting the outer body scroll when needed instead of collapsing results to zero height. Both actual scrollers retain their own bottom fade; normal entry views use natural content height.
- Live browser checks covered direct task search, scoped Video/provider search, explicit one-node addition, six Import sources, Back/Escape, native keyboard traversal and responsive bounds down to 390×300. Browsing and final cleanup preserved the exact original graph/execution export; counters remained zero for generation, provider checks and motion handoff. The browser Undo keyboard check did not confirm removal of the backend-created test node, so cleanup used explicit Delete; this slice makes no new Undo claim. Browser metrics were restored and Flora was returned to Projects. Private synthetic screenshots/fixtures remain outside Git.

### 2026-10-09 — Centered hover toolbar

- Continue in the isolated worktree on `codex/hover-workspace-rail`, above the local node-picker change. The request concerns the left icon toolbar, so retain its actions and existing drawers.
- Center the toolbar vertically and reduce desktop rows to 36px. Its visible shell is 44px wide at rest and expands to the reserved 56px footprint on hover or keyboard focus. Animate horizontal shell/button width and icon scale only, preserving row positions and drawer placement. Keep the navigation element itself at the reserved width so pinned Inspector and canvas-fit measurements cannot collide with the expanded shell.
- Devices without hover or with coarse pointers keep the shell expanded and 44px targets. Retain short-window scrolling and disable these transitions for reduced motion. No backend, graph or generation behavior changes.
- Independent review identified the extra Commons action as an overflow risk on short touch windows. Use the full shell painted on the scroll container below 378px desktop height or 450px touch height, with an inset keyboard focus ring that stays visible when scrolled.
- Live checks confirmed exact vertical centering at 987×792, 44px/56px shell states, unchanged row positions and drawer offset, keyboard expansion, reachable Settings in an 800×300 scroller, 44px touch rows at 390×390, and zero transition duration with reduced motion. Browser emulation was reset afterward. The synthetic three-node/two-edge export stayed identical and all generation/check/handoff counters stayed zero. Verification: 57 relevant frontend tests passed; lint/style guards and production build/budget passed. Private compact/expanded screenshots remain outside Git.

### 2026-10-09 — Flush-left toolbar

- Remove both desktop/mobile outer margins and anchor the compact shell at the viewport edge. It expands toward the canvas only. Shift the compact action groups 6px left to keep icons centered inside that shell, preserving their vertical positions and existing pressed-state scale. Touch and short-window full shells use no group shift; reduced motion also disables group transitions. Inset the narrow-layout focus ring to keep it inside the viewport.
- Live desktop compact/hover and 390×720 touch checks confirmed a zero left offset and exact vertical centering. Touch rows remain 44px; browser emulation was restored. Lint/style guards and production build/budget passed. This CSS spacing adjustment adds no tests; screenshots remain private outside Git.

### 2026-10-09 — Match toolbar and node radii

- Use the effective visible image-node corner token (`--sr-node-media-radius`, 14px) for canvas toolbar shells: left rail, Canvas/Edit video header, Run/actions bar, contextual selection bar and zoom control shell. Inner action buttons use the smaller 8px node/control radius, with matching inset highlight radii. Apply the shell token in the rail's mobile and short-scroll overrides too; changing the global pill token would affect unrelated UI.
- The initial source audit found the base 8px node token, but the live computed-style check exposed overrides: text nodes use 12px and image-node cards use 14px. Correct the toolbar shell choice to the image nodes actually visible in the preview and keep all node/media radii unchanged. Preserve toolbar sizing, hover expansion, flush-left placement and vertical centering.
- Live computed styles confirmed 14px corners on all canvas toolbar shells, including the contextual selection bar and the short 390×300 touch scroller. Inner controls measure 8px; touch rows remain 44px. Browser emulation was restored; the synthetic graph export stayed identical and no generation/handoff was dispatched. Lint/style guards and production build/budget passed. No new tests for this CSS-only visual change; actual screenshots remain outside Git.

### 2026-10-09 — Smaller resting rail and studio navigation

- Reduce the resting rail shell from 44px to 36px, with 28px square buttons and 16px regular icons. Each action retains its 36px row footprint using balanced margins, so expanding to the existing 56px shell/44px-wide buttons does not move row centers under the pointer. Keep touch targets at 44px, keyboard expansion, short-window full-size scrolling, flush-left placement and reduced-motion handling.
- Replace the top-level Edit video action with two-way Canvas / Creator Studio navigation. Video editing belongs on ready video nodes; removing its global entry must also supply a direct node-level action using current output/source guards.
- Share the mode navigation with Creator Studio's existing header and expose the active workspace with `aria-current`. Keep one accessible page heading and an icon-only Back action in Studio. Reuse the existing entry/exit actions so drafts, history, selection, graph connections and active jobs survive switching without dispatching generation.
- The selected video node's Edit video action uses the completed canonical `video` output and rejects stale node data, imports, whitespace-only URLs, mismatched types and earlier batch previews. Dynamic video nodes use their effective ports. Restrict this shortcut to the `video` port because the existing editor wires that exact source handle; auxiliary video URIs cannot enter the editor through it.
- Live verification confirmed a 36px resting shell, 28px buttons, fixed row centers during hover, 44×36px expanded buttons, keyboard expansion, 44px touch targets, short-height scrolling and zero transitions under reduced motion. Canvas / Creator Studio switched both ways with the saved draft intact. A locally generated two-second test clip opened through its node action with loaded media and a two-second editor timeline. Restore the original three-node/two-edge synthetic graph afterward: the export is exactly unchanged and generation, handoff and provider-check counters are zero. Browser emulation was reset; screenshots and synthetic media remain outside Git.
- Verification: all 163 focused tests passed across 11 files; lint/style guards and production build/budget passed. Independent read-only review found no material blockers. No provider, backend, package or packaged Electron changes.

### 2026-10-09 — Current Krea MCP asset upload route

- The authenticated current MCP upload contract returns an HTTPS `api.krea.ai/assets/presigned` URL with a signed query, while the adapter allowed only the older `/public-api/assets/presigned/` path-token route. Permit the exact new path alongside the legacy prefix, retaining the same host, HTTPS, port 443 and no-userinfo restrictions. Compare the raw parsed path so encoded aliases and suffix routes cannot broaden the upload destination. Keep redirects disabled; a redirect response fails before any generation submission. Signed queries and account identifiers stay out of logs and repository evidence.
- Focused adapter verification passed all 39 tests, including multipart artwork upload and materialized output through both allowed routes, rejection before file transfer for ten invalid destinations, and 302/307/308 responses without forwarding the local file or submitting a generation job. `git diff --check` passed. This repair changes only local upload-contract handling; no server restart or paid generation was performed for these tests.
- The live upload probe then confirmed HTTP 200 with no Content-Type and a single plain-text asset URL, matching the current MCP tool description and the official upload instructions (https://www.krea.ai/docs/developers/mcp). The old adapter assumed a JSON object unconditionally. Decode the documented raw-URL body explicitly for text/plain or absent Content-Type, retaining legacy JSON objects including absent-header objects. An advertised JSON response must parse as JSON; malformed JSON never falls back to text. Empty, HTML, mixed/multiple URLs and other unusable bodies fail before generation with a generic error that cannot disclose provider response text or signed URLs.
- Updated focused verification passes 58 adapter tests: both allowed routes now exercise JSON and raw URL success through file upload and output materialization; thirteen unusable response contracts fail without any generation call or private-body disclosure. Destination and redirect protections still pass. `git diff --check` passes; no restart or generation was performed by this repair.
- A bounded response-security review found that the shared media URL validator permits userinfo, and the pre-existing upload destination guard only rejected nonempty usernames/passwords. Keep the shared validator unchanged, but explicitly reject any userinfo in upload result URLs and destination URLs, including empty userinfo. Credential-bearing raw/JSON responses fail before generation with the same generic error.
- Final focused verification passes 68 adapter tests, including eight raw/JSON userinfo response failures and two empty-userinfo destination failures. Existing invalid URL/body, host/scheme/port/path and no-redirect assertions still pass. `git diff --check` passes; shared media validation, server state and generation remain unchanged by this review.

- Broader Krea verification passed308existingtests across gateway, MCPgeneration, OAuthconnector, agentMCP, MCPserver, desktopAPI, directhandler and catalog. Live artwork upload through the new route/plain URL response succeeded; the following explicit video submission was rejected by Krea for exhausted selected-workspace compute before a job was accepted. No alternate workspace or API-token billing was used. Private video state and provider diagnostics remain outside Git.

### 2026-10-09 — Settings-controlled canvas minimap

- hide the map by default and expose a separate persisted Interface preference, independent of performance mode. Use a new opt-in key so the old expanded-by-default/collapsed flag cannot count as consent to show it. Remove the canvas collapse/restore controls and their unused styles; preserve zoom, Fit and node count. Continue in the isolated `codex/settings-minimap` checkout above current main.
- Verification: 90 focused Settings, store, canvas-navigation, focus and workspace tests passed, including legacy defaults and persisted opt-in across reloads; lint/style guards and TypeScript/production build/budget passed. Live browser review confirmed the default hidden canvas, checkbox-driven map appearance/removal, and retained zoom/Fit/count controls with performance mode on. The preview is left with the map off; screenshot evidence stays outside Git.

### 2026-10-12 — The person is a token, not an Origin (person gate, PR A)

- Why: any local program could write `Origin: http://localhost:5173` and pass as the person (change spend limits, accept its own proposals, start chats, run Enhance unlimited). The person is now one secret per launch (`services/person_session.py`); a request is the person's only with no agent marker and a valid `X-Nebula-Person` (`services/person_gate.py`). `local_guard` keeps its Host/Origin CSRF checks unchanged.
- `backend/devserver.py` departs from the plan's "token in env only for the reload supervisor": the token never enters any environment. It rides inside the pickled `uvicorn.Server` subclass that `ChangeReload` already sends each worker over multiprocessing's pipe, and the worker calls `person_session.provide()` before importing the app. Same "survives reloads" behavior with no env exposure at all. The link prints only on a TTY (or opens with `--open`); a non-loopback canvas or backend gets no link.
- Env is never a token source on the backend; desktop and headless use stdin (`NEBULA_PERSON_TOKEN_STDIN=1`; the Commons-era `NEBULA_UI_TOKEN_STDIN=1` still works). Commons' separate UI session (`commons/ui_auth.py`) is gone: Commons' human is the person token.
- Frontend: the link fragment moves into sessionStorage (`nebula.person`, bound to the issuing backend origin) and is stripped from the address bar before validation. A tab holding a token pins that backend (no port discovery, no stored fallback, no rediscovery retry), and the header only goes to that exact origin. Browser: header on non-GET/HEAD plus GET `/api/agent/spend` and `/api/krea/*`. Desktop: header on every request to its own sidecar, because an opaque `null`/`file://` origin can read a response only when it carries the token (ACAO is now given for any desktop-renderer request with the token, not just `/api/krea/`).
- `/ws` gets proposal accept keys only after a `{type:"hello", personToken}` frame; otherwise the server sends `personRequired`. `/ws/chat` checks `personToken` (or `commonsToken`, migration) on every send before minting a workspace or token; Daedalus, Hermes, Claude and Codex alike.
- Person-only (all bodies): `PUT /api/settings`, `DELETE /api/settings/api-keys/{provider}`, `POST /api/credentials/update`, Krea connect/check/DELETE and also `/api/krea/trial` (plan scope said connect/check/DELETE; trial starts a checkout on the person's account, so it is gated too). `/tools`, `/tools/call`, `GET /connection` stay open.
- Enhance: person-only, gate first; then 4,000-character cap (413, readable), 20 calls/minute (429), and a log line per call with provider, length and outcome, never the prompt. The frontend renders FastAPI's list-shaped `detail` readably.
- `canvas_events.actor_for_headers` (journal attribution) now says "person" only for a token, not an Origin, so a forged Origin no longer writes person-attributed journal entries.
- One scrub for every child (`services/child_env.py`): `NEBULA_PERSON_TOKEN`, `NEBULA_CONNECTOR_ENCRYPTION_KEY`, `NEBULA_INJECTED_KEYS`, `NEBULA_CONNECTOR_SESSION`, applied to agents, the Commons reader, ffmpeg/ffprobe, Remotion, git, `open`, `ps`/`taskkill`, `sips`, `brctl`, each with a test.
- Desktop: `--nebula-connector-session` argv, `NEBULA_CONNECTOR_SESSION` env and the `/ws?connectorSession=` query are gone. Main makes the token (`person-token.mjs`), writes it to the sidecar's stdin and answers `person:token` IPC only for its own main frame. With `NEBULA_DESKTOP_DEBUG_PORT` there is no token (fail closed; renderer says why); the Vite dev renderer gets one only with `NEBULA_DESKTOP_DEV_PERSON=1`. The real-backend sidecar test proves the stdin token unlocks `PUT /api/settings` and a wrong one doesn't. Whether packaged Electron sends `null` or `file://` as Origin, and whether it enforces CORS for file pages at all, is still unverified until the deferred desktop pass.
- Chat sends are now async (token lookup), so ChatPanel tests await the send before asserting what went out.
- Found, not fixed here: Hermes' narrator makes OpenRouter calls outside the spending limits. The spend stages didn't take it up either; it is open and waiting on Justin's call (see "Follow-ups before pushing" on 2026-10-13).
- Residual, stated in README, MCP-SETUP, Settings and the gate docstring: a same-user program with its own unsandboxed shell can still read the token (backend memory, Chrome's Session Storage/History). The token binds in-app Claude and MCP/CLI/API-only clients; in-app Codex and Hermes only once their shells have no network (PR B, not landed at this commit). The README, Settings hint and MCP-SETUP first said "Nebula's in-app agents"/"never get the token" without that condition; review caught it and they now match `person_gate.py`.

### 2026-10-12 — Accept approves values, not node ids (review fixes on the person gate)

- **The hole (predates the person gate; adversarial review reproduced it).** Accept committed the nodes, then the canvas ran `runNodeIds` from its live store as the person, so outside the spending limits. Between the two, an agent watching `/ws` for `proposalClosed` could `PUT /api/graph/node/{id}` on the new node or any ancestor (Nano Banana flash-lite at $0.034 → Pro at 4K, $0.24) and the person-exempt run used it. The window is long when the run is held back because another was going. The canvas's $1 confirm was the only check, and it doesn't fire below $1 or for nodes with no computable price.
- **Fix: `services/run_approvals.py`.** On accept, before any await, the backend records a fingerprint of the run set (each runNodeId plus everything that feeds it: definitionId, params, incoming wires; outputs, positions and labels left out) and returns `approvalId` only in the accept response. The canvas sends it with the run it starts (`executeNode`/`executeCluster` options → `approvalId` on `/api/execute` and `/api/execute-node`), including the held ("deferred") run. The backend (`_check_run_approval`, inside `_require_run_spend_approval`) uses it up and starts the run only if the caller is the person, the request's nodes and wires are exactly the approved ones, and the live graph still matches the fingerprint. Otherwise 409 "changed since you accepted ... click Run on them yourself"; the node shows it as a start error.
- **Locks.** While an approval waits, any non-person edit that would change its fingerprint is refused with 409: `PUT /api/graph/node`, connect, `DELETE /api/graph/edge`, `DELETE /api/graph/node`, `/api/graph/apply`, node-and-connect and cluster. Candidate-based routes check the staged candidate; direct-mutation routes try the edit on a clone first (`_guard_approved_runs`). One generic check ("would this change any open approval's fingerprint?") instead of per-route rules, so params, deletes and wires-in are all covered the same way. If the clone refuses the edit, the real edit reports its own error; if it somehow didn't, the run-time check still refuses the run.
- **Also before Accept.** The proposal's card showed costs computed at propose time, but an agent could change an existing ancestor between propose and Accept. The proposal now stores the same fingerprint at submit (new nodes named by ref, since staging gives them new ids each time), and Accept refuses (409, invalidated) if it changed: "what it runs changed after it was proposed (n2)". Stricter than `_refuse_overwriting_later_edits`, which only looks at keys the proposal sets; a person's own edit to an ancestor also invalidates, which matches how that check already treats their edits.
- **Decision: compare against the live backend graph, not the request's params.** The canvas's params legitimately differ from `cli_graph` in several known ways: asset URLs rewritten absolute on graphSync (`rewriteBackendAssetUrls`), `paramsForBackend` trimming paper-source history and adding video-edit `speed`, Replicate schema defaults filled in on fetch. An exact request-vs-approval param compare would refuse ordinary accept runs. Agents can only change values through the backend graph, and graphSync makes the canvas mirror it, so with the locks the backend graph is the right place to check values. The request is still checked structurally (same node ids, definitions and wires), so it can't run more or different nodes than approved.
- **Lifetime.** Single-use: the run that carries it uses it up, matched or not, and the locks lift. Also ends on `DELETE /api/canvas/approvals/{id}` (person-only; the canvas calls it when the person dismisses the held run, and after every approved run attempt, where it is a no-op if the run used it, so a run the canvas declined to start, e.g. a "no" on the cost confirm, never leaves nodes locked), on import/project switch/Clear canvas, and after 30 minutes (`APPROVAL_TTL_SECONDS`). Memory-only, like proposals; a restart drops them and a held run is then refused, which only means the person starts it by hand.
- **Tradeoff.** If something legitimately changes a node in the run set between Accept and a held run (the person edits it, or another run's param write-back via `_sync_params_to_cli_graph` touches a shared ancestor), the held run is refused with the "changed since you accepted" message instead of running. Fail closed; one click to run it by hand.
- **Other review fixes in this commit.**
  - ChatPanel: a person link pasted into an open tab pinned the backend, but the chat socket stayed on the dev proxy URL, so `personTokenForSocket` withheld the token and every send was refused until a reload. ChatPanel now listens for `nebula:person-connected` and reconnects at once when its socket isn't on the pinned backend (test fails without the fix).
  - `NEBULA_URL` for agent children pointed at port 8000 under `devserver.py --port N` (workers inherit the parent's argv, which `resolve_nebula_url` didn't recognize). `devserver.main` now sets the non-secret `NEBULA_URL` to its own origin before starting, and `resolve_nebula_url` also reads `devserver.py` argv. Mapped `::` to `::1` like `resolve_nebula_url` does.
  - `POST /api/agents/codex/login/chatgpt` is person-only: it runs `codex logout` first, clearing the person's Codex credentials, the same kind of account change as the gated settings/key routes. Predates the person gate; the design didn't name it.
  - Krea person-only routes returned a plain `HTTPException` without `code`, so a refused connect/check/disconnect/trial didn't raise the "not connected as you" banner. `person_only` now lets `PersonGateError` reach the shared handler (moved to `person_gate.person_gate_error`; main registers it, and so does the Krea test's standalone app). Without the handler a standalone mount answers 500, still a refusal.
  - `docs/commons-integration-ui-notes-2026-10-07.md` still described `commonsToken` on enabled sends only; now says every send carries `personToken`.

### 2026-10-13 — A stable outside budget, app tokens, and Krea plan billing inside the limits (findings 4 and 5)

The person chose 4C (rolling 24-hour outside budget plus person-issued app tokens) and 5B+5C (agents can't switch Krea billing; plan runs are counted against a cap).

- **Outside budget (`services/agent_spend.py`).** `_spend_session` returns `outside:shared` for every caller without a chat or app token; `_SPEND_LAUNCH` is gone, so a restart (which an outside agent with a shell can trigger) no longer resets anything. Outside keys store events `[time, definitionId, usd, planRuns]`; `spent()` sums the last 24 hours, `spent_outside()` sums every outside key (shared plus apps). Chat keys keep running totals, now with `planRuns`.
- **Give-backs keep their window.** `record()` returns the run's time; the hold (`main._SpendHold`) keeps it and `refund(..., at=)` appends a negative event at that time. A refund for a run that already left the window can't lower today's total. An outside refund with no time gives nothing back (fail closed) rather than guess.
- **Migration.** Old `unverified:<launch>` entries updated in the last 24 hours fold into `outside:shared` once, at their `updated` time, including any total not attributed to a model; older ones are dropped. This can overcount for up to a day after the upgrade, by design. Checked live with a seeded ledger.
- **Settings.** `agentSpend.outsideDailyUsd`: absent means "same as sessionUsd", so upgrading never loosened anything; an unreadable value also falls back to sessionUsd. `validate_caps` keeps the key only when the request names it, so the Settings select's "Same as a chat" option simply leaves it out. `agentSpend.kreaPlanRuns`: whole number or null (since revised, see the next entry: 0–100000, default 10 when unset). Per-model `sessionUsd` caps apply to the outside agents' combined 24-hour total.
- **`decide()` takes budgets.** `session_budgets()` builds them per key: a chat gets its session budget; the shared key gets the outside budget; an app gets its own daily limit (no per-model caps) plus the shared one, checked in that order, stricter wins. Any USD budget counts as "limited", so unpriced nodes then need a proposal, same as other limits (a plan-run cap alone no longer does; see the next entry). `decide(spent=...)` without budgets still means a chat session (keeps the old call shape for tests).
- **App tokens (`services/app_tokens.py`).** `nebula_app_` + 256 random bits, stored as SHA-256 in `app-tokens.json` (0600), shown once. Person-only routes under `/api/agent/spend/apps` (that prefix already gets the person header for GETs in the browser). `Authorization: Agent <app token>` passes the workspace middleware (no workspace), `resolve_actor` (actor `agent:app:<id>`) and presence (verified, named as the person named it). A revoked or forged token is a 401, never a fall-through to the shared budget. The MCP server and CLI send `NEBULA_APP_TOKEN`; `NEBULA_AGENT_TOKEN` wins, and `child_env` scrubs `NEBULA_APP_TOKEN` so an in-app chat can't spend as an app. Revoking keeps the app's events, so its spending still counts in the outside total.
- **Deviation: no `nebula mcp connect`.** The design tied app tokens to a `nebula mcp connect` command from PR 3, which doesn't exist on this branch. The person copies the token from Settings into the client's MCP config (docs/MCP-SETUP.md "Connected apps" shows the snippet). The Settings limit is a select per app plus Revoke (with a confirm).
- **Hermes/Daedalus** already got minted chat tokens (commit adc33faa); `test_chat_real_runners` now asserts every in-app turn's token resolves to `chat:<session>`, not the shared budget.
- **5B, Krea billing is the person's.** `main._refuse_agent_krea_billing_change` refuses (403, points at `propose_change`) any non-person edit that changes the effective `_kreaAuth` of a node offering both modes (default `api-token`), or creates one already on `mcp`. Wired into `/api/graph/apply`, `POST /api/graph/node`, `PUT /api/graph/node/{id}` (`nebula set`), node-and-connect, cluster and import. Switching back from plan to token is refused too: it's still a billing change. Account-only nodes are untouched.
- **Surprise: proposals couldn't carry `_kreaAuth`.** `parse_spec` in the proposal route had no `internal_ok`, so the Krea primer's "send any `_kreaAuth` change as a proposal" was a 422. Proposals now take `_kreaAuth` (value checked per node like direct edits), and the proposal bar shows it as "Billed to: API token balance → Krea plan" instead of the raw key or "(empty)".
- **5C, plan runs.** `model_pricing.estimate_run` returns `planRuns` {node: {model, runs}} with runs = batch high multiplier × cinema shots; `decide` multiplies by passes. Counted always (even with no limits), capped when `kreaPlanRuns` is set, given back by the same rules (never reached the handler, missing credential, refused after the check). All plan-billed nodes count, including account-only utilities like Krea Files: Krea doesn't say which calls draw compute, so overcounting is the fail-closed choice.
- **Not done: the optional enterprise usage readout (5C step 3).** Showing actual compute units from Krea's `/usage` endpoint next to the count needs a workspace service key with enterprise entitlement; it would be display-only. Left out of this stage.
- **Plan node with no Krea connection** used to raise a plain `ConnectorError`, so its run stayed counted although nothing was sent. Fixed in "Follow-ups before pushing" below: it is now a missing-credential error and is given back.
- **Agent-facing text.** `describe_node`'s `kreaNote`/`priceNote`, the `edit_canvas` and `get_spend_limits` docstrings, `nebula context` and `nebula spend` no longer say plan runs are "not limited" or that the budget lasts "until Nebula restarts".
- **Settings copy.** The "who these limits bind" hint said Codex and Hermes still had networked shells; that stopped being true at adc33faa, so it now matches README/MCP-SETUP.
- **Live check (isolated backend 8133, Vite 5253, no provider keys).** Seeded legacy ledger migrated to $0.60; an outside $0.43 run was refused against a $1 budget, still refused after a backend restart under another agent name; a counted run that stopped at its key check left +/− events at the same time. Krea: agent edit/`nebula set`/new-on-plan refused, account-only allowed, the switch proposed and accepted on the canvas; with `kreaPlanRuns=1` a two-plan-node run was refused before any Krea call. App token made in Settings, used from curl (`budget: "app"`, own line in the ledger), forged token 401, file holds only the hash. Pre-existing, not from this change: a proposal made before the canvas had a project has `projectId: null` and can't be accepted or rejected from the bar ("belongs to another project").

### 2026-10-13 — Krea billing holds on runs and project snapshots too (review fixes on findings 4 and 5)

Reviewers found 5B covered only the graph-edit routes. Three other ways put a node on the Krea plan without a proposal, and plan runs were unlimited by default.

- **Root cause.** Node params reach the canvas or a provider through more than the edit routes: `/api/execute`, `/api/execute-node` and `/api/quick` take whole nodes in the request; `_sync_params_to_cli_graph` copied a run's params back onto whatever canvas node had the same id, without checking its definition; and `PUT /api/projects/{id}` (and `/api/projects/recover`) stored snapshots that opening the project loads onto the canvas. Verified each with a failing test first (12 of the new tests fail on the previous commit).
- **Runs: one choke point.** `_require_spend_approval` (every run route that isn't the person's goes through it) now calls `_refuse_agent_krea_billing_in_run` before anything is counted: a node may bill only the way the canvas node with its id and definition does; a node that isn't on the canvas, or is there as another definition, starts on the default (API token). `/api/quick` passes `on_canvas=False`, so its temp node never inherits a canvas node's billing. An agent can still run a node the person put on the plan; it counts against "Krea plan runs".
- **Write-back.** `_sync_params_to_cli_graph` now skips any canvas node whose definition differs (for everyone; that was simply a bug). For a run that isn't the person's, `_submitted_params` records what the request sent, and only what the run itself changed is copied (handler enrichment like video-edit's clips), never `_kreaAuth`. Tradeoff: an agent's `/api/execute` no longer persists the request's own param edits onto the canvas. Edits have their own routes with their own checks; the canvas's own runs (the person) still mirror everything.
- **Snapshots.** `save_project` and `recover_project_copy` run `_refuse_agent_krea_billing_in_project` on the staged nodes against the live canvas, then the project as saved (recover: the source project, plus the live canvas when the source is open). Open isn't gated separately: everything it loads came through a gated save, recover or import. Exception: a project saved before this branch, or one in the trash, can already hold plan billing that an agent set back then; opening or restoring it loads that as is (see "Follow-ups before pushing"). The `/api/outputs/restore` bundle route only hands the graph back to the browser, which then goes through the gated import.
- **Plan runs fail closed (minor findings).** `kreaPlanRuns` now follows `outsideDailyUsd`'s shape: kept only when named; unset means `DEFAULT_PLAN_RUNS` = 10 per chat or per 24 hours outside; explicit `null` is the person's "No limit"; anything unreadable (wrong type, negative, over 100000, `agentSpend` not an object) is 0, so every plan run needs a proposal. 0 is now a valid saved value ("Ask every time" in Settings). Chose a default number over "unset means always ask" because plan runs were already allowed and counted; 10 keeps agents useful on a Pro plan while bounding a runaway loop. The frontend reader mirrors this (unset stays unset and shows "10 (default)", unreadable reads as 0 and is never saved back as no limit, values over 100000 are unreadable), so a bad value can't make the next Settings save fail with a 400.
- **Surprise: the default cap would have changed unpriced nodes.** `decide()` treated any budget, including a plan-run cap, as "limited", which makes unpriced nodes need a proposal. With the cap on by default, turning every USD limit off would still have refused unpriced runs. `decide()` now splits USD limits (which gate unpriced nodes) from plan-run limits.


### 2026-10-13 — Local nodes that still call a provider, and the pricing leads (pricing-readiness stage)

The person chose to leave vision-llm QC runs unpriced for now (agents must propose them); heuristic and opencv stay free.

- **`providerVia` on the definition.** `apiProvider: utility` meant "no top-level key", not "never calls a provider". Cinema Scene runs its base image model (`kind: model`); the four QC nodes call a vision model when `mode` isn't heuristic/opencv (`kind: param`). One rule for every surface: `services/node_readiness.py` (backend: find_nodes, describe_node, `nebula context`) and `frontend/src/lib/nodeKeys.ts` (canvas badge, readiness line, Inspector, run chip). `check-node-contracts` validates the field; `test_node_readiness.py` pins it to the handler constants (`_COMMERCIAL_OK_DEFAULT_BASES`, `_DEFAULT_BASE_MODEL`, `_NONCOMMERCIAL_BASES`, `VISION_PROVIDERS`, `VALID_QC_MODES`), so the handler stays the boundary and the definition only describes it.
- **Fail-closed reading.** QC: an absent `mode` is the definition default; any present value not exactly in `freeWhen` (including `''`, null, "Heuristic") counts as the provider call. Cinema: a missing or empty `scene`/`base` reads as `{}` and runs the default, as the handler does (`params.get("scene") or {}`); a present non-object level or unknown model is unreadable (badge says missing, priced as unpriced).
- **QC unpriced.** `estimate_run` and the runScope mirror put a non-local QC run in `unpriced`; `cost_for` labels it "paid · vision model, no list price" (provider `vision`). `NoVisionProviderError` is now a `MissingCredentialError`, so a keyless vision-llm run is given back like any other missing key. Per-model caps in Settings weren't added for QC: unpriced already means a proposal whenever a USD limit is set.
- **Guard test.** Any utility definition whose handler module transitively imports httpx or a provider SDK must declare `providerVia` or sit on a commented allowlist (`krea-style`, `krea-moodboard`, `krea-image-style-reference`: data-only nodes sharing a module with paid Krea handlers). The walk stops at `services.output`, `services.settings` and `services.file_access`, each with its reason; a positive test proves the walk still finds the QC and cinema calls.
- **Wired price params.** If any of a node's wired input ports is a key its price depends on (row match, extras, multiplyBy), the node is unpriced: the value only exists at run time. Same rule in Python and TS, through the shared `pricing_cases.json` fixture. `agent_spend.decide` takes edges as (source, target, targetHandle) triples for this.
- **Kling 3.0 multi-shot.** kling-v3 rows match only `multi_prompt: ""`, so a multi-shot run is unpriced instead of priced as one shot. How a multi-shot run is billed is not verified: Kling's doc only says the shot durations must add up to the total, and neither fal nor Krea says what a run is billed by (or whether a mismatched sum is rejected), which is why it stays unpriced. `checked` 2026-10-12 is the design agent's reading of the kling.ai doc, not mine. The same guard is in `sync-krea-catalog.py` (78 Kling 3.0 rows regenerated offline, `--check` passes), plus a provenance note on the five Krea audio models that their price doesn't vary with `generate_audio`.
- **One settings snapshot.** `_require_spend_approval` takes `settings=` (required) and every run route passes the snapshot whose `apiKeys` go to `execute_graph`, so the check prices the route the run uses. The test flips keys between the check and the run; it fails on the old re-read code.
- **Hand-edited `node_definitions.json`.** The TS-to-JSON export already drifts (extra `_note`s, a gemini-tts label), so only the five `providerVia` lines were inserted textually and checked equal to the TS export. `test_reference_roles.py` pins baseline fingerprints; cinema-scene's `providerVia` is an exact approved addition there (`APPROVED_TOP_LEVEL_FIELD_ADDITIONS`), like the earlier approved deltas, not a new baseline.
- **Not done.** The design's optional step gave `style-reference` (apiProvider google) a providerVia so its manual and passthrough modes, which call nothing, stop being reported as needing GOOGLE_API_KEY and counted as Google runs. Skipped: it only over-reports and over-counts, the safe direction. (`krea-image-style-reference` is a separate case: local, and on the guard's allowlist.) The Inspector lists any-of keys as "Missing API key: A, B, C"; the badge title says "A or B or C".
- **Surprise: the test suite was writing the person's real settings.json.** `test_credential_injection.py` and `test_settings_path.py` restored `services.settings` after each test by deleting `NEBULA_SETTINGS_PATH` and reloading, which points `SETTINGS_PATH` at the repo-root `settings.json` for the rest of the run. Later tests then read the person's keys and wrote it (`test_mcp_tools` PUTs `runCostConfirmUsd: 1` and a cleared `agentSpend`). Present on HEAD too (reproduced in a worktree: the run created a repo-root settings.json there). Fixed at the root: both fixtures reload with the session's sandbox path, and a `pytest_runtest_teardown` hook in conftest fails any test that leaves `SETTINGS_PATH` anywhere else (it errors 88 tests with the old fixtures). Keys in the real file look intact; earlier `runCostConfirmUsd`/`agentSpend` values may have been overwritten by past full runs and can't be recovered from here. A full run now leaves the real file's hash unchanged.
- **Test made deterministic.** `test_find_and_describe_follow_the_readiness_rule` looked for text-input in an unfiltered top-100 list sorted ready-first by name; with keys in the session settings it fell past row 100. It now looks text-input up by name, same assertion.
- **Live check (isolated 8134/5254, no keys).** Badges on Cinema ("Needs FAL_KEY for base seedream-4-5", then "Needs GOOGLE_API_KEY for base nano-banana" after switching the base) and on a vision-llm QC node; none on heuristic/opencv. Run chip "2 paid", tooltip "No list price for … QC Frame Review"; switching QC to opencv drops it to "1 paid". An agent `/api/execute` with a vision-llm QC node got 403 "no list price … propose it"; heuristic started.

### 2026-10-13 — Review fixes on pricing-readiness (guard blind spots, TS/JSON parity, cluster wires)

- **Guard walk fails closed.** `_imports` resolves relative imports against the importing module's package (a relative import with no known package is a hit). Dynamic imports and process spawns are hits: imports of `subprocess`, `importlib`, `pty`, `multiprocessing`, and calls (or string names, for `getattr(asyncio, "create_subprocess_exec")`) of `__import__`, `create_subprocess_*`, `os.system`/`popen`/`spawn*`/`exec*`/`posix_spawn*`. The first strict run flagged `video-edit`, `video-duration-check` (services.ffmpeg) and `remotion-node` (services.remotion_render); both modules run known local programs, so they're on a new `LOCAL_PROCESSES` list with reasons. Only their own spawn is excused; the walk still follows their imports.
- **Stops are pinned, not removed.** Walking through `services.output`/`settings`/`file_access` instead of stopping reaches the whole app (file_access → agent_workspaces → app_tokens → agent_spend → model_pricing → cinema_scene → sync_runner → every handler), so every utility node would read as paid. Kept the stops, but `NOT_PROVIDER_CALLS` now maps each to its reviewed direct imports (network, opaque, in-repo) and `test_the_walk_stops_only_where_it_was_reviewed` fails when one changes. A negative test feeds the walk relative, importlib, `__import__`, subprocess/curl, `create_subprocess_exec` (direct and via getattr) and `os.system` sources.
- **TS/JSON providerVia parity.** `frontend/tests/lib/nodeKeys.test.ts` compares every `providerVia` in `NODE_DEFINITIONS` against `backend/data/node_definitions.json` (deep equality, so key order doesn't matter). Checked it fails on a TS-only `freeWhen` edit. Put in vitest rather than `check-node-contracts.mjs` because that script reads the TS as text and can't evaluate it.
- **Cluster wires.** `wiredPorts` counts only edges whose source is also in the run, because `runCluster` sends only edges inside the cluster; a wire from outside never reaches the backend, which prices the param. Graph and node scopes already include every source, so they're unchanged. The backend `wired_ports` docstring ("the source needn't be in the run") is about the edges a run request carries, which is consistent.
- **Kling multi-shot wording** above corrected: the billed length of a multi-shot run is unverified, matching the `model_pricing.json` note.

### 2026-10-13 — Follow-ups before pushing (completeness critic)

- **A multiplier that can't be read leaves the node unpriced.** `estimate_node` (and the TS mirror) multiplied by 1.0 when a `multiplyBy` value was set but wasn't a positive number, so a duration of "abc", 0 or -4 priced the run as one unit: fail open. Now a set-but-unreadable value (also true/false, which Python would read as 1) returns None; an absent value with no default still counts once (no real entry hits this today: every multiplier has a default). Both sides now read a multiplier the same way: a number, or a string that is a plain ASCII decimal (`_multiplier` / `multiplier`), so "0x10", "1_000" or non-ASCII digits are unpriced on both sides instead of priced on one. New cases in `pricing_cases.json` pin both sides. Docs: MODEL-PRICING.md.
- **No Krea connection is a missing credential.** `KreaNotConnectedError(ConnectorError, MissingCredentialError)`, raised only by `_session_revision`, the check at the start of `session()` before any request. A plan node that stops there gets its dollar and plan-run share back. The same message from `_access_token` stays a plain `ConnectorError`: it runs inside a request that is already being built. Test: `test_a_session_with_no_connection_stops_before_krea_as_a_missing_credential` (Krea host never called). Review caught a hole: the connection is re-read per batch item, so disconnecting mid-batch would have given back items that already ran. The engine now counts handler calls per node per run and marks `missing_credential` only when the failing call is the node's first (`test_a_credential_stop_after_an_earlier_item_reached_the_provider_keeps_the_count`, which fails without the fix).
- **Old projects with plan billing.** Accepted as the person's existing state rather than reset on open or restore: Nebula can't tell whether the person or an agent set `_kreaAuth: mcp` in a project saved before this branch, and resetting would silently change billing the person chose. Agent runs of those nodes are still counted and capped by `kreaPlanRuns` (default 10).
- **Hermes narrator: open, Justin's call.** `services/narrator.py` makes one OpenRouter call (Kimi K2.6) per Daedalus turn with the person's key, outside the limits and the ledger. Since `/ws/chat` needs the person token, every such call comes from a turn the person started. Options: count it against the turn's `chat:<session>` budget at a cited list price, or keep it as part of the person's turn and log each call.
- **Deferred to the desktop pass (tracked in memory):** whether the packaged `file://` renderer sends Origin `null` or `file://` and whether the CORS preflight with `X-Nebula-Person` works there; a `ps` check that no token or connector session shows in argv; a planted skill declaring an MCP dependency under the generated Codex args.
- **Also found:** test runs before 062ecaee wrote `runCostConfirmUsd: 1.0` and an empty `agentSpend` into the repo-root `settings.json` again (06:32). Removed by hand a second time; keys untouched, backup in the session scratchpad. 062ecaee's teardown hook now fails any test that leaves the settings path pointing there.
- **Not fixed (also on main):** a `settings.json` that exists but lacks `apiKeys` (e.g. a hand-written `{}`) leaves Settings on "Settings couldn't load", because `load_settings` adds defaults only when the file is missing.


## 2026-10-13 — Desktop launch tests (integration + resilience) pass

Root causes, in the order found:

- **Isolated launches were not isolated (safety bug, fixed first).** `paths.mjs` always used the real home, so every test/validator launch with `NEBULA_DESKTOP_USER_DATA_DIR` still created dirs, state and `connector-vault-key.enc` in `~/Library/Application Support/Nebula Nodes/`, and the sidecar wrote state there. Migration read the repo-root `settings.json` (real API keys) and `~/.nebula`. safeStorage created a `<app id> Safe Storage` login-keychain item per run. Fix: `resolveDesktopDataPaths` puts the app data root at `<userDataDir>/Nebula Nodes` and migration sources at `<userDataDir>/legacy/...` when isolated; isolated launches also append Chromium's `use-mock-keychain` switch. Normal launches are unchanged.
- **Leftovers from earlier runs, not removed (Justin's call):** his login keychain holds `nebula-iso-1791831100555-a` … `nebula-iso-1791884720149-a` (6) and `nebula-ut-e1` "Safe Storage" items from older validator runs. `Nebula Nodes/connector-vault-key.enc` and `state/` were last modified 2026-10-12 14:51, possibly by one of those launches. I did not delete anything.
- **`rootMounted:false`:** `frontend/dist` held a web build (`/assets/...` absolute URLs → `file:///assets/...` under Electron). Desktop and web builds shared one folder, so any `npm run build` broke the app. Now `build:desktop` writes `frontend/dist-desktop/` (gitignored, eslint-ignored), Electron loads that, the budget script refuses a desktop build with root-absolute URLs, and main shows a "renderer is not built" failure surface before spawning a sidecar.
- **Resilience harness:** `pgrep -f "uvicorn main:app"` counted Justin's dev backend on :8000 (`python -m uvicorn main:app ... --port 8000`), so "0 remaining" could never hold while he works. Tests now snapshot uvicorn PIDs before launching and assert no *new* ones remain, plus the logged sidecar PIDs are dead (stricter than before). The quit-during-startup test polled after a fixed 2 s sleep; a truly fresh profile shows the migration overlay (~1.5 s incl. the 1.2 s "complete" screen) first, so it now polls up to 10 s for its fixture child (matched by this repo's absolute fixture path) and the test timeout went 30 → 45 s.
- **Smoke hardening:** smoke now waits (≤15 s) for `#root` to get children instead of sampling once at did-finish-load, and marks its own sidecar stop as cleanup so it no longer logs "Sidecar exited mid-session".
- Every test launch now sets a unique `NEBULA_DESKTOP_APP_ID`.

Live check (throwaway wrapper in the scratchpad that imports the real `main.mjs`, drives the window from the main process with no debug port, stubs only `dialog.showOpenDialog`): Project Home renders, New project mounts the canvas, `person.token()` returns a 43-char token, a PUT /api/settings without the header gets 403, Settings → Storage → Choose… calls the folder IPC (with the main window, `openDirectory`+`createDirectory`), and the save is a PUT /api/settings 200 whose `X-Nebula-Person` equals the IPC token; the panel shows "Saved". Screenshots were not committed.

Not done here: app icon / packaging (@electron/packager) is a separate stage.

## 2026-10-13 — Review fixes on the launch-test stage

- **Mock keychain is now an explicit test flag, and packaged builds ignore dev/test env vars.** Before, `NEBULA_DESKTOP_USER_DATA_DIR` alone switched safeStorage to Chromium's mock keychain, whose key is a public constant, while `isEncryptionAvailable()` still said true. Anyone using an isolated profile as a real second profile would have stored keys effectively unencrypted under a "Keychain-protected" UI. Now the mock keychain needs `NEBULA_DESKTOP_TEST=1` *and* a user-data dir, and main logs a warning when it's on. New `desktop/launch-overrides.mjs` decides which overrides apply: when `app.isPackaged`, `NEBULA_DESKTOP_DEBUG_PORT`, `_USER_DATA_DIR`, `_APP_ID`, `_TEST`, `VITE_DEV_SERVER_URL` and `NEBULA_DESKTOP_DEV_PERSON` are all ignored (and named in a warning). That makes the "packaging check" the reviewer suggested a runtime property of the app rather than a build-script lint, so it holds no matter how the package was built. `main.mjs` no longer reads those vars from `process.env` directly; a source test enforces it.
- Tradeoff: a user-data dir *without* `NEBULA_DESKTOP_TEST=1` uses the real keychain and leaves one "<app id> Safe Storage" item per new app id. That's the correct behaviour for a real profile. All test launches set the flag, and any validator that launches Electron should too.
- Not live-checked: the packaged branch, because faking `app.isPackaged` in a wrapper would make main ignore the isolation vars and use Justin's real profile. Covered by unit tests; check it for real in the packaging stage.
- **Renderer-missing check moved to the top of `whenReady`**, before `prepareAppDataEnv`, credential setup and the one-time migration, so a first launch without `frontend/dist-desktop` no longer creates the real app data root or runs migration before failing. Live check: with `dist-desktop` moved aside, an isolated smoke launch failed with the build message and `<profile>/Nebula Nodes` was never created.
- **Resilience test PID filter:** new `uvicorn main:app` PIDs only count if their environment (read with `ps -E`) contains the test's temp-profile prefix (`$TMPDIR/nebula-res-`), which the sidecar's `NEBULA_STATE_DIR` etc. carry. A dev server restarted mid-run no longer fails the test. If the env can't be read, the PID counts as ours, so the check stays strict.

## 2026-10-13 — Nebula.app: packaging, icon, clean quit

- **The bundle is a thin launcher that runs the checkout.** `npm run package` (`desktop/scripts/package.mjs`, `@electron/packager` 20.3.0) puts only `packaging/bootstrap.mjs`, `app-repo.mjs`, a stripped `package.json` and `nebula-app.json` (absolute repo path, validation flag, Electron version) into `Nebula.app/Contents/Resources/app`. The bootstrap checks the checkout (`desktop/main.mjs`, `backend/main.py`, executable `backend/.venv/bin/python`), records the packaged config in the checkout's `packaged-launch.mjs`, then `await import`s the checkout's `desktop/main.mjs`. So backend *and* Electron main/preload changes arrive with `git pull`; only the renderer needs `npm run build:desktop`, and an Electron bump needs a re-package (the bootstrap logs a warning on mismatch). Alternative considered: copy main.mjs and friends into the bundle. Rejected because the bundled main would drift from the checked-out backend it talks to.
- **Renderer path:** the brief said `frontend/dist`; the desktop renderer actually lives in `frontend/dist-desktop` (`npm run build:desktop`), and that's what the app loads and the package script rebuilds when missing or older than `frontend/src`, `public`, configs.
- **Validation builds.** The earlier stage made packaged builds ignore every dev/test override, which is right for Justin's app but means the real bundle can't be launched against a throwaway profile. `npm run package -- --validation` builds a separate bundle in `desktop/out/validation/` whose `nebula-app.json` has `validation: true`; `treatAsPackaged()` then honours the overrides. `install-app` refuses it. The normal bundle differs only in that flag. On the bootstrap's own error path (main.mjs never runs) a validation build also applies `NEBULA_DESKTOP_USER_DATA_DIR`, because the first missing-repo test opened Chromium on the default profile name (it wrote nothing, and the App Support hash didn't change, but it could have).
- **Name / bundle id.** CFBundleName "Nebula", bundle id `com.nebulanodes.nebula-desktop`, and no `productName` in the bundled package.json, so Electron's app name stays `nebula-desktop` (logged at startup and checked live). That keeps the same profile dir, single-instance lock and "nebula-desktop Safe Storage" keychain item as `npm run start`, so the two can't run on the same data at once.
- **Signing.** Not Developer ID signed or notarized. The package script ad-hoc signs the bundle (`codesign --force --deep --sign -`) because packager's Info.plist/icon rewrite otherwise leaves Electron's seal broken; `codesign --verify --deep --strict` passes. `spctl --assess` says `rejected` (expected), the bundle has no `com.apple.quarantine` (only `com.apple.provenance`), and `open -n` launched it without a prompt. README cites Apple's Gatekeeper and "Open Anyway" pages for the downloaded/quarantined case; Apple's pages don't say anything explicit about locally built apps, so the README states what was observed rather than claiming a rule.
- **Keychain prompt not live-checked.** The real app will read the existing "nebula-desktop Safe Storage" item from a differently signed binary; macOS may ask once (Always Allow). Not tested because it would touch the real keychain.
- **Icon.** `desktop/scripts/make-icon.sh` uses only `sips` (which rasterizes SVG) and `iconutil`. It widens the favicon's viewBox so the mark sits in the macOS 824-of-1024 icon body instead of full bleed. Output is byte-identical across runs; `build/icon.icns` and `build/icon.png` are committed. `npm run start` sets the Dock icon from `build/icon.png`.
- **Clean quit.** There was no orphan protection: stdin closes right after the person token, so a crashed/killed Electron left uvicorn running forever. Added a dedicated lifeline: the sidecar gets a 4th stdio pipe as fd 3 (`NEBULA_PARENT_WATCH_FD=3`) that Electron never writes; `backend/services/parent_watch.py` (started from a FastAPI startup hook) reads it on a daemon thread and on EOF sends itself SIGTERM (uvicorn's graceful path), with a 5 s `os._exit` fallback. Chose a separate fd over reusing stdin so the person-token protocol stays untouched, and over ppid polling because EOF is immediate and kernel-guaranteed. Python's `subprocess` closes fd 3 in grandchildren by default.
- **Quit path fixes in main.mjs.** `before-quit` used to let a second Cmd-Q through while the sidecar was still stopping (cleanupSidecar clears the handle before awaiting), so Electron could exit mid-stop. Now a `stopInFlight` flag holds every quit until the stop finishes. Added SIGTERM/SIGINT/SIGHUP handlers that call `app.quit()`.
- **Smoke now checks a real Settings save** in isolated profiles only: person token via preload IPC, `PUT /api/settings {zoomTelemetryEnabled}` with `X-Nebula-Person` → 200 and persisted, same PUT without the token → 403. Skipped (not failed) with a debug port open or in a real profile. This is how the packaged app's Settings save was verified, since there's no Accessibility/CDP route to click the panel with a person token (a debug port removes the token by design).
- **Live results (validation bundle, isolated profiles under scratchpad/desktop-pkg-*):** smoke passed through the bundle binary (title, root mounted, dynamic port, ws, settings save 200/403); `open -n --env …` launch rendered the projects home (window screenshot); a CDP run opened a new project and `.react-flow` canvas rendered; SIGTERM to Electron → "Sidecar stopped", port closed in ~1 s; `kill -9` of Electron → sidecar gone 0.22 s later, port closed; missing-repo bundle → error dialog with the Nebula icon, no profile data written outside the isolated dir. Not exercised live: Cmd-Q through the menu (no Accessibility access here; it calls the same `app.quit()` as the SIGTERM path).
- **Migration on this Mac:** App Support already has `migration-state.json` `{"status":"complete"}` from 2026-09-18 and no `credentials.json`, so the first Nebula.app launch skips migration, opens with the September data, and has no API keys until Justin adds them in Settings (or removes that one marker file to re-run the copy, which never overwrites). Documented in desktop/README.md.
- **Open:** `NEBULA_DESKTOP_PYTHON` is still honoured by packaged builds (it isn't in the dev-only list). Anyone who can set the app's environment can already run code as Justin, but it's the same class of redirect the earlier stage closed for the other vars; worth deciding.

## 2026-10-13 — Review fixes on Nebula.app (debug switches, fuses, parent-watch env)

- **Argv debug switches.** Chromium honours `--remote-debugging-port` / `--remote-debugging-pipe` from argv even in a packaged build, and main.mjs only looked at `NEBULA_DESKTOP_DEBUG_PORT`, so `open -a Nebula --args --remote-debugging-port=N` got a CDP port *and* a person token (the reviewer's probe read it). `person-token.mjs` now has `debugSwitchesInUse()` (app.commandLine.hasSwitch, argv, execArgv, NODE_OPTIONS; remote-debugging-port/pipe, inspect, inspect-brk, inspect-port, inspect-publish-uid). main.mjs computes it *before* appending its own debug switch and passes it into `decidePersonToken`, so any of them means no token. Decision: a normal Nebula.app goes further and refuses to start (removes the switches, shows a dialog, `app.exit(1)`, never takes the lock or starts the backend); validation builds and `npm run start` carry on without a token, since validators and dev need CDP.
- **Refusal was live-checked through a temporary local patch** (validation bundle made to take the refusal branch, then reverted; the committed code is unchanged from what the unit/wiring tests cover). The everyday build was never launched. Result: port never listened, no python child, one 410x432 alert window.
- **Fuses.** Added `@electron/fuses` 2.1.3 (Electron org, published 2026-06-29, pinned exactly, installed with `--before=2026-09-29`). `packaging/fuses.mjs` sets every fuse (`strictlyRequireAllFuses`, so a future Electron fuse fails the build until decided): RunAsNode off, NODE_OPTIONS off, --inspect args off, cookie encryption on, asar options off (the app isn't asar), WasmTrapHandlers on. package.mjs flips, reads the wire back and fails on a mismatch, then ad-hoc signs.
- **Deviation: GrantFileProtocolExtraPrivileges stays ON.** Turned off, the smoke run failed: Chromium gives the file:// page origin `null` and blocks its own module scripts and CSS ("Cross origin requests are only supported for protocol schemes..."). A custom scheme (app://) would fix that but changes the renderer origin, which drops its localStorage and touches the backend desktop CORS allowlist and every IPC sender validator. Instead the actual risk (renderer reading other local files) is closed with `renderer-files.mjs`: main intercepts the `file:` scheme and serves only real paths inside frontend/dist-desktop (symlinks resolved), 404 for everything else. Live: with the handler, a canary file and the repo-root settings.json both 404 from the renderer; with it disabled, both returned 200 (settings.json body never read or printed). Moving to a custom scheme and then turning the fuse off is still possible later if it's worth the storage migration.
- **Cookie encryption** is safe to turn on: nothing in the frontend, backend or desktop sets cookies. If that changes, note that `npm run start` (stock Electron, unfused) shares the profile and would not read encrypted cookies.
- **NEBULA_DESKTOP_PYTHON is dev/test-only now.** It's in DEV_ONLY_ENV_VARS; launch-overrides returns it as `overrides.python`, and main deletes the inherited value from the sidecar env and sets it only from the override.
- **Parent-watch env leak.** `start_from_env()` now pops `NEBULA_PARENT_WATCH_FD` from os.environ when it reads the real environment, and marks the watched fd non-inheritable; `child_env.scrubbed_env` strips it as a new `PROCESS_LOCAL_ENV_KEYS` entry (kept separate from SECRET_ENV_KEYS, which krea_agent_mcp reuses as its secret list). The end-to-end regression test boots the FastAPI app in a grandchild with an EOF-reading file at the inherited fd number; on the old code it was SIGTERM'd (rc -15), now it survives.
- **Process note.** While checking the refusal dialog I ran an `osascript` against System Events, which put an "Orca wants access to control System Events" permission prompt on screen. I didn't answer it; the window check used CoreGraphics' window list instead. Justin can click Don't Allow.
- Not hardened: no hardened runtime (`codesign --options runtime`), since Electron needs entitlements for it and the app is ad-hoc signed anyway; no CSP on the renderer.

## 2026-10-13 — Desktop pass: the checks PR #39 deferred, run in the packaged app

All live runs used the validation Nebula.app (`desktop/out/validation/…`, which runs this checkout's `desktop/main.mjs`), each with its own `NEBULA_DESKTOP_USER_DATA_DIR` and `NEBULA_DESKTOP_APP_ID` under the session scratchpad and `NEBULA_DESKTOP_TEST=1` (mock keychain). To see the Origin on the token-on path without a debug port (which removes the token by design), `NEBULA_DESKTOP_PYTHON` pointed at a scratchpad wrapper that runs the real venv python but serves `origin_probe:app`: an ASGI wrapper around `main.app` that logs method, path, Origin, ACAO, status, and only booleans for the person header and hello token (present / valid). For check 2 it also wrote the SHA-256 of the token, so every process's `ps -E` output could be scanned for the token without ever printing it. A canary fake key (`FAL_KEY`) was planted in the isolated profile's `legacy/settings.json`, so migration put it in the mock-keychain `credentials.json` and I could see where provider keys travel. None of this is committed.

1. **Origin and CORS.** The page's `location.origin` is `file://`. Its HTTP requests (GET, PUT, POST, DELETE) arrive with **no Origin header at all**, no OPTIONS preflight is ever sent (not even for `X-Nebula-Person` + JSON PUTs), and the page reads every response although none carries `Access-Control-Allow-Origin`. `/ws` arrives with `Origin: file://`, which `local_guard` allows. So in today's packaged app CORS plays no part, the opaque-origin branch of `desktop_renderer_cors` is never reached, and the person token is the only gate, which works: `PUT /api/settings` 200 with the token, 403 without; `GET /api/agent/spend` `limited: false` with it, `limited: true` without; the `/ws` hello gets `proposalSync`, a wrong token gets `personRequired`. Electron's fuse docs (electronjs.org/docs/latest/tutorial/fuses) list `grantFileProtocolExtraPrivileges` privileges as "incompletely documented" and don't mention CORS, so I'm reporting the observed behavior rather than claiming it's caused by that fuse. Corrected the comments in `backend/main.py` and `frontend/src/lib/backend.ts` that assumed an opaque origin held to CORS. Kept the middleware: it's still correct if the fuse is turned off or the renderer moves to a custom scheme.
2. **argv/env.** `ps -ax -o args | grep nebula-connector-session`, excluding the grep itself, is 0 while the app runs. The person token was in no process's argv or env. **But the sidecar's environment held `NEBULA_INJECTED_KEYS` (the canary key in plaintext) and `NEBULA_CONNECTOR_ENCRYPTION_KEY`.** Any same-user program can read that with `ps -E`, and popping the vars from `os.environ` later wouldn't help, because `ps -E` reads the env block the process got at exec. **Fixed at the root (7a77319a):** Electron writes them as one JSON line on stdin right after the person-token line (`launchSecretsLine`, `NEBULA_LAUNCH_SECRETS_STDIN=1`) and strips the old names from the child env. The backend reads the line in the startup hook right after the person token (`services/launch_secrets.py`), one byte at a time so nothing past the newline is consumed, capped at 1 MiB, and fails closed (no keys, no Krea vault in desktop mode) on a missing, late or malformed line, never logging it. Re-run: canary absent from every process, the key still arrives (`/api/settings` shows `***cdef`), the Krea vault opens (`disconnected`, not `error`). The real-backend sidecar test now checks the same through `ps -E`.
   - Decision: kept the env-var paths in `settings.py` and `krea_connector.py` for tests and hand-started backends, rather than removing them. Electron never sets them now and `child_env` still scrubs them from children.
   - Decision: the secrets line is always written (`{}` when empty) whenever the token line is, so the framing is the same on every launch.
   - Observed, not changed: the sidecar inherits the launching process's whole environment (`{...process.env}`). Launched from my shell it carried that shell's `FAL_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN` etc.; a Finder/Dock launch gets launchd's much smaller environment. That isn't a Nebula secret, but the backend may read provider keys from its env as a fallback, so a shell-launched app can use keys it didn't get from the Keychain. Worth a decision (strip `*_API_KEY`-style vars from the sidecar env?).
3. **Planted skill with an MCP dependency (codex-cli 0.160.0, no model turn).** Isolated copies only: the repo's `.agents/skills` copied to the scratchpad plus `planted-mcp-dep/` (`SKILL.md` + `agents/openai.yaml` with `dependencies.tools: [{type: mcp, value: planted-server, transport: streamable_http, url: http://127.0.0.1:9/mcp}]`, the format Codex's own tests use), the same skill in a scratch agent workspace, and a hostile workspace `.codex/config.toml` turning `skill_mcp_dependency_install` and `hooks` on and adding a marker-writing MCP server. Arguments came from the real `_codex_base_args`, run with isolated `NEBULA_*` paths; every Codex call used a throwaway empty `CODEX_HOME`/`HOME`.
   - Nebula's preflight (`codex_feature_preflight`) passes, and Codex's own `features list` with the generated flags shows `skill_mcp_dependency_install`, `hooks`, `plugins`, `apps` all **false**. Without the flags they're all true: the Codex default for `skill_mcp_dependency_install` is enabled (`features/src/lib.rs`), so the explicit `--disable` matters. That held even with the workspace marked trusted in the throwaway user config, because `--disable` (a `-c` override) beats project layers.
   - `codex exec` with Nebula's exact args, mentioning `$planted-mcp-dep`: the trusted project's MCP server never started (no marker) and the throwaway global `config.toml` was unchanged. Control: the same args without `--ignore-user-config` **did** start it (marker written), so the method detects a start. No credentials existed, so every model request got 401 and nothing was billed.
   - Codex does load workspace `.agents/skills` skills: `codex debug prompt-input` lists `planted-mcp-dep` in the model-visible skill list. That's why the workspace `.agents`/`.codex` dirs are write-denied to the agent. Nebula's own bootstrap prompt lists only **git-tracked** skills in the checkout, so an untracked planted skill there is never named.
   - Source (openai/codex `main` via opensrc, not the 0.160.0 tag): `maybe_prompt_and_install_mcp_dependencies` returns early unless the feature is on, and also unless the originator is first-party, which `codex_exec` isn't (`login/src/auth/default_client.rs`). So exec has three independent barriers: originator, Nebula's `--disable`, and `approval_policy="never"` with a sandbox that isn't full-disk-write (not auto-approved, so no install). It also means the feature-on control couldn't show an install, so the flag is defense in depth today. The install path writes to the **global** Codex config, which is why it's worth keeping off.
   - `codex mcp list` and `features list` can't take `--ignore-user-config`. With a *trusted* project they show the project's MCP server even with Nebula's flags. The preflight avoids this by running with an empty `CODEX_HOME` (no trust entries). The real turn avoids it with `--ignore-user-config`, as the exec test showed.
4. **Krea vault in desktop mode.** The vault key comes from `connector-vault-key.enc` (mock keychain in these runs; the real-keychain path wasn't exercised, to stay off the login keychain) and now arrives over stdin. Status renders: `GET /api/krea/connection` → `disconnected`, and Settings > Providers shows "Krea · sign-in" with **Sign in** (CDP screenshot, isolated debug-port run). Person-only routes from the packaged page: check → 200 (`needs_auth`, stops before any Krea request with no saved connection), disconnect → 200 `disconnected`; both 403 `person_required` without the token. No Krea login or network call.
   - Seen in that screenshot, not investigated: a translucent "+ New project" pill from the projects home draws over the Settings panel's search field.

- **Smoke run extended** (886cc02c) with checks 1 and 4's person paths, so `npm run test:smoke` repeats them in any isolated profile.
- **Side effect:** Justin's `--reload` dev backend on :8000 reloaded when I edited backend files in this checkout (new worker PID). Nothing of his was stopped.
- **Not changed (pre-existing):** `is_injected_mode()` is `bool(_INJECTED_KEYS)`, so a desktop app with zero keys in the Keychain accepts `apiKeys` in `PUT /api/settings` and would write them in plaintext to App Support `settings.json` (person-only, and the desktop UI uses the credential bridge instead). Keying it on `NEBULA_DESKTOP_MODE` would close that; left for a decision because the browser-mode endpoints share the check.
- Safety: App Support hash and repo-root `settings.json` hash unchanged before/after (see the stage report).

## 2026-10-13 — Final verification of the desktop-app branch (no code changes)

- **Suites:** desktop 336/336 (each file on its own), backend `run_files.py` "done 201" with no failures, vitest 201 files / 2165 tests, `tsc -p tsconfig.app.json` clean, eslint clean on the branch's changed frontend files, `check-node-contracts.mjs` passed for 302 definitions.
- **Clean build:** deleted `desktop/out/` and `frontend/dist-desktop/`, then `npm run package` rebuilt the renderer and the everyday bundle. Fuses read back as intended and `codesign --verify --deep --strict` passes. The validation bundle (`-- --validation`) was built as well, because only that one honours the isolation overrides. The everyday bundle was not launched, since it would open Justin's real profile.
- **Packaged app, isolated:** the smoke run through the validation binary passed (settings save 200 with the token, 403 without; person paths ok). Launched with `open -n`: the Nebula icon was in the Dock and New project mounted the canvas. On SIGTERM the sidecar and its port were gone within 4 s.
- **Browser dev mode:** `devserver.py --port 8136 --ui http://localhost:5256` plus Vite on 5256, both with scratchpad `NEBULA_*` paths. The printed link opened in an isolated headless Chromium, and a Preferences change autosaved (PUT 200, value written to the file). A PUT without the token returned 403. `devserver.py` prints the link only when stdout is a TTY, so the scripted run used `script -q -F`.
- **Found, not changed (pre-existing):** `load_settings()` uses `DEFAULT_SETTINGS` only when `settings.json` is missing and does not merge defaults into a partial file. A `settings.json` holding `{}` gives a `GET /api/settings` with no `apiKeys`, and the Settings panel shows "Settings couldn't load". A missing file and a full file both work. A defaults merge would fix it, but this stage was verification-only, so it is left for a decision.

## 2026-10-13 — Removing Daedalus

Justin decided to remove Daedalus (the Hermes-driven in-app chat agent) completely. Claude and Codex chats stay as they were; the Nous Portal node stays and reads the person's normal Hermes login.

- **Saved state: ignore, don't migrate.** Chat sessions live in memory (`WorkspaceSessions`, agent tokens), so nothing on disk names a runner. A send that still says `agent: "daedalus"` (an old tab, a script) gets the existing "Unknown agent ... Valid: ['claude', 'codex']" error and a done, and the socket stays usable (`test_an_old_daedalus_chat_is_refused_cleanly`, plus checked live). The frontend's saved `nebula:chat-selection` already turned any agent but `codex` into `claude`; new test `opens a chat saved with the removed daedalus agent as Claude`. Spend ledger entries labelled "Daedalus" and old `agent-workspaces/<uuid>` dirs are history and load unchanged (checked live with a seeded ledger and workspace). Commons actor ids `agent:daedalus/...` on old entries stay as history. Agent-log events whose source is `daedalus` or `hermes` now render as `system`.
- **`X-Daedalus-Caller` is dropped everywhere**, including from `person_gate.AGENT_MARKER_HEADERS`. Dropping it is not an escalation: a request still needs this launch's person token to count as the person, and nothing sets the header any more. The section 1.5 guards in `update_graph_node` and `run_graph` went with it; `TestRemovedDaedalusGuard` pins that the header no longer blocks anything.
- **`provider` on `/ws/chat` is refused for every agent.** It was only meaningful for Daedalus. The runner signature (`autonomy`, `provider`) is unchanged so Claude/Codex runners and their tests don't move; the frontend stopped sending `autonomy`.
- **Nous lookup order is now active profile, then `~/.hermes/auth.json`.** The `daedalus` profile is read only when it *is* the active profile. Behaviour change: someone whose only Nous login sits in `~/.hermes/profiles/daedalus/auth.json` must run `hermes model` (pick Nous Portal) in their normal profile. Every user-facing string now says `hermes model` (checked against the installed CLI's `--help`: "Select default model and provider"); backend errors, NousRow, both nous SKILL.md copies, `docs/api-guides/nous.md`, `universal.md`. `.agents|.claude/skills/nous/HERMES-SETUP.md` were deleted and their login steps folded into SKILL.md rule 1.
- **Removed as Daedalus-only:** `chat_actions` heartbeat and narrator buffer (the buffer also grew without bound during Claude/Codex turns, since only the Hermes runner reset it), the Hermes MCP overlay, the approval/saved-learning chat events and their Approve/Reject bubble, the autonomy/approval/Daedalus-accent CSS, the Daedalus portrait (`frontend/public/hermes/`), `themes/daedalus`, `.hermes/`, `docs/HERMES-SETUP.md`, and the hackathon recording chain (`puppeteer-driver` drive/scripted-build/sections/pre-generate-assets/smoke-test/derive-zoom/apply-zoom, `scripts/voiceover/`).
- **Kept on purpose:** the in-app "Demo zoom telemetry" setting, `useZoomManifest`, `/api/zoom-manifest/*`, `scripts/zoom_from_manifest.py` and `scripts/manifest_to_openscreen.py`. They record any agent's canvas actions and are a Settings toggle, so they're shared capture work, not Daedalus; only their Daedalus wording changed. Delete them in a follow-up if they're no longer used. `scripts/puppeteer-driver/package.json` stays as the shared Puppeteer install for the nebula-nodes-visuals capture template; its `drive` script pointed at a deleted file and now runs the Remotion smoke test. The `__nebulaChat`/`__nebulaCanvas`/`__nebulaGraphStore` DEV bridges stay for that capture template; their comments now say so. The retired Hermes *skin* migration (`skins.ts`) stays.
- **Slava screenshot check** (`scripts/slava-screenshot-check.mjs`): Daedalus steps now use Codex and the fixture image is `/og-card.svg`. It was already stale before this branch: it looks for `.chat-panel__agent-selector`, which the model picker replaced with `.chat-model-picker__providers`. Not fixed here; it isn't part of vitest/lint.
- **Provider knowledge manifest** regenerated: drops the deleted nous HERMES-SETUP.md and also picks up two tracked Krea docs (`krea-full-coverage.md`, `krea-workspace.md`) the manifest was missing on the base branch.
- **History left alone:** dated docs, docs/research-*, evidence, hackathon-submission, past implementation-notes entries. `docs/ipad-conversion/NEBULA-IPAD-SPEC.md` (a draft plan citing `.hermes/` as a port source) got a one-line note that those files now live in git history (last at 84b6d899). The "Hermes narrator: open, Justin's call" item in the section above is moot: the narrator is deleted.
- **Left in `.gitignore`:** the `scripts/voiceover/*-cache/` and `scripts/puppeteer-driver/_assets/` ignores. Harmless, and `.gitignore` is being edited on desktop-app, so touching it here would only make a merge conflict.

- Review follow-up (2026-10-13): README's person-link paragraph still named Daedalus as an in-app agent; it now ends at Claude and Codex. A wider scan found no other current-doc mentions. What remains is deliberate: regression tests that check old Daedalus state is refused, test comments about past incidents, dated history docs, and the iPad draft plan (NEBULA-IPAD-SPEC.md has a dated note; its companion component-registry.yaml still cites `.hermes/skills/daedalus-core` and was left as part of that draft).
- Final verification (2026-10-13): all suites pass on 0c2e193a (backend done 196, vitest 201 files/2166 tests, tsc, lint, 302 contracts, model reference). Live on 8137/5257 with isolated paths and a fake HOME: canvas opened from the person link, the chat picker lists only Claude Code and Codex, Settings > Providers lists Nous Portal with the `hermes model` hint, and a free text-input x2 -> combine-text graph ran to "hello world" with no page errors. Seeding the isolated settings as `{}` reproduced the known "Settings couldn't load" case from the section above (not Daedalus-related); with no file, defaults load fine. Remaining `daedalus`/`hermes` hits are all deliberate: regression tests for old state, test comments about past incidents, the Nous Portal node's Hermes login (code, skills, docs, NousRow), the retired Hermes skin migration and Slava docs/CSS comments that mention it, the Hermes PYTHONPATH note in env_check/main, `hermes-parser` in frontend/package-lock.json (an eslint dependency, unrelated), the iPad draft plan, and dated history docs.

## 2026-10-13 — Desktop follow-ups (critic + open items from the desktop pass)

All live checks used a scratchpad copy of the validation bundle (`npm run package -- --validation`) whose `nebula-app.json` points at a shim checkout. The shim's `desktop/packaged-launch.mjs` re-exports the real one, and its `main.mjs` exits unless `packagedLaunch().validation`, `NEBULA_DESKTOP_TEST=1` and a `NEBULA_DESKTOP_USER_DATA_DIR`/`APP_ID` under the scratchpad are all set. It then installs a probe and imports the real `desktop/main.mjs`. The copy was re-signed ad hoc. Screenshots came only from `webContents.capturePage`. No osascript and no screen capture. App Support hash `f715929a…` and repo `settings.json` `e64fe4ca…` were unchanged before and after. Nothing is committed from the harness.

- **Keychain vs checkout code (critic, major): documented, design unchanged.** `desktop/README.md` has a new "What the keychain prompt does and doesn't protect" section. The keychain item is trusted, but every launch imports main-process JS from a writable checkout, so repo write access means key access. That's no worse than browser dev's plaintext `settings.json`, and better against read-only snoopers, but the prompt isn't protection against local code. The README no longer just says "choose Always Allow". It explains Always Allow, Allow Once and Deny, using Apple's Keychain Access guide for what each one means. The Deny behaviour wasn't tried live (it would touch the real keychain), and the README says so. The hardening paragraph now says the fuses harden the binary, not the code it loads. Future options are named but not chosen: bundle main/preload into the app with the asar integrity fuses on, or check a hash of `desktop/*.mjs` at launch. Either one makes every main-process change a rebuild. *(Corrected in review round 2 below: neither covers the backend and venv, which also receive the keys.)*
- **Second instance with no windows (74d18467).** `second-instance` and `activate` now share `showAppWindow`, which asks `window-recovery.mjs` (pure, unit tested) to focus, recreate the main window, recreate the disconnected page, or do nothing (quitting, still starting, another window open). Decision: a created window gets `focus()` except in smoke runs, because `focus()` also shows a hidden window. Live: closed every window, launched a second copy of the bundle with the same profile and app id. It exited 0, the first instance logged `Window request (second launch): create-main`, and the window reopened on the projects home (capture).
- **Dev-only list (b7217e38).** Added `NEBULA_DESKTOP_SMOKE` and `NEBULA_DESKTOP_HEALTH_TIMEOUT_MS`. The second is read by `sidecar.mjs` from the env main passes it, so main now deletes the inherited value and sets it only from the override, the same as `NEBULA_DESKTOP_PYTHON`. A new test scans every desktop module (`*.mjs`, `*.cjs`, `packaging/`) for `NEBULA_DESKTOP_*` names and fails on any that's neither dev-only nor on an explicit honoured list (only `NEBULA_DESKTOP_MODE`, which main sets itself). That closes the earlier "Open: `NEBULA_DESKTOP_PYTHON`" item and the launch-test stage's health-timeout note.
- **Quit during an agent turn (bd3811fc).** Fake `claude` on the sidecar's PATH: it emits a session and a text event, starts a `sleep` child with `start_new_session=True`, writes both pids and idles. Backend alone: SIGTERM mid-turn cleaned up both (uvicorn closes `/ws/chat`, the turn is cancelled, `terminate_agent_process_tree` runs). **SIGKILL left both running.** That's the path Electron takes after its 5 s grace, and also parent_watch's `os._exit` and a crash. Root fix: `services/agent_guardian.py`. On the first agent spawn the backend starts `python -I agent_guardian.py <backend pid>` in its own session, with stdout/stderr to /dev/null so a dead Electron pipe can't SIGPIPE it, and a stdin pipe only the backend writes. `spawn_agent_process` (new, in `agent_process.py`) registers `+pid` and sends `-pid` when the process exits. At EOF the guardian runs the existing `_freeze_and_kill_posix_tree` plus `killpg` on everything still registered. It only accepts a group leader whose parent is the backend, or launchd once the backend is gone (covers a kill racing the registration), and re-checks the group before killing. Every agent spawn site moved to the helper: Claude turn, Codex turn, Codex preflight, `codex login status`, chat-model discovery, and the Commons reader, which also ran `claude` and wasn't in its own group before (now it is). A source test keeps new call sites from bypassing it.
  - Tradeoff: one extra Python process per backend, started lazily, so no agent means no guardian. pid reuse between an agent exiting and its `-pid` arriving, by an unrelated group leader, is accepted as negligible.
  - Tests: `test_agent_guardian.py` SIGKILLs a stand-in backend mid-"turn" (agent + its new-session child + the guardian are all gone), covers the registration race, and checks that a pid the backend didn't start survives. 3 of the 4 fail with `track` stubbed out.
  - Live through the validation app (person token from the preload, `/ws/chat` send from the packaged page, fake agent running): SIGTERM to the app (the Cmd-Q path), SIGTERM to the sidecar, SIGKILL to the sidecar (the guardian path) and `kill -9` of the app (the parent-watch path). Every time, agent and child were gone in 0.4–0.7 s, no guardian remained, and no process referencing the profile was left.
- **Packaged-app folder picker and Settings save (repeated, now with renderer-files and stdin secrets).** Only `dialog.showOpenDialog` was stubbed. Storage > "Choose generated files folder" called it with the main window and `openDirectory`+`createDirectory`, then two `PUT /api/settings` returned 200. The picked path was in the profile's `settings.json` as `outputPath`, and the same PUT without the token from the page returned 403. Chat person gate from the packaged page: a `/ws/chat` send without a token got `error:person_required` then `done`, and the fake agent never ran (pid file empty). Not added to the smoke run. The probe covers it, and the smoke's existing person-path checks already prove token-on/token-off for `/ws`.
- **Root README migration sentence** now says the copy only runs when App Support has no `migration-state.json`. When one exists, the app opens with that older data and asks for keys again. To start fresh, move the folder aside, never delete it. `desktop/README.md` "Your data" now offers both: move the folder aside (fresh), or move only `migration-state.json` out (top-up). The earlier wording said "remove".
- **`load_settings()` defaults merge (4e7b2376).** Starts from `copy.deepcopy(DEFAULT_SETTINGS)` and lays the file's object over it. File values win and loading never writes. The deep copy also fixes a latent aliasing bug: the old missing-file path returned `dict(DEFAULT_SETTINGS)`, which shared the nested `apiKeys`/`routing` dicts with the module constant. A non-object JSON file is returned as before. Tests in `test_settings_defaults.py` cover `{}`, saved values winning, no write (bytes and mtime), a missing file not being created, the defaults staying untouched, and `GET /api/settings` on `{}`.
- **"+ New project" pill (b146dfa8).** Reproduced in the packaged window. On the projects home the Settings drawer (`--sr-glass`, 66% alpha) hangs over the solid ink pill, which showed through the provider search field (pill at y 174–218, search at y 199). On home the drawer's background is now `linear-gradient(var(--sr-glass), var(--sr-glass)), var(--sr-canvas)`: the same tint over the canvas colour, so it's opaque. Re-captured: the pill no longer shows, and the drawer otherwise looks the same. No CSS unit test (no precedent in the frontend); the capture is the check.
- **@electron/packager 20.3.0 age check.** Walked the dependency closure from `desktop/package-lock.json` (node resolution from `node_modules/@electron/packager`, optional deps included): 48 packages including packager. Checked each pinned version's publish time on registry.npmjs.org on 2026-10-13. None is under 14 days. The newest are `@electron/osx-sign` 2.7.1 (2026-09-28), `@electron/asar` 4.3.1 (2026-09-26) and `lru-cache` 11.5.3 (2026-09-18). The critic counted 53, probably with a different closure; nothing in either count is too new.
- **Corrected history:** line 146's "this machine's environment" now has a pointer to the real causes (shared `frontend/dist`, non-isolated launches, the harness counting the :8000 uvicorn). FORjustin.md's matching line was corrected the same way, and it has a new "Nebula.app" section.
- **Suites:** desktop 348/348 (each file alone, TMPDIR in scratchpad; integration 4/4 and resilience 3/3 included), backend `run_files.py` done 200 with no failures and no guardian left afterwards, vitest 201 files / 2166 tests, `tsc -p tsconfig.app.json`, `npm run lint` (eslint + CSS guards) clean.
- **Still open (unchanged, Justin's call):** the inherited shell `*_API_KEY` environment in the sidecar, `is_injected_mode()` keyed on `_INJECTED_KEYS`, the old `nebula-iso-*`/`nebula-ut-e1` keychain leftovers, the first real-keychain launch and `npm run install-app`, the everyday bundle never launched here (by design), hardened runtime/CSP, and the stale "desktop pass deferred" entry in Claude Code's auto-memory.

## 2026-10-13 — Desktop follow-ups, review round 2

Four minor findings from the reviewers on the follow-up commits. All four were right; all four are fixed.

- **README overstated the future remedy.** It said bundling `main.mjs`/`preload.cjs` into an asar (or hashing `desktop/*.mjs`) would make a code change need a rebuild before it runs with the keys. Wrong: main sends every decrypted key and the connector key over stdin to the checkout's backend (`backend/.venv/bin/python`), and the backend code and venv stay writable. The README now says so and lists options that cover all three (main-process code, backend code, interpreter + site-packages), or stop handing keys to the checkout's Python. It says an Electron-only lock isn't a partial fix. Same correction in the `fuses.mjs` asar comment, FORjustin.md, and this file's earlier "Future options" bullet (superseded by this one). Design unchanged.
- **Guardian forgot a pid on a cancelled wait.** `_forget_when_done` deregistered in a `finally`, so the shutdown cancel (asyncio.run cancelling every task, including a turn still killing the tree) sent `-pid` with the agent alive, and a hard exit right after left it running. Now it deregisters only when `proc.returncode is not None`; a cancelled wait re-raises and leaves the pid registered. That's safe because the guardian re-checks group leadership and parent before killing, and a reaped pid fails that check. New test `test_a_cancelled_wait_keeps_the_agent_registered` (fails on the old code).
- **Commons reader killed only the leader.** Since the reader goes through `spawn_agent_process`, claude is in its own session, so `proc.kill()` on timeout/cancel orphaned any child where no group kill reaches. `_kill` is now async and awaits `terminate_agent_process_tree` under `asyncio.shield` (the cancel branch re-raises right after, and the tree kill must finish), with `proc.kill()` as a fallback if the tree kill raises. New test `test_read_image_timeout_kills_the_whole_claude_tree` uses a real fake leader with a child in its group (fails on the old code).
- **Failed startup + closed error window = no window ever.** `decideWindowAction` couldn't tell "starting" from "failed". main.mjs now keeps `startupError` (set in the startup catch, cleared on success) and passes `startupFailed: Boolean(startupError) && !sidecarStarting`. The new action `create-failure` calls `showFailure(startupError)`, which reuses or recreates the error window. Live window state still wins (an open error window is focused), and quitting still opens nothing. 4 new window-recovery tests (2 fail on the old code). Tradeoff: no retry of startup from the Dock; re-showing the error is consistent with the rest of the app's no-auto-restart rule, and quitting plus relaunching is the retry.


## 2026-10-13 — Sidecar and devserver drop inherited provider keys

Closes the "inherited shell `*_API_KEY` environment in the sidecar" item from the follow-ups list above.

- **One catalog, owned by Python.** The 18 provider key names lived as a literal in `backend/main.py` (`_CREDENTIAL_PROVIDER_ALLOWLIST`), mirrored in `desktop/credentials.mjs` `ALLOWED_PROVIDERS`, with no check between the two (the desktop test hardcoded its own copy). Moved the literal to a new stdlib-only `backend/services/credential_catalog.py` (`CREDENTIAL_PROVIDERS`) so `devserver.py` can read it without importing the app; `main._CREDENTIAL_PROVIDER_ALLOWLIST` is now an alias, so `test_settings_api.py` (catalog == UI == settings.example) still guards it. Electron can't import Python, so the desktop keeps `ALLOWED_PROVIDERS` and `sidecar.test.mjs` parses the Python literal and asserts equality. Considered a shared JSON file read by both: more moving parts (main.py, packaging) for the same guarantee.
- **Sidecar.** `sidecar.mjs` exports `INHERITED_CREDENTIAL_ENV_KEYS` (`ALLOWED_PROVIDERS` + `NEBULA_APP_TOKEN` + `NEBULA_AGENT_TOKEN`) and `SIDECAR_STRIPPED_ENV_KEYS` (that plus the existing `LAUNCH_SECRET_ENV_KEYS`); `startSidecar` deletes all of them from the child env, and `main.mjs` deletes the same list before calling it. `LAUNCH_SECRET_ENV_KEYS` is kept as-is.
- **Devserver: scrub too (decision).** Settings are the only key source in Nebula's own code (`test_provider_credentials_do_not_fallback_to_process_environment`), but env keys still mattered in browser dev: (1) every agent child inherits the backend env (`child_env.scrubbed_env` strips only NEBULA_* secrets), and `claude -p` uses `ANTHROPIC_API_KEY` ahead of the subscription login, so chats could bill an API key; (2) provider SDKs (openai, fal_client, replicate) fall back to their own variable, so a key missing from Settings would work in browser dev and fail in the app. So `devserver.main()` removes the same names from `os.environ` before the reload supervisor (or the single server) starts, and prints the removed *names* (never values) so a dev knows why a shell key is ignored. `NEBULA_INJECTED_KEYS` is left alone in devserver: it is the documented input for hand-started backends.
- **Behaviour change to know about:** anyone who relied on a shell `ANTHROPIC_API_KEY` for in-app Claude chats will now use the Claude CLI's saved login instead. Codex already refused `OPENAI_API_KEY`. A backend started by plain `uvicorn main:app` (not devserver, not the app) still inherits the shell; that path is undocumented.
- **Not in the catalog, so not stripped:** `ANTHROPIC_AUTH_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLAUDE_CODE_USE_*`. They are agent/cloud auth selectors rather than Nebula provider keys; whether `child_env.scrubbed_env` should also drop catalog keys for agent children of a hand-started backend is left open.
- **Tests:** new sidecar tests (catalog parity; every catalog key + app/agent token planted in the env never reaches the spawn env, other vars kept); the real-backend stdin test now plants `OPENAI_API_KEY`/`FAL_KEY`/`NEBULA_APP_TOKEN` and checks `ps -E`. Devserver: worker env captured at supervisor construction has none of the names, output lists names only; existing devserver test now `delenv`s those names so `main()` can't strip the pytest process's real env. Desktop 354/354 (each file alone), backend `run_files.py` done 200, no failures.

## 2026-10-13 — ACP host design pass (personal agents in the chat panel)

Design only, no code yet. The full design went back to the coordinating workflow. Decisions that weren't in the brief:

- **Spec read at ACP protocol v1** (agentclientprotocol.com/protocol/v1/*, fetched 2026-10-13). Nebula sends `protocolVersion: 1` and refuses any other version the agent answers with. v2 is a draft.
- **No SDK dependency.** A JSON-RPC-over-stdio client of about 250 lines (`services/acp_client.py`) replaces `agent-client-protocol`.
- **Spend key `outside:personal:<agentId>`.** It starts with `outside:`, so `spent_outside()` and `session_budgets()` already count it in the shared 24h budget, and Settings can still show a line per agent. One constant, `agent_spend.PERSONAL_AGENT_BUDGET = "outside"`, switches it to a per-chat `chat:<id>` key. The token record gains `spend_key`, `display_name` and `color`.
- **The session token has to carry a workspace.** `mcp_server.py` fails closed unless `/api/agent/context` returns one. The ACP session therefore takes a private workspace from `workspace_sessions` and uses it as the ACP `cwd`.
- **Guardian.** `agent_guardian` exists only on the desktop-app branch, and this worktree is based on main. For now: `agent_process_group_options` + `terminate_agent_process_tree`, stdin EOF when the backend dies, and an idle reaper. Switch to `spawn_agent_process` when desktop-app merges (done in the merge with main, below).
- **npx adapter pins (14-day rule, checked on registry.npmjs.org 2026-10-13):** claude-agent-acp 0.84.0 (2026-09-28), codex-acp 2.0.0 (2026-09-28). `npm_config_before` (now minus 14 days) also holds transitive deps to the rule. Gemini uses the person's installed `gemini --acp` (flag checked in the docs at v0.61.0). Hermes is a preset with status `needs_setup` and can't be started.
- **Deny with no reject option.** If the agent offers no `reject_once`, a timeout or deny answers `cancelled` and sends `session/cancel`. Nebula never picks `reject_always`, because that would write a rule into the agent's own config.

## 2026-10-13 — ACP host build (personal agents in the chat panel)

Built from the design above. Where it differs, or decides something the design left open:

- **Presets start switched off.** The person turns each on in Settings > Preferences > Personal agents. Without this, Justin's installed `npx` would put "Claude (your setup)" in the picker the moment this merges.
- **`initialize` and `session/new` wait for the launch spec's startup timeout (180 s for npx), not 30 s.** The first npx run downloads the adapter before it can answer `initialize`, so 30 s would fail it on a cold cache.
- **Cleanup also calls `killpg` after `terminate_agent_process_tree`.** That helper returns at once if the root has already exited (a crash, or a clean exit on stdin EOF), and grandchildren in the agent's own process group would survive. The group kill covers that case. `test_close_kills_the_whole_tree` checks it.
- **"Allow" when the agent offered no `allow_once` counts as deny.** The card hides the button in that case anyway. If there's also no `reject_once`, it answers `cancelled` and sends `session/cancel`, as designed.
- **`close_session` during a running personal turn cancels the turn first,** then closes. The UI never sends it while busy, but the backend shouldn't depend on that.
- **Two small new chat events:** `system` (a stop reason like `refusal` or `max_tokens` becomes a plain line) and `session_closed` (the reply to `close_session`).
- **The primer** is `chat_session.NEBULA_MCP_PRIMER` plus a short "your setup" paragraph. It goes as the first text block of the first turn only.
- **`/api/personal-agents` joined `PERSON_READ_PREFIXES`** in `frontend/src/lib/backend.ts`. Without it the GET goes out without the person header and gets 403.
- **Route tests accept 401 or 403** for a forged `Authorization: Agent` header: an unknown agent token is refused by the actor resolver before the person gate runs. A *valid* minted token gets 403 (`test_a_minted_agent_token_cannot_reach_the_registry`).
- **Custom-agent args are capped at 512 characters** each, so tests and the live check pass the fake agent's script as a file path, not inline JSON.
- **Existing frontend tests:** the ChatPanel and Settings tests mock `lib/api`. They now also mock `fetchPersonalAgents`, because the panel and Settings load the registry on open.
- **Live check (ports 8142/5262, isolated `NEBULA_*` paths, temp HOME):** the fake agent was registered as a custom agent through the person-only route. Headless Playwright then captured the picker, the one-time notice, a tool call, mid-stream text, the permission card and the finished turn, with no page errors. The demo script's `edit_canvas` step is scripted narrative from the fake agent: no node was actually added. No processes were left behind afterwards.
- **Real Claude adapter turn: skipped, though the package passes the 14-day rule** (0.84.0, published 2026-09-28; latest 0.90.0 is from today). On macOS, Claude Code keeps its login in the login keychain. With a temp HOME the adapter would still go to the keychain and might pop a prompt on Justin's screen. With the real HOME it would read and write `~/.claude.json`. The run rules forbid both. Justin can run the turn himself (Settings > Personal agents > Claude on, then chat). Codex and Gemini were skipped as instructed.
- **The guardian switch waited for desktop-app,** as designed: `_spawn()` is the one place to change. Done in the merge with main, below.
- **FORjustin.md** is gitignored and lives only in the main checkout, which this workflow may not edit. Lesson for it: "ACP is just JSON-RPC over a pipe. The hard part isn't the protocol, it's every way a session can end. Route all of them through one idempotent `close()` that kills the process group and revokes the token, and test each way with a real subprocess. A mock would hide the grandchild that outlives its parent."
- **Commit trailers:** commits from the frontend commit onward use only the `Co-Authored-By` line, per a mid-run attribution update from the harness.

## 2026-10-13 — ACP host: review fixes

- **Settings now stop running agents (major).** `personal_agents.launch_key()` reads only the registry (no binary
  probes), so it is cheap to check on every send. Each session stores the key it started with.
  `AcpSessionManager.close_stale()` closes every live session whose key no longer matches (switched off, removed, or a
  custom agent's command or args changed). It runs after every PUT and DELETE on `/api/personal-agents*`, and
  `personal_turn` re-checks before reusing a host, which also catches registry edits that bypassed the routes. Renaming
  or recoloring doesn't count as a change. I compare a launch key rather than a revision counter so a rename doesn't
  kill a session.
- **Commons:** `is_enabled()` reads an env var fixed at startup, so Commons can't actually switch on while a session
  is live. The refusal path still calls `close_owned(..., "commons_enabled")` for personal agents, as a cheap backstop.
- **Why a session ended survives the prune.** The manager remembers `(owner, message)` for the last 64 ended
  sessions, so a send after a Settings switch-off says "switched off, removed or changed in Settings". Before, it
  showed the generic message. Only the owning socket gets it.
- **Provider keys (minor).** I copied `backend/services/credential_catalog.py` byte for byte from desktop-app's
  c1c652f0, and made the same `main._CREDENTIAL_PROVIDER_ALLOWLIST = CREDENTIAL_PROVIDERS` alias, so the merge
  stays clean (an identical add on both sides). `_agent_env` drops every catalog name plus NEBULA_AGENT_TOKEN and
  NEBULA_APP_TOKEN. The catalog's docstring mentions mirror tests that live on desktop-app; they arrive with that merge.
- **The frontend catalog test read main.py's literal frozenset,** which the alias removes. I pointed it at
  credential_catalog.py instead. **desktop-app has this same failure right now** (its main.py has the alias, and its
  frontend/tests/providerCatalog.test.ts still parses main.py), and it needs the same one-line fix.
- **close() can't be skipped by cancellation (minor).** The teardown runs once, in its own task. `close()` starts it
  and awaits it through `asyncio.shield`, so cancelling the caller only stops the waiting, and later close() calls
  (close_all at shutdown) wait on the same task. The token is revoked at the start of teardown, before the slow
  session/close RPC and the kill. `_close_lock` is gone.
- **A crash during cancel closes the session (minor).** `cancel_turn` treats `AcpConnectionClosed` as a crash. As a
  general backstop, `prompt()`'s finally closes the session whenever the connection is dead, instead of going back to
  "ready". When Nebula itself closed the session mid-turn, the turn ends with the reason (`ended_message`), not
  "exited (code -9)".
- **Per-agent spend lines (minor).** I went with the UI over a doc change. `PersonalAgentSpend` in
  AgentSpendSection shows one read-only row for each personal agent that spent, or used Krea plan runs, in the last 24 h.
  Agents at $0 are hidden: the backend lists every preset, even ones never switched on, and four $0.00 rows would be
  noise. I changed the docs from "a line per agent" to "a line for each agent that spent in the last 24 hours".
- Live check (ports 8142/5262, isolated paths, temp HOME, backend started with a fake ANTHROPIC_API_KEY): the agent
  saw it as unset. A PUT `enabled=false` left no agent process, and the next send gave the Settings message. The
  reviewer's crash-during-cancel repro now returns 401 for the session token right after the cancel.
- Unchanged: the model picker's status line still reads "ready" until the picker refetches the list. That's cosmetic,
  and the send path is authoritative.

## 2026-10-13: ACP host, second review fixes

- **A close during start now wins (major, findings 1 and 5).** `start()` checks `_closing` after every await
  (spawn, initialize, session/new) and gives up with `personal_session_ended` and the close reason. So a session that
  Settings, a replaced chat or shutdown closed while it was starting never turns "ready" over "closed", never holds a
  live-session slot, and never mints a token after the teardown's revoke. The check right after initialize and the
  mint have no await between them, so the mint is either before the teardown (which then revokes it) or not at all.
  The teardown also revokes a second time in its `finally`, as a belt and braces step. `closed` is now true from the
  moment `close()` begins, so `_prune` and `live()` drop a session whose teardown has started. I kept the shielded,
  run-once teardown task.
- **The spawn window.** A close during `_spawn` finds no process to kill. `start()` now kills a process that arrives
  after closing began, itself and shielded, and never stores it on the session. I pulled the kill steps into
  `_kill_tree()` so the teardown and this path share them.
- **When the kill ends the connection,** start used to say "exited while starting (code -15)". It now says why Nebula
  stopped it.
- **open() reads Settings after its last await (major, finding 2).** The launch key and spec are read after
  `close_owned()`, with nothing awaited between the read and registering the session, so `close_stale` can always see
  it. `open()` re-checks `still_allowed` after `start()` (for registry edits that skip the routes) and closes and
  refuses if it fails. `personal_turn` now checks `still_allowed` before every prompt, new chat or reused. Tradeoff:
  the owner's previous session is now closed before a bad agent id or a disabled agent is reported, where before the
  error came first. The UI only offers ready agents, and a send with no session id means a new chat anyway, so I
  judged that fine.
- **The token no longer reaches argv (major, security, finding 3).** I did not re-verify the adapter and SDK argv
  path myself (no real adapter runs allowed); I took it from the review. The fix doesn't depend on any adapter's
  behavior: `session/new` carries no token at all, only `NEBULA_AGENT_TOKEN_FILE`, a path. New module
  `services/agent_token_file.py` writes `<state>/agent-tokens/<backend pid>/<session id>.token` with O_EXCL and
  O_NOFOLLOW, mode 0600, in 0700 folders (it tightens an existing folder that is looser). The file is outside the
  agent's workspace. The teardown deletes it. A startup hook in main.py (`_personal_agents_startup`) removes leftovers.
- **Why a pid level in the path.** Two backends could share a state dir. Startup cleanup skips the folder of any other
  pid that is alive, so one backend never deletes another's live token files. Its own pid folder can only be from a
  dead process that had the same pid, so it goes. `clear_stale` must only run before sessions start, and the
  docstring says so.
- **mcp_server.py fails closed.** `load_agent_token_file()` runs before `agent_workspace_scope()`. When
  `NEBULA_AGENT_TOKEN` is unset and `NEBULA_AGENT_TOKEN_FILE` is set, it reads the file. The read requires a regular
  file (not a symlink) owned by this user, no group or other permission bits, at most 512 bytes, and one token
  matching `[A-Za-z0-9_-]{20,256}`. Anything else (including an empty variable) raises a ValueError, and the existing
  handler exits 1. An in-app chat's `NEBULA_AGENT_TOKEN` still wins, and `nebula_server_env_refs` is unchanged.
  `NEBULA_AGENT_TOKEN_FILE` was added to the variables the agent's own environment drops, so a value inherited from a
  shell can't reach it.
- **Text caps (minor, finding 4).** Message and thought chunks are redacted, then capped at 20,000 characters each,
  and a turn's text and thought together at 200,000 (`TurnTextBudget`, one per `_Turn`). The first cut in a turn adds
  one `system` line: "This reply was too long to show in full, so Nebula cut some of it." After the budget runs out,
  text chunks are dropped. Redact-then-cap is tested, because capping first could leave the start of the token
  showing. Not covered: tool results still have only their per-result cap (20,000) and no per-turn total, and a token
  split across two chunks isn't redacted. The doc says the first; the second predates this change.
- **Fake agent.** `fake_acp_agent.py` gained `initDelay` and `sessionNewDelay`, so the tests can hit the start races
  deterministically. The race tests slow the teardown's tree kill to one second (the reviewer's approach), so start
  resumes mid-teardown.
- **Mutation checks.** For each fix I reverted only that fix and ran its tests; every one failed, then passed again
  after the restore. One gotcha: a mutation that keeps the file size identical, restored within the same second,
  leaves a stale `.pyc` that Python reuses. The redact-order mutation hit this and made the full suite fail once. I
  re-ran every mutation with `PYTHONDONTWRITEBYTECODE=1` and cleared caches before the final suite run.
- **Docs.** PERSONAL-AGENTS.md: the sequence diagram, the "Where the token lives" paragraph (it was wrong; the token
  could reach argv through the adapter), the start-race guarantee, and a new "Output caps" bullet with the real
  limits. MCP-SETUP.md's personal-token paragraph now describes the file.

### Third review round (2026-10-13)

Two reviewers checked 5eba86fc. Concurrency said ship, with one older gap; the token-file reviewer found two small issues. All three are fixed, each with a test that fails when only its fix is reverted.

- **The startup sweep followed a symlinked `agent-tokens` folder.** `clear_stale` listed and deleted the entries of whatever `<state>/agent-tokens` pointed to. Any program running as the person (an agent included) could plant that symlink, and the next backend start would empty the target folder. The sweep now opens the folder with `O_DIRECTORY | O_NOFOLLOW` and works through that descriptor (`os.scandir(fd)`, `rmtree(dir_fd=)`, `unlink(dir_fd=)`). A symlink, a non-directory or another user's folder is left alone, and a swap after the check can't redirect it. A symlinked pid folder inside the real one is unlinked, not followed.
- **Shutdown could miss a teardown already under way.** A session leaves the registry the moment its close begins. So if the idle reaper or a cancelled caller started a close, and something else pruned the session, `close_all` never waited for that kill, and the loop could cancel it halfway and leave grandchildren running. The manager now keeps the unfinished teardown tasks of pruned sessions, and `close_all` waits on them (shielded, so cancelling `close_all` doesn't cancel a kill).
- **An agent could start after shutdown.** An `open()` waiting on `close_owned()` when shutdown ran went on to start a fresh agent and mint a token after `close_all` returned. The new `shutdown()` sets a flag first, and `open()` refuses (`personal_agent_shutting_down`) after `close_owned` and again after `start()`. The backend's shutdown hook calls `shutdown()`. `close_all()` keeps working for tests and reuse, since only `shutdown()` sets the flag, which never clears.
- **Doc fix.** PERSONAL-AGENTS.md said a cut drops the rest of the turn's text. Only the 200,000-character turn budget does that. A chunk over 20,000 characters is trimmed and later chunks still show.

## 2026-10-13 — ACP host: merged with main (desktop app + Connect your agent)

- **Personal agents now use the agent guardian.** `_spawn()` calls `spawn_agent_process`, so a SIGKILLed backend no longer leaves an agent's grandchildren running: the guardian kills the group, as it does for in-app chats. New test `test_the_agent_guardian_watches_every_personal_agent` (fails with the old `create_subprocess_exec` call). PERSONAL-AGENTS.md drops the "doesn't use the guardian yet" caveat.
- **Conflicts, all additive:** `OutsideSpend` keeps main's `connect` and adds `personal`. `PERSON_READ_PREFIXES` keeps main's comment and adds `/api/personal-agents`. MCP-SETUP.md puts "Personal agents' session tokens" before main's "Connect your agent". This file keeps main's entries first, then the ACP ones.

## 2026-10-13 — Desktop early-exit test: skip unbuilt, check the real fields

- **The early-exit integration test needed the same skip as the other three launch tests (628d35f8).** The app fails on a missing `frontend/dist-desktop` before it starts the sidecar (7cf754a1), so unbuilt the test can only see the renderer error. It still "passed" in the earlier scratch run because its last fallback was `message.includes('7')` and the scratch path contains one (`…-be74-…`). In the acp-host worktree, whose path has none, it failed.
- **The assertion now checks the sidecar's own error:** `type === 'early_exit'`, `exitCode === 7`, and the fixture's `DISTINCTIVE_EARLY_EXIT_MARKER` in the message. With `FIXTURE_EXIT_CODE` changed to 9 it fails. Built: integration 4/4, desktop suite 354/354. Unbuilt: the four launch tests skip. CI doesn't run the desktop suite, so nothing there changes.

## 2026-10-14 — ACP adapter pin watch

Justin asked for a check about every two weeks that finds the newest stable adapter release at least 14 days old and
hands him the bump. Session schedulers don't persist, so it lives in the repo as a GitHub Actions workflow.

- **Weekly, not every two weeks.** Cron can't say "every other Monday" cleanly, and the run is idempotent: it updates
  the one open issue rather than opening another. A weekly run also means a release that clears the hold shows up
  within a week. `17 14 * * 1` (Monday 14:17 UTC), off the top of the hour.
- **An issue, not a PR.** The bump needs one real adapter turn by hand (the tests drive a fake agent), so a bot PR
  would only look ready. The issue holds the report; Justin makes the one-line change. The workflow gets
  `contents: read` and `issues: write` only, and no step can push.
- **Python, in `backend/scripts/check_adapter_pins.py`.** It imports `PRESETS` and `PACKAGE_AGE_DAYS` from
  `services/personal_agents.py`, so the pins and the 14-day number have one home. That import chain is stdlib only,
  so the workflow installs nothing. The logic is covered by `tests/test_adapter_pins.py`, which the CI backend job
  already runs.
- **Version choice.** Strict semver parse; anything with a prerelease tag, a missing publish time, or a non-empty
  `deprecated` field is skipped. An empty `deprecated` string is what `npm deprecate pkg@x ""` leaves behind to
  un-deprecate, and npm's resolver checks truthiness, so we treat any falsy value as not deprecated. Compare is on integer tuples (0.10.0 > 0.9.0). The cutoff is `now - 14 days` to the minute,
  the same instant `npx_env()` uses for `npm_config_before`. "Next newer release" is the earliest-published stable
  release above the candidate (or the pin) that is still held, and its clear date is publish time + 14 days.
- **What counts as "action needed":** a candidate exists, or the pin is deprecated, or the pin is missing from the
  registry. A pin published inside the hold is noted in the report but doesn't open an issue on its own.
- **Untrusted registry data.** Versions only reach the report if they match the strict semver regex. Deprecation
  messages and error text are flattened to one line, backticks swapped out, angle brackets dropped, capped, and shown
  in a code span, so they can't leave it or fake the signature comment (which is also read from the end of the body). The
  report goes from file to `gh --body-file`; no `${{ }}` expression ever holds registry data, and the only output
  read by an `if:` is the script's own `true`/`false`.
- **Failures.** A fetch error is reported in the table and the job summary and fails the run (exit 1), so a broken
  check shows red in Actions. The issue step still runs if the other adapter needs action (`!cancelled()`).
- **Duplicate guard.** The issue step lists open issues (up to 500) and matches the exact title *and* the workflow's
  own author (`gh` reports it as `{"login": "app/github-actions", "is_bot": true}`, checked against a real bot issue;
  no user login can contain "/"). Title alone wasn't enough: the repo is public, so anyone could open an issue with
  that title first, the workflow would write its report into it, and the opener could then edit the versions or add
  instructions to the issue I act on. No labels, no search index lag. The report ends with an HTML comment holding a signature (package=candidate). If the signature matches
  the open issue's, the body is refreshed quietly; if it changed, the body is replaced and a comment is added so
  Justin gets a notification. `concurrency: adapter-pins` stops two runs racing to create the issue.
- **Testability.** `file_issue()` takes the gh runner as a parameter, and `--dry-run` prints the write commands
  (the `gh issue list` read still runs). `main()` takes the fetch function, so the network-failure path is tested.
- **First real run (2026-10-14):** claude-agent-acp 0.84.0 is current (0.85.0, published 2026-10-01, clears
  2026-10-15). codex-acp has 2.0.1 (published 2026-09-29) past the hold; 2.1.0 (2026-10-01) clears 2026-10-15.
  Pins not changed in this branch, as asked.

## 2026-10-14 — Connect: token files and color picker

Connected apps now get a token file instead of the token. Settings > Connect your agent writes the new app's token
to `<state>/app-tokens/<app id>.token` (folder 0700, file 0600) and every client's config names that file as
`NEBULA_APP_TOKEN_FILE`. The rows in the connected-apps list also got a color picker.

- **One strict reader, shared helpers.** `services/agent_token_file.py` now holds the generic pieces:
  `write_private` (0700 folders, O_EXCL|O_NOFOLLOW create), `unlink_private`, `sweep` (what `clear_stale` used to do
  inline) and `read`. The new `services/app_token_file.py` is a thin layer over them: `write`, `remove`,
  `clear_unknown`, and `read` is the same function. The reader's messages now say "the token file" rather than "the
  agent token file", and `mcp_server.py` puts the variable name in front (`NEBULA_APP_TOKEN_FILE: can't open the
  token file (...)`). One existing test asserted the old wording and was updated.
- **Folder descriptors, not paths, where the OS has them.** Writes, deletes and sweeps open the token folder with
  O_DIRECTORY|O_NOFOLLOW, check owner and type on the descriptor, then create, unlink or scan relative to it. This
  closes the gap between a check and the use that the old path-based `_private_dir` + `os.open(path)` had. The agent
  token writer moved onto the same code. Where `dir_fd` isn't supported (Windows), it falls back to the old
  path-based checks, and `sweep` removes nothing, as `clear_stale` did before.
- **The store owns the file lifecycle.** `AppTokens(path, token_dir=...)` writes the file inside `create()` under the
  store lock, before saving. If the file can't be written, no app is saved and the route returns 400 with the
  reason. If the save fails, the new file is removed. `revoke()` saves first and then deletes the file: the token
  is dead either way, and a missed delete is cleaned up at startup by `clear_unknown_files()`, which runs in the
  existing `_personal_agents_startup` hook next to `clear_stale`. `token_dir=None` (budget tests) writes nothing.
  The brief said "written in create_agent_app / deleted in revoke_agent_app"; those routes call the store, so this is
  the same moment with fewer ways to get out of step.
- **The raw `token` stays in the POST response.** Scripts that call the route and the backend tests use it, and
  removing it would only move the same secret one hop (the person can read the file anyway). Settings never shows
  it for a client setup. For a plain token (no client, or the packaged app) Settings shows the file path and a
  "Show the token for an app that can't read a file" button. That is the one case that may need the value: an
  outside script or app config that takes a token value and can't read a file. It is behind an explicit click.
- **Precedence in `mcp_server.py`** (documented in `load_app_token_file` and MCP-SETUP.md): `NEBULA_AGENT_TOKEN`,
  then `NEBULA_AGENT_TOKEN_FILE`, then `NEBULA_APP_TOKEN_FILE`, then `NEBULA_APP_TOKEN`. When an agent token or agent
  token file is set, the app file isn't read at all. When the app file is set it must be good. If it is bad, the
  loader also drops any `NEBULA_APP_TOKEN` beside it before raising, so nothing can fall back to an old raw token.
  `nebula_api.py` and the `nebula` CLI's own commands still read only the env tokens, as the brief asked.
- **`NEBULA_APP_TOKEN_FILE` is scrubbed from children.** Added to `services/child_env.py` `SECRET_ENV_KEYS` and
  `acp_session._AGENT_ENV_DROP`. The path isn't the token, but a child's own Nebula MCP server would read it and spend
  as that app. Not added to `devserver.INHERITED_CREDENTIAL_ENV_KEYS` or the desktop sidecar's list. Those strip the
  backend's own env, and a test pins devserver's set to the credential catalog. `child_env` already covers every
  process the backend starts.
- **OpenClaw doctor step removed for token files.** Checked OpenClaw's source (`src/cli/mcp-cli.ts`,
  `SENSITIVE_KEY_PATTERN = /(?:^|[_-])(api[_-]?key|authorization|bearer|password|secret|token)$/i`, main at
  3d9637ef, 2026-10-14). The key has to end in token, so `NEBULA_APP_TOKEN_FILE` isn't flagged. The step is kept
  for a pasted raw token.
- **CLI.** `nebula mcp connect <client> --token-file <path>` (or `$NEBULA_APP_TOKEN_FILE`) reads the file with the
  strict reader, requires the `nebula_app_` prefix, checks the token with Nebula as before, and writes configs that
  name the file. Codex no longer needs the placeholder swap in file mode: the path goes straight on `codex mcp add`'s
  argv, then `fill_codex_token(..., placeholder=None, ..., key=NEBULA_APP_TOKEN_FILE)` only adds the timeout and
  checks the parse. The old paste flow still works but isn't the default: `$NEBULA_APP_TOKEN` is still honored
  (scripts and old docs use it), and the hidden prompt now needs `--paste-token`. With no token at all, connect
  fails and points to Settings' `--token-file` command. A pasted token prints a note that the config will hold the
  token and how to move to a file. Precedence: `--token-file`, then `$NEBULA_APP_TOKEN_FILE`, then
  `$NEBULA_APP_TOKEN`, then `--paste-token`.
- **The command Settings offers.** `setup.cli` is `NEBULA_URL=<url> <venv python> <repo>/nebula mcp connect <client>
  --token-file <file>` (or `NEBULA_URL_FILE=` for the desktop app). It runs the `nebula` package directory directly,
  so it works without `nebula` on PATH and from any cwd. The address goes in as an env prefix because `--url` is a
  top-level option and would have to sit before `mcp`. It is offered only for the clients the CLI writes for (Claude
  Code, Codex, Claude Desktop, Cursor). Hermes, OpenClaw and other only print, so the line would add nothing.
- **`--print` placeholder.** `TOKEN_PLACEHOLDER` (`nebula_app_PASTE_YOUR_TOKEN`) is gone. `--print` with no token
  file renders the file form with `TOKEN_FILE_PLACEHOLDER` (`/PASTE/THE/TOKEN/FILE/PATH/FROM/SETTINGS.token`), and the
  warning then says "its token file" instead of the placeholder.
- **`render()` takes exactly one of `token_file` / `token`**, and `server_entry()`'s token argument is now
  keyword-only (`token_file=` or `token=`). The legacy `token=` path renders the old way, with the plain-text and
  shell-history warnings plus "revoke and connect again". The setup also returns `tokenFile` and `cli`.
- **Color picker (Task 2).** Each connected row's color dot is now a button ("Change the cursor color for X",
  `aria-expanded`). It opens the existing `ColorPicker` on its own line in the row. A pick goes through the row's
  existing `run()`, so it shares the pending state (every control disabled while saving) and the error line with
  limit editing. The picker closes on success and stays open on failure. `setConnectedAppColor` already existed in
  `api.ts`. CSS adds `.settings-apps__dot-button`, which keeps the 9px dot visually and has a ~17px hit area.

Tradeoffs and surprises:

- **The plaintext moved; it didn't vanish.** Before, the token sat in each app's config (and, for Claude Code,
  Codex and OpenClaw, in shell history and briefly in `ps`). Now it sits in one 0600 file in Nebula's state dir. Any
  program running as the person can still read it, as before. What improved: one place, deleted on revoke, never on
  argv or in history, not copied around in configs, backups or dotfile repos.
- **Old connections keep their raw tokens** until revoked and reconnected. Nebula stores only hashes, so it can't
  make files for them. This is documented in MCP-SETUP.md and in the CLI's note.
- **The token file path appears in configs and on argv.** It isn't a secret, but it tells a reader where the token is.
  That reader would need to run as the person to open it.
- **Mutation-checked:** reader following symlinks; reader skipping the mode check; a bad app file leaving the old
  raw token in place; the server never loading the app file; revoke keeping the file; the startup sweep following a
  symlinked folder; startup skipping the app sweep; the writer following a symlinked folder; the route putting the
  token in the setup; and a snippet carrying a raw token env beside the file. Each made its target tests fail and
  was restored. The first try at the last one targeted the wrong test (the legacy render, where the token is
  expected) and passed. It was retargeted at `test_no_setup_holds_the_token` and failed as it should.
- **Live check** (scratch backend on :8342, scratch NEBULA_* paths, person token over stdin): created a claude-code
  app as the person. The file was 0600 in a 0700 folder, owned by the user and holding the token. The setup named
  the file and didn't contain the token. `backend/mcp_server.py` over stdio with only `NEBULA_APP_TOKEN_FILE` +
  `NEBULA_URL` (plus PATH/HOME) answered `get_spend_limits` with `budget: app`. Then the CLI checks against a temp
  HOME: `nebula mcp connect claude-code --print` (placeholder), with `--token-file --print`, `cursor --token-file
  --yes` (wrote a 0600 mcp.json naming the file, no token), and the Settings line itself with `--print`. Then
  revoke: the file was gone, a fresh server exited 1 with "NEBULA_APP_TOKEN_FILE: can't open the token file", and the
  token got 401. The backend was stopped afterwards.
- **Review fixes.** Two findings from review, both fixed with tests that fail without the fix:
  - *An unreadable store emptied the folder.* `_load()` fails closed to an empty app list, and the startup sweep
    took that list as "no active apps" and deleted every token file. Nebula keeps only hashes, so those files
    couldn't be made again and every app would need reconnecting. `AppTokens` now records whether the store
    existed but couldn't be read or parsed (an OSError, bad JSON, or no `apps` list), and `clear_unknown_files()`
    then does nothing. A missing store still counts as "no apps". Test:
    `test_startup_keeps_every_file_when_the_store_cant_be_read` (mode 000, corrupt JSON, wrong shape).
    Mutation-checked by dropping the guard (all three fail) and the shape check (the wrong-shape case fails).
  - *The token folders weren't protected.* `protected_agent_dirs()` now also lists `<state>/app-tokens` and
    `<state>/agent-tokens`, so the graph/media path guard, the in-app Claude read-deny rules and the Codex
    filesystem deny list all cover them. No grant overlaps: agent workspaces live in a sibling folder, and in-app
    agents get their token through env, not a file. ACP personal agents read their file through their own MCP
    server, which isn't under these rules. Test: `test_token_file_folders_are_protected` (direct path and a
    symlink alias). Mutation-checked by removing the two entries.
  - *A new app could write over an unreadable store (fixed after review).* After a failed load, `create()` saved
    the one new app over `app-tokens.json`, dropping every other app, and the next startup then swept their token
    files. It predates this branch, but token files made it worse, so it's fixed here. `create()` now refuses
    ("won't write over it") while the load has failed. Limit, color and revoke already couldn't save: they find no
    app in the empty list. A failed load is also retried on the next call, so a store that's put right works
    without a restart. Test: `test_a_new_app_never_writes_over_a_store_that_cant_be_read` (all three damage
    kinds). Mutation-checked by removing the refusal and the retry (each fails all three).
- **The backend's own environment drops the token-file variables too.** devserver.py and the desktop sidecar
  already dropped an inherited `NEBULA_APP_TOKEN` / `NEBULA_AGENT_TOKEN` ("the backend must not run as either"),
  but not `NEBULA_APP_TOKEN_FILE` or #43's `NEBULA_AGENT_TOKEN_FILE`. Both now drop all four
  (`devserver.SPENDING_TOKEN_ENV_KEYS`, sidecar `INHERITED_CREDENTIAL_ENV_KEYS`). `child_env` keeps stripping
  `NEBULA_APP_TOKEN_FILE` from every child; it leaves `NEBULA_AGENT_TOKEN(_FILE)` alone because the in-app chats
  and ACP sessions set those for their own MCP servers on purpose. Tests: `test_person_session` (the set) and
  the sidecar test that sets all four from a shell (fails with the old list).
- **Left for later:** the `nebula` CLI's own commands still read only `NEBULA_APP_TOKEN`, not the file. Connect
  only sets up the MCP server, so nothing needs it yet.

## 2026-10-14 — Maker retirements (Veo previews, gpt-image-1, Sora 2, Meshy, Gemini TTS)

Track: keep the existing direct maker routes working past the October–November 2026 shutdowns. Vendor pages
were re-fetched on 2026-10-14 (Gemini API deprecations, Vertex Veo 3.1 model card and pricing, OpenAI
deprecations/model pages/image guide, Meshy openapi.yaml and llms.txt, Gemini speech-generation and model pages).

### Veo (veo-3, veo-3-flf)
- **The node now stores the Vertex IDs** (`veo-3.1-generate-001`, `veo-3.1-fast-generate-001`,
  `veo-3.1-lite-generate-001`), as enum values, default and `apiEndpoint`. Option order and labels are kept;
  Lite's label now says it is a preview on Vertex. The Gemini API route translates back to the
  `-preview` IDs (`GEMINI_API_MODELS` in veo.py) until 2026-10-22.
- **Saved preview IDs migrate without a date gate.** It's a rename of the same model, and both routes accept
  either spelling (`canonical_model`), so there was nothing to protect by waiting. The Veo 3.0/2.0 migration
  now targets the `-001` IDs directly instead of the dying preview IDs.
- **GOOGLE_API_KEY-only after 2026-10-22:** `handle_veo` raises `MissingCredentialError` naming
  `GOOGLE_VERTEX_CREDENTIALS` before any request (reused `previews_retired`). Routing is unchanged: a user with
  both GOOGLE_API_KEY and FAL_KEY still lands on the Google route and gets that message rather than falling
  through to fal. I kept it that way because fal's Veo 3.1 is believed to run on the same previews (status
  unverified) and changing `route_provider` would also need the frontend mirror changed. `with_vertex_hint`
  still decorates fal failures.
- Tests that exercise the Gemini API route now pin `previews_retired` to False, so they keep passing after
  2026-10-22 (several would have broken on that date).
- **veo-3-flf pricing added** (Vertex route, `provider: google`). The node stores duration as "4s", which
  `multiplyBy` can't read, so the entry is `per: video` with one row per resolution × audio × duration.
  Vertex lists Veo per "count"; read as per second like the existing veo-3 entry (unit label NOT CONFIRMED).
- Not done: Vertex `generateAudio` is still always true on veo-3 (Vertex sells video-only at about half price),
  and reference images on Vertex are still not exposed. Both are feature work, not retirement work.
