"""Agent support for questions (Q125 item 1): MCP, the `nebula` CLI, docs and
every list propose_change is in.

Justin's standing rule: every feature ships its agent tools in the same PR.
Asking is the agent's (ask_person, `nebula ask`); answering and dismissing
are the person's only, so agents get a read (get_answers, `nebula answers`)
and their own withdraw, and no surface can answer for the person.
"""
from __future__ import annotations

import argparse
import inspect
import io
import json
import re
from pathlib import Path

import pytest

import mcp_server
from nebula_api import NebulaAPI, NebulaAPIError
from services import krea_agent_mcp
from services.agent_questions import CAP_LINE, MAX_OPEN_PER_AGENT
from tests.conftest import PERSON
from tests.test_agent_questions import GOOD_ANSWERS, SECRET_ANSWER, TWO, _answer, _key, asked  # noqa: F401
from tests.test_canvas_proposals import CLAUDE, KEY, api  # noqa: F401 - fixtures

REPO = Path(__file__).resolve().parents[2]
TOOLS = ("ask_person", "get_answers", "withdraw_questions")


@pytest.fixture
def tools(asked, monkeypatch):  # noqa: F811 - the imported fixture
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=asked.client))
    return asked


def _registered():
    return {tool.name: tool for tool in mcp_server.mcp._tool_manager.list_tools()}


# -- MCP ----------------------------------------------------------------------------

def test_the_three_tools_are_registered_listed_and_annotated():
    registered = _registered()
    for name in TOOLS:
        assert name in registered, name
        assert name in krea_agent_mcp.NEBULA_MCP_TOOLS, name
    assert registered["get_answers"].annotations.readOnlyHint is True
    ask = registered["ask_person"].annotations
    assert ask.readOnlyHint is False and ask.destructiveHint is False and ask.openWorldHint is False
    assert registered["withdraw_questions"].annotations.destructiveHint is True
    # Nothing an agent holds answers or dismisses for the person.
    assert not [name for name in registered if re.search(r"answer|dismiss", name) and name != "get_answers"]


def test_the_instructions_name_the_tools_and_when_to_ask():
    text = mcp_server.INSTRUCTIONS
    assert "ask_person" in text and "get_answers" in text
    assert len(text) <= 3000
    ask = inspect.getdoc(mcp_server.ask_person)
    # When to ask, against the other two ways to reach the person.
    assert "only the person can make" in ask
    assert "propose_change" in ask and "post_note" in ask
    assert "not to announce" in ask
    assert "get_answers" in ask and "withdraw_questions" in ask


def test_ask_answer_and_read_over_mcp(tools):
    made = mcp_server.ask_person(
        questions=[{"text": "Which crop for the hero?", "options": ["Square", "Wide", "Tall"]},
                   {"text": "Anything to avoid?", "allow_text": True}],
        note="Picking the hero crop")
    view = made["questions"]
    assert view["status"] == "open" and len(view["questions"]) == 2

    waiting = mcp_server.get_answers(view["id"], wait_seconds=0.3)
    assert waiting["questions"]["status"] == "open" and waiting["timedOut"] is True

    assert _answer(tools, view["id"], GOOD_ANSWERS).status_code == 200
    done = mcp_server.get_answers(view["id"], wait_seconds=5)
    assert done["questions"]["status"] == "answered" and "timedOut" not in done
    assert done["questions"]["answers"][1] == {"questionId": "q2", "answered": True, "choices": [],
                                               "text": SECRET_ANSWER}


def test_mcp_ask_maps_its_own_argument_names(tools):
    n1 = tools.graph.add_node("text-input", {"value": "a cat"})
    made = mcp_server.ask_person(
        questions=[{"text": "Moods?", "options": ["Calm", "Loud"], "multiple": True, "allow_text": False}],
        node_ids=[n1, "n404"])
    question = made["questions"]["questions"][0]
    assert question["multiple"] is True and question["allowText"] is False
    assert made["questions"]["nodeIds"] == [n1] and made["dropped"] == ["n404"]


