#!/usr/bin/env python3
"""Check the pinned ACP adapters against npm under the 14-day package rule.

The pins live in services/personal_agents.py (the npx presets); this script
reads them from there and never keeps its own copy. For each adapter it asks
registry.npmjs.org for the package's versions and publish times, then reports:

- the pinned version, its publish date, and whether it is deprecated or gone;
- the newest stable release (no prerelease tag) that is newer than the pin,
  not deprecated, and published at least 14 days ago;
- the next newer stable release still inside the hold, and the date it clears.

Run it with no flags to print the report. In CI (.github/workflows/adapter-pins.yml):

    check_adapter_pins.py --report report.md --github-output "$GITHUB_OUTPUT"
    check_adapter_pins.py --file-issue report.md [--dry-run]

The first writes ``action_needed`` and ``fetch_failed`` (true/false) and exits 1
if any registry fetch failed. The second opens one issue, or updates the open
one with the same title, through the gh CLI; ``--dry-run`` prints the gh
commands instead. Nothing here changes a pin: a person bumps it by hand.
"""
from __future__ import annotations

import argparse
import json
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.personal_agents import PACKAGE_AGE_DAYS, PRESETS  # noqa: E402

REGISTRY = "https://registry.npmjs.org/"
ISSUE_TITLE = "ACP adapter updates past the 14-day hold"
SIGNATURE_RE = re.compile(r"<!-- adapter-pins: ([^>]*) -->")
SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
FETCH_TIMEOUT_S = 30.0


