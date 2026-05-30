#!/usr/bin/env python3
"""
Human empirical test — Pheme identity run.
Feeds 3 real reference images (front, three-quarter, waist-up) + frozenTraitString
into Gemini 3.1 Flash Image (nano-banana-2) for 2 new-scene generations.

Run from docs/character-smoke/ or with full paths.
Seed is N/A — the identity comes from the reference images, not a seed param
(Gemini's generateContent API has no seed parameter for image generation).
"""
from __future__ import annotations

import base64
import json
import shutil
import sys
from pathlib import Path

import httpx

SETTINGS_PATH = Path("/Users/justinperea/Documents/Workspace/Projects/nebula_nodes/settings.json")
OUT_DIR = Path("/Users/justinperea/Documents/Workspace/Projects/nebula_nodes/docs/character-smoke")
MODEL = "gemini-3.1-flash-image-preview"
API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"

# Pheme's real reference images (from her character build directory)
PHEME_REF_FRONT = Path("/Users/justinperea/Documents/Workspace/Agents/system/pheme/build/character/pheme/refs/front.png")
PHEME_REF_3Q = Path("/Users/justinperea/Documents/Workspace/Agents/system/pheme/build/character/pheme/refs/three-quarter.png")
PHEME_REF_WAIST = Path("/Users/justinperea/Documents/Workspace/Agents/system/pheme/build/character/pheme/reference-packs/v1.7/gpt-image-2-candidates/waist_up_standing_front_blank_room__candidate-01.png")

# Verbatim frozenTraitString from Pheme's manifest — must not be paraphrased
FROZEN_TRAIT_STRING = (
    "A young woman around 24 years old (early-mid 20s — distinctly NOT late 20s, NOT 30s) "
    "with dark blonde hair (warm honey undertones). Fair complexion with light freckles across "
    "the bridge of the nose and upper cheeks, cool-neutral undertone — distinctly NOT tan, NOT "
    "olive, NOT medium skin tone, NOT warm golden undertones. Youthful dewy skin, soft cheek "
    "line, bright clear eyes — distinctly recent-college-grad young, not yet defined into the "
    "firmer face of late 20s. Natural-looking with sharp focused expression and a soft, slightly "
    "knowing half-smile. Medium-length hair pulled back loosely with strands loose at the front. "
    "A single pink peekaboo strand on the front-left of her hairline falls loose across her cheek "
    "(saturated bubblegum-rose, dyed in the hair fiber, NOT pastel/neon). Subtle natural makeup, "
    "realistic skin texture. A small fine-line bird-in-flight tattoo just below her right "
    "collarbone — soft black ink, delicate wing detail, partially visible above the wide neckline "
    "of her shirt."
)


def get_api_key() -> str:
    settings = json.loads(SETTINGS_PATH.read_text())
    key = settings.get("apiKeys", {}).get("GOOGLE_API_KEY", "")
    if not key:
        raise RuntimeError("GOOGLE_API_KEY not found in settings.json")
    return key


def image_to_inline_data(path: Path) -> dict:
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    suffix = path.suffix.lstrip(".").lower()
    mime = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
    }.get(suffix, "image/jpeg")
    return {"inlineData": {"mimeType": mime, "data": data}}


def generate(prompt: str, ref_images: list[Path] | None, out_name: str, api_key: str) -> Path:
    parts: list[dict] = [{"text": prompt}]
    if ref_images:
        for img_path in ref_images:
            parts.append(image_to_inline_data(img_path))

    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseModalities": ["IMAGE", "TEXT"],
            "imageConfig": {"aspectRatio": "1:1", "imageSize": "1K"},
        },
    }

    print(f"  Calling Gemini for {out_name}...")
    with httpx.Client(timeout=180.0) as client:
        resp = client.post(API_URL, json=body, headers={"x-goog-api-key": api_key})
        if resp.status_code != 200:
            raise RuntimeError(f"Gemini error {resp.status_code}: {resp.text}")

    data = resp.json()
    parts_out = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])

    for part in parts_out:
        if "inlineData" in part:
            b64 = part["inlineData"]["data"]
            mime = part["inlineData"].get("mimeType", "image/jpeg")
            ext = "png" if "png" in mime else "jpg"
            out_path = OUT_DIR / f"{out_name}.{ext}"
            out_path.write_bytes(base64.b64decode(b64))
            print(f"  Saved {out_path}")
            return out_path
        elif "text" in part:
            print(f"  Text response: {part['text'][:200]}")

    raise RuntimeError(f"No image returned for {out_name}: {data}")


def main() -> None:
    api_key = get_api_key()
    print(f"API key loaded (prefix: {api_key[:8]}...)")

    # Copy reference images into docs/character-smoke/ for the record
    print("\nCopying reference images into docs/character-smoke/...")
    shutil.copy2(PHEME_REF_FRONT, OUT_DIR / "pheme_ref_front.png")
    shutil.copy2(PHEME_REF_3Q, OUT_DIR / "pheme_ref_3q.png")
    shutil.copy2(PHEME_REF_WAIST, OUT_DIR / "pheme_ref_waist.png")
    print("  pheme_ref_front.png  ✓")
    print("  pheme_ref_3q.png     ✓")
    print("  pheme_ref_waist.png  ✓")

    ref_images = [
        OUT_DIR / "pheme_ref_front.png",
        OUT_DIR / "pheme_ref_3q.png",
        OUT_DIR / "pheme_ref_waist.png",
    ]

    # Scene 1: café, golden-hour, three-quarter angle
    scene1_prompt = (
        FROZEN_TRAIT_STRING
        + ". sitting outdoors at a sunny café table reviewing a tablet, "
        "candid three-quarter angle, warm golden-hour light, shallow depth of field. "
        "Preserve ALL identity features exactly — face, dark blonde hair with the pink "
        "front-left strand, freckles, the gold laurel choker, the gold laurel earring on "
        "her right ear, and the fine-line bird-in-flight tattoo below her right collarbone."
    )

    print("\n[1/2] Generating pheme_scene1 (café, golden-hour)...")
    scene1 = generate(scene1_prompt, ref_images, "pheme_scene1", api_key)

    # Scene 2: city rooftop at dusk, looking back over shoulder
    scene2_prompt = (
        FROZEN_TRAIT_STRING
        + ". standing on a city rooftop at dusk, looking back over her shoulder toward "
        "camera, cinematic wide shot. Preserve ALL identity features exactly — face, dark "
        "blonde hair with the pink front-left strand, freckles, gold laurel choker, gold "
        "laurel earring (right ear), and the bird-in-flight tattoo below her right collarbone."
    )

    print("\n[2/2] Generating pheme_scene2 (rooftop, dusk)...")
    scene2 = generate(scene2_prompt, ref_images, "pheme_scene2", api_key)

    print("\nAll generations complete.")
    print(f"  pheme_scene1:  {scene1}")
    print(f"  pheme_scene2:  {scene2}")


if __name__ == "__main__":
    main()
