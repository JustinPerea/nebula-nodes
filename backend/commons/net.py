"""SSRF-safe fetching for URL intake (§3.2)."""
from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

MAX_REDIRECTS = 3
DNS_TIMEOUT = 10.0
ALLOWED_PORTS = {80, 443}
USER_AGENT = "NebulaCommons/1 (+local reference intake)"

_BLOCKED_V4 = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32")]
_BLOCKED_V6 = [ipaddress.ip_network(n) for n in (
    "::/96", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23",
    "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8")]
_NUMERIC_HOST = re.compile(r"^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+)){0,3}$", re.IGNORECASE)


class FetchBlocked(Exception):
    pass


class FetchError(Exception):
    pass


@dataclass
class Fetched:
    url: str
    final_url: str
    content_type: str
    data: bytes
    status: int = 200


def ip_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        return any(ip in n for n in _BLOCKED_V6) or not ip.is_global
    return any(ip in n for n in _BLOCKED_V4) or not ip.is_global or ip.is_multicast


def parse_literal_host(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    text = host.strip("[]")
    try:
        return ipaddress.ip_address(text)
    except ValueError:
        pass
    if _NUMERIC_HOST.fullmatch(text):
        raise FetchBlocked(f"non-canonical IP literal: {host!r}")
    return None


def resolve_pinned(host: str, port: int) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    literal = parse_literal_host(host)
    if literal is not None:
        if ip_blocked(literal):
            raise FetchBlocked(f"blocked address {literal}")
        return literal
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise FetchError(f"cannot resolve {host}: {exc}") from exc
    ips = [ipaddress.ip_address(info[4][0].split("%")[0]) for info in infos]
    if not ips:
        raise FetchError(f"no addresses for {host}")
    for ip in ips:
        if ip_blocked(ip):
            raise FetchBlocked(f"{host} resolves to blocked address {ip}")
    return ips[0]


async def safe_fetch(url: str, *, max_bytes: int, accept: str = "*/*", range_bytes: int | None = None,
                     resolver=resolve_pinned, transport: httpx.AsyncBaseTransport | None = None) -> Fetched:
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        parts = urlsplit(current)
        if parts.scheme not in ("http", "https"):
            raise FetchBlocked(f"scheme not allowed: {parts.scheme!r}")
        if parts.username or parts.password:
            raise FetchBlocked("credentials in URL are not allowed")
        host = parts.hostname
        if not host:
            raise FetchBlocked("URL has no host")
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if port not in ALLOWED_PORTS:
            raise FetchBlocked(f"port not allowed: {port}")
        parse_literal_host(host)  # rejects octal/decimal forms before any DNS
        try:
            # getaddrinfo in a thread can't be cancelled and httpx's timeout doesn't cover it; bound the wait.
            ip = await asyncio.wait_for(asyncio.to_thread(resolver, host, port), DNS_TIMEOUT)
        except TimeoutError as exc:
            raise FetchError(f"DNS lookup for {host} timed out") from exc
        if ip_blocked(ip):
            raise FetchBlocked(f"blocked address {ip}")
        ip_host = f"[{ip}]" if ip.version == 6 else str(ip)
        target = urlunsplit((parts.scheme, f"{ip_host}:{port}", parts.path or "/", parts.query, ""))
        host_header = host if parts.port is None else f"{host}:{parts.port}"
        headers = {"Host": host_header, "User-Agent": USER_AGENT, "Accept": accept}
        if range_bytes:
            headers["Range"] = f"bytes=0-{range_bytes - 1}"
        extensions = {"sni_hostname": host} if parts.scheme == "https" else {}
        async with httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                                     timeout=httpx.Timeout(20.0)) as client:
            request = client.build_request("GET", target, headers=headers, extensions=extensions)
            response = await client.send(request, stream=True)
            try:
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get("location")
                    if not location:
                        raise FetchError("redirect without Location")
                    current = urljoin(current, location)
                    continue
                if response.status_code >= 400:
                    raise FetchError(f"HTTP {response.status_code}")
                declared = int(response.headers.get("content-length") or 0)
                if declared > max_bytes and not range_bytes:
                    raise FetchError(f"response exceeds the {max_bytes}-byte cap")
                buf = bytearray()
                async for chunk in response.aiter_bytes():
                    buf.extend(chunk)
                    if len(buf) > max_bytes:
                        if range_bytes:
                            break
                        raise FetchError(f"response exceeds the {max_bytes}-byte cap")
                return Fetched(url, current, response.headers.get("content-type", ""), bytes(buf),
                               response.status_code)
            finally:
                await response.aclose()
    raise FetchBlocked("too many redirects")
