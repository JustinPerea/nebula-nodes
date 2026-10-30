"""Idol (Speridlabs) on the maker's own Hugging Face Space: one image to a 3D
Gaussian splat (.ply), returned as a World v2 value.

The Space is ``speridlabs/idol`` (https://huggingface.co/spaces/speridlabs/idol),
a Gradio 5.49.1 app on ZeroGPU. Its API, read 2026-10-29 from
https://speridlabs-idol.hf.space/gradio_api/info (pinned in
tests/fixtures/provider_schemas/speridlabs_idol_gradio_info.json): ``/run``
takes ``image, mode, steps, cfg_scale, rescale_t, seed, randomize, gaussians``
and returns ``[Model3D file (.ply), seed, html]``. The Gradio queue protocol
(https://www.gradio.app/guides/querying-gradio-apps-with-curl): POST
``/gradio_api/call/run`` with ``{"data": [...]}`` gives an ``event_id``; GET
``/gradio_api/call/run/<event_id>`` streams server-sent events ending in
``complete`` (the outputs) or ``error``. Files go up first through POST
``/gradio_api/upload`` (multipart ``files``), which answers with the
server-side paths, the call the Gradio client makes.

Who pays: nobody bills Nebula. Without a token the Space runs on Hugging
Face's anonymous ZeroGPU allowance; with the person's ``HF_TOKEN`` it uses
their own (free 5, PRO 40 minutes a day; past that, a PRO account can be billed
$1 per 10 GPU-minutes, https://huggingface.co/docs/hub/spaces-zerogpu). The
token is sent only to huggingface.co and the Space's own host
(speridlabs-idol.hf.space) over HTTPS, and never appears in a log line or an
error.

The ZeroGPU errors the Space can answer with are read from ``spaces`` 0.51.3
``spaces/zero/client.py`` ``schedule()`` (the package every ZeroGPU Space
runs; read 2026-10-29): see :func:`zerogpu_kind`.

``randomize`` is always sent as false: Nebula's run cache keys on the params,
so a random seed would replay one result. Change Seed for a new object.
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Mapping
from urllib.parse import quote, urlsplit, urlunsplit

import httpx

from execution.person_line import as_person_line, with_api_status, with_person_line, with_provider_line
from models.events import ExecutionEvent, ProgressEvent
from models.graph import GraphNode, PortValueDict
from services.splat_ply import SPLAT_PLY_MAX_BYTES, SplatPlyError, SplatPlyHeader, validate_splat_ply

SPACE_ID = "speridlabs/idol"
SPACE_URL = "https://speridlabs-idol.hf.space"
SPACE_HOST = "speridlabs-idol.hf.space"
GRADIO_API = f"{SPACE_URL}/gradio_api"
HUB_SPACE_API = f"https://huggingface.co/api/spaces/{SPACE_ID}"
TOKEN_KEY = "HF_TOKEN"

# /run's inputs, in order, as /gradio_api/info names them (the pinned fixture).
RUN_PARAMS: tuple[str, ...] = ("image", "mode", "steps", "cfg_scale", "rescale_t", "seed", "randomize", "gaussians")
RUN_RETURNS: tuple[str, ...] = ("Model3D", "Number", "HTML")
MODES = ("Synthetic", "Real photo")
GAUSSIANS = ("65,536", "131,072", "262,144", "524,288", "1,048,576")
# The node's own values for the Space's mode labels (the route's valueMap,
# read backwards): the World's session tags use the node's words.
MODE_VALUES = {"Synthetic": "synthetic", "Real photo": "real"}

# The Space's slider bounds, from the pinned /gradio_api/info ("numeric value
# between 10 and 100" ...), and the node's own bounds for the seed, which the
# Space types as a bare integer. tests/test_speridlabs_idol.py checks these
# against the fixture and the node definition.
# key: (field label as the Inspector shows it, low, high, whole number)
PARAM_BOUNDS: dict[str, tuple[str, float, float, bool]] = {
    "steps": ("Steps", 10, 100, True),
    "cfg_scale": ("Guidance scale", 0.0, 10.0, False),
    "rescale_t": ("Time shift", 1.0, 6.0, False),
    "seed": ("Seed", 0, 2_147_483_647, True),
}
PARAM_DEFAULTS: dict[str, float] = {"steps": 50, "cfg_scale": 3.0, "rescale_t": 3.0, "seed": 42}

# Gradio's documented size limit is none (config max_file_size null); this is
# Nebula's, for an image the backend itself reads and uploads.
MAX_IMAGE_BYTES = 20_000_000
# 1,048,576 Gaussians x 68 bytes + header is 71.3 MB; the cap is the preview's.
MAX_PLY_BYTES = SPLAT_PLY_MAX_BYTES

CONNECT_TIMEOUT = 20.0
# Gradio sends a heartbeat every 15 s, so a minute of silence is a dead stream.
STREAM_READ_TIMEOUT = 60.0
# The whole wait for one result, queue included. The Space asks ZeroGPU for
# 120 s per call (app.py ``spaces.GPU(duration=120)``); queues can add more.
RUN_TIMEOUT = 15 * 60.0
# A sleeping or starting Space is given this long to come up.
WAKE_TIMEOUT = 180.0
WAKE_POLL_INTERVAL = 5.0

# huggingface_hub SpaceStage values.
_RUNNING = {"RUNNING", "RUNNING_BUILDING", "RUNNING_APP_STARTING"}
_STARTING = {"SLEEPING", "BUILDING", "APP_STARTING"}

Emit = Callable[[ExecutionEvent], Awaitable[None]]


def _log(message: str) -> None:
    print(f"[speridlabs-idol] {message}", file=sys.stderr, flush=True)


class IdolSpaceError(RuntimeError):
    """A failure on the Space's side, worded for agents (the exception text)
    and for the person (its person line)."""


# The only hosts the person's token goes to: the Hub (stage check) and this
# Space's own domain. Not any *.hf.space: anyone can make a Space.
TOKEN_HOSTS = frozenset({"huggingface.co", SPACE_HOST})


def token_allowed(url: str) -> bool:
    """The person's HF token goes only to the Hub and the Idol Space, over HTTPS."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().rstrip(".")
    return parts.scheme == "https" and host in TOKEN_HOSTS


