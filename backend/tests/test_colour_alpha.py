"""Colour is measured from the pixels you see: alpha counts.

Before: every colour measurement flattened alpha away (``convert("RGB")``),
so a transparent background read as the colour hidden under it, usually
black. A logo mark 74% transparent gave "near-black 97%"; a board of
transparent sprites read as mostly black. Now cinema.color.visible_pixels is
the one way in: pixels under ALPHA_MIN don't count, partly transparent ones
count by their alpha, and an image with no transparency measures exactly as
before (the opaque golden below is measure-1's output).

The images are synthetic; no brand asset is used.
"""
from __future__ import annotations

import io
import json
from uuid import uuid4

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

from cinema.color import ALPHA_MIN, extract_palette, has_transparency, visible_pixels
from commons import intake, media
from commons.colour import delta_e00, hex_to_lab
from commons.measure import CODE_VERSION, measure_image
from services.moodboard_analysis import (
    ALPHA_OUTDATED,
    analysis_is_current,
    analyze_moodboard,
    dry_run,
    predates_alpha,
    with_alpha_outdated,
)
from services.output import OUTPUT_ROOT

CHARCOAL = (0x11, 0x14, 0x13)
ORANGE = (0xE8, 0x59, 0x3C)
GREEN = (60, 170, 90)


# -- synthetic images ----------------------------------------------------------------------

def mark_74() -> Image.Image:
    """182×182, about 74% transparent; the opaque 26% is 90% charcoal, 10% orange.
    Black under the transparent pixels, as the reported mark has."""
    pixels = np.zeros((182 * 182, 4), np.uint8)
    order = np.random.default_rng(3).permutation(182 * 182)[: int(182 * 182 * 0.26)]
    orange = len(order) // 10
    pixels[order[:orange]] = (*ORANGE, 255)
    pixels[order[orange:]] = (*CHARCOAL, 255)
    return Image.fromarray(pixels.reshape(182, 182, 4), "RGBA")


def sprite_49() -> Image.Image:
    """A 64×64 sprite at about 49% alpha: green on the left half, a 2 px half-alpha seam."""
    pixels = np.zeros((64, 64, 4), np.uint8)
    pixels[:, :31] = (*GREEN, 255)
    pixels[:, 31:33] = (*GREEN, 128)
    return Image.fromarray(pixels, "RGBA")


def soft_disc() -> Image.Image:
    """An antialiased orange disc, straight alpha as PNG stores it: the soft
    edge is only in alpha, and fully transparent pixels hold black."""
    big = Image.new("L", (512, 512), 0)
    ImageDraw.Draw(big).ellipse((96, 96, 416, 416), fill=255)
    mask = big.filter(ImageFilter.GaussianBlur(12)).resize((128, 128), Image.Resampling.LANCZOS)
    disc = Image.new("RGBA", (128, 128), (*ORANGE, 255))
    disc.putalpha(mask)
    pixels = np.asarray(disc).copy()
    pixels[pixels[..., 3] == 0, :3] = 0
    return Image.fromarray(pixels, "RGBA")


def clear() -> Image.Image:
    return Image.new("RGBA", (64, 64), (0, 0, 0, 0))


def opaque() -> Image.Image:
    pixels = np.zeros((300, 400, 3), np.uint8)
    pixels[..., 0] = np.linspace(20, 230, 400)[None]
    pixels[..., 1] = np.linspace(40, 200, 300)[:, None]
    pixels[..., 2] = 90
    return Image.fromarray(pixels, "RGB")


def palette_with_transparency() -> Image.Image:
    """P mode with a transparency index: 0 clear, 1 blue (half), 2 white (an eighth)."""
    image = Image.new("P", (64, 64), 0)
    image.putpalette([0, 0, 0, 30, 80, 200, 250, 250, 250] + [0] * (253 * 3))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 31, 63), fill=1)
    draw.rectangle((32, 0, 39, 63), fill=2)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", transparency=0)
    return Image.open(io.BytesIO(buffer.getvalue()))


def grey_alpha() -> Image.Image:
    """LA: a light grey square on a transparent field."""
    pixels = np.zeros((64, 64, 2), np.uint8)
    pixels[16:48, 16:48] = (200, 255)
    return Image.fromarray(pixels, "LA")


def _close(hex_value: str, rgb: tuple[int, int, int], tolerance: float = 3.0) -> bool:
    target = hex_to_lab("#{:02x}{:02x}{:02x}".format(*rgb))
    return float(delta_e00(hex_to_lab(hex_value), target)) < tolerance


def _dark(hex_value: str) -> bool:
    return hex_to_lab(hex_value)[0] < 8


