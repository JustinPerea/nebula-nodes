"""Read the board: one whole-board style report by Gemini 4 Argon.

Moodboard Studio's "Read the board", ``nebula moodboard read`` and the MCP
tool ``moodboard_read_board`` all come here. Every image on the board that
steers (not set aside, weight above 0, a Nebula file) goes to the model under
a name made from its tile id (``tile-<id>.<ext>``), with one fixed prompt
(``PROMPT``, the reference prompt verbatim apart from the file list). The
model's answer is Gemini's prose: Nebula keeps it as it came and only maps the
file names it cites back to the board's tiles (``cited_ids``), so each
citation renders as that tile's #N.

**Two routes, in this order** (``choose_route``):

- ``antigravity``: the person's own ``agy`` CLI, on their Google AI plan. Only
  when ``agy`` is installed *and* signed in (``detect_antigravity``, which
  never reads agy's credential files: it runs ``agy -p /usage`` in print mode,
  which agy answers "without starting an agent turn, spending quota, or
  leaving a conversation behind", and reads its exit code). Nebula never
  holds a Google token; agy keeps its own login.

  The run (``run_antigravity``): the images are *copied* into a fresh folder
  under Nebula's own temp root (0700, holding nothing else: ``images/`` and
  the copies), symlinks refused. agy runs with that folder as its cwd,
  ``--sandbox``, ``--mode plan`` (research only: the most restrictive mode
  agy has), ``--output-format json`` and an environment built from an
  allow-list (``agy_env``), so no Nebula variable, key, token or secret
  reaches it, and no ``GEMINI_API_KEY`` turns the run into a paid key run.
  The folder is fingerprinted before and after; any change (a file written,
  removed or touched) fails the read closed, whatever agy answered. The
  folder is deleted afterwards. Only the answer is kept: never agy's paths,
  its other output or anything about the person's account.
- ``gemini_key``: the person's Gemini API key, through the same Gemini path
  the gemini-chat node and the moodboard reader use
  (``moodboard_reader.GeminiTransport``), priced from the reader's model file
  (``data/moodboard_reader_models.json``, the list price Nebula already keeps
  for Argon; ``estimate_key_read``).

The result (``build_reading``) is saved on the board by the moodboard store
(``boardReading``), with the image-set fingerprint the staleness check
compares (``staleness``).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Sequence

from services import agent_binaries

MODEL_ID = "gemini-4-argon"          # data/moodboard_reader_models.json
AGY_MODEL = "gemini-4-argon-medium"  # agy's name for Argon at medium effort (the reference run)
AGY_MODE = "plan"
ROUTES = ("antigravity", "gemini_key")
ROUTE_CHOICES = ("auto", *ROUTES)
LEVEL = "medium"
# The answer allowance on the key route, on top of the thinking allowance.
ANSWER_TOKENS = 4096
# The low end of the key route's estimate: the reference answer was about 7k
# tokens with thinking on Antigravity, so a short one is about this.
ANSWER_TOKENS_LOW = 1500
PROMPT_TOKENS = 400

RUN_TIMEOUT_S = 300.0
STATUS_TIMEOUT_S = 20.0
STATUS_TTL_S = 60.0
STDOUT_CAP = 2 * 1024 * 1024
STDERR_CAP = 64 * 1024
MAX_ANSWER_CHARS = 60_000
MAX_IMAGES = 200
MAX_IMAGE_BYTES = 40 * 1024 * 1024
KEY_IMAGE_EDGE = 1024

EXTENSIONS = {".png": ".png", ".jpg": ".jpg", ".jpeg": ".jpg", ".webp": ".webp", ".gif": ".gif"}

# Everything agy may see of Nebula's environment: the names, nothing else.
# PATH is rebuilt (agy's own folder, then the system folders); HOME so agy
# finds its own login; the locale; the temp dir and the user; and proxies,
# so agy works on a network that needs one (the person's own setting).
ENV_ALLOW = ("HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
             "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy")
_ENV_REFUSED_WORDS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH")

# The reference prompt (~/Developer/brand/portable-agent/ui-brand-gemini-reading.md),
# verbatim apart from the file list. It is Gemini's input, not person-facing copy.
PROMPT = ("The folder images/ holds {count} {noun}: {files}. Look at every one of them (open each image file). "
          "Don't create or change any files. Analyze the visual style. What is it, what makes it distinctive, "
          "and why does it work? Write plain prose for a designer. Say which images you're drawing each point from.")

# Why a read failed. The Studio words each (GM's lines); anything else is the shared fallback.
CAUSES = ("timeout", "signed_out", "plan_limit", "key_refused", "write_attempt", "not_installed", "no_key",
          "no_images", "other")


class ReadFailure(Exception):
    """A read that gave no reading. ``cause`` is one of CAUSES; the message is
    for logs and agents, never agy's own output."""

    def __init__(self, cause: str, message: str = "") -> None:
        super().__init__(message or cause)
        self.cause = cause if cause in CAUSES else "other"


