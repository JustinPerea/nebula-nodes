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
