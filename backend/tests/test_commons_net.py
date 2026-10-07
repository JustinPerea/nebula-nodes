from __future__ import annotations

import io
import ipaddress

import httpx
import pytest
from PIL import Image

from commons import intake, net, page
from commons.db import CommonsDB
from commons.store import CommonsStore

PUBLIC = ipaddress.ip_address("93.184.216.34")


@pytest.mark.parametrize("ip", [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "0.1.2.3", "224.0.0.1", "240.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::127.0.0.1", "fe80::1", "fc00::1",
    "ff02::1", "64:ff9b::7f00:1", "2002:7f00:1::1",
])
def test_blocked_ranges(ip):
    assert net.ip_blocked(ipaddress.ip_address(ip))


@pytest.mark.parametrize("ip", ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
def test_public_addresses_allowed(ip):
    assert not net.ip_blocked(ipaddress.ip_address(ip))


@pytest.mark.parametrize("host", ["2130706433", "0177.0.0.1", "0x7f.1", "017700000001", "127.1"])
def test_non_canonical_ip_literals_rejected(host):
    with pytest.raises(net.FetchBlocked):
        net.parse_literal_host(host)


def test_hostnames_are_not_literals():
    assert net.parse_literal_host("images.example.com") is None
    assert net.parse_literal_host("1e100.net") is None


def _png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (30, 20), (0, 90, 200)).save(buf, "PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_fetch_connects_to_pinned_ip_with_host_header():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["host"] = request.url.host
        seen["host_header"] = request.headers["host"]
        return httpx.Response(200, headers={"content-type": "image/png"}, content=_png())

    fetched = await net.safe_fetch("https://images.example.com/a.png", max_bytes=10_000_000,
                                   resolver=lambda h, p: PUBLIC, transport=httpx.MockTransport(handler))
    assert seen == {"host": "93.184.216.34", "host_header": "images.example.com"}
    assert fetched.data == _png()


@pytest.mark.asyncio
async def test_redirect_to_internal_is_blocked():
    def handler(request):
        return httpx.Response(302, headers={"location": "http://127.0.0.1:8000/api/settings"})

    def resolver(host, port):
        if host == "127.0.0.1":
            raise net.FetchBlocked("loopback")
        return PUBLIC

    with pytest.raises(net.FetchBlocked):
        await net.safe_fetch("https://evil.example/x", max_bytes=1000, resolver=resolver,
                             transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_too_many_redirects():
    def handler(request):
        return httpx.Response(302, headers={"location": "https://a.example/next"})

    with pytest.raises(net.FetchBlocked, match="redirect"):
        await net.safe_fetch("https://a.example/", max_bytes=1000, resolver=lambda h, p: PUBLIC,
                             transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_byte_cap_enforced():
    def handler(request):
        return httpx.Response(200, headers={"content-type": "image/png"}, content=b"x" * 5000)

    with pytest.raises(net.FetchError, match="cap"):
        await net.safe_fetch("https://a.example/big", max_bytes=1000, resolver=lambda h, p: PUBLIC,
                             transport=httpx.MockTransport(handler))


@pytest.mark.parametrize("url", ["ftp://a.example/x", "file:///etc/passwd", "https://u:p@a.example/",
                                 "https://a.example:8443/x", "http://[::1]/"])
@pytest.mark.asyncio
async def test_bad_urls_rejected(url):
    with pytest.raises(net.FetchBlocked):
        await net.safe_fetch(url, max_bytes=1000, resolver=net.resolve_pinned,
                             transport=httpx.MockTransport(lambda r: httpx.Response(200)))


def test_parse_page_finds_og_srcset_and_picture():
    html = """<html><head><title>Studio X</title>
      <meta property="og:image" content="/og.jpg"></head><body>
      <img src="small.jpg" srcset="small.jpg 400w, large.jpg 1600w">
      <picture><source srcset="hero.webp 1x, hero@2x.webp 2x"><img src="hero.jpg"></picture>
      <img src="data:image/png;base64,xx"></body></html>"""
    info = page.parse_page(html, "https://studio.example/work/")
    assert info.title == "Studio X"
    assert info.candidates[0] == "https://studio.example/og.jpg"
    assert "https://studio.example/work/large.jpg" in info.candidates
    assert "https://studio.example/work/hero@2x.webp" in info.candidates
    assert not any(c.startswith("data:") for c in info.candidates)


@pytest.mark.asyncio
async def test_add_url_image_and_page(tmp_path):
    store = CommonsStore(CommonsDB(tmp_path / "c.db"), tmp_path / "blobs")
    col = store.ensure_collection("web", "manual")

    async def fake_fetch(url, **kw):
        if url.endswith(".png"):
            return net.Fetched(url, url, "image/png", _png(), 200)
        return net.Fetched(url, url, "text/html; charset=utf-8",
                           b'<title>T</title><img src="/a.png">', 200)

    res = await intake.add_url(store, "https://a.example/a.png", collection_id=col["id"],
                               actor="human:justin", fetch=fake_fetch, page_url="https://a.example/",
                               page_title="T")
    assert res.sighting["url"] == "https://a.example/a.png" and res.sighting["page_title"] == "T"
    assert res.sighting["fetched_at"]
    page_res = await intake.add_url(store, "https://a.example/", collection_id=col["id"],
                                    actor="human:justin", fetch=fake_fetch)
    assert page_res["kind"] == "page" and page_res["candidates"][0]["url"] == "https://a.example/a.png"
