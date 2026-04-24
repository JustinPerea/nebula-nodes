# Setting up Daedalus (Hermes Agent + Kimi K2.6)

Daedalus is nebula-nodes' creative-craftsman agent — a master builder that
plans multi-stage creative pipelines on the canvas, measures every output,
and learns from every failed cut. It's powered by
[Hermes Agent](https://github.com/NousResearch/hermes-agent) from Nous
Research, running Kimi K2.6 via OpenRouter.

Claude remains the default chat agent. Daedalus is opt-in.

## 1. Install Hermes Agent

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

Verify:

```bash
hermes --version
```

Expected: prints a version string (v0.10+).

## 2. Configure OpenRouter + Kimi K2.6

Get an OpenRouter API key from https://openrouter.ai/keys if you don't have
one. Then:

```bash
hermes login
# Select 'openrouter' when prompted
# Paste your OpenRouter key when asked
```

Set Kimi K2.6 as your default model:

```bash
hermes config set model.provider openrouter
hermes config set model.name moonshotai/kimi-k2.6
```

Verify:

```bash
hermes config get model
```

Expected: shows `provider: openrouter, name: moonshotai/kimi-k2.6`.

## 3. Create the Daedalus Hermes profile

Hermes profiles give each agent an isolated SOUL.md, memories, sessions, and
skills directory. We create a dedicated `daedalus` profile so it doesn't
interfere with any other Hermes work you're doing in your terminal.

```bash
hermes profile create daedalus
hermes profile alias daedalus --name hermes-daedalus
```

The `--name hermes-daedalus` alias creates a wrapper script at
`~/.local/bin/hermes-daedalus` — the backend's subprocess spawner looks for
exactly that binary name. (Plain `hermes profile alias daedalus` without
`--name` would create a wrapper called just `daedalus`, which isn't what the
backend expects.)

The wrapper lets us invoke `hermes-daedalus chat ...` and always use the
daedalus profile, without touching your globally active profile. This is
the only clean way to pin a profile for subprocess invocation — Hermes's
`chat` subcommand has no `--profile` flag.

If the new `daedalus` profile doesn't inherit your Kimi/OpenRouter config,
set it explicitly:

```bash
hermes-daedalus config set model.provider openrouter
hermes-daedalus config set model.name moonshotai/kimi-k2.6
```

Verify:

```bash
hermes-daedalus config get model
```

## 4. Install Daedalus's SOUL.md

`hermes profile create daedalus` populates the profile with a generic
"You are Hermes Agent…" SOUL.md. Left as-is, Kimi will introduce itself as
Hermes Agent in any non-tool-calling turn — identity claims in SOUL.md
outweigh the persona directive in a loaded skill. Overwrite with the
repo-shipped Daedalus SOUL.md:

```bash
# From inside the nebula-nodes clone
cp .hermes/profiles/daedalus/SOUL.md ~/.hermes/profiles/daedalus/SOUL.md
```

Verify:

```bash
head -1 ~/.hermes/profiles/daedalus/SOUL.md
```

Expected: the first line starts with `You are Daedalus`.

## 5. Install the daedalus-core skill

nebula-nodes ships Daedalus's playbook at `.hermes/skills/daedalus-core/`.
Copy (don't symlink; Hermes doesn't follow symlinks for discovery) into the
daedalus profile's `creative` category:

```bash
# From inside the nebula-nodes clone
mkdir -p ~/.hermes/profiles/daedalus/skills/creative
cp -R .hermes/skills/daedalus-core \
  ~/.hermes/profiles/daedalus/skills/creative/daedalus-core
```

Verify:

```bash
hermes-daedalus skills list | grep daedalus-core
```

Expected: shows `daedalus-core` as a local skill under the `creative`
category. If nothing prints, check the skill is at
`~/.hermes/profiles/daedalus/skills/creative/daedalus-core/SKILL.md`.

**Re-install after repo updates:** if we ship a new version of
`daedalus-core/SKILL.md` upstream, re-run the `cp` to refresh your local
copy. A future version of this guide may ship a one-shot install script
that handles this.

## 6. Install the `nebula` CLI wrapper

Daedalus drives the canvas via the `nebula` CLI, invoked through Hermes's
`terminal` tool. The `nebula` command isn't a shell binary by default — it's
a Python package invoked as `python3 -m nebula`. We install a small wrapper
at `~/.local/bin/nebula` so the subprocess environment (and your terminal)
can call `nebula` directly.

```bash
cat > ~/.local/bin/nebula <<'EOF'
#!/bin/bash
# nebula CLI wrapper — invokes `python3 -m nebula`. Adjust the cd path to
# your nebula-nodes clone if it lives somewhere else.
cd "$HOME/Documents/Projects/nebula_nodes" 2>/dev/null || true
exec python3 -m nebula "$@"
EOF
chmod +x ~/.local/bin/nebula
```

Verify (with the backend running — see step 8):

```bash
nebula nodes | head -5
```

Expected: prints a list of available node types.

**Note:** the wrapper hardcodes the nebula-nodes clone path to
`~/Documents/Projects/nebula_nodes`. Edit the `cd` line in the wrapper if
you cloned elsewhere. A future version of this guide may use an env var.

## 7. One-turn smoke test

From inside the nebula-nodes directory:

```bash
hermes-daedalus chat -q "Introduce yourself and list your opinions about image models." -Q \
  --skills daedalus-core
```

Expected: Daedalus responds in the craftsman voice, names specific models
with opinions (gpt-image-2 as default, Imagen 4 for photoreal portraits,
Nano Banana Pro for multi-reference character sheets). Output starts with
`session_id: <timestamp_id>` on the first line (e.g.
`session_id: 20260423_095548_a2985d`), followed by the response body.

If you see "hermes-daedalus: command not found," re-run
`hermes profile alias daedalus` and ensure `~/.local/bin` is in your PATH.

## 8. Launch the nebula backend + frontend

Same as before — Hermes integration reuses the existing dev setup.

```bash
# Terminal 1
cd backend && python -m uvicorn main:app --port 8000

# Terminal 2
cd frontend && npm run dev
```

Open http://localhost:5173, open the chat panel, switch the agent selector
to **Daedalus**, and send a message.

## Autonomy modes

The header toggle in the chat panel has two positions:

- **Auto-pilot (▶):** Daedalus runs the full pipeline without asking.
- **Step Approval (⏸):** before expensive operations (>$0.01 or >30s), it
  pauses and shows you a plan. Click Approve or Reject + add notes.

The backend sets `DAEDALUS_APPROVAL=auto|step` in the subprocess env so the
agent's SKILL.md can switch modes.

## Learnings

Daedalus saves what it learns to
`~/.hermes/skills/daedalus-learnings/LEARNINGS.md` on your machine. This is
YOUR Daedalus's memory — personal, user-local, privacy-friendly. When a
learning in your LEARNINGS.md has been confirmed multiple times and seems
generally applicable, you can promote it upstream by opening a PR on
nebula-nodes that adds it to `daedalus-core/SKILL.md` — your local lesson
becomes every future user's baseline.

## Troubleshooting

**"hermes-daedalus: command not found"**
Run `hermes profile alias daedalus` to (re-)create the wrapper script.
Ensure `~/.local/bin` is in your PATH.

**"hermes exited N: auth failed..."**
Run `hermes-daedalus login` and select openrouter; verify your key at
https://openrouter.ai/keys.

**"hermes exited N: rate limit..."**
OpenRouter's rate limits vary per model. Wait ~30 seconds and retry, or
switch models temporarily via the model-selector in the chat panel.

**"Daedalus keeps re-introducing itself mid-conversation"**
The session ID may not be threading correctly. Check that the chat panel
shows a session pill (short ID after your model name) — if not, open the
browser console and look for WebSocket errors.

**Kimi K2.6 tool calls look malformed**
Some providers have edge cases with function-calling on new models. Swap to
`moonshotai/kimi-k2` (prior version) as a fallback:

```bash
hermes-daedalus config set model.name moonshotai/kimi-k2
```

## Kimi track evidence (for hackathon submission)

For the Nous Research Creative Hackathon, Daedalus running on Kimi K2.6 is
provable:

- `hermes-daedalus config get model` → shows `moonshotai/kimi-k2.6`
- `hermes-daedalus insights` after a demo run → shows Kimi token usage
- `backend/services/hermes_session.py` hardcodes `--provider openrouter
  --model moonshotai/kimi-k2.6` and invokes via `hermes-daedalus`
