"""Error copy round 3d: GM - Design's lines for the other handlers' run errors.

GM owns the copy; GM's lines are verbatim here. GM: "Raw provider text stays
behind Details in every case." The exception text is what agents, MCP, the
run record and the journal read, and none of it changes: every test asserts
the exact text beside the line.

- One shared provider status table, applied at one point (the engine's run
  error, execution/provider_status.py), naming the provider the node actually
  called; a handler's own line wins.
- Paid async jobs Nebula stopped waiting on, empty or malformed answers, a
  connected file that isn't there, every missing-key shape, GM's ten Krea
  lines, and no provider model ids or parentheses on the card.
"""
from __future__ import annotations

import ast
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest

from execution.engine import execute_graph
from execution.person_line import person_line
from models.events import ErrorEvent
from models.graph import GraphEdge, GraphNode, PortValueDict

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent


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


def _card(exc: BaseException, definition_id: str, params: dict[str, Any] | None = None,
          api_keys: dict[str, str] | None = None):
    from execution.provider_status import card_line

    return card_line(exc, definition_id, params or {}, api_keys or {})


# -- 1. the provider status table ----------------------------------------------

KEY = "Meshy didn't accept your API key. Check it in Settings, then run the node again."
CREDITS = "Your Meshy account is out of credits. Add credits, then run the node again."
BUSY = "Meshy is busy. Wait a moment, then run the node again."
TROUBLE = "Meshy is having trouble right now. Try again in a few minutes."


@pytest.mark.parametrize("status, line", [
    (401, KEY), (403, KEY), (402, CREDITS), (429, BUSY), (500, TROUBLE), (502, TROUBLE), (503, TROUBLE),
])
def test_one_table_maps_a_providers_status_to_gms_line(status: int, line: str) -> None:
    exc = RuntimeError(f'Meshy submit failed ({status}): {{"message": "the provider\'s own words"}}')
    card = _card(exc, "meshy-text-to-3d", {}, {"MESHY_API_KEY": "fixture"})
    assert card.person == line
    # The provider's own words stay behind Details (GM), and agents' text is untouched.
    assert card.provider_text is True
    assert str(exc).startswith(f"Meshy submit failed ({status})")


@pytest.mark.parametrize("text", [
    "OpenAI API error 401: {\"error\": {\"message\": \"Incorrect API key provided\"}}",
    "OpenAI TTS error 403: forbidden",
])
def test_the_table_reads_every_shape_handlers_write_a_status_in(text: str) -> None:
    card = _card(RuntimeError(text), "gpt-image-1-generate", {}, {"OPENAI_API_KEY": "fixture"})
    assert card.person == "OpenAI didn't accept your API key. Check it in Settings, then run the node again."


def test_auto_routing_names_the_provider_the_run_went_to_not_the_nodes_default() -> None:
    # FLUX 3 Video's maker is Black Forest Labs; on Auto with only a fal key
    # the run goes to fal, and a generic runner's text names no one.
    exc = RuntimeError("Async submit failed (429): slow down")
    assert _card(exc, "flux-3-video", {}, {"FAL_KEY": "fixture"}).person == (
        "fal.ai is busy. Wait a moment, then run the node again.")
    # The provider switcher set to Replicate, with both keys saved.
    chosen = {"_provider": "replicate"}
    keys = {"FAL_KEY": "fixture", "REPLICATE_API_TOKEN": "fixture"}
    assert _card(exc, "flux-3-video", chosen, keys).person == (
        "Replicate is busy. Wait a moment, then run the node again.")
    assert _card(RuntimeError("Async submit failed (401): no"), "flux-3-video", chosen, keys).person == (
        "Replicate didn't accept your API token. Check it in Settings, then run the node again.")


def test_a_typed_provider_error_names_its_provider() -> None:
    from handlers.bfl import BFLError, explain
    from handlers.byteplus import BytePlusError

    exc = BFLError(401, explain(401, "Not authenticated"), detail="Not authenticated")
    assert _card(exc, "flux-3-video", {}, {"BFL_API_KEY": "fixture"}).person == (
        "Black Forest Labs didn't accept your API key. Check it in Settings, then run the node again.")
    exc = BytePlusError(429, "RateLimitExceeded", "too many", "BytePlus ModelArk error 429 RateLimitExceeded: too many")
    assert _card(exc, "seedream-4-5", {}, {"BYTEPLUS_API_KEY": "fixture"}).person == (
        "BytePlus is busy. Wait a moment, then run the node again.")


@pytest.mark.parametrize("text", [
    # OpenAI answers an exhausted quota with a 429 ("insufficient_quota"), and
    # some providers with a 400: the classifier's quota words win the status.
    'OpenAI API error 429: {"error": {"code": "insufficient_quota", "message": "You exceeded your current quota"}}',
    'OpenAI API error 400: {"error": {"code": "insufficient_quota"}}',
])
def test_credits_a_provider_signals_without_a_402(text: str) -> None:
    assert _card(RuntimeError(text), "gpt-image-1-generate", {}, {"OPENAI_API_KEY": "fixture"}).person == (
        "Your OpenAI account is out of credits. Add credits, then run the node again.")


def test_a_handlers_own_line_wins_over_the_table() -> None:
    from execution.person_line import with_person_line

    exc = with_person_line(RuntimeError("Meshy submit failed (401): no"), "A line the handler wrote.")
    card = _card(exc, "meshy-text-to-3d", {}, {"MESHY_API_KEY": "fixture"})
    assert card.person == "A line the handler wrote."
    assert card.provider_text is False


@pytest.mark.parametrize("make, definition_id, keys", [
    # A status the table has no line for.
    (lambda: RuntimeError("Meshy submit failed (418): teapot"), "meshy-text-to-3d", {"MESHY_API_KEY": "x"}),
    # A download of a result or an input URL: who answered isn't the provider's API.
    (lambda: httpx.HTTPStatusError("Client error '403 Forbidden' for url 'https://cdn.example/a.png'",
                                   request=httpx.Request("GET", "https://cdn.example/a.png"),
                                   response=httpx.Response(403)), "meshy-text-to-3d", {"MESHY_API_KEY": "x"}),
    # Moderation keeps its own card.
    (lambda: RuntimeError("OpenAI API error 400: content_policy_violation"), "gpt-image-1-generate",
     {"OPENAI_API_KEY": "x"}),
    # A number that isn't a status.
    (lambda: RuntimeError("Async job timed out after 300 polls (600s)"), "flux-3-video", {"FAL_KEY": "x"}),
    (lambda: ValueError("World Labs seed must be an integer from 0 to 4294967295"), "meshy-text-to-3d",
     {"MESHY_API_KEY": "x"}),
    # A local node: no provider to name.
    (lambda: RuntimeError("Stream request failed (503): down"), "text-input", {}),
])
def test_a_failure_nebula_cant_tell_keeps_todays_line(make, definition_id, keys) -> None:
    card = _card(make(), definition_id, {}, keys)
    assert card.person is None
    assert card.provider_text is False


