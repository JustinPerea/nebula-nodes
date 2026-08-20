"""Read Nous Portal credentials out of Hermes's per-profile auth files.

Hermes stores provider credentials per profile under
`~/.hermes/profiles/<profile>/auth.json`. There's also a global
`~/.hermes/auth.json` used as a fallback for env-sourced API keys. The
empirical shape of a Nous entry (captured from a real OAuth-authed
profile) is:

    {
      "credential_pool": {
        "nous": [
          {
            "auth_type": "oauth",
            "access_token": "<short-lived oauth token>",
            "refresh_token": "...",
            "agent_key": "sk-...",                  ← Bearer token to use
            "agent_key_expires_at": "...",
            "inference_base_url": "https://inference-api.nousresearch.com/v1",
            "portal_base_url": "https://portal.nousresearch.com",
            ...
          }
        ]
      }
    }

The Bearer token Hermes actually attaches to inference calls is the
`agent_key`, not the OAuth `access_token`. Nous mints short-lived agent
keys (~24h) from the OAuth pair; Hermes refreshes them in the background.
We honor that — our handler attaches `Authorization: Bearer <agent_key>`.
Before returning it, this module validates JWT-shaped keys for a future `exp`
and the `inference:invoke` scope. Historical opaque `sk-*` keys stay compatible
and use Hermes's adjacent expiry metadata when present.

Persisted inference URLs are treated as untrusted and may only name
`https://inference-api.nousresearch.com/v1`. An explicit operator-controlled
`NOUS_INFERENCE_BASE_URL` may select another secure host for staging/tests.

Profile lookup order:
  1. The Daedalus profile (`~/.hermes/profiles/daedalus/auth.json`),
     because Daedalus chat runs through `hermes-daedalus` against this
     profile and the canvas Nous node should see the same auth.
  2. The user's currently active profile (read from `~/.hermes/active_profile`).
  3. The global `~/.hermes/auth.json` as a last resort.

If none have a `nous` entry, we raise a clear error pointing the user at
`hermes-daedalus model` (the right wrapper to run for the Daedalus profile).
"""
from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

DEFAULT_INFERENCE_URL = "https://inference-api.nousresearch.com/v1"
CANONICAL_INFERENCE_HOST = "inference-api.nousresearch.com"
INFERENCE_SCOPE = "inference:invoke"
JWT_EXPIRY_SKEW_SECONDS = 60

HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
GLOBAL_AUTH_FILE = Path(
    os.environ.get("HERMES_AUTH_FILE", str(HERMES_HOME / "auth.json"))
)
DAEDALUS_PROFILE_AUTH = HERMES_HOME / "profiles" / "daedalus" / "auth.json"
ACTIVE_PROFILE_FILE = HERMES_HOME / "active_profile"


class NousNotAuthenticatedError(RuntimeError):
    """Raised when no Hermes profile has a Nous credential.

    Surfaced to the user verbatim — the message tells them which command
    to run and which profile to target, since `hermes-daedalus` and plain
    `hermes` log into different profiles.
    """


class NousCredentialExpiredError(NousNotAuthenticatedError):
    """Raised when Hermes files contain Nous tokens but all are expired."""


class NousCredentialInvalidError(NousNotAuthenticatedError):
    """Raised when Hermes files contain credentials that fail local validation."""


@dataclass(frozen=True)
class NousCredential:
    access_token: str
    base_url: str
    expires_at: datetime | None = None

    @property
    def cache_identity(self) -> str:
        """Return a non-secret identity for expiry/rotation-aware caches."""
        expiry = self.expires_at.isoformat() if self.expires_at is not None else ""
        material = f"{self.access_token}\0{self.base_url}\0{expiry}".encode()
        return sha256(material).hexdigest()


