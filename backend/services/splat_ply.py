"""Read a 3D Gaussian Splatting PLY (the standard "3DGS" layout) safely.

One reader for every backend consumer of a splat PLY: the Idol handler checks
what the Space returned before it becomes a World v2 value, and MCP
``view_output`` summarizes it for agents, who can't see 3D otherwise.

The layout is the one the original 3DGS code and most tools write (Idol's
``idol/gaussian.py`` ``save_ply``, read 2026-10-29): one ``vertex`` element,
binary little-endian, float properties ``x y z`` (position), optional ``nx ny
nz``, ``f_dc_0..2`` (degree-0 spherical harmonics), optional ``f_rest_*``,
``opacity`` (before the sigmoid), ``scale_0..2`` (log scale) and ``rot_0..3``
(a quaternion, w first). Nothing else: no faces, no other elements.

The bounds mirror the browser's preflight (frontend/src/lib/splatPly.ts): at
most 2,000,000 Gaussians and 128 MiB, the same caps the SPZ world preview has.
Stdlib only for the header; numpy only in :func:`summarize_splat_ply`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SPLAT_PLY_MAX_POINTS = 2_000_000
SPLAT_PLY_MAX_BYTES = 128 * 1024 * 1024
SPLAT_PLY_MAX_HEADER_BYTES = 64 * 1024

REQUIRED_PROPERTIES: tuple[str, ...] = (
    "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
    "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
)
_OPTIONAL = re.compile(r"(?:nx|ny|nz|f_rest_[0-9]{1,2})")
_FLOAT_TYPES = {"float", "float32"}
_SH_REST_BY_DEGREE = {0: 0, 1: 9, 2: 24, 3: 45}


class SplatPlyError(ValueError):
    """The bytes aren't a 3DGS PLY Nebula can read, or are past its bounds."""


@dataclass(frozen=True)
class SplatPlyHeader:
    vertex_count: int
    properties: tuple[str, ...]
    header_bytes: int
    stride: int
    sh_degree: int

    @property
    def expected_bytes(self) -> int:
        return self.header_bytes + self.vertex_count * self.stride


def parse_splat_ply_header(prefix: bytes, *, max_points: int = SPLAT_PLY_MAX_POINTS) -> SplatPlyHeader:
    """The header of a 3DGS PLY from the file's first bytes (at least the
    header). Raises SplatPlyError on anything outside the layout above."""
    window = prefix[:SPLAT_PLY_MAX_HEADER_BYTES]
    match = re.search(br"(?:^|\n)end_header\n", window)
    if not window.startswith(b"ply\n") or match is None:
        raise SplatPlyError("not a PLY file, or its header is longer than 64 KiB")
    header = window[: match.end()]
    try:
        text = header.decode("ascii")
    except UnicodeDecodeError as exc:
        raise SplatPlyError("the PLY header isn't ASCII") from exc
    lines = [line.strip() for line in text.split("\n")[1:] if line.strip()]
    if lines[-1:] != ["end_header"]:
        raise SplatPlyError("the PLY header doesn't end with end_header")
    vertex_count: int | None = None
    properties: list[str] = []
    seen_format = False
    for line in lines[:-1]:
        parts = line.split()
        if parts[0] in {"comment", "obj_info"}:
            continue
        if parts[0] == "format":
            if parts[1:] != ["binary_little_endian", "1.0"]:
                raise SplatPlyError(f"only binary little-endian 3DGS PLY is supported, not {' '.join(parts[1:])}")
            seen_format = True
        elif parts[0] == "element":
            if len(parts) != 3 or parts[1] != "vertex" or vertex_count is not None:
                raise SplatPlyError("a 3DGS PLY has exactly one element, vertex")
            if not parts[2].isdigit() or len(parts[2]) > 10:
                raise SplatPlyError("the vertex count isn't a whole number")
            vertex_count = int(parts[2])
        elif parts[0] == "property":
            if vertex_count is None:
                raise SplatPlyError("a property comes before the vertex element")
            if len(parts) != 3 or parts[1] not in _FLOAT_TYPES:
                raise SplatPlyError(f"every 3DGS property is a float; {' '.join(parts[1:])} isn't")
            name = parts[2]
            if name in properties:
                raise SplatPlyError(f"property {name} appears twice")
            if name not in REQUIRED_PROPERTIES and not _OPTIONAL.fullmatch(name):
                raise SplatPlyError(f"property {name} isn't part of the 3DGS layout")
            properties.append(name)
        else:
            raise SplatPlyError(f"unexpected PLY header line {parts[0]}")
    if not seen_format:
        raise SplatPlyError("the PLY header has no format line")
    if vertex_count is None or vertex_count <= 0:
        raise SplatPlyError("the PLY has no Gaussians")
    missing = [name for name in REQUIRED_PROPERTIES if name not in properties]
    if missing:
        raise SplatPlyError(f"the PLY is missing 3DGS properties {', '.join(missing)}")
    rest_names = {name for name in properties if name.startswith("f_rest_")}
    rest = len(rest_names)
    degrees = [degree for degree, count in _SH_REST_BY_DEGREE.items() if count == rest]
    if not degrees:
        raise SplatPlyError(f"{rest} f_rest properties match no spherical-harmonics degree")
    # Spark reads f_rest_0 .. f_rest_{n-1} by name: a set with a gap or a
    # stray index (f_rest_0..7 and f_rest_20) has the right count but no
    # coefficient Spark can find, and it throws.
    if rest_names != {f"f_rest_{index}" for index in range(rest)}:
        raise SplatPlyError(f"the f_rest properties aren't f_rest_0 to f_rest_{rest - 1}")
    if vertex_count > max_points:
        raise SplatPlyError(f"the PLY declares {vertex_count:,} Gaussians, above the {max_points:,} limit")
    return SplatPlyHeader(
        vertex_count=vertex_count, properties=tuple(properties), header_bytes=len(header),
        stride=4 * len(properties), sh_degree=degrees[0],
    )


