import json
from pathlib import Path

NODE_DEFS_PATH = Path(__file__).parent.parent / "data" / "node_definitions.json"

def test_remotion_node_definition_exists():
    with open(NODE_DEFS_PATH) as f:
        defs = json.load(f)
    assert "remotion-node" in defs, "remotion-node entry missing"
    entry = defs["remotion-node"]
    assert entry["id"] == "remotion-node"
    assert entry["displayName"] == "Remotion Composition"
    assert entry["category"] == "utility"
    assert entry["apiProvider"] == "utility"
    assert entry["executionPattern"] == "async-poll"

def test_remotion_node_ports():
    with open(NODE_DEFS_PATH) as f:
        defs = json.load(f)
    entry = defs["remotion-node"]
    # Multi-input port for upstream TrackItem sources
    assert len(entry["inputPorts"]) == 1
    assert entry["inputPorts"][0]["id"] == "sources"
    assert entry["inputPorts"][0]["dataType"] == "Any"
    assert entry["inputPorts"][0]["required"] is False
    # Single Video output for downstream consumers
    assert len(entry["outputPorts"]) == 1
    assert entry["outputPorts"][0]["id"] == "video"
    assert entry["outputPorts"][0]["dataType"] == "Video"

