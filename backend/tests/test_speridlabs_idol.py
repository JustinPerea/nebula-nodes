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
from tests.test_canvas_proposals import api  # noqa: F401 - fixture
from tests.test_pending_nodes import pend  # noqa: F401 - fixture
from tests.test_route_clients import FakeHosts, quick, registry_handler, validate  # noqa: F401

TOKEN = "hf_fixturetoken0123456789abcdefghijklmnop"
CHANGED = ("Idol changed on Hugging Face, and this version of Nebula can’t run it. Update Nebula, then try again.")
STARTING = "Idol is still starting on Hugging Face. Try again in a few minutes."
TOKEN_LINE = "Hugging Face didn’t accept your token. Check it in Settings."
NEEDS_TOKEN = "You can run Idol after you add your Hugging Face token in Settings."
MISSING_LINE = "Nebula can’t find Idol on Hugging Face, so it can’t run. Use another 3D node instead."
SIGNED_IN = {"HF_TOKEN": TOKEN}
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
    """The registry's handler for the node (multi_route over its route table),
    with the token its route needs unless ``keys`` says otherwise."""
    defaults = {p["key"]: p.get("default") for p in node_route.all_param_definitions(registry()["speridlabs-idol"])
                if p["key"] != "_provider"}
    saved = {**defaults, "_provider": "auto", **(params or {})}
    return await registry_handler("speridlabs-idol")(node(**saved), image() if inputs is None else inputs,
                                                     dict(SIGNED_IN if keys is None else keys))


def keyless_idol() -> dict[str, Any]:
    """Idol's definition, keyless (PR #203 round 7: the first live call ran
    with no token). Built from the registry either way, so the keyless rules'
    tests never depended on which state the registry was in."""
    definition = json.loads(json.dumps(registry()["speridlabs-idol"]))
    route = definition["routes"][0]
    route["keys"], route["optionalKeys"] = [], ["HF_TOKEN"]
    route.pop("missingKeyLine", None)
    definition["envKeyName"], definition["directKeyName"] = [], []
    return definition


def keyed_idol() -> dict[str, Any]:
    """Idol as a keyed Space route with its own missing-key line, as it was
    in PR #203 rounds 4 to 6: the shape a keyed route takes (missingKeyLine,
    the keyed readiness), kept for the generic rules' tests."""
    definition = json.loads(json.dumps(registry()["speridlabs-idol"]))
    route = definition["routes"][0]
    route["keys"] = ["HF_TOKEN"]
    route.pop("optionalKeys", None)
    route.pop("mayBillWithKey", None)
    route["missingKeyLine"] = NEEDS_TOKEN
    definition["envKeyName"], definition["directKeyName"] = ["HF_TOKEN"], ["HF_TOKEN"]
    return definition


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
async def test_a_run_sends_the_schema_body_and_returns_a_world_v2_splat(monkeypatch, capsys):
    hosts = idol_hosts(monkeypatch, stream=sse(("heartbeat", "null"), complete(seed=42)), ply=splat_ply(64))
    out = await run_node()
    body = hosts.json("POST", re.escape(f"{API}/call/run"))
    validate(run_schema(), body)
    assert body == {"data": [UPLOADED_IMAGE, "Synthetic", 50, 3.0, 3.0, 42, False, "262,144"]}
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
    assert "signed_in=True" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_without_a_token_the_node_runs_anonymously_with_no_auth_header(monkeypatch, capsys):
    """PR #203 round 7: the first live call ran with no token (every request
    200, 27.6 s, a valid splat), so the route is keyless. A run without the
    token goes out through the route with no token header at all, as the
    live call did."""
    for keys in ({}, {"HF_TOKEN": ""}, {"HF_TOKEN": "  "}):
        hosts = idol_hosts(monkeypatch)
        world_of(await run_node(keys=keys))
        assert hosts.sent("POST", re.escape(f"{API}/call/run"))
        assert all("authorization" not in r.headers and "x-hf-authorization" not in r.headers
                   for r in hosts.requests)
        assert "signed_in=False" in capsys.readouterr().err


def test_the_engines_preflight_passes_idol_with_or_without_a_token():
    """Agent and CLI runs (MCP run tools, nebula run, apply and run) all go
    through the engine's pre-run check. Keyless (round 7), Idol passes it
    either way; a keyed route's own line still refuses there (the keyed half)."""
    from execution.engine import validate_graph
    from models.graph import GraphEdge

    nodes = [GraphNode(id="img", definitionId="image-input", params={"filePath": IMAGE}),
             GraphNode(id="n1", definitionId="speridlabs-idol", params={"_provider": "auto"})]
    edges = [GraphEdge(id="e1", source="img", sourceHandle="image", target="n1", targetHandle="image")]
    for keys in ({}, SIGNED_IN):
        assert not [e for e in validate_graph(nodes, edges, keys) if e.node_id == "n1"]


def test_the_engines_preflight_refuses_a_keyed_route_without_its_key_in_its_own_words(monkeypatch):
    from execution import engine
    from execution.engine import validate_graph
    from models.graph import GraphEdge

    monkeypatch.setattr(engine, "_REGISTRY_NODE_DEFS", {**registry(), "speridlabs-idol": keyed_idol()})
    nodes = [GraphNode(id="img", definitionId="image-input", params={"filePath": IMAGE}),
             GraphNode(id="n1", definitionId="speridlabs-idol", params={"_provider": "auto"})]
    edges = [GraphEdge(id="e1", source="img", sourceHandle="image", target="n1", targetHandle="image")]
    errors = [e for e in validate_graph(nodes, edges, {}) if e.node_id == "n1"]
    assert [(e.message, e.person) for e in errors] == [(NEEDS_TOKEN, NEEDS_TOKEN)]
    assert not [e for e in validate_graph(nodes, edges, SIGNED_IN) if e.node_id == "n1"]


