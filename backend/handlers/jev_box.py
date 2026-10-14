"""jev-box: TypeSafe Jev finds one thing in an image (experimental).

A Box answer always holds a box, even for something that isn't in the
image, so every request pairs it with a yes/no "is it there?" question. Both
questions share the one image in the state, so it is sent and billed once.

Only a confident "yes" produces a box, crop, mask and annotated image. When
the target is missing or Jev is unsure, the node emits ``found``, a null
``box`` and the report, and never cuts anything from a box that may point at
nothing. Crop, mask and annotated are gate ports (execution/gating.py): they
are withheld then, so a paid node wired to them (an inpaint fed the mask) is
skipped instead of running without its input.

TypeSafe sees a prepared copy (upright, resized or padded to its limits). The
box comes back as fractions of that copy and is mapped back through the
copy's ImageTransform, so ``box``, the crop and the mask all line up with the
original image as a browser shows it. Output formats are the shared Jev
contract in services/jev_outputs.py and docs/api-guides/typesafe.md.
"""
from __future__ import annotations

import asyncio
import base64
import math
import re
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping
from uuid import uuid4

from PIL import Image, ImageDraw, ImageFont, ImageOps

from execution.gating import withheld
from execution.missing_credential import MissingCredentialError
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services import jev_outputs as out
from services.output import OUTPUT_ROOT, get_run_dir
from services.typesafe_client import (
    BOX_MODELS,
    CREDENTIAL,
    check_model,
    load_image_source,
    noul_confidence,
    open_image,
    prepare_images,
    system_one,
)

PRESENCE_ID = "present"
BOX_ID = "where"
MEDIA_PORTS = ("crop", "mask", "annotated")
MAX_PAD = 0.5
BOX_COLOR = "#65e6c4"  # the QC nodes' annotation colour


def _fraction(raw: Any, default: float, name: str, high: float = 1.0) -> float:
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number from 0 to {out.format_number(high)}, got {raw!r}") from None
    if not 0.0 <= value <= high:
        raise ValueError(f"{name} must be from 0 to {out.format_number(high)}, got {value}")
    return value


def _target_text(node: GraphNode, inputs: dict[str, PortValueDict]) -> str:
    entry = inputs.get("target")
    raw: Any = entry.value if entry is not None else None
    if isinstance(raw, list):
        raw = " ".join(str(item) for item in raw if item not in (None, ""))
    text = " ".join(str(raw or "").split()) or " ".join(str(node.params.get("target") or "").split())
    # Backticks mark a path into the state for Jev; keep the target plain text.
    return text.replace("`", "'")


def _image_value(inputs: dict[str, PortValueDict]) -> str:
    entry = inputs.get("image")
    value = entry.value if entry is not None else None
    if isinstance(value, list):
        value = next((item for item in value if item not in (None, "")), None)
    if value in (None, ""):
        raise ValueError("Jev Box needs an image: connect one to Image")
    return str(value)


def build_questions(target: str) -> dict[str, dict[str, Any]]:
    """The presence check and the box, both pointing at `image` in the state."""
    return {
        PRESENCE_ID: {"type": "noul", "instructions": f"Does `image` show {target}?"},
        BOX_ID: {"type": "box", "instructions": f"{target} in `image`"},
    }


def crop_rect(mapped: Mapping[str, Any], pad: float) -> tuple[int, int, int, int]:
    """(left, top, right, bottom) pixels of the box grown by ``pad`` (a
    fraction of the image on each side), clamped to the image, at least 1 px."""
    width, height = int(mapped["image"]["w"]), int(mapped["image"]["h"])
    px = mapped["px"]
    grow_x, grow_y = pad * width, pad * height
    left = max(0, math.floor(px["x"] - grow_x))
    top = max(0, math.floor(px["y"] - grow_y))
    right = min(width, math.ceil(px["x"] + px["w"] + grow_x))
    bottom = min(height, math.ceil(px["y"] + px["h"] + grow_y))
    if right <= left:
        left, right = (left, left + 1) if left < width else (width - 1, width)
    if bottom <= top:
        top, bottom = (top, top + 1) if top < height else (height - 1, height)
    return left, top, right, bottom


