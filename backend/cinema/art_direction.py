"""Pure translation of Cinema's typed art-direction inputs into real requests.

Camera values are prompt guidance, not native camera controls. Reference
priorities determine ordering and inclusion, not model adherence weights.
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence


REFERENCE_ROLES = (
    "style", "identity", "composition", "pose", "lighting", "subject", "background",
)

_CAMERA_FIELDS = (
    ("height", "camera height", "m"),
    ("pitch", "pitch", "deg"),
    ("yaw", "yaw around subject", "deg"),
    ("roll", "roll", "deg"),
    ("focalLength", "focal length", "mm"),
    ("subjectDistance", "subject distance", "m"),
    ("focusDistance", "focus distance", "m"),
    ("subjectScreenX", "subject horizontal position (0 left, 1 right)", ""),
    ("subjectScreenY", "subject vertical position (0 top, 1 bottom)", ""),
)


def validate_base_input_params(params: Mapping[str, Any]) -> None:
    """Cinema owns these request inputs; model params must not replace them.

    FAL's universal request builder applies params after resolved ports. Reject
    conflicting saved fields rather than replacing the prompt/refs after their
    guidance, role indexes and limits have been checked.
    """
    reserved = sorted({"prompt", "image_url", "image_urls"}.intersection(params))
    if reserved:
        raise ValueError(
            "Cinema base.params cannot override Cinema inputs: "
            + ", ".join(reserved)
            + ". Use scene/shot prompts and connected reference inputs instead."
        )


def parse_reference_priority(raw: Any) -> float:
    """Keep legacy ``weight`` keys, treating malformed values as priority 1."""
    if raw is None or raw == "" or isinstance(raw, bool):
        return 1.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(value):
        return 1.0
    return max(0.0, min(1.0, value))


def camera_prompt_guidance(bundle: Any) -> str:
    """Describe provided finite camera values without modifying identity text."""
    if bundle is None or bundle == {}:
        return ""
    if not isinstance(bundle, Mapping):
        raise ValueError("Cinema Camera Rig input must be a camera value bundle")
    directions = []
    for key, label, unit in _CAMERA_FIELDS:
        if key not in bundle:
            continue
        value = bundle[key]
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            raise ValueError(f"Cinema Camera Rig {key} must be a finite number")
        directions.append(f"{label}: {value:g}{' ' + unit if unit else ''}")
    if not directions:
        return ""
    return "Camera prompt guidance: " + "; ".join(directions) + "."


def reference_items(bundle: Any) -> list[dict[str, Any]]:
    """Normalize legacy ReferenceSet items, excluding priority zero stably."""
    if bundle is None or bundle == {}:
        return []
    if not isinstance(bundle, Mapping) or not isinstance(bundle.get("items", []), list):
        raise ValueError("Cinema Reference Set input must contain an items list")
    items = []
    for item in bundle.get("items", []):
        if not isinstance(item, Mapping):
            raise ValueError("Cinema Reference Set items must be reference objects")
        priority = parse_reference_priority(item.get("weight"))
        if priority == 0:
            continue
        url = item.get("url")
        if not url:
            continue
        if not isinstance(url, str):
            raise ValueError("Cinema Reference Set image URLs must be strings")
        role = item.get("role")
        if role not in REFERENCE_ROLES:
            raise ValueError(f"Cinema Reference Set has an unsupported reference role: {role!r}")
        items.append({"url": url, "role": role, "weight": priority})
    items.sort(key=lambda item: item["weight"], reverse=True)
    return items


def append_reference_guidance(
    prompt: str,
    existing_urls: Sequence[str],
    items: Sequence[Mapping[str, Any]],
) -> tuple[str, list[str]]:
    """Append refs after Character/shot refs and label their actual image indexes.

    Empty bundles are byte-for-byte no-ops. With active role refs, duplicate
    URLs are delivered once; a URL may retain several role labels.
    """
    if not items:
        return prompt, list(existing_urls)
    image_urls = list(dict.fromkeys(existing_urls))
    indexes = {url: index + 1 for index, url in enumerate(image_urls)}
    roles_by_index: dict[int, list[str]] = {}
    for item in items:
        url, role = item["url"], item["role"]
        if url not in indexes:
            image_urls.append(url)
            indexes[url] = len(image_urls)
        roles = roles_by_index.setdefault(indexes[url], [])
        if role not in roles:
            roles.append(role)
    legend = "; ".join(
        f"image {index}: {', '.join(roles)}" for index, roles in roles_by_index.items()
    )
    guidance = "Reference image guidance (image numbers follow the supplied order): " + legend + "."
    return (prompt + "\n\n" + guidance if prompt else guidance), image_urls


def reference_cap_for(base_model: str, params: Mapping[str, Any]) -> int:
    """Caps for the actual supported adapters/selectors, verified in vendor docs.

    Flux's adapter accepts one image. Google's original 2.5 image model is
    conservatively limited to three; Nano Banana 2 and Pro accept up to 14.
    Seedream reference requests use its edit adapter, which accepts 10.
    Unknown selectors are rejected rather than sent with a fabricated cap.
    """
    if "model" in params:
        selector = params["model"]
        if not isinstance(selector, str) or not selector:
            raise ValueError(
                "Cinema base model selector must be a nonempty string when supplied; "
                "omit the model parameter to use the adapter default."
            )
    else:
        selector = ""
    if base_model == "seedream-4-5":
        if selector in ("", "4.5", "5.0-lite"):
            return 10
    elif base_model == "flux-kontext":
        if selector.lower() in ("", "base", "max"):
            return 1
    elif base_model == "nano-banana":
        if selector in ("", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image"):
            return 14
        if selector == "gemini-2.5-flash-image":
            return 3
    elif base_model == "nano-banana-fal-edit":
        if selector in ("", "nano-banana-2", "nano-banana-pro", "gemini-3-pro-image"):
            return 14
        if selector in ("nano-banana", "gemini-25-flash-image"):
            return 3
    raise ValueError(
        f"Cinema reference support is not verified for base '{base_model}' "
        f"with model selector '{selector}'. Choose a supported Cinema base/model."
    )


def check_reference_cap(base_model: str, image_urls: Sequence[str], cap: int) -> None:
    if len(image_urls) > cap:
        raise ValueError(
            f"Cinema adapter for '{base_model}' allows at most {cap} reference image(s), "
            f"but this shot supplies {len(image_urls)}. Reduce references or choose "
            "a supported base with a higher reference cap. No references were submitted."
        )
