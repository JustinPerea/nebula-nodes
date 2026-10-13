"""services/launch_secrets.py: the desktop's provider keys and Krea vault key arrive on stdin."""
import io
import json
import os

import pytest
from cryptography.fernet import Fernet

from services import launch_secrets, settings


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    launch_secrets.reset_for_tests()
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    monkeypatch.delenv("NEBULA_CONNECTOR_ENCRYPTION_KEY", raising=False)
    yield
    launch_secrets.reset_for_tests()


def _line(payload) -> io.StringIO:
    return io.StringIO(json.dumps(payload) + "\n")


def test_without_the_flag_stdin_is_not_read(monkeypatch):
    monkeypatch.delenv(launch_secrets.STDIN_ENV, raising=False)
    stream = _line({"injectedKeys": {"FAL_KEY": "fal-x"}})
    launch_secrets.initialize(stdin=stream)
    assert stream.tell() == 0
    assert settings._INJECTED_KEYS == {}


def test_keys_and_vault_key_are_applied(monkeypatch):
    monkeypatch.setenv(launch_secrets.STDIN_ENV, "1")
    launch_secrets.initialize(stdin=_line({
        "injectedKeys": {"FAL_KEY": "fal-" + "stdin", "OPENAI_API_KEY": ""},
        "connectorEncryptionKey": "vault-fixture",
    }))
    assert settings._INJECTED_KEYS == {"FAL_KEY": "fal-stdin"}
    assert settings.is_injected_mode() is True
    assert launch_secrets.connector_encryption_key() == "vault-fixture"


def test_read_only_once(monkeypatch):
    monkeypatch.setenv(launch_secrets.STDIN_ENV, "1")
    launch_secrets.initialize(stdin=_line({"injectedKeys": {"FAL_KEY": "first"}}))
    launch_secrets.initialize(stdin=_line({"injectedKeys": {"FAL_KEY": "second"}}))
    assert settings._INJECTED_KEYS == {"FAL_KEY": "first"}


@pytest.mark.parametrize("raw", [
    "",                                  # EOF
    '{"injectedKeys": {"FAL_KEY": "x"}}',  # no newline
    "not json\n",
    "[1, 2]\n",
    '{"injectedKeys": {"FAL_KEY": 5}}\n',
    '{"connectorEncryptionKey": 7}\n',
])
def test_a_bad_line_fails_closed_without_logging_it(monkeypatch, caplog, raw):
    monkeypatch.setenv(launch_secrets.STDIN_ENV, "1")
    launch_secrets.initialize(stdin=io.StringIO(raw))
    assert settings._INJECTED_KEYS == {}
    assert launch_secrets.connector_encryption_key() is None
    assert "launch secrets unavailable" in caplog.text
    assert "FAL_KEY" not in caplog.text


def test_a_real_pipe_reads_exactly_one_line(monkeypatch):
    monkeypatch.setenv(launch_secrets.STDIN_ENV, "1")
    read_fd, write_fd = os.pipe()
    os.write(write_fd, (json.dumps({"injectedKeys": {"FAL_KEY": "pipe"}}) + "\nAFTER").encode())
    os.close(write_fd)
    with os.fdopen(read_fd, "rb", buffering=0) as stream:
        launch_secrets.initialize(stdin=stream)
        assert stream.read() == b"AFTER"
    assert settings._INJECTED_KEYS == {"FAL_KEY": "pipe"}


def test_the_desktop_krea_vault_opens_with_the_stdin_key(monkeypatch, tmp_path):
    from services.krea_connector import ConnectorError, Vault
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    with pytest.raises(ConnectorError):
        Vault(tmp_path / "before")
    monkeypatch.setenv(launch_secrets.STDIN_ENV, "1")
    launch_secrets.initialize(stdin=_line({"connectorEncryptionKey": Fernet.generate_key().decode()}))
    vault = Vault(tmp_path / "after")
    assert vault.read() is None
