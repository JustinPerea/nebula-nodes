"""Google's Antigravity ACP server as a personal agent: its pinned download and its sign-in.

"Antigravity (your setup)" runs ``agy_acp_server.par``, the ACP server Google
LLC publishes for editors (the ACP registry's ``antigravity-acp`` entry,
github.com/agentclientprotocol/registry, ``antigravity-acp/agent.json``; Zed
installs it from there). It is a binary, not an npm package, so Nebula
downloads it itself:

- **Pinned.** One exact version (``VERSION``), the archive URL from that
  registry entry on dl.google.com, and the SHA-256 of the archive and of each
  file in it, all below. Google publishes no checksum file, so the hashes were
  taken from the download on 2026-10-20 and checked against Google's code
  signature (both binaries are signed "Developer ID Application: Google LLC
  (EQHXZ8M8AV)", the same team as the ``agy`` CLI). Nothing is ever fetched by
  name or "latest", and nothing updates itself: a new version is a code change
  here, with new hashes.
- **The 14-day rule.** 1.4.1 was published 2026-10-17 (files dated
  2026-10-16), under 14 days old when pinned. The first-party exception
  applies: it is Google's own signed binary from Google's own domain, and the
  person already runs Google's ``agy`` and the Gemini API (Justin's go,
  2026-10-20).
- **Checked before it runs.** The archive is hashed while it downloads and
  refused, with nothing installed, if its size or hash is off. Only the two
  expected files are extracted, each hashed again, then moved into place in one
  rename. A marker records each file's hash, size, inode and mtime; a launch
  goes ahead only while the files still match it (a cheap stat, no re-hash),
  and anything else reads "changed, download again".
- **Where.** ``<state dir>/agent-binaries/antigravity-acp/<version>/``:
  Nebula's own data dir, about 400 MB unpacked. Removing it deletes the
  folder.

**Sign-in.** The server keeps its own Google login, separate from the
``agy`` CLI's: macOS Keychain service ``gemini``, account
``antigravity-acp`` (the CLI's is account ``antigravity``), so an ``agy``
login doesn't carry over. Its only sign-in is ACP ``authenticate`` with
``oauth-personal``, which opens Google's sign-in page in the person's browser
and waits up to 300 s for Google's redirect to a loopback port it opens.
Nebula calls it only when the person presses "Sign in with Google" in
Settings; the token goes from Google to Google's binary to the Keychain, and
Nebula never sees, reads or stores it. Nebula keeps one boolean,
``signedIn``, meaning "the person finished that sign-in here". After it,
every chat start calls ``authenticate`` again, which only refreshes the
stored login, with ``BROWSER`` set to a command that does nothing, so a start
can never pop a browser: if the stored login is gone, the call fails, and the
chat says to sign in again. "Sign out" calls the server's ACP ``logout``,
which deletes that Keychain login.

**Terms.** Using a Google AI plan through a third-party app this way is the
person's call and the person's risk: Antigravity's Additional Terms (item 6)
call third-party access to the Service a breach that can suspend or terminate
the Antigravity and/or Gemini CLI account, and the FAQ says wrapping Antigravity
in third-party apps "is not supported under consumer plans". Settings says so
on the agent.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import stat
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

logger = logging.getLogger(__name__)

AGENT_ID = "antigravity"
VERSION = "1.4.1"
PUBLISHED = "2026-10-17"
REGISTRY_URL = "https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json"
COMMAND = "agy_acp_server.par"
SIGNING_TEAM = "EQHXZ8M8AV"
AUTH_METHOD = "oauth-personal"
# Python's webbrowser runs $BROWSER when it has a space; /usr/bin/true succeeds
# without opening anything, so a chat start never shows a sign-in page.
NO_BROWSER = "/usr/bin/true %s"
MARKER = ".nebula-verified.json"
DOWNLOAD_TIMEOUT_S = 600.0
CHUNK = 1 << 20
SIGN_IN_TIMEOUT_S = 310.0
SIGN_OUT_TIMEOUT_S = 30.0
# As long as a chat session waits (personal_agents.STARTUP_TIMEOUT_S). The
# server answers initialize in about 2 s on a normal Mac, but it is a 280 MB
# program: in the 2026-10-20 live check, on a Mac at load 70 running it at
# background priority, the same start took 84 s.
START_TIMEOUT_S = 60.0
TERMS_NOTE = ("Uses your Google AI plan through Google's Antigravity ACP server. Google's FAQ says using Antigravity "
              "through third-party apps \"is not supported under consumer plans\", and its terms let Google suspend "
              "the Antigravity and Gemini CLI accounts that do it. Your Google account carries that risk.")
_GOOGLE_SIGN_IN = re.compile(r"https://accounts\.google\.com/[^\s\"'<>]+")


@dataclass(frozen=True)
class PinnedFile:
    name: str
    sha256: str
    size: int


@dataclass(frozen=True)
class Release:
    platform: str
    url: str
    sha256: str
    size: int
    files: tuple[PinnedFile, ...]


RELEASES: dict[str, Release] = {
    "darwin-aarch64": Release(
        "darwin-aarch64",
        "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-arm64.zip",
        "f9bdd68291ae78c38d2141e63bc86b84e6cc7b9f60f71652c68435a7943deb17", 112_737_434,
        (PinnedFile("agy_acp_server.par", "ee664236c317b38f33fb8d14188c5e32887bf493ab1372f1185cde126a3b130d",
                    280_996_576),
         PinnedFile("localharness_external", "b5b921d79c849806204901a24cb6a961bf2a689edd8a2e226401c96e368cfb6f",
                    120_246_928))),
    "darwin-x86_64": Release(
        "darwin-x86_64",
        "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-x86_64.zip",
        "27e31f096874704f14167b07ef9e84cc77134615ee41d024f7b1c957add85307", 118_349_036,
        (PinnedFile("agy_acp_server.par", "022ae66dd99e7a6ea17846641963942c72c00bce1c5a32a1ccb32ec889c5023d",
                    285_186_624),
         PinnedFile("localharness_external", "c6a2c260ca03899e8a3e4fe3279a2f9aa1d701a01721720db73d95ade9dfe511",
                    124_910_048))),
}


class AntigravityError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def platform_id(system: str | None = None, machine: str | None = None) -> str | None:
    """The registry's platform key for this Mac, or None where Nebula pins no build."""
    system = system or sys.platform
    machine = (machine or platform.machine() or "").lower()
    if system != "darwin":
        return None
    if machine in {"arm64", "aarch64"}:
        return "darwin-aarch64"
    if machine in {"x86_64", "amd64"}:
        return "darwin-x86_64"
    return None


