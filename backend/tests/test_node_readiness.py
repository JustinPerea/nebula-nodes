"""Readiness for local nodes that still call a provider (``providerVia``), and
the guards that keep those definitions honest about what their handlers do."""
from __future__ import annotations

import ast
import functools
import inspect
import json
import sys
import textwrap
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from services import model_pricing, node_readiness  # noqa: E402

DEFINITIONS = json.loads((BACKEND / "data" / "node_definitions.json").read_text())
CINEMA = DEFINITIONS["cinema-scene"]
QC_IDS = ("qc-loop-safety", "qc-frame-review", "qc-composited-look", "qc-camera-geometry")
VISION_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"]


def scene(model: object = "seedream-4-5") -> dict:
    return {"scene": {"base": {"model": model}, "shots": []}}


# -- cinema-scene: it runs its base model --------------------------------------

def test_cinema_scene_needs_a_base_models_key_not_nothing():
    assert node_readiness.node_access(CINEMA, set(), False, DEFINITIONS) is None
    assert node_readiness.node_access(CINEMA, {"FAL_KEY"}, False, DEFINITIONS) == "key"
    assert node_readiness.node_access(CINEMA, {"GOOGLE_API_KEY"}, False, DEFINITIONS) == "key"
    # Without the definitions to look its models up, it can't be judged: fail closed.
    assert node_readiness.node_access(CINEMA, {"FAL_KEY"}, False) is None
    missing = node_readiness.missing(CINEMA, False, DEFINITIONS)
    assert "FAL_KEY (seedream-4-5 default" in missing and "GOOGLE_API_KEY (nano-banana)" in missing


def test_cinema_detail_points_at_a_base_that_can_run():
    only_google = node_readiness.detail(CINEMA, {"GOOGLE_API_KEY"}, False, DEFINITIONS)
    assert only_google["param"] == "scene.base.model" and only_google["default"] == "seedream-4-5"
    assert only_google["options"]["seedream-4-5"] is None and only_google["options"]["nano-banana"] == "key"
    assert "set scene.base.model to nano-banana" in only_google["note"]
    nothing = node_readiness.detail(CINEMA, set(), False, DEFINITIONS)
    assert "note" not in nothing and "FAL_KEY" in nothing["missing"]
    assert "note" not in node_readiness.detail(CINEMA, {"FAL_KEY"}, False, DEFINITIONS)


@pytest.mark.parametrize(("params", "expected"), [
    ({}, "seedream-4-5"),                       # a fresh node runs the default
    ({"scene": {}}, "seedream-4-5"),
    (scene(""), "seedream-4-5"),
    (scene(None), "seedream-4-5"),
    (scene(" FLUX-1-dev "), "seedream-4-5"),    # non-commercial falls back, as the guard does
    (scene("Nano-Banana"), "nano-banana"),
    (scene("flux-kontext"), "flux-kontext"),
    (scene("worldlabs-environment"), None),      # anything else is refused
    (scene(5), None),
    ({"scene": "text"}, None),
    ({"scene": {"base": "nano-banana"}}, None),
])
def test_cinema_model_choice_reads_like_the_handler_guard(params, expected):
    from handlers.cinema_scene import _guard_base_model

    assert node_readiness.model_choice(CINEMA, params) == expected
    spec = params.get("scene") or {}
    if isinstance(spec, dict) and isinstance(spec.get("base") or {}, dict):
        try:
            guarded = _guard_base_model(spec.get("base") or {})
        except ValueError:
            guarded = None
        assert guarded == expected


def test_keys_needed_names_the_chosen_base_or_fails_closed():
    needs = node_readiness.keys_needed(CINEMA, scene("nano-banana"), DEFINITIONS)
    assert [need["id"] for need in needs] == ["nano-banana"]
    assert node_readiness.keys_needed(CINEMA, scene("bogus"), DEFINITIONS) is None


# -- QC nodes: a mode picks local or vision-model work -------------------------

@pytest.mark.parametrize("definition_id", QC_IDS)
def test_qc_is_free_at_its_defaults_and_says_what_vision_llm_needs(definition_id):
    definition = DEFINITIONS[definition_id]
    assert node_readiness.node_access(definition, set(), False, DEFINITIONS) == "free"
    nothing = node_readiness.detail(definition, set(), False, DEFINITIONS)
    assert nothing["options"] == {"heuristic": "free", "vision-llm": None, "opencv": "free", "jev": None}
    assert all(key in nothing["missing"]["vision-llm"] for key in VISION_KEYS)
    assert nothing["missing"]["jev"] == "needs TYPESAFE_API_KEY in Settings > Providers"
    assert "no list price" in nothing["note"]
    openai = node_readiness.detail(definition, {"OPENAI_API_KEY"}, False, DEFINITIONS)
    # A vision key runs vision-llm; Jev mode still needs TypeSafe's own key.
    assert openai["options"]["vision-llm"] == "key" and list(openai["missing"]) == ["jev"]