def _headers(url: str, token: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token and token_allowed(url) else {}


def _scrub(text: str, token: str | None) -> str:
    """Provider text with the token cut out, in case a Space ever echoes it."""
    text = str(text)
    if token:
        text = text.replace(token, "***")
    return text[:600]


def quota_error(message: str, *, signed_in: bool) -> IdolSpaceError:
    if signed_in:
        line = ("Your Hugging Face GPU allowance is used up for now. Try again later, "
                "or raise it on your Hugging Face account.")
        text = f"The Idol Space refused the run: your ZeroGPU quota is used up ({message})"
    else:
        line = ("Idol’s free allowance is used up for now. Try again later, "
                "or add your Hugging Face token in Settings to use your own.")
        text = ("The Idol Space refused the run: the anonymous ZeroGPU quota is used up. "
                f"Add HF_TOKEN in Settings > Providers for the person's own quota ({message})")
    return with_provider_line(IdolSpaceError(text), line)


def gpu_busy_error(*, detail: str) -> IdolSpaceError:
    return with_provider_line(
        IdolSpaceError(f"ZeroGPU had no free GPU for the Idol Space within its queue wait; "
                       f"the quota is untouched ({detail})"),
        "Hugging Face had no free GPU for Idol. Try again in a few minutes.")


def space_limit_error(*, detail: str) -> IdolSpaceError:
    return with_provider_line(
        IdolSpaceError(f"The Idol Space has reached its own ZeroGPU limit ({detail})"),
        "Idol has reached its own limit on Hugging Face for now. Try again later.")


def token_not_applied_error(*, detail: str) -> IdolSpaceError:
    return with_provider_line(
        IdolSpaceError("HF_TOKEN was sent, but ZeroGPU ran the Idol Space without it (no X-IP-Token reached "
                       f"the Space) and hit the anonymous limit ({detail})"),
        "Idol ran without your Hugging Face token and hit the free allowance. "
        "Check your token in Settings, then try again.")


def duration_error(*, detail: str, signed_in: bool) -> IdolSpaceError:
    if signed_in:
        return with_provider_line(
            IdolSpaceError(f"The Idol Space asks ZeroGPU for more time per run than this Hugging Face "
                           f"account allows ({detail})"),
            "Idol needs more GPU time per run than your Hugging Face account allows. "
            "Raise your allowance on Hugging Face, then try again.")
    return with_provider_line(
        IdolSpaceError(f"The Idol Space asks ZeroGPU for more time per run than the anonymous allowance "
                       f"gives; add HF_TOKEN in Settings > Providers ({detail})"),
        "Idol needs more GPU time per run than the free allowance gives. "
        "Add your Hugging Face token in Settings, then try again.")


# spaces/zero/client.py's fixed texts (0.51.3). "exceeded your … quota" and
# "runs limit" are the caller's own quota (or, with no account, their IP's);
# "too many ZeroGPU credits" is a PRO account's prepaid credits all held by
# running tasks. "No GPU was available after 60s" is a full queue, unless it
# comes with EXAMPLES_RETRY_MESSAGE, which spaces adds only when no
# X-IP-Token reached the Space: then, like "Space app has reached its GPU
# limit", it is the Space's own limit, or (with HF_TOKEN sent) the token
# didn't apply. "The requested GPU duration (…s) is larger than the maximum
# allowed" is the Space's per-run ask (app.py duration=120) over the tier's cap.
_OWN_QUOTA = re.compile(r"exceeded your .*quota|runs limit|too many zerogpu credits")
_NO_IP_TOKEN = "re-running outside of examples"


def zerogpu_kind(message: str, *, signed_in: bool) -> str | None:
    """Which ZeroGPU refusal the Space's error text is: "quota", "busy",
    "space-limit", "token-not-applied", "duration", or None for another error."""
    lowered = message.lower()
    if "requested gpu duration" in lowered and "larger than the maximum allowed" in lowered:
        return "duration"
    if _OWN_QUOTA.search(lowered):
        return "quota"
    no_ip_token = "reached its gpu limit" in lowered or (
        "no gpu was available" in lowered and _NO_IP_TOKEN in lowered)
    if no_ip_token:
        return "token-not-applied" if signed_in else "space-limit"
    if "no gpu was available" in lowered:
        return "busy"
    return None


def classify_space_error(message: Any, *, signed_in: bool, token: str | None = None) -> IdolSpaceError:
    """The Space's ``error`` event (a gr.Error message, or null) as Nebula's error."""
    text = _scrub(message if isinstance(message, str) else json.dumps(message), token) if message else ""
    kind = zerogpu_kind(text, signed_in=signed_in) if text else None
    if kind == "quota":
        return quota_error(text, signed_in=signed_in)
    if kind == "busy":
        return gpu_busy_error(detail=text)
    if kind == "space-limit":
        return space_limit_error(detail=text)
    if kind == "token-not-applied":
        return token_not_applied_error(detail=text)
    if kind == "duration":
        return duration_error(detail=text, signed_in=signed_in)
    if "upload an image" in text.lower():
        return with_person_line(IdolSpaceError("The Idol Space got no image"),
                                "Idol got no image. Connect one, then run it again.")
    if text:
        error = IdolSpaceError(f"The Idol Space returned an error: {text}")
        return with_provider_line(error, "Idol couldn’t make this object. Details has its message.")
    return with_person_line(
        IdolSpaceError("The Idol Space stopped the run without saying why (Gradio error event with no message)"),
        "Idol stopped without saying why. Try again in a minute.")


# The builders below take their detail by keyword: the error copy guards
# (tests/test_error_copy_round3c2.py) read each builder's own return, which
# carries the person's line, not its call sites.
def signature_error(*, detail: str) -> IdolSpaceError:
    # The detail can carry the Space's own answer (a 422 body): behind Details.
    return with_provider_line(
        IdolSpaceError(f"The Idol Space's API changed ({detail}); Nebula's node no longer matches it"),
        "Idol changed on Hugging Face, and this version of Nebula can’t run it. Update Nebula, then try again.")


def check_signature(info: Any) -> None:
    """Refuse to call a /run whose inputs or outputs differ from the pinned ones."""
    try:
        run = info["named_endpoints"]["/run"]
        names = tuple(p["parameter_name"] for p in run["parameters"])
        returns = tuple(str(r.get("component") or "") for r in run["returns"])
        by_name = {p["parameter_name"]: p for p in run["parameters"]}
        modes = tuple(by_name["mode"]["type"]["enum"])
        gaussians = tuple(by_name["gaussians"]["type"]["enum"])
    except (KeyError, TypeError, IndexError):
        raise signature_error(detail="its /run endpoint is missing or unreadable") from None
    if names != RUN_PARAMS:
        raise signature_error(detail=f"/run takes {', '.join(names)}, not {', '.join(RUN_PARAMS)}")
    if tuple(r.lower() for r in returns) != tuple(r.lower() for r in RUN_RETURNS):
        raise signature_error(detail=f"/run returns {', '.join(returns)}, not {', '.join(RUN_RETURNS)}")
    if modes != MODES or gaussians != GAUSSIANS:
        raise signature_error(detail="its Input type or Gaussians choices changed")


def space_down_error(*, stage: str) -> IdolSpaceError:
    return with_person_line(
        IdolSpaceError(f"The Idol Space is {stage.lower().replace('_', ' ')} on Hugging Face, so it can't run"),
        "Idol isn’t running on Hugging Face right now. Try again later.")


def space_starting_error(*, stage: str) -> IdolSpaceError:
    return with_person_line(
        IdolSpaceError(f"The Idol Space is still {stage.lower().replace('_', ' ')} after {int(WAKE_TIMEOUT)} s"),
        "Idol is still starting on Hugging Face. Try again in a few minutes.")


def timeout_error(*, what: str) -> IdolSpaceError:
    return with_person_line(IdolSpaceError(f"The Idol Space didn't answer in time ({what})"),
                            "Idol took too long to answer. Try again in a few minutes.")


def token_refused(*, status: int = 401) -> IdolSpaceError:
    return with_person_line(with_api_status(IdolSpaceError(f"Hugging Face refused the HF_TOKEN ({status})"), status),
                            "Hugging Face didn’t accept your token. Check it in Settings.")


def token_unusable() -> IdolSpaceError:
    # Nothing was sent: httpx can't put a non-ASCII or control character in
    # a header (a pasted smart quote or line break).
    return with_person_line(
        IdolSpaceError("The HF_TOKEN in Settings has a character an HTTP header can't carry "
                       "(not printable ASCII), so Nebula sent nothing"),
        "Your Hugging Face token has a character a token can’t have. Paste it again in Settings.")


def _number_text(value: float) -> str:
    return f"{int(value):,}" if float(value).is_integer() else f"{value:g}"


def param_range_error(*, key: str, label: str, low: str, high: str) -> ValueError:
    return with_person_line(
        ValueError(f"Idol's {key} must be a number from {low} to {high}"),
        f"{label} must be between {low} and {high}. Change it in the node’s settings, then run it again.")


def checked_params(params: Mapping[str, Any]) -> dict[str, float]:
    """steps, cfg_scale, rescale_t and seed, each checked against PARAM_BOUNDS
    before any request: a value out of range or not a number stops the run
    with a line that names the field."""
    checked: dict[str, float] = {}
    for key, (label, low, high, whole) in PARAM_BOUNDS.items():
        raw = params.get(key)
        if raw is None or raw == "":
            raw = PARAM_DEFAULTS[key]
        error = param_range_error(key=key, label=label, low=_number_text(low), high=_number_text(high))
        if isinstance(raw, bool):
            raise error
        try:
            value = float(raw)
        except (TypeError, ValueError, OverflowError):
            raise error from None
        if not math.isfinite(value) or not low <= value <= high or (whole and not value.is_integer()):
            raise error
        checked[key] = int(value) if whole else value
    return checked


async def wait_until_running(client: httpx.AsyncClient, token: str | None) -> None:
    """Wake a sleeping Space and wait for it, or say why it can't run.

    The Hub API reads the stage without starting anything; the first request
    to the Space's own domain is what wakes a sleeping one (GET
    /gradio_api/info, which also runs nothing)."""
    deadline = time.monotonic() + WAKE_TIMEOUT
    woke = False
    while True:
        try:
            response = await client.get(HUB_SPACE_API, headers=_headers(HUB_SPACE_API, token))
        except httpx.HTTPError as exc:
            _log(f"stage check skipped: {type(exc).__name__}")
            return
        if response.status_code == 404:
            raise with_person_line(IdolSpaceError("The Idol Space (speridlabs/idol) no longer exists on Hugging Face"),
                                   "Idol is no longer on Hugging Face, so it can’t run. Use another 3D node instead.")
        if response.status_code in (401, 403) and token:
            # The Hub refuses a bad or revoked token even on a public Space.
            raise token_refused(status=response.status_code)
        if response.status_code != 200:
            _log(f"stage check skipped: HTTP {response.status_code}")
            return
        try:
            stage = str((response.json().get("runtime") or {}).get("stage") or "")
        except (ValueError, AttributeError):
            return
        if not stage or stage in _RUNNING:
            return
        if stage not in _STARTING:
            raise space_down_error(stage=stage)
        if not woke:
            woke = True
            try:
                await client.get(f"{GRADIO_API}/info", headers=_headers(GRADIO_API, token))
            except httpx.HTTPError:
                pass
        if time.monotonic() >= deadline:
            raise space_starting_error(stage=stage)
        await asyncio.sleep(WAKE_POLL_INTERVAL)


async def _read_info(client: httpx.AsyncClient, token: str | None) -> Any:
    url = f"{GRADIO_API}/info"
    response = await client.get(url, headers=_headers(url, token))
    if response.status_code in (502, 503, 504):
        raise space_starting_error(stage=f"answering {response.status_code}")
    if response.status_code in (401, 403) and token:
        raise token_refused(status=response.status_code)
    if response.status_code != 200:
        raise signature_error(detail=f"GET /gradio_api/info answered {response.status_code}")
    try:
        return response.json()
    except ValueError:
        raise signature_error(detail="GET /gradio_api/info didn't answer JSON") from None


async def _image_file_data(client: httpx.AsyncClient, image: tuple[bytes, str], token: str | None) -> dict[str, Any]:
    """The Space's ImageData for the wired image: always uploaded first, under
    a neutral name, so neither the person's file name nor a URL (with any
    query string) reaches the Space."""
    content, mime = image
    name = _upload_name(mime)
    url = f"{GRADIO_API}/upload"
    response = await client.post(url, headers=_headers(url, token),
                                 files={"files": (name, content, mime or "application/octet-stream")})
    if response.status_code != 200:
        raise _upload_error(response, token)
    try:
        server_path = response.json()[0]
    except (ValueError, IndexError, KeyError, TypeError):
        server_path = None
    if not isinstance(server_path, str) or not server_path:
        raise signature_error(detail="its upload answered something other than a list of file paths")
    return {"path": server_path, "orig_name": name, "meta": {"_type": "gradio.FileData"}}


_IMAGE_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
                     "image/bmp": "bmp", "image/tiff": "tiff", "image/avif": "avif"}


