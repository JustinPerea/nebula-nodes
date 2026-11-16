"""Where a person adds a Moodboard reader's key. A leaf module with no imports,
so the reader (services/moodboard_reader.py) and the CLI's cost estimate
(cli/commands/moodboard.py) say the same path without the CLI importing the
reader's HTTP client."""
from __future__ import annotations

# The Settings > Providers section each reader key is saved in (providerCatalog.ts label).
_KEY_SECTIONS = {"GOOGLE_API_KEY": "Google · Gemini API"}


def key_settings_path(key_name: object) -> str:
    """"Settings > Providers > Google · Gemini API", or "Settings > Providers"
    for a key whose section isn't listed."""
    section = _KEY_SECTIONS.get(str(key_name))
    return "Settings > Providers" + (f" > {section}" if section else "")
