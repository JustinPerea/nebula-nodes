from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from services import nous_auth


def _write_auth(
    path: Path,
    *,
    token: str,
    expires_at: str | None,
    base_url: str = nous_auth.DEFAULT_INFERENCE_URL,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    credential: dict[str, str] = {
        "auth_type": "oauth",
        "agent_key": token,
        "inference_base_url": base_url,
    }
    if expires_at is not None:
        credential["agent_key_expires_at"] = expires_at
    path.write_text(
        json.dumps({"credential_pool": {"nous": [credential]}}),
        encoding="utf-8",
    )


def _write_entries(path: Path, entries: list[object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"credential_pool": {"nous": entries}}),
        encoding="utf-8",
    )


def _point_at_temp_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("NOUS_INFERENCE_BASE_URL", raising=False)
    monkeypatch.setattr(
        nous_auth,
        "DAEDALUS_PROFILE_AUTH",
        tmp_path / "profiles" / "daedalus" / "auth.json",
    )
    monkeypatch.setattr(nous_auth, "ACTIVE_PROFILE_FILE", tmp_path / "active_profile")
    monkeypatch.setattr(nous_auth, "GLOBAL_AUTH_FILE", tmp_path / "auth.json")


def _b64url(value: object) -> str:
    encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode("ascii")


def _jwt(claims: dict[str, object]) -> str:
    return f"{_b64url({'alg': 'RS256', 'typ': 'JWT'})}.{_b64url(claims)}.signature"


