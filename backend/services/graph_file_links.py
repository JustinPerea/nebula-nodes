"""How a graph file's links to Nebula's output folder are read and rewritten:
the backend's port of Load graph's link handling (frontend/src/lib/graphFile.ts).

Q123 a (Justin, 2026-10-24): "Yes: `nebula load` and an MCP tool open a
bundle, restoring its files, as Load graph does. A big one opens as a new
project." The canvas restores a `.nebula.zip` through POST /api/outputs/restore,
then rewrites every local `/api/outputs/<path>` link in the graph's params and
outputs to the restored copy (an unmapped one becomes null, an unsafe one is
refused), and checks World and spatial outputs. Agents have no browser, so
the restore does the same for them when asked (`?rewriteLinks=true`).

- ``decoded_portable_component`` is the restore preflight's own rule for one
  path component (main._decoded_portable_component wraps it), and
  ``canonical_portable_output_relative_path`` builds on it: one rule, not a
  copy per caller.
- ``parse_local_output_reference``, ``validated_restore_mapping`` and
  ``rewrite_asset_urls`` follow the canvas's functions of the same names, case
  for case: tests/fixtures/graph_file_links_cases.json is run against both
  (tests/test_graph_file_links.py, frontend/tests/graphFileLinksParity.test.ts).
  Telling a link from text needs the browser's URL parser, so a small part of
  the WHATWG URL rules is here (``_parse_url``): enough to find a URL's scheme,
  credentials, host (with the browser's IPv4 and percent-decoding rules), port,
  path (dot segments resolved), query and fragment.
- "The current backend origin" is only http(s)://localhost or 127.0.0.1 here:
  there is no page whose origin could be the backend's.
- ``sanitize_imported_spatial_outputs`` drops at least what the canvas's
  drops (the canvas runs the full World and spatial parsers, frontend/src/lib/
  spatialValue.ts and worldValue.ts, and rebuilds each value from its known
  fields; those parsers aren't ported). A World or spatial output is dropped
  when it isn't an object, when a World asset slot the canvas checks is
  outside Nebula's outputs, when a spatial asset `uri` isn't a plain relative
  /api/outputs/ path, or when any string anywhere in its value is a link
  (a fetchable scheme, or a leading "/") that isn't a Nebula output or, for a
  World, its worldlabs.ai page. So it can drop an output the canvas would
  keep (for example a World with an outside link in a field the canvas
  rebuilds away), never keep one the canvas drops; the shared "spatial" cases
  pin both sides. Every viewer parses its value strictly again before
  showing it.
"""
from __future__ import annotations

import ipaddress
import re
import unicodedata
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, unquote_to_bytes

import idna

OUTPUTS_PREFIX = "/api/outputs/"
OUTPUTS_ROOT = OUTPUTS_PREFIX[:-1]
MAX_PATH_BYTES = 1024
MAX_COMPONENT_BYTES = 255

_PORTABLE_COMPONENT_FORBIDDEN = re.compile(r'[<>:"|?#*\\\x00-\x1f\x7f]')
_WINDOWS_DEVICE_NAME = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.IGNORECASE)
_PROTOTYPE_COMPONENTS = {"__proto__", "prototype", "constructor"}
_INVALID_PERCENT = re.compile(r"%(?![0-9A-Fa-f]{2})")

# String.prototype.trim's whitespace (WhiteSpace and LineTerminator), which
# isn't Python's str.strip() set (that one strips \x1c-\x1f and \x85 too).
JS_WHITESPACE = ("\t\n\v\f\r             "
                 "     　﻿")


def js_trim(value: str) -> str:
    return value.strip(JS_WHITESPACE)


def _has_control_characters(value: str) -> bool:
    return any(ord(char) <= 0x1F or ord(char) == 0x7F for char in value)


class PortablePathError(ValueError):
    """A path component the restore won't extract (its text is the restore's 400 detail)."""


class GraphFileLinkError(ValueError):
    """The restore's URL mapping isn't one the canvas would accept."""


