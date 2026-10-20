"""scripts/count_agent_turns.py counts orientation turns as GM did (plan v2.7, PR26, §5.10.1).

One fixture per class, and GM's headless run rebuilt from its table
(docs/agent-runs/2026-10-20-cli-headless.md), which must give 8 of 16.
"""
from __future__ import annotations

import importlib.util
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "count_agent_turns.py"


def _load():
    spec = importlib.util.spec_from_file_location("count_agent_turns", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses look their module up there
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


@pytest.fixture(scope="module")
def counter():
    return _load()


class Transcript:
    """stream-json events as `claude -p --output-format stream-json --verbose` writes them."""

    def __init__(self) -> None:
        self.events: list[dict] = [{"type": "system", "subtype": "init", "tools": ["Bash"]}]
        self._n = 0

    def _id(self) -> str:
        self._n += 1
        return f"msg_{self._n:02d}"

    def call(self, command: str | None = None, result: str = "ok", *, error: bool = False, tool: str = "Bash",
             tool_input: dict | None = None, text: str | None = None) -> "Transcript":
        message_id = self._id()
        tool_use_id = f"toolu_{self._n:02d}"
        if text:
            # Claude Code writes one assistant event per content block, same message id.
            self.events.append({"type": "assistant", "message": {"id": message_id, "role": "assistant",
                                "content": [{"type": "text", "text": text}]}})
        self.events.append({"type": "assistant", "message": {"id": message_id, "role": "assistant", "content": [
            {"type": "tool_use", "id": tool_use_id, "name": tool,
             "input": tool_input if tool_input is not None else {"command": command}}]}})
        self.events.append({"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool_use_id, "content": result, "is_error": error}]}})
        return self

    def calls(self, *commands: str) -> "Transcript":
        """Several tool calls in one turn."""
        message_id = self._id()
        for position, command in enumerate(commands):
            tool_use_id = f"toolu_{self._n:02d}_{position}"
            self.events.append({"type": "assistant", "message": {"id": message_id, "content": [
                {"type": "tool_use", "id": tool_use_id, "name": "Bash", "input": {"command": command}}]}})
            self.events.append({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": tool_use_id, "content": [{"type": "text", "text": "ok"}]}]}})
        return self

    def reply(self, text: str) -> "Transcript":
        self.events.append({"type": "assistant", "message": {"id": self._id(), "content": [{"type": "text", "text": text}]}})
        return self

    def result(self, **fields) -> "Transcript":
        self.events.append({"type": "result", "subtype": "success", **fields})
        return self

    def lines(self) -> list[str]:
        return [json.dumps(event) for event in self.events]


def _kinds(report) -> list[str]:
    return [call["kind"] for row in report["rows"] for call in row["calls"]]


# -- one fixture per class -----------------------------------------------------

@pytest.mark.parametrize("command", ["nebula apply --help", "nebula propose -h", "nebula", "nebula --url http://x",
                                     "nebula --help", "cat skills/nebula/SKILL.md", "sed -n 1,40p docs/MCP-SETUP.md"])
def test_help_reads_are_orientation(counter, command):
    report = counter.count(Transcript().call(command).reply("done").lines())
    assert _kinds(report) == ["help"]
    assert report["orientation"] == 1 and report["turns"] == 2 and report["helpReads"] == 1


def test_reading_the_skill_or_docs_with_read_or_skill_is_help(counter):
    t = (Transcript().call(tool="Read", tool_input={"file_path": "/repo/skills/nebula/SKILL.md"})
         .call(tool="Skill", tool_input={"skill": "nebula"})
         .call(tool="Read", tool_input={"file_path": "/repo/backend/main.py"}))
    assert _kinds(counter.count(t.lines())) == ["help", "help", "needed"]


@pytest.mark.parametrize("command", ["nebula context", "nebula context --json", "nebula nodes", "nebula nodes preview",
                                     "nebula --url http://127.0.0.1:8787 info nano-banana", "nebula find upscale",
                                     "nebula describe nano-banana", "NEBULA_AGENT_NAME=x nebula nodes --category image",
                                     "/opt/bin/nebula info preview", "python -m nebula nodes"])
def test_node_lookups_are_orientation(counter, command):
    assert _kinds(counter.count(Transcript().call(command).lines())) == ["lookup"]


@pytest.mark.parametrize("tool", ["mcp__nebula__start_here", "mcp__nebula__find_nodes", "mcp__nebula__describe_node"])
def test_mcp_lookups_are_orientation(counter, tool):
    assert _kinds(counter.count(Transcript().call(tool=tool, tool_input={}).lines())) == ["lookup"]


@pytest.mark.parametrize("command,tool", [("nebula spend", "Bash"), ("nebula keys", "Bash"),
                                          (None, "mcp__nebula__get_spend_limits")])
def test_reading_limits_or_keys_is_orientation(counter, command, tool):
    t = Transcript().call(command, tool=tool, tool_input=None if command else {})
    assert _kinds(counter.count(t.lines())) == ["limits"]


@pytest.mark.parametrize("command,result", [
    ("nebula nodes preview", "Exit code 2\nusage: nebula [--url URL] <command> [options]\n"
                             "nebula: error: unrecognized arguments: preview"),
    ("nebula nodez", "Exit code 2\nusage: nebula [--url URL] <command> [options]\n"
                     "nebula: error: argument <command>: invalid choice: 'nodez'. Did you mean nodes?"),
    ("nebula moodboard show", "Exit code 2\nusage: nebula moodboard show [-h] id\n"
                              "nebula moodboard show: error: the following arguments are required: id"),
    ("nebula info moodboard", "Exit code 1\nNode 'moodboard' not found. Did you mean: nebula-moodboard"),
    ("nebula propose --note x --move n1=1,2", "Exit code 1\nerror: `nebula propose` doesn't take --move: ..."),
])
def test_usage_failures_are_orientation_whatever_they_meant(counter, command, result):
    report = counter.count(Transcript().call(command, result, error=True).lines())
    assert _kinds(report) == ["usage-error"] and report["usageErrors"] == 1 and report["orientation"] == 1


def test_mcp_argument_errors_are_usage_failures(counter):
    t = (Transcript()
         .call(tool="mcp__nebula__edit_canvas", tool_input={"bogus": 1}, error=True,
               result="Error executing tool edit_canvas: 1 validation error for edit_canvasArguments\nnodes\n  Field required")
         .call(tool="mcp__nebula__run_nodes", tool_input={}, error=True,
               result="<tool_use_error>InputValidationError: run_nodes failed due to the following issue: ..."))
    assert _kinds(counter.count(t.lines())) == ["usage-error", "usage-error"]


def test_a_failure_that_isnt_usage_stays_needed(counter):
    # The work failed (a provider error), not the way the agent called Nebula.
    t = Transcript().call("nebula run n2", "Exit code 1\nerror: run r1 failed: provider timed out", error=True)
    report = counter.count(t.lines())
    assert _kinds(report) == ["needed"] and report["orientation"] == 0


def test_the_guard_wrappers_refusal_is_needed_and_counted_apart(counter):
    t = Transcript().call("nebula propose --note x --add +g=nano-banana --wait",
                          "Exit code 2\nNot allowed in this demo: --wait. Propose, then tell the person.", error=True)
    report = counter.count(t.lines())
    assert _kinds(report) == ["refused"] and report["orientation"] == 0
    assert report["callsByKind"]["refused"] == 1


@pytest.mark.parametrize("command,tool", [
    ("nebula projects", "Bash"), ("nebula look", "Bash"), ("nebula selection", "Bash"), ("nebula pins", "Bash"),
    ("nebula moodboard list --project p1", "Bash"), ("nebula moodboard show mb1", "Bash"),
    ("nebula apply --add +p=text-input", "Bash"), ("nebula run n2", "Bash"), ("nebula propose --note x --add +g=x", "Bash"),
    ("nebula point n1 --say hi", "Bash"), ("nebula resolve pin_1 --reply ok", "Bash"),
    (None, "mcp__nebula__look_at_canvas"), (None, "mcp__nebula__moodboard_get"), (None, "mcp__nebula__edit_canvas"),
    (None, "mcp__nebula__propose_change"), (None, "mcp__nebula__point_at"), (None, "mcp__nebula__list_projects"),
])
def test_the_persons_work_is_needed(counter, command, tool):
    t = Transcript().call(command, tool=tool, tool_input=None if command else {})
    assert _kinds(counter.count(t.lines())) == ["needed"]


def test_a_turn_is_one_message_and_orientation_only_when_every_call_is(counter):
    t = (Transcript()
         .call("nebula context", text="Let me look first.")   # text + call, one message: one turn
         .calls("nebula info nano-banana", "nebula info preview")   # two lookups: orientation
         .calls("nebula info nano-banana", "nebula look")   # a lookup and a read of the canvas: needed
         .reply("Here it is."))
    report = counter.count(t.lines())
    assert report["turns"] == 4 and report["toolCalls"] == 4 + 1
    assert [row["kind"] for row in report["rows"]] == ["orientation (lookup)", "orientation (lookup)", "needed", "reply"]
    assert report["orientation"] == 2


def test_a_shell_line_is_orientation_only_when_all_of_it_is(counter):
    t = (Transcript().call("nebula nodes && nebula info preview")
         .call("nebula nodes | head -40")
         .call("nebula info preview; nebula run n2"))
    # A filter on the output (`| head`) doesn't change what the call was.
    assert _kinds(counter.count(t.lines())) == ["lookup", "lookup", "needed"]


def test_the_final_reply_is_a_needed_turn(counter):
    report = counter.count(Transcript().reply("Nothing to do.").lines())
    assert report["turns"] == 1 and report["orientation"] == 0 and report["rows"][0]["kind"] == "reply"


# -- GM's run ---------------------------------------------------------------------

def gm_run() -> Transcript:
    """GM's 15 calls and final reply, as docs/agent-runs/2026-10-20-cli-headless.md records them."""
    unrecognized = "Exit code 2\nusage: nebula [--url URL] <command> [options]\nnebula: error: unrecognized arguments: {}"
    return (Transcript()
            .call("nebula projects", text="I'll find your project first.")
            .call("nebula moodboard list --project p_gm")
            .call("nebula moodboard show mb_gm", "x" * 8319)
            .call("nebula apply --help")
            .call("nebula info moodboard", "Exit code 1\nNode 'moodboard' not found. Did you mean: krea-moodboard, "
                                           "nebula-moodboard, krea-moodboard-search, krea-moodboard-create", error=True)
            .call("nebula info nebula-moodboard")
            .call("nebula nodes preview", unrecognized.format("preview"), error=True)
            .call("nebula nodes", "y" * 20489)
            .call("nebula apply --add +mb=nebula-moodboard --param +mb.moodboard=mb_gm --add +pv=preview "
                  "--wire +mb:moodboard +pv:input --at +mb=0,0 --at +pv=450,0")
            .call("nebula run n2")
            .call("nebula point n1 --say \"Here's what your board gives\"")
            .call("nebula info gpt-image-2-generate")
            .call("nebula propose --note 'Hero: a quiet lake at dawn' --add +p=text-input "
                  "--param '+p.value=a quiet lake at dawn' --add +g=gpt-image-2-generate --wire +p:text +g:prompt "
                  "--rename '+g=Lake hero'", unrecognized.format("--rename +g=Lake hero"), error=True)
            .call("nebula propose --help")
            .call("nebula propose --note 'Hero: a quiet lake at dawn' --add +p=text-input "
                  "--param '+p.value=a quiet lake at dawn' --add +g=gpt-image-2-generate --wire +p:text +g:prompt")
            .reply("Here's what your board gives; the hero is waiting for your Accept.")
            .result(num_turns=16, duration_ms=38226, total_cost_usd=0.226))


GM_KINDS = ["needed", "needed", "needed", "help", "usage-error", "lookup", "usage-error", "lookup",
            "needed", "needed", "needed", "lookup", "usage-error", "help", "needed"]


def test_gm_run_gives_8_of_16(counter):
    report = counter.count(gm_run().lines())
    assert (report["orientation"], report["turns"]) == (8, 16)
    assert report["toolCalls"] == 15 and report["numTurns"] == 16 and "warning" not in report
    assert _kinds(report) == GM_KINDS
    # GM's breakdown: two help reads, three node lookups... and the usage errors among them.
    assert report["helpReads"] == 2 and report["usageErrors"] == 3
    assert report["callsByKind"]["lookup"] == 3


def test_the_script_prints_a_table_and_json(counter, tmp_path):
    path = tmp_path / "gm.jsonl"
    path.write_text("\n".join(gm_run().lines()) + "\n", encoding="utf-8")
    out = io.StringIO()
    with redirect_stdout(out):
        assert counter.main([str(path)]) == 0
    text = out.getvalue()
    assert "Orientation: 8 of 16 turns" in text and "nebula apply --help" in text and "[exit 2]" in text
    out = io.StringIO()
    with redirect_stdout(out):
        assert counter.main([str(path), "--json"]) == 0
    payload = json.loads(out.getvalue())
    assert payload["orientation"] == 8 and payload["turns"] == 16
    # Several runs: one block each, then the median and the range.
    out = io.StringIO()
    with redirect_stdout(out):
        assert counter.main([str(path), str(path), "--json"]) == 0
    summary = json.loads(out.getvalue())["summary"]
    assert summary["runs"] == 2 and summary["orientation"] == {"median": 8, "min": 8, "max": 8}


def test_a_turn_count_that_disagrees_with_the_result_is_flagged(counter):
    report = counter.count(Transcript().call("nebula look").reply("ok").result(num_turns=5).lines())
    assert "num_turns 5" in report["warning"]
