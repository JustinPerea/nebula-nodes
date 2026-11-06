"""Every graphSync carries ``syncSeq``, and the answers to a restore and a
node delete name the sync that sent them (PR #205 review 8, held undo).

A canvas reads any sync numbered below an answer's as one Nebula read before
it applied that edit, so such a sync never undoes it there. The numbers grow
in the order the syncs read the graph, every socket gets them in that order,
and a backend started later numbers above an earlier one.
"""
from __future__ import annotations

import asyncio
import json

from tests.test_graph_restore import AGENT, CANVAS, _restore, _seed, _syncs, api  # noqa: F401 (fixture)


def _seqs(api) -> list[int]:
    return [event["syncSeq"] for event in _syncs(api)]


def test_every_graph_sync_carries_a_growing_sync_seq(api):
    import main as main_module

    prompt, image = _seed(api)
    api.client.put(f"/api/graph/node/{prompt}/label", headers=AGENT, json={"label": "Hero"})
    api.client.request("DELETE", "/api/graph/edge", headers=AGENT, json={
        "source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"})
    api.client.post("/api/graph/connect", headers=AGENT, json={
        "source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"})
    seqs = _seqs(api)
    assert len(seqs) == 3
    assert all(type(seq) is int for seq in seqs)
    assert seqs == sorted(set(seqs))
    # Above this process's start (microseconds): a backend started later
    # numbers its syncs above this one's.
    assert seqs[0] > main_module.BACKEND_BOOT_STARTED_AT


def test_a_restore_answer_names_the_sync_that_sent_it(api):
    prompt, image = _seed(api)
    api.client.post("/api/graph/node", headers=AGENT, json={"definitionId": "text-input"})
    response = _restore(api, {"action": "undo", "nodes": [], "remove": [image], "wire": [], "unwire": []})
    assert response.status_code == 200, response.text
    sync = _syncs(api)[-1]
    assert response.json()["syncSeq"] == sync["syncSeq"]
    assert image not in {node["id"] for node in sync["nodes"]}
    # Every earlier sync is numbered below it.
    assert all(seq < sync["syncSeq"] for seq in _seqs(api)[:-1])


def test_a_node_delete_answer_names_the_sync_that_sent_it(api):
    prompt, image = _seed(api)
    api.client.put(f"/api/graph/node/{prompt}/label", headers=AGENT, json={"label": "Hero"})
    response = api.client.delete(f"/api/graph/node/{image}", headers=CANVAS)
    assert response.status_code == 200, response.text
    sync = _syncs(api)[-1]
    assert response.json()["syncSeq"] == sync["syncSeq"]
    assert image not in {node["id"] for node in sync["nodes"]}
    assert _seqs(api)[0] < sync["syncSeq"]


def test_a_delete_of_a_node_already_gone_names_no_sync(api):
    response = api.client.delete("/api/graph/node/n9", headers=CANVAS)
    assert response.status_code == 404
    assert "syncSeq" not in response.json()


def test_a_socket_s_first_sync_is_numbered_after_every_sync_before_it(api):
    prompt, _ = _seed(api)
    api.client.put(f"/api/graph/node/{prompt}/label", headers=AGENT, json={"label": "Hero"})
    before = _seqs(api)[-1]
    with api.client.websocket_connect("/ws") as socket:
        hello = socket.receive_json()
    assert hello["type"] == "graphSync"
    assert hello["syncSeq"] > before


def test_a_socket_s_first_sync_waits_for_a_sync_on_its_way(api):
    """A socket that opens while a broadcast is between its graph read and its
    send (holding the order) sends its own first sync only after it."""
    import main as main_module
    from starlette.websockets import WebSocketDisconnect

    _seed(api)

    class Socket:
        headers: dict[str, str] = {}
        query_params: dict[str, str] = {}

        def __init__(self) -> None:
            self.sent: list[dict] = []

        async def accept(self) -> None:
            return None

        async def send_text(self, text: str) -> None:
            self.sent.append(json.loads(text))

        async def receive_text(self) -> str:
            raise WebSocketDisconnect()

    async def opened_during_a_send() -> tuple[list[dict], list[dict]]:
        socket = Socket()
        holding = asyncio.Event()
        let_go = asyncio.Event()

        async def a_send_on_its_way() -> None:
            async with main_module._graph_sync_order():
                holding.set()
                await let_go.wait()

        sending = asyncio.create_task(a_send_on_its_way())
        await holding.wait()
        task = asyncio.create_task(main_module.websocket_endpoint(socket))
        for _ in range(20):
            await asyncio.sleep(0)
        before = [message for message in socket.sent if message.get("type") == "graphSync"]
        let_go.set()
        await asyncio.gather(sending, task)
        return before, socket.sent

    before, sent = asyncio.run(opened_during_a_send())
    assert before == []
    assert [message["type"] for message in sent][0] == "graphSync"


