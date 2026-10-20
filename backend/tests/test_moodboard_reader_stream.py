"""The reader's own stream parser (services/moodboard_reader_stream.py).

docs/moodboard-canvas-plan.md section 5.6.1: thought parts kept out of the
answer, every part joined, items cut out as they close, and the same calls
wherever the bytes split. ``handlers/google_gemini.py``'s stream keeps only
``parts[0]`` and ignores ``thought``, which is why the reader has its own.

The fixture is shaped like Google's documented ``streamGenerateContent?alt=sse``
answer (one GenerateContentResponse per ``data:`` line, CRLF line ends, a
running ``usageMetadata``). It is built by hand, not recorded: the one real
Argon probe waits for Justin's spend OK, and its recording can replace it.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.moodboard_reader_stream import (
    GeminiStreamParser,
    ItemScanner,
    SSEDecoder,
    clean_model_text,
    read_payload,
    trim_reason,
)

FIXTURE = Path(__file__).parent / "fixtures" / "moodboard_reader" / "argon_batch_sse.txt"


def _calls(chunks: list[bytes]) -> tuple[list[tuple[str, object]], object]:
    calls: list[tuple[str, object]] = []
    parser = GeminiStreamParser(
        items_key="readings",
        on_focus=lambda ref: calls.append(("focus", ref)),
        on_item=lambda item: calls.append(("item", item["ref"] if isinstance(item, dict) else None)),
        on_thought=lambda text: calls.append(("thought", text)),
    )
    for chunk in chunks:
        parser.feed_bytes(chunk)
    return calls, parser.close()


def _answer_calls(calls):
    return [call for call in calls if call[0] != "thought"]


def test_the_recorded_answer_gives_focus_then_item_for_each_ref():
    calls, outcome = _calls([FIXTURE.read_bytes()])

    assert _answer_calls(calls) == [("focus", "A"), ("item", "A"), ("focus", "B"), ("item", "B"),
                                    ("focus", "C"), ("item", "C")]
    assert outcome.complete and outcome.finish_reason == "STOP"
    assert outcome.usage["thoughtsTokenCount"] == 812 and outcome.usage["candidatesTokenCount"] == 402
    assert [r["ref"] for r in outcome.value["readings"]] == ["A", "B", "C"]


def test_split_at_every_byte_offset_gives_the_same_calls_in_order():
    data = FIXTURE.read_bytes()
    expected, whole = _calls([data])
    for offset in range(len(data) + 1):
        calls, outcome = _calls([data[:offset], data[offset:]])
        assert calls == expected, f"split at byte {offset}"
        assert outcome.text == whole.text


def test_three_way_splits_and_one_byte_chunks_give_the_same_calls():
    data = FIXTURE.read_bytes()
    expected, _ = _calls([data])
    assert _calls([data[i:i + 1] for i in range(len(data))])[0] == expected
    for a in range(0, len(data), 97):
        for b in range(a, len(data), 389):
            assert _calls([data[:a], data[a:b], data[b:]])[0] == expected


def test_thought_parts_never_reach_the_json_buffer():
    calls, outcome = _calls([FIXTURE.read_bytes()])

    assert "weighing glass" not in outcome.text and "Looking at the six" not in outcome.text
    assert [text for kind, text in calls if kind == "thought"] == [
        "Looking at the six images, Image A and #3 share a screen pattern.", "weighing glass vs dither"]
    json.loads(outcome.text)  # the answer alone is valid JSON


def test_text_in_later_parts_is_read():
    payload = {"candidates": [{"content": {"parts": [{"text": '{"readings": [{"ref": "A"'},
                                                     {"text": ', "x": 1}]}'}]}}]}
    calls: list = []
    parser = GeminiStreamParser(items_key="readings", on_focus=lambda r: calls.append(("focus", r)),
                                on_item=lambda i: calls.append(("item", i)))
    parser.feed_payload(payload)
    outcome = parser.close()

    assert calls == [("focus", "A"), ("item", {"ref": "A", "x": 1})]
    assert outcome.complete and outcome.value == {"readings": [{"ref": "A", "x": 1}]}


def test_a_thought_part_is_kept_apart_even_when_nobody_asked_for_thoughts():
    parts = read_payload({"candidates": [{"content": {"parts": [
        {"text": "secret plan", "thought": True}, {"text": "{}"}]}}]})
    assert parts.thoughts == ["secret plan"] and parts.answer == ["{}"]


def test_ref_anywhere_in_the_item_still_comes_before_the_item():
    calls: list = []
    scanner = ItemScanner("readings", on_focus=lambda r: calls.append(("focus", r)),
                          on_item=lambda i: calls.append(("item", i["ref"])))
    scanner.feed('{"readings": [{"medium": "photo", "looks": [{"name": "ref", "fit": 1}], "ref": "B"}]}')
    assert calls == [("focus", "B"), ("item", "B")]


def test_strings_that_look_like_structure_do_not_confuse_the_scanner():
    calls: list = []
    scanner = ItemScanner("readings", on_focus=lambda r: calls.append(("focus", r)),
                          on_item=lambda i: calls.append(("item", i)))
    text = '{"readings": [{"ref": "A", "reason": "a } and a ] and \\"ref\\": \\"Z\\" here"}, {"ref": "B"}]}'
    for char in text:
        scanner.feed(char)
    assert [c for c in calls if c[0] == "focus"] == [("focus", "A"), ("focus", "B")]
    assert calls[1][1]["reason"] == 'a } and a ] and "ref": "Z" here'
    assert scanner.complete


def test_items_outside_the_list_and_text_around_the_object_are_ignored():
    calls: list = []
    scanner = ItemScanner("readings", on_focus=lambda r: calls.append(r), on_item=lambda i: calls.append(i))
    scanner.feed('```json\n{"note": {"ref": "X"}, "readings": [{"ref": "A"}]}\n```')
    assert calls == ["A", {"ref": "A"}]
    assert scanner.value() == {"note": {"ref": "X"}, "readings": [{"ref": "A"}]}


def test_a_cut_off_answer_keeps_the_items_that_closed():
    calls: list = []
    scanner = ItemScanner("readings", on_item=lambda i: calls.append(i["ref"]))
    scanner.feed('{"readings": [{"ref": "A"}, {"ref": "B"}, {"ref": "C", "reason": "half')
    assert calls == ["A", "B"]
    assert not scanner.complete and scanner.value() is None


def test_sse_crlf_split_between_cr_and_lf_and_a_last_event_without_a_blank_line():
    decoder = SSEDecoder()
    assert decoder.feed(b"data: {\"a\": 1}\r") == []
    assert decoder.feed(b"\n\r\n: comment\r\ndata: {\"b\"") == ['{"a": 1}']
    assert decoder.feed(b": 2}") == []
    assert decoder.close() == ['{"b": 2}']


def test_sse_split_inside_a_multibyte_character():
    raw = 'data: {"t": "café — \U0001f3a8"}\n\n'.encode("utf-8")
    for offset in range(len(raw) + 1):
        decoder = SSEDecoder()
        events = decoder.feed(raw[:offset]) + decoder.feed(raw[offset:]) + decoder.close()
        assert events == ['{"t": "café — \U0001f3a8"}']


def test_an_error_event_in_the_stream_is_reported():
    parser = GeminiStreamParser(items_key="readings")
    parser.feed_bytes(b'data: {"error": {"code": 503, "message": "The model is overloaded.", "status": "UNAVAILABLE"}}\n\n')
    assert parser.close().error == "The model is overloaded."


@pytest.mark.parametrize("text, expected", [
    ("Clouds under a halftone screen, like Image B but softer", "Clouds under a halftone screen, like but softer"),
    ("The haystack echoing #18", "The haystack echoing"),
    ("Same palette as images A and C, warmer", "Same palette as, warmer"),
    ("Image D's grain is coarse", "grain is coarse"),
    ("A cat on a mat (see #4)", "A cat on a mat (see)"),
    ("Image a bit grainy", "Image a bit grainy"),
    ("A wide shot. Not Image Z.", "A wide shot. Not Image Z."),
    ("Like # 12, but blue", "Like, but blue"),
    # Ranges, "to" lists, bare bracketed labels and the "and" they leave.
    ("Softer than images A–C, with film grain", "Softer than, with film grain"),
    ("Like images B-D, warm dusk light", "Like, warm dusk light"),
    ("Same palette as Image A to C", "Same palette as"),
    ("Echoes #3 through #5 and #7", "Echoes"),
    ("Matches the grain in (B) and #4", "Matches the grain in"),
    ("Close to (B, C) in tone", "Close to in tone"),
    ("Black and white, grain and dust", "Black and white, grain and dust"),
    ("Rock and", "Rock and"),
    ("Image B — the softer one — leans blue", "the softer one — leans blue"),
    ("A 3-inch print, to a degree", "A 3-inch print, to a degree"),
])
def test_reason_cleaning_strips_labels_and_numbers(text, expected):
    assert clean_model_text(text) == expected


def test_a_long_reason_is_trimmed_at_a_word_to_120():
    text = "A long winding description of mist rolling over terraced hills " * 4
    trimmed = trim_reason(text)
    assert len(trimmed) <= 120 and trimmed.endswith("…")
    assert text.startswith(trimmed[:-1])
    assert not trimmed[:-1].endswith(" ")
    assert trim_reason("short") == "short"


@pytest.mark.parametrize("text, expected", [
    # A letter glued to &, -, ' or ’ and then a word is part of that word, not a label.
    ("Image A - B&W grain", "B&W grain"),
    ("Like Image A, B-movie glow", "Like, B-movie glow"),
    ("Like Image A, D'Arcy's light", "Like, D'Arcy's light"),
    ("Image B&W grain", "Image B&W grain"),
    ("Image B-movie tones", "Image B-movie tones"),
    # Lists and ranges of labels still go, glued or not.
    ("Warm, like Images A & B", "Warm, like"),
    ("Images A, B and C are warm", "are warm"),
    ("Grain as in (A–C)", "Grain as in"),
    ("Images A&B share a palette", "share a palette"),
    ("Images A-C, softer", "softer"),
    ("Images A and B's palette", "palette"),
    # Look-alike letters from other scripts (UTS #39) are labels too; the rest of the text keeps its script.
    ("Like Іmage В, softer", "Like, softer"),
    ("Like Image Β and С", "Like"),
    ("Тёмный свет", "Тёмный свет"),
])
def test_reason_cleaning_keeps_glued_letters_and_sees_look_alikes(text, expected):
    assert clean_model_text(text) == expected


@pytest.mark.parametrize("text, expected", [
    # A #n in another script's digits is still stripped (UTS #39 reads ١ as "l" and ٥ as "o").
    ("Like #١٨ and #18", "Like"),
    ("Like #٥ soft", "Like soft"),
    # "/" glues a letter to a word too: B/W is black and white, not Image B.
    ("Image A - B/W grain", "B/W grain"),
    ("Image B/W split", "Image B/W split"),
    ("Images A/B share a palette", "share a palette"),
    # The join a stripped label leaves before a glued word goes with it.
    ("Images A & B-movie glow", "B-movie glow"),
    ("Images A&B&W", "B&W"),
])
def test_reason_cleaning_keeps_other_digits_and_slashed_words(text, expected):
    assert clean_model_text(text) == expected
