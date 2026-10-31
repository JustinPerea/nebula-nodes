"""Each agent surface's own words for Nebula's agent calls: one table.

An agent reads Nebula through MCP tools (propose_change, describe_node, ...)
or through the `nebula` CLI (`nebula propose`, `nebula info <id>`, ...). A
refusal or a hint that tells the agent what to do next names the call in its
reader's words, worded where it is written (review 9 of PR #203, keys
MEDIUM-1): the CLI sends ``X-Nebula-Surface: cli`` on every request
(cli/client.py), and anything else reads MCP words. Nothing rewrites a
refusal on its way out.

``cli_words`` stays for data that arrives in MCP words and is printed by the
CLI (describe_node's billing note, a find_nodes row's needsKeyFor): one
table for main._start_node_notes and cli/formatter, with word boundaries,
so a text that already names a `nebula` command keeps it as it is.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

SURFACE_HEADER = "X-Nebula-Surface"
MCP = "mcp"
CLI = "cli"

# The calls a refusal or a hint names, by surface. A template names them as
# {propose}, {describe}, {find}, {apply} and {projects}; {withdraw} is a whole
# call with the proposal's id as {id} (canvas_proposals.withdraw_call).
# Every surface's words for these calls live here: main._start_node_notes,
# project_client and canvas_proposals' READY_NODES_* and WITHDRAW_* read this
# table (review 10 of PR #203, NIT-4).
WORDS: dict[str, dict[str, str]] = {
    MCP: {"propose": "propose_change", "describe": "describe_node", "find": "find_nodes", "apply": "edit_canvas",
          "projects": "list_projects", "withdraw": 'withdraw_proposal(proposal_id="{id}")'},
    CLI: {"propose": "`nebula propose`", "describe": "`nebula info <id>`", "find": "`nebula nodes`",
          "apply": "`nebula apply`", "projects": "`nebula projects`", "withdraw": "nebula proposal withdraw {id}"},
}

# The calls named by a bare tool name, which cli_words can find in MCP-worded
# text ({withdraw} is a whole call, never left in data for the CLI to reword).
_NAMED = ("propose", "describe", "find", "apply", "projects")
# Each MCP tool by its CLI command (WORDS, read the other way).
_CLI_FOR_TOOL = {WORDS[MCP][name]: WORDS[CLI][name] for name in _NAMED}
# A tool name already beside its command ("propose_change (`nebula
# propose`)") is left as it is.
_TOOL = re.compile(r"(?<![`\w])(" + "|".join(map(re.escape, _CLI_FOR_TOOL)) + r")\b(?! \(`nebula )")
# "propose_change (run: n2, n3)": a hint's way to propose these nodes (propose_run).
_PROPOSE_RUN = re.compile(r"propose_change \(run: ([^)]*)\)")


def surface(headers: Mapping[str, Any] | None) -> str:
    """The surface a request comes from: CLI when it says so, else MCP."""
    lower = {str(key).lower(): value for key, value in (headers or {}).items()}
    return CLI if str(lower.get(SURFACE_HEADER.lower()) or "").strip().lower() == CLI else MCP


def worded(template: str, where: str) -> str:
    """``template`` with each {call} in ``where``'s words."""
    return template.format_map(WORDS[where if where in WORDS else MCP])


def propose_run(run_ids: Iterable[str], where: str) -> str:
    """How to propose a run of these canvas nodes, in ``where``'s words:
    "propose_change (run: n2, n3)" or `nebula propose --note "<why>" --run n2
    --run n3`."""
    ids = list(run_ids) or ["<node id>"]
    if where == CLI:
        return "`nebula propose --note \"<why>\" " + " ".join(f"--run {node}" for node in ids) + "`"
    return f"propose_change (run: {', '.join(ids)})"


def cli_words(text: str) -> str:
    """MCP-worded data in CLI words, for the CLI to print: each tool name a
    whole word not already beside a `nebula` command, and a propose_run
    hint with its nodes."""
    text = _PROPOSE_RUN.sub(lambda match: propose_run(match.group(1).split(", "), CLI), text)
    return _TOOL.sub(lambda match: _CLI_FOR_TOOL[match.group(1)], text)