def _upload_name(mime: str) -> str:
    return f"input.{_IMAGE_EXTENSIONS.get(mime.split(';', 1)[0].strip().lower(), 'png')}"


async def _read_image(value: str) -> tuple[bytes, str]:
    """The wired image's bytes and type, read the way every handler reads one
    (services/media_input.load_media): an owned output or a local file under
    the path policy, a data URI, or a public https URL fetched without
    credentials (loopback and private addresses refused)."""
    from services.media_input import load_media

    return await load_media(value, label="The image", max_bytes=MAX_IMAGE_BYTES)


def _upload_error(response: httpx.Response, token: str | None) -> IdolSpaceError:
    if response.status_code == 401 and token:
        return token_refused()
    if response.status_code in (502, 503, 504):
        return space_starting_error(stage=f"answering {response.status_code}")
    return with_provider_line(with_api_status(
        IdolSpaceError(f"The Idol Space refused the image upload ({response.status_code}): "
                       f"{_scrub(response.text, token)}"), response.status_code),
        "Idol didn’t take the image. Details has its message.")


async def sse_events(response: httpx.Response) -> AsyncIterator[tuple[str, str]]:
    """(event, data) pairs from a server-sent-events stream."""
    event, data = "message", []
    async for line in response.aiter_lines():
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "message", []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    if data:
        yield event, "\n".join(data)


