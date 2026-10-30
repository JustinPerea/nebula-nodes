"""Idol (speridlabs-idol) on its Hugging Face Space, handlers/speridlabs_idol.py.

Every request is answered by fake hosts (tests/speridlabs_fakes.py): no test
reaches Hugging Face, joins the Space's queue or uses anyone's GPU time. The
Space's /run signature is the pinned /gradio_api/info fixture.
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from execution import route_clients
from execution.person_line import carries_provider_text, person_line
from handlers import speridlabs_idol as idol
from models.graph import GraphNode, PortValueDict
from services import node_readiness, node_route
from services.splat_ply import summarize_splat_ply
from tests.speridlabs_fakes import (
    API, HUB, IMAGE, INFO, INFO_PATH, PNG, RESULT_URL, SPACE, UPLOADED, complete, idol_hosts, public_dns,
    run_schema, space_routes, splat_ply, sse,
)
from tests.test_route_clients import FakeHosts, quick, registry_handler, validate  # noqa: F401

TOKEN = "hf_fixturetoken0123456789abcdefghijklmnop"
CHANGED = ("Idol changed on Hugging Face, and this version of Nebula can’t run it. Update Nebula, then try again.")
STARTING = "Idol is still starting on Hugging Face. Try again in a few minutes."
TOKEN_LINE = "Hugging Face didn’t accept your token. Check it in Settings."
UPLOADED_IMAGE = {"path": UPLOADED, "orig_name": "input.png", "meta": {"_type": "gradio.FileData"}}


@pytest.fixture(autouse=True)
def fast_wake(monkeypatch):
    monkeypatch.setattr(idol, "WAKE_POLL_INTERVAL", 0.0)


def registry() -> dict[str, Any]:
    from services.node_registry import NodeRegistry

    return NodeRegistry().get_all()


def node(**params: Any) -> GraphNode:
    return GraphNode(id="n1", definitionId="speridlabs-idol", params=params)


def image(value: Any = IMAGE) -> dict[str, PortValueDict]:
    return {"image": PortValueDict(type="Image", value=value)}


async def run_node(params: dict[str, Any] | None = None, inputs=None, keys: dict[str, str] | None = None):
    """The registry's handler for the node (multi_route over its route table)."""
    defaults = {p["key"]: p.get("default") for p in node_route.all_param_definitions(registry()["speridlabs-idol"])
                if p["key"] != "_provider"}
    saved = {**defaults, "_provider": "auto", **(params or {})}
    return await registry_handler("speridlabs-idol")(node(**saved), image() if inputs is None else inputs,
                                                     dict(keys or {}))


async def run_direct(inputs=None, keys=None, **params: Any):
    """The handler itself, with the Space's own param names and values."""
    saved = {"mode": "Synthetic", "gaussians": "262,144", "steps": 50, "cfg_scale": 3.0, "rescale_t": 3.0,
             "seed": 42, **params}
    return await idol.run_idol(node(**saved), image() if inputs is None else inputs, dict(keys or {}))


def world_of(out: dict[str, Any]) -> dict[str, Any]:
    assert out["world"]["type"] == "World"
    return out["world"]["value"]


def failure(excinfo) -> tuple[str, str | None]:
    return str(excinfo.value), person_line(excinfo.value)


# -- the pinned signature ---------------------------------------------------------


def test_the_pinned_info_is_the_spaces_run_signature_and_passes_the_check():
    run = INFO["named_endpoints"]["/run"]
    assert [p["parameter_name"] for p in run["parameters"]] == list(idol.RUN_PARAMS)
    assert [r["component"] for r in run["returns"]] == ["Model3d", "Number", "Html"]
    idol.check_signature(INFO)
    # The node's options are the Space's choices, through the route's valueMap.
    definition = registry()["speridlabs-idol"]
    route = definition["routes"][0]
    shared = {p["key"]: p for p in definition["sharedParams"]}
    assert [route["valueMap"]["mode"][o["value"]] for o in shared["mode"]["options"]] == list(idol.MODES)
    assert [route["valueMap"]["gaussians"][str(o["value"])] for o in shared["gaussians"]["options"]] == list(idol.GAUSSIANS)
    by_name = {p["parameter_name"]: p for p in run["parameters"]}
    for key in ("steps", "cfg_scale", "rescale_t", "seed"):
        assert shared[key]["default"] == by_name[key]["parameter_default"], key
    assert INFO_PATH.stat().st_size == 13741


@pytest.mark.parametrize("change, detail", [
    (lambda info: info["named_endpoints"].pop("/run"), "missing or unreadable"),
    (lambda info: info["named_endpoints"]["/run"]["parameters"].pop(6), "/run takes"),
    (lambda info: info["named_endpoints"]["/run"]["returns"].pop(), "/run returns"),
    (lambda info: info["named_endpoints"]["/run"]["parameters"][7]["type"]["enum"].append("2,097,152"),
     "Gaussians choices changed"),
    (lambda info: info["named_endpoints"]["/run"]["parameters"][1]["type"]["enum"].reverse(),
     "Input type"),
])
def test_a_changed_signature_is_refused_with_its_own_line(change, detail):
    info = json.loads(json.dumps(INFO))
    change(info)
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        idol.check_signature(info)
    text, line = failure(excinfo)
    assert detail in text
    assert line == CHANGED