@pytest.mark.parametrize(("params", "calls"), [
    ({}, False), ({"mode": "heuristic"}, False), ({"mode": "opencv"}, False),
    ({"mode": "vision-llm"}, True),
    # Anything the handler wouldn't run locally counts as the provider call.
    ({"mode": ""}, True), ({"mode": None}, True), ({"mode": "Heuristic"}, True), ({"mode": "bogus"}, True),
])
def test_qc_mode_is_read_exactly_like_the_handler(params, calls):
    definition = DEFINITIONS["qc-frame-review"]
    assert node_readiness.param_calls_provider(definition, params) is calls
    assert model_pricing.is_local(definition, params) is (not calls)
    needs = node_readiness.keys_needed(definition, params, DEFINITIONS)
    assert (needs[0]["envKeyName"] if needs else []) == (VISION_KEYS if calls else [])


# -- the definitions match the code that calls the provider --------------------

def test_cinema_provider_via_matches_the_handler_guard():
    from handlers.cinema_scene import _COMMERCIAL_OK_DEFAULT_BASES, _DEFAULT_BASE_MODEL, _NONCOMMERCIAL_BASES

    via = CINEMA["providerVia"]
    # The handler constant stays the boundary; the definition only describes it.
    assert set(via["models"]) == _COMMERCIAL_OK_DEFAULT_BASES
    assert via["default"] == _DEFAULT_BASE_MODEL
    assert set(via["fallbackFor"]) == _NONCOMMERCIAL_BASES
    assert via["path"] == ["scene", "base", "model"]


@pytest.mark.parametrize("definition_id", QC_IDS)
def test_qc_provider_via_matches_vision_llm_and_the_handler_modes(definition_id):
    from handlers.qc_base import VALID_QC_MODES, qc_mode
    from models.graph import GraphNode
    from services.vision_llm import VISION_PROVIDERS

    definition = DEFINITIONS[definition_id]
    from services.qc_jev import JEV_MODE
    from services.typesafe_client import CREDENTIAL

    via = definition["providerVia"]
    assert via["anyKey"] == [provider.key_name for provider in VISION_PROVIDERS]
    # Every QC handler calls the vision model only for mode == "vision-llm",
    # and TypeSafe only for mode == "jev".
    assert set(via["freeWhen"]) == VALID_QC_MODES - {"vision-llm", JEV_MODE}
    assert via["byValue"] == {JEV_MODE: {"anyKey": [CREDENTIAL], "provider": "typesafe"}}
    default = next(p["default"] for p in definition["params"] if p["key"] == via["param"])
    assert qc_mode(GraphNode(id="n", definitionId=definition_id, params={})) == default


# What a handler module imports, to find utility nodes that can reach a paid
# API. The walk fails closed: anything it can't follow (a dynamic import, a
# subprocess or shell call that could run curl or a provider CLI) counts as a
# hit, the same as importing httpx, unless the module is listed below with why.
NETWORK_MODULES = ("httpx", "requests", "aiohttp", "urllib.request", "openai", "anthropic",
                   "google.genai", "google.generativeai", "google.cloud", "fal_client", "replicate",
                   "elevenlabs", "websockets", "boto3")
# Imports and calls the walk can't see through.
OPAQUE_MODULES = ("subprocess", "importlib", "pty", "multiprocessing")
OPAQUE_CALLS = {"__import__", "create_subprocess_exec", "create_subprocess_shell", "system", "popen",
                "spawnl", "spawnv", "spawnve", "spawnlp", "spawnvp", "execv", "execve", "execvp",
                "execl", "execlp", "posix_spawn", "posix_spawnp"}
