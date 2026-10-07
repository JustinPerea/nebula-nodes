"""Same-machine connection controls and read-only Krea MCP discovery."""
import ipaddress
import os
import secrets
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from services.krea_connector import ConnectorError, get_connector


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
    if origin == "null" and os.environ.get("NEBULA_DESKTOP_MODE") == "1":
        expected = os.environ.get("NEBULA_CONNECTOR_SESSION", "")
        provided = request.headers.get("X-Nebula-Connector-Session", "")
        if expected and secrets.compare_digest(provided.encode(), expected.encode()):
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


router = APIRouter(prefix="/api/krea", tags=["krea-connection"], dependencies=[Depends(local_origin)])


class DiscoveryCall(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=128)
    arguments: dict = Field(default_factory=dict)


@router.get("/connection")
async def connection():
    return get_connector().status()


@router.post("/connection/connect")
async def connect():
    return await get_connector().connect()


@router.post("/connection/check")
async def check():
    return await get_connector().check()


@router.delete("/connection")
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
