"""Error copy round 3e: the Paper source card's lines (GM - Design).

"People get the written line; agents keep the specific detail." A Paper
error's own text (paper_transport, paper_sources) stays word for word in the
routes' `detail.message` and the source record's `lastError`; the line here
goes beside it as `detail.person` and `lastErrorPerson`, for the card.
"""
from __future__ import annotations

from services.paper_transport import PaperError

# A text that isn't listed reads the closest general line.
PAPER_UNREACHABLE_LINE = "Paper isn't answering. Open Paper Desktop, then try again."
PAPER_MISSING_LINE = "The linked object is missing in Paper. Reconnect it, or link another object."
PAPER_SOURCE_GONE_LINE = "Nebula can't find this Paper source. Link the object again."
PAPER_EXPORT_CHECK_LINE = "Nebula couldn't check the artwork Paper exported. Refresh the source again."
PAPER_CONFIRM_LINE = "Nebula couldn't confirm the object in Paper. Refresh the source again."
_PAPER_LINES = (
    (("CLI unavailable", "disconnected", "tool failed", "no readable result"), PAPER_UNREACHABLE_LINE),
    (("page root",), "Choose an object on the page, not the page itself, then link it again."),
    (("changed while exporting",), "The object changed while Paper was exporting it. Refresh the source again."),
    (("exceeds 32 MiB",), "Paper couldn't export this object, or its export is over 32 MB. Try a smaller object."),
    (("not a PNG", "integrity", "could not be validated", "absolute local file", "safe PNG", "snapshot is missing"),
     PAPER_EXPORT_CHECK_LINE),
)


def paper_person_line(exc: PaperError) -> str:
    if exc.state == "missing":
        return PAPER_MISSING_LINE
    text = str(exc)
    for needles, line in _PAPER_LINES:
        if any(needle in text for needle in needles):
            return line
    return PAPER_CONFIRM_LINE