@pytest.mark.asyncio
async def test_the_handler_still_runs_without_a_token_as_a_backstop(monkeypatch, capsys):
    """A run that slips past the route (or a keyless route, if the first live
    run shows 120 s) sends no token header at all."""
    hosts = idol_hosts(monkeypatch)
    world_of(await run_direct())
    assert hosts.sent("POST", re.escape(f"{API}/call/run"))
    assert all("authorization" not in r.headers and "x-hf-authorization" not in r.headers for r in hosts.requests)
    assert "signed_in=False" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_a_signed_in_run_sends_the_token_only_to_hugging_face_and_never_prints_it(monkeypatch, capsys):
    hosts = idol_hosts(monkeypatch)
    out = await run_node(keys={"HF_TOKEN": TOKEN})
    assert hosts.requests
    spaces = 0
    for request in hosts.requests:
        host = request.url.host
        if host == "example.com":
            # The image is fetched without credentials (fetch_public_media).
            assert "authorization" not in request.headers and "x-hf-authorization" not in request.headers
            continue
        assert request.url.scheme == "https" and host in ("huggingface.co", "speridlabs-idol.hf.space"), host
        if host == "huggingface.co":
            # The Hub reads Authorization.
            assert request.headers.get("authorization") == f"Bearer {TOKEN}"
            assert "x-hf-authorization" not in request.headers
        else:
            # The Space gets X-HF-Authorization, which Hugging Face's proxy
            # reads and strips (gradio PR #11700): never Authorization, which
            # would reach Speridlabs' container.
            spaces += 1
            assert request.headers.get("x-hf-authorization") == f"Bearer {TOKEN}"
            assert "authorization" not in request.headers
    # info, upload, call, stream and the file download all carry it.
    assert spaces == 5
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
    for url in (HUB, "https://huggingface.co./api/whoami-v2", "https://HuggingFace.co/api/spaces/x"):
        assert idol._headers(url, TOKEN) == {"Authorization": f"Bearer {TOKEN}"}, url
    for url in (f"{API}/call/run", RESULT_URL, "https://SPERIDLABS-IDOL.hf.space/gradio_api/info",
                "https://speridlabs-idol.hf.space./gradio_api/upload"):
        assert idol._headers(url, TOKEN) == {"X-HF-Authorization": f"Bearer {TOKEN}"}, url
    assert idol._headers(HUB, None) == {} and idol._headers(f"{API}/info", "") == {}
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


@pytest.mark.parametrize("provider", ["auto", "hf-space"])
def test_the_node_is_keyless_with_an_optional_token_that_may_bill(provider):
    """Round 7, idol.md "Switching back to keyless" step 1: keys [],
    optionalKeys HF_TOKEN, no missingKeyLine, empty envKeyName and
    directKeyName. With the token, a run may bill the person's own Hugging
    Face account (mayBillWithKey); without it, nothing can."""
    definition = registry()["speridlabs-idol"]
    route = definition["routes"][0]
    assert definition["envKeyName"] == [] and definition["directKeyName"] == []
    assert route["keys"] == [] and route["optionalKeys"] == ["HF_TOKEN"] and route["mayBillWithKey"] is True
    assert "missingKeyLine" not in route and "note" not in route
    assert node_route.routes_problems(definition) == []
    params = {"_provider": provider}
    anonymous = node_route.select_route(definition, params, {})
    assert (anonymous.route_id, anonymous.key, anonymous.missing) == ("hf-space", None, ())
    assert node_route.route_unavailable(definition, params, {}) is None
    signed_in = node_route.select_route(definition, params, SIGNED_IN)
    assert (signed_in.route_id, signed_in.key) == ("hf-space", "HF_TOKEN")
    assert node_readiness.instance_access(definition, params, SIGNED_IN) == node_readiness.KEY
    assert node_readiness.instance_access(definition, params, {}) == node_readiness.FREE
    assert node_route.may_bill(definition, params, SIGNED_IN) is True
    for keys in ({}, {"HF_TOKEN": ""}):
        assert node_route.may_bill(definition, params, keys) is False


def test_may_bill_needs_the_flag_and_the_optional_key():
    definition = keyless_idol()
    params = {"_provider": "auto"}
    definition["routes"][0].pop("mayBillWithKey")
    assert node_route.may_bill(definition, params, SIGNED_IN) is False
    assert node_route.may_bill(keyed_idol(), params, SIGNED_IN) is False
    assert node_route.may_bill(None, params, SIGNED_IN) is False
    assert node_route.may_bill(registry()["text-input"], {}, SIGNED_IN) is False


def test_the_may_bill_flag_is_validated():
    definition = keyless_idol()
    route = definition["routes"][0]
    route["mayBillWithKey"] = "yes"
    assert any("mayBillWithKey must be true" in p for p in node_route.routes_problems(definition))
    keyed = keyed_idol()
    keyed["routes"][0]["mayBillWithKey"] = True
    assert any("mayBillWithKey needs optionalKeys" in p for p in node_route.routes_problems(keyed))


