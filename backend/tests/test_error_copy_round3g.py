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
Item 1's interim Delete-key confirm is gone: undo puts back everything a
delete removed (tests/test_undo_restores_deletes.py). What agents read
(exception texts, a validation error's message) doesn't change.
"""
from __future__ import annotations

import ast
import json


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
        "The connection into “Prompt” brings something it can't take. Remove that connection, then connect a matching output.")
    # The label exactly as the node shows it, its note included (a quoted
    # label may hold parentheses, 3f judgment 11).
    mask = {"id": "mask", "label": "Mask (white = edit)"}
    assert port_contracts._wrong_kind_line(mask, "mask").startswith("The connection into “Mask (white = edit)” brings ")
    assert port_contracts._too_many_line(prompt, "prompt", 1) == (
        "“Prompt” takes one connection. Remove the extra one, then run the node again.")
    images = {"id": "images", "label": "Images (1-4)"}
    assert port_contracts._too_many_line(images, "images", 4) == (
        "“Images (1-4)” takes up to 4 connections. Remove the extra ones, then run the node again.")
    assert port_contracts.PORT_TYPE_PERSON_HINTS[("krea-2-generate", "moodboard")] == (
        "“Moodboard” takes a Nebula moodboard now. To use a Krea moodboard, put its ID in “Moodboard ID” and "
        "remove the connection.")
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
