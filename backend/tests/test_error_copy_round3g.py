"""Error copy round 3g: GM - Design's answers to round 3f's questions, and two fixes.

GM, verbatim (2026-10-23):

1. "Delete: choose a), make undo complete. While a) builds, ship c) so the
   Delete key doesn't start asking on every delete. It asks only when a node
   has pins or open proposals; the toolbar, menu and Inspector paths keep the
   confirm until a) lands."
2. "Ports: yes, quote them too. The rule is now that anything a person reads
   as a label on the node goes in quotes, field or port. "The wire into
   “Prompt” brings something it can't take." "Connect an image to
   “Character Refs”.""
3. "World Labs: keep the quotes." (already pinned by
   test_error_copy_round3f.test_review_rule_5_the_lines_the_label_guard_found_quote_their_fields)
- "Gemini Omni: the period inside the quote followed by a comma reads badly.
  → "Gemini Omni can edit a video but can't make it longer. Describe the
  change as an edit, like “Change the lighting and keep everything else the
  same”, or use Veo 3.1 to extend the video.""

The port guard extends 3f's (test_error_copy_round3f.rule_breaks and
card_lines): a port's label written into a card line without quotes fails.
The Delete key's rule is pinned against the backend's own delete here and
against the canvas's reading of it (frontend/tests/errorCopy.round3g.test.tsx)
through one fixture, tests/fixtures/delete_confirm_cases.json. What agents
read (exception texts, a validation error's message) doesn't change.
"""
from __future__ import annotations

import ast
import asyncio
import json

import pytest

from tests.test_error_copy_round3f import BACKEND, _files, _line_beside, card_lines, port_breaks, rule_breaks

DEFINITIONS = json.loads((BACKEND / "data" / "node_definitions.json").read_text())


# -- GM item 2: a port's label sits in quotes ------------------------------------


def test_the_port_check_catches_each_shape_and_lets_gms_lines_through() -> None:
    for line in (
        "The wire into the node's Prompt input brings something it can't take.",
        "The node's Images (1-4) input takes up to 4 wires.",
        "Connect a base image to this node's Image input, then run it again.",
        "Krea 2's Moodboard input takes a Nebula moodboard now.",
        "Connect the audio track to Audio, or clear the voice.",
        "Disconnect End image.",
        "The wire into the node's {} input brings something it can't take.",
    ):
        assert port_breaks(line), line
    for line in (
        # GM's own examples.
        "The wire into “Prompt” brings something it can't take.",
        "Connect an image to “Character Refs”.",
        # Rule 6 names no port label: an input in words.
        "Connect a prompt to this node, then run it again.",
        "Connect media or text to save to Krea Files, then run the node again.",
        "Connect a Meshy Auto-Rig node to “Rig Task ID”, then run the node again.",
        "Disconnect the extra ones, then run the node again.",
    ):
        assert not port_breaks(line), line
    # 3f's rules still hold on GM's examples.
    assert not rule_breaks("The wire into “Prompt” brings something it can't take.")


def test_every_card_line_quotes_the_ports_it_names() -> None:
    broken = [f"{path}:{number}: {text}" for path, number, text, _ends in card_lines() if port_breaks(text)]
    assert not broken, f"{len(broken)} card lines name a port without quotes:\n" + "\n".join(broken)


def _input_ports() -> list[tuple[str, dict]]:
    return [(definition_id, port) for definition_id, definition in DEFINITIONS.items()
            for port in definition.get("inputPorts") or []]


def test_every_wiring_line_names_the_port_in_quotes_exactly_as_the_node_shows_it() -> None:
    from services import port_contracts

    ports = _input_ports()
    assert len(ports) > 300
    broken = []
    for definition_id, port in ports:
        label = str(port.get("label") or "").strip()
        for line in (port_contracts._wrong_kind_line(port, port["id"]),
                     port_contracts._too_many_line(port, port["id"], 1),
                     port_contracts._too_many_line(port, port["id"], 4)):
            if port_breaks(line) or rule_breaks(line) or f"“{label}”" not in line:
                broken.append(f"{definition_id}.{port['id']}: {line}")
    for line in port_contracts.PORT_TYPE_PERSON_HINTS.values():
        if port_breaks(line) or rule_breaks(line):
            broken.append(line)
    assert not broken, "\n".join(broken[:40])


