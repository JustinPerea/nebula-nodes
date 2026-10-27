"""Error copy round 3c, part 2: Nebula's own run lines show again (GM - Design).

3c made every node run error with no person line read GM's general line with
the raw text behind "Details". That hid the lines Nebula already wrote for the
person ("No mask painted yet — open the Mask Painter node and paint one", the
route wiring lines, Meshy's Smart Topology line ...). GM's guard: "provider
run errors often carry the one fact the person needs ... Don't let the
general fallback hide them." A line Nebula wrote for the person is a written
line, so each such raise carries it as its person line (``as_person_line``
when the text already is that line, ``with_person_line`` with id-free words
when the text names ids, paths, parameter keys or env vars).

What agents, MCP, the run record and the journal read is the exception text,
and none of it changes: the tests assert the exact texts beside the lines.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any

import pytest

from execution.engine import execute_graph
from execution.error_classifier import classify_error
from execution.person_line import person_line
from models.events import ErrorEvent
from models.graph import GraphNode, PortValueDict

BACKEND = Path(__file__).resolve().parent.parent


def _node(definition_id: str, params: dict[str, Any] | None = None, *, node_id: str = "n1") -> GraphNode:
    return GraphNode(id=node_id, definitionId=definition_id, params=params or {}, outputs={})


def _port(value: Any, port_type: str = "Text") -> PortValueDict:
    return PortValueDict(type=port_type, value=value)


def _raised(fn, *args, **kwargs) -> BaseException:
    with pytest.raises(Exception) as info:
        fn(*args, **kwargs)
    return info.value


async def _araised(fn, *args, **kwargs) -> BaseException:
    with pytest.raises(Exception) as info:
        await fn(*args, **kwargs)
    return info.value


async def _run_one(node: GraphNode) -> ErrorEvent:
    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    await execute_graph(nodes=[node], edges=[], api_keys={}, handler_registry={}, emit=emit, run_id=None)
    [error] = [event for event in events if isinstance(event, ErrorEvent)]
    return error


# -- the mechanism -------------------------------------------------------------


def test_as_person_line_marks_the_text_as_the_persons_line_and_changes_nothing() -> None:
    from execution.person_line import as_person_line

    original = ValueError("Prompt input is required")
    marked = as_person_line(original)
    assert marked is original
    assert str(marked) == "Prompt input is required"
    assert person_line(marked) == "Prompt input is required"


# -- Nebula's own lines, word for word, and the card's line beside them --------


@pytest.mark.asyncio
async def test_a_mask_painter_with_no_mask_shows_its_own_line() -> None:
    error = await _run_one(_node("mask-painter"))
    assert error.error == "No mask painted yet — open the Mask Painter node and paint one"
    # Round 3f: GM's rules (no dash, a final period) on the card; agents keep the text.
    assert error.person == "No mask is painted yet. Open the Mask Painter node and paint one, then run the node again."


def test_a_batch_over_its_cap_says_so_in_the_cards_words() -> None:
    # The run's own check (the engine's fan-out); before a run the same text
    # is a validation line (_iterator_validation_errors), shown as it is.
    from execution.engine import _batch_items

    exc = _raised(_batch_items, {"items_text": "a\nb\nc", "batch_size_cap": 2})
    assert str(exc) == ("Batch has 3 items, exceeding its batch_size_cap of 2. "
                        "Reduce the list or raise the cap before running; no generation was started.")
    assert person_line(exc) == ("This Batch has 3 items, more than its “Item cap” of 2. Remove items or raise "
                            "the cap, then run it again. Nothing was generated.")


def test_a_fan_out_over_its_cap_names_the_cap_by_its_nodes_own_label() -> None:
    # A Batch downstream of another fan-out can go over its cap only in all
    # contexts together; its field is "Item cap", an iterator's "Batch Size Cap".
    from execution.engine import _fanout_over_cap

    exc = _fanout_over_cap("batch", 12, 10)
    assert str(exc) == ("Nested iterator expands to 12 items, exceeding this iterator's batch_size_cap of 10. "
                        "Reduce the batch before running; no downstream generation was started.")
    assert person_line(exc) == ("This Batch would make 12 items, more than its “Item cap” of 10. Make the batch "
                                "smaller, then run it again. Nothing after it was generated.")
    exc = _fanout_over_cap("iterator-image", 12, 10)
    assert person_line(exc) == ("This iterator would make 12 items, more than its “Batch Size Cap” of 10. Make "
                                "the batch smaller, then run it again. Nothing after it was generated.")


@pytest.mark.asyncio
async def test_the_openai_routes_reference_count_is_the_persons_line(tmp_path) -> None:
    from execution.maker_routes_openai import MAX_REFERENCE_IMAGES, local_images

    exc = await _araised(local_images, ["https://example.com/a.png"] * (MAX_REFERENCE_IMAGES + 4), tmp_path)
    assert str(exc) == f"OpenAI image edits take up to {MAX_REFERENCE_IMAGES} images; got {MAX_REFERENCE_IMAGES + 4}"
    assert person_line(exc) == (f"OpenAI image edits take up to {MAX_REFERENCE_IMAGES} images, and "
                                f"{MAX_REFERENCE_IMAGES + 4} are connected.")


def test_the_route_wiring_lines_are_the_persons_lines() -> None:
    from execution import route_clients

    # A real caller's `where`: the provider's id for the agents' text, the
    # node's name on its provider for the person's line.
    where = route_clients.Where("Replicate's black-forest-labs/flux-3", "FLUX 3 Video on Replicate")
    exc = _raised(route_clients.replicate_input, {}, {}, where)
    assert str(exc) == "Replicate's black-forest-labs/flux-3 needs a prompt"
    assert person_line(exc) == "FLUX 3 Video on Replicate needs a prompt. Connect one, then run the node again."

    where = route_clients.Where("fal.ai's fal-ai/kling-video/v2.1", "Kling 2.1 on fal.ai")
    exc = _raised(route_clients.refuse_unwired, {"start_image": _port("a.png", "Image")}, {"prompt"}, where)
    assert str(exc) == ("fal.ai's fal-ai/kling-video/v2.1 can't take the connected start_image. "
                        "Disconnect it or choose another provider.")
    assert person_line(exc) == ("Kling 2.1 on fal.ai can't take the connected start image. "
                                "Disconnect it or choose another provider.")

    exc = _raised(route_clients.one_value, {"start_image": _port(["a.png", "b.png"], "Image")}, "start_image", where)
    assert str(exc) == "fal.ai's fal-ai/kling-video/v2.1 takes one start_image, but 2 are connected"
    assert person_line(exc) == "Kling 2.1 on fal.ai takes one start image, but 2 are connected. Disconnect the extra ones."

    # A plain string from a caller with no person form never reaches the card.
    exc = _raised(route_clients.replicate_input, {}, {}, "Replicate's owner/model")
    assert person_line(exc) == "This node needs a prompt. Connect one, then run the node again."


def test_meshys_smart_topology_lines_are_the_persons_lines() -> None:
    from handlers.meshy import check_model_options, check_smart_topology

    exc = _raised(check_smart_topology, {"model_type": "smart-topology", "topology": "quad"})
    assert str(exc) == "Smart Topology makes triangles only. Set Topology to Triangle."
    assert person_line(exc) == "Smart Topology makes triangles only. Set “Topology” to Triangle."
    exc = _raised(check_model_options, {"ai_model": "meshy-6-lite", "hd_texture": True})
    assert str(exc) == "Meshy 6 Lite makes 2K textures only. Turn off HD Texture (4K) or pick another model."
    assert person_line(exc) == "Meshy 6 Lite makes 2K textures only. Turn off “HD Texture (4K)” or pick another model."


def test_the_elevenlabs_dialogue_script_lines_are_the_persons_lines() -> None:
    from handlers.elevenlabs import parse_dialogue_script

    exc = _raised(parse_dialogue_script, "  ")
    assert str(exc) == "The dialogue script is empty. Write one line per turn, e.g. 'Rachel: Hello.' then 'Adam: Hi!'"
    assert person_line(exc) == ("The dialogue script is empty. Write one line per turn, each starting with a voice "
                                "name and a colon, like “Rachel: Hello.”")
    exc = _raised(parse_dialogue_script, "Rachel:")
    assert str(exc) == "Dialogue line 1 (Rachel) has no text after the colon."
    # Round 3d: no parentheses in a person line (GM).
    assert person_line(exc) == "Dialogue line 1 has no text after the colon. Add what Rachel says, then run the node again."


def test_kreas_node_app_image_count_is_the_persons_line() -> None:
    from handlers.krea_workspace import node_app_input

    schema = {"properties": {"image": {"type": "string", "format": "uri"}}}
    exc = _raised(node_app_input, schema, {}, ["a.png", "b.png"], None)
    assert str(exc) == "This node app takes 1 more image(s); 2 are connected"
    # Round 3d: no parentheses in a person line (GM).
    assert person_line(exc) == "This node app takes 1 more image, and 2 are connected. Disconnect the extra ones, then run the node again."


def test_runways_duration_line_is_the_persons_line() -> None:
    from handlers.runway import RUNWAY_VIDEO_MODELS, _video_duration

    spec = next(spec for spec in RUNWAY_VIDEO_MODELS.values() if not spec["auto"])
    exc = _raised(_video_duration, spec, "auto")
    assert str(exc).startswith(f"{spec['label']} has no automatic duration. Pick one of: ")
    assert person_line(exc).startswith(f"{spec['label']} has no automatic duration. Pick ")
    assert person_line(exc).endswith(" seconds in “Duration”.")


@pytest.mark.asyncio
async def test_a_missing_file_says_which_input_in_words_not_its_path() -> None:
    from handlers.runway import _local_media_uri

    exc = await _araised(_local_media_uri, "/no/such/clip.mp4", "video/mp4", None, "Video file")
    assert str(exc) == "Video file not found: /no/such/clip.mp4"
    assert person_line(exc) == "A connected video file can't be found. Connect it again, then run the node again."


@pytest.mark.asyncio
async def test_a_character_node_with_no_character_names_the_field_not_the_api() -> None:
    from handlers.character_node import handle_character_node

    exc = await _araised(handle_character_node, _node("character"), {}, {})
    assert str(exc) == "No character chosen: set character to a character id (GET /api/characters lists them)"
    assert person_line(exc) == "Choose a character in “Character”, then run it again."


# -- a missing key points at Settings, in the provider's own spelling ----------


@pytest.mark.parametrize(("text", "line"), [
    ("OPENAI_API_KEY is required", "Add your OpenAI API key in Settings, then run the node again."),
    ("FAL_KEY is required", "Add your fal.ai API key in Settings, then run the node again."),
    ("REPLICATE_API_TOKEN is required", "Add your Replicate API token in Settings, then run the node again."),
    ("ELEVENLABS_API_KEY or RUNWAY_API_KEY is required",
     "Add your ElevenLabs or Runway API key in Settings, then run the node again."),
    ("GOOGLE_VERTEX_CREDENTIALS is required",
     "Add your Google Vertex AI credentials in Settings, then run the node again."),
])
def test_a_missing_key_says_add_it_in_settings(text: str, line: str) -> None:
    from execution.missing_credential import MissingCredentialError

    exc = MissingCredentialError(text)
    assert str(exc) == text
    assert person_line(exc) == line
    # Before this round the card read the classifier's line for it, the wrong fix.
    assert classify_error(text)[1] == "The request was rejected as invalid. Check the node's inputs and parameters."


def test_every_key_settings_stores_has_a_name_for_the_line() -> None:
    from execution.missing_credential import MissingCredentialError
    from services.credential_catalog import CREDENTIAL_PROVIDERS

    for key in CREDENTIAL_PROVIDERS:
        line = person_line(MissingCredentialError(f"{key} is required"))
        assert line and line.startswith("Add ") and key not in line, key


def test_a_missing_key_message_of_another_shape_keeps_its_own_way() -> None:
    from execution.missing_credential import MissingCredentialError

    # Only the plain "<KEY> is required" shape is read; other texts write their own line.
    assert person_line(MissingCredentialError("This node has no route it can run on")) is None


# -- the guard: no hidden line comes back quietly --------------------------------


RUN_TIME_DIRS = ("handlers", "execution")
RUN_TIME_SERVICES = ("media_input", "qc_common", "qc_jev", "typesafe_client", "vision_llm",
                     "google_vertex", "quiver_client", "krea_mcp_generation", "edit_masks", "ffmpeg", "krea_account",
                     "nous_auth")
WRAPPERS = {"with_person_line", "as_person_line", "with_provider_line", "with_details_line"}
# Facts a raise attaches beside its text (round 3d, part 2): the guard reads
# the exception inside them.
MARKERS = {"with_api_status", "as_job_failure", "with_call_facts"}


def _peel(exc: ast.AST | None) -> tuple[ast.AST | None, ast.Call | None]:
    """(the exception call, its person-line wrapper) with the markers peeled off."""
    wrapper = None
    while isinstance(exc, ast.Call) and isinstance(exc.func, ast.Name) and exc.args and (
            exc.func.id in MARKERS or (exc.func.id in WRAPPERS and wrapper is None)):
        if exc.func.id in WRAPPERS:
            wrapper = exc
        exc = exc.args[0]
    return exc, wrapper


def _run_time_files() -> list[Path]:
    files = [path for folder in RUN_TIME_DIRS for path in sorted((BACKEND / folder).glob("*.py"))]
    return files + [BACKEND / "services" / f"{name}.py" for name in RUN_TIME_SERVICES]


def _template(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(part.value if isinstance(part, ast.Constant) else "{}" for part in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _template(node.left), _template(node.right)
        return None if left is None or right is None else left + right
    return None


def _raises(path: Path) -> list[tuple[bool, str, ast.Call, ast.Call | None]]:
    """(has a person line, text template, exception call, wrapper call) per literal raise."""
    found = []
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Raise):
            exc = node.exc
        elif isinstance(node, ast.Return):
            exc = node.value  # a helper that builds the exception it raises
        else:
            continue
        exc, wrapper = _peel(exc)
        if not isinstance(exc, ast.Call) or not exc.args:
            continue
        name = exc.func.id if isinstance(exc.func, ast.Name) else getattr(exc.func, "attr", "")
        if isinstance(node, ast.Return) and not name.endswith(("Error", "Exception")):
            continue
        text = _template(exc.args[0])
        if text is None:
            continue
        lined = wrapper is not None or (name == "MissingCredentialError"
                                        and re.fullmatch(r"(\{\}|[A-Z_]+)( or [A-Z_]+)* is required", text) is not None)
        found.append((lined, text, exc, wrapper))
    return found


# Raises in a run whose text has no person line: provider text and malformed
# provider answers (GM's general line, the raw text behind Details), timeouts
# the classifier names, moderation (its own card), developer-only states, and
# checks only an agent or an old saved graph can reach. The count may only go
# down. A new raise in Nebula's own words gets a line instead.
UNLINED_BASELINE: dict[str, int] = {
    "handlers/bfl.py": 8, "handlers/byteplus.py": 4, "handlers/cinema_scene.py": 6,
    "handlers/elevenlabs.py": 20, "handlers/fal_universal.py": 9, "handlers/gemini_omni.py": 8,
    "handlers/google_gemini.py": 9, "handlers/grok_video.py": 7, "handlers/higgsfield.py": 8,
    "handlers/ideogram.py": 12, "handlers/jev_box.py": 1, "handlers/jev_decide.py": 2, "handlers/krea.py": 18,
    "handlers/krea_export.py": 9, "handlers/krea_gateway.py": 27, "handlers/krea_workspace.py": 19,
    "handlers/meshy.py": 26, "handlers/minimax.py": 6, "handlers/minimax_v2.py": 5,
    "handlers/openai_audio.py": 3, "handlers/openai_image.py": 1, "handlers/openai_image_edit.py": 2,
    "handlers/openai_image_v2.py": 2, "handlers/openrouter.py": 1, "handlers/openrouter_media.py": 14,
    "handlers/qc_base.py": 1, "handlers/quiver.py": 6, "handlers/remotion_node.py": 5,
    "handlers/replicate_model.py": 12, "handlers/replicate_universal.py": 4, "handlers/runway.py": 11,
    "handlers/spatial.py": 12, "handlers/style_reference.py": 3, "handlers/veo.py": 10,
    "handlers/video_edit.py": 4, "handlers/worldlabs.py": 87, "handlers/xai_image.py": 2,
    "execution/async_poll_runner.py": 6, "execution/engine.py": 6, "execution/gating.py": 3,
    "execution/maker_routes.py": 5, "execution/maker_routes_byteplus.py": 4,
    "execution/maker_routes_byteplus_seedance.py": 3, "execution/maker_routes_elevenlabs.py": 1,
    "execution/maker_routes_google.py": 2, "execution/maker_routes_ideogram_runway.py": 3,
    "execution/maker_routes_minimax_meshy.py": 5, "execution/maker_routes_openai.py": 3,
    "execution/maker_routes_xai.py": 1, "execution/poll_retry.py": 1, "execution/route_clients.py": 4,
    "execution/stream_runner.py": 5, "execution/sync_runner.py": 4, "services/media_input.py": 3,
    "services/qc_common.py": 6, "services/qc_jev.py": 3, "services/typesafe_client.py": 23,
    "services/vision_llm.py": 8, "services/google_vertex.py": 2, "services/quiver_client.py": 9,
    # The 3c-2 review raised two by one: handlers/replicate_model.py's
    # model_path and maker_routes_google.py's Vertex Veo model check read
    # Nebula's route table, never the person, so they are developer-only and
    # their person lines (which named the ids) went.
    # Read by the guard from the 3c-2 review on. ffmpeg: tool output, timeouts
    # and developer-only input checks. krea_account: a schema mismatch and
    # malformed job answers. nous_auth: its internal _CredentialRejected
    # checks and the public sign-in errors, which the handler
    # (handlers/nous_portal.py) re-raises with the card's line.
    "services/ffmpeg.py": 6, "services/krea_account.py": 3, "services/nous_auth.py": 23,
    # krea_mcp_generation: Krea's MCP server contract (a tool or schema it
    # doesn't expose), malformed answers and job states.
    "services/krea_mcp_generation.py": 17,
    # Round 3d lowered fourteen, mostly paid jobs Nebula stopped waiting on
    # (GM's slow-job line) and Krea's lines 1-10.
    # The 3d review lowered minimax.py by one: its missing task id now reads
    # MiniMax's own code (a refused key or no balance gets the table's line),
    # and the exception is built before the raise, so the guard can't read
    # its text; tests/test_error_copy_round3d.py pins it.
    # Round 3d, part 2 lowered stream_runner.py by one: the image stream's
    # "ended without a final image event" is built before its raise, so the
    # card can give a fal.ai job still running GM's slow-job line;
    # tests/test_error_copy_round3d2.py pins its text.
}


def test_no_run_time_raise_in_nebulas_own_words_goes_without_a_person_line() -> None:
    counts = {str(path.relative_to(BACKEND)): sum(not lined for lined, *_ in _raises(path))
              for path in _run_time_files()}
    counts = {path: count for path, count in counts.items() if count}
    grown = {path: (count, UNLINED_BASELINE.get(path, 0)) for path, count in counts.items()
             if count > UNLINED_BASELINE.get(path, 0)}
    assert not grown, (
        "These files have more raises with no person line than before (now, baseline): "
        f"{grown}. The card hides an unlined run error behind GM's general line. A raise in "
        "Nebula's own words needs a line for the person (execution/person_line.py): "
        "raise as_person_line(ValueError(...)) when the text already is that line, or "
        "with_person_line(exc, line) with id-free words naming the node's field by its label. "
        "Provider text, developer-only states and moderation keep the fallback; only then raise "
        "UNLINED_BASELINE here, and say why in the PR.")
    shrunk = {path: (counts.get(path, 0), base) for path, base in UNLINED_BASELINE.items()
              if counts.get(path, 0) < base}
    assert not shrunk, f"Fewer unlined raises now (now, baseline): {shrunk}. Lower UNLINED_BASELINE to match."


FORBIDDEN_IN_A_LINE = re.compile(
    # snake_case ids and keys, a digit before the underscore too ("gen4_turbo").
    r"(?<![{\w])[a-z][a-z0-9]*_[a-z0-9_]+(?![}\w])|[A-Z]{2,}_[A-Z_]+|/api/|nebula trash|\bGET\b|"
    r"\{(?:path|file_path|image_value|img_str|audio_path|value|ref|raw|task_id|job_id|character_id|moodboard_id)\b|"
    # Round 3d (GM's rules: no ids, no parentheses in error copy): a provider's
    # kebab-case model id with a digit in it ("gpt-image-2", "k2-large"), a
    # dated one ("seedance-1-0-pro-250528"), one of the makers' id prefixes
    # with none ("grok-imagine-video", "fal-ai/..."), and a parenthesis.
    # English compounds ("speech-to-speech", "text-to-3D", "8-second") pass.
    r"\b[a-z][a-z0-9.]*(?:-[a-z0-9.]+)*-[a-z]*\d[a-z0-9.]*(?:-[a-z0-9.]+)*(?![\w-])|"
    r"\b[a-z]+\d[a-z0-9.]*(?:-[a-z0-9.]+)+(?![\w-])|\b[a-z0-9]+(?:-[a-z0-9]+)*-\d{6}\b|"
    r"\b(?:grok|fal|dreamina|seedance|seedream|kling|hailuo|imagen|flux|gpt|dall|krea|ltx|hunyuan|stability|"
    r"black|bytedance|minimax|veo|gemini|ideogram|recraft|luma|qwen|wan)-[a-z]|[()]|"
    # Round 3d, part 2: a capitalised id with a numbered segment
    # ("MiniMax-Hailuo-02", "MiniMax-Hailuo-2.3-Fast"; a maker's name and a
    # hyphen, "Gen-4 Turbo", is a model's own spelling and passes), a digitless
    # kebab id of three parts or more ("nano-banana-pro"; English compounds
    # joined by -to-, -and-, -of- pass: "speech-to-speech",
    # "first-and-last-frame"), and an owner/name id ("stability-ai/sdxl",
    # "owner/name"). A URL is the one fact some lines need, so the guard
    # reads a line with its URLs taken out (forbidden_in_a_line).
    r"\b[A-Z][A-Za-z0-9]*-[A-Za-z0-9.]+-\d[\d.]*(?:-[A-Za-z0-9.]+)*\b|"
    r"(?<![\w-])(?![a-z]+(?:-[a-z]+)*-(?:to|and|or|of|in|on|by|for|the)-)[a-z]+(?:-[a-z]+){2,}\b(?!-)|"
    r"\b[\w.-]+/[\w.-]+|"
    # Round 3f (GM's rule 5: "Never a param key, a port id or a code name
    # ('filePath param', 'Array input', 'CameraPose input')"): a camelCase
    # name that starts lowercase ("filePath"; "xAI" is the provider's own
    # spelling), "... param", a type's name ("CameraPose"), and a type's name
    # as an input ("Array input").
    r"\b(?!xAI\b)[a-z]+[A-Z][A-Za-z]*\b|\b\w+ param\b|\bCameraPose\b|"
    r"\b(?:Array|String|Number|Boolean|Object|SensorRig|SpatialContext) inputs?\b"
)

_URL = re.compile(r"https?://\S+")


def _labels_with_parentheses() -> list[str]:
    """Field labels the nodes show that carry a parenthesis ("Duration (ms)"):
    a line names a field by its label, so those may stand in one."""
    found: set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            label = value.get("label")
            if isinstance(label, str) and "(" in label:
                found.add(label)
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(json.loads((BACKEND / "data" / "node_definitions.json").read_text()))
    return sorted(found, key=len, reverse=True)


_FIELD_LABELS = _labels_with_parentheses()


def forbidden_in_a_line(line: str) -> re.Match[str] | None:
    """What a person line may not carry (FORBIDDEN_IN_A_LINE), a field's own
    label left aside."""
    for label in _FIELD_LABELS:
        line = line.replace(label, "")
    return FORBIDDEN_IN_A_LINE.search(_URL.sub("", line))


def test_no_person_line_names_an_id_a_path_a_parameter_key_or_an_env_var() -> None:
    for path in _run_time_files():
        if path.name == "worldlabs.py":
            continue  # 3c's lines, pinned by test_error_copy_round3c.py
        source = path.read_text()
        for lined, text, exc, wrapper in _raises(path):
            if wrapper is None:
                continue
            if wrapper.func.id == "as_person_line":
                line = text
            else:
                second = wrapper.args[1] if len(wrapper.args) > 1 else None
                line = ast.get_source_segment(source, second) if second is not None else ""
            assert line is not None
            if wrapper.func.id == "as_person_line":
                assert not forbidden_in_a_line(line), (path.name, line)
            else:
                literal = _template(second) if second is not None else None
                if literal is not None:
                    assert not forbidden_in_a_line(literal), (path.name, literal)


def test_no_person_line_goes_on_a_moderation_block() -> None:
    # A blocked run keeps its calmer card; a person line would replace it.
    for path in _run_time_files():
        for lined, text, _exc, wrapper in _raises(path):
            if wrapper is not None:
                assert classify_error(text.replace("{}", "x"))[0] != "blocked", (path.name, text)


# Nebula's own instruction around a provider's words: since round 3d the raise
# says so with with_provider_line, so the card keeps the instruction and puts
# the provider's words behind Details (GM: "Raw provider text stays behind
# Details in every case.").
def test_provider_text_keeps_gms_design() -> None:
    # A raise that carries the provider's own body or message keeps the
    # classifier's line or GM's general line, the raw text behind Details,
    # unless its line is a with_provider_line, which keeps Details too.
    # (A status code isn't the provider's text: a line may leave it out.)
    provider = re.compile(r"\{[^}]*(\.text\b|\bbody\b|_error_detail|error_body|\bdetail\b|\bexc\b|\.json\(\)|\.message\b)[^}]*\}")
    for path in _run_time_files():
        source = path.read_text()
        for _lined, _text, exc, wrapper in _raises(path):
            if wrapper is None or wrapper.func.id == "with_provider_line":
                continue
            literal = ast.get_source_segment(source, exc.args[0]) or ""
            assert not provider.search(literal), (path.name, literal)


# -- the Cinema shot carries the card's fields beside the agents' text ---------


@pytest.mark.asyncio
async def test_a_failed_shot_keeps_the_agents_text_and_carries_the_cards_fields(monkeypatch, run_shot_task) -> None:
    from main import cli_graph

    cli_graph.nodes["n1"] = {"id": "n1", "definitionId": "cinema-scene", "outputs": {},
                             "params": {"scene": {"shots": [{"id": "b", "output": {"status": "done"}}]}}}

    async def fake_execute_graph(**kwargs):
        await kwargs["emit"](ErrorEvent(node_id="upstream", error="No mask painted yet — open the Mask Painter node "
                                        "and paint one", category="unknown",
                                        friendly="No mask painted yet — open the Mask Painter node and paint one",
                                        person="No mask painted yet — open the Mask Painter node and paint one"))

    async def nothing(*_args, **_kwargs):
        return None

    monkeypatch.setattr("main.execute_graph", fake_execute_graph)
    monkeypatch.setattr("main._emit_and_sync", nothing)
    monkeypatch.setattr("main._broadcast_graph_sync", nothing)
    try:
        await run_shot_task(GraphNode(id="n1", definitionId="cinema-scene",
                                      params={"scene": {"shots": [{"id": "b"}]}}), "b")
        [shot] = cli_graph.nodes["n1"]["params"]["scene"]["shots"]
        assert shot["output"]["error"] == "No mask painted yet — open the Mask Painter node and paint one"
        assert shot["output"]["errorPerson"] == "No mask painted yet — open the Mask Painter node and paint one"
        assert shot["output"]["errorCategory"] == "unknown"
    finally:
        cli_graph.nodes.pop("n1", None)


@pytest.mark.asyncio
async def test_a_shot_that_failed_on_an_unknown_provider_error_keeps_the_raw_text_for_details(monkeypatch, run_shot_task) -> None:
    from main import cli_graph

    raw = "FAL submit failed (500): " + "x" * 300
    cli_graph.nodes["n1"] = {"id": "n1", "definitionId": "cinema-scene", "outputs": {},
                             "params": {"scene": {"shots": [{"id": "b", "output": {
                                 "status": "error", "error": "old", "errorPerson": "An old line."}}]}}}

    async def fake_execute_graph(**kwargs):
        category, friendly, _ = classify_error(raw)
        await kwargs["emit"](ErrorEvent(node_id="upstream", error=raw, category=category, friendly=friendly))

    async def nothing(*_args, **_kwargs):
        return None

    monkeypatch.setattr("main.execute_graph", fake_execute_graph)
    monkeypatch.setattr("main._emit_and_sync", nothing)
    monkeypatch.setattr("main._broadcast_graph_sync", nothing)
    try:
        await run_shot_task(GraphNode(id="n1", definitionId="cinema-scene",
                                      params={"scene": {"shots": [{"id": "b"}]}}), "b")
        [shot] = cli_graph.nodes["n1"]["params"]["scene"]["shots"]
        output = shot["output"]
        # Agents read what they read before, word for word (the classifier's cut).
        assert output["error"] == raw[:140]
        assert output["errorCategory"] == "unknown"
        assert output["errorRaw"] == raw
        # A line from an earlier failure doesn't stay.
        assert "errorPerson" not in output
    finally:
        cli_graph.nodes.pop("n1", None)


# -- "paid-provider" leaves what the person reads --------------------------------


def test_the_recovery_warnings_say_world_labs_not_paid_provider() -> None:
    source = (BACKEND / "main.py").read_text()
    strings = [node.value for node in ast.walk(ast.parse(source))
               if isinstance(node, ast.Constant) and isinstance(node.value, str)]
    assert not [text for text in strings if "paid-provider recovery ID" in text]
    assert any("Nebula captured this World Labs recovery ID but couldn't" in text for text in strings)


# -- a whole-scene run's failed shot carries the same fields --------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("make, person, category", [
    # Round 3d: a provider's 5xx reads the status table's line, naming the
    # provider the shot's base called (tests/test_error_copy_round3d.py); the
    # status is the one the raise attached (round 3d, part 2).
    (lambda: __import__("execution.person_line", fromlist=["with_api_status"]).with_api_status(
        ValueError("FAL submit failed (500): upstream exploded"), 500),
     "fal.ai is having trouble right now. Try again in a few minutes.", "unknown"),
    (lambda: __import__("execution.person_line", fromlist=["as_person_line"]).as_person_line(
        ValueError("The prompt is empty. Write one, then run the node again.")),
     "The prompt is empty. Write one, then run the node again.", "unknown"),
])
async def test_a_scene_runs_failed_shot_reads_like_the_node_card(monkeypatch, make, person, category) -> None:
    import handlers.cinema_scene as cinema_scene

    exc = make()

    async def boom(node, inputs, api_keys):
        raise exc

    class _AnyKey(dict):
        def get(self, _key, _default=None):
            return boom

    monkeypatch.setattr(cinema_scene, "get_handler_registry", lambda emit=None: _AnyKey(), raising=False)
    import execution.sync_runner as sync_runner
    monkeypatch.setattr(sync_runner, "get_handler_registry", lambda emit=None: _AnyKey())

    scene = {"version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9",
             "shots": [{"id": "bad", "prompt": "a shot"}]}
    await cinema_scene.handle_cinema_scene(GraphNode(id="scene1", definitionId="cinema-scene",
                                                     params={"scene": scene}),
                                           inputs={}, api_keys={"FAL_KEY": "x"}, emit=None)
    output = scene["shots"][0]["output"]
    # Agents read the exception text, word for word, as before.
    assert output["error"] == str(exc)
    assert output["status"] == "error"
    assert output["errorCategory"] == category
    assert output["errorRaw"] == str(exc)
    assert output.get("errorPerson") == person


# -- the review's fixes (3c-2 review) ------------------------------------------


def test_quivers_own_credits_and_key_lines_reach_the_card() -> None:
    from handlers.quiver import _wrap_provider_error
    from services.quiver_client import (QuiverAuthError, QuiverInsufficientCreditsError,
                                        QuiverRateLimitError, QuiverServerError)

    credits = _wrap_provider_error(QuiverInsufficientCreditsError("402 from QuiverAI", status_code=402))
    assert str(credits) == "Insufficient QuiverAI credits — top up or upgrade plan"
    assert person_line(credits) == "Your QuiverAI account is out of credits. Add credits, then run the node again."
    auth = _wrap_provider_error(QuiverAuthError("401 from QuiverAI", status_code=401))
    assert str(auth) == "QuiverAI auth failed — check QUIVER_API_KEY"
    assert person_line(auth) == "Add your QuiverAI API key in Settings, then run the node again."
    # The classifier's own line for a rate limit, and provider text, keep GM's design.
    assert person_line(_wrap_provider_error(QuiverRateLimitError("429", status_code=429))) is None
    assert person_line(_wrap_provider_error(QuiverServerError("upstream exploded", status_code=502))) is None


def test_the_edit_mask_lines_are_the_persons_lines(tmp_path, monkeypatch) -> None:
    from services import edit_masks

    exc = _raised(edit_masks._open, b"not an image", "The mask")
    assert str(exc) == "The mask isn't a PNG, JPEG, WebP or GIF image Nebula can read"
    assert person_line(exc) == "The mask isn't a PNG, JPEG, WebP or GIF image Nebula can read."
    monkeypatch.setattr(edit_masks, "require_allowed_path", lambda path: Path(path))
    not_an_image = tmp_path / "edit.png"
    not_an_image.write_bytes(b"not an image")
    exc = _raised(edit_masks.image_size, not_an_image)
    assert str(exc) == ("The image to edit isn't a PNG, JPEG, WebP or GIF file Nebula can read, "
                        "so its mask can't be sized to it")
    assert person_line(exc) == str(exc) + "."


def test_the_guard_reads_the_edit_mask_service() -> None:
    assert BACKEND / "services" / "edit_masks.py" in _run_time_files()


@pytest.mark.asyncio
@pytest.mark.parametrize("make, line", [
    (lambda nous: nous.NousNotAuthenticatedError(
        "No Nous Portal credential found in any Hermes profile. Run `hermes model` and select Nous Portal — it "
        "OAuths in the browser and writes the credential into your active Hermes profile (or ~/.hermes/auth.json). "
        "(Last path checked: /fixture/auth.json)"),
     "Nous Portal isn't signed in. Run `hermes model` in a terminal, choose Nous Portal, then run the node again."),
    (lambda nous: nous.NousCredentialExpiredError(
        "All discovered Nous Portal inference credentials are expired. Run `hermes model` and select Nous Portal "
        "to refresh them."),
     "Your Nous Portal sign-in has expired. Run `hermes model` in a terminal, choose Nous Portal, "
     "then run the node again."),
    (lambda nous: nous.NousCredentialInvalidError(
        "No usable Nous Portal inference credential passed local validation (fixture). Run `hermes model` and "
        "select Nous Portal to refresh."),
     "Nous Portal's saved sign-in can't be used. Run `hermes model` in a terminal, choose Nous Portal, "
     "then run the node again."),
    # The process override is a developer's setting: it keeps the general line.
    (lambda nous: nous.NousCredentialInvalidError("NOUS_INFERENCE_BASE_URL is unsafe: fixture."), None),
])
async def test_a_nous_portal_node_with_no_sign_in_says_how_to_sign_in(monkeypatch, make, line) -> None:
    import handlers.nous_portal as nous_portal
    import services.nous_auth as nous

    cause = make(nous)

    def refuse():
        raise cause

    monkeypatch.setattr(nous_portal, "load_nous_credential", refuse)
    exc = await _araised(nous_portal.handle_nous_portal_universal, _node("nous-portal-universal"), {}, {})
    assert str(exc) == str(cause)
    assert person_line(exc) == line


def test_a_replicate_result_of_another_type_says_to_pick_the_model_again(monkeypatch) -> None:
    import handlers.replicate_universal as replicate_universal
    from services import universal_ports

    monkeypatch.setattr(universal_ports, "declared_output",
                        lambda *_: {"id": "text", "dataType": "Text"})
    monkeypatch.setattr(universal_ports, "untyped_output_stamp", lambda *_: False)
    node = _node("replicate-universal", {"model_id": "acme/clipmaker"})
    exc = _raised(replicate_universal._fill_declared_port, node, "https://replicate.delivery/x/out.png", "pred-1")
    assert str(exc) == (
        "acme/clipmaker returned an Image file, but this node's output `text` is Text (typed from the model's "
        "data before the run; if the model changed, pick it again (or set its model_id again) to re-read its "
        "ports), so nothing was passed on. The result is still on Replicate (prediction pred-1).")
    assert person_line(exc) == (
        "The model returned an image file, but this node's output is set to text, so nothing was passed on. "
        "Pick the model again in “Model ID” to re-read its outputs, then run the node again.")

    monkeypatch.setattr(universal_ports, "declared_output",
                        lambda *_: {"id": "image", "dataType": "Image", "typeUnconfirmed": True})
    exc = _raised(replicate_universal._fill_declared_port, node, "just some words", None)
    assert str(exc).startswith("acme/clipmaker returned text (Text), not a file, but this node's output `image` is "
                               "Image (")
    assert person_line(exc) == (
        "The model returned text, but this node's output is set to image, so nothing was passed on. "
        "Pick the model again in “Model ID” to re-read its outputs, then run the node again.")


def _route(definition_id: str, route_id: str) -> dict[str, Any]:
    from execution import maker_routes

    return next(route for route in maker_routes.definition_for(definition_id)["routes"] if route["id"] == route_id)


ID_IN_A_LINE = re.compile(r"/|(?<![{\w])[a-z0-9]+_[a-z0-9_]+(?![}\w])|\b[a-z0-9]+-[a-z0-9-]+\b")


@pytest.mark.asyncio
@pytest.mark.parametrize("route_id, endpoint, wired, text, line", [
    ("replicate", None, {}, "Replicate's black-forest-labs/flux-3 needs a prompt",
     "FLUX 3 Video on Replicate needs a prompt. Connect one, then run the node again."),
    ("bfl", None, {}, "Black Forest Labs' flux-3-video needs a prompt",
     "FLUX 3 Video on Black Forest Labs needs a prompt. Connect one, then run the node again."),
    ("openrouter", None, {}, "OpenRouter's black-forest-labs/flux-3-video needs a prompt",
     "FLUX 3 Video on OpenRouter needs a prompt. Connect one, then run the node again."),
    ("fal", None, {"prompt": _port("p"), "end_image": _port("https://e.com/b.png", "Image")},
     "fal.ai's blackforestlabs/flux-3/text-to-video can't take the connected end_image. Disconnect it or choose "
     "another provider.",
     "FLUX 3 Video on fal.ai can't take the connected end image. Disconnect it or choose another provider."),
    ("fal", "blackforestlabs/flux-3/edit-video",
     {"prompt": _port("p"), "start_video": _port("https://e.com/a.mp4", "Video"),
      "video": _port("https://e.com/b.mp4", "Video")},
     "fal.ai's blackforestlabs/flux-3/edit-video takes one source for video_url; disconnect one of the connected inputs",
     "FLUX 3 Video on fal.ai takes one source video, but the start video and the video are both connected. "
     "Disconnect one."),
    ("fal", "blackforestlabs/flux-3/keyframes-to-video", {"prompt": _port("p"), "keyframes": _port(["a.png"], "Image")},
     "fal.ai's blackforestlabs/flux-3/keyframes-to-video needs a set duration in seconds to place its keyframes "
     "(got 'auto')",
     "FLUX 3 Video on fal.ai needs a number of seconds to place its keyframes. Set “Duration”, "
     "then run it again."),
    ("krea", None, {"prompt": _port("p"), "end_image": _port("https://e.com/b.png", "Image")},
     "Krea's krea-video-black-forest-labs-flux-3-video needs a start image (or keyframes) to end on an end image",
     "FLUX 3 Video on Krea needs a start image or keyframes to end on an end image."),
])
async def test_a_route_runs_lines_name_the_node_and_provider_not_their_ids(route_id, endpoint, wired, text,
                                                                           line) -> None:
    from execution import route_clients

    route = _route("flux-3-video", route_id)
    params = {"duration": "auto"} if endpoint and "keyframes" in endpoint else {}
    node = _node("flux-3-video", params)
    run = route_clients.ROUTE_CLIENTS[route["handler"]].run
    exc = await _araised(run, node, wired, {}, route=route, endpoint=endpoint)
    assert str(exc) == text
    assert person_line(exc) == line
    assert not ID_IN_A_LINE.search(line), line


def test_no_route_line_puts_the_raw_where_or_a_value_on_the_card() -> None:
    # `where` names the provider's model or endpoint id. Every refusal goes
    # through refuse(where, text, person): the card reads `where.person` (the
    # node's name on its provider) and the tail in words, never a field key
    # or a value the run was given (a size, a duration).
    path = BACKEND / "execution" / "route_clients.py"
    source = path.read_text()
    calls = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Name) and node.func.id == "refuse"]
    assert len(calls) >= 15
    for call in calls:
        tail = call.args[2] if len(call.args) > 2 else call.args[1]
        template = _template(tail)
        assert template is not None, ast.get_source_segment(source, call)
        assert not forbidden_in_a_line(template), template
        for part in ast.walk(tail):
            if isinstance(part, ast.FormattedValue):
                expression = ast.get_source_segment(source, part.value)
                assert expression not in {"where", "field", "endpoint", "model", "path", "key", "port"}, expression
                assert part.conversion != ord("r"), expression
    # And no raise in the file builds its card line from `where` itself.
    for _lined, _text, exc, wrapper in _raises(path):
        if wrapper is not None and wrapper.func.id == "as_person_line":
            assert not any(isinstance(part, ast.Name) and part.id == "where" for part in ast.walk(exc.args[0]))


@pytest.mark.asyncio
async def test_veos_model_lines_name_the_field_not_the_model_id() -> None:
    from handlers.veo import handle_veo

    exc = await _araised(handle_veo, _node("veo-3", {"model": "veo-9-nope"}), {}, {"GOOGLE_API_KEY": "fixture"})
    assert str(exc) == "'veo-9-nope' isn't a Veo 3.1 model"
    assert person_line(exc) == "Pick a Veo 3.1 model in “Model”, then run it again."

    exc = await _araised(handle_veo, _node("veo-3", {"model": "veo-3.1-lite-generate-001"}),
                         {"video": _port("https://e.com/v.mp4", "Video")}, {"GOOGLE_API_KEY": "fixture"})
    assert str(exc) == "Video extension requires Veo 3.1 or 3.1 Fast (got 'veo-3.1-lite-generate-001')"
    assert person_line(exc) == ("Extending a video takes Veo 3.1 or Veo 3.1 Fast. Pick one in “Model”, "
                                "or disconnect “Extend Video”.")


def test_a_route_tables_own_model_check_keeps_the_general_line() -> None:
    # The model comes from Nebula's route table, not from anything the person
    # set: a developer-only state, so the card keeps GM's general line.
    from handlers.replicate_model import model_path

    exc = _raised(model_path, "not-a-model")
    assert str(exc) == "Replicate model must be owner/name (got 'not-a-model')"
    assert person_line(exc) is None


def test_the_guard_reads_every_service_a_run_raises_from() -> None:
    files = _run_time_files()
    for name in ("krea_mcp_generation", "edit_masks", "ffmpeg", "krea_account", "nous_auth"):
        assert BACKEND / "services" / f"{name}.py" in files, name


def test_a_krea_connection_without_the_tool_says_so_without_its_name() -> None:
    from types import SimpleNamespace

    from services.krea_account import AccountTools

    tools = AccountTools(SimpleNamespace(tools={}), None)
    exc = _raised(tools.check, "generate_image", {})
    assert str(exc) == "Your Krea connection does not offer generate_image; nothing was sent"
    assert person_line(exc) == ("Your Krea connection doesn't offer what this node needs. Nothing was sent to Krea. "
                                "Choose another provider, or check the connection in Settings.")


@pytest.mark.asyncio
async def test_a_krea_upload_with_no_media_is_the_persons_line() -> None:
    from types import SimpleNamespace

    from services.krea_account import AccountTools

    exc = await _araised(AccountTools(SimpleNamespace(tools={}), None).upload, None, "  ")
    assert str(exc) == "Krea needs a media URL or a local file"
    assert person_line(exc) == "Krea needs a media link or a file. Connect one, then run the node again."


@pytest.mark.asyncio
async def test_a_video_with_no_video_track_says_so_in_words(monkeypatch, tmp_path) -> None:
    import json as _json

    from services import ffmpeg

    class _Proc:
        returncode = 0

        async def communicate(self):
            return _json.dumps({"format": {"duration": "1.0"}, "streams": [{"codec_type": "audio"}]}).encode(), b""

    async def spawn(*_args, **_kwargs):
        return _Proc()

    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"")
    monkeypatch.setattr(ffmpeg, "require_allowed_path", lambda path: Path(path))
    monkeypatch.setattr(ffmpeg, "_spawn_subprocess", spawn)
    exc = await _araised(ffmpeg.ffprobe_video, clip)
    assert str(exc) == "No video stream in source"
    assert person_line(exc) == ("The connected video has no video track Nebula can read. "
                                "Connect another video, then run the node again.")
