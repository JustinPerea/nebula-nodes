"""PR #200 fix round 14 (GM r22 Q1 and Q3).

- Q3: the hidden-text refusal counts hidden characters, never bytes. 280
  emoji each with a stray FE0F, and 280 family ZWJ sequences (about 25 bytes
  each), save; so does any long mix of them. No note limit counts bytes.
- The events feed and the summaries cut a note's preview on a character's
  edge, never through a family.
- Q1: the person gate's 403 keeps its code for agents (agent_refused) and for
  a tab that isn't the person (person_required); the canvas reads the code
  and shows "Notes can only be added from the Nebula canvas.".
"""
from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from services.canvas_pins import (
    HIDDEN_TEXT_CHARACTERS,
    PinError,
    clean_text,
    clip_characters,
    event_text,
    pin_resolved_summary,
    pin_summary,
    shown_text,
    text_length,
)
from tests.conftest import PERSON
from tests.test_canvas_pins import AGENT, api  # noqa: F401  (api is a fixture)

FAMILY = "\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466"
STRAY = "\U0001F600️"
SCIENTIST = "\U0001F469\U0001F3FD‍\U0001F52C"
CORPUS = json.loads((Path(__file__).parent / "fixtures/pin_text_cases.json").read_text(encoding="utf-8"))["cases"]


def test_gm_r22_q3_both_280_character_notes_save_by_characters_not_bytes():
    stray = STRAY * 280
    shown = clean_text(stray, limit=280, multiline=True)
    assert text_length(shown) == 280 and len(stray) - len(shown) == 280  # 280 hidden characters
    families = FAMILY * 280
    assert len(families.encode("utf-8")) == 7000
    assert clean_text(families, limit=280, multiline=True) == families
    assert text_length(families) == 280
    named = {c["name"]: c for c in CORPUS}
    assert named["GM r22: 280 emoji, each with a stray FE0F"]["saves"]
    assert named["GM r22: 280 families"]["saves"] and named["GM r22: 280 families"]["noteLength"] == 280


def test_the_hidden_limit_counts_characters_whatever_their_bytes():
    # 1,120 hidden characters of 4 bytes each (4,480 bytes) are kept; one more isn't.
    assert clean_text("a" + "\U000E0101" * HIDDEN_TEXT_CHARACTERS, limit=280, multiline=True) == "a"
    with pytest.raises(PinError) as over:
        clean_text("a" + "\U000E0101" * (HIDDEN_TEXT_CHARACTERS + 1), limit=280, multiline=True)
    assert over.value.extra == {"code": "note_hidden_too_long", "hiddenCharacters": HIDDEN_TEXT_CHARACTERS + 1,
                                "limitCharacters": HIDDEN_TEXT_CHARACTERS}


def test_a_seeded_fuzz_of_long_emoji_notes_always_saves():
    rng = random.Random(20261030)
    tokens = [FAMILY, STRAY, SCIENTIST, "\U0001F44D", "a", " ", "♥️"]
    for _ in range(300):
        typed = "".join(rng.choice(tokens) for _ in range(rng.randint(200, 280))).strip() or "a"
        shown = clean_text(typed, limit=10_000, multiline=True)
        if text_length(shown) <= 280:
            clean_text(typed, limit=280, multiline=True)  # never note_hidden_too_long, never a byte cap
    # The corpus agrees: every case with a note in 280 characters and under the hidden limit saves.
    for case in CORPUS:
        typed = case["typed"]
        expected = bool(case["note"]) and case["noteLength"] <= 280 and len(typed.strip().strip("﻿")) - len(case["note"]) <= HIDDEN_TEXT_CHARACTERS
        if case["name"].startswith(("GM r22", "fuzz r14")):
            assert case["saves"] == expected, case["name"]


def test_280_families_save_through_the_api_and_come_back_whole(api):
    client, graph, journal, _sent, _store, _ids = api
    node = graph.add_node("text-input", {})
    families = FAMILY * 280
    made = client.post("/api/canvas/pins", headers=PERSON, json={"text": families, "nodeId": node})
    assert made.status_code == 201 and made.json()["pin"]["text"] == families
    assert client.get("/api/canvas/pins").json()["pins"][0]["text"] == families
    stray = client.post("/api/canvas/pins", headers=PERSON, json={"text": STRAY * 280, "nodeId": node})
    assert stray.status_code == 201 and stray.json()["pin"]["text"] == "\U0001F600" * 280
    # The event's preview is cut on a family's edge, and its summary too.
    event = journal.read(after=0, kinds={"pin.added"})["events"][0]
    text = event["data"]["text"]
    assert text.endswith("…") and len(text) <= 160
    assert text[:-1] == FAMILY * (len(text[:-1]) // len(FAMILY)) and text_length(text[:-1]) == len(text[:-1]) // len(FAMILY)
    summary = event["summary"]
    assert len(summary) <= 200 and FAMILY + "…" in summary and summary.count("‍") % 3 == 0


def test_previews_never_cut_through_a_character():
    families = FAMILY * 280
    for cut in (event_text(families), clip_characters(families, 50), clip_characters("é" * 100, 51)):
        body = cut[:-1]
        assert cut.endswith("…") and text_length(body) * (len(body) // max(text_length(body), 1)) == len(body)
    assert clip_characters("é" * 100, 51) == "é" * 25 + "…"
    assert event_text("short") == "short"
    summary = pin_summary({"text": families, "anchor": {"nodeId": "n1"}})
    assert summary.endswith('…" on n1') and summary.count("‍") % 3 == 0
    resolved = pin_resolved_summary("pin_1", {"text": families}, families)
    assert len(resolved) <= 200 and resolved.count("‍") % 3 == 0
    assert shown_text(families) == families


def test_gm_r22_q1_the_person_gate_keeps_its_code(api):
    client, graph, _journal, _sent, _store, _ids = api
    node = graph.add_node("text-input", {})
    agent = client.post("/api/canvas/pins", headers=AGENT, json={"text": "hi", "nodeId": node})
    assert agent.status_code == 403 and agent.json()["code"] == "agent_refused"
    assert "Nebula canvas" in agent.json()["detail"]
    tab = client.post("/api/canvas/pins", headers={"Origin": "http://localhost:5173"}, json={"text": "hi", "nodeId": node})
    assert tab.status_code == 403 and tab.json()["code"] == "person_required"
