"""The packaged renderer's opaque origin is trusted only with the person token."""
import pytest
from fastapi.testclient import TestClient
from main import app


@pytest.mark.parametrize("origin", ["null", "file://"])
def test_packaged_renderer_cors_needs_the_person_token(monkeypatch, person, origin):
    monkeypatch.setenv('NEBULA_DESKTOP_MODE', '1')
    # The old per-launch nonce proves nothing now.
    monkeypatch.setenv('NEBULA_CONNECTOR_SESSION', 'fixture-session-nonce')
    with TestClient(app, client=('127.0.0.1', 54321)) as client:
        untrusted = client.get('/api/krea/connection', headers={'Origin': origin})
        assert untrusted.status_code == 403
        assert 'access-control-allow-origin' not in untrusted.headers
        old = client.get('/api/krea/connection', headers={'Origin': origin, 'X-Nebula-Connector-Session': 'fixture-session-nonce'})
        assert old.status_code == 403
        assert 'access-control-allow-origin' not in old.headers
        malformed = client.get('/api/krea/connection', headers=[(b'origin', origin.encode()),
                               (b'x-nebula-person', b'\xff')])
        assert malformed.status_code == 403
        trusted = client.get('/api/krea/connection', headers={'Origin': origin, 'X-Nebula-Person': person.token})
        assert trusted.status_code == 200
        assert trusted.headers['access-control-allow-origin'] == origin
        preflight = client.options('/api/krea/connection/connect', headers={'Origin': origin,
                                  'Access-Control-Request-Method': 'POST',
                                  'Access-Control-Request-Headers': 'X-Nebula-Person'})
        assert preflight.status_code == 204
        assert 'X-Nebula-Person' in preflight.headers['access-control-allow-headers']
        # Any route the renderer reads, but only with the token: a website's
        # sandboxed iframe also sends "Origin: null" and must not read replies.
        settings = client.get('/api/settings', headers={'Origin': origin, 'X-Nebula-Person': person.token})
        assert settings.headers['access-control-allow-origin'] == origin
        unread = client.get('/api/settings', headers={'Origin': origin})
        assert unread.headers.get('access-control-allow-origin') is None
        wrong = client.get('/api/settings', headers={'Origin': origin, 'X-Nebula-Person': 'x' * 43})
        assert wrong.headers.get('access-control-allow-origin') is None


def test_desktop_preflight_is_not_answered_for_a_foreign_host(monkeypatch):
    monkeypatch.setenv('NEBULA_DESKTOP_MODE', '1')
    with TestClient(app, client=('127.0.0.1', 54321)) as client:
        response = client.options('/api/settings', headers={'Origin': 'null', 'Host': 'attacker.example',
                                                          'Access-Control-Request-Method': 'PUT'})
        assert response.status_code == 403
        assert 'access-control-allow-origin' not in response.headers


def test_browser_mode_does_not_enable_opaque_origin_even_with_the_token(monkeypatch, person):
    monkeypatch.delenv('NEBULA_DESKTOP_MODE', raising=False)
    with TestClient(app, client=('127.0.0.1', 54321)) as client:
        response = client.get('/api/krea/connection', headers={'Origin': 'null', 'X-Nebula-Person': person.token})
        assert response.status_code == 403
        assert 'access-control-allow-origin' not in response.headers


def test_future_node_connection_preference_persists_without_changing_graph_or_generating(monkeypatch, tmp_path, person):
    from services import settings
    import main
    import respx
    monkeypatch.setattr(settings, 'SETTINGS_PATH', tmp_path / 'settings.json')
    import copy
    before = copy.deepcopy((main.cli_graph.nodes, main.cli_graph.edges))
    with TestClient(app, client=('127.0.0.1', 54321), headers=person.headers) as client, respx.mock:
        response = client.put('/api/settings', json={'kreaConnectionMode': 'mcp'}, headers={'X-Nebula-Agent': 'Codex'})
        assert response.status_code == 403
        response = client.put('/api/settings', json={'kreaConnectionMode': 'mcp'})
        assert response.status_code == 200
        assert client.get('/api/settings').json()['kreaConnectionMode'] == 'mcp'
        assert settings.load_settings()['kreaConnectionMode'] == 'mcp'
        invalid = client.put('/api/settings', json={'kreaConnectionMode': 'automatic-fallback'})
        assert invalid.status_code == 400
        assert settings.load_settings()['kreaConnectionMode'] == 'mcp'
        assert (main.cli_graph.nodes, main.cli_graph.edges) == before
