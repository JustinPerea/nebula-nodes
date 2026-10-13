"""Pytest setup: sandbox file-system paths so tests never touch the user's
real working tree.

- NEBULA_STATE_DIR → temp dir, so auto-persist of cli_graph doesn't overwrite
  the user's real ~/.nebula/state.json.
- NEBULA_OUTPUT_ROOT → temp dir, so handlers that write generated images
  (and the three handler tests that `shutil.rmtree` their root at teardown)
  don't wipe the user's real output/ directory. The old behavior destroyed
  hours of Daedalus work when the test suite ran against the shared OUTPUT_ROOT.
- NEBULA_SETTINGS_PATH → temp file, so save_settings() (called by PUT
  /api/settings) writes to a throwaway file instead of the real repo
  settings.json. Without this, a full pytest run rewrites the real
  settings.json with apiKeys:{} on every execution.

All must be set BEFORE any test module imports `main` or `services.output`,
which happens at collection time for files that do `from main import app`.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

_TEST_STATE_DIR = Path(tempfile.mkdtemp(prefix="nebula-test-state-"))
os.environ["NEBULA_STATE_DIR"] = str(_TEST_STATE_DIR)

_TEST_OUTPUT_DIR = Path(tempfile.mkdtemp(prefix="nebula-test-output-"))
os.environ["NEBULA_OUTPUT_ROOT"] = str(_TEST_OUTPUT_DIR)

_TEST_CHARACTER_DIR = Path(tempfile.mkdtemp(prefix="nebula-test-characters-"))
os.environ["NEBULA_CHARACTER_ROOT"] = str(_TEST_CHARACTER_DIR)

_TEST_PRESET_DIR = Path(tempfile.mkdtemp(prefix="nebula-test-presets-"))
os.environ["NEBULA_PRESET_ROOT"] = str(_TEST_PRESET_DIR)

_TEST_SETTINGS_PATH = Path(tempfile.mkdtemp(prefix="nebula-test-settings-")) / "settings.json"
os.environ["NEBULA_SETTINGS_PATH"] = str(_TEST_SETTINGS_PATH)

_TEST_COMMONS_DIR = Path(tempfile.mkdtemp(prefix="nebula-test-commons-"))
os.environ["NEBULA_COMMONS_ROOT"] = str(_TEST_COMMONS_DIR)
os.environ["NEBULA_COMMONS_NO_STARTUP_SCAN"] = "1"
# Ordinary tests exercise the released default: Commons remains inactive.
os.environ.pop("NEBULA_COMMONS_ENABLED", None)

import pytest  # noqa: E402


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_teardown(item, nextitem):
    """Fail the test that leaves services.settings pointing anywhere but the
    sandbox file above, checked after all of its fixtures (and monkeypatch)
    have been undone. Tests that reload the module (test_settings_path.py,
    test_credential_injection.py) once restored it by removing the variable,
    which falls back to the repo's real settings.json: every later test then
    read the person's keys and wrote their settings."""
    yield
    import sys

    module = sys.modules.get("services.settings")
    if module is not None and Path(module.SETTINGS_PATH) != _TEST_SETTINGS_PATH:
        raise AssertionError(
            f"services.settings.SETTINGS_PATH is {module.SETTINGS_PATH} after {item.nodeid}; "
            f"restore it to {_TEST_SETTINGS_PATH} (reload with NEBULA_SETTINGS_PATH set)"
        )


@pytest.fixture(autouse=True)
def isolated_commons_opt_in(request, monkeypatch):
    """Only the dedicated synthetic Commons tests opt into store access."""
    name = request.node.path.name
    controls_activation = name in {
        "test_commons_activation.py", "test_commons_clients_activation.py",
        "test_commons_integration.py",
    }
    if (name.startswith("test_commons_") and not controls_activation) or name == "test_agent_workspace_authority.py":
        monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")


@pytest.fixture
def spending_limits_off(monkeypatch):
    """Run as if the person turned agent spending limits off in Settings.

    For tests about other parts of a run (provider admission, quick, gateways)
    that call run routes the way an agent does, without the canvas's Origin.
    The limits themselves are tested in tests/test_agent_spend.py. Patching
    the reader, not settings.json, keeps it in force when a test rewrites its
    settings."""
    from services import agent_spend

    monkeypatch.setattr(agent_spend, "threshold_from_settings", lambda settings: None)
    monkeypatch.setattr(agent_spend, "caps_from_settings",
                        lambda settings: {"sessionUsd": None, "outsideDailyUsd": None, "kreaPlanRuns": None,
                                          "models": {}})


# The person's launch token in tests (services/person_session.py). The
# `person` fixture installs it; without that fixture it verifies as nothing.
PERSON_TOKEN = "test-person-token-" + "0" * 25
# What the person's canvas sends. A real browser also sends Origin, which
# proves nothing on its own: FORGED_ORIGIN is what any local program can send.
PERSON = {"Origin": "http://localhost:5173", "X-Nebula-Person": PERSON_TOKEN}
FORGED_ORIGIN = {"Origin": "http://localhost:5173"}
PERSON_HELLO = {"type": "hello", "personToken": PERSON_TOKEN}


class PersonFixture:
    """This test's person: the launch token and the headers the canvas sends."""

    def __init__(self, token: str) -> None:
        self.token = token
        self.headers = {"Origin": "http://localhost:5173", "X-Nebula-Person": token}
        self.hello = {"type": "hello", "personToken": token}


@pytest.fixture
def fresh_person_session(monkeypatch):
    """Swap in an empty person session (services/person_session.py), the one
    object the person gate, /ws, /ws/chat and Commons all read."""
    from services import person_session

    session = person_session.PersonSession()
    monkeypatch.setattr(person_session, "_session", session)
    monkeypatch.setattr(person_session, "_provided", None)
    return session


@pytest.fixture
def person(fresh_person_session) -> PersonFixture:
    """A person session holding PERSON_TOKEN. Send ``PERSON`` (or
    ``person.headers``) where the canvas would, and keep forged-Origin cases
    (FORGED_ORIGIN) as negatives."""
    fresh_person_session.set(PERSON_TOKEN)
    return PersonFixture(PERSON_TOKEN)
