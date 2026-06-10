#!/usr/bin/env python3
"""One-shot live smoke for Ideogram nodes (direct when IDEOGRAM_API_KEY set, else FAL)."""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import sys
from pathlib import Path

# backend/ on path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw

from execution.sync_runner import get_handler_registry
from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from services.settings import load_settings


async def _noop_emit(_event: ExecutionEvent) -> None:
    pass


def _png_data_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _test_canvas(size: int = 512) -> tuple[str, str]:
    """Solid blue canvas + mask with black circle center (Ideogram: black = edit)."""
    base = Image.new("RGB", (size, size), (40, 90, 200))
    draw = ImageDraw.Draw(base)
    draw.rectangle([40, 40, size - 40, size - 40], outline=(255, 255, 255), width=4)
    base_uri = _png_data_uri(base)

    mask = Image.new("L", (size, size), 255)  # white = keep
    md = ImageDraw.Draw(mask)
    r = size // 5
    cx, cy = size // 2, size // 2
    md.ellipse([cx - r, cy - r, cx + r, cy + r], fill=0)  # black = edit
    mask_uri = _png_data_uri(mask.convert("RGB"))
    return base_uri, mask_uri


async def _run_node(definition_id: str, params: dict, inputs: dict, registry: dict, api_keys: dict) -> dict:
    handler = registry.get(definition_id)
    if not handler:
        raise RuntimeError(f"No handler for {definition_id}")
    node = GraphNode(id=f"smoke-{definition_id}", definitionId=definition_id, params=params)
    port_inputs = {k: PortValueDict(type=v["type"], value=v["value"]) for k, v in inputs.items()}
    print(f"\n▶ {definition_id} …", flush=True)
    result = await handler(node, port_inputs, api_keys)
    for port, val in result.items():
        preview = str(val.get("value", ""))[:120]
        print(f"  ✓ {port}: {preview}", flush=True)
    return result


async def _smoke_dual_route_remaining(
    *,
    registry: dict,
    api_keys: dict,
    failures: list[str],
    base_uri: str,
    gen_params: dict,
    has_direct: bool,
) -> None:
    """Remix, reframe, replace-background, upscale, character — not run in the first pass."""
    if has_direct:
        remix_params = {**gen_params, "image_weight": 60}
        reframe_params = {**gen_params, "resolution": "1280x800"}
    else:
        remix_params = {**gen_params, "strength": 0.6}
        reframe_params = {**gen_params, "image_size": "landscape_16_9"}

    try:
        await _run_node(
            "ideogram-remix",
            remix_params,
            {
                "prompt": {"type": "Text", "value": "same composition at night, moody lighting"},
                "image": {"type": "Image", "value": base_uri},
            },
            registry,
            api_keys,
        )
    except Exception as exc:
        failures.append(f"ideogram-remix: {exc}")
        print(f"  ✗ ideogram-remix: {exc}", flush=True)

    try:
        await _run_node(
            "ideogram-reframe",
            reframe_params,
            {"image": {"type": "Image", "value": base_uri}},
            registry,
            api_keys,
        )
    except Exception as exc:
        failures.append(f"ideogram-reframe: {exc}")
        print(f"  ✗ ideogram-reframe: {exc}", flush=True)

    try:
        await _run_node(
            "ideogram-replace-background",
            gen_params,
            {
                "prompt": {"type": "Text", "value": "soft gradient studio backdrop, neutral gray"},
                "image": {"type": "Image", "value": base_uri},
            },
            registry,
            api_keys,
        )
    except Exception as exc:
        failures.append(f"ideogram-replace-background: {exc}")
        print(f"  ✗ ideogram-replace-background: {exc}", flush=True)

    try:
        await _run_node(
            "ideogram-upscale",
            {"resemblance": 60, "detail": 40},
            {
                "image": {"type": "Image", "value": base_uri},
                "prompt": {"type": "Text", "value": "sharper edges, cleaner border"},
            },
            registry,
            api_keys,
        )
    except Exception as exc:
        failures.append(f"ideogram-upscale: {exc}")
        print(f"  ✗ ideogram-upscale: {exc}", flush=True)

    try:
        await _run_node(
            "ideogram-character",
            {**gen_params, "aspect_ratio": "1x1", "style_type": "FICTION"},
            {
                "prompt": {"type": "Text", "value": "the character waving hello"},
                "reference_images": {"type": "Image", "value": [base_uri]},
            },
            registry,
            api_keys,
        )
    except Exception as exc:
        failures.append(f"ideogram-character: {exc}")
        print(f"  ✗ ideogram-character: {exc}", flush=True)


