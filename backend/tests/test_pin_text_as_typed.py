"""PR #200 fix round 10 (review 9 MEDIUM-1; GM r15 condition 1, r16 answer 3):
a note, and an agent's reply, are stored exactly as typed; every output strips
them. No output path carries a control byte (no C0 but \\n and \\t, no DEL, no
C1, no ESC) for complete, unterminated and nested escape sequences, and random
bytes. The canvas display's half is frontend/tests/agentPresenceFollowups.r10.test.tsx.

From the reviewer's probe (r9 be/fuzz9.py): its "raw store" half reached 2,409
to 2,962 leaks per path before this round."""
from __future__ import annotations

import json
import random
import tempfile
from pathlib import Path

import pytest

import mcp_channel
from services import agent_start
from cli import formatter
from services.agent_presence import AgentIdentity
from services.canvas_pins import (
    _selector_fits,
    HIDDEN_TEXT_CHARACTERS,
    HIDDEN_TOO_LONG,
    MAX_PIN_TEXT,
    CanvasPins,
    PinError,
    note_block,
    one_line,
    pin_resolved_summary,
    pin_summary,
    public_pin,
    shown_text,
    text_length,
)
from tests.conftest import PERSON
from tests.test_canvas_pins import AGENT, Clock, _store_with_projects, api  # noqa: F401  (api is a fixture)
from tests.test_mcp_channel import pin as channel_pin, resp, take

CODEX = AgentIdentity(id="codex", name="Codex", color="#5B9DFF", verified=True)


def bad(text: str) -> list[str]:
    return [hex(ord(c)) for c in text
            if (ord(c) < 0x20 and c not in "\n\t") or ord(c) == 0x7F or 0x80 <= ord(c) <= 0x9F]


KNOWN = ["\x1b[31m", "\x1b[0m", "\x1b]0;t\x07", "\x1b]8;;http://e\x1b\\", "\x1bPq#0\x1b\\", "\x1b_Gf=1\x1b\\",
         "\x1b^pm\x1b\\", "\x1bXsos\x1b\\", "\x9b31m", "\x9d0;t\x9c", "\x90q\x9c", "\x9f a\x9c", "\x9e b\x9c",
         "\x98 c\x9c", "\x1b", "\x1b]", "\x1bP", "\x9d", "\x90", "\x1b[", "\x1b[?", "\x1bP\x1b[31m\x1b\\",
         "\x1b]\x1b]0;x\x07\x07", "\x00", "\x07", "\x08", "\x0b", "\x0c", "\x7f", "\x85", " ", "\r", "\r\n",
         "\x1bc", "\x1b(B", "\x1b7", "\x1b#8", "\x1bN", "\x1bO", "‮", "​"]
ALPHABET = [chr(i) for i in range(0, 0xA0)] + list('abc ⏎é‮​<>"\\')


def cases(n: int, seed: int = 9) -> list[str]:
    rng = random.Random(seed)

    def sample() -> str:
        parts = []
        for _ in range(rng.randint(1, 12)):
            r = rng.random()
            if r < 0.45:
                parts.append(rng.choice(KNOWN))
            elif r < 0.8:
                parts.append("".join(rng.choice(ALPHABET) for _ in range(rng.randint(1, 6))))
            else:
                parts.append("word ")
        return "x" + "".join(parts)

    return [sample() for _ in range(n)] + KNOWN + ["a" + k + "b\nsecond line" for k in KNOWN]


def as_pin(text: str, **extra) -> dict:
    return {"id": "pin_1", "anchor": {"nodeId": "n4"}, "text": text, "status": "open", "createdAt": None, **extra}


def channel_push(text: str) -> str:
    state = mcp_channel.ChannelState(now=0.0)
    state.observe(resp(channel_pin(1, text=text)), now=10.0)
    push = take(state, 11.0)
    return push.content if push else ""


def resolved(reply: str) -> dict:
    return as_pin("ok", status="resolved", reply={"agent": {"name": "C"}, "text": reply, "at": None})


