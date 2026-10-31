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

import base64
import hashlib
import io
import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter, ImageOps

from cinema.color import ALPHA_MIN, extract_palette, has_transparency, visible_pixels
from commons import intake, media
from commons.colour import delta_e00, hex_to_lab
from commons.measure import CODE_VERSION, measure_image
from services.moodboard_analysis import (
    ALPHA_OUTDATED,
    analysis_is_current,
    analyze_moodboard,
    colours_current,
    dry_run,
    predates_alpha,
    stamp_transparency,
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
# sha256 of transfer_to_palette(opaque(), ["#1b3a4b", "#d98841"], 0.7) on 1944d052.
OPAQUE_TRANSFER_GOLDEN = "4ca87d8e4b74ae652e30702c84ac69c5464d2b7f88845c8ee7cf28c01a5c5b98"
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
    with pytest.raises(ValueError, match="too transparent") as caught:
        await handle_cinema_color(node, inputs, api_keys={}, emit=None)
    assert person_line(caught.value) == (
        "The image in “Palette Source” is too transparent to match colors from. Choose another image, or "
        "add hex swatches to “Palette”.")


# -- the moodboard analysis ----------------------------------------------------------------

def _board(*urls: str) -> dict:
    return {"id": "mb_alpha", "name": "Alpha", "mode": "look", "strength": 0.7, "notes": "",
            "images": [{"id": f"i{n}", "url": url, "weight": 1.0, "notes": "", "excluded": False}
                       for n, url in enumerate(urls)]}


def _stamped(board: dict) -> dict:
    """``board`` with each image's stored ``hasTransparency``, as intake and
    the startup pass write it."""
    stamp_transparency(board["images"])
    return board


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
    assert "#2 is too transparent to add colors." in analysis["summary"]
    assert "#2 is too transparent to add colors." in analysis["warnings"]
    # The clear image takes no part of the board: the sprite's green is all of it.
    assert [(c["hex"], c["share"]) for c in analysis["colors"]] == [(analysis["palette"][0], 1.0)]

    alone = analyze_moodboard(_board(_write(clear())))
    assert alone["palette"] == [] and alone["colors"] == []
    assert "no local palette extracted" in alone["summary"]
    assert "#1 is too transparent to add colors." in alone["summary"]


def _saved_v5(board: dict) -> dict:
    analysis = analyze_moodboard(board)
    return {**analysis, "version": 5}


def test_an_analysis_from_before_alpha_counted_is_out_of_date_on_a_transparent_board() -> None:
    board = _stamped(_board(_write(mark_74())))
    assert board["images"][0]["hasTransparency"] is True
    old = _saved_v5(board)
    assert predates_alpha(board, old)
    # It still describes the board (review 1 F5): only its colours are out of date.
    assert analysis_is_current(board, old)
    assert not colours_current(board, old)
    assert colours_current(board, analyze_moodboard(board))

    shown = with_alpha_outdated({**board, "analysis": old})
    assert shown["analysis"]["outdated"] == ALPHA_OUTDATED
    assert dry_run({**board, "analysis": old})["saved"] == {"analyzed": True, "current": True,
                                                          "outdated": ALPHA_OUTDATED}


def test_an_older_analysis_of_an_opaque_board_stays_current() -> None:
    board = _stamped(_board(_write(opaque()), _write(opaque().convert("RGBA"))))
    assert [img["hasTransparency"] for img in board["images"]] == [False, False]
    old = _saved_v5(board)
    assert not predates_alpha(board, old)
    assert analysis_is_current(board, old) and colours_current(board, old)
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


# -- round 2: one contract, the vision readers, Cinema Color's alpha -----------------------

CONTRACT = json.loads((Path(__file__).resolve().parents[2] / "contracts/fixtures/colour/alpha.json")
                      .read_text(encoding="utf-8"))


def test_the_backend_follows_the_alpha_contract() -> None:
    from cinema.color import COMMONS_READER_SURFACE, MOODBOARD_READER_SURFACE, NODE_MEDIA_SURFACE

    assert ALPHA_MIN == CONTRACT["alphaMin"]
    for case in CONTRACT["weightCases"]:
        pixel = np.zeros((1, 1, 4), np.uint8)
        pixel[0, 0] = (*ORANGE, case["alpha"])
        rgb, weights = visible_pixels(Image.fromarray(pixel, "RGBA"))
        weight = 0.0 if not len(rgb) else 1.0 if weights is None else float(weights[0])  # None: all opaque
        assert weight == pytest.approx(case["weight"], abs=1e-6), case
    surfaces = {"commons": COMMONS_READER_SURFACE, "moodboard": MOODBOARD_READER_SURFACE,
                "canvasNode": NODE_MEDIA_SURFACE}
    assert set(surfaces) == set(CONTRACT["readerSurfaces"])
    for name, surface in surfaces.items():
        assert "#{:02x}{:02x}{:02x}".format(*surface) == CONTRACT["readerSurfaces"][name]["hex"], name


def test_composite_on_shows_the_surface_never_the_hidden_colour() -> None:
    from cinema.color import composite_on, is_clear

    surface = (8, 8, 8)
    seen = composite_on(mark_74(), surface)
    pixels = np.asarray(seen).reshape(-1, 3)
    colours = {tuple(int(v) for v in p) for p in pixels}
    assert colours == {surface, CHARCOAL, ORANGE}  # the clear 74% shows the surface
    half = np.asarray(composite_on(sprite_49(), (128, 128, 128)))
    assert tuple(half[0, 31]) == tuple(round(g * 128 / 255 + 128 * (1 - 128 / 255)) for g in GREEN)
    assert composite_on(clear(), surface) is None and is_clear(clear())
    faint = np.zeros((8, 8, 4), np.uint8)
    faint[..., 3] = ALPHA_MIN - 1
    assert is_clear(Image.fromarray(faint, "RGBA")) and not is_clear(mark_74())
    for image in (opaque(), opaque().convert("RGBA"), opaque().convert("P")):
        assert composite_on(image, surface).tobytes() == image.convert("RGB").tobytes()


def test_the_moodboard_reader_sends_a_transparent_reference_over_the_card() -> None:
    from services.moodboard_reader import encode_image

    def decoded(path: Path) -> np.ndarray:
        mime, data = encode_image(path)
        assert mime == "image/jpeg"
        return np.asarray(Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB"), dtype=np.int16)

    folder = OUTPUT_ROOT / "alpha-tests"
    folder.mkdir(parents=True, exist_ok=True)
    sprite = folder / f"{uuid4().hex[:8]}-sprite.png"
    sprite_49().save(sprite)
    seen = decoded(sprite)
    assert np.abs(seen[:, 48:] - 8).max() <= 4  # the clear half is the card, near black either way
    assert np.abs(seen[:, :20] - np.array(GREEN)).max() <= 6

    disc = folder / f"{uuid4().hex[:8]}-disc.png"
    soft_disc().save(disc)
    edge = decoded(disc)[64, 2:14]  # across the soft edge: never darker than the card, no black ring
    assert edge.min() >= 4

    # An opaque reference is sent byte for byte as before.
    plain = folder / f"{uuid4().hex[:8]}-plain.png"
    opaque().save(plain)
    with Image.open(plain) as source:
        old = ImageOps.exif_transpose(source).convert("RGB")
        old.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        old.save(buffer, format="JPEG", quality=85, optimize=True)
    assert encode_image(plain)[1] == base64.b64encode(buffer.getvalue()).decode("ascii")

    clear_file = folder / f"{uuid4().hex[:8]}-clear.png"
    clear().save(clear_file)
    with pytest.raises(ValueError, match="too transparent"):
        encode_image(clear_file)


def test_a_clear_reference_is_never_sent_or_priced() -> None:
    from services import moodboard_reader as reader
    from tests.test_moodboard_reader import ARGON, FakeGoogle, fake_encode, run_read

    folder = OUTPUT_ROOT / "alpha-tests"
    folder.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, image in (("one", sprite_49()), ("two", clear()), ("three", soft_disc())):
        path = folder / f"{name}-{uuid4().hex[:6]}.png"
        image.save(path)
        paths.append(path)
    b = {"id": "board1", "name": "Board", "frames": [], "notes": "", "sendNotes": False,
         "images": [{"id": f"img{n}", "url": str(p), "weight": 1.0, "notes": "", "privateNote": "", "excluded": False}
                    for n, p in enumerate(paths, 1)]}
    targets = reader.select_targets(b, resolve=lambda url: Path(url))
    assert reader.clear_targets(targets) == {"img2"}
    est = reader.estimate(b, ARGON, targets=targets, today=date(2026, 10, 20))
    assert est["count"] == 2 and est["transparent"] == [2] and est["targets"] == 3

    from tests.test_moodboard_reader_source import FakeSource

    unpriced = reader.read_estimate(FakeSource(), b, targets)
    assert unpriced["count"] == 2 and unpriced["transparent"] == [2] and unpriced["batches"] == 1

    google = FakeGoogle()
    import tests.test_moodboard_reader as reader_tests
    original = reader_tests.targets_of
    reader_tests.targets_of = lambda board: reader.select_targets(board, resolve=lambda url: Path(url))
    try:
        result = run_read(b, google)
    finally:
        reader_tests.targets_of = original
    sent = [base64.b64decode(part["inline_data"]["data"]).decode()
            for body in google.bodies for part in body["contents"][0]["parts"] if "inline_data" in part]
    assert paths[1].stem not in sent and {paths[0].stem, paths[2].stem} <= set(sent)
    skip = [line for line in result["trace"] if line["kind"] == "skip"]
    assert [line["text"] for line in skip] == ["#2 is too transparent to add colors."]
    placement = next(r for r in result["results"] if r["id"] == "img2")
    assert placement["status"] == "couldntRead"
    assert placement["why"] == "It's too transparent to add colors."
    assert "#2 Unsorted: it's too transparent" in [line["text"] for line in result["trace"]]
    assert len([b for b in google.bodies if "readings" in json.dumps(b)]) >= 1


@pytest.mark.parametrize("method", ["lab-transfer", "reinhard", "histogram"])
def test_cinema_color_keeps_alpha_and_grades_only_what_is_seen(method: str) -> None:
    from cinema.color import transfer_to_palette

    source = soft_disc()
    graded = transfer_to_palette(source, ["#1b3a4b", "#d98841"], strength=0.8, method=method)
    assert graded.mode == "RGBA"
    assert np.array_equal(np.asarray(graded)[..., 3], np.asarray(source)[..., 3])
    # The stats count only what's seen: the black under the clear corners
    # changes nothing, so a different hidden colour grades the same.
    hidden = np.asarray(source).copy()
    hidden[hidden[..., 3] == 0, :3] = (255, 255, 255)
    again = transfer_to_palette(Image.fromarray(hidden, "RGBA"), ["#1b3a4b", "#d98841"], strength=0.8, method=method)
    seen = np.asarray(source)[..., 3] >= ALPHA_MIN
    assert np.array_equal(np.asarray(graded)[seen], np.asarray(again)[seen])


def test_cinema_color_grades_an_opaque_image_byte_for_byte_as_before() -> None:
    from cinema.color import transfer_to_palette

    golden = OPAQUE_TRANSFER_GOLDEN
    for image in (opaque(), opaque().convert("RGBA")):
        out = transfer_to_palette(image, ["#1b3a4b", "#d98841"], strength=0.7)
        assert out.mode == "RGB"
        assert hashlib.sha256(out.tobytes()).hexdigest() == golden


@pytest.mark.asyncio
async def test_cinema_color_output_keeps_the_sources_alpha_end_to_end() -> None:
    from handlers.cinema_color import handle_cinema_color
    from models.graph import GraphNode, PortValueDict

    node = GraphNode(id="c1", definitionId="cinema-color", params={"palette": ["#1b3a4b", "#d98841"]})
    inputs = {"image": PortValueDict(type="Image", value=_write(soft_disc()))}
    out = await handle_cinema_color(node, inputs, api_keys={}, emit=None)
    rel = out["image"]["value"].removeprefix("/api/outputs/")
    with Image.open(OUTPUT_ROOT / rel) as result:
        assert result.mode == "RGBA"
        assert np.array_equal(np.asarray(result)[..., 3], np.asarray(soft_disc())[..., 3])


# -- GM r1 on #208: each line verbatim, on every surface -----------------------------------

OUTDATED_LINE = "These colors counted transparent areas as dark. Analyze again to update them."
RERUN_LINE = ("The board’s saved colors counted transparent areas as dark, so this run analyzed it again. "
              "Analyze it in Moodboard Studio to save the new analysis.")


def test_the_lines_read_as_gm_wrote_them() -> None:
    from services.moodboard_analysis import ALPHA_RERUN_WARNING, TRANSPARENT_IMAGE_LINE

    assert ALPHA_OUTDATED == OUTDATED_LINE
    assert ALPHA_RERUN_WARNING == RERUN_LINE
    assert TRANSPARENT_IMAGE_LINE.format(number=4) == "#4 is too transparent to add colors."


@pytest.mark.asyncio
async def test_the_node_says_why_it_analyzed_a_pre_alpha_board_again(tmp_path, monkeypatch) -> None:
    from handlers.moodboard import handle_moodboard_node
    from models.graph import GraphNode
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))
    store = MoodboardStore()
    made = store.create(name="Sprites", images=[{"url": _write(sprite_49())}])
    store.update(made["id"], analysis={**analyze_moodboard(store.get(made["id"])), "version": 5})
    result = await handle_moodboard_node(
        GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": made["id"]}), {}, {})
    assert result["moodboard"]["value"]["analysis"]["warnings"][-1] == RERUN_LINE


@pytest.mark.asyncio
async def test_the_nodes_bundle_says_which_image_is_clear(tmp_path, monkeypatch) -> None:
    from handlers.moodboard import handle_moodboard_node
    from models.graph import GraphNode
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))
    store = MoodboardStore()
    made = store.create(name="Sprites", images=[{"url": _write(sprite_49())}, {"url": _write(clear())}])
    store.update(made["id"], analysis=analyze_moodboard(store.get(made["id"])))
    result = await handle_moodboard_node(
        GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": made["id"]}), {}, {})
    summary = result["moodboard"]["value"]["analysis"]["summary"]
    assert summary.startswith("2 reference images analyzed as look.")
    assert "#2 is too transparent to add colors." in summary


def test_the_summary_counts_in_a_real_plural() -> None:
    one = analyze_moodboard(_board(_write(sprite_49())))["summary"]
    two = analyze_moodboard(_board(_write(sprite_49()), _write(mark_74())))["summary"]
    assert one.startswith("1 reference image analyzed as look.") and "(s)" not in one
    assert two.startswith("2 reference images analyzed as look.") and "(s)" not in two


def test_the_cli_estimate_names_clear_references(capsys) -> None:
    from cli.commands import moodboard as moodboard_cmd

    moodboard_cmd._print_estimate({"reader": {"name": "Argon"}, "thinkingLevel": "low", "count": 2, "batches": 1,
                                   "low": 0.01, "high": 0.02, "transparent": [2]})
    assert "  Too transparent, so not read: #2" in capsys.readouterr().out


# -- round 2, review 1 (affb9b25): each fails there ------------------------------------------

def line_art_2048() -> Image.Image:
    """1px orange lines every 128px at offset 4, on a clear 2048 canvas."""
    a = np.zeros((2048, 2048, 4), np.uint8)
    a[4::128, :] = (*ORANGE, 255)
    a[:, 4::128] = (*ORANGE, 255)
    return Image.fromarray(a, "RGBA")


def thin_cross_2048() -> Image.Image:
    """A 4px orange cross (rows and columns 1000-1003) on a clear 2048 canvas:
    between the rows and columns a NEAREST resize to 256 picks."""
    a = np.zeros((2048, 2048, 4), np.uint8)
    a[1000:1004, :] = (*ORANGE, 255)
    a[:, 1000:1004] = (*ORANGE, 255)
    return Image.fromarray(a, "RGBA")


def one_pixel(alpha: int, size: int = 16) -> Image.Image:
    a = np.zeros((size, size, 4), np.uint8)
    a[size // 2, size // 2] = (*ORANGE, alpha)
    return Image.fromarray(a, "RGBA")


def test_the_threshold_is_16_of_255() -> None:
    # Written as numbers, not the symbol (review 1 F6): 15 is out, 16 is in.
    assert ALPHA_MIN == 16
    rgb, weights = visible_pixels(one_pixel(15))
    assert rgb.shape == (0, 3)
    rgb, weights = visible_pixels(one_pixel(16))
    assert [tuple(p) for p in rgb] == [ORANGE] and weights.tolist() == pytest.approx([16 / 255])
    # A pixel at 254 is transparency; every pixel at 255 is opaque.
    almost = opaque().convert("RGBA")
    almost.putpixel((0, 0), (*ORANGE, 254))
    assert has_transparency(almost) and not has_transparency(opaque().convert("RGBA"))


def test_sparse_line_art_analyzes_without_error() -> None:
    # Review 1 F1: the palette saw the lines while the stats' 64px sample didn't, and analyze crashed.
    analysis = analyze_moodboard(_board(_write(line_art_2048()), _write(opaque())))
    art = analysis["images"][0]
    assert [c["hex"] for c in art["colors"]] == ["#e8593c"] and "transparent" not in art
    assert art["lightness"] == pytest.approx((0xE8 + 0x3C) / 2, abs=0.5)
    assert isinstance(analysis["styleBrief"], str) and analysis["styleBrief"]


def test_one_pixel_at_the_threshold_analyzes_without_error() -> None:
    analysis = analyze_moodboard(_board(_write(one_pixel(16)), _write(opaque())))
    dot = analysis["images"][0]
    assert [c["hex"] for c in dot["colors"]] == ["#e8593c"] and dot["lightness"] is not None
    # And on a 2048 canvas, where the reduce makes it 1/64 of a cell: still seen.
    assert extract_palette(one_pixel(16, 2048)) and not analyze_moodboard(
        _board(_write(one_pixel(16, 2048))))["images"][0].get("transparent")


def test_no_lightness_skips_the_mean_instead_of_crashing() -> None:
    from services.moodboard_analysis import _keywords_from_analysis, _lighting_hint, _weighted_mean

    images = [{"weight": 1.0, "lightness": None, "saturation": None},
              {"weight": 1.0, "lightness": 40.0, "saturation": 10.0}]
    assert _weighted_mean(images, lambda img: img.get("lightness", 128)) == 40.0
    assert _weighted_mean(images[:1], lambda img: img.get("lightness", 128)) is None
    assert "deep shadows" in _keywords_from_analysis("look", "", images, ["#222222"])
    assert _keywords_from_analysis("look", "", images[:1], ["#222222"]) == ["palette-led", "style consistency",
                                                                           "visual language"]
    assert _lighting_hint(images[:1]) == "derive lighting from source references"


def test_a_thin_stroke_is_seen_and_has_its_own_colour() -> None:
    # Review 1 F2: NEAREST to 256 missed the cross and called the image fully transparent.
    analysis = analyze_moodboard(_board(_write(thin_cross_2048())))
    cross = analysis["images"][0]
    assert [c["hex"] for c in cross["colors"]] == ["#e8593c"] and "transparent" not in cross
    assert "too transparent" not in analysis["summary"]
    assert extract_palette(thin_cross_2048())[0] == "#e8593c"  # no dark fringe from the reduce
    rgb, weights = visible_pixels(thin_cross_2048())
    # Each reduced pixel carries its block's coverage: 4 of 8 rows, or of 8 columns.
    assert {tuple(p) for p in rgb} == {ORANGE} and max(weights) <= 1.0 and min(weights) == pytest.approx(0.5)


def test_faint_and_clear_images_both_read_too_transparent() -> None:
    # Decided at full resolution: no pixel at 16 or above (GM r2 on #208: one line for both).
    from cinema.color import is_clear

    faint = Image.new("RGBA", (64, 64), (128, 32, 160, 15))
    for image in (clear(), faint, one_pixel(15, 2048)):
        assert is_clear(image) and visible_pixels(image)[0].shape == (0, 3)
    analysis = analyze_moodboard(_board(_write(sprite_49()), _write(faint)))
    assert analysis["images"][1]["transparent"] is True
    assert "#2 is too transparent to add colors." in analysis["summary"]
    assert not is_clear(one_pixel(16, 2048))


def test_lightness_counts_each_pixel_by_its_alpha() -> None:
    # Review 1 F6: half opaque white, half black at alpha 64. Weighted, the
    # black counts 64/255 of a pixel: 255 / (1 + 64/255) = 203.84. Unweighted 127.5.
    a = np.zeros((16, 16, 4), np.uint8)
    a[:, :8] = (255, 255, 255, 255)
    a[:, 8:] = (0, 0, 0, 64)
    image = analyze_moodboard(_board(_write(Image.fromarray(a, "RGBA"))))["images"][0]
    assert image["lightness"] == pytest.approx(255 / (1 + 64 / 255), abs=0.01)


def _accent_pass(orange_alpha: int, monkeypatch, count: int = 3) -> list[dict]:
    """commons.measure._palette over eight grey bands at alpha 64 and three
    orange pixels, with the main clusters fixed on the greys, so the orange is
    found by the accent pass (k-means++ would otherwise seed a main on it)."""
    import commons.measure as measure
    from cinema.color import rgb_to_lab

    a = np.zeros((40, 50, 4), np.uint8)
    for band in range(8):
        a[band * 5:(band + 1) * 5, :, :3] = 15 + band * 32
    a[..., 3] = 64
    a[0, :count] = (*ORANGE, orange_alpha)
    rgb, weights = visible_pixels(Image.fromarray(a, "RGBA"))
    greys = rgb_to_lab(np.array([[15 + band * 32] * 3 for band in range(8)], float))
    real, calls = measure._kmeans_lab, []

    def fixed(points, k, seed=1729, weights=None):
        calls.append(points.shape[0])
        return greys if len(calls) == 1 else real(points, k, seed, weights=weights)

    monkeypatch.setattr(measure, "_kmeans_lab", fixed)
    out = measure._palette(rgb_to_lab(rgb.astype(np.float64)), 40.0, 10.0, 5.0, weights)
    assert len(calls) == (2 if orange_alpha * count >= 255 else 1)
    return out


def test_an_accent_counts_by_its_mass_not_its_pixels(monkeypatch) -> None:
    # Review 1 F6 (M09, M10). The board's mass is about 504 (2000 pixels at 64/255).
    # Three opaque orange pixels are an accent at 3 / 504.2 of it (by pixels: 3 / 2000).
    accents = [e for e in _accent_pass(255, monkeypatch) if e["hex"] == "#e8593c"]
    assert [(e["share"], e["is_accent"]) for e in accents] == [(0.0059, True)]
    # At alpha 64 they weigh 0.75 of a pixel, under the one-pixel minimum: no accent.
    assert not [e for e in _accent_pass(64, monkeypatch) if e["hex"] == "#e8593c"]
    # Six at alpha 128 weigh 3.01 pixels: an accent at that mass, not at six pixels.
    half = [e for e in _accent_pass(128, monkeypatch, count=6) if e["hex"] == "#e8593c"]
    total = 2000 * 64 / 255 - 6 * 64 / 255 + 6 * 128 / 255
    assert [(e["share"], e["is_accent"]) for e in half] == [(round(6 * 128 / 255 / total, 4), True)]


# A transparent image's palette, pinned: it moves with any change to the
# alpha weights, the reduce or the weighted seeding (review 1 M06).
def _ramp_with_alpha() -> Image.Image:
    a = np.zeros((300, 400, 4), np.uint8)
    a[..., 0] = np.linspace(0, 255, 400)[None, :]
    a[..., 1] = np.linspace(255, 0, 300)[:, None]
    a[..., 2] = 90
    a[..., 3] = np.linspace(0, 255, 400)[None, :]
    return Image.fromarray(a, "RGBA")


TRANSPARENT_EXTRACT_GOLDEN = ['#5b2f5a', '#a63d5a', '#70855a', '#e4435a', '#d8a25a', '#a1dc5a']


def test_a_transparent_images_palette_is_pinned() -> None:
    assert extract_palette(_ramp_with_alpha()) == TRANSPARENT_EXTRACT_GOLDEN


def test_la_is_read_through_la_not_refused() -> None:
    # Review 1 F10: Pillow has no La to RGBA conversion; base raised here too.
    from cinema.color import as_rgba, composite_on

    la = Image.new("La", (8, 8), (100, 128))  # premultiplied grey 100 at alpha 128: straight 199
    assert has_transparency(la)
    assert as_rgba(la).getpixel((0, 0)) == (199, 199, 199, 128)
    rgb, weights = visible_pixels(la)
    assert {tuple(p) for p in rgb} == {(199, 199, 199)} and weights.tolist() == pytest.approx([128 / 255] * 64)
    assert composite_on(la, (8, 8, 8)).getpixel((0, 0)) == tuple([round(199 * 128 / 255 + 8 * 127 / 255)] * 3)


# -- the stored transparency fact (review 1 F3) and outdated never saved (F4) -------------------

def _raw(store_root: Path, board_id: str) -> dict:
    return json.loads(next(store_root.rglob(f"{board_id}.json")).read_text(encoding="utf-8"))


def _pre_alpha_board(root: Path, *images: Image.Image) -> str:
    """A board file as a pre-v6 Nebula left it: version 5 analysis, images
    with no stored transparency."""
    from services.moodboard_store import MoodboardStore

    store = MoodboardStore()
    made = store.create(name="Old", images=[{"url": _write(image)} for image in images])
    store.update(made["id"], analysis={**analyze_moodboard(store.get(made["id"])), "version": 5})
    path = next(root.rglob(f"{made['id']}.json"))
    raw = json.loads(path.read_text(encoding="utf-8"))
    for image in raw["images"]:
        image.pop("hasTransparency", None)
    path.write_text(json.dumps(raw), encoding="utf-8")
    return made["id"]


def test_intake_stores_whether_each_image_has_transparency(tmp_path, monkeypatch) -> None:
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))
    store = MoodboardStore()
    junk = OUTPUT_ROOT / "alpha-tests" / f"{uuid4().hex[:10]}.png"
    junk.write_bytes(b"not an image")
    made = store.create(name="Mixed", images=[{"url": _write(sprite_49())}, {"url": _write(opaque())},
                                              {"url": f"/api/outputs/alpha-tests/{junk.name}"}])
    flags = [img.get("hasTransparency") for img in _raw(tmp_path / "boards", made["id"])["images"]]
    assert flags == [True, False, None]  # an unreadable file is unknown, not transparent
    # A client echoing the flag back can't change it; a new file is read again.
    images = store.get(made["id"])["images"]
    images[1] = {**images[1], "hasTransparency": True}
    images[0] = {**images[0], "url": _write(opaque())}
    store.update(made["id"], images=images)
    assert [img.get("hasTransparency") for img in _raw(tmp_path / "boards", made["id"])["images"]][:2] == [False,
                                                                                                         False]