def test_the_wiring_lines_in_gms_form() -> None:
    from services import port_contracts

    prompt = {"id": "prompt", "label": "Prompt"}
    assert port_contracts._wrong_kind_line(prompt, "prompt") == (
        "The wire into “Prompt” brings something it can't take. Remove that wire, then connect a matching output.")
    # The label exactly as the node shows it, its note included (a quoted
    # label may hold parentheses, 3f judgment 11).
    mask = {"id": "mask", "label": "Mask (white = edit)"}
    assert port_contracts._wrong_kind_line(mask, "mask").startswith("The wire into “Mask (white = edit)” brings ")
    assert port_contracts._too_many_line(prompt, "prompt", 1) == (
        "“Prompt” takes one wire. Remove the extra one, then run the node again.")
    images = {"id": "images", "label": "Images (1-4)"}
    assert port_contracts._too_many_line(images, "images", 4) == (
        "“Images (1-4)” takes up to 4 wires. Remove the extra ones, then run the node again.")
    assert port_contracts.PORT_TYPE_PERSON_HINTS[("krea-2-generate", "moodboard")] == (
        "“Moodboard” takes a Nebula moodboard now. To use a Krea moodboard, put its ID in “Moodboard ID” and "
        "remove the wire.")
    # Agents keep the specific text word for word.
    assert port_contracts.PORT_TYPE_HINTS[("krea-2-generate", "moodboard")].startswith(
        "Krea 2's Moodboard input takes a Nebula moodboard or the Krea Moodboard node's Moodboard output")


def test_a_port_label_written_into_a_card_line_sits_in_quotes() -> None:
    # Structurally, as 3f's field_label check: a card line that writes a port's
    # label from its definition (port_contracts._input_name) quotes it.
    bare = []
    for path in _files():
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.JoinedStr):
                continue
            parts = node.values
            for index, part in enumerate(parts):
                if not (isinstance(part, ast.FormattedValue) and isinstance(part.value, ast.Call)):
                    continue
                func = part.value.func
                if (func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")) != "_input_name":
                    continue
                before = parts[index - 1] if index else None
                after = parts[index + 1] if index + 1 < len(parts) else None
                opens = isinstance(before, ast.Constant) and str(before.value).endswith("“")
                closes = isinstance(after, ast.Constant) and str(after.value).startswith("”")
                if not (opens and closes):
                    bare.append(f"{path.relative_to(BACKEND)}:{node.lineno}")
    assert not bare, bare


def _port_label(definition_id: str, port_id: str) -> str:
    return next(str(port["label"]) for port in DEFINITIONS[definition_id]["inputPorts"] if port["id"] == port_id)


def test_identity_edits_lines_name_its_ports_as_it_shows_them() -> None:
    # "Where a line names a specific port, it becomes GM's second example's form."
    assert _port_label("identity-edit", "image") == "Image"
    assert _line_beside("execution/maker_routes_google.py", "identity-edit requires a base image") == (
        "Connect a base image to “Image”, then run the node again.")
    # The node shows its mask port as "Mask (unavailable)".
    assert _port_label("identity-edit", "mask") == "Mask (unavailable)"
    assert _line_beside("execution/maker_routes_google.py", "Identity Edit does not support masks") == (
        "Identity Edit can't take a mask on the Nano Banana 2 endpoint. Disconnect “Mask (unavailable)”, then run "
        "the node again.")


def test_the_quoted_ports_other_rounds_wrote_are_the_nodes_own_labels() -> None:
    assert _port_label("ideogram-character", "reference_images") == "Character Refs"
    assert "Connect an image to “Character Refs”" in _line_beside("handlers/ideogram.py", "Character Refs input is required")
    assert (_port_label("ideogram-edit-prompt", "image"), _port_label("ideogram-edit-prompt", "images")) == (
        "Image", "Images")
    assert _port_label("runway-sts", "audio") == "Audio"
    assert _port_label("veo-3", "video") == "Extend Video"
    assert _port_label("meshy-animate", "rig_task_id") == "Rig Task ID"
    assert _port_label("meshy-3d-print", "task_id") == "Task ID"
    assert _port_label("krea-video-minimax-hailuo-02", "end_image") == "End image"


def test_a_numbered_port_keeps_gms_second_example_form() -> None:
    from execution.person_line import connect_line

    assert connect_line("Item 1") == "Connect an output to “Item 1”, then run the node again."
    assert connect_line("Prompt") == "Connect a prompt to this node, then run it again."  # rule 6, in words


# -- GM's Gemini Omni fix ----------------------------------------------------------


def test_the_gemini_omni_line_closes_the_quote_before_the_comma() -> None:
    from services.provider_capabilities import GEMINI_OMNI_EXTENSION_ERROR, GEMINI_OMNI_EXTENSION_LINE

    assert GEMINI_OMNI_EXTENSION_LINE == (
        "Gemini Omni can edit a video but can't make it longer. Describe the change as an edit, like "
        "“Change the lighting and keep everything else the same”, or use Veo 3.1 to extend the video.")
    assert not rule_breaks(GEMINI_OMNI_EXTENSION_LINE)
    # Agents keep the guardrail word for word.
    assert GEMINI_OMNI_EXTENSION_ERROR == (
        "Gemini Omni capability guardrail: Gemini Omni can edit an existing video in place, but it cannot extend "
        "the video's duration. Rephrase this as an edit (for example, 'Change the lighting and keep everything "
        "else the same') or use Veo 3.1 for video extension.")


# -- GM item 1: what the backend's delete takes with it ------------------------------

CASES = json.loads((BACKEND / "tests" / "fixtures" / "delete_confirm_cases.json").read_text())["cases"]
CLAUDE = {"X-Nebula-Agent": "Claude Code"}


@pytest.fixture
def delete_api(tmp_path, monkeypatch, person):
    import main as main_module
    from fastapi.testclient import TestClient

    from services import asset_proposals, project_cover
    from services.agent_presence import AgentPresence
    from services.canvas_events import CanvasEventJournal
    from services.canvas_pins import CanvasPins
    from services.canvas_proposals import ProposalBook
    from services.cli_graph import CLIGraph
    from services.execution_runs import ExecutionRunRegistry
    from services.project_store import ProjectStore, make_project
    from services.provider_recovery import ProviderRecoveryStore
    from services.provider_start_guard import ProviderStartGuard
    from services.run_approvals import RunApprovals
    from services.selection_context import SelectionContextStore

    class Clock:
        now = 1_760_000_000.0

        def __call__(self) -> float:
            return self.now

    monkeypatch.setattr(project_cover, "_time_for", lambda url: None)
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Open now")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    clock = Clock()

    async def quiet(_data):
        return None

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook(clock))
    monkeypatch.setattr(main_module, "asset_proposals", asset_proposals.AssetProposalBook(clock))
    monkeypatch.setattr(main_module, "run_approvals", RunApprovals(clock))
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", quiet)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", quiet)
    return main_module, TestClient(main_module.app), person.headers, project["id"]


