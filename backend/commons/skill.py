"""The use-the-commons skill text, injected into Nebula's runners and the MCP instructions.

COMMONS_SKILL names only the MCP tools: it is what agents whose shell can't
reach Nebula (in-app Codex) get. COMMONS_CLI_SKILL adds the `nebula commons`
CLI twins, for agents whose shell does reach Nebula (in-app Claude).

COMMONS_MCP_GUIDE is the short part, up to the `mcp-guide-end` marker: the
two safety lines first, then when to search and how to borrow. The MCP
server's instructions carry only that part, because Claude Code shows only
the first 4,096 characters of a server's instructions; the rest of the guide
is in commons_get's and commons_borrow's descriptions (plan v2.7, PR26).
"""
from pathlib import Path

_HERE = Path(__file__).parent
_MARKER = "<!-- mcp-guide-end -->"
_TEXT = (_HERE / "skill.md").read_text(encoding="utf-8")
COMMONS_MCP_GUIDE = _TEXT.split(_MARKER, 1)[0].rstrip() + "\n"
COMMONS_SKILL = _TEXT.replace(_MARKER + "\n", "")
COMMONS_CLI_SKILL = f"{COMMONS_SKILL}\n{(_HERE / 'skill_cli.md').read_text(encoding='utf-8')}"
