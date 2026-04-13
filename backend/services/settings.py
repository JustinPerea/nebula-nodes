from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SETTINGS_PATH = Path(__file__).resolve().parent.parent.parent / "settings.json"

DEFAULT_SETTINGS: dict[str, Any] = {
    "apiKeys": {},
    "routing": {},
    "outputPath": None,
    "executionMode": "manual",
    "batchSizeCap": 25,
}


def load_settings() -> dict[str, Any]:
    if SETTINGS_PATH.exists():
        with open(SETTINGS_PATH, "r") as f:
            return json.load(f)
    return dict(DEFAULT_SETTINGS)


def save_settings(settings: dict[str, Any]) -> None:
    with open(SETTINGS_PATH, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")


def get_api_key(provider_key_name: str | list[str]) -> str | None:
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})

    if isinstance(provider_key_name, str):
        names = [provider_key_name]
    else:
        names = provider_key_name

    for name in names:
        key = api_keys.get(name)
        if key:
            return key
    return None
