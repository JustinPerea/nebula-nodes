"""gemini_cli_setup: the Gemini CLI's ACP flag and login, checked before Nebula starts it."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from services import gemini_cli_setup as g

OLD_HELP = """Usage: gemini [options]
      --experimental-acp          Starts the agent in ACP mode  [boolean]
      --allowed-mcp-server-names  Allowed MCP server names  [array]
"""
NEW_HELP = """Usage: gemini [options]
      --acp                       Starts the agent in ACP mode  [boolean]
      --experimental-acp          Starts the agent in ACP mode (deprecated, use --acp instead)  [boolean]
"""
NO_ACP_HELP = "Usage: gemini [options]\n  --prompt  Prompt  [string]\n"


def fake_gemini(tmp_path: Path, version: str, help_text: str, name: str = "gemini") -> Path:
    folder = tmp_path / f"bin-{version}-{abs(hash(help_text))}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "help.txt").write_text(help_text)
    script = folder / name
    script.write_text(f"""#!/bin/sh
case "$1" in
  --version) echo "{version}" ;;
  --help) cat "{folder / 'help.txt'}" ;;
  *) exit 3 ;;
esac
""")
    script.chmod(0o755)
    return script


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".gemini").mkdir(parents=True)
    # No real system settings file, whatever this machine has.
    monkeypatch.setenv("GEMINI_CLI_SYSTEM_SETTINGS_PATH", str(tmp_path / "no-system-settings.json"))
    g.clear_probe_cache()
    return home


def write_settings(home: Path, selected: str | None, extra: str = "") -> None:
    auth = f'"selectedType": "{selected}"' if selected else ""
    (home / ".gemini" / "settings.json").write_text(
        "{\n  // the CLI allows comments\n  \"security\": {\"auth\": {" + auth + "}}" + extra + "\n}\n")


def check(binary, home, tmp_path, *, use_key=False, key_saved=False, environ=None):
    return g.readiness(binary, home, use_nebula_key=use_key, nebula_key_saved=key_saved,
                       start_dir=tmp_path / "state", environ=environ or {}, dropped_env=frozenset({"GEMINI_API_KEY"}))


def test_probe_uses_the_flag_the_installed_cli_lists(tmp_path, home):
    old = g.probe(fake_gemini(tmp_path, "0.25.2", OLD_HELP))
    assert (old.version, old.acp_flag) == ("0.25.2", "--experimental-acp")
    new = g.probe(fake_gemini(tmp_path, "0.64.0", NEW_HELP))
    assert (new.version, new.acp_flag) == ("0.64.0", "--acp")
    none = g.probe(fake_gemini(tmp_path, "0.1.0", NO_ACP_HELP))
    assert none.ran and none.acp_flag is None


def test_no_acp_mode_is_not_ready_and_says_update(tmp_path, home):
    write_settings(home, "gemini-api-key")
    result = check(fake_gemini(tmp_path, "0.1.0", NO_ACP_HELP), home, tmp_path)
    assert not result.ready and "0.1.0" in result.note and "--acp" in result.note and "Update" in result.note


def test_a_google_account_login_without_a_project_can_not_work(tmp_path, home):
    write_settings(home, "oauth-personal")
    result = check(fake_gemini(tmp_path, "0.25.2", OLD_HELP), home, tmp_path)
    assert not result.ready and result.acp_flag == "--experimental-acp"
    for words in ("2026-06-18", "paid Gemini API key", "Code Assist Standard or Enterprise", "Google AI Pro/Ultra",
                  "Use my Gemini API key from Nebula"):
        assert words in result.note


def test_a_google_login_with_a_cloud_project_may_be_a_code_assist_license(tmp_path, home):
    write_settings(home, "oauth-personal")
    (home / ".gemini" / ".env").write_text("GOOGLE_CLOUD_PROJECT=my-project\n")
    result = check(fake_gemini(tmp_path, "0.25.2", OLD_HELP), home, tmp_path)
    assert result.ready and "Code Assist Standard or Enterprise" in result.note


@pytest.mark.parametrize("selected", ["compute-default-credentials", "cloud-shell"])
def test_a_machine_sign_in_never_says_google_cloud_credentials(tmp_path, home, selected):
    # GM r28 item 1 (PR #203): Google's own term stays out of every person line.
    write_settings(home, selected)
    result = check(fake_gemini(tmp_path, "0.64.0", NEW_HELP), home, tmp_path)
    assert result.ready and "credentials" not in result.note.lower()
    assert result.note.endswith("Uses the Google Cloud sign-in of the machine it runs on.")


def test_an_api_key_login_needs_a_key_nebula_can_see(tmp_path, home):
    binary = fake_gemini(tmp_path, "0.64.0", NEW_HELP)
    write_settings(home, "gemini-api-key")
    # A key the shell exported is dropped from the agent's environment, so it doesn't count.
    result = check(binary, home, tmp_path, environ={"GEMINI_API_KEY": "AIza-from-the-shell"})
    assert not result.ready and "~/.gemini/.env" in result.note
    (home / ".gemini" / ".env").write_text("# mine\nexport GEMINI_API_KEY=AIza-in-the-env-file\n")
    result = check(binary, home, tmp_path)
    assert result.ready and result.acp_flag == "--acp"
    assert "AIza" not in result.note


def test_env_files_are_ignored_when_folder_trust_is_on(tmp_path, home):
    write_settings(home, "gemini-api-key", ',\n  "security2": {}')
    settings = json.loads(g.strip_json_comments((home / ".gemini" / "settings.json").read_text()))
    settings["security"]["folderTrust"] = {"enabled": True}
    (home / ".gemini" / "settings.json").write_text(json.dumps(settings))
    (home / ".gemini" / ".env").write_text("GEMINI_API_KEY=AIza-in-the-env-file\n")
    assert not check(fake_gemini(tmp_path, "0.64.0", NEW_HELP), home, tmp_path).ready


def test_not_signed_in_at_all(tmp_path, home):
    result = check(fake_gemini(tmp_path, "0.64.0", NEW_HELP), home, tmp_path)
    assert not result.ready and "isn't signed in" in result.note


def test_the_nebula_key_choice(tmp_path, home):
    binary = fake_gemini(tmp_path, "0.25.2", OLD_HELP)
    write_settings(home, "oauth-personal")
    missing = check(binary, home, tmp_path, use_key=True, key_saved=False)
    assert not missing.ready and "Settings > API keys" in missing.note
    on = check(binary, home, tmp_path, use_key=True, key_saved=True)
    assert on.ready and on.auth == "gemini-api-key" and "bills" in on.note


def test_an_enforced_login_blocks_the_key_choice(tmp_path, home, monkeypatch):
    system = tmp_path / "system.json"
    system.write_text(json.dumps({"security": {"auth": {"enforcedType": "vertex-ai"}}}))
    monkeypatch.setenv("GEMINI_CLI_SYSTEM_SETTINGS_PATH", str(system))
    write_settings(home, "vertex-ai")
    binary = fake_gemini(tmp_path, "0.64.0", NEW_HELP)
    plain = check(binary, home, tmp_path, environ={"GEMINI_CLI_SYSTEM_SETTINGS_PATH": str(system)})
    assert plain.ready and plain.key_blocked and "vertex-ai" in plain.key_blocked
    keyed = check(binary, home, tmp_path, use_key=True, key_saved=True,
                  environ={"GEMINI_CLI_SYSTEM_SETTINGS_PATH": str(system)})
    assert not keyed.ready


def test_the_key_overlay_selects_api_key_login_and_keeps_system_settings(tmp_path, home, monkeypatch):
    system = tmp_path / "system.json"
    system.write_text('{ /* admin */ "general": {"disableAutoUpdate": true}, "security": {"auth": {}} }')
    path = g.write_key_overlay(tmp_path / "state", {"GEMINI_CLI_SYSTEM_SETTINGS_PATH": str(system)})
    data = json.loads(path.read_text())
    assert data["security"]["auth"]["selectedType"] == "gemini-api-key"
    assert data["general"] == {"disableAutoUpdate": True}
    assert (path.stat().st_mode & 0o777) == 0o600
    assert "AIza" not in path.read_text()
    # The person's own settings are never touched.
    assert not (home / ".gemini" / "settings.json").exists()


def test_strip_json_comments_keeps_strings():
    text = '{"url": "http://x//y", /* c */ "a": "/*not*/" // tail\n}'
    assert json.loads(g.strip_json_comments(text)) == {"url": "http://x//y", "a": "/*not*/"}


def test_a_failed_probe_is_not_kept(tmp_path, home):
    folder = tmp_path / "flaky"
    folder.mkdir()
    flag = folder / "help-works"
    script = folder / "gemini"
    script.write_text(f"""#!/bin/sh
