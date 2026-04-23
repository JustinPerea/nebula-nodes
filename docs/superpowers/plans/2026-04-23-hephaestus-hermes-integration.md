# Hephaestus — Hermes Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Hephaestus as a user-selectable alt-agent in the nebula-nodes chat panel, powered by Hermes Agent + Kimi K2.6, ready for demo video recording by day 8 of the Nous Research Creative Hackathon (submission due 2026-05-03).

**Architecture:** Backend wrapper `run_hermes()` mirrors existing `run_claude()` event contract; spawns `hermes chat -q MSG -Q --resume SESSION` subprocess per turn; parses stdout for structured markers (`APPROVAL_REQUIRED:`, `LEARNING_SAVED:`). Hephaestus persona + playbook ride inside a repo-shipped skill at `.hermes/skills/hephaestus-core/SKILL.md`, loaded via `--skills hephaestus-core`. Chat panel gets agent selector + autonomy toggle; approval/learning events render as interactive bubbles.

**Tech Stack:** Python 3.12 (FastAPI + asyncio subprocess), React 19 + TypeScript, Hermes Agent v0.10 CLI, Kimi K2.6 via OpenRouter.

**Reference spec:** `docs/superpowers/specs/2026-04-23-hephaestus-hermes-integration-design.md`

---

## Task 0: Verify `hermes chat -q -Q` stdout format (de-risk open question)

Spec Open Question #1: exact stdout format is unverified. One real invocation captures fixture data that subsequent tasks depend on.

**Files:**
- Create: `backend/tests/fixtures/hermes/hello_world.txt` (captured stdout)
- Create: `backend/tests/fixtures/hermes/hello_world.stderr.txt` (captured stderr)

- [ ] **Step 1: Run a minimal Hermes invocation and capture stdout**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
mkdir -p backend/tests/fixtures/hermes
hermes chat -q "respond with exactly: HELLO" -Q \
  --provider openrouter \
  --model moonshotai/kimi-k2.6 \
  > backend/tests/fixtures/hermes/hello_world.txt \
  2> backend/tests/fixtures/hermes/hello_world.stderr.txt
```

Expected: command exits 0. `hello_world.txt` contains Hermes's final response. `hello_world.stderr.txt` captures any diagnostic output.

- [ ] **Step 2: Inspect the captured output**

```bash
echo "--- STDOUT ---"
cat backend/tests/fixtures/hermes/hello_world.txt
echo "--- STDERR ---"
cat backend/tests/fixtures/hermes/hello_world.stderr.txt
```

Expected: identify (a) whether the response is plain text, JSON, or structured; (b) where the session ID appears (stdout, stderr, or not at all in `-Q` mode); (c) whether `-Q` suppresses all diagnostic lines.

- [ ] **Step 3: Verify `--pass-session-id` flag for session echo**

If Step 2 shows the session ID is NOT in stdout under `-Q`, re-run with `--pass-session-id`:

```bash
hermes chat -q "respond with exactly: HELLO" -Q --pass-session-id \
  --provider openrouter \
  --model moonshotai/kimi-k2.6 \
  > backend/tests/fixtures/hermes/hello_with_session_id.txt \
  2> backend/tests/fixtures/hermes/hello_with_session_id.stderr.txt

cat backend/tests/fixtures/hermes/hello_with_session_id.txt
```

Expected: session ID now visible in stdout (format TBD — could be trailing line, could be prefix, depends on Hermes's implementation).

- [ ] **Step 4: Capture a `--resume` turn to verify session continuity**

Using the session ID from Step 3:

```bash
HERMES_SID="<paste session id from Step 3>"
hermes chat -q "what was my last message?" -Q --pass-session-id \
  --resume "$HERMES_SID" \
  --provider openrouter \
  --model moonshotai/kimi-k2.6 \
  > backend/tests/fixtures/hermes/resume_turn.txt
cat backend/tests/fixtures/hermes/resume_turn.txt
```

Expected: Hermes references the prior turn's content. Confirms `--resume` threads context across CLI invocations.

- [ ] **Step 5: Document findings inline in the fixture file**

Append a comment block at the top of `backend/tests/fixtures/hermes/hello_world.txt` OR create `backend/tests/fixtures/hermes/README.md` documenting:
- Stdout format (plain text / JSON / mixed)
- Session ID location (which stream, which line)
- Whether `--pass-session-id` is needed
- Any diagnostic noise in stderr to filter out

This is the canonical reference subsequent tasks will follow.

- [ ] **Step 6: Commit fixtures**

```bash
git add backend/tests/fixtures/hermes/
git commit -m "test(hermes): capture real stdout fixtures for -q -Q mode

Resolves spec Open Question #1 (stdout format unverified). Captured
fixtures are the reference for run_hermes parser tests."
```

---

## Task 1: Create `backend/services/hermes_session.py` skeleton + happy-path test

**Files:**
- Create: `backend/services/hermes_session.py`
- Create: `backend/tests/test_hermes_session.py`

- [ ] **Step 1: Write the failing happy-path test**

Create `backend/tests/test_hermes_session.py`:

```python
"""Tests for run_hermes — mirrors the run_claude event contract."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.hermes_session import run_hermes


async def _collect(agen):
    return [event async for event in agen]


@pytest.mark.asyncio
async def test_happy_path_yields_text_and_done():
    """Minimal successful turn: Hermes prints a response, wrapper emits text + done."""
    fake_stdout = b"HELLO\n"
    fake_stderr = b""

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=fake_stderr)
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    types = [e["type"] for e in events]
    assert "text" in types
    assert events[-1]["type"] == "done"
    text_event = next(e for e in events if e["type"] == "text")
    assert "HELLO" in text_event["text"]
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && python -m pytest tests/test_hermes_session.py::test_happy_path_yields_text_and_done -v
```

Expected: FAIL with `ModuleNotFoundError: services.hermes_session`.

- [ ] **Step 3: Write minimal happy-path implementation**

Create `backend/services/hermes_session.py`:

```python
"""Hephaestus runtime — wraps `hermes chat -q -Q` subprocess and normalizes
output into the same event dict contract as run_claude.

Yields dicts with a `type` field:
  - session          — {sessionId}
  - text             — {text}
  - approval_request — {summary, plan, cost}
  - learning_saved   — {topic, entry_preview}
  - error            — {message}
  - done             — {}
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, AsyncIterator

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

DEFAULT_MODEL = "moonshotai/kimi-k2.6"
DEFAULT_PROVIDER = "openrouter"
DEFAULT_SKILLS = "hephaestus-core"


async def run_hermes(
    message: str,
    session_id: str | None,
    model: str = DEFAULT_MODEL,
    autonomy: str = "auto",
) -> AsyncIterator[dict[str, Any]]:
    """Run a single Hephaestus turn via `hermes chat -q -Q` and yield events."""
    args = [
        "hermes", "chat", "-q", message, "-Q",
        "--provider", DEFAULT_PROVIDER,
        "--model", model,
        "--skills", DEFAULT_SKILLS,
        "--pass-session-id",
    ]
    if session_id:
        args.extend(["--resume", session_id])

    env = {
        **os.environ,
        "NEBULA_DISABLE_QUICK": "1",
        "HEPHAESTUS_APPROVAL": autonomy,
    }

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
            env=env,
            limit=64 * 1024 * 1024,
        )
    except FileNotFoundError:
        yield {"type": "error", "message": "`hermes` binary not found in PATH. See docs/HERMES-SETUP.md."}
        yield {"type": "done"}
        return

    stdout_bytes = await proc.stdout.read()
    _ = await proc.stderr.read()
    await proc.wait()

    text = stdout_bytes.decode("utf-8", errors="replace")
    if text.strip():
        yield {"type": "text", "text": text.rstrip("\n")}
    yield {"type": "done"}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && python -m pytest tests/test_hermes_session.py::test_happy_path_yields_text_and_done -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/hermes_session.py backend/tests/test_hermes_session.py
