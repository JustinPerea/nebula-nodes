"""Big run outputs collapse to one line in `nebula run` and MCP's run result,
and `nebula context` tells "no tab", "a tab with an old view" and "watching"
apart (design)."""
from __future__ import annotations

import io
import json
from contextlib import redirect_stderr, redirect_stdout

from cli.commands import execute
from cli.formatter import format_run_results, format_start, tab_state_line


def _bundle(size_kb: int = 51) -> dict:
    # Padded so its JSON is just over size_kb KB.
    return {"kind": "nebula_moodboard", "styleBrief": "x" * (size_kb * 1024 - 60)}


def _results(value, port_type="Moodboard", port="moodboard") -> dict:
    return {"results": {"n3": {port: {"type": port_type, "value": value}}}, "duration": 1.5}


NAMES = {"n3": "Preview"}
LOOKUP = {"names": NAMES, "ports": {"n3": {"moodboard": "Moodboard", "images": "Images"}}}


def test_a_51_kb_bundle_prints_as_one_exact_line():
    text = format_run_results(_results(_bundle()), names=NAMES)
    assert text.splitlines()[0] == "“Preview” · moodboard bundle, 51 KB. Add --verbose to print it."
    assert len(text) < 200 and "styleBrief" not in text


def test_a_list_a_long_string_and_a_small_dict_collapse():
    listed = format_run_results(_results([f"/api/outputs/{i}.png" for i in range(12)], "Array", "images"),
                                names=NAMES)
    assert listed.splitlines()[0].startswith("“Preview” · list of 12, ")
    assert listed.splitlines()[0].endswith(" bytes. Add --verbose to print it.")
    long_text = format_run_results(_results("word " * 100, "Text", "text"), names=NAMES)
    assert long_text.splitlines()[0] == "“Preview” · text, 500 bytes. Add --verbose to print it."
    big_dict = format_run_results(_results({"a": "y" * 300}, "Any", "out"), names=NAMES)
    assert big_dict.splitlines()[0] == "“Preview” · object, 309 bytes. Add --verbose to print it."


def test_a_short_dict_and_a_short_list_print_whole():
    assert format_run_results(_results({"a": 1}, "Any", "out"), names=NAMES).splitlines()[0] == "n3: {'a': 1}"
    urls = ["/api/outputs/a.png", "/api/outputs/b.png"]
    assert format_run_results(_results(urls, "Array", "images"), names=NAMES).splitlines()[0] == f"n3: {urls}"


def test_a_list_collapses_one_character_past_200():
    def listed(extra: int) -> list:
        # JSON: ["x...x"] is 4 characters of brackets and quotes around the text.
        return ["x" * (196 + extra)]

    assert len(json.dumps(listed(0))) == 200 and len(json.dumps(listed(1))) == 201
    assert format_run_results(_results(listed(0), "Array", "images"), names=NAMES).splitlines()[0].startswith("n3: ")
    assert format_run_results(_results(listed(1), "Array", "images"), names=NAMES).splitlines()[0] == \
        "“Preview” · list of 1, 201 bytes. Add --verbose to print it."


def _two_ports(images_label="Images") -> tuple[dict, dict]:
    results = {"results": {"n3": {"images": {"type": "Array", "value": ["/api/outputs/" + "a" * 100 + ".png"] * 12},
                                  "openai_text": {"type": "Text", "value": "word " * 100}}}, "duration": 1}
    labels = {"n3": {"images": images_label, "openai_text": "OpenAI text"}}
    return results, labels


def test_two_big_ports_name_the_port_after_the_node():
    results, labels = _two_ports()
    lines = format_run_results(results, names=NAMES, port_labels=lambda: labels).splitlines()
    assert lines[0] == "“Preview”’s images · list of 12, 1 KB. Add --verbose to print it."
    # A provider name the label starts with keeps its capitals; the rest lower-cases.
    assert lines[1] == "“Preview”’s OpenAI text · text, 500 bytes. Add --verbose to print it."


def test_a_port_without_a_label_falls_back_to_its_id_in_words():
    results, _ = _two_ports()
    lines = format_run_results(results, names=NAMES, port_labels={}).splitlines()
    assert lines[0].startswith("“Preview”’s images · ") and lines[1].startswith("“Preview”’s openai text · ")


def test_one_big_port_keeps_designs_line_even_beside_a_short_one():
    results = {"results": {"n3": {"moodboard": {"type": "Moodboard", "value": _bundle()}}}, "duration": 1}
    text = format_run_results(results, names=NAMES, port_labels={"n3": {"moodboard": "Moodboard"}})
    assert text.splitlines()[0] == "“Preview” · moodboard bundle, 51 KB. Add --verbose to print it."