def test_mcp_withdraw_and_the_cap_say_the_mcp_call(tools):
    ids = [mcp_server.ask_person(questions=[{"text": f"Question {i}?"}])["questions"]["id"]
           for i in range(MAX_OPEN_PER_AGENT)]
    with pytest.raises(NebulaAPIError) as refused:
        mcp_server.ask_person(questions=[{"text": "One more?"}])
    assert refused.value.status == 429
    assert refused.value.detail.startswith(CAP_LINE)
    assert f'withdraw_questions(question_id="{ids[0]}")' in refused.value.detail
    assert "DELETE /api" not in refused.value.detail
    withdrawn = mcp_server.withdraw_questions(ids[0])
    assert withdrawn["questions"]["status"] == "withdrawn"
    assert mcp_server.ask_person(questions=[{"text": "Now?"}])["questions"]["status"] == "open"


def test_another_agent_cannot_read_or_withdraw_over_mcp(tools, monkeypatch):
    view = mcp_server.ask_person(questions=[{"text": "Crop?"}])["questions"]
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    for call in (lambda: mcp_server.get_answers(view["id"]), lambda: mcp_server.withdraw_questions(view["id"])):
        with pytest.raises(NebulaAPIError) as refused:
            call()
        assert refused.value.status == 404


def test_an_agent_cannot_answer_by_any_route_it_holds(tools):
    """The answer routes refuse every agent marker, and the key never reaches an agent."""
    made = mcp_server.ask_person(questions=[{"text": "Crop?"}])
    view = made["questions"]
    key = _key(tools, view["id"])
    assert key not in json.dumps(made)
    assert key not in json.dumps(mcp_server.get_answers(view["id"]))
    api = NebulaAPI("http://testserver", client=tools.client)
    for route in ("answer", "dismiss"):
        with pytest.raises(NebulaAPIError) as refused:
            # As the MCP server sends it, even holding the person token and the key.
            api.request("POST", f"/api/canvas/questions/{view['id']}/{route}",
                        headers={**PERSON, "X-Nebula-Agent": "Claude Code", KEY: key},
                        json={"answers": [{"questionId": "q1", "text": "yes"}]})
        assert refused.value.status == 403
    assert tools.questions.get(view["id"]).is_open


# -- the CLI ------------------------------------------------------------------------

def _cli_client(asked):
    from cli.client import NebulaClient

    client = NebulaClient("http://testserver")
    client._client = asked.client
    return client


def _parse(argv: list[str]) -> argparse.Namespace:
    from cli.__main__ import build_parser

    return build_parser().parse_args(argv)


def test_cli_parses_questions_in_order():
    args = _parse(["ask", "--question", "Which crop?", "--option", "Square", "--option", "Wide",
                   "--question", "Moods?", "--option", "Calm", "--option", "Loud", "--multiple", "--no-text",
                   "--question", "Anything else?", "--note", "Hero crop", "--node", "n1", "--as", "Codex"])
    from cli.commands import questions as questions_cmd

    body = questions_cmd.body_from_args(args)
    assert body == {
        "questions": [
            {"text": "Which crop?", "options": ["Square", "Wide"]},
            {"text": "Moods?", "options": ["Calm", "Loud"], "multiple": True, "allowText": False},
            {"text": "Anything else?"},
        ],
        "note": "Hero crop",
        "nodeIds": ["n1"],
    }


def test_cli_option_before_a_question_is_refused():
    with pytest.raises(SystemExit):
        _parse(["ask", "--option", "Square"])


def test_cli_ask_then_answers_wait(asked, monkeypatch):
    from cli.commands import questions as questions_cmd

    client = _cli_client(asked)
    out = io.StringIO()
    args = _parse(["ask", "--question", "Which crop for the hero?", "--option", "Square", "--option", "Wide",
                   "--option", "Tall", "--question", "Anything to avoid?", "--as", "Claude Code", "--json"])
    assert questions_cmd.run_ask(client, args, out=out) == 0
    set_id = json.loads(out.getvalue())["questions"]["id"]
    assert _answer(asked, set_id, GOOD_ANSWERS).status_code == 200

    out = io.StringIO()
    code = questions_cmd.run_answers(client, _parse(["answers", set_id, "--wait", "5", "--as", "Claude Code"]), out=out)
    assert code == 0
    text = out.getvalue()
    assert "Which crop for the hero?" in text and "Wide" in text and SECRET_ANSWER in text