case "$1" in
  --version) echo 0.25.2 ;;
  --help) [ -f "{flag}" ] || exit 1; echo "  --experimental-acp  ACP" ;;
esac
""")
    script.chmod(0o755)
    first = g.probe(script)
    assert not first.ran and first.acp_flag is None
    write_settings(home, "gemini-api-key")
    assert "--help" in check(script, home, tmp_path).note
    flag.write_text("")
    assert g.probe(script).acp_flag == "--experimental-acp"


def test_a_slow_cli_says_it_was_slow_and_is_asked_again(tmp_path, home, monkeypatch):
    # A cold start on a busy machine can take longer than the probe waits.
    monkeypatch.setattr(g, "PROBE_TIMEOUT_S", 0.5)
    folder = tmp_path / "slow"
    folder.mkdir()
    fast = folder / "fast"
    script = folder / "gemini"
    script.write_text(f"""#!/bin/sh
[ -f "{fast}" ] || sleep 3
case "$1" in
  --version) echo 0.64.0 ;;
  --help) echo "  --acp  ACP" ;;
esac
""")
    script.chmod(0o755)
    write_settings(home, "gemini-api-key")
    result = check(script, home, tmp_path)
    assert not result.ready and "too long" in result.note and "--help" not in result.note
    fast.write_text("")
    assert check(script, home, tmp_path).acp_flag == "--acp"


def test_version_and_help_run_side_by_side(tmp_path, home, monkeypatch):
    # Settings waits for this the first time, so the two answers don't queue.
    monkeypatch.setattr(g, "PROBE_TIMEOUT_S", 5)
    script = tmp_path / "gemini"
    script.write_text("""#!/bin/sh