def decoded_portable_component(raw_part: str) -> tuple[str, str]:
    """Return once-decoded NFC text and its browser-compatible identity
    (the restore preflight's rule for one archive path component)."""
    if _INVALID_PERCENT.search(raw_part):
        raise PortablePathError("Zip bundle path has invalid percent encoding")
    try:
        decoded = unquote_to_bytes(raw_part).decode("utf-8")
    except UnicodeError as exc:
        # UnicodeEncodeError too: a lone surrogate in a link (JSON allows one)
        # isn't a UTF-8 path, as encodeURIComponent refuses it in the canvas.
        raise PortablePathError("Zip bundle path is not valid UTF-8") from exc
    decoded = unicodedata.normalize("NFC", decoded)

    def reject_unsafe(value: str) -> None:
        if (
            not value
            or value in {".", ".."}
            or "/" in value
            or "\\" in value
            or _PORTABLE_COMPONENT_FORBIDDEN.search(value)
            or value.endswith((" ", "."))
            or _WINDOWS_DEVICE_NAME.fullmatch(value)
            or value.casefold() in _PROTOTYPE_COMPONENTS
        ):
            raise PortablePathError("Zip bundle contains a non-portable path")

    reject_unsafe(decoded)
    probe = decoded
    for _decode_pass in range(4):
        if "%" not in probe:
            break
        if _INVALID_PERCENT.search(probe):
            raise PortablePathError("Zip bundle path has invalid percent encoding")
        try:
            nested = unquote_to_bytes(probe).decode("utf-8")
        except UnicodeError as exc:
            raise PortablePathError("Zip bundle path is not valid UTF-8") from exc
        nested = unicodedata.normalize("NFC", nested)
        if nested == probe:
            break
        reject_unsafe(nested)
        probe = nested
    if "%" in probe:
        # The frontend applies the same bounded nested-decode policy. Reject
        # residual encoding instead of extracting a path the browser will
        # subsequently refuse (which would orphan a restore directory).
        raise PortablePathError("Zip bundle path has excessive percent encoding")

    # JavaScript encodeURIComponent's unescaped set, minus '*' which the
    # portability policy rejects above.
    canonical = quote(decoded, safe="-_.!~'()")
    if len(canonical.encode("utf-8")) > MAX_COMPONENT_BYTES:
        raise PortablePathError("Zip bundle path component is too long")
    return decoded, canonical


def canonical_portable_output_relative_path(raw: str) -> str | None:
    """The canvas's canonicalPortableOutputRelativePath: the once-encoded NFC
    key for an output-relative path, or None when it isn't portable."""
    if not isinstance(raw, str) or not raw or raw.startswith("/") or raw.endswith("/") or "\\" in raw:
        return None
    parts = raw.split("/")
    if any(not part for part in parts):
        return None
    try:
        canonical = "/".join(decoded_portable_component(part)[1] for part in parts)
    except PortablePathError:
        return None
    return canonical if len(canonical.encode("utf-8")) <= MAX_PATH_BYTES else None


# -- a part of the WHATWG URL parser ----------------------------------------------------

_SPECIAL_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21}
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+\-.]*:")
_FORBIDDEN_HOST = set("\x00\t\n\r #/:<>?@[\\]^|")
_FORBIDDEN_DOMAIN = _FORBIDDEN_HOST | {chr(code) for code in range(0x20)} | {"%", "\x7f"}
_PATH_ENCODE = set(' "#<>?`{}')
_DOUBLE_DOT = {"..", ".%2e", "%2e.", "%2e%2e"}
_SINGLE_DOT = {".", "%2e"}


@dataclass
class _URL:
    scheme: str
    username: str = ""
    password: str = ""
    host: str | None = None
    port: int | None = None
    path: str = ""
    query: str | None = None
    fragment: str | None = None

    def origin(self) -> str | None:
        if self.scheme not in _SPECIAL_PORTS or self.host is None:
            return None
        return f"{self.scheme}://{self.host}" + (f":{self.port}" if self.port is not None else "")


def _ipv4_number(part: str) -> int | None:
    if not part:
        return None
    radix = 10
    if part[:2] in ("0x", "0X"):
        radix, part = 16, part[2:]
    elif len(part) > 1 and part[0] == "0":
        radix, part = 8, part[1:]
    if not part:
        return 0
    digits = {10: "0123456789", 8: "01234567", 16: "0123456789abcdefABCDEF"}[radix]
    if any(char not in digits for char in part):
        return None
    return int(part, radix)