# -- a run -------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_anonymous_run_sends_the_schema_body_and_returns_a_world_v2_splat(monkeypatch, capsys):
    hosts = idol_hosts(monkeypatch, stream=sse(("heartbeat", "null"), complete(seed=42)), ply=splat_ply(64))
    out = await run_node()
    body = hosts.json("POST", re.escape(f"{API}/call/run"))
    validate(run_schema(), body)
    assert body == {"data": [UPLOADED_IMAGE, "Synthetic", 50, 3.0, 3.0, 42, False, "262,144"]}
    # No token anywhere: an anonymous run sends no Authorization header.
    assert all("authorization" not in r.headers for r in hosts.requests)
    # A public URL is read by Nebula (load_media) and uploaded as input.png:
    # neither the URL nor its file name reaches the Space.
    [upload] = hosts.sent("POST", re.escape(f"{API}/upload"))
    assert PNG in upload.content and b'filename="input.png"' in upload.content
    assert IMAGE.encode() not in upload.content and b"chair" not in upload.content
    world = world_of(out)
    assert world["schemaVersion"] == 2 and world["kind"] == "world"
    assert world["coordinateSystem"] == {
        "schemaVersion": 1, "kind": "coordinate-system", "id": "idol-object", "handedness": "right",
        "upAxis": "-y", "forwardAxis": "x", "unit": "custom", "metersPerUnit": 1.0,
        "originMeters": [0.0, 0.0, 0.0]}
    session = world["session"]
    assert (session["source"], session["provider"], session["model"]) == ("generated", "speridlabs", "idol")
    # The node's own values, not the Space's labels; the count is the file's.
    assert session["tags"] == ["seed:42", "gaussians:64", "mode:synthetic", "steps:50"]
    [splat] = world["assets"]["splats"]
    # pointCount is the validated header's vertex count, not the dropdown's 262,144.
    assert (splat["id"], splat["format"], splat["pointCount"]) == ("splat", "ply", 64)
    from services.output import resolve_output_ref

    path = Path(resolve_output_ref(splat["asset"]["uri"]))
    assert path.read_bytes() == splat_ply(64)
    assert splat["asset"]["byteLength"] == path.stat().st_size
    assert not list(path.parent.glob("*.part"))
    assert "signed_in=False" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_a_signed_in_run_sends_the_token_only_to_hugging_face_and_never_prints_it(monkeypatch, capsys):
    hosts = idol_hosts(monkeypatch)
    out = await run_node(keys={"HF_TOKEN": TOKEN})
    assert hosts.requests
    for request in hosts.requests:
        host = request.url.host
        if host == "example.com":
            # The image is fetched without credentials (fetch_public_media).
            assert "authorization" not in request.headers
            continue
        assert request.url.scheme == "https" and host in ("huggingface.co", "speridlabs-idol.hf.space"), host
        assert request.headers.get("authorization") == f"Bearer {TOKEN}"
    printed = capsys.readouterr()
    assert TOKEN not in printed.out + printed.err
    assert "signed_in=True" in printed.err
    assert TOKEN not in json.dumps(out)


def test_the_token_is_never_sent_to_any_other_host():
    for url in ("https://example.com/a.png", "http://speridlabs-idol.hf.space/gradio_api/info",
                "https://hf.space.evil.com/x", "https://huggingface.co.evil.com/x", "https://evilhuggingface.co/x",
                "https://evilhf.space/x", "https://hf.space/x",
                # Any other Space: anyone can make one, so *.hf.space is not enough.
                "https://someone-else.hf.space/gradio_api/info", "https://idol.hf.space/x",
                "https://xsperidlabs-idol.hf.space/x", "https://speridlabs-idol.hf.space.evil.com/x",
                "https://api.huggingface.co/x", "https://speridlabs-idol.hf.space@evil.com/x"):
        assert idol._headers(url, TOKEN) == {}, url
    for url in (HUB, f"{API}/call/run", RESULT_URL, "https://huggingface.co./api/whoami-v2",
                "https://SPERIDLABS-IDOL.hf.space/gradio_api/info"):
        assert idol._headers(url, TOKEN) == {"Authorization": f"Bearer {TOKEN}"}, url
    assert idol.TOKEN_HOSTS == {"huggingface.co", "speridlabs-idol.hf.space"}


@pytest.mark.asyncio
async def test_the_route_maps_the_nodes_values_to_the_spaces_labels(monkeypatch):
    hosts = idol_hosts(monkeypatch)
    out = await run_node({"mode": "real", "gaussians": 1048576, "steps": 30, "cfg_scale": 4.5,
                          "rescale_t": 2, "seed": 7})
    body = hosts.json("POST", re.escape(f"{API}/call/run"))
    validate(run_schema(), body)
    assert body["data"][1:] == ["Real photo", 30, 4.5, 2.0, 7, False, "1,048,576"]
    # Tags use the node's values (real), not the Space's labels (Real photo).
    assert world_of(out)["session"]["tags"] == ["seed:42", "gaussians:64", "mode:real", "steps:30"]


@pytest.mark.asyncio
async def test_the_seed_the_space_reports_names_the_file_and_the_tags(monkeypatch):
    idol_hosts(monkeypatch, stream=sse(complete(seed=1234)))
    world = world_of(await run_direct(seed=1234))
    assert "seed:1234" in world["session"]["tags"]
    assert re.search(r"/idol-seed1234-262144-[0-9a-f]{8}\.ply$", world["assets"]["splats"][0]["asset"]["uri"])


@pytest.mark.asyncio
@pytest.mark.parametrize("value, kind", [("data", "data URI"), ("local", "local file")])
async def test_a_data_uri_or_local_image_is_uploaded_first(monkeypatch, value, kind):
    from services.output import OUTPUT_ROOT

    if value == "data":
        source = "data:image/png;base64," + base64.b64encode(PNG).decode()
    else:
        folder = Path(OUTPUT_ROOT) / "idol-inputs"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "chair.png").write_bytes(PNG)
        source = str(folder / "chair.png")
    hosts = idol_hosts(monkeypatch)
    await run_direct(inputs=image(source))
    [upload] = hosts.sent("POST", re.escape(f"{API}/upload"))
    assert PNG in upload.content and b'name="files"' in upload.content, kind
    # A neutral name: the person's file name never goes to the Space.
    assert b'filename="input.png"' in upload.content and b"chair" not in upload.content, kind
    body = hosts.json("POST", re.escape(f"{API}/call/run"))
    assert body["data"][0] == UPLOADED_IMAGE
    validate(run_schema(), body)


@pytest.mark.asyncio
async def test_a_list_image_value_uses_its_first_image(monkeypatch):
    hosts = idol_hosts(monkeypatch)
    await run_direct(inputs=image([IMAGE, "https://example.com/other.png"]))
    assert hosts.sent("GET", re.escape(IMAGE)) and not hosts.sent("GET", r".*/other\.png")


@pytest.mark.asyncio
async def test_progress_creeps_on_heartbeats_and_ends_at_one(monkeypatch):
    idol_hosts(monkeypatch, stream=sse(*[("heartbeat", "null")] * 3, ("generating", "[]"), complete()))
    seen: list[float] = []

    async def emit(event):
        seen.append(event.value)

    await idol.run_idol(node(mode="Synthetic", gaussians="262,144"), image(), {}, emit=emit)
    assert seen[:4] == pytest.approx([0.12, 0.14, 0.16, 0.18])
    assert seen[-1] == 1.0 and max(seen[:-1]) < 0.9