sleep 1
case "$1" in
  --version) echo 0.64.0 ;;
  --help) echo "  --acp  ACP" ;;
esac
""")
    script.chmod(0o755)
    started = time.monotonic()
    assert g.probe(script).acp_flag == "--acp"
    assert time.monotonic() - started < 1.8


def test_a_probe_already_running_is_not_started_again(tmp_path, home, monkeypatch):
    """Settings polls every second while a download or sign-in runs, and each
    poll lists the agents. A slow probe (a cold node start can take over 30 s
    on a busy Mac) must not be started again on every poll, piling up node
    processes and worker threads; later looks say it's still checking."""
    import threading
    monkeypatch.setattr(g, "PROBE_TIMEOUT_S", 5)
    count = tmp_path / "count"
    script = tmp_path / "gemini"
    script.write_text(f"""#!/bin/sh
echo "$1" >> "{count}"
sleep 1.5
case "$1" in
  --version) echo 0.64.0 ;;
  --help) echo "  --acp  ACP" ;;
esac
""")
    script.chmod(0o755)
    results = []
    first = threading.Thread(target=lambda: results.append(g.probe(script)))
    first.start()
    time.sleep(0.4)
    started = time.monotonic()
    second = g.probe(script)
    waited = time.monotonic() - started
    write_settings(home, "gemini-api-key")
    note = check(script, home, tmp_path).note
    first.join()
    assert waited < 0.5 and not second.ran and second.checking
    assert "still checking" in note
    assert results[0].acp_flag == "--acp"
    assert sorted(count.read_text().split()) == ["--help", "--version"]  # one probe, not three
    assert g.probe(script).acp_flag == "--acp"