def test_a_routes_own_missing_key_line_applies_only_to_a_missing_key_alone():
    """missingKeyLine replaces the generic line only when the key is the one
    thing missing, and on Auto only when every route Auto could take has one."""
    definition = keyed_idol()
    unset = node_route.Route(node_route.UNSET, None, None, None, None, ("HF_TOKEN",))
    assert node_route.missing_key_line_for(definition, unset) == NEEDS_TOKEN
    # Something else stops the route too: its own line doesn't hide that.
    blocked = unset._replace(route_id="hf-space", block=node_route.DirectBlock("unsupported", "mode"))
    assert node_route.missing_key_line_for(definition, blocked) is None
    assert node_route.missing_key_line_for(definition, unset._replace(missing=())) is None
    # A second route with no line of its own: Auto with no key keeps the
    # generic "add a key or choose another provider".
    other = {**definition["routes"][0], "id": "fal", "provider": "fal", "keys": ["FAL_KEY"], "handler": "fal"}
    other.pop("missingKeyLine")
    definition["routes"].append(other)
    assert node_route.missing_key_line_for(definition, unset) is None
    assert node_route.missing_key_line_for(definition, unset._replace(route_id="hf-space")) == NEEDS_TOKEN
    assert node_route.missing_key_line_for(definition, unset._replace(route_id="fal")) is None


def test_switching_back_to_keyless_is_the_routes_own_change():
    """If the first live run shows 120 s, the route goes back to keyless."""
    definition = keyless_idol()
    assert node_route.routes_problems(definition) == []
    params = {"_provider": "auto"}
    assert node_route.select_route(definition, params, {}).key is None
    assert node_route.route_unavailable(definition, params, {}) is None
    assert node_readiness.instance_access(definition, params, {}) == node_readiness.FREE
    assert node_readiness.instance_access(definition, params, SIGNED_IN) == node_readiness.KEY


def test_the_space_route_rules_are_validated():
    definition = keyed_idol()
    route = definition["routes"][0]
    # Only a maker's Space may name the maker beside the Hugging Face token.
    route["handler"] = "fal"
    assert any("provider must be 'huggingface'" in p for p in node_route.routes_problems(definition))
    route["handler"] = "hf-space"
    route["missingKeyLine"] = " "
    assert any("missingKeyLine must be a sentence" in p for p in node_route.routes_problems(definition))


def test_a_keyless_route_cant_carry_a_missing_key_line():
    """The keyless half (review r5 LOW-2): built from keyless_idol, so it
    passes before and after idol.md's switch back."""
    keyless = keyless_idol()
    keyless["routes"][0]["missingKeyLine"] = NEEDS_TOKEN
    assert any("missingKeyLine needs keys" in p for p in node_route.routes_problems(keyless))


def test_a_keyless_route_is_validated():
    definition = keyless_idol()
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

# GM, PR #203 r12 item 6: the anonymous quota and Space-limit refusals share one line.
ANON_QUOTA_LINE = ("Hugging Face’s free GPU time for Idol is used up for now. Try again later, "
                   "or add your Hugging Face token in Settings to use your own allowance.")
OWN_QUOTA_LINE = ("Your Hugging Face GPU allowance is used up for now. Try again later, "
                  "or raise it on your Hugging Face account.")
BUSY_LINE = "Hugging Face had no free GPU for Idol. Try again in a few minutes."
SPACE_LIMIT_LINE = ANON_QUOTA_LINE
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
    # GM r6 #7: signed in, a duration refusal means the token didn't apply
    # (any account's allowance is past the Space's ask).
    (DURATION, True, NOT_APPLIED_LINE),
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
    (OWN_FREE, "quota"), (OWN_PRO, "quota"), (RUNS_LIMIT, "quota"), (CREDITS, "quota"),
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


# spaces' texts for an IP with no account behind it (meta.auth None): the
# bare "your ZeroGPU quota" label, and the API call's suffix. Sent with a
# token, either means the token didn't apply (PR #203 r2 review, MEDIUM 2).
ANON_RUNS = ("You have exceeded your ZeroGPU runs limit. "
             "Authenticate with a Hugging Face token for more quota - https://huggingface.co/settings/tokens")
ANON_BARE = "You have exceeded your ZeroGPU quota (180s requested vs. 120s left). Try again in 23:59:00."


@pytest.mark.parametrize("message", [ANON_IP, ANON_RUNS, ANON_BARE])
def test_an_ip_only_quota_text_reads_as_a_token_that_didnt_apply_when_one_was_sent(message):
    assert idol.zerogpu_kind(message, signed_in=False) == "quota"
    assert idol.zerogpu_kind(message, signed_in=True) == "token-not-applied"


@pytest.mark.asyncio
@pytest.mark.parametrize("message", [ANON_IP, ANON_RUNS, ANON_BARE])
async def test_a_signed_in_run_that_hit_the_ip_quota_says_the_token_didnt_apply(monkeypatch, message):
    idol_hosts(monkeypatch, stream=sse(("error", json.dumps(message))))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys=SIGNED_IN)
    assert person_line(excinfo.value) == NOT_APPLIED_LINE


def test_an_accounts_own_quota_is_never_read_as_ip_only():
    for message in (OWN_FREE, OWN_PRO, CREDITS):
        assert idol.zerogpu_kind(message, signed_in=True) == "quota", message


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
    assert person_line(excinfo.value) == "Idol couldn’t make a 3D object from this image. Try another image, or open Details to see why."