def test_listing_old_boards_never_decodes_an_image(tmp_path, monkeypatch) -> None:
    from services import moodboard_analysis
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))
    ids = [_pre_alpha_board(tmp_path / "boards", sprite_49()) for _ in range(3)]

    def no_decode(*args, **kwargs):
        raise AssertionError("a read decoded an image")

    monkeypatch.setattr(moodboard_analysis.Image, "open", no_decode)
    store = MoodboardStore()
    listed = store.list("global")
    assert {b["id"] for b in listed} >= set(ids)
    # Not yet stored: unknown, so not out of date (and nothing decoded to find out).
    assert all("outdated" not in (b.get("analysis") or {}) for b in listed)
    assert "outdated" not in store.get(ids[0])["analysis"]


def test_the_startup_pass_stores_the_fact_once(tmp_path, monkeypatch) -> None:
    from services import moodboard_analysis
    from services.moodboard_store import MoodboardStore, stamp_transparency_once

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))
    old = _pre_alpha_board(tmp_path / "boards", sprite_49(), opaque())
    gone = _pre_alpha_board(tmp_path / "boards", opaque())
    path = OUTPUT_ROOT / _raw(tmp_path / "boards", gone)["images"][0]["url"].removeprefix("/api/outputs/")
    path.write_bytes(b"not an image")
    current = MoodboardStore().create(name="New", images=[{"url": _write(sprite_49())}])
    MoodboardStore().update(current["id"], analysis=analyze_moodboard(MoodboardStore().get(current["id"])))
    new_path = next((tmp_path / "boards").rglob(f"{current['id']}.json"))
    raw_new = json.loads(new_path.read_text(encoding="utf-8"))
    for image in raw_new["images"]:
        image.pop("hasTransparency", None)  # as if added before the flag existed
    new_path.write_text(json.dumps(raw_new), encoding="utf-8")
    before_new = _raw(tmp_path / "boards", current["id"])

    opened: list[str] = []
    real = moodboard_analysis.Image.open
    monkeypatch.setattr(moodboard_analysis.Image, "open", lambda p, *a, **k: (opened.append(str(p)), real(p, *a, **k))[1])
    report = stamp_transparency_once()
    assert len(opened) == 3  # the old board's two images and the unreadable one; never the v6 board's
    assert [img["hasTransparency"] for img in _raw(tmp_path / "boards", old)["images"]] == [True, False]
    raw_gone = _raw(tmp_path / "boards", gone)
    assert "hasTransparency" not in raw_gone["images"][0]  # unreadable: unknown, left without it
    assert _raw(tmp_path / "boards", current["id"]) == before_new
    assert [Path(p).stem for p in report["saved"]] == [old]
    assert _raw(tmp_path / "boards", old)["version"] == MoodboardStore().get(old)["version"]

    store = MoodboardStore()
    assert store.get(old)["analysis"]["outdated"] == ALPHA_OUTDATED
    assert "outdated" not in store.get(gone)["analysis"]  # unknown never marks a board out of date
    opened.clear()
    stamp_transparency_once()
    assert opened == [str(path)]  # only the unknown one is tried again


