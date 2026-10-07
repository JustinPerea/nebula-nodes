"""nebula commons <verb>: the same JSON in and out as the MCP tools."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from commons.client_paths import asset_path
from services.file_access import require_allowed_path

_MAX_UPLOAD = 25 * 1024 * 1024
_MAX_VIDEO_UPLOAD = 500 * 1024 * 1024


def _print(data) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def _fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def _json_arg(text: str, name: str):
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        _fail(f"--{name} is not valid JSON: {exc}")


def run(client, args) -> None:
    # Query the server, whose activation may differ from this CLI process.
    # Refuse before local bytes are read or download directories are created.
    if client.commons_enabled() is not True:
        _fail("Commons is disabled on this backend")
    verb = args.commons_cmd
    path = None
    if verb in {"get", "fetch"}:
        try:
            path = asset_path(args.id)
        except ValueError as exc:
            _fail(str(exc))
    if verb == "search":
        filters = _json_arg(args.filters, "filters") if args.filters else {}
        _print(client.commons("POST", "/search", json={
            "query": args.query or "", "filters": filters, "brand": args.brand, "limit": args.limit}))
    elif verb == "get":
        params = {k: v for k, v in {"brand": args.brand, "fields": args.fields}.items() if v}
        _print(client.commons("GET", path, params=params))
    elif verb == "fetch":
        import re
        from services.agent_workspaces import active_workspace
        workspace = active_workspace()
        if os.environ.get("NEBULA_AGENT_TOKEN") and workspace is None:
            _fail("agent workspace context is unavailable")
        directory = require_allowed_path(args.out if args.out else (workspace or Path.cwd()))
        if workspace is not None and not directory.is_relative_to(workspace.resolve()):
            _fail("--out must be inside this agent's workspace")
        params = {"brand": args.brand} if args.brand else {}
        detail = client.commons("GET", path, params=params)
        key = detail["asset"]["blob_key"]
        if not re.fullmatch(r"[a-f0-9]{64}\.[a-z0-9]+", key):
            _fail("invalid blob key from backend")
        data = client.commons("GET", f"/blobs/{key}", params=params, binary=True)
        directory.mkdir(parents=True, exist_ok=True)
        # A unique file avoids following an existing symlink or clobbering work.
        import tempfile
        with tempfile.NamedTemporaryFile(dir=directory, prefix=key.split(".")[0] + "-",
                                         suffix="." + key.split(".")[1], delete=False) as output:
            output.write(data)
            destination = output.name
        print(destination)
    elif verb == "add":
        body = {"collection": args.collection, "why": args.why, "made_by": args.made_by}
        if args.source.startswith(("http://", "https://")) or os.environ.get("NEBULA_AGENT_TOKEN"):
            # With a turn token the backend confines the path to that turn's dirs.
            source = args.source
            if not source.startswith(("http://", "https://")):
                source = str(Path(source).expanduser().resolve())
            _print(client.commons("POST", "/add", json={"source": source, **body}))
        else:
            # No token: read the file here, with this process's permissions, and upload the bytes.
            path = require_allowed_path(args.source)
            if not path.is_file():
                _fail(f"no such file: {args.source}")
            cap = _MAX_VIDEO_UPLOAD if path.suffix.lower() in (".mp4", ".mov") else _MAX_UPLOAD
            if path.stat().st_size > cap:
                _fail("file is over the size cap")
            _print(client.commons("POST", "/add/upload", data=body, files={"file": (path.name, path.read_bytes())}))
    elif verb == "comment":
        _print(client.commons("POST", "/comments", json={"asset_id": args.id, "text": args.text,
                                                         "region_id": args.region, "brand": args.brand}))
    elif verb == "borrow":
        value = args.value
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            pass  # plain strings like "grid" or "#1f6feb"
        _print(client.commons("POST", "/borrow", json={
            "id": args.id, "attribute": args.attribute, "value": value,
            "used_in": _json_arg(args.used_in, "used-in"),
            "why": args.why, "region_id": args.region, "brand": args.brand}))
    elif verb == "status":
        _print(client.commons("GET", "/status"))
