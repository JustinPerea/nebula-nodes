"""Pytest setup: sandbox file-system paths so tests never touch the user's
real working tree.

- NEBULA_STATE_DIR → temp dir, so auto-persist of cli_graph doesn't overwrite
  the user's real ~/.nebula/state.json.
- NEBULA_OUTPUT_ROOT → temp dir, so handlers that write generated images
  (and the three handler tests that `shutil.rmtree` their root at teardown)
  don't wipe the user's real output/ directory. The old behavior destroyed
  hours of Daedalus work when the test suite ran against the shared OUTPUT_ROOT.

Both must be set BEFORE any test module imports `main` or `services.output`,
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