def test_the_krea_plan_never_asks_for_an_api_key() -> None:
    plan = {"_kreaAuth": "mcp"}
    assert _card(RuntimeError("Krea generate failed (401): no"), "krea-2-generate", plan, {}).person is None
    assert _card(RuntimeError("Krea generate failed (402): Krea API balance is depleted"), "krea-2-generate",
                 plan, {}).person == "Your Krea account is out of credits. Add credits, then run the node again."


@pytest.mark.asyncio
async def test_the_engine_puts_the_tables_line_on_the_event_and_keeps_the_agents_text() -> None:
    text = 'Meshy submit failed (402): {"message": "Insufficient credits"}'

    async def handler(node, inputs, api_keys):
        raise RuntimeError(text)

    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    nodes = [GraphNode(id="p", definitionId="text-input", params={"value": "a chair"}),
             _node("meshy-text-to-3d")]
    edges = [GraphEdge(id="e", source="p", sourceHandle="text", target="n1", targetHandle="prompt")]
    await execute_graph(nodes=nodes, edges=edges, api_keys={"MESHY_API_KEY": "fixture"},
                        handler_registry={"meshy-text-to-3d": handler}, emit=emit, run_id=None)
    [error] = [event for event in events if isinstance(event, ErrorEvent)]
    assert error.error == text
    assert error.person == CREDITS
    assert error.provider_text is True


def test_node_errors_keep_the_details_flag_for_the_card_not_for_agents(tmp_path) -> None:
    from services.node_errors import NodeErrors

    store = NodeErrors(tmp_path / "errors.json")
    store.observe(ErrorEvent(node_id="n1", error="Meshy submit failed (429): slow", category="rate_limit",
                             friendly="Rate limited by the provider. Wait a moment and run again.",
                             person=BUSY, provider_text=True))
    assert store.card("n1")["errorPerson"] == BUSY
    assert store.card("n1")["errorProviderText"] is True
    assert "errorProviderText" not in (store.get("n1") or {})
    assert "providerText" not in (store.get("n1") or {})
    # After a restart (the file read back).
    assert NodeErrors(tmp_path / "errors.json").card("n1")["errorProviderText"] is True


@pytest.mark.asyncio
async def test_a_scene_runs_failed_shot_names_the_provider_its_base_called(monkeypatch) -> None:
    import execution.sync_runner as sync_runner
    import handlers.cinema_scene as cinema_scene

    async def boom(node, inputs, api_keys):
        raise RuntimeError("FAL submit failed (503): upstream exploded")

    class _AnyKey(dict):
        def get(self, _key, _default=None):
            return boom

    monkeypatch.setattr(cinema_scene, "get_handler_registry", lambda emit=None: _AnyKey(), raising=False)
    monkeypatch.setattr(sync_runner, "get_handler_registry", lambda emit=None: _AnyKey())
    scene = {"version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9",
             "shots": [{"id": "bad", "prompt": "a shot"}]}
    await cinema_scene.handle_cinema_scene(GraphNode(id="scene1", definitionId="cinema-scene", params={"scene": scene}),
                                           inputs={}, api_keys={"FAL_KEY": "x"}, emit=None)
    output = scene["shots"][0]["output"]
    assert output["error"] == "FAL submit failed (503): upstream exploded"
    assert output["errorPerson"] == "fal.ai is having trouble right now. Try again in a few minutes."
    assert output["errorProviderText"] is True
    assert output["errorRaw"] == "FAL submit failed (503): upstream exploded"


def test_a_single_shots_failure_carries_the_details_flag() -> None:
    from main import _ShotPassError, _shot_failure_fields

    fields = _shot_failure_fields(_ShotPassError("x", {"category": "rate_limit", "friendly": "f", "person": BUSY,
                                                       "raw": "Meshy submit failed (429)", "provider_text": True}))
    assert fields["errorPerson"] == BUSY
    assert fields["errorProviderText"] is True


# -- 2. paid async jobs Nebula stopped waiting on -----------------------------


def _slow(provider: str) -> str:
    return (f"{provider} is taking longer than usual. The job may still finish there and be billed, so check "
            f"{provider} before you run the node again.")


@pytest.mark.asyncio
async def test_a_runway_job_nebula_stopped_waiting_on_says_check_runway() -> None:
    from execution.async_poll_runner import poll_until_terminal
    from handlers.runway import _runway_poll_config

    config = _runway_poll_config("fixture", "https://api.dev.runwayml.com/v1/image_to_video")
    config.max_polls, config.poll_interval = 1, 0
    transport = httpx.MockTransport(lambda request: httpx.Response(
        200 if request.method == "GET" else 204, json={"status": "RUNNING"}))

    async def emit(_event):
        return None

    async with httpx.AsyncClient(transport=transport) as client:
        exc = await _araised(poll_until_terminal, client, config, "task-1", "n1", emit)
    assert str(exc) == "Async job timed out after 1 polls (0s)"
    assert person_line(exc) == _slow("Runway")


@pytest.mark.asyncio
async def test_a_meshy_job_nebula_stopped_waiting_on_says_check_meshy() -> None:
    from handlers.meshy import _poll_meshy_task

    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"status": "IN_PROGRESS"}))

    async def emit(_event):
        return None

    async with httpx.AsyncClient(transport=transport) as client:
        exc = await _araised(_poll_meshy_task, client, "fixture", "https://api.meshy.ai/x", emit, "n1",
                             max_polls=1, poll_interval=0)
    assert str(exc) == "Meshy task timed out after 1 polls"
    assert person_line(exc) == _slow("Meshy")


