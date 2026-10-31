"""Where a board's colours come from, and a dry-run analyze that saves nothing.

Before: each board colour said only how many images it came from
(`images: 2`), so nobody could tell which image carried the orange, and the
only way to see what other colour thresholds would do was to change Commons'
constants and analyze for real.
"""
from __future__ import annotations

import json

import numpy as np
import pytest
from PIL import Image

import mcp_server
import moodboard_client as boards
from cli.__main__ import build_parser
from cli.client import NebulaClient
from cli.commands import moodboard as moodboard_cmd
from commons.measure import measure_image
from nebula_api import NebulaAPIError
from services.moodboard_analysis import (
    ANALYSIS_VERSION,
    Thresholds,
    _roll_up,
    _Steering,
    analyze_moodboard,
    colour_changes,
    dry_run,
    parse_thresholds,
)
from tests.test_moodboard_cli import _cli, app  # noqa: F401
from tests.test_moodboard_defaults_pin import CREAM, NAVY, ORANGE, SAGE, BLUE, _blocks, _image

MAGENTA = (220, 30, 160)


def _accent_board() -> dict:
    """Image 1 excluded, 2 navy, 3 weight 0, 4 cream with an orange accent,
    5 sage (weight 0.5) with orange and blue accents."""
    return {"name": "Accent", "mode": "look", "strength": 0.7, "notes": "", "images": [
        _image(_blocks("prov-1", [], MAGENTA, noise=2, seed=41), excluded=True, image_id="ex"),
        _image(_blocks("prov-2", [], NAVY, noise=2, seed=42), image_id="navy"),
        _image(_blocks("prov-3", [], BLUE, noise=2, seed=43), 0.0, image_id="zero"),
        _image(_blocks("prov-4", [(ORANGE, (2, 6, 2, 8))], CREAM, noise=2, seed=44), image_id="cream"),
        _image(_blocks("prov-5", [(ORANGE, (60, 63, 80, 86)), (BLUE, (10, 13, 40, 45))], SAGE, noise=2, seed=45),
               0.5, image_id="sage"),
    ]}


# -- provenance ----------------------------------------------------------------

def test_each_board_colour_lists_its_source_images_by_board_number() -> None:
    analysis = analyze_moodboard(_accent_board())

    assert analysis["version"] == ANALYSIS_VERSION == 6
    by_hex = {colour["hex"]: colour for colour in analysis["colors"]}
    navy, cream, sage = (c for c in analysis["colors"] if c["role"] == "dominant")
    assert [s["number"] for s in navy["sources"]] == [2] and navy["sources"][0]["id"] == "navy"
    assert [s["number"] for s in cream["sources"]] == [4] and [s["number"] for s in sage["sources"]] == [5]
    # Weights 1, 1 and 0.5 (weight 0 and excluded images don't count): parts 0.4, 0.4, 0.2.
    assert navy["sources"][0] == {"number": 2, "id": "navy", "share": 1.0, "contribution": 0.4}
    assert sage["sources"][0]["contribution"] == round(0.2 * sage["sources"][0]["share"], 4)

    orange, blue = (c for c in analysis["colors"] if c["role"] == "accent")
    assert orange["images"] == 2
    # Sorted by contribution: image 4 (part 0.4) gives more than image 5 (part 0.2).
    assert [s["number"] for s in orange["sources"]] == [4, 5]
    assert [s["id"] for s in orange["sources"]] == ["cream", "sage"]
    contributions = [s["contribution"] for s in orange["sources"]]
    assert contributions == sorted(contributions, reverse=True)
    for colour in by_hex.values():
        assert abs(sum(s["contribution"] for s in colour["sources"]) - colour["share"]) < 0.0003
        assert len(colour["sources"]) == colour["images"]
    assert [s["number"] for s in blue["sources"]] == [5]


def test_each_image_says_its_number_and_keeps_its_colours() -> None:
    analysis = analyze_moodboard(_accent_board())

    # Set-aside image 1 and weight-0 image 3 are measured, but sources never name them.
    assert [(item["number"], item["id"], item.get("setAside")) for item in analysis["images"]] == [
        (1, "ex", True), (2, "navy", None), (3, "zero", None), (4, "cream", None), (5, "sage", None)]
    assert analysis["images"][0]["colors"] and analysis["images"][0]["status"] == "analyzed"
    cream = analysis["images"][3]
    assert [(c["share"] > 0.9, c["accent"]) for c in cream["colors"]] == [(True, False), (False, True)]
    named = {s["number"] for colour in analysis["colors"] for s in colour["sources"]}
    assert named == {2, 4, 5}


def _steering(number: int, weight: float, *colours: tuple[str, float, bool]) -> _Steering:
    return _Steering(weight, [{"hex": h, "share": s, "accent": a} for h, s, a in colours], number, f"img{number}")


