# Hermes Setup — authenticating the Nous Portal node (no `.env` key)

This is the one piece of setup the `nous-portal-universal` node needs. It is **not** an API key in `.env`. Read this before telling a user "add your Nous key" — there is no such key.

## TL;DR

```bash
hermes-daedalus model   # opens a browser → log in / subscribe at portal.nousresearch.com → pick "Nous Portal"
```

That's it. Hermes writes the credential to `~/.hermes/profiles/daedalus/auth.json`, Nebula reads it at run time, and the dropdown fills with your Hermes models. No file to edit, no key to paste.

## Why there's no env var

Every other provider in Nebula reads an API key from `.env` (e.g. `MESHY_API_KEY`, `RUNWAY_API_KEY`). Nous Portal is the exception: the node definition's `envKeyName` is `[]`, and the handler (`backend/handlers/nous_portal.py`) **ignores** the `api_keys` dict. Instead, the backend service `backend/services/nous_auth.py` reads Hermes's OAuth credential files under `~/.hermes/`. Hermes owns the login (browser OAuth at portal.nousresearch.com) and the token lifecycle; Nebula just borrows the result.

## What Hermes writes, and what Nebula reads

After login, the relevant file looks like this (shape captured from a real OAuth-authed profile):

```jsonc
// ~/.hermes/profiles/daedalus/auth.json
{
  "credential_pool": {
    "nous": [
      {
        "auth_type": "oauth",
        "access_token": "<short-lived oauth token>",
        "refresh_token": "...",
        "agent_key": "sk-...",                                  // ← the Bearer token Nebula uses
        "agent_key_expires_at": "...",
        "inference_base_url": "https://inference-api.nousresearch.com/v1",  // ← becomes the base URL
        "portal_base_url": "https://portal.nousresearch.com"
      }
    ]
  }
}
```

Nebula reads `credential_pool.nous[0].agent_key` and sends `Authorization: Bearer <agent_key>`. The `agent_key` is a **short-lived (~24h) key Hermes mints from the OAuth pair and auto-refreshes in the background** — you don't manage it. The base URL comes from `inference_base_url` (defaults to `https://inference-api.nousresearch.com/v1` if missing). If there's no `agent_key`, the loader falls back to `access_token`.

## Profile lookup order (where Nebula looks)

`load_nous_credential()` checks these paths in order and uses the first one that has a `credential_pool.nous` entry with a usable token:

1. **Daedalus profile** — `~/.hermes/profiles/daedalus/auth.json` (checked first, because Daedalus chat runs through `hermes-daedalus` against this profile and the canvas node should see the same auth).
2. **Active profile** — the name in `~/.hermes/active_profile` → `~/.hermes/profiles/<name>/auth.json` (skipped if it's already `daedalus`).
3. **Global** — `~/.hermes/auth.json` (last resort).

So the canonical login command is the **daedalus** wrapper (`hermes-daedalus model`), which targets path #1. Plain `hermes` may log into a *different* profile — if you authed with plain `hermes` and the node still can't find a credential, re-run with `hermes-daedalus model`.

### Overrides (advanced)

`nous_auth.py` honors a couple of env vars for non-default Hermes installs:
- `HERMES_HOME` — base dir (default `~/.hermes`).
- `HERMES_AUTH_FILE` — path to the **global** fallback `auth.json` (default `$HERMES_HOME/auth.json`).

These move *where Hermes's files live*; they are **not** a way to inject a raw Nous API key.

## Troubleshooting

| Symptom (verbatim message) | Cause | Fix |
|---|---|---|
| `No Nous Portal credential found in any Hermes profile. Run `hermes-daedalus model` and select Nous Portal…` | No `credential_pool.nous` entry in any checked profile (never logged in, or logged into a different profile). | Run `hermes-daedalus model` and pick **Nous Portal**. |
| `Nous Portal token rejected — run `hermes auth` to refresh.` (HTTP 401 from `/api/nous/models`) | The `agent_key` is stale/invalid. | Re-run the OAuth login so Hermes refreshes the key. |
| Dropdown stuck on "Loading models…" | The backend `GET /api/nous/models` proxy can't auth or reach Nous. | Confirm login (above); check the backend logs for the upstream status. |
| `No model selected — choose one from the Inspector panel` | The required `model` param is still empty. | Pick a Hermes model in the Inspector. |

## What this does NOT set up

Logging in via Hermes authenticates **inference only** (chat completions + streaming + the three Hermes models). It does **not** enable the Tool Gateway (managed image gen / TTS / web search / browser) from this node, tool calling, JSON mode, or the legacy completions endpoint — none of those are wired in Nebula. See the "Capability boundaries" section of `SKILL.md`.
