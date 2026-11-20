"""Shared fakes for the extraction reader tests: a fake Claude process, and the landing-page fixtures.

No test may reach the real CLI. ``block_real_spawn`` is an autouse fixture in each reader test module:
it replaces the default spawn that ``commons.reader.read_image`` would otherwise use.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from commons import reader as commons_reader

FIXTURES = Path(__file__).parent / "fixtures" / "extraction"
LANDING = FIXTURES / "landing.png"
FAKE_READ = FIXTURES / "fake_read_landing.json"


def landing_structured() -> dict[str, Any]:
    return json.loads(FAKE_READ.read_text())


def init_event(tools=("StructuredOutput",), model="claude-opus-5-5") -> dict[str, Any]:
    return {"type": "system", "subtype": "init", "model": model, "tools": list(tools)}


def result_event(structured: dict[str, Any] | None) -> dict[str, Any]:
    return {"type": "result", "subtype": "success", "is_error": False, "result": "{}", "structured_output": structured}


class FakeProcess:
    returncode = 0

    def __init__(self, events: list[dict[str, Any]], on_run=None) -> None:
        self.events = events
        self.on_run = on_run
        self.payload: bytes | None = None

    async def communicate(self, data: bytes):
        self.payload = data
        if self.on_run:
            self.on_run()
        return ("\n".join(json.dumps(e) for e in self.events).encode(), b"")


class Spawner:
    """A fake ``spawn``: records every call and answers with the events it was given."""

    def __init__(self, events: list[dict[str, Any]], on_run=None) -> None:
        self.events = events
        self.on_run = on_run
        self.calls: list[tuple[tuple, dict]] = []
        self.processes: list[FakeProcess] = []

    async def __call__(self, *cmd, **kwargs):
        self.calls.append((cmd, kwargs))
        proc = FakeProcess(self.events, self.on_run)
        self.processes.append(proc)
        return proc


def answering(structured: dict[str, Any] | None = None, *, tools=("StructuredOutput",), on_run=None) -> Spawner:
    return Spawner([init_event(tools), result_event(landing_structured() if structured is None else structured)], on_run)


def failing(text: str = "API Error: 529 Overloaded") -> Spawner:
    return Spawner([init_event(), {"type": "result", "subtype": "error_during_execution", "is_error": True, "result": text}])


async def _no_real_cli(*cmd, **kwargs):
    raise AssertionError("a test reached the real Claude CLI")


@pytest.fixture
def block_real_spawn(monkeypatch):
    monkeypatch.setitem(commons_reader.read_image.__kwdefaults__, "spawn", _no_real_cli)
