#!/usr/bin/env python3
"""
Non-human empirical test — generates ref1, ref2, ref3, scene_out via Gemini 3.1 Flash Image.
Run from docs/character-smoke/ or with full paths.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import httpx

SETTINGS_PATH = Path("/Users/justinperea/Documents/Workspace/Projects/nebula_nodes/settings.json")
OUT_DIR = Path("/Users/justinperea/Documents/Workspace/Projects/nebula_nodes/docs/character-smoke")
MODEL = "gemini-3.1-flash-image"
API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"

def get_api_key() -> str:
    settings = json.loads(SETTINGS_PATH.read_text())
    key = settings.get("apiKeys", {}).get("GOOGLE_API_KEY", "")
    if not key:
        raise RuntimeError("GOOGLE_API_KEY not found in settings.json")
    return key

def image_to_inline_data(path: Path) -> dict:
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    suffix = path.suffix.lstrip(".").lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(suffix, "image/jpeg")
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

    # Step 1: Base subject
    print("\n[1/4] Generating ref1 (text-to-image, base subject)...")
    ref1 = generate(
        "A small bioluminescent moss-covered stone golem creature with three glowing amber eyes, "
        "a cracked geode chest that glows teal, stubby rounded limbs, full body, centered, "
        "neutral light-grey studio background, soft even lighting, high detail.",
        None,
        "ref1",
        api_key,
    )

    # Step 2: 3/4 side profile view
    print("\n[2/4] Generating ref2 (3/4 profile, ref1 as reference)...")
    ref2 = generate(
        "The SAME moss-covered stone golem creature from the reference image. "
        "Keep EXACT same features: same number of glowing amber eyes, same teal geode chest crystal, "
        "same mossy stone texture, same stubby rounded limbs. "
        "Show the creature from a 3/4 side profile view, full body, neutral grey background, soft even lighting.",
        [ref1],
        "ref2",
        api_key,
    )

    # Step 3: Low front angle view
    print("\n[3/4] Generating ref3 (low front angle, ref1 as reference)...")
    ref3 = generate(
        "The SAME moss-covered stone golem creature from the reference image. "
        "Keep EXACT same features: same number of glowing amber eyes, same teal geode chest crystal, "
        "same mossy stone texture, same stubby rounded limbs. "
        "Show the creature from a low front angle (camera slightly below eye level looking up), "
        "full body, neutral grey background, soft even lighting.",
        [ref1],
        "ref3",
        api_key,
    )

    # Step 4: Identity test — multi-ref scene
    print("\n[4/5] Generating scene_out (multi-ref identity test, 3 refs, new scene)...")
    scene_out = generate(
        "The same bioluminescent moss-stone golem creature shown in ALL the reference images "
        "sitting on a mossy fallen log beside a misty forest stream at dawn, "
        "cinematic wide shot, volumetric light. "
        "Preserve ALL identity features: exact same amber eyes, teal geode chest, mossy stone body.",
        [ref1, ref2, ref3],
        "scene_out",
        api_key,
    )

    # Step 5: Second scene (bonus)
    print("\n[5/5] Generating scene_out2 (bonus: second new scene)...")
    scene_out2 = generate(
        "The same bioluminescent moss-stone golem creature from ALL the reference images "
        "curled up asleep inside a hollow tree, soft firefly light. "
        "Preserve ALL identity features: exact same amber eyes, teal geode chest, mossy stone body.",
        [ref1, ref2, ref3],
        "scene_out2",
        api_key,
    )

    print("\nAll generations complete.")
    print(f"  ref1:       {ref1}")
    print(f"  ref2:       {ref2}")
    print(f"  ref3:       {ref3}")
    print(f"  scene_out:  {scene_out}")
    print(f"  scene_out2: {scene_out2}")


if __name__ == "__main__":
    main()
