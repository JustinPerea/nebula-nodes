"""Launch profiles for Nebula's chat agents (Claude, Codex).

Every chat runner launches its CLI from a *clean* profile instead of
inheriting the user's whole agent config (decision #17 in the
agents-for-design PLAN). Without this, the in-app Claude agent loaded every
user MCP server (Gmail, Calendar, FLORA …), every user sub-agent (including
Fable), 300+ user skills and Claude auto-memory shared with dev sessions.

What a clean profile allows:
  - Nebula's own tools: the `nebula` CLI (via Bash) plus file reads inside
    the output root and the agent's own workdir (its cwd). Never the state
    dir: it holds the Commons store, whose pixels agents must fetch through
    the scoped, quarantine-checked API (`agent_read_grants`).
  - A private session working directory with no secrets (`agent_workspace`). The repo
    root holds `settings.json` (plaintext API keys) and `.env`, so agents
    never run there, and those files are also denied by absolute path.
  - Only Nebula's ephemeral, read-only Krea discovery MCP bridge. User MCP
    configuration is ignored; account credentials stay in the backend.
  - User/project/local settings are ignored, slash-command skills disabled,
    and auto-memory off. Private file grants exclude the repo and user config.
  - Explicit permissions instead of `--dangerously-skip-permissions`.
    Anything not allowed is denied automatically (no one is there to answer
    a prompt in `-p` mode).

Model and effort are chosen per turn in the chat panel chip and passed
through here, so the exact model and effort are always known instead of an
opaque default.
"""

from __future__ import annotations

import json
import os
import tomllib
from pathlib import Path
from typing import Any


# Effort levels offered by the chat chip. Same labels as the node-level
# reasoning selector (Low / Medium / High / X-High).
EFFORT_LEVELS: tuple[str, ...] = ("low", "medium", "high", "xhigh")
DEFAULT_EFFORT = "medium"

# Claude model aliases. Passed verbatim to `claude --model`, which resolves
# each alias to the latest model in that family. That keeps the pin current
# without hard-coding version IDs that go stale (the old table still mapped
# `opus` to claude-opus-4-7).
CLAUDE_MODEL_ALIASES: tuple[str, ...] = ("opus", "sonnet", "haiku")
DEFAULT_CLAUDE_MODEL = "opus"

# Static user-controlled servers are never admitted. The Krea bridge below is
# built by the backend for this invocation, rather than loaded from user config.
CLEAN_MCP_SERVERS: dict[str, dict[str, Any]] = {}

# Built-in Claude tools the clean profile exposes. Bash is required for the
# `nebula` CLI; the permission rules below narrow it to that one command.
CLAUDE_TOOLS = ("Bash", "Read", "Glob", "Grep")
CLAUDE_ALLOW_RULES = ("Bash(nebula)", "Bash(nebula *)", "Read", "Glob", "Grep",
                     "mcp__nebula_krea__list_models", "mcp__nebula_krea__get_model_schema")
# Always denied, even if an allow rule would match: nothing an agent runs may
# forge a design-memory approval.
CLAUDE_DENY_RULES = ("Bash(dm approve*)",)

CODEX_CONFIG_PATH = Path.home() / ".codex" / "config.toml"


def normalize_effort(raw: Any) -> str:
    """Return a supported effort level, falling back to the default."""
    value = str(raw or "").strip().lower()
    return value if value in EFFORT_LEVELS else DEFAULT_EFFORT


def normalize_claude_model(raw: Any) -> str:
    """Return the Claude model to pass to `claude --model`.

    Aliases pass through verbatim. Full `claude-*` IDs are allowed so a user
    can pin an exact model with `/model`. Fable is never allowed in Nebula's
    agent (decision #17), and anything unrecognized falls back to the default.
    """
    value = str(raw or "").strip().lower()
    if not value or "fable" in value:
        return DEFAULT_CLAUDE_MODEL
    if value in CLAUDE_MODEL_ALIASES or value.startswith("claude-"):
        return value
    return DEFAULT_CLAUDE_MODEL


def agent_workspace(state_dir: Path | None = None) -> Path:
    """Allocate a fresh workspace for a caller without a bound session.

    Session-aware callers supply their existing workspace explicitly. Never
    fall back to the legacy shared directory, which may contain old references.
    """
    from services.agent_workspaces import create_workspace, workspace_root

    return create_workspace(state_dir or workspace_root().parent)


class GrantOverlapsProtectedDir(RuntimeError):
    """A directory an agent would be granted equals, contains or sits inside a protected one."""