def test_a_set_aside_transparent_image_still_makes_the_colours_outdated() -> None:
    # Review 1 M24: the saved colours came from every image, set aside or not.
    board = _stamped(_board(_write(opaque()), _write(sprite_49())))
    board["images"][1]["excluded"] = True
    assert predates_alpha(board, _saved_v5(board))
    board["images"][1]["weight"], board["images"][1]["excluded"] = 0.0, False
    assert predates_alpha(board, _saved_v5(board))


def test_outdated_is_never_written_to_disk(tmp_path, monkeypatch) -> None:
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))
    store = MoodboardStore()
    made = store.create(name="Sprites", images=[{"url": _write(sprite_49())}])
    store.update(made["id"], analysis={**analyze_moodboard(store.get(made["id"])), "version": 5})
    read = store.get(made["id"])
    assert read["analysis"]["outdated"] == ALPHA_OUTDATED
    card = read["images"][0]["placements"][0]["id"]
    writes = [lambda: store.update(made["id"], name="P2"),
              lambda: store.update(made["id"], by="person", direction="Warmer"),
              lambda: store.apply_edits(made["id"], [{"op": "place", "placement": card, "x": 40, "y": 40}],
                                        by="person"),
              # A client that sends the analysis back as it read it.
              lambda: store.update(made["id"], analysis=store.get(made["id"])["analysis"])]
    for write in writes:
        write()
        assert "outdated" not in _raw(tmp_path / "boards", made["id"])["analysis"]
    # Worked out again on read: a stored stale one never outlives its cause.
    path = next((tmp_path / "boards").rglob(f"{made['id']}.json"))
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["analysis"]["outdated"], raw["images"][0]["hasTransparency"] = ALPHA_OUTDATED, False
    path.write_text(json.dumps(raw), encoding="utf-8")
    assert "outdated" not in store.get(made["id"])["analysis"]