def _ends_in_a_number(domain: str) -> bool:
    parts = domain.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    last = parts[-1]
    if last and all(char in "0123456789" for char in last):
        return True
    return _ipv4_number(last) is not None


def _ipv4(domain: str) -> str | None:
    """The browser's IPv4 host parser ("127.1", "0x7f.0.0.1", "2130706433");
    None for a failure."""
    parts = domain.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    if len(parts) > 4:
        return None
    numbers = [_ipv4_number(part) for part in parts]
    if any(number is None for number in numbers):
        return None
    if any(number > 255 for number in numbers[:-1]):  # type: ignore[operator]
        return None
    if numbers[-1] >= 256 ** (5 - len(numbers)):  # type: ignore[operator]
        return None
    address = numbers[-1]
    for index, number in enumerate(numbers[:-1]):
        address += number * 256 ** (3 - index)  # type: ignore[operator]
    return ".".join(str((address >> shift) & 0xFF) for shift in (24, 16, 8, 0))  # type: ignore[operator]


def _domain_host(raw: str) -> str | None:
    """A special URL's host: percent-decoded, to ASCII, lowercased, an IPv4
    serialized. None for a failure."""
    if raw.startswith("["):
        if not raw.endswith("]"):
            return None
        try:
            return f"[{ipaddress.IPv6Address(raw[1:-1]).compressed}]"
        except ValueError:
            return None
    domain = unquote_to_bytes(raw).decode("utf-8", errors="replace")
    if domain.isascii():
        ascii_domain = domain.lower()
    else:
        # The browser's UTS #46 processing (non-transitional, no STD3 rules),
        # not Python's "idna" codec: that one is IDNA 2003 on Unicode 3.2 and
        # reads the squared letters U+1F13B... spelling LOCALHOST, which a
        # browser maps to localhost, as a foreign host, so its link would skip the
        # rewrite. A host that maps to plain ASCII is used as mapped: the idna
        # package's hyphen and empty-label checks, which a browser doesn't run,
        # then can't turn a local host into a failure.
        try:
            mapped = idna.uts46_remap(domain, std3_rules=False, transitional=False)
            ascii_domain = (mapped if mapped.isascii()
                            else idna.encode(mapped, uts46=False).decode("ascii")).lower()
        except (idna.IDNAError, UnicodeError, ValueError):
            return None
    if not ascii_domain or any(char in _FORBIDDEN_DOMAIN for char in ascii_domain):
        return None
    if _ends_in_a_number(ascii_domain):
        return _ipv4(ascii_domain)
    return ascii_domain


def _opaque_host(raw: str) -> str | None:
    if raw.startswith("["):
        return _domain_host(raw)
    if any(char in _FORBIDDEN_HOST for char in raw):
        return None
    return raw


def _encode_path_segment(segment: str) -> str:
    out = []
    for char in segment:
        if ord(char) <= 0x1F or ord(char) > 0x7E or char in _PATH_ENCODE:
            out.append("".join(f"%{byte:02X}" for byte in char.encode("utf-8")))
        else:
            out.append(char)
    return "".join(out)


def _path(raw: str, special: bool) -> str:
    if special:
        raw = raw.replace("\\", "/")
    parts = raw[1:].split("/") if raw.startswith("/") else raw.split("/")
    segments: list[str] = []
    for index, segment in enumerate(parts):
        last = index == len(parts) - 1
        lowered = segment.lower()
        if lowered in _DOUBLE_DOT:
            if segments:
                segments.pop()
            if last:
                segments.append("")
        elif lowered in _SINGLE_DOT:
            if last:
                segments.append("")
        else:
            segments.append(_encode_path_segment(segment))
    return "/" + "/".join(segments)


def _split_tail(rest: str, special: bool) -> tuple[str, str | None, str | None]:
    """(path, query, fragment) of what follows the host."""
    fragment = None
    if "#" in rest:
        rest, fragment = rest.split("#", 1)
    query = None
    if "?" in rest:
        rest, query = rest.split("?", 1)
    return rest, query, fragment