# Shared plumbing that imports httpx for something other than a provider call.
# The walk stops at these, so each one's direct imports are pinned below: a new
# import into one of them fails test_the_walk_stops_only_where_it_was_reviewed
# until someone checks it and updates the pin.
NOT_PROVIDER_CALLS = {
    # Downloads a finished output URL into the output folder. image_to_data_uri
    # reads a local image through services.media_input (file policy + size cap;
    # its only network use is public_url's credential-free public https fetch)
    # and takes its default bound from services.image_input (local reads only).
    # services.media_types is the extension table (re, pathlib, urllib.parse only;
    # no network, no backend import), shared with universal_ports (2026-10-21).
    "services.output": {"httpx", "services.ffmpeg", "services.file_access", "services.settings",
                        "services.image_input", "services.media_input", "services.media_types"},
    # The settings store; its httpx use is Settings > Providers' key check, which
    # the person starts and which costs nothing (google_vertex and nous_auth are
    # the credential checks for those two providers). services.node_route gives
    # it key_text, the one "token is set and usable" reading the run gate and
    # the handlers share (the standard library, and execution.person_line's
    # wording, itself re and typing only; no network), PR #203 round 8.
    "services.settings": {"httpx", "services.google_vertex", "services.nous_auth", "services", "services.node_route"},
    # Path rules for local files; it imports the agent/workspace stack, never a provider.
    # services.input_file_name is the kept upload name's param key (re and typing
    # only; no network, no backend import), skipped by validate_file_references
    # (2026-10-24).
    "services.file_access": {"services.agent_profiles", "services.agent_workspaces", "services.output",
                             "services.input_file_name"},
}
# Modules that spawn a process the walk can't see into, but whose program is
# known and calls no paid API, each with why. Only their own spawn is excused;
# the walk still follows what they import.
LOCAL_PROCESSES = {
    # Runs the ffmpeg and ffprobe binaries on local files or a public media URL
    # (services/ffmpeg.py cmd lists); no provider account is involved.
    "services.ffmpeg",
    # Runs `node` on the bundled Remotion renderer to render a composition locally.
    "services.remotion_render",
}
# Utility definitions whose handler module can reach the network, but whose own
# handler never does, each with why.
LOCAL_DESPITE_IMPORTS = {
    # Data-only nodes that hand a Krea style or moodboard reference to a Krea
    # generation node (handlers/krea.py handle_krea_style / _moodboard /
    # _image_style_reference); they share a module with the paid Krea handlers.
    "krea-style", "krea-moodboard", "krea-image-style-reference",
}


def _file_for(module: str) -> Path | None:
    for candidate in (BACKEND / (module.replace(".", "/") + ".py"), BACKEND / module.replace(".", "/") / "__init__.py"):
        if candidate.exists():
            return candidate
    return None


def _package_of(module: str) -> str:
    path = _file_for(module)
    if path is not None and path.name == "__init__.py":
        return module
    return module.rpartition(".")[0]


def _imports(source: str, module: str | None = None) -> set[str]:
    """Modules ``source`` imports. Relative imports resolve against ``module``'s
    package. A dynamic import or a process spawn adds an ``<opaque:...>`` entry,
    which the walk counts as a hit."""
    found: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                if module is None:
                    found.add(f"<opaque:relative import .{base}>")
                    continue
                package = _package_of(module).split(".") if _package_of(module) else []
                anchor = package[: len(package) - (node.level - 1)] if node.level - 1 <= len(package) else None
                if anchor is None:
                    found.add(f"<opaque:relative import .{base}>")
                    continue
                base = ".".join([*anchor, *([base] if base else [])])
            if base:
                found.add(base)
            found |= {f"{base}.{alias.name}" if base else alias.name for alias in node.names}
        elif isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name in OPAQUE_CALLS:
                found.add(f"<opaque:{name}()>")
        elif isinstance(node, ast.Constant) and node.value in OPAQUE_CALLS:
            # getattr(asyncio, "create_subprocess_exec") and the like.
            found.add(f"<opaque:{node.value}>")
    return found


def _reaches_network(roots: set[str]) -> list[str]:
    seen: set[str] = set()
    hits: set[str] = set()
    stack = [(module, None) for module in roots]
    while stack:
        module, importer = stack.pop()
        if module.startswith("<opaque:"):
            if importer not in LOCAL_PROCESSES:
                hits.add(f"{module} in {importer}")
            continue
        if module in seen or any(module == stop or module.startswith(stop + ".") for stop in NOT_PROVIDER_CALLS):
            continue
        seen.add(module)
        path = _file_for(module)
        if path is None:
            if any(module == m or module.startswith(m + ".") for m in (*NETWORK_MODULES, *OPAQUE_MODULES)):
                hits.add(module if importer is None else f"{module} in {importer}")
            continue
        stack.extend((imported, module) for imported in _imports(path.read_text(), module))
    return sorted(hits)


def _handler_roots(handler) -> set[str]:
    while isinstance(handler, functools.partial):
        handler = handler.func
    if handler.__module__ != "execution.sync_runner":
        return {handler.__module__}
    # sync_runner's wrappers import their handler inside the function body.
    return _imports(textwrap.dedent(inspect.getsource(handler)), "execution.sync_runner")


