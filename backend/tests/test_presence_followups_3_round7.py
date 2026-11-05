"""PR #204 round 7 (review 5 NIT-1, MEDIUM-2): the chat socket echoes a message's `ref` on its
person_required refusal, so the tab reads each refusal against the promote that message went
out under, and knows which permission answer was refused. A ref that isn't a short string is
left out."""
from __future__ import annotations

import asyncio

import pytest

import main
from tests.test_chat_personal_ws import AGENT, Socket, ws_env  # noqa: F401
from tests.test_commons_integration import isolated_app  # noqa: F401

pytestmark = pytest.mark.usefixtures("person")


@pytest.mark.asyncio
async def test_a_refused_turn_echoes_its_ref(ws_env):
    ws_env.register({})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    socket.put({"type": "send", "message": "hi", "agent": AGENT, "ref": "r7"})
    error = await socket.next("error")
    assert (error["code"], error.get("ref")) == ("person_required", "r7")
    socket.disconnect()
    await asyncio.wait_for(task, 5)


@pytest.mark.asyncio
async def test_a_refused_permission_answer_and_close_echo_their_refs(ws_env):
    ws_env.register({})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    socket.put({"type": "permission", "requestId": "p1", "decision": "allow", "ref": "r8"})
    assert (await socket.next("error")).get("ref") == "r8"
    socket.put({"type": "close_session", "sessionId": "s1", "ref": "r9"})
    assert (await socket.next("error")).get("ref") == "r9"
    socket.disconnect()
    await asyncio.wait_for(task, 5)


@pytest.mark.asyncio
@pytest.mark.parametrize("ref", [None, 7, "", "x" * 65, {"a": 1}])
async def test_a_ref_that_isnt_a_short_string_is_left_out(ws_env, ref):
    ws_env.register({})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    payload = {"type": "permission", "requestId": "p1", "decision": "deny"}
    if ref is not None:
        payload["ref"] = ref
    socket.put(payload)
    error = await socket.next("error")
    assert error["code"] == "person_required" and "ref" not in error
    socket.disconnect()
    await asyncio.wait_for(task, 5)