def paths_overlap(a: Path, b: Path) -> bool:
    """Conservatively detect containment through names, symlinks and identity.

    Use the same case/Unicode and mount-alias handling as graph/media reads.
    Lexical names are reserved even before their directories exist.
    """
    from services.file_access import _comparison_path, _identity_contains

    a, b = Path(a).expanduser(), Path(b).expanduser()
    ra, rb = a.resolve(), b.resolve()
    names_a = map(_comparison_path, (Path(os.path.abspath(a)), ra))
    names_b = tuple(map(_comparison_path, (Path(os.path.abspath(b)), rb)))
    if any(left.is_relative_to(right) or right.is_relative_to(left)
           for left in names_a for right in names_b):
        return True
    return _identity_contains(ra, rb) or _identity_contains(rb, ra)


def protected_agent_dirs() -> list[Path]:
    """Directories no agent may be granted or read directly: the Commons store.

    Its blobs and database hold quarantined and other brands' references; the
    HTTP gate (scope + quarantine) is the only way agents may reach them.
    """
    from commons.paths import commons_root

    # Derive paths only; importing the connector would construct its real vault.
    state_root = Path(os.environ.get("NEBULA_STATE_DIR", Path.home() / ".nebula"))
    return [commons_root(), state_root / "krea"]


def agent_read_grants(*, output_root: Path, workdir: Path, protected: list[Path]) -> list[Path]:
    """The extra directories (`--add-dir`) for one agent turn.

    The workdir is the runner's cwd and needs no grant. Granting its parent,
    the state dir, would expose the Commons store inside it, which is how the
    blob gate was bypassed before. Fails closed rather than silently dropping
    a grant, so a misconfigured Commons root (e.g. inside the output root) is
    loud instead of turning into a confusing agent failure.
    """
    validate_agent_read_grants(workdir=workdir, extra_dirs=[output_root], protected=protected)
    return [output_root]


def validate_agent_read_grants(*, workdir: Path, extra_dirs: list[Path], protected: list[Path]) -> None:
    """Reject grants that expose private workspaces, including future siblings."""
    from services.agent_workspaces import workspace_deny_roots

    for granted in (*extra_dirs, workdir):
        for directory in protected:
            if paths_overlap(granted, directory):
                raise GrantOverlapsProtectedDir(
                    f"agent grant {granted} overlaps protected storage at {directory}")
    roots = workspace_deny_roots(workdir)
    for directory in roots:
        for granted in extra_dirs:
            if paths_overlap(granted, directory):
                raise GrantOverlapsProtectedDir(
                    f"agent grant {granted} overlaps private agent workspaces at {directory}")
    current = workdir.resolve()
    own_namespace = roots[0].resolve() if roots else None
    for directory in roots:
        root = directory.resolve()
        owns_subtree = root == own_namespace and current != root and current.is_relative_to(root)
        if paths_overlap(current, root) and not owns_subtree:
            raise GrantOverlapsProtectedDir(
                f"agent workdir {workdir} overlaps the reserved agent workspace directory {directory}")


def agent_workspace_env(workdir: Path) -> dict[str, str]:
    """Keep subprocess CLI path policy aligned with its backend state root.

    This is a location hint, never an authorization grant. The backend still
    verifies the turn token before permitting any private workspace access.
    """
    from services.agent_workspaces import workspace_deny_roots

    roots = workspace_deny_roots(workdir)
    if roots and workdir.resolve().is_relative_to(roots[0].resolve()):
        return {"NEBULA_STATE_DIR": str(roots[0].resolve().parent)}
    raw = os.environ.get("NEBULA_STATE_DIR")
    return {"NEBULA_STATE_DIR": str(Path(raw).expanduser().resolve())} if raw else {}


def default_secret_paths() -> list[Path]:
    """Files holding credentials that no agent may read."""
    from services.settings import SETTINGS_PATH

    project_root = Path(__file__).resolve().parent.parent.parent
    return [SETTINGS_PATH, project_root / ".env", project_root / "backend" / ".env"]


def secret_deny_rules(secret_paths: list[Path]) -> list[str]:
    """Read-deny rules for secret files, as absolute (`//`) paths."""
    # A single leading slash anchors at the settings source, not the
    # filesystem root; `//` is the absolute form.
    return [f"Read(/{path.resolve()})" for path in secret_paths]


def dir_deny_rules(directories: list[Path]) -> list[str]:
    """Read-deny rules for whole directories, as absolute (`//`) paths."""
    rules = []
    for directory in directories:
        root = directory.resolve()
        rules += [f"Read(/{root})", f"Read(/{root}/**)"]
    return rules


def clean_mcp_servers(backend_url: str | None = None) -> dict[str, dict[str, Any]]:
    """Build the one allowed local bridge without merging arbitrary user MCPs."""
    from services.krea_agent_mcp import SERVER_NAME, krea_server_config

    return {SERVER_NAME: krea_server_config(backend_url)}