async def main() -> int:
    parser = argparse.ArgumentParser(description="Live-smoke Ideogram nodes against real API keys.")
    parser.add_argument(
        "--remaining-dual-route",
        action="store_true",
        help="Only remix, reframe, replace-background, upscale, and character.",
    )
    args = parser.parse_args()

    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    has_fal = bool(api_keys.get("FAL_KEY"))
    has_direct = bool(api_keys.get("IDEOGRAM_API_KEY"))
    print(f"Keys: FAL_KEY={'yes' if has_fal else 'NO'}  IDEOGRAM_API_KEY={'yes' if has_direct else 'NO'}")

    if not has_fal and not has_direct:
        print("ERROR: need at least FAL_KEY or IDEOGRAM_API_KEY in settings.json")
        return 1

    registry = get_handler_registry(emit=_noop_emit)
    failures: list[str] = []

    route = "direct" if has_direct else "fal"
    gen_params = (
        {"rendering_speed": "TURBO", "magic_prompt": "OFF"}
        if has_direct
        else {"rendering_speed": "TURBO", "expand_prompt": False}
    )
    print(f"Dual-route nodes will use: {route}")

    base_uri, mask_uri = _test_canvas()

    if args.remaining_dual_route:
        print("\n--- Remaining dual-route smokes ---")
        await _smoke_dual_route_remaining(
            registry=registry,
            api_keys=api_keys,
            failures=failures,
            base_uri=base_uri,
            gen_params=gen_params,
            has_direct=has_direct,
        )
        print("\n" + ("=" * 40))
        if failures:
            print(f"FAILED ({len(failures)}):")
            for f in failures:
                print(f"  - {f}")
            return 1
        print("All executed smokes passed.")
        return 0

    # 1. ideogram-v4 (text → image)
    try:
        await _run_node(
            "ideogram-v4",
            gen_params,
            {"prompt": {"type": "Text", "value": "a simple red apple on white background, product photo"}},
            registry,
            api_keys,
        )
    except Exception as exc:
        failures.append(f"ideogram-v4: {exc}")
        print(f"  ✗ ideogram-v4: {exc}", flush=True)

    # 2. ideogram-edit (inpaint center circle → golden)
    try:
        await _run_node(
            "ideogram-edit",
            gen_params,
            {
                "prompt": {"type": "Text", "value": "shiny gold coin"},
                "image": {"type": "Image", "value": base_uri},
                "mask": {"type": "Image", "value": mask_uri},
            },
            registry,
            api_keys,
        )
    except Exception as exc:
        failures.append(f"ideogram-edit: {exc}")
        print(f"  ✗ ideogram-edit: {exc}", flush=True)

    await _smoke_dual_route_remaining(
        registry=registry,
        api_keys=api_keys,
        failures=failures,
        base_uri=base_uri,
        gen_params=gen_params,
        has_direct=has_direct,
    )

    if not has_direct:
        print("\n⊘ direct-only nodes skipped (no IDEOGRAM_API_KEY)")
    else:
        # 3. ideogram-transparent
        try:
            await _run_node(
                "ideogram-transparent",
                {"rendering_speed": "TURBO", "magic_prompt": "OFF", "aspect_ratio": "1x1"},
                {"prompt": {"type": "Text", "value": "simple red apple icon, centered"}},
                registry,
                api_keys,
            )
        except Exception as exc:
            failures.append(f"ideogram-transparent: {exc}")
            print(f"  ✗ ideogram-transparent: {exc}", flush=True)

        # 4. ideogram-remove-background
        try:
            await _run_node(
                "ideogram-remove-background",
                {},
                {"image": {"type": "Image", "value": base_uri}},
                registry,
                api_keys,
            )
        except Exception as exc:
            failures.append(f"ideogram-remove-background: {exc}")
            print(f"  ✗ ideogram-remove-background: {exc}", flush=True)

        # 5. ideogram-edit-prompt (maskless)
        try:
            await _run_node(
                "ideogram-edit-prompt",
                {"rendering_speed": "TURBO"},
                {
                    "prompt": {"type": "Text", "value": "make the background a sunset gradient"},
                    "image": {"type": "Image", "value": base_uri},
                },
                registry,
                api_keys,
            )
        except Exception as exc:
            failures.append(f"ideogram-edit-prompt: {exc}")
            print(f"  ✗ ideogram-edit-prompt: {exc}", flush=True)

        # 6. describe → magic-prompt chain
        try:
            desc = await _run_node(
                "ideogram-describe",
                {},
                {"image": {"type": "Image", "value": base_uri}},
                registry,
                api_keys,
            )
            caption = desc.get("description", {}).get("value")
            if caption:
                await _run_node(
                    "ideogram-magic-prompt",
                    {},
                    {"prompt": {"type": "Text", "value": caption}},
                    registry,
                    api_keys,
                )
            else:
                raise RuntimeError("describe returned no description text")
        except Exception as exc:
            failures.append(f"describe/magic-prompt: {exc}")
            print(f"  ✗ describe/magic-prompt: {exc}", flush=True)

    print("\n" + ("=" * 40))
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("All executed smokes passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