# -- readiness, price, key ----------------------------------------------------------


def test_the_node_runs_without_a_key_and_uses_the_token_when_set():
    definition = registry()["speridlabs-idol"]
    assert definition["envKeyName"] == []
    assert node_route.routes_problems(definition) == []
    params = {"_provider": "auto"}
    anonymous = node_route.select_route(definition, params, {})
    assert (anonymous.route_id, anonymous.key) == ("hf-space", None)
    signed_in = node_route.select_route(definition, params, {"HF_TOKEN": TOKEN})
    assert signed_in.key == "HF_TOKEN"
    assert node_route.route_unavailable(definition, params, {}) is None
    assert node_readiness.instance_access(definition, params, {}) == node_readiness.FREE
    assert node_readiness.instance_access(definition, params, {"HF_TOKEN": TOKEN}) == node_readiness.KEY


def test_a_keyless_route_is_validated():
    definition = json.loads(json.dumps(registry()["speridlabs-idol"]))
    route = definition["routes"][0]
    route["keys"] = ["HF_TOKEN"]
    assert any("optionalKeys" in p for p in node_route.routes_problems(definition))
    route["keys"], route["optionalKeys"] = [], ["NOT_A_KEY"]
    assert any("NOT_A_KEY" in p for p in node_route.routes_problems(definition))
    route["optionalKeys"], route["plan"] = ["HF_TOKEN"], "optional"
    assert node_route.routes_problems(definition)
    route.pop("plan")
    route.pop("optionalKeys")
    assert any("key" in p for p in node_route.routes_problems(definition))


def test_the_route_is_priced_at_zero_with_its_source():
    pricing = json.loads((Path(__file__).parents[1] / "data" / "model_pricing.json").read_text())
    entry = pricing["nodes"]["speridlabs-idol"]["routes"]["hf-space"]
    assert entry["rows"] == [{"match": {}, "price": 0}]
    sources = json.dumps(entry)
    assert "https://huggingface.co/docs/hub/spaces-zerogpu" in sources
    assert "$1 per 10" in sources or "1 per 10 minutes" in sources


# -- what can go wrong --------------------------------------------------------------


# The texts spaces 0.51.3 (spaces/zero/client.py schedule()) raises, word for
# word, with what each one is.
OWN_FREE = ("You have exceeded your free ZeroGPU quota (120s requested vs. 30s left). Try again in 3:12:00. "
            "Subscribe to Hugging Face PRO to get 40 min of ZeroGPU quota a day - "
            "https://huggingface.co/subscribe/pro?from=ZeroGPU")
OWN_PRO = ("You have exceeded your Pro ZeroGPU quota (120s requested vs. 0s left). Try again in 1:00:00. "
           "Add credits to keep using ZeroGPU. $1 for 10 minutes of ZeroGPU inference - "
           "https://huggingface.co/settings/billing?add-credits=true")
ANON_IP = ("You have exceeded your ZeroGPU quota (120s requested vs. 0s left). Try again in 23:59:00. "
           "Authenticate with a Hugging Face token for more quota - https://huggingface.co/settings/tokens")
RUNS_LIMIT = "You have exceeded your ZeroGPU runs limit. "
CREDITS = ("You have too many ZeroGPU credits allocated to running tasks. "
           "Try again once some of those tasks have completed.")
SPACE_LIMIT = "Space app has reached its GPU limit. Try re-running outside of examples if it happened after clicking one"
QUEUE_NO_IP = "No GPU was available after 60s. Try re-running outside of examples if it happened after clicking one"
QUEUE_FULL = ("No GPU was available after 60s [Subscribe to Pro](https://huggingface.co/subscribe/pro?from=ZeroGPU) "
              "to get the highest priority in ZeroGPU queues.")
QUEUE_PRO = "No GPU was available after 60s Retry later"
NO_GPU = "No GPU was available"
DURATION = ("The requested GPU duration (120s) is larger than the maximum allowed"
            "Subscribe to Hugging Face PRO to allow GPU tasks up to 40 min - https://huggingface.co/subscribe/pro?from=ZeroGPU")

ANON_QUOTA_LINE = ("Idol’s free allowance is used up for now. Try again later, "
                   "or add your Hugging Face token in Settings to use your own.")
OWN_QUOTA_LINE = ("Your Hugging Face GPU allowance is used up for now. Try again later, "
                  "or raise it on your Hugging Face account.")
BUSY_LINE = "Hugging Face had no free GPU for Idol. Try again in a few minutes."
SPACE_LIMIT_LINE = "Idol has reached its own limit on Hugging Face for now. Try again later."
NOT_APPLIED_LINE = ("Idol ran without your Hugging Face token and hit the free allowance. "
                    "Check your token in Settings, then try again.")
DURATION_ANON_LINE = ("Idol needs more GPU time per run than the free allowance gives. "
                      "Add your Hugging Face token in Settings, then try again.")
DURATION_OWN_LINE = ("Idol needs more GPU time per run than your Hugging Face account allows. "
                     "Raise your allowance on Hugging Face, then try again.")


@pytest.mark.asyncio
@pytest.mark.parametrize("message, signed_in, line", [
    (OWN_FREE, True, OWN_QUOTA_LINE),
    (OWN_PRO, True, OWN_QUOTA_LINE),
    (RUNS_LIMIT, True, OWN_QUOTA_LINE),
    (CREDITS, True, OWN_QUOTA_LINE),
    (ANON_IP, False, ANON_QUOTA_LINE),
    (RUNS_LIMIT, False, ANON_QUOTA_LINE),
    # A full queue is not anyone's quota, signed in or not.
    (QUEUE_FULL, True, BUSY_LINE),
    (QUEUE_PRO, True, BUSY_LINE),
    (QUEUE_FULL, False, BUSY_LINE),
    (NO_GPU, True, BUSY_LINE),
    # No X-IP-Token reached the Space: its own limit, or a token that didn't apply.
    (SPACE_LIMIT, False, SPACE_LIMIT_LINE),
    (QUEUE_NO_IP, False, SPACE_LIMIT_LINE),
    (SPACE_LIMIT, True, NOT_APPLIED_LINE),
    (QUEUE_NO_IP, True, NOT_APPLIED_LINE),
    (DURATION, False, DURATION_ANON_LINE),
    (DURATION, True, DURATION_OWN_LINE),
])
async def test_a_zerogpu_refusal_says_what_happened(monkeypatch, message, signed_in, line):
    idol_hosts(monkeypatch, stream=sse(("error", json.dumps(message))))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys={"HF_TOKEN": TOKEN} if signed_in else None)
    text, got = failure(excinfo)
    assert got == line
    assert message[:30] in text and carries_provider_text(excinfo.value)
    assert TOKEN not in text


