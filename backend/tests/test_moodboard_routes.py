"""Moodboard routes refuse what they used to drop (design-canvas gaps 6 and 7).

A POST whose image list sat under any key but `images` made an empty board and
a 200; a blank image url was skipped; a PUT dropped an explicit
`analysis: null`, so a board re-weighted in Moodboard Studio kept its old
analysis on the server.
"""
from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from services.output import OUTPUT_ROOT


@pytest.fixture
def client(tmp_path, monkeypatch):
    import main as main_module

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    return TestClient(main_module.app)


def _url(color=(200, 80, 40)) -> str:
    path = OUTPUT_ROOT / "moodboard-route-tests" / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), color).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _create(client, **body) -> dict:
    response = client.post("/api/moodboards", json={"name": "Board", "images": [{"url": _url()}], **body})
    assert response.status_code == 200, response.text
    return response.json()


def test_a_board_of_32_images_keeps_all_32(client):
    urls = [f"/api/outputs/chat-uploads/{n}.png" for n in range(32)]
    created = client.post("/api/moodboards", json={"name": "Big", "images": [{"url": u} for u in urls]}).json()

    assert [img["url"] for img in created["images"]] == urls
    assert len(client.get(f"/api/moodboards/{created['id']}").json()["images"]) == 32


@pytest.mark.parametrize("body, field", [
    ({"name": "Board", "imageUrls": ["/api/outputs/a.png"]}, "imageUrls"),
    ({"name": "Board", "images": [{"url": "/api/outputs/a.png", "label": "hero"}]}, "label"),
])
def test_create_refuses_fields_it_does_not_know(client, body, field):
    response = client.post("/api/moodboards", json=body)

    assert response.status_code == 422
    assert any(error["loc"][-1] == field and error["type"] == "extra_forbidden" for error in response.json()["detail"])


def test_a_blank_image_url_is_refused_not_dropped(client):
    created = client.post("/api/moodboards", json={"name": "Board", "images": [{"url": "/api/outputs/a.png"}, {"url": "  "}]})
    assert created.status_code == 422 and created.json()["detail"] == "images[1].url is empty"

    board = _create(client)
    updated = client.put(f"/api/moodboards/{board['id']}", json={"images": [{"url": ""}]})
    assert updated.status_code == 422 and updated.json()["detail"] == "images[0].url is empty"
    assert len(client.get(f"/api/moodboards/{board['id']}").json()["images"]) == 1


def test_update_refuses_fields_it_does_not_know(client):
    board = _create(client)

    response = client.put(f"/api/moodboards/{board['id']}", json={"imageUrls": ["/api/outputs/b.png"]})

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"][-1] == "imageUrls"


def test_the_put_moodboard_studio_sends_round_trips_and_clears_the_analysis(client):
    project_id = "project-one"
    board = _create(client, projectId=project_id)
    analyzed = client.post(f"/api/moodboards/{board['id']}/analyze").json()
    assert analyzed["analysis"]["palette"]

    # MoodboardStudioView's persist(): the whole draft, with analysis nulled by the weight change.
    draft = {"name": analyzed["name"], "images": [{**analyzed["images"][0], "weight": 0.4}],
             "notes": analyzed["notes"], "mode": analyzed["mode"], "strength": analyzed["strength"],
             "analysis": None, "projectId": project_id}
    response = client.put(f"/api/moodboards/{board['id']}", json=draft)

    assert response.status_code == 200, response.text
    saved = client.get(f"/api/moodboards/{board['id']}").json()
    assert saved["analysis"] is None and saved["images"][0]["weight"] == 0.4


def test_a_put_without_analysis_keeps_it(client):
    board = _create(client)
    analyzed = client.post(f"/api/moodboards/{board['id']}/analyze").json()

    renamed = client.put(f"/api/moodboards/{board['id']}", json={"name": "Renamed"}).json()

    assert renamed["analysis"] == analyzed["analysis"]


def test_a_board_cannot_move_to_another_project(client):
    board = _create(client, projectId="project-one")

    response = client.put(f"/api/moodboards/{board['id']}", json={"name": "Moved", "projectId": "project-two"})

    assert response.status_code == 422
    assert response.json()["detail"] == "projectId can't change: a board stays where it was created"
    assert client.get(f"/api/moodboards/{board['id']}").json()["name"] == "Board"


def test_analyze_runs_off_the_event_loop(client, monkeypatch):
    import services.moodboard_analysis as analysis_module

    real = analysis_module.analyze_moodboard
    loops = []

    def record(moodboard):
        try:
            loops.append(asyncio.get_running_loop())
        except RuntimeError:
            loops.append(None)
        return real(moodboard)

    monkeypatch.setattr(analysis_module, "analyze_moodboard", record)
    board = _create(client)

    analyzed = client.post(f"/api/moodboards/{board['id']}/analyze").json()

    assert loops == [None] and analyzed["analysis"]["version"] == 3
