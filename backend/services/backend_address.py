"""Where an outside MCP client finds this backend when its port changes per launch.

The desktop sidecar (desktop/sidecar.mjs) starts the backend on a port the OS
assigns, a new one each launch, and puts it in ``NEBULA_URL``. A config that
names that port stops working when Nebula is reopened. So in desktop mode the
backend writes its address to ``<NEBULA_STATE_DIR>/backend-url`` (0600) at
startup, and Connect your agent configs carry ``NEBULA_URL_FILE`` (that path)
instead of ``NEBULA_URL``. backend/mcp_server.py and the ``nebula`` CLI read the
file on every call, so they follow Nebula across relaunches.

The file can outlive the backend: after a crash it still names a port that
any local program may bind next, and a client that trusted it would hand that
program its app token. So the file also holds a secret made fresh each launch,
readable only by this user, and a client checks the address before it sends a
token (``verified_url``): it sends a random challenge to
``GET /api/agent/address-proof``, which only the backend that wrote the file
can answer, because the answer is an HMAC keyed by that secret. Anything else
at that port gets a challenge and no token.

A dev backend (backend/devserver.py, plain uvicorn) has a fixed port the
person chose, and several of them may share one state dir, so it publishes
nothing and its configs keep ``NEBULA_URL``.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
from pathlib import Path
from typing import Callable, Mapping, NamedTuple
from urllib.parse import urlsplit, urlunsplit

FILE_NAME = "backend-url"
PROOF_PATH = "/api/agent/address-proof"
_PROOF_CONTEXT = b"nebula backend-url proof\x00"
_CHALLENGE = re.compile(r"[0-9a-f]{32,128}")
_SECRET = re.compile(r"[0-9a-f]{64}")


class Published(NamedTuple):
    url: str
    secret: str


def loopback_url(url: str) -> str:
    """An http origin on this machine, or ValueError. Nothing else is trusted
    with an app token: a file anyone edited to point elsewhere is refused."""
    parts = urlsplit(url.strip())
    try:
        port = parts.port
    except ValueError as exc:
        raise ValueError("the Nebula address must use a valid port") from exc
    if (parts.scheme != "http" or parts.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parts.username is not None or parts.password is not None or parts.query
            or parts.fragment or parts.path not in {"", "/"} or port is None):
        raise ValueError("the Nebula address must be http on 127.0.0.1, localhost or ::1 with a port")
    return urlunsplit((parts.scheme, parts.netloc, "", "", ""))


def launch_assigned(environ: Mapping[str, str] | None = None) -> bool:
    """True when the desktop sidecar started this backend (a new port each launch)."""
    env = os.environ if environ is None else environ
    return env.get("NEBULA_DESKTOP_MODE") == "1"


def url_file(state_dir: Path) -> Path:
    return Path(state_dir) / FILE_NAME


def new_secret() -> str:
    return secrets.token_hex(32)


def prove(secret: str, challenge: str) -> str:
    """The answer to a client's challenge: HMAC-SHA256 keyed by this launch's secret."""
    if not _CHALLENGE.fullmatch(challenge or ""):
        raise ValueError("challenge must be 32 to 128 lowercase hex characters")
    return hmac.new(bytes.fromhex(secret), _PROOF_CONTEXT + challenge.encode("ascii"), hashlib.sha256).hexdigest()


def publish(state_dir: Path, url: str, secret: str) -> Path:
    """Write this launch's address and secret, atomically and 0600."""
    if not _SECRET.fullmatch(secret):
        raise ValueError("the launch secret must be 64 lowercase hex characters")
    target = url_file(state_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{FILE_NAME}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps({"url": loopback_url(url), "secret": secret}) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)
    return target


def withdraw(state_dir: Path, secret: str) -> None:
    """Remove the file at shutdown, unless a newer launch already replaced it."""
    target = url_file(state_dir)
    try:
        if hmac.compare_digest(read(target).secret, secret):
            target.unlink()
    except (OSError, ValueError):
        pass


def read(path: str | Path) -> Published:
    """The address and secret in a backend-url file, unchecked. Raises
    ValueError with a plain reason. Use ``verified_url`` before sending a token."""
    try:
        text = Path(path).read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise ValueError(f"Nebula isn't running (no {path}). Open Nebula, then try again.") from exc
    except OSError as exc:
        raise ValueError(f"can't read {path}: {exc}") from exc
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if not isinstance(data, dict) or not isinstance(data.get("url"), str) \
            or not isinstance(data.get("secret"), str) or not _SECRET.fullmatch(data["secret"]):
        raise ValueError(f"{path} isn't a Nebula address file. Reopen Nebula to rewrite it.")
    return Published(loopback_url(data["url"]), data["secret"])


# (url, challenge) -> the "proof" the server answered, or None when nothing answered.
Probe = Callable[[str, str], str | None]


def _http_probe(url: str, challenge: str, timeout: float) -> str | None:
    import httpx

    try:
        # No proxies from the environment: this is a loopback check, and a
        # proxy would answer for whatever it reaches, not for this port.
        response = httpx.get(f"{url}{PROOF_PATH}", params={"challenge": challenge},
                             timeout=timeout, trust_env=False, follow_redirects=False)
    except (httpx.ConnectError, httpx.TimeoutException):
        return None
    except httpx.HTTPError:
        return ""
    try:
        payload = response.json() if response.status_code == 200 else None
    except ValueError:
        payload = None
    proof = payload.get("proof") if isinstance(payload, dict) else None
    return proof if isinstance(proof, str) else ""


def verified_url(path: str | Path, *, probe: Probe | None = None, timeout: float = 3.0) -> str:
    """The address in a backend-url file, once the backend there has proved
    it wrote the file. Raises ValueError with a plain reason otherwise; the
    caller then sends nothing, so a stale file never leaks a token."""
    published = read(path)
    challenge = secrets.token_hex(32)
    answer = (probe or (lambda url, c: _http_probe(url, c, timeout)))(published.url, challenge)
    if answer is None:
        raise ValueError(f"Nebula isn't running (nothing answers at {published.url}; {path} is left from an "
                         "earlier launch). Open Nebula, then try again.")
    # compare_digest raises TypeError on non-ASCII text, so check that first.
    if not (answer.isascii() and hmac.compare_digest(answer, prove(published.secret, challenge))):
        raise ValueError(f"the program at {published.url} isn't the Nebula that wrote {path} (Nebula may have "
                         "quit or crashed, and something else took its port), so no token was sent. "
                         "Open Nebula, then try again.")
    return published.url
