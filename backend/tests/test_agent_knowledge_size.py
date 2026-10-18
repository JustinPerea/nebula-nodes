"""The provider knowledge an in-app Claude session copies stays under its caps.

services/agent_knowledge.py snapshot_provider_knowledge refuses the whole
snapshot when one tracked file is over MAX_KNOWLEDGE_FILE_BYTES (or the set
is over its file count or total), and that refusal makes every in-app Claude
turn fail. Generated files grow quietly (docs/MODEL_REFERENCE.md gains a
settings table per provider for each route-table node), so this fails at 85%
of each cap, while there is still room to split or trim the file.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from services import agent_knowledge as knowledge  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MARGIN = 0.85


def _knowledge_files() -> list[Path]:
    """The files a snapshot would copy: tracked (git, or the portable
    manifest in a source ZIP) and allowed by type and root."""
    return [Path(entry) for entry in knowledge._tracked_files(ROOT)
            if entry and knowledge._allowed_relative(Path(entry)) and (ROOT / entry).is_file()]


def test_every_knowledge_file_stays_well_under_the_per_file_cap():
    limit = int(knowledge.MAX_KNOWLEDGE_FILE_BYTES * MARGIN)
    files = _knowledge_files()
    assert Path("docs/MODEL_REFERENCE.md") in files
    over = {str(path): (ROOT / path).stat().st_size for path in files if (ROOT / path).stat().st_size > limit}
    assert not over, (f"over {limit} bytes (85% of the {knowledge.MAX_KNOWLEDGE_FILE_BYTES}-byte cap in "
                      f"services/agent_knowledge.py; a file over the cap makes every in-app Claude turn fail): {over}")


def test_the_knowledge_set_stays_well_under_its_count_and_total_caps():
    files = _knowledge_files()
    total = sum((ROOT / path).stat().st_size for path in files)
    assert len(files) <= knowledge.MAX_KNOWLEDGE_FILES * MARGIN, len(files)
    assert total <= knowledge.MAX_KNOWLEDGE_BYTES * MARGIN, total
