"""Entry point for `python -m nebula` from the project root."""
import sys
from pathlib import Path

# Add backend/ to sys.path so cli imports resolve
_backend = str(Path(__file__).resolve().parent.parent / "backend")
if _backend not in sys.path:
    sys.path.insert(0, _backend)

from cli.__main__ import main  # noqa: E402

main()
