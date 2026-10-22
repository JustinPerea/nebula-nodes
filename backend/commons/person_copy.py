"""What the person reads when a Commons call is refused (GM - Design, error-copy round 2).

GM: "Raw backend exception text: fix it at the backend. Log str(exc) and send
written copy." And on the split: "People get the written line and agents keep
the specific detail." So a refusal carries two texts: its message (str(exc)),
specific and technical, for agents (they read `detail` to fix their call) and
the log; and `person`, a line written to GM's patterns, for the person's UI.
Messages already written for people (most of evaluation.EvaluationError's)
need no `person`: they are the line.
"""
from __future__ import annotations

# GM's 4xx fallback, the same words the frontend shows for a refusal with no reason.
FALLBACK = "That didn't work. Try again, or reload if it keeps happening."

# GM's lines, verbatim.
BAD_FILTERS = "Those filters didn't work. Clear them and try again."
UNKNOWN_SETTING = "That setting isn't available. Reload to get the latest settings."

# Written to GM's patterns; listed in docs/notes/2026-10-22-fix-error-copy.md for GM.
BAD_SETTING_VALUE = "That value doesn't work for this setting. Reload to get the latest settings."
FOLDER_UNREADABLE = "Nebula can't read that folder. Check that it exists and that Nebula can open it."

# Intake refusals by their machine code (IntakeError.code): the URL route's
# 422, and each refused file in an upload (its `person` field, which the
# frontend shows under "Couldn't upload {filename}."). The only copy of these
# words; FALLBACK and "too_large" match the frontend's lib/errorCopy.ts
# (pinned by test_commons_person_copy).
INTAKE = {
    "too_large": "That's too large to save.",
    "unsupported_type": "Nebula can't read that file type. Use JPG, PNG, WebP, GIF, HEIC, MP4 or MOV.",
    "unreadable": "That file couldn't be read. It may be damaged.",
    "unknown_collection": "That collection isn't there anymore. Reload to get the latest collections.",
    "fetch_failed": "Nebula couldn't get that URL. Check the address, or save the image and upload it.",
    "blocked": "Nebula can't fetch that address. Use a public image URL.",
}


class Refused(ValueError):
    """A ValueError whose message is the specific text (agents, the log) and
    whose `person` is the line for the person's UI."""

    def __init__(self, message: str, person: str | None = None):
        super().__init__(message)
        self.person = person


def person_line(exc: BaseException, fallback: str = FALLBACK) -> str:
    """The person's line for a refusal: its own `person`, else `fallback`."""
    return getattr(exc, "person", None) or fallback