# -- analysis_is_current keeps its meaning (review 1 F5) -------------------------------------

@pytest.mark.parametrize("second", [sprite_49, opaque])
def test_a_pre_alpha_summary_still_recounts_and_its_edited_brief_stays_current(second, monkeypatch) -> None:
    # Both callers of analysis_is_current read as on base, for a transparent
    # board (sprite) and an opaque one alike.
    from services import moodboard_brief
    from services.moodboard_analysis import with_steering_count

    board = _stamped(_board(_write(sprite_49()), _write(second())))
    board["images"][1]["excluded"] = True
    old = {**_saved_v5(board), "summary": "2 reference image(s) analyzed as look. Palette: #3caa5a."}
    from services.moodboard_analysis import source_hash
    old["sourceHash"] = source_hash(board, 5)
    shown = {**board, "analysis": old}
    assert analysis_is_current(board, old)
    # Recounted (the set-aside image is out), as for any current analysis.
    assert with_steering_count(shown)["analysis"]["summary"] == "1 reference image analyzed as look. Palette: #3caa5a."
    # An edited brief on it keeps a real basis: the board didn't change.
    monkeypatch.setattr(moodboard_brief, "_brief_was_edited", lambda *a: True)
    migrated, record = moodboard_brief.migrate_board(shown)
    assert record["overrideFromEditedBrief"] and record["overrideCurrent"] is True
    assert migrated["briefOverride"]["basis"] != "migrated"


