"""Error copy round 3c: a node run error for two readers (GM - Design).

GM, verbatim: "On 3c's World node run errors: the person reads these on the
node, so their lines shouldn't carry ids or record names. ... Get agents
their facts through the person/agent split you built in round 3. The node's
error stores the specific text for agents (and the run record and MCP keep
it), and the canvas shows the written line. If a fact helps the person act,
put it in words, like "the node's Resume Operation ID field"."

And for the status bar and its warnings: "People never see the word
"start"; they ran a World Labs job. ... write "World Labs run" wherever they
now say "paid start". Keep the rest of each line."

So a handler raises its specific text as before (unchanged: agents, the run
record, MCP and the node's stored error read it) and attaches the person's
line (execution/person_line.py). The engine carries both on the ErrorEvent
(`error` and the additive `person`), node_errors keeps both, and the card's
node data gets `errorPerson`. Every HTTP call here is mocked: nothing paid.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from execution.engine import execute_graph
from handlers.worldlabs import (
    WORLDLABS_API_BASE,
    handle_worldlabs_environment,
    handle_worldlabs_export,
)
from models.events import ErrorEvent, ExecutingEvent
from models.graph import GraphNode, PortValueDict
from services.canvas_events import CanvasEventJournal
from services.node_errors import NodeErrors

API_KEYS = {"WORLDLABS_API_KEY": "worldlabs-test-key"}
CLAUDE = {"X-Nebula-Agent": "Claude Code"}

LOCKED = ("World Labs didn't answer this run, so Nebula locked the node to avoid paying twice. "
          "Check the job in Marble, then use “Checked Marble — unlock” before you run it again.")
PLY_LOST = "World Labs didn't answer this export. PLY exports are free, so you can run the node again."
KEY_REJECTED = "World Labs didn't accept your API key. Check it in Settings, then run the node again."
NO_CREDITS = "Your World Labs account is out of API credits. Add credits, then run the node again."
BUSY = "World Labs is busy. Wait a moment, then run the node again."


def kept(field: str) -> str:
    return ("World Labs accepted this run, and it may be billed, but Nebula couldn't finish it here. "
            f"Check the job in Marble. The node's {field} field keeps the job, so running the node "
            "again picks it up without paying twice.")


def job_failed(field: str) -> str:
    return ("World Labs couldn't finish this run. Check the job in Marble to see why. To run it "
            f"from scratch, clear the node's {field} field first.")


# What no person line may say: ids, parameter and record names, internal words.
FORBIDDEN = re.compile(
    r"paid[- ]start|resume_operation_id|existing_world_id|WORLDLABS_API_KEY|operationId|worldId|"
    r"world-123|paid-operation|paid-world|safety hold|safety-locked|idempoten|schemaVersion|\bstart\b",
    re.IGNORECASE,
)


def _node(definition_id: str = "worldlabs-environment", params: dict[str, Any] | None = None,
          *, node_id: str = "world-node") -> GraphNode:
    return GraphNode(id=node_id, definitionId=definition_id, params=params or {}, outputs={})


def _port(value: Any, port_type: str = "Text") -> PortValueDict:
    return PortValueDict(type=port_type, value=value)


WORLD_V1 = {"schemaVersion": 1, "provider": "worldlabs", "worldId": "world-123"}


def _person(exc: BaseException) -> str | None:
    from execution.person_line import person_line

    return person_line(exc)


@pytest.fixture(autouse=True)
def _public_hosts(monkeypatch) -> None:
    import ipaddress

    async def public_addresses(_hostname: str, _port: int):
        return {ipaddress.ip_address("8.8.8.8")}

    monkeypatch.setattr("handlers.worldlabs._resolve_host_addresses", public_addresses)


async def _no_emit(_event: Any) -> None:
    return None


# -- the World nodes: the specific text unchanged, the person's line beside it --


@pytest.mark.asyncio
@respx.mock
async def test_a_lost_environment_answer_keeps_its_text_and_says_the_locked_line() -> None:
    respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(side_effect=httpx.ConnectError("reset"))
    with pytest.raises(RuntimeError) as caught:
        await handle_worldlabs_environment(_node(), {"prompt": _port("a room")}, API_KEYS, emit=_no_emit)
    assert str(caught.value) == (
        "World Labs generation start response was not received. Nebula "
        "safety-locked this node because the public API has no "
        "idempotency key and a retry could create a second paid world; "
        "check World Labs Marble before explicitly unlocking it."
    )
    assert _person(caught.value) == LOCKED


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize("status_code", [408, 500, 502, 503, 504])
async def test_an_ambiguous_environment_answer_says_the_locked_line(status_code: int) -> None:
    respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
        return_value=httpx.Response(status_code, text="uncertain response"))
    with pytest.raises(RuntimeError) as caught:
        await handle_worldlabs_environment(_node(), {"prompt": _port("a room")}, API_KEYS, emit=_no_emit)
    assert str(caught.value) == f"World Labs generation start failed ({status_code}): uncertain response"
    assert _person(caught.value) == LOCKED


@pytest.mark.asyncio
@respx.mock
async def test_a_lost_glb_export_answer_says_the_locked_line_and_ply_says_its_own() -> None:
    respx.post(f"{WORLDLABS_API_BASE}/worlds/world-123:export").mock(side_effect=httpx.ConnectError("reset"))
    with pytest.raises(RuntimeError) as glb:
        await handle_worldlabs_export(_node("worldlabs-world-export", {"format": "glb"}),
                                      {"world": _port(WORLD_V1, "World")}, API_KEYS, emit=_no_emit)
    assert str(glb.value).startswith("World Labs export start response was not received. Nebula safety-locked")
    assert _person(glb.value) == LOCKED

    with pytest.raises(RuntimeError) as ply:
        await handle_worldlabs_export(_node("worldlabs-world-export", {"format": "ply"}),
                                      {"world": _port(WORLD_V1, "World")}, API_KEYS, emit=_no_emit)
    assert str(ply.value) == ("World Labs free PLY export start response was not received; no "
                              "paid-start safety hold was created.")
    assert _person(ply.value) == PLY_LOST


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize(("status_code", "line"), [(401, KEY_REJECTED), (402, NO_CREDITS), (429, BUSY)])
async def test_a_refused_environment_run_says_what_to_fix(status_code: int, line: str) -> None:
    respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(
        return_value=httpx.Response(status_code, text="no"))
    with pytest.raises(RuntimeError) as caught:
        await handle_worldlabs_environment(_node(), {"prompt": _port("a room")}, API_KEYS, emit=_no_emit)
    assert str(caught.value).startswith(f"World Labs generation start failed ({status_code}): ")
    assert _person(caught.value) == line


@pytest.mark.asyncio
@respx.mock
async def test_a_failure_after_world_labs_accepted_names_the_field_that_keeps_the_job(tmp_path: Path) -> None:
    # The world was made, then a download broke: the node keeps the World ID.
    respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(return_value=httpx.Response(
        200, json={"operation_id": "paid-operation-7", "done": True, "response": {"world_id": "paid-world-9"}}))
    respx.get(f"{WORLDLABS_API_BASE}/worlds/paid-world-9").mock(side_effect=httpx.ConnectError("reset"))
    node = _node()
    with patch("handlers.worldlabs.get_run_dir", return_value=tmp_path):
        with pytest.raises(RuntimeError) as caught:
            await handle_worldlabs_environment(node, {"prompt": _port("a room")}, API_KEYS, emit=_no_emit)
    message = str(caught.value)
    assert "operationId=paid-operation-7" in message and "existing_world_id=paid-world-9" in message
    assert _person(caught.value) == kept("Existing World ID")


@pytest.mark.asyncio
@respx.mock
async def test_a_poll_failure_names_the_resume_field() -> None:
    respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(return_value=httpx.Response(
        200, json={"operation_id": "paid-operation-transport", "done": False}))
    respx.get(f"{WORLDLABS_API_BASE}/operations/paid-operation-transport").mock(
        side_effect=httpx.ConnectError("connection lost"))
    with patch("handlers.worldlabs.asyncio.sleep", new_callable=AsyncMock):
        with pytest.raises(RuntimeError) as caught:
            await handle_worldlabs_environment(_node(), {"prompt": _port("a room")}, API_KEYS, emit=_no_emit)
    assert "resume_operation_id=paid-operation-transport" in str(caught.value)
    assert _person(caught.value) == kept("Resume Operation ID")


@pytest.mark.asyncio
@respx.mock
async def test_a_job_world_labs_failed_says_so_and_how_to_run_it_fresh() -> None:
    respx.post(f"{WORLDLABS_API_BASE}/worlds:generate").mock(return_value=httpx.Response(
        200, json={"operation_id": "paid-operation-8", "done": True,
                   "error": {"message": "prompt was flagged"}}))
    with pytest.raises(RuntimeError) as caught:
        await handle_worldlabs_environment(_node(), {"prompt": _port("a room")}, API_KEYS, emit=_no_emit)
    assert "cause: World Labs operation failed: prompt was flagged" in str(caught.value)
    assert _person(caught.value) == job_failed("Resume Operation ID")


@pytest.mark.asyncio
@respx.mock
async def test_an_export_failure_after_acceptance_names_the_export_field() -> None:
    respx.post(f"{WORLDLABS_API_BASE}/worlds/world-123:export").mock(return_value=httpx.Response(
        200, json={"operation_id": "paid-operation-e", "done": False}))
    respx.get(f"{WORLDLABS_API_BASE}/operations/paid-operation-e").mock(side_effect=httpx.ConnectError("lost"))
    with patch("handlers.worldlabs.asyncio.sleep", new_callable=AsyncMock):
        with pytest.raises(RuntimeError) as caught:
            await handle_worldlabs_export(_node("worldlabs-world-export", {"format": "glb"}),
                                          {"world": _port(WORLD_V1, "World")}, API_KEYS, emit=_no_emit)
    assert "resume_operation_id=paid-operation-e" in str(caught.value)
    assert _person(caught.value) == kept("Resume Export Operation ID")


@pytest.mark.asyncio
async def test_the_world_nodes_own_checks_say_lines_without_parameter_names() -> None:
    with pytest.raises(ValueError) as both:
        await handle_worldlabs_environment(
            _node(params={"resume_operation_id": "op-1", "existing_world_id": "w-1"}), {}, API_KEYS)
    assert str(both.value) == "Set either resume_operation_id or existing_world_id, not both"
    assert _person(both.value) == "Fill in the node's Resume Operation ID or its Existing World ID, not both."

    with pytest.raises(ValueError) as bad_id:
        await handle_worldlabs_environment(_node(params={"resume_operation_id": "bad\x01id"}), {}, API_KEYS)
    assert str(bad_id.value) == "World Labs resume operation ID is invalid"
    assert _person(bad_id.value) == ("The node's Resume Operation ID field doesn't hold a World Labs job. "
                                     "Copy the job's ID from Marble, or clear the field.")

    with pytest.raises(Exception) as no_key:
        await handle_worldlabs_environment(_node(), {}, {})
    assert str(no_key.value) == "WORLDLABS_API_KEY is required"
    assert _person(no_key.value) == "Add your World Labs API key in Settings, then run the node again."

    with pytest.raises(ValueError) as nothing:
        await handle_worldlabs_environment(_node(), {}, API_KEYS)
    assert str(nothing.value) == "Connect a prompt, one or more images, or a video"
    assert _person(nothing.value) == "Connect a prompt, one or more images, or a video, then run the node again."

    for value in ({"schemaVersion": 1, "provider": "other", "worldId": "w"},
                  {"schemaVersion": 3, "provider": "worldlabs", "worldId": "w"}):
        with pytest.raises(ValueError) as foreign:
            await handle_worldlabs_export(_node("worldlabs-world-export"), {"world": _port(value, "World")}, API_KEYS)
        assert _person(foreign.value) == ("This node exports worlds made by a World Labs Environment node. "
                                          "Connect one, then run it again.")


def test_the_field_names_in_the_lines_are_the_nodes_own_labels() -> None:
    from handlers import worldlabs

    definitions = json.loads((Path(__file__).resolve().parents[1] / "data" / "node_definitions.json").read_text())
    def label(node_id: str, param: str) -> str:
        return next(p["label"] for p in definitions[node_id]["params"] if p["key"] == param)

    assert worldlabs.RECOVERY_FIELD_LABELS == {
        ("worldlabs-environment", "resume_operation_id"): label("worldlabs-environment", "resume_operation_id"),
        ("worldlabs-environment", "existing_world_id"): label("worldlabs-environment", "existing_world_id"),
        ("worldlabs-world-export", "resume_operation_id"): label("worldlabs-world-export", "resume_operation_id"),
    }


def test_no_world_person_line_carries_an_id_or_a_record_name() -> None:
    from handlers import worldlabs

    lines = [LOCKED, PLY_LOST, KEY_REJECTED, NO_CREDITS, BUSY, *worldlabs.PERSON_LINES.values()]
    for field in worldlabs.RECOVERY_FIELD_LABELS.values():
        lines += [kept(field), job_failed(field)]
    for line in lines:
        assert not FORBIDDEN.search(line), line


# -- the engine carries both, and the store keeps both ----------------------


@pytest.mark.asyncio
async def test_the_engine_carries_the_person_line_beside_the_specific_text() -> None:
    from execution.person_line import with_person_line

    async def failing(_node, _inputs, _keys):
        raise with_person_line(RuntimeError("Provider X failed for op-123 (job_id=9)"), "The person's line.")

    async def plain(_node, _inputs, _keys):
        raise RuntimeError("HTTP 500 from provider")

    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    for handler in (failing, plain):
        events.clear()
        await execute_graph(nodes=[_node("gpt-image-1-generate", node_id="n1")], edges=[], api_keys={},
                            handler_registry={"gpt-image-1-generate": handler}, emit=emit, run_id=None)
        [error] = [event for event in events if isinstance(event, ErrorEvent)]
        if handler is failing:
            assert error.error == "Provider X failed for op-123 (job_id=9)"
            assert error.person == "The person's line."
        else:
            assert error.error == "HTTP 500 from provider"
            assert error.person is None


def test_node_errors_keep_the_person_line_for_the_card_and_not_for_agents(tmp_path: Path) -> None:
    path = tmp_path / "node-errors.json"
    errors = NodeErrors(path)
    errors.observe(ErrorEvent(node_id="n1", error="specific op-1", person="The written line.",
                              category="unknown", friendly="specific op-1"))
    assert errors.card("n1") == {"state": "error", "error": "specific op-1", "errorPerson": "The written line.",
                                 "errorCategory": "unknown"}
    # Agents read the specific text only, word for word.
    assert errors.get("n1") == {"error": "specific op-1"}
    # A restart keeps it.
    assert NodeErrors(path).card("n1")["errorPerson"] == "The written line."
    # Running again forgets both.
    errors.observe(ExecutingEvent(node_id="n1"))
    assert errors.card("n1") is None


# -- both readers, through the backend --------------------------------------


@pytest.fixture
def canvas(monkeypatch):
    import main

    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main, "node_errors", NodeErrors(), raising=False)
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        node = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "x"}}).json()["id"]
        sent.clear()
        yield client, main, sent, node
        client.delete("/api/graph?force=true")


SPECIFIC = ("World Labs generation/recovery was already accepted or is being recovered "
            "(operationId=op-77), but Nebula could not finish locally. Recover with resume_operation_id=op-77;")


def test_the_canvas_reads_the_person_line_and_agents_the_specific_text(canvas, monkeypatch):
    client, main, sent, node = canvas

    async def fails(*, nodes, emit, run_id, **kwargs):
        await emit(ExecutingEvent(node_id=node, run_id=run_id))
        await emit(ErrorEvent(node_id=node, error=SPECIFIC, run_id=run_id, person=kept("Resume Operation ID"),
                              category="unknown", friendly=SPECIFIC[:140]))

    monkeypatch.setattr(main, "execute_graph", fails)
    body = client.post("/api/graph/run", json={"targetNodeId": node}, headers=CLAUDE).json()

    # The canvas's event carries both; the card shows the person's.
    [event] = [m for m in sent if m.get("type") == "error"]
    assert event["error"] == SPECIFIC and event["person"] == kept("Resume Operation ID")
    # Agents: the run record, get_run and look_at_canvas keep the specific text word for word.
    assert body["errors"] == {node: SPECIFIC}
    assert client.get(f"/api/graph/runs/{body['runId']}").json()["errors"] == {node: SPECIFIC}
    snapshot = client.get("/api/canvas/snapshot").json()
    shown = next(n for n in snapshot["nodes"] if n["id"] == node)
    assert shown["error"] == SPECIFIC and "errorPerson" not in shown
    # A reload (graphSync / graph export) gives the card both, as the event did.
    exported = client.get("/api/graph/export").json()
    data = next(n for n in exported["nodes"] if n["id"] == node)["data"]
    assert data["error"] == SPECIFIC and data["errorPerson"] == kept("Resume Operation ID")


# -- the status bar's warnings (shared with agents: no facts lost) -----------


def test_the_ambiguity_warning_says_world_labs_run():
    from services import provider_start_guard

    assert provider_start_guard.AMBIGUITY_MESSAGE == (
        "World Labs may have started this run without sending back its ID, so Nebula can't tell if it was "
        "billed. Check the job in Marble before you unlock the node, and don't run it again until you have.")
    assert provider_start_guard.NONDURABLE_RECOVERY_MESSAGE == (
        "World Labs sent back the job's ID, but Nebula couldn't save it. Keep this tab open and use the ID "
        "shown here. Don't start the run again from another tab.")


def test_a_hold_saved_with_the_old_words_reads_the_new_ones(tmp_path: Path):
    from services.provider_start_guard import AMBIGUITY_MESSAGE, NONDURABLE_RECOVERY_MESSAGE, ProviderStartGuard

    path = tmp_path / "provider-start-guard.json"
    old = ProviderStartGuard(path)
    old.mark_ambiguous(run_id="r1", node_id="n1", kind="worldlabs-environment")
    raw = json.loads(path.read_text())
    raw["ambiguities"][0]["message"] = ("World Labs may have accepted a paid start without returning a "
                                         "recovery ID. Check Marble before unlocking; do not rerun blindly.")
    raw["ambiguities"].append({**raw["ambiguities"][0], "nodeId": "n2", "message": (
        "World Labs returned a recovery ID, but Nebula could not save that ID durably. Use the live ID; "
        "do not submit a fresh paid start from a stale tab.")})
    path.write_text(json.dumps(raw))
    messages = {record["nodeId"]: record["message"] for record in ProviderStartGuard(path).list()}
    assert messages == {"n1": AMBIGUITY_MESSAGE, "n2": NONDURABLE_RECOVERY_MESSAGE}


# -- review: the World node checks the person can hit, and the seed read as a rate limit --

SEED = "Set the node's Seed to a whole number from 0 to 4294967295, or clear it for a random seed."
SEED_TEXT = "World Labs seed must be an integer from 0 to 4294967295"
NAME = "The node's World Name is too long. Keep it to 64 characters or fewer."
TAGS = "The node's Tags field takes up to 10 tags of 32 characters each, separated by commas."
AZIMUTHS = ("Write the node's Image Azimuths as numbers separated by commas, one for each connected "
            "image, or clear the field.")


def test_the_seed_check_is_not_read_as_a_rate_limit() -> None:
    from execution.error_classifier import classify_error

    # "429" sits inside 4294967295; "401" and "402" inside other numbers.
    assert classify_error(SEED_TEXT)[0] != "rate_limit"
    assert classify_error("Seed must be from 0 to 4294967295")[0] != "rate_limit"
    assert classify_error("frame 14012 of the clip could not be decoded")[0] != "auth"
    assert classify_error("node 34021 has no output")[0] != "quota"
    assert classify_error("width 14001 px is not allowed")[0] != "invalid_input"
    # A status code standing on its own still names its failure.
    assert classify_error("429 Too Many Requests")[:1] == ("rate_limit",)
    assert classify_error("Meshy submit failed (429): slow down")[0] == "rate_limit"
    assert classify_error("HTTP 401")[0] == "auth"
    assert classify_error("Replicate submit failed (402): pay up")[0] == "quota"
    assert classify_error("status_code=422")[0] == "invalid_input"


@pytest.mark.asyncio
@pytest.mark.parametrize("seed", [True, "abc", "1.5", 1.5, -1, 5_000_000_000, "-3"])
async def test_a_bad_seed_says_the_seed_line(seed: Any) -> None:
    with pytest.raises(ValueError) as bad:
        await handle_worldlabs_environment(
            _node(params={"seed": seed}), {"prompt": _port("a quiet valley")}, API_KEYS)
    assert str(bad.value) == SEED_TEXT
    assert _person(bad.value) == SEED


@pytest.mark.asyncio
async def test_the_world_name_and_tags_checks_say_their_lines() -> None:
    prompt = {"prompt": _port("a quiet valley")}
    with pytest.raises(ValueError) as name:
        await handle_worldlabs_environment(_node(params={"display_name": "x" * 65}), prompt, API_KEYS)
    assert str(name.value) == "World Labs display name must be 64 characters or fewer"
    assert _person(name.value) == NAME

    for tags in (",".join(f"t{i}" for i in range(11)), "a" * 33, ["ok", "b" * 33]):
        with pytest.raises(ValueError) as many:
            await handle_worldlabs_environment(_node(params={"tags": tags}), prompt, API_KEYS)
        assert str(many.value) == "World Labs accepts at most 10 tags of 32 characters each"
        assert _person(many.value) == TAGS
    with pytest.raises(ValueError) as shape:
        await handle_worldlabs_environment(_node(params={"tags": {"a": 1}}), prompt, API_KEYS)
    assert str(shape.value) == "World Labs tags must be a comma-separated string or list"
    assert _person(shape.value) == TAGS


@pytest.mark.asyncio
async def test_the_image_checks_say_their_lines(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("handlers.worldlabs.require_allowed_path", lambda path: path)
    pictures = []
    for index in range(9):
        picture = tmp_path / f"p{index}.png"
        picture.write_bytes(b"\x89PNG" + bytes(16))
        pictures.append(str(picture))

    with pytest.raises(ValueError) as five:
        await handle_worldlabs_environment(_node(), {"images": _port(pictures[:5], "Image")}, API_KEYS)
    assert str(five.value) == "World Labs accepts at most 4 images when reconstruct_images is disabled"
    assert _person(five.value) == ("This node takes up to 4 images. Turn on the node's Reconstruct Image Set "
                                   "for up to 8, or disconnect some.")
    with pytest.raises(ValueError) as nine:
        await handle_worldlabs_environment(
            _node(params={"reconstruct_images": True}), {"images": _port(pictures, "Image")}, API_KEYS)
    assert str(nine.value) == "World Labs accepts at most 8 images when reconstruct_images is enabled"
    assert _person(nine.value) == "This node takes up to 8 images. Disconnect some, then run the node again."

    missing = str(tmp_path / "gone.png")
    with pytest.raises(ValueError) as gone:
        await handle_worldlabs_environment(_node(), {"images": _port(missing, "Image")}, API_KEYS)
    assert str(gone.value) == f"Image file not found: {missing}"
    assert _person(gone.value) == "A connected image file can't be found. Connect it again, then run the node again."
    with pytest.raises(ValueError) as gone_video:
        await handle_worldlabs_environment(_node(), {"video": _port(str(tmp_path / "gone.mp4"), "Video")}, API_KEYS)
    assert _person(gone_video.value) == ("A connected video file can't be found. Connect it again, "
                                         "then run the node again.")

    empty = tmp_path / "empty.png"
    empty.write_bytes(b"")
    with pytest.raises(ValueError) as nothing:
        await handle_worldlabs_environment(_node(), {"images": _port(str(empty), "Image")}, API_KEYS)
    assert str(nothing.value) == f"Image file is empty: {empty}"
    assert _person(nothing.value) == "A connected image file is empty. Connect another one, then run the node again."

    monkeypatch.setattr("handlers.worldlabs._MAX_UPLOAD_BYTES", 4)
    monkeypatch.setattr("handlers.worldlabs._MAX_VIDEO_BYTES", 4)
    with pytest.raises(ValueError) as big:
        await handle_worldlabs_environment(_node(), {"images": _port(pictures[0], "Image")}, API_KEYS)
    assert str(big.value) == f"Image file exceeds World Labs' 1 GB media upload limit: {pictures[0]}"
    assert _person(big.value) == "A connected image is over World Labs' 1 GB limit. Connect a smaller one."
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(bytes(16))
    with pytest.raises(ValueError) as long_clip:
        await handle_worldlabs_environment(_node(), {"video": _port(str(clip), "Video")}, API_KEYS)
    assert str(long_clip.value) == f"Video file exceeds World Labs' 100 MB video limit: {clip}"
    assert _person(long_clip.value) == ("The connected video is over World Labs' 100 MB limit. "
                                        "Connect a shorter or smaller one.")


@pytest.mark.asyncio
@pytest.mark.parametrize(("azimuths", "text"), [
    ("[1, 2", "Azimuths must be comma-separated numbers or a JSON array"),
    ("10", "Azimuth count must match the 2 connected images"),
    ("10, east", "Invalid azimuth: 'east'"),
    ("10, inf", "Invalid azimuth: 'inf'"),
])
async def test_the_azimuth_checks_say_the_azimuth_line(azimuths: str, text: str, tmp_path: Path,
                                                         monkeypatch) -> None:
    async def uploaded(_client, value, _kind, _headers):
        return {"source": "media_asset", "media_asset_id": str(value)}

    monkeypatch.setattr("handlers.worldlabs._content_reference", uploaded)
    with pytest.raises(ValueError) as bad:
        await handle_worldlabs_environment(
            _node(params={"azimuths": azimuths}), {"images": _port(["a.png", "b.png"], "Image")}, API_KEYS)
    assert str(bad.value) == text
    assert _person(bad.value) == AZIMUTHS


def test_the_review_lines_carry_no_id_or_record_name() -> None:
    from handlers import worldlabs

    for line in worldlabs.PERSON_LINES.values():
        assert not FORBIDDEN.search(line), line
        assert "(" not in line, line