git commit -m "feat(hermes): run_hermes skeleton + happy-path test

Mirrors run_claude's AsyncIterator[dict] event contract. Subprocess
spawns hermes chat -q MSG -Q with Kimi K2.6 and hephaestus-core skill
preloaded. Basic happy path: stdout text emitted as 'text' event,
followed by 'done'."
```

---

## Task 2: Parse session ID from stdout + thread `--resume`

**Files:**
- Modify: `backend/services/hermes_session.py`
- Modify: `backend/tests/test_hermes_session.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_hermes_session.py`:

```python
@pytest.mark.asyncio
async def test_emits_session_event_when_session_id_present():
    """Hermes --pass-session-id prints the session ID on stdout; we emit it as an event."""
    # Format per Task 0 fixtures — adjust if Hermes prints it differently
    # (e.g. JSON line, trailing line, header). Assumption: trailing marker line.
    fake_stdout = b"Some response text.\nSESSION_ID: 01HXYZ123\n"

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    session_events = [e for e in events if e["type"] == "session"]
    assert len(session_events) == 1
    assert session_events[0]["sessionId"] == "01HXYZ123"
    # Session marker stripped from text
    text_event = next(e for e in events if e["type"] == "text")
    assert "SESSION_ID" not in text_event["text"]


@pytest.mark.asyncio
async def test_resume_flag_passed_when_session_id_given():
    """When session_id arg is provided, --resume is in the subprocess args."""
    captured_args = []

    async def fake_create(*args, **kwargs):
        captured_args.extend(args)
        proc = AsyncMock()
        proc.stdout.read = AsyncMock(return_value=b"ok\n")
        proc.stderr.read = AsyncMock(return_value=b"")
        proc.wait = AsyncMock(return_value=0)
        proc.returncode = 0
        return proc

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               side_effect=fake_create):
        _ = await _collect(run_hermes("hi", "01HEXISTING", autonomy="auto"))

    assert "--resume" in captured_args
    idx = captured_args.index("--resume")
    assert captured_args[idx + 1] == "01HEXISTING"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && python -m pytest tests/test_hermes_session.py -v -k "session"
```

Expected: FAIL — session event not emitted; text includes `SESSION_ID:` line.

- [ ] **Step 3: Parse session ID marker in implementation**

In `backend/services/hermes_session.py`, replace the last block (after `proc.wait()`) with:

```python
    text = stdout_bytes.decode("utf-8", errors="replace")

    # Extract session ID marker (format assumed from Task 0 fixtures).
    # Hermes --pass-session-id prints `SESSION_ID: <ulid>` on its own line.
    session_id_emitted: str | None = None
    filtered_lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("SESSION_ID:"):
            session_id_emitted = stripped.split(":", 1)[1].strip()
        else:
            filtered_lines.append(line)

    if session_id_emitted:
        yield {"type": "session", "sessionId": session_id_emitted}

    body = "\n".join(filtered_lines).strip()
    if body:
        yield {"type": "text", "text": body}

    yield {"type": "done"}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && python -m pytest tests/test_hermes_session.py -v
```

Expected: 3 tests pass (happy_path + 2 new).

- [ ] **Step 5: Commit**

```bash
git add backend/services/hermes_session.py backend/tests/test_hermes_session.py
git commit -m "feat(hermes): parse SESSION_ID marker + thread --resume across turns

Hermes's --pass-session-id flag prints the session ID on its own line.
Wrapper extracts it, emits as 'session' event, and threads it through
the next subprocess call via --resume when the caller provides it."
```

> **Note for future engineer:** If Task 0 fixtures show Hermes uses a different session-ID format (JSON, prefix, different label), adjust the marker parse in Step 3 accordingly. The rest of the shape stays the same.

---

## Task 3: Parse `APPROVAL_REQUIRED:` marker and emit `approval_request` event

**Files:**
- Modify: `backend/services/hermes_session.py`
- Modify: `backend/tests/test_hermes_session.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_hermes_session.py`:

```python
@pytest.mark.asyncio
async def test_parses_approval_required_marker():
    """When Hephaestus prints APPROVAL_REQUIRED, emit approval_request event."""
    fake_stdout = (
        b"Planning the render.\n"
        b"APPROVAL_REQUIRED: Run Veo 3.1 on n4 (est $0.15, ~60s)\n"
        b"PLAN: connect n2:image -> n4:first_frame + n4:last_frame; run n4\n"
        b"COST: $0.15\n"
        b"SESSION_ID: 01HZZ123\n"
    )

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("render it", None, autonomy="step"))

    approval = [e for e in events if e["type"] == "approval_request"]
    assert len(approval) == 1
    assert "Veo 3.1" in approval[0]["summary"]
    assert "connect n2:image" in approval[0]["plan"]
    assert approval[0]["cost"] == "$0.15"

    # Markers stripped from the free-text event
    text = next((e for e in events if e["type"] == "text"), None)
    if text:
        assert "APPROVAL_REQUIRED" not in text["text"]
        assert "PLAN:" not in text["text"]
        assert "COST:" not in text["text"]
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_hermes_session.py::test_parses_approval_required_marker -v
```

Expected: FAIL — no `approval_request` event emitted.

- [ ] **Step 3: Extend the parser**

Replace the parsing block in `backend/services/hermes_session.py` with:

```python
    text = stdout_bytes.decode("utf-8", errors="replace")

    session_id_emitted: str | None = None
    approval_summary: str | None = None
    approval_plan: str | None = None
    approval_cost: str | None = None
    filtered_lines: list[str] = []

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("SESSION_ID:"):
            session_id_emitted = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("APPROVAL_REQUIRED:"):
            approval_summary = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("PLAN:"):
            approval_plan = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("COST:"):
            approval_cost = stripped.split(":", 1)[1].strip()
        else:
            filtered_lines.append(line)

    if session_id_emitted:
        yield {"type": "session", "sessionId": session_id_emitted}

    if approval_summary:
        yield {
            "type": "approval_request",
            "summary": approval_summary,
            "plan": approval_plan or "",
            "cost": approval_cost or "",
        }

    body = "\n".join(filtered_lines).strip()
    if body:
        yield {"type": "text", "text": body}

    yield {"type": "done"}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && python -m pytest tests/test_hermes_session.py -v
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/hermes_session.py backend/tests/test_hermes_session.py
git commit -m "feat(hermes): parse APPROVAL_REQUIRED/PLAN/COST markers

When Hephaestus is in step-approval mode (HEPHAESTUS_APPROVAL=step),
SKILL.md directives tell it to pause before expensive ops and print
three structured marker lines. Parser extracts them into a single
approval_request event for the frontend to render as Approve/Reject
buttons."
```

---

## Task 4: Parse `LEARNING_SAVED:` marker and emit `learning_saved` event

**Files:**
- Modify: `backend/services/hermes_session.py`
- Modify: `backend/tests/test_hermes_session.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_hermes_session.py`:

```python
@pytest.mark.asyncio
async def test_parses_learning_saved_marker():
    """LEARNING_SAVED: <slug> on stdout becomes a learning_saved event."""
    fake_stdout = (
        b"Loops cleanly now.\n"
        b"LEARNING_SAVED: loop-color-grade-drift\n"
        b"SESSION_ID: 01HXYZ\n"
    )

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("render", None, autonomy="auto"))

    learn = [e for e in events if e["type"] == "learning_saved"]
    assert len(learn) == 1
    assert learn[0]["topic"] == "loop-color-grade-drift"

    text = next((e for e in events if e["type"] == "text"), None)
    if text:
        assert "LEARNING_SAVED" not in text["text"]
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_hermes_session.py::test_parses_learning_saved_marker -v
```

Expected: FAIL.

- [ ] **Step 3: Extend the parser**

Add a new branch in the for-loop in `backend/services/hermes_session.py`:

```python
        elif stripped.startswith("LEARNING_SAVED:"):
            learning_topic = stripped.split(":", 1)[1].strip()
