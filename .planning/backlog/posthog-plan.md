# PostHog in Nebula Nodes: plan (not scheduled)

Status: **plan only**. Needs Justin's OK before any build: it adds a new data flow out of people's machines.
Written 2026-11-06 at Justin's request ("we should be using PostHog much more").

Account: PostHog US cloud, org "Good Machines", project 548985. Only Mitamaton sends to it today. Startup credits cover product analytics, error tracking, session replay, flags, surveys and LLM analytics.

Packages (checked 2026-11-06, official PostHog repos): `posthog-js` (github.com/PostHog/posthog-js) and `posthog` for Python (github.com/posthog/posthog-python). Vendor we already use, so the first-party rule applies; pin an exact version when adding.

## The shape: one backend gate, off until the person says yes

Nebula is open source and runs on each person's own keys, so the default is **nothing sent**.

- **Consent.** Off by default. Ask once on first launch (the agent-freedom rule: new installs are asked first), and a Settings > Preferences toggle ("Share anonymous usage and errors with Good Machines") that turns it on or off at any time. Off means the SDK is never initialised, not just opted out.
- **One gate.** Every event goes through the backend: the frontend posts to a local `/api/telemetry` route, and the backend sends with the Python SDK. Nothing in the app calls PostHog directly. One place to check consent, scrub and test.
- **Allowlist, not blocklist.** A typed schema of event names and properties (`backend/services/telemetry_events.py`). Unknown events or properties are dropped. Property values are enums, catalog ids, numbers or booleans; there is no free-text field, so a prompt can't leak through one.
- **Anonymous.** A random install id is the distinct id. No email, no account, no project or file names. `disable_geoip=True`, and turn on "discard client IP" in the project settings.
- **A check script** in `check:ratchets` fails if any code outside the gate imports `posthog` or `posthog-js`, or if a schema property is typed as free text.
- **Agents (MCP parity):** agents can read whether sharing is on (a read tool); only the person changes it, through the person-gated settings route. Agent-started runs are tagged `actor: agent` and send the same events.

**Never sent:** prompts, negative prompts, notes, pin or chat text, node labels, moodboard briefs, file names or paths, images, audio, video, output URLs, API keys, provider account ids, error messages (they can quote prompts or paths).

## 1. Product analytics (size M)

Events, all through the gate:

- `app_opened`: app version, platform, whether it's the desktop build.
- `node_added`: node type id (catalog id only), source (palette, apply, agent).
- `run_started` / `run_finished`: node type, provider, model id, status (completed, failed, cancelled), error kind (an enum: auth, quota, timeout, provider_4xx, provider_5xx, refused_by_limit, other), duration in ms, Nebula's own cost estimate, actor (person or agent), key route (own key, Krea plan, free).
- `first_output`: time from first launch to the first completed run. Sent once per install.
- `moodboard_created`, `moodboard_used_in_run` (counts only), `proposal_shown` / `accepted` / `declined`, `agent_connected` (agent kind: Claude, Codex, Gemini, custom).

Dashboards to build in PostHog: runs by provider and model, failure rate by error kind, time to first output, moodboard adoption, share of runs by agents.

## 2. LLM analytics for provider calls (size S, on top of 1)

Send a `$ai_generation` event per provider call from the engine (manual capture; most of our providers aren't OpenAI or Anthropic SDK calls), with privacy mode on and no `$ai_input` or `$ai_output`: `$ai_provider`, `$ai_model`, `$ai_latency`, `$ai_time_to_first_token` where streaming, `$ai_is_error`, `$ai_http_status`, `$ai_total_cost_usd`, and the run id as `$ai_trace_id`.

**Against what Nebula already has:** `services/agent_spend.py` enforces the person's limits locally (per run, per chat session, outside agents over 24 h, Krea plan runs), and the daily total (PR #212) shows the person their own spend. Both stay local and stay the source of truth for the person. PostHog adds only the aggregate view across installs that opted in: which providers are slow or failing, and what a typical run costs. No duplication: the cost figure comes from the same price function the spend guard uses, computed once and passed to both. PostHog never enforces anything.

## 3. Error tracking (size S–M)

- Backend: Python SDK `enable_exception_autocapture=True`, plus explicit capture in the engine's provider-call failure path, all through the gate.
- Frontend: the error boundary and `window.onerror` / `unhandledrejection` post to the gate.
- Scrub: send the exception type and stack frames only. Drop the message and frame locals. Rewrite paths to repo-relative (no home folder, no username).

## 4. Session replay and the rest: later

- **Session replay: not in v1.** The canvas is prompts and media; masking it reliably (`ph-no-capture` on every preview, masked inputs) is easy to get wrong, and replay would have to bypass the backend gate. Revisit only for Justin's own dogfood builds, with everything masked by default.
- Flags and surveys: later, once events are flowing. A survey after `first_output` is a natural first one.

## Order

1. The gate, the schema, the consent toggle and first-launch ask, the install id and the check script. Nothing is sent before this lands. Design pass for the consent copy and the Settings line. (M)
2. Run events and `$ai_generation` from the engine. (M)
3. Error tracking, backend then frontend. (S–M)
4. The other product events: moodboards, proposals, first output, agents. (S)
5. PostHog dashboards. (S, no code)

Each step ships with its tests, including one that sends a run with a known prompt through the gate and asserts the prompt appears in no event.