def test_syncs_reach_each_socket_in_sync_seq_order(api, monkeypatch):
    """A sync waiting at an await between its graph read and its send (a cover
    proposal's view) is sent before a sync that read the graph after it."""
    import main as main_module

    _seed(api)
    sent: list[int] = []

    async def capture(data, **_kwargs):
        sent.append(data["syncSeq"])

    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)

    async def both() -> None:
        first_waiting = asyncio.Event()
        let_go = asyncio.Event()
        calls = 0

        async def slow_follow(_exported) -> None:
            nonlocal calls
            calls += 1
            if calls == 1:
                first_waiting.set()
                await let_go.wait()

        monkeypatch.setattr(main_module, "_follow_cover_proposals", slow_follow)
        first = asyncio.create_task(main_module._broadcast_graph_sync(edit=True))
        await first_waiting.wait()
        second = asyncio.create_task(main_module._broadcast_graph_sync(edit=True))
        for _ in range(5):
            await asyncio.sleep(0)
        let_go.set()
        await asyncio.gather(first, second)

    asyncio.run(both())
    assert len(sent) == 2
    assert sent == sorted(sent)


def test_a_task_s_second_sync_waits_its_turn_too(api, monkeypatch):
    """A request that broadcasts twice: its second sync holds the order as its
    first did, so another sync read after it is sent after it."""
    import main as main_module

    _seed(api)
    sent: list[int] = []

    async def capture(data, **_kwargs):
        sent.append(data["syncSeq"])

    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)

    async def both() -> None:
        second_waiting = asyncio.Event()
        let_go = asyncio.Event()
        calls = 0

        async def slow_follow(_exported) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                second_waiting.set()
                await let_go.wait()

        async def twice() -> None:
            await main_module._broadcast_graph_sync(edit=True)
            await main_module._broadcast_graph_sync(edit=True)

        monkeypatch.setattr(main_module, "_follow_cover_proposals", slow_follow)
        first = asyncio.create_task(twice())
        await second_waiting.wait()
        other = asyncio.create_task(main_module._broadcast_graph_sync(edit=True))
        for _ in range(5):
            await asyncio.sleep(0)
        let_go.set()
        await asyncio.gather(first, other)

    asyncio.run(both())
    assert len(sent) == 3
    assert sent == sorted(sent)


def test_a_sync_made_inside_a_send_by_the_same_task_goes_ahead(api, monkeypatch):
    """A write run inside a sync's send (a hook on broadcast_raw) broadcasts its
    own sync then and there, numbered after it, instead of waiting for itself."""
    import main as main_module

    _seed(api)
    real = main_module.manager.broadcast_raw
    sent: list[int] = []

    async def capture(data, **kwargs):
        await real(data, **kwargs)
        if data.get("type") != "graphSync":
            return
        sent.append(data["syncSeq"])
        if len(sent) == 1:
            await main_module._broadcast_graph_sync(edit=True)

    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)

    async def nested() -> None:
        await asyncio.wait_for(main_module._broadcast_graph_sync(edit=True), timeout=10)

    asyncio.run(nested())
    assert len(sent) == 2
    assert sent[0] < sent[1]


def test_an_answer_names_no_sync_when_the_broadcast_returned_none():
    """A stand-in broadcast (tests stub it with one returning None or a mock)
    gives the answer no ``syncSeq`` rather than failing the request."""
    import main as main_module

    assert main_module._synced_seq(None) == {}
    assert main_module._synced_seq({"nodes": []}) == {}
    assert main_module._synced_seq({"syncSeq": 7}) == {"syncSeq": 7}