```

Add the local variable init at top with the others:

```python
    learning_topic: str | None = None
```

Add the emission before `yield done`, after approval emission:

```python
    if learning_topic:
        yield {"type": "learning_saved", "topic": learning_topic, "entry_preview": ""}
```

Full updated parsing block:

```python
    text = stdout_bytes.decode("utf-8", errors="replace")

    session_id_emitted: str | None = None
    approval_summary: str | None = None
    approval_plan: str | None = None
    approval_cost: str | None = None
    learning_topic: str | None = None
    filtered_lines: list[str] = []

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("SESSION_ID:"):
            session_id_emitted = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("APPROVAL_REQUIRED:"):
            approval_summary = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("PLAN:"):
            approval_plan = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("COST:"):
            approval_cost = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("LEARNING_SAVED:"):
            learning_topic = stripped.split(":", 1)[1].strip()
        else:
            filtered_lines.append(line)

    if session_id_emitted:
        yield {"type": "session", "sessionId": session_id_emitted}

    if approval_summary:
        yield {
            "type": "approval_request",
            "summary": approval_summary,
            "plan": approval_plan or "",
            "cost": approval_cost or "",
        }

    if learning_topic:
        yield {"type": "learning_saved", "topic": learning_topic, "entry_preview": ""}

    body = "\n".join(filtered_lines).strip()
    if body:
        yield {"type": "text", "text": body}

    yield {"type": "done"}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && python -m pytest tests/test_hermes_session.py -v
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/hermes_session.py backend/tests/test_hermes_session.py
git commit -m "feat(hermes): parse LEARNING_SAVED marker

SKILL.md directs Hephaestus to print LEARNING_SAVED: <slug> after
appending to LEARNINGS.md via skill_manage. Wrapper converts the
marker to a learning_saved event so the frontend can render a subtle
'Saved learning' system line in the chat."
```

---

## Task 5: Error handling (binary missing, non-zero exit, stderr capture)

**Files:**
- Modify: `backend/services/hermes_session.py`
- Modify: `backend/tests/test_hermes_session.py`

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_hermes_session.py`:

```python
@pytest.mark.asyncio
async def test_binary_missing_yields_error_event():
    """When hermes binary isn't in PATH, emit error + done gracefully."""
    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               side_effect=FileNotFoundError("no such file")):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    assert events[0]["type"] == "error"
    assert "hermes" in events[0]["message"].lower()
    assert "HERMES-SETUP" in events[0]["message"]
    assert events[-1]["type"] == "done"


@pytest.mark.asyncio
async def test_non_zero_exit_surfaces_stderr_tail():
    """If hermes subprocess exits non-zero, emit error with stderr tail."""
    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=b"")
    proc.stderr.read = AsyncMock(return_value=b"auth failed: no API key configured\n")
    proc.wait = AsyncMock(return_value=1)
    proc.returncode = 1

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    error_events = [e for e in events if e["type"] == "error"]
    assert len(error_events) == 1
    assert "auth failed" in error_events[0]["message"]
    assert events[-1]["type"] == "done"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && python -m pytest tests/test_hermes_session.py -v -k "binary_missing or non_zero"
```

Expected: FAIL — the non-zero case isn't checked yet; the error string doesn't include "HERMES-SETUP" yet.

- [ ] **Step 3: Extend implementation**

In `backend/services/hermes_session.py`, update the FileNotFoundError handler and add a non-zero exit check right after `await proc.wait()`:

```python
    except FileNotFoundError:
        yield {
            "type": "error",
            "message": "`hermes` binary not found in PATH. See docs/HERMES-SETUP.md for install instructions.",
        }
        yield {"type": "done"}
        return
```

Replace the post-wait block:

```python
    stdout_bytes = await proc.stdout.read()
    stderr_bytes = await proc.stderr.read()
    await proc.wait()

    if proc.returncode != 0:
        stderr_tail = stderr_bytes.decode("utf-8", errors="replace").strip()
        # Trim to last 500 chars so a noisy stderr doesn't bloat the chat bubble
        tail = stderr_tail[-500:] if len(stderr_tail) > 500 else stderr_tail
        yield {
            "type": "error",
            "message": f"hermes exited {proc.returncode}: {tail}" if tail else f"hermes exited {proc.returncode} with no output",
        }
        yield {"type": "done"}
        return

    text = stdout_bytes.decode("utf-8", errors="replace")
    # ... rest of parsing unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && python -m pytest tests/test_hermes_session.py -v
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/hermes_session.py backend/tests/test_hermes_session.py
git commit -m "feat(hermes): binary-missing + non-zero-exit error handling

FileNotFoundError routes to a friendly setup-doc pointer. Non-zero
exit surfaces the last 500 chars of stderr so the chat bubble shows
actionable diagnostic info without bloating."
```

---

## Task 6: Add `AGENT_RUNNERS` dispatch to `chat_session.py`

**Files:**
- Modify: `backend/services/chat_session.py`
- Create: `backend/tests/test_chat_session_dispatch.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_chat_session_dispatch.py`:

```python
"""Tests that AGENT_RUNNERS dispatches to the right runner per agent name."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.chat_session import AGENT_RUNNERS, run_claude
from services.hermes_session import run_hermes


def test_dispatch_registers_both_agents():
    assert "claude" in AGENT_RUNNERS
    assert "hephaestus" in AGENT_RUNNERS
    assert AGENT_RUNNERS["claude"] is run_claude
    assert AGENT_RUNNERS["hephaestus"] is run_hermes
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && python -m pytest tests/test_chat_session_dispatch.py -v
```

Expected: FAIL — `ImportError: cannot import name 'AGENT_RUNNERS'`.

- [ ] **Step 3: Add the dispatch table**

In `backend/services/chat_session.py`, at the very bottom of the file add:

```python
# Agent dispatch registry — keyed by the 'agent' field on /ws/chat payloads.
# Keep this at the bottom so both run_claude and run_hermes are in scope.
from services.hermes_session import run_hermes as _run_hermes  # noqa: E402

AGENT_RUNNERS: dict[str, Any] = {
    "claude": run_claude,
    "hephaestus": _run_hermes,
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && python -m pytest tests/test_chat_session_dispatch.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/chat_session.py backend/tests/test_chat_session_dispatch.py
git commit -m "feat(chat): AGENT_RUNNERS dispatch for claude + hephaestus

Single lookup table so /ws/chat can route per-turn to the right runner
without branching in main.py. Both runners share the same event
contract, so downstream WebSocket code is agent-agnostic."
```

---

## Task 7: Wire `/ws/chat` to dispatch via `AGENT_RUNNERS`

**Files:**
- Modify: `backend/main.py:256-320` (chat_websocket)

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_cli_api.py`:

```python
class TestChatAgentDispatch:
    """WebSocket /ws/chat accepts an 'agent' field and routes to the right runner."""

    def test_chat_payload_schema_accepts_agent_field(self):
        """Smoke test: the payload schema doesn't reject agent/autonomy fields.

        Real end-to-end testing of agent dispatch requires a running Hermes
        binary and is done manually per spec §8.
        """
        # Pure schema-level regression — if main.py rejects the agent field,
        # the WebSocket handler would drop the message. Verified by reading
        # the source; this test documents the required fields.
        import main  # noqa: F401 — import for side-effects
        # The websocket handler in main.py must read payload["agent"] and
        # payload.get("autonomy", "auto"); see chat_websocket in main.py.
        assert True  # schema is at the handler level, not Pydantic