def test_a_short_value_and_a_node_without_a_name_print_as_before():
    assert format_run_results(_results("hello", "Text", "text")).splitlines()[0] == "n3: hello"
    assert format_run_results(_results("x" * 200, "Text", "text")).splitlines()[0] == "n3: " + "x" * 200
    assert format_run_results(_results(7, "Number", "n")).splitlines()[0] == "n3: 7"
    # No name known: the node's id stands in.
    assert format_run_results(_results(_bundle())).startswith("“n3” · moodboard bundle, 51 KB.")


def test_names_are_read_only_when_a_value_collapses():
    calls: list[int] = []

    def names() -> dict:
        calls.append(1)
        return NAMES

    format_run_results(_results("hello", "Text", "text"), names=names)
    assert calls == []
    format_run_results(_results(_bundle()), names=names)
    assert calls == [1]


def test_verbose_prints_the_value_whole():
    value = _bundle()
    text = format_run_results(_results(value), verbose=True, names=NAMES)
    assert text.splitlines()[0] == f"n3: {value}"


class _Client:
    def __init__(self, result):
        self.result = result

    def get_nodes(self):
        return {"nodes": [{"id": "nebula-moodboard", "displayName": "Moodboard"}]}

    def get_graph(self):
        return {"nodes": [{"id": "n3", "definitionId": "nebula-moodboard", "label": "Preview"}]}

    def run_graph(self, target_node_id=None, wait=0):
        return self.result


def _run(result, **flags):
    out = io.StringIO()
    with redirect_stdout(out):
        code = execute.run_node(_Client(result), "n3", **flags)
    return code, out.getvalue()


def test_the_cli_run_names_the_node_as_the_canvas_does_and_verbose_and_json_switch_it():
    result = {"status": "finished", **_results(_bundle())}
    code, text = _run(result)
    assert code == 0 and text.splitlines()[0] == "“Preview” · moodboard bundle, 51 KB. Add --verbose to print it."
    code, text = _run(result, verbose=True)
    assert code == 0 and text.splitlines()[0].startswith("n3: {") and "styleBrief" in text
    code, text = _run(result, as_json=True)
    assert code == 0 and json.loads(text)["results"]["n3"]["moodboard"]["value"] == result["results"]["n3"]["moodboard"]["value"]


def test_json_keeps_each_exit_code():
    for result, code in (({"status": "running"}, 2), ({"status": "waiting", "proposalId": "p"}, 4),
                         ({"status": "failed", "error": "x"}, 1), ({"status": "cancelled"}, 3),
                         ({"status": "cancelled", "neverStarted": True}, 3), ({"status": "unknown", "noRecord": True}, 1),
                         ({"status": "finished"}, 0)):
        assert _run(result, as_json=True)[0] == code == _run_text_code(result)


def _run_text_code(result):
    out = io.StringIO()
    with redirect_stdout(out), redirect_stderr(io.StringIO()):
        return execute.run_node(_Client(result), "n3")


def test_mcp_summarises_a_big_dict_or_list_and_leaves_the_rest():
    import mcp_server

    big = {"moodboard": {"type": "Moodboard", "value": _bundle()},
           "images": {"type": "Array", "value": ["/api/outputs/" + "a" * 100 + ".png"] * 60},
           "small": {"type": "Any", "value": {"a": 1}},
           "text": {"type": "Text", "value": "t" * 5000}}
    out = mcp_server._brief_outputs(big, "n3", lambda: LOOKUP)
    # Four ports in this node: each collapsed line names its port.
    assert out["moodboard"]["value"] == "“Preview”’s moodboard · moodboard bundle, 51 KB. view_output shows it whole."
    assert out["images"]["value"].startswith("“Preview”’s images · list of 60, ") and "KB. view_output shows it whole." in out["images"]["value"]
    assert out["small"]["value"] == {"a": 1}
    assert out["text"]["value"].endswith("(5000 characters; view_output shows it all)")


def test_mcp_run_result_carries_the_summary(monkeypatch):
    import mcp_server

    monkeypatch.setattr(mcp_server, "_canvas_node_names", lambda ctx: LOOKUP)
    shown = json.loads(mcp_server._run_result(
        {"status": "finished", "runId": "r1", **_results(_bundle())}, None)[0])
    assert shown["outputs"]["n3"]["moodboard"]["value"] == "“Preview” · moodboard bundle, 51 KB. view_output shows it whole."


def test_the_run_docstrings_say_so():
    import mcp_server

    assert "view_output has it whole" in mcp_server.run_nodes.__doc__
    assert "view_output has it whole" in mcp_server.get_run.__doc__


# -- context: no tab / a tab with an old view / watching ----------------------------------------

NO_TAB = "No Nebula tab is open."
OLD_VIEW = "A tab is open, but its view is more than 30 s old."
WATCHING = "Watching: the canvas."


def _start(view) -> dict:
    return {"canvas": {"nodeCount": 1, "view": view}, "pins": {}, "proposals": {}, "boards": {},
            "nodes": {}, "spend": {}, "next": {}}