def test_colours_from_one_image_that_merge_add_up_in_its_source() -> None:
    # Image 1 has two reds about dE00 3 apart (Commons merges within an image,
    # but a hand-made list shows the roll-up's own merge); image 2 has one.
    dominant, accents = _roll_up([
        _steering(1, 1.0, ("#c83c32", 0.3, False), ("#c4423a", 0.2, False), ("#202020", 0.5, False)),
        _steering(3, 1.0, ("#c83c32", 0.6, False), ("#f0f0f0", 0.4, False)),
    ])

    red = next(c for c in dominant if c["images"] == 2)
    assert red["sources"] == [
        {"number": 3, "id": "img3", "share": 0.6, "contribution": 0.3},
        {"number": 1, "id": "img1", "share": 0.5, "contribution": 0.25},
    ]
    assert red["share"] == 0.55 and accents == []


def test_accent_ranking_still_counts_each_image_once() -> None:
    # Accent A comes from two images in two pieces each; accent B from one
    # image with a larger share. A leads on how much of the board carries it.
    _, accents = _roll_up([
        _steering(1, 1.0, ("#808080", 0.98, False), ("#1e64f0", 0.01, True), ("#1a5ff0", 0.005, True)),
        _steering(2, 1.0, ("#808080", 0.95, False), ("#1e64f0", 0.004, True), ("#e6c81e", 0.04, True)),
    ])
    assert accents[0]["images"] == 2 and accents[0]["hex"] != "#e6c81e"
    assert [s["number"] for s in accents[0]["sources"]] == [1, 2]
    assert accents[0]["sources"][0]["share"] == 0.015


# -- thresholds -----------------------------------------------------------------

def test_commons_measures_the_same_with_and_without_explicit_defaults() -> None:
    pixels = np.full((40, 60, 3), CREAM, dtype=np.uint8)
    pixels[2:5, 2:6] = ORANGE
    img = Image.fromarray(pixels)
    assert measure_image(img) == measure_image(img, accent_min_chroma=40.0, accent_separation=10.0,
                                               merge_delta_e=5.0)
    # The accent goes once it must be more saturated than it is.
    assert not any(e["is_accent"] for e in measure_image(img, accent_min_chroma=120)["palette"])


@pytest.mark.parametrize("raw, message", [
    ({"mergeDeltaE": -1}, "mergeDeltaE must be from 0 to 50 (got -1)"),
    ({"accentMinChroma": 151}, "accentMinChroma must be from 0 to 150"),
    ({"accentSeparation": "5"}, "accentSeparation must be a number from 0 to 100"),
    ({"accentSeparation": True}, "accentSeparation must be a number"),
    ({"mergeDeltaE": float("nan")}, "mergeDeltaE must be a number"),
    ({"mergeDelta": 3}, "unknown threshold mergeDelta"),
    ([1], "thresholds must be an object"),
])
def test_thresholds_out_of_range_are_refused(raw, message) -> None:
    with pytest.raises(ValueError, match=message.replace("(", r"\(").replace(")", r"\)")):
        parse_thresholds(raw)


def test_thresholds_left_out_keep_their_defaults() -> None:
    assert parse_thresholds(None) == Thresholds() == parse_thresholds({"mergeDeltaE": None})
    assert parse_thresholds({"mergeDeltaE": 8}) == Thresholds(merge_delta_e=8.0)
    assert Thresholds().as_json() == {"accentMinChroma": 40.0, "accentSeparation": 10.0, "mergeDeltaE": 5.0}


def test_a_dry_run_with_thresholds_doesnt_change_the_next_default_analysis() -> None:
    board = _accent_board()
    before = analyze_moodboard(board)
    tried = analyze_moodboard(board, thresholds=Thresholds(accent_min_chroma=120.0))
    after = analyze_moodboard(board)

    assert tried["accents"] == [] and before["accents"]
    assert after["palette"] == before["palette"] and after["accents"] == before["accents"]
    assert after["colors"] == before["colors"]


def test_colour_changes_name_added_removed_nudged_and_reordered() -> None:
    same = colour_changes(["#112233", "#ddeeff"], ["#112233", "#ddeeff"])
    assert same["changed"] is False

    moved = colour_changes(["#112233", "#ddeeff", "#ff0000"], ["#ddeeff", "#112234", "#00ff00"])
    assert moved["added"] == ["#00ff00"] and moved["removed"] == ["#ff0000"]
    assert moved["nudged"] == [{"from": "#112233", "to": "#112234"}]
    assert moved["reordered"] is True and moved["changed"] is True

    first = colour_changes([], ["#112233"])
    assert first["added"] == ["#112233"] and first["reordered"] is False