def _authority(url: _URL, rest: str, special: bool) -> _URL | None:
    end = len(rest)
    for index, char in enumerate(rest):
        if char in "/?#" or (special and char == "\\"):
            end = index
            break
    authority, tail = rest[:end], rest[end:]
    if "@" in authority:
        userinfo, authority = authority.rsplit("@", 1)
        if not authority:
            return None
        username, _, password = userinfo.partition(":")
        url.username, url.password = username, password
    host, port = authority, ""
    if not host.startswith("["):
        host, _, port = authority.partition(":")
    else:
        close = authority.find("]")
        if close != -1 and authority[close + 1:].startswith(":"):
            host, port = authority[:close + 1], authority[close + 2:]
    if port:
        if any(char not in "0123456789" for char in port) or int(port) > 65535:
            return None
        url.port = None if int(port) == _SPECIAL_PORTS.get(url.scheme) else int(port)
    if special:
        if not host:
            return None
        url.host = _domain_host(host)
    else:
        url.host = _opaque_host(host)
    if url.host is None:
        return None
    path, url.query, url.fragment = _split_tail(tail, special)
    url.path = _path(path, special) if (special or path) else ""
    return url


def _parse_url(value: str, base: _URL | None = None) -> _URL | None:
    """`new URL(value, base)` for the parts these checks read; None where the
    browser would throw."""
    text = "".join("�" if 0xD800 <= ord(char) <= 0xDFFF else char for char in value)
    text = text.strip("".join(chr(code) for code in range(0x21)))
    text = text.replace("\t", "").replace("\n", "").replace("\r", "")
    match = _SCHEME.match(text)
    if match:
        scheme = match.group(0)[:-1].lower()
        rest = text[match.end():]
        if scheme == "file":
            url = _URL(scheme, host="")
            if rest[:1] in ("/", "\\") and rest[1:2] in ("/", "\\"):
                parsed = _authority(_URL(scheme), rest[2:], True) if rest[2:3] not in ("/", "\\") else None
                if parsed is not None:
                    parsed.host = "" if parsed.host == "localhost" else parsed.host
                    return parsed
                rest = rest[2:]
            path, url.query, url.fragment = _split_tail(rest, True)
            url.path = _path(path, True)
            return url
        if scheme in _SPECIAL_PORTS:
            if base is not None and base.scheme == scheme and not (
                    rest[:1] in ("/", "\\") and rest[1:2] in ("/", "\\")):
                return _relative(rest, base)
            return _authority(_URL(scheme), rest.lstrip("/\\"), True)
        if rest.startswith("//"):
            return _authority(_URL(scheme), rest[2:], False)
        url = _URL(scheme, host=None)
        path, url.query, url.fragment = _split_tail(rest, False)
        url.path = _path(path, False) if path.startswith("/") else path
        return url
    if base is None:
        return None
    return _relative(text, base)


def _relative(text: str, base: _URL) -> _URL | None:
    if text[:1] in ("/", "\\") and text[1:2] in ("/", "\\"):
        return _authority(_URL(base.scheme), text.lstrip("/\\"), True)
    url = _URL(base.scheme, host=base.host, port=base.port)
    path, url.query, url.fragment = _split_tail(text, True)
    if not path.startswith(("/", "\\")):
        path = base.path.rsplit("/", 1)[0] + "/" + path if path else base.path
    url.path = _path(path, True)
    return url


# The page a browser tab resolves a scheme-relative link against (only its
# scheme matters here), and isSafeWorldUrl's own placeholder origin.
_BROWSER_BASE = _URL("http", host="localhost", path="/")
_WORLD_BASE = _URL("https", host="nebula.invalid", path="/")


def _is_local_backend_host(host: str | None) -> bool:
    return host in ("localhost", "127.0.0.1")


# -- the canvas's link checks -----------------------------------------------------------

def raw_absolute_path(value: str) -> str:
    scheme_end = value.find("://")
    if scheme_end < 0:
        return ""
    path_start = value.find("/", scheme_end + 3)
    if path_start < 0:
        return ""
    endings = [index for index in (value.find("?", path_start), value.find("#", path_start)) if index >= 0]
    return value[path_start:min(endings) if endings else len(value)]