@pytest.mark.asyncio
@pytest.mark.parametrize("data, line", [
    ("null", "Idol stopped without saying why. Try again in a minute."),
    ("", "Idol stopped without saying why. Try again in a minute."),
    (json.dumps({"error": None}), "Idol stopped without saying why. Try again in a minute."),
    (json.dumps("Please upload an image first."),
     "The image Idol got is empty. Check the node that makes it, then run Idol again."),
    (json.dumps({"error": "CUDA out of memory"}), "Idol couldn’t make a 3D object from this image. Try another image, or open Details to see why."),
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
    assert person_line(excinfo.value) == "Idol stopped before sending a result. Try again in a minute."


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
@pytest.mark.parametrize("keys", [None, SIGNED_IN])
@pytest.mark.parametrize("answer", [
    httpx.Response(404, json={"error": "not found"}, headers={"x-error-code": "RepoNotFound"}),
    # huggingface_hub's rule: RepoNotFound, or any 401 but a bad token's, is
    # a missing repo (or a private or gated one the caller can't see).
    httpx.Response(401, json={"error": "Repository not found"},
                   headers={"x-error-code": "RepoNotFound", "x-error-message": "Repository not found"}),
    httpx.Response(401, json={"error": "Repository not found"}),
    httpx.Response(403, json={"error": "gated"}, headers={"x-error-code": "RepoNotFound"}),
    # Gated and disabled come first in huggingface_hub's order, ahead of the
    # token rule: with a token, the token is fine and the Space can't be used.
    httpx.Response(403, json={"error": "gated"}, headers={"x-error-code": "GatedRepo"}),
    httpx.Response(401, json={"error": "gated"}, headers={"x-error-code": "GatedRepo"}),
    httpx.Response(403, json={"error": "disabled"},
                   headers={"x-error-message": "Access to this resource is disabled."}),
    httpx.Response(410, json={"error": "disabled"},
                   headers={"x-error-message": "Access to this resource is disabled."}),
])
async def test_a_space_hugging_face_says_is_missing_says_so(monkeypatch, keys, answer):
    hosts = idol_hosts(monkeypatch, stage=answer)
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys=keys)
    assert person_line(excinfo.value) == MISSING_LINE
    assert not hosts.sent("GET", re.escape(f"{API}/info")) and not hosts.sent("POST", r".*")


@pytest.mark.asyncio
@pytest.mark.parametrize("keys", [None, SIGNED_IN])
async def test_a_bare_404_from_the_hub_is_not_missing(monkeypatch, keys):
    """huggingface_hub reads a 404 as RepoNotFound only with that error code:
    a bare one (a moved API path) is skipped like any odd stage answer."""
    hosts = idol_hosts(monkeypatch, stage=httpx.Response(404, json={"error": "not found"}))
    await run_direct(keys=keys)
    assert hosts.sent("POST", re.escape(f"{API}/call/run"))


@pytest.mark.asyncio
async def test_a_disabled_space_names_what_the_hub_said_for_agents(monkeypatch):
    idol_hosts(monkeypatch, stage=httpx.Response(
        403, json={"error": "disabled"}, headers={"x-error-message": "Access to this resource is disabled."}))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys=SIGNED_IN)
    assert "disabled (Hub API answered 403, Access to this resource is disabled.)" in str(excinfo.value)


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
    bad = "Invalid credentials in Authorization header"
    hosts = idol_hosts(monkeypatch, stage=httpx.Response(status, json={"error": bad}, headers={"x-error-message": bad}))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys={"HF_TOKEN": TOKEN})
    assert person_line(excinfo.value) == TOKEN_LINE
    assert str(excinfo.value) == f"Hugging Face refused the HF_TOKEN ({status})"
    # Nothing goes to the Space with a token the Hub refused.
    assert not hosts.sent("GET", re.escape(f"{API}/info")) and not hosts.sent("POST", r".*")


@pytest.mark.asyncio
async def test_an_anonymous_hub_answer_with_the_bad_token_message_is_only_skipped(monkeypatch):
    # No token was sent, so it can't be about one, and it isn't RepoNotFound.
    hosts = idol_hosts(monkeypatch, stage=httpx.Response(
        401, json={"error": "no"}, headers={"x-error-message": "Invalid credentials in Authorization header"}))
    await run_direct()
    assert hosts.sent("POST", re.escape(f"{API}/call/run"))


@pytest.mark.asyncio
async def test_an_anonymous_403_from_the_hub_is_only_skipped(monkeypatch):
    hosts = idol_hosts(monkeypatch, stage=httpx.Response(403, json={"error": "no"}))
    await run_direct()
    assert hosts.sent("POST", re.escape(f"{API}/call/run"))


