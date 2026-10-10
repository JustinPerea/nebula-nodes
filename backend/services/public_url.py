"""Fetch provider-supplied media only from public https hosts.

Provider responses can carry URLs that a model, a shared workspace or an agent
chose. Each request and every redirect hop is checked against DNS so a URL
cannot reach this machine or a private network. httpx resolves again for TLS,
so this blocks ordinary SSRF targets but cannot pin against DNS rebinding.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urljoin, urlsplit

import httpx

MAX_REDIRECTS = 5


async def resolve_host(hostname: str, port: int) -> set[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        records = await asyncio.to_thread(socket.getaddrinfo, hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise RuntimeError("Could not resolve the media host") from exc
    try:
        return {ipaddress.ip_address(str(record[4][0]).split("%", 1)[0]) for record in records}
    except ValueError as exc:
        raise RuntimeError("Media host resolved to an invalid address") from exc


async def require_public_https(url: str, label: str) -> str:
    unsafe = RuntimeError(f"{label} returned a media URL Nebula will not fetch")
    if not isinstance(url, str) or url != url.strip() or len(url) > 8192:
        raise unsafe
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        raise unsafe from None
    hostname = (parsed.hostname or "").rstrip(".").lower()
    if (parsed.scheme != "https" or not hostname or parsed.username is not None or parsed.password is not None
            or port not in (None, 443) or hostname == "localhost" or hostname.endswith(".localhost")):
        raise unsafe
    try:
        addresses = {ipaddress.ip_address(hostname)}
    except ValueError:
        addresses = await resolve_host(hostname, 443)
    if not addresses or any(not address.is_global for address in addresses):
        raise unsafe
    return url


async def fetch_public_media(url: str, *, label: str, max_bytes: int, timeout: float = 300.0) -> tuple[bytes, str]:
    """GET a public https URL without credentials; return (bytes, content type)."""
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            await require_public_https(url, label)
            async with client.stream("GET", url) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise RuntimeError(f"{label} media redirect had no target")
                    url = urljoin(url, location)
                    continue
                response.raise_for_status()
                chunks, size = [], 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise RuntimeError(f"{label} media is larger than {max_bytes // 1_000_000} MB")
                    chunks.append(chunk)
                return b"".join(chunks), response.headers.get("content-type", "")
    raise RuntimeError(f"{label} media redirected too many times")
