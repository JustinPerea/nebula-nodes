"""Tests for backend/env_check.py — PYTHONPATH sanitization + runtime checks.

The module runs at the very top of backend/main.py, before fastapi/pydantic
are imported, to strip inherited PYTHONPATH entries that target a different
Python version (e.g. Hermes exporting Python 3.11 site-packages while Nebula
runs under Python 3.12, which breaks pydantic_core at import time).
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

import env_check

CURRENT = (sys.version_info.major, sys.version_info.minor)
OTHER = (3, 11) if CURRENT != (3, 11) else (3, 12)
OTHER_TAG = f"cpython-{OTHER[0]}{OTHER[1]}"
CURRENT_TAG = f"cpython-{CURRENT[0]}{CURRENT[1]}"

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _foreign_site_packages(tmp_path: Path) -> Path:
    """Build a fake site-packages holding a compiled pydantic_core for a
    *different* CPython version — the exact failure mode from the field."""
    site = tmp_path / f"python{OTHER[0]}.{OTHER[1]}" / "site-packages"
    pkg = site / "pydantic_core"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("raise ImportError('foreign pydantic_core')\n")
    (pkg / f"_pydantic_core.{OTHER_TAG}-darwin.so").write_bytes(b"")
    return site


def _compatible_dir(tmp_path: Path) -> Path:
    """A directory with a compiled extension matching the running interpreter."""
    d = tmp_path / "mytools"
    pkg = d / "mytools"
    pkg.mkdir(parents=True)
    (pkg / f"_speedups.{CURRENT_TAG}-darwin.so").write_bytes(b"")
    return d


def _nested_foreign_site_packages(tmp_path: Path) -> Path:
    """Fake site-packages with a foreign compiled extension three levels
    down — the numpy layout from the field:
    ``site-packages/numpy/core/_multiarray_umath.cpython-311-*.so``.
    The old root-plus-one-level scan could not see this deep."""
    site = tmp_path / "deep-site-packages"
    core = site / "numpy" / "core"
    core.mkdir(parents=True)
    (core / f"_multiarray_umath.{OTHER_TAG}-x86_64-linux-gnu.so").write_bytes(b"")
    return site


# ---------------------------------------------------------------------------
# Stripping behavior
# ---------------------------------------------------------------------------


def test_strips_incompatible_paths(tmp_path, caplog):
    """PYTHONPATH with a foreign-version site-packages entry gets that entry
    stripped; the running-version and version-agnostic entries are kept."""
    foreign = _foreign_site_packages(tmp_path)
    current_version_dir = tmp_path / f"python{CURRENT[0]}.{CURRENT[1]}" / "site-packages"
    current_version_dir.mkdir(parents=True)
    agnostic = tmp_path / "shared-libs"
    agnostic.mkdir()

    env = {"PYTHONPATH": os.pathsep.join([str(foreign), str(current_version_dir), str(agnostic)])}
    with caplog.at_level(logging.WARNING, logger="nebula.env_check"):
        stripped = env_check.sanitize_pythonpath(environ=env, version=CURRENT)

    assert stripped == [str(foreign)]
    remaining = env["PYTHONPATH"].split(os.pathsep)
    assert str(foreign) not in remaining
    assert str(current_version_dir) in remaining
    assert str(agnostic) in remaining
    # Warning lists the stripped path
    assert str(foreign) in caplog.text
    assert "PYTHONPATH" in caplog.text


def test_strips_path_with_foreign_compiled_artifact_even_without_version_segment(tmp_path, caplog):
    """A directory with no pythonX.Y in its name is still stripped when it
    houses compiled extensions built for another CPython (e.g. a 3.11
    pydantic_core .so while running 3.12)."""
    d = tmp_path / "hermes-libs"
    pkg = d / "pydantic_core"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / f"_pydantic_core.{OTHER_TAG}-darwin.so").write_bytes(b"")

    env = {"PYTHONPATH": str(d)}
    with caplog.at_level(logging.WARNING, logger="nebula.env_check"):
        stripped = env_check.sanitize_pythonpath(environ=env, version=CURRENT)

    assert stripped == [str(d)]
    assert "PYTHONPATH" not in env  # last entry stripped → variable removed
    assert str(d) in caplog.text


def test_strips_windows_style_versioned_segment(tmp_path):
    """Windows-style 'Python311' path segments are recognized too."""
    env = {"PYTHONPATH": f"C:\\Python{OTHER[0]}{OTHER[1]}\\Lib\\site-packages"}
    stripped = env_check.sanitize_pythonpath(environ=env, version=CURRENT)
    assert len(stripped) == 1


def test_removes_stripped_entries_from_sys_path(tmp_path, monkeypatch):
    """The interpreter already copied PYTHONPATH into sys.path at startup, so
    sanitization must evict stripped entries from sys.path as well."""
    foreign = _foreign_site_packages(tmp_path)
    monkeypatch.setenv("PYTHONPATH", str(foreign))
    fake_sys_path = [str(foreign), "/real/site-packages"]
    with monkeypatch.context() as m:
        m.setattr(env_check.sys, "path", fake_sys_path)
        stripped = env_check.sanitize_pythonpath(version=CURRENT)
    assert stripped == [str(foreign)]
    assert str(foreign) not in fake_sys_path
    assert "/real/site-packages" in fake_sys_path
    assert os.environ.get("PYTHONPATH") is None


def test_strips_entry_with_deeply_nested_foreign_extension(tmp_path, caplog):
    """A foreign compiled extension nested more than two levels below the
    PYTHONPATH entry (e.g. site-packages/numpy/core/_multiarray_umath.
    cpython-311-*.so) must still be detected and the entry stripped."""
    site = _nested_foreign_site_packages(tmp_path)
    env = {"PYTHONPATH": str(site)}
    with caplog.at_level(logging.WARNING, logger="nebula.env_check"):
        stripped = env_check.sanitize_pythonpath(environ=env, version=CURRENT)

    assert stripped == [str(site)]
    assert "PYTHONPATH" not in env  # last entry stripped → variable removed
    assert str(site) in caplog.text


def test_strips_entry_with_foreign_extension_at_max_depth(tmp_path):
    """Detection reaches the bounded maximum of four levels below the entry."""
    site = tmp_path / "depth-four"
    target = site / "a" / "b" / "c"
    target.mkdir(parents=True)
    (target / f"_ext.{OTHER_TAG}-darwin.so").write_bytes(b"")

    env = {"PYTHONPATH": str(site)}
    stripped = env_check.sanitize_pythonpath(environ=env, version=CURRENT)
    assert stripped == [str(site)]


# ---------------------------------------------------------------------------
# Preservation behavior
# ---------------------------------------------------------------------------


def test_preserves_compatible_paths(tmp_path, caplog):
    """Paths matching the running Python version, version-agnostic dirs, and
    dirs with current-version compiled artifacts are all preserved."""
    current_version_dir = tmp_path / "lib" / f"python{CURRENT[0]}.{CURRENT[1]}" / "site-packages"
    current_version_dir.mkdir(parents=True)
    agnostic = tmp_path / "plain-python-libs"
    agnostic.mkdir()
    with_artifacts = _compatible_dir(tmp_path)

    original = os.pathsep.join([str(current_version_dir), str(agnostic), str(with_artifacts)])
    env = {"PYTHONPATH": original}
    with caplog.at_level(logging.WARNING, logger="nebula.env_check"):
        stripped = env_check.sanitize_pythonpath(environ=env, version=CURRENT)

    assert stripped == []
    assert env["PYTHONPATH"] == original
    assert caplog.text == ""


def test_clean_pythonpath_unchanged(caplog):
    """Absent or empty PYTHONPATH: nothing stripped, no warning, no new key."""
    with caplog.at_level(logging.WARNING, logger="nebula.env_check"):
        assert env_check.sanitize_pythonpath(environ={}, version=CURRENT) == []
        env = {"PYTHONPATH": ""}
        assert env_check.sanitize_pythonpath(environ=env, version=CURRENT) == []
    assert env["PYTHONPATH"] == ""
    assert caplog.text == ""


def test_unreadable_path_is_not_stripped(tmp_path):
    """A path that cannot be scanned produces no false-positive strip."""
    missing = tmp_path / "does-not-exist"
    env = {"PYTHONPATH": str(missing)}
    assert env_check.sanitize_pythonpath(environ=env, version=CURRENT) == []
    assert env["PYTHONPATH"] == str(missing)


def test_preserves_entry_with_only_compatible_nested_extensions(tmp_path, caplog):
    """Nested compiled extensions built for the *running* interpreter must
    not cause a strip, even several levels deep."""
    site = tmp_path / "compatible-deep"
    target = site / "numpy" / "core"
    target.mkdir(parents=True)
    (target / f"_multiarray_umath.{CURRENT_TAG}-x86_64-linux-gnu.so").write_bytes(b"")

    env = {"PYTHONPATH": str(site)}
    with caplog.at_level(logging.WARNING, logger="nebula.env_check"):
        stripped = env_check.sanitize_pythonpath(environ=env, version=CURRENT)

    assert stripped == []
    assert env["PYTHONPATH"] == str(site)
    assert caplog.text == ""


def test_preserves_entry_beyond_max_scan_depth(tmp_path, caplog):
    """The scan is bounded at four levels: a foreign extension five levels
    down is intentionally out of scope (no unbounded walks of huge trees),
    so the entry is preserved."""
    site = tmp_path / "too-deep"
    target = site / "a" / "b" / "c" / "d"
    target.mkdir(parents=True)
    (target / f"_ext.{OTHER_TAG}-darwin.so").write_bytes(b"")

    env = {"PYTHONPATH": str(site)}
    with caplog.at_level(logging.WARNING, logger="nebula.env_check"):
        stripped = env_check.sanitize_pythonpath(environ=env, version=CURRENT)

    assert stripped == []
    assert env["PYTHONPATH"] == str(site)
    assert caplog.text == ""


# ---------------------------------------------------------------------------
# Runtime verification
# ---------------------------------------------------------------------------


def test_verify_runtime_accepts_current_interpreter():
    env_check.verify_runtime()  # must not raise


def test_verify_runtime_rejects_old_python():
    with pytest.raises(SystemExit, match=r"3\.12"):
        env_check.verify_runtime(version=(3, 11, 0), executable=sys.executable)


def test_verify_runtime_rejects_missing_executable(tmp_path):
    bogus = tmp_path / "no-such-python"
    with pytest.raises(SystemExit, match="sys.executable"):
        env_check.verify_runtime(version=(3, 12, 0), executable=str(bogus))


# ---------------------------------------------------------------------------
# End-to-end: poisoned PYTHONPATH no longer shadows the real pydantic_core
# ---------------------------------------------------------------------------


def test_startup_import_succeeds_after_sanitization(tmp_path):
    """Simulate the real failure: PYTHONPATH points at a site-packages whose
    pydantic_core blows up on import. After env_check runs, `import
    pydantic_core` must resolve to the real, compatible package."""
    foreign = _foreign_site_packages(tmp_path)
    env = os.environ.copy()
    env["PYTHONPATH"] = str(foreign)
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "import env_check; env_check.run_startup_checks(); "
            "import pydantic_core; print(pydantic_core.__file__)",
        ],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert str(foreign) not in proc.stdout
    assert "stripped" in proc.stderr.lower() or "stripped" in proc.stdout.lower()
