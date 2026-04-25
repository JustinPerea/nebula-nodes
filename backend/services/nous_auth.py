"""Read Nous Portal credentials out of Hermes's per-profile auth files.

Hermes stores provider credentials per profile under
`~/.hermes/profiles/<profile>/auth.json`. There's also a global
`~/.hermes/auth.json` used as a fallback for env-sourced API keys. The
empirical shape of a Nous entry (captured from a real OAuth-authed
profile) is:

    {
      "credential_pool": {
        "nous": [
          {
            "auth_type": "oauth",
            "access_token": "<short-lived oauth token>",
            "refresh_token": "...",
            "agent_key": "sk-...",                  ← Bearer token to use
            "agent_key_expires_at": "...",
            "inference_base_url": "https://inference-api.nousresearch.com/v1",
            "portal_base_url": "https://portal.nousresearch.com",
            ...
          }
        ]
      }
    }

The Bearer token Hermes actually attaches to inference calls is the
`agent_key`, not the OAuth `access_token`. Nous mints short-lived agent
keys (~24h) from the OAuth pair; Hermes refreshes them in the background.
We honor that — our handler attaches `Authorization: Bearer <agent_key>`.

Profile lookup order:
  1. The Daedalus profile (`~/.hermes/profiles/daedalus/auth.json`),
     because Daedalus chat runs through `hermes-daedalus` against this
     profile and the canvas Nous node should see the same auth.
  2. The user's currently active profile (read from `~/.hermes/active_profile`).
  3. The global `~/.hermes/auth.json` as a last resort.

If none have a `nous` entry, we raise a clear error pointing the user at
`hermes-daedalus model` (the right wrapper to run for the Daedalus profile).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_INFERENCE_URL = "https://inference-api.nousresearch.com/v1"

HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
GLOBAL_AUTH_FILE = Path(
    os.environ.get("HERMES_AUTH_FILE", str(HERMES_HOME / "auth.json"))
)
DAEDALUS_PROFILE_AUTH = HERMES_HOME / "profiles" / "daedalus" / "auth.json"
ACTIVE_PROFILE_FILE = HERMES_HOME / "active_profile"


class NousNotAuthenticatedError(RuntimeError):
    """Raised when no Hermes profile has a Nous credential.

    Surfaced to the user verbatim — the message tells them which command
    to run and which profile to target, since `hermes-daedalus` and plain
    `hermes` log into different profiles.
    """


@dataclass(frozen=True)
class NousCredential:
    access_token: str
    base_url: str


def _read_pool(path: Path) -> list[dict] | None:
    """Return the `credential_pool.nous` list from an auth.json, or None."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    pool = data.get("credential_pool") or {}
    nous = pool.get("nous") or []
    return nous if nous else None


def _candidate_paths() -> list[Path]:
    """Profile-aware lookup order — see module docstring."""
    paths: list[Path] = [DAEDALUS_PROFILE_AUTH]
    if ACTIVE_PROFILE_FILE.exists():
        try:
            name = ACTIVE_PROFILE_FILE.read_text().strip()
        except OSError:
            name = ""
        if name and name != "daedalus":
            paths.append(HERMES_HOME / "profiles" / name / "auth.json")
    paths.append(GLOBAL_AUTH_FILE)
    return paths


def load_nous_credential() -> NousCredential:
    """Return the highest-priority Nous credential found in any profile."""
    last_path: Path | None = None
    for path in _candidate_paths():
        last_path = path
        nous = _read_pool(path)
        if not nous:
            continue
        cred = nous[0]
        token = cred.get("agent_key") or cred.get("access_token")
        if not token:
            continue
        base_url = (
            cred.get("inference_base_url")
            or cred.get("base_url")
            or DEFAULT_INFERENCE_URL
        )
        return NousCredential(access_token=str(token), base_url=str(base_url))

    raise NousNotAuthenticatedError(
        "No Nous Portal credential found in any Hermes profile. "
        "Run `hermes-daedalus model` and select Nous Portal — it OAuths in "
        "the browser and writes the credential into "
        "~/.hermes/profiles/daedalus/auth.json. "
        f"(Last path checked: {last_path})"
    )