# Every poll that stops waiting on a job a paid provider accepted, and the
# provider it names.
PAID_POLL_TIMEOUTS = {
    "handlers/krea_gateway.py": "Krea", "handlers/minimax.py": "MiniMax", "handlers/krea.py": "Krea",
    "handlers/fal_universal.py": "fal.ai", "handlers/grok_video.py": "xAI", "handlers/higgsfield.py": "Higgsfield",
    "handlers/gemini_omni.py": "Gemini", "handlers/veo.py": None, "handlers/elevenlabs.py": "ElevenLabs",
    "handlers/minimax_v2.py": "MiniMax", "handlers/meshy.py": "Meshy", "handlers/ideogram.py": "Ideogram",
    "handlers/bfl.py": "Black Forest Labs", "handlers/openrouter_media.py": "OpenRouter",
    "handlers/byteplus.py": "BytePlus", "services/krea_mcp_generation.py": "Krea",
}


def _timeout_raises(path: Path) -> list[tuple[str, ast.Call | None]]:
    source = path.read_text()
    found = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Raise) or not isinstance(node.exc, ast.Call):
            continue
        call, wrapper = node.exc, None
        if isinstance(call.func, ast.Name) and call.func.id in {"with_person_line", "as_person_line"}:
            wrapper, call = call, call.args[0]
        text = ast.get_source_segment(source, call) or ""
        if re.search(r"timed out|was still|didn't finish this job|still \{", text, re.I) and "file" not in text:
            found.append((text, wrapper))
    return found


def test_every_paid_poll_timeout_says_the_job_may_still_be_billed() -> None:
    for name, provider in PAID_POLL_TIMEOUTS.items():
        raises = _timeout_raises(BACKEND / name)
        assert raises, name
        for text, wrapper in raises:
            assert wrapper is not None and wrapper.func.id == "with_person_line", (name, text)
            line = wrapper.args[1]
            assert isinstance(line, ast.Call) and getattr(line.func, "id", "") == "slow_job_line", (name, text)
            if provider is not None:
                assert ast.literal_eval(line.args[0]) == provider, (name, text)


def test_veo_names_the_api_it_polled() -> None:
    raises = {text: wrapper for text, wrapper in _timeout_raises(BACKEND / "handlers" / "veo.py")}
    names = sorted(ast.literal_eval(w.args[1].args[0]) for w in raises.values())
    assert names == ["Gemini", "Google Vertex AI"]


def test_the_runway_and_replicate_polls_name_their_provider() -> None:
    source = (BACKEND / "handlers" / "runway.py").read_text() + (BACKEND / "handlers" / "replicate_model.py").read_text() \
        + (BACKEND / "handlers" / "replicate_universal.py").read_text()
    assert source.count('provider="Runway"') == 1
    assert source.count('provider="Replicate"') == 2


def test_a_free_wait_keeps_the_classifiers_line() -> None:
    # Gemini's file processing (an upload, not a paid job) is not a paid job.
    source = (BACKEND / "handlers" / "gemini_omni.py").read_text()
    assert 'raise RuntimeError("Timed out waiting for Gemini Omni video file to become ACTIVE")' in source


# -- 3. empty or malformed answers --------------------------------------------


@pytest.mark.parametrize("text, definition_id, keys, provider", [
    ("Meshy did not return task ID: {'result': None}", "meshy-text-to-3d", {"MESHY_API_KEY": "x"}, "Meshy"),
    ("Runway returned no output URLs", "runway-image", {"RUNWAY_API_KEY": "x"}, "Runway"),
    ("fal.ai finished without returning a video", "flux-3-video", {"FAL_KEY": "x"}, "fal.ai"),
    ("Grok completed but no video URL: {'status': 'done'}", "grok-imagine-video", {"XAI_API_KEY": "x"}, "xAI"),
    ("Black Forest Labs returned non-JSON (200)", "flux-3-video", {"BFL_API_KEY": "x"}, "Black Forest Labs"),
    ("BytePlus ModelArk returned an unexpected response", "seedream-4-5", {"BYTEPLUS_API_KEY": "x"}, "BytePlus"),
    ("Krea MCP returned no usable structured result", "krea-2-generate", {"_kreaAuth": "mcp"}, "Krea"),
    ("Veo (Vertex) completed but returned no video: ['done']", "veo-3", {"GOOGLE_VERTEX_CREDENTIALS": "x"},
     "Google Vertex AI"),
])
def test_an_empty_or_malformed_answer_says_the_provider_returned_no_result(text, definition_id, keys,
                                                                            provider) -> None:
    params = {"_kreaAuth": "mcp"} if keys.pop("_kreaAuth", None) else {}
    card = _card(RuntimeError(text), definition_id, params, keys)
    assert card.person == f"{provider} didn't return a result. Run the node again."
    assert card.provider_text is True


def test_a_filtered_answer_keeps_the_moderation_card() -> None:
    card = _card(RuntimeError("xAI returned no image (the request may have been filtered by moderation)"),
                 "grok-imagine-image", {}, {"XAI_API_KEY": "x"})
    assert card.person is None


# -- 4. a connected file that isn't there ---------------------------------------


@pytest.mark.parametrize("what, value, kind", [
    ("image file", None, "image"), ("Image input", None, "image"), ("Mask", None, "image"),
    ("Veo frame", None, "image"), ("Veo clip", None, "video"), ("Video input", None, "video"),
    ("Dubbing audio", None, "audio"), ("Speech-to-speech audio", None, "audio"),
    ("Gemini Omni input", "/outputs/run/a.mp4", "video"), ("file", "/x/take.wav", "audio"),
    ("Media", "/x/a.PNG", "image"),
])
def test_a_missing_file_says_image_audio_or_video_in_words(what, value, kind) -> None:
    from execution.person_line import missing_file_line

    assert missing_file_line(what, value) == (
        f"A connected {kind} file can't be found. Connect it again, then run the node again.")


def test_a_missing_file_of_another_kind_uses_the_inputs_own_name() -> None:
    from execution.person_line import missing_file_line

    assert missing_file_line("Mesh", "/x/a.glb") == (
        "A connected mesh file can't be found. Connect it again, then run the node again.")


@pytest.mark.asyncio
async def test_gemini_omnis_missing_media_names_its_kind() -> None:
    from handlers.gemini_omni import _load_bytes

    exc = await _araised(_load_bytes, "/no/such/take.mp4")
    assert str(exc) == "Media not found: /no/such/take.mp4"
    assert person_line(exc) == "A connected video file can't be found. Connect it again, then run the node again."


