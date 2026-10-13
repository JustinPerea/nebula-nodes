"""Same-machine connection controls, read-only Krea MCP discovery, and plan links.

Connecting, re-checking or disconnecting the Krea account, and starting a
trial checkout, are the person's (services/person_gate.py). Discovery
(/tools, /tools/call), plans and the connection status stay open to local
agents, which send no Origin.
"""
import ipaddress
import os
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from services.krea_connector import ConnectorError, get_connector
from services.krea_plans import sanitize_plans, trial_link
from services.person_gate import has_person_token, require_person


def local_origin(request: Request):
    try:
        local = request.client is not None and ipaddress.ip_address(request.client.host).is_loopback
    except ValueError:
        local = False
    if not local:
        raise HTTPException(403, "Krea connection requires a local client")
    origin = request.headers.get("origin")
    if origin is None:
        return
    if origin in {"null", "file://"} and os.environ.get("NEBULA_DESKTOP_MODE") == "1":
        # The packaged renderer's opaque origin; a website's sandboxed iframe
        # sends "null" too, but it can't know the person token.
        if has_person_token(request.headers):
            return
        raise HTTPException(403, "Krea connector session is not allowed")
    try:
        parsed = urlsplit(origin)
        allowed = parsed.scheme in {"http", "https"} and parsed.hostname in {"localhost", "127.0.0.1"} and not (
            parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment)
        if parsed.port == 0:
            allowed = False
    except ValueError:
        allowed = False
    if not allowed:
        raise HTTPException(403, "Krea connection origin is not allowed")


def person_only(request: Request):
    """The Krea account is the person's to connect, re-scope or drop.

    A refusal is a PersonGateError, rendered by person_gate.person_gate_error
    (main registers it) as {detail, code: "person_required"}, so a tab that
    isn't connected as the person shows why, as it does for Settings."""
    require_person(request.headers)


router = APIRouter(prefix="/api/krea", tags=["krea-connection"], dependencies=[Depends(local_origin)])


class DiscoveryCall(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=128)
    arguments: dict = Field(default_factory=dict)


@router.get("/connection")
async def connection():
    return get_connector().status()


@router.post("/connection/connect", dependencies=[Depends(person_only)])
async def connect():
    return await get_connector().connect()


@router.post("/connection/check", dependencies=[Depends(person_only)])
async def check():
    return await get_connector().check()


@router.delete("/connection", dependencies=[Depends(person_only)])
async def disconnect():
    return await get_connector().disconnect()


@router.get("/tools")
async def tools():
    try:
        return await get_connector().tools()
    except ConnectorError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, "Krea discovery could not be completed") from exc


@router.post("/tools/call")
async def call(body: DiscoveryCall):
    try:
        return await get_connector().call_readonly(body.name, body.arguments)
    except ConnectorError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, "Krea discovery could not be completed") from exc


@router.get("/plans")
async def plans():
    try:
        return sanitize_plans(await get_connector().call_billing("show_plans"))
    except ConnectorError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, "Krea plans could not be loaded") from exc


@router.post("/trial", dependencies=[Depends(person_only)])
async def trial():
    """Start Krea's free-trial checkout. Only a user click calls this; the
    returned page asks for payment details in the browser, never in Nebula."""
    try:
        return {"url": trial_link(await get_connector().call_billing("start_free_trial"))}
    except ConnectorError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, "Krea trial could not be started") from exc