# What measure-1 gave for opaque() on 1944d052: an image with no
# transparency must still give exactly this.
OPAQUE_GOLDEN = {
    "aspect": 1.3333,
    "palette": [
        {"hex": "#54b35a", "index": 0, "is_accent": False, "share": 0.1571},
        {"hex": "#bb455a", "index": 1, "is_accent": False, "share": 0.1556},
        {"hex": "#50885a", "index": 2, "is_accent": False, "share": 0.1361},
        {"hex": "#b3ac5a", "index": 3, "is_accent": False, "share": 0.1357},
        {"hex": "#563b5a", "index": 4, "is_accent": False, "share": 0.1207},
        {"hex": "#3e5c5a", "index": 5, "is_accent": False, "share": 0.0993},
        {"hex": "#8a6c5a", "index": 6, "is_accent": False, "share": 0.099},
        {"hex": "#ca815a", "index": 7, "is_accent": False, "share": 0.0965},
        {"hex": "#ccae5a", "index": 8, "is_accent": True, "share": 0.0321},
        {"hex": "#d6635a", "index": 9, "is_accent": True, "share": 0.0225},
        {"hex": "#8f2e5a", "index": 10, "is_accent": True, "share": 0.0156},
    ],
    "value_range": {"high": 75.7, "low": 23.1},
}
OPAQUE_EXTRACT_GOLDEN = ["#583c5a", "#57615a", "#bc525a", "#50875a", "#ba9c5a", "#5eb35a"]


# -- the shared helper ---------------------------------------------------------------------

def test_visible_pixels_leave_out_transparency_and_weigh_by_alpha() -> None:
    rgb, weights = visible_pixels(sprite_49())
    assert len(rgb) == 64 * 33  # the clear half is gone
    assert set(np.round(weights, 3)) == {1.0, round(128 / 255, 3)}
    assert (rgb == GREEN).all()  # straight colour, never flattened

    faint = np.zeros((4, 4, 4), np.uint8)
    faint[..., :3] = ORANGE
    faint[0, 0, 3] = ALPHA_MIN - 1
    faint[0, 1, 3] = ALPHA_MIN
    rgb, weights = visible_pixels(Image.fromarray(faint, "RGBA"))
    assert len(rgb) == 1 and weights[0] == pytest.approx(ALPHA_MIN / 255)


def test_an_opaque_image_reads_as_before_with_no_weights() -> None:
    for image in (opaque(), opaque().convert("RGBA"), opaque().convert("P"), opaque().convert("L")):
        rgb, weights = visible_pixels(image)
        assert weights is None
        assert not has_transparency(image)
        old = image.convert("RGB").resize((256, 192), Image.Resampling.NEAREST)
        assert np.array_equal(rgb, np.asarray(old).reshape(-1, 3))


def test_has_transparency_reads_every_kind() -> None:
    assert has_transparency(mark_74())
    assert has_transparency(palette_with_transparency())
    assert has_transparency(grey_alpha())
    assert not has_transparency(opaque().convert("RGBA"))  # an alpha channel that is all 255


# -- Commons' measurement (moodboards measure through it) ----------------------------------

def test_a_mostly_transparent_mark_measures_its_two_colours_90_10() -> None:
    palette = measure_image(mark_74())["palette"]
    assert [(p["hex"], p["share"]) for p in palette] == [("#111413", 0.9), ("#e8593c", 0.1)]
    assert CODE_VERSION == "measure-2"


def test_a_half_transparent_sprite_is_all_its_colour() -> None:
    palette = measure_image(sprite_49())["palette"]
    assert len(palette) == 1 and _close(palette[0]["hex"], GREEN) and palette[0]["share"] == 1.0


def test_a_soft_edged_logo_has_no_dark_fringe() -> None:
    palette = measure_image(soft_disc())["palette"]
    assert not any(_dark(p["hex"]) for p in palette)
    assert _close(palette[0]["hex"], ORANGE) and palette[0]["share"] == 1.0


def test_partly_transparent_pixels_count_by_their_alpha() -> None:
    # Half the pixels orange and opaque, half green at alpha 64: green covers
    # a quarter as much, so it is 64 / (255 + 64) of what's seen, not half.
    pixels = np.zeros((40, 40, 4), np.uint8)
    pixels[:20] = (*ORANGE, 255)
    pixels[20:] = (*GREEN, 64)
    palette = measure_image(Image.fromarray(pixels, "RGBA"))["palette"]
    shares = {("orange" if _close(p["hex"], ORANGE) else "green"): p["share"] for p in palette}
    assert shares == {"orange": round(255 / 319, 4), "green": round(64 / 319, 4)}


