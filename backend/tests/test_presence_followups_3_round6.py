"""PR #204 round 6 (review 4, gates-security NIT-1).

A broadcast's per-form cache keys each form by the payload it was built from (``id(base)``):
a socket that reads Updates the way the person's canvas does (``sees_share`` and no agent), but
isn't the person's canvas, gets the ``others=`` form, never the person's form cached under the
same view."""
from __future__ import annotations

import asyncio
import json


class _Socket:
    def __init__(self) -> None:
        self.got: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.got.append(json.loads(text))


def _message(text: str) -> dict:
    note = {"id": "an_1", "about": "note", "text": text,
            "author": {"kind": "agent", "id": "ext:claude-code", "name": "Claude Code", "color": "#E8825A"}}
    return {"type": "agentNotes", "surface": "canvas", "op": "changed", "note": note}


def test_a_socket_with_the_persons_view_gets_the_others_form():
    import main

    manager = main.ConnectionManager()
    person, claimed = _Socket(), _Socket()
    manager.active_connections.extend([person, claimed])
    manager.browser_connections.add(person)
    # Claimed: sees the share, no agent, as the person's canvas does; not the person's canvas.
    manager.share_views[claimed] = {"sees_share": True, "agent_id": None}
    assert manager.share_view(claimed) == manager.share_view(person)
    asyncio.run(manager.broadcast_raw(_message("for the person"), others=_message("for everyone else")))
    assert person.got[-1]["note"]["text"] == "for the person"
    assert claimed.got[-1]["note"]["text"] == "for everyone else"


def test_the_same_form_is_serialised_once_per_view_and_payload():
    import main

    manager = main.ConnectionManager()
    sockets = [_Socket() for _ in range(3)]
    manager.active_connections.extend(sockets)
    for sock in sockets:
        manager.share_views[sock] = {"sees_share": True, "agent_id": None}
    calls: list[int] = []
    real = main.json.dumps

    def counting(value, *args, **kwargs):
        calls.append(1)
        return real(value, *args, **kwargs)

    main.json.dumps = counting
    try:
        asyncio.run(manager.broadcast_raw(_message("one")))
    finally:
        main.json.dumps = real
    assert [sock.got[-1]["note"]["text"] for sock in sockets] == ["one"] * 3
    assert len(calls) == 1