def open_original(data: bytes) -> Image.Image:
    """The image as a browser shows it: first frame, EXIF rotation applied.
    The bytes were already size- and format-checked by prepare_images."""
    image = open_image(data)
    if int(getattr(image, "n_frames", 1) or 1) > 1:
        image.seek(0)
    image.load()
    upright = ImageOps.exif_transpose(image) or image
    alpha = upright.mode in ("RGBA", "LA", "PA") or (upright.mode == "P" and "transparency" in upright.info)
    return upright.convert("RGBA" if alpha else "RGB")


def make_mask(size: tuple[int, int], rect: tuple[int, int, int, int]) -> Image.Image:
    """White rectangle on black at the original size (white = the region)."""
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rectangle((rect[0], rect[1], rect[2] - 1, rect[3] - 1), fill=255)
    return mask


def _font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    try:
        return ImageFont.load_default(size=size)
    except (TypeError, OSError):  # Pillow without FreeType: fixed bitmap font
        return ImageFont.load_default()


def annotate(image: Image.Image, mapped: Mapping[str, Any], label: str) -> Image.Image:
    """The original with Jev's box outlined and a small label tag on it."""
    if image.mode == "RGBA":
        # Transparent areas show as white, the way most viewers show them.
        canvas = Image.new("RGB", image.size, (255, 255, 255))
        canvas.paste(image, mask=image.getchannel("A"))
    else:
        canvas = image.convert("RGB")
    draw = ImageDraw.Draw(canvas)
    width, height = canvas.size
    px = mapped["px"]
    line = max(3, round(min(width, height) / 250))
    x0, y0 = px["x"], px["y"]
    x1, y1 = max(x0, px["x"] + px["w"] - 1), max(y0, px["y"] + px["h"] - 1)
    draw.rectangle((x0, y0, x1, y1), outline=BOX_COLOR, width=line)
    font = _font(max(12, round(min(width, height) / 36)))
    left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
    text_w, text_h = right - left, bottom - top
    margin = max(3, line)
    tag_w, tag_h = text_w + 2 * margin, text_h + 2 * margin
    tag_x = min(max(0, x0), max(0, width - tag_w))
    # Above the box when there's room, else just inside its top edge.
    tag_y = y0 - tag_h if y0 - tag_h >= 0 else min(y0, max(0, height - tag_h))
    draw.rectangle((tag_x, tag_y, tag_x + tag_w, tag_y + tag_h), fill=BOX_COLOR)
    draw.text((tag_x + margin - left, tag_y + margin - top), label, fill="#0b0d10", font=font)
    return canvas


def _save(picture: Image.Image, run_dir: Path, node_id: str, port: str) -> str:
    """Save one output PNG the way the QC nodes do (services/qc_common.py
    save_annotated_output), but all three into the same run directory."""
    safe_node = re.sub(r"[^a-zA-Z0-9_-]+", "-", node_id).strip("-") or "node"
    path = run_dir / f"jev-box-{port}-{safe_node}-{uuid4().hex[:8]}.png"
    picture.save(path, format="PNG", optimize=True)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _box_line(mapped: Mapping[str, Any]) -> str:
    px, size = mapped["px"], mapped["image"]
    return f"x {px['x']}, y {px['y']}, {px['w']} x {px['h']} px of {size['w']} x {size['h']}"


def _render(data: bytes, mapped: Mapping[str, Any], rect: tuple[int, int, int, int],
            label: str) -> tuple[Image.Image, Image.Image, Image.Image]:
    original = open_original(data)
    if original.size != (mapped["image"]["w"], mapped["image"]["h"]):
        raise RuntimeError("Jev Box bug: the original image size doesn't match its prepared copy")
    return original.crop(rect), make_mask(original.size, rect), annotate(original, mapped, label)