def test_a_colours_centre_is_weighed_by_alpha() -> None:
    # One cluster over red (opaque) and blue (alpha 64): its centre sits a
    # quarter of the way to blue, in Lab, as the weights say.
    from cinema.color import lab_to_rgb, rgb_to_lab

    pixels = np.zeros((40, 40, 4), np.uint8)
    pixels[:20] = (200, 30, 30, 255)
    pixels[20:] = (30, 30, 200, 64)
    labs = rgb_to_lab(np.array([[200, 30, 30], [30, 30, 200]], dtype=np.float64))
    centre = (labs[0] * 255 + labs[1] * 64) / (255 + 64)
    expected = "#{:02x}{:02x}{:02x}".format(*np.clip(np.rint(lab_to_rgb(centre)), 0, 255).astype(int))
    assert extract_palette(Image.fromarray(pixels, "RGBA"), k=1) == [expected]


def test_the_value_range_reads_what_is_seen() -> None:
    # A fifth of the pixels black at the faintest alpha that counts, the rest
    # white: the black is 1.5% of what's seen, under the 2nd percentile.
    pixels = np.full((50, 50, 4), 255, np.uint8)
    pixels[:10] = (0, 0, 0, ALPHA_MIN)
    assert measure_image(Image.fromarray(pixels, "RGBA"))["value_range"] == {"low": 100.0, "high": 100.0}


def test_a_fully_transparent_image_has_no_palette() -> None:
    measured = measure_image(clear())
    assert measured["palette"] == [] and measured["value_range"] is None


def test_an_opaque_image_measures_byte_for_byte_as_measure_1() -> None:
    for image in (opaque(), opaque().convert("RGBA")):
        measured = measure_image(image)
        measured.pop("code_version")
        assert json.dumps(measured, sort_keys=True) == json.dumps(OPAQUE_GOLDEN, sort_keys=True)


def test_a_palette_png_with_a_transparency_index() -> None:
    palette = measure_image(palette_with_transparency())["palette"]
    assert [(p["hex"], p["share"]) for p in palette] == [("#1e50c8", 0.8), ("#fafafa", 0.2)]


def test_grey_with_alpha() -> None:
    palette = measure_image(grey_alpha())["palette"]
    assert [(p["hex"], p["share"]) for p in palette] == [("#c8c8c8", 1.0)]


def test_commons_intake_measures_with_alpha_and_hashes_as_before() -> None:
    buffer = io.BytesIO()
    mark_74().save(buffer, format="PNG")
    data = buffer.getvalue()
    columns = intake._image_columns(data, media.sniff(data))
    assert [p["hex"] for p in columns["measurements"]["palette"]] == ["#111413", "#e8593c"]
    assert columns["code_version"] == "measure-2"
    from commons.measure import phash
    assert columns["phash"] == phash(media.load_image(data, "image/png"))  # the RGB image's hash
    assert media.load_image(data, "image/png").mode == "RGB"  # the default stays RGB


# -- Cinema's palette from a source image --------------------------------------------------

def test_extract_palette_ignores_transparency() -> None:
    assert all(_close(h, CHARCOAL) or _close(h, ORANGE) for h in extract_palette(mark_74()))
    assert all(_close(h, ORANGE) for h in extract_palette(soft_disc()))
    assert all(_close(h, GREEN) for h in extract_palette(sprite_49()))
    assert extract_palette(clear()) == []
    assert extract_palette(opaque()) == OPAQUE_EXTRACT_GOLDEN
    assert extract_palette(opaque().convert("RGBA")) == OPAQUE_EXTRACT_GOLDEN


def _write(image: Image.Image, folder: str = "alpha-tests") -> str:
    path = OUTPUT_ROOT / folder / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


@pytest.mark.asyncio
async def test_cinema_color_matches_a_transparent_sources_visible_colours(monkeypatch) -> None:
    import handlers.cinema_color as cinema_color
    from models.graph import GraphNode, PortValueDict

    seen: list[list[str]] = []
    real = cinema_color.transfer_to_palette
    monkeypatch.setattr(cinema_color, "transfer_to_palette",
                        lambda img, swatches, **kw: (seen.append(list(swatches)), real(img, swatches, **kw))[1])
    node = GraphNode(id="c1", definitionId="cinema-color", params={"source_image": _write(sprite_49())})
    inputs = {"image": PortValueDict(type="Image", value=_write(opaque()))}
    await cinema_color.handle_cinema_color(node, inputs, api_keys={}, emit=None)
    assert seen and all(_close(h, GREEN) for h in seen[0])