@pytest.mark.asyncio
@pytest.mark.parametrize("status, line", [
    (401, TOKEN_LINE),
    (503, STARTING),
    (422, CHANGED),
    (403, TOKEN_LINE),
    (500, "Idol turned down this run. Open Details to see why, then try again."),
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
    (403, {"HF_TOKEN": TOKEN}, TOKEN_LINE),
    # Without a token, a 401 or 403 isn't about one (review L7, M09).
    (401, None, "Idol couldn’t use this image. Try another one, or open Details to see why."),
    (403, None, "Idol couldn’t use this image. Try another one, or open Details to see why."),
    (502, None, STARTING),
    (413, None, "Idol couldn’t use this image. Try another one, or open Details to see why."),
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
    # Shorter than its header says: Content-Length disagrees, cut at once.
    (splat_ply(64)[:-10], "Content-Length is"),
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
    # The header declares one byte more than the cap: refused from it.
    assert (f"declares {len(splat_ply(64)):,} bytes, above Nebula's {len(splat_ply(64)) - 1:,}-byte limit"
            in str(excinfo.value))
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
    assert person_line(excinfo.value) == "Nebula couldn’t reach Idol. Check your internet connection, then try again."


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
@pytest.mark.parametrize("bad_token", ["hf_abc’def", "hf_abc\ndef", "hf_été", "hf_abc\x00def", "hf_abc def",
                                       "hf_abc\tdef"])
async def test_a_token_with_a_character_tokens_cant_have_gets_gms_line_and_sends_nothing(monkeypatch, bad_token):
    hosts = idol_hosts(monkeypatch)
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys={"HF_TOKEN": bad_token})
    assert not isinstance(excinfo.value, UnicodeError)
    # GM PR #203 r2: the card's version says Settings; the field's says "here".
    assert person_line(excinfo.value) == ("This token has a character Hugging Face tokens can’t have. "
                                          "Copy it again from Hugging Face, then paste it in Settings.")
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


def test_a_run_names_hugging_face_as_the_provider_it_called():
    """Review LOW 11: the card's "Details shows what … said" named nobody on
    an anonymous run, and "Hugging Face" on a signed-in one."""
    from execution.provider_status import called_provider

    assert called_provider("speridlabs-idol", {"_provider": "auto"}, {"HF_TOKEN": TOKEN}) == "Hugging Face"
    # Keyless (round 7): an anonymous run calls the Space too.
    assert called_provider("speridlabs-idol", {"_provider": "auto"}, {}) == "Hugging Face"
    # Not every keyless-looking None: a node that calls no provider still has none.
    assert called_provider("text-input", {}, {}) is None


def test_a_keyless_route_cant_bill_a_plan():
    definition = keyless_idol()
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



# -- PR #203 round 3 -----------------------------------------------------------------


def _ply_routes(answer):
    return [
        *space_routes(),
        ("POST", re.escape(f"{API}/call/run"), httpx.Response(200, json={"event_id": "ev1"})),
        ("GET", re.escape(f"{API}/call/run/ev1"), httpx.Response(200, content=sse(complete()))),
        ("GET", re.escape(f"{API}/file=") + ".*", answer),
    ]


def _streamed(body: bytes, *, step: int = 1024, headers: dict[str, str] | None = None, served: list[int] | None = None):
    """A streamed file answer; ``served`` counts the bytes the fake handed over."""
    def answer(_request):
        async def chunks():
            for start in range(0, len(body), step):
                if served is not None:
                    served.append(len(body[start:start + step]))
                yield body[start:start + step]

        return httpx.Response(200, content=chunks(), headers=headers or {})
    return answer


@pytest.mark.asyncio
async def test_a_download_that_isnt_a_ply_is_cut_off_after_its_first_bytes(monkeypatch):
    """Review L5: the header is checked from the stream's first 64 KiB, not
    after the whole file (up to 128 MiB) has come."""
    served: list[int] = []
    body = b"<html>" + b"x" * (8 * 1024 * 1024)
    public_dns(monkeypatch)
    FakeHosts(monkeypatch, _ply_routes(_streamed(body, step=4096, served=served)))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert person_line(excinfo.value) == "Idol sent back a file Nebula can’t read as a splat. Try again."
    assert sum(served) <= 64 * 1024 + 4096


@pytest.mark.asyncio
async def test_a_header_declaring_too_many_bytes_is_refused_before_the_rest(monkeypatch):
    monkeypatch.setattr(idol, "MAX_PLY_BYTES", 2000)
    served: list[int] = []
    public_dns(monkeypatch)
    FakeHosts(monkeypatch, _ply_routes(_streamed(splat_ply(64), step=512, served=served)))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert "declares" in str(excinfo.value) and person_line(excinfo.value) == TOO_LARGE_LINE
    assert sum(served) < len(splat_ply(64))


@pytest.mark.asyncio
async def test_a_header_declaring_too_many_gaussians_reads_as_too_large(monkeypatch):
    monkeypatch.setattr(idol, "SPLAT_PLY_MAX_POINTS", 10)
    public_dns(monkeypatch)
    FakeHosts(monkeypatch, _ply_routes(_streamed(splat_ply(64))))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert "64 Gaussians" in str(excinfo.value) and person_line(excinfo.value) == TOO_LARGE_LINE


@pytest.mark.asyncio
async def test_a_content_length_that_disagrees_with_the_header_is_refused(monkeypatch):
    body = splat_ply(64)
    public_dns(monkeypatch)
    FakeHosts(monkeypatch, _ply_routes(_streamed(body, headers={"content-length": str(len(body) + 50)})))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert f"Content-Length is {len(body) + 50:,} bytes" in str(excinfo.value)
    assert person_line(excinfo.value) == "Idol sent back a file Nebula can’t read as a splat. Try again."


@pytest.mark.asyncio
async def test_a_stream_past_the_size_its_header_declares_is_cut_off(monkeypatch):
    served: list[int] = []
    body = splat_ply(64) + b"\0" * 20000
    public_dns(monkeypatch)
    FakeHosts(monkeypatch, _ply_routes(_streamed(body, step=1024, served=served)))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert "runs past" in str(excinfo.value)
    assert sum(served) <= len(splat_ply(64)) + 1024


@pytest.mark.asyncio
async def test_a_headerless_stream_past_the_cap_is_too_large(monkeypatch):
    # No end_header within the cap: refused as too large once past it.
    monkeypatch.setattr(idol, "MAX_PLY_BYTES", 3000)
    public_dns(monkeypatch)
    FakeHosts(monkeypatch, _ply_routes(_streamed(b"ply\n" + b"c" * 10000, step=500)))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert "passed Nebula's 3,000-byte limit" in str(excinfo.value)
    assert person_line(excinfo.value) == TOO_LARGE_LINE


@pytest.mark.asyncio
async def test_a_content_length_exactly_at_the_cap_is_kept(monkeypatch):
    """Review L7, M14: the cap is "over", not "at"."""
    monkeypatch.setattr(idol, "MAX_PLY_BYTES", len(splat_ply(64)))
    idol_hosts(monkeypatch, ply=splat_ply(64))
    world = world_of(await run_direct())
    assert world["assets"]["splats"][0]["asset"]["byteLength"] == len(splat_ply(64))


@pytest.mark.asyncio
async def test_a_result_on_another_space_is_refused_and_never_fetched(monkeypatch):
    """Review L7, M10: only Idol's own host, not any *.hf.space."""
    other = "https://someone-else.hf.space/gradio_api/file=/tmp/x.ply"
    hosts = idol_hosts(monkeypatch, stream=sse(complete(url=other)))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys=SIGNED_IN)
    assert "another host" in str(excinfo.value)
    assert not [r for r in hosts.requests if r.url.host == "someone-else.hf.space"]