async def _call_run(client: httpx.AsyncClient, payload: list[Any], token: str | None,
                    emit: Emit | None, node_id: str) -> list[Any]:
    url = f"{GRADIO_API}/call/run"
    response = await client.post(url, headers=_headers(url, token), json={"data": payload})
    if response.status_code == 401 and token:
        raise token_refused()
    if response.status_code in (502, 503, 504):
        raise space_starting_error(stage=f"answering {response.status_code}")
    if response.status_code == 422:
        raise signature_error(detail=f"/call/run refused the request (422): {_scrub(response.text, token)}")
    if response.status_code != 200:
        raise with_provider_line(with_api_status(
            IdolSpaceError(f"The Idol Space refused the run ({response.status_code}): {_scrub(response.text, token)}"),
            response.status_code), "Idol didn’t take the run. Details has its message.")
    try:
        event_id = str(response.json()["event_id"])
    except (ValueError, KeyError, TypeError):
        raise signature_error(detail="/call/run answered no event_id") from None
    stream_url = f"{url}/{event_id}"
    beats = 0
    async with client.stream("GET", stream_url, headers=_headers(stream_url, token)) as stream:
        if stream.status_code != 200:
            await stream.aread()
            raise with_provider_line(
                with_api_status(IdolSpaceError(f"The Idol Space's result stream answered {stream.status_code}"),
                                stream.status_code),
                "Idol didn’t send its result. Try again in a minute.")
        async for event, data in sse_events(stream):
            if event == "complete":
                try:
                    outputs = json.loads(data)
                except ValueError:
                    raise signature_error(detail="its result wasn't JSON") from None
                if not isinstance(outputs, list) or len(outputs) != len(RUN_RETURNS):
                    raise signature_error(detail=f"/run returned {type(outputs).__name__}, not {len(RUN_RETURNS)} outputs")
                return outputs
            if event == "error":
                try:
                    message = json.loads(data) if data else None
                except ValueError:
                    message = data
                if isinstance(message, Mapping):
                    message = message.get("error") or message.get("message") or message.get("title")
                raise classify_space_error(message, signed_in=bool(token), token=token)
            if event in ("heartbeat", "generating") and emit is not None:
                beats += 1
                # No real progress from the Space: a slow creep that never claims done.
                await emit(ProgressEvent(node_id=node_id, value=min(0.9, 0.1 + 0.02 * beats)))
    raise with_person_line(IdolSpaceError("The Idol Space's result stream ended without a result"),
                           "Idol stopped without a result. Try again in a minute.")