def test_the_frame_extractors_missing_source_uses_gms_line() -> None:
    source = (BACKEND / "execution" / "engine.py").read_text()
    assert ('raise with_person_line(ValueError("Video source file not found; restore or upload the source video '
            'before extracting frames"), missing_file_line("video file"))') in source


def test_every_file_not_found_names_its_kind() -> None:
    # No bare missing_file_line(): each names its input or passes the value.
    for folder in ("handlers", "execution", "services"):
        for path in sorted((BACKEND / folder).glob("*.py")):
            if path.name == "person_line.py":
                continue
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "missing_file_line":
                    assert node.args, f"{path.name}:{node.lineno}"


def test_a_checked_media_file_names_its_kind(tmp_path, monkeypatch) -> None:
    from services import media_input

    monkeypatch.setattr("services.file_access.require_allowed_path", lambda value: Path(value))
    exc = _raised(media_input.checked_local_file, str(tmp_path / "gone.mp3"), label="Dubbing audio", max_bytes=10)
    assert str(exc) == f"Dubbing audio not found: {tmp_path / 'gone.mp3'}"
    assert person_line(exc) == "A connected audio file can't be found. Connect it again, then run the node again."


# -- 5. every missing-key shape that reaches the card ------------------------


def test_veo_on_vertex_only_asks_for_the_vertex_credentials() -> None:
    from execution.missing_credential import MissingCredentialError
    from handlers.veo import VERTEX_ONLY_MESSAGE

    source = (BACKEND / "handlers" / "veo.py").read_text()
    assert "raise with_person_line(MissingCredentialError(VERTEX_ONLY_MESSAGE), key_line([VERTEX_KEY]))" in source \
        or 'raise with_person_line(MissingCredentialError(VERTEX_ONLY_MESSAGE), key_line(["GOOGLE_VERTEX_CREDENTIALS"]))' in source
    assert person_line(MissingCredentialError(VERTEX_ONLY_MESSAGE)) is None  # the class reads only "<KEY> is required"


@pytest.mark.asyncio
async def test_a_route_table_run_with_no_key_for_its_route_says_add_it() -> None:
    from execution import maker_routes

    router = maker_routes.multi_route({})
    exc = await _araised(router, _node("flux-3-video", {"_provider": "replicate"}), {"prompt": _port("p")}, {})
    assert str(exc) == ("FLUX 3 Video is set to Replicate, which needs REPLICATE_API_TOKEN. "
                        "Add it in Settings > Providers or choose another provider.")
    assert person_line(exc) == "Add your Replicate API token in Settings, then run the node again."


def _settings_label(key: str) -> str:
    source = (REPO / "frontend" / "src" / "lib" / "providerCatalog.ts").read_text()
    match = re.search(rf"key: '{key}', label: '([^']+)'", source)
    assert match, key
    return match.group(1)


@pytest.mark.asyncio
async def test_krea_usage_names_the_settings_field_by_its_real_label() -> None:
    from handlers.krea_workspace import handle_krea_usage

    exc = await _araised(handle_krea_usage, _node("krea-usage"), {}, {})
    assert str(exc) == ("Krea usage needs a workspace service key (KREA_USAGE_KEY); personal API tokens are "
                        "refused by Krea")
    assert person_line(exc) == ("Krea usage needs a workspace service key, and Krea doesn't accept personal API "
                                f"tokens for it. Add one to “{_settings_label('KREA_USAGE_KEY')}” in Settings. "
                                "Nothing was sent to Krea.")


def test_jev_modes_key_line_is_gms() -> None:
    from services.qc_jev import setup

    exc = _raised(setup, {}, {})
    assert str(exc) == "TYPESAFE_API_KEY is required for Jev mode"
    assert person_line(exc) == "Add your TypeSafe API key in Settings, then run the node again."


# -- 6. GM's Krea lines --------------------------------------------------------


@pytest.mark.asyncio
async def test_krea_1_training_an_account_only_model_on_the_api_token() -> None:
    from handlers.krea import handle_krea_style_train

    node = _node("krea-style-train", {"_kreaAuth": "api-token", "name": "mine", "model": "k1"})
    exc = await _araised(handle_krea_style_train, node, {"images": _port(["https://e.com/a.png"], "Image")}, {})
    assert str(exc) == "Krea trains k1 styles only on a connected Krea account; nothing was sent"
    assert person_line(exc) == "Training Krea 1 styles needs the “Krea account” connection. Nothing was sent to Krea."


@pytest.mark.asyncio
async def test_krea_2_style_search_fields_the_account_cant_use() -> None:
    from handlers.krea import _account_style_search

    exc = await _araised(_account_style_search, _node("krea-style-search", {"user": "me", "liked": True,
                                                                             "filter": "user"}))
    assert str(exc) == ("User, Liked only, Filter needs a Krea API token; the Krea account lists the styles "
                        "available to you. Nothing was sent")
    assert person_line(exc) == ("To use “User”, “Liked Only” and “Filter”, switch to the “API token” connection. "
                                "The “Krea account” connection lists every style you can use. Nothing was sent to Krea.")
    exc = await _araised(_account_style_search, _node("krea-style-search", {"user": "me"}))
    assert person_line(exc) == ("To use “User”, switch to the “API token” connection. The “Krea account” connection "
                                "lists every style you can use. Nothing was sent to Krea.")


@pytest.mark.asyncio
async def test_krea_3_training_settings_the_account_cant_use() -> None:
    from handlers.krea import _account_style_train

    node = _node("krea-style-train", {"max_train_steps": 100, "training_type": "Default"})
    exc = await _araised(_account_style_train, node, "mine", "flux_dev", ["https://e.com/a.png"], None)
    assert str(exc) == ("Max steps, Type: Default needs a Krea API token; the Krea account trains with Krea's "
                        "defaults. Nothing was sent")
    assert person_line(exc) == ("To use “Max Steps” and “Type” set to Default, switch to the “API token” connection. "
                                "The “Krea account” connection trains with Krea's default settings. "
                                "Nothing was sent to Krea.")


