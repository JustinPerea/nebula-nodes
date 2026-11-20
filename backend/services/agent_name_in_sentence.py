"""A personal agent's name inside a sentence. A leaf module with no imports, so
the CLI's formatters can use it without loading the personal-agent stack (and
its subprocess and HTTP code). services.personal_agents re-exports it as
``in_sentence``."""
from __future__ import annotations


def in_sentence(name: str) -> str:
    """A personal agent's name inside a sentence, an aria-label or a title.

    The presets are named "Your Claude", "Your Codex", "Your Gemini" and "Your
    Antigravity", with the capital where the name starts a label or a sentence.
    Mid-sentence the first word drops to lower case ("Use your Gemini in
    chat"). Any other name, such as "Claude (your setup)" stored before the
    change, "Hermes" or a custom agent, comes back unchanged. Twin of
    ``agentNameInSentence`` in frontend/src/lib/personalAgentName.ts.
    """
    return f"your {name[5:]}" if name.startswith("Your ") and len(name) > 5 else name


def withdrawn_line(author_name: str, closed_by: dict[str, object] | None = None) -> str:
    """How an Update says its proposal or question set was withdrawn, without
    a closing period (the question sets' line adds its own).

    The Update sits under its author's header (and `nebula notes` and
    `list_notes` print the author beside the line), so when the author closed
    it the line is just "Withdrawn". When someone else did the "by" stays:
    "Withdrawn by you." for the person, "Withdrawn by Claude Code" for another
    agent. ``closed_by`` is the Update's ``resolvedBy``: {"kind": "agent",
    "name"} or {"kind": "person"}; None is the author, the only agent Nebula
    lets withdraw (the routes answer 403 to any other).
    """
    closer = closed_by or {}
    kind, name = closer.get("kind"), str(closer.get("name") or "")
    if kind == "person":
        return "Withdrawn by you"
    if kind == "agent" and name and name != author_name:
        return f"Withdrawn by {in_sentence(name)}"
    return "Withdrawn"