@pytest.mark.parametrize("message, kind", [
    (OWN_FREE, "quota"), (OWN_PRO, "quota"), (ANON_IP, "quota"), (RUNS_LIMIT, "quota"), (CREDITS, "quota"),
    (QUEUE_FULL, "busy"), (QUEUE_PRO, "busy"), (NO_GPU, "busy"), (DURATION, "duration"),
    ("CUDA out of memory", None), ("Please upload an image first.", None),
    # The duration refusal needs both halves of its own text.
    ("Video duration must be under 10 s", None), ("The image is larger than the maximum allowed size", None),
    # "quota" alone is no longer a marker: only "exceeded your … quota" is the caller's.
    ("GPU quota service unreachable", None),
])
def test_zerogpu_kinds_read_the_spaces_package_texts(message, kind):
    assert idol.zerogpu_kind(message, signed_in=True) == kind
    assert idol.zerogpu_kind(message, signed_in=False) == kind


@pytest.mark.parametrize("message", [SPACE_LIMIT, QUEUE_NO_IP])
def test_no_ip_token_reads_as_the_spaces_limit_or_a_token_that_didnt_apply(message):
    assert idol.zerogpu_kind(message, signed_in=False) == "space-limit"
    assert idol.zerogpu_kind(message, signed_in=True) == "token-not-applied"


@pytest.mark.asyncio
async def test_a_space_error_that_echoes_the_token_is_scrubbed(monkeypatch):
    idol_hosts(monkeypatch, stream=sse(("error", json.dumps(f"bad header Bearer {TOKEN}"))))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys={"HF_TOKEN": TOKEN})
    assert TOKEN not in str(excinfo.value) and "***" in str(excinfo.value)
    assert person_line(excinfo.value) == "Idol couldn’t make this object. Details has its message."


@pytest.mark.asyncio
@pytest.mark.parametrize("data, line", [
    ("null", "Idol stopped without saying why. Try again in a minute."),
    ("", "Idol stopped without saying why. Try again in a minute."),
    (json.dumps({"error": None}), "Idol stopped without saying why. Try again in a minute."),
    (json.dumps("Please upload an image first."), "Idol got no image. Connect one, then run it again."),
    (json.dumps({"error": "CUDA out of memory"}), "Idol couldn’t make this object. Details has its message."),
])
async def test_other_space_errors_get_their_own_lines(monkeypatch, data, line):
    stream = b"event: error\ndata: " + data.encode() + b"\n\n" if data else b"event: error\ndata:\n\n"
    if not data:
        stream = b"event: error\ndata: null\n\n"
    idol_hosts(monkeypatch, stream=stream)
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert person_line(excinfo.value) == line


@pytest.mark.asyncio
async def test_a_stream_that_ends_without_a_result_says_so(monkeypatch):
    idol_hosts(monkeypatch, stream=sse(("heartbeat", "null")))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert person_line(excinfo.value) == "Idol stopped without a result. Try again in a minute."


@pytest.mark.asyncio
@pytest.mark.parametrize("stream, detail", [
    (sse(("complete", "not json")), "wasn't JSON"),
    (sse(("complete", [1, 2])), "not 3 outputs"),
    (sse(("complete", ["/tmp/x.ply", 1, ""])), "isn't a file"),
    (sse(complete(url="https://evil.example.com/gradio_api/file=/tmp/x.ply")), "another host"),
    (sse(("complete", [{"path": None, "url": None}, 1, ""])), "has no path"),
])
async def test_a_result_in_another_shape_is_a_signature_error(monkeypatch, stream, detail):
    hosts = idol_hosts(monkeypatch, stream=stream)
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert detail in str(excinfo.value)
    assert person_line(excinfo.value) == CHANGED
    assert not hosts.sent("GET", r"https://evil\.example\.com/.*")


@pytest.mark.asyncio
async def test_a_result_with_only_a_path_is_fetched_from_the_space(monkeypatch):
    hosts = idol_hosts(monkeypatch, stream=sse(complete(url=None)))
    await run_direct()
    assert hosts.sent("GET", re.escape(RESULT_URL))


@pytest.mark.asyncio
async def test_a_sleeping_space_is_woken_and_waited_for(monkeypatch):
    stage = [httpx.Response(200, json={"runtime": {"stage": "SLEEPING"}}),
             httpx.Response(200, json={"runtime": {"stage": "APP_STARTING"}}),
             httpx.Response(200, json={"runtime": {"stage": "RUNNING"}})]
    hosts = idol_hosts(monkeypatch, stage=stage)
    await run_direct()
    assert len(hosts.sent("GET", re.escape(HUB))) == 3
    # One wake request, then the real /info read.
    assert len(hosts.sent("GET", re.escape(f"{API}/info"))) == 2


@pytest.mark.asyncio
async def test_a_space_still_starting_after_the_wait_says_so(monkeypatch):
    monkeypatch.setattr(idol, "WAKE_TIMEOUT", 0.0)
    hosts = idol_hosts(monkeypatch, stage="BUILDING")
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert person_line(excinfo.value) == STARTING
    assert not hosts.sent("POST", r".*")


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["PAUSED", "RUNTIME_ERROR", "BUILD_ERROR", "STOPPED"])
async def test_a_space_that_is_down_says_so_before_any_call(monkeypatch, stage):
    hosts = idol_hosts(monkeypatch, stage=stage)
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert person_line(excinfo.value) == "Idol isn’t running on Hugging Face right now. Try again later."
    assert not hosts.sent("POST", r".*")


@pytest.mark.asyncio
async def test_a_space_that_is_gone_says_so(monkeypatch):
    idol_hosts(monkeypatch, stage=httpx.Response(404, json={"error": "not found"}))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert person_line(excinfo.value) == ("Idol is no longer on Hugging Face, so it can’t run. "
                                          "Use another 3D node instead.")


@pytest.mark.asyncio
async def test_an_unreadable_stage_check_goes_on_to_the_space(monkeypatch):
    hosts = idol_hosts(monkeypatch, stage=httpx.Response(500, text="hub down"))
    await run_direct()
    assert hosts.sent("POST", re.escape(f"{API}/call/run"))