def _parse_expiry(value: object) -> datetime | None:
    """Parse Hermes's ISO-8601 expiry fields without rejecting old profiles.

    Hermes has emitted both ``Z`` and explicit-offset timestamps. A malformed
    or absent timestamp remains provider-validated instead of making a
    credential disappear locally.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (OverflowError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    try:
        return parsed.astimezone(timezone.utc)
    except (OverflowError, ValueError):
        return None


def _credential_expiry(
    cred: dict,
    *,
    uses_agent_key: bool,
) -> datetime | None:
    """Return the selected token's first parseable, token-specific expiry."""
    expiry_keys = (
        ("agent_key_expires_at", "expires_at")
        if uses_agent_key
        else ("access_token_expires_at", "expires_at")
    )
    return next(
        (
            parsed
            for key in expiry_keys
            if (parsed := _parse_expiry(cred.get(key))) is not None
        ),
        None,
    )


def _credential_is_expired(
    cred: dict,
    *,
    uses_agent_key: bool,
    now: datetime | None = None,
) -> bool:
    """Return whether the selected token is expired or inside the safety skew."""
    expiry = _credential_expiry(cred, uses_agent_key=uses_agent_key)
    if expiry is None:
        return False
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    try:
        current_utc = current.astimezone(timezone.utc)
        return (expiry.timestamp() - current_utc.timestamp()) <= JWT_EXPIRY_SKEW_SECONDS
    except (OSError, OverflowError, ValueError):
        # An unrepresentable timestamp is malformed, not proof of a usable
        # credential. JWT claims are rejected separately; legacy opaque-token
        # metadata stays provider-validated for backwards compatibility.
        return False


