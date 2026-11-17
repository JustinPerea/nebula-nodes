"""The missing-key line (copy sweep item 12) and its article, held to one table of cases
(fixtures/missing_key_lines.json) that frontend/tests/lib/missingKeyLine.parity.test.ts reads too, so the
backend (execution/person_line) and the frontend (lib/directRoute) give the same line for the same keys."""
import json
from pathlib import Path

import pytest

from execution.person_line import KEY_NAMES, key_line, missing_key_line, status_line, with_article

TABLE = json.loads((Path(__file__).parent / "fixtures" / "missing_key_lines.json").read_text())


@pytest.mark.parametrize("keys,line", [(c["keys"], c["line"]) for c in TABLE["cases"]])
def test_missing_key_line_matches_the_shared_table(keys, line):
    assert missing_key_line(keys) == line


@pytest.mark.parametrize("name,expected", TABLE["articles"])
def test_with_article_goes_by_sound(name, expected):
    assert with_article(name) == expected


def test_every_key_settings_stores_has_a_row_in_the_table():
    rows = {c["keys"][0] for c in TABLE["cases"] if len(c["keys"]) == 1}
    assert set(KEY_NAMES) <= rows


def test_a_key_line_is_none_for_a_name_settings_does_not_store():
    assert key_line(["NOT_A_SETTINGS_KEY"]) is None


def test_the_provider_status_missing_line_takes_the_same_form():
    assert status_line("missing", "OpenAI", "API key") == "Add an OpenAI API key in Settings to run this node."
    assert status_line("missing", "Replicate", "token") == "Add a Replicate token in Settings to run this node."
