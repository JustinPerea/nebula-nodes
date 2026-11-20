"""Errors the library raises. Each message is one plain sentence a person can read."""
from __future__ import annotations


class ExtractionRefused(Exception):
    """An input or a folder the library will not take (a video, an oversize file, a folder that is not allowed)."""


class StoreRefused(ExtractionRefused):
    """A folder or record path the store will not read or write."""
