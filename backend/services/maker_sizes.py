"""The fixed size lists makers take, and the one rule that picks from them.

A Krea copy takes a free width x height (512 to 8192), but some makers take
only a list: Ideogram 3 a list of exact pixel resolutions, Ideogram 2a a list
of aspect ratios, Runway Gen-4 Image a list of output sizes. On the maker
route (execution/maker_routes_ideogram_runway.py) the request gets the
nearest entry, and the person is told when that isn't what they asked for:

- before a run, the Inspector (frontend/src/lib/makerSizes.ts, the same rule)
  and describe_node / ``nebula info`` (:func:`rule_note`);
- after a run, the run's notes (models/events.py ``add_run_note``) say the
  size the maker made, read from the saved image.

The lists live here. scripts/sync-krea-catalog.py copies each into its
node's ``directRoute.snap``, so the frontend reads the same values, and
handlers/ideogram.py and handlers/runway.py validate their own nodes against
them. backend/tests/fixtures/maker_size_cases.json holds cases both sides'
tests check.

Stdlib only, so node_route, the scripts and the CLI can import it.
"""
from __future__ import annotations

import math
from typing import Any, Mapping, NamedTuple

# Ideogram 3.0's resolutions, in the order Ideogram lists them: "resolution
# (enum, required) - The resolutions supported for Ideogram 3.0. Allowed
# values: `512x1536`, ... `1536x640`" (developer.ideogram.ai
# api-reference/generate-v3, read 2026-10-14). The generate request takes
# `resolution` or `aspect_ratio`; Nebula sends only resolution.
IDEOGRAM_V3_RESOLUTIONS: tuple[str, ...] = (
    "512x1536", "576x1408", "576x1472", "576x1536", "640x1344",
    "640x1408", "640x1472", "640x1536", "704x1152", "704x1216",
    "704x1280", "704x1344", "704x1408", "704x1472", "736x1312",
    "768x1088", "768x1216", "768x1280", "768x1344", "800x1280",
    "832x960", "832x1024", "832x1088", "832x1152", "832x1216",
    "832x1248", "864x1152", "896x960", "896x1024", "896x1088",
    "896x1120", "896x1152", "960x832", "960x896", "960x1024",
    "960x1088", "1024x832", "1024x896", "1024x960", "1024x1024",
    "1088x768", "1088x832", "1088x896", "1088x960", "1120x896",
    "1152x704", "1152x832", "1152x864", "1152x896", "1216x704",
    "1216x768", "1216x832", "1248x832", "1280x704", "1280x768",
    "1280x800", "1312x736", "1344x640", "1344x704", "1344x768",
    "1408x576", "1408x640", "1408x704", "1472x576", "1472x640",
    "1472x704", "1536x512", "1536x576", "1536x640",
)
# "The aspect ratio for an Ideogram 3.x or 2.x generation ... Allowed values:
# `auto`, `1x3`, `3x1`, `1x2`, `2x1`, `9x16`, `16x9`, `10x16`, `16x10`, `2x3`,
# `3x2`, `3x4`, `4x3`, `4x5`, `5x4`, `1x1`"
# (https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-2a.md).
# The page gives no pixel size per ratio; the response's `resolution` ("The
# resolution of the generated image") is the only place Ideogram says it.
IDEOGRAM_ASPECT_RATIOS: tuple[str, ...] = (
    "1x1", "1x3", "3x1", "1x2", "2x1", "9x16", "16x9", "10x16", "16x10",
    "2x3", "3x2", "3x4", "4x3", "4x5", "5x4",
)
# gen4_image's `ratio` values are output sizes ("1920:1080", ...), from
# Runway's openapi.json (handlers/runway.py reads them from here).
RUNWAY_GEN4_IMAGE_RATIOS: tuple[str, ...] = (
    "1024:1024", "1080:1080", "1168:880", "1360:768", "1440:1080", "1080:1440", "1808:768", "1920:1080",
    "1080:1920", "2112:912", "1280:720", "720:1280", "720:720", "960:720", "720:960", "1680:720",
)

SIZE = "size"    # the choices are exact pixel sizes
SHAPE = "shape"  # the choices are aspect ratios; the maker picks the pixels

# Per direct translation (execution/maker_routes.py KREA_TRANSLATIONS): who
# makes it, the request field the choice goes in, whether the choices are
# sizes or shapes, how the maker spells them, and the choices.
SNAPS: dict[str, dict[str, Any]] = {
    "krea-ideogram-3": {"maker": "Ideogram", "field": "resolution", "kind": SIZE, "sep": "x",
                        "choices": list(IDEOGRAM_V3_RESOLUTIONS)},
    "krea-ideogram-2a": {"maker": "Ideogram", "field": "aspect_ratio", "kind": SHAPE, "sep": "x",
                         "choices": list(IDEOGRAM_ASPECT_RATIOS)},
    "krea-runway-gen4-image": {"maker": "Runway", "field": "ratio", "kind": SIZE, "sep": ":",
                               "choices": list(RUNWAY_GEN4_IMAGE_RATIOS)},
}
# Two shapes this close in log ratio count as the same shape, so the pixel
# count decides (the same tolerance in makerSizes.ts).
_SAME = 1e-9