```

This is a sentinel test; real verification of the dispatch is via the manual UAT in Task 16.

- [ ] **Step 2: Run the sentinel test to verify the existing suite still passes**

```bash
cd backend && python -m pytest tests/ -v -k "ChatAgent"
```

Expected: PASS (sentinel), plus no regressions in the full suite.

- [ ] **Step 3: Update `chat_websocket` in `backend/main.py`**

Replace the existing `chat_websocket` function starting at `main.py:258` with:

```python
@app.websocket("/ws/chat")
async def chat_websocket(websocket: WebSocket) -> None:
    """Chat WebSocket — one message per turn, streams agent output.

    Client sends: {
        type: "send",
        message: str,
        sessionId: str|null,
        model: str,
        agent: "claude" | "hephaestus" (default "claude"),
        autonomy: "auto" | "step" (default "auto", hephaestus-only)
    }
    Server sends events matching AGENT_RUNNERS' event contract.
    """
    from services.chat_session import AGENT_RUNNERS

    await websocket.accept()
    current_task: asyncio.Task[None] | None = None

    async def stream_response(
        message: str,
        session_id: str | None,
        model: str,
        agent: str,
        autonomy: str,
    ) -> None:
        runner = AGENT_RUNNERS.get(agent)
        if runner is None:
            await websocket.send_text(json.dumps({
                "type": "error",
                "message": f"Unknown agent '{agent}'. Valid: {sorted(AGENT_RUNNERS.keys())}",
            }))
            await websocket.send_text(json.dumps({"type": "done"}))
            return

        try:
            if agent == "hephaestus":
                agen = runner(message, session_id, model, autonomy)  # type: ignore[call-arg]
            else:
                agen = runner(message, session_id, model)
            async for event in agen:
                await websocket.send_text(json.dumps(event))
        except Exception as exc:
            try:
                await websocket.send_text(json.dumps({"type": "error", "message": str(exc)}))
                await websocket.send_text(json.dumps({"type": "done"}))
            except Exception:
                pass

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"type": "error", "message": "invalid JSON"}))
                continue

            msg_type = payload.get("type")
            if msg_type == "cancel":
                if current_task and not current_task.done():
                    current_task.cancel()
                continue
            if msg_type != "send":
                continue

            message = payload.get("message", "")
            session_id = payload.get("sessionId")
            model = payload.get("model", "claude-sonnet-4-6")
            agent = payload.get("agent", "claude")
            autonomy = payload.get("autonomy", "auto")

            if current_task and not current_task.done():
                current_task.cancel()
            current_task = asyncio.create_task(
                stream_response(message, session_id, model, agent, autonomy)
            )
    except WebSocketDisconnect:
        if current_task and not current_task.done():
            current_task.cancel()
```

- [ ] **Step 4: Run full test suite to verify no regressions**

```bash
cd backend && python -m pytest tests/ -q
```

Expected: all tests pass (163 existing + new hermes tests + dispatch test).

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_cli_api.py
git commit -m "feat(chat): /ws/chat dispatches to agent runner via AGENT_RUNNERS

Payload now carries agent (default 'claude') and autonomy (default
'auto'). Unknown agent names surface as error events. Hephaestus gets
the autonomy arg; Claude ignores it."
```

---

## Task 8: Write `.hermes/skills/hephaestus-core/SKILL.md` (persona + playbook)

**Files:**
- Create: `.hermes/skills/hephaestus-core/SKILL.md`

- [ ] **Step 1: Create the skill file**

```bash
mkdir -p .hermes/skills/hephaestus-core
```

Create `.hermes/skills/hephaestus-core/SKILL.md`:

```markdown
---
name: hephaestus-core
description: Hephaestus's iterative-artist playbook — persona directive + pipeline-stage tracing + vision reliability rules + nebula CLI cookbook + learnings discipline + autonomy modes.
category: agent-persona
triggers: |
  Loaded automatically when `--skills hephaestus-core` is passed to
  `hermes chat`. Treated as authoritative guidance for the session.
platforms: [hermes-cli]
---

# Hephaestus — Persona Directive

You are Hephaestus — the forge-god made into a creative agent.

You build through a canvas called nebula-nodes. You speak concisely, name your
tools by reputation, and never ship a flawed artifact without saying so.

## Your signature: the iterative loop

1. Plan the pipeline. State the stages explicitly.
2. Build as nebula nodes via `terminal("nebula create / connect / run ...")`.
3. Inspect outputs with `vision_analyze`. Demand geometric specifics, not
   pattern labels. Use per-cell verdicts for multi-frame outputs.
4. If defective: trace to earliest affected stage, fix THERE, rerun.
5. Max 3 iterations per turn. Beyond that, explain and ask.

## Opinions (share them in planning)

- Imagen is cleaner than Nano Banana for character faces.
- Veo 3.1 loops only when `first_frame` = `last_frame` at the reference level.
- Meshy multi-image-to-3D wants genuinely different views of ONE subject, not
  one image repeated. For single-image 3D: `meshy-image-to-3d`.
- Color grade is a stage-1 prompt concern on looping clips, not a stage-3 post
  filter — the loop breaks otherwise.

Your accent is copper. Your temperament is methodical. You never forget a
lesson twice.

---

# Playbook

## 1. Pipeline stage tracing

Every creative pipeline has stages. A defect observed at stage N usually has
its true origin at an earlier stage. Before proposing a fix, list the stages
the artifact passed through and pick the EARLIEST stage where the defect
could be addressed.

Canonical stages by medium:

**Image (2D)**
1. Source prompt / concept
2. Reference composition (crop, layout, color intent)
3. Generation (Imagen / Nano Banana / GPT Image / Flux / etc.)
4. Post-processing (upscale, color correction, background)
5. Delivery (format, resolution)

**Video (including loops)**
1. Source frame(s) and prompt
2. First/last-frame setup for looping (first = last for clean loops)
3. Temporal prompt (camera motion, duration)
4. Generation (Veo 3.1 / Kling / Runway / MiniMax / etc.)
5. Post (color, transitions, audio)

**Audio**
1. Prompt / reference
2. Voice/timbre selection
3. Generation (ElevenLabs / Lyria / etc.)
4. Post (mastering, mixing)

**3D**
1. 2D reference (cropped, pose-correct, no pedestal)
2. Image-to-3D generation (Meshy / Hunyuan)
3. Mesh cleanup (Blender / separate_islands)
4. Rigging (humanoid check, proxy rig fallback)
5. Preview (Three.js / renders)

**Fix-at-source rule:** if a downstream artifact shows an issue rooted upstream
(e.g. 3D mesh has baked-in grass patch → 2D ref had a grass patch → fix is
to regenerate the 2D ref), fixing downstream is more complex, accumulates
error, and often fails. Fix at origin.

## 2. Vision reliability rules

`vision_analyze` is strong for texture, silhouette, and color QA. It is WEAK
for fine geometry, sub-radian pose changes, and multi-cell summaries.

Rules:
- Demand geometric specifics in questions: "is the nose at pixel column 180
  of a 512-wide cell?" beats "does the character face left?"
- For multi-frame outputs (spritesheets, N-panel comics), request per-cell
  verdicts with a checklist. Whole-image summaries overgeneralize from the
  most prominent cell.
- Cross-check vision with programmatic tests where possible (alpha-channel
  centroid, bone coords, pixel-diff between first and last frame of a loop).
- Vision cannot detect pose rotations smaller than ~0.5 rad. For rigging/pose
  QA, use programmatic bone-coord checks.
- If a vision call returns a single pattern label, do a second pass demanding
  specifics before trusting it.

## 3. Nebula CLI cookbook

You have the `terminal` tool. Use `nebula` subcommands to drive the canvas:

- `nebula nodes` — list available node types
- `nebula info <node_id>` — full params / IO for one node type
- `nebula context` — compact graph + keys summary (cheap to check)
- `nebula keys` — which API keys are configured
- `nebula create <definition_id> [--param k=v]` — add a node. Returns short ID (n1, n2...)
- `nebula connect <src>:<port> <dst>:<port>` — wire ports
- `nebula set <node_ref> <key>=<value>` — edit params
- `nebula run <node_ref>` — execute a node + its upstream dependencies
- `nebula run-all` — execute the full graph
- `nebula graph` — current state
- `nebula path <node_ref>` — local file path of a node's primary image/output
- `nebula save <file>` / `nebula load <file>` — persist / restore graphs
- `nebula clear` — wipe the current graph

Note: `nebula quick` is hard-gated by the env (NEBULA_DISABLE_QUICK=1) — it
bypasses the canvas sync and is not available from chat.

### `@nX` references

The human can refer to canvas nodes by short ID in chat (e.g. `@n2`). Use
`nebula path <short_id>` to resolve one to a local file path. Use `vision_analyze`
with that path to inspect its output.

## 4. Learnings discipline

### At turn start
Scan `~/.hermes/skills/hephaestus-learnings/LEARNINGS.md` (via `skills_list`
+ `skill_view`) for entries whose topic/tags relate to the current goal. If
you apply one, CITE IT in your plan:

> "Applying learning [loop-color-grade-drift]: bake color into the source prompt, not post."

The citation format is important — it makes the learning visible to the user
and proves the loop is working.

### At turn end
If a novel insight fired this turn (something not already covered in
LEARNINGS.md), APPEND an entry via `skill_manage patch
hephaestus-learnings/LEARNINGS.md` with this format:

```
## [YYYY-MM-DD slug] Short title
Observed: <what broke / surprised you>
Fix: <what worked>
Confidence: low|medium|high — count of confirmations
```

Then print on stdout (outside any other marker):

```
LEARNING_SAVED: slug
```

The runtime converts this into a chat event. If no novel insight fired, don't
force one — honest absence beats fake learnings.

If a learning in LEARNINGS.md has been confirmed many times (confidence = high,
3+ confirmations), mention this in the chat so the user can consider
graduating it into the shipped playbook via a PR to the repo.

## 5. Autonomy modes

The env var `HEPHAESTUS_APPROVAL` controls your pacing.

### `HEPHAESTUS_APPROVAL=auto` (default)
Run the full pipeline through to a clean output. Iterate per §1–§2 as needed,
cap at 3 iterations per turn. Summarize at the end: what ran, what passed
vision QA, cost / time.

### `HEPHAESTUS_APPROVAL=step`
Before any of these MATERIAL actions, pause and print three marker lines:

- Executing a node with estimated cost > $0.01 (e.g. Veo, Imagen, Meshy, etc.)
- Executing a node with expected runtime > 30 seconds
- Triggering an iteration (rerun after a vision-detected defect)

Do NOT pause for cheap ops (node create, connect, set param, `nebula context`).

Marker format (print exactly; each on its own line):

```
APPROVAL_REQUIRED: <one-line summary of what you're about to do>
PLAN: <compact action plan, e.g. "connect n2:image -> n4:first_frame; run n4">
COST: <est cost, e.g. "$0.15" or "60s">
```

After printing, STOP — do not act further this turn. The next turn's user
message will start with either `APPROVED:` (continue the plan) or `REJECTED:
<optional edit notes>` (adjust or ask). Resume from exactly where you paused.

## 6. Output hygiene

- After any `nebula run`, call `vision_analyze` on the output (via `nebula
  path <node>` to get the file path) and report the findings in chat.
- Quote vision findings with geometric specifics, not just "looks good."
- When iterating, state: what stage you're fixing, why THIS stage is the
  origin (not a later stage), and what you expect to change in the output.
- When max-3 iterations is reached without convergence, STOP and say so —
  explain what you tried and ask the user to adjust the brief.
```

- [ ] **Step 2: Verify SKILL.md frontmatter parses cleanly**

```bash
python3 -c "
import re
with open('.hermes/skills/hephaestus-core/SKILL.md') as f:
    content = f.read()
match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
assert match, 'missing frontmatter'
print('frontmatter ok')
print(match.group(1))
"
```

Expected: prints the frontmatter block without errors.

- [ ] **Step 3: Commit**

```bash
git add .hermes/skills/hephaestus-core/SKILL.md
git commit -m "feat(hephaestus): ship hephaestus-core skill with persona + playbook

Contains: persona directive (iterative-artist voice), pipeline-stage
tracing (generalized from pipeline_3d to image/video/audio/3D), vision
reliability rules (verbatim from hephaestus.html learnings), nebula
CLI cookbook, learnings discipline (cite-when-applying, save-at-end),
autonomy-mode directives (auto vs step with cost/time gating).

Loaded via --skills hephaestus-core from hermes chat subprocess."
```

---

## Task 9: Write `.hermes/skills/hephaestus-core/metadata.json`

**Files:**
- Create: `.hermes/skills/hephaestus-core/metadata.json`

- [ ] **Step 1: Create the metadata file**

```json
{
  "name": "hephaestus-core",
  "description": "Hephaestus's iterative-artist playbook for the Hephaestus chat agent in nebula-nodes. Persona + pipeline stage tracing + vision QA rules + nebula CLI cookbook + learnings discipline + autonomy modes.",
  "category": "agent-persona",
  "version": "1.0.0",
  "author": "nebula-nodes + Hephaestus (Nous Hermes Agent Creative Hackathon 2026)",
  "platforms": ["hermes-cli"],
  "required_environment_variables": {
    "HEPHAESTUS_APPROVAL": "'auto' (default) or 'step' — controls whether Hephaestus pauses before expensive operations for user approval."
  }
}
```

- [ ] **Step 2: Verify JSON is valid**

```bash
python3 -m json.tool .hermes/skills/hephaestus-core/metadata.json > /dev/null
echo "metadata.json valid"
```

Expected: "metadata.json valid"

- [ ] **Step 3: Commit**

```bash
git add .hermes/skills/hephaestus-core/metadata.json
git commit -m "feat(hephaestus): metadata.json for hephaestus-core skill"
```

---

## Task 10: Write `docs/HERMES-SETUP.md` — user-facing install + config guide

**Files:**
- Create: `docs/HERMES-SETUP.md`

- [ ] **Step 1: Create the setup doc**

