# Setting up Hephaestus (Hermes Agent + Kimi K2.6)

Hephaestus is nebula-nodes' creative-generalist agent — an iterative artist
that plans, builds, and QAs multi-stage creative pipelines on the canvas.
It's powered by [Hermes Agent](https://github.com/NousResearch/hermes-agent)
from Nous Research, running Kimi K2.6 via OpenRouter.

Claude remains the default chat agent. Hephaestus is opt-in.

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

Set Kimi K2.6 as Hephaestus's default model:

```bash
hermes config set model.provider openrouter
hermes config set model.name moonshotai/kimi-k2.6
```

Verify:

```bash
hermes config get model
```

Expected: shows `provider: openrouter, name: moonshotai/kimi-k2.6`.

## 3. Install the repo-shipped hephaestus-core skill

nebula-nodes ships Hephaestus's persona + playbook at
`.hermes/skills/hephaestus-core/`. Hermes discovers skills from its active
profile's skills directory — copy (don't symlink; Hermes doesn't follow
symlinks for discovery) into the right category folder:

```bash
# Find your active profile
ACTIVE_PROFILE=$(cat ~/.hermes/active_profile)
echo "Active profile: $ACTIVE_PROFILE"

# Copy the skill into the profile's creative category
mkdir -p ~/.hermes/profiles/$ACTIVE_PROFILE/skills/creative
cp -R .hermes/skills/hephaestus-core \
  ~/.hermes/profiles/$ACTIVE_PROFILE/skills/creative/hephaestus-core
```

Verify:

```bash
hermes skills list | grep hephaestus-core
```

Expected: shows `hephaestus-core` as a local skill under the `creative`
category. If nothing prints, check the skill is at
`~/.hermes/profiles/<profile>/skills/creative/hephaestus-core/SKILL.md`.

**Re-install after repo updates:** if we ship a new version of
`hephaestus-core/SKILL.md` upstream, re-run the `cp` to refresh your
local copy. A future version of this guide may ship a one-shot install
script that handles this.

## 4. One-turn smoke test

From inside the nebula-nodes directory:

```bash
hermes chat -q "Introduce yourself and list your opinions about image models." -Q \
  --provider openrouter \
  --model moonshotai/kimi-k2.6 \
  --skills hephaestus-core
```

Expected: Hephaestus responds in the forge-god voice, names specific models
with opinions (Imagen cleaner than Nano Banana for faces, etc.). Output starts
with `session_id: <timestamp_id>` on the first line (e.g.
`session_id: 20260423_095548_a2985d`), followed by the response body.

If you see "hermes: command not found," check that Hermes is installed and
that `~/.local/bin` is in your PATH.

## 5. Launch the nebula backend + frontend

Same as before — Hermes integration reuses the existing dev setup.

```bash
# Terminal 1
cd backend && python -m uvicorn main:app --port 8000

# Terminal 2
cd frontend && npm run dev
```

Open http://localhost:5173, open the chat panel, switch agent selector to
**Hephaestus**, and send a message.

## Autonomy modes

The header toggle in the chat panel has two positions:

- **Auto-pilot (▶):** Hephaestus runs the full pipeline without asking.
- **Step Approval (⏸):** before expensive operations (>$0.01 or >30s), it
  pauses and shows you a plan. Click Approve or Reject + add notes.

## Learnings

Hephaestus saves what it learns to
`~/.hermes/skills/hephaestus-learnings/LEARNINGS.md` on your machine.
This is YOUR Hephaestus's memory — personal, user-local, privacy-friendly.
When a learning in your LEARNINGS.md has been confirmed multiple times and
seems generally applicable, you can promote it upstream by opening a PR on
nebula-nodes that adds it to `hephaestus-core/SKILL.md` — your local lesson
becomes every future user's baseline.

## Troubleshooting

**"hermes exited N: auth failed..."**
Run `hermes login` and select openrouter; verify your key at
https://openrouter.ai/keys.

**"hermes exited N: rate limit..."**
OpenRouter's rate limits vary per model. Wait ~30 seconds and retry, or
switch models temporarily via the model-selector in the chat panel.

**"Hephaestus keeps re-introducing itself mid-conversation"**
The session ID may not be threading correctly. Check that the chat panel
shows a session pill (short ID after your model name) — if not, open the
browser console and look for WebSocket errors.

**Kimi K2.6 tool calls look malformed**
Some providers have edge cases with function-calling on new models. Swap to
`moonshotai/kimi-k2` (prior version) as a fallback:

```bash
hermes config set model.name moonshotai/kimi-k2
```

## Kimi track evidence (for hackathon submission)

For the Nous Research Creative Hackathon, Hephaestus running on Kimi K2.6 is
provable:

- `hermes config get model` → shows `moonshotai/kimi-k2.6`
- `hermes insights` after a demo run → shows Kimi token usage
- `backend/services/hermes_session.py` hardcodes `--provider openrouter
  --model moonshotai/kimi-k2.6`