# Every output a note's text (or a reply's) reaches, given the text as stored.
PATHS = {
    "channel push": channel_push,
    "nebula pins (format_pin)": lambda t: formatter.format_pin(as_pin(t)),
    "nebula pins, a reply (format_pin)": lambda t: formatter.format_pin(resolved(t)),
    "nebula start (format_start)": lambda t: formatter.format_start({"pins": {"open": [as_pin(t)]}}),
    "note_block": lambda t: note_block(t, "  "),
    "nebula watch (one_line)": one_line,
    "pin.added summary": lambda t: pin_summary(as_pin(t)),
    "pin.resolved summary, the note": lambda t: pin_resolved_summary("pin_1", as_pin(t), "done"),
    "pin.resolved summary, the reply": lambda t: pin_resolved_summary("pin_1", as_pin("ok"), t),
    "API pin (public_pin), the note": lambda t: public_pin(as_pin(t))["text"],
    "API pin (public_pin), the reply": lambda t: public_pin(resolved(t))["reply"]["text"],
    "shown_text, one line": lambda t: shown_text(t, multiline=False),
    # Review 10 NIT-3: strips on its own, whatever its caller passes.
    "agent_start.pins_part (raw pins)": lambda t: "\n".join(row["text"] for row in agent_start.pins_part([as_pin(t)], via="mcp")["open"]),
}


@pytest.mark.parametrize("path", sorted(PATHS))
def test_no_control_byte_survives_any_output_path_from_the_raw_text(path):
    out = PATHS[path]
    leaks = []
    for raw in cases(3000):
        text = out(raw)
        if bad(text):
            leaks.append((repr(raw)[:60], bad(text)[:4]))
    assert leaks == [], f"{len(leaks)} leaks, e.g. {leaks[:3]}"


def test_the_store_keeps_the_note_and_the_reply_byte_for_byte_and_its_outputs_strip_them(tmp_path):
    store, (project,) = _store_with_projects(tmp_path, "Active")
    pins = CanvasPins(store, clock=Clock())
    kept = refused = 0
    for raw in cases(240, seed=10):
        try:
            _, added = pins.add_in(raw, position={"x": 1, "y": 2}, graph_nodes={})
        except PinError as exc:
            # Empty once stripped, or over the cap: refused, never stored half.
            assert exc.status in {409, 422}
            refused += 1
            continue
        stored = next(p for p in store.projection().pins if p["id"] == added["id"])
        # As typed but for whitespace at its ends (GM r19 answer 1: trimmed, so
        # what is saved is what was counted).
        assert stored["text"] == raw.strip() and stored["text"].encode() == raw.strip().encode()
        assert not bad(added["text"])
        reply = "re " + raw.replace("\n", " ")
        try:
            _, answered = pins.resolve_in(added["id"], reply, CODEX)
        except PinError:
            answered = None
        if answered is not None:
            stored = next(p for p in store.projection().pins if p["id"] == added["id"])
            assert stored["reply"]["text"] == reply.strip()
            assert not bad(answered["reply"]["text"])
        for listing in (pins.list()["pins"], pins.for_agents()["pins"]):
            for pin in listing:
                assert not bad(pin["text"]) and not bad((pin.get("reply") or {}).get("text") or "")
        pins.remove_in(added["id"])
        kept += 1
    assert kept > 150 and refused > 0


