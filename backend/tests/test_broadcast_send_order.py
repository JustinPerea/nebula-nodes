"""Broadcasts reach every listener, in order, and one stalled socket holds nobody.

ConnectionManager.broadcast_others, broadcast_raw and the hello's direct sends
share one send lock per socket, and every send is bounded (the lock wait counts
toward the bound).
"""
from __future__ import annotations

import asyncio
import json

import pytest


class Socket:
    headers: dict[str, str] = {}
    query_params: dict[str, str] = {}

    def __init__(self, *, delay: float = 0.0, fail: bool = False, stall: bool = False) -> None:
        self.delay, self.fail, self.stall = delay, fail, stall
        self.sent: list[object] = []
        self.inside = 0
        self.overlapped = False
        self.closed = False

    async def send_text(self, text: str) -> None:
        self.inside += 1
        if self.inside > 1:
            self.overlapped = True
        try:
            if self.stall:
                await asyncio.sleep(3600)
            if self.fail:
                raise RuntimeError("socket broke")
            await asyncio.sleep(self.delay)
            self.sent.append(json.loads(text)["n"])
        finally:
            self.inside -= 1

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def main_module(monkeypatch):
    import main

    monkeypatch.setattr(main, "socket_send_timeout", lambda size: 0.3)
    return main


def _manager(main_module, *sockets: Socket, browsers: tuple[Socket, ...] = ()):
    manager = main_module.ConnectionManager()
    manager.active_connections = [*sockets, *browsers]
    manager.browser_connections = set(browsers)
    return manager


@pytest.mark.parametrize("send", ["broadcast_others", "broadcast_raw"])
def test_a_failing_socket_is_dropped_and_the_others_still_get_it(main_module, send):
    async def run():
        first, bad, last = Socket(), Socket(fail=True), Socket()
        manager = _manager(main_module, first, bad, last)
        await getattr(manager, send)({"type": "x", "n": 1})
        return manager, first, bad, last

    manager, first, bad, last = asyncio.run(run())
    assert first.sent == [1] and last.sent == [1]
    assert bad.closed and bad not in manager.active_connections
    assert first in manager.active_connections and last in manager.active_connections


@pytest.mark.parametrize("send", ["broadcast_others", "broadcast_raw"])
def test_a_stalled_socket_does_not_hold_the_others_or_the_caller(main_module, send):
    async def run():
        first, stuck, last = Socket(), Socket(stall=True), Socket()
        manager = _manager(main_module, first, stuck, last)
        started = asyncio.get_running_loop().time()
        await getattr(manager, send)({"type": "x", "n": 1})
        return asyncio.get_running_loop().time() - started, manager, first, stuck, last

    took, manager, first, stuck, last = asyncio.run(run())
    assert first.sent == [1] and last.sent == [1]
    assert took < 1.0  # the 0.3 s bound plus the close
    assert stuck.closed and stuck not in manager.active_connections


def test_broadcast_others_skips_the_persons_canvas(main_module):
    async def run():
        listener, tab = Socket(), Socket()
        manager = _manager(main_module, listener, browsers=(tab,))
        await manager.broadcast_others({"type": "x", "n": 1})
        return listener, tab

    listener, tab = asyncio.run(run())
    assert listener.sent == [1] and tab.sent == []


@pytest.mark.parametrize("send", ["broadcast_others", "broadcast_raw"])
def test_a_disconnect_during_the_gather_skips_no_other_socket(main_module, send):
    async def run():
        sockets = [Socket(delay=0.02) for _ in range(4)]
        manager = _manager(main_module, *sockets)
        task = asyncio.create_task(getattr(manager, send)({"type": "x", "n": 1}))
        await asyncio.sleep(0.005)
        manager.disconnect(sockets[1])  # while the sends are in flight
        await task
        return manager, sockets

    manager, sockets = asyncio.run(run())
    assert [s.sent for s in (sockets[0], sockets[2], sockets[3])] == [[1], [1], [1]]
    assert sockets[1] not in manager.active_connections
    assert sockets[1] not in manager._send_locks


def test_concurrent_broadcasts_never_overlap_on_a_socket_and_arrive_in_start_order(main_module):
    async def run():
        slow, fast = Socket(delay=0.02), Socket()
        manager = _manager(main_module, slow, fast)
        # Started in order 1..5 as separate tasks, mixing the senders.
        senders = [manager.broadcast_raw, manager.broadcast_others, manager.broadcast_raw,
                   manager.broadcast_others, manager.broadcast_raw]
        tasks = [asyncio.create_task(send({"type": "x", "n": n})) for n, send in enumerate(senders, 1)]
        await asyncio.gather(*tasks)
        return slow, fast

    slow, fast = asyncio.run(run())
    for socket in (slow, fast):
        assert not socket.overlapped
        assert socket.sent == [1, 2, 3, 4, 5]


def test_a_greeting_send_and_a_broadcast_to_a_new_socket_do_not_overlap(main_module):
    async def run():
        socket = Socket(delay=0.02)
        manager = _manager(main_module, socket)
        greeting = asyncio.create_task(manager.send_direct(socket, json.dumps({"n": 1})))
        await asyncio.sleep(0)  # the greeting is mid-write
        await manager.broadcast_raw({"type": "x", "n": 2})
        await greeting
        return socket

    socket = asyncio.run(run())
    assert not socket.overlapped
    assert socket.sent == [1, 2]


def test_a_lock_wait_counts_toward_the_bound(main_module):
    async def run():
        socket = Socket(stall=True)
        manager = _manager(main_module, socket)
        started = asyncio.get_running_loop().time()
        # The first holds the lock for its whole 0.3 s; the second waits behind
        # it and is out of time at the same moment, not 0.3 s after.
        results = await asyncio.gather(manager._send_bounded(socket, '{"n": 1}'),
                                       manager._send_bounded(socket, '{"n": 2}'))
        return results, asyncio.get_running_loop().time() - started

    results, took = asyncio.run(run())
    assert results == [False, False]
    assert took < 0.6


def test_connect_makes_the_lock_and_disconnect_drops_it(main_module):
    async def run():
        class Accepting(Socket):
            async def accept(self) -> None:
                pass

        manager = main_module.ConnectionManager()
        socket = Accepting()
        await manager.connect(socket)
        had = socket in manager._send_locks
        manager.disconnect(socket)
        return had, socket in manager._send_locks

    assert asyncio.run(run()) == (True, False)
