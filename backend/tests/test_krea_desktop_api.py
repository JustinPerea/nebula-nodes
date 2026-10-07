"""Opaque browser origins require an unguessable sidecar request nonce."""
from fastapi.testclient import TestClient
from main import app


def test_packaged_renderer_cors_and_nonce_are_limited_to_connector_routes(monkeypatch):
    monkeypatch.setenv('NEBULA_DESKTOP_MODE', '1')
    monkeypatch.setenv('NEBULA_CONNECTOR_SESSION', 'fixture-session-nonce')
    with TestClient(app, client=('127.0.0.1', 54321)) as client:
        untrusted = client.get('/api/krea/connection', headers={'Origin': 'null'})
        assert untrusted.status_code == 403
        assert 'access-control-allow-origin' not in untrusted.headers
        malformed = client.get('/api/krea/connection', headers=[(b'origin', b'null'),
                               (b'x-nebula-connector-session', b'\xff')])
        assert malformed.status_code == 403
        trusted = client.get('/api/krea/connection', headers={'Origin': 'null', 'X-Nebula-Connector-Session': 'fixture-session-nonce'})
        assert trusted.status_code == 200
        assert trusted.headers['access-control-allow-origin'] == 'null'
        preflight = client.options('/api/krea/connection/connect', headers={'Origin': 'null',
                                  'Access-Control-Request-Method': 'POST',
                                  'Access-Control-Request-Headers': 'X-Nebula-Connector-Session'})
        assert preflight.status_code == 204
        assert 'X-Nebula-Connector-Session' in preflight.headers['access-control-allow-headers']
        unrelated = client.get('/api/settings', headers={'Origin': 'null', 'X-Nebula-Connector-Session': 'fixture-session-nonce'})
        assert unrelated.headers.get('access-control-allow-origin') != 'null'


def test_browser_mode_does_not_enable_opaque_origin_even_with_header(monkeypatch):
    monkeypatch.delenv('NEBULA_DESKTOP_MODE', raising=False)
    with TestClient(app, client=('127.0.0.1', 54321)) as client:
        response = client.get('/api/krea/connection', headers={'Origin': 'null', 'X-Nebula-Connector-Session': 'fixture-session-nonce'})
        assert response.status_code == 403
        assert 'access-control-allow-origin' not in response.headers


def test_future_node_connection_preference_persists_without_changing_graph_or_generating(monkeypatch, tmp_path):
    from services import settings
    import main
    import respx
    monkeypatch.setattr(settings, 'SETTINGS_PATH', tmp_path / 'settings.json')
    import copy
    before = copy.deepcopy((main.cli_graph.nodes, main.cli_graph.edges))
    with TestClient(app, client=('127.0.0.1', 54321)) as client, respx.mock:
        response = client.put('/api/settings', json={'kreaConnectionMode': 'mcp'})
        assert response.status_code == 200
        assert client.get('/api/settings').json()['kreaConnectionMode'] == 'mcp'
        assert settings.load_settings()['kreaConnectionMode'] == 'mcp'
        invalid = client.put('/api/settings', json={'kreaConnectionMode': 'automatic-fallback'})
        assert invalid.status_code == 400
        assert settings.load_settings()['kreaConnectionMode'] == 'mcp'
        assert (main.cli_graph.nodes, main.cli_graph.edges) == before
