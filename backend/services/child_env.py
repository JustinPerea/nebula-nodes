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
- NEBULA_CONNECTOR_SESSION: the old desktop canvas nonce. Nothing sets it
  any more; an older Electron shell might.
"""
from __future__ import annotations

import os
from typing import Mapping

SECRET_ENV_KEYS = (
    "NEBULA_PERSON_TOKEN",
    "NEBULA_CONNECTOR_ENCRYPTION_KEY",
    "NEBULA_INJECTED_KEYS",
    "NEBULA_CONNECTOR_SESSION",
)


def scrubbed_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """A copy of ``env`` (default: this process's) without SECRET_ENV_KEYS."""
    source = os.environ if env is None else env
    return {key: value for key, value in source.items() if key not in SECRET_ENV_KEYS}
