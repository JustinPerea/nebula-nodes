"""Launch profiles for Nebula's chat agents (Claude, Codex).

Every chat runner launches its CLI from a *clean* profile instead of
inheriting the user's whole agent config (decision #17 in the
agents-for-design PLAN). Without this, the in-app Claude agent loaded every
user MCP server (Gmail, Calendar, FLORA …), every user sub-agent (including
Fable), 300+ user skills and Claude auto-memory shared with dev sessions.

What a clean profile allows:
  - Nebula's own tools: the Nebula MCP server (every agent), the `nebula`
    CLI via Bash (Claude only; Codex's shell has no network), plus file reads
    inside the output root and the agent's own workdir (its cwd). Never the
    state dir: it holds the Commons store, whose pixels agents must fetch
    through the scoped, quarantine-checked API (`agent_read_grants`).
  - A private session working directory with no secrets (`agent_workspace`). The repo
    root holds `settings.json` (plaintext API keys) and `.env`, so agents
    never run there, and those files are also denied by absolute path.
  - Only Nebula's own per-turn MCP servers (`nebula` and the read-only Krea
    discovery bridge). User MCP configuration is ignored; account credentials
    stay in the backend.
  - Codex: no shell network, and only reviewed Codex features (browser and
    computer use, hooks, plugins, apps and the like are off, and a preflight
    refuses the turn if anything unreviewed is on). Its MCP servers run
    outside the sandbox, which is how it still reaches Nebula.
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

from services.krea_agent_mcp import KREA_READONLY_TOOLS, NEBULA_MCP_TOOLS, NEBULA_SERVER_NAME
from services.krea_agent_mcp import SERVER_NAME as KREA_SERVER_NAME


# Legacy/direct runner normalization. Picker choices are validated against
# the runtime's per-model catalog and preserve its supported effort labels.
EFFORT_LEVELS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")
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
# MCP tools by exact name, never a server wildcard: a tool added to a server
# stays denied until it is listed (and NEBULA_MCP_TOOLS is checked against
# the server in tests).
CLAUDE_MCP_ALLOW_RULES = (
    *(f"mcp__{NEBULA_SERVER_NAME}__{tool}" for tool in NEBULA_MCP_TOOLS),
    *(f"mcp__{KREA_SERVER_NAME}__{tool}" for tool in sorted(KREA_READONLY_TOOLS)),
)
CLAUDE_ALLOW_RULES = ("Bash(nebula)", "Bash(nebula *)", "Read", "Glob", "Grep", *CLAUDE_MCP_ALLOW_RULES)
# Always denied, even if an allow rule would match: nothing an agent runs may
# forge a design-memory approval. `ps` would otherwise run unprompted as a
# read-only command and list other processes (another chat's token sits in its
# environment, which `ps eww` prints).
CLAUDE_DENY_RULES = ("Bash(dm approve*)", "Bash(ps)", "Bash(ps *)")

# Codex features (codex-cli 0.160.0 names) Nebula's Codex agent may run with.
# Reviewed: local tool plumbing, image viewing and request transport. Anything
# else that is on, including a feature a newer Codex adds, refuses the turn
# (codex_session.codex_feature_preflight); features at stage "removed" do
# nothing and are ignored. code_mode_host is how newer models (gpt-6.1-sol)
# call every tool; with it off they can't call any. Checked live: the
# JavaScript it runs has no fetch, require or Deno, and no request from it
# reached the backend, so tools still go through the sandboxed shell and MCP.
CODEX_ALLOWED_FEATURES = frozenset({
    "shell_tool", "unified_exec", "unified_exec_tty", "shell_snapshot", "view_image",
    "content_item_kinds", "compaction_image_budget", "enable_request_compression", "fast_mode",
    "guardian_approval", "guardian_reuse_parent_compaction", "mentions_v2", "sleep_tool",
    "system_proxy_fallback", "unbounded_connection_retries", "write_stdin_approval",
    "code_mode_host",
})
# Turned off explicitly. Each can start a process outside the sandbox, reach the
# network or the person's screen and browser, load code or config the agent
# could write, or reach the user's own agent setup: hooks run commands,
# plugins and skill dependencies install MCP servers, apps are remote
# connectors, browser/computer use drive a real browser (which sends a real
# Origin) or the screen, the daemon can serve a turn from a process started
# with the user's own config. image_generation makes images on the ChatGPT plan
# outside the canvas, Nebula's spending limits and proposals; agents generate
# through Nebula nodes.
# `--strict-config` turns a renamed name into an error.
CODEX_DISABLED_FEATURES = (
    "memories", "hooks", "plugins", "remote_plugin", "plugin_sharing", "apps",
    "skill_mcp_dependency_install", "workspace_dependencies",
    "computer_use", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
    "in_app_browser", "in_app_chat", "in_app_dictation", "in_app_local_automation", "in_app_updates",
    "daemon_auto_start", "multi_agent", "realtime_conversation", "tool_suggest", "skill_search",
    "worktrees", "goals", "auth_elicitation", "tool_call_mcp_elicitation", "image_generation",
)

CODEX_CONFIG_PATH = Path.home() / ".codex" / "config.toml"
# Where Codex looks for project config, hooks and skills inside a workspace.
CODEX_PROJECT_CONFIG_DIRS = (".codex", ".agents")


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
    """Directories no agent may be granted or read directly: the Commons store,
    the Krea connector's vault, the token-file folders and the settings copy
    folder.

    The Commons blobs and database hold quarantined and other brands'
    references; the HTTP gate (scope + quarantine) is the only way agents may
    reach them. ``app-tokens`` and ``agent-tokens`` hold bearer tokens at
    predictable paths (services/app_token_file.py, agent_token_file.py): only
    the MCP server a token file was made for reads it, never a graph or media
    path or an in-app agent. ``settings-copy`` holds the copy of settings.json
    an in-place save keeps, the file a restore replaced, and their temp files,
    keys in plain text (services/settings.settings_copy_folder; review 17 of
    PR #203, settings MEDIUM-1).
    """
    from commons.paths import commons_root
    from services import agent_token_file, app_token_file
    from services.settings import settings_copy_folder

    # Derive paths only; importing the connector would construct its real vault.
    state_root = Path(os.environ.get("NEBULA_STATE_DIR", Path.home() / ".nebula"))
    return [commons_root(), state_root / "krea",
            app_token_file.root(state_root), agent_token_file.root(state_root), settings_copy_folder()]


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
    """Files holding credentials that no agent may read: settings.json, the
    temp file a save writes beside it (services/settings.secret_temp_paths;
    review 17 of PR #203, settings MEDIUM-1) and the .env files."""
    from services.settings import secret_temp_paths, settings_path

    project_root = Path(__file__).resolve().parent.parent.parent
    return [settings_path(), *secret_temp_paths(), project_root / ".env", project_root / "backend" / ".env"]


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
    """Nebula's own per-turn servers, without merging arbitrary user MCPs.

    The Nebula server's `env` names the token instead of holding it; Claude
    Code expands `${NEBULA_AGENT_TOKEN}` from its own environment. Codex gets
    the same servers through `codex_mcp_server_args`, which passes the names
    with `env_vars` instead.
    """
    from services.krea_agent_mcp import krea_server_config, nebula_server_config, nebula_server_env_refs

    return {
        NEBULA_SERVER_NAME: {**nebula_server_config(backend_url), "env": nebula_server_env_refs(backend_url)},
        KREA_SERVER_NAME: krea_server_config(backend_url),
    }


def codex_mcp_server_args(backend_url: str | None = None) -> list[str]:
    """`-c mcp_servers.*` for Codex. Codex gives stdio servers a filtered
    environment; `env_vars` lets the token and URL through by name."""
    from services.krea_agent_mcp import (
        CODEX_NEBULA_TOOL_TIMEOUT_SEC, NEBULA_MCP_ENV_VARS, krea_server_config, nebula_server_config,
    )

    args: list[str] = []
    for name, config in ((NEBULA_SERVER_NAME, nebula_server_config(backend_url)),
                         (KREA_SERVER_NAME, krea_server_config(backend_url))):
        args += ["-c", f"mcp_servers.{name}.command={json.dumps(config['command'])}",
                 "-c", f"mcp_servers.{name}.args={json.dumps(config['args'])}"]
    # The same exact-name list as Claude's allow rules: only listed tools are
    # exposed, and each runs without a prompt (nobody is there to answer one,
    # and approval_policy "never" otherwise refuses run_nodes, which is
    # marked open-world). Nebula's own spending limits and proposals still apply.
    approvals = ", ".join(f'{tool} = {{approval_mode = "approve"}}' for tool in NEBULA_MCP_TOOLS)
    args += ["-c", f"mcp_servers.{NEBULA_SERVER_NAME}.env_vars={json.dumps(list(NEBULA_MCP_ENV_VARS))}",
             "-c", f"mcp_servers.{NEBULA_SERVER_NAME}.tool_timeout_sec={CODEX_NEBULA_TOOL_TIMEOUT_SEC}",
             "-c", f"mcp_servers.{NEBULA_SERVER_NAME}.enabled_tools={json.dumps(list(NEBULA_MCP_TOOLS))}",
             "-c", f"mcp_servers.{NEBULA_SERVER_NAME}.tools={{{approvals}}}"]
    return args


def claude_profile_args(
    *,
    extra_dirs: list[Path],
    secret_paths: list[Path] | None = None,
    deny_read_dirs: list[Path] | None = None,
    backend_url: str | None = None,
    with_servers: bool = False,
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
        "--mcp-config", json.dumps({"mcpServers": clean_mcp_servers(backend_url) if with_servers else {}}),
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


def codex_profile_args(*, effort: str | None) -> list[str]:
    """Flags that launch `codex exec` from the clean profile.

    `--ignore-user-config` skips ~/.codex/config.toml (its MCP servers,
    memories and hooks) while auth still comes from CODEX_HOME, so the
    ChatGPT subscription login keeps working. CODEX_DISABLED_FEATURES are
    turned off explicitly, since most are on by default.
    """
    args = [
        "--ignore-user-config",
        "--ignore-rules",
        # Agents run from `agent_workspace`, which isn't a git repo.
        "--skip-git-repo-check",
    ]
    for feature in CODEX_DISABLED_FEATURES:
        args.extend(["--disable", feature])
    if effort is not None:
        args.extend(["-c", f'model_reasoning_effort={json.dumps(effort)}'])
    return args


def codex_filesystem_args(*, workdir: Path, deny_paths: list[Path], output_root: Path | None = None) -> list[str]:
    """Keep the current session writable while denying protected storage and peers.

    ``output_root`` (Nebula's output folder; codex_session passes OUTPUT_ROOT)
    is read-only. The ':workspace' base makes /tmp and $TMPDIR writable as
    well as the workdir (checked live with `codex sandbox`, codex-cli
    0.163.0), so an output folder under one of them would otherwise be
    writable, and the spending check prices runs from files there because
    no agent can change them after the check (services/input_sizes.py). A
    read entry wins over the base's write; a workdir inside the output
    folder is refused.

    Never combine these flags with --sandbox or sandbox_mode: those legacy
    settings override named profiles. The clean config and strict parsing
    must fail rather than silently falling back to broad reads.

    The shell has no network: Codex reaches Nebula only through its MCP
    servers, which run outside the sandbox and carry the turn's agent token.
    With network on, a shell could call the backend with headers of its own
    choosing, or with the person's token read from the browser's storage on
    disk. The workspace's `.codex` and `.agents` stay unwritable, so a turn
    can't plant project config, hooks or skills for the next turn of the same
    chat. (Checked live with codex-cli 0.160.0: a planted `.codex/config.toml`
    MCP server and hooks file never start under `--ignore-user-config`, which
    skips project layers too; with user config loaded the same MCP server did
    start, even with the project's trust_level set to "untrusted".)
    """
    from services.agent_workspaces import workspace_deny_roots

    validate_agent_read_grants(workdir=workdir, extra_dirs=[output_root] if output_root else [],
                               protected=deny_paths)
    if output_root is not None and paths_overlap(workdir, output_root):
        raise GrantOverlapsProtectedDir(
            f"agent workdir {workdir} overlaps Nebula's output folder {output_root}, which agents may only read")
    denied: set[str] = set()
    for path in deny_paths:
        # Deny the configured spelling as well as a symlink's current target.
        # No contents are opened; absent paths are denied for later creation.
        denied.update((str(Path(path).absolute()), str(Path(path).resolve())))
    workspace_roots = workspace_deny_roots(workdir)
    for root in workspace_roots:
        denied.update((str(root.absolute()), str(root.resolve())))
    filesystem = {path: "deny" for path in sorted(denied)}
    if output_root is not None:
        # Both spellings, as for the denies: the configured one and a symlink's target.
        for spelling in (str(Path(output_root).absolute()), str(Path(output_root).resolve())):
            filesystem.setdefault(spelling, "read")
    # A narrower current-session grant reopens only this subtree. Denying the
    # parent also covers sessions created after this subprocess starts.
    if workspace_roots and workdir.resolve().is_relative_to(workspace_roots[0].resolve()):
        filesystem[str(workdir.resolve())] = "write"
    for name in CODEX_PROJECT_CONFIG_DIRS:
        for base in (workdir.absolute(), workdir.resolve()):
            filesystem[str(base / name)] = "deny"
    entries = ", ".join(f'{json.dumps(path, ensure_ascii=False)} = "{access}"'
                        for path, access in filesystem.items())
    return [
        "--strict-config",
        "-c", 'default_permissions="nebula-agent"',
        "-c", 'permissions.nebula-agent.extends=":workspace"',
        "-c", f"permissions.nebula-agent.filesystem={{{entries}}}",
        "-c", "permissions.nebula-agent.network.enabled=false",
    ]
