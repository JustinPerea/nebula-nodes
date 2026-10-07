"""Refresh the portable tracked-text inventory used in GitHub source ZIPs."""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from services.agent_knowledge import KNOWLEDGE_PATHS, _allowed_relative  # noqa: E402

result = subprocess.run(["git", "ls-files", "-z", "--", *KNOWLEDGE_PATHS], cwd=ROOT,
                        capture_output=True, check=True)
paths = sorted({entry for entry in result.stdout.decode("utf-8").split("\0")
                if entry and _allowed_relative(Path(entry))})
destination = ROOT / "backend/data/provider_knowledge_manifest.json"
destination.write_text(json.dumps({"version": 1, "paths": paths}, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {len(paths)} provider knowledge paths")
