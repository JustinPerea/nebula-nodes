"""A connected app's token, kept in a private file its MCP config points at.

Settings > Connect your agent mints a token for an outside app (Hermes,
Claude Code, Cursor...; services/app_tokens.py stores only its hash). The
app's MCP config used to hold the token itself, in plain text, and for
Claude Code, Codex and OpenClaw it also went on a command line (shell
history, the process list). Now Nebula writes it here when it is minted and
the config holds only this file's path, as ``NEBULA_APP_TOKEN_FILE``;
backend/mcp_server.py reads it at startup with the same strict reader as a
personal agent's token (services/agent_token_file.py).

Layout: ``<state>/app-tokens/<app id>.token``, the folder 0700 and the file
0600. App tokens outlive a backend restart, so unlike agent-tokens there is
no backend-pid level. Revoking an app deletes its file; at startup
``clear_unknown`` removes any file whose app is no longer active (revoked
while the delete failed, or a store reset).

The file is still a bearer secret: any program running as this macOS user
can read it and spend as the app until the person revokes it. What changes
is that it is in one place Nebula controls and deletes, not in each app's
config, shell history or a process list.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

from services import agent_token_file

DIR_NAME = "app-tokens"
ENV_VAR = "NEBULA_APP_TOKEN_FILE"
SUFFIX = ".token"


def root(state_dir: Path) -> Path:
    return Path(state_dir) / DIR_NAME


def path_for(state_dir: Path, app_id: str) -> Path:
    return root(state_dir) / f"{app_id}{SUFFIX}"


def write(state_dir: Path, app_id: str, token: str) -> Path:
    """Write a new app's token to its 0600 file and return the path. Raises
    (FileExistsError, OSError, ValueError) rather than overwrite anything."""
    return agent_token_file.write_private(root(state_dir), (), f"{app_id}{SUFFIX}", token)


def remove(state_dir: Path, app_id: str) -> bool:
    """Delete an app's token file. Returns whether one went; never raises."""
    return agent_token_file.unlink_private(root(state_dir), f"{app_id}{SUFFIX}")


def clear_unknown(state_dir: Path, active_ids: Iterable[str]) -> int:
    """At backend startup: delete everything in the folder except the token
    files of apps that are still active. Returns the number removed."""
    wanted = {f"{app_id}{SUFFIX}" for app_id in active_ids}

    def active(entry: os.DirEntry) -> bool:
        return entry.name in wanted and entry.is_file(follow_symlinks=False)

    return agent_token_file.sweep(root(state_dir), active)


read = agent_token_file.read
TokenFileError = agent_token_file.TokenFileError
