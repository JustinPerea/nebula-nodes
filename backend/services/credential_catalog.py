"""The provider credentials Nebula knows by name: one list for every consumer.

These are the keys Settings stores (``settings.json`` ``apiKeys`` in the
browser, the Keychain in the desktop app), the names the credential routes
accept, and the environment variable names a launcher must not pass on to the
backend. Keys reach the backend only from Settings or, in the desktop app,
over the sidecar's stdin (services/launch_secrets.py); never from its
environment.

Mirrors, each checked by a test against this set:

- desktop/credentials.mjs ``ALLOWED_PROVIDERS`` (desktop/tests/sidecar.test.mjs),
  which desktop/sidecar.mjs also strips from the sidecar's environment.
- frontend/src/lib/providerCatalog.ts and settings.example.json
  (tests/test_settings_api.py).

Stdlib only and import-light, so backend/devserver.py can read it without
importing the app.
"""
from __future__ import annotations

CREDENTIAL_PROVIDERS: frozenset[str] = frozenset({
    "ANTHROPIC_API_KEY",
    "BYTEPLUS_API_KEY",
    "ELEVENLABS_API_KEY",
    "FAL_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_VERTEX_CREDENTIALS",
    "HIGGSFIELD_API_KEY",
    "IDEOGRAM_API_KEY",
    "KREA_API_TOKEN",
    "KREA_USAGE_KEY",
    "MESHY_API_KEY",
    "MINIMAX_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "QUIVER_API_KEY",
    "REPLICATE_API_TOKEN",
    "RUNWAY_API_KEY",
    "TYPESAFE_API_KEY",
    "XAI_API_KEY",
    "WORLDLABS_API_KEY",
})