@pytest.mark.asyncio
@pytest.mark.parametrize("status, keys, line", [
    (503, None, STARTING),
    (404, None, CHANGED),
    # Without a token a 401 isn't about a token: the Space answered oddly.
    (401, None, CHANGED),
    # With one, Hugging Face refused the token, not a changed Space.
    (401, {"HF_TOKEN": TOKEN}, TOKEN_LINE),
    (403, {"HF_TOKEN": TOKEN}, TOKEN_LINE),
])
async def test_an_info_read_that_fails_says_why(monkeypatch, status, keys, line):
    public_dns(monkeypatch)
    hosts = FakeHosts(monkeypatch, [
        *space_routes(info=None)[:2],
        ("GET", re.escape(f"{API}/info"), httpx.Response(status, text="no")),
    ])
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys=keys)
    assert person_line(excinfo.value) == line
    assert not hosts.sent("POST", r".*")


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403])
async def test_a_token_the_hub_refuses_stops_at_the_stage_check(monkeypatch, status):
    hosts = idol_hosts(monkeypatch, stage=httpx.Response(status, json={"error": "Invalid credentials in Authorization header"}))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys={"HF_TOKEN": TOKEN})
    assert person_line(excinfo.value) == TOKEN_LINE
    assert str(excinfo.value) == f"Hugging Face refused the HF_TOKEN ({status})"
    # Nothing goes to the Space with a token the Hub refused.
    assert not hosts.sent("GET", re.escape(f"{API}/info")) and not hosts.sent("POST", r".*")


@pytest.mark.asyncio
async def test_an_anonymous_401_from_the_hub_is_only_skipped(monkeypatch):
    hosts = idol_hosts(monkeypatch, stage=httpx.Response(401, json={"error": "no"}))
    await run_direct()
    assert hosts.sent("POST", re.escape(f"{API}/call/run"))


@pytest.mark.asyncio
@pytest.mark.parametrize("status, line", [
    (401, TOKEN_LINE),
    (503, STARTING),
    (422, CHANGED),
    (500, "Idol didn’t take the run. Details has its message."),
])
async def test_a_refused_call_says_why(monkeypatch, status, line):
    # The Space echoing the token back never puts it in Nebula's error.
    idol_hosts(monkeypatch, call=httpx.Response(status, text=f"refused {TOKEN}"))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys={"HF_TOKEN": TOKEN})
    assert person_line(excinfo.value) == line
    assert TOKEN not in str(excinfo.value)


