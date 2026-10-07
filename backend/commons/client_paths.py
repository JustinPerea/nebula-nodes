"""Construct scoped client paths without allowing URL traversal or parameters."""
from __future__ import annotations

import re

_ASSET_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


def asset_path(asset_id: str) -> str:
    # Current assets are prefixed ULIDs. Keep synthetic and legacy identifiers
    # usable while rejecting every URL delimiter, encoding and dot segment.
    if not isinstance(asset_id, str) or _ASSET_ID.fullmatch(asset_id) is None:
        raise ValueError("invalid Commons asset id")
    return f"/assets/{asset_id}"
