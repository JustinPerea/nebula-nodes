"""PR #200 fix round 13 (review 12 M-1, L-2, NIT-5; GM r21): the strip and
the count read Unicode's own lists, the same bytes the canvas reads.

- Tag characters stay only as England, Scotland or Wales; any other tag run
  is hidden (280 flags of 7 ASCII tags carried 1,960 hidden characters).
- A ZWJ chain is one character only as an RGI ZWJ sequence; every other emoji
  in it counts (11 thumbs joined are 11, not 1).
- One variation selector, kept only when Unicode lists it for its base; the
  pair is one visible character; every other selector is hidden.
- A byte order mark at either end is trimmed with the whitespace.
The canvas's half is frontend/tests/agentPresenceFollowups.r13text.test.ts."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.canvas_pins import (
    HIDDEN_TOO_LONG_CODE,
    TOO_LONG_CODE,
    CanvasPins,
    PinError,
    clean_text,
    public_pin,
    shown_text,
    text_length,
    typed_text,
)
from tests.test_canvas_pins import Clock, _store_with_projects

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "backend/data/pin_text_unicode.json"
CANVAS_DATA = REPO / "frontend/src/lib/pinTextUnicode.json"


def tags(spec: str) -> str:
    return "".join(chr(0xE0000 + ord(char)) for char in spec)


FLAG = "\U0001F3F4"
CANCEL = "\U000E007F"
ENGLAND = FLAG + tags("gbeng") + CANCEL
THUMB = "\U0001F44D"
ZWJ = "‍"


def hidden(typed: str) -> int:
    return len(typed.encode("utf-8")) - len(shown_text(typed).encode("utf-8"))


def test_both_sides_read_the_same_generated_data():
    assert DATA.read_bytes() == CANVAS_DATA.read_bytes()
    data = json.loads(DATA.read_text(encoding="utf-8"))
    assert data["tagFlags"] == ["gbeng", "gbsct", "gbwls"]
    assert data["sources"]["emoji-zwj-sequences.txt"]["version"] == "18.0"
    assert data["rgiZwjLongest"] == 4 and len(data["rgiZwj"]) > 200


@pytest.mark.parametrize("spec", ["gbeng", "gbsct", "gbwls"])
def test_the_three_subdivision_flags_stay_whole_and_count_one(spec):
    flag = FLAG + tags(spec) + CANCEL
    assert shown_text(flag) == flag and text_length(flag) == 1 and hidden(flag) == 0


@pytest.mark.parametrize("name,typed", [
    ("seven ASCII tags", FLAG + tags("ignorea") + CANCEL),
    ("a valid flag with an extra tag", FLAG + tags("gbengg") + CANCEL),
    ("a truncated flag", FLAG + tags("gben") + CANCEL),
    ("no cancel tag", FLAG + tags("gbeng")),
    ("one tag", FLAG + tags("g") + CANCEL),
    ("upper case", FLAG + tags("GBENG") + CANCEL),
])
def test_any_other_tag_run_is_hidden(name, typed):
    assert shown_text(typed) == FLAG, name
    assert text_length(shown_text(typed)) == 1


def test_review_12_m1_280_flags_of_ascii_tags_are_refused_as_hidden_text():
    payload = (FLAG + tags("ignorea") + CANCEL) * 280
    with pytest.raises(PinError) as refused:
        clean_text(payload, limit=280, multiline=True)
    assert refused.value.extra["code"] == HIDDEN_TOO_LONG_CODE
    # Nothing of it reaches an agent even when it fits the hidden budget.
    few = (FLAG + tags("ignorea") + CANCEL) * 3
    assert public_pin({"id": "p", "text": few, "anchor": {"nodeId": "n"}, "status": "open", "createdAt": 0.0})["text"] == FLAG * 3


def test_review_12_l2_a_chain_that_is_not_rgi_counts_each_emoji():
    eleven = ZWJ.join([THUMB] * 11)
    assert shown_text(eleven) == eleven  # a joiner between emoji still shows as typed
    assert text_length(eleven) == 11
    chains = (eleven + " ") * 140
    with pytest.raises(PinError) as refused:
        clean_text(chains, limit=280, multiline=True)
    assert refused.value.extra == {"code": TOO_LONG_CODE, "limit": 280}


@pytest.mark.parametrize("name,typed,length", [
    ("a family", "\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466", 1),
    ("a kiss", "\U0001F469‍❤️‍\U0001F48B‍\U0001F468", 1),
    ("a scientist with a skin tone", "\U0001F469\U0001F3FD‍\U0001F52C", 1),
    ("a handshake with two tones", "\U0001FAF1\U0001F3FB‍\U0001FAF2\U0001F3FC", 1),
    ("a rainbow flag", "\U0001F3F3️‍\U0001F308", 1),
    ("a family then a thumb", "\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466‍\U0001F44D", 2),
    ("two scientists joined", "\U0001F469\U0001F3FD‍\U0001F52C‍\U0001F469\U0001F3FD‍\U0001F52C", 2),
    ("two thumbs", "\U0001F44D‍\U0001F44D", 2),
])
def test_rgi_zwj_sequences_are_one_and_the_rest_count_apart(name, typed, length):
    assert text_length(shown_text(typed)) == length, name


@pytest.mark.parametrize("name,typed,shown,length,hidden_bytes", [
    ("葛 + E0100 is kept, one visible", "葛\U000E0100", "葛\U000E0100", 1, 0),
    ("葛 + 20 E0100: one visible, 19 hidden", "葛" + "\U000E0100" * 20, "葛\U000E0100", 1, 19 * 4),
    ("an extension-B ideograph + E0101", "\U00020000\U000E0101", "\U00020000\U000E0101", 1, 0),
    ("Latin a + E0100 is hidden", "a\U000E0100", "a", 1, 4),
    ("a Mongolian letter + FVS1 is kept", "ᠠ᠋", "ᠠ᠋", 1, 0),
    ("a Mongolian letter + FVS4 is kept", "ᠠ᠏", "ᠠ᠏", 1, 0),
    ("a Latin letter + FVS1 is hidden", "a᠋", "a", 1, 3),
    ("a Mongolian letter + two FVS: one kept", "ᠠ᠋᠌", "ᠠ᠋", 1, 3),
    ("a listed FE00 (∩)", "∩︀", "∩︀", 1, 0),
    ("FE00 after a letter it isn't listed for", "a︀", "a", 1, 3),
    ("text and emoji hearts", "♥︎♥️", "♥︎♥️", 2, 0),
    ("a keycap", "1️⃣", "1️⃣", 1, 0),
    ("FE0F after an emoji with no text form", "\U0001F600️", "\U0001F600", 1, 3),
    ("a second FE0F", "❤️️", "❤️", 1, 3),
    ("an ideographic selector after an emoji", "❤\U000E0100", "❤", 1, 4),
])
def test_gm_r21_one_selector_valid_for_its_base(name, typed, shown, length, hidden_bytes):
    assert shown_text(typed) == shown, name
    assert text_length(shown_text(typed)) == length, name
    assert hidden(typed) == hidden_bytes, name


def test_review_12_nit5_a_byte_order_mark_at_the_ends_is_trimmed(tmp_path):
    assert typed_text("﻿ note ﻿", limit=280, multiline=True) == "note"
    assert typed_text(" ﻿\n x", limit=280, multiline=True) == "x"
    store, _ = _store_with_projects(tmp_path, "Active")
    pins = CanvasPins(store, clock=Clock())
    _, made = pins.add_in("﻿x", position={"x": 0, "y": 0}, graph_nodes={})
    assert store.projection().pins[0]["text"] == "x" and made["text"] == "x"
    # Inside, it is a format character: hidden, not stored away.
    assert typed_text("a﻿b", limit=280, multiline=True) == "a﻿b"
    assert shown_text("a﻿b") == "ab"