@pytest.mark.asyncio
async def test_krea_4_the_api_token_only_renames_styles() -> None:
    from handlers.krea import handle_krea_library_manage

    node = _node("krea-library-manage", {"_kreaAuth": "api-token", "action": "delete-style", "item_id": "abc",
                                         "confirm_delete": "abc"})
    exc = await _araised(handle_krea_library_manage, node, {}, {"KREA_API_TOKEN": "fixture"})
    assert str(exc) == ("Only renaming a style works with a Krea API token; use the Krea account for moodboards "
                        "and deletes. Nothing was sent")
    assert person_line(exc) == ("The “API token” connection can only rename styles. To make moodboards or delete "
                                "styles, switch to the “Krea account” connection. Nothing was sent to Krea.")


@pytest.mark.asyncio
async def test_krea_5_job_history_on_the_account() -> None:
    from handlers.krea_workspace import handle_krea_job_history

    exc = await _araised(handle_krea_job_history, _node("krea-job-history", {"_kreaAuth": "mcp"}), {}, {})
    assert str(exc) == ("Listing job history needs a Krea API token; the Krea account can fetch one job by ID. "
                        "Nothing was sent")
    assert person_line(exc) == ("Job history needs the “API token” connection. The “Krea account” connection can "
                                "look up one job by its ID. Nothing was sent to Krea.")


class _Account:
    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers

    async def call(self, name, arguments=None):
        return self.answers[name]


@pytest.mark.asyncio
async def test_krea_6_an_app_version_the_account_cant_run() -> None:
    from handlers.krea_workspace import _account_node_app

    exc = await _araised(_account_node_app, _Account({"get_node_apps": {"node_apps": []}}), "v1")
    assert str(exc) == ("This node app version is not runnable from your Krea account (only public and "
                        "workspace-shared apps are)")
    assert person_line(exc) == ("This app version can't run from your Krea account. Only public apps and apps "
                                "shared with your workspace can. Nothing was sent to Krea.")


def _desktop_account(monkeypatch, tools: list[dict[str, Any]]) -> None:
    import services.krea_account as krea_account

    @asynccontextmanager
    async def account_tools():
        yield _Account({"get_desktop_tools": {"tools": tools}})

    monkeypatch.setattr(krea_account, "account_tools", account_tools)


@pytest.mark.asyncio
async def test_krea_7_an_app_id_that_isnt_one(monkeypatch) -> None:
    from handlers.krea_workspace import handle_krea_desktop

    _desktop_account(monkeypatch, [])
    exc = await _araised(handle_krea_desktop, _node("krea-desktop", {"action": "list-tools", "app_id": "nope"}), {}, {})
    assert str(exc) == "Enter the app ID from Krea Desktop Apps (list apps first)"
    assert person_line(exc) == "Enter an app ID from the Apps page in Krea Desktop, or list your apps to find one."


@pytest.mark.parametrize("call", ["krea", "gateway"])
@pytest.mark.asyncio
async def test_krea_9_a_connection_that_isnt_set(call) -> None:
    if call == "krea":
        from handlers.krea import _auth_mode

        exc = _raised(_auth_mode, _node("krea-style-search", {"_kreaAuth": "nope"}))
    else:
        from handlers.krea_gateway import handle_krea_gateway

        exc = await _araised(handle_krea_gateway, _node("krea-video-bytedance-seedance-2", {"_kreaAuth": "nope"}), {}, {})
    assert str(exc) == "Unknown Krea connection; choose API token or Krea account"
    assert person_line(exc) == "This node's Krea connection isn't set. Choose “API token” or “Krea account”."


APP_ID = "0123abcd-0123-4567-89ab-0123456789ab"


@pytest.mark.asyncio
async def test_krea_10_an_input_the_app_refused(monkeypatch) -> None:
    from execution.person_line import carries_provider_text
    from handlers.krea_workspace import handle_krea_desktop

    schema = {"type": "object", "properties": {"layer": {"type": "string", "title": "Layer name"},
                                               "count": {"type": "integer"}}}
    _desktop_account(monkeypatch, [{"name": "Rename Layer", "inputSchema": schema}])
    node = _node("krea-desktop", {"action": "call-tool", "app_id": APP_ID, "tool": "Rename Layer",
                                  "input": json.dumps({"layer": 3})})
    exc = await _araised(handle_krea_desktop, node, {}, {})
    assert str(exc) == "Rename Layer input: 3 is not of type 'string'; nothing was sent"
    assert person_line(exc) == ("The Rename Layer app didn't accept the value for “Layer name”. "
                                "Nothing was sent to Krea.")
    # The validator's own message is behind Details, like any provider text.
    assert carries_provider_text(exc)
    # A property with no name the person sees: the first form.
    node = _node("krea-desktop", {"action": "call-tool", "app_id": APP_ID, "tool": "Rename Layer",
                                  "input": json.dumps({"count": "x"})})
    exc = await _araised(handle_krea_desktop, node, {}, {})
    assert person_line(exc) == "The Rename Layer app didn't accept this input. Nothing was sent to Krea."


def test_a_node_apps_refused_input_reads_the_same_way() -> None:
    from execution.person_line import carries_provider_text
    from handlers.krea_workspace import _check_input

    exc = _raised(_check_input, {"type": "object", "properties": {"steps": {"type": "integer"}}}, {"steps": "x"})
    assert str(exc) == "Node app steps: 'x' is not of type 'integer'; nothing was sent"
    assert person_line(exc) == "The node app didn't accept this input. Nothing was sent to Krea."
    assert carries_provider_text(exc)


# -- 7. no provider model ids, values or parentheses on the card -------------


def test_seedances_dated_ids_leave_the_card() -> None:
    from execution.byteplus_seedance_prices import SEEDANCE_1_0_PRO, SEEDANCE_1_0_PRO_FAST, SEEDANCE_2_5
    from execution.maker_routes_byteplus_seedance import _frames, _resolution, _whole_seconds

    exc = _raised(_resolution, "4k", SEEDANCE_2_5)
    assert str(exc) == "BytePlus's dreamina-seedance-2-5-260628 renders 480p, 720p, 1080p, not '4k'"
    assert person_line(exc) == "Seedance 2.5 on BytePlus renders 480p, 720p or 1080p. Pick one in the node's Resolution field."
    exc = _raised(_whole_seconds, 3.5, SEEDANCE_2_5)
    assert str(exc).startswith("BytePlus takes whole seconds from 4 to 30 for this model (received 3.5).")
    # GM's own example of the rule.
    assert person_line(exc) == "Set Duration to whole seconds from 4 to 30. It was 3.5."
    exc = _raised(_frames, SEEDANCE_1_0_PRO_FAST, ["https://e.com/a.png"], ["https://e.com/end.png"])
    assert str(exc) == f"BytePlus's {SEEDANCE_1_0_PRO_FAST} takes a start image only, not an end image"
    assert person_line(exc) == ("Seedance 1.0 Pro Fast on BytePlus takes a start image only. Disconnect the end "
                                "image, then run the node again.")
    exc = _raised(_frames, SEEDANCE_1_0_PRO, [], ["https://e.com/end.png"])
    assert str(exc) == "BytePlus needs a start image to use an end image (first and last frames)"
    assert person_line(exc) == "BytePlus needs a start image to use an end image. Connect one, then run the node again."