_ASCII_ESCAPE = re.compile(r"%([0-7][0-9a-fA-F])")


def resembles_local_output_path(raw: str) -> bool:
    probe = raw.replace("\\", "/")
    for _decode_pass in range(5):
        if probe == OUTPUTS_ROOT or probe.startswith(OUTPUTS_PREFIX):
            return True
        if "%" not in probe:
            return False
        decoded = _ASCII_ESCAPE.sub(lambda match: chr(int(match.group(1), 16)), probe)
        if decoded == probe:
            return False
        probe = decoded.replace("\\", "/")
    return False


def _before_query(value: str) -> str:
    return re.split(r"[?#]", value, maxsplit=1)[0]


def parse_local_output_reference(value: str) -> dict[str, str]:
    """The canvas's parseLocalOutputReference: {"kind": "none"} for text and
    outside links, {"kind": "invalid"} for a local output link spelled in a
    way that could escape the rewrite, {"kind": "valid", "relativePath"}."""
    raw_path = ""
    absolute: _URL | None = None
    if value.startswith(OUTPUTS_PREFIX):
        raw_path = _before_query(value)
    elif value.startswith("/") and resembles_local_output_path(_before_query(value)):
        return {"kind": "invalid"}
    else:
        scheme_relative = value.startswith("//") or value.startswith("\\\\")
        absolute = _parse_url(value, _BROWSER_BASE if scheme_relative else None)
        if absolute is None:
            return {"kind": "none"}
        raw_path = raw_absolute_path(value)
        if not (_is_local_backend_host(absolute.host)
                and (resembles_local_output_path(raw_path) or resembles_local_output_path(absolute.path))):
            return {"kind": "none"}

    if (not raw_path.startswith(OUTPUTS_PREFIX) or value != js_trim(value)
            or _has_control_characters(value) or "\\" in value):
        return {"kind": "invalid"}
    if absolute is not None:
        if (absolute.scheme not in ("http", "https") or absolute.username or absolute.password
                or absolute.query or absolute.fragment):
            return {"kind": "invalid"}
    elif "?" in value or "#" in value:
        return {"kind": "invalid"}
    relative_path = canonical_portable_output_relative_path(raw_path[len(OUTPUTS_PREFIX):])
    if not relative_path:
        return {"kind": "invalid"}
    return {"kind": "valid", "relativePath": relative_path}


def validated_restore_mapping(value: Any) -> dict[str, str]:
    """The canvas's validatedRestoreMapping: each bundle path's canonical key
    to the restored file's /api/outputs/ link."""
    if not isinstance(value, dict):
        raise GraphFileLinkError("Asset restore returned an invalid URL mapping")
    mapping: dict[str, str] = {}
    for raw_path, raw_url in value.items():
        if not isinstance(raw_url, str):
            raise GraphFileLinkError("Asset restore returned an invalid URL mapping")
        path = canonical_portable_output_relative_path(raw_path)
        mapped = parse_local_output_reference(raw_url)
        if not path or mapped["kind"] != "valid":
            raise GraphFileLinkError("Asset restore returned an invalid URL mapping")
        portable = OUTPUTS_PREFIX + mapped["relativePath"]
        if path in mapping and mapping[path] != portable:
            raise GraphFileLinkError("Asset restore returned colliding URL mapping keys")
        mapping[path] = portable
    return mapping


