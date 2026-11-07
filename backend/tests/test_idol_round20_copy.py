"""PR #203 round 20, section 1: GM r39's words, and r40 where it rewrote them.

1. The Idol agent stop: its own card body for the person (r39 item 1), its
   own body when the click came from a tab not connected as the person (r40
   item 5), and the agents' text.
2. A folder where the settings file goes (r39 item 2).
3. Settings not restored (r39 item 3; r40 item 3 for any other cause).
5. A needs or route bubble says its first sentence (r39 item 5).
7. Agents read a size value as they send it back, its size after it:
   "768sq (768 × 768)" (r39, MCP size).
8. A renamed node's own card line names it by its name (r39 item 8).
"""
from __future__ import annotations

import errno
from pathlib import Path

import main
from execution.engine import validate_graph
from handlers import speridlabs_idol
from models.graph import GraphNode
from services import node_route
from services.node_registry import NodeRegistry

# -- 1: the stop ------------------------------------------------------------------------------

def test_the_stops_words_are_gms():
    assert speridlabs_idol.AGENT_STOP_PERSON == (
        "An agent’s run stopped here because this node could bill your Hugging Face account, and only you can "
        "start that. Run the node yourself to go ahead.")
    assert speridlabs_idol.TAB_STOP_PERSON == (
        "This node could bill your Hugging Face account, so only you can run it. You can run it when this tab is "
        "connected as you.")
    assert speridlabs_idol.agent_stop_text("Chair splat") == (
        "“Chair splat” wasn’t run. Nodes that call Hugging Face with the person’s token can bill their account, so "
        "only the person can run them. Ask them to run “Chair splat”, or carry on without it.")


# -- 2 and 3: settings ------------------------------------------------------------------------

def test_a_folder_in_the_way_says_gms_line():
    assert main.SETTINGS_IN_THE_WAY["person"].format(folder="~/.nebula/settings.json") == (
        "Nothing was saved because ~/.nebula/settings.json is a folder, and Nebula needs to put a file there. "
        "Move or rename that folder, then try again.")


def test_not_restored_says_gms_line_by_cause(tmp_path):
    from services import settings

    where = tmp_path / "settings.json"
    blocked = settings.NotRestored(where, PermissionError(errno.EACCES, "denied"))
    assert main.settings_not_restored_line(blocked) == (
        f"Nebula has a saved copy of your settings but couldn’t put it back, because it isn’t allowed to change "
        f"{settings.shown_path(where)}. It’ll try again the next time Nebula starts.")
    full = settings.NotRestored(where, OSError(errno.ENOSPC, "full"))
    assert main.settings_not_restored_line(full) == (
        "Nebula has a saved copy of your settings but couldn’t put it back. It’ll try again the next time Nebula "
        "starts.")


# -- 7: a size as agents send it back ----------------------------------------------------------

def _flux3() -> dict:
    return NodeRegistry().get_all()["flux-3-image"]


def test_agents_read_a_size_value_with_its_size_after_it():
    keys = {"FAL_KEY": "fal-test-fake", "REPLICATE_API_TOKEN": "r8-test-fake"}
    message = node_route.route_unavailable(_flux3(), {"_provider": "fal", "resolution": "1.5k"}, keys)["message"]
    assert "Pick 768sq (768 × 768), 1k, 2k or 4k" in message, message
    # A value whose label isn't a size is sent as it is.
    assert "1k (" not in message and "4k (" not in message


def test_a_size_label_is_added_only_where_the_label_is_a_size():
    param = {"options": [{"value": "768sq", "label": "768 × 768"}, {"value": "hd", "label": "HD (720p)"},
                         {"value": "1k", "label": "1K"}]}
    assert node_route._agent_value(param, "768sq") == "768sq (768 × 768)"
    assert node_route._agent_value(param, "hd") == "hd"
    assert node_route._agent_value(param, "1k") == "1k"


# -- 8 and 5: a renamed node's card and bubble agree --------------------------------------------

def test_a_renamed_nodes_own_card_line_names_it():
    keys = {"FAL_KEY": "fal-test-fake", "REPLICATE_API_TOKEN": "r8-test-fake"}
    nodes = [GraphNode(id="n1", definitionId="flux-3-image",
                       params={"_provider": "fal", "resolution": "1.5k"})]
    renamed = validate_graph(nodes, [], keys, name_of=lambda _id: "Hero shot")
    [line] = [error.person for error in renamed if error.person and not error.port_id]
    assert line.startswith("“Hero shot” can’t run on fal.ai with “Resolution” set to 1.5K."), line
    assert "FLUX 3 Image" not in line
    # Not renamed: its type's name, as before.
    plain = validate_graph(nodes, [], keys, name_of=lambda _id: "FLUX 3 Image")
    [line] = [error.person for error in plain if error.person and not error.port_id]
    assert line.startswith("“FLUX 3 Image” can’t run on fal.ai"), line


def test_a_needs_bubble_says_its_first_sentence():
    main.cli_graph.nodes["n-r20"] = {"definitionId": "flux-3-image", "label": "Hero shot"}
    try:
        line = "“FLUX 3 Image” can’t run on fal.ai with “Resolution” set to 1.5K. Pick 1K, or switch to Replicate."
        assert main._bubble_line("n-r20", line) == "“Hero shot” can’t run on fal.ai with “Resolution” set to 1.5K."
    finally:
        main.cli_graph.nodes.pop("n-r20", None)


def test_the_bubble_wraps_to_two_lines_before_any_cut():
    css = (Path(main.__file__).resolve().parents[1] / "frontend/src/styles/agentCursor.css").read_text()
    block = css.split(".agent-cursor__say {", 1)[1].split("}", 1)[0]
    for rule in ("white-space: normal", "-webkit-line-clamp: 2", "overflow-wrap: break-word"):
        assert rule in block, rule
