"""Prefixed ULIDs (`ast_…`), matching PLAN's id style. No dependency."""
from __future__ import annotations

import secrets
import time

_CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"


def new_id(prefix: str, *, now_ms: int | None = None, rand: bytes | None = None) -> str:
    ms = int(time.time() * 1000) if now_ms is None else now_ms
    tail = secrets.token_bytes(10) if rand is None else rand
    value = (ms << 80) | int.from_bytes(tail, "big")
    chars = []
    for _ in range(26):
        chars.append(_CROCKFORD[value & 31])
        value >>= 5
    return f"{prefix}_{''.join(reversed(chars))}"