@pytest.mark.asyncio
async def test_a_call_without_an_event_id_is_a_signature_error(monkeypatch):
    idol_hosts(monkeypatch, call=httpx.Response(200, json={"id": "x"}))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert "no event_id" in str(excinfo.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("status, keys, line", [
    (401, {"HF_TOKEN": TOKEN}, TOKEN_LINE),
    (502, None, STARTING),
    (413, None, "Idol didn’t take the image. Details has its message."),
])
async def test_a_refused_upload_says_why(monkeypatch, status, keys, line):
    hosts = idol_hosts(monkeypatch, upload=httpx.Response(status, text="no"))
    source = "data:image/png;base64," + base64.b64encode(PNG).decode()
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(inputs=image(source), keys=keys)
    assert person_line(excinfo.value) == line
    assert not hosts.sent("POST", re.escape(f"{API}/call/run"))


@pytest.mark.asyncio
async def test_an_upload_answer_without_paths_is_a_signature_error(monkeypatch):
    idol_hosts(monkeypatch, upload=httpx.Response(200, json={"files": []}))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(inputs=image("data:image/png;base64," + base64.b64encode(PNG).decode()))
    assert "list of file paths" in str(excinfo.value)


@pytest.mark.asyncio
async def test_no_image_stops_before_any_request(monkeypatch):
    hosts = idol_hosts(monkeypatch)
    with pytest.raises(ValueError) as excinfo:
        await run_direct(inputs={})
    assert person_line(excinfo.value) == "Idol needs an image. Connect one, then run it again."
    assert hosts.requests == []


@pytest.mark.asyncio
async def test_a_value_the_space_doesnt_take_stops_before_any_request(monkeypatch):
    hosts = idol_hosts(monkeypatch)
    with pytest.raises(ValueError):
        await run_direct(gaussians="2,097,152")
    assert hosts.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("ply, detail", [
    (splat_ply(64)[:-10], "header describes"),
    (splat_ply(8, fmt="ascii"), "binary little-endian"),
    (splat_ply(8, properties=["x", "y", "z", "opacity"]), "missing"),
    (b"<html>queue full</html>", "ply"),
])
async def test_a_ply_nebula_cant_read_is_refused_and_not_kept(monkeypatch, ply, detail):
    from services.output import OUTPUT_ROOT

    before = set(Path(OUTPUT_ROOT).rglob("*.ply*"))
    idol_hosts(monkeypatch, ply=ply)
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert detail in str(excinfo.value)
    assert person_line(excinfo.value) == "Idol sent back a file Nebula can’t read as a splat. Try again."
    assert set(Path(OUTPUT_ROOT).rglob("*.ply*")) == before


TOO_LARGE_LINE = ("This splat is too large for Nebula to keep. "
                  "Lower Gaussians in the node’s settings, then run it again.")


def test_the_too_large_line_names_the_field_that_sets_the_size():
    # GM: the line names the Inspector field that controls the splat's size.
    shared = {p["key"]: p for p in registry()["speridlabs-idol"]["sharedParams"]}
    assert shared["gaussians"]["label"] == "Gaussians" and "Lower Gaussians" in TOO_LARGE_LINE


@pytest.mark.asyncio
async def test_a_ply_over_the_size_cap_is_refused_from_its_header(monkeypatch):
    monkeypatch.setattr(idol, "MAX_PLY_BYTES", 1000)
    hosts = idol_hosts(monkeypatch, ply=splat_ply(64))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    # Refused from its content-length, before the body is read.
    assert f"is {len(splat_ply(64)):,} bytes, above Nebula's 1,000-byte limit" in str(excinfo.value)
    assert person_line(excinfo.value) == TOO_LARGE_LINE
    assert hosts.sent("GET", re.escape(RESULT_URL))


@pytest.mark.asyncio
async def test_a_ply_that_streams_past_the_cap_is_cut_off(monkeypatch):
    # One byte over: the cap holds exactly.
    monkeypatch.setattr(idol, "MAX_PLY_BYTES", len(splat_ply(64)) - 1)

    async def chunks():
        yield splat_ply(64)

    def chunked(_request):
        return httpx.Response(200, content=chunks())  # streamed: no content-length

    public_dns(monkeypatch)
    FakeHosts(monkeypatch, [
        *space_routes(),
        ("POST", re.escape(f"{API}/call/run"), httpx.Response(200, json={"event_id": "ev1"})),
        ("GET", re.escape(f"{API}/call/run/ev1"), httpx.Response(200, content=sse(complete()))),
        ("GET", re.escape(f"{API}/file=") + ".*", chunked),
    ])
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert f"passed Nebula's {len(splat_ply(64)) - 1:,}-byte limit" in str(excinfo.value)
    assert person_line(excinfo.value) == TOO_LARGE_LINE


@pytest.mark.asyncio
async def test_a_download_that_fails_says_so(monkeypatch):
    public_dns(monkeypatch)
    FakeHosts(monkeypatch, [
        *space_routes(),
        ("POST", re.escape(f"{API}/call/run"), httpx.Response(200, json={"event_id": "ev1"})),
        ("GET", re.escape(f"{API}/call/run/ev1"), httpx.Response(200, content=sse(complete()))),
        ("GET", re.escape(f"{API}/file=") + ".*", httpx.Response(403, text="no")),
    ])
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert person_line(excinfo.value) == "Nebula couldn’t download the object from Idol. Try again in a minute."


@pytest.mark.asyncio
async def test_a_stalled_stream_times_out_with_its_own_line(monkeypatch):
    def stall(request):
        raise httpx.ReadTimeout("timed out", request=request)

    public_dns(monkeypatch)
    FakeHosts(monkeypatch, [
        *space_routes(),
        ("POST", re.escape(f"{API}/call/run"), httpx.Response(200, json={"event_id": "ev1"})),
        ("GET", re.escape(f"{API}/call/run/ev1"), stall),
    ])
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert "ReadTimeout" in str(excinfo.value)
    assert person_line(excinfo.value) == "Idol took too long to answer. Try again in a few minutes."


@pytest.mark.asyncio
async def test_a_run_past_the_whole_wait_times_out(monkeypatch):
    monkeypatch.setattr(idol, "RUN_TIMEOUT", 0.05)

    async def slow(*_args, **_kwargs):
        await asyncio.sleep(1)

    monkeypatch.setattr(idol, "wait_until_running", slow)
    idol_hosts(monkeypatch)
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert "no result within" in str(excinfo.value)
    assert person_line(excinfo.value) == "Idol took too long to answer. Try again in a few minutes."


@pytest.mark.asyncio
async def test_a_connection_error_names_only_its_type(monkeypatch):
    def refuse(request):
        raise httpx.ConnectError(f"cannot connect to {request.url} with {TOKEN}", request=request)

    FakeHosts(monkeypatch, [("GET", r".*", refuse)])
    source = "data:image/png;base64," + base64.b64encode(PNG).decode()
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(inputs=image(source), keys={"HF_TOKEN": TOKEN})
    assert "ConnectError" in str(excinfo.value)
    assert TOKEN not in str(excinfo.value)
    assert person_line(excinfo.value) == "Nebula couldn’t reach Idol. Check the connection and try again."


@pytest.mark.asyncio
async def test_cancelling_a_run_closes_the_stream_and_cancels(monkeypatch, capsys):
    started = asyncio.Event()

    async def stall(*_args, **_kwargs):
        started.set()
        await asyncio.sleep(30)

    monkeypatch.setattr(idol, "_call_run", stall)
    idol_hosts(monkeypatch)
    task = asyncio.create_task(run_direct())
    await asyncio.wait_for(started.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert "cancelled node=n1" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_the_route_client_refuses_an_unknown_space_and_extra_ports(monkeypatch):
    hosts = idol_hosts(monkeypatch)
    route = registry()["speridlabs-idol"]["routes"][0]
    client = route_clients.ROUTE_CLIENTS["hf-space"]
    with pytest.raises(Exception) as excinfo:
        await client.run(node(), image(), {}, route=route, emit=None, endpoint="someone/else")
    assert "request shape" in str(excinfo.value)
    with pytest.raises(Exception) as excinfo:
        await client.run(node(), {**image(), "mask": PortValueDict(type="Image", value=IMAGE)}, {},
                         route=route, emit=None, endpoint=route["endpoint"])
    assert "mask" in str(excinfo.value)
    assert hosts.requests == []


def test_the_handler_module_is_wired_for_the_route():
    assert route_clients.HF_SPACE_HANDLERS == {"speridlabs/idol": "handlers.speridlabs_idol"}
    assert "hf-space" in node_route.ROUTE_HANDLERS
    assert idol.SPACE_URL == SPACE


def test_the_written_splat_is_summarized():
    from services.output import OUTPUT_ROOT

    path = Path(OUTPUT_ROOT) / "summary.ply"
    path.write_bytes(splat_ply(512, seed=3))
    summary = summarize_splat_ply(path)
    assert summary["gaussians"] == 512 and summary["shDegree"] == 0
    assert all(-0.5 <= v <= 0.5 for v in summary["boundingBox"]["min"] + summary["boundingBox"]["max"])


def test_world_labs_export_refuses_an_idol_splat_with_its_own_line():
    """Scope H: the one node that takes a World (worldlabs-world-export) takes
    Marble's World v1 only; an Idol World v2 stops before any request."""
    from handlers.worldlabs import _validated_world_input
    from services.output import OUTPUT_ROOT

    path = Path(OUTPUT_ROOT) / "export-check.ply"
    path.write_bytes(splat_ply(8))
    world = idol.world_value(path, seed=1, gaussians=8, mode="synthetic", steps=50)
    with pytest.raises(ValueError) as excinfo:
        _validated_world_input({"world": PortValueDict(type="World", value=world)})
    assert "World v2" in str(excinfo.value)
    assert person_line(excinfo.value) == ("World Labs Export only takes a world made by World Labs Environment. "
                                          "To keep this splat, download it from its card.")
    world_inputs = [(node_id, port["id"]) for node_id, d in registry().items()
                    for port in d.get("inputPorts") or [] if port.get("dataType") == "World"]
    assert world_inputs == [("worldlabs-world-export", "world")]


@pytest.mark.asyncio
async def test_a_ply_that_streams_exactly_to_the_cap_is_kept(monkeypatch):
    monkeypatch.setattr(idol, "MAX_PLY_BYTES", len(splat_ply(64)))

    async def chunks():
        yield splat_ply(64)

    public_dns(monkeypatch)
    FakeHosts(monkeypatch, [
        *space_routes(),
        ("POST", re.escape(f"{API}/call/run"), httpx.Response(200, json={"event_id": "ev1"})),
        ("GET", re.escape(f"{API}/call/run/ev1"), httpx.Response(200, content=sse(complete()))),
        ("GET", re.escape(f"{API}/file=") + ".*", lambda _request: httpx.Response(200, content=chunks())),
    ])
    world = world_of(await run_direct())
    assert world["assets"]["splats"][0]["asset"]["byteLength"] == len(splat_ply(64))


# -- PR #203 round 2 -----------------------------------------------------------------


def _two_plys():
    return splat_ply(64, seed=1), splat_ply(96, seed=2)


@pytest.mark.asyncio
async def test_two_idol_nodes_in_one_run_keep_their_own_files(monkeypatch, tmp_path):
    """Review HIGH 1: two nodes with the default seed shared idol-seed42-N.ply."""
    from services.output import OUTPUT_ROOT, execution_run_dir, resolve_output_ref

    first, second = _two_plys()
    answers = [httpx.Response(200, content=first), httpx.Response(200, content=second)]
    hosts = idol_hosts(monkeypatch)
    hosts.routes[-1] = ("GET", re.escape(f"{API}/file=") + ".*", lambda _request: answers.pop(0))
    run_dir = Path(OUTPUT_ROOT) / "two-nodes-run"
    run_dir.mkdir(parents=True, exist_ok=True)
    token = execution_run_dir.set(run_dir)
    try:
        a = world_of(await run_direct())
        b = world_of(await run_direct())
    finally:
        execution_run_dir.reset(token)
    uri_a, uri_b = (w["assets"]["splats"][0]["asset"]["uri"] for w in (a, b))
    assert uri_a != uri_b
    assert Path(resolve_output_ref(uri_a)).read_bytes() == first
    assert Path(resolve_output_ref(uri_b)).read_bytes() == second
    assert (a["assets"]["splats"][0]["pointCount"], b["assets"]["splats"][0]["pointCount"]) == (64, 96)
    assert not list(run_dir.glob("*.part"))


@pytest.mark.asyncio
async def test_two_idol_nodes_downloading_at_once_never_share_a_part_file(monkeypatch):
    """The same, in parallel: both streams interleave chunk by chunk, so a
    shared .part file would mix them or be unlinked under the other."""
    from services.output import OUTPUT_ROOT, execution_run_dir, resolve_output_ref

    first, second = _two_plys()
    bodies = [first, second]
    seen_parts: list[set[str]] = []
    run_dir = Path(OUTPUT_ROOT) / "two-nodes-parallel"
    run_dir.mkdir(parents=True, exist_ok=True)

    def streamed(_request):
        body = bodies.pop(0)

        async def chunks():
            for start in range(0, len(body), 256):
                seen_parts.append({p.name for p in run_dir.glob("*.part")})
                await asyncio.sleep(0)
                yield body[start:start + 256]

        return httpx.Response(200, content=chunks())

    hosts = idol_hosts(monkeypatch)
    hosts.routes[-1] = ("GET", re.escape(f"{API}/file=") + ".*", streamed)
    token = execution_run_dir.set(run_dir)
    try:
        a, b = await asyncio.gather(run_direct(), run_direct())
    finally:
        execution_run_dir.reset(token)
    worlds = [world_of(a), world_of(b)]
    files = {Path(resolve_output_ref(w["assets"]["splats"][0]["asset"]["uri"])).read_bytes() for w in worlds}
    assert files == {first, second}
    for world in worlds:
        splat = world["assets"]["splats"][0]
        content = Path(resolve_output_ref(splat["asset"]["uri"])).read_bytes()
        assert splat["pointCount"] == (64 if content == first else 96)
    # Two .part files were open at once, one per node, and none is left.
    assert max(len(names) for names in seen_parts) == 2
    assert not list(run_dir.glob("*.part"))


@pytest.mark.parametrize("key, bad", [
    ("steps", 9), ("steps", 101), ("steps", 100000), ("steps", 50.5), ("steps", "many"), ("steps", True),
    ("cfg_scale", -50), ("cfg_scale", 10.01), ("cfg_scale", float("nan")),
    ("rescale_t", 0.99), ("rescale_t", 99), ("rescale_t", float("inf")),
    ("seed", -1), ("seed", -5), ("seed", 2_147_483_648), ("seed", 1.5), ("seed", [42]),
    # A bool is not a number here, even where True (1) is in range.
    ("seed", True), ("cfg_scale", True), ("rescale_t", True),
])
@pytest.mark.asyncio
async def test_a_setting_out_of_its_range_stops_before_any_request_and_names_the_field(monkeypatch, key, bad):
    hosts = idol_hosts(monkeypatch)
    with pytest.raises(ValueError) as excinfo:
        await run_direct(**{key: bad})
    label, low, high, _whole = idol.PARAM_BOUNDS[key]
    low_text, high_text = idol._number_text(low), idol._number_text(high)
    assert str(excinfo.value) == f"Idol's {key} must be a number from {low_text} to {high_text}"
    assert person_line(excinfo.value) == (f"{label} must be between {low_text} and {high_text}. "
                                          "Change it in the node’s settings, then run it again.")
    assert hosts.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("key, edge", [("steps", 10), ("steps", 100), ("cfg_scale", 0), ("cfg_scale", 10),
                                       ("rescale_t", 1), ("rescale_t", 6), ("seed", 0), ("seed", 2_147_483_647),
                                       ("steps", "30"), ("steps", 30.0)])
async def test_a_setting_at_its_bounds_is_sent(monkeypatch, key, edge):
    hosts = idol_hosts(monkeypatch)
    await run_direct(**{key: edge})
    sent = hosts.json("POST", re.escape(f"{API}/call/run"))["data"][idol.RUN_PARAMS.index(key)]
    assert sent == float(edge)
    validate(run_schema(), hosts.json("POST", re.escape(f"{API}/call/run")))


def test_the_bounds_are_the_pinned_spaces_and_the_nodes():
    by_name = {p["parameter_name"]: p for p in INFO["named_endpoints"]["/run"]["parameters"]}
    shared = {p["key"]: p for p in registry()["speridlabs-idol"]["sharedParams"]}
    for key, (label, low, high, whole) in idol.PARAM_BOUNDS.items():
        assert shared[key]["label"] == label, key
        assert (shared[key]["min"], shared[key]["max"]) == (low, high), key
        assert (shared[key]["type"] == "integer") is whole, key
        assert shared[key]["default"] == idol.PARAM_DEFAULTS[key], key
        if key != "seed":
            match = re.search(r"between ([0-9.]+) and ([0-9.]+)", by_name[key]["type"]["description"])
            assert (float(match.group(1)), float(match.group(2))) == (low, high), key
    # The seed has no range on the Space (a bare integer): the node's own bounds hold.
    assert by_name["seed"]["type"] == {"type": "integer"}


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_token", ["hf_abc’def", "hf_abc\ndef", "hf_été", "hf_abc\x00def"])
async def test_a_token_a_header_cant_carry_gets_a_clear_line_and_sends_nothing(monkeypatch, bad_token):
    hosts = idol_hosts(monkeypatch)
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys={"HF_TOKEN": bad_token})
    assert not isinstance(excinfo.value, UnicodeError)
    assert person_line(excinfo.value) == ("Your Hugging Face token has a character a token can’t have. "
                                          "Paste it again in Settings.")
    assert bad_token not in str(excinfo.value)
    assert hosts.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [
    "http://127.0.0.1:9/private?sig=SECRET", "https://127.0.0.1/a.png", "https://localhost/a.png",
    "https://10.0.0.5/a.png?sig=SECRET", "https://169.254.169.254/latest/meta-data", "http://example.com/a.png",
])
async def test_a_loopback_private_or_plain_http_image_is_refused_before_the_space(monkeypatch, url):
    hosts = idol_hosts(monkeypatch)
    with pytest.raises(Exception) as excinfo:
        await run_direct(inputs=image(url))
    assert "media URL Nebula will not fetch" in str(excinfo.value)
    assert not [r for r in hosts.requests if r.url.host.endswith(("hf.space", "huggingface.co"))]
    assert all("SECRET" not in str(r.url) for r in hosts.requests)


