"""Error copy round 3e: a pre-run check's line for two readers (GM - Design).

Round 3c split a node's run error in two: `error` is the specific text for
agents, `person` is the line the canvas card shows. The pre-run check
(execution/engine.validate_graph) still gave one text to both: "Missing API
key: OPENAI_API_KEY", "Required input port prompt is not connected",
"Batch has 3 items, exceeding its batch_size_cap of 2. ...". GM's rules: no
ids, parameter keys or env-var names in what the person reads (a field by its
label, an input in words); "people get the written line and agents keep the
specific detail".

So a validation error gets the same additive `person` field. `message` is
unchanged word for word: agents read it in run results (/api/graph/run, MCP
run_nodes, `nebula run`), look_at_canvas and the run record. The canvas reads
`person` from the run's answer and the socket's event, and node_errors keeps
it for a reload. Nothing here calls a provider.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from execution import engine
from execution.engine import validate_graph
from models.events import ValidationErrorDetail, ValidationErrorEvent
from models.graph import GraphEdge, GraphNode
from services import node_route
from services.canvas_events import CanvasEventJournal
from services.node_errors import NodeErrors
from services.port_contracts import ContractEdge, ContractNode, validate_edge_contracts

CLAUDE = {"X-Nebula-Agent": "Claude Code"}

KEY_LINE = "Add your OpenAI API key in Settings, then run the node again."
PROMPT_LINE = "Connect a prompt to this node, then run it again."
OVER_CAP = ("This Batch has 3 items, more than its “Item cap” of 2. Remove items or raise the cap, then run it "
            "again. Nothing was generated.")

# What no person line may say (GM): env-var names, parameter or port keys,
# quoted ids, Settings paths, parentheses, internal words.
FORBIDDEN = re.compile(
    r"[A-Z][A-Z0-9]+_[A-Z0-9_]+|\b[a-z0-9]+_[a-z0-9_]+\b|'[\w./:-]+'|\(|\)|Settings >|recovery-aware|"
    r"\bport\b|\bhandle\b|validation|definition|n1\b|n2\b",
)

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "route_cases.json").read_text())
ROUTES = FIXTURE["definitions"]["routes-image"]


def _node(node_id: str, definition_id: str, params: dict | None = None) -> GraphNode:
    return GraphNode(id=node_id, definitionId=definition_id, params=params or {}, outputs={})


def _edge(source: str, source_handle: str, target: str, target_handle: str) -> GraphEdge:
    return GraphEdge(id=f"{source}:{source_handle}->{target}:{target_handle}", source=source,
                     sourceHandle=source_handle, target=target, targetHandle=target_handle)


def _for(errors: list[ValidationErrorDetail], node_id: str) -> list[ValidationErrorDetail]:
    return [error for error in errors if error.node_id == node_id]


def _clean(line: str | None) -> str:
    assert line, "a check the person can reach has a person line"
    assert not FORBIDDEN.search(line), line
    return line


# -- the model --------------------------------------------------------------


def test_a_validation_error_has_an_additive_person_field():
    detail = ValidationErrorDetail(node_id="n1", port_id="", message="Missing API key: OPENAI_API_KEY")
    assert detail.person is None
    lined = ValidationErrorDetail(node_id="n1", port_id="", message="x", person=KEY_LINE)
    assert lined.person == KEY_LINE and lined.message == "x"


# -- each check: the agents' text unchanged, the person's line beside it -----


def test_a_missing_key_names_the_provider_not_the_env_var():
    nodes = [_node("t", "text-input", {"value": "a dune"}), _node("n1", "gpt-image-1-generate")]
    [error] = _for(validate_graph(nodes, [_edge("t", "text", "n1", "prompt")], {}), "n1")
    assert error.message == "Missing API key: OPENAI_API_KEY"
    assert _clean(error.person) == KEY_LINE


def test_a_node_that_takes_either_of_two_keys_names_both():
    nodes = [_node("t", "text-input", {"value": "hello"}), _node("n1", "runway-tts")]
    [error] = _for(validate_graph(nodes, [_edge("t", "text", "n1", "text")], {}), "n1")
    assert error.message == "Missing API key: ELEVENLABS_API_KEY or RUNWAY_API_KEY"
    assert _clean(error.person) == "Add your ElevenLabs or Runway API key in Settings, then run the node again."


def test_an_unconfigured_universal_node_with_no_key_names_its_provider():
    errors = validate_graph([_node("n1", "fal-universal")], [], {})
    key = next(error for error in errors if error.message.startswith("Missing API key"))
    assert key.message == "Missing API key: FAL_KEY"
    assert _clean(key.person) == "Add your fal.ai API key in Settings, then run the node again."


def test_an_unwired_required_input_names_it_in_words():
    [error] = _for(validate_graph([_node("n1", "gpt-image-1-generate")], [], {"OPENAI_API_KEY": "set"}), "n1")
    assert error.message == "Required input port prompt is not connected"
    assert _clean(error.person) == PROMPT_LINE


@pytest.mark.parametrize(("definition_id", "line"), [
    ("elevenlabs-sts", "Connect audio to this node, then run it again."),
    ("kling-v2-1", "Connect an image to this node, then run it again."),
    ("claude-chat", "Connect messages to this node, then run it again."),
    ("runway-act-two", "Connect a performance video to this node, then run it again."),
])
def test_other_inputs_read_by_their_label(definition_id: str, line: str):
    keys = {key: "set" for key in ("ELEVENLABS_API_KEY", "FAL_KEY", "ANTHROPIC_API_KEY", "RUNWAY_API_KEY")}
    [error] = _for(validate_graph([_node("n1", definition_id)], [], keys), "n1")
    assert error.message.startswith("Required input port ") and "'" not in error.message
    assert _clean(error.person) == line


def test_a_label_with_a_note_in_parentheses_reads_without_it():
    from execution.person_line import port_line

    assert port_line("Mask (white = edit)") == "Connect a mask to this node, then run it again."
    assert port_line("Images (1-4)") == "Connect images to this node, then run it again."


def _batch_graph(cap: object = 2) -> tuple[list[GraphNode], list[GraphEdge]]:
    batch = _node("n1", "batch", {"items_text": "one\ntwo\nthree", "batch_size_cap": cap})
    return [batch, _node("n2", "gpt-image-1-generate")], [_edge("n1", "set", "n2", "prompt")]


def test_a_batch_over_its_cap_names_the_item_cap_field():
    nodes, edges = _batch_graph()
    [error] = _for(validate_graph(nodes, edges, {"OPENAI_API_KEY": "set"}), "n1")
    # Agents' text, word for word.
    assert error.message == ("Batch has 3 items, exceeding its batch_size_cap of 2. Reduce the list or raise the "
                             "cap before running; no generation was started.")
    assert _clean(error.person) == OVER_CAP


def test_a_batch_cap_out_of_range_names_the_field():
    nodes, edges = _batch_graph(cap=40)
    [error] = _for(validate_graph(nodes, edges, {"OPENAI_API_KEY": "set"}), "n1")
    assert error.message == "Batch batch_size_cap must be an integer from 1 to 25"
    assert _clean(error.person) == "Set “Item cap” to a whole number from 1 to 25."


def test_an_iterator_cap_out_of_range_names_its_field():
    nodes = [_node("n1", "iterator-text", {"batch_size_cap": 0})]
    [error] = [e for e in _for(validate_graph(nodes, [], {}), "n1") if "batch_size_cap" in e.message]
    assert error.message == "Iterator batch_size_cap must be an integer from 1 to 25"
    assert _clean(error.person) == "Set “Batch Size Cap” to a whole number from 1 to 25."


def test_two_batches_into_one_node_read_without_internal_words():
    nodes = [_node("b1", "batch", {"items_text": "a\nb"}), _node("b2", "batch", {"items_text": "c\nd"}),
             _node("n1", "combine-text")]
    edges = [_edge("b1", "set", "n1", "text1"), _edge("b2", "set", "n1", "text2")]
    joined = [error for error in validate_graph(nodes, edges, {}) if "independent iterator" in error.message]
    assert joined, [error.message for error in validate_graph(nodes, edges, {})]
    assert joined[0].message.startswith("Joining independent iterator batches is unsupported.")
    assert _clean(joined[0].person) == (
        "This node takes items from two separate Batch or iterator nodes. Nebula won't combine them, because "
        "that would multiply the paid runs. Feed it from one of them, then run it again.")


def test_a_world_labs_node_after_a_batch_has_a_line():
    nodes = [_node("b1", "batch", {"items_text": "a\nb"}), _node("n1", "worldlabs-environment")]
    edges = [_edge("b1", "set", "n1", "prompt")]
    [error] = [e for e in validate_graph(nodes, edges, {"WORLDLABS_API_KEY": "set"}) if "recovery-aware" in e.message]
    assert error.message.startswith("World Labs recovery-aware operations cannot run inside an iterator.")
    assert _clean(error.person) == (
        "A World Labs node can't run once for each item of a Batch or iterator. Give each World Labs run "
        "its own node, then run them one at a time.")


def test_a_route_table_node_with_no_key_names_providers_not_env_vars(monkeypatch):
    registry = dict(engine._registry_node_defs())
    registry.update(FIXTURE["definitions"])
    monkeypatch.setattr(engine, "_registry_node_defs", lambda: registry)
    nodes = [_node("t", "text-input", {"value": "a cat"}), _node("n1", ROUTES["id"], {"_provider": "replicate"})]
    keys = {"BFL_API_KEY": "set", "FAL_KEY": "set"}
    [error] = _for(validate_graph(nodes, [_edge("t", "text", "n1", "prompt")], keys), "n1")
    # Agents' text is the router's, word for word (it names the key).
    assert error.message == node_route.route_unavailable(ROUTES, {"_provider": "replicate"}, keys)["message"]
    assert "REPLICATE_API_TOKEN" in error.message
    assert _clean(error.person) == (
        "Fixture Image is set to Replicate, which needs your Replicate API token. Add it in Settings, or "
        "choose another provider. Black Forest Labs or fal.ai can take it.")

    auto = [_node("t", "text-input", {"value": "a cat"}), _node("n1", ROUTES["id"], {})]
    [error] = _for(validate_graph(auto, [_edge("t", "text", "n1", "prompt")], {}), "n1")
    assert "Settings > Providers" in error.message
    assert _clean(error.person).startswith("Add your Black Forest Labs API key, fal.ai API key")
    assert error.person.endswith("in Settings, then run the node again.")


def test_a_route_stopped_by_a_setting_names_the_setting_by_its_label(monkeypatch):
    registry = dict(engine._registry_node_defs())
    registry.update(FIXTURE["definitions"])
    monkeypatch.setattr(engine, "_registry_node_defs", lambda: registry)
    nodes = [_node("t", "text-input", {"value": "a cat"}), _node("n1", ROUTES["id"], {"safety_tolerance": 6})]
    keys = {"BFL_API_KEY": "set", "FAL_KEY": "set"}
    [error] = _for(validate_graph(nodes, [_edge("t", "text", "n1", "prompt")], keys), "n1")
    assert "can't run on Black Forest Labs" in error.message
    line = _clean(error.person)
    # Round 3f: GM's words, the setting by its label in quotes.
    assert line.startswith("Fixture Image can't run on Black Forest Labs with “Safety tolerance” set to 6.")
    assert line.endswith("fal.ai can take it.")


def test_the_krea_account_check_has_a_line(monkeypatch):
    from services import krea_connector

    monkeypatch.setattr(krea_connector, "is_krea_connected", lambda: False)
    errors = [e for e in validate_graph([_node("n1", "krea-moodboard-search")], [], {})
              if "Connect your Krea account" in e.message]
    assert errors and errors[0].message == "Connect your Krea account in Settings before running this recipe"
    assert _clean(errors[0].person) == "Connect your Krea account in Settings, then run the node again."


def test_the_gemini_guardrail_shows_as_it_is():
    from services.provider_capabilities import GEMINI_OMNI_EXTENSION_ERROR

    nodes = [_node("t", "text-input", {"value": "keep the video going"}),
             _node("n1", "gemini-omni-flash", {"task": "edit"})]
    errors = _for(validate_graph(nodes, [_edge("t", "text", "n1", "prompt")], {"GOOGLE_API_KEY": "set"}), "n1")
    [error] = [e for e in errors if e.message == GEMINI_OMNI_EXTENSION_ERROR]
    # Round 3f: the card's line follows GM's rules; agents keep the text.
    from services.provider_capabilities import GEMINI_OMNI_EXTENSION_LINE
    assert error.person == GEMINI_OMNI_EXTENSION_LINE


# -- wiring checks (services/port_contracts.py) -----------------------------


def _contracts(nodes: list[tuple[str, str]], edges: list[tuple[str, str, str, str]]):
    definitions = dict(engine.NODE_DEFS)
    definitions.update(engine._registry_node_defs())
    return validate_edge_contracts(
        [ContractNode(node_id=n, definition_id=d) for n, d in nodes],
        [ContractEdge(edge_id=f"e{i}", source=s, source_handle=sh, target=t, target_handle=th)
         for i, (s, sh, t, th) in enumerate(edges)],
        definitions,
    ).issues


def test_a_wire_of_the_wrong_kind_names_the_input_by_its_label():
    [issue] = _contracts([("a", "image-input"), ("b", "gpt-image-1-generate")], [("a", "image", "b", "prompt")])
    assert issue.message.startswith("Incompatible port types: source 'image' on node a")
    # Round 3g (GM): the port's label in quotes.
    assert _clean(issue.person) == ("The connection into “Prompt” brings something it can't take. "
                                    "Remove that connection, then connect a matching output.")


def test_too_many_wires_into_one_input_has_a_line():
    issues = _contracts([("a", "text-input"), ("c", "text-input"), ("b", "gpt-image-1-generate")],
                        [("a", "text", "b", "prompt"), ("c", "text", "b", "prompt")])
    [issue] = [i for i in issues if "multiple connections" in i.message]
    assert issue.message == "Input port 'prompt' on node b does not allow multiple connections"
    # Round 3g (GM): the port's label in quotes.
    assert _clean(issue.person) == "“Prompt” takes one connection. Remove the extra one, then run the node again."


def test_a_wire_into_an_input_the_node_no_longer_has_has_a_line():
    [issue] = _contracts([("a", "text-input"), ("b", "gpt-image-1-generate")], [("a", "text", "b", "gone")])
    assert issue.message.startswith("Invalid target handle 'gone' on node b")
    assert _clean(issue.person) == ("A connection into this node no longer matches its inputs. Remove it, then "
                                    "connect it again.")


def test_validate_graph_carries_the_wiring_line():
    nodes = [_node("a", "image-input"), _node("n1", "gpt-image-1-generate")]
    errors = _for(validate_graph(nodes, [_edge("a", "image", "n1", "prompt")], {"OPENAI_API_KEY": "set"}), "n1")
    assert any(e.message.startswith("Incompatible port types") and e.person for e in errors)


def test_no_check_a_person_can_reach_is_left_without_a_line():
    """Every ValidationErrorDetail in validate_graph names its person line, or
    is one only agents or a damaged saved graph reach (listed by reason)."""
    source = Path(engine.__file__).read_text(encoding="utf-8")
    body = source[source.index("def _iterator_validation_errors"):source.index("NodeHandler = Callable")]
    unlined = [m.start() for m in re.finditer(r"ValidationErrorDetail\(", body)
               if "person=" not in body[m.start():body.find(")\n", m.start()) + 200]]
    assert unlined == [], "add person= to every ValidationErrorDetail(...) in validate_graph"


# -- the two readers, through the backend ----------------------------------


@pytest.fixture
def canvas(monkeypatch):
    import main

    sent: list[dict] = []

    async def capture(data, **kw):  # the person form; `others` is the agents'
        sent.append(data)

    monkeypatch.setattr(main.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main, "node_errors", NodeErrors(), raising=False)
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        node = client.post("/api/graph/node", json={"definitionId": "gpt-image-1-generate", "params": {}}).json()["id"]
        sent.clear()
        yield client, main, sent, node
        client.delete("/api/graph?force=true")


def test_the_canvas_reads_the_person_line_and_agents_the_specific_text(canvas):
    client, main, sent, node = canvas
    nodes = [{"id": node, "definitionId": "gpt-image-1-generate", "params": {}}]
    canvas_run = client.post("/api/execute", json={"nodes": nodes, "edges": []}).json()
    assert canvas_run["status"] == "validation_error"
    by_message = {error["message"]: error for error in canvas_run["errors"]}
    assert by_message["Missing API key: OPENAI_API_KEY"]["person"] == KEY_LINE
    assert by_message["Required input port prompt is not connected"]["person"] == PROMPT_LINE

    # The socket's event carries the line too (another tab, an agent's run).
    [event] = [m for m in sent if m.get("type") == "validationError"]
    assert {e["message"]: e.get("person") for e in event["errors"]} == {
        "Required input port prompt is not connected": PROMPT_LINE,
        "Missing API key: OPENAI_API_KEY": KEY_LINE,
    }

    # A reload's graph gives the card both, as the run's answer did.
    exported = client.get("/api/graph/export").json()
    data = next(n for n in exported["nodes"] if n["id"] == node)["data"]
    assert data["error"] == "Required input port prompt is not connected; Missing API key: OPENAI_API_KEY"
    assert data["errorPerson"] == f"{PROMPT_LINE} {KEY_LINE}"

    # Agents: look_at_canvas keeps the specific text, no person line.
    shown = next(n for n in client.get("/api/canvas/snapshot").json()["nodes"] if n["id"] == node)
    assert shown["error"] == data["error"] and "errorPerson" not in shown


def test_an_agents_refused_run_keeps_its_text_word_for_word(canvas):
    client, main, sent, node = canvas
    body = client.post("/api/graph/run", json={"targetNodeId": node}, headers=CLAUDE).json()
    assert body["status"] == "failed"
    assert body["errors"] == {node: "Required input port prompt is not connected; Missing API key: OPENAI_API_KEY"}
    assert "person" not in json.dumps(body)
    assert client.get(f"/api/graph/runs/{body['runId']}").json()["errors"] == body["errors"]
    # The agent's cursor on the canvas says the person's line, not the keys.
    [said] = [m["say"] for m in sent if m.get("type") == "agentPresence" and "can't run" in str(m.get("say"))]
    assert "OPENAI_API_KEY" not in said and "'prompt'" not in said
    assert said.endswith(f"can't run. {PROMPT_LINE} {KEY_LINE}")


def test_a_validation_event_serializes_its_person_line():
    import main

    event = ValidationErrorEvent(run_id="r1", errors=[
        ValidationErrorDetail(node_id="n1", port_id="", message="Missing API key: OPENAI_API_KEY", person=KEY_LINE),
        ValidationErrorDetail(node_id="n2", port_id="", message="Edge e1 references missing ..."),
    ])
    camel = main._event_to_camel(event)
    assert camel["errors"][0]["person"] == KEY_LINE
    assert camel["errors"][1].get("person") is None


# -- node_errors: the card after a reload, agents unchanged -----------------


def test_node_errors_keep_the_person_line_for_the_card_only():
    errors = NodeErrors()
    errors.record_validation([
        ValidationErrorDetail(node_id="n1", port_id="prompt", message="Required input port prompt is not connected",
                              person=PROMPT_LINE),
        ValidationErrorDetail(node_id="n1", port_id="", message="Missing API key: OPENAI_API_KEY", person=KEY_LINE),
    ])
    assert errors.get("n1") == {"error": "Required input port prompt is not connected; Missing API key: OPENAI_API_KEY"}
    assert errors.card("n1")["errorPerson"] == f"{PROMPT_LINE} {KEY_LINE}"


def test_a_check_only_agents_reach_reads_the_general_line_after_a_reload():
    errors = NodeErrors()
    errors.record_validation([ValidationErrorDetail(node_id="n1", port_id="",
                                                    message="Duplicate node id 'n1' makes edge endpoints ambiguous")])
    card = errors.card("n1")
    # No line: the card shows GM's general line with the text behind Details.
    assert "errorPerson" not in card and card["errorCategory"] == "unknown"
    assert errors.get("n1") == {"error": "Duplicate node id 'n1' makes edge endpoints ambiguous"}


# -- Paper source routes: the card's line beside the specific text ---------
#
# The Paper source card showed the route's detail as is: "Paper CLI
# unavailable; open Paper Desktop or configure NEBULA_PAPER_CLI", "Paper tool
# failed". The detail keeps `message` word for word and gains `person`.

PAPER_CASES = [
    ("Paper CLI unavailable; open Paper Desktop or configure NEBULA_PAPER_CLI", "unavailable",
     "Paper isn't answering. Open Paper Desktop, then try again."),
    ("Paper is disconnected or its request timed out; last good snapshot retained", "unavailable",
     "Paper isn't answering. Open Paper Desktop, then try again."),
    ("Paper tool failed", "unavailable", "Paper isn't answering. Open Paper Desktop, then try again."),
    ("Linked Paper object is missing", "missing",
     "The linked object is missing in Paper. Reconnect it, or link another object."),
    ("Choose an editable Paper object rather than the page root", "unavailable",
     "Choose an object on the page, not the page itself, then link it again."),
    ("Paper object changed while exporting; refresh again", "unavailable",
     "The object changed while Paper was exporting it. Refresh the source again."),
    ("Paper export is unavailable or exceeds 32 MiB", "unavailable",
     "Paper couldn't export this object, or its export is over 32 MB. Try a smaller object."),
    ("Snapshot integrity check failed", "unavailable",
     "Nebula couldn't check the artwork Paper exported. Refresh the source again."),
]


@pytest.mark.parametrize("message,state,line", PAPER_CASES)
def test_a_paper_route_error_carries_a_person_line(message, state, line):
    from services.paper_routes import error
    from services.paper_sources import SourceRefreshError
    from services.paper_transport import PaperError

    plain = error(PaperError(message, state))
    assert plain.detail == {"message": message, "person": line}
    refresh = error(SourceRefreshError(PaperError(message, state), {"id": "s1"}))
    assert refresh.detail["message"] == message and refresh.detail["person"] == line
    assert refresh.detail["source"] == {"id": "s1"}
    assert not FORBIDDEN.search(line), line


def test_a_missing_paper_source_keeps_its_text_and_gains_a_line():
    from services.paper_routes import error

    gone = error(KeyError("s1"))
    assert gone.status_code == 404
    assert gone.detail == {"message": "Paper source or snapshot not found",
                           "person": "Nebula can't find this Paper source. Link the object again."}


@pytest.mark.asyncio
async def test_a_failed_refresh_keeps_the_card_line_beside_its_text(tmp_path):
    import io as _io

    from PIL import Image

    from services.paper_sources import PaperSources, SourceRefreshError
    from services.paper_transport import PaperError

    out = _io.BytesIO()
    Image.new("RGBA", (4, 4), (10, 20, 30, 255)).save(out, format="PNG")

    class Transport:
        error = None

        async def capture(self, identity, settings):
            if self.error:
                raise self.error
            return ({**identity, "fileName": "F", "pageName": "P", "objectName": "Logo",
                     "openUrl": "https://app.paper.design/file/f/p", "navigation": "file"},
                    out.getvalue(), {"width": 4, "height": 4})

    transport = Transport()
    sources = PaperSources(tmp_path, transport)
    linked = await sources.link({"fileId": "f", "pageId": "p", "objectId": "o"})
    transport.error = PaperError("Paper tool failed")
    with pytest.raises(SourceRefreshError):
        await sources.refresh(linked["id"])
    kept = sources.get(linked["id"])
    assert kept["lastError"] == "Paper tool failed"
    assert kept["lastErrorPerson"] == "Paper isn't answering. Open Paper Desktop, then try again."

    transport.error = None
    restored = await sources.refresh(linked["id"])
    assert "lastError" not in restored and "lastErrorPerson" not in restored
