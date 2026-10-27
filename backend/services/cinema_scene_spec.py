"""A Cinema scene's shape, filled in on every write (PR #198 review 2, M2).

A scene an agent wrote with only ``{"shots": [...]}`` (no ``base``) opened
in Cinema as a white screen: the studio reads ``scene.base.model``. Every
path that writes a cinema-scene node's ``scene`` (create, edit_canvas,
proposals and their Accept, PUT, restore, import, a project's load) fills
what's missing with the defaults the canvas uses for a new scene
(frontend graphStore ``createDefaultScene``), and refuses only what can't be
filled, naming the field.

A shot's ``running`` status is the canvas's optimistic mark while a run is
on its way. Nothing the backend stores is ever rendering (a run writes
``done`` or ``error``), so a stored ``running`` is settled: ``done`` when the
shot has an image, else ``idle`` (review 2, M1: a scene saved with a running
shot showed "Generating…" for good after a reload).
"""
from __future__ import annotations

import copy
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


def normalize_scene(scene: Any, *, strict: bool = True) -> Any:
    """``scene`` with its missing fields filled and transient statuses
    settled (a copy). ``strict``: raise SceneSpecError for what can't be
    filled; otherwise leave that part as it is (a saved project still opens,
    and the studio's own guard shows what's wrong)."""
    if scene is None and not strict:
        scene = {}
    if not isinstance(scene, dict):
        if strict:
            raise _refuse("scene", "must be an object")
        return scene
    out = copy.deepcopy(scene)
    version = out.get("version")
    if version is None:
        out["version"] = SCENE_VERSION
    elif strict and (isinstance(version, bool) or not isinstance(version, int)):
        raise _refuse("scene.version", "must be a whole number")
    base = out.get("base")
    if base is None:
        out["base"] = {"model": DEFAULT_BASE_MODEL}
    elif isinstance(base, dict):
        model = base.get("model")
        if model is None or (isinstance(model, str) and not model.strip()):
            out["base"] = {**base, "model": DEFAULT_BASE_MODEL}
        elif strict and not isinstance(model, str):
            raise _refuse("scene.base.model", "must be text")
    elif strict:
        raise _refuse("scene.base", 'must be an object like {"model": "seedream-4-5"}')
    aspect = out.get("aspectRatio")
    if aspect is None or (isinstance(aspect, str) and not aspect.strip()):
        out["aspectRatio"] = DEFAULT_ASPECT_RATIO
    elif strict and not isinstance(aspect, str):
        raise _refuse("scene.aspectRatio", 'must be text like "16:9"')
    shots = out.get("shots")
    if shots is None and not strict:
        # A write always says which shots the scene has (an empty or missing
        # list would wipe them); a saved scene without any has none.
        out["shots"] = shots = []
    if not isinstance(shots, list):
        if strict:
            raise _refuse("scene.shots", "must be a list of shots")
        return out
    seen: set[str] = set()
    for index, shot in enumerate(shots):
        if not isinstance(shot, dict):
            if strict:
                raise _refuse(f"scene.shots[{index}]", "must be an object")
            continue
        shot_id = shot.get("id")
        if not isinstance(shot_id, str) or not shot_id:
            if strict:
                raise _refuse(f"scene.shots[{index}].id", "must be non-empty text")
            continue
        if strict and shot_id in seen:
            raise _refuse(f"scene.shots[{index}].id", f"'{shot_id}' is used twice; shot ids must be unique")
        seen.add(shot_id)
        prompt = shot.get("prompt")
        if prompt is None:
            shot["prompt"] = ""
        elif strict and not isinstance(prompt, str):
            raise _refuse(f"scene.shots[{index}].prompt", "must be text")
        if "output" in shot:
            shot["output"] = settled_output(shot["output"])
    return out


def normalize_params(definition_id: str, params: dict[str, Any], *, strict: bool = True) -> dict[str, Any]:
    """``params`` with a cinema-scene's ``scene`` normalized (a copy when it
    changes); other nodes' params as they are."""
    if definition_id != CINEMA_SCENE or not isinstance(params, dict) or "scene" not in params:
        return params
    return {**params, "scene": normalize_scene(params["scene"], strict=strict)}
