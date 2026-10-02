"""Small Paper MCP adapter. No credentials, generation, or selection-based refresh."""
from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from services.paper_export_path import require_allowed_path


class PaperError(Exception):
    def __init__(self, message: str, state: str = "unavailable"):
        super().__init__(message)
        self.state = state


def grouped_paper_error(error: BaseException) -> PaperError | None:
    """MCP stdio task-group teardown can wrap our own validated source error."""
    if isinstance(error, PaperError):
        return error
    if isinstance(error, BaseExceptionGroup):
        for nested in error.exceptions:
            paper_error = grouped_paper_error(nested)
            if paper_error is not None:
                return paper_error
    return None


class PaperTools(Protocol):
    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]: ...


MAX_OBJECT_ANCESTORS = 128


def require_response_scope(result: dict, file_id: str, page_id: str) -> None:
    """Check authoritative scope fields when the tool supplies them.

    Node/children tools are file-scoped and do not always include scope fields.
    Their page membership is proved by the rooted reciprocal chain below.
    """
    nested_file = result.get("file") if isinstance(result.get("file"), dict) else {}
    if any(returned is not None and returned != file_id for returned in (result.get("fileId"), nested_file.get("id"))):
        raise PaperError("Paper did not resolve the linked file")
    if result.get("pageId") is not None and result["pageId"] != page_id:
        raise PaperError("Linked Paper object is not on the linked page", "missing")


async def linked_object_membership(
    tools: PaperTools, file_id: str, page_id: str, object_id: str,
) -> tuple[dict, dict, tuple[str, ...]]:
    """Reject Paper tombstones: surviving IDs alone do not prove live artwork.

    Every ancestor must acknowledge its child, and the final live ancestor must
    appear in get_children for the exact requested page root. Root node-info is
    not assumed supported. No name search or current-selection fallback exists.
    """
    info = await tools.call("get_basic_info", {"fileId": file_id, "pageId": page_id})
    require_response_scope(info, file_id, page_id)
    if not isinstance(info.get("file"), dict) or info["file"].get("id") != file_id or info.get("pageId") != page_id:
        raise PaperError("Paper did not confirm the linked file and page")
    obj = await tools.call("get_node_info", {"fileId": file_id, "nodeId": object_id})
    require_response_scope(obj, file_id, page_id)
    if obj.get("id") != object_id:
        raise PaperError("Linked Paper object is missing", "missing")

    root_id = f"root_node_{page_id}"
    if object_id == root_id:
        raise PaperError("Choose an editable Paper object rather than the page root")
    chain = [object_id]
    visited = {object_id}
    child = obj
    for _ in range(MAX_OBJECT_ANCESTORS):
        parent_id = child.get("parentId")
        if not isinstance(parent_id, str) or not parent_id:
            raise PaperError("Linked Paper object is missing or detached from its page", "missing")
        if parent_id in visited:
            raise PaperError("Paper object ancestry could not be verified")
        chain.append(parent_id)
        visited.add(parent_id)
        if parent_id == root_id:
            root_children = await tools.call("get_children", {"fileId": file_id, "nodeId": root_id})
            require_response_scope(root_children, file_id, page_id)
            children = root_children.get("children")
            if not isinstance(children, list):
                raise PaperError("Paper page membership could not be verified")
            if not any(isinstance(item, dict) and item.get("id") == child["id"] for item in children):
                raise PaperError("Linked Paper object is missing from its page", "missing")
            return info, obj, tuple(chain)
        if parent_id.startswith("root_node_"):
            raise PaperError("Linked Paper object is not on the linked page", "missing")
        parent = await tools.call("get_node_info", {"fileId": file_id, "nodeId": parent_id})
        require_response_scope(parent, file_id, page_id)
        if parent.get("id") != parent_id:
            raise PaperError("Linked Paper object ancestor is missing", "missing")
        child_ids = parent.get("childIds")
        if not isinstance(child_ids, list):
            raise PaperError("Paper object ancestry could not be verified")
        if child["id"] not in child_ids:
            raise PaperError("Linked Paper object is missing from its parent", "missing")
        child = parent
    raise PaperError("Paper object ancestry exceeds the verification limit")


def decode_result(result: Any) -> dict[str, Any]:
    """Paper returns a file header followed by a JSON payload, not just one text."""
    if result.isError:
        # Tool errors can contain local paths or relay internals. Persist a safe label.
        texts = " ".join(getattr(c, "text", "") for c in result.content).lower()
        missing = "not found" in texts or "does not exist" in texts
        raise PaperError("Linked Paper object is missing" if missing else "Paper tool failed", "missing" if missing else "unavailable")
    payload: dict[str, Any] = {}
    for block in result.content:
        if getattr(block, "type", None) != "text":
            continue
        try:
            value = json.loads(block.text)
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict):
            payload.update(value)
    if not payload:
        raise PaperError("Paper returned no readable result")
    return payload


class SessionTools:
    def __init__(self, session: ClientSession):
        self.session = session

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return decode_result(await self.session.call_tool(name, arguments))


