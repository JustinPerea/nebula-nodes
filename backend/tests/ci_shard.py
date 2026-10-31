"""Splits the backend suite into parts, one per CI job (NEBULA_TEST_SHARD="2/3").

Whole files stay together, since a file's module fixtures and test order can
matter. Files go, largest first, to the part with the fewest tests so far, so
the parts hold about the same number of tests. Every job collects the same
files and assigns them the same way, so the parts never overlap and together
hold every test.
"""
from __future__ import annotations

from collections.abc import Mapping


def parse_shard(value: str) -> tuple[int, int]:
    """"2/3" -> (2, 3). Raises ValueError for anything else."""
    part, _, total = value.partition("/")
    try:
        index, count = int(part), int(total)
    except ValueError:
        index = count = 0
    if not 1 <= index <= count:
        raise ValueError(f'NEBULA_TEST_SHARD must look like "2/3" (part 2 of 3), not {value!r}')
    return index, count


def assign_files(tests_per_file: Mapping[str, int], count: int) -> dict[str, int]:
    """Maps each file to its part, 1 to count."""
    loads = [0] * count
    parts: dict[str, int] = {}
    for path, size in sorted(tests_per_file.items(), key=lambda entry: (-entry[1], entry[0])):
        part = min(range(count), key=lambda i: (loads[i], i))
        parts[path] = part + 1
        loads[part] += size
    return parts
