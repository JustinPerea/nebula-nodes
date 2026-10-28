"""A Cinema scene's shape, filled in on every write (PR #198 reviews 2 and 3).

A scene an agent wrote with only ``{"shots": [...]}`` (no ``base``) opened
in Cinema as a white screen: the studio reads ``scene.base.model``. Every
path that writes a cinema-scene node's ``scene`` fills what's missing with
the defaults the canvas uses for a new scene (frontend graphStore
``createDefaultScene``).

Two readings (review 3, H1: a strict read on a project's open and save
locked a saved project, and every paid result in it, out of the UI):

- ``strict``: an agent-authored write (create, edit_canvas, a proposal, an
  agent's PUT). What can't be filled is refused with the field named, so the
  agent learns the shape. Only one thing is converted: a scene sent as JSON
  text, which is how the CLI sends every ``--param``.
- lenient: everything else (a project's open, every save and autosave, the
  handoff save, a recovered copy, import, the person's own PUT and create,
  the person's undo, ``state.json``). Nothing is refused: what can be
  converted is (a base written as a model name, a version that isn't a whole
  number, a prompt that isn't text, a shot without an id or with one used
  twice), and the rest becomes the defaults. The same input always converts
  to the same scene, so the ids an open gives are the ones the next save
  keeps. A new id is never one a ``shot_<id>`` port on the node still names
  (a removed shot's late image), so it never takes over that image or its
  wires (review 4, L1; ``reserved``). A port whose image is a renumbered
  shot's own (it lost its id) moves to that shot's new id instead, with its
  wires (review 5, L3; ``claim_stray_ports``).

A shot's ``running`` status is the canvas's optimistic mark while a run is
on its way. Nothing the backend stores is ever rendering (a run writes
``done`` or ``error``), so a stored ``running`` is settled: ``done`` when the
shot has an image, else ``idle`` (review 2, M1: a scene saved with a running
shot showed "Generating…" for good after a reload).
"""
from __future__ import annotations

import copy
import json
from collections.abc import Iterable
from typing import Any

DEFAULT_BASE_MODEL = "seedream-4-5"
DEFAULT_ASPECT_RATIO = "16:9"
SCENE_VERSION = 1
TRANSIENT_STATUSES = frozenset({"running", "queued", "pending"})
CINEMA_SCENE = "cinema-scene"


class SceneSpecError(ValueError):
    """A scene that can't be normalized; the message names the field."""


def _refuse(field: str, what: str) -> SceneSpecError:
    return SceneSpecError(
        f"cinema-scene {field} {what}. A scene looks like "
        '{"version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9", '
        '"shots": [{"id": "s1", "prompt": "…"}]}; only "shots" is needed, the rest is filled in.')


def settled_output(output: Any) -> Any:
    """A shot's output with a transient run status settled."""
    if not isinstance(output, dict) or output.get("status") not in TRANSIENT_STATUSES:
        return output
    image = output.get("imageUrl")
    if isinstance(image, str) and image:
        return {**output, "status": "done"}
    return {"status": "idle"}


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _scalar_text(value: Any) -> str | None:
    """A prompt that isn't text, as text when it has one (a number); None
    for anything else."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value)
    return None


def _from_json_text(scene: Any) -> Any:
    """A scene sent as JSON text (the CLI sends every ``--param`` as text),
    as the object it spells; anything else as it is."""
    if not isinstance(scene, str):
        return scene
    try:
        parsed = json.loads(scene)
    except ValueError:
        return scene
    return parsed if isinstance(parsed, dict) else scene


def _shot_id(value: Any) -> str | None:
    """A shot's id as text: text as it is, a whole number as its digits."""
    if isinstance(value, str) and value:
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return None


def _clean_runtime(shot: dict[str, Any]) -> None:
    """A shot's runtime fields kept only when they have their shape (in
    place): ``output`` an object (settled), ``variations`` a list,
    ``selectedVariation`` a whole number."""
    if "output" in shot:
        if isinstance(shot["output"], dict):
            shot["output"] = settled_output(shot["output"])
        else:
            shot.pop("output")
    if "variations" in shot and not isinstance(shot["variations"], list):
        shot.pop("variations")
    selected = shot.get("selectedVariation")
    if "selectedVariation" in shot and (isinstance(selected, bool) or not isinstance(selected, int)):
        shot.pop("selectedVariation")


def _new_ids(count: int, taken: set[str]) -> list[str]:
    """``count`` shot ids none of ``taken`` has: "s1", "s2", … in order, the
    same every time for the same scene."""
    ids: list[str] = []
    number = 0
    while len(ids) < count:
        number += 1
        candidate = f"s{number}"
        if candidate not in taken:
            taken.add(candidate)
            ids.append(candidate)
    return ids


