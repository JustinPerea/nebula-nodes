"""Agent-facing text says "session", never "lane" (design).

"Lane" is how the studio organises its own work, not a Nebula word. Agents read
Nebula's MCP tool docs, the CLI's help, the nebula skill and the MCP setup doc,
so none of them may carry the whole word. The comment-level check lives in
frontend/scripts/check-internal-ids.mjs (strings, titles and docstrings, never a
comment); this file reads the built text itself.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import mcp_channel
import mcp_server
from cli import __main__ as cli

REPO = Path(__file__).resolve().parent.parent.parent
LANE = re.compile(r"\blanes?\b", re.IGNORECASE)


def _walk_parser(parser: argparse.ArgumentParser, path: str = "nebula"):
    """(where, text) for every help, description and epilog in the parser tree."""
    for field in ("description", "epilog", "usage"):
        text = getattr(parser, field, None)
        if text:
            yield f"{path} {field}", text
    for action in parser._actions:
        if action.help and action.help is not argparse.SUPPRESS:
            yield f"{path} --{action.dest}", str(action.help)
        if isinstance(action, argparse._SubParsersAction):
            helps = {choice.dest: choice.help for choice in action._choices_actions}
            for name, sub in action.choices.items():
                if helps.get(name):
                    yield f"{path} {name} help", helps[name]
                yield from _walk_parser(sub, f"{path} {name}")


def _param_specs(params: dict):
    """(where, spec) for every parameter schema: top-level and nested properties, and $defs."""
    def walk(schema, where):
        if not isinstance(schema, dict):
            return
        for name, spec in (schema.get("properties") or {}).items():
            yield f"{where}{name}", spec
            yield from walk(spec, f"{where}{name}.")
        for name, spec in (schema.get("$defs") or {}).items():
            yield f"{where}$defs.{name}", spec
            yield from walk(spec, f"{where}$defs.{name}.")
        for key in ("items",):
            yield from walk(schema.get(key), where)
    yield from walk(params, "")


def _lane_hits(texts):
    return [where for where, text in texts if LANE.search(text)]


def test_the_checker_itself_catches_lane_and_lets_other_words_through():
    assert LANE.search("give each Lane its own cursor")
    assert LANE.search("two lanes of one agent")
    assert not LANE.search("a plane, laneway and Elaney")
    assert _lane_hits([("a", "fine"), ("b", "per lane")]) == ["b"]
    nested = {"properties": {"a": {"description": "x", "properties": {"b": {"description": "y"}}}},
              "$defs": {"D": {"description": "z", "properties": {"c": {"description": "w"}}}}}
    assert [w for w, _ in _param_specs(nested)] == ["a", "a.b", "$defs.D", "$defs.D.c"]


def test_no_mcp_tool_doc_says_lane():
    tools = mcp_server.mcp._tool_manager.list_tools()
    assert len(tools) > 50  # the registry is really read
    texts = [(f"tool {t.name}", t.description or "") for t in tools]
    for t in tools:
        # Today no tool's parameter schema (top-level, nested or $defs) carries a description, so
        # this loop finds no text; it stays so a described parameter is checked the day one appears.
        params = t.parameters or {}
        for where, spec in _param_specs(params):
            texts.append((f"tool {t.name}({where})", str(spec.get("description", ""))))
    # What the server serves, not the INSTRUCTIONS constant alone: it adds the Commons guide.
    texts += [("mcp_server.mcp.instructions", mcp_server.mcp.instructions or ""), ("mcp_channel.INSTRUCTIONS", mcp_channel.INSTRUCTIONS)]
    assert _lane_hits(texts) == []


def test_no_cli_help_description_or_epilog_says_lane():
    texts = list(_walk_parser(cli.build_parser()))
    assert len(texts) > 50  # the parser tree is really walked
    texts.append(("CURSOR_ENV_HELP", cli.CURSOR_ENV_HELP))
    assert _lane_hits(texts) == []


def _agent_read_docs():
    """Every skill file an agent can read (the Codex runner puts .agents/skills into the in-app
    agent's prompt) and the MCP setup doc."""
    paths = sorted(REPO.glob("skills/**/*.md")) + sorted(REPO.glob(".agents/skills/**/*.md"))
    return paths + [REPO / "docs/MCP-SETUP.md"]


def test_every_skill_file_and_the_mcp_setup_doc_never_say_lane():
    paths = _agent_read_docs()
    assert any(p.name == "SKILL.md" and ".agents" in p.parts for p in paths)  # the trees are really read
    assert REPO / "skills/nebula/SKILL.md" in paths
    for path in paths:
        text = path.read_text(encoding="utf-8")
        assert [n for n, line in enumerate(text.splitlines(), 1) if LANE.search(line)] == [], str(path.relative_to(REPO))


def test_point_at_and_the_cli_help_read_the_session_wording():
    doc = mcp_server.point_at.__doc__ or ""
    assert "to give each subagent its own" in doc
    assert "NEBULA_AGENT_SESSION" in doc

    assert "NEBULA_AGENT_SESSION=agent-a nebula point" in cli.CURSOR_ENV_HELP
    assert "subagent" in cli.CURSOR_ENV_HELP

    point = next(
        sub for action in cli.build_parser()._actions if isinstance(action, argparse._SubParsersAction)
        for name, sub in action.choices.items() if name == "point"
    )
    assert "give each subagent its own $NEBULA_AGENT_SESSION" in point.description

    for rel in ("skills/nebula/SKILL.md", "docs/MCP-SETUP.md"):
        text = (REPO / rel).read_text(encoding="utf-8")
        assert "NEBULA_AGENT_SESSION=agent-a nebula point" in text, rel