def release(system: str | None = None, machine: str | None = None) -> Release | None:
    key = platform_id(system, machine)
    return RELEASES.get(key) if key else None


def root(state_dir: Path) -> Path:
    return Path(state_dir) / "agent-binaries" / "antigravity-acp"


def version_dir(state_dir: Path) -> Path:
    return root(state_dir) / VERSION


def _file_stamp(path: Path) -> dict[str, int]:
    info = path.stat()
    return {"size": info.st_size, "ino": info.st_ino, "mtimeNs": info.st_mtime_ns}


def _read_marker(folder: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((folder / MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def install_state(state_dir: Path) -> tuple[str, str]:
    """("unsupported" | "missing" | "changed" | "installed", a sentence)."""
    rel = release()
    if rel is None:
        return "unsupported", "Nebula has Google's Antigravity ACP server for macOS only (Apple silicon and Intel)."
    folder = version_dir(state_dir)
    if not folder.exists():
        return "missing", f"Download Google's Antigravity ACP server {VERSION} ({round(rel.size / 1_000_000)} MB) first."
    marker = _read_marker(folder)
    if not marker or marker.get("version") != VERSION or marker.get("archiveSha256") != rel.sha256:
        return "changed", "The downloaded Antigravity files don't match what Nebula checked. Remove and download again."
    files = marker.get("files") if isinstance(marker.get("files"), dict) else {}
    for pinned in rel.files:
        recorded = files.get(pinned.name)
        path = folder / pinned.name
        try:
            current = _file_stamp(path)
        except OSError:
            return "changed", "A downloaded Antigravity file is missing. Remove and download again."
        if not isinstance(recorded, dict) or recorded.get("sha256") != pinned.sha256 \
                or any(recorded.get(k) != v for k, v in current.items()) or not os.access(path, os.X_OK):
            return "changed", "A downloaded Antigravity file changed since Nebula checked it. Remove and download again."
    return "installed", f"Google's Antigravity ACP server {VERSION}, checked by SHA-256."


def installed_command(state_dir: Path) -> Path | None:
    state, _ = install_state(state_dir)
    return version_dir(state_dir) / COMMAND if state == "installed" else None


# -- jobs ---------------------------------------------------------------------------------


@dataclass
class Job:
    kind: str
    state: str = "running"   # running | done | failed | cancelled
    message: str = ""
    received: int = 0
    total: int = 0
    url: str | None = None   # the Google sign-in page, when the browser didn't open
    task: asyncio.Task | None = field(default=None, repr=False)
    proc: Any = field(default=None, repr=False)

    def view(self) -> dict[str, Any]:
        data: dict[str, Any] = {"state": self.state, "message": self.message}
        if self.kind == "install":
            data.update(receivedBytes=self.received, totalBytes=self.total)
        # Only while it runs: the link's loopback port closes with the server.
        if self.kind == "sign_in" and self.url and self.state == "running":
            data["signInUrl"] = self.url
        return data


_jobs: dict[tuple[str, str], Job] = {}
_STOPPED = {"install": "Download stopped.", "sign_in": "Sign-in stopped."}


def _job_key(state_dir: Path, kind: str) -> tuple[str, str]:
    return (str(Path(state_dir).resolve()), kind)


def job(state_dir: Path, kind: str) -> Job | None:
    return _jobs.get(_job_key(state_dir, kind))


def running(state_dir: Path, kind: str) -> bool:
    current = job(state_dir, kind)
    return current is not None and current.state == "running"


def _start(state_dir: Path, kind: str, work: Callable[[Job], Any]) -> Job:
    key = _job_key(state_dir, kind)
    current = _jobs.get(key)
    if current is not None and current.state == "running":
        return current
    new = Job(kind)
    _jobs[key] = new

    async def run() -> None:
        try:
            await work(new)
            if new.state == "running":
                new.state = "done"
        except asyncio.CancelledError:
            new.state = "cancelled"
            new.message = _STOPPED.get(kind, "Stopped.")
            raise
        except AntigravityError as exc:
            new.state, new.message = "failed", exc.message
        except Exception as exc:  # pragma: no cover - reported, never raised into the loop
            logger.warning("Antigravity %s failed", kind, exc_info=True)
            new.state, new.message = "failed", f"Something went wrong: {type(exc).__name__}."

    new.task = asyncio.create_task(run())
    return new


async def cancel(state_dir: Path, kind: str) -> bool:
    current = job(state_dir, kind)
    if current is None or current.state != "running" or current.task is None:
        return False
    current.task.cancel()
    try:
        await current.task
    except (asyncio.CancelledError, Exception):
        pass
    return True


# -- download -------------------------------------------------------------------------------


def _is_symlink_member(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK(info.external_attr >> 16)


def _extract_checked(archive: Path, dest: Path, rel: Release) -> dict[str, dict[str, Any]]:
    """Extract exactly the pinned files, each hashed against its pin."""
    expected = {pinned.name: pinned for pinned in rel.files}
    recorded: dict[str, dict[str, Any]] = {}
    with zipfile.ZipFile(archive) as bundle:
        members = [info for info in bundle.infolist() if not info.is_dir()]
        names = sorted(info.filename for info in members)
        if names != sorted(expected):
            raise AntigravityError("archive_unexpected", "The download held other files than expected; nothing was installed.")
        for info in members:
            pinned = expected[info.filename]
            if "/" in info.filename or "\\" in info.filename or _is_symlink_member(info):
                raise AntigravityError("archive_unexpected", "The download held an unsafe entry; nothing was installed.")
            if info.file_size != pinned.size:
                raise AntigravityError("checksum_mismatch", "A file in the download has the wrong size; nothing was installed.")
            target = dest / pinned.name
            digest = hashlib.sha256()
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o700)
            with bundle.open(info) as source, os.fdopen(fd, "wb") as out:
                while True:
                    chunk = source.read(CHUNK)
                    if not chunk:
                        break
                    digest.update(chunk)
                    out.write(chunk)
            if digest.hexdigest() != pinned.sha256:
                raise AntigravityError("checksum_mismatch", "A file in the download didn't match its SHA-256; nothing was installed.")
            os.chmod(target, 0o755)
            recorded[pinned.name] = {"sha256": pinned.sha256, **_file_stamp(target)}
    return recorded


async def _download(job_: Job, rel: Release, archive: Path, client_factory: Callable[[], Any]) -> None:
    digest = hashlib.sha256()
    job_.total = rel.size
    async with client_factory() as client:
        async with client.stream("GET", rel.url) as response:
            if response.status_code != 200:
                raise AntigravityError("download_failed", f"Google's download answered {response.status_code}.")
            fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as out:
                async for chunk in response.aiter_bytes(CHUNK):
                    job_.received += len(chunk)
                    if job_.received > rel.size:
                        raise AntigravityError("checksum_mismatch", "The download is bigger than the pinned file; nothing was installed.")
                    digest.update(chunk)
                    out.write(chunk)
    if job_.received != rel.size or digest.hexdigest() != rel.sha256:
        raise AntigravityError("checksum_mismatch", "The download didn't match its pinned SHA-256; nothing was installed.")


def _default_client() -> Any:
    import httpx
    return httpx.AsyncClient(timeout=httpx.Timeout(DOWNLOAD_TIMEOUT_S, connect=30.0), follow_redirects=True)


def start_install(state_dir: Path, *, client_factory: Callable[[], Any] | None = None) -> Job:
    rel = release()
    if rel is None:
        raise AntigravityError("unsupported", install_state(state_dir)[1])
    factory = client_factory or _default_client

    async def work(job_: Job) -> None:
        base = root(state_dir)
        base.mkdir(parents=True, exist_ok=True)
        os.chmod(base, 0o700)
        staging = base / f".download-{uuid4().hex}"
        staging.mkdir(mode=0o700)
        try:
            job_.message = "Downloading from dl.google.com…"
            archive = staging / "archive.zip"
            await _download(job_, rel, archive, factory)
            job_.message = "Checking the files…"
            unpacked = staging / VERSION
            unpacked.mkdir(mode=0o700)
            files = await asyncio.to_thread(_extract_checked, archive, unpacked, rel)
            marker = {"version": VERSION, "platform": rel.platform, "url": rel.url, "archiveSha256": rel.sha256,
                      "files": files}
            (unpacked / MARKER).write_text(json.dumps(marker, indent=2), encoding="utf-8")
            os.chmod(unpacked, 0o755)
            final = version_dir(state_dir)
            if final.exists():
                await asyncio.to_thread(shutil.rmtree, final)
            os.replace(unpacked, final)
            for other in base.iterdir():
                if other.is_dir() and other.name != VERSION and not other.name.startswith(".download-"):
                    await asyncio.to_thread(shutil.rmtree, other, True)
            job_.message = f"Installed {VERSION}; SHA-256 checked."
        finally:
            await asyncio.to_thread(shutil.rmtree, staging, True)

    return _start(state_dir, "install", work)


def remove(state_dir: Path) -> bool:
    folder = root(state_dir)
    if not folder.exists():
        return False
    shutil.rmtree(folder)
    return True


# -- sign-in and sign-out ---------------------------------------------------------------------


async def _open_server(state_dir: Path, *, browser: str | None) -> tuple[Any, Any, dict[str, Any]]:
    """Start the installed server and run ``initialize``; (proc, conn, init)."""
    from services.acp_client import AcpConnection, AcpError
    from services.acp_session import ACP_PROTOCOL_VERSION, CLIENT_CAPABILITIES, CLIENT_INFO, agent_base_env
    from services.agent_process import spawn_agent_process

    command = installed_command(state_dir)
    if command is None:
        raise AntigravityError("not_installed", install_state(state_dir)[1])
    env = agent_base_env(command)
    if browser is not None:
        env["BROWSER"] = browser
    work = root(state_dir)
    proc = await spawn_agent_process(str(command), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                     stderr=asyncio.subprocess.PIPE, env=env, cwd=str(work), limit=1 << 24)

    async def refuse(_method: str, _params: dict, _rid: Any) -> Any:
        raise AcpError(-32601, "Method not found")

    conn = AcpConnection(proc, on_notification=lambda _m, _p: None, on_request=refuse)
    conn.start()
    try:
        init = await conn.request("initialize", {"protocolVersion": ACP_PROTOCOL_VERSION,
                                                 "clientCapabilities": CLIENT_CAPABILITIES, "clientInfo": CLIENT_INFO},
                                  timeout=START_TIMEOUT_S)
    except asyncio.TimeoutError as exc:
        await _close_server(proc, conn)
        raise AntigravityError("start_timeout", f"Google's Antigravity server didn't start within "
                               f"{START_TIMEOUT_S:g} seconds. Try again.") from exc
    except BaseException:
        await _close_server(proc, conn)
        raise
    return proc, conn, init if isinstance(init, dict) else {}


async def _close_server(proc: Any, conn: Any) -> None:
    from services.acp_session import _kill_tree
    try:
        await asyncio.shield(_kill_tree(proc))
    finally:
        await conn.close()


def _offers(init: dict[str, Any], method_id: str) -> bool:
    methods = init.get("authMethods")
    return isinstance(methods, list) and any(isinstance(m, dict) and m.get("id") == method_id for m in methods)


async def _watch_for_sign_in_url(proc: Any, job_: Job) -> None:
    stream = getattr(proc, "stderr", None)
    if stream is None:
        return
    try:
        while True:
            line = await stream.readline()
            if not line:
                return
            match = _GOOGLE_SIGN_IN.search(line.decode("utf-8", errors="replace"))
            if match and job_.url is None:
                job_.url = match.group(0)[:4096]
    except (asyncio.CancelledError, Exception):
        return


def start_sign_in(state_dir: Path, on_signed_in: Callable[[bool], None]) -> Job:
    """Sign in with Google through Google's own server, which opens the browser."""
    from services.acp_client import AcpConnectionClosed, AcpError

    if installed_command(state_dir) is None:
        raise AntigravityError("not_installed", install_state(state_dir)[1])

    async def work(job_: Job) -> None:
        job_.message = "Starting Google's Antigravity server…"
        proc, conn, init = await _open_server(state_dir, browser=None)
        job_.proc = proc
        watcher = asyncio.create_task(_watch_for_sign_in_url(proc, job_))
        try:
            if not _offers(init, AUTH_METHOD):
                raise AntigravityError("sign_in_unavailable", "This Antigravity server doesn't offer Google sign-in.")
            job_.message = "Finish signing in with Google in your browser. Nebula waits up to 5 minutes."
            try:
                await conn.request("authenticate", {"methodId": AUTH_METHOD}, timeout=SIGN_IN_TIMEOUT_S)
            except asyncio.TimeoutError as exc:
                raise AntigravityError("sign_in_timeout", "Sign-in timed out. Try again.") from exc
            except AcpError as exc:
                raise AntigravityError("sign_in_failed", f"Google sign-in didn't finish: {exc.message[:200]}") from exc
            except AcpConnectionClosed as exc:
                raise AntigravityError("sign_in_failed", "Google's Antigravity server stopped during sign-in.") from exc
            on_signed_in(True)
            job_.url = None
            job_.message = "Signed in with Google."
        finally:
            watcher.cancel()
            await _close_server(proc, conn)

    return _start(state_dir, "sign_in", work)


async def sign_out(state_dir: Path, on_signed_in: Callable[[bool], None]) -> str:
    """Nebula stops using the login at once; Google's server deletes it if it can."""
    from services.acp_client import AcpConnectionClosed, AcpError

    await cancel(state_dir, "sign_in")
    on_signed_in(False)
    if installed_command(state_dir) is None:
        return "Signed out in Nebula. The server isn't downloaded, so its stored Google login (if any) stays."
    try:
        proc, conn, init = await _open_server(state_dir, browser=NO_BROWSER)
    except (AntigravityError, AcpError, AcpConnectionClosed, asyncio.TimeoutError, OSError):
        return "Signed out in Nebula, but Google's server didn't start, so its stored login stays."
    try:
        caps = init.get("agentCapabilities") if isinstance(init.get("agentCapabilities"), dict) else {}
        if not isinstance(caps.get("auth"), dict) or "logout" not in caps["auth"]:
            return "Signed out in Nebula. This server can't delete its stored Google login."
        try:
            await conn.request("logout", {}, timeout=SIGN_OUT_TIMEOUT_S)
        except (AcpError, AcpConnectionClosed, asyncio.TimeoutError):
            return "Signed out in Nebula, but Google's server couldn't delete its stored login."
        return "Signed out. Google's server deleted its stored Google login."
    finally:
        await _close_server(proc, conn)