def test_a_note_too_long_once_shown_or_as_typed_is_refused(tmp_path):
    store, _ = _store_with_projects(tmp_path, "Active")
    pins = CanvasPins(store, clock=Clock())
    with pytest.raises(PinError) as over:
        pins.add_in("x" * (MAX_PIN_TEXT + 1), position={"x": 0, "y": 0}, graph_nodes={})
    assert over.value.detail == "Note must be 280 characters or fewer"
    assert over.value.extra == {"code": "note_too_long", "limit": 280}  # GM r20 Q1: the person's line by its code
    with pytest.raises(PinError) as hidden:
        pins.add_in("x" + "\x1b[0m" * 281, position={"x": 0, "y": 0}, graph_nodes={})
    assert hidden.value.detail == HIDDEN_TOO_LONG
    # GM r22 Q3 (fix round 14): counted in hidden characters, never bytes.
    assert hidden.value.extra == {"code": "note_hidden_too_long", "hiddenCharacters": 4 * 281,
                                  "limitCharacters": HIDDEN_TEXT_CHARACTERS}
    with pytest.raises(PinError):
        pins.add_in("\x1b[31m\x00", position={"x": 0, "y": 0}, graph_nodes={})
    _, ok = pins.add_in("x" * MAX_PIN_TEXT + "\x1b[0m", position={"x": 0, "y": 0}, graph_nodes={})
    assert ok["text"] == "x" * MAX_PIN_TEXT
    # Exactly the hidden limit is kept as typed.
    _, edge = pins.add_in("y" + "\x1b[0m" * (HIDDEN_TEXT_CHARACTERS // 4), position={"x": 0, "y": 0}, graph_nodes={})
    assert edge["text"] == "y"


# GM r12 answer 3 (fix round 11): only what shows counts, in characters as a
# person sees them; the frontend's noteLength is the same rule (its test
# shares these cases: agentPresenceFollowups.r11.test.tsx).
LENGTH_CASES = [
    ("abc", 3),
    ("e\u0301", 1),                       # e + combining acute
    ("\U0001F1EB\U0001F1F7", 1),          # a flag: two regional indicators
    ("\U0001F1EB\U0001F1F7\U0001F1E9", 2),  # a flag and a lone indicator
    ("\U0001F44D\U0001F3FD", 1),          # thumbs up, a skin tone
    ("\u2764\ufe0f", 1),                  # a heart, its emoji presentation selector
    ("\u0301abc", 4),                      # a mark with nothing before it counts
    ("a" + "\u0301" * 32, 1),              # up to 32 marks join a character
    ("a" + "\u0301" * 33, 2),              # the 33rd counts on its own
    ("\ud55c\uae00", 2),                  # Hangul syllables
    ("line one\nline two", 17),          # a line break is a character
]


@pytest.mark.parametrize("text,expected", LENGTH_CASES)
def test_text_length_counts_what_a_person_sees(text, expected):
    assert text_length(text) == expected


def test_280_visible_characters_fit_whatever_their_code_points():
    store, _ = _store_with_projects(Path(tempfile.mkdtemp()), "Active")
    pins = CanvasPins(store, clock=Clock())
    flags = "\U0001F1EB\U0001F1F7" * MAX_PIN_TEXT  # 560 code points, 280 characters
    _, ok = pins.add_in(flags, position={"x": 0, "y": 0}, graph_nodes={})
    assert ok["text"] == flags
    with pytest.raises(PinError) as over:
        pins.add_in(flags + "x", position={"x": 0, "y": 0}, graph_nodes={})
    assert "280 characters or fewer" in over.value.detail
    accented = "e\u0301" * MAX_PIN_TEXT
    _, ok = pins.add_in(accented, position={"x": 0, "y": 0}, graph_nodes={})
    assert ok["text"] == accented


# Review 11 MEDIUM-1 and NIT-3, GM r19 answer 1 (fix round 12): the shared
# corpus (the named cases GM asked for and a seeded fuzz). The frontend's
# agentPresenceFollowups.r12text.test.ts checks its strip and count against
# the same file.
CORPUS = json.loads((Path(__file__).parent / "fixtures" / "pin_text_cases.json").read_text())["cases"]


def test_the_shared_corpus_shows_and_counts_as_written():
    off = [c["name"] for c in CORPUS
           if shown_text(c["typed"]) != c["note"] or text_length(c["note"]) != c["noteLength"]
           or shown_text(c["typed"], multiline=False) != c["reply"] or text_length(c["reply"]) != c["replyLength"]]
    assert off == []
    named = {c["name"]: c for c in CORPUS}
    for name in ("family emoji", "England flag", "a scientist with a skin tone", "a keycap"):
        assert named[name]["note"] == named[name]["typed"] and named[name]["noteLength"] == 1, name
    assert named["text and emoji hearts"]["note"] == "\u2665\ufe0e\u2665\ufe0f"
    assert named["a selector after a letter"]["note"] == "a"
    # GM r21 (fix round 13): one selector, kept when Unicode lists it for its base.
    assert named["an ideographic selector"]["note"] == "\u845b\U000E0100" and named["an ideographic selector"]["noteLength"] == 1
    assert named["a ZWJ between letters"]["note"] == "ab"
    assert named["tags without the black flag"]["note"] == "a"
    assert named["whitespace at the ends"]["note"] == "hi there"
    assert named["blank lines inside"]["note"] == "one\n\n\n   \ntwo"


def test_a_seeded_fuzz_leaves_no_stray_selector_joiner_or_tag_on_any_output():
    rng = random.Random(1028)
    pool = ["a", " ", "\n", "\u0301", "\ufe0e", "\ufe0f", "\ufe00", "\u034f", "\u200d", "\U0001F468", "\U0001F3FD",
            "\U0001F3F4", "\U000E0067", "\U000E007F", "\U000E0100", "\u2665", "1", "\u845b", "\x1b[1m"]
    for _ in range(3000):
        typed = "".join(rng.choice(pool) for _ in range(rng.randint(1, 20)))
        for shown in (shown_text(typed), shown_text(typed, multiline=False), one_line(typed)):
            for index, char in enumerate(shown):
                code = ord(char)
                if code == 0x34F:
                    raise AssertionError(repr(typed))
                if 0xFE00 <= code <= 0xFE0F or 0xE0100 <= code <= 0xE01EF:
                    # GM r21: one selector, right after a base it is listed for.
                    assert index and _selector_fits(shown[index - 1], code), repr(typed)
                if char == "\u200d":
                    assert 0 < index < len(shown) - 1, repr(typed)
                if 0xE0020 <= code <= 0xE007F:
                    assert next(p for p in reversed(shown[:index]) if ord(p) < 0xE0020) == "\U0001F3F4", repr(typed)


def test_whitespace_is_trimmed_and_stored_trimmed_and_whitespace_alone_is_empty(tmp_path):
    store, _ = _store_with_projects(tmp_path, "Active")
    pins = CanvasPins(store, clock=Clock())
    _, made = pins.add_in("  \n  look here  \n\n  ", position={"x": 0, "y": 0}, graph_nodes={})
    assert made["text"] == "look here"
    assert store.projection().pins[0]["text"] == "look here"  # stored trimmed: saved is what was counted
    for blank in (" ", "\n\n\t ", "\x1b[31m   \x1b[0m"):
        with pytest.raises(PinError) as empty:
            pins.add_in(blank, position={"x": 0, "y": 0}, graph_nodes={})
        assert empty.value.detail == "Note can't be empty" and empty.value.extra == {}
    # Spaces and blank lines inside are visible: 1,200 of them are too long, never hidden text.
    with pytest.raises(PinError) as long:
        pins.add_in("x" + " " * 1200 + "y", position={"x": 0, "y": 0}, graph_nodes={})
    assert "280 characters or fewer" in long.value.detail
    with pytest.raises(PinError) as lines:
        pins.add_in("x" + "\n" * 1500 + "y", position={"x": 0, "y": 0}, graph_nodes={})
    assert "280 characters or fewer" in lines.value.detail


def test_a_payload_in_invisible_marks_is_hidden_text_and_never_reaches_an_agent(api):
    client, graph, _journal, _sent, store, _ids = api
    node = graph.add_node("text-input", {})
    smuggled = "".join(chr(0x61 + i % 26) + "".join(chr(0xE0100 + (i * 32 + j) % 240) for j in range(32)) for i in range(MAX_PIN_TEXT))
    refused = client.post("/api/canvas/pins", headers=PERSON, json={"text": smuggled, "nodeId": node})
    assert refused.status_code == 422 and refused.json()["code"] == "note_hidden_too_long"
    assert refused.json()["hiddenCharacters"] == 32 * MAX_PIN_TEXT
    cgj = client.post("/api/canvas/pins", headers=PERSON, json={"text": "x" + "\u034f" * 1200, "nodeId": node})
    assert cgj.status_code == 422 and cgj.json()["code"] == "note_hidden_too_long"
    assert not store.projection().pins
    # Under the cap, stored as typed, and no output carries a mark past the first.
    typed = "go" + "\U000E0100" * 32 + " \u2764\ufe0f\ufe0f"
    made = client.post("/api/canvas/pins", headers=PERSON, json={"text": typed, "nodeId": node})
    assert made.status_code == 201 and made.json()["pin"]["text"] == "go \u2764\ufe0f"
    # The person's canvas keeps the emoji's FE0F; agents read the bare emoji (GM r23).
    assert client.get("/api/canvas/pins", headers=PERSON).json()["pins"][0]["text"] == "go \u2764\ufe0f"
    assert client.get("/api/canvas/pins").json()["pins"][0]["text"] == "go \u2764"
    assert text_length("go \u2764\ufe0f") == 4
    family = "\U0001F468\u200d\U0001F469\u200d\U0001F467\u200d\U0001F466"
    england = "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F"
    whole = client.post("/api/canvas/pins", headers=PERSON, json={"text": f"{family} {england} \u2665\ufe0e\u2665\ufe0f", "nodeId": node})
    assert whole.status_code == 201
    assert whole.json()["pin"]["text"] == f"{family} {england} \u2665\ufe0e\u2665\ufe0f"


def test_a_refused_hidden_text_answers_its_code_and_counts_beside_the_persons_line(api):
    client, graph, _journal, _sent, store, _ids = api
    node = graph.add_node("text-input", {})
    typed = "ok" + "\x1b]0;" + "h" * 1200 + "\x07"
    refused = client.post("/api/canvas/pins", headers=PERSON, json={"text": typed, "nodeId": node})
    assert refused.status_code == 422
    body = refused.json()
    assert body["detail"] == HIDDEN_TOO_LONG
    assert body == {"detail": HIDDEN_TOO_LONG, "code": "note_hidden_too_long", "hiddenCharacters": len(typed) - 2,
                    "limitCharacters": HIDDEN_TEXT_CHARACTERS}
    assert not store.projection().pins
    over = client.post("/api/canvas/pins", headers=PERSON, json={"text": "x" * 281, "nodeId": node})
    assert over.status_code == 422
    assert over.json() == {"detail": "Note must be 280 characters or fewer", "code": "note_too_long", "limit": 280}


def test_routes_store_as_typed_and_every_answer_journal_and_broadcast_is_stripped(api):
    client, graph, journal, sent, store, _ids = api
    node = graph.add_node("text-input", {})
    typed = "say \x1bPlease\tkeep  \nline two \x1b]0;t\x07end \x85x‮   "
    created = client.post("/api/canvas/pins", headers=PERSON, json={"text": typed, "nodeId": node})
    assert created.status_code == 201, created.text
    pin = created.json()["pin"]
    # \x85 is NEL, a line break; spaces inside show as typed (GM r19 answer 1).
    assert pin["text"] == "say \nline two end \nx"
    assert store.projection().pins[0]["text"] == typed.strip()
    listed = client.get("/api/canvas/pins").json()["pins"][0]
    assert listed["text"] == "say \nline two end \nx"
    reply = "done \x1b[1mbold\x1b[0m\x9b2J and \x07bell\nnext"
    answered = client.post(f"/api/canvas/pins/{pin['id']}/resolve", headers=AGENT, json={"reply": reply})
    assert answered.status_code == 200, answered.text
    assert store.projection().pins[0]["reply"]["text"] == reply
    assert client.get("/api/canvas/pins").json()["pins"][0]["reply"]["text"] == "done bold and bell next"
    for event in journal.read(after=0, kinds={"pin"})["events"]:
        for value in (event.get("summary") or "", *(str(v) for v in (event.get("data") or {}).values())):
            assert not bad(value), event
    for message in sent:
        for item in message.get("pins") or []:
            assert not bad(item["text"]) and not bad((item.get("reply") or {}).get("text") or "")


# PR #200 fix round 11 (review 10 MEDIUM-1): the journal's own data fields
# are output paths too. pin.detached and pin.reattached journaled the stored
# (raw) note. Every pin event, its data and its summary, through the store
# (detach, reattach) and through the routes and GET /api/canvas/events (what
# MCP wait_for_canvas_change and `nebula watch --json` return as is).

def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def test_detach_and_reattach_hand_back_the_shown_text_and_keep_the_typed_text(tmp_path):
    store, _ = _store_with_projects(tmp_path, "Active")
    pins = CanvasPins(store, clock=Clock())
    project = None
    checked = 0
    for raw in cases(300, seed=11):
        try:
            _, added = pins.add_in(raw, node_id="n4", graph_nodes={"n4": {"id": "n4"}})
        except PinError:
            continue
        detached = pins.detach_node("n4", {"x": 1, "y": 2}, removal="rm_1", definition_id="text-input")
        assert detached and all(not bad(s) for pin in detached for s in _strings(pin)), (repr(raw), detached)
        assert next(p for p in store.projection().pins if p["id"] == added["id"])["text"] == raw.strip()
        back = pins.reattach([{"id": "rm_1", "nodeId": "n4", "pins": [added["id"]]}], {"n4": "text-input"}, project)
        assert all(not bad(s) for pin in back["reattached"] for s in _strings(pin)), (repr(raw), back)
        assert next(p for p in store.projection().pins if p["id"] == added["id"])["text"] == raw.strip()
        pins.remove_in(added["id"])
        checked += 1
    assert checked > 150


def test_every_pin_event_and_the_events_route_carry_no_control_byte(api):
    client, graph, journal, _sent, store, _ids = api
    done = 0
    for raw in cases(60, seed=12):
        node = graph.add_node("text-input", {"value": "keep"}, position={"x": 300, "y": 40})
        made = client.post("/api/canvas/pins", headers=PERSON, json={"text": raw, "nodeId": node})
        if made.status_code != 201:
            continue
        pin_id = made.json()["pin"]["id"]
        reply = "re " + raw.replace("\n", " ")
        client.post(f"/api/canvas/pins/{pin_id}/resolve", headers=AGENT, json={"reply": reply})
        gone = client.delete(f"/api/graph/node/{node}", headers=PERSON)
        assert gone.status_code == 200, gone.text
        restored = client.post("/api/graph/restore", headers=PERSON, json={
            "action": "undo", "removals": [gone.json()["removal"]],
            "nodes": [{"id": node, "definitionId": "text-input", "params": {"value": "keep"}, "position": {"x": 300, "y": 40}}]})
        assert restored.status_code == 200, restored.text
        assert client.delete(f"/api/canvas/pins/{pin_id}", headers=PERSON).status_code == 200
        done += 1
    assert done > 40
    kinds = {"pin.added", "pin.resolved", "pin.detached", "pin.reattached", "pin.removed"}
    events = journal.read(after=0, kinds=kinds, limit=100000)["events"]
    assert {event["kind"] for event in events} == kinds
    leaks = [(event["kind"], s[:40]) for event in events for s in _strings(event) if bad(s)]
    assert leaks == []
    # What agents read: GET /api/canvas/events, as is behind MCP wait_for_canvas_change and nebula watch --json.
    seen, after = set(), 0
    wanted = ",".join(sorted(kinds))
    while True:
        page = client.get(f"/api/canvas/events?after={after}&limit=100&kinds={wanted}&wait=0&self=1", headers=AGENT)
        assert page.status_code == 200, page.text
        body = page.json()
        for event in body["events"]:
            seen.add(event["kind"])
            assert not any(bad(s) for s in _strings(event)), event
        after = body["cursor"]
        if not body["more"]:
            break
    assert seen == kinds
