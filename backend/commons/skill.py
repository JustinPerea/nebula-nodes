"""The use-the-commons skill text, injected into Nebula's runners and the MCP instructions."""
from pathlib import Path

COMMONS_SKILL = Path(__file__).with_name("skill.md").read_text(encoding="utf-8")