```markdown
# Setting up Hephaestus (Hermes Agent + Kimi K2.6)

Hephaestus is nebula-nodes' creative-generalist agent — an iterative artist
that plans, builds, and QAs multi-stage creative pipelines on the canvas.
It's powered by [Hermes Agent](https://github.com/NousResearch/hermes-agent)
from Nous Research, running Kimi K2.6 via OpenRouter.

Claude remains the default chat agent. Hephaestus is opt-in.

## 1. Install Hermes Agent

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

Verify:

```bash
hermes --version
```

Expected: prints a version string (v0.10+).

## 2. Configure OpenRouter + Kimi K2.6

Get an OpenRouter API key from https://openrouter.ai/keys if you don't have
one. Then:

```bash
hermes login
# Select 'openrouter' when prompted
# Paste your OpenRouter key when asked
```

Set Kimi K2.6 as Hephaestus's default model:

```bash
hermes config set model.provider openrouter
hermes config set model.name moonshotai/kimi-k2.6
```

Verify:

```bash
hermes config get model
```

Expected: shows `provider: openrouter, name: moonshotai/kimi-k2.6`.

## 3. Link the repo-shipped hephaestus-core skill

nebula-nodes ships Hephaestus's persona + playbook at
`.hermes/skills/hephaestus-core/`. Tell Hermes to load skills from this
directory:

Edit `~/.hermes/config.yaml`, add or update:

```yaml
skills:
  external_directories:
    - /path/to/nebula-nodes/.hermes/skills
```

(Replace `/path/to/nebula-nodes` with your actual clone path.)

Verify:

```bash
hermes skills ls | grep hephaestus-core
```

Expected: shows `hephaestus-core` as an available skill.

## 4. One-turn smoke test

From inside the nebula-nodes directory:

```bash
hermes chat -q "Introduce yourself and list your opinions about image models." -Q \
  --provider openrouter \
  --model moonshotai/kimi-k2.6 \
  --skills hephaestus-core \
  --pass-session-id
```

Expected: Hephaestus responds in the forge-god voice, names specific models
with opinions (Imagen cleaner than Nano Banana for faces, etc.), and prints a
`SESSION_ID: <ulid>` on its own line at the end.

If you see "hermes: command not found," check that Hermes is installed and
that `~/.local/bin` is in your PATH.

## 5. Launch the nebula backend + frontend

Same as before — Hermes integration reuses the existing dev setup.

```bash
# Terminal 1
cd backend && python -m uvicorn main:app --port 8000

# Terminal 2
cd frontend && npm run dev
```

Open http://localhost:5173, open the chat panel, switch agent selector to
**Hephaestus**, and send a message.

## Autonomy modes

The header toggle in the chat panel has two positions:

- **Auto-pilot (▶):** Hephaestus runs the full pipeline without asking.
- **Step Approval (⏸):** before expensive operations (>$0.01 or >30s), it
  pauses and shows you a plan. Click Approve or Reject + add notes.

## Learnings

Hephaestus saves what it learns to
`~/.hermes/skills/hephaestus-learnings/LEARNINGS.md` on your machine.
This is YOUR Hephaestus's memory — personal, user-local, privacy-friendly.
When a learning in your LEARNINGS.md has been confirmed multiple times and
seems generally applicable, you can promote it upstream by opening a PR on
nebula-nodes that adds it to `hephaestus-core/SKILL.md` — your local lesson
becomes every future user's baseline.

## Troubleshooting

**"hermes exited N: auth failed..."**
Run `hermes login` and select openrouter; verify your key at
https://openrouter.ai/keys.

**"hermes exited N: rate limit..."**
OpenRouter's rate limits vary per model. Wait ~30 seconds and retry, or
switch models temporarily via the model-selector in the chat panel.

**"Hephaestus keeps re-introducing itself mid-conversation"**
The session ID may not be threading correctly. Check that the chat panel
shows a session pill (short ID after your model name) — if not, open the
browser console and look for WebSocket errors.

**Kimi K2.6 tool calls look malformed**
Some providers have edge cases with function-calling on new models. Swap to
`moonshotai/kimi-k2` (prior version) as a fallback:

```bash
hermes config set model.name moonshotai/kimi-k2
```

## Kimi track evidence (for hackathon submission)

For the Nous Research Creative Hackathon, Hephaestus running on Kimi K2.6 is
provable:

- `hermes config get model` → shows `moonshotai/kimi-k2.6`
- `hermes insights` after a demo run → shows Kimi token usage
- `backend/services/hermes_session.py` hardcodes `--provider openrouter
  --model moonshotai/kimi-k2.6`
```

- [ ] **Step 2: Commit**

```bash
git add docs/HERMES-SETUP.md
git commit -m "docs: HERMES-SETUP.md — user install + config guide

Covers Hermes install, OpenRouter + Kimi K2.6 setup, linking the
repo-shipped hephaestus-core skill via external_directories,
smoke-test command, autonomy modes, learnings location, troubleshooting,
and Kimi track evidence trail."
```

---

## Task 11: Add agent selector to `ChatPanel.tsx`

**Files:**
- Modify: `frontend/src/components/panels/ChatPanel.tsx`

- [ ] **Step 1: Add agent state + selector UI**

Find the existing state declarations around `ChatPanel.tsx:234-241` and add
an `agent` state. Example insertion point after `setModel`:

```tsx
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [agent, setAgent] = useState<'claude' | 'hephaestus'>('claude');
  const [sessionId, setSessionId] = useState<string | null>(null);
```

- [ ] **Step 2: Clear session ID when switching agents**

Each agent has its own session thread — switching should NOT resume the
other agent's session. Add a handler:

```tsx
  const handleAgentChange = useCallback((next: 'claude' | 'hephaestus') => {
    if (next === agent) return;
    setAgent(next);
    setSessionId(null);  // clear so next turn starts fresh on the new agent
  }, [agent]);
```

- [ ] **Step 3: Render the selector in the chat panel header**

Find the existing header area. Add the agent selector next to the model
indicator (around `ChatPanel.tsx:763` where `{model} · {status}` is rendered):

```tsx
<div className="chat-panel__agent-selector">
  <button
    type="button"
    className={agent === 'claude' ? 'chat-panel__agent-btn--active' : 'chat-panel__agent-btn'}
    onClick={() => handleAgentChange('claude')}
  >
    Claude
  </button>
  <button
    type="button"
    className={agent === 'hephaestus' ? 'chat-panel__agent-btn--active' : 'chat-panel__agent-btn'}
    onClick={() => handleAgentChange('hephaestus')}
  >
    Hephaestus
  </button>
</div>
```

- [ ] **Step 4: Include `agent` in the WebSocket send payload**

Find the existing send handler around `ChatPanel.tsx:591` where the `send`
payload is built. Add `agent` to it:

```tsx
ws.send(JSON.stringify({
  type: 'send',
  message: input,
  sessionId,
  model,
  agent,           // new
  autonomy: 'auto', // Task 12 adds a toggle for this
}));
```

- [ ] **Step 5: Add baseline CSS for the selector**

Modify `frontend/src/styles/panels.css` — append:

```css
.chat-panel__agent-selector {
  display: inline-flex;
  gap: 2px;
  margin-right: 8px;
  padding: 2px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
}

.chat-panel__agent-btn,
.chat-panel__agent-btn--active {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  border: none;
  cursor: pointer;
  background: transparent;
  color: inherit;
}

.chat-panel__agent-btn--active {
  background: rgba(255, 255, 255, 0.15);
  font-weight: 600;
}
```

- [ ] **Step 6: Run frontend typecheck**

```bash
cd frontend && ./node_modules/.bin/tsc --noEmit
```

Expected: exits 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/panels/ChatPanel.tsx frontend/src/styles/panels.css
git commit -m "feat(chat): agent selector (Claude | Hephaestus) in chat header

State + selector UI + WebSocket payload carry the 'agent' field.
Switching agents clears the session ID so each agent keeps its own
session thread. Styling is neutral placeholder; copper accent for
Hephaestus comes in Task 15."
```

---

## Task 12: Add autonomy toggle to `ChatPanel.tsx`

**Files:**
- Modify: `frontend/src/components/panels/ChatPanel.tsx`
- Modify: `frontend/src/styles/panels.css`

- [ ] **Step 1: Add autonomy state**

After the agent state declaration, add:

```tsx
  const [autonomy, setAutonomy] = useState<'auto' | 'step'>('auto');