@dataclass(frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    prerelease: str | None
    text: str

    @property
    def stable(self) -> bool:
        return self.prerelease is None

    @property
    def key(self) -> tuple[int, int, int]:
        return (self.major, self.minor, self.patch)


def parse_version(text: Any) -> Version | None:
    if not isinstance(text, str):
        return None
    match = SEMVER_RE.match(text)
    if not match:
        return None
    major, minor, patch, pre = match.groups()
    return Version(int(major), int(minor), int(patch), pre, text)


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def adapter_pins() -> list[tuple[str, str]]:
    """(package, version) for every npx preset, read from its launch args."""
    pins = []
    for preset in PRESETS.values():
        if not preset.npx:
            continue
        for arg in preset.args:
            if arg.startswith("-"):
                continue
            name, sep, version = arg.rpartition("@")
            if sep and name and version:
                pins.append((name, version))
    return pins


@dataclass
class Release:
    version: str
    published: datetime


@dataclass
class AdapterReport:
    package: str
    pinned: str
    pinned_published: datetime | None = None
    pinned_missing: bool = False
    pinned_deprecated: str | None = None
    pinned_in_hold: bool = False
    candidate: Release | None = None
    next_pending: Release | None = None
    next_clears: datetime | None = None
    error: str | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def needs_action(self) -> bool:
        return bool(self.candidate or self.pinned_missing or self.pinned_deprecated)


def _deprecation(manifest: Any) -> str | None:
    if not isinstance(manifest, dict):
        return None
    message = manifest.get("deprecated")
    if message is None or message is False:
        return None
    text = message if isinstance(message, str) else "deprecated"
    # Registry text is untrusted: one line, no backticks, capped.
    text = " ".join(text.replace("`", "'").split())[:200]
    return text or "deprecated"


def evaluate(package: str, pinned: str, doc: Any, now: datetime,
             hold_days: int = PACKAGE_AGE_DAYS) -> AdapterReport:
    """Pure: compare one pin with a registry document as of ``now``."""
    report = AdapterReport(package, pinned)
    if not isinstance(doc, dict):
        report.error = "registry answer was not a JSON object"
        return report
    times = doc.get("time") if isinstance(doc.get("time"), dict) else {}
    versions = doc.get("versions") if isinstance(doc.get("versions"), dict) else {}
    cutoff = now - timedelta(days=hold_days)
    pin = parse_version(pinned)
    if pin is None:
        report.error = f"pinned version {pinned!r} is not plain semver"
        return report

    if pinned not in versions:
        report.pinned_missing = True
    else:
        report.pinned_deprecated = _deprecation(versions[pinned])
    report.pinned_published = _parse_time(times.get(pinned))
    if report.pinned_published and report.pinned_published > cutoff:
        report.pinned_in_hold = True

    newer: list[tuple[Version, datetime]] = []
    for text, manifest in versions.items():
        version = parse_version(text)
        published = _parse_time(times.get(text))
        if version is None or not version.stable or version.key <= pin.key:
            continue
        if published is None:
            report.notes.append(f"{version.text} has no publish time, skipped")
            continue
        if _deprecation(manifest):
            report.notes.append(f"{version.text} is deprecated, skipped")
            continue
        newer.append((version, published))

    cleared = [item for item in newer if item[1] <= cutoff]
    if cleared:
        best = max(cleared, key=lambda item: item[0].key)
        report.candidate = Release(best[0].text, best[1])
    floor = max(cleared, key=lambda item: item[0].key)[0].key if cleared else pin.key
    pending = [item for item in newer if item[1] > cutoff and item[0].key > floor]
    if pending:
        first = min(pending, key=lambda item: item[1])
        report.next_pending = Release(first[0].text, first[1])
        report.next_clears = first[1] + timedelta(days=hold_days)
    return report


def fetch_registry(package: str, timeout: float = FETCH_TIMEOUT_S) -> Any:
    url = REGISTRY + urllib.parse.quote(package, safe="@")
    request = urllib.request.Request(url, headers={"Accept": "application/json",
                                                   "User-Agent": "nebula-adapter-pin-check"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def check(now: datetime, fetch: Callable[[str], Any] = fetch_registry) -> list[AdapterReport]:
    reports = []
    for package, pinned in adapter_pins():
        try:
            doc = fetch(package)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            report = AdapterReport(package, pinned)
            report.error = f"could not fetch {package} from the registry: {type(exc).__name__}: {exc}"
            reports.append(report)
            continue
        reports.append(evaluate(package, pinned, doc, now))
    return reports


def _day(value: datetime | None) -> str:
    return value.strftime("%Y-%m-%d") if value else "unknown"


def signature(reports: Sequence[AdapterReport]) -> str:
    """A stable summary of what needs doing, so a changed finding can be told apart."""
    parts = []
    for report in reports:
        if not report.needs_action:
            continue
        state = report.candidate.version if report.candidate else "-"
        if report.pinned_missing:
            state += ",pin-missing"
        if report.pinned_deprecated:
            state += ",pin-deprecated"
        parts.append(f"{report.package}={state}")
    return ";".join(parts)


def render(reports: Sequence[AdapterReport], now: datetime, hold_days: int = PACKAGE_AGE_DAYS) -> str:
    cutoff = now - timedelta(days=hold_days)
    lines = [
        "# ACP adapter pins",
        "",
        f"Checked {now.strftime('%Y-%m-%d %H:%M UTC')} against registry.npmjs.org. "
        f"The {hold_days}-day rule allows releases published before {cutoff.strftime('%Y-%m-%d %H:%M UTC')}.",
        "",
        "| Adapter | Pinned | Newest allowed stable | Next newer release |",
        "| --- | --- | --- | --- |",
    ]
    for r in reports:
        if r.error:
            lines.append(f"| `{r.package}` | {r.pinned} | check failed | |")
            continue
        pinned = f"{r.pinned} ({_day(r.pinned_published)})"
        if r.pinned_missing:
            pinned += ", **not on the registry**"
        if r.pinned_deprecated:
            pinned += ", **deprecated**"
        allowed = f"**{r.candidate.version}** ({_day(r.candidate.published)})" if r.candidate else "none, pin is current"
        pending = (f"{r.next_pending.version} ({_day(r.next_pending.published)}), clears {_day(r.next_clears)}"
                   if r.next_pending else "none")
        lines.append(f"| `{r.package}` | {pinned} | {allowed} | {pending} |")
    bullets = []
    for r in reports:
        if r.error:
            bullets.append(f"- `{r.package}`: {r.error}")
        if r.pinned_deprecated:
            bullets.append(f"- `{r.package}@{r.pinned}` is deprecated: `{r.pinned_deprecated}`")
        if r.pinned_in_hold:
            bullets.append(f"- `{r.package}@{r.pinned}` was published inside the {hold_days}-day hold.")
        bullets += [f"- `{r.package}`: {note}" for note in r.notes]
    if bullets:
        lines += [""] + bullets
    if any(r.needs_action for r in reports):
        lines += [
            "",
            "To bump: change the pin in `backend/services/personal_agents.py` (and the dates in its docstring), "
            "run the ACP tests, then do one real turn with the adapter by hand. "
            "See \"Updating the adapter pins\" in docs/PERSONAL-AGENTS.md.",
        ]
    lines += ["", f"<!-- adapter-pins: {signature(reports)} -->", ""]
    return "\n".join(lines)


Runner = Callable[[list[str]], str]


def _run_gh(args: list[str]) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def file_issue(report_path: Path, run: Runner = _run_gh, dry_run: bool = False,
               out: Callable[[str], None] = print) -> str:
    """Open the issue, or update the open one with the exact title. Returns what it did."""
    body = report_path.read_text(encoding="utf-8")
    match = SIGNATURE_RE.search(body)
    new_sig = match.group(1) if match else ""
    listed = json.loads(run(["gh", "issue", "list", "--state", "open", "--limit", "500",
                             "--json", "number,title,body"]) or "[]")
    existing = next((item for item in listed if item.get("title") == ISSUE_TITLE), None)

    def act(args: list[str]) -> None:
        if dry_run:
            out("would run: " + shlex.join(args))
        else:
            run(args)

    if existing is None:
        act(["gh", "issue", "create", "--title", ISSUE_TITLE, "--body-file", str(report_path)])
        return "created"
    number = str(existing["number"])
    old = SIGNATURE_RE.search(existing.get("body") or "")
    act(["gh", "issue", "edit", number, "--body-file", str(report_path)])
    if (old.group(1) if old else None) == new_sig:
        return "refreshed"
    act(["gh", "issue", "comment", number, "--body",
         "The available versions changed since this issue was last updated. The description has the new report."])
    return "updated"


def _write_outputs(path: str, values: dict[str, str]) -> None:
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def main(argv: Sequence[str] | None = None, fetch: Callable[[str], Any] = fetch_registry) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--report", type=Path, help="also write the markdown report to this file")
    parser.add_argument("--github-output", help="append action_needed and fetch_failed to this file")
    parser.add_argument("--file-issue", type=Path, metavar="REPORT",
                        help="open or update the GitHub issue from a saved report (no registry fetch)")
    parser.add_argument("--dry-run", action="store_true", help="with --file-issue, print the gh commands")
    args = parser.parse_args(argv)

    if args.file_issue:
        result = file_issue(args.file_issue, dry_run=args.dry_run)
        print(f"issue {result}" + (" (dry run, nothing changed)" if args.dry_run else ""))
        return 0

    now = datetime.now(timezone.utc)
    reports = check(now, fetch)
    text = render(reports, now)
    sys.stdout.write(text)
    if args.report:
        args.report.write_text(text, encoding="utf-8")
    failed = any(r.error for r in reports)
    action = any(r.needs_action for r in reports)
    if args.github_output:
        _write_outputs(args.github_output, {"action_needed": str(action).lower(),
                                            "fetch_failed": str(failed).lower()})
    if failed:
        print("error: at least one adapter could not be checked", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
