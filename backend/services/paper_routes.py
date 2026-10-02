from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from typing import Literal

from services.output import OUTPUT_ROOT
from services.paper_sources import PaperSources, SourceRefreshError
from services.paper_transport import PaperError

router = APIRouter(prefix="/api/paper", tags=["paper"])
paper_sources = PaperSources(OUTPUT_ROOT)


class LinkRequest(BaseModel):
    fileId: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    pageId: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    objectId: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    scale: Literal["1x", "2x"] = "1x"

    def identity(self):
        return self.model_dump(exclude={"scale"})


def error(exc):
    if isinstance(exc, SourceRefreshError):
        return HTTPException(409 if exc.state == "missing" else 503, {"message": str(exc), "source": exc.source})
    if isinstance(exc, KeyError):
        return HTTPException(404, "Paper source or snapshot not found")
    return HTTPException(503, {"message": str(exc)})


@router.get("/files")
async def files():
    try:
        return await paper_sources.transport.files()
    except PaperError as exc:
        raise error(exc)


@router.get("/files/{file_id}")
async def file_info(file_id: str, pageId: str | None = None):
    try:
        return await paper_sources.transport.info(file_id, pageId)
    except PaperError as exc:
        raise error(exc)


@router.get("/selection")
async def selection(fileId: str | None = None):
    try:
        return await paper_sources.transport.selection(fileId)
    except PaperError as exc:
        raise error(exc)


@router.post("/sources")
async def link(body: LinkRequest):
    try:
        return await paper_sources.link(body.identity(), body.scale)
    except (PaperError, KeyError) as exc:
        raise error(exc)


@router.get("/object")
async def object_info(fileId: str, pageId: str, objectId: str):
    try:
        return await paper_sources.transport.object_info(fileId, pageId, objectId)
    except PaperError as exc:
        raise error(exc)


@router.post("/sources/{source_id}/open")
async def open_source(source_id: str):
    try:
        return await paper_sources.transport.open(paper_sources.get(source_id)["identity"])
    except (PaperError, KeyError) as exc:
        raise error(exc)


@router.get("/sources/{source_id}")
async def source(source_id: str):
    try:
        return paper_sources.get(source_id)
    except KeyError as exc:
        raise error(exc)


@router.post("/sources/{source_id}/refresh")
async def refresh(source_id: str):
    try:
        return await paper_sources.refresh(source_id)
    except (PaperError, KeyError) as exc:
        raise error(exc)


@router.post("/sources/{source_id}/reconnect")
async def reconnect(source_id: str, body: LinkRequest):
    try:
        return await paper_sources.refresh(source_id, body.identity(), body.scale)
    except (PaperError, KeyError) as exc:
        raise error(exc)


@router.get("/snapshots/{snapshot_id}")
async def snapshot(snapshot_id: str):
    try:
        result = paper_sources.snapshot(snapshot_id)
        return FileResponse(result["filePath"], media_type="image/png", headers={"Cache-Control": "public, max-age=31536000, immutable"})
    except (PaperError, KeyError) as exc:
        raise error(exc)