def _parts(choice: str, sep: str) -> tuple[int, int]:
    a, b = choice.split(sep)
    return int(a), int(b)


def nearest(width: float, height: float, choices: list[str] | tuple[str, ...], sep: str) -> str:
    """The choice closest in shape to width x height, then closest in pixel
    count; on a full tie, the one listed first. A choice equal to the request
    always wins, and the shape is what keeps a composition intact."""
    target_shape = math.log(width / height)
    target_area = math.log(width * height)
    best: str | None = None
    best_shape = best_area = math.inf
    for choice in choices:
        a, b = _parts(choice, sep)
        shape = abs(math.log(a / b) - target_shape)
        area = abs(math.log(a * b) - target_area)
        if shape < best_shape - _SAME or (abs(shape - best_shape) <= _SAME and area < best_area):
            best, best_shape, best_area = choice, shape, area
    if best is None:
        raise ValueError("no sizes to choose from")
    return best


def _number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def _wxh(width: float, height: float) -> str:
    return f"{_number(width)}x{_number(height)}"


class SizeSnap(NamedTuple):
    """One request's size on a maker route: what was asked, what the maker gets."""

    maker: str
    kind: str              # SIZE or SHAPE
    width: float           # requested
    height: float
    value: str             # the maker's value, in its own spelling ("1312x736", "16x9", "1360:768")
    a: int                 # the value's two numbers (pixels for SIZE, the ratio's terms for SHAPE)
    b: int

    @property
    def exact(self) -> bool:
        """The maker can make what was asked: the same pixels, or for a shape
        list the same shape (the maker picks the pixels either way)."""
        if self.kind == SIZE:
            return self.a == self.width and self.b == self.height
        return self.a * self.height == self.b * self.width

    def note(self) -> str | None:
        """What the Inspector shows before a run, or None when the maker can make it."""
        if self.exact:
            return None
        asked = _wxh(self.width, self.height)
        if self.kind == SIZE:
            return f"{self.maker} makes {self.a}x{self.b}, the closest it can get to your {asked}."
        return (f"{self.maker} makes a {self.a}:{self.b} image at a size it picks, the closest shape it has "
                f"to your {asked}.")

    def made_note(self, made_width: int, made_height: int) -> str | None:
        """The run's note once the image is saved: the size the maker made, or
        None when that is the size asked for."""
        if made_width == self.width and made_height == self.height:
            return None
        asked = _wxh(self.width, self.height)
        if self.kind == SIZE:
            return f"{self.maker} made {made_width}x{made_height}, the closest it could get to your {asked}."
        return (f"{self.maker} made {made_width}x{made_height} (its {self.a}:{self.b} size), the closest it "
                f"could get to your {asked}.")


def snap(spec: Mapping[str, Any], width: float, height: float) -> SizeSnap:
    """The maker's nearest choice (``spec``: a SNAPS entry or a definition's
    ``directRoute.snap``) for a requested width x height."""
    value = nearest(width, height, spec["choices"], spec["sep"])
    a, b = _parts(value, spec["sep"])
    return SizeSnap(str(spec["maker"]), str(spec["kind"]), width, height, value, a, b)


def _effective(definition: Mapping[str, Any], params: Mapping[str, Any], key: str) -> Any:
    value = params.get(key)
    if value is not None and value != "":
        return value
    for group in ("sharedParams", "directParams", "falParams", "params"):
        for param in definition.get(group) or []:
            if isinstance(param, Mapping) and param.get("key") == key:
                return param.get("default")
    return None


def definition_snap(definition: Mapping[str, Any], params: Mapping[str, Any] | None) -> SizeSnap | None:
    """The size a maker-route run of this node would get, or None when the
    node has no size list or its width/height aren't usable numbers (the
    route's own check refuses those). Only meaningful on the maker route:
    the caller checks the route first."""
    spec = (definition.get("directRoute") or {}).get("snap")
    if not isinstance(spec, Mapping):
        return None
    values = params or {}
    sizes = []
    for key in (spec.get("widthParam"), spec.get("heightParam")):
        value = _effective(definition, values, str(key))
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            return None
        sizes.append(float(value))
    return snap(spec, sizes[0], sizes[1])


def rule_note(definition: Mapping[str, Any]) -> str | None:
    """For agents (describe_node, ``nebula info``): how width/height are
    treated on the maker route, or None for a node without a size list."""
    spec = (definition.get("directRoute") or {}).get("snap")
    if not isinstance(spec, Mapping):
        return None
    maker, count = spec.get("maker"), len(spec.get("choices") or [])
    width, height = spec.get("widthParam"), spec.get("heightParam")
    if spec.get("kind") == SHAPE:
        what = f"the nearest of {maker}'s {count} aspect ratios, and {maker} picks the pixel size"
    else:
        what = f"the nearest of the {count} sizes {maker} makes"
    return (f"On the maker route ({maker} key), {width}/{height} round to {what}; the run's notes say the size "
            f"it made. On the Krea copy they are sent as given.")