@pytest.mark.asyncio
async def test_a_redirect_from_the_space_is_not_followed(monkeypatch):
    """Review L7, M16: a 3xx from the Space never takes the token elsewhere."""
    public_dns(monkeypatch)
    hosts = FakeHosts(monkeypatch, [
        *space_routes(info=None)[:2],
        ("GET", re.escape(f"{API}/info"), httpx.Response(302, headers={"location": "https://evil.example.com/info"})),
        ("GET", r"https://evil\.example\.com/.*", httpx.Response(200, json=INFO)),
    ])
    with pytest.raises(idol.IdolSpaceError):
        await run_direct(keys=SIGNED_IN)
    assert not [r for r in hosts.requests if r.url.host == "evil.example.com"]


@pytest.mark.asyncio
@pytest.mark.parametrize("padded", [f"  {TOKEN}  ", f"{TOKEN}\n", f"\t{TOKEN}\r\n"])
async def test_a_token_padded_with_spaces_or_a_line_break_still_runs(monkeypatch, padded):
    """Review L7, M24, and GM r2: trimmed without a word."""
    hosts = idol_hosts(monkeypatch)
    world_of(await run_node(keys={"HF_TOKEN": padded}))
    sent = {r.headers.get("x-hf-authorization") or r.headers.get("authorization")
            for r in hosts.requests if r.url.host != "example.com"}
    assert sent == {f"Bearer {TOKEN}"}


def test_a_padded_result_url_is_refused():
    """Review N10: urlsplit and httpx read a leading space differently."""
    for url in (f" {RESULT_URL}", f"{RESULT_URL} ", f"\n{RESULT_URL}"):
        with pytest.raises(idol.IdolSpaceError) as excinfo:
            idol._result_url({"url": url, "path": None})
        assert "spaces around it" in str(excinfo.value)


@pytest.mark.asyncio
async def test_a_negative_zero_guidance_is_sent_as_zero(monkeypatch):
    """Review N10: -0.0 is in range, but the Space should get 0.0."""
    hosts = idol_hosts(monkeypatch)
    await run_direct(cfg_scale=-0.0)
    sent = hosts.sent("POST", re.escape(f"{API}/call/run"))[0].content
    assert b"-0.0" not in sent and json.loads(sent)["data"][3] == 0.0


@pytest.mark.asyncio
@pytest.mark.parametrize("params, line", [
    ({"gaussians": "2,097,152"}, "Idol doesn’t take this Gaussians value. Pick one from the list."),
    ({"mode": "Cartoon"}, "Idol doesn’t take this input type. Pick one from the list."),
])
async def test_a_value_the_space_doesnt_take_names_only_its_field(monkeypatch, params, line):
    hosts = idol_hosts(monkeypatch)
    with pytest.raises(ValueError) as excinfo:
        await run_direct(**params)
    assert person_line(excinfo.value) == line
    assert hosts.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403])
async def test_a_result_stream_that_refuses_the_token_says_so(monkeypatch, status):
    """Review L4: the stream, like upload and call/run, maps 401 and 403."""
    public_dns(monkeypatch)
    FakeHosts(monkeypatch, [
        *space_routes(),
        ("POST", re.escape(f"{API}/call/run"), httpx.Response(200, json={"event_id": "ev1"})),
        ("GET", re.escape(f"{API}/call/run/ev1"), httpx.Response(status, text="no")),
    ])
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct(keys=SIGNED_IN)
    assert person_line(excinfo.value) == TOKEN_LINE
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert person_line(excinfo.value) == "Idol stopped before sending a result. Try again in a minute."


def test_the_hugging_face_settings_check_trims_the_token():
    from services.settings import PROVIDER_CHECKS

    check = PROVIDER_CHECKS["Hugging Face"]
    assert check.auth_headers(f" {TOKEN}\n") == {"Authorization": f"Bearer {TOKEN}"}


def test_describe_node_tells_agents_who_can_bill_past_the_allowance():
    from main import HF_SPACE_BILLING_NOTE, _describe_routes

    for keys, is_set in (({}, False), (SIGNED_IN, True)):
        out = _describe_routes(registry()["speridlabs-idol"], keys, lambda _route: [])
        [row] = out["routes"]
        assert row["billing"] == HF_SPACE_BILLING_NOTE
        assert "$1 per 10" in row["billing"] and "PRO, Team or Enterprise" in row["billing"]
        assert "https://huggingface.co/docs/hub/spaces-zerogpu" in row["billing"]
        # Round 7: keyless, and with the token set an agent proposes it.
        assert "Runs free without a token" in row["billing"] and "propose it instead (propose_change)" in row["billing"]
        assert row["keys"] == [] and row["optionalKeys"] == [{"key": "HF_TOKEN", "set": is_set}]


