"""Soul Cinema deterministic-pillar smoke generator.

Runs the two deterministic pillars (Soul HEX color transfer + film-look post)
DIRECTLY against the backend ``cinema`` package — no server, no API calls — on
one real generated still, and writes eyeball-able PNG proofs into this folder.

Run with the backend venv from the backend dir so ``cinema`` is importable:

    cd backend && .venv/bin/python ../docs/soul-cinema-smoke/_generate_smoke.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from PIL import Image

# Ensure the backend package root (where `cinema/` lives) is importable.
_BACKEND = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(_BACKEND))

from cinema.color import extract_palette, transfer_to_palette  # noqa: E402
from cinema.look import PRESETS, apply_look  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent
SRC = (
    Path(__file__).resolve().parents[2]
    / "output"
    / "chat-uploads"
    / "06cdd0273182405a910adf3c74bf2a22acd49ae4158dd15ec9f82b67ec7a70b1.png"
)

# Three target palettes for color transfer.
PALETTES: dict[str, list[str]] = {
    # Warm teal-orange cinematic blockbuster grade.
    "warm-teal-orange": ["#0b3d3a", "#1f6f6b", "#e8a15c", "#f4c98a", "#3a2a1a", "#f7e8c8"],
    # Cool moonlit / night grade.
    "cool-blue": ["#0a1a2f", "#1d3a5f", "#3f6aa0", "#7fa8d0", "#cde0f0", "#101820"],
    # Muted autumn / dusty rose grade.
    "muted-autumn": ["#3a2218", "#7a4a2c", "#b07b4e", "#d8b48a", "#5a5036", "#e8dcc0"],
}


def _save(img: Image.Image, name: str) -> str:
    path = OUT_DIR / name
    img.convert("RGB").save(path, format="PNG")
    return path.name


def main() -> None:
    assert SRC.exists(), f"source image missing: {SRC}"
    src = Image.open(SRC).convert("RGB")
    print(f"source: {SRC.name}  mode=RGB  size={src.size}")

    # Source palette (proves extract_palette runs on a real image).
    src_palette = extract_palette(src, k=6)
    print(f"extracted source palette (k=6): {src_palette}")

    written: list[str] = []

    # 0. Original, re-saved as PNG so the index can embed it.
    written.append(_save(src, "00_original.png"))

    # 1. Color transfer toward each target palette (lab-transfer, strength 0.7).
    for key, swatches in PALETTES.items():
        out = transfer_to_palette(src, swatches, strength=0.7, method="lab-transfer")
        written.append(_save(out, f"10_color_{key}.png"))
        print(f"color transfer -> {key}: ok ({swatches})")

    # 2. Each film-look preset.
    for preset in PRESETS:
        out = apply_look(src, {"preset": preset})
        safe = preset.replace("/", "-")
        written.append(_save(out, f"20_look_{safe}.png"))
        print(f"film-look preset -> {preset}: ok")

    # 3. Full pipeline: palette transfer THEN film-look (warm grade + cinestill).
    graded = transfer_to_palette(
        src, PALETTES["warm-teal-orange"], strength=0.6, method="lab-transfer"
    )
    full = apply_look(graded, {"preset": "cinestill-800t"})
    written.append(_save(full, "30_full_pipeline_warm-teal-orange_cinestill-800t.png"))
    print("full pipeline (warm-teal-orange palette + cinestill-800t look): ok")

    # Second full-pipeline variant: cool palette + kodak-portra.
    graded2 = transfer_to_palette(
        src, PALETTES["cool-blue"], strength=0.6, method="lab-transfer"
    )
    full2 = apply_look(graded2, {"preset": "kodak-portra"})
    written.append(_save(full2, "31_full_pipeline_cool-blue_kodak-portra.png"))
    print("full pipeline (cool-blue palette + kodak-portra look): ok")

    print(f"\nwrote {len(written)} PNGs to {OUT_DIR}:")
    for name in written:
        print(f"  - {name}")


if __name__ == "__main__":
    main()
