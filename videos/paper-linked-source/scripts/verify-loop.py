#!/usr/bin/env python3
"""Read-only checks of the captured Paper demo's durable run artifacts.

Run with the existing backend virtualenv Python (Pillow is already installed).
Prints JSON to stdout; never calls Paper, refreshes a source, or executes a graph.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3

from PIL import Image


SOURCE_ID = "9ebc189bb3a14c73885a18d2c30988b1"
RUN_A = "ec39bfc5-0c9e-4e2d-af49-9b598ef7488f"
RUN_B = "fd2ff2b2-8c3a-4910-92f9-ff5b23010399"
HASH_A = "685a2efff5ff506694d96473f25de56a559e3eee983daa1a3b224a93636ab0ae"
HASH_B = "225269f6bf0d64f1b5e489f030f23780a93b586c7ae68dae2918ddcea3e995c9"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stamp(value: str) -> datetime:
    return datetime.fromisoformat(value)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def artwork(path: Path) -> dict:
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
        pixels = rgba.tobytes()
        opaque = Counter(tuple(pixels[index:index + 3]) for index in range(0, len(pixels), 4) if pixels[index + 3] == 255)
        color = opaque.most_common(1)[0][0]
        return {
            "width": image.width,
            "height": image.height,
            "dominantOpaqueColor": "#" + "".join(f"{part:02x}" for part in color),
            "hasTransparency": rgba.getchannel("A").getextrema()[0] < 255,
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    root = args.root.resolve()
    output = root / "output/paper-demo"
    demo = root / "videos/paper-linked-source"
    database = output / "paper-sources/sources.sqlite3"
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        row = connection.execute("SELECT record FROM sources WHERE id=?", (SOURCE_ID,)).fetchone()
        require(row is not None, "Demo source missing")
        source = json.loads(row[0])
    receipts = {}
    for path in output.glob("*/paper-inputs.json"):
        receipt = json.loads(path.read_text())
        receipts[receipt["runId"]] = (path, receipt)
    require(set(receipts) == {RUN_A, RUN_B}, "Expected exactly the two recorded demo runs")
    path_a, run_a = receipts[RUN_A]
    path_b, run_b = receipts[RUN_B]
    require(run_a["recipe"] == run_b["recipe"], "Saved recipes differ")
    revision = hashlib.sha256(json.dumps(run_a["recipe"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    require(run_a["recipeRevision"] == run_b["recipeRevision"] == revision, "Recipe revision mismatch")
    expected_edge = {"id": "e1", "source": "n1", "sourceHandle": "image", "target": "n2", "targetHandle": "image"}
    require(run_a["recipe"]["edges"] == [expected_edge], "Demo connection changed")
    snapshots = [run["paperInputs"][0]["snapshot"] for run in (run_a, run_b)]
    require(all(run["paperInputs"][0]["sourceId"] == SOURCE_ID for run in (run_a, run_b)), "Logical source changed")
    require([snap["hash"] for snap in snapshots] == [HASH_A, HASH_B], "Unexpected demo snapshots")
    require(HASH_A != HASH_B, "Artwork did not change")
    history_ids = {snap["id"] for snap in source["snapshots"]}
    require(all(snap["id"] in history_ids for snap in snapshots), "Source history lost a snapshot")
    pictures = []
    for run_path, snap in zip((path_a, path_b), snapshots):
        png = output / "paper-sources" / (snap["id"] + ".png")
        require(digest(png) == snap["hash"], "Immutable snapshot bytes do not match receipt")
        copied = list(run_path.parent.glob("paper-fixture-*.png"))
        require(len(copied) == 1, "Downstream artwork poster missing")
        with Image.open(png) as image, Image.open(copied[0]) as poster:
            logo = image.convert("RGBA")
            expected = Image.new("RGB", logo.size, "white")
            expected.paste(logo, mask=logo.getchannel("A"))
            require(expected.size == poster.size and expected.tobytes() == poster.convert("RGB").tobytes(), "Downstream poster does not composite the exact snapshot artwork")
        manifest = json.loads((run_path.parent / "manifest.json").read_text())
        require(bool(manifest.get("completed_at")), "A recorded run did not complete")
        require(manifest["run_id"] == json.loads(run_path.read_text())["runId"], "Manifest run mismatch")
        require(len(manifest["outputs"]) == 1 and (run_path.parent / manifest["outputs"][0]["output_path"]).is_file(), "Run output missing")
        pictures.append(artwork(png))
    # Actual export pixel colors; Paper's output color profile differs from CSS.
    require(pictures[0]["dominantOpaqueColor"] == "#c953a2", "A is not the pink artwork")
    require(pictures[1]["dominantOpaqueColor"] == "#51a4ca", "B is not the cyan artwork")
    require(all(p["width"] == 480 and p["height"] == 360 and p["hasTransparency"] for p in pictures), "Artwork export geometry/alpha changed")
    refresh = stamp(snapshots[1]["capturedAt"])
    stale_path = demo / "assets/real-ui/canvas-stale-b.jpg"
    ledger = json.loads((demo / "evidence/asset-ledger.json").read_text())
    stale_asset = next(asset for asset in ledger["assets"] if asset["path"] == "assets/real-ui/canvas-stale-b.jpg")
    require(digest(stale_path) == stale_asset["sha256"], "Stale UI capture differs from asset ledger")
    stale_capture = stamp(stale_asset["capturedAt"]) if stale_asset.get("capturedAt") else datetime.fromtimestamp(stale_path.stat().st_mtime, timezone.utc)
    start_a, start_b = stamp(run_a["capturedAt"]), stamp(run_b["capturedAt"])
    require(start_a < refresh < stale_capture < start_b, "Capture no longer demonstrates refresh before rerun")
    require(not any(refresh <= stamp(receipt["capturedAt"]) <= stale_capture for _, receipt in receipts.values()), "A run receipt appeared during refresh/stale capture")
    state = json.loads((output / "state/state.json").read_text())
    require(state["edges"] == [expected_edge], "Current canvas connection changed")
    report = {
        "ok": True,
        "sourceId": SOURCE_ID,
        "runIds": [RUN_A, RUN_B],
        "completedRunCount": len(receipts),
        "recipeRevision": revision,
        "sameSavedRecipeAndConnection": True,
        "bothSnapshotsRetained": True,
        "immutableSnapshotHashesMatchReceipts": True,
        "exactArtworkPixelsComposited": True,
        "artwork": [dict(snapshotId=snap["id"], hash=snap["hash"], **picture) for snap, picture in zip(snapshots, pictures)],
        "timing": {"firstRun": start_a.isoformat(), "refreshB": refresh.isoformat(), "staleCapture": stale_capture.isoformat(), "latestRerun": start_b.isoformat(), "secondsRefreshToRerun": (start_b - refresh).total_seconds()},
        "noRunReceiptBetweenRefreshAndStaleCapture": True,
        "proofCeiling": "Durable local fixture artifacts and capture file timestamps; explicit rerun interaction and visible staleness are supported separately by real UI captures. No paid provider generation is claimed.",
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
