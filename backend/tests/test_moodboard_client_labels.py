"""Each board field the client names in its "changed by someone else" line takes
"The" (design), so the line reads as a sentence: "The mode was changed by
someone else after this call read the board, ..."."""

from __future__ import annotations

import moodboard_client as client


def test_every_field_label_reads_as_the_subject_of_the_changed_by_someone_else_line():
    assert client._FIELD_LABELS["mode"] == "The mode"
    assert client._FIELD_LABELS["direction"] == "The direction"
    assert client._FIELD_LABELS["strength"] == "The strength"
    assert client._FIELD_LABELS["notes"] == "The notes"
    for key, label in client._FIELD_LABELS.items():
        assert label.startswith(("The ", "“")), (key, label)
        assert not label.endswith("."), (key, label)