@pytest.mark.asyncio
async def test_a_public_image_url_with_a_query_never_reaches_the_space(monkeypatch):
    signed = "https://example.com/chair.png?sig=SECRET"
    hosts = idol_hosts(monkeypatch)
    hosts.routes.insert(0, ("GET", re.escape(signed), httpx.Response(200, content=PNG,
                                                                     headers={"content-type": "image/png"})))
    await run_direct(inputs=image(signed))
    for request in hosts.requests:
        if request.url.host != "example.com":
            assert b"SECRET" not in request.content and "SECRET" not in str(request.url)
    assert hosts.json("POST", re.escape(f"{API}/call/run"))["data"][0] == UPLOADED_IMAGE


@pytest.mark.asyncio
async def test_a_result_over_http_on_the_spaces_host_is_fetched_over_https(monkeypatch):
    http_url = RESULT_URL.replace("https://", "http://")
    hosts = idol_hosts(monkeypatch, stream=sse(complete(url=http_url)))
    world = world_of(await run_direct())
    assert hosts.sent("GET", re.escape(RESULT_URL))
    assert not [r for r in hosts.requests if r.url.scheme == "http"]
    assert world["assets"]["splats"][0]["pointCount"] == 64


def test_an_http_result_with_no_path_moves_to_https_on_the_same_host():
    url = idol._result_url({"url": "http://speridlabs-idol.hf.space:80/gradio_api/file=/tmp/x.ply?a=1", "path": None})
    assert url == "https://speridlabs-idol.hf.space/gradio_api/file=/tmp/x.ply?a=1"
    for bad in ("http://evil.example.com/gradio_api/file=/tmp/x.ply", "ftp://speridlabs-idol.hf.space/x.ply"):
        with pytest.raises(idol.IdolSpaceError):
            idol._result_url({"url": bad, "path": "/tmp/x.ply"})