def test_dry_run_compares_with_the_saved_analysis_and_brief() -> None:
    board = {**_accent_board(), "id": "b1", "avoid": ["neon"]}
    board["analysis"] = analyze_moodboard(board)

    unchanged = dry_run(board)
    assert unchanged["saved"] == {"analyzed": True, "current": True}
    assert not any(change["changed"] for change in unchanged["changes"].values())
    assert unchanged["brief"]["negativePrompt"] == "blurry, low-detail artifacts, neon"

    result = dry_run(board, Thresholds(accent_min_chroma=120.0))
    accents = result["changes"]["accents"]
    assert accents["changed"] and accents["after"] == [] and len(accents["removed"]) == 2
    assert result["changes"]["brief"]["changed"]
    assert "Accent colors" in result["changes"]["brief"]["before"]
    assert "Accent colors" not in result["changes"]["brief"]["after"]
    assert result["changes"]["negativePrompt"]["changed"] is False
    assert result["thresholds"]["accentMinChroma"] == 120.0 and result["defaults"]["accentMinChroma"] == 40.0

    fresh = dry_run({**board, "analysis": None})
    assert fresh["saved"] == {"analyzed": False, "current": False}
    assert fresh["changes"]["palette"]["added"] == fresh["analysis"]["palette"]


# -- the route ------------------------------------------------------------------