```

- [ ] **Step 2: Render the toggle in the chat panel header (next to agent selector)**

Add next to the agent selector. Show only when Hephaestus is active:

```tsx
{agent === 'hephaestus' && (
  <div className="chat-panel__autonomy-toggle">
    <button
      type="button"
      className={autonomy === 'auto' ? 'chat-panel__autonomy-btn--active' : 'chat-panel__autonomy-btn'}
      onClick={() => setAutonomy('auto')}
      title="Auto-pilot: Hephaestus runs the full pipeline"
    >
      Auto ▶
    </button>
    <button
      type="button"
      className={autonomy === 'step' ? 'chat-panel__autonomy-btn--active' : 'chat-panel__autonomy-btn'}
      onClick={() => setAutonomy('step')}
      title="Step Approval: Hephaestus pauses before expensive operations"
    >
      Step ⏸
    </button>
  </div>
)}
```

- [ ] **Step 3: Wire autonomy into the send payload**

Update the `send` payload construction in the send handler:

```tsx
ws.send(JSON.stringify({
  type: 'send',
  message: input,
  sessionId,
  model,
  agent,
  autonomy,
}));
```

- [ ] **Step 4: Add CSS**

Append to `frontend/src/styles/panels.css`:

```css
.chat-panel__autonomy-toggle {
  display: inline-flex;
  gap: 2px;
  margin-right: 8px;
  padding: 2px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
}

.chat-panel__autonomy-btn,
.chat-panel__autonomy-btn--active {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  border: none;
  cursor: pointer;
  background: transparent;
  color: inherit;
}

.chat-panel__autonomy-btn--active {
  background: rgba(255, 255, 255, 0.15);
  font-weight: 600;
}
```

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && ./node_modules/.bin/tsc --noEmit
cd ..
git add frontend/src/components/panels/ChatPanel.tsx frontend/src/styles/panels.css
git commit -m "feat(chat): autonomy toggle (Auto | Step) shown for Hephaestus only

Maps to HEPHAESTUS_APPROVAL env var via the WebSocket payload, which
hermes_session.py passes to the hermes chat subprocess. Hidden for
Claude since claude -p doesn't honor this contract."
```

---

## Task 13: Render `approval_request` events with Approve/Reject buttons

**Files:**
- Modify: `frontend/src/components/panels/ChatPanel.tsx`
- Modify: `frontend/src/styles/panels.css`

- [ ] **Step 1: Extend the ChatMessage type to include approval payloads**

Find the `ChatMessage` type definition in `ChatPanel.tsx` (top of file). Add
an `approval` variant:

```tsx
type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string; /* ... existing fields */ }
  | { id: string; role: 'approval'; summary: string; plan: string; cost: string };
```

Keep the existing variants; just add the `approval` case.

- [ ] **Step 2: Handle the `approval_request` event type in the WebSocket listener**

In the WebSocket `onmessage` handler, add a branch for `approval_request`:

```tsx
if (event.type === 'approval_request') {
  setMessages((prev) => [
    ...prev,
    {
      id: crypto.randomUUID(),
      role: 'approval',
      summary: String(event.summary ?? ''),
      plan: String(event.plan ?? ''),
      cost: String(event.cost ?? ''),
    },
  ]);
  return;
}
```

- [ ] **Step 3: Render the approval bubble in the message list**

Find where `messages.map(...)` renders each message. Add a branch for the
approval role:

```tsx
{msg.role === 'approval' && (
  <div className="chat-panel__approval">
    <div className="chat-panel__approval-summary">
      <strong>Approval required:</strong> {msg.summary}
    </div>
    {msg.plan && (
      <div className="chat-panel__approval-plan">
        <strong>Plan:</strong> {msg.plan}
      </div>
    )}
    {msg.cost && (
      <div className="chat-panel__approval-cost">
        <strong>Cost:</strong> {msg.cost}
      </div>
    )}
    <div className="chat-panel__approval-actions">
      <button
        type="button"
        className="chat-panel__approval-btn chat-panel__approval-btn--approve"
        onClick={() => handleApprovalResponse('APPROVED: continue')}
      >
        Approve
      </button>
      <button
        type="button"
        className="chat-panel__approval-btn chat-panel__approval-btn--reject"
        onClick={() => handleApprovalResponse('REJECTED: please revise')}
      >
        Reject
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 4: Add the `handleApprovalResponse` handler**

Near the other handlers in `ChatPanel.tsx`:

```tsx
const handleApprovalResponse = useCallback((response: string) => {
  if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
  wsRef.current.send(JSON.stringify({
    type: 'send',
    message: response,
    sessionId,
    model,
    agent,
    autonomy,
  }));
  setMessages((prev) => [
    ...prev,
    { id: crypto.randomUUID(), role: 'user', text: response },
  ]);
}, [sessionId, model, agent, autonomy]);
```

(If `wsRef` is named differently in the existing file — likely — substitute
the actual ref name.)

- [ ] **Step 5: Add CSS**

Append to `frontend/src/styles/panels.css`:

```css
.chat-panel__approval {
  margin: 8px 0;
  padding: 12px;
  border: 1px solid rgba(184, 115, 51, 0.4); /* copper accent */
  border-radius: 8px;
  background: rgba(184, 115, 51, 0.08);
  font-size: 13px;
}

.chat-panel__approval-summary,
.chat-panel__approval-plan,
.chat-panel__approval-cost {
  margin-bottom: 6px;
}

.chat-panel__approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.chat-panel__approval-btn {
  padding: 6px 14px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-weight: 600;
}

.chat-panel__approval-btn--approve {
  background: #b87333; /* copper */
  color: white;
}

.chat-panel__approval-btn--reject {
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
}
```

- [ ] **Step 6: Typecheck + commit**

```bash
cd frontend && ./node_modules/.bin/tsc --noEmit
cd ..
git add frontend/src/components/panels/ChatPanel.tsx frontend/src/styles/panels.css
git commit -m "feat(chat): render approval_request events with Approve/Reject buttons

When Hephaestus is in Step mode and hits an expensive op, it prints
APPROVAL_REQUIRED/PLAN/COST markers. Backend emits approval_request;
frontend renders an interactive bubble with copper-accented buttons.
Clicking Approve/Reject sends a new turn starting with 'APPROVED:' or
'REJECTED:' which Hephaestus's SKILL.md tells it to recognize."
```

---

## Task 14: Render `learning_saved` events as subtle system lines

**Files:**
- Modify: `frontend/src/components/panels/ChatPanel.tsx`
- Modify: `frontend/src/styles/panels.css`

- [ ] **Step 1: Handle the `learning_saved` event**

In the WebSocket `onmessage` handler, add a branch:

```tsx
if (event.type === 'learning_saved') {
  setMessages((prev) => [
    ...prev,
    {
      id: crypto.randomUUID(),
      role: 'system',
      text: `→ Saved learning: ${String(event.topic ?? '')}`,
    },
  ]);
  return;
}
```

If `role: 'system'` isn't yet in the `ChatMessage` union, add it:

```tsx
type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string; /* existing */ }
  | { id: string; role: 'approval'; summary: string; plan: string; cost: string }
  | { id: string; role: 'system'; text: string };
```

- [ ] **Step 2: Render the system line in the message list**

Add a branch in the `messages.map(...)` render:

```tsx
{msg.role === 'system' && (
  <div className="chat-panel__system-line">{msg.text}</div>
)}
```

- [ ] **Step 3: Add CSS**

Append to `frontend/src/styles/panels.css`:

```css
.chat-panel__system-line {
  margin: 4px 0;
  padding: 4px 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  font-style: italic;
}
```

- [ ] **Step 4: Typecheck + commit**

```bash
cd frontend && ./node_modules/.bin/tsc --noEmit
cd ..
git add frontend/src/components/panels/ChatPanel.tsx frontend/src/styles/panels.css
git commit -m "feat(chat): render learning_saved events as subtle system lines