def test_cli_answers_exit_codes(asked):
    from cli.commands import questions as questions_cmd

    client = _cli_client(asked)
    set_id = asked.client.post("/api/canvas/questions", headers=CLAUDE, json=TWO).json()["questions"]["id"]
    out = io.StringIO()
    args = _parse(["answers", set_id, "--wait", "0.2", "--as", "Claude Code"])
    assert questions_cmd.run_answers(client, args, out=out) == questions_cmd.EXIT_TIMEOUT
    assert f"nebula answers {set_id} --wait" in out.getvalue()
    key = _key(asked, set_id)
    asked.client.post(f"/api/canvas/questions/{set_id}/dismiss", headers={**PERSON, KEY: key})
    out = io.StringIO()
    assert questions_cmd.run_answers(client, _parse(["answers", set_id, "--as", "Claude Code"]), out=out) == 0
    out = io.StringIO()
    assert questions_cmd.run_answers(client, args, out=out) == questions_cmd.EXIT_DISMISSED
    assert "dismissed" in out.getvalue().lower()


def test_cli_withdraw_and_the_cap_say_the_cli_call(asked, capsys):
    from cli.commands import questions as questions_cmd

    client = _cli_client(asked)
    ids = []
    for index in range(MAX_OPEN_PER_AGENT):
        out = io.StringIO()
        args = _parse(["ask", "--question", f"Question {index}?", "--as", "Codex", "--json"])
        assert questions_cmd.run_ask(client, args, out=out) == 0
        ids.append(json.loads(out.getvalue())["questions"]["id"])
    code = questions_cmd.run_ask(client, _parse(["ask", "--question", "More?", "--as", "Codex"]), out=io.StringIO())
    assert code == 1
    err = capsys.readouterr().err
    assert CAP_LINE in err
    assert f"nebula questions withdraw {ids[0]} --as Codex" in err
    out = io.StringIO()
    assert questions_cmd.run_questions(client, _parse(["questions", "withdraw", ids[0], "--as", "Codex"]), out=out) == 0
    assert f"Withdrew {ids[0]}." in out.getvalue()


def test_the_cli_has_no_answer_or_dismiss_command():
    from cli.__main__ import build_parser

    parser = build_parser()
    choices = next(action.choices for action in parser._actions if isinstance(action, argparse._SubParsersAction))  # noqa: SLF001
    assert {"ask", "answers", "questions"} <= set(choices)
    for argv in (["questions", "answer", "qs_1"], ["questions", "dismiss", "qs_1"]):
        with pytest.raises(SystemExit):
            parser.parse_args(argv)


# -- every list and doc that names propose_change for agents ------------------------

def test_in_app_guidance_and_start_here_name_ask_person():
    from services import agent_start
    from services.chat_session import NEBULA_MCP_PRIMER

    assert "ask_person" in NEBULA_MCP_PRIMER and "get_answers" in NEBULA_MCP_PRIMER
    # `nebula context` names it for CLI agents. start_here's `next` part has no
    # room left under its budget (test_agent_start); MCP agents get the
    # INSTRUCTIONS line on every connection instead.
    assert "`nebula ask`" in agent_start.HINTS["cli"]["propose"]
    assert "ask_person" in mcp_server.INSTRUCTIONS


def test_the_docs_cover_the_tools_and_the_cli():
    setup = (REPO / "docs/MCP-SETUP.md").read_text(encoding="utf-8")
    skill = (REPO / "skills/nebula/SKILL.md").read_text(encoding="utf-8")
    for name in (*TOOLS, "nebula ask", "nebula answers", "nebula questions withdraw"):
        assert name in setup, name
        assert name in skill, name
    assert "Closed when Nebula restarted." in setup


def test_the_docs_tie_the_answers_exit_codes_to_wait():
    # `nebula answers` without --wait prints the set and exits 0 whatever its
    # status (as `nebula proposal <id>` does); only --wait exits 2/3/4. A doc
    # that lists the codes unconditionally invites `nebula answers qs_x && ...`
    # on a set nobody answered.
    setup = (REPO / "docs/MCP-SETUP.md").read_text(encoding="utf-8")
    skill = (REPO / "skills/nebula/SKILL.md").read_text(encoding="utf-8")
    for name, text in (("MCP-SETUP.md", setup), ("SKILL.md", skill)):
        flat = " ".join(text.split())
        spots = [m.start() for m in re.finditer(r"3 dismissed, 4 withdrawn", flat)]
        assert spots, name
        for at in spots:
            around = flat[max(0, at - 120): at + 120]
            assert "with --wait" in around.lower() or "--wait N` exits" in around, (name, around)
            assert "without --wait" in around and "0" in around.split("without --wait", 1)[1][:40], (name, around)