# -- the other readers that flattened alpha onto black (review 1 F7) -------------------------

def _decoded(data: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[-1]))).convert("RGB")


def _old_jpeg(image: Image.Image, edge: int, quality: int, optimize: bool) -> bytes:
    flat = image.convert("RGB")
    flat.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    flat.save(out, format="JPEG", quality=quality, optimize=optimize)
    return out.getvalue()


def test_the_vision_node_sends_a_transparent_image_as_it_shows_on_the_node(tmp_path) -> None:
    from services import vision_llm

    path = tmp_path / "sprite.png"
    sprite_49().save(path)
    (mime, data), = vision_llm._encoded_images([path])
    corner = _decoded(data).getpixel((63, 0))  # a clear pixel of the sprite
    assert max(abs(c - 10) for c in corner) <= 3 and mime == "image/jpeg"
    flat = tmp_path / "flat.png"
    opaque().save(flat)
    (_, sent), = vision_llm._encoded_images([flat])
    with Image.open(flat) as source:
        assert base64.b64decode(sent) == _old_jpeg(ImageOps.exif_transpose(source),
                                                   vision_llm.MAX_VISION_IMAGE_EDGE, 78, True)


def test_qc_frames_and_references_show_as_on_the_node() -> None:
    from services import qc_jev
    from services.qc_common import normalized_rgb

    corner = _decoded(qc_jev._data_uri(sprite_49())).getpixel((63, 0))
    assert max(abs(c - 10) for c in corner) <= 3
    frame = opaque()
    assert base64.b64decode(qc_jev._data_uri(frame).split(",", 1)[1]) == _old_jpeg(frame, qc_jev.FRAME_LONG_SIDE,
                                                                                   92, False)
    assert frame.size == opaque().size  # the caller's frame isn't shrunk in place
    measured = normalized_rgb(sprite_49(), (8, 8))
    assert measured[0, 7].tolist() == pytest.approx([10 / 255] * 3, abs=1e-6)
    flat = np.asarray(ImageOps.fit(opaque(), (8, 8), method=Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
    assert np.array_equal(normalized_rgb(opaque(), (8, 8)), flat)
