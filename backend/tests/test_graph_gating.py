"""Gates: a node withholds an output, and the nodes wired to it are skipped.

The engine rule (execution/gating.py): a node runs only if none of its
inbound edges comes from a withheld port or a skipped node. Paid handlers here
are fakes that count calls, and the one real Jev Decide test mocks httpx, so
nothing reaches a provider.
"""
from __future__ import annotations

import httpx
import pytest

from execution import provider_calls
from execution.engine import execute_graph, validate_graph
from execution.gating import join_outputs, split_outputs, withheld
from handlers.jev_decide import handle_jev_decide
from models.graph import GraphEdge, GraphNode
from services import typesafe_client as ts
from services.cache import ExecutionCache

GATE = "jev-decide"
PAID = "gpt-image-1-edit"  # image + prompt in, image out
UPSCALE = "esrgan-upscale"  # image in, image out


def node(nid, definition, params=None):
    return GraphNode(id=nid, definitionId=definition, params=params or {})


def edge(src, dst, source, target):
    return GraphEdge(id=f"{src}.{source}->{dst}.{target}", source=src, sourceHandle=source,
                     target=dst, targetHandle=target)


class Fakes:
    """A gate that decides by its `verdict` param, and paid nodes that count calls."""

    def __init__(self):
        self.calls: list[str] = []
        self.inputs: dict[str, dict] = {}

    async def gate(self, node, inputs, api_keys):
        self.calls.append(node.id)
        verdict = node.params.get("verdict", "true")
        through = inputs.get("through")
        carried = {"type": through.type, "value": through.value} if through else {"type": "Text", "value": verdict}
        reason = f"Jev Decide {'passed' if verdict == 'true' else 'failed'} (answered {'yes' if verdict == 'true' else 'no'}, 0.9)"
        if node.params.get("omit"):
            return {"pass": {"type": "Text", "value": verdict}, "on_pass": carried}
        return {
            "pass": {"type": "Text", "value": verdict},
            "report": {"type": "Text", "value": f"Jev Decide (yes/no)\nPass: {verdict}"},
            "on_pass": carried if verdict == "true" else withheld(reason),
            "on_fail": carried if verdict == "false" else withheld(reason),
        }

    async def paid(self, node, inputs, api_keys):
        self.calls.append(node.id)
        self.inputs[node.id] = {port: value.value for port, value in inputs.items()}
        return {"image": {"type": "Image", "value": f"https://example.invalid/{node.id}.png"}}

    def registry(self):
        return {GATE: self.gate, PAID: self.paid, UPSCALE: self.paid}


async def run(nodes, edges, registry, *, cache=None, run_id="gating-tests"):
    events = []

    async def emit(event):
        events.append(event)

    await execute_graph(nodes, edges, {}, registry, emit, cache=cache, run_id=run_id)
    return events


def of(events, kind, nid=None):
    return [event for event in events if event.type == kind and (nid is None or event.node_id == nid)]


@pytest.fixture(autouse=True)
def no_downloads(monkeypatch):
    """The fake paid nodes return https URLs; keep them as they are."""
    import execution.engine as engine

    async def keep(outputs, run_dir):
        return outputs

    monkeypatch.setattr(engine, "_materialize_media_outputs", keep)


def gate_graph(verdict):
    """image -> Decide.through; Decide.on_pass -> upscale; Decide.on_fail -> paid edit."""
    nodes = [
        node("img", "image-input", {"filePath": "https://example.invalid/source.png"}),
        node("brief", "text-input", {"value": "a red mug"}),
        node("gate", GATE, {"verdict": verdict, "question": "On brief?"}),
        node("up", UPSCALE),
        node("redo", PAID),
    ]
    edges = [
        edge("img", "gate", "image", "images"),
        edge("img", "gate", "image", "through"),
        edge("brief", "gate", "text", "state"),
        edge("gate", "up", "on_pass", "image"),
        edge("gate", "redo", "on_fail", "image"),
        edge("brief", "redo", "text", "prompt"),
    ]
    return nodes, edges


