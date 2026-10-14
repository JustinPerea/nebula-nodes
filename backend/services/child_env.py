"""The environment every process the backend starts gets: its own, minus secrets.

One scrub for every child (agents, the Commons reader, ffmpeg/ffprobe, the
Remotion renderer, Finder's `open`, git, ps, sips, brctl), so a secret added
here leaves all of them at once. A child that inherited the backend's
environment as-is would hold these in its own initial environment, where
`ps eww` shows them to any same-user program.

- NEBULA_PERSON_TOKEN: the person's launch secret (services/person_session.py).
  Nebula never puts it in the environment; this catches a launcher that did.
- NEBULA_CONNECTOR_ENCRYPTION_KEY: the Krea OAuth vault key.
- NEBULA_INJECTED_KEYS: the desktop app's provider keys.
  Electron sends both over stdin now (services/launch_secrets.py); these
  catch a hand-started backend or an older shell that set them.
- NEBULA_CONNECTOR_SESSION: the old desktop canvas nonce. Nothing sets it
  any more; an older Electron shell might.
- NEBULA_APP_TOKEN: an outside app's spending token (services/app_tokens.py).
  Nebula never sets it; a backend started from that app's shell might carry
  it, and an in-app chat must not spend as that app.
- NEBULA_APP_TOKEN_FILE: the path to such a token's file
  (services/app_token_file.py). The path isn't the token, but a child's own
  Nebula MCP server would read it and spend as that app.

PROCESS_LOCAL_ENV_KEYS are not secrets but describe this process only, so a
child must not inherit them either:

- NEBULA_PARENT_WATCH_FD: the fd the desktop sidecar watches for Electron's
  exit (services/parent_watch.py). A child that started its own FastAPI app
  with it set would watch an unrelated fd 3 and SIGTERM itself.
"""
from __future__ import annotations

import os
from typing import Mapping

SECRET_ENV_KEYS = (
    "NEBULA_PERSON_TOKEN",
    "NEBULA_CONNECTOR_ENCRYPTION_KEY",
    "NEBULA_INJECTED_KEYS",
    "NEBULA_CONNECTOR_SESSION",
    "NEBULA_APP_TOKEN",
    "NEBULA_APP_TOKEN_FILE",
)

PROCESS_LOCAL_ENV_KEYS = (
    "NEBULA_PARENT_WATCH_FD",
)

_STRIPPED_KEYS = frozenset(SECRET_ENV_KEYS + PROCESS_LOCAL_ENV_KEYS)


def scrubbed_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """A copy of ``env`` (default: this process's) without SECRET_ENV_KEYS
    or PROCESS_LOCAL_ENV_KEYS."""
    source = os.environ if env is None else env
    return {key: value for key, value in source.items() if key not in _STRIPPED_KEYS}