# -- round 4 -------------------------------------------------------------------

IDOL_KEY_LINE = "You can run Idol after you add your Hugging Face token in Settings."


def _quick_idol(pend, monkeypatch, keys, *, headers):
    called = []

    async def fake(**kwargs):
        called.append(1)

    monkeypatch.setattr(pend.main, "execute_graph", fake)
    monkeypatch.setattr(pend.main, "load_settings", lambda: {"apiKeys": dict(keys)})
    response = pend.client.post("/api/quick", headers=headers, json={
        "definitionId": "speridlabs-idol", "inputs": {"image": "https://example.com/a.png"}, "params": {}})
    return response, called


def test_quick_runs_idol_without_a_token_for_agents_and_the_person(pend, monkeypatch):
    """Round 7: keyless, so `nebula quick` / /api/quick runs Idol with no
    token for anyone, with no proposal: nothing can bill."""
    from tests.conftest import PERSON
    from tests.test_canvas_proposals import CLAUDE

    for headers in (CLAUDE, PERSON):
        for keys in ({}, {"HF_TOKEN": ""}):
            response, called = _quick_idol(pend, monkeypatch, keys, headers=headers)
            assert response.status_code == 200, response.text
            assert called == [1]


def test_quick_with_a_token_reaches_the_run(pend, monkeypatch):
    """Past the route's own checks. The pend fixture stubs the spend gate;
    tests/test_idol_may_bill.py runs the real one, which sends an agent's
    run with the token to a proposal."""
    from tests.test_canvas_proposals import CLAUDE

    response, called = _quick_idol(pend, monkeypatch, {"HF_TOKEN": TOKEN}, headers=CLAUDE)
    assert response.status_code == 200, response.text
    assert called == [1]


@pytest.mark.asyncio
async def test_the_download_asks_for_the_file_as_it_is(monkeypatch):
    public_dns(monkeypatch)
    hosts = FakeHosts(monkeypatch, _ply_routes(_streamed(splat_ply(64))))
    world_of(await run_direct(keys=SIGNED_IN))
    [download] = hosts.sent("GET", re.escape(f"{API}/file=") + ".*")
    assert download.headers["accept-encoding"] == "identity"


@pytest.mark.asyncio
@pytest.mark.parametrize("encoding", ["gzip", "GZIP", "deflate"])
async def test_a_compressed_download_its_server_sent_anyway_is_kept(monkeypatch, encoding):
    """Content-Length counts the compressed body; the decoded bytes are the
    splat, so a valid file isn't refused after the GPU time is spent."""
    import gzip
    import zlib

    body = splat_ply(4096)
    packed = gzip.compress(body) if encoding.lower() == "gzip" else zlib.compress(body)
    assert len(packed) < len(body)
    public_dns(monkeypatch)
    FakeHosts(monkeypatch, _ply_routes(_streamed(packed, headers={
        "content-encoding": encoding, "content-length": str(len(packed))})))
    world = world_of(await run_direct())
    assert world["assets"]["splats"][0]["asset"]["byteLength"] == len(body)


@pytest.mark.asyncio
async def test_a_compressed_download_is_still_held_to_its_headers_size(monkeypatch):
    import gzip

    body = splat_ply(64) + b"\0" * 200_000
    packed = gzip.compress(body)
    public_dns(monkeypatch)
    FakeHosts(monkeypatch, _ply_routes(_streamed(packed, headers={
        "content-encoding": "gzip", "content-length": str(len(packed))})))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert f"runs past the {len(splat_ply(64)):,} bytes its header declares" in str(excinfo.value)


SETTINGS_FIELD_LINE = ("This token has a character Hugging Face tokens can’t have. "
                       "Copy it again from Hugging Face, then paste it here.")


@pytest.mark.asyncio
@pytest.mark.parametrize("saved", ["hf_a b", "hf_a\nb", "hf_a\rb", "hf_a\tb", "hf_a\x00b", "hf_aéb", " hf_a b\n"])
async def test_the_settings_check_sends_nothing_for_a_token_with_an_inner_bad_character(monkeypatch, saved):
    from services import settings as settings_service

    sent = []

    class Client:
        async def get(self, url, headers=None, **_kwargs):
            sent.append(url)
            return httpx.Response(200)

    monkeypatch.setattr(settings_service, "load_settings", lambda: {"apiKeys": {"HF_TOKEN": saved}})
    check = settings_service.PROVIDER_CHECKS["Hugging Face"]
    result = await settings_service._check_one(Client(), "Hugging Face", check)
    assert result["status"] == "invalid" and result["configured"] is True
    assert result["detail"] == SETTINGS_FIELD_LINE
    assert sent == []


@pytest.mark.asyncio
async def test_the_settings_check_still_sends_a_clean_token(monkeypatch):
    from services import settings as settings_service

    sent = []

    class Client:
        async def get(self, url, headers=None, **_kwargs):
            sent.append((url, headers))
            return httpx.Response(200)

    monkeypatch.setattr(settings_service, "load_settings", lambda: {"apiKeys": {"HF_TOKEN": f" {TOKEN}\n"}})
    check = settings_service.PROVIDER_CHECKS["Hugging Face"]
    result = await settings_service._check_one(Client(), "Hugging Face", check)
    assert result["status"] == "valid"
    assert sent == [("https://huggingface.co/api/whoami-v2", {"Authorization": f"Bearer {TOKEN}"})]


