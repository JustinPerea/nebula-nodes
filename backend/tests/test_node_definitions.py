import json
from pathlib import Path

import pytest

NODE_DEFS_PATH = Path(__file__).parent.parent / "data" / "node_definitions.json"


@pytest.fixture(scope="module")
def definitions():
    with open(NODE_DEFS_PATH) as f:
        return json.load(f)


def test_remotion_node_definition_exists(definitions):
    assert "remotion-node" in definitions, "remotion-node entry missing"
    entry = definitions["remotion-node"]
    assert entry["id"] == "remotion-node"
    assert entry["displayName"] == "Remotion Composition"
    assert entry["category"] == "utility"
    assert entry["apiProvider"] == "utility"
    assert entry["executionPattern"] == "async-poll"


def test_remotion_node_ports(definitions):
    entry = definitions["remotion-node"]
    # Multi-input port for upstream TrackItem sources
    assert len(entry["inputPorts"]) == 1
    assert entry["inputPorts"][0]["id"] == "sources"
    assert entry["inputPorts"][0]["dataType"] == "Any"
    assert entry["inputPorts"][0]["required"] is False
    # Single Video output for downstream consumers
    assert len(entry["outputPorts"]) == 1
    assert entry["outputPorts"][0]["id"] == "video"
    assert entry["outputPorts"][0]["dataType"] == "Video"

