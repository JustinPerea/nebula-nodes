"""A raw provider key as a person reads it.

A leaf module: it imports nothing of Nebula's, so the modules that must stay
free of network imports (services/node_route.py; tests/test_node_readiness.py
walks their imports) can use it. services/universal_ports.py re-exports
``setting_label`` for its own callers.
"""
from __future__ import annotations

import re


def setting_label(key: str) -> str:
    """A raw provider key as a person reads it (PR #198, then
    the 2026-11 copy sweep): split into words and set in sentence
    case. Snake case, camelCase and PascalCase all split, and an acronym stays
    in capitals: "guidance_scale" gives "Guidance scale", "filePath" gives
    "File path", "numInferenceSteps" gives "Num inference steps", "imageURL"
    gives "Image URL". The frontend's twin is lib/universalSettingLabel.ts;
    both are held to the same table of cases."""
    spaced = key.replace("_", " ")
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", spaced, flags=re.ASCII)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced, flags=re.ASCII)
    words = [
        word if re.fullmatch(r"[A-Z]{2,}", word, flags=re.ASCII) else word.lower()
        for word in spaced.split(" ")
        if word != ""
    ]
    joined = " ".join(words)
    return joined[:1].upper() + joined[1:]
