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
    assert nothing["options"] == {"heuristic": "free", "vision-llm": None, "opencv": "free"}
    assert all(key in nothing["missing"]["vision-llm"] for key in VISION_KEYS)
    assert "no list price" in nothing["note"]
    openai = node_readiness.detail(definition, {"OPENAI_API_KEY"}, False, DEFINITIONS)
    assert openai["options"]["vision-llm"] == "key" and "missing" not in openai


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
    via = definition["providerVia"]
    assert via["anyKey"] == [provider.key_name for provider in VISION_PROVIDERS]
    # Every QC handler calls the vision model only for mode == "vision-llm".
    assert set(via["freeWhen"]) == VALID_QC_MODES - {"vision-llm"}
    default = next(p["default"] for p in definition["params"] if p["key"] == via["param"])
    assert qc_mode(GraphNode(id="n", definitionId=definition_id, params={})) == default


# What a handler module imports, to find utility nodes that can reach a paid
# API. Shared plumbing that imports httpx for something other than a provider
# call is listed here, each with why; the walk stops there.
NETWORK_MODULES = ("httpx", "requests", "aiohttp", "urllib.request", "openai", "anthropic",
                   "google.genai", "google.generativeai", "google.cloud", "fal_client", "replicate",
                   "elevenlabs", "websockets", "boto3")
NOT_PROVIDER_CALLS = {
    # Downloads a finished output URL into the output folder.
    "services.output",
    # The settings store; its httpx use is Settings > Providers' key check, which
    # the person starts and which costs nothing.
    "services.settings",
    # Path rules for local files; it imports the agent/workspace stack, never a provider.
    "services.file_access",
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


def _imports(source: str) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module)
            found |= {f"{node.module}.{alias.name}" for alias in node.names}
    return found


def _reaches_network(roots: set[str]) -> list[str]:
    seen: set[str] = set()
    hits: set[str] = set()
    stack = list(roots)
    while stack:
        module = stack.pop()
        if module in seen or any(module == stop or module.startswith(stop + ".") for stop in NOT_PROVIDER_CALLS):
            continue
        seen.add(module)
        path = _file_for(module)
        if path is None:
            if any(module == net or module.startswith(net + ".") for net in NETWORK_MODULES):
                hits.add(module)
            continue
        stack.extend(_imports(path.read_text()))
    return sorted(hits)


def _handler_roots(handler) -> set[str]:
    while isinstance(handler, functools.partial):
        handler = handler.func
    if handler.__module__ != "execution.sync_runner":
        return {handler.__module__}
    # sync_runner's wrappers import their handler inside the function body.
    return _imports(textwrap.dedent(inspect.getsource(handler)))


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
    for module in NOT_PROVIDER_CALLS:
        assert _file_for(module) is not None


def test_the_guard_sees_the_vision_and_cinema_calls():
    """The walk does find them: without providerVia these would fail the test above."""
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=AsyncMock())
    for definition_id in (*QC_IDS, "cinema-scene"):
        assert _reaches_network(_handler_roots(registry[definition_id])), definition_id