def _proposal_body(case_proposal: dict) -> dict:
    node_id, how = case_proposal["reads"], case_proposal["as"]
    if how == "edge":
        return {"note": "Generate from the prompt",
                "nodes": [{"ref": "+img", "definitionId": "nano-banana", "params": {"aspect_ratio": "16:9"}}],
                "edges": [{"source": node_id, "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}],
                "run": ["+img"]}
    if how == "params":
        return {"note": "A warmer prompt", "params": [{"nodeId": node_id, "params": {"value": "a warm cat"}}]}
    return {"note": "Run it", "run": [node_id]}


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_the_backends_delete_takes_what_the_fixture_says(delete_api, case) -> None:
    """`asks` is whether deleting the nodes detaches a pin or closes a proposal,
    as the real DELETE /api/graph/node and the asset-proposal sweep do it, and
    each proposal's view (what the canvas reads) is the fixture's."""
    main, client, person, project_id = delete_api
    for index, spec in enumerate(case["nodes"], start=1):
        if spec.get("image"):
            made = main.cli_graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": spec["image"]}})
        else:
            made = main.cli_graph.add_node("text-input", {"value": "a cat"})
        assert made == spec["id"] == f"n{index}"
    pins = []
    for spec in case.get("pins", []):
        body = {"text": "Check this", **({"nodeId": spec["on"]} if spec["on"] else {"position": {"x": 5, "y": 5}})}
        made = client.post("/api/canvas/pins", json=body, headers=person)
        assert made.status_code == 201, made.text
        pin = made.json()["pin"]
        if spec["status"] == "resolved":
            answered = client.post(f"/api/canvas/pins/{pin['id']}/resolve", json={"reply": "Done"}, headers=CLAUDE)
            assert answered.status_code == 200, answered.text
        pins.append(pin["id"])
    proposals = []
    for spec in case.get("proposals", []):
        made = client.post("/api/canvas/proposals", json=_proposal_body(spec), headers=CLAUDE)
        assert made.status_code in (200, 201), made.text
        view = made.json()["proposal"]
        assert view["references"] == [spec["reads"]]  # what the canvas reads (ProposalView.references)
        if spec["status"] == "withdrawn":
            assert client.delete(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).status_code == 200
        proposals.append(view["id"])
    if case.get("coverPin"):
        pinned = client.put(f"/api/projects/{project_id}/cover", json={"url": case["coverPin"]}, headers=person)
        assert pinned.status_code == 200, pinned.text
    covers = []
    for spec in case.get("covers", []):
        made = client.post("/api/asset-proposals", json={"kind": "project", "id": project_id,
                                                          "change": {"cover": spec["to"]}, "note": "Use this one"},
                           headers=CLAUDE)
        assert made.status_code == 201, made.text
        view = made.json()["proposal"]
        # What the canvas reads (AssetProposalView.change.cover).
        assert view["change"]["cover"]["to"] == spec["to"]
        assert view["change"]["cover"]["from"] == case.get("coverPin")
        assert view["target"]["id"] == project_id and view["status"] == "open"
        covers.append(view["id"])

    open_before = {pid for pid in proposals if main.canvas_proposals.get(pid).status == "open"}
    for node_id in case["delete"]:
        assert client.delete(f"/api/graph/node/{node_id}", headers=person).status_code == 200
    asyncio.run(main._sweep_asset_proposals())

    listed = {pin["id"]: pin for pin in main.canvas_pins.list()["pins"]}
    detached = [pid for pid in pins if listed[pid].get("detached")]
    closed = [pid for pid in open_before if main.canvas_proposals.get(pid).status != "open"]
    covers_closed = [pid for pid in covers if main.asset_proposals.get(pid).status != "open"]
    assert bool(detached or closed or covers_closed) is case["asks"], (detached, closed, covers_closed)