def _read_pool(path: Path) -> list[dict] | None:
    """Return the `credential_pool.nous` list from an auth.json, or None."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    pool = data.get("credential_pool") or {}
    if not isinstance(pool, dict):
        return None
    nous = pool.get("nous") or []
    if not isinstance(nous, list):
        return None
    credentials = [item for item in nous if isinstance(item, dict)]
    return credentials or None


def _token(value: object) -> str | None:
    """Accept only non-blank string tokens from the external auth file."""
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


class _CredentialRejected(ValueError):
    """Internal, token-free reason to skip one external credential entry."""

    def __init__(self, reason: str, *, expired: bool = False) -> None:
        super().__init__(reason)
        self.expired = expired


def _normalize_secure_base_url(
    value: str,
    *,
    canonical_host_only: bool,
) -> str:
    """Validate and normalize an inference URL before bearer forwarding.

    Hermes auth files are mutable external state, so their URL is not a trust
    boundary. Persisted values may name only Nous's canonical HTTPS inference
    origin. ``NOUS_INFERENCE_BASE_URL`` is an explicit operator-controlled
    escape hatch for staging/tests and may name another host, but it still may
    not downgrade TLS, include userinfo, or target a loopback/private literal.
    """
    if not isinstance(value, str) or not value.strip():
        raise _CredentialRejected("inference base URL is blank or not a string")

    raw = value.strip()
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except (UnicodeError, ValueError) as exc:
        raise _CredentialRejected("inference base URL is malformed") from exc

    if parsed.scheme.lower() != "https":
        raise _CredentialRejected("inference base URL must use HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise _CredentialRejected("inference base URL must not contain userinfo")
    if parsed.query or parsed.fragment:
        raise _CredentialRejected("inference base URL must not contain query or fragment")

    hostname = (parsed.hostname or "").rstrip(".").lower()
    if not hostname:
        raise _CredentialRejected("inference base URL has no host")

    if canonical_host_only:
        if hostname != CANONICAL_INFERENCE_HOST or port not in (None, 443):
            raise _CredentialRejected(
                "persisted inference base URL is not the canonical Nous host"
            )
        if parsed.path.rstrip("/") not in ("", "/v1"):
            raise _CredentialRejected(
                "persisted inference base URL does not use the canonical /v1 path"
            )
        # Return one canonical spelling so downstream callers cannot preserve
        # odd ports, casing, or path encodings.
        return DEFAULT_INFERENCE_URL

    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise _CredentialRejected("inference base URL must not target loopback")
    try:
        literal_ip = ipaddress.ip_address(hostname)
    except ValueError:
        literal_ip = None
    if literal_ip is not None and not literal_ip.is_global:
        raise _CredentialRejected(
            "inference base URL must not target a private or loopback address"
        )

    host_for_url = f"[{hostname}]" if ":" in hostname else hostname
    netloc = host_for_url if port in (None, 443) else f"{host_for_url}:{port}"
    path = parsed.path.rstrip("/") or "/v1"
    return urlunsplit(("https", netloc, path, "", ""))


def _configured_base_url(cred: dict) -> str:
    """Select the trusted operator override or validate one persisted URL."""
    override = os.environ.get("NOUS_INFERENCE_BASE_URL")
    if override is not None and override.strip():
        return _normalize_secure_base_url(override, canonical_host_only=False)

    for key in ("inference_base_url", "base_url"):
        if key not in cred or cred.get(key) in (None, ""):
            continue
        value = cred.get(key)
        if not isinstance(value, str):
            raise _CredentialRejected("persisted inference base URL is malformed")
        return _normalize_secure_base_url(value, canonical_host_only=True)
    return DEFAULT_INFERENCE_URL


def _jwt_claims(token: str) -> dict[str, object] | None:
    """Decode a JWT payload for local expiry/scope preflight.

    This does not authenticate the signature; Nous remains responsible for
    that. It only prevents an obviously expired or under-scoped JWT-shaped
    token from shadowing a usable lower-priority Hermes profile.

    Existing Hermes installs also emit opaque ``sk-*`` agent keys. Tokens that
    are not JWT-shaped therefore remain supported and use Hermes's adjacent
    expiry metadata plus provider validation.
    """
    if token.count(".") != 2:
        return None
    parts = token.split(".")
    if any(not part for part in parts):
        raise _CredentialRejected("JWT-shaped credential has an empty segment")
    payload = parts[1]
    try:
        padded = payload + "=" * (-len(payload) % 4)
        decoded = base64.b64decode(padded, altchars=b"-_", validate=True)
        claims = json.loads(decoded.decode("utf-8"))
    except (
        binascii.Error,
        json.JSONDecodeError,
        OverflowError,
        UnicodeDecodeError,
        UnicodeEncodeError,
        ValueError,
    ) as exc:
        raise _CredentialRejected("JWT-shaped credential payload is malformed") from exc
    if not isinstance(claims, dict):
        raise _CredentialRejected("JWT-shaped credential payload is not an object")
    return claims


def _scope_values(value: object) -> set[str]:
    if isinstance(value, str):
        return {part for part in value.split() if part}
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return {item for item in value if item}
    return set()


def _validate_selected_token(
    token: str,
    cred: dict,
    *,
    uses_agent_key: bool,
    now: datetime,
) -> datetime | None:
    """Validate JWT claims or the legacy opaque-token expiry metadata."""
    claims = _jwt_claims(token)
    if claims is None:
        # Compatibility contract: Hermes historically writes opaque sk-* agent
        # keys and the existing node/handler tests exercise that shape. Keep
        # accepting them, but honor known adjacent expiry metadata with the
        # same short safety skew used for JWT NumericDate claims.
        expiry = _credential_expiry(cred, uses_agent_key=uses_agent_key)
        if _credential_is_expired(cred, uses_agent_key=uses_agent_key, now=now):
            raise _CredentialRejected(
                "credential is expired or about to expire",
                expired=True,
            )
        return expiry

    exp = claims.get("exp")
    if (
        isinstance(exp, bool)
        or not isinstance(exp, (int, float))
        or (isinstance(exp, float) and not math.isfinite(exp))
    ):
        raise _CredentialRejected("JWT-shaped credential has no valid exp claim")
    try:
        expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
    except (OSError, OverflowError, ValueError) as exc:
        raise _CredentialRejected("JWT-shaped credential exp is out of range") from exc
    if exp <= now.timestamp() + JWT_EXPIRY_SKEW_SECONDS:
        raise _CredentialRejected(
            "credential is expired or about to expire",
            expired=True,
        )

    if INFERENCE_SCOPE not in _scope_values(claims.get("scope")):
        raise _CredentialRejected(
            f"JWT-shaped credential is missing {INFERENCE_SCOPE} scope"
        )
    return expires_at


def _candidate_paths() -> list[Path]:
    """Profile-aware lookup order — see module docstring."""
    paths: list[Path] = [DAEDALUS_PROFILE_AUTH]
    if ACTIVE_PROFILE_FILE.exists():
        try:
            name = ACTIVE_PROFILE_FILE.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            name = ""
        # The active profile marker is a directory name, not a path. Treat a
        # malformed marker as absent rather than reading outside profiles/.
        if (
            name
            and name != "daedalus"
            and name not in {".", ".."}
            and "/" not in name
            and "\\" not in name
        ):
            paths.append(HERMES_HOME / "profiles" / name / "auth.json")
    paths.append(GLOBAL_AUTH_FILE)
    return paths


def load_nous_credential() -> NousCredential:
    """Return the highest-priority Nous credential found in any profile."""
    last_path: Path | None = None
    expired_paths: list[Path] = []
    invalid_reasons: list[str] = []
    now = datetime.now(timezone.utc)

    # The override is process configuration rather than credential-file data.
    # Validate it before reading any token so an unsafe explicit value cannot
    # silently fall back to a persisted destination.
    override = os.environ.get("NOUS_INFERENCE_BASE_URL")
    if override is not None and override.strip():
        try:
            _normalize_secure_base_url(override, canonical_host_only=False)
        except _CredentialRejected as exc:
            raise NousCredentialInvalidError(
                f"NOUS_INFERENCE_BASE_URL is unsafe: {exc}."
            ) from exc

    for path in _candidate_paths():
        last_path = path
        nous = _read_pool(path)
        if not nous:
            continue
        for cred in nous:
            agent_key = _token(cred.get("agent_key"))
            access_token = _token(cred.get("access_token"))

            # The agent key is the real inference credential. Only use the
            # OAuth access-token fallback for legacy/access-token-only entries;
            # an expired agent key must not silently downgrade within the same
            # entry when another pool entry or profile may be usable.
            token = agent_key or access_token
            if token is None:
                continue
            uses_agent_key = agent_key is not None
            try:
                expires_at = _validate_selected_token(
                    token,
                    cred,
                    uses_agent_key=uses_agent_key,
                    now=now,
                )
                base_url = _configured_base_url(cred)
            except _CredentialRejected as exc:
                if exc.expired:
                    expired_paths.append(path)
                else:
                    invalid_reasons.append(str(exc))
                continue
            return NousCredential(
                access_token=token,
                base_url=base_url,
                expires_at=expires_at,
            )

    if expired_paths and not invalid_reasons:
        raise NousCredentialExpiredError(
            "All discovered Nous Portal inference credentials are expired. "
            "Run `hermes-daedalus model` and select Nous Portal to refresh "
            "the Daedalus profile."
        )

    if invalid_reasons:
        # Reasons are deliberately token-free and bounded. Neither raw token
        # contents nor arbitrary file data enter the user-facing error.
        detail = "; ".join(dict.fromkeys(invalid_reasons))[:300]
        raise NousCredentialInvalidError(
            "No usable Nous Portal inference credential passed local "
            f"validation ({detail}). Run `hermes-daedalus model` and select "
            "Nous Portal to refresh."
        )

    raise NousNotAuthenticatedError(
        "No Nous Portal credential found in any Hermes profile. "
        "Run `hermes-daedalus model` and select Nous Portal — it OAuths in "
        "the browser and writes the credential into "
        "~/.hermes/profiles/daedalus/auth.json. "
        f"(Last path checked: {last_path})"
    )