# -- the images ------------------------------------------------------------------------------------

@dataclass(frozen=True)
class SentImage:
    image_id: str
    number: int          # the board's own number: its place in `images` + 1
    url: str
    path: Path
    name: str            # tile-<id>.<ext>, the name the model cites

    def ref(self) -> dict[str, Any]:
        return {"imageId": self.image_id, "number": self.number, "file": self.name, "url": self.url}


def _safe_id(image_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "", image_id)[:64] or "image"


def citation_name(image_id: str, suffix: str) -> str:
    """``tile-<id>.<ext>``: the file name an image is sent under, so a
    citation maps to exactly one tile."""
    return f"tile-{_safe_id(image_id)}{EXTENSIONS.get(suffix.lower(), '.png')}"


def _lexical_source(url: str) -> Path | None:
    """The image's path as its URL names it, before any symlink is followed."""
    from services.output import DEFAULT_OUTPUT_ROOT, OUTPUT_ROOT

    raw = str(url or "").strip()
    if raw.startswith("http://") or raw.startswith("https://"):
        from urllib.parse import urlparse
        raw = urlparse(raw).path
    if raw.startswith("/api/outputs/"):
        rel = raw[len("/api/outputs/"):].lstrip("/")
        for root in dict.fromkeys((OUTPUT_ROOT, DEFAULT_OUTPUT_ROOT)):
            candidate = Path(os.path.normpath(Path(root).resolve() / rel))
            if os.path.lexists(candidate):
                return candidate
        return None
    candidate = Path(raw).expanduser()
    return Path(os.path.normpath(candidate)) if candidate.is_absolute() else None


def source_path(url: str, resolve: Callable[[str], Path | None] | None = None) -> Path | None:
    """The file to copy for a board image, or None when Nebula doesn't read
    it (an outside link, a protected or missing file) or a symlink is
    anywhere in its path below the output root."""
    if resolve is None:
        from services.moodboard_analysis import resolve_moodboard_image_path as resolve
    resolved = resolve(url)
    if resolved is None:
        return None
    lexical = _lexical_source(url)
    if lexical is None or Path(os.path.realpath(lexical)) != Path(resolved) or lexical.is_symlink():
        return None
    return lexical


def sendable_images(board: Mapping[str, Any], resolve: Callable[[str], Path | None] | None = None,
                    ) -> list[SentImage]:
    """The images a read sends, in board order: every image that steers (not
    set aside, weight above 0) and is a file Nebula reads."""
    from services.moodboard_analysis import steers

    out: list[SentImage] = []
    used: set[str] = set()
    for index, image in enumerate(board.get("images") or []):
        if not isinstance(image, dict) or not steers(image):
            continue
        path = source_path(str(image.get("url") or ""), resolve)
        if path is None:
            continue
        image_id = str(image.get("id") or "")
        name = citation_name(image_id, path.suffix)
        stem, ext = os.path.splitext(name)
        n = 2
        while name in used:
            name = f"{stem}-{n}{ext}"
            n += 1
        used.add(name)
        out.append(SentImage(image_id, index + 1, str(image.get("url") or ""), path, name))
        if len(out) >= MAX_IMAGES:
            break
    return out


def prompt(names: Sequence[str]) -> str:
    count = len(names)
    return PROMPT.format(count=count, noun="screenshot" if count == 1 else "screenshots", files=", ".join(names))


# -- hashing, fingerprints and staleness --------------------------------------------------------

_HASHES: dict[tuple[str, int, int], str] = {}


