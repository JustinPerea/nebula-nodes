#!/usr/bin/env python3
"""zoom_from_manifest.py — apply zoom-and-hold using a Daedalus zoom manifest.

Replaces Chris Lema's chain step 3 (OpenCV face-detection zoom) with
agent-telemetry-driven zoom for the Daedalus demo recording. Each entry in
the zoom manifest (produced by the frontend's useZoomManifest hook) marks a
canvas mutation event with a node ID, screen-space bounds, and timestamp.
This script generates ffmpeg crop+scale segments that hold on each node as
it appears, then return to full frame.

Pipeline position:

    raw recording
        ↓ Chris step 1 (remove-silence)
    trimmed.mp4 + segment_map.json
        ↓ THIS SCRIPT
    zoomed.mp4
        ↓ Chris steps 4-5 (color, audio)
    final.mp4

Inputs:
- trimmed.mp4 (output of Chris's silence removal)
- segment_map.json (also output of step 1 — maps trimmed→original timestamps)
- zoom-manifest-<session>.json (frontend-emitted, output/ directory)
- recording_started_at: Unix epoch when Screen Studio began recording (used
  to convert manifest's absolute timestamps to recording-relative times)

Usage:
    python3 zoom_from_manifest.py \\
        --input mydemo_trimmed.mp4 \\
        --segment-map mydemo_segment_map.json \\
        --manifest output/zoom-manifest-20260427_001234.json \\
        --recording-started-at 1745784000.0 \\
        --output mydemo_zoomed.mp4
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

DEFAULT_HOLD_SECONDS = 1.5
PADDING_FRACTION = 0.4  # 40% padding around each node so it has breathing room


def trimmed_to_original(trimmed_time: float, segments: list[dict]) -> float:
    """Map a timestamp on the trimmed timeline back to the original recording."""
    for seg in segments:
        if seg["trimmed_start"] <= trimmed_time <= seg["trimmed_end"]:
            return seg["original_start"] + (trimmed_time - seg["trimmed_start"])
    return trimmed_time  # fallback


def original_to_trimmed(original_time: float, segments: list[dict]) -> float | None:
    """Inverse of trimmed_to_original. Returns None if the original time
    fell into a removed silence — meaning the manifest event happened during
    a moment the silence-cut step deleted, and there's nowhere to anchor it
    in the trimmed timeline."""
    for seg in segments:
        if seg["original_start"] <= original_time <= seg["original_end"]:
            return seg["trimmed_start"] + (original_time - seg["original_start"])
    return None


def probe_video(path: Path) -> tuple[int, int, float]:
    """Return (width, height, duration_seconds) via ffprobe."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,duration",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True, check=True,
    )
    info = json.loads(result.stdout)["streams"][0]
    return int(info["width"]), int(info["height"]), float(info["duration"])


def build_render_segments(
    events: list[dict],
    video_duration: float,
    hold_seconds: float,
) -> list[dict]:
    """Interleave 'normal' (full-frame) and 'zoom' segments covering the
    full video duration. Later events override earlier ones if they overlap.
    """
    events = sorted(events, key=lambda e: e["ts"])
    segments: list[dict] = []
    cursor = 0.0
    for evt in events:
        zoom_start = evt["ts"]
        zoom_end = min(zoom_start + hold_seconds, video_duration)
        if zoom_start > cursor:
            segments.append({"type": "normal", "start": cursor, "end": zoom_start})
        # Overlapping zoom: later wins, but truncate so we don't backtrack.
        if zoom_start < cursor:
            zoom_start = cursor
            if zoom_start >= zoom_end:
                continue
        segments.append(
            {
                "type": "zoom",
                "start": zoom_start,
                "end": zoom_end,
                "bounds": evt["bounds"],
                "node_id": evt["node_id"],
            }
        )
        cursor = zoom_end
    if cursor < video_duration:
        segments.append({"type": "normal", "start": cursor, "end": video_duration})
    return segments


def crop_args_for_bounds(
    bounds: dict,
    video_w: int,
    video_h: int,
    padding: float,
    bounds_scale: float = 1.0,
) -> tuple[int, int, int, int]:
    """Compute even-dimension crop window from a node's bounding rect with
    padding, clamped to video bounds. Returns (cw, ch, cx, cy).

    `bounds_scale` multiplies all coordinates — use 2.0 when the manifest
    captured CSS pixels (logical) and the recording is at physical pixels
    (Retina 2x). The hook should already do this multiplication going
    forward, but this flag lets us salvage older manifests."""
    bw = bounds["width"] * bounds_scale
    bh = bounds["height"] * bounds_scale
    bx = bounds["x"] * bounds_scale
    by = bounds["y"] * bounds_scale
    cw = int(bw * (1 + padding))
    ch = int(bh * (1 + padding))
    cx = int(bx - bw * padding / 2)
    cy = int(by - bh * padding / 2)
    # Clamp to video bounds.
    cx = max(0, min(cx, video_w - 2))
    cy = max(0, min(cy, video_h - 2))
    cw = min(cw, video_w - cx)
    ch = min(ch, video_h - cy)
    # libx264 requires even dimensions.
    cw -= cw % 2
    ch -= ch % 2
    cx -= cx % 2
    cy -= cy % 2
    return cw, ch, cx, cy