def _file_url(path: str) -> str:
    """The Space's file route for a server path, URL-quoted (a ``#`` or a
    space in a path would otherwise cut or break it)."""
    return f"{GRADIO_API}/file={quote(path, safe='/')}"


def _result_url(file_data: Any) -> str:
    if not isinstance(file_data, Mapping):
        raise signature_error(detail="its first output isn't a file")
    url = file_data.get("url")
    path = file_data.get("path")
    if isinstance(url, str) and url:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        if host != SPACE_HOST:
            raise signature_error(detail="its result file is served from another host")
        if parts.scheme == "https":
            return url
        if parts.scheme != "http":
            raise signature_error(detail="its result file URL isn't http or https")
        # Gradio builds the URL from the request; behind a proxy that drops
        # x-forwarded-proto it says http. The same file is on the Space's
        # https file route.
        if isinstance(path, str) and path:
            return _file_url(path)
        return urlunsplit(("https", host, parts.path, parts.query, ""))
    if isinstance(path, str) and path:
        return _file_url(path)
    raise signature_error(detail="its result file has no path")


async def _download_ply(client: httpx.AsyncClient, url: str, token: str | None,
                        destination: Path) -> SplatPlyHeader:
    partial = destination.with_name(destination.name + ".part")
    received = 0
    try:
        async with client.stream("GET", url, headers=_headers(url, token)) as response:
            if response.status_code != 200:
                raise with_provider_line(
                    # no API status: a download of a result file, not the Space's API
                    IdolSpaceError(f"The Idol Space's .ply download answered {response.status_code}"),
                    "Nebula couldn’t download the object from Idol. Try again in a minute.")
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > MAX_PLY_BYTES:
                raise with_person_line(
                    IdolSpaceError(f"The Idol Space's .ply is {int(declared):,} bytes, above Nebula's "
                                   f"{MAX_PLY_BYTES:,}-byte limit"),
                    "This splat is too large for Nebula to keep. "
                    "Lower Gaussians in the node’s settings, then run it again.")
            with partial.open("wb") as handle:
                async for chunk in response.aiter_bytes():
                    received += len(chunk)
                    if received > MAX_PLY_BYTES:
                        raise with_person_line(
                            IdolSpaceError(f"The Idol Space's .ply passed Nebula's {MAX_PLY_BYTES:,}-byte limit"),
                            "This splat is too large for Nebula to keep. "
                    "Lower Gaussians in the node’s settings, then run it again.")
                    handle.write(chunk)
        try:
            header = validate_splat_ply(partial)
        except SplatPlyError as exc:
            # The preflight's reason (Nebula's own words) stays behind Details.
            raise with_provider_line(IdolSpaceError(f"The Idol Space returned a .ply Nebula can't read: {exc}"),
                                     "Idol sent back a file Nebula can’t read as a splat. Try again.") from None
        partial.replace(destination)
        return header
    finally:
        partial.unlink(missing_ok=True)