def test_context_prints_the_three_states():
    assert tab_state_line({"connected": False, "stale": True}) == NO_TAB
    assert tab_state_line({"connected": False, "stale": False}) == NO_TAB
    assert tab_state_line({"connected": True, "stale": True}) == OLD_VIEW
    assert tab_state_line({"connected": True, "stale": False}) == WATCHING
    for view, line in (({"connected": False, "stale": True}, NO_TAB), ({"connected": True, "stale": True}, OLD_VIEW),
                       ({"connected": True, "stale": False}, WATCHING)):
        assert f"CANVAS: no project open, 1 node\n  {line}\n" in format_start(_start(view))


def test_a_payload_without_connected_reads_as_before():
    assert tab_state_line({"stale": True}) == NO_TAB and tab_state_line({"stale": False}) == WATCHING
    assert tab_state_line(None) == NO_TAB


def test_the_canvas_part_carries_connected_beside_stale():
    from services import agent_start

    for view, want in (({"stale": True, "connected": True}, {"stale": True, "connected": True}),
                       ({"stale": False, "connected": True}, {"stale": False, "connected": True}),
                       ({"stale": True, "connected": False}, {"stale": True, "connected": False}),
                       ({"stale": False}, {"stale": False, "connected": True}), ({}, {"stale": True, "connected": False})):
        part = agent_start.canvas_part({"view": view, "nodes": [], "selection": []}, project=None, caller_id=None, via="cli")
        assert part["view"] == want


def test_the_snapshot_view_line_names_the_state():
    from cli.formatter import format_snapshot

    base = {"reported": True, "secondsAgo": 40.0, "stale": True, "viewport": {"zoom": 1.0}, "visibleArea": None}
    gone = format_snapshot({"view": {**base, "connected": False}})
    old = format_snapshot({"view": {**base, "connected": True}})
    assert "(reported 40.0s ago). " + NO_TAB in gone and "STALE" not in gone
    assert "(reported 40.0s ago). " + OLD_VIEW in old


def test_watching_says_what_the_view_shows():
    def watching(on_screen, count):
        return tab_state_line({"connected": True, "stale": False, "onScreen": on_screen}, count)

    assert watching(6, 14) == "Watching: 6 of 14 nodes on screen."
    assert watching(14, 14) == "Watching: all 14 nodes on screen."
    assert watching(1, 1) == "Watching: the one node on screen."
    assert watching(0, 14) == "Watching: none of the 14 nodes on screen."
    assert watching(0, 0) == "Watching: an empty canvas."
    # Connected and fresh, but no visible area reported: no count.
    assert tab_state_line({"connected": True, "stale": False}, 14) == "Watching: the canvas."
    assert tab_state_line({"connected": True, "stale": False}, 0) == "Watching: an empty canvas."
    # The other two states are unchanged by a count.
    assert tab_state_line({"connected": False, "stale": True, "onScreen": 3}, 14) == NO_TAB
    assert tab_state_line({"connected": True, "stale": True, "onScreen": 3}, 14) == OLD_VIEW


def test_format_start_prints_the_watching_forms_from_a_payload():
    start = {"canvas": {"nodeCount": 14, "view": {"connected": True, "stale": False, "onScreen": 6}}, "pins": {},
             "proposals": {}, "boards": {}, "nodes": {}, "spend": {}, "next": {}}
    assert "  Watching: 6 of 14 nodes on screen.\n" in format_start(start)
    start["canvas"]["nodeCount"] = 0
    assert "  Watching: an empty canvas.\n" in format_start(start)


def test_the_canvas_part_sends_on_screen_only_when_the_visible_area_is_known():
    from services import agent_start

    nodes = [{"id": f"n{i}", "name": f"N{i}", "onScreen": i < 2} for i in range(5)]
    known = agent_start.canvas_part({"view": {"stale": False, "connected": True, "visibleArea": {"x": 0, "y": 0, "width": 9, "height": 9}},
                                     "nodes": nodes, "nodeCount": 5, "selection": []}, project=None, caller_id=None, via="cli")
    assert known["view"] == {"stale": False, "connected": True, "onScreen": 2}
    unknown = agent_start.canvas_part({"view": {"stale": False, "connected": True, "visibleArea": None},
                                       "nodes": [{"id": "n0", "name": "N0"}], "nodeCount": 1, "selection": []},
                                      project=None, caller_id=None, via="cli")
    assert unknown["view"] == {"stale": False, "connected": True}
    none_on = agent_start.canvas_part({"view": {"stale": False, "connected": True, "visibleArea": {"x": 0}},
                                       "nodes": [{"id": "n0", "name": "N0", "onScreen": False}], "nodeCount": 1,
                                       "selection": []}, project=None, caller_id=None, via="cli")
    assert none_on["view"]["onScreen"] == 0