def test_the_settings_line_is_the_fields_word_for_word():
    from services.settings import HF_TOKEN_CHARACTER_LINE

    source = (Path(__file__).parents[2] / "frontend" / "src" / "lib" / "settingsWrites.ts").read_text()
    assert HF_TOKEN_CHARACTER_LINE == SETTINGS_FIELD_LINE
    assert "'This token has a character Hugging Face tokens can’t have. '\n  + 'Copy it again from Hugging Face, then paste it here.'" in source


@pytest.mark.parametrize("saved", ["   ", "\n", " \r\n\t"])
def test_a_whitespace_only_token_is_no_token(monkeypatch, saved):
    from services import settings as settings_service

    monkeypatch.setattr(settings_service, "_INJECTED_KEYS", {"HF_TOKEN": saved})
    assert settings_service.get_api_key("HF_TOKEN") is None
    assert node_route._is_set({"HF_TOKEN": saved}, "HF_TOKEN") is False


def test_credentials_update_trims_the_hugging_face_token(monkeypatch, person):
    from fastapi.testclient import TestClient

    import main as main_mod
    from services import settings as settings_service

    monkeypatch.setattr(settings_service, "_INJECTED_KEYS", {"OPENAI_API_KEY": "sk-" + "kept"})
    client = TestClient(main_mod.app, headers=person.headers)
    response = client.post("/api/credentials/update", json={"provider": "HF_TOKEN", "key": "  hf_x\r\n"})
    assert response.status_code == 200, response.text
    assert settings_service._INJECTED_KEYS["HF_TOKEN"] == "hf_x"
    response = client.post("/api/credentials/update", json={"provider": "HF_TOKEN", "key": " \n"})
    assert response.status_code == 200, response.text
    assert "HF_TOKEN" not in settings_service._INJECTED_KEYS
    # Only the Hugging Face token is trimmed; another key is stored as sent.
    client.post("/api/credentials/update", json={"provider": "OPENAI_API_KEY", "key": " sk-x "})
    assert settings_service._INJECTED_KEYS["OPENAI_API_KEY"] == " sk-x "


def test_the_signed_in_duration_line_stays_in_code_unused():
    """GM r6 #7: kept for the first live run, not shown today."""
    from execution.person_line import person_line as line_of

    assert line_of(idol.duration_error(detail="x", signed_in=True)) == DURATION_OWN_LINE
    error = idol.classify_space_error(DURATION, signed_in=True)
    assert line_of(error) == NOT_APPLIED_LINE
    # Review r4 LOW-3: agents read both causes; the text is the same for both.
    assert "either the token didn't apply, or a free account's per-task cap is under the ask" in str(error)


# -- round 5 -------------------------------------------------------------------

def test_the_keyless_helpers_survive_the_switch_back(monkeypatch):
    """Review r4 LOW-2: idol.md says the keyless rules' tests pass before and
    after the switch back (step 1 drops missingKeyLine). Here the registry is
    already keyless, as after step 1, and both helpers still build it."""
    from services.node_registry import NodeRegistry
    from tests import test_route_agent_surfaces as surfaces

    switched = keyless_idol()
    assert "missingKeyLine" not in switched["routes"][0]
    real = NodeRegistry.get_all

    def get_all(self):
        return {**real(self), "speridlabs-idol": json.loads(json.dumps(switched))}

    monkeypatch.setattr(NodeRegistry, "get_all", get_all)
    monkeypatch.setitem(surfaces.REGISTRY, "speridlabs-idol", json.loads(json.dumps(switched)))
    assert keyless_idol() == switched
    assert surfaces._keyless_idol() == switched


@pytest.mark.parametrize("answer, missing", [
    # Review r4 NIT-2: huggingface_hub checks these two first, and neither is
    # a missing repo, whatever the status or message with them.
    (httpx.Response(401, headers={"x-error-code": "RevisionNotFound"}), False),
    (httpx.Response(404, headers={"x-error-code": "EntryNotFound",
                                  "x-error-message": "Access to this resource is disabled."}), False),
    (httpx.Response(401, headers={"x-error-code": "EntryNotFound"}), False),
    # The rest of the order still reads as missing.
    (httpx.Response(401), True),
    (httpx.Response(403, headers={"x-error-message": "Access to this resource is disabled."}), True),
])
def test_the_hub_rule_reads_revision_and_entry_answers_first(answer, missing):
    assert idol.hub_says_missing(answer) is missing


@pytest.mark.asyncio
@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
async def test_a_compressed_download_that_wont_decode_says_the_download_line(monkeypatch, encoding):
    """GM, PR #203 r8 item 4: httpx's DecodingError is an HTTPError, which the
    run read as no connection. It is a failed download, in GM's line."""
    from execution.person_line import person_line as line_of

    public_dns(monkeypatch)
    FakeHosts(monkeypatch, _ply_routes(_streamed(b"\x1f\x8b\x08\x00 not really compressed" * 50, headers={
        "content-encoding": encoding})))
    with pytest.raises(idol.IdolSpaceError) as excinfo:
        await run_direct()
    assert line_of(excinfo.value) == "Nebula couldn’t download the object from Idol. Try again in a minute."
    assert "couldn't be decoded" in str(excinfo.value)
