"""PR #200 fix round 10 (review 9 MEDIUM-1; GM r15 condition 1, r16 answer 3):
a note, and an agent's reply, are stored exactly as typed; every output strips
them. No output path carries a control byte (no C0 but \\n and \\t, no DEL, no
C1, no ESC) for complete, unterminated and nested escape sequences, and random
bytes. The canvas display's half is frontend/tests/agentPresenceFollowups.r10.test.tsx.

From the reviewer's probe (r9 be/fuzz9.py): its "raw store" half reached 2,409
to 2,962 leaks per path before this round."""
from __future__ import annotations

import random

import pytest

import mcp_channel
from cli import formatter
from services.agent_presence import AgentIdentity
from services.canvas_pins import (
    MAX_PIN_TEXT,
    CanvasPins,
    PinError,
    note_block,
    one_line,
    pin_resolved_summary,
    pin_summary,
    public_pin,
    shown_text,
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
    with pytest.raises(PinError):
        pins.add_in("x" * (MAX_PIN_TEXT + 1), position={"x": 0, "y": 0}, graph_nodes={})
    with pytest.raises(PinError):
        pins.add_in("x" + "\x1b[0m" * MAX_PIN_TEXT, position={"x": 0, "y": 0}, graph_nodes={})
    with pytest.raises(PinError):
        pins.add_in("\x1b[31m\x00", position={"x": 0, "y": 0}, graph_nodes={})
    _, ok = pins.add_in("x" * MAX_PIN_TEXT + "\x1b[0m", position={"x": 0, "y": 0}, graph_nodes={})
    assert ok["text"] == "x" * MAX_PIN_TEXT


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
