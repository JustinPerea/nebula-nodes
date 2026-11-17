"""How a Moodboard reader's missing key is asked for. A leaf module with no
imports, so the reader (services/moodboard_reader.py) and the CLI's cost
estimate (cli/commands/moodboard.py) say the same thing without the CLI
importing the reader's HTTP client."""
from __future__ import annotations

# What the person calls each reader key (the Providers tab's name for it).
_KEY_NOUNS = {"GOOGLE_API_KEY": "a Gemini API key"}


def add_key_sentence(key_name: object) -> str:
    """"Add a Gemini API key in Settings.", or "Add OTHER_KEY in Settings." for
    a key whose person-facing name isn't listed."""
    noun = _KEY_NOUNS.get(str(key_name)) or str(key_name)
    return f"Add {noun} in Settings."