def claude_profile_args(
    *,
    extra_dirs: list[Path],
    secret_paths: list[Path] | None = None,
    deny_read_dirs: list[Path] | None = None,
    backend_url: str | None = None,
    include_krea: bool = False,
) -> list[str]:
    """CLI flags that launch `claude -p` from the clean profile.

    `--restricted` ignores user, project and local settings files, removes code-running tools
    unless `--tools` names them, and confines file tools to the working dirs.
    `--settings` still applies, which is how hooks and permissions come in;
    that is also why the profile does not use `--bare`, which skips hooks.

    The `--add-dir` list is the real boundary: pass only what
    `agent_read_grants` returns. Two documented backstops sit behind it.
    `blockReadsOutsideWorkingDirectories` makes Read, Grep, Glob and LSP
    refuse paths outside the working dirs in every mode, even though the
    bare `Read` allow rule would otherwise permit them under dontAsk. The
    `deny_read_dirs` rules cover recognised Bash reads (cat, head, ...) too,
    but Claude applies Read rules to Grep and Glob only best-effort and never
    to subprocesses such as the `nebula` CLI, so they are defence in depth.
    """
    settings = {
        "autoMemoryEnabled": False,
        "permissions": {
            "allow": list(CLAUDE_ALLOW_RULES),
            "deny": [*CLAUDE_DENY_RULES, *secret_deny_rules(list(secret_paths or [])),
                     *dir_deny_rules(list(deny_read_dirs or []))],
            "blockReadsOutsideWorkingDirectories": True,
        },
    }
    args = [
        "--restricted",
        # Repo knowledge is explicitly bootstrapped. Do not resolve global or
        # project slash-command skills into this private chat profile.
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config", json.dumps({"mcpServers": clean_mcp_servers(backend_url) if include_krea else {}}),
        "--settings", json.dumps(settings),
        "--tools", ",".join(CLAUDE_TOOLS),
        "--permission-mode", "dontAsk",
    ]
    for directory in extra_dirs:
        args.extend(["--add-dir", str(directory)])
    return args


def claude_profile_env() -> dict[str, str]:
    """Env vars layered on top of the backend env for Claude turns."""
    # Belt and braces with `autoMemoryEnabled: false` in --settings.
    return {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}


def codex_default_model(config_path: Path = CODEX_CONFIG_PATH) -> str | None:
    """The model named in the user's Codex config, if any.

    The clean profile ignores the user config (MCP servers, memories, hooks),
    which would also drop its model choice. Reading just the `model` key keeps
    the user's Codex default while still recording exactly which model ran.
    """
    try:
        with config_path.open("rb") as fh:
            data = tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError):
        return None
    model = data.get("model")
    return str(model) if isinstance(model, str) and model.strip() else None


def codex_profile_args(*, effort: str) -> list[str]:
    """Flags that launch `codex exec` from the clean profile.

    `--ignore-user-config` skips ~/.codex/config.toml (its MCP servers,
    memories and hooks) while auth still comes from CODEX_HOME, so the
    ChatGPT subscription login keeps working. Memories are also disabled
    explicitly in case a future default turns them on.
    """
    return [
        "--ignore-user-config",
        "--ignore-rules",
        # Agents run from `agent_workspace`, which isn't a git repo.
        "--skip-git-repo-check",
        "--disable", "memories",
        "-c", f'model_reasoning_effort="{effort}"',
    ]


def codex_filesystem_args(*, workdir: Path, deny_paths: list[Path]) -> list[str]:
    """Keep the current session writable while denying protected storage and peers.

    Never combine these flags with --sandbox or sandbox_mode: those legacy
    settings override named profiles. The clean config and strict parsing
    must fail rather than silently falling back to broad reads.
    """
    from services.agent_workspaces import workspace_deny_roots

    validate_agent_read_grants(workdir=workdir, extra_dirs=[], protected=deny_paths)
    denied: set[str] = set()
    for path in deny_paths:
        # Deny the configured spelling as well as a symlink's current target.
        # No contents are opened; absent paths are denied for later creation.
        denied.update((str(Path(path).absolute()), str(Path(path).resolve())))
    workspace_roots = workspace_deny_roots(workdir)
    for root in workspace_roots:
        denied.update((str(root.absolute()), str(root.resolve())))
    filesystem = {path: "deny" for path in sorted(denied)}
    # A narrower current-session grant reopens only this subtree. Denying the
    # parent also covers sessions created after this subprocess starts.
    if workspace_roots and workdir.resolve().is_relative_to(workspace_roots[0].resolve()):
        filesystem[str(workdir.resolve())] = "write"
    entries = ", ".join(f'{json.dumps(path, ensure_ascii=False)} = "{access}"'
                        for path, access in filesystem.items())
    return [
        "--strict-config",
        "-c", 'default_permissions="nebula-agent"',
        "-c", 'permissions.nebula-agent.extends=":workspace"',
        "-c", f"permissions.nebula-agent.filesystem={{{entries}}}",
        "-c", "permissions.nebula-agent.network.enabled=true",
    ]
