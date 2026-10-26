"""The error a handler raises when its provider key isn't set."""
from __future__ import annotations

import re

from execution.person_line import key_line, with_person_line

# "OPENAI_API_KEY is required", "ELEVENLABS_API_KEY or RUNWAY_API_KEY is required".
_PLAIN_KEY_CHECK = re.compile(r"([A-Z][A-Z0-9_]*(?: or [A-Z][A-Z0-9_]*)*) is required")


class MissingCredentialError(ValueError):
    """A handler's credential check failed before it contacted any provider.

    Raise it only from a check that runs before the handler's first provider
    request. The engine marks the node's ErrorEvent with it, and the agent
    spending limits give that node's share of the run's hold back: a node
    that never reached its provider can't have cost anything. Anywhere a
    request may already have gone out, raise a plain ValueError instead, so
    the hold stays counted.

    The plain "<KEY> is required" text (and "<KEY> or <KEY> is required")
    carries the person's line by itself (error copy round 3c-2): "Add your
    OpenAI API key in Settings, then run the node again." Before, the card
    read the classifier's "Check the node's inputs and parameters." for it,
    the wrong fix. The text agents read is unchanged. Any other text writes
    its own line with with_person_line.
    """

    def __init__(self, *args: object) -> None:
        super().__init__(*args)
        match = _PLAIN_KEY_CHECK.fullmatch(str(args[0])) if len(args) == 1 else None
        line = key_line(match.group(1).split(" or ")) if match else None
        if line:
            with_person_line(self, line)
