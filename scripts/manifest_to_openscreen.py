#!/usr/bin/env python3
"""manifest_to_openscreen.py — rewrite an OpenScreen project's zoomRegions
from a Daedalus zoom manifest.

OpenScreen's project file (.openscreen — JSON) contains a zoomRegions array
of objects with normalized focus coords (cx, cy as 0-1 fractions of frame),
startMs, endMs, and depth. By default OpenScreen auto-generates these from
cursor activity. This script REPLACES that array with regions derived from
our zoom manifest, so the editor renders zoom-on-node-as-Daedalus-builds-it
instead of zoom-on-cursor-where-the-user-pointed.

OpenScreen handles all coordinate alignment internally — we only have to
supply the focus point as a fraction of the frame. Resolution-independent.

Usage:
    python3 manifest_to_openscreen.py \\
        --project ~/Desktop/recording-XXX.openscreen \\
        --manifest output/zoom-manifest-XXX.json \\
        --recording-started-at 1777255115.232 \\
        --recording-width 2832 --recording-height 1748 \\
        --output ~/Desktop/recording-XXX-daedalus.openscreen
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DEFAULT_HOLD_MS = 1500
DEFAULT_DEPTH = 3  # OpenScreen: 1 (light) through 3 (tight)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--recording-started-at", required=True, type=float)
    parser.add_argument("--recording-width", required=True, type=int)
    parser.add_argument("--recording-height", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--hold-ms", type=int, default=DEFAULT_HOLD_MS)
    parser.add_argument("--depth", type=int, default=DEFAULT_DEPTH)
    args = parser.parse_args()

    project = json.loads(args.project.read_text())
    manifest = json.loads(args.manifest.read_text())
    rec_w = args.recording_width
    rec_h = args.recording_height

    new_regions = []
    skipped_pre = 0
    skipped_oob = 0
    for i, entry in enumerate(manifest["entries"]):
        absolute_ts = manifest["started_at"] + entry["ts"]
        rec_ts = absolute_ts - args.recording_started_at
        if rec_ts < 0:
            skipped_pre += 1
            continue
        b = entry["bounds"]
        # Center of the node in pixel coords.
        center_x = b["x"] + b["width"] / 2
        center_y = b["y"] + b["height"] / 2
        # Normalize to 0-1 fractions of the recording frame.
        cx = center_x / rec_w
        cy = center_y / rec_h
        if not (0 <= cx <= 1 and 0 <= cy <= 1):
            skipped_oob += 1
            print(
                f"  warning: entry {i} ({entry['node_id']}) center "
                f"({cx:.3f}, {cy:.3f}) is out of frame — skipping",
                file=sys.stderr,
            )
            continue
        start_ms = int(rec_ts * 1000)
        end_ms = start_ms + args.hold_ms
        new_regions.append(
            {
                "id": f"daedalus-{i + 1}",
                "startMs": start_ms,
                "endMs": end_ms,
                "depth": args.depth,
                "focus": {"cx": cx, "cy": cy},
            }
        )

    print(
        f"manifest entries: {len(manifest['entries'])} total, "
        f"{len(new_regions)} usable "
        f"({skipped_pre} pre-recording, {skipped_oob} out-of-frame)"
    )

    project["editor"]["zoomRegions"] = new_regions
    args.output.write_text(json.dumps(project, indent=2))
    print(f"\nwrote: {args.output}")
    print("→ open this file in OpenScreen and export")
    return 0


if __name__ == "__main__":
    sys.exit(main())