def rewrite_asset_urls(nodes: list[dict[str, Any]], mapping: dict[str, str]) -> list[str]:
    """The canvas's rewriteAssetUrls, on canvas-shaped nodes (node.data.params
    and node.data.outputs), in place. Returns its warnings."""
    missing: dict[str, None] = {}
    counts = {"missing": 0, "invalid": 0}

    def remap(value: Any) -> Any:
        if isinstance(value, str):
            parsed = parse_local_output_reference(value)
            if parsed["kind"] == "none":
                return value
            if parsed["kind"] == "invalid":
                counts["invalid"] += 1
                return None
            mapped = mapping.get(parsed["relativePath"])
            if not mapped:
                counts["missing"] += 1
                if len(missing) < 20:
                    missing[parsed["relativePath"]] = None
                return None
            return mapped
        if isinstance(value, list):
            return [remap(item) for item in value]
        if isinstance(value, dict):
            return {key: remap(item) for key, item in value.items()}
        return value

    for node in nodes:
        data = node.get("data") if isinstance(node, dict) else None
        if not isinstance(data, dict):
            continue
        if data.get("outputs"):
            data["outputs"] = remap(data["outputs"])
        if data.get("params"):
            data["params"] = remap(data["params"])
    warnings = [f"Bundled asset unavailable: {path}" for path in missing]
    if counts["missing"] > len(missing):
        warnings.append(f"{counts['missing'] - len(missing)} additional bundled asset references were unavailable.")
    if counts["invalid"]:
        plural = "" if counts["invalid"] == 1 else "s"
        warnings.append(f"Rejected {counts['invalid']} unsafe bundled asset reference{plural}.")
    return warnings


# -- World and spatial outputs ----------------------------------------------------------

REPRESENTATION_TYPES = frozenset({
    "World", "CameraPose", "CameraPath", "SpatialContext", "DepthMap", "DepthSequence", "PointCloud",
    "SensorRig", "SensorStream", "SpatialSession",
})


def _js_decode_uri_component(value: str) -> str | None:
    if _INVALID_PERCENT.search(value):
        return None
    try:
        return unquote_to_bytes(value).decode("utf-8")
    except UnicodeError:
        return None


def is_safe_world_url(value: Any) -> bool:
    """The canvas's isSafeWorldUrl (frontend/src/lib/worldValue.ts): a link to
    a file in Nebula's outputs, relative or on localhost / 127.0.0.1."""
    if not isinstance(value, str) or not value or value != js_trim(value) or _has_control_characters(value):
        return False
    url = _parse_url(value, _WORLD_BASE)
    if url is None:
        return False
    is_relative = value.startswith("/")
    if ((not is_relative and not _is_local_backend_host(url.host))
            or (is_relative and url.origin() != _WORLD_BASE.origin())
            or url.scheme not in ("http", "https") or url.username or url.password or url.fragment or url.query
            or not url.path.startswith(OUTPUTS_PREFIX)):
        return False
    segments = [_js_decode_uri_component(segment) for segment in url.path[len(OUTPUTS_PREFIX):].split("/")]
    if any(segment is None for segment in segments):
        return False
    return any(segments) and all(
        segment and segment not in (".", "..") and not _has_control_characters(segment)
        and not any(char in segment for char in "/\\?#")
        for segment in segments  # type: ignore[union-attr]
    )


def _count_unsafe_world_assets(value: Any) -> int:
    """The canvas's countUnsafeAssets: the World asset links it checks."""
    if not isinstance(value, dict):
        return 0
    assets = value.get("assets") if isinstance(value.get("assets"), dict) else {}
    candidates: list[Any] = []
    splats = assets.get("splats")
    if isinstance(splats, dict):
        candidates.extend(splats.values())
    elif isinstance(splats, list):
        candidates.extend(item["asset"].get("uri") if isinstance(item, dict) and isinstance(item.get("asset"), dict)
                          else None for item in splats)
    for key in ("panorama", "colliderMesh", "collider_mesh", "thumbnail"):
        candidate = assets.get(key)
        candidates.append(candidate.get("uri") if isinstance(candidate, dict) else candidate)
    point_cloud = assets.get("pointCloud")
    if isinstance(point_cloud, dict) and isinstance(point_cloud.get("asset"), dict):
        candidates.append(point_cloud["asset"].get("uri"))
    depth = assets.get("depthSequence")
    if isinstance(depth, dict) and isinstance(depth.get("frames"), list):
        candidates.extend(frame["asset"].get("uri") if isinstance(frame, dict) and isinstance(frame.get("asset"), dict)
                          else None for frame in depth["frames"])
    return sum(1 for candidate in candidates if isinstance(candidate, str) and not is_safe_world_url(candidate))


