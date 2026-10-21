"""`nebula nodes` is find_nodes' twin: what runs here, with prices.

In the Q104 rerun (docs/agent-runs/2026-10-20-pr26-first-turn-measurement.md,
run B3) a CLI agent browsed `nebula nodes --category image-gen`, which listed
all 78 image node types with no sign of which could run, and proposed
FLUX.2 [pro] with no BFL or fal key set. MCP's find_nodes (GET
/api/agent/nodes) already answered "what runs here, at what price"; the CLI
now reads the same route: by default only node types that run here, with
how and at what list price, and a line saying how many more need a key;
`--all` lists the rest with what each is missing; `--json` prints the
route's answer as find_nodes returns it.
"""
from __future__ import annotations

import json
import re

import pytest

import mcp_server
from nebula_api import NebulaAPI
from tests.test_first_turn_cli import START_LINE, _run, cli  # noqa: F401  (the fixture)

FAKE_OPENAI = "test-openai-not-a-key"
ROW = re.compile(r"^  ([a-z0-9][a-z0-9.-]*)\s{2,}", flags=re.M)


class _Krea:
    def status(self):
        return {"status": "disconnected"}


@pytest.fixture
def keys(cli, monkeypatch):  # noqa: F811
    """Only an OpenAI key set, no Krea sign-in; MCP's find_nodes on the same app."""
    main = cli.main
    real = main.load_settings
    api_keys: dict[str, str] = {"OPENAI_API_KEY": FAKE_OPENAI}
    monkeypatch.setattr(main, "load_settings", lambda: {**real(), "apiKeys": dict(api_keys)})
    monkeypatch.setattr(main, "_krea_connector", lambda: _Krea())
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=cli.http))
    return api_keys


def _rows(out: str) -> dict[str, str]:
    """Each listed node id -> its whole table line."""
    return {match.group(1): line for line in out.splitlines() if (match := ROW.match(line))}


def test_by_default_only_node_types_that_run_here_are_listed(keys):
    code, out, err = _run(["nodes", "--category", "image"])
    assert code == 0, err
    assert out.splitlines()[0] == START_LINE
    rows = _rows(out)
    assert "gpt-image-2-generate" in rows and "gpt-image-2-edit" in rows
    assert "flux-2-pro" not in rows and "nano-banana" not in rows
    # Every row runs here: how, and its list price at default settings.
    assert re.search(r"\bkey\b", rows["gpt-image-2-generate"])
    assert re.search(r"\$\d", rows["gpt-image-2-generate"])
    # The last line says how many were left out and how to see them.
    hidden = mcp_server.find_nodes(category="image", ready_only=False, limit=100)["total"] \
        - mcp_server.find_nodes(category="image", limit=100)["total"]
    assert hidden > 0
    last = out.rstrip().splitlines()[-1]
    assert last.startswith(f"{hidden} more need a key"), last
    assert "`nebula nodes --category image --all`" in last


def test_all_lists_the_rest_marked_with_what_is_missing(keys):
    code, out, err = _run(["nodes", "--category", "image", "--all"])
    assert code == 0, err
    rows = _rows(out)
    assert "gpt-image-2-generate" in rows and "flux-2-pro" in rows
    flux = next(row for row in mcp_server.find_nodes(query="flux-2-pro", ready_only=False)["nodes"]
                if row["id"] == "flux-2-pro")
    assert "BFL_API_KEY" in flux["missing"] and "FAL_KEY" in flux["missing"]
    assert flux["missing"] in rows["flux-2-pro"]
    assert "more need a key" not in out
    # Ready ones first in their category, as find_nodes ranks them.
    ids = list(rows)
    assert ids.index("gpt-image-2-generate") < ids.index("flux-2-pro")


@pytest.mark.parametrize("argv", [["nodes"], ["nodes", "--all"], ["nodes", "--category", "utility"]])
def test_free_nodes_always_show_as_free(keys, argv):
    code, out, err = _run(argv)
    assert code == 0, err
    rows = _rows(out)
    for node_id in ("preview", "text-input"):
        assert node_id in rows, (node_id, out[:500])
        assert re.search(r"\bfree\s+free\b", rows[node_id]), rows[node_id]
    if argv != ["nodes", "--category", "utility"]:
        assert re.search(r"\bfree\s+free\b", rows["nebula-moodboard"]), rows["nebula-moodboard"]