def test_every_utility_node_that_can_reach_a_paid_api_says_so():
    """A utility node whose handler can make a network call is either declared
    (``providerVia``, so readiness, pricing and the spending limits see it) or
    listed above as local with a reason. A new one fails here instead of
    reading as free to agents."""
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=AsyncMock())
    undeclared = {}
    for definition_id, definition in DEFINITIONS.items():
        if definition.get("apiProvider") != "utility" or definition_id not in registry:
            continue  # the engine runs the rest itself (inputs, router, batch, ...)
        hits = _reaches_network(_handler_roots(registry[definition_id]))
        declared = "providerVia" in definition or definition_id in LOCAL_DESPITE_IMPORTS
        if hits and not declared:
            undeclared[definition_id] = hits
    assert undeclared == {}
    # The allowlist stays honest: each entry still exists, and none of them is
    # declared as a provider caller too.
    for definition_id in LOCAL_DESPITE_IMPORTS:
        assert definition_id in DEFINITIONS and "providerVia" not in DEFINITIONS[definition_id]
    for module in (*NOT_PROVIDER_CALLS, *LOCAL_PROCESSES):
        assert _file_for(module) is not None


def test_the_guard_sees_the_vision_and_cinema_calls():
    """The walk does find them: without providerVia these would fail the test above."""
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=AsyncMock())
    for definition_id in (*QC_IDS, "cinema-scene"):
        assert _reaches_network(_handler_roots(registry[definition_id])), definition_id


def _direct_reach(module: str) -> set[str]:
    """``module``'s own imports that the walk cares about: network, opaque, or in-repo."""
    reach = set()
    for name in _imports(_file_for(module).read_text(), module):
        network = any(name == m or name.startswith(m + ".") for m in (*NETWORK_MODULES, *OPAQUE_MODULES))
        if name.startswith("<opaque:") or network or _file_for(name) is not None:
            reach.add(name)
    return reach


@pytest.mark.parametrize("module", sorted(NOT_PROVIDER_CALLS))
def test_the_walk_stops_only_where_it_was_reviewed(module):
    """The walk stops at these modules, so they can't quietly gain a provider
    import: their direct imports are pinned to what was reviewed."""
    assert _direct_reach(module) == NOT_PROVIDER_CALLS[module]


def test_the_walk_fails_closed_on_what_it_cannot_follow():
    # Relative imports resolve against the importing module's package.
    assert {"handlers", "handlers.x", "services", "services.y"} <= _imports(
        "from . import x\nfrom ..services import y\n", "handlers.foo")
    assert _imports("from .helpers import z\n", "handlers") >= {"handlers.helpers", "handlers.helpers.z"}
    # ...and one with no known package can't be followed, so it is a hit.
    assert _reaches_network(_imports("from .x import y\n"))
    # Dynamic imports and process spawns are hits wherever the walk meets them.
    for source in (
        "import importlib\nimportlib.import_module('fal_client')\n",
        "__import__('fal_client')\n",
        "import subprocess\nsubprocess.run(['curl', 'https://api.example'])\n",
        "import asyncio\nasyncio.create_subprocess_exec('npx', 'some-sdk-cli')\n",
        "import asyncio\nspawn = getattr(asyncio, 'create_subprocess_exec')\n",
        "import os\nos.system('curl https://api.example')\n",
    ):
        assert _reaches_network(_imports(source, "handlers.made_up")), source
    # A listed local process module is excused for its own spawn only.
    assert not _reaches_network({"services.ffmpeg"})
    assert _reaches_network({"<opaque:create_subprocess_exec>"})


ROUTE_TABLE = json.loads((Path(__file__).parent / "fixtures" / "route_cases.json").read_text())["definitions"]["routes-image"]


