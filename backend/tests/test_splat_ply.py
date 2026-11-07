"""The 3DGS PLY preflight (services/splat_ply.py): the layout, the bounds
(2,000,000 Gaussians, 128 MiB) and the exact length, and the summary."""
from __future__ import annotations

import struct

import numpy as np
import pytest

from services.splat_ply import (
    REQUIRED_PROPERTIES, SPLAT_PLY_MAX_BYTES, SPLAT_PLY_MAX_POINTS, SplatPlyError, parse_splat_ply_header,
    summarize_splat_ply, validate_splat_ply,
)
from tests.speridlabs_fakes import PROPERTIES, splat_ply


def header(count: int, properties=None, *, fmt: str = "binary_little_endian 1.0", extra: str = "") -> bytes:
    names = PROPERTIES if properties is None else properties
    return (f"ply\nformat {fmt}\n{extra}element vertex {count}\n"
            + "".join(f"property float {name}\n" for name in names) + "end_header\n").encode()


def test_the_bounds_are_the_previews():
    assert SPLAT_PLY_MAX_POINTS == 2_000_000
    assert SPLAT_PLY_MAX_BYTES == 128 * 1024 * 1024


def test_idols_layout_parses():
    parsed = parse_splat_ply_header(header(262144))
    assert parsed.vertex_count == 262144 and parsed.stride == 68 and parsed.sh_degree == 0
    assert parsed.expected_bytes == len(header(262144)) + 262144 * 68


@pytest.mark.parametrize("rest, degree", [(9, 1), (24, 2), (45, 3)])
def test_higher_spherical_harmonics_parse(rest, degree):
    names = [*PROPERTIES[:9], *(f"f_rest_{i}" for i in range(rest)), *PROPERTIES[9:]]
    assert parse_splat_ply_header(header(4, names)).sh_degree == degree


def test_the_point_cap_holds_at_its_edge():
    assert parse_splat_ply_header(header(SPLAT_PLY_MAX_POINTS)).vertex_count == SPLAT_PLY_MAX_POINTS
    with pytest.raises(SplatPlyError, match="above the 2,000,000 limit"):
        parse_splat_ply_header(header(SPLAT_PLY_MAX_POINTS + 1))
    with pytest.raises(SplatPlyError, match="above the 10 limit"):
        parse_splat_ply_header(header(11), max_points=10)
    assert parse_splat_ply_header(header(10), max_points=10).vertex_count == 10


@pytest.mark.parametrize("data, message", [
    (b"PLY\n", "not a PLY"),
    (b"ply\nformat binary_little_endian 1.0\nelement vertex 1\n", "not a PLY"),
    (header(4, fmt="ascii 1.0"), "binary little-endian"),
    (header(4, fmt="binary_big_endian 1.0"), "binary little-endian"),
    (header(0), "no Gaussians"),
    (header(4, [n for n in PROPERTIES if n != "opacity"]), "missing 3DGS properties opacity"),
    (header(4, [*PROPERTIES, "x"]), "appears twice"),
    (header(4, [*PROPERTIES, "red"]), "isn't part of the 3DGS layout"),
    (header(4, [*PROPERTIES, "f_rest_0"]), "match no spherical-harmonics degree"),
    (header(4, extra="element face 2\n"), "exactly one element"),
    (b"ply\nformat binary_little_endian 1.0\nelement vertex 4\nproperty double x\nend_header\n", "is a float"),
    (b"ply\nformat binary_little_endian 1.0\nelement vertex -4\nend_header\n", "whole number"),
    (b"ply\nformat binary_little_endian 1.0\nproperty float x\nelement vertex 4\nend_header\n", "comes before"),
    (b"ply\nelement vertex 4\n" + b"".join(f"property float {n}\n".encode() for n in REQUIRED_PROPERTIES)
     + b"end_header\n", "no format line"),
    (b"ply\n" + b"comment " + b"x" * (64 * 1024) + b"\nend_header\n", "not a PLY"),
])
def test_anything_outside_the_layout_is_refused(data, message):
    with pytest.raises(SplatPlyError, match=message):
        parse_splat_ply_header(data)


