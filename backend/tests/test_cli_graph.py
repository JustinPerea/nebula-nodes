import pytest
from services.cli_graph import CLIGraph


@pytest.fixture
def graph():
    return CLIGraph()


def test_add_node(graph):
    nid = graph.add_node("imagen-4-generate", {"model": "imagen-4.0-generate-001"})
    assert nid == "n1"
    assert graph.nodes["n1"]["definitionId"] == "imagen-4-generate"
    assert graph.nodes["n1"]["params"]["model"] == "imagen-4.0-generate-001"


def test_sequential_ids(graph):
    n1 = graph.add_node("node-a", {})
    n2 = graph.add_node("node-b", {})
    n3 = graph.add_node("node-c", {})
    assert (n1, n2, n3) == ("n1", "n2", "n3")


def test_connect(graph):
    graph.add_node("node-a", {})
    graph.add_node("node-b", {})
    graph.connect("n1", "image", "n2", "image")
    assert len(graph.edges) == 1
    edge = graph.edges[0]
    assert edge["source"] == "n1"
    assert edge["sourceHandle"] == "image"
    assert edge["target"] == "n2"
    assert edge["targetHandle"] == "image"


def test_connect_unknown_node_raises(graph):
    graph.add_node("node-a", {})
    with pytest.raises(ValueError, match="not found"):
        graph.connect("n1", "out", "n99", "in")


def test_update_params(graph):
    graph.add_node("node-a", {"x": 1})
    graph.update_params("n1", {"x": 2, "y": 3})
    assert graph.nodes["n1"]["params"] == {"x": 2, "y": 3}


def test_update_unknown_node_raises(graph):
    with pytest.raises(ValueError, match="not found"):
        graph.update_params("n99", {"x": 1})


def test_clear(graph):
    graph.add_node("node-a", {})
    graph.add_node("node-b", {})
    graph.connect("n1", "out", "n2", "in")
    graph.clear()
    assert len(graph.nodes) == 0
    assert len(graph.edges) == 0


def test_clear_resets_counter(graph):
    graph.add_node("node-a", {})
    graph.clear()
    nid = graph.add_node("node-b", {})
    assert nid == "n1"


def test_get_state(graph):
    graph.add_node("imagen-4-generate", {"model": "v1"})
    graph.add_node("seedvr2-upscale", {"factor": 2})
    graph.connect("n1", "image", "n2", "image")
    state = graph.get_state()
    assert len(state["nodes"]) == 2
    assert len(state["edges"]) == 1


def test_to_execute_format(graph):
    graph.add_node("imagen-4-generate", {"model": "v1"})
    nodes, edges = graph.to_execute_format()
    assert len(nodes) == 1
    assert nodes[0]["id"] == "n1"
    assert nodes[0]["definitionId"] == "imagen-4-generate"
    assert nodes[0]["params"] == {"model": "v1"}
    assert nodes[0]["outputs"] == {}


def test_save_and_load(graph, tmp_path):
    graph.add_node("node-a", {"x": 1})
    graph.add_node("node-b", {"y": 2})
    graph.connect("n1", "out", "n2", "in")

    filepath = tmp_path / "test_graph.json"
    graph.save(filepath)

    new_graph = CLIGraph()
    new_graph.load(filepath)
    assert len(new_graph.nodes) == 2
    assert len(new_graph.edges) == 1
    assert new_graph.nodes["n1"]["params"] == {"x": 1}