def _gaussian_count(label: Any) -> int:
    return int(str(label).replace(",", ""))


def world_value(path: Path, *, seed: int, gaussians: int, mode: str, steps: int) -> dict[str, Any]:
    """The World v2 value for one Idol splat (frontend/src/types/spatial.ts
    WorldValueV2). Idol's ``save_ply`` writes its z-up object turned +90
    degrees about x, (x, y, z) -> (x, -z, y), so in the file up is -y (its
    own "y-up" comment notwithstanding). The front faces +x: renders of the
    Space's backpack example from each axis show its front at +x, its back at
    -x and its sides at +-z (PR #203 review, 2026-10-29); the input camera's
    yaw is predicted per image, so this is the typical front, not a promise.
    The object fits [-0.5, 0.5] on each axis in model units, so the unit is
    ``custom``. ``gaussians`` is the file's own count (its validated header),
    ``mode`` the node's value ("synthetic" or "real")."""
    from services.output import portable_output_ref

    uri = portable_output_ref(str(path), require_file=True)
    world_id = f"idol-{uuid.uuid4().hex[:12]}"
    coordinate_system = {
        "schemaVersion": 1, "kind": "coordinate-system", "id": "idol-object",
        "handedness": "right", "upAxis": "-y", "forwardAxis": "x",
        "unit": "custom", "metersPerUnit": 1.0, "originMeters": [0.0, 0.0, 0.0],
    }
    return {
        "schemaVersion": 2,
        "kind": "world",
        "id": world_id,
        "displayName": "Idol object",
        "coordinateSystem": coordinate_system,
        "session": {
            "schemaVersion": 1, "kind": "spatial-session", "id": world_id,
            "source": "generated", "createdAtMs": int(time.time() * 1000),
            "provider": "speridlabs", "model": "idol", "label": "Idol object",
            "tags": [f"seed:{seed}", f"gaussians:{gaussians}", f"mode:{mode}", f"steps:{steps}"],
        },
        "assets": {
            "splats": [{
                "id": "splat",
                "format": "ply",
                "asset": {"id": "splat-ply", "uri": uri, "mediaType": "application/octet-stream",
                          "byteLength": path.stat().st_size},
                "pointCount": gaussians,
            }],
        },
    }