def test_a_result_path_is_url_quoted():
    url = idol._result_url({"url": None, "path": "/tmp/gradio/a b#c?.ply"})
    assert url == f"{API}/file=/tmp/gradio/a%20b%23c%3F.ply"


@pytest.mark.asyncio
async def test_point_count_is_the_files_own_not_the_dropdowns(monkeypatch):
    idol_hosts(monkeypatch, ply=splat_ply(10))
    world = world_of(await run_direct(gaussians="65,536"))
    assert world["assets"]["splats"][0]["pointCount"] == 10
    assert "gaussians:10" in world["session"]["tags"]


def test_the_mode_values_are_the_routes_value_map_read_backwards():
    route = registry()["speridlabs-idol"]["routes"][0]
    assert idol.MODE_VALUES == {label: value for value, label in route["valueMap"]["mode"].items()}


def test_an_anonymous_run_names_hugging_face_as_the_provider_it_called():
    """Review LOW 11: the card's "Details shows what … said" named nobody on
    an anonymous run, and "Hugging Face" on a signed-in one."""
    from execution.provider_status import called_provider

    assert called_provider("speridlabs-idol", {"_provider": "auto"}, {}) == "Hugging Face"
    assert called_provider("speridlabs-idol", {"_provider": "auto"}, {"HF_TOKEN": TOKEN}) == "Hugging Face"
    # Not every keyless-looking None: a node that calls no provider still has none.
    assert called_provider("text-input", {}, {}) is None


def test_a_keyless_route_cant_bill_a_plan():
    definition = json.loads(json.dumps(registry()["speridlabs-idol"]))
    route = definition["routes"][0]
    # On a Krea route, so only the keyless rule can refuse it.
    route["provider"], route["plan"] = "krea", "optional"
    problems = node_route.routes_problems(definition)
    assert any("a keyless route can't bill a plan" in p for p in problems), problems


@pytest.mark.parametrize("bad", ["HF_TOKEN", {"HF_TOKEN": True}, [""], [3]])
def test_optional_keys_must_be_a_list_of_key_names(bad):
    definition = json.loads(json.dumps(registry()["speridlabs-idol"]))
    definition["routes"][0]["optionalKeys"] = bad
    problems = node_route.routes_problems(definition)
    assert any("optionalKeys must be a list of key names" in p for p in problems), problems