# -- the rule -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_pass_branch_runs_with_the_through_value_and_the_fail_branch_is_skipped():
    fakes = Fakes()
    nodes, edges = gate_graph("true")
    assert validate_graph(nodes, edges, {"TYPESAFE_API_KEY": "k", "FAL_KEY": "k", "OPENAI_API_KEY": "k"}) == []
    events = await run(nodes, edges, fakes.registry())

    assert fakes.calls == ["gate", "up"]
    assert fakes.inputs["up"] == {"image": "https://example.invalid/source.png"}
    [gate_done] = of(events, "executed", "gate")
    assert "on_fail" not in gate_done.outputs and gate_done.outputs["on_pass"]["type"] == "Image"
    assert gate_done.withheld == {"on_fail": "Jev Decide passed (answered yes, 0.9)"}
    [skipped] = of(events, "skipped", "redo")
    assert skipped.reason == "Jev Decide passed (answered yes, 0.9)" and skipped.gate_node_id == "gate"
    assert not of(events, "executing", "redo") and not of(events, "executed", "redo")
    assert of(events, "graph_complete")[0].nodes_skipped == 1


@pytest.mark.asyncio
async def test_the_fail_branch_runs_and_the_pass_branch_and_its_descendants_are_skipped():
    fakes = Fakes()
    nodes, edges = gate_graph("false")
    nodes += [node("up2", UPSCALE), node("show", "preview")]
    edges += [edge("up", "up2", "image", "image"), edge("up2", "show", "image", "input")]
    events = await run(nodes, edges, fakes.registry())

    assert fakes.calls == ["gate", "redo"]
    assert fakes.inputs["redo"] == {"image": "https://example.invalid/source.png", "prompt": "a red mug"}
    for nid in ("up", "up2", "show"):
        [skipped] = of(events, "skipped", nid)
        assert skipped.reason == "Jev Decide failed (answered no, 0.9)" and skipped.gate_node_id == "gate"
        assert not of(events, "executing", nid)
    complete = of(events, "graph_complete")[0]
    assert complete.nodes_skipped == 3 and complete.nodes_executed == 4  # img, brief, gate, redo


@pytest.mark.asyncio
async def test_a_node_fed_by_both_branches_is_skipped_whichever_way_the_gate_goes():
    for verdict in ("true", "false"):
        fakes = Fakes()
        nodes, edges = gate_graph(verdict)
        nodes.append(node("join", "combine-text"))
        edges += [edge("gate", "join", "on_pass", "text1"), edge("gate", "join", "on_fail", "text2")]
        events = await run(nodes, edges, fakes.registry())
        assert of(events, "skipped", "join"), verdict
        assert not of(events, "executed", "join")


@pytest.mark.asyncio
async def test_a_skipped_input_skips_a_node_even_when_its_other_inputs_ran():
    fakes = Fakes()
    nodes, edges = gate_graph("false")
    edges.append(edge("brief", "up", "text", "prompt"))  # a live input alongside the withheld one
    nodes.append(node("after", PAID))
    edges += [edge("up", "after", "image", "image"), edge("brief", "after", "text", "prompt")]
    events = await run(nodes, edges, fakes.registry())
    assert of(events, "skipped", "up") and of(events, "skipped", "after")
    assert "after" not in fakes.calls


@pytest.mark.asyncio
async def test_only_withheld_ports_skip_and_the_gates_other_outputs_still_flow():
    fakes = Fakes()
    nodes, edges = gate_graph("false")
    nodes.append(node("note", "preview"))
    edges.append(edge("gate", "note", "report", "input"))
    events = await run(nodes, edges, fakes.registry())
    [shown] = of(events, "executed", "note")
    assert shown.outputs["input"]["value"].startswith("Jev Decide (yes/no)")


@pytest.mark.asyncio
async def test_a_gate_that_leaves_out_a_conditional_port_fails_closed():
    fakes = Fakes()
    nodes, edges = gate_graph("true")
    nodes[2].params["omit"] = True  # returns on_pass only, and no withheld entry for on_fail
    events = await run(nodes, edges, fakes.registry())
    [skipped] = of(events, "skipped", "redo")
    assert skipped.reason == "Jev Decide sent nothing on On Fail"
    assert "redo" not in fakes.calls