async def run_idol(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: Mapping[str, Any], *,
                   emit: Emit | None = None) -> dict[str, Any]:
    """One Idol run on the Space. ``node.params`` are already the Space's
    names and values (the route's valueMap: "Real photo", "262,144")."""
    from services.output import get_run_dir

    image = inputs.get("image")
    image_value = image.value[0] if image is not None and isinstance(image.value, list) and image.value else (
        image.value if image is not None else None)
    if not image_value:
        raise as_person_line(ValueError("Idol needs an image. Connect one, then run it again."))
    raw_token = api_keys.get(TOKEN_KEY)
    # TODO(Justin): an agent's run on a PRO, Team or Enterprise token can be
    # billed by Hugging Face past the daily quota; the spend gate admits it at
    # $0 today (PR #203 review). Decide whether agents may run it on a token.
    token = raw_token.strip() if isinstance(raw_token, str) and raw_token.strip() else None
    if token is not None and not (token.isascii() and token.isprintable()):
        raise token_unusable()
    params = dict(node.params)
    mode = str(params.get("mode") or MODES[0])
    gaussians_label = str(params.get("gaussians") or "262,144")
    if mode not in MODES or gaussians_label not in GAUSSIANS:
        raise as_person_line(ValueError("Idol doesn’t take this Input type or Gaussians value. Pick one from the list."))
    numbers = checked_params(params)
    steps, cfg, rescale_t, seed = numbers["steps"], numbers["cfg_scale"], numbers["rescale_t"], numbers["seed"]

    timeout = httpx.Timeout(CONNECT_TIMEOUT, read=STREAM_READ_TIMEOUT)
    _log(f"run node={node.id} signed_in={bool(token)} gaussians={gaussians_label} steps={steps}")
    # Read before the Space is touched, and outside its error mapping: a
    # refused or unreadable image says so in load_media's own words.
    picture = await _read_image(str(image_value))
    try:
        async with asyncio.timeout(RUN_TIMEOUT):
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
                await wait_until_running(client, token)
                check_signature(await _read_info(client, token))
                file_data = await _image_file_data(client, picture, token)
                payload = [file_data, mode, steps, cfg, rescale_t, seed, False, gaussians_label]
                outputs = await _call_run(client, payload, token, emit, node.id)
                used_seed = outputs[1] if isinstance(outputs[1], int) and not isinstance(outputs[1], bool) else seed
                # A uuid per file: two Idol nodes in one run share its folder,
                # and the default seed would otherwise give them one name.
                destination = get_run_dir() / (
                    f"idol-seed{used_seed}-{_gaussian_count(gaussians_label)}-{uuid.uuid4().hex[:8]}.ply")
                header = await _download_ply(client, _result_url(outputs[0]), token, destination)
    except TimeoutError:
        raise timeout_error(what=f"no result within {int(RUN_TIMEOUT // 60)} minutes") from None
    except httpx.TimeoutException as exc:
        raise timeout_error(what=type(exc).__name__) from None
    except httpx.HTTPError as exc:
        # The exception's own text can carry a request URL; the token is
        # only ever in a header, never in a URL, so the type name is enough.
        raise with_provider_line(
            IdolSpaceError(f"Nebula couldn't reach the Idol Space ({type(exc).__name__})"),
            "Nebula couldn’t reach Idol. Check the connection and try again.") from None
    except asyncio.CancelledError:
        # Closing the stream (the context managers above) ends Nebula's wait.
        # Gradio's /call API has no documented cancel, so a job the Space has
        # already started may still finish there and use its GPU time.
        _log(f"cancelled node={node.id}")
        raise
    if emit is not None:
        await emit(ProgressEvent(node_id=node.id, value=1.0))
    return {
        "world": {"type": "World", "value": world_value(
            destination, seed=used_seed, gaussians=header.vertex_count, mode=MODE_VALUES[mode], steps=steps)},
    }