def _is_local_asset_uri(uri: Any) -> bool:
    """spatialValue.ts readLocalAssetReference's uri rule: an unsigned relative
    /api/outputs/ path with no empty or traversing segment."""
    if not isinstance(uri, str) or not uri.startswith(OUTPUTS_PREFIX) or "?" in uri or "#" in uri:
        return False
    segments = [_js_decode_uri_component(segment) for segment in uri[len(OUTPUTS_PREFIX):].split("/")]
    return bool(segments) and all(
        segment and segment not in (".", "..") and not _has_control_characters(segment)
        and not any(char in segment for char in "/\\?#")
        for segment in segments
    )


def is_safe_marble_url(value: Any) -> bool:
    """The canvas's isSafeMarbleUrl (worldValue.ts): https on worldlabs.ai."""
    if not isinstance(value, str) or not value or value != js_trim(value) or _has_control_characters(value):
        return False
    url = _parse_url(value)
    return (url is not None and url.scheme == "https" and not url.username and not url.password
            and (url.host == "marble.worldlabs.ai" or (url.host or "").endswith(".worldlabs.ai")))


# Schemes a viewer could fetch or run; "Scene: dusk" is text, not a link.
_LINK_SCHEMES = frozenset({"http", "https", "ws", "wss", "ftp", "file", "data", "blob", "javascript", "filesystem"})
_URL_LEADING = "".join(chr(code) for code in range(0x21))


def _looks_like_link(value: str) -> bool:
    text = value.strip(_URL_LEADING).replace("\t", "").replace("\n", "").replace("\r", "")
    if text[:1] in ("/", "\\"):
        return True
    match = _SCHEME.match(text)
    if not match:
        return False
    return match.group(0)[:-1].lower() in _LINK_SCHEMES or text[match.end():match.end() + 1] in ("/", "\\")


def _holds_outside_link(value: Any) -> bool:
    """Whether any string in a World or spatial value is a link that isn't a
    Nebula output (or, for a World, its Marble page). The canvas rebuilds
    these values from their known fields, so an outside link anywhere else
    never reaches its project; without that parser here, the whole output
    goes instead."""
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
        elif isinstance(current, str) and _looks_like_link(current) and not (
                is_safe_world_url(current) or _is_local_asset_uri(current) or is_safe_marble_url(current)):
            return True
    return False


def _holds_outside_asset(value: Any) -> bool:
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if "uri" in current and not _is_local_asset_uri(current["uri"]):
                return True
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return False


def sanitize_imported_spatial_outputs(nodes: list[dict[str, Any]]) -> list[str]:
    """The canvas's sanitizeImportedSpatialOutputs as a floor: drops at least
    what it drops (see the module's docstring), with its warning lines."""
    unsafe_assets = invalid_worlds = invalid_spatial = 0
    for node in nodes:
        data = node.get("data") if isinstance(node, dict) else None
        outputs = data.get("outputs") if isinstance(data, dict) else None
        if not isinstance(outputs, dict):
            continue
        for port_id, output in list(outputs.items()):
            kind = output.get("type") if isinstance(output, dict) else None
            if kind not in REPRESENTATION_TYPES:
                continue
            value = output.get("value")
            if kind == "World":
                unsafe = _count_unsafe_world_assets(value)
                unsafe_assets += unsafe
                # The canvas's World parsers refuse an outside asset in any
                # slot they read, so it counts the World as invalid too.
                if not isinstance(value, dict) or unsafe or _holds_outside_link(value):
                    invalid_worlds += 1
                    del outputs[port_id]
                continue
            if not isinstance(value, dict) or _holds_outside_asset(value) or _holds_outside_link(value):
                invalid_spatial += 1
                del outputs[port_id]
    warnings = []
    if unsafe_assets:
        warnings.append(f"{unsafe_assets} external World asset reference{' was' if unsafe_assets == 1 else 's were'} "
                        "omitted; only Nebula output assets can be loaded.")
    if invalid_worlds:
        warnings.append(f"{invalid_worlds} invalid World output{' was' if invalid_worlds == 1 else 's were'} "
                        "made unavailable.")
    if invalid_spatial:
        warnings.append(f"{invalid_spatial} invalid spatial output{' was' if invalid_spatial == 1 else 's were'} "
                        "made unavailable.")
    return warnings