def shot_port_ids(outputs: Any) -> set[str]:
    """The shot ids a node's outputs hold a ``shot_<id>`` port for. A port
    whose shot is gone (a removed shot's late image) still names its id, so a
    shot given a new id never takes it over (PR #198 review 4, L1)."""
    if not isinstance(outputs, dict):
        return set()
    return {port[5:] for port in outputs if is_shot_port(port)}


def scene_shot_ids(params: Any) -> list[str]:
    """The text ids of a cinema-scene's shots, in order (none when its params
    hold no readable scene)."""
    scene = params.get("scene") if isinstance(params, dict) else None
    shots = scene.get("shots") if isinstance(scene, dict) else None
    if not isinstance(shots, list):
        return []
    return [shot["id"] for shot in shots if isinstance(shot, dict) and isinstance(shot.get("id"), str)]


def is_shot_port(handle: Any) -> bool:
    return isinstance(handle, str) and handle.startswith("shot_") and len(handle) > 5


def claim_stray_ports(raw_params: Any, params: Any, outputs: Any) -> dict[str, str]:
    """{stray ``shot_<id>`` port: the port of the shot that owns it} for a
    scene read leniently (PR #198 review 5, L3).

    A stray port is one no shot of the converted scene (``params``) owns. A
    shot that lost its id in the saved data (``raw_params``, as it was before
    the read) was given a new one, never a port's (``reserved``), so its own
    port looks stray. Each stray port, in order, goes to the first such
    renumbered shot, in scene order, whose ``output.imageUrl`` is the port's
    value and that has no port of its own; the caller renames the port and
    points its wires at the new handle. A port no shot can claim (a removed
    shot's late image, a case that differs) is left to the caller."""
    if not isinstance(outputs, dict):
        return {}
    scene = params.get("scene") if isinstance(params, dict) else None
    shots = scene.get("shots") if isinstance(scene, dict) else None
    if not isinstance(shots, list):
        return {}
    raw_scene = _from_json_text(raw_params.get("scene")) if isinstance(raw_params, dict) else None
    raw_shots = raw_scene.get("shots") if isinstance(raw_scene, dict) else None
    raw_ids = {text for shot in raw_shots if isinstance(shot, dict) and (text := _shot_id(shot.get("id")))} \
        if isinstance(raw_shots, list) else set()
    owned = {f"shot_{shot['id']}" for shot in shots if isinstance(shot, dict) and isinstance(shot.get("id"), str)}
    renumbered = [shot for shot in shots if isinstance(shot, dict) and isinstance(shot.get("id"), str)
                  and shot["id"] not in raw_ids and f"shot_{shot['id']}" not in outputs]
    claimed: dict[str, str] = {}
    for handle, port in outputs.items():
        if not is_shot_port(handle) or handle in owned:
            continue
        value = port.get("value") if isinstance(port, dict) else None
        if not isinstance(value, str) or not value:
            continue
        for shot in renumbered:
            output = shot.get("output")
            new_handle = f"shot_{shot['id']}"
            if isinstance(output, dict) and output.get("imageUrl") == value and new_handle not in claimed.values():
                claimed[handle] = new_handle
                break
    return claimed


def rekeyed_outputs(outputs: dict[str, Any], claimed: dict[str, str]) -> dict[str, Any]:
    """``outputs`` with each claimed port under its new handle, in place of
    the old one (claim_stray_ports)."""
    return {claimed.get(handle, handle): port for handle, port in outputs.items()}


def _lenient_shots(shots: Any, reserved: Iterable[str] = ()) -> list[dict[str, Any]]:
    """Every shot that can be read, each with a unique text id and a text
    prompt. A shot that is only text is that prompt; anything else that
    isn't an object is dropped (it holds nothing to keep). A new id is never
    one of ``reserved`` (the ids the node's ports name, shot_port_ids)."""
    if not isinstance(shots, list):
        return []
    kept: list[dict[str, Any]] = []
    for shot in shots:
        if isinstance(shot, str):
            kept.append({"prompt": shot})
        elif isinstance(shot, dict):
            kept.append(shot)
    # The first shot with an id keeps it (its port and wires are its own);
    # a shot with none, or with one an earlier shot has, gets a new one that
    # no shot in the scene has.
    seen: set[str] = set()
    needs: list[int] = []
    for index, shot in enumerate(kept):
        shot_id = _shot_id(shot.get("id"))
        if shot_id is None or shot_id in seen:
            needs.append(index)
            continue
        shot["id"] = shot_id
        seen.add(shot_id)
    taken = seen | {text for shot in kept if (text := _shot_id(shot.get("id")))} | set(reserved)
    for index, shot_id in zip(needs, _new_ids(len(needs), taken)):
        kept[index]["id"] = shot_id
    for shot in kept:
        prompt = shot.get("prompt")
        if not isinstance(prompt, str):
            shot["prompt"] = _scalar_text(prompt) or ""
        _clean_runtime(shot)
    # The id first, as the canvas writes a shot.
    return [{"id": shot["id"], **{key: value for key, value in shot.items() if key != "id"}} for shot in kept]


