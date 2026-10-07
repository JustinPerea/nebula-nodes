"""Candidate images on a page (§5.3): og:image, <img> + srcset, <picture>."""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urljoin

from PIL import Image

MAX_CANDIDATES = 40
# Only the still formats intake accepts; Pillow never tries its other parsers on
# untrusted header bytes (same rule as media.load_image).
PROBE_FORMATS = ["PNG", "JPEG", "WEBP", "GIF"]


@dataclass
class PageInfo:
    title: str | None = None
    candidates: list[str] = field(default_factory=list)


def _best_from_srcset(srcset: str) -> str | None:
    best, best_score = None, -1.0
    for part in srcset.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        score = 1.0
        if len(bits) > 1:
            desc = bits[1].lower()
            try:
                score = float(desc[:-1]) if desc[-1] in "wx" else 1.0
            except ValueError:
                score = 1.0
        if score > best_score:
            best, best_score = bits[0], score
    return best


class _Parser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.og: list[str] = []
        self.imgs: list[str] = []
        self.title: str | None = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta" and a.get("property", a.get("name", "")).lower() in ("og:image", "og:image:url", "twitter:image"):
            if a.get("content"):
                self.og.append(a["content"])
        elif tag == "img":
            chosen = _best_from_srcset(a["srcset"]) if a.get("srcset") else None
            if chosen:
                self.imgs.append(chosen)
            elif a.get("src"):
                self.imgs.append(a["src"])
        elif tag == "source" and a.get("srcset"):
            chosen = _best_from_srcset(a["srcset"])
            if chosen:
                self.imgs.append(chosen)
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and data.strip():
            self.title = (self.title or "") + data.strip()


def parse_page(html: str, base_url: str) -> PageInfo:
    parser = _Parser()
    parser.feed(html)
    seen, out = set(), []
    for raw in parser.og + parser.imgs:
        if raw.startswith("data:"):
            continue
        absolute = urljoin(base_url, raw)
        if absolute.startswith(("http://", "https://")) and absolute not in seen:
            seen.add(absolute)
            out.append(absolute)
        if len(out) >= MAX_CANDIDATES:
            break
    return PageInfo(title=parser.title, candidates=out)


async def probe_dimensions(url: str, *, fetch) -> tuple[int, int] | None:
    try:
        fetched = await fetch(url, max_bytes=65536, accept="image/*", range_bytes=65536)
        with Image.open(io.BytesIO(fetched.data), formats=PROBE_FORMATS) as img:
            return img.size
    except Exception:  # noqa: BLE001 (a probe failure just means "size unknown")
        return None
