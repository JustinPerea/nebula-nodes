# Kimi Track Evidence — Daedalus on Kimi K2.6

This folder is the evidence package for the Nous Research Creative Hackathon
Kimi track. It proves the **Daedalus** chat agent inside nebula_nodes runs
end-to-end on **Kimi K2.6** (`moonshotai/kimi-k2.6`).

## How Daedalus pins Kimi K2.6

Daedalus does not depend on the user's default Hermes model. The Python
runner pins `moonshotai/kimi-k2.6` per-call:

```
backend/services/hermes_session.py:36
    DEFAULT_MODEL = "moonshotai/kimi-k2.6"
backend/services/hermes_session.py:208
    "--provider", effective_provider,    # openrouter
    "--model", model,                    # moonshotai/kimi-k2.6
```

Every Daedalus turn invokes `hermes chat -q ... --provider openrouter
--model moonshotai/kimi-k2.6 ...` regardless of `hermes config show`.

## Evidence files (capture after the demo run)

| File | What it proves | How to capture |
|------|----------------|----------------|
| `evidence-config.txt` | Hermes is installed and the Daedalus runner's pinned model is reachable | `hermes config show > evidence-config.txt` |
| `evidence-insights.txt` | Token usage during the demo session (Kimi K2.6 line items) | `hermes insights --days 1 > evidence-insights.txt` |
| `evidence-sessions.txt` | DB excerpt: provider + model + timestamps for the most recent sessions | `sqlite3 ~/.hermes/state.db "SELECT id, source, model, billing_provider, started_at FROM sessions ORDER BY started_at DESC LIMIT 5" > evidence-sessions.txt` |
| `evidence-config.png` | Screenshot of `hermes config show` showing the auxiliary providers + model layout | manual |
| `evidence-demo-run.png` | Screenshot of the nebula_nodes app mid-demo: Daedalus answering with copper accent + canvas building nodes | manual |
| `evidence-canvas.png` | Final canvas after demo prompt completes (text-input → Imagen → Veo 3.1 → Preview) | manual |

## Running the demo

See `docs/superpowers/plans/2026-04-23-daedalus-hermes-integration.md` Task 16
Step 3 for the demo script. Short version:

1. `cd backend && python -m uvicorn main:app --port 8000 --reload`
2. `cd frontend && npm run dev`
3. Open http://localhost:5173
4. Switch agent selector to **Daedalus**
5. Send: *"Build me a looping scene: foggy forest at dawn, camera drifts through. Cinematic."*
6. Watch nodes appear, edges connect, generation runs
7. Capture screenshots above
8. Run the three CLI commands above to dump txt evidence

## Pre-flight verified (2026-04-26)

- Hermes Agent v0.11.0 installed at `~/.local/bin/hermes`
- daedalus-core skill registered (`hermes skills list` → `local`)
- Backend test suite: 217 passing
- Frontend typecheck: clean