def test_a_file_must_be_exactly_its_header_plus_its_records(tmp_path):
    path = tmp_path / "s.ply"
    path.write_bytes(splat_ply(32))
    assert validate_splat_ply(path).vertex_count == 32
    for data in (splat_ply(32)[:-1], splat_ply(32) + b"\0"):
        path.write_bytes(data)
        with pytest.raises(SplatPlyError, match="header describes"):
            validate_splat_ply(path)


def test_the_byte_cap_holds_at_its_edge(tmp_path):
    path = tmp_path / "s.ply"
    data = splat_ply(32)
    path.write_bytes(data)
    assert validate_splat_ply(path, max_bytes=len(data)).vertex_count == 32
    with pytest.raises(SplatPlyError, match="byte limit"):
        validate_splat_ply(path, max_bytes=len(data) - 1)


def test_the_summary_reads_positions_and_opacity(tmp_path):
    path = tmp_path / "s.ply"
    values = np.zeros((3, len(PROPERTIES)), dtype="<f4")
    values[:, 0:3] = [[-1, 0, 2], [1, 3, -2], [0, -4, 0]]
    values[:, PROPERTIES.index("opacity")] = [10.0, -10.0, 0.0]
    path.write_bytes(header(3) + values.tobytes())
    summary = summarize_splat_ply(path)
    assert summary["gaussians"] == 3 and summary["fileBytes"] == path.stat().st_size
    assert summary["boundingBox"] == {"min": [-1.0, -4.0, -2.0], "max": [1.0, 3.0, 2.0], "size": [2.0, 7.0, 4.0]}
    assert summary["visibleShare"] == pytest.approx(2 / 3, abs=1e-4)
    assert summary["nonFinitePositions"] == 0


def test_the_summary_skips_non_finite_positions_and_refuses_none(tmp_path):
    path = tmp_path / "s.ply"
    values = np.zeros((2, len(PROPERTIES)), dtype="<f4")
    values[0, 0] = np.nan
    values[1, 0:3] = [0.25, 0.5, 0.75]
    path.write_bytes(header(2) + values.tobytes())
    summary = summarize_splat_ply(path)
    assert summary["nonFinitePositions"] == 1 and summary["boundingBox"]["min"] == [0.25, 0.5, 0.75]
    values[1, 1] = np.inf
    path.write_bytes(header(2) + values.tobytes())
    with pytest.raises(SplatPlyError, match="finite"):
        summarize_splat_ply(path)


def test_the_header_byte_count_is_exact():
    data = header(1) + struct.pack("<17f", *range(17))
    assert parse_splat_ply_header(data).header_bytes == len(header(1))


@pytest.mark.parametrize("rest_names", [
    # The right count for SH degree 1 (9), with a gap and a stray index.
    [*(f"f_rest_{i}" for i in range(8)), "f_rest_20"],
    [*(f"f_rest_{i}" for i in range(1, 10))],
    # Leading zeros name no coefficient Spark reads.
    [*(f"f_rest_{i}" for i in range(8)), "f_rest_08"],
    # 24 for degree 2, with f_rest_23 missing.
    [*(f"f_rest_{i}" for i in range(23)), "f_rest_99"],
])
def test_f_rest_must_be_exactly_zero_to_n_minus_one(rest_names):
    """PR #203 review LOW 5: a set Spark rejects passed on its count alone."""
    names = [*PROPERTIES[:9], *rest_names, *PROPERTIES[9:]]
    with pytest.raises(SplatPlyError, match="f_rest properties aren't f_rest_0 to"):
        parse_splat_ply_header(header(4, names))


def test_f_rest_in_any_order_is_fine():
    names = [*PROPERTIES[:9], *(f"f_rest_{i}" for i in reversed(range(9))), *PROPERTIES[9:]]
    assert parse_splat_ply_header(header(4, names)).sh_degree == 1