def test_no_person_line_puts_a_model_value_on_the_card() -> None:
    # A `{model}` in a line is the provider's model id (or a list of them);
    # the line names the model the way the node shows it.
    from tests.test_error_copy_round3c2 import _raises, _run_time_files, _template  # noqa: F401

    for path in _run_time_files():
        source = path.read_text()
        for _lined, _text, exc, wrapper in _raises(path):
            if wrapper is None:
                continue
            node = exc.args[0] if wrapper.func.id == "as_person_line" else (
                wrapper.args[1] if len(wrapper.args) > 1 else None)
            if node is None:
                continue
            for part in ast.walk(node):
                if isinstance(part, ast.FormattedValue):
                    expression = ast.get_source_segment(source, part.value) or ""
                    if re.search(r"model", expression, re.I):
                        assert re.search(r"label|name|display", expression, re.I), (
                            f"{path.relative_to(BACKEND)}:{exc.lineno}", expression)


def test_the_guard_knows_kebab_and_dated_ids_and_parentheses() -> None:
    from tests.test_error_copy_round3c2 import forbidden_in_a_line

    for line in ("BytePlus's dreamina-seedance-2-5-260628 renders 720p", "Pick gpt-image-2 here",
                 "xAI's grok-imagine-video takes one", "Seedream takes 10 (received 12)",
                 "Use seedance-1-0-pro-250528"):
        assert forbidden_in_a_line(line), line
    for line in ("Audio input is required for speech-to-speech", "Meshy text-to-3D needs a prompt",
                 "On Vertex, reference images only make 8-second videos", "Set the node's Duration (ms) to 3."):
        assert not forbidden_in_a_line(line), line


def test_nebulas_words_around_a_providers_keep_the_providers_behind_details() -> None:
    # Two lines wrap Nebula's instruction around the provider's own words
    # (3c-2's allowlist): the card shows the instruction, Details the rest.
    for name, start in (("handlers/elevenlabs.py", "Your ElevenLabs API key can't list your voices ({exc})"),
                        ("services/typesafe_client.py", "{label} is damaged or incomplete: {exc}")):
        source = (BACKEND / name).read_text()
        calls = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)
                 and getattr(node.func, "id", "") == "with_provider_line"
                 and start in (ast.get_source_segment(source, node.args[0]) or "")]
        assert calls, name


def test_a_provider_line_marks_the_text_as_the_providers() -> None:
    from execution.person_line import carries_provider_text, with_person_line, with_provider_line

    plain = with_person_line(ValueError("x"), "A line.")
    assert not carries_provider_text(plain)
    marked = with_provider_line(ValueError("Provider said: no"), "A line.")
    assert carries_provider_text(marked)
    assert person_line(marked) == "A line."
    assert str(marked) == "Provider said: no"


def test_a_value_goes_in_its_own_sentence() -> None:
    # GM: "the value goes in its own sentence or into the line".
    from execution.person_line import it_was

    assert it_was(3.5) == "It was 3.5."
    assert it_was(True) == "It was on."
    assert it_was("") == it_was(None) == "It was empty."
    assert it_was("x" * 80) == f"It was {'x' * 39}…."


def test_every_seedance_id_has_its_name() -> None:
    from execution import byteplus_seedance_prices as prices
    from execution.person_line import model_name
    from tests.test_error_copy_round3c2 import forbidden_in_a_line

    ids = [value for name, value in vars(prices).items() if name.startswith("SEEDANCE_") and isinstance(value, str)]
    assert len(ids) == 7
    for model in ids:
        name = model_name(model)
        assert name.startswith("Seedance ") and not forbidden_in_a_line(name), (model, name)
    # A node's own Model option wins, less its note in parentheses.
    assert model_name("claude-opus-4-7", "claude-chat") == "Claude Opus 4.7"
    assert model_name("no-such-model-1") == "This model"


def test_a_range_line_names_the_field_by_its_label_not_its_key() -> None:
    from handlers.ideogram import _validate_int_range

    exc = _raised(_validate_int_range, _node("ideogram-transparent", {"num_images": 9}), "num_images", 1, 8,
                  "Ideogram num_images")
    assert str(exc) == "Ideogram num_images must be an integer from 1 to 8 (received 9)"
    assert person_line(exc) == "Set Images to a whole number from 1 to 8. It was 9."


def test_a_reasoning_effort_line_names_the_model_and_levels_as_the_node_shows_them() -> None:
    from handlers.openai_chat import _listed_effort

    exc = _raised(_listed_effort, "gpt-6-astra", "none")
    assert str(exc) == "Reasoning effort 'none' isn't available for gpt-6-astra. Pick one of: low, medium, high, xhigh, max."
    assert person_line(exc) == ("GPT-6 Astra doesn't offer Reasoning Effort None. "
                                "Pick Low, Medium, High, X-High or Max, then run the node again.")


def test_hailuo_and_grok_lines_name_the_model_not_its_id() -> None:
    from execution.maker_routes_minimax_meshy import krea_hailuo_to_minimax
    from execution.maker_routes_xai import GROK_VIDEO_MAX_REFERENCES, krea_grok_video_to_xai

    translate = krea_hailuo_to_minimax("MiniMax-Hailuo-2.3")
    exc = _raised(translate, _node("krea-video-minimax-hailuo-2-3", {"prompt": "a", "start_image": "https://e.com/a.png",
                                                                      "end_image": "https://e.com/b.png", "duration": 6}), {})
    assert "MiniMax-Hailuo-2.3 can't take" in str(exc)
    assert person_line(exc).startswith("MiniMax's first-and-last-frame mode is Hailuo 02 only, so Hailuo 2.3 can't take")

    translate = krea_grok_video_to_xai("grok-imagine-video-1.5")
    refs = [f"https://e.com/{n}.png" for n in range(GROK_VIDEO_MAX_REFERENCES + 1)]
    exc = _raised(translate, _node("krea-video-xai-grok-video-1-5", {"prompt": "a", "duration": 6,
                                                                     "reference_images": refs}), {})
    assert str(exc).startswith("grok-imagine-video-1.5 takes up to")
    assert person_line(exc) == (f"Grok Imagine 1.5 takes up to {GROK_VIDEO_MAX_REFERENCES} reference images, and "
                                f"{GROK_VIDEO_MAX_REFERENCES + 1} are connected. Disconnect the extra ones, then run "
                                "the node again.")