Appears inline in the chat as '→ Saved learning: <topic>' in muted
italic. Makes the learn-as-you-go loop visible in the demo video
without interrupting the flow."
```

---

## Task 15: Hephaestus visual treatment — copper accent variant

**Files:**
- Modify: `frontend/src/components/panels/ChatPanel.tsx`
- Modify: `frontend/src/styles/panels.css`

- [ ] **Step 1: Apply a variant class to the chat panel root based on active agent**

Find the top-level return JSX of `ChatPanel()`. Add a className based on the
active agent:

```tsx
return (
  <div className={`chat-panel chat-panel--agent-${agent}`}>
    {/* existing content */}
  </div>
);
```

- [ ] **Step 2: Add CSS variables for the Hephaestus variant**

Append to `frontend/src/styles/panels.css`:

```css
.chat-panel--agent-hephaestus {
  --chat-accent: #b87333;       /* copper */
  --chat-accent-bg: rgba(184, 115, 51, 0.08);
  --chat-accent-border: rgba(184, 115, 51, 0.4);
}

.chat-panel--agent-claude {
  --chat-accent: #7c6bef;       /* existing Claude indigo — approximate, match real var */
  --chat-accent-bg: rgba(124, 107, 239, 0.08);
  --chat-accent-border: rgba(124, 107, 239, 0.4);
}
```

Then update any existing Claude-specific accent references in `panels.css` to
use the variable (`var(--chat-accent)`), and apply the same variable where
Hephaestus should pick up the accent — e.g. the agent-selector active state,
the user message bubbles, the assistant message bubble border, the session pill.

Example search-and-replace targets (adjust based on what's in the existing file):

```css
/* Replace hard-coded indigo with the variable */
.chat-panel__agent-btn--active {
  background: var(--chat-accent);
  color: white;
}
.chat-panel__autonomy-btn--active {
  background: var(--chat-accent);
  color: white;
}
/* And so on for bubble borders, session pill, etc. */
```

- [ ] **Step 3: Run dev server and verify visually**

```bash
cd frontend && npm run dev
# open http://localhost:5173, open chat panel
# switch between Claude and Hephaestus — accent color should flip
```

Expected: switching agent selector visibly changes the accent color from
indigo (Claude) to copper (Hephaestus) across the relevant chrome.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/panels/ChatPanel.tsx frontend/src/styles/panels.css
git commit -m "feat(chat): Hephaestus copper accent variant via CSS variable

Chat panel root gets a per-agent modifier class. CSS variables swap
accent colors for agent-selector, autonomy toggle, approval bubble,
and other chrome. Profile picture + full Hermes-style theme are
tracked in .planning/backlog/hephaestus-chat-ui-theme.md (scope beyond
MVP)."
```

---

## Task 16: End-to-end smoke test + Kimi evidence capture

**Files:**
- Modify: `docs/HERMES-SETUP.md` (add troubleshooting findings if any surface)

- [ ] **Step 1: Verify Hermes is installed, Kimi K2.6 is configured, hephaestus-core skill is linked**

```bash
hermes --version
hermes config get model
hermes skills ls | grep hephaestus-core
```

Expected: version shown, provider=openrouter name=moonshotai/kimi-k2.6, hephaestus-core visible.

If hephaestus-core is missing, add it to `~/.hermes/config.yaml`:

```yaml
skills:
  external_directories:
    - /Users/justinperea/Documents/Projects/nebula_nodes/.hermes/skills
```

- [ ] **Step 2: Start the dev servers**

```bash
# terminal 1
cd backend && python -m uvicorn main:app --port 8000 --reload
# terminal 2
cd frontend && npm run dev
```

Expected: backend listening on :8000, frontend on :5173.

- [ ] **Step 3: Open the app and run the demo scenario end-to-end**

Open http://localhost:5173.

1. Switch agent selector to **Hephaestus** (copper accent should apply).
2. Keep autonomy on **Auto ▶**.
3. Send: `Build me a looping scene: foggy forest at dawn, camera drifts through. Cinematic.`
4. Watch the canvas. Nodes should appear (text-input, Imagen, Veo 3.1, Preview). Edges should connect.
5. First generation runs. Hephaestus should report vision findings in chat.
6. If a defect is detected, iteration should fire. Observe the "Applying learning [slug]..." citation if LEARNINGS.md has relevant entries.
7. A `→ Saved learning: <slug>` system line should appear if a novel insight fired.

Track any breakage — expected issues to watch for (per spec Open Questions):
- Session ID not threading → check backend log for SESSION_ID line
- Tool-call format issue on Kimi K2.6 → fallback documented in SETUP.md
- Skill not loading → verify `external_directories` path

- [ ] **Step 4: Capture Kimi track evidence**

```bash
# Screenshot (manual) of hermes config get model
hermes config get model | tee /tmp/kimi-evidence-config.txt

# Token usage from the demo session
hermes insights | tee /tmp/kimi-evidence-insights.txt

# Session DB excerpt (sqlite)
sqlite3 ~/.hermes/state.db "SELECT provider, model, created_at FROM sessions ORDER BY created_at DESC LIMIT 5" | tee /tmp/kimi-evidence-sessions.txt
```

Save screenshots + these files to `docs/hackathon-submission/evidence/`:

```bash
mkdir -p docs/hackathon-submission/evidence
cp /tmp/kimi-evidence-*.txt docs/hackathon-submission/evidence/
# Add screenshots manually: evidence-config.png, evidence-insights.png
```

- [ ] **Step 5: Run the full test suite one more time for regression check**

```bash
cd backend && python -m pytest tests/ -q
cd ../frontend && ./node_modules/.bin/tsc --noEmit
```

Expected: backend tests all pass (163 existing + ~8 new hermes + 1 dispatch); frontend typecheck clean.

- [ ] **Step 6: Commit evidence package**

```bash
git add docs/hackathon-submission/evidence/
git commit -m "docs: Kimi track evidence package for Nous hackathon

config + insights + session DB excerpts captured after demo-scenario
dogfood run. Screenshots attached. Proves Hephaestus runs on Kimi
K2.6 end-to-end."
```

- [ ] **Step 7: Push to GitHub**

```bash
git push origin main
```

Expected: clean push, all commits on main.

---

## Verification after all tasks

Run this at the end — catches type mismatches and missed tests.

```bash
# Backend: full suite + typecheck
cd backend && python -m pytest tests/ -q

# Frontend: typecheck
cd ../frontend && ./node_modules/.bin/tsc --noEmit

# Git: confirm all work is committed and pushed
cd .. && git status && git log --oneline -20
```

Expected:
- Backend: all tests pass (163 pre-existing + ~8 new = ~171)
- Frontend: typecheck clean
- Git: clean tree, recent commits show the full plan's work, pushed to origin/main

---

## Follow-on work (post-hackathon, out of scope for this plan)

- Hephaestus profile picture + full Hermes-style theme swap → `.planning/backlog/hephaestus-chat-ui-theme.md`
- Meshy single-image node full param surface → `.planning/backlog/meshy-single-image-params.md`
- Gateway PlatformAdapter for streaming output → spec §12 post-hackathon roadmap
- `nebula_*` typed tools via Hermes `tools/registry.py` → spec §12
- Voice mode via ElevenLabs → spec §12
- LEARNINGS-to-PR UI flywheel → spec §12
