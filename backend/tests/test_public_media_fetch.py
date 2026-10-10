"""Provider media is fetched only from public https hosts; active outputs are served sandboxed."""
from __future__ import annotations

import ipaddress

import pytest
import respx
from fastapi.testclient import TestClient

from services import public_url

PUBLIC = {ipaddress.ip_address("93.184.216.34")}


@pytest.fixture
def dns(monkeypatch):
    table = {"media.example.test": PUBLIC, "internal.example.test": {ipaddress.ip_address("10.0.0.7")}}

    async def resolve(hostname, _port):
        return table[hostname]

    monkeypatch.setattr(public_url, "resolve_host", resolve)
    return table


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [
    "http://media.example.test/a.png", "https://localhost/a.png", "https://127.0.0.1/a.png",
    "https://169.254.169.254/latest/meta-data", "https://[::1]/a.png", "https://user:pw@media.example.test/a.png",
    "https://media.example.test:8443/a.png", "https://internal.example.test/a.png", "https://api.localhost/a.png",
])
async def test_non_public_or_non_https_media_urls_are_refused(dns, url):
    with pytest.raises(RuntimeError, match="will not fetch"):
        await public_url.require_public_https(url, "Krea")


@pytest.mark.asyncio
async def test_redirects_are_checked_hop_by_hop(dns):
    with respx.mock(assert_all_called=False) as router:
        router.get("https://media.example.test/a.png").respond(302, headers={"location": "https://internal.example.test/secret"})
        internal = router.get("https://internal.example.test/secret").respond(200, content=b"secret")
        with pytest.raises(RuntimeError, match="will not fetch"):
            await public_url.fetch_public_media("https://media.example.test/a.png", label="Krea", max_bytes=1000)
        assert not internal.called


@pytest.mark.asyncio
async def test_public_media_is_fetched_without_credentials_and_size_capped(dns):
    with respx.mock as router:
        route = router.get("https://media.example.test/a.png").respond(200, content=b"x" * 10, headers={"content-type": "image/png"})
        assert await public_url.fetch_public_media("https://media.example.test/a.png", label="Krea", max_bytes=100) == (b"x" * 10, "image/png")
        assert "authorization" not in route.calls[0].request.headers
        with pytest.raises(RuntimeError, match="larger than"):
            await public_url.fetch_public_media("https://media.example.test/a.png", label="Krea", max_bytes=5)


def test_svg_and_html_outputs_are_served_sandboxed(monkeypatch, tmp_path):
    import main
    monkeypatch.setattr(main, "OUTPUT_ROOT", tmp_path)
    monkeypatch.setattr(main, "DEFAULT_OUTPUT_ROOT", tmp_path)
    (tmp_path / "evil.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'><script>fetch('/api/settings')</script></svg>")
    (tmp_path / "page.html").write_text("<script>alert(1)</script>")
    (tmp_path / "ok.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    client = TestClient(main.app)
    for name in ("evil.svg", "page.html"):
        response = client.get(f"/api/outputs/{name}")
        assert response.status_code == 200
        assert "sandbox" in response.headers["content-security-policy"]
        assert "script-src" not in response.headers["content-security-policy"]
        assert response.headers["x-content-type-options"] == "nosniff"
    image = client.get("/api/outputs/ok.png")
    assert "content-security-policy" not in image.headers
    assert image.headers["x-content-type-options"] == "nosniff"