# -- review of 3d -------------------------------------------------------------
# Four findings from the review, each pinned before its fix.


@pytest.mark.parametrize("code, message, line", [
    # MiniMax V1 answers HTTP 200 with its own code and no task id
    # (platform.minimax.io/docs/api-reference/errorcode).
    (1008, "insufficient balance", "Your MiniMax account is out of credits. Add credits, then run the node again."),
    (1004, "login fail", "MiniMax didn't accept your API key. Check it in Settings, then run the node again."),
    (2049, "invalid api key", "MiniMax didn't accept your API key. Check it in Settings, then run the node again."),
])
@pytest.mark.asyncio
async def test_minimaxs_own_code_for_a_key_or_credits_says_so(monkeypatch, code, message, line) -> None:
    import handlers.minimax as minimax

    answer = {"task_id": "", "base_resp": {"status_code": code, "status_msg": message}}
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=answer))
    real_client = httpx.AsyncClient
    monkeypatch.setattr(minimax.httpx, "AsyncClient", lambda **kwargs: real_client(transport=transport))
    exc = await _araised(minimax.handle_minimax_video, _node("minimax-t2v", {"model": "MiniMax-Hailuo-2.3"}),
                         {"prompt": _port("a lighthouse")}, {"MINIMAX_API_KEY": "fixture"})
    # Agents read MiniMax's answer word for word; the card says what to do.
    assert str(exc) == f"MiniMax did not return task_id: {answer}"
    card = _card(exc, "minimax-t2v", {}, {"MINIMAX_API_KEY": "fixture"})
    assert card.person == line
    assert card.provider_text is True


@pytest.mark.asyncio
async def test_minimaxs_other_codes_keep_the_no_result_line(monkeypatch) -> None:
    import handlers.minimax as minimax

    answer = {"base_resp": {"status_code": 0, "status_msg": "success"}}
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=answer))
    real_client = httpx.AsyncClient
    monkeypatch.setattr(minimax.httpx, "AsyncClient", lambda **kwargs: real_client(transport=transport))
    exc = await _araised(minimax.handle_minimax_video, _node("minimax-t2v"), {"prompt": _port("a")},
                         {"MINIMAX_API_KEY": "fixture"})
    assert person_line(exc) is None
    assert _card(exc, "minimax-t2v", {}, {"MINIMAX_API_KEY": "x"}).person == (
        "MiniMax didn't return a result. Run the node again.")


def test_insufficient_balance_reads_as_credits_for_any_provider() -> None:
    card = _card(RuntimeError("Meshy submit failed (400): insufficient balance"), "meshy-text-to-3d", {},
                 {"MESHY_API_KEY": "x"})
    assert card.person == CREDITS


@pytest.mark.parametrize("text, definition_id, keys, provider", [
    ("Krea completed without media URLs", "krea-2-generate", {"KREA_API_TOKEN": "x"}, "Krea"),
    ("MiniMax returned Success but no file_id: {}", "minimax-t2v", {"MINIMAX_API_KEY": "x"}, "MiniMax"),
    ("Veo (Vertex) returned a video with no data", "veo-3", {"GOOGLE_VERTEX_CREDENTIALS": "x"}, "Google Vertex AI"),
    ("World Labs returned an empty asset: a.spz", "meshy-text-to-3d", {"MESHY_API_KEY": "x"}, "World Labs"),
    ("World Labs world completed without any SPZ assets", "meshy-text-to-3d", {"MESHY_API_KEY": "x"},
     "World Labs"),
    ("Replicate stream closed without a 'done' event (status=200, events=0).", "flux-3-video",
     {"REPLICATE_API_TOKEN": "x"}, "Replicate"),
    ("Image stream ended without a final image event (provider=openai, fal_request_id=unavailable). "
     "Last 0 raw events: (no events received)", "gpt-image-1-generate", {"OPENAI_API_KEY": "x"}, "OpenAI"),
    ("Image edit stream ended without a final image event. events=0", "gpt-image-1-generate",
     {"OPENAI_API_KEY": "x"}, "OpenAI"),
    ("Quiver stream ended without a final `content` event", "meshy-text-to-3d", {"MESHY_API_KEY": "x"},
     "QuiverAI"),
])
def test_every_empty_answer_shape_says_the_provider_returned_no_result(text, definition_id, keys,
                                                                        provider) -> None:
    card = _card(RuntimeError(text), definition_id, {}, keys)
    assert card.person == f"{provider} didn't return a result. Run the node again."
    assert card.provider_text is True


@pytest.mark.parametrize("text", [
    "Async job timed out after 300 polls (600s)",
    "Krea job still processing after 60 status polls",
    "Gemini Omni ended the stream early: connection reset",
])
def test_a_wait_or_a_dropped_stream_is_not_an_empty_answer(text) -> None:
    from execution.provider_status import failure_kind

    assert failure_kind(RuntimeError(text)) != "no_result"


def test_every_route_table_nodes_missing_file_uses_gms_line(tmp_path, monkeypatch) -> None:
    from execution.route_clients import local_media_path

    monkeypatch.setattr("services.file_access.require_allowed_path", lambda value: Path(value))
    exc = _raised(local_media_path, str(tmp_path / "gone.png"))
    assert str(exc) == "A wired input isn't a readable file: gone.png"
    assert person_line(exc) == "A connected image file can't be found. Connect it again, then run the node again."
    exc = _raised(local_media_path, str(tmp_path / "take.mp4"))
    assert person_line(exc) == "A connected video file can't be found. Connect it again, then run the node again."


