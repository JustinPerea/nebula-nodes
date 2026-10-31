"""CI runs each test suite in parts, one job per part (.github/workflows/ci.yml).
A part that never runs would pass CI silently, so these tests check that the
parts together hold every test, that no test runs twice, and that each job's
matrix and part count agree."""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from tests.ci_shard import assign_files, parse_shard

BACKEND = Path(__file__).resolve().parents[1]
CI = BACKEND.parent / ".github" / "workflows" / "ci.yml"


def test_parse_shard_reads_part_and_count():
    assert parse_shard("1/3") == (1, 3)
    assert parse_shard("3/3") == (3, 3)


@pytest.mark.parametrize("value", ["", "3", "0/3", "4/3", "1/0", "-1/3", "a/3", "1/b", "1/3/5", "/3"])
def test_parse_shard_refuses_anything_else(value):
    with pytest.raises(ValueError, match="NEBULA_TEST_SHARD"):
        parse_shard(value)


def test_every_file_lands_in_exactly_one_part_and_the_parts_are_even():
    sizes = {f"tests/test_{n}.py": (n * 37) % 23 + 1 for n in range(60)}
    parts = assign_files(sizes, 3)
    assert set(parts) == set(sizes)
    assert set(parts.values()) == {1, 2, 3}
    loads = [sum(size for path, size in sizes.items() if parts[path] == part) for part in (1, 2, 3)]
    assert max(loads) - min(loads) <= max(sizes.values())
    # The same input always gives the same split, so separate jobs agree.
    assert assign_files(dict(reversed(list(sizes.items()))), 3) == parts


def _collected(files: list[str], shard: str | None, home: Path) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if k != "NEBULA_TEST_SHARD"}
    env["HOME"] = str(home)
    if shard is not None:
        env["NEBULA_TEST_SHARD"] = shard
    return subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", *files],
        cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120,
    )


def _ids(result: subprocess.CompletedProcess[str]) -> set[str]:
    return {line for line in result.stdout.splitlines() if "::" in line}


def test_the_parts_collected_by_pytest_hold_every_test_once(tmp_path):
    files = ["tests/test_cancellation.py", "tests/test_runway_pricing.py", "tests/test_output_service.py"]
    whole = _collected(files, None, tmp_path)
    assert whole.returncode == 0, whole.stdout + whole.stderr
    every = _ids(whole)
    assert len(every) >= 6
    parts = []
    for index in (1, 2, 3):
        result = _collected(files, f"{index}/3", tmp_path)
        assert result.returncode == 0, result.stdout + result.stderr
        parts.append(_ids(result))
    assert set().union(*parts) == every
    assert sum(len(part) for part in parts) == len(every)
    # Whole files stay together.
    for part in parts:
        for other in parts:
            if part is not other:
                assert not {i.split("::")[0] for i in part} & {i.split("::")[0] for i in other}


def test_a_malformed_shard_stops_the_run(tmp_path):
    result = _collected(["tests/test_cancellation.py"], "2", tmp_path)
    assert result.returncode == 4
    assert "NEBULA_TEST_SHARD" in result.stdout + result.stderr


def _jobs(text: str) -> dict[str, str]:
    body = text.split("\njobs:\n", 1)[1]
    return dict(re.findall(r"^  ([a-z][\w-]*):\n(.*?)(?=^  [a-z][\w-]*:\n|\Z)", body, re.S | re.M))


def test_each_split_job_runs_every_part_of_its_count():
    jobs = _jobs(CI.read_text(encoding="utf-8"))
    split = {name: body for name, body in jobs.items() if "matrix.shard" in body}
    assert set(split) == {"backend", "frontend-tests"}
    for name, body in split.items():
        [listed] = re.findall(r"^\s+shard: \[([\d, ]+)\]$", body, re.M)
        shards = [int(n) for n in listed.split(",")]
        counts = {int(n) for n in re.findall(r"\$\{\{ matrix\.shard \}\}(?:/| of )(\d+)", body)}
        assert len(counts) == 1, (name, counts)
        [count] = counts
        assert shards == list(range(1, count + 1)), (name, shards, count)
        assert "fail-fast: false" in body
        # Nothing may drop or skip a part, or let one fail quietly.
        for word in ("exclude:", "include:", "if:", "continue-on-error"):
            assert word not in body, (name, word)
    # Each part runs its whole share, unnarrowed.
    assert "NEBULA_TEST_SHARD: ${{ matrix.shard }}/" in split["backend"]
    assert re.findall(r"^\s+run: (.*pytest.*)$", split["backend"], re.M) == ["python -m pytest"]
    assert re.findall(r"^\s+run: (npm test.*)$", split["frontend-tests"], re.M) == [
        "npm test -- --shard=${{ matrix.shard }}/3"
    ]
    # Lint and the build still run once, outside the split.
    assert "npm run lint" in jobs["frontend"] and "npm run build" in jobs["frontend"]
    assert "npm test" not in jobs["frontend"]