def file_hash(path: Path) -> str | None:
    """SHA-256 of a file's bytes, cached by (path, size, mtime)."""
    try:
        info = path.stat()
    except OSError:
        return None
    key = (str(path), info.st_size, info.st_mtime_ns)
    if key in _HASHES:
        return _HASHES[key]
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
    except OSError:
        return None
    if len(_HASHES) > 4096:
        _HASHES.clear()
    _HASHES[key] = digest.hexdigest()
    return _HASHES[key]


def fingerprint(entries: Sequence[Mapping[str, Any]]) -> str:
    """The image set: tile ids with each file's content hash, in any order."""
    lines = sorted(f"{entry['id']}:{entry.get('hash') or ''}" for entry in entries)
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def image_set(images: Sequence[SentImage], hashes: Mapping[str, str | None] | None = None) -> dict[str, Any]:
    entries = []
    for image in images:
        digest = (hashes or {}).get(image.image_id) if hashes is not None else file_hash(image.path)
        entries.append({"id": image.image_id, "hash": digest, "url": image.url})
    return {"fingerprint": fingerprint(entries), "images": entries}


def staleness(reading: Mapping[str, Any] | None, board: Mapping[str, Any],
              resolve: Callable[[str], Path | None] | None = None) -> dict[str, Any] | None:
    """How the board's image set moved since ``reading`` ran: image ids
    ``added``, ``removed`` (off the board), ``setAside`` (still on it, no
    longer sent) and ``replaced`` (same tile, other bytes). None when there
    is no reading. Notes and Direction aren't in the prompt, so they never
    make a reading stale."""
    if not isinstance(reading, Mapping):
        return None
    sent = (reading.get("imageSet") or {}).get("images") or []
    then = {str(entry.get("id")): entry for entry in sent if isinstance(entry, Mapping)}
    now_images = sendable_images(board, resolve)
    now = image_set(now_images)
    on_board = {str(img.get("id")) for img in board.get("images") or [] if isinstance(img, dict)}
    now_ids = {entry["id"]: entry for entry in now["images"]}
    added = [image_id for image_id in now_ids if image_id not in then]
    removed = [image_id for image_id in then if image_id not in now_ids and image_id not in on_board]
    set_aside = [image_id for image_id in then if image_id not in now_ids and image_id in on_board]
    replaced = [image_id for image_id, entry in now_ids.items()
                if image_id in then and (entry.get("hash") != then[image_id].get("hash")
                                         or entry.get("url") != then[image_id].get("url"))]
    stale = now["fingerprint"] != (reading.get("imageSet") or {}).get("fingerprint")
    return {"stale": bool(stale or added or removed or set_aside or replaced), "added": added,
            "removed": removed, "setAside": set_aside, "replaced": replaced}


# -- citations ---------------------------------------------------------------------------------

_CITATION = re.compile(r"tile-[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif)", re.IGNORECASE)


def cited_ids(markdown: str, citations: Sequence[Mapping[str, Any]]) -> list[str]:
    """The tile ids ``markdown`` cites, in first-cited order. A name that
    isn't one the read sent stays plain text and maps to nothing."""
    by_name = {str(entry["file"]).lower(): str(entry["imageId"]) for entry in citations}
    out: list[str] = []
    for match in _CITATION.finditer(markdown or ""):
        image_id = by_name.get(match.group(0).lower())
        if image_id and image_id not in out:
            out.append(image_id)
    return out