def test_save_to_krea_files_missing_file_uses_gms_line(tmp_path, monkeypatch) -> None:
    from handlers.krea_workspace import _local_path

    monkeypatch.setattr("services.file_access.require_allowed_path", lambda value: Path(value))
    # A deleted local output, not a remote URL.
    exc = _raised(_local_path, str(tmp_path / "gone.png"))
    assert str(exc) == "Save to Krea Files input is not a readable file"
    assert person_line(exc) == "A connected image file can't be found. Connect it again, then run the node again."
    # A path that is there but isn't a file.
    folder = tmp_path / "folder"
    folder.mkdir()
    exc = _raised(_local_path, str(folder))
    assert str(exc) == "Save to Krea Files input is not a readable file"
    assert person_line(exc) == "A connected file can't be found. Connect it again, then run the node again."
    # A remote URL keeps its own line.
    exc = _raised(_local_path, "https://example.com/a.png")
    assert person_line(exc) == "Save to Krea Files takes Nebula media from this machine, not remote URLs"


def test_krea_media_input_missing_file_uses_gms_line(tmp_path) -> None:
    from handlers.krea_gateway import _asset_data

    exc = _raised(_asset_data, str(tmp_path / "gone.mp4"))
    assert str(exc) == "Krea media input is not a readable local file"
    assert person_line(exc) == "A connected video file can't be found. Connect it again, then run the node again."


def test_a_chat_nodes_missing_image_uses_gms_line(tmp_path, monkeypatch) -> None:
    from services.image_input import load_local_image

    monkeypatch.setattr("services.file_access.require_allowed_path", lambda value: Path(value))
    gone = str(tmp_path / "gone.png")
    exc = _raised(load_local_image, gone)
    assert str(exc) == (f"Image input not found: {gone!r}. The file does not exist, so it was NOT sent to the "
                        "model. Check the path — a wrong working directory is the usual cause.")
    assert person_line(exc) == "A connected image file can't be found. Connect it again, then run the node again."
    exc = _raised(load_local_image, str(tmp_path))
    assert str(exc) == f"Image input is not a file: {str(tmp_path)!r}. It was NOT sent to the model."
    assert person_line(exc) == "A connected image file can't be found. Connect it again, then run the node again."


@pytest.mark.parametrize("text, definition_id, params, keys", [
    # The job ran: the key and the service answered. A status or auth word in
    # the job's own error is about the job (an input URL it couldn't fetch, a
    # model crash), never the person's key.
    ("Async job failed: HTTPError: 403 Client Error: Forbidden for url: https://cdn.example/a.png",
     "flux-3-video", {"_provider": "replicate"}, {"REPLICATE_API_TOKEN": "x", "FAL_KEY": "x"}),
    ("Async job failed: CUDA error 500 on the worker", "flux-3-video", {"_provider": "replicate"},
     {"REPLICATE_API_TOKEN": "x", "FAL_KEY": "x"}),
    ("Async job failed: unauthorized to fetch input", "flux-3-video", {"_provider": "replicate"},
     {"REPLICATE_API_TOKEN": "x", "FAL_KEY": "x"}),
    ("Async job failed: Could not fetch input (HTTP 401) from https://cdn.example/a.png", "flux-3-video",
     {}, {"FAL_KEY": "x"}),
    ("Meshy task failed: Image download failed with status 403", "meshy-text-to-3d", {}, {"MESHY_API_KEY": "x"}),
    ("Meshy task canceled: status 503", "meshy-text-to-3d", {}, {"MESHY_API_KEY": "x"}),
    ("FAL job failed: upstream error 502", "flux-3-video", {}, {"FAL_KEY": "x"}),
    ("Krea job failed: input fetch returned 403", "krea-2-generate", {}, {"KREA_API_TOKEN": "x"}),
    ("Krea job 4f1c-77 cancelled: HTTP 401", "krea-2-generate", {}, {"KREA_API_TOKEN": "x"}),
    ("MiniMax task failed: download error 403", "minimax-t2v", {}, {"MINIMAX_API_KEY": "x"}),
    ("MiniMax H3 task failed: forbidden (1004)", "minimax-t2v", {}, {"MINIMAX_API_KEY": "x"}),
    ("OpenRouter video failed: provider error 500", "flux-3-video", {}, {"OPENROUTER_API_KEY": "x"}),
    ("Gemini Omni interaction failed: {'code': 403}", "flux-3-video", {}, {"GOOGLE_API_KEY": "x"}),
    ("Grok failed: status 500", "grok-imagine-video", {}, {"XAI_API_KEY": "x"}),
    ("Higgsfield failed: error 503", "flux-3-video", {}, {"HIGGSFIELD_API_KEY": "x"}),
    ("ElevenLabs Dubbing failed: HTTP 401 fetching the source", "flux-3-video", {}, {"ELEVENLABS_API_KEY": "x"}),
    ("World Labs operation failed: status 500", "flux-3-video", {}, {"WORLDLABS_API_KEY": "x"}),
    ("Veo failed: {'code': 403, 'message': 'forbidden'}", "veo-3", {}, {"GOOGLE_API_KEY": "x"}),
    ("Veo (Vertex) failed: {'code': 500}", "veo-3", {}, {"GOOGLE_VERTEX_CREDENTIALS": "x"}),
    ("Replicate stream error: CUDA error 500", "flux-3-video", {}, {"REPLICATE_API_TOKEN": "x"}),
])
def test_a_job_that_ran_and_failed_never_blames_the_key_or_the_service(text, definition_id, params, keys) -> None:
    card = _card(RuntimeError(text), definition_id, params, keys)
    assert card.person is None
    assert card.provider_text is False


@pytest.mark.parametrize("text, line", [
    # The same providers' API answers before a job runs still read the table.
    ("Meshy submit failed (401): no", KEY),
    ("Meshy task failed: insufficient credits", CREDITS),
])
def test_a_submit_failure_and_a_jobs_out_of_credits_still_read_the_table(text, line) -> None:
    assert _card(RuntimeError(text), "meshy-text-to-3d", {}, {"MESHY_API_KEY": "x"}).person == line


@pytest.mark.parametrize("text", [
    "OpenRouter video failed (402): out of credits. Add credits",
    "World Labs world generation failed (401): no",
    "MiniMax H3 submit failed (401): bad key.",
    "Replicate prediction failed (429): slow down",
])
def test_an_api_answer_that_says_failed_is_not_a_job_failure(text) -> None:
    from execution.provider_status import failure_kind

    assert failure_kind(RuntimeError(text)) in {"key", "credits", "busy"}