@pytest.mark.asyncio
async def test_withholding_a_port_that_is_not_conditional_fails_the_node():
    calls = []

    async def bad(node, inputs, api_keys):
        return {"image": withheld("nope")}

    async def downstream(node, inputs, api_keys):
        calls.append(node.id)
        return {}

    nodes = [node("a", PAID), node("b", UPSCALE)]
    edges = [edge("a", "b", "image", "image")]
    events = await run(nodes, edges, {PAID: bad, UPSCALE: downstream})
    [error] = of(events, "error", "a")
    assert "isn't a conditional output" in error.error
    assert calls == [] and not of(events, "skipped")


# -- nothing else changes -------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_normal_node_that_leaves_out_an_output_still_lets_downstream_run():
    calls = []

    async def empty(node, inputs, api_keys):
        calls.append(node.id)
        return {}

    async def downstream(node, inputs, api_keys):
        calls.append(node.id)
        assert "image" not in inputs  # today's behaviour: the input is just missing
        return {"image": {"type": "Image", "value": "https://example.invalid/b.png"}}

    nodes = [node("a", PAID), node("b", UPSCALE)]
    events = await run(nodes, [edge("a", "b", "image", "image")], {PAID: empty, UPSCALE: downstream})
    assert calls == ["a", "b"] and not of(events, "skipped")
    assert of(events, "executed", "a")[0].withheld is None


@pytest.mark.asyncio
async def test_the_router_still_copies_to_every_output():
    nodes = [node("t", "text-input", {"value": "hi"}), node("r", "router")]
    nodes += [node(f"p{i}", "preview") for i in (1, 2, 3)]
    edges = [edge("t", "r", "text", "input")] + [edge("r", f"p{i}", f"out{i}", "input") for i in (1, 2, 3)]
    events = await run(nodes, edges, {})
    assert [of(events, "executed", f"p{i}")[0].outputs["input"]["value"] for i in (1, 2, 3)] == ["hi"] * 3
    assert not of(events, "skipped")


# -- cache and spend -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_cached_gate_replays_its_withheld_ports_and_skipped_nodes_write_no_cache():
    cache = ExecutionCache()
    nodes, edges = gate_graph("false")
    first = Fakes()
    events = await run(nodes, edges, first.registry(), cache=cache)
    assert first.calls == ["gate", "redo"] and of(events, "skipped", "up")
    assert cache.size == 2  # gate and redo; the skipped upscale wrote nothing

    again = Fakes()
    events = await run(nodes, edges, again.registry(), cache=cache)
    assert again.calls == []  # both answered from the cache
    [skipped] = of(events, "skipped", "up")
    assert skipped.reason == "Jev Decide failed (answered no, 0.9)"
    assert of(events, "executed", "gate")[0].withheld == {"on_pass": "Jev Decide failed (answered no, 0.9)"}
    assert cache.size == 2


@pytest.mark.asyncio
async def test_skipped_nodes_never_reach_their_handler_so_the_spend_hold_gives_them_back():
    provider_calls.begin("gated-spend")
    nodes, edges = gate_graph("true")
    await run(nodes, edges, Fakes().registry(), run_id="gated-spend")
    assert provider_calls.take("gated-spend") == {"gate", "up"}


def test_split_and_join_round_trip_and_keep_withheld_entries_out_of_port_values():
    definition = {"displayName": "Gate", "outputPorts": [
        {"id": "pass", "label": "Pass"}, {"id": "on_pass", "label": "On Pass", "conditional": True},
        {"id": "on_fail", "label": "On Fail", "conditional": True}]}
    outputs = {"pass": {"type": "Text", "value": "true"}, "on_pass": {"type": "Text", "value": "x"},
               "on_fail": withheld("  Gate   passed ")}
    ports, held = split_outputs(outputs, definition)
    assert ports == {"pass": outputs["pass"], "on_pass": outputs["on_pass"]}
    assert held == {"on_fail": "Gate passed"}
    assert split_outputs(join_outputs(ports, held), definition) == (ports, held)
    with pytest.raises(ValueError):
        withheld("   ")