def test_instance_access_answers_for_the_chosen_route():
    from services import node_route
    # Auto runs on the first keyed route.
    assert node_readiness.instance_access(ROUTE_TABLE, {}, {"FAL_KEY"}) == node_readiness.KEY
    # An explicit route needs its own key; another route's key doesn't count.
    assert node_readiness.instance_access(ROUTE_TABLE, {"_provider": "replicate"}, {"FAL_KEY", "BFL_API_KEY"}) is None
    assert node_readiness.instance_access(ROUTE_TABLE, {"_provider": "replicate"}, {"REPLICATE_API_TOKEN"}) == "key"
    # A setting Auto's route can't take: not ready, never moved to another route.
    assert node_readiness.instance_access(ROUTE_TABLE, {"safety_tolerance": 6}, {"BFL_API_KEY", "FAL_KEY"}) is None
    # An unknown route id fails closed.
    assert node_readiness.instance_access(ROUTE_TABLE, {"_provider": "nope"}, {"FAL_KEY"}) is None
    # The Krea route on the plan needs the sign-in, not a key.
    plan = {"_provider": "krea", "_kreaAuth": "mcp"}
    assert node_readiness.instance_access(ROUTE_TABLE, plan, set(), krea_signed_in=True) == node_readiness.KREA
    assert node_readiness.instance_access(ROUTE_TABLE, plan, {"KREA_API_TOKEN"}) is None
    # The definition stays ready when any route is keyed.
    assert node_readiness.node_access(ROUTE_TABLE, {"REPLICATE_API_TOKEN"}, False) == node_readiness.KEY
    assert node_route.has_routes(ROUTE_TABLE)


def test_instance_access_for_a_legacy_node_is_node_access():
    veo = DEFINITIONS["veo-3"]
    for keys in (set(), {"FAL_KEY"}, {"GOOGLE_API_KEY"}):
        assert node_readiness.instance_access(veo, {}, keys) == node_readiness.node_access(veo, keys, False, DEFINITIONS)


def test_keys_needed_names_only_the_explicit_route():
    assert node_readiness.keys_needed(ROUTE_TABLE, {}, DEFINITIONS) == [ROUTE_TABLE]
    assert node_readiness.keys_needed(ROUTE_TABLE, {"_provider": "replicate"}, DEFINITIONS) == [
        {"id": "routes-image", "apiProvider": "replicate", "envKeyName": ["REPLICATE_API_TOKEN"]}]
    krea = node_readiness.keys_needed(ROUTE_TABLE, {"_provider": "krea"}, DEFINITIONS)
    assert krea[0]["envKeyName"] == ["KREA_API_TOKEN"]
    assert node_readiness.krea_modes(krea[0]) == ["api-token", "mcp"]
    assert node_readiness.keys_needed(ROUTE_TABLE, {"_provider": "nope"}, DEFINITIONS) is None


# -- one node with its own params (proposals: what Accept would run) ---------------

def test_instance_missing_reads_a_krea_nodes_own_billing_choice():
    krea = DEFINITIONS["krea-2-generate"]
    # Signed in, but this node bills the API token (the default for a new node).
    assert node_readiness.instance_missing(krea, {}, set(), krea_signed_in=True) == (
        "needs KREA_API_TOKEN in Settings > Providers")
    assert node_readiness.node_access(krea, set(), True) == node_readiness.KREA  # the type can run
    assert node_readiness.instance_missing(krea, {}, {"KREA_API_TOKEN"}) is None
    assert node_readiness.instance_missing(krea, {"_kreaAuth": "mcp"}, set(), krea_signed_in=True) is None
    assert node_readiness.instance_missing(krea, {"_kreaAuth": "mcp"}, set()) == node_readiness.KREA_SIGN_IN


def test_instance_missing_speaks_like_find_nodes():
    gpt = DEFINITIONS["gpt-image-2-generate"]
    assert node_readiness.instance_missing(gpt, {}, set()) == node_readiness.missing(gpt, False, DEFINITIONS)
    assert node_readiness.instance_missing(gpt, {}, {"OPENAI_API_KEY"}) is None
    assert node_readiness.instance_missing(DEFINITIONS["text-input"], {}, set()) is None
    # A local node that calls a provider needs the key its value picks.
    qc = DEFINITIONS["qc-frame-review"]
    assert node_readiness.instance_missing(qc, {}, set()) is None
    assert "ANTHROPIC_API_KEY" in node_readiness.instance_missing(qc, {"mode": "vision-llm"}, set())
    assert node_readiness.instance_missing(CINEMA, scene("nano-banana"), {"GOOGLE_API_KEY"}, definitions=DEFINITIONS) is None
    assert "FAL_KEY" in node_readiness.instance_missing(CINEMA, scene("seedream-4-5"), {"GOOGLE_API_KEY"},
                                                        definitions=DEFINITIONS)


def test_instance_missing_on_a_route_table_node_is_the_routers_message():
    from services import node_route

    flux = DEFINITIONS["flux-3-image"]
    expected = node_route.route_unavailable(flux, {}, {})["message"]
    assert node_readiness.instance_missing(flux, {}, set()) == expected
    keys = {key for route in node_route.routes_of(flux) for key in route.get("keys") or []}
    assert node_readiness.instance_missing(flux, {}, keys) is None