def validate_splat_ply(
    path: str | Path, *, max_points: int = SPLAT_PLY_MAX_POINTS, max_bytes: int = SPLAT_PLY_MAX_BYTES,
) -> SplatPlyHeader:
    """Check a whole 3DGS PLY file: header, bounds, and that its size is exactly
    the header plus one record per Gaussian (no truncation, no trailing data)."""
    file_path = Path(path)
    size = file_path.stat().st_size
    if size > max_bytes:
        raise SplatPlyError(f"the PLY is {size:,} bytes, above the {max_bytes:,}-byte limit")
    with file_path.open("rb") as handle:
        header = parse_splat_ply_header(handle.read(SPLAT_PLY_MAX_HEADER_BYTES), max_points=max_points)
    if size != header.expected_bytes:
        raise SplatPlyError(
            f"the PLY is {size:,} bytes but its header describes {header.expected_bytes:,}")
    return header


def summarize_splat_ply(path: str | Path) -> dict[str, Any]:
    """What an agent can know about a splat without seeing it: Gaussian count,
    bounding box (positions as stored, before any viewer transform), file
    size, spherical-harmonics degree, and the opacity spread. Reads the
    positions through a memory map, so a 71 MB file isn't copied."""
    import numpy as np

    header = validate_splat_ply(path)
    dtype = np.dtype([(name, "<f4") for name in header.properties])
    records = np.memmap(Path(path), dtype=dtype, mode="r", offset=header.header_bytes, shape=(header.vertex_count,))
    xyz = np.stack([records["x"], records["y"], records["z"]], axis=1)
    finite = np.isfinite(xyz).all(axis=1)
    if not finite.any():
        raise SplatPlyError("no Gaussian has a finite position")
    points = xyz[finite]
    low, high = points.min(axis=0), points.max(axis=0)
    opacity = 1.0 / (1.0 + np.exp(-np.clip(records["opacity"].astype(np.float64), -60.0, 60.0)))
    summary = {
        "format": "ply",
        "gaussians": header.vertex_count,
        "fileBytes": Path(path).stat().st_size,
        "shDegree": header.sh_degree,
        "boundingBox": {
            "min": [round(float(value), 6) for value in low],
            "max": [round(float(value), 6) for value in high],
            "size": [round(float(value), 6) for value in high - low],
        },
        "nonFinitePositions": int((~finite).sum()),
        "meanOpacity": round(float(opacity.mean()), 4),
        "visibleShare": round(float((opacity > 0.1).mean()), 4),
    }
    del records
    return summary