async def handle_jev_box(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get(CREDENTIAL)
    if not api_key:
        raise MissingCredentialError(f"{CREDENTIAL} is required")

    params = node.params
    target = _target_text(node, inputs)
    if not target:
        raise ValueError("Jev Box needs a target: what to find, e.g. 'the red car'")
    model = check_model(params.get("model") or BOX_MODELS[0])
    if model not in BOX_MODELS:
        raise ValueError(f"Jev Box needs Jev 1.14: pick {' or '.join(BOX_MODELS)}, not {model}")
    presence_threshold = _fraction(params.get("presence_threshold"), 0.5, "presence_threshold")
    min_confidence = _fraction(params.get("min_confidence"), 0.5, "min_confidence")
    pad = _fraction(params.get("pad"), 0.05, "pad", MAX_PAD)

    value = _image_value(inputs)
    # Read once: the same bytes feed the copy TypeSafe sees and the crop.
    data = await load_image_source(value, label="Image")
    image = (await prepare_images([f"data:application/octet-stream;base64,{base64.b64encode(data).decode()}"],
                                  label="Image", max_images=1))[0]

    result = await system_one(api_key, model=model, state={"image": image.placeholder},
                              questions=build_questions(target), images=[image])

    presence = result.answer(PRESENCE_ID, "noul").noul or 0.0
    found = out.verdict(presence >= presence_threshold, noul_confidence(presence), min_confidence)
    fields: list[tuple[str, Any]] = [
        ("Target", target),
        ("Found", found),
        ("Presence", out.format_number(presence)),
    ]
    notes: list[str] = []
    transform = image.transform
    outputs: dict[str, Any] = {"found": out.text(found)}

    if found == "true":
        answer = result.answer(BOX_ID, "box")
        assert answer.box is not None
        mapped = transform.to_original_box(**answer.box)
        rect = crop_rect(mapped, pad)
        confidence = answer.confidence
        label = target if confidence is None else f"{target} {out.format_number(confidence)}"
        crop, mask, annotated = await asyncio.to_thread(_render, data, mapped, rect, label[:80])
        fields += [
            ("Box", _box_line(mapped)),
            ("Box confidence", "unknown" if confidence is None else out.format_number(confidence)),
            ("Crop", f"x {rect[0]}, y {rect[1]}, {rect[2] - rect[0]} x {rect[3] - rect[1]} px "
                     f"(pad {out.format_number(pad)})"),
        ]
        outputs["box"] = out.text(out.box_json(mapped, confidence))
        run_dir = get_run_dir()
        for port, picture in (("crop", crop), ("mask", mask), ("annotated", annotated)):
            url = _save(picture, run_dir, node.id, port)
            outputs[port] = {"type": "Mask" if port == "mask" else "Image", "value": url}
    else:
        outputs["box"] = out.text("null")
        shown = target if len(target) <= 60 else target[:59] + "…"
        if found == "unsure":
            notes.append(f"Presence confidence {out.format_number(noul_confidence(presence))} is below the "
                         f"minimum {out.format_number(min_confidence)}, so found is unsure; no box, crop or mask.")
            reason = f"Jev Box was unsure whether {shown} is there (presence {out.format_number(presence)})"
        else:
            reason = f"Jev Box didn't find {shown} (presence {out.format_number(presence)})"
        for port in MEDIA_PORTS:
            outputs[port] = withheld(reason)

    if found == "true" and (transform.transposed or transform.frames > 1 or transform.padded
                            or transform.resized):
        notes.append(f"Image: {transform.describe()}; the box is mapped back to the original.")

    outputs["report"] = out.text(out.report(
        "Jev Box", fields,
        model=result.model, requested_model=result.requested_model,
        input_tokens=result.input_tokens, images=1,
        request_id=result.request_id, notes=notes,
    ))
    return outputs