def build_filter_script(
    segments: list[dict],
    video_w: int,
    video_h: int,
    padding: float,
    bounds_scale: float = 1.0,
) -> str:
    """Generate the ffmpeg filter_complex script that produces the zoomed video."""
    lines: list[str] = []
    for i, seg in enumerate(segments):
        if seg["type"] == "normal":
            lines.append(
                f"[0:v]trim=start={seg['start']:.3f}:end={seg['end']:.3f},"
                f"setpts=PTS-STARTPTS[v{i}]"
            )
        else:
            cw, ch, cx, cy = crop_args_for_bounds(
                seg["bounds"], video_w, video_h, padding, bounds_scale
            )
            lines.append(
                f"[0:v]trim=start={seg['start']:.3f}:end={seg['end']:.3f},"
                f"setpts=PTS-STARTPTS,"
                f"crop={cw}:{ch}:{cx}:{cy},"
                f"scale={video_w}:{video_h}:flags=lanczos[v{i}]"
            )
    n = len(segments)
    concat_in = "".join(f"[v{i}]" for i in range(n))
    lines.append(f"{concat_in}concat=n={n}:v=1:a=0[outv]")
    return ";\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--segment-map", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument(
        "--recording-started-at",
        required=True,
        type=float,
        help="Unix epoch when Screen Studio began recording.",
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--hold", type=float, default=DEFAULT_HOLD_SECONDS,
        help=f"Seconds to hold each zoom (default {DEFAULT_HOLD_SECONDS})",
    )
    parser.add_argument(
        "--padding", type=float, default=PADDING_FRACTION,
        help=f"Fractional padding around each node (default {PADDING_FRACTION})",
    )
    parser.add_argument(
        "--bounds-scale", type=float, default=1.0,
        help=(
            "Multiply manifest bounds by this factor before cropping. "
            "Use 2.0 if the manifest captured CSS pixels (logical) and the "
            "recording is at physical pixels (Retina displays). Going forward "
            "the hook applies devicePixelRatio itself, so this defaults to 1.0."
        ),
    )
    args = parser.parse_args()

    if not args.input.exists():
        print(f"error: input video not found: {args.input}", file=sys.stderr)
        return 1
    if not args.segment_map.exists():
        print(f"error: segment map not found: {args.segment_map}", file=sys.stderr)
        return 1
    if not args.manifest.exists():
        print(f"error: zoom manifest not found: {args.manifest}", file=sys.stderr)
        return 1

    manifest = json.loads(args.manifest.read_text())
    segment_map = json.loads(args.segment_map.read_text())
    if isinstance(segment_map, dict) and "segments" in segment_map:
        segments_list = segment_map["segments"]
    else:
        segments_list = segment_map  # assume bare list

    video_w, video_h, video_dur = probe_video(args.input)
    print(f"video: {video_w}x{video_h}, {video_dur:.2f}s")

    manifest_start = manifest["started_at"]
    events: list[dict] = []
    skipped_pre = skipped_silence = 0
    for entry in manifest["entries"]:
        absolute_ts = manifest_start + entry["ts"]
        original_ts = absolute_ts - args.recording_started_at
        if original_ts < 0:
            skipped_pre += 1
            continue
        trimmed_ts = original_to_trimmed(original_ts, segments_list)
        if trimmed_ts is None:
            skipped_silence += 1
            continue
        events.append(
            {
                "ts": trimmed_ts,
                "bounds": entry["bounds"],
                "node_id": entry["node_id"],
            }
        )

    print(
        f"manifest entries: {len(manifest['entries'])} total, "
        f"{len(events)} usable "
        f"({skipped_pre} pre-recording, {skipped_silence} in cut silences)"
    )
    if not events:
        print("no usable zoom events — copying input to output unchanged")
        subprocess.run(["cp", str(args.input), str(args.output)], check=True)
        return 0

    render_segments = build_render_segments(events, video_dur, args.hold)
    n_zoom = sum(1 for s in render_segments if s["type"] == "zoom")
    print(f"render segments: {len(render_segments)} ({n_zoom} zoom holds)")

    filter_script = build_filter_script(
        render_segments, video_w, video_h, args.padding, args.bounds_scale
    )
    filter_path = Path(f"/tmp/zoom_manifest_filter_{os.getpid()}.txt")
    filter_path.write_text(filter_script)

    try:
        cmd = [
            "ffmpeg", "-y", "-i", str(args.input),
            "-filter_complex_script", str(filter_path),
            "-map", "[outv]", "-map", "0:a",
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            str(args.output),
        ]
        print(f"\nrunning: {' '.join(cmd)}\n")
        subprocess.run(cmd, check=True)
        print(f"\ndone: {args.output}")
        return 0
    finally:
        filter_path.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
