"""The use-the-commons skill text, injected into Nebula's runners and the MCP instructions.

COMMONS_SKILL names only the MCP tools: it is what MCP clients and agents whose
shell can't reach Nebula (in-app Codex) get. COMMONS_CLI_SKILL adds the
`nebula commons` CLI twins, for agents whose shell does reach Nebula (in-app Claude).
"""
from pathlib import Path

_HERE = Path(__file__).parent
COMMONS_SKILL = (_HERE / "skill.md").read_text(encoding="utf-8")
COMMONS_CLI_SKILL = f"{COMMONS_SKILL}\n{(_HERE / 'skill_cli.md').read_text(encoding='utf-8')}"
