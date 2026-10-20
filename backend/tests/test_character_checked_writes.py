"""Checked Character writes, so an open Character Studio can follow edits
made elsewhere (an agent, another tab) without overwriting them or having
its own unsaved edits overwritten (contract 07, section 2.1).

``PUT /api/characters/{id}`` takes ``baseVersion``, the version the caller
read: any other is a 409 ``version_conflict`` carrying the Character as it is
now, and nothing is written. Left out, the write goes through as before
(agents, the CLI, older tabs). Every write's ``storedAssetChanged`` carries
the new ``version`` and ``edit`` (who wrote it; ``tab`` only for the person's
own tab), as a board's does, so the Studio can tell its own echo from an
outside edit.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude Code"}
TAB = "tab-0123456789abcdef"
BODY = {"name": "Rina", "subjectType": "human", "referenceViews": ["url_a", "url_b", "url_c"],
        "frozenTraitString": "late 20s, warm skin tone", "seed": 7, "consistencyStrength": 0.9}


@pytest.fixture
def sent(monkeypatch) -> list[dict]:
    import main as main_module

    messages: list[dict] = []

    async def capture(data):
        messages.append(data)

    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    return messages


@pytest.fixture
def client(tmp_path, monkeypatch, sent):
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    from main import app
    return TestClient(app)


def _make(client) -> dict:
    response = client.post("/api/characters", json=BODY)
    assert response.status_code == 200, response.text
    return response.json()


def _changes(sent: list[dict]) -> list[dict]:
    return [m for m in sent if m.get("type") == "storedAssetChanged" and m.get("kind") == "character"]


def test_a_put_at_the_version_read_saves(client):
    made = _make(client)
    response = client.put(f"/api/characters/{made['id']}", json={"name": "Rina 2", "baseVersion": 1})
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Rina 2" and response.json()["version"] == 2


def test_a_stale_base_version_is_a_409_with_the_character_and_writes_nothing(client):
    made = _make(client)
    assert client.put(f"/api/characters/{made['id']}", json={"frozenTraitString": "agent words"},
                      headers=AGENT).status_code == 200

    response = client.put(f"/api/characters/{made['id']}", json={"name": "Mine", "baseVersion": 1})

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "version_conflict" and body["version"] == 2
    assert body["character"]["id"] == made["id"] and body["character"]["frozenTraitString"] == "agent words"
    assert body["character"]["name"] == "Rina"
    assert "version 2" in body["detail"]
    now = client.get(f"/api/characters/{made['id']}").json()
    assert now["name"] == "Rina" and now["version"] == 2


@pytest.mark.parametrize("bad", ["1", True, 1.5])
def test_base_version_must_be_a_whole_number(client, bad):
    made = _make(client)
    response = client.put(f"/api/characters/{made['id']}", json={"name": "X", "baseVersion": bad})
    assert response.status_code == 422
    assert client.get(f"/api/characters/{made['id']}").json()["version"] == 1


def test_without_base_version_a_put_writes_as_before(client):
    made = _make(client)
    client.put(f"/api/characters/{made['id']}", json={"seed": 9})
    response = client.put(f"/api/characters/{made['id']}", json={"name": "Old tab"})
    assert response.status_code == 200 and response.json()["version"] == 3
    # A field left out keeps its saved value.
    assert response.json()["seed"] == 9


def test_a_put_says_its_version_and_who_wrote_it(client, sent, person):
    made = _make(client)
    client.put(f"/api/characters/{made['id']}", json={"name": "Tab", "baseVersion": 1},
               headers={**PERSON, "X-Nebula-Tab": TAB})
    message = _changes(sent)[-1]
    assert message["id"] == made["id"] and message["deleted"] is False and message["version"] == 2
    assert message["edit"]["actor"] == {"kind": "person"} and message["edit"]["tab"] == TAB

    client.put(f"/api/characters/{made['id']}", json={"name": "Agent"}, headers={**AGENT, "X-Nebula-Tab": TAB})
    message = _changes(sent)[-1]
    assert message["version"] == 3
    assert "tab" not in message["edit"] and message["edit"]["actor"]["name"] == "Claude Code"


def test_the_store_checks_the_base_version_under_its_lock(tmp_path, monkeypatch):
    from services.character_store import CharacterStore, CharacterVersionConflict

    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    store = CharacterStore()
    made = store.create(**BODY)
    assert store.update(made["id"], base_version=1, name="A")["version"] == 2
    with pytest.raises(CharacterVersionConflict) as caught:
        store.update(made["id"], base_version=1, name="B")
    assert caught.value.character["name"] == "A" and caught.value.character["version"] == 2
    assert store.get(made["id"])["name"] == "A"
