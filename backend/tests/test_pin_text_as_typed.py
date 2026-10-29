"""PR #200 fix round 10 (review 9 MEDIUM-1; GM r15 condition 1, r16 answer 3):
a note, and an agent's reply, are stored exactly as typed; every output strips
them. No output path carries a control byte (no C0 but \\n and \\t, no DEL, no
C1, no ESC) for complete, unterminated and nested escape sequences, and random
bytes. The canvas display's half is frontend/tests/agentPresenceFollowups.r10.test.tsx.

From the reviewer's probe (r9 be/fuzz9.py): its "raw store" half reached 2,409
to 2,962 leaks per path before this round."""
from __future__ import annotations

import random
import tempfile
from pathlib import Path

import pytest

import mcp_channel
from services import agent_start
from cli import formatter
from services.agent_presence import AgentIdentity
from services.canvas_pins import (
    HIDDEN_TEXT_BYTES,
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
        assert stored["text"] == raw and stored["text"].encode() == raw.encode()
        assert not bad(added["text"])
        reply = "re " + raw.replace("\n", " ")
        try:
            _, answered = pins.resolve_in(added["id"], reply, CODEX)
        except PinError:
            answered = None
        if answered is not None:
            stored = next(p for p in store.projection().pins if p["id"] == added["id"])
            assert stored["reply"]["text"] == reply
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
    assert over.value.detail == "Note must be 280 characters or fewer" and over.value.extra == {}
    with pytest.raises(PinError) as hidden:
        pins.add_in("x" + "\x1b[0m" * 281, position={"x": 0, "y": 0}, graph_nodes={})
    assert hidden.value.detail == HIDDEN_TOO_LONG
    assert hidden.value.extra == {"code": "note_hidden_too_long", "rawBytes": 1 + 4 * 281,
                                  "hiddenBytes": 4 * 281, "limitBytes": HIDDEN_TEXT_BYTES}
    with pytest.raises(PinError):
        pins.add_in("\x1b[31m\x00", position={"x": 0, "y": 0}, graph_nodes={})
    _, ok = pins.add_in("x" * MAX_PIN_TEXT + "\x1b[0m", position={"x": 0, "y": 0}, graph_nodes={})
    assert ok["text"] == "x" * MAX_PIN_TEXT
    # Exactly the hidden limit is kept as typed.
    _, edge = pins.add_in("y" + "\x1b[0m" * (HIDDEN_TEXT_BYTES // 4), position={"x": 0, "y": 0}, graph_nodes={})
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


def test_a_refused_hidden_text_answers_its_code_and_counts_beside_the_persons_line(api):
    client, graph, _journal, _sent, store, _ids = api
    node = graph.add_node("text-input", {})
    typed = "ok" + "\x1b]0;" + "h" * 1200 + "\x07"
    refused = client.post("/api/canvas/pins", headers=PERSON, json={"text": typed, "nodeId": node})
    assert refused.status_code == 422
    body = refused.json()
    assert body["detail"] == HIDDEN_TOO_LONG
    raw_bytes = len(typed.encode())
    assert body == {"detail": HIDDEN_TOO_LONG, "code": "note_hidden_too_long", "rawBytes": raw_bytes,
                    "hiddenBytes": raw_bytes - 2, "limitBytes": HIDDEN_TEXT_BYTES}
    assert not store.projection().pins
    over = client.post("/api/canvas/pins", headers=PERSON, json={"text": "x" * 281, "nodeId": node})
    assert over.status_code == 422 and over.json() == {"detail": "Note must be 280 characters or fewer"}


def test_routes_store_as_typed_and_every_answer_journal_and_broadcast_is_stripped(api):
    client, graph, journal, sent, store, _ids = api
    node = graph.add_node("text-input", {})
    typed = "say \x1bPlease\tkeep  \nline two \x1b]0;t\x07end \x85x‮   "
    created = client.post("/api/canvas/pins", headers=PERSON, json={"text": typed, "nodeId": node})
    assert created.status_code == 201, created.text
    pin = created.json()["pin"]
    assert pin["text"] == "say\nline two end\nx"  # \x85 is NEL, a line break
    assert store.projection().pins[0]["text"] == typed
    listed = client.get("/api/canvas/pins").json()["pins"][0]
    assert listed["text"] == "say\nline two end\nx"
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
        assert next(p for p in store.projection().pins if p["id"] == added["id"])["text"] == raw
        back = pins.reattach([{"id": "rm_1", "nodeId": "n4", "pins": [added["id"]]}], {"n4": "text-input"}, project)
        assert all(not bad(s) for pin in back["reattached"] for s in _strings(pin)), (repr(raw), back)
        assert next(p for p in store.projection().pins if p["id"] == added["id"])["text"] == raw
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
