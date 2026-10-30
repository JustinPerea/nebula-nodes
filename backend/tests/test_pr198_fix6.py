"""PR #198 fix round 6 (GM's pr198 r8 rulings): the stray shot-port lines.

GM's words, verbatim:
- "Removed the connection to shot port <port> on “Scene”, node n4. That shot
  no longer exists."
- Plural: "Removed 3 connections to shot ports on “Scene”, node n4. Those
  shots no longer exist."
- Load case: "while loading the project" before the period.
- The Agent log's overflow names the rest: "“A”, “B”, “C” and 4 more" (no
  serial comma).

Builder's reading, reported to GM: one line per node; <port> is the shot's id
(the port is ``shot_<id>``); several connections from one port keep "shot
port <port>" and "That shot"; a port dropped with no connection is listed in
``droppedPorts`` but has no line (nothing the person sees changed); a project
open is the load case, a graph-file import is not.
"""
from __future__ import annotations

import pytest

import main as main_module
from tests.conftest import PERSON
from tests.test_agent_presence import api  # noqa: F401 - fixture
from tests.test_params_version_gate import workspace  # noqa: F401 - fixture
from tests.test_pr198_fix5 import BASE, PAID, WIRE, _import, _rf_scene, _saved_project, _scene

AGENT = {"X-Nebula-Agent": "Codex"}


def test_one_connection_reads_gms_line():
    assert main_module.stray_shot_line("Scene", "n4", ["shot_s2"], 1) == (
        "Removed the connection to shot port s2 on “Scene”, node n4. That shot no longer exists.")


def test_several_connections_from_several_ports_read_gms_plural():
    assert main_module.stray_shot_line("Scene", "n4", ["shot_s2", "shot_s3"], 3) == (
        "Removed 3 connections to shot ports on “Scene”, node n4. Those shots no longer exist.")


def test_several_connections_from_one_port_name_it():
    assert main_module.stray_shot_line("Scene", "n4", ["shot_s2"], 2) == (
        "Removed 2 connections to shot port s2 on “Scene”, node n4. That shot no longer exists.")


def test_the_load_case_adds_while_loading_the_project():
    assert main_module.stray_shot_line("Scene", "n4", ["shot_s2"], 1, loading=True) == (
        "Removed the connection to shot port s2 on “Scene”, node n4 while loading the project. "
        "That shot no longer exists.")
    assert main_module.stray_shot_line("Scene", "n4", ["shot_s2", "shot_s3"], 3, loading=True) == (
        "Removed 3 connections to shot ports on “Scene”, node n4 while loading the project. "
        "Those shots no longer exist.")


def test_a_port_with_no_connection_has_no_line():
    assert main_module.stray_shot_line("Scene", "n4", ["shot_s2"], 0) is None


def test_the_agent_log_overflow_names_three_then_counts():
    assert main_module.quoted_overflow(["A", "B", "C", "D", "E", "F", "G"]) == "“A”, “B”, “C” and 4 more"
    assert main_module.quoted_overflow(["A", "B", "C"]) == "“A”, “B” and “C”"
    assert main_module.quoted_overflow(["A"]) == "“A”"


def test_the_report_is_one_line_per_node_with_its_id():
    reports = {
        "n4": {"name": "Scene", "dropped": ["shot_s2", "shot_s3"], "wires": {"shot_s2": 2, "shot_s3": 1}, "rekeyed": {}},
        "n5": {"name": "Next", "dropped": ["shot_s9"], "wires": {}, "rekeyed": {}},
        "n6": {"name": "Other", "dropped": [], "wires": {"shot_s1": 1}, "rekeyed": {}},
    }
    lines, records = main_module._stray_port_report(reports)
    assert lines == [
        "Removed 3 connections to shot ports on “Scene”, node n4. Those shots no longer exist.",
        "Removed the connection to shot port s1 on “Other”, node n6. That shot no longer exists.",
    ]
    assert records == [
        {"nodeId": "n4", "handle": "shot_s2", "port": True, "connections": 2},
        {"nodeId": "n4", "handle": "shot_s3", "port": True, "connections": 1},
        {"nodeId": "n5", "handle": "shot_s9", "port": True, "connections": 0},
        {"nodeId": "n6", "handle": "shot_s1", "port": False, "connections": 1},
    ]


def test_the_agent_log_says_up_to_five_lines_then_the_overflow():
    reports = {f"n{i}": {"name": f"Scene {i}", "dropped": ["shot_s2"], "wires": {"shot_s2": 1}, "rekeyed": {}}
               for i in range(1, 13)}
    said = main_module._stray_log_lines(reports, loading=True)
    assert said[:5] == [main_module.stray_shot_line(f"Scene {i}", f"n{i}", ["shot_s2"], 1, loading=True) for i in range(1, 6)]
    assert said[5:] == ["Removed 7 connections to shot ports on “Scene 6”, “Scene 7”, “Scene 8” and 4 more "
                        "while loading the project. Those shots no longer exist."]
    assert len(main_module._stray_log_lines(dict(list(reports.items())[:5]))) == 5


@pytest.mark.parametrize("who", ["person", "agent"])
def test_an_import_says_gms_line_with_the_new_node_id(api, person, who):  # noqa: F811
    client, _graph, sent = api
    sent.clear()
    reply = _import(client, {"person": PERSON, "agent": AGENT}[who], {"shots": [{"id": "S2", "prompt": "a"}]},
                    {"shot_s2": {"type": "Image", "value": PAID}}, "shot_s2")
    assert reply.status_code == 200, reply.text
    node_id = reply.json()["idMap"]["a"]
    line = f"Removed the connection to shot port s2 on “Opening”, node {node_id}. That shot no longer exists."
    assert reply.json()["warnings"] == [line]
    said = [event.get("say") for event in sent if event.get("type") == "agentPresence"]
    assert (line in said) is (who == "agent")


def test_a_project_open_is_the_load_case(workspace, person):  # noqa: F811
    opened = _saved_project(workspace, [
        _rf_scene("n1", "Opening", _scene("s1"), {"shot_s2": {"type": "Image", "value": PAID}}),
        _rf_scene("n2", "Next", _scene("t1"), {})], [WIRE])
    assert opened.status_code == 200, opened.text
    assert opened.json()["warnings"] == [
        "Removed the connection to shot port s2 on “Opening”, node n1 while loading the project. That shot no longer exists."]


def test_a_project_open_with_a_port_and_no_connection_says_nothing(workspace, person):  # noqa: F811
    opened = _saved_project(workspace, [
        _rf_scene("n1", "Opening", _scene("s1"), {"shot_s2": {"type": "Image", "value": PAID}}),
        _rf_scene("n2", "Next", _scene("t1"), {})], [])
    assert opened.status_code == 200, opened.text
    assert opened.json()["warnings"] == []
    assert BASE  # the shared fixtures are the round 5 ones