def test_load_nous_credential_skips_expired_high_priority_profile(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token="expired-daedalus-key",
        expires_at="2000-01-01T00:00:00+00:00",
    )
    _write_auth(
        nous_auth.GLOBAL_AUTH_FILE,
        token="usable-global-key",
        expires_at="2999-01-01T00:00:00Z",
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "usable-global-key"


def test_load_nous_credential_keeps_unexpired_high_priority_profile(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token="usable-daedalus-key",
        expires_at="2999-01-01T00:00:00+00:00",
    )
    _write_auth(
        nous_auth.GLOBAL_AUTH_FILE,
        token="usable-global-key",
        expires_at="2999-01-01T00:00:00+00:00",
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "usable-daedalus-key"


def test_load_nous_credential_reports_all_expired_profiles(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token="expired-daedalus-key",
        expires_at="2000-01-01T00:00:00+00:00",
    )
    _write_auth(
        nous_auth.GLOBAL_AUTH_FILE,
        token="expired-global-key",
        expires_at="2001-01-01T00:00:00+00:00",
    )

    with pytest.raises(nous_auth.NousCredentialExpiredError, match="expired"):
        nous_auth.load_nous_credential()


def test_malformed_expiry_is_left_for_provider_validation() -> None:
    credential = {
        "agent_key": "opaque-key",
        "agent_key_expires_at": "not-a-date",
    }

    assert not nous_auth._credential_is_expired(
        credential,
        uses_agent_key=True,
        now=datetime(2026, 8, 19, tzinfo=timezone.utc),
    )


def test_generic_expires_at_is_used_for_agent_key() -> None:
    credential = {
        "agent_key": "opaque-key",
        "expires_at": "2026-08-18T23:59:59Z",
    }

    assert nous_auth._credential_is_expired(
        credential,
        uses_agent_key=True,
        now=datetime(2026, 8, 19, tzinfo=timezone.utc),
    )


def test_access_token_only_entry_uses_generic_expires_at_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_entries(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        [
            {
                "access_token": "expired-access-token",
                "expires_at": "2000-01-01T00:00:00Z",
            },
            {
                "access_token": "usable-access-token",
                "expires_at": "2999-01-01T00:00:00Z",
                "inference_base_url": nous_auth.DEFAULT_INFERENCE_URL,
            },
        ],
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "usable-access-token"
    assert credential.base_url == nous_auth.DEFAULT_INFERENCE_URL
    assert credential.expires_at == datetime(2999, 1, 1, tzinfo=timezone.utc)


def test_multiple_pool_entries_skip_expired_before_usable_entry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_entries(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        [
            {
                "agent_key": "expired-first-key",
                "agent_key_expires_at": "2000-01-01T00:00:00Z",
            },
            {
                "agent_key": "usable-second-key",
                "agent_key_expires_at": "2999-01-01T00:00:00Z",
            },
        ],
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "usable-second-key"


@pytest.mark.parametrize("bad_agent_key", ["", "   ", 123, ["not", "a", "token"], {}])
def test_blank_or_non_string_agent_key_does_not_shadow_access_token(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    bad_agent_key: object,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_entries(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        [
            {
                "agent_key": bad_agent_key,
                "access_token": "usable-access-token",
                "access_token_expires_at": "2999-01-01T00:00:00Z",
            }
        ],
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "usable-access-token"


def test_malformed_pool_entries_and_tokens_are_skipped(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_entries(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        [
            "not-an-object",
            {"agent_key": 123, "access_token": []},
            {"agent_key": "  usable-key  "},
        ],
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "usable-key"
    assert credential.base_url == nous_auth.DEFAULT_INFERENCE_URL


def test_cache_identity_changes_without_containing_token() -> None:
    first = nous_auth.NousCredential(
        access_token="secret-token-one",
        base_url="https://inference.example/v1",
        expires_at=datetime(2999, 1, 1, tzinfo=timezone.utc),
    )
    rotated = nous_auth.NousCredential(
        access_token="secret-token-two",
        base_url="https://inference.example/v1",
        expires_at=datetime(2999, 1, 1, tzinfo=timezone.utc),
    )

    assert first.cache_identity != rotated.cache_identity
    assert "secret-token-one" not in first.cache_identity


@pytest.mark.parametrize(
    "untrusted_url",
    [
        "http://inference-api.nousresearch.com/v1",
        "https://127.0.0.1/v1",
        "https://user@inference-api.nousresearch.com/v1",
        "https://inference-api.nousresearch.com.evil.test/v1",
        "https://inference-api.nousresearch.com@evil.test/v1",
    ],
)
def test_untrusted_persisted_base_url_falls_through_without_forwarding_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    untrusted_url: str,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token="poisoned-high-priority-token",
        expires_at="2999-01-01T00:00:00Z",
        base_url=untrusted_url,
    )
    _write_auth(
        nous_auth.GLOBAL_AUTH_FILE,
        token="safe-fallback-token",
        expires_at="2999-01-01T00:00:00Z",
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "safe-fallback-token"
    assert credential.base_url == nous_auth.DEFAULT_INFERENCE_URL


def test_only_untrusted_persisted_base_url_is_controlled_auth_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token="must-not-be-forwarded",
        expires_at="2999-01-01T00:00:00Z",
        base_url="https://inference-api.nousresearch.com.evil.test/v1",
    )

    with pytest.raises(
        nous_auth.NousCredentialInvalidError,
        match="canonical Nous host",
    ):
        nous_auth.load_nous_credential()


def test_explicit_https_base_url_override_is_trusted_for_staging(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    monkeypatch.setenv(
        "NOUS_INFERENCE_BASE_URL",
        "https://staging-inference.nous.test/custom/v1/",
    )
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token="staging-token",
        expires_at="2999-01-01T00:00:00Z",
        # The operator override, not this untrusted persisted value, wins.
        base_url="https://attacker.example/v1",
    )

    credential = nous_auth.load_nous_credential()

    assert credential.base_url == "https://staging-inference.nous.test/custom/v1"


@pytest.mark.parametrize(
    "unsafe_override",
    [
        "http://staging-inference.nous.test/v1",
        "https://localhost/v1",
        "https://127.0.0.1/v1",
        "https://user@staging-inference.nous.test/v1",
    ],
)
def test_unsafe_explicit_base_url_override_is_controlled_auth_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    unsafe_override: str,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    monkeypatch.setenv("NOUS_INFERENCE_BASE_URL", unsafe_override)
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token="must-not-be-forwarded",
        expires_at="2999-01-01T00:00:00Z",
    )

    with pytest.raises(nous_auth.NousCredentialInvalidError, match="unsafe"):
        nous_auth.load_nous_credential()


def test_valid_jwt_requires_future_exp_and_inference_scope(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    token = _jwt({"exp": 32503680000, "scope": ["profile:read", "inference:invoke"]})
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token=token,
        expires_at=None,
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == token
    assert credential.expires_at == datetime(3000, 1, 1, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "claims",
    [
        {"exp": 32503680000, "scope": "profile:read"},
        {"scope": "inference:invoke"},
        {"exp": "32503680000", "scope": "inference:invoke"},
    ],
)
def test_invalid_high_priority_jwt_falls_through_to_next_profile(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    claims: dict[str, object],
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token=_jwt(claims),
        expires_at=None,
    )
    _write_auth(
        nous_auth.GLOBAL_AUTH_FILE,
        token="legacy-safe-fallback",
        expires_at="2999-01-01T00:00:00Z",
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "legacy-safe-fallback"


def test_jwt_inside_expiry_safety_skew_falls_through(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    expires_in_30_seconds = datetime.now(timezone.utc).timestamp() + 30
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token=_jwt(
            {
                "exp": expires_in_30_seconds,
                "scope": "profile:read inference:invoke",
            }
        ),
        expires_at=None,
    )
    _write_auth(
        nous_auth.GLOBAL_AUTH_FILE,
        token="safe-after-skew",
        expires_at="2999-01-01T00:00:00Z",
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "safe-after-skew"


def test_out_of_range_jwt_exp_is_controlled_and_falls_through(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token=_jwt({"exp": 10**1000, "scope": "inference:invoke"}),
        expires_at=None,
    )
    _write_auth(
        nous_auth.GLOBAL_AUTH_FILE,
        token="safe-after-overflow",
        expires_at="2999-01-01T00:00:00Z",
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "safe-after-overflow"


def test_malformed_utf8_auth_file_is_skipped_without_500(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    nous_auth.DAEDALUS_PROFILE_AUTH.parent.mkdir(parents=True, exist_ok=True)
    nous_auth.DAEDALUS_PROFILE_AUTH.write_bytes(b"\xff\xfe\x00not-json")
    _write_auth(
        nous_auth.GLOBAL_AUTH_FILE,
        token="safe-after-unicode-error",
        expires_at="2999-01-01T00:00:00Z",
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "safe-after-unicode-error"


def test_malformed_utf8_jwt_payload_is_skipped_without_500(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    header = _b64url({"alg": "RS256", "typ": "JWT"})
    payload = base64.urlsafe_b64encode(b"\xff\xfe").rstrip(b"=").decode("ascii")
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token=f"{header}.{payload}.signature",
        expires_at=None,
    )
    _write_auth(
        nous_auth.GLOBAL_AUTH_FILE,
        token="safe-after-unicode-jwt",
        expires_at="2999-01-01T00:00:00Z",
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "safe-after-unicode-jwt"


def test_opaque_legacy_agent_key_remains_supported(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _point_at_temp_home(monkeypatch, tmp_path)
    _write_auth(
        nous_auth.DAEDALUS_PROFILE_AUTH,
        token="sk-opaque-hermes-agent-key",
        expires_at=None,
    )

    credential = nous_auth.load_nous_credential()

    assert credential.access_token == "sk-opaque-hermes-agent-key"
    assert credential.base_url == nous_auth.DEFAULT_INFERENCE_URL