# -- iterators ------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_inside_an_iterator_each_item_is_gated_on_its_own():
    fakes = Fakes()

    async def gate(node, inputs, api_keys):
        keep = "keep" in str(inputs["through"].value)
        node.params["verdict"] = "true" if keep else "false"
        return await fakes.gate(node, inputs, api_keys)

    async def per_item(node, inputs, api_keys):
        fakes.calls.append(f"{node.id}:{inputs['prompt'].value}")
        return {"image": {"type": "Image", "value": f"https://example.invalid/{inputs['prompt'].value}.png"}}

    values = ["keep one", "drop two", "keep three"]
    nodes = [node(f"s{i}", "text-input", {"value": value}) for i, value in enumerate(values)]
    nodes += [node("array", "array-builder"), node("each", "iterator-text"), node("gate", GATE),
              node("make", PAID), node("all_fail", PAID)]
    edges = [edge(f"s{i}", "array", "text", f"item{i + 1}") for i in range(len(values))]
    edges += [edge("array", "each", "array", "array"), edge("each", "gate", "text", "through"),
              edge("gate", "make", "on_pass", "prompt"), edge("gate", "all_fail", "on_pass", "image"),
              edge("gate", "all_fail", "on_fail", "prompt")]
    events = await run(nodes, edges, {GATE: gate, PAID: per_item})

    assert [call for call in fakes.calls if call.startswith("make")] == ["make:keep one", "make:keep three"]
    made = of(events, "executed", "make")
    assert len(made) == 2 and len(made[-1].batch_outputs) == 2
    assert not of(events, "skipped", "make")  # it ran for some items
    assert of(events, "skipped", "all_fail")  # fed by both branches: skipped for every item
    # The wire to `make` carried values on some items, so it doesn't show as withheld.
    assert of(events, "executed", "gate")[-1].withheld is None


# -- the real Jev Decide handler (httpx mocked) -----------------------------------------


def _mock_jev(monkeypatch, noul):
    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"model": "jev-1.14.0", "answers": {"decide": {"type": "noul", "noul": noul}},
                                         "usage": {"input_tokens": 40, "output_tokens": 2}})

    monkeypatch.setattr(ts, "_make_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(answer)))

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(ts, "_sleep", no_sleep)


def decide_graph(**params):
    nodes = [node("brief", "text-input", {"value": "A blue mug on a wooden table."}),
             node("gate", GATE, {"question": "Is the mug red?", **params}),
             node("on_pass_show", "preview"), node("on_fail_show", "preview")]
    edges = [edge("brief", "gate", "text", "state"), edge("brief", "gate", "text", "through"),
             edge("gate", "on_pass_show", "on_pass", "input"), edge("gate", "on_fail_show", "on_fail", "input")]
    return nodes, edges


async def run_decide(monkeypatch, noul, **params):
    _mock_jev(monkeypatch, noul)
    nodes, edges = decide_graph(**params)
    events = []

    async def emit(event):
        events.append(event)

    await execute_graph(nodes, edges, {"TYPESAFE_API_KEY": "ts-test-key"}, {GATE: handle_jev_decide}, emit,
                        run_id="gating-real-decide")
    return events


@pytest.mark.asyncio
async def test_real_decide_answering_no_sends_through_down_on_fail(monkeypatch):
    events = await run_decide(monkeypatch, 0.12)
    [shown] = of(events, "executed", "on_fail_show")
    assert shown.outputs["input"] == {"type": "Text", "value": "A blue mug on a wooden table."}
    [skipped] = of(events, "skipped", "on_pass_show")
    assert skipped.reason == "Jev Decide failed (answered no, 0.12)"


@pytest.mark.asyncio
@pytest.mark.parametrize("when_unsure, runs", [("fail", "on_fail_show"), ("pass", "on_pass_show"), ("neither", None)])
async def test_real_decide_routes_an_unsure_answer_by_when_unsure(monkeypatch, when_unsure, runs):
    events = await run_decide(monkeypatch, 0.6, when_unsure=when_unsure, min_confidence=0.5)  # confidence 0.2
    ran = {event.node_id for event in of(events, "executed")} & {"on_pass_show", "on_fail_show"}
    assert ran == ({runs} if runs else set())
    for event in of(events, "skipped"):
        assert event.reason.startswith("Jev Decide was unsure (confidence 0.2, below 0.5)")