def _lenient(scene: Any, reserved: Iterable[str] = ()) -> dict[str, Any]:
    out = copy.deepcopy(scene) if isinstance(scene, dict) else {}
    version = out.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        out["version"] = SCENE_VERSION
    base = out.get("base")
    if isinstance(base, str) and base.strip():
        out["base"] = {"model": base.strip()}
    elif isinstance(base, dict):
        model = base.get("model")
        fixed = dict(base)
        if not isinstance(model, str) or not model.strip():
            fixed["model"] = DEFAULT_BASE_MODEL
        if "params" in fixed and not isinstance(fixed["params"], dict):
            fixed.pop("params")
        out["base"] = fixed
    else:
        out["base"] = {"model": DEFAULT_BASE_MODEL}
    aspect = out.get("aspectRatio")
    if not isinstance(aspect, str) or not aspect.strip():
        out["aspectRatio"] = DEFAULT_ASPECT_RATIO
    out["shots"] = _lenient_shots(out.get("shots"), reserved)
    return out


def normalize_scene(scene: Any, *, strict: bool = True, reserved: Iterable[str] = ()) -> Any:
    """``scene`` with its missing fields filled and transient statuses
    settled (a copy). ``strict`` (an agent-authored write): raise
    SceneSpecError for what can't be filled. Otherwise convert what can be
    and fill the rest with the defaults; never raises (see the module doc).
    ``reserved``: shot ids a new id must not take (shot_port_ids of the node)."""
    scene = _from_json_text(scene)
    if not strict:
        return _lenient(scene, reserved)
    if not isinstance(scene, dict):
        raise _refuse("scene", "must be an object")
    out = copy.deepcopy(scene)
    version = out.get("version")
    if version is None:
        out["version"] = SCENE_VERSION
    elif isinstance(version, bool) or not isinstance(version, int):
        raise _refuse("scene.version", "must be a whole number")
    base = out.get("base")
    if base is None:
        out["base"] = {"model": DEFAULT_BASE_MODEL}
    elif isinstance(base, dict):
        model = base.get("model")
        if model is None or (isinstance(model, str) and not model.strip()):
            out["base"] = {**base, "model": DEFAULT_BASE_MODEL}
        elif not isinstance(model, str):
            raise _refuse("scene.base.model", "must be text")
        if "params" in base and not isinstance(base["params"], dict):
            raise _refuse("scene.base.params", "must be an object")
    else:
        raise _refuse("scene.base", 'must be an object like {"model": "seedream-4-5"}')
    aspect = out.get("aspectRatio")
    if _blank(aspect):
        out["aspectRatio"] = DEFAULT_ASPECT_RATIO
    elif not isinstance(aspect, str):
        raise _refuse("scene.aspectRatio", 'must be text like "16:9"')
    shots = out.get("shots")
    if not isinstance(shots, list):
        raise _refuse("scene.shots", "must be a list of shots")
    seen: set[str] = set()
    for index, shot in enumerate(shots):
        if not isinstance(shot, dict):
            raise _refuse(f"scene.shots[{index}]", "must be an object")
        shot_id = shot.get("id")
        if not isinstance(shot_id, str) or not shot_id:
            raise _refuse(f"scene.shots[{index}].id", "must be non-empty text")
        if shot_id in seen:
            raise _refuse(f"scene.shots[{index}].id", f"'{shot_id}' is used twice; shot ids must be unique")
        seen.add(shot_id)
        prompt = shot.get("prompt")
        if prompt is None:
            shot["prompt"] = ""
        elif not isinstance(prompt, str):
            raise _refuse(f"scene.shots[{index}].prompt", "must be text")
        _clean_runtime(shot)
    return out


def normalize_params(definition_id: str, params: dict[str, Any], *, strict: bool = True,
                     reserved: Iterable[str] = ()) -> dict[str, Any]:
    """``params`` with a cinema-scene's ``scene`` normalized (a copy when it
    changes); other nodes' params as they are. ``reserved`` as for
    normalize_scene."""
    if definition_id != CINEMA_SCENE or not isinstance(params, dict) or "scene" not in params:
        return params
    return {**params, "scene": normalize_scene(params["scene"], strict=strict, reserved=reserved)}