def _stored_files(root) -> dict[str, bytes]:
    return {str(path.relative_to(root)): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def test_the_dry_run_route_saves_and_broadcasts_nothing(app, tmp_path, monkeypatch):  # noqa: F811
    import main as main_module

    sent = []

    async def record(data):
        sent.append(data)

    monkeypatch.setattr(main_module.manager, "broadcast_raw", record)
    board = app.api.request("POST", "/api/moodboards", json={
        "name": "Dry", "images": [{"url": img["url"], "weight": img["weight"], "excluded": img["excluded"]}
                                  for img in _accent_board()["images"]]})
    app.api.request("POST", f"/api/moodboards/{board['id']}/analyze")
    root = tmp_path / "moodboards"
    sent.clear()
    stored = _stored_files(root)
    saved = app.api.request("GET", f"/api/moodboards/{board['id']}")

    result = app.api.request("POST", f"/api/moodboards/{board['id']}/analyze/dry-run",
                             json={"thresholds": {"accentMinChroma": 120}})
    plain = app.api.request("POST", f"/api/moodboards/{board['id']}/analyze/dry-run")

    assert _stored_files(root) == stored and sent == []
    assert app.api.request("GET", f"/api/moodboards/{board['id']}") == saved
    assert result["dryRun"] is True and result["changes"]["accents"]["changed"]
    assert plain["changes"]["accents"]["changed"] is False and plain["analysis"]["accents"] == saved["analysis"][
        "accents"]


@pytest.mark.parametrize("body, status, detail", [
    ({"thresholds": {"mergeDeltaE": 99}}, 422, "mergeDeltaE must be from 0 to 50 (got 99)"),
    ({"thresholds": {"accentMinChroma": "high"}}, 422, "accentMinChroma must be a number from 0 to 150"),
    ({"thresholds": {"chroma": 3}}, 422, None),
    ({"dryRun": True}, 422, None),
])
def test_the_dry_run_route_refuses_nonsense(app, tmp_path, body, status, detail):  # noqa: F811
    board = app.api.request("POST", "/api/moodboards", json={"name": "Dry", "images": []})
    with pytest.raises(NebulaAPIError) as caught:
        app.api.request("POST", f"/api/moodboards/{board['id']}/analyze/dry-run", json=body)
    assert caught.value.status == status
    if detail:
        assert caught.value.detail == detail
    with pytest.raises(NebulaAPIError) as missing:
        app.api.request("POST", "/api/moodboards/nope/analyze/dry-run")
    assert missing.value.status == 404


# -- CLI and MCP ----------------------------------------------------------------

def _made(app) -> dict:  # noqa: F811
    images = [{"url": img["url"], "weight": img["weight"], "excluded": img["excluded"]}
              for img in _accent_board()["images"]]
    board = app.api.request("POST", "/api/moodboards", json={"name": "Prov", "images": images})
    app.api.request("POST", f"/api/moodboards/{board['id']}/analyze")
    return board


def test_cli_show_prints_each_colour_with_share_and_source_images(app, capsys):  # noqa: F811
    board = _made(app)
    shown = _cli(app, ["moodboard", "show", board["id"]], capsys)

    assert "Palette (share of the board · images it comes from, with its share of each):" in shown
    analysis = boards.get_board(app.api, board["id"])["analysis"]
    orange = next(c for c in analysis["colors"] if c["role"] == "accent" and c["images"] == 2)
    # Sources largest contribution first, each with the colour's share of that image.
    assert f"      {orange['hex']}   0.19%  #4 0.35%, #5 0.26%" in shown
    navy = analysis["colors"][0]
    assert f"{navy['hex']}     40%  #2 100%" in shown

    data = json.loads(_cli(app, ["moodboard", "show", board["id"], "--json"], capsys))
    assert data["analysis"]["colors"][0]["sources"][0]["number"] == 2


def test_cli_show_says_to_analyze_again_for_an_analysis_without_sources(app, capsys):  # noqa: F811
    board = _made(app)
    analysis = boards.get_board(app.api, board["id"])["analysis"]
    old = {**analysis, "version": 3, "colors": [{k: v for k, v in c.items() if k != "sources"}
                                                for c in analysis["colors"]]}
    app.api.request("PUT", f"/api/moodboards/{board['id']}", json={"analysis": old})

    shown = _cli(app, ["moodboard", "show", board["id"]], capsys)
    assert f"Palette: {' '.join(analysis['palette'])}" in shown
    assert f"Analyze again to see which images each colour comes from: `nebula moodboard analyze {board['id']}`" \
        in shown


def test_cli_dry_run_prints_changes_and_saves_nothing(app, tmp_path, capsys):  # noqa: F811
    board = _made(app)
    stored = _stored_files(tmp_path / "moodboards")

    out = _cli(app, ["moodboard", "analyze", board["id"], "--dry-run", "--accent-min-chroma", "120"], capsys)
    assert f"Dry run for Prov ({board['id']}). Nothing was saved." in out
    assert "accent min chroma 120 (default 40) · accent separation 10 · merge dE 5" in out
    # At chroma 120 the oranges and blue are no longer accents, so they join the palette.
    assert "    Palette: changed\n      added #f06e1e #145ae6\n      was: #1e285a #ebe1cd #789678" in out
    assert "    Accents: changed\n      removed #f06e1e #145ae6" in out
    assert "    Brief generators get: changed" in out
    assert "Negative prompt: unchanged (blurry, low-detail artifacts)" in out

    data = json.loads(_cli(app, ["moodboard", "analyze", board["id"], "--dry-run", "--json"], capsys))
    assert data["dryRun"] is True and data["saved"]["current"] is True
    assert set(data["changes"]) == {"palette", "accents", "brief", "generatedBrief", "negativePrompt"}
    assert data["analysis"]["colors"][0]["sources"] and data["brief"]["styleBrief"]
    assert _stored_files(tmp_path / "moodboards") == stored


def test_cli_refuses_thresholds_without_dry_run(app, capsys):  # noqa: F811
    board = _made(app)
    with pytest.raises(SystemExit):
        _cli(app, ["moodboard", "analyze", board["id"], "--merge-delta-e", "8"], capsys)
    assert "thresholds work only with --dry-run" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        _cli(app, ["moodboard", "analyze", board["id"], "--dry-run", "--merge-delta-e", "80"], capsys)
    assert "thresholds: mergeDeltaE must be from 0 to 50 (got 80)" in capsys.readouterr().err


def test_a_dry_run_on_a_nebula_without_it_never_falls_back_to_saving(capsys, monkeypatch):
    calls = []

    class _OldAPI:
        def request(self, method, path, **kwargs):
            calls.append((method, path))
            if method == "GET":
                return {"id": "mb_old", "name": "Old", "images": []}
            raise NebulaAPIError("Not Found", status=404)

    monkeypatch.setattr(NebulaClient, "api", property(lambda self: _OldAPI()))
    with pytest.raises(SystemExit):
        moodboard_cmd.run(NebulaClient("http://testserver"),
                          build_parser().parse_args(["moodboard", "analyze", "mb_old", "--dry-run"]))
    assert "has no dry run" in capsys.readouterr().err
    assert calls == [("GET", "/api/moodboards/mb_old"), ("POST", "/api/moodboards/mb_old/analyze/dry-run")]


def test_mcp_analyze_dry_run_and_thresholds(app, tmp_path):  # noqa: F811
    board = _made(app)
    stored = _stored_files(tmp_path / "moodboards")

    result = mcp_server.moodboard_analyze(board["id"], dry_run=True, accent_min_chroma=120)
    assert result["dryRun"] is True and result["changes"]["accents"]["after"] == []
    assert _stored_files(tmp_path / "moodboards") == stored
    with pytest.raises(RuntimeError, match="work only with dry_run"):
        mcp_server.moodboard_analyze(board["id"], merge_delta_e=8)
    with pytest.raises(RuntimeError, match="accentSeparation must be from 0 to 100"):
        mcp_server.moodboard_analyze(board["id"], dry_run=True, accent_separation=101)
    saved = mcp_server.moodboard_analyze(board["id"])
    assert saved["analysis"]["colors"][0]["sources"][0]["number"] == 2