@pytest.mark.asyncio
async def test_cinema_color_says_a_clear_source_has_no_palette() -> None:
    from execution.person_line import person_line
    from handlers.cinema_color import handle_cinema_color
    from models.graph import GraphNode, PortValueDict

    node = GraphNode(id="c1", definitionId="cinema-color", params={"source_image": _write(clear())})
    inputs = {"image": PortValueDict(type="Image", value=_write(opaque()))}
    with pytest.raises(ValueError, match="fully transparent") as caught:
        await handle_cinema_color(node, inputs, api_keys={}, emit=None)
    assert person_line(caught.value) == (
        "The image in “Palette Source” is fully transparent, so it has no colors to match. Choose another "
        "image, or add hex swatches to “Palette”.")


# -- the moodboard analysis ----------------------------------------------------------------

def _board(*urls: str) -> dict:
    return {"id": "mb_alpha", "name": "Alpha", "mode": "look", "strength": 0.7, "notes": "",
            "images": [{"id": f"i{n}", "url": url, "weight": 1.0, "notes": "", "excluded": False}
                       for n, url in enumerate(urls)]}


def test_a_board_of_a_transparent_mark_reads_charcoal_and_orange() -> None:
    analysis = analyze_moodboard(_board(_write(mark_74())))
    colours = [(c["hex"], c["share"]) for c in analysis["colors"]]
    assert colours == [("#111413", 0.9), ("#e8593c", 0.1)]
    assert analysis["version"] == 6
    image = analysis["images"][0]
    assert image["lightness"] > 20  # not the black under the transparency
    assert "transparent" not in image


def test_a_board_of_sprites_isnt_mostly_black() -> None:
    analysis = analyze_moodboard(_board(_write(sprite_49()), _write(soft_disc())))
    assert not any(_dark(hex_value) for hex_value in analysis["palette"])
    assert "deep shadows" not in analysis["keywords"]


def test_a_fully_transparent_image_says_so_and_invents_no_colour() -> None:
    sprite = _write(sprite_49())
    analysis = analyze_moodboard(_board(sprite, _write(clear())))
    clear_entry = analysis["images"][1]
    assert clear_entry["status"] == "analyzed" and clear_entry["transparent"] is True
    assert clear_entry["colors"] == [] and clear_entry["lightness"] is None
    assert "#2 is fully transparent, so it adds no colors." in analysis["summary"]
    assert "#2 is fully transparent, so it adds no colors." in analysis["warnings"]
    # The clear image takes no part of the board: the sprite's green is all of it.
    assert [(c["hex"], c["share"]) for c in analysis["colors"]] == [(analysis["palette"][0], 1.0)]

    alone = analyze_moodboard(_board(_write(clear())))
    assert alone["palette"] == [] and alone["colors"] == []
    assert "no local palette extracted" in alone["summary"]
    assert "#1 is fully transparent" in alone["summary"]


def _saved_v5(board: dict) -> dict:
    analysis = analyze_moodboard(board)
    return {**analysis, "version": 5}


def test_an_analysis_from_before_alpha_counted_is_out_of_date_on_a_transparent_board() -> None:
    board = _board(_write(mark_74()))
    old = _saved_v5(board)
    assert predates_alpha(board, old)
    assert not analysis_is_current(board, old)
    assert analysis_is_current(board, analyze_moodboard(board))

    shown = with_alpha_outdated({**board, "analysis": old})
    assert shown["analysis"]["outdated"] == ALPHA_OUTDATED
    assert dry_run({**board, "analysis": old})["saved"] == {"analyzed": True, "current": False,
                                                          "outdated": ALPHA_OUTDATED}


def test_an_older_analysis_of_an_opaque_board_stays_current() -> None:
    board = _board(_write(opaque()), _write(opaque().convert("RGBA")))
    old = _saved_v5(board)
    assert not predates_alpha(board, old)
    assert analysis_is_current(board, old)
    assert with_alpha_outdated({**board, "analysis": old})["analysis"] is old


def test_the_store_marks_a_pre_alpha_analysis_on_every_read(tmp_path, monkeypatch) -> None:
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    store = MoodboardStore()
    made = store.create(name="Sprites", images=[{"url": _write(sprite_49())}])
    analysis = {**analyze_moodboard(made), "version": 5}
    store.update(made["id"], analysis=analysis)
    assert store.get(made["id"])["analysis"]["outdated"] == ALPHA_OUTDATED
    store.update(made["id"], analysis=analyze_moodboard(store.get(made["id"])))
    assert "outdated" not in store.get(made["id"])["analysis"]