def numbered_markdown(reading: Mapping[str, Any], board: Mapping[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """The reading as agents and Copy get it: each cited file name as ``#N``
    (the tile's number on the board now; a tile no longer on the board keeps
    the number it had, marked removed), plus the tile map."""
    images = [img for img in board.get("images") or [] if isinstance(img, dict)]
    number_now = {str(img.get("id")): index + 1 for index, img in enumerate(images)}
    tiles: list[dict[str, Any]] = []
    by_name: dict[str, str] = {}
    for entry in reading.get("citations") or []:
        image_id = str(entry.get("imageId"))
        on_board = image_id in number_now
        number = number_now.get(image_id, int(entry.get("number") or 0))
        label = f"#{number}" if on_board else f"#{number} (removed from the board)"
        by_name[str(entry.get("file")).lower()] = label
        tiles.append({"number": number, "imageId": image_id, "file": entry.get("file"), "onBoard": on_board,
                      "numberWhenRead": entry.get("number"),
                      "cited": image_id in (reading.get("cited") or [])})

    text = re.sub(r"`?(?:images/)?(" + _CITATION.pattern + r")`?",
                  lambda m: by_name.get(m.group(1).lower(), m.group(0)), str(reading.get("markdown") or ""),
                  flags=re.IGNORECASE)
    return text, tiles


# -- routes ------------------------------------------------------------------------------------

def agy_env(source: Mapping[str, str] | None = None, agy_path: Path | None = None) -> dict[str, str]:
    """agy's environment: only ENV_ALLOW, never a NEBULA_* name or anything
    that names a key, token, secret, password or credential, and PATH
    rebuilt from agy's own folder and the system folders."""
    source = os.environ if source is None else source
    env: dict[str, str] = {}
    for name in ENV_ALLOW:
        value = source.get(name)
        if value is None or name.upper().startswith("NEBULA") or any(w in name.upper() for w in _ENV_REFUSED_WORDS):
            continue
        env[name] = value
    folders = [str(agy_path.parent)] if agy_path is not None else []
    env["PATH"] = os.pathsep.join(dict.fromkeys([*folders, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]))
    env["NO_COLOR"] = "1"
    return env


def find_agy() -> Path | None:
    return agent_binaries.resolve("agy")


_STATUS: dict[str, tuple[float, dict[str, Any]]] = {}


def forget_status() -> None:
    _STATUS.clear()


def detect_antigravity(*, temp_root: Path, find: Callable[[], Path | None] | None = None,
                       run: Callable[..., Any] = subprocess.run, clock: Callable[[], float] = time.monotonic,
                       ttl: float = STATUS_TTL_S) -> dict[str, Any]:
    """``{installed, signedIn}`` for the person's agy. Installed: an ``agy``
    executable is found (agent_binaries.resolve). Signed in: ``agy -p /usage
    --output-format json`` exits 0 with JSON on stdout. agy answers it
    without an agent turn or quota, and a signed-out agy exits non-zero.
    Nebula never reads agy's credential files. Cached for ``ttl`` seconds."""
    path = (find or find_agy)()  # looked up per call, so a stand-in replaces it everywhere
    if path is None:
        return {"installed": False, "signedIn": False}
    cached = _STATUS.get(str(path))
    if cached and clock() - cached[0] < ttl:
        return dict(cached[1])
    signed_in = False
    folder = _fresh_folder(temp_root)
    try:
        result = run([str(path), "--output-format", "json", "-p", "/usage"], cwd=str(folder),
                     env=agy_env(agy_path=path), stdin=subprocess.DEVNULL, capture_output=True,
                     timeout=STATUS_TIMEOUT_S)
        if result.returncode == 0:
            try:
                json.loads((result.stdout or b"").decode("utf-8", "replace") if isinstance(result.stdout, bytes)
                           else (result.stdout or ""))
                signed_in = True
            except ValueError:
                signed_in = False
    except (OSError, subprocess.SubprocessError):
        signed_in = False
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    status = {"installed": True, "signedIn": signed_in}
    _STATUS[str(path)] = (clock(), status)
    return dict(status)


def choose_route(antigravity: Mapping[str, Any], has_key: bool, wanted: str = "auto") -> str | None:
    """Antigravity first when installed and signed in, then the key; None
    when neither can read. ``wanted`` names one route and gets it only when
    that route can run."""
    if wanted not in ROUTE_CHOICES:
        raise ValueError(f"route must be one of {', '.join(ROUTE_CHOICES)}")
    agy_ready = bool(antigravity.get("installed")) and bool(antigravity.get("signedIn"))
    if wanted == "antigravity":
        return "antigravity" if agy_ready else None
    if wanted == "gemini_key":
        return "gemini_key" if has_key else None
    if agy_ready:
        return "antigravity"
    return "gemini_key" if has_key else None


# -- the sandbox folder -------------------------------------------------------------------------

def _fresh_folder(temp_root: Path) -> Path:
    """A new 0700 folder under Nebula's own temp root (itself 0700)."""
    temp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(temp_root, 0o700)
    return Path(tempfile.mkdtemp(prefix="read-", dir=temp_root))


def _copy_no_follow(source: Path, dest: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(source, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ReadFailure("other", "a board image isn't a regular file")
        if info.st_size > MAX_IMAGE_BYTES:
            raise ReadFailure("other", "a board image is too large to send")
        out = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            while True:
                chunk = os.read(fd, 1 << 20)
                if not chunk:
                    break
                os.write(out, chunk)
        finally:
            os.close(out)
    finally:
        os.close(fd)


def prepare_folder(temp_root: Path, images: Sequence[SentImage]) -> Path:
    """A fresh folder holding ``images/`` and copies of the images, nothing
    else. A symlink anywhere is refused."""
    folder = _fresh_folder(temp_root)
    try:
        (folder / "images").mkdir(mode=0o700)
        for image in images:
            if image.path.is_symlink():
                raise ReadFailure("other", "a board image is a symlink")
            try:
                _copy_no_follow(image.path, folder / "images" / image.name)
            except OSError as exc:
                raise ReadFailure("other", f"couldn't copy a board image ({exc.__class__.__name__})") from exc
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return folder


def snapshot(folder: Path) -> dict[str, tuple[Any, ...]]:
    """Every entry under ``folder``: type, size, mtime, mode and, for files,
    a hash. Compared before and after a run."""
    out: dict[str, tuple[Any, ...]] = {}
    for root, dirs, files in os.walk(folder, followlinks=False):
        for name in [*dirs, *files]:
            path = Path(root) / name
            rel = str(path.relative_to(folder))
            try:
                info = os.lstat(path)
            except OSError:
                out[rel] = ("gone",)
                continue
            if stat.S_ISREG(info.st_mode):
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                out[rel] = ("file", info.st_size, info.st_mtime_ns, info.st_mode, digest)
            else:
                out[rel] = ("other", stat.S_IFMT(info.st_mode), info.st_mtime_ns, info.st_mode)
    try:
        top = os.lstat(folder)
        out["."] = ("dir", top.st_mode)
    except OSError:
        out["."] = ("gone",)
    return out


# -- the Antigravity run ------------------------------------------------------------------------

_SIGNED_OUT = re.compile(r"not signed in|sign in|signed out|log ?in again|authenticat|unauthenticated|"
                         r"logged out|credentials", re.IGNORECASE)
_PLAN_LIMIT = re.compile(r"quota|resource[_ ]exhausted|credits balance|rate.?limit|usage limit|"
                         r"reached (?:your|the) limit|too many requests|\b429\b", re.IGNORECASE)


def classify_agy_failure(stderr: str, returncode: int | None) -> str:
    """The cause behind a failed agy run, from its ``AGY_ERROR: {...}`` line
    (agy prints one on stderr for an agent or model failure, exit 3) or its
    message. Only the cause is kept, never the text."""
    error_line = next((line for line in stderr.splitlines() if line.startswith("AGY_ERROR:")), "")
    text = error_line or stderr
    if error_line:
        try:
            data = json.loads(error_line.removeprefix("AGY_ERROR:").strip())
            text = json.dumps(data)
        except ValueError:
            pass
    if _SIGNED_OUT.search(text):
        return "signed_out"
    if _PLAN_LIMIT.search(text):
        return "plan_limit"
    return "other"


def parse_agy_answer(stdout: str) -> str:
    """The answer from ``--output-format json``: one JSON object whose
    ``result`` (or ``response``/``text``) is the answer. A ``finished_reason``
    means the turn ended early (``print_timeout``: the answer is partial)."""
    try:
        data = json.loads(stdout)
    except ValueError as exc:
        raise ReadFailure("other", "agy's answer wasn't JSON") from exc
    if not isinstance(data, dict):
        raise ReadFailure("other", "agy's answer wasn't a JSON object")
    reason = data.get("finished_reason")
    if reason:
        raise ReadFailure("timeout" if reason == "print_timeout" else "other", f"agy stopped early ({reason})")
    answer = next((data[key] for key in ("result", "response", "text") if isinstance(data.get(key), str)), None)
    if data.get("is_error") is True:
        raise ReadFailure(classify_agy_failure(str(answer or ""), None), "agy reported an error")
    if not answer or not answer.strip():
        raise ReadFailure("other", "agy gave no answer")
    if len(answer) > MAX_ANSWER_CHARS:
        raise ReadFailure("other", "the answer was too long")
    return answer.strip()


async def _read_capped(stream: asyncio.StreamReader, cap: int, keep_tail: bool,
                       on_over: Callable[[], None] | None = None) -> tuple[bytes, bool]:
    """Read a pipe to its end, keeping at most ``cap`` bytes (the head, or
    the tail). Past the cap ``on_over`` runs once (it stops agy) and the
    rest is drained and dropped, so the pipe closes and the process can be
    reaped."""
    buffer = bytearray()
    over = False
    while True:
        chunk = await stream.read(1 << 16)
        if not chunk:
            break
        if over and not keep_tail:
            continue
        buffer.extend(chunk)
        if len(buffer) > cap:
            if keep_tail:
                del buffer[:len(buffer) - cap]
            else:
                del buffer[cap:]
            if not over:
                over = True
                if on_over is not None:
                    on_over()
    return bytes(buffer), over


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return


async def run_antigravity(images: Sequence[SentImage], *, agy: Path, temp_root: Path,
                          timeout: float = RUN_TIMEOUT_S, env: Mapping[str, str] | None = None) -> str:
    """One read on agy, in a sandbox folder of image copies. The answer, or
    ReadFailure. The folder is gone when this returns, however it returns."""
    folder = prepare_folder(temp_root, images)
    try:
        before = snapshot(folder)
        argv = [str(agy), "--model", AGY_MODEL, "--mode", AGY_MODE, "--sandbox", "--output-format", "json",
                "-p", prompt([image.name for image in images])]
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=str(folder), env=dict(env) if env is not None else agy_env(agy_path=agy),
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True)
        assert proc.stdout is not None and proc.stderr is not None
        out_task = asyncio.ensure_future(_read_capped(proc.stdout, STDOUT_CAP, keep_tail=False,
                                                      on_over=lambda: _kill_group(proc)))
        err_task = asyncio.ensure_future(_read_capped(proc.stderr, STDERR_CAP, keep_tail=True))
        timed_out = False
        try:
            (stdout, too_much), (stderr, _) = await asyncio.wait_for(asyncio.gather(out_task, err_task), timeout)
            await asyncio.wait_for(proc.wait(), 10)
        except asyncio.TimeoutError:
            timed_out = True
            _kill_group(proc)
            await asyncio.gather(out_task, err_task, return_exceptions=True)  # the pipes close once agy is gone
            await asyncio.wait_for(proc.wait(), 10)
            stdout, too_much, stderr = b"", False, b""
        except BaseException:  # Stop (cancelled) or anything else: agy goes too
            _kill_group(proc)
            out_task.cancel()
            err_task.cancel()
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except BaseException:  # noqa: BLE001
                pass
            raise
        after = snapshot(folder)
        if after != before:
            raise ReadFailure("write_attempt", "agy changed the sandbox folder")
        if timed_out:
            raise ReadFailure("timeout", "agy didn't answer in time")
        if too_much:
            raise ReadFailure("other", "the answer was too long")
        err_text = stderr.decode("utf-8", "replace")
        if proc.returncode != 0:
            raise ReadFailure(classify_agy_failure(err_text, proc.returncode), f"agy exited {proc.returncode}")
        return parse_agy_answer(stdout.decode("utf-8", "replace"))
    finally:
        shutil.rmtree(folder, ignore_errors=True)


# -- the Gemini API key run ---------------------------------------------------------------------

def reader_entry() -> dict[str, Any]:
    from services import moodboard_reader as reader
    return reader.reader_entry(MODEL_ID)


def key_cap(entry: Mapping[str, Any]) -> int:
    return int(entry["thinking"][LEVEL]["thinkingTokens"]) + ANSWER_TOKENS


def estimate_key_read(count: int, entry: Mapping[str, Any] | None = None, today: date | None = None
                      ) -> dict[str, Any]:
    """The key route's list price for ``count`` images: input is each
    image's tokens plus the prompt; output is up to the request's cap (the
    high end) or a short answer with its thinking (the low end). From the
    reader's model file, which keeps Argon's list price."""
    from services import moodboard_reader as reader

    entry = entry or reader_entry()
    row = reader.price_row(entry, today or date.today())
    tokens_in = count * int(entry["imageTokens"]) + PROMPT_TOKENS
    cap = key_cap(entry)
    low_out = int(entry["thinking"][LEVEL]["thinkingTokens"]) // 2 + ANSWER_TOKENS_LOW
    if row is None:
        return {"count": count, "low": None, "high": None, "unpriced": True, "unconfirmed": True,
                "model": MODEL_ID, "name": entry["name"]}
    usd = lambda tin, tout: tin / 1e6 * float(row["inputPerMTok"]) + tout / 1e6 * float(row["outputPerMTok"])
    return {"count": count, "low": round(usd(tokens_in, low_out), 6), "high": round(usd(tokens_in, cap), 6),
            "unpriced": False, "unconfirmed": bool(entry.get("unconfirmed")) or bool(row.get("unconfirmed")),
            "model": MODEL_ID, "name": entry["name"], "sources": list(entry.get("sources") or []),
            "checked": entry.get("checked")}


def _encode(path: Path) -> tuple[str, str]:
    from services import moodboard_reader as reader
    return reader.encode_image(path)


def key_body(entry: Mapping[str, Any], images: Sequence[SentImage],
             encode: Callable[[Path], tuple[str, str]] = _encode) -> dict[str, Any]:
    """The prompt, then each image under its file name, as one Gemini request."""
    from services import moodboard_reader as reader

    parts: list[dict[str, Any]] = [{"text": prompt([image.name for image in images])}]
    for image in images:
        mime, data = encode(image.path)
        parts.append({"text": f"images/{image.name}"})
        parts.append({"inline_data": {"mime_type": mime, "data": data}})
    body = reader.gemini_body(entry, parts=parts, schema=None, level=LEVEL, max_output_tokens=key_cap(entry))
    body.pop("systemInstruction", None)  # the prompt is the whole instruction, as on Antigravity
    return body


async def run_gemini_key(images: Sequence[SentImage], *, api_key: str, client: Any = None,
                         entry: Mapping[str, Any] | None = None) -> str:
    from services import moodboard_reader as reader

    entry = entry or reader_entry()
    body = await asyncio.to_thread(key_body, entry, images)
    transport = reader.GeminiTransport(entry, api_key, client=client)
    result = await reader.call_text(transport, body, reader.TimeBounds.of(entry, LEVEL))
    error = result.error
    if error is not None:
        detail = f"{error.text} {error.detail}"
        if error.status in (401, 403) or (error.status == 400 and re.search(r"API[_ ]key", detail, re.I)):
            raise ReadFailure("key_refused", "Google refused the key")
        if error.kind in ("timeout", "timeout-total"):
            raise ReadFailure("timeout", error.text)
        if error.status == 429:
            raise ReadFailure("other", "Google is rate-limiting this key")
        raise ReadFailure("other", error.text)
    answer = (result.text or "").strip()
    if not answer:
        raise ReadFailure("other", "Gemini gave no answer")
    if len(answer) > MAX_ANSWER_CHARS:
        raise ReadFailure("other", "the answer was too long")
    return answer


# -- the reading ---------------------------------------------------------------------------------

def new_reading_id() -> str:
    return "rd_" + secrets.token_hex(6)


def build_reading(markdown: str, images: Sequence[SentImage], *, route: str, by: Mapping[str, Any],
                  hashes: Mapping[str, str | None] | None = None, cost: Mapping[str, Any] | None = None,
                  entry: Mapping[str, Any] | None = None, now: datetime | None = None) -> dict[str, Any]:
    """What the board keeps: the markdown as the model wrote it, the model,
    the route, the time, who asked, the image-set fingerprint, every image
    sent (``citations``: tile id, number then, file name) and the tile ids
    the markdown cites."""
    entry = entry or reader_entry()
    citations = [{"imageId": image.image_id, "number": image.number, "file": image.name} for image in images]
    return {
        "id": new_reading_id(),
        "markdown": markdown,
        "model": MODEL_ID,
        "modelName": str(entry["name"]),
        "route": route,
        "at": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "by": dict(by),
        "imageSet": image_set(images, hashes),
        "citations": citations,
        "cited": cited_ids(markdown, citations),
        **({"cost": dict(cost)} if cost else {}),
    }


def check_reading(value: Any) -> dict[str, Any]:
    """A reading as the store saves it (the shape build_reading makes)."""
    if not isinstance(value, dict):
        raise ValueError("a board reading must be an object")
    for key in ("id", "markdown", "model", "route", "at", "imageSet", "citations", "cited"):
        if key not in value:
            raise ValueError(f"a board reading needs {key}")
    if value["route"] not in ROUTES:
        raise ValueError("a board reading's route is antigravity or gemini_key")
    if not isinstance(value["markdown"], str) or len(value["markdown"]) > MAX_ANSWER_CHARS:
        raise ValueError("a board reading's markdown is a string up to 60,000 characters")
    return value


# -- runs (one per board at a time) -----------------------------------------------------------------

@dataclass
class Run:
    board_id: str
    route: str
    count: int
    by: dict[str, Any]
    started: float
    task: asyncio.Task[Any] | None = None
    status: str = "running"            # running | done | failed | stopped
    cause: str | None = None
    reading_id: str | None = None
    finished: float | None = None
    agent: Any = None                  # the asking agent's identity, for the Agent log
    on_end: Callable[["Run"], Awaitable[None]] | None = field(default=None, repr=False)
    ended: bool = False
    run_id: str = field(default_factory=lambda: "rr_" + secrets.token_hex(4))

    def view(self, now: float | None = None) -> dict[str, Any]:
        now = time.time() if now is None else now
        return {"id": self.run_id, "boardId": self.board_id, "status": self.status, "route": self.route,
                "count": self.count, "by": self.by, "startedAt": int(self.started * 1000),
                "elapsedMs": int(((self.finished or now) - self.started) * 1000),
                "cause": self.cause, "readingId": self.reading_id}


class Runs:
    """The board reads under way and the last outcome per board (memory only)."""

    def __init__(self) -> None:
        self._runs: dict[str, Run] = {}

    def get(self, board_id: str) -> Run | None:
        return self._runs.get(board_id)

    def running(self, board_id: str) -> Run | None:
        run = self._runs.get(board_id)
        return run if run is not None and run.status == "running" else None

    def start(self, run: Run, work: Callable[[Run], Awaitable[None]],
              on_end: Callable[[Run], Awaitable[None]] | None = None) -> Run:
        """Run ``work`` in the background; ``on_end`` follows whatever the
        outcome (done, failed or stopped), for the broadcast."""
        if self.running(run.board_id) is not None:
            raise RuntimeError("a read is already running on this board")
        self._runs[run.board_id] = run
        run.on_end = on_end

        async def go() -> None:
            try:
                await work(run)
                if run.status == "running":
                    run.status, run.finished = "done", time.time()
            except asyncio.CancelledError:
                run.status, run.finished = "stopped", time.time()
            except ReadFailure as exc:
                run.status, run.cause, run.finished = "failed", exc.cause, time.time()
            except Exception:  # noqa: BLE001 - any other failure is the fallback line
                run.status, run.cause, run.finished = "failed", "other", time.time()
            await _end(run)

        run.task = asyncio.get_running_loop().create_task(go())
        return run

    async def stop(self, board_id: str) -> Run | None:
        run = self.running(board_id)
        if run is None or run.task is None:
            return None
        run.task.cancel()
        try:
            await run.task
        except BaseException:  # noqa: BLE001
            pass
        run.status, run.finished = "stopped", run.finished or time.time()
        await _end(run)  # a run stopped before it began never reached its own end
        return run

    def clear(self) -> None:
        for run in self._runs.values():
            if run.task is not None and not run.task.done():
                run.task.cancel()
        self._runs.clear()


async def _end(run: Run) -> None:
    if run.ended:
        return
    run.ended = True
    if run.on_end is not None:
        try:
            await run.on_end(run)
        except Exception:  # noqa: BLE001 - the outcome is recorded; a screen reads it again
            pass


runs = Runs()

# What a failed read says, by cause: GM's lines (the Studio shows the same).
FAILURE_LINES = {
    "timeout": "Gemini didn't answer in time. Try again.",
    "signed_out": "Antigravity signed out during the read. Sign in again, then try again.",
    "plan_limit": "Your Antigravity plan has reached its limit for now. Try again later, or use your Gemini API key.",
    "key_refused": "Google refused your Gemini API key. Check it in Settings, then try again.",
}
FALLBACK_LINE = "Try again, or reload if it keeps happening."
# "Claude Code couldn't read the board because …" (the Agent log).
BECAUSE = {
    "timeout": "Gemini didn't answer in time",
    "signed_out": "Antigravity signed out during the read",
    "plan_limit": "the Antigravity plan has reached its limit for now",
    "key_refused": "Google refused the Gemini API key",
    "write_attempt": "the read tried to change its files, so Nebula stopped it",
}


def failure_line(cause: str | None) -> str:
    return FAILURE_LINES.get(cause or "", FALLBACK_LINE)


def agent_failure_say(cause: str | None) -> str:
    return f"Couldn't read the board because {BECAUSE.get(cause or '', 'something went wrong')}."