def test_free_nodes_show_with_no_key_at_all(keys):
    keys.clear()
    code, out, err = _run(["nodes", "moodboard"])
    assert code == 0, err
    assert re.search(r"\bfree\s+free\b", _rows(out)["nebula-moodboard"])


def test_words_still_filter_and_filter_and_query_mean_the_same(keys):
    code, out, err = _run(["nodes", "gpt", "image"])
    assert code == 0, err
    rows = _rows(out)
    assert rows and "gpt-image-2-generate" in rows
    found = {row["id"]: row for row in mcp_server.find_nodes(query="gpt image", limit=100)["nodes"]}
    assert set(rows) == set(found)
    assert _run(["nodes", "--filter", "gpt image"])[1] == out
    assert _run(["nodes", "--query", "gpt image"])[1] == out
    # A search with nothing that runs here says so, and how to see the rest.
    code, out, err = _run(["nodes", "flux", "2", "pro"])
    assert code == 0, err
    assert not _rows(out)
    assert "runs here" in out and "`nebula nodes flux 2 pro --all`" in out
    assert "No nodes match" not in out


@pytest.mark.parametrize("argv, kwargs", [
    (["--category", "image"], {"category": "image", "limit": 100}),
    (["--category", "image", "--limit", "5"], {"category": "image", "limit": 5}),
    (["upscale", "--all", "--limit", "20"], {"query": "upscale", "ready_only": False, "limit": 20}),
    (["gpt", "image", "--all"], {"query": "gpt image", "ready_only": False, "limit": 100}),
])
def test_json_is_find_nodes_answer_for_the_same_arguments(keys, argv, kwargs):
    code, out, err = _run(["nodes", *argv, "--json"])
    assert code == 0, err
    printed = json.loads(out)
    expected = mcp_server.find_nodes(**kwargs)
    assert expected["total"] <= kwargs["limit"] or kwargs["limit"] < 100
    assert printed == expected


def test_json_without_a_limit_has_every_match(keys):
    code, out, err = _run(["nodes", "--all", "--json"])
    assert code == 0, err
    printed = json.loads(out)
    assert printed["total"] > 100 and len(printed["nodes"]) == printed["total"]


def test_a_limit_cuts_the_table_and_says_so(keys):
    code, out, err = _run(["nodes", "--category", "image", "--all", "--limit", "3"])
    assert code == 0, err
    assert len(_rows(out)) == 3
    total = mcp_server.find_nodes(category="image", ready_only=False, limit=100)["total"]
    assert f"3 of {total}" in out


@pytest.mark.parametrize("argv", [["upscale"], ["--category", "image"], ["--category", "image", "--all"],
                                  ["upscale", "--json"]])
def test_find_gives_the_same_output(keys, argv):
    assert _run(["find", *argv]) == _run(["nodes", *argv])


def test_help_says_what_nodes_shows_and_that_all_lists_the_rest(keys):
    code, out, _ = _run(["--help"])
    line = next(line for line in out.splitlines() if line.strip().startswith("nodes"))
    assert "run here" in line
    code, out, _ = _run(["nodes", "--help"])
    assert "--all" in out and "--json" in out and "--limit" in out
    assert "find_nodes" in out


def test_context_says_nodes_lists_them_and_all_the_rest(keys):
    code, out, err = _run(["context"])
    assert code == 0, err
    nodes_part = out[out.index("NODES THAT RUN HERE"):out.index("SPEND")]
    assert "`nebula nodes --all`" in nodes_part


def test_the_cli_asks_for_no_more_than_the_route_gives():
    import main
    from cli.client import NebulaClient

    assert NebulaClient.ALL_NODES == main.AGENT_NODES_MAX
    assert main.AGENT_NODES_MAX >= len(main.node_registry.get_all())


def test_docs_send_cli_agents_to_nebula_nodes_for_a_node_that_runs_here():
    """After a failed run or a propose warning, the skill and MCP-SETUP name
    `nebula nodes` (find_nodes' twin), not `nebula context`, whose node list
    is cut at a budget and can't be narrowed."""
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    skill = " ".join((repo / "skills" / "nebula" / "SKILL.md").read_text().split())
    setup = " ".join((repo / "docs" / "MCP-SETUP.md").read_text().split())
    assert "pick a node `nebula nodes` lists" in skill
    assert "propose a node that runs here instead (`nebula nodes` lists them)" in skill
    assert "`nebula context` lists them" not in skill
    assert "pick a node `nebula context` lists" not in skill
    assert "`find_nodes` for MCP, `nebula nodes` for the CLI" in setup