class PaperCLI:
    """Official installed CLI; configurable executable path, never a shell command."""
    def __init__(self):
        self.command = os.environ.get("NEBULA_PAPER_CLI", str(Path.home() / ".paper/bin/paper"))
        # Export writes human-readable filenames. Serialize reads of those temporary
        # exports so two requests through this adapter cannot consume one another's bytes.
        self.export_lock = asyncio.Lock()

    @asynccontextmanager
    async def tools(self):
        if not Path(self.command).is_file():
            raise PaperError("Paper CLI unavailable; open Paper Desktop or configure NEBULA_PAPER_CLI")
        try:
            async with asyncio.timeout(60):
                with open(os.devnull, "w") as errlog:
                    async with stdio_client(StdioServerParameters(command=self.command, args=["mcp"]), errlog=errlog) as (read, write):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            await session.call_tool("get_guide", {"topic": "paper-mcp-instructions"})
                            yield SessionTools(session)
        except PaperError:
            raise
        except Exception as exc:
            paper_error = grouped_paper_error(exc)
            if paper_error is not None:
                raise paper_error from exc
            raise PaperError("Paper is disconnected or its request timed out; last good snapshot retained") from exc

    async def files(self):
        async with self.tools() as tools:
            return await tools.call("list_files", {"limit": 50})

    async def info(self, file_id: str, page_id: str | None = None):
        async with self.tools() as tools:
            args = {"fileId": file_id}
            if page_id:
                args["pageId"] = page_id
            return await tools.call("get_basic_info", args)

    async def selection(self, file_id: str | None = None):
        async with self.tools() as tools:
            args = {"fileId": file_id} if file_id else {}
            info = await tools.call("get_basic_info", args)
            selected = await tools.call("get_selection", {"fileId": info["file"]["id"]})
            return {**info, "selection": selected.get("selectedNodes", selected.get("selection", selected.get("nodes", [])))}

    async def object_info(self, file_id: str, page_id: str, object_id: str):
        async with self.tools() as tools:
            info, obj, _ = await linked_object_membership(tools, file_id, page_id, object_id)
            return {"file": info["file"], "pageId": info["pageId"], "pageName": info["pageName"], "object": obj}

    async def open(self, identity: dict):
        async with self.tools() as tools:
            result = await tools.call("open_file", {"fileId": identity["fileId"], "pageId": identity["pageId"]})
            opened_url = urlsplit(str(result.get("url", "")))
            opened = (opened_url.scheme == "https" and opened_url.netloc == "app.paper.design"
                      and opened_url.path.strip("/").split("/")[:2] == ["file", identity["fileId"]])
            target_url = identity.get("openUrl", f"https://app.paper.design/file/{identity['fileId']}/{identity['pageId']}")
            return {"navigation": "file", "objectNavigation": False, "url": target_url, "opened": opened}

    async def capture(self, identity: dict, settings: dict) -> tuple[dict, bytes, dict]:
        async with self.export_lock:
            async with self.tools() as tools:
                file_id, page_id, object_id = (identity[k] for k in ("fileId", "pageId", "objectId"))
                info, before, before_chain = await linked_object_membership(tools, file_id, page_id, object_id)
                exported = await tools.call("export", {"fileId": file_id, "pageId": page_id, "type": "image", "nodes": {object_id: [{"format": "png", "scale": settings["scale"]}]}})
                require_response_scope(exported, file_id, page_id)
                exports = [e for e in exported.get("exports", []) if e.get("nodeId") == object_id]
                if len(exports) != 1:
                    raise PaperError("Paper did not export the exact linked object", "missing")
                require_response_scope(exports[0], file_id, page_id)
                export_path = exports[0].get("filePath", "")
                if not isinstance(export_path, str) or not Path(export_path).is_absolute():
                    raise PaperError("Paper export did not supply an absolute local file path")
                try:
                    path = require_allowed_path(export_path)
                except (OSError, ValueError, RuntimeError) as exc:
                    raise PaperError("Paper export did not supply a readable, safe PNG file") from exc
                if not path.is_file() or path.stat().st_size > 32 * 1024 * 1024:
                    raise PaperError("Paper export is unavailable or exceeds 32 MiB")
                raw = path.read_bytes()
                _, after, after_chain = await linked_object_membership(tools, file_id, page_id, object_id)
                if before_chain != after_chain or any(before.get(k) != after.get(k) for k in ("id", "width", "height", "childIds")):
                    raise PaperError("Paper object changed while exporting; refresh again")
                # Token contentHash is NOT an artwork revision. No invented source revision.
                resolved = {"fileId": file_id, "pageId": page_id, "objectId": object_id,
                            "fileName": info["file"]["name"], "pageName": info["pageName"], "objectName": after["name"],
                            "openUrl": f"https://app.paper.design/file/{file_id}/{page_id}", "navigation": "file"}
                return resolved, raw, {"width": after["width"], "height": after["height"]}
