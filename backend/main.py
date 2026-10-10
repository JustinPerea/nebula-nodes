from __future__ import annotations

# Must run before ANY third-party import (fastapi/pydantic): an inherited
# PYTHONPATH pointing at another Python version's site-packages (e.g. Hermes
# exporting 3.11 paths while Nebula runs on 3.12) breaks pydantic_core at
# import time. env_check is stdlib-only so it is safe to import this early.
import env_check as _env_check

_env_check.run_startup_checks()

import asyncio
import copy
import difflib
import hashlib
import json
import math
import os
import random
import re
import secrets
import shutil
import stat
import tempfile
import unicodedata
import zipfile
from contextlib import aclosing, contextmanager, nullcontext
from contextvars import ContextVar
from functools import wraps
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, BinaryIO
from urllib.parse import quote, unquote_to_bytes, urlsplit

from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, JSONResponse

# Load only process-level path/runtime overrides from the optional project
# file. Provider handlers deliberately read credentials from settings.json,
# so .env is not a second credential store.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)

from models import (
    ExecuteRequest,
    ExecuteNodeRequest,
    GenerateShotRequest,
    PromoteShotVariationRequest,
    ValidationErrorEvent,
    ValidationErrorDetail,
    GraphNode,
    GraphEdge,
    PortValueDict,
)
from models.events import (
    ExecutionEvent,
    ExecutedEvent,
    ExecutingEvent,
    ErrorEvent,
    GraphCancelledEvent,
    GraphCompleteEvent,
    ProviderRecoveryEvent,
    ProviderStartAmbiguousEvent,
    execution_run_id,
)
from execution.engine import execute_graph, validate_graph, topological_sort, get_subgraph, CycleError
from execution.sync_runner import get_handler_registry
from services.settings import (
    load_settings,
    save_settings,
    get_api_key,
    validate_provider_keys,
    clear_provider_validation_cache,
    is_injected_mode,
    update_injected_keys,
)
from services.node_registry import NodeRegistry
from services.cli_graph import CLIGraph
from services.project_store import (
    MAX_PROJECT_BYTES, ProjectLimitError, ProjectStore, ProjectStoreError, empty_snapshot,
    make_project, metadata as project_metadata, now as project_now,
    project_name, public_project, refresh_metadata, validate_project_id,
)
from services.port_contracts import (
    ContractEdge,
    ContractNode,
    cinema_output_ports,
    validate_edge_contracts,
)
from services.file_access import ProtectedPathError, require_allowed_path, validate_file_references
from services.output import OUTPUT_ROOT, DEFAULT_OUTPUT_ROOT, resolve_output_ref, portable_output_ref, ManifestError, find_output_record, read_manifest
from services.image_input import is_remote_or_data_uri
from services.cache import ExecutionCache
from services.execution_runs import (
    ExecutionCancellationCapacityError,
    ExecutionCancelledBeforeStartError,
    ExecutionRunRegistry,
)
from services.chat_session import run_claude
from services.agent_profiles import (
    GrantOverlapsProtectedDir,
    agent_read_grants,
    protected_agent_dirs,
)
from services.local_guard import LocalRequestGuard
from services.agent_workspaces import AgentWorkspaceContext, WorkspaceSessions, WorkspaceSessionError, workspace_scope
from services.chat_actions import publish_action
from services.agent_presence import (
    PresenceError,
    RequestHeadersContext,
    agent_presence,
    current_request_headers,
    identify as identify_agent,
    parse_target,
)
from services.canvas_events import (
    MOVE_THRESHOLD_PX,
    TooManyWaiters,
    actor_for_headers,
    actor_label,
    canvas_events,
    param_changes,
    parse_kinds,
)
from services.canvas_pins import CanvasPins, PinError, pin_summary
from services.person_gate import PersonGateError, desktop_session_matches, is_browser_request, require_person
from services.canvas_proposals import (
    MAX_REASON,
    Proposal,
    ProposalError,
    ProposalSpec,
    canvas_proposals,
    clean_note,
    clean_positions,
    cost_for,
    parse_spec,
    place_new_nodes,
    summarize_cost,
)
from services.local_guard import origin_allowed
from services.zoom_manifest import init_manifest, append_entry
from services.project_context import get_current_project
from routes.openrouter_proxy import router as openrouter_router
from routes.replicate_proxy import router as replicate_router
from routes.fal_proxy import router as fal_router
from routes.nous_proxy import router as nous_router
from routes.quiver_proxy import router as quiver_router
from routes.video_edit_preview import router as video_edit_preview_router
from routes.render_exports import router as render_exports_router
from routes.krea_connector import router as krea_connector_router
from routes.commons import router as commons_router
from commons import actors as commons_actors
from services.ffmpeg import ffprobe_video
from services.preset_store import preset_store
from services.selection_context import SelectionContextStore, _safe_value as _journal_safe_value, selection_prompt_context
from services.provider_recovery import (
    ProviderRecoveryCapacityError,
    ProviderRecoveryConflictError,
    ProviderRecoveryPersistenceError,
    ProviderRecoveryStore,
)
from services.provider_start_guard import (
    ProviderStartCancellationCapacityError,
    ProviderStartCancelledError,
    ProviderStartConflictError,
    ProviderStartGuard,
    ProviderStartPersistenceError,
)
from services.provider_operation_policy import (
    has_recovery_identity,
    operation_policy,
    quick_execution_allowed,
    recovery_identifiers,
    recovery_param_names,
    requires_fresh_paid_start,
    uses_durable_recovery,
)
from services.worldlabs_capabilities import worldlabs_capability_gate
from models.spatial import (
    SPATIAL_VALUE_MODELS,
    canonicalize_world_value_v1,
    dump_spatial_value,
    parse_spatial_value,
)

execution_cache = ExecutionCache(ttl=3600)
execution_runs = ExecutionRunRegistry()
node_registry = NodeRegistry()
selection_context = SelectionContextStore()
workspace_sessions = WorkspaceSessions()

# Persist the CLI graph to ~/.nebula/state.json on every mutation and reload
# it on boot. Survives uvicorn restart so a crash or `kill` no longer wipes
# the canvas. Per-user state dir keeps different projects on the same machine
# isolated; override with NEBULA_STATE_DIR if you need a project-scoped file.
_STATE_DIR = Path(os.environ.get("NEBULA_STATE_DIR", Path.home() / ".nebula"))
try:
    _STATE_DIR.mkdir(parents=True, exist_ok=True)
except Exception as exc:
    print(f"[main] cannot create state dir {_STATE_DIR}: {exc} — persistence disabled", flush=True)
    _STATE_PATH: Path | None = None
else:
    _STATE_PATH = _STATE_DIR / "state.json"

cli_graph = CLIGraph(persist_path=_STATE_PATH)
project_store = ProjectStore(_STATE_DIR / "projects")
# Pins follow `main.project_store` through the getter (tests swap the store).
canvas_pins = CanvasPins(lambda: project_store)
_request_workspace_revision: ContextVar[str | None] = ContextVar("workspace_revision", default=None)
_execution_workspace_context: ContextVar[dict[str, Any] | None] = ContextVar("execution_workspace", default=None)
_synchronous_workspace_runs: set[str] = set()
if _STATE_PATH is not None and _STATE_PATH.exists():
    try:
        cli_graph.load(_STATE_PATH)
        print(f"[main] restored graph from {_STATE_PATH} — {len(cli_graph.nodes)} nodes, {len(cli_graph.edges)} edges", flush=True)
    except Exception as exc:
        print(f"[main] failed to restore graph from {_STATE_PATH}: {exc} — starting fresh", flush=True)

provider_recovery_store = ProviderRecoveryStore(
    _STATE_DIR / "provider-recoveries.json" if _STATE_PATH is not None else None
)
provider_start_guard = ProviderStartGuard(
    _STATE_DIR / "provider-start-ambiguities.json" if _STATE_PATH is not None else None
)


def _reject_graph_replacement_during_paid_start(action: str) -> None:
    if provider_start_guard.has_active():
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot {action} while a World Labs paid start is settling. "
                "Stop the run and wait for its terminal state first."
            ),
        )
    canonical_checkpoints = _graph_worldlabs_recovery_checkpoints(
        list(cli_graph.nodes.values())
    )
    if (
        provider_start_guard.list()
        or provider_recovery_store.list()
        or canonical_checkpoints
        or _graph_recovery_bootstrap_error is not None
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot {action} while unresolved World Labs paid state exists. "
                "Check Marble and resolve the exact recovery/ambiguity record first."
            ),
        )


@contextmanager
def _paid_graph_mutation(action: str):
    """Hold the cross-process paid lifecycle fence through a graph commit."""
    global _graph_recovery_bootstrap_error
    _check_workspace_revision()
    try:
        with provider_start_guard.exclusive_lifecycle():
            # A worker may have booted while another worker owned the lifecycle
            # lock, or may be carrying a legacy state.json written before the
            # shared journal existed. Seed its current checkpoint identities
            # before this mutation is allowed to erase or replace that graph.
            _seed_shared_graph_recoveries_for_api(
                list(cli_graph.nodes.values()), source="mutation-preflight"
            )
            _graph_recovery_bootstrap_error = None
            yield
    except ProviderStartConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot {action} while a World Labs paid start is settling. "
                "Stop the run and wait for its terminal state first."
            ),
        ) from exc
    except ProviderStartPersistenceError as exc:
        raise HTTPException(
            status_code=507,
            detail=(
                f"Cannot {action} because Nebula cannot verify the durable "
                "World Labs paid-start fence."
            ),
        ) from exc


def _graph_worldlabs_recovery_checkpoints(
    nodes: list[dict[str, Any]],
) -> list[tuple[str, str | None, str | None]]:
    """Extract provider identities that make a graph node a recovery run."""
    checkpoints: list[tuple[str, str | None, str | None]] = []
    for node in nodes:
        definition_id = node.get("definitionId")
        if not isinstance(definition_id, str) or not uses_durable_recovery(
            definition_id,
            provider="worldlabs",
        ):
            continue
        node_id = node.get("id")
        params = node.get("params") or {}
        if not isinstance(node_id, str) or not isinstance(params, dict):
            continue
        resume_id, existing_id = recovery_identifiers(definition_id, params)
        if resume_id is not None or existing_id is not None:
            # A recovery ID remains authoritative even if another stale
            # parameter would classify a new invocation as free. The handler
            # validates the recovered result later; admission must lease it now.
            checkpoints.append((node_id, resume_id, existing_id))
    return checkpoints


def _ensure_shared_graph_recoveries(
    nodes: list[dict[str, Any]], *, source: str
) -> list[dict[str, str | None]]:
    checkpoints = _graph_worldlabs_recovery_checkpoints(nodes)
    if not checkpoints:
        return []
    return provider_recovery_store.ensure_many(
        run_id=f"graph-{source}-{uuid4().hex}",
        checkpoints=checkpoints,
    )


def _seed_shared_graph_recoveries_for_api(
    nodes: list[dict[str, Any]], *, source: str
) -> list[dict[str, str | None]]:
    """Fail the graph commit if its recovery control state is not durable."""
    try:
        return _ensure_shared_graph_recoveries(nodes, source=source)
    except ProviderRecoveryCapacityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ProviderRecoveryConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ProviderRecoveryPersistenceError as exc:
        raise HTTPException(
            status_code=507,
            detail=(
                "Cannot commit graph-carried World Labs recovery state because "
                "Nebula could not save the shared recovery journal"
            ),
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _commit_graph_candidate_with_recoveries(
    candidate: CLIGraph,
    recovery_nodes: list[dict[str, Any]],
    *,
    source: str,
) -> None:
    """Commit graph and recovery journal as one failure-atomic API action.

    The recovery journal must land first so a committed graph never exposes a
    paid provider identity without its control-plane fence. If the graph's
    atomic replacement fails before commit, remove only the exact records that
    this attempt added. Existing/idempotently reused records are never touched.
    """
    additions = _seed_shared_graph_recoveries_for_api(
        recovery_nodes,
        source=source,
    )
    try:
        cli_graph.replace_with(candidate)
    except Exception as graph_error:
        try:
            provider_recovery_store.delete_many_exact(additions)
        except (
            ProviderRecoveryConflictError,
            ProviderRecoveryPersistenceError,
            ValueError,
        ) as rollback_error:
            raise HTTPException(
                status_code=507,
                detail=(
                    "Graph storage rejected the candidate and Nebula could not "
                    "roll back its newly seeded provider recovery records; "
                    "paid execution is blocked until the journal is reconciled"
                ),
            ) from rollback_error
        raise graph_error


# A persisted graph can predate the shared recovery journal. Seed it once on
# boot so every backend process sees the same paid-operation identities rather
# than relying on its process-local cli_graph snapshot.
_graph_recovery_bootstrap_error: str | None = None
_bootstrap_checkpoints = _graph_worldlabs_recovery_checkpoints(
    list(cli_graph.nodes.values())
)
if _bootstrap_checkpoints:
    try:
        with provider_start_guard.exclusive_lifecycle():
            provider_recovery_store.ensure_many(
                run_id=f"graph-bootstrap-{uuid4().hex}",
                checkpoints=_bootstrap_checkpoints,
            )
    except (
        ProviderRecoveryCapacityError,
        ProviderRecoveryConflictError,
        ProviderRecoveryPersistenceError,
        ProviderStartConflictError,
        ProviderStartPersistenceError,
        ValueError,
    ) as exc:
        _graph_recovery_bootstrap_error = str(exc)
        print(
            "[provider-recovery] could not seed persisted graph checkpoints; "
            f"paid World Labs admission is blocked in this backend: {exc}",
            flush=True,
        )
app = FastAPI(title="Nebula Node Backend", version="0.1.0")


@app.exception_handler(ProjectStoreError)
async def project_storage_error(request, exc: ProjectStoreError):
    return JSONResponse(status_code=413 if isinstance(exc, ProjectLimitError) else 507, content={"detail": str(exc)})


def _workspace_context() -> dict[str, Any]:
    catalog = project_store.read()
    return {"activeProjectId": catalog["activeProjectId"], "workspaceRevision": catalog["workspaceRevision"]}


def _check_workspace_revision(revision: str | None = None) -> None:
    supplied = revision if revision is not None else _request_workspace_revision.get()
    if supplied is not None and supplied != _workspace_context()["workspaceRevision"]:
        raise HTTPException(status_code=409, detail="This canvas is out of date. Open the current project before editing or running it.")


def _capture_execution_workspace() -> None:
    # asyncio tasks inherit this immutable admission identity; late events
    # never borrow whichever project happens to be active when broadcast.
    _execution_workspace_context.set(_workspace_context())


def _track_synchronous_project_run(handler):
    """Fence project replacement for CLI and quick runs that own HTTP tasks."""
    @wraps(handler)
    async def tracked(*args, **kwargs):
        _check_workspace_revision()
        identity = uuid4().hex
        _synchronous_workspace_runs.add(identity)
        try:
            return await handler(*args, **kwargs)
        finally:
            _synchronous_workspace_runs.discard(identity)
    return tracked


@app.middleware("http")
async def project_workspace_fence(request: Request, call_next):
    path = request.url.path
    guarded = request.method not in {"GET", "HEAD", "OPTIONS"} and path.startswith((
        "/api/graph", "/api/execute", "/api/cinema", "/api/quick",
    ))
    supplied = request.headers.get("x-nebula-workspace-revision") if guarded else None
    token = _request_workspace_revision.set(supplied)
    execution_token = _execution_workspace_context.set(None)
    try:
        try:
            _check_workspace_revision()
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        except ProjectStoreError as exc:
            return JSONResponse(status_code=507, content={"detail": str(exc)})
        return await call_next(request)
    finally:
        _execution_workspace_context.reset(execution_token)
        _request_workspace_revision.reset(token)


@app.exception_handler(ProtectedPathError)
async def protected_file_error(request, exc: ProtectedPathError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


DYNAMIC_NODE_PROVIDER_BY_DEFINITION = {
    "openrouter-universal": "openrouter",
    "nous-portal-universal": "nous",
    "replicate-universal": "replicate",
    "fal-universal": "fal",
}

app.add_middleware(
    CORSMiddleware,
    # Accept any localhost port for dev (Vite auto-bumps to 5174/5175 when 5173 is busy, etc.).
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Added after CORS so it runs first (Starlette wraps later middleware around
# earlier ones): foreign Hosts and Origins never reach CORS or the routes.
app.add_middleware(AgentWorkspaceContext)
# Lets graph routes see who is calling, so agent edits move that agent's cursor.
app.add_middleware(RequestHeadersContext)
app.add_middleware(LocalRequestGuard)


@app.middleware("http")
async def krea_desktop_cors(request: Request, call_next):
    # A packaged Electron file has an opaque origin. Limit this exception to
    # the private sidecar's connector API; browser mode keeps normal CORS.
    desktop_krea = (
        os.environ.get("NEBULA_DESKTOP_MODE") == "1"
        and request.url.path.startswith("/api/krea/")
        and request.headers.get("origin") == "null"
        and request.client is not None
        and request.client.host in {"127.0.0.1", "::1"}
        and bool(os.environ.get("NEBULA_CONNECTOR_SESSION"))
        and (request.method == "OPTIONS" or secrets.compare_digest(
            request.headers.get("x-nebula-connector-session", "").encode(),
            os.environ["NEBULA_CONNECTOR_SESSION"].encode(),
        ))
    )
    if desktop_krea and request.method == "OPTIONS":
        response = Response(status_code=204)
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Nebula-Connector-Session"
    else:
        response = await call_next(request)
    if desktop_krea:
        response.headers["Access-Control-Allow-Origin"] = "null"
        response.headers["Vary"] = "Origin"
    return response


app.include_router(krea_connector_router)

# Serve output files as static assets (mounted after dynamic routes — mounts are catch-all)
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

CHAT_UPLOADS_DIR = OUTPUT_ROOT / "chat-uploads"
CHAT_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


RESTORE_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB upload
RESTORE_SPOOL_MEMORY_BYTES = 8 * 1024 * 1024  # spill larger uploads to disk
RESTORE_MAX_MEMBERS = 4096
RESTORE_MAX_MEMBER_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB per file
RESTORE_MAX_TOTAL_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024  # 8 GiB bundle
RESTORE_MAX_COMPRESSION_RATIO = 250.0
RESTORE_MAX_PATH_BYTES = 1024
RESTORE_COPY_CHUNK_BYTES = 1024 * 1024
RESTORE_MAX_GRAPH_BYTES = 16 * 1024 * 1024
RESTORE_MAX_GRAPH_NODES = 10_000
RESTORE_MAX_GRAPH_EDGES = 50_000
RESTORE_MAX_GRAPH_DEPTH = 64
RESTORE_MAX_GRAPH_VALUES = 1_000_000
RESTORE_CONTENT_TYPE = "application/zip"
_PORTABLE_COMPONENT_FORBIDDEN = re.compile(r'[<>:"|?#*\\\x00-\x1f\x7f]')
_WINDOWS_DEVICE_NAME = re.compile(
    r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.IGNORECASE
)
_PROTOTYPE_COMPONENTS = {"__proto__", "prototype", "constructor"}


def _zip_member_kind(member: zipfile.ZipInfo) -> str:
    """Return regular-file/directory for a safe ZIP member, else reject it.

    ZIP symlinks and special Unix files must never reach the filesystem.  A
    symlink entry is just bytes to ``zipfile`` and would otherwise look like a
    harmless small member during the size preflight.
    """
    mode = member.external_attr >> 16
    file_type = stat.S_IFMT(mode)
    if file_type == stat.S_IFLNK:
        raise HTTPException(status_code=400, detail="Zip bundle contains a symlink")
    if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise HTTPException(status_code=400, detail="Zip bundle contains a special file")

    archive_kind = "directory" if member.is_dir() else "file"
    if file_type == stat.S_IFDIR and archive_kind != "directory":
        raise HTTPException(status_code=400, detail="Zip bundle has an ambiguous directory entry")
    if file_type == stat.S_IFREG and archive_kind != "file":
        raise HTTPException(status_code=400, detail="Zip bundle has an ambiguous file entry")
    return archive_kind


def _safe_zip_parts(member_name: str) -> tuple[str, ...]:
    """Validate and split one portable archive path.

    Case-folded NFC keys are used separately for collision checks so an
    archive cannot smuggle two names that alias on a case-insensitive or
    Unicode-normalizing filesystem.
    """
    if not member_name or "\x00" in member_name or "\\" in member_name:
        raise HTTPException(status_code=400, detail="Zip bundle contains an invalid path")
    if len(member_name.encode("utf-8")) > RESTORE_MAX_PATH_BYTES:
        raise HTTPException(status_code=400, detail="Zip bundle path is too long")

    stripped = member_name[:-1] if member_name.endswith("/") else member_name
    raw_parts = stripped.split("/")
    path = PurePosixPath(stripped)
    parts = path.parts
    if (
        not parts
        or path.is_absolute()
        or stripped.startswith("/")
        or "//" in stripped
        or any(part in {"", ".", ".."} for part in raw_parts)
        or (parts and re.fullmatch(r"[A-Za-z]:", parts[0]))
    ):
        raise HTTPException(status_code=400, detail="Zip bundle contains an unsafe path")

    for raw_part in parts:
        if len(raw_part.encode("utf-8")) > 255:
            raise HTTPException(status_code=400, detail="Zip bundle path component is too long")
    return tuple(parts)


def _decoded_portable_component(raw_part: str) -> tuple[str, str]:
    """Return once-decoded NFC text and its browser-compatible identity."""
    if re.search(r"%(?![0-9A-Fa-f]{2})", raw_part):
        raise HTTPException(status_code=400, detail="Zip bundle path has invalid percent encoding")
    try:
        decoded = unquote_to_bytes(raw_part).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400, detail="Zip bundle path is not valid UTF-8"
        ) from exc
    decoded = unicodedata.normalize("NFC", decoded)

    def reject_unsafe(value: str) -> None:
        if (
            not value
            or value in {".", ".."}
            or "/" in value
            or "\\" in value
            or _PORTABLE_COMPONENT_FORBIDDEN.search(value)
            or value.endswith((" ", "."))
            or _WINDOWS_DEVICE_NAME.fullmatch(value)
            or value.casefold() in _PROTOTYPE_COMPONENTS
        ):
            raise HTTPException(
                status_code=400, detail="Zip bundle contains a non-portable path"
            )

    reject_unsafe(decoded)
    probe = decoded
    for _decode_pass in range(4):
        if "%" not in probe:
            break
        if re.search(r"%(?![0-9A-Fa-f]{2})", probe):
            raise HTTPException(
                status_code=400, detail="Zip bundle path has invalid percent encoding"
            )
        try:
            nested = unquote_to_bytes(probe).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(
                status_code=400, detail="Zip bundle path is not valid UTF-8"
            ) from exc
        nested = unicodedata.normalize("NFC", nested)
        if nested == probe:
            break
        reject_unsafe(nested)
        probe = nested
    if "%" in probe:
        # The frontend applies the same bounded nested-decode policy. Reject
        # residual encoding instead of extracting a path the browser will
        # subsequently refuse (which would orphan a restore directory).
        raise HTTPException(
            status_code=400, detail="Zip bundle path has excessive percent encoding"
        )

    # JavaScript encodeURIComponent's unescaped set, minus '*' which the
    # portability policy rejects above.
    canonical = quote(decoded, safe="-_.!~'()")
    if len(canonical.encode("utf-8")) > 255:
        raise HTTPException(status_code=400, detail="Zip bundle path component is too long")
    return decoded, canonical


def _canonical_zip_parts(parts: tuple[str, ...]) -> tuple[str, ...]:
    canonical = tuple(_decoded_portable_component(part)[1] for part in parts)
    if len("/".join(canonical).encode("utf-8")) > RESTORE_MAX_PATH_BYTES:
        raise HTTPException(status_code=400, detail="Zip bundle path is too long")
    return canonical


def _collision_key(parts: tuple[str, ...]) -> tuple[str, ...]:
    keys: list[str] = []
    for part in parts:
        decoded, _canonical = _decoded_portable_component(part)
        # Match the browser's portablePathCollisionKey: compatibility
        # normalization, en-US-style Unicode lowercase, then the two folds
        # JavaScript lowercasing does not perform itself.
        key = (
            unicodedata.normalize("NFKC", decoded)
            .lower()
            .replace("ß", "ss")
            .replace("ς", "σ")
        )
        keys.append(key)
    return tuple(keys)


def _validated_restore_members(
    archive: zipfile.ZipFile,
) -> tuple[zipfile.ZipInfo, list[tuple[zipfile.ZipInfo, str, Path]]]:
    """Preflight the complete central directory before creating output files."""
    members = archive.infolist()
    if len(members) > RESTORE_MAX_MEMBERS:
        raise HTTPException(status_code=413, detail="Zip bundle contains too many members")

    total_uncompressed = 0
    total_compressed = 0
    file_keys: set[tuple[str, ...]] = set()
    directory_keys: set[tuple[str, ...]] = set()
    graph_member: zipfile.ZipInfo | None = None
    restore_members: list[tuple[zipfile.ZipInfo, str, Path]] = []

    for member in members:
        if member.flag_bits & 0x1:
            raise HTTPException(status_code=400, detail="Encrypted zip bundles are not supported")
        if member.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            raise HTTPException(status_code=400, detail="Zip bundle uses an unsupported compression method")
        if member.file_size < 0 or member.compress_size < 0:
            raise HTTPException(status_code=400, detail="Zip bundle contains invalid size metadata")
        if member.file_size > RESTORE_MAX_MEMBER_BYTES:
            raise HTTPException(status_code=413, detail="Zip bundle member is too large")

        total_uncompressed += member.file_size
        total_compressed += member.compress_size
        if total_uncompressed > RESTORE_MAX_TOTAL_UNCOMPRESSED_BYTES:
            raise HTTPException(status_code=413, detail="Zip bundle expands beyond the restore limit")
        if member.file_size and (
            member.compress_size == 0
            or member.file_size / member.compress_size > RESTORE_MAX_COMPRESSION_RATIO
        ):
            raise HTTPException(status_code=413, detail="Zip bundle member has an unsafe compression ratio")

        kind = _zip_member_kind(member)
        parts = _safe_zip_parts(member.filename)
        canonical_parts = _canonical_zip_parts(parts)
        key = _collision_key(parts)
        parent_keys = {key[:index] for index in range(1, len(key))}

        if key in file_keys or key in directory_keys:
            raise HTTPException(status_code=400, detail="Zip bundle contains duplicate or colliding paths")
        if parent_keys & file_keys:
            raise HTTPException(status_code=400, detail="Zip bundle contains a file/directory collision")

        if kind == "directory":
            directory_keys.add(key)
            continue

        # A file at a path that is already an implicit parent directory, or a
        # file whose path is a parent of an earlier file, is ambiguous on disk.
        if any(existing[: len(key)] == key for existing in file_keys | directory_keys):
            raise HTTPException(status_code=400, detail="Zip bundle contains a file/directory collision")
        file_keys.add(key)
        directory_keys.update(parent_keys)

        if parts == ("graph.json",):
            if member.file_size > RESTORE_MAX_GRAPH_BYTES:
                raise HTTPException(status_code=413, detail="graph.json is too large")
            graph_member = member
        if parts[0] == "assets" and len(parts) > 1:
            inner_parts = parts[1:]
            inner_path = "/".join(canonical_parts[1:])
            decoded_inner_parts = tuple(
                _decoded_portable_component(part)[0] for part in inner_parts
            )
            restore_members.append(
                (member, inner_path, Path(*decoded_inner_parts))
            )

    if total_uncompressed and (
        total_compressed == 0
        or total_uncompressed / total_compressed > RESTORE_MAX_COMPRESSION_RATIO
    ):
        raise HTTPException(status_code=413, detail="Zip bundle has an unsafe compression ratio")
    if graph_member is None:
        raise HTTPException(status_code=400, detail="Zip bundle is missing graph.json")
    return graph_member, restore_members


def _read_restore_member_bytes(
    archive: zipfile.ZipFile,
    member: zipfile.ZipInfo,
    *,
    byte_limit: int,
) -> bytes:
    payload = bytearray()
    with archive.open(member, "r") as source:
        while chunk := source.read(min(RESTORE_COPY_CHUNK_BYTES, byte_limit + 1)):
            payload.extend(chunk)
            if len(payload) > byte_limit:
                raise HTTPException(status_code=413, detail=f"{member.filename} is too large")
    if len(payload) != member.file_size:
        raise HTTPException(
            status_code=400,
            detail=f"{member.filename} size did not match its metadata",
        )
    return bytes(payload)


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _validate_restore_json_complexity(value: Any) -> None:
    """Bound nested graph work independently of the serialized byte ceiling."""
    stack: list[tuple[Any, int]] = [(value, 0)]
    value_count = 0
    while stack:
        current, depth = stack.pop()
        value_count += 1
        if value_count > RESTORE_MAX_GRAPH_VALUES:
            raise HTTPException(status_code=413, detail="graph.json contains too many values")
        if depth > RESTORE_MAX_GRAPH_DEPTH:
            raise HTTPException(status_code=400, detail="graph.json is nested too deeply")
        if isinstance(current, float) and not math.isfinite(current):
            raise HTTPException(status_code=400, detail="graph.json contains a non-finite number")
        if isinstance(current, dict):
            stack.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)


def _restore_runtime_params(
    definition_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Mirror the browser's legacy runtime-metadata migration for validation."""
    normalized = dict(params)
    valid = _valid_param_keys(definition_id)
    for key in ("sourceDuration", "sourceFps", "sourceIsVfr"):
        if key not in normalized or (valid is not None and key in valid):
            continue
        normalized.setdefault(f"_{key}", normalized[key])
        del normalized[key]
    return normalized


def _validate_restore_graph(graph: Any) -> dict[str, Any]:
    """Validate the complete browser-facing NebulaFile without mutating state."""
    if not isinstance(graph, dict):
        raise HTTPException(status_code=400, detail="graph.json must contain an object")
    _validate_restore_json_complexity(graph)

    version = graph.get("version")
    if type(version) is not int or version not in {1, 2, 3}:
        raise HTTPException(status_code=400, detail="Unsupported .nebula file version")
    if not isinstance(graph.get("name"), str) or not graph["name"].strip():
        raise HTTPException(status_code=400, detail="graph.json name must be a non-empty string")
    if not isinstance(graph.get("createdAt"), str) or not graph["createdAt"].strip():
        raise HTTPException(status_code=400, detail="graph.json createdAt must be a non-empty string")

    nodes = graph.get("nodes")
    edges = graph.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise HTTPException(status_code=400, detail="graph.json requires nodes and edges arrays")
    if len(nodes) > RESTORE_MAX_GRAPH_NODES:
        raise HTTPException(status_code=413, detail="graph.json contains too many nodes")
    if len(edges) > RESTORE_MAX_GRAPH_EDGES:
        raise HTTPException(status_code=413, detail="graph.json contains too many edges")

    ingress_nodes: list[dict[str, Any]] = []
    seen_node_ids: set[str] = set()
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise HTTPException(status_code=400, detail=f"nodes[{index}] must be an object")
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id or len(node_id) > 256:
            raise HTTPException(
                status_code=400, detail=f"nodes[{index}].id must be a bounded non-empty string"
            )
        if node_id in seen_node_ids:
            raise HTTPException(status_code=400, detail=f"duplicate node id '{node_id}'")
        seen_node_ids.add(node_id)
        if not isinstance(node.get("type"), str) or not node["type"]:
            raise HTTPException(status_code=400, detail=f"nodes[{index}].type must be a string")

        position = node.get("position")
        if not isinstance(position, dict):
            raise HTTPException(status_code=400, detail=f"nodes[{index}].position must be an object")
        x = position.get("x")
        y = position.get("y")
        if (
            not isinstance(x, (int, float))
            or isinstance(x, bool)
            or not math.isfinite(float(x))
            or not isinstance(y, (int, float))
            or isinstance(y, bool)
            or not math.isfinite(float(y))
        ):
            raise HTTPException(
                status_code=400, detail=f"nodes[{index}].position requires finite numeric x and y"
            )

        data = node.get("data")
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail=f"nodes[{index}].data must be an object")
        if not isinstance(data.get("label"), str):
            raise HTTPException(status_code=400, detail=f"nodes[{index}].data.label must be a string")
        definition_id = data.get("definitionId")
        if not isinstance(definition_id, str) or not definition_id:
            raise HTTPException(
                status_code=400,
                detail=f"nodes[{index}].data.definitionId must be a non-empty string",
            )
        params = data.get("params")
        if not isinstance(params, dict):
            raise HTTPException(
                status_code=400, detail=f"nodes[{index}].data.params must be an object"
            )
        normalized_params = _restore_runtime_params(definition_id, params)

        outputs = data.get("outputs", {})
        if outputs is None:
            outputs = {}
        if not isinstance(outputs, dict):
            raise HTTPException(
                status_code=400, detail=f"nodes[{index}].data.outputs must be an object"
            )
        for port_id, output in outputs.items():
            if not isinstance(port_id, str) or not port_id:
                raise HTTPException(
                    status_code=400, detail=f"nodes[{index}] has an invalid output port id"
                )
            if (
                not isinstance(output, dict)
                or not isinstance(output.get("type"), str)
                or not output["type"]
            ):
                raise HTTPException(
                    status_code=400,
                    detail=f"nodes[{index}].data.outputs.{port_id} must be a typed port object",
                )
        state = data.get("state")
        if state is not None and state not in {"idle", "queued", "executing", "complete", "error"}:
            raise HTTPException(status_code=400, detail=f"nodes[{index}].data.state is invalid")

        ingress_nodes.append(
            {
                "id": node_id,
                "definitionId": definition_id,
                "params": normalized_params,
                "outputs": outputs,
                "position": {"x": x, "y": y},
            }
        )

    ingress_edges: list[dict[str, Any]] = []
    seen_edge_ids: set[str] = set()
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            raise HTTPException(status_code=400, detail=f"edges[{index}] must be an object")
        edge_id = edge.get("id")
        if not isinstance(edge_id, str) or not edge_id or len(edge_id) > 256:
            raise HTTPException(
                status_code=400, detail=f"edges[{index}].id must be a bounded non-empty string"
            )
        if edge_id in seen_edge_ids:
            raise HTTPException(status_code=400, detail=f"duplicate edge id '{edge_id}'")
        seen_edge_ids.add(edge_id)
        if not isinstance(edge.get("type"), str) or not edge["type"]:
            raise HTTPException(status_code=400, detail=f"edges[{index}].type must be a string")
        if edge.get("data") is not None and not isinstance(edge.get("data"), dict):
            raise HTTPException(status_code=400, detail=f"edges[{index}].data must be an object")
        ingress_edges.append(
            {
                "source": edge.get("source"),
                "sourceHandle": edge.get("sourceHandle"),
                "target": edge.get("target"),
                "targetHandle": edge.get("targetHandle"),
            }
        )

    viewport = graph.get("viewport")
    if viewport is not None:
        if not isinstance(viewport, dict):
            raise HTTPException(status_code=400, detail="graph.json viewport must be an object")
        values = [viewport.get(key) for key in ("x", "y", "zoom")]
        if any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(float(value))
            for value in values
        ) or float(values[2]) <= 0:
            raise HTTPException(
                status_code=400,
                detail="graph.json viewport requires finite x/y and positive zoom",
            )

    # Exercise the same registry, param, handle, duplicate-edge, and cycle
    # validation as /api/graph/import against a persistence-free candidate.
    candidate = CLIGraph()
    id_map = _stage_graph_nodes(
        candidate,
        ingress_nodes,
        reference_key="id",
        include_outputs=True,
        normalize_image_inputs=False,
    )
    _stage_graph_edges(candidate, ingress_edges, id_map)
    return graph


def _read_and_validate_restore_graph(
    archive: zipfile.ZipFile,
    member: zipfile.ZipInfo,
) -> dict[str, Any]:
    payload = _read_restore_member_bytes(
        archive,
        member,
        byte_limit=RESTORE_MAX_GRAPH_BYTES,
    )
    try:
        text = payload.decode("utf-8")
        graph = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_json_keys,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"invalid JSON number: {value}")
            ),
        )
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid graph.json: {exc}") from exc
    return _validate_restore_graph(graph)


def _extract_restore_member(
    archive: zipfile.ZipFile,
    member: zipfile.ZipInfo,
    destination: Path,
    *,
    extracted_total: int,
) -> int:
    """Extract one regular member in bounded chunks and verify actual size."""
    partial = destination.with_name(f".{destination.name}.part")
    member_size = 0
    try:
        with archive.open(member, "r") as source, partial.open("xb") as output:
            while chunk := source.read(RESTORE_COPY_CHUNK_BYTES):
                member_size += len(chunk)
                if member_size > RESTORE_MAX_MEMBER_BYTES:
                    raise HTTPException(status_code=413, detail="Zip bundle member is too large")
                if extracted_total + member_size > RESTORE_MAX_TOTAL_UNCOMPRESSED_BYTES:
                    raise HTTPException(status_code=413, detail="Zip bundle expands beyond the restore limit")
                output.write(chunk)
        if member_size != member.file_size:
            raise HTTPException(status_code=400, detail="Zip bundle member size did not match its metadata")
        partial.replace(destination)
        return member_size
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def _restore_zip_bundle(zip_file: BinaryIO) -> dict[str, Any]:
    """Extract a frontend-produced .nebula.zip (from Save) into a fresh
    output/<timestamp>/restored-<id>/ directory. Returns the bounded, validated
    graph plus a mapping of the original asset path inside the zip (without
    the 'assets/' prefix) to the URL under which the restored file is served.

    A zip entry '<path>' at 'assets/<path>' is extracted to
    OUTPUT_ROOT / <timestamp> / restored-<id> / <path>. The archive is
    completely preflighted before extraction and every write is
    bounded.  Any failure removes the fresh restore directory so callers never
    receive or later discover a partially restored graph.
    """
    from datetime import datetime, timezone

    restore_dir: Path | None = None
    timestamp_dir: Path | None = None
    succeeded = False
    try:
        zip_file.seek(0)
        with zipfile.ZipFile(zip_file) as archive:
            graph_member, restore_members = _validated_restore_members(archive)
            graph = _read_and_validate_restore_graph(archive, graph_member)
            if not restore_members:
                succeeded = True
                return {"graph": graph, "urlMapping": {}}

            timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
            timestamp_dir = OUTPUT_ROOT / timestamp
            restore_dir = timestamp_dir / f"restored-{uuid4().hex[:8]}"
            restore_dir.mkdir(parents=True, exist_ok=False)
            restore_root = restore_dir.resolve()
            rel_prefix = f"{timestamp}/{restore_dir.name}"
            url_mapping: dict[str, str] = {}
            extracted_total = 0

            for member, inner_path, relative_destination in restore_members:
                destination = (restore_dir / relative_destination).resolve()
                try:
                    destination.relative_to(restore_root)
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail="Zip bundle contains an unsafe path") from exc
                destination.parent.mkdir(parents=True, exist_ok=True)
                extracted_total += _extract_restore_member(
                    archive,
                    member,
                    destination,
                    extracted_total=extracted_total,
                )
                served_path = quote(inner_path, safe="/")
                url_mapping[inner_path] = f"/api/outputs/{rel_prefix}/{served_path}"
            succeeded = True
            return {"graph": graph, "urlMapping": url_mapping}
    except HTTPException:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, EOFError, RuntimeError, NotImplementedError) as exc:
        raise HTTPException(status_code=400, detail=f"Not a valid zip bundle: {exc}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Could not restore zip bundle assets") from exc
    finally:
        # A successful return leaves the restore tree in place. During an
        # exception, Python executes this block before propagating it.
        if restore_dir is not None and not succeeded:
            shutil.rmtree(restore_dir, ignore_errors=True)
            if timestamp_dir is not None:
                try:
                    timestamp_dir.rmdir()
                except OSError:
                    pass


async def _spool_restore_request(request: Request) -> BinaryIO:
    """Stream a restore upload into a memory-then-disk spool with a hard cap."""
    declared_length = request.headers.get("content-length")
    if declared_length is not None:
        try:
            declared = int(declared_length)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length") from exc
        if declared < 0:
            raise HTTPException(status_code=400, detail="Invalid Content-Length")
        if declared > RESTORE_MAX_COMPRESSED_BYTES:
            raise HTTPException(status_code=413, detail="Zip bundle exceeds the compressed upload limit")

    spool = tempfile.SpooledTemporaryFile(max_size=RESTORE_SPOOL_MEMORY_BYTES, mode="w+b")
    received = 0
    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            received += len(chunk)
            if received > RESTORE_MAX_COMPRESSED_BYTES:
                raise HTTPException(status_code=413, detail="Zip bundle exceeds the compressed upload limit")
            spool.write(chunk)
        if received == 0:
            raise HTTPException(status_code=400, detail="Empty request body")
        spool.seek(0)
        return spool
    except BaseException:
        spool.close()
        raise


def _validate_restore_request_headers(request: Request) -> None:
    """Reject browser-drive-by restore writes before consuming request bytes."""
    content_type = request.headers.get("content-type", "").strip().lower()
    if content_type != RESTORE_CONTENT_TYPE:
        # Nebula's own save/import path emits application/zip. Avoid accepting
        # text/plain (a CORS-safelisted type) or legacy aliases we do not need.
        raise HTTPException(
            status_code=415,
            detail="Output restore requires Content-Type: application/zip",
        )

    origin = request.headers.get("origin")
    if origin is None:
        # curl, the CLI, and other non-browser local callers do not send Origin.
        return
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Output restore origin is not allowed") from exc
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"localhost", "127.0.0.1"}
        or port is None
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise HTTPException(status_code=403, detail="Output restore origin is not allowed")


_OUTPUT_DIR_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}"
    r"(?:_\d{6}-[A-Za-z0-9_-]+-[0-9a-f]{8})?$"
)
_OUTPUTS_URL_PREFIX = "/api/outputs/"


def _safe_output_relative_path(value: str) -> Path | None:
    """Return a safe relative path under OUTPUT_ROOT, or None."""
    try:
        rel = Path(value)
        if rel.is_absolute():
            return None
        candidate = (OUTPUT_ROOT / rel).resolve()
        candidate.relative_to(OUTPUT_ROOT.resolve())
    except (OSError, ValueError):
        return None
    return rel


def _path_exists(path: Path) -> bool:
    try:
        return path.exists()
    except OSError:
        return False


def _moved_output_relative_path(value: str) -> Path | None:
    """Map stale absolute .../output/<rel> paths to the current OUTPUT_ROOT.

    This keeps persisted graph state portable across repo moves. We only accept
    the mapping when the equivalent file exists under the current OUTPUT_ROOT,
    so arbitrary external paths are not accidentally treated as local assets.
    """
    parts = Path(value).parts
    output_dir_names = {OUTPUT_ROOT.name, "output"}
    for idx in range(len(parts) - 1, -1, -1):
        if parts[idx] not in output_dir_names:
            continue
        suffix = parts[idx + 1:]
        if not suffix:
            continue
        rel = _safe_output_relative_path(str(Path(*suffix)))
        if rel is None:
            continue
        candidate = (OUTPUT_ROOT / rel).resolve()
        if _path_exists(candidate):
            return rel
    return None


def _output_relative_from_ref(value: str) -> Path | None:
    """Resolve a served URL or filesystem-ish value to OUTPUT_ROOT-relative."""
    if not value or value.startswith(("http://", "https://")):
        return None

    if value.startswith(_OUTPUTS_URL_PREFIX):
        return _safe_output_relative_path(value[len(_OUTPUTS_URL_PREFIX):])

    rel = _safe_output_relative_path(value)
    if rel is not None and _path_exists(OUTPUT_ROOT / rel):
        return rel

    try:
        candidate = Path(value).expanduser().resolve()
        return candidate.relative_to(OUTPUT_ROOT.resolve())
    except (OSError, ValueError):
        return _moved_output_relative_path(value)


def _output_path_from_ref(value: str) -> Path | None:
    rel = _output_relative_from_ref(value)
    if rel is None:
        return None
    primary = require_allowed_path(OUTPUT_ROOT / rel)
    if primary.exists():
        return primary
    # Fallback: check DEFAULT_OUTPUT_ROOT for outputs created before a relocation.
    if DEFAULT_OUTPUT_ROOT != OUTPUT_ROOT:
        try:
            candidate = require_allowed_path(DEFAULT_OUTPUT_ROOT / rel)
            candidate.relative_to(DEFAULT_OUTPUT_ROOT.resolve())  # containment check
            if candidate.exists():
                return candidate
        except (ValueError, OSError):
            pass
    return primary  # let callers handle missing-file errors normally


def _output_url_from_ref(value: str) -> str | None:
    rel = _output_relative_from_ref(value)
    if rel is None:
        return None
    return f"{_OUTPUTS_URL_PREFIX}{rel.as_posix()}"


def _normalize_output_value_for_storage(port_val: Any) -> Any:
    """Store portable /api/outputs URLs instead of absolute output paths."""
    if not isinstance(port_val, dict):
        return port_val

    value = port_val.get("value")
    normalized = _normalize_nested_output_refs_for_storage(value)
    normalized_port = port_val if normalized == value else {**port_val, "value": normalized}
    port_type = normalized_port.get("type")
    if port_type in SPATIAL_VALUE_MODELS:
        if normalized is None:
            raise ValueError(f"{port_type} output cannot be null")
        if (
            port_type == "World"
            and isinstance(normalized, dict)
            and normalized.get("schemaVersion", normalized.get("schema_version")) == 1
        ):
            normalized_port = {
                **normalized_port,
                "value": canonicalize_world_value_v1(normalized),
            }
        else:
            parsed = parse_spatial_value(str(port_type), normalized)
            normalized_port = {
                **normalized_port,
                "value": dump_spatial_value(parsed),
            }
    return normalized_port


def _normalize_nested_output_refs_for_storage(value: Any) -> Any:
    """Recursively make run-owned references portable inside structured ports.

    Most ports hold a string or list, but the versioned ``World`` port embeds
    splats, panorama, collider, and thumbnail paths several levels deep.
    External provider links (for example ``marbleUrl``) pass through because
    ``_output_url_from_ref`` only accepts paths owned by Nebula's output root.
    """
    if isinstance(value, str):
        return _output_url_from_ref(value) or value
    if isinstance(value, list):
        return [_normalize_nested_output_refs_for_storage(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_normalize_nested_output_refs_for_storage(item) for item in value)
    if isinstance(value, dict):
        return {
            key: _normalize_nested_output_refs_for_storage(item)
            for key, item in value.items()
        }
    return value


def _normalize_outputs_for_storage(outputs: dict[str, Any]) -> dict[str, Any]:
    rewritten: dict[str, Any] = {}
    for key, value in outputs.items():
        if isinstance(value, dict):
            rewritten[key] = _normalize_output_value_for_storage(value)
            continue
        if isinstance(value, str):
            url = _output_url_from_ref(value)
            if url is not None:
                rewritten[key] = {"type": "Any", "value": url}
                continue
        rewritten[key] = value
    return rewritten


_DYNAMIC_OUTPUT_DEFINITION_IDS = {
    "openrouter-universal",
    "replicate-universal",
    "fal-universal",
    "nous-portal-universal",
}


def _known_port_data_types() -> set[str]:
    return {
        str(port["dataType"])
        for definition in node_registry.get_all().values()
        for port_key in ("inputPorts", "outputPorts")
        for port in definition.get(port_key, []) or []
        if isinstance(port, dict)
        and isinstance(port.get("dataType"), str)
        and port["dataType"]
    } | set(SPATIAL_VALUE_MODELS) | {"Any"}


def _imported_output_type_is_valid(actual: str, declared: str | None) -> bool:
    if actual not in _known_port_data_types():
        return False
    if declared is None or declared == "Any":
        return True
    return actual == declared or {actual, declared} == {"Image", "Mask"}


def _validate_imported_outputs(
    definition_id: str,
    outputs: dict[str, Any],
    *,
    node_index: int,
    params: dict[str, Any] | None = None,
) -> None:
    """Reject fabricated output handles/types before staging graph state."""

    definition = node_registry.get(definition_id) or {}
    output_ports = (cinema_output_ports(params) if definition_id == "cinema-scene"
                    else definition.get("outputPorts", []) or [])
    declared_ports = {
        str(port["id"]): str(port.get("dataType") or "Any")
        for port in output_ports
        if isinstance(port, dict) and isinstance(port.get("id"), str)
    }
    handles_are_dynamic = (
        definition_id in _DYNAMIC_OUTPUT_DEFINITION_IDS and not declared_ports
    )
    for handle, port in outputs.items():
        if not isinstance(handle, str) or not handle:
            raise ValueError(f"nodes[{node_index}] has an invalid output handle")
        if not handles_are_dynamic and handle not in declared_ports:
            raise ValueError(
                f"nodes[{node_index}] output handle '{handle}' is not declared by "
                f"definition '{definition_id}'"
            )
        if not isinstance(port, dict):
            raise ValueError(f"nodes[{node_index}].outputs.{handle} must be an object")
        actual_type = port.get("type")
        if not isinstance(actual_type, str) or not actual_type:
            raise ValueError(
                f"nodes[{node_index}].outputs.{handle}.type must be a non-empty string"
            )
        declared_type = declared_ports.get(handle)
        if not _imported_output_type_is_valid(actual_type, declared_type):
            raise ValueError(
                f"nodes[{node_index}] output '{handle}' declares type {actual_type}, "
                f"but definition '{definition_id}' outputs {declared_type or 'a known dynamic type'}"
            )


def _import_external_image_to_output_root(file_path_value: str) -> tuple[Path, str] | None:
    """Copy an image referenced by an external local path into chat-uploads.

    Used when an image-input node's `filePath` points outside OUTPUT_ROOT
    (cross-project graph imports, CLI-set paths, etc.) — without this,
    the file is unreachable from the browser and the preview breaks.
    Content-hash dedup matches the `/api/uploads` flow so identical
    bytes collapse to one file on disk.

    Returns (new_local_path, served_url) when migration happens, None when
    the file is already under OUTPUT_ROOT, missing, too large, or not a
    recognized image format. None means "leave params untouched".
    """
    if not file_path_value:
        return None
    if is_remote_or_data_uri(file_path_value):
        return None
    src = require_allowed_path(file_path_value)
    try:
        src_resolved = src.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    try:
        src_resolved.relative_to(OUTPUT_ROOT.resolve())
        return None  # Already inside OUTPUT_ROOT — caller's existing logic handles it.
    except ValueError:
        pass
    try:
        if src_resolved.stat().st_size > MAX_CHAT_UPLOAD_BYTES:
            return None
        data = src_resolved.read_bytes()
    except OSError:
        return None
    sniffed = _sniff_image_type(data[:16])
    if sniffed is None:
        return None
    _, ext = sniffed
    digest = hashlib.sha256(data).hexdigest()
    saved_path = require_allowed_path(CHAT_UPLOADS_DIR / f"{digest}{ext}")
    if not saved_path.exists():
        saved_path.write_bytes(data)
    return saved_path.resolve(), f"/api/outputs/chat-uploads/{saved_path.name}"


_PRESET_THUMBNAIL_URL_RE = re.compile(r"^/api/presets/thumbnails/([a-z0-9-]{1,64})$")


def _preset_thumbnail_path_from_ref(value: str) -> Path | None:
    """Map a shipped preset thumbnail URL to its on-disk .webp path."""
    match = _PRESET_THUMBNAIL_URL_RE.match(value.strip())
    if not match:
        return None
    thumbnails_dir = (Path(__file__).resolve().parent / "data" / "presets" / "thumbnails").resolve()
    path = (thumbnails_dir / f"{match.group(1)}.webp").resolve()
    try:
        path.relative_to(thumbnails_dir)
    except ValueError:
        return None
    return path if path.is_file() else None


def _normalize_image_input_params(params: dict[str, Any]) -> dict[str, Any]:
    """Normalize image-input file paths after repo/output-root moves."""
    validate_file_references(params)
    rewritten = dict(params)

    for key in ("filePath", "file"):
        value = rewritten.get(key)
        if not isinstance(value, str) or not value:
            continue
        local_path = _output_path_from_ref(value)
        url = _output_url_from_ref(value)
        if key == "filePath" and local_path is not None:
            rewritten[key] = str(local_path)
        elif key == "file" and url is not None:
            rewritten[key] = url

    # If filePath still points outside OUTPUT_ROOT (cross-project ref or
    # CLI-set path), auto-import the file so the browser can preview it
    # via /api/outputs and downstream nodes see a URL-resolvable value.
    file_path = rewritten.get("filePath")
    if isinstance(file_path, str) and file_path:
        imported = _import_external_image_to_output_root(file_path)
        if imported is not None:
            new_path, new_url = imported
            rewritten["filePath"] = str(new_path)
            rewritten["_previewUrl"] = new_url

    # Preset thumbnails only populate _previewUrl in the UI — resolve to a
    # local filePath so execution can read the bytes (mask-painter, inpaint, etc.).
    if not rewritten.get("filePath"):
        preview = rewritten.get("_previewUrl")
        if isinstance(preview, str) and preview:
            preset_path = _preset_thumbnail_path_from_ref(preview)
            if preset_path is not None:
                rewritten["filePath"] = str(preset_path)

    preview = rewritten.get("_previewUrl")
    if isinstance(preview, str) and preview:
        preview_url = _output_url_from_ref(preview)
        if preview_url is not None:
            rewritten["_previewUrl"] = preview_url

    if not rewritten.get("_previewUrl"):
        for key in ("filePath", "file"):
            value = rewritten.get(key)
            if not isinstance(value, str) or not value:
                continue
            preview_url = _output_url_from_ref(value)
            if preview_url is not None:
                rewritten["_previewUrl"] = preview_url
                break

    return rewritten


def _substitute_output_paths(outputs: dict[str, Any], mapping: dict[str, str]) -> tuple[dict[str, Any], bool]:
    """Rewrite stale absolute paths in port outputs to their migrated targets.

    Returns (new_outputs, changed). Used after image-input migration so
    downstream nodes (Router, etc.) whose cached outputs still reference
    the pre-migration path get updated in lock-step.
    """
    rewritten: dict[str, Any] = {}
    changed = False
    for key, port_val in outputs.items():
        if isinstance(port_val, dict):
            value = port_val.get("value")
            substituted = _substitute_nested_output_paths(value, mapping)
            if substituted != value:
                rewritten[key] = {**port_val, "value": substituted}
                changed = True
                continue
        rewritten[key] = port_val
    return rewritten, changed


def _substitute_nested_output_paths(value: Any, mapping: dict[str, str]) -> Any:
    """Apply graph-import path migration inside structured output values."""
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [_substitute_nested_output_paths(item, mapping) for item in value]
    if isinstance(value, tuple):
        return tuple(_substitute_nested_output_paths(item, mapping) for item in value)
    if isinstance(value, dict):
        return {
            key: _substitute_nested_output_paths(item, mapping)
            for key, item in value.items()
        }
    return value


def _normalize_cli_graph_output_refs() -> None:
    """Migrate in-memory CLI graph refs to the current output root."""
    changed = False
    path_substitutions: dict[str, str] = {}

    for node in cli_graph.nodes.values():
        if node.get("definitionId") == "image-input":
            old_params = node.get("params", {}) or {}
            old_file_path = old_params.get("filePath") if isinstance(old_params.get("filePath"), str) else None
            params = _normalize_image_input_params(old_params)
            if params != old_params:
                node["params"] = params
                changed = True
                new_file_path = params.get("filePath") if isinstance(params.get("filePath"), str) else None
                if old_file_path and new_file_path and old_file_path != new_file_path:
                    path_substitutions[old_file_path] = new_file_path

    if path_substitutions:
        for node in cli_graph.nodes.values():
            outputs = node.get("outputs")
            if not isinstance(outputs, dict):
                continue
            new_outputs, sub_changed = _substitute_output_paths(outputs, path_substitutions)
            if sub_changed:
                node["outputs"] = new_outputs
                changed = True

    for node in cli_graph.nodes.values():
        outputs = node.get("outputs")
        if isinstance(outputs, dict):
            normalized_outputs = _normalize_outputs_for_storage(outputs)
            if normalized_outputs != outputs:
                node["outputs"] = normalized_outputs
                changed = True

    if changed:
        cli_graph._maybe_persist()


def _normalize_execute_nodes(nodes: list[GraphNode]) -> list[GraphNode]:
    """Normalize request-scoped nodes before validation/execution."""
    normalized: list[GraphNode] = []
    for node in nodes:
        if node.definition_id == "image-input":
            normalized.append(
                node.model_copy(update={"params": _normalize_image_input_params(node.params)})
            )
        else:
            normalized.append(node)
    return normalized


@app.post("/api/outputs/archive")
async def archive_outputs(older_than_days: int = 30) -> dict:
    """Move `output/YYYY-MM-DD_*` directories older than `older_than_days`
    to `output/.archive/`. Explicit-only — the backend NEVER runs this on
    its own. Nothing is deleted; archived directories can be moved back
    manually if needed.

    Only directories matching the canonical timestamp pattern are considered.
    chat-uploads, .archive, restored-* subfolders, and any ad-hoc directory
    are left untouched regardless of age."""
    import shutil
    import time

    if older_than_days < 0:
        raise HTTPException(status_code=400, detail="older_than_days must be >= 0")

    cutoff = time.time() - older_than_days * 86400
    archive_root = OUTPUT_ROOT / ".archive"
    archive_root.mkdir(parents=True, exist_ok=True)
    archived: list[str] = []

    for entry in OUTPUT_ROOT.iterdir():
        if not entry.is_dir():
            continue
        if not _OUTPUT_DIR_PATTERN.match(entry.name):
            continue  # chat-uploads, .archive, restored-*, etc. never archived
        try:
            if entry.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        dest = archive_root / entry.name
        if dest.exists():
            # Don't clobber an existing archive slot — append a uuid suffix.
            from uuid import uuid4
            dest = archive_root / f"{entry.name}-{uuid4().hex[:6]}"
        shutil.move(str(entry), str(dest))
        archived.append(entry.name)

    return {"archived": archived, "archive_dir": str(archive_root)}


@app.post("/api/outputs/restore")
async def restore_outputs(request: Request) -> dict:
    """Bound, validate, and restore a complete .nebula.zip atomically.

    The browser does not inflate graph.json. This endpoint returns the parsed
    graph with the old-path → served-URL mapping only after both graph
    validation and asset extraction succeed.
    """
    _reject_graph_replacement_during_paid_start("restore a graph bundle")
    _validate_restore_request_headers(request)
    spool = await _spool_restore_request(request)
    try:
        return await asyncio.to_thread(_restore_zip_bundle, spool)
    finally:
        spool.close()

_SUPPORTED_IMAGE_TYPES = {
    b"\x89PNG\r\n\x1a\n": ("image/png", ".png"),
    b"\xff\xd8\xff": ("image/jpeg", ".jpg"),
    b"GIF87a": ("image/gif", ".gif"),
    b"GIF89a": ("image/gif", ".gif"),
}

MAX_CHAT_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB
MAX_VIDEO_UPLOAD_BYTES = 500 * 1024 * 1024  # 500 MB


def _sniff_image_type(data: bytes) -> tuple[str, str] | None:
    """Return (mime, ext) if *data* starts with a supported image signature.

    Also handles WebP (RIFF....WEBP). Returns None for anything else so the
    caller can reject with 415.
    """
    for sig, pair in _SUPPORTED_IMAGE_TYPES.items():
        if data.startswith(sig):
            return pair
    # WebP has a variable prefix: "RIFF" then 4 size bytes then "WEBP".
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ("image/webp", ".webp")
    return None


def _sniff_video_type(data: bytes) -> tuple[str, str] | None:
    """Return (mime, ext) if *data* matches a supported video container.

    Detects:
    - MP4 / MOV / M4V: ISO base media file format — bytes 4-8 == b"ftyp"
    - WebM: EBML/Matroska header — bytes 0-4 == b"\\x1a\\x45\\xdf\\xa3"

    Returns None for anything else.
    """
    if len(data) >= 8 and data[4:8] == b"ftyp":
        return ("video/mp4", ".mp4")
    if len(data) >= 4 and data[:4] == b"\x1a\x45\xdf\xa3":
        return ("video/webm", ".webm")
    return None


_DOC_TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".json", ".log", ".rst", ".tsv"}


def _sniff_document_type(data: bytes, filename: str | None) -> tuple[str, str] | None:
    """Return (mime, ext) for a Document Input upload: PDF by magic bytes, or a
    plain-text format by filename extension (text has no signature). Else None."""
    if data[:5] == b"%PDF-":
        return ("application/pdf", ".pdf")
    ext = Path(filename or "").suffix.lower()
    if ext in _DOC_TEXT_EXTS:
        return ("text/plain", ext)
    return None


# Run after _sniff_image_type / MAX_CHAT_UPLOAD_BYTES are defined — the
# image-input normalizer now auto-imports external files and needs both.
_normalize_cli_graph_output_refs()


app.include_router(openrouter_router)
app.include_router(replicate_router)
app.include_router(fal_router)
app.include_router(nous_router)
app.include_router(quiver_router)
app.include_router(video_edit_preview_router)
app.include_router(render_exports_router)
from services.paper_routes import router as paper_router
app.include_router(paper_router)
app.include_router(commons_router)


@app.on_event("startup")
async def _commons_startup() -> None:
    """Initialize human authority before serving, then scan linked folders."""
    from commons.activation import is_enabled
    if not is_enabled():
        return
    from commons.ui_auth import initialize_ui_session

    initialize_ui_session(commons_actors.ui_session)
    if os.environ.get("NEBULA_COMMONS_NO_STARTUP_SCAN") == "1":
        return
    from commons import folders as commons_folders, records as commons_records, review as commons_review, runtime as commons_runtime

    store = commons_runtime.get_store()
    await asyncio.to_thread(commons_records.requeue_stale_analyzing, store)
    await asyncio.to_thread(commons_review.fail_interrupted, store)
    for link in store.list_folder_links():
        commons_runtime.spawn(commons_folders.scan_and_fetch(store, link["id"],
                                                             downloader=commons_runtime.get_downloader()))


@app.post("/api/uploads")
async def upload_file_consolidated(
    file: UploadFile,
    create_node: str = Form("false"),
) -> dict:
    """Accept an image or video upload with strict validation and content-hash dedup.

    Routes by magic bytes: PNG/JPEG/GIF/WebP → image-input node; MP4/MOV/WebM
    → video-input node (with ffprobe-derived private source metadata stored on
    the node's params so the editor surface can read source metadata
    without waiting for the edit handler to run).

    When `create_node` is truthy, atomically creates the routed node in
    cli_graph and broadcasts graphSync. When absent or falsy, returns only
    the upload metadata so callers can handle node creation themselves (or
    use the URL for an existing node).

    Probe failure on a video that passed the magic-byte sniff deletes the
    just-written file (unless it pre-existed via content-hash dedup) and
    returns 415. A graphSync broadcast failure after node creation rolls the
    node back out of cli_graph and returns 500. Pre-write rejections (oversize,
    unsupported bytes, too small) never touch disk, graph, or the broadcast.

    Supersedes the deprecated /api/upload and /api/chat/uploads endpoints;
    both shapes of caller can migrate to this one.
    """
    content = await file.read()
    # Reject anything that cannot possibly be an accepted file before sniffing.
    # Images are capped at MAX_CHAT_UPLOAD_BYTES; videos at MAX_VIDEO_UPLOAD_BYTES.
    # Check the tighter image cap first so oversized non-video uploads get 413
    # without needing valid magic bytes (preserves legacy test expectations).
    if len(content) > MAX_VIDEO_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 500 MB limit")
    # 12-byte minimum is for image/video magic-byte sniffing (WebP needs 12).
    # Text documents have no magic bytes, so a short .txt/.csv must bypass it.
    if len(content) < 12 and _sniff_document_type(content[:8], file.filename) is None:
        raise HTTPException(status_code=415, detail="File is too small to be a valid media file")

    image_sniffed = _sniff_image_type(content[:16])
    video_sniffed = _sniff_video_type(content[:16]) if image_sniffed is None else None

    if image_sniffed is not None:
        if len(content) > MAX_CHAT_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Image exceeds 20 MB limit")
        _, ext = image_sniffed
        node_type = "image-input"
    elif video_sniffed is not None:
        # Size already validated against MAX_VIDEO_UPLOAD_BYTES above.
        _, ext = video_sniffed
        node_type = "video-input"
    elif (doc_sniffed := _sniff_document_type(content[:8], file.filename)) is not None:
        if len(content) > MAX_CHAT_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Document exceeds 20 MB limit")
        _, ext = doc_sniffed
        node_type = "document-input"
    else:
        # Neither image, video, nor document — but within the size budget. Check
        # the image cap for a better error, else reject.
        if len(content) > MAX_CHAT_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Image exceeds 20 MB limit")
        raise HTTPException(status_code=415, detail="Only image, video, or document (PDF/text) files are accepted")

    digest = hashlib.sha256(content).hexdigest()
    saved_path = require_allowed_path(CHAT_UPLOADS_DIR / f"{digest}{ext}")
    # Track whether THIS request created the file: content-hash dedup means the
    # file may already exist from an earlier upload, in which case a later
    # failure must NOT delete it (other nodes/requests may reference it).
    file_created = not saved_path.exists()
    if file_created:
        # Dedup by content hash: identical bytes collapse to one file on disk.
        # Concurrent write-after-write writes the same bytes and is benign.
        saved_path.write_bytes(content)

    url = f"/api/outputs/chat-uploads/{saved_path.name}"
    filename = file.filename or f"{digest}{ext}"

    # Base response — present for every caller.
    response: dict[str, Any] = {
        "url": url,
        "filePath": str(saved_path.resolve()),
        "filename": filename,
    }

    # Opt-in node creation: parse create_node laxly so any reasonable truthy
    # string works (supports callers composing forms in different tools).
    if create_node.strip().lower() in ("true", "1", "yes"):
        positions = [n.get("position", {}) for n in cli_graph.nodes.values()]
        max_x = max((p.get("x", 0) for p in positions), default=-300)
        new_position = {"x": float(max_x) + 300.0, "y": 100.0}

        if node_type in ("image-input", "document-input"):
            # filePath is the absolute local path (handlers open() this), _previewUrl
            # is the served URL. Document Input ignores the preview (no <img>) but
            # the shape is harmless and matches the Inspector upload.
            node_params = {"filePath": str(saved_path.resolve()), "_previewUrl": url}
        else:
            # video-input: probe at upload so the source owns its own
            # metadata. Downstream consumers (editor surface, edit handler,
            # inspector) can read the private source metadata from params
            # without re-probing. Editor initial-clip seeding depends
            # on this — without it the editor opens degraded with 0 clips.
            try:
                probe = await ffprobe_video(saved_path)
            except Exception as exc:
                # Transactional cleanup: an unprobeable video is useless, so
                # remove the file this request just wrote — but ONLY if this
                # request created it. A deduplicated pre-existing file may be
                # referenced by other nodes and must survive. Catch any probe
                # exception, not just the nominal ffprobe error type.
                if file_created:
                    try:
                        saved_path.unlink(missing_ok=True)
                    except OSError:
                        pass  # best-effort cleanup; the 415 still stands
                raise HTTPException(
                    status_code=415,
                    detail=f"Could not probe video metadata: {exc}",
                ) from exc
            node_params = {
                "filePath": str(saved_path.resolve()),
                "_sourceDuration": probe.duration,
                "_sourceFps": probe.fps,
                "_sourceIsVfr": probe.is_vfr,
            }
            response["sourceDuration"] = probe.duration
            response["sourceFps"] = probe.fps
            response["sourceIsVfr"] = probe.is_vfr

        node_id = cli_graph.add_node(node_type, node_params, position=new_position)
        try:
            await _broadcast_graph_sync()
        except Exception as exc:
            # Roll back the graph mutation so a failed broadcast doesn't leave
            # a node the frontend never heard about. Removal is best-effort —
            # even if it errors, the caller still gets an error response with
            # no success fields. The uploaded file stays on disk (it is a
            # valid, content-addressed artifact, same as a create_node=false
            # upload); only the graph mutation is rolled back.
            try:
                cli_graph.remove_node(node_id)
            except Exception:
                pass
            raise HTTPException(
                status_code=500,
                detail=f"Upload succeeded but graph sync failed: {exc}",
            ) from exc
        response["nodeId"] = node_id
        if node_type == "image-input":
            response["thumbUrl"] = url

    return response


@app.get("/api/convert-to-glb")
async def convert_to_glb(path: str) -> Any:
    """Convert a non-GLB 3D file to GLB for preview. Caches the result."""
    import trimesh

    # Dual-root resolution: prefer OUTPUT_ROOT, fall back to DEFAULT_OUTPUT_ROOT
    # so assets created before a relocation remain accessible.
    source_path: Path | None = None
    for root in (OUTPUT_ROOT, DEFAULT_OUTPUT_ROOT) if DEFAULT_OUTPUT_ROOT != OUTPUT_ROOT else (OUTPUT_ROOT,):
        try:
            candidate = require_allowed_path(root / path)
            candidate.relative_to(root.resolve())  # containment — block ../ traversal
        except (ValueError, OSError):
            continue
        if candidate.exists():
            source_path = candidate
            break

    if source_path is None:
        raise HTTPException(status_code=404, detail="Source file not found")

    # If already GLB, serve directly
    if source_path.suffix.lower() == ".glb":
        return FileResponse(str(source_path), media_type="model/gltf-binary")

    # Check for cached conversion
    preview_path = require_allowed_path(source_path.with_suffix(".preview.glb"))
    if preview_path.exists():
        return FileResponse(str(preview_path), media_type="model/gltf-binary")

    # Convert to GLB using trimesh
    try:
        from services.mesh_input import ProtectedFileResolver
        mesh = trimesh.load(str(source_path), resolver=ProtectedFileResolver(source_path))
        mesh.export(str(preview_path), file_type="glb")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Conversion failed: {exc}")

    return FileResponse(str(preview_path), media_type="model/gltf-binary")


# ---------- WebSocket connection manager ----------

def _websocket_is_browser(websocket: WebSocket) -> bool:
    """True for the person's canvas: an allowed browser Origin, or the desktop session.

    Browsers always send Origin on a WebSocket handshake; the CLI and MCP
    don't. The packaged desktop renderer may send `Origin: null`, so in
    desktop mode the per-launch connector session (query param) counts too.
    Browser-only messages (proposal accept keys) go only to these sockets.
    """
    try:
        if desktop_session_matches(websocket.query_params.get("connectorSession")):
            return True
        origin = websocket.headers.get("origin")
    except Exception:  # noqa: BLE001 - a malformed handshake is simply not a browser
        return False
    return origin is not None and origin_allowed(origin)


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []
        self.browser_connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)
        if _websocket_is_browser(websocket):
            self.browser_connections.add(websocket)

    def is_browser(self, websocket: WebSocket) -> bool:
        return websocket in self.browser_connections

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        self.browser_connections.discard(websocket)

    async def broadcast(self, event: ExecutionEvent) -> None:
        data = _event_to_camel(event)
        data.update(_execution_workspace_context.get() or _workspace_context())
        await self.broadcast_raw(data)

    async def broadcast_raw(self, data: dict[str, Any]) -> None:
        message = json.dumps(data)
        disconnected: list[WebSocket] = []
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)

    async def broadcast_browser(self, data: dict[str, Any]) -> None:
        """Send only to the person's canvas sockets (never to CLI/MCP listeners)."""
        message = json.dumps(data)
        disconnected: list[WebSocket] = []
        for connection in list(self.browser_connections):
            try:
                await connection.send_text(message)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)


manager = ConnectionManager()


def _try_compact_execution_cancellation(run_id: str) -> bool:
    """Move an exact Stop record into permanent-deny storage when safe."""
    try:
        provider_start_guard.acknowledge_cancel_intent(run_id)
    except (ProviderStartConflictError, ProviderStartPersistenceError, ValueError):
        return False
    # The exact record may already have been compacted by another worker. The
    # durable filter is authoritative, so local inspection capacity is safe to
    # release either way.
    execution_runs.compact_cancel_intent(run_id)
    return True


def _publish_terminal_execution_status(run_id: str, status: str) -> None:
    """Push authoritative terminal state after the task done callback settles."""
    canvas_events.forget_run(run_id)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    async def settle_and_publish() -> None:
        # A task cancelled before its coroutine receives its first event-loop
        # turn never enters the route-level ``finally``. This idempotent release
        # closes that admission lease before announcing terminal state.
        await _release_paid_worldlabs_starts(run_id)
        # Exact Stop records are useful only until terminal settlement. Compact
        # every visible record into the durable permanent-deny filter here;
        # this also cleans an unknown Stop that initially raced an unrelated
        # paid lifecycle on another backend worker.
        compacted = False
        for cancelled_run_id in provider_start_guard.list_cancel_intents():
            compacted = (
                _try_compact_execution_cancellation(cancelled_run_id)
                or compacted
            )
        if compacted:
            await _broadcast_graph_sync()
        await manager.broadcast_raw(
            {
                **(_execution_workspace_context.get() or _workspace_context()),
                "type": "executionStatus",
                "runId": run_id,
                "status": status,
            }
        )

    loop.create_task(settle_and_publish())


execution_runs.set_terminal_callback(_publish_terminal_execution_status)


def _snake_to_camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _event_to_camel(event: ExecutionEvent) -> dict[str, Any]:
    raw = event.model_dump()
    run_id = raw.get("run_id") or execution_run_id.get()
    if run_id is None:
        raw.pop("run_id", None)
    else:
        raw["run_id"] = run_id
    result: dict[str, Any] = {}
    for key, value in raw.items():
        camel = _snake_to_camel(key)
        # Also camelize the "type" value (e.g. "graph_complete" → "graphComplete")
        if key == "type" and isinstance(value, str):
            result[camel] = _snake_to_camel(value)
        elif camel == "nodeId" and isinstance(value, str):
            result["nodeId"] = value
        elif camel == "nodesExecuted":
            result["nodesExecuted"] = value
        else:
            result[camel] = value
        if key == "errors" and isinstance(value, list):
            result["errors"] = [
                {
                    "nodeId": e.get("node_id", e.get("nodeId", "")),
                    "portId": e.get("port_id", e.get("portId", "")),
                    "message": e.get("message", ""),
                }
                for e in value
            ]
    return result


def _validation_response(errors: list[ValidationErrorDetail]) -> dict[str, Any]:
    """Keep REST validation details aligned with the WebSocket event shape."""
    return {
        "status": "validation_error",
        "errorCount": len(errors),
        "errors": [
            {
                "nodeId": error.node_id,
                "portId": error.port_id,
                "message": error.message,
            }
            for error in errors
        ],
    }


# ---------- WebSocket endpoint ----------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        # Events emitted while a browser is disconnected are not replayed.
        # Reconnect therefore starts with an authoritative graph, provider
        # safety journal, and retained execution-status snapshot.
        export = await export_graph_for_frontend()
        await websocket.send_text(json.dumps({"type": "graphSync", **export}))
        await websocket.send_text(json.dumps(_pins_message()))
        if manager.is_browser(websocket):
            # Accept keys travel only to the person's canvas sockets.
            await websocket.send_text(json.dumps({
                "type": "proposalSync",
                "proposals": [
                    {**_proposal_view(p), "acceptKey": p.accept_key,
                     "personValues": canvas_proposals.person_values(p)}
                    for p in canvas_proposals.open_list()
                ],
            }))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# ---------- Chat WebSocket (/ws/chat) ----------

@app.websocket("/ws/chat")
async def chat_websocket(websocket: WebSocket) -> None:
    """Chat WebSocket — one message per turn, streams agent output.

    Client sends: {
        type: "send",
        message: str,
        sessionId: str|null (opaque Claude/Codex conversation ID),
        commonsToken: str (human UI token, required only with Commons enabled),
        brand: str|null (Commons-enabled Claude/Codex turns),
        model: str|null,
        effort: str|null (model-specific effort, Claude/Codex),
        agent: "claude" | "daedalus" | "codex" (default "claude"),
        autonomy: "auto" | "step" (default "auto", daedalus-only)
    }
    Server sends events matching AGENT_RUNNERS' event contract.
    """
    from services.chat_session import AGENT_RUNNERS
    from services.chat_actions import register_action_handler, unregister_action_handler
    from services.chat_models import ChatModelSelectionError, validate_chat_model_selection

    await websocket.accept()
    server_host, server_port = websocket.scope.get("server") or ("127.0.0.1", 8000)
    backend_url = f"http://{server_host}:{server_port}"
    current_task: asyncio.Task[None] | None = None
    current_agent: str | None = None
    current_finished: asyncio.Event | None = None
    send_lock = asyncio.Lock()

    async def send_event(event: dict[str, Any]) -> None:
        """Serialize every chat WebSocket write, including cancellation acks."""
        async with send_lock:
            await websocket.send_text(json.dumps(event))

    def _event_source(agent: str) -> str:
        return agent if agent in {"claude", "codex", "daedalus"} else "system"

    async def stream_response(
        message: str,
        session_id: str | None,
        model: Any,
        agent: str,
        autonomy: str,
        provider: str | None,
        turn_selection_context: str,
        effort: Any,
        brand: str | None,
        finished: asyncio.Event,
    ) -> None:
        # Single outbound queue so every send path (agent events + canvas-
        # action events from the graph API) is serialized through one drainer
        # task — WebSocket.send_text is not safe to call from two tasks at
        # once.
        outbound: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        source = _event_source(agent)

        def enqueue(event: dict[str, Any]) -> None:
            sourced_event = dict(event)
            # The selected backend runner is authoritative. Never trust a
            # stale or hostile source field supplied by runner output.
            sourced_event["source"] = source
            outbound.put_nowait(sourced_event)

        async def drain() -> None:
            while True:
                event = await outbound.get()
                if event is None:
                    return
                try:
                    await send_event(event)
                except Exception:
                    return

        drainer = asyncio.create_task(drain())
        # Graph mutation routes publish thinking events via chat_actions —
        # register the enqueuer so they flow through the same outbound queue
        # as the agent's own events.
        register_action_handler(enqueue)
        workspace_session = None
        agent_token = None
        terminal_done = None

        try:
            runner = AGENT_RUNNERS.get(agent)
            if runner is None:
                enqueue({
                    "type": "error",
                    "message": f"Unknown agent '{agent}'. Valid: {sorted(AGENT_RUNNERS.keys())}",
                })
                enqueue({"type": "done"})
                return

            try:
                catalog_validated = False
                if agent in {"claude", "codex"}:
                    if model is not None or effort is not None:
                        # Keep discovery in the tracked task so Stop/disconnect
                        # can cancel it before granting turn authority.
                        model, effort = await validate_chat_model_selection(agent, model, effort)
                        catalog_validated = True
                    else:
                        # Preserve defaults for legacy clients that send no
                        # picker choice. The picker always supplies a model ID.
                        model = "claude-sonnet-4-6" if agent == "claude" else ""
                else:
                    model = str(model) if model else ""
                runner_kwargs = {"provider": provider, "selection_context": turn_selection_context}
                if agent in {"claude", "codex"}:
                    workspace_session = workspace_sessions.acquire(_STATE_DIR, agent, brand, session_id)
                    workdir = workspace_session.workspace
                    read_grants = agent_read_grants(output_root=OUTPUT_ROOT, workdir=workdir,
                                                    protected=protected_agent_dirs())
                    agent_token = commons_actors.agent_registry.mint(
                        agent, [OUTPUT_ROOT, workdir], brand=workspace_session.brand, workspace=workdir)
                    if model:
                        commons_actors.agent_registry.set_model(agent_token, model)
                    runner_kwargs.update(effort=effort, catalog_validated=catalog_validated,
                                         backend_url=backend_url, extra_dirs=read_grants,
                                         workdir=workdir, agent_token=agent_token)
                    runner_session = workspace_session.provider_session_id
                else:
                    runner_session = session_id
                with workspace_scope(workspace_session.workspace if workspace_session else None):
                    agen = runner(message, runner_session, model, autonomy, **runner_kwargs)
                    async with aclosing(agen):
                        async for event in agen:
                            task = asyncio.current_task()
                            if task is not None and task.cancelling():
                                # Confirm cancellation only after process cleanup and capability revocation.
                                raise asyncio.CancelledError
                            if event.get("type") == "done":
                                terminal_done = event
                                continue
                            if workspace_session is not None and event.get("type") == "session":
                                workspace_sessions.bind_provider(workspace_session, event.get("sessionId"))
                                if event.get("model") and agent_token:
                                    commons_actors.agent_registry.set_model(agent_token, str(event["model"]))
                                event = {**event, "sessionId": workspace_session.id, "brand": workspace_session.brand}
                            enqueue(event)
            except ChatModelSelectionError as exc:
                task = asyncio.current_task()
                if task is not None and task.cancelling():
                    raise
                enqueue({"type": "error", "code": exc.code, "message": str(exc)})
                terminal_done = {"type": "done"}
            except Exception as exc:
                task = asyncio.current_task()
                if task is not None and task.cancelling():
                    raise
                enqueue({"type": "error", "message": str(exc)})
                terminal_done = {"type": "done"}
        finally:
            if agent_token is not None:
                commons_actors.agent_registry.revoke(agent_token)
            if workspace_session is not None:
                workspace_sessions.release(workspace_session)
            unregister_action_handler()
            finished.set()
            if terminal_done is not None:
                enqueue(terminal_done)
            # Sentinel stops the drainer; wait for it so remaining events flush.
            outbound.put_nowait(None)
            try:
                await drainer
            except Exception:
                pass

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await send_event({"type": "error", "message": "invalid JSON", "source": "system"})
                continue

            if not isinstance(payload, dict):
                await send_event({"type": "error", "message": "message envelope must be an object", "source": "system"})
                continue

            msg_type = payload.get("type")
            if msg_type == "cancel":
                task = current_task
                if task is None or task.done():
                    await send_event({
                        "type": "cancellation",
                        "status": "failed",
                        "active": False,
                        "message": "No active response to cancel.",
                        "source": "system",
                    })
                    continue

                source = _event_source(current_agent or "system")
                await send_event({
                    "type": "cancellation",
                    "status": "requested",
                    "active": True,
                    "source": source,
                })
                accepted = task.cancel()
                if not accepted:
                    await send_event({
                        "type": "cancellation",
                        "status": "failed",
                        "active": False,
                        "message": "The response finished before cancellation was accepted.",
                        "source": source,
                    })
                    continue
                try:
                    await task
                except asyncio.CancelledError:
                    if current_task is task:
                        current_task = None
                        current_agent = None
                    await send_event({
                        "type": "cancellation",
                        "status": "confirmed",
                        "active": False,
                        "source": source,
                    })
                except Exception as exc:
                    if current_task is task:
                        current_task = None
                        current_agent = None
                    await send_event({
                        "type": "cancellation",
                        "status": "failed",
                        "active": False,
                        "message": f"Agent cleanup failed: {exc}",
                        "source": source,
                    })
                else:
                    if current_task is task:
                        current_task = None
                        current_agent = None
                    await send_event({
                        "type": "cancellation",
                        "status": "confirmed",
                        "active": False,
                        "source": source,
                    })
                continue
            if msg_type != "send":
                continue

            if current_task and not current_task.done() and current_finished is not None and current_finished.is_set():
                # Done becomes visible while send_text is still returning.
                # Cleanup has completed; settle the old drainer before admitting
                # the next turn so its handler cannot outlive the new one.
                await current_task
            if current_task and not current_task.done():
                # Reject a competing turn before validating its fields. A
                # rejected second send must never emit done for the active one.
                await send_event({
                    "type": "error",
                    "message": (
                        "Another response is active. Stop it and wait for "
                        "cancellation confirmation before sending again."
                    ),
                    "source": _event_source(current_agent or "system"),
                })
                continue

            from commons.activation import is_enabled
            commons_enabled = is_enabled()
            if commons_enabled:
                human_token = payload.get("commonsToken")
                if not isinstance(human_token, str) or not commons_actors.ui_session.verify(human_token):
                    await send_event({"type": "error", "message": "No current UI session: use the Commons dev link before starting a private reference turn.", "source": "system"})
                    await send_event({"type": "done", "source": "system"})
                    continue
            user_message = payload.get("message", "")
            if not isinstance(user_message, str):
                await send_event({"type": "error", "message": "message must be text.", "source": "system"})
                continue
            session_id = payload.get("sessionId") or None
            agent_raw = payload.get("agent")
            agent = "claude" if agent_raw is None else agent_raw
            if not isinstance(agent, str) or not agent.strip():
                await send_event({"type": "error", "code": "agent_invalid", "message": "agent must be text and a nonempty agent identifier.", "source": "system"})
                await send_event({"type": "done", "source": "system"})
                continue
            if commons_enabled and agent not in {"claude", "codex"}:
                await send_event({"type": "error", "message": "Commons private reference turns support Claude and Codex; disable Commons to use Daedalus.", "source": "system"})
                await send_event({"type": "done", "source": "system"})
                continue
            model_raw = payload.get("model")
            autonomy = payload.get("autonomy") or "auto"
            # Optional per-turn provider override (e.g. "nous" / "openrouter").
            # When omitted, the runner falls back to its default provider.
            provider_raw = payload.get("provider")
            provider = str(provider_raw) if provider_raw else None
            selected_ids_raw = payload.get("selectedNodeIds")
            if selected_ids_raw is not None and not isinstance(selected_ids_raw, list):
                await send_event({
                    "type": "error",
                    "message": "selectedNodeIds must be an array of node IDs.",
                    "source": "system",
                })
                continue
            selection_snapshot = selection_context.snapshot(
                cli_graph,
                node_registry,
                requested_ids=selected_ids_raw,
            )
            turn_selection_context = selection_prompt_context(selection_snapshot)
            if not user_message.strip():
                continue

            effort = payload.get("effort")
            if agent in {"claude", "codex"} and provider_raw is not None:
                await send_event({"type": "error", "code": "provider_invalid", "message": "Claude and Codex use their local official CLI provider; provider overrides are only available for Daedalus.", "source": agent})
                await send_event({"type": "done", "source": agent})
                continue

            current_finished = asyncio.Event()
            current_task = asyncio.create_task(
                stream_response(
                    user_message,
                    session_id,
                    model_raw,
                    agent,
                    autonomy,
                    provider,
                    turn_selection_context,
                    effort,
                    payload.get("brand") if commons_enabled else None,
                    current_finished,
                )
            )
            current_agent = agent
    except WebSocketDisconnect:
        pass
    finally:
        if current_task and not current_task.done():
            current_task.cancel()
            try:
                await current_task
            except (asyncio.CancelledError, Exception):
                pass


# ---------- REST endpoints ----------

@app.get("/api/capabilities/commons")
async def commons_capabilities() -> dict[str, Any]:
    """Discover opt-in without initializing authority, storage or workers."""
    from commons.activation import is_enabled
    return {"enabled": is_enabled(), "scopedAgents": ["claude", "codex"]}


@app.get("/api/agent/context")
async def agent_context(request: Request) -> dict[str, Any]:
    """Resolve a private workspace only through a current backend capability."""
    try:
        actor = commons_actors.resolve_actor(request.headers)
    except commons_actors.AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    if not actor.is_agent or actor.workspace is None:
        raise HTTPException(status_code=401, detail="A scoped agent turn is required")
    return {"workspace": str(actor.workspace), "brand": actor.brand}

@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "app": "nebula", "version": "0.1.0"}


@app.get("/api/capabilities/worldlabs")
async def get_worldlabs_capabilities() -> dict[str, Any]:
    """Describe World Labs support without credentials or provider traffic."""
    return worldlabs_capability_gate.manifest()


@app.get("/api/canvas/selection")
async def get_canvas_selection() -> dict[str, Any]:
    """Return the live, bounded canvas selection for CLI/MCP agents."""
    return selection_context.snapshot(cli_graph, node_registry)


@app.post("/api/canvas/selection")
async def set_canvas_selection(body: dict[str, Any]) -> dict[str, Any]:
    """Publish ephemeral selected IDs; authoritative node data stays server-side."""
    node_ids = body.get("nodeIds")
    if not isinstance(node_ids, list):
        raise HTTPException(status_code=422, detail="nodeIds must be an array")
    if len(node_ids) > 200:
        raise HTTPException(status_code=422, detail="nodeIds supports at most 200 entries")
    before = set(selection_context.current())
    snapshot = selection_context.snapshot(
        cli_graph,
        node_registry,
        requested_ids=node_ids,
    )
    after = selection_context.current()
    if set(after) != before:
        live = [node_id for node_id in after if node_id in cli_graph.nodes]
        _journal(
            "selection.changed",
            data={"nodeIds": live[:50], "count": len(live)},
            summary=f"selected {_listed(live)}" if live else "cleared the selection",
        )
    return snapshot


async def _show_agent(
    target: dict[str, Any],
    *,
    action: str = "click",
    say: str = "",
    origin: dict[str, Any] | None = None,
) -> None:
    """Move the calling agent's cursor; a no-op for the browser's own requests.

    Never fails the route that called it: presence is decoration on top of
    an edit that already succeeded.
    """
    identity = identify_agent(current_request_headers())
    if identity is None:
        return
    try:
        event = agent_presence.point(identity, target=target, origin=origin, action=action, say=say)
        await manager.broadcast_raw(event)
    except Exception:  # noqa: BLE001 - decoration must not break graph edits
        pass


def _journal(
    kind: str,
    *,
    node_id: str | None = None,
    data: dict[str, Any] | None = None,
    summary: str = "",
    actor: dict[str, Any] | None = None,
) -> None:
    """Record a canvas change for `nebula watch`; never fails the route that called it.

    The actor defaults to whoever sent the current request (agent, person or
    anonymous). Like presence, the journal is decoration on top of an edit
    that already succeeded.
    """
    try:
        if not canvas_events.project_known:
            canvas_events.set_project(_workspace_context()["activeProjectId"])
        canvas_events.publish(
            kind,
            actor=actor or actor_for_headers(current_request_headers()),
            node_id=node_id,
            data=data,
            summary=summary,
        )
    except Exception:  # noqa: BLE001 - the journal is decoration, like presence
        pass


def _edge_data(edge: dict[str, Any]) -> dict[str, Any]:
    return {key: edge.get(key) for key in ("source", "sourceHandle", "target", "targetHandle")}


def _listed(ids: list[str], limit: int = 6) -> str:
    shown = ", ".join(ids[:limit])
    return shown + (f" and {len(ids) - limit} more" if len(ids) > limit else "")


_RUN_EVENT_KINDS: dict[type, str] = {
    ExecutingEvent: "run.started",
    ExecutedEvent: "run.finished",
    ErrorEvent: "run.failed",
}
_RUN_EVENT_VERBS = {"run.started": "started", "run.finished": "finished", "run.failed": "failed"}


def _journal_execution_event(event: Any, run_id: str | None) -> None:
    """Journal one node's run start/finish/failure, attributed to whoever started the run."""
    try:
        kind = _RUN_EVENT_KINDS.get(type(event))
        if kind is None:
            return
        node_id = getattr(event, "node_id", None)
        # Skip /api/quick's temporary nodes and anything no longer on the canvas.
        if not isinstance(node_id, str) or node_id not in cli_graph.nodes:
            return
        if not canvas_events.first_run_event(run_id, node_id, kind):
            return
        data: dict[str, Any] = {"runId": run_id}
        if isinstance(event, ErrorEvent):
            error = event.friendly or event.error or ""
            data["error"] = str(_journal_safe_value(error, key="error"))[:200]
        _journal(
            kind,
            node_id=node_id,
            data=data,
            summary=f"{_node_label(node_id)} ({node_id}) {_RUN_EVENT_VERBS[kind]}",
            actor=canvas_events.run_actor(run_id),
        )
    except Exception:  # noqa: BLE001 - never break execution for the journal
        pass


def _node_label(node_id: str) -> str:
    node = cli_graph.nodes.get(node_id) or {}
    definition = node_registry.get_all().get(str(node.get("definitionId", "")), {})
    return str(definition.get("displayName") or node.get("definitionId") or node_id)


@app.post("/api/canvas/cursor")
async def point_agent_cursor(body: dict[str, Any]) -> dict[str, Any]:
    """Point the calling agent's cursor at a node, a port, or a canvas spot.

    Body: {target: {nodeId, handle?} | {x, y}, from?: same shape,
    action?: move|click|drag|look, say?: text}. The caller must identify
    itself (agent token, Daedalus header, or X-Nebula-Agent).
    """
    identity = identify_agent(current_request_headers())
    if identity is None:
        raise HTTPException(
            status_code=400,
            detail="Identify the agent with an X-Nebula-Agent header (e.g. 'Claude Code') or an agent token",
        )
    try:
        target = parse_target(body.get("target"), cli_graph.nodes)
        origin = parse_target(body["from"], cli_graph.nodes, "from") if body.get("from") is not None else None
        event = agent_presence.point(
            identity,
            target=target,
            origin=origin,
            action=body.get("action") or "move",
            say=body.get("say"),
        )
    except PresenceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await manager.broadcast_raw(event)
    return {"agent": identity.as_dict(), "target": target, "action": event["action"], "say": event["say"]}


@app.post("/api/canvas/view")
async def report_canvas_view(body: dict[str, Any]) -> dict[str, Any]:
    """The browser's latest viewport, node bounds and run states (never persisted)."""
    try:
        return agent_presence.report_view(body)
    except PresenceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/canvas/snapshot")
async def get_canvas_snapshot() -> dict[str, Any]:
    """Read the canvas as data: what's on screen, node states, wires, selection, agent cursors."""
    selected = selection_context.snapshot(cli_graph, node_registry).get("selectedNodeIds", [])
    snapshot = agent_presence.snapshot(cli_graph, node_registry, selected_ids=selected)
    # `nebula look` then `nebula watch --since <cursor>` leaves no gap.
    snapshot["events"] = {"journal": canvas_events.journal_id, "cursor": canvas_events.latest}
    # The person's notes for agents: open pins first, plus recent replies.
    try:
        snapshot["pins"] = canvas_pins.for_agents()["pins"]
    except (PinError, ProjectStoreError):
        snapshot["pins"] = []
    # Proposals waiting for the person (one line each; never their accept keys).
    await _sweep_proposals()
    snapshot["proposals"] = [canvas_proposals.brief(p) for p in canvas_proposals.open_list()]
    return snapshot


def _query_number(raw: str | None, name: str, *, integer: bool, low: float, high: float | None) -> float | None:
    if raw is None or raw == "":
        return None
    try:
        value = int(raw) if integer else float(raw)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"{name} must be a number") from None
    if not math.isfinite(value) or value < low or (high is not None and value > high):
        bound = f"between {low:g} and {high:g}" if high is not None else f"at least {low:g}"
        raise HTTPException(status_code=422, detail=f"{name} must be {bound}")
    return value


@app.get("/api/canvas/events")
async def get_canvas_events(request: Request) -> dict[str, Any]:
    """Long-poll the canvas change journal (see services/canvas_events.py).

    Query: after (seq; default "from now"), journal (id from a previous
    response), wait (seconds, capped at 25), limit (1-100), kinds (comma
    list of groups or exact kinds), self=1 to include the caller's own
    events. Resume with after=<cursor>.
    """
    query = request.query_params
    known = {"after", "journal", "wait", "limit", "kinds", "self"}
    await _sweep_proposals()
    unknown = sorted(set(query) - known)
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown query parameter '{unknown[0][:40]}'")
    after = _query_number(query.get("after"), "after", integer=True, low=0, high=None)
    wait = _query_number(query.get("wait"), "wait", integer=False, low=0, high=None) or 0.0
    limit = _query_number(query.get("limit"), "limit", integer=True, low=1, high=100)
    journal = query.get("journal") or None
    if journal is not None and not re.fullmatch(r"[0-9a-f]{1,32}", journal):
        raise HTTPException(status_code=422, detail="journal must be the id from a previous response")
    try:
        kinds = parse_kinds(query.get("kinds"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    include_self = (query.get("self") or "0").lower()
    if include_self not in {"0", "1", "true", "false"}:
        raise HTTPException(status_code=422, detail="self must be 1 or 0")
    identity = identify_agent(current_request_headers())
    exclude = identity.id if identity is not None and include_self in {"0", "false"} else None
    try:
        return await canvas_events.wait(
            after=int(after) if after is not None else None,
            journal=journal,
            wait=wait,
            limit=int(limit) if limit is not None else 50,
            kinds=kinds,
            exclude_actor_id=exclude,
        )
    except TooManyWaiters as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc


# ---------- Pins: the person's notes for agents ----------

def _pins_message() -> dict[str, Any]:
    """The `canvasPins` WebSocket message for the active project (empty when unreadable)."""
    try:
        listing = canvas_pins.list()
    except (PinError, ProjectStoreError):
        listing = {"projectId": None, "pins": []}
    return {"type": "canvasPins", **listing}


async def _broadcast_pins() -> None:
    try:
        await manager.broadcast_raw(_pins_message())
    except Exception:  # noqa: BLE001 - pins are already saved; a failed push heals on reconnect
        pass


async def _journal_detached_pins(pins: list[dict[str, Any]], reason: str) -> None:
    """Broadcast and journal pins that just lost their node."""
    if not pins:
        return
    await _broadcast_pins()
    for pin in pins[:50]:
        node_id = pin.get("detachedFrom")
        _journal(
            "pin.detached",
            node_id=node_id if isinstance(node_id, str) else None,
            data={"pinId": pin.get("id"), "text": pin.get("text"), "anchor": pin.get("anchor"), "reason": reason},
            summary=f"note {pin.get('id')} lost its node {node_id} ({reason}); it stays where the node was",
        )


def _pin_http_error(exc: PinError | PersonGateError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)


@app.get("/api/canvas/pins")
async def list_canvas_pins() -> dict[str, Any]:
    """Notes the person pinned for agents in the open project (open first, newest first)."""
    try:
        return canvas_pins.list()
    except PinError as exc:
        raise _pin_http_error(exc) from exc


@app.post("/api/canvas/pins", status_code=201)
async def create_canvas_pin(body: dict[str, Any]) -> dict[str, Any]:
    """Pin a short note to a node or a canvas spot. Only the person can do this.

    Body: {text, nodeId} or {text, position: {x, y}}.
    """
    try:
        require_person(current_request_headers())
        pin = canvas_pins.add(
            body.get("text"),
            node_id=body.get("nodeId"),
            position=body.get("position"),
            graph_nodes=cli_graph.nodes,
        )
    except (PersonGateError, PinError) as exc:
        raise _pin_http_error(exc) from exc
    await _broadcast_pins()
    anchor = pin.get("anchor") or {}
    _journal(
        "pin.added",
        node_id=anchor.get("nodeId"),
        data={"pinId": pin["id"], "text": pin["text"], "anchor": anchor},
        summary=pin_summary(pin),
    )
    return {"pin": pin}


@app.delete("/api/canvas/pins/{pin_id}")
async def delete_canvas_pin(pin_id: str) -> dict[str, Any]:
    """Delete a note. Only the person can do this."""
    try:
        require_person(current_request_headers())
        pin = canvas_pins.remove(pin_id)
    except (PersonGateError, PinError) as exc:
        raise _pin_http_error(exc) from exc
    await _broadcast_pins()
    _journal(
        "pin.removed",
        node_id=(pin.get("anchor") or {}).get("nodeId"),
        data={"pinId": pin_id, "text": pin.get("text")},
        summary=f"deleted the note {pin_id}",
    )
    return {"status": "deleted"}


@app.post("/api/canvas/pins/{pin_id}/resolve")
async def resolve_canvas_pin(pin_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """An agent answers a note in one line, which resolves it and moves its cursor there."""
    identity = identify_agent(current_request_headers())
    if identity is None:
        raise HTTPException(status_code=400, detail="Name yourself with NEBULA_AGENT_NAME or --as")
    try:
        pin = canvas_pins.resolve(pin_id, body.get("reply"), identity)
    except PinError as exc:
        raise _pin_http_error(exc) from exc
    await _broadcast_pins()
    reply = (pin.get("reply") or {}).get("text", "")
    anchor = pin.get("anchor") or {}
    _journal(
        "pin.resolved",
        node_id=anchor.get("nodeId"),
        data={"pinId": pin_id, "text": pin.get("text"), "reply": reply},
        summary=f'answered the note {pin_id} ("{str(pin.get("text"))[:40]}"): {reply}',
    )
    try:
        target = anchor if anchor.get("nodeId") in cli_graph.nodes else (
            pin.get("position") or {"x": anchor.get("x", 0.0), "y": anchor.get("y", 0.0)}
        )
        target = {"nodeId": target["nodeId"]} if "nodeId" in target else {"x": target["x"], "y": target["y"]}
        await manager.broadcast_raw(agent_presence.point(identity, target=target, action="click", say=reply))
    except Exception:  # noqa: BLE001 - the cursor is decoration on a saved reply
        pass
    return {"pin": pin}


# ---------- Proposals: agents propose, the person approves ----------

_PROPOSAL_KEY_HEADER = "x-nebula-proposal-key"
_SYSTEM_ACTOR: dict[str, Any] = {"kind": "system"}
_PERSON_ACTOR: dict[str, Any] = {"kind": "person"}


def _proposal_http_error(exc: ProposalError | PersonGateError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)


def _proposal_closed_message(proposal: Proposal) -> dict[str, Any]:
    message: dict[str, Any] = {
        "type": "proposalClosed",
        "proposalId": proposal.id,
        "status": proposal.status,
        "reason": proposal.reason,
    }
    if proposal.id_map:
        message["idMap"] = dict(proposal.id_map)
    return message


async def _announce_closed_proposals(
    proposals: list[Proposal],
    *,
    actor: dict[str, Any] | None = None,
) -> None:
    """Journal and broadcast proposals that just closed (expired, invalidated, ...)."""
    for proposal in proposals:
        kind = f"proposal.{proposal.status}"
        reason = f": {proposal.reason}" if proposal.reason else ""
        _journal(
            kind,
            node_id=next(iter(sorted(proposal.references)), None),
            data={"proposalId": proposal.id, "agentId": proposal.agent.id,
                  "note": proposal.spec.note, "reason": proposal.reason},
            summary=f"{proposal.status} {proposal.agent.name}'s proposal {proposal.id}{reason}",
            actor=actor,
        )
        try:
            await manager.broadcast_raw(_proposal_closed_message(proposal))
        except Exception:  # noqa: BLE001 - the canvas also hides expired proposals locally
            pass


async def _sweep_proposals() -> None:
    """Expire overdue proposals; called before every proposal read and decision."""
    try:
        expired = canvas_proposals.sweep()
    except Exception:  # noqa: BLE001 - never fail a read over housekeeping
        return
    await _announce_closed_proposals(expired, actor=dict(_SYSTEM_ACTOR))


def _proposal_view(proposal: Proposal) -> dict[str, Any]:
    return canvas_proposals.view(proposal, registry=node_registry)


def _stage_proposal(
    spec: ProposalSpec,
    *,
    positions: dict[str, dict[str, float]] | None = None,
) -> tuple[CLIGraph, dict[str, str], list[str], list[str]]:
    """Stage a proposal on a clone of the live graph with the cluster validators.

    Returns (candidate, id_map ref→new id, new edge ids, run node ids). Raises
    HTTPException from the same validators create/connect/update use, so a
    proposal that would fail as direct edits fails here, before anything is
    committed. Missing referenced nodes raise 409 (the canvas moved on).
    """
    candidate = cli_graph.clone()
    for node_id in sorted(spec.references):
        if node_id not in candidate.nodes:
            raise HTTPException(status_code=409, detail=f"{node_id} is no longer on the canvas")
    # Existing nodes first: their ports can depend on their params.
    for change in spec.params:
        node = candidate.nodes[change.node_id]
        definition_id = str(node.get("definitionId") or "")
        if definition_id == "cinema-scene" and "scene" in change.params:
            raise HTTPException(status_code=400, detail="Cinema scenes can't be changed by a proposal; edit them in Cinema")
        if uses_durable_recovery(definition_id, provider="worldlabs"):
            raise HTTPException(status_code=400, detail="World Labs nodes can't be changed by a proposal; propose a new node instead")
        _validate_params(definition_id, change.params)
        candidate.update_params(change.node_id, _coerce_params(definition_id, change.params))
    raw_nodes = [
        {
            "tempId": node.ref,
            "definitionId": node.definition_id,
            "params": copy.deepcopy(node.params),
            "position": (positions or {}).get(node.ref) or node.position,
        }
        for node in spec.nodes
    ]
    id_map = _stage_graph_nodes(candidate, raw_nodes, reference_key="tempId", include_outputs=False)
    new_ids = set(id_map.values())
    refs: dict[str, str] = {node_id: node_id for node_id in candidate.nodes if node_id not in new_ids}
    refs.update(id_map)
    edge_ids = _stage_graph_edges(candidate, [edge.as_dict() for edge in spec.edges], refs)
    run_ids: list[str] = []
    for item in spec.run:
        if item not in refs:
            raise HTTPException(status_code=400, detail=f"run names '{item[:30]}', which is not on the canvas or in the proposal")
        run_ids.append(refs[item])
    return candidate, id_map, edge_ids, run_ids


def _outputs_available(outputs: Any) -> bool:
    if not isinstance(outputs, dict):
        return False
    return any(bool(value.get("value") if isinstance(value, dict) else value) for value in outputs.values())


def _proposal_cost(candidate: CLIGraph, id_map: dict[str, str], run_ids: list[str]) -> dict[str, Any]:
    """Which nodes a run after acceptance may start: the targets plus ancestors without outputs.

    Never a number: each node is free (utility) or paid (a provider call).
    "Up to" when ancestors are counted, because the execution cache may skip them.
    """
    ref_for = {new_id: ref for ref, new_id in id_map.items()}
    definitions = node_registry.get_all()
    entries: list[dict[str, Any]] = []
    up_to = False
    if run_ids:
        graph_nodes, graph_edges = candidate.to_execute_format()
        nodes = [GraphNode.model_validate(node) for node in graph_nodes]
        edges = [GraphEdge.model_validate(edge) for edge in graph_edges]
        chosen: list[str] = []
        for target in run_ids:
            sub_nodes, _ = get_subgraph(nodes, edges, target)
            for node in sorted(sub_nodes, key=lambda n: _node_order(n.id)):
                if node.id in chosen:
                    continue
                if node.id not in run_ids:
                    if _outputs_available((candidate.nodes.get(node.id) or {}).get("outputs")):
                        continue
                    up_to = True
                chosen.append(node.id)
        for node_id in chosen:
            definition = definitions.get(str(candidate.nodes[node_id].get("definitionId") or ""), {})
            entries.append({
                "ref": ref_for.get(node_id, node_id),
                "nodeId": None if node_id in ref_for else node_id,
                **cost_for(definition),
            })
    return summarize_cost(entries, up_to=up_to)


def _node_order(node_id: str) -> tuple[int, str]:
    digits = node_id[1:]
    return (int(digits) if digits.isdigit() else 0, node_id)


def _proposal_layout_hints() -> tuple[dict[str, dict[str, Any]], dict[str, float] | None]:
    """Where existing nodes are (browser report first, else stored) and what's on screen."""
    try:
        snapshot = agent_presence.snapshot(cli_graph, node_registry)
    except Exception:  # noqa: BLE001 - placement falls back to (0, 0)
        return {}, None
    known: dict[str, dict[str, Any]] = {}
    for node in snapshot.get("nodes") or []:
        position = node.get("position")
        if isinstance(position, dict):
            known[node["id"]] = {
                "x": float(position.get("x", 0.0)),
                "y": float(position.get("y", 0.0)),
                "width": float((node.get("size") or {}).get("width") or 0.0),
                "height": float((node.get("size") or {}).get("height") or 0.0),
            }
    return known, (snapshot.get("view") or {}).get("visibleArea")


@app.post("/api/canvas/proposals", status_code=201)
async def create_canvas_proposal(body: dict[str, Any]) -> dict[str, Any]:
    """An agent proposes a change; the person sees ghosts and accepts or rejects it.

    Body: {note, nodes?: [{ref: "+up", definitionId, params?, position?}],
    edges?: [{source, sourceHandle, target, targetHandle}] (refs or node ids),
    params?: [{nodeId, params}], run?: [ref or node id]}. Nothing changes on
    the canvas until the person accepts in Nebula.
    """
    headers = current_request_headers()
    identity = identify_agent(headers)
    if identity is None:
        if is_browser_request(headers):
            raise HTTPException(status_code=403, detail="The person doesn't need to propose; edit directly")
        raise HTTPException(status_code=400, detail="Name yourself with NEBULA_AGENT_NAME or --as")
    await _sweep_proposals()
    _validate_graph_ingress_complexity(body)
    try:
        spec = parse_spec(body)
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    try:
        candidate, id_map, _edge_ids, run_ids = _stage_proposal(spec)
    except HTTPException as exc:
        # A missing node is a bad proposal here (the agent's view is stale), not a conflict.
        raise HTTPException(status_code=400 if exc.status_code == 409 else exc.status_code,
                            detail=exc.detail) from exc
    known, visible_area = _proposal_layout_hints()
    positions = place_new_nodes(spec, known, visible_area)
    cost = _proposal_cost(candidate, id_map, run_ids)
    existing = {
        node_id: {
            "name": f"{_node_label(node_id)} ({node_id})",
            "params": copy.deepcopy((cli_graph.nodes.get(node_id) or {}).get("params") or {}),
        }
        for node_id in spec.references
    }
    try:
        proposal = canvas_proposals.create(
            agent=identity,
            project_id=_workspace_context()["activeProjectId"],
            spec=spec,
            positions=positions,
            cost=cost,
            existing=existing,
        )
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    view = _proposal_view(proposal)
    first_reference = next(iter(sorted(proposal.references, key=_node_order)), None)
    _journal(
        "proposal.created",
        node_id=first_reference,
        data={
            "proposalId": proposal.id,
            "note": spec.note,
            "adds": len(spec.nodes),
            "wires": len(spec.edges),
            "sets": len(spec.params),
            "runs": len(spec.run),
            "paidRuns": cost["paidRuns"],
        },
        summary=f'proposed {proposal.id}: "{spec.note}"',
    )
    # The accept key goes only to the person's canvas sockets.
    try:
        await manager.broadcast_browser({
            "type": "proposalOpened",
            "proposal": view,
            "acceptKey": proposal.accept_key,
            # Exactly what Accept will write, for the person's decision bar.
            "personValues": canvas_proposals.person_values(proposal),
        })
    except Exception:  # noqa: BLE001 - a browser that missed it gets proposalSync on reconnect
        pass
    if first_reference is not None:
        target: dict[str, Any] = {"nodeId": first_reference}
    elif spec.nodes:
        spot = positions[spec.nodes[0].ref]
        target = {"x": spot["x"] + 120.0, "y": spot["y"] + 40.0}
    else:
        target = None
    if target is not None:
        await _show_agent(target, action="click", say=spec.note)
    return {"proposal": view}


@app.get("/api/canvas/proposals")
async def list_canvas_proposals() -> dict[str, Any]:
    """Open proposals waiting for the person (never their accept keys)."""
    await _sweep_proposals()
    return {"proposals": [_proposal_view(p) for p in canvas_proposals.open_list()]}


@app.get("/api/canvas/proposals/{proposal_id}")
async def get_canvas_proposal(proposal_id: str, request: Request) -> dict[str, Any]:
    """One proposal; with ?wait=<seconds> (≤25) wait for the person to decide."""
    wait = _query_number(request.query_params.get("wait"), "wait", integer=False, low=0, high=None) or 0.0
    wait = min(wait, 25.0)
    await _sweep_proposals()
    proposal = canvas_proposals.get(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail=f"No proposal {proposal_id[:20]} (decided proposals are kept for 30 minutes)")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait
    cursor = canvas_events.latest
    while proposal.is_open:
        # Expiry is only noticed by a sweep, so never sleep past it.
        remaining = min(deadline - loop.time(), proposal.expires_at - canvas_proposals.now() + 0.05)
        if remaining <= 0:
            break
        try:
            result = await canvas_events.wait(after=cursor, journal=canvas_events.journal_id,
                                              wait=remaining, kinds={"proposal"})
        except TooManyWaiters as exc:
            raise HTTPException(status_code=429, detail=str(exc)) from exc
        cursor = result.get("cursor", cursor)
        await _sweep_proposals()
        if result.get("timedOut") and deadline - loop.time() <= 0:
            break
    return {"proposal": _proposal_view(proposal)}


@app.delete("/api/canvas/proposals/{proposal_id}")
async def withdraw_canvas_proposal(proposal_id: str) -> dict[str, Any]:
    """The proposing agent takes its proposal back."""
    identity = identify_agent(current_request_headers())
    if identity is None:
        raise HTTPException(status_code=400, detail="Name yourself with NEBULA_AGENT_NAME or --as")
    await _sweep_proposals()
    proposal = canvas_proposals.get(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail=f"No proposal {proposal_id[:20]}")
    if proposal.agent.id != identity.id:
        raise HTTPException(status_code=403, detail="Only the agent that proposed this can withdraw it")
    try:
        canvas_proposals.close(proposal_id, "withdrawn", reason="withdrawn by the agent")
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    await _announce_closed_proposals([proposal])
    return {"proposal": _proposal_view(proposal)}


async def _decidable_proposal(proposal_id: str) -> Proposal:
    """The person-only checks shared by accept and reject, in order.

    1. No agent markers and a browser (or the desktop session).
    2. The per-proposal accept key, which only browser sockets ever received.
    3. Still open, and for the project that is open now.
    """
    headers = current_request_headers()
    try:
        require_person(headers)
    except PersonGateError as exc:
        raise _proposal_http_error(exc) from exc
    lower = {k.lower(): v for k, v in (headers or {}).items()}
    supplied = lower.get(_PROPOSAL_KEY_HEADER) or ""
    proposal = canvas_proposals.get(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="This proposal is no longer available")
    if not supplied or not secrets.compare_digest(supplied.encode(), proposal.accept_key.encode()):
        raise HTTPException(status_code=403, detail="This proposal can only be accepted from the Nebula canvas.")
    await _sweep_proposals()
    _ensure_still_decidable(proposal)
    return proposal


def _refuse_overwriting_later_edits(proposal: Proposal) -> None:
    """409 when a param the proposal sets has changed since it was proposed.

    The person saw "from -> to" against the value at proposal time. If that
    value has since changed (the person edited it, say), accepting would
    silently overwrite the newer edit, so the proposal no longer fits.
    """
    stale: list[str] = []
    for change in proposal.spec.params:
        if change.node_id not in cli_graph.nodes:
            continue  # staging reports a deleted node in its own words
        before = (proposal.existing.get(change.node_id) or {}).get("params") or {}
        now = cli_graph.nodes[change.node_id].get("params") or {}
        stale.extend(f"{change.node_id}.{key}" for key in change.params if now.get(key) != before.get(key))
    if stale:
        raise HTTPException(status_code=409, detail=f"{_listed(stale, 4)} changed after it was proposed")


def _ensure_still_decidable(proposal: Proposal) -> None:
    """Re-check after an await: still open and still for the open project."""
    if not proposal.is_open:
        raise HTTPException(status_code=409, detail=f"This proposal is already {proposal.status}")
    if proposal.project_id != _workspace_context()["activeProjectId"]:
        raise HTTPException(status_code=409, detail="This proposal belongs to another project")


async def _proposal_body(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="body must be JSON") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="body must be a JSON object")
    return body


@app.post("/api/canvas/proposals/{proposal_id}/accept")
async def accept_canvas_proposal(proposal_id: str, request: Request) -> dict[str, Any]:
    """The person accepts: apply every node, wire and param change at once, or nothing.

    Body: {positions?: {"+up": {x, y}}} for ghosts the person dragged.
    The backend never starts a run here. The canvas runs `runNodeIds`
    itself after this returns, through its normal guarded run path; the
    Accept click is the person's approval for those runs.
    """
    proposal = await _decidable_proposal(proposal_id)
    _check_workspace_revision()
    body = await _proposal_body(request)
    # Reading the body can yield to the event loop, and in that gap the agent
    # may withdraw, the sweep may expire it, or a second tab may accept it.
    # Check again here. From this line to close() below nothing awaits, so no
    # other request can decide this proposal while it is being applied.
    _ensure_still_decidable(proposal)
    try:
        dragged = clean_positions(body.get("positions"), proposal.spec.refs)
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    positions = {**proposal.positions, **dragged}
    staging_error: HTTPException | None = None
    with _paid_graph_mutation("accept a proposal"):
        try:
            _refuse_overwriting_later_edits(proposal)
            candidate, id_map, edge_ids, run_ids = _stage_proposal(proposal.spec, positions=positions)
        except HTTPException as exc:
            # cli_graph is only replaced at commit, so nothing changed.
            staging_error = exc
        else:
            touched = sorted(set(id_map.values()) | {change.node_id for change in proposal.spec.params})
            _commit_graph_candidate_with_recoveries(
                candidate,
                [candidate.nodes[node_id] for node_id in touched],
                source="proposal",
            )
    if staging_error is not None:
        detail = str(staging_error.detail)
        try:
            canvas_proposals.close(proposal.id, "invalidated", reason=detail[:200])
        except ProposalError:
            pass
        await _announce_closed_proposals([proposal], actor=dict(_PERSON_ACTOR))
        raise HTTPException(status_code=409, detail=f"This proposal no longer fits the canvas: {detail}")

    try:
        canvas_proposals.close(proposal.id, "accepted", id_map=id_map, run_node_ids=run_ids)
    except ProposalError:
        # Unreachable while the stretch above stays await-free. If it ever
        # happens the graph is already committed, so still sync the canvas.
        pass
    await _broadcast_graph_sync()
    publish_action(f"Accepted {proposal.agent.name}'s proposal ({len(id_map)} nodes)")
    person = dict(_PERSON_ACTOR)
    _journal(
        "proposal.accepted",
        node_id=next(iter(id_map.values()), None) or next(iter(sorted(proposal.references)), None),
        data={"proposalId": proposal.id, "agentId": proposal.agent.id, "note": proposal.spec.note,
              "idMap": id_map, "runNodeIds": run_ids},
        summary=f"accepted {proposal.agent.name}'s proposal {proposal.id}"
        + (f"; will run {_listed(run_ids)}" if run_ids else ""),
        actor=person,
    )
    note = f" (accepted from {proposal.agent.name})"
    _journal_cluster(list(id_map.values()), edge_ids, actor=person, note=note)
    for change in proposal.spec.params:
        before = (proposal.existing.get(change.node_id) or {}).get("params") or {}
        changes = param_changes(before, (cli_graph.nodes.get(change.node_id) or {}).get("params") or {})
        if changes:
            _journal(
                "node.params",
                node_id=change.node_id,
                data=changes,
                summary=f"set {_listed(changes['keys'], 4)} on {_node_label(change.node_id)} ({change.node_id}){note}",
                actor=person,
            )
    try:
        await manager.broadcast_raw(_proposal_closed_message(proposal))
    except Exception:  # noqa: BLE001
        pass
    focus = next(iter(id_map.values()), None) or next(iter(sorted(proposal.references, key=_node_order)), None)
    if focus is not None:
        try:
            event = agent_presence.point(proposal.agent, target={"nodeId": focus}, action="click", say="Accepted")
            await manager.broadcast_raw(event)
        except Exception:  # noqa: BLE001 - the cursor is decoration on a committed change
            pass
    all_defs = node_registry.get_all()
    updated = [
        _cli_node_to_rf(cli_graph.nodes[node_id], cli_graph.nodes[node_id].get("position") or {"x": 0.0, "y": 0.0}, all_defs)
        for node_id in [change.node_id for change in proposal.spec.params]
        if node_id in cli_graph.nodes
    ]
    return {
        "status": "accepted",
        "proposalId": proposal.id,
        "idMap": id_map,
        "runNodeIds": run_ids,
        **_rf_created(list(id_map.values()), edge_ids),
        "updatedNodes": updated,
    }


@app.post("/api/canvas/proposals/{proposal_id}/reject")
async def reject_canvas_proposal(proposal_id: str, request: Request) -> dict[str, Any]:
    """The person says no. Body: {reason?} (one short line the agent will read)."""
    proposal = await _decidable_proposal(proposal_id)
    body = await _proposal_body(request)
    _ensure_still_decidable(proposal)
    reason: str | None = None
    if body.get("reason") not in (None, ""):
        try:
            reason = clean_note(body.get("reason"), limit=MAX_REASON, label="reason")
        except ProposalError as exc:
            raise _proposal_http_error(exc) from exc
    canvas_proposals.close(proposal.id, "rejected", reason=reason)
    await _announce_closed_proposals([proposal], actor=dict(_PERSON_ACTOR))
    return {"status": "rejected", "proposalId": proposal.id}


@app.get("/api/project")
async def current_project() -> dict[str, str]:
    """Identity for the single local project served by this backend."""
    return get_current_project()


@app.get("/api/health/providers")
async def health_providers(refresh: bool = False) -> dict:
    """Per-provider API key validation.

    Reports every credential family used by the node catalog plus Nous OAuth.
    Configured credentials are checked with a non-billable authenticated read
    when the provider documents one. Providers without a safe probe are marked
    configured_unverified instead of triggering generation. Results are cached
    for 5 minutes; pass ?refresh=true to bypass the cache.
    """
    return {"providers": await validate_provider_keys(force_refresh=refresh)}


@app.get("/api/agents/claude/status")
async def get_claude_status() -> dict[str, Any]:
    from services.chat_session import claude_login_status

    return await claude_login_status()


@app.get("/api/agents/codex/status")
async def get_codex_status() -> dict[str, Any]:
    from services.codex_session import codex_login_status

    return await codex_login_status()


@app.get("/api/agents/{agent}/models")
async def get_agent_models(agent: str, refresh: bool = False) -> dict[str, Any]:
    """Read available local CLI models/efforts without starting a chat turn."""
    from services.chat_models import ChatModelSelectionError, get_chat_models

    try:
        return await get_chat_models(agent, refresh=refresh)
    except ChatModelSelectionError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)}) from exc


@app.post("/api/agents/codex/login/chatgpt")
async def start_codex_chatgpt_login(request: Request) -> dict[str, Any]:
    from services.codex_session import start_codex_chatgpt_login as start_login

    payload: dict[str, Any] = {}
    if request.headers.get("content-type", "").startswith("application/json"):
        try:
            loaded = await request.json()
            if isinstance(loaded, dict):
                payload = loaded
        except json.JSONDecodeError:
            payload = {}
    return await start_login(device_auth=bool(payload.get("deviceAuth")))


@app.get("/api/agents/codex/login/chatgpt")
async def get_codex_chatgpt_login_state() -> dict[str, Any]:
    from services.codex_session import codex_chatgpt_login_state

    return await codex_chatgpt_login_state()


# ---------- Zoom manifest (demo-video editing chain telemetry) ----------
# Frontend calls /init on page load, then POSTs entries on every
# canvas-mutation event with the node's screen-space bounds + timestamp.
# Manifest JSON is consumed post-recording by a custom editing-chain step
# to drive auto-zoom on the right pixel region at the right moment.

@app.post("/api/zoom-manifest/init")
async def zoom_manifest_init() -> dict:
    if load_settings().get("zoomTelemetryEnabled") is not True:
        raise HTTPException(status_code=403, detail="zoom telemetry is disabled")
    return init_manifest()


@app.post("/api/zoom-manifest/entry")
async def zoom_manifest_entry(body: dict[str, Any]) -> dict:
    if load_settings().get("zoomTelemetryEnabled") is not True:
        raise HTTPException(status_code=403, detail="zoom telemetry is disabled")
    appended = append_entry(body)
    return {"ok": appended}


@app.get("/api/settings")
async def get_settings() -> dict:
    settings = load_settings()
    masked = dict(settings)
    if "apiKeys" in masked:
        masked["apiKeys"] = {
            k: ("***" + v[-4:] if len(v) > 4 else "***") if v else ""
            for k, v in masked["apiKeys"].items()
        }
    return masked


@app.put("/api/settings")
async def update_settings(body: dict[str, Any]) -> dict:
    if "kreaConnectionMode" in body and body["kreaConnectionMode"] not in ("api-token", "mcp"):
        raise HTTPException(400, "Krea connection mode must be api-token or mcp")
    if "zoomTelemetryEnabled" in body and not isinstance(body["zoomTelemetryEnabled"], bool):
        raise HTTPException(400, "zoomTelemetryEnabled must be a boolean")
    # Desktop mode: credentials are managed via the Keychain credential IPC
    # and POST /api/credentials/update — never via this endpoint. Ignore any
    # apiKeys in the request body so a compromised renderer cannot overwrite
    # injected keys.
    accepts_keys = not is_injected_mode()
    if "apiKeys" in body and accepts_keys:
        if not isinstance(body["apiKeys"], dict) or any(
            not isinstance(value, str) for value in body["apiKeys"].values()
        ):
            raise HTTPException(400, "apiKeys must be an object of string values")
    # Do not mutate a loaded/shared object until the complete request is valid.
    current = copy.deepcopy(load_settings())
    if "apiKeys" in body and accepts_keys:
        current_keys = current.get("apiKeys", {})
        for k, v in body["apiKeys"].items():
            if v and not v.startswith("***"):
                current_keys[k] = v
        current["apiKeys"] = current_keys
    for key in (
        "routing",
        "outputPath",
        "executionMode",
        "batchSizeCap",
        "favorites",
        "exportFolder",
        "zoomTelemetryEnabled",
        "kreaConnectionMode",
    ):
        if key in body:
            current[key] = body[key]
    save_settings(current)
    # API keys may have changed — drop cached validation results so the next
    # GET /api/health/providers re-checks providers instead of serving stale
    # status for up to PROVIDER_CHECK_TTL_SECONDS.
    clear_provider_validation_cache()
    return {"status": "saved"}


# The credential-update allowlist (17 keys; desktop/credentials.mjs mirrors it).
_CREDENTIAL_PROVIDER_ALLOWLIST = frozenset({
    "ANTHROPIC_API_KEY",
    "ELEVENLABS_API_KEY",
    "FAL_KEY",
    "GOOGLE_API_KEY",
    "HIGGSFIELD_API_KEY",
    "IDEOGRAM_API_KEY",
    "KREA_API_TOKEN",
    "KREA_USAGE_KEY",
    "MESHY_API_KEY",
    "MINIMAX_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "QUIVER_API_KEY",
    "REPLICATE_API_TOKEN",
    "RUNWAY_API_KEY",
    "XAI_API_KEY",
    "WORLDLABS_API_KEY",
})


@app.delete("/api/settings/api-keys/{provider}")
async def remove_settings_api_key(provider: str) -> dict:
    """Explicitly remove one browser credential without replacing Settings.

    Credential values and Krea MCP OAuth state never enter the response. The
    desktop credential bridge remains responsible for injected credentials.
    """
    if provider not in _CREDENTIAL_PROVIDER_ALLOWLIST:
        raise HTTPException(400, "Unknown credential provider")
    if is_injected_mode():
        raise HTTPException(409, "Injected credentials must be removed through the credential bridge")
    current = copy.deepcopy(load_settings())
    current_keys = current.get("apiKeys", {})
    current_keys.pop(provider, None)
    current["apiKeys"] = current_keys
    save_settings(current)
    clear_provider_validation_cache()
    return {"status": "removed"}


@app.post("/api/credentials/update")
async def credentials_update(body: dict[str, Any]) -> dict:
    """Update an in-memory injected credential without sidecar restart.

    Called by Electron main when the user changes a provider key via the
    Settings panel credential IPC. Loopback-only (same security boundary as
    all other endpoints). Never persists to disk.
    """
    provider = body.get("provider")
    key = body.get("key")

    if not provider or not isinstance(provider, str):
        raise HTTPException(
            status_code=422,
            detail="provider is required and must be a string",
        )
    if key is None or not isinstance(key, str):
        raise HTTPException(
            status_code=422,
            detail="key is required and must be a string",
        )
    if provider not in _CREDENTIAL_PROVIDER_ALLOWLIST:
        raise HTTPException(
            status_code=400,
            detail=f"unknown provider: {provider}",
        )

    update_injected_keys(provider, key)
    return {"status": "updated"}


def _execution_is_cancelling(run_id: str) -> bool:
    record = execution_runs.get(run_id)
    return record is not None and record.status == "cancelling"


async def _finalize_cancelled_execution(
    nodes: list[GraphNode], run_id: str, *, preserve_graph_params: bool = False,
) -> None:
    """Sync late live-run params, preserve replay canvas params, then emit Stop."""
    if not preserve_graph_params and _sync_params_to_cli_graph(nodes):
        await _broadcast_graph_sync()
    await manager.broadcast(GraphCancelledEvent(run_id=run_id))
    _journal(
        "run.cancelled",
        data={"runId": run_id},
        summary="run stopped",
        actor=canvas_events.run_actor(run_id),
    )


def _fresh_paid_worldlabs_claims(
    nodes: list[GraphNode],
) -> list[tuple[str, str]]:
    """Return paid, non-idempotent World Labs starts in an execution scope.

    Environment generation is paid for every model/input mode. PLY conversion
    is provider-documented as free, so only a fresh HQ-GLB export is admitted
    through this paid-start gate. Supplying a recovery identifier changes the
    operation into polling/retrieval and deliberately bypasses the gate.
    """
    claims: list[tuple[str, str]] = []
    for node in nodes:
        policy = operation_policy(node.definition_id)
        if (
            policy is not None
            and policy.provider == "worldlabs"
            and requires_fresh_paid_start(node.definition_id, node.params)
        ):
            claims.append((node.definition_id, node.id))
    return claims


def _worldlabs_recovery_claims(
    nodes: list[GraphNode],
) -> list[tuple[str, str, str | None, str | None]]:
    claims: list[tuple[str, str, str | None, str | None]] = []
    for node in nodes:
        policy = operation_policy(node.definition_id)
        if policy is None or policy.provider != "worldlabs":
            continue
        resume_id, existing_id = recovery_identifiers(
            node.definition_id, node.params
        )
        if resume_id or existing_id:
            claims.append((node.definition_id, node.id, resume_id, existing_id))
    return claims


def _validate_cinema_base_models(nodes: list[GraphNode]) -> None:
    """Reject nested handler-dispatch IDs outside Cinema's strict allowlist."""
    from handlers.cinema_scene import _guard_base_model

    for node in nodes:
        if node.definition_id != "cinema-scene":
            continue
        scene = (node.params or {}).get("scene")
        if not isinstance(scene, dict):
            continue
        base = scene.get("base") or {}
        if not isinstance(base, dict):
            raise HTTPException(
                status_code=400,
                detail="cinema-scene scene.base must be an object",
            )
        try:
            _guard_base_model(base)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


def _assert_execution_admissible(run_id: str) -> None:
    """Honor both durable cross-process and local pre-admission Stop intents."""
    try:
        provider_start_guard.assert_run_admissible(run_id)
    except ProviderStartCancelledError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ProviderStartCancellationCapacityError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ProviderStartPersistenceError as exc:
        raise HTTPException(
            status_code=507,
            detail=(
                "Nebula cannot verify durable pre-admission Stop state; no "
                "provider request was sent"
            ),
        ) from exc
    try:
        execution_runs.assert_admissible(run_id)
    except ExecutionCancelledBeforeStartError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExecutionCancellationCapacityError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _claim_fresh_paid_worldlabs_starts(
    *, run_id: str, nodes: list[GraphNode]
) -> None:
    claims = _fresh_paid_worldlabs_claims(nodes)
    recovery_claims = _worldlabs_recovery_claims(nodes)
    if not claims and not recovery_claims:
        return

    def prepare_recovery_journal() -> None:
        global _graph_recovery_bootstrap_error
        # ProviderStartGuard invokes this callback while holding the shared
        # cross-process lifecycle + admission journal locks. A recovery resume
        # and a stale fresh payload therefore cannot both pass their checks.
        if _graph_recovery_bootstrap_error is not None:
            try:
                _ensure_shared_graph_recoveries(
                    list(cli_graph.nodes.values()), source="bootstrap-retry"
                )
            except (
                ProviderRecoveryCapacityError,
                ProviderRecoveryConflictError,
                ProviderRecoveryPersistenceError,
                ValueError,
            ) as exc:
                _graph_recovery_bootstrap_error = str(exc)
                raise ProviderRecoveryPersistenceError(
                    "persisted graph recovery bootstrap is unhealthy: "
                    + _graph_recovery_bootstrap_error
                ) from exc
            _graph_recovery_bootstrap_error = None
        if not provider_recovery_store.is_healthy():
            raise ProviderRecoveryPersistenceError(
                "provider recovery storage is unhealthy"
            )
        claimed_node_ids = {node_id for _kind, node_id in claims}
        recovered_node_ids = {
            str(record.get("nodeId"))
            for record in provider_recovery_store.list()
            if isinstance(record, dict)
        }
        canonical_recovery_node_ids = {
            node_id
            for node_id in claimed_node_ids
            if (
                (current := cli_graph.nodes.get(node_id)) is not None
                and has_recovery_identity(
                    str(current.get("definitionId") or ""),
                    current.get("params") or {},
                )
            )
        }
        stale_nodes = sorted(
            claimed_node_ids & (recovered_node_ids | canonical_recovery_node_ids)
        )
        if stale_nodes:
            raise ProviderStartConflictError(
                "Fresh World Labs start blocked because Nebula already has a "
                "recovery checkpoint for node(s): "
                + ", ".join(stale_nodes)
                + ". Restore or explicitly delete the checkpoint before starting "
                "new paid work."
            )
        provider_recovery_store.reserve(
            run_id=run_id,
            node_ids=list(
                dict.fromkeys(node_id for _kind, node_id in claims)
            ),
        )
        provider_recovery_store.reserve_checkpoints(
            run_id=run_id,
            checkpoints=[
                (node_id, resume_id, existing_id)
                for _kind, node_id, resume_id, existing_id in recovery_claims
            ],
        )
        for _kind, node_id, resume_id, existing_id in recovery_claims:
            provider_recovery_store.set(
                run_id=run_id,
                node_id=node_id,
                resume_operation_id=resume_id,
                existing_world_id=existing_id,
            )

    try:
        provider_start_guard.claim(
            run_id=run_id,
            claims=claims,
            recovery_claims=[
                (kind, node_id)
                for kind, node_id, _resume, _existing in recovery_claims
            ],
            pre_commit=prepare_recovery_journal,
        )
    except ProviderRecoveryCapacityError as exc:
        provider_recovery_store.release_reservations(run_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ProviderRecoveryPersistenceError as exc:
        provider_recovery_store.release_reservations(run_id)
        raise HTTPException(
            status_code=507,
            detail=(
                "Nebula cannot durably register the supplied World Labs recovery "
                "ID; no provider request was sent"
            ),
        ) from exc
    except ProviderStartCancellationCapacityError as exc:
        provider_recovery_store.release_reservations(run_id)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ProviderStartConflictError as exc:
        provider_recovery_store.release_reservations(run_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ProviderStartPersistenceError as exc:
        provider_recovery_store.release_reservations(run_id)
        raise HTTPException(
            status_code=507,
            detail=(
                "Nebula cannot verify durable paid-start safety storage; no "
                "World Labs request was sent"
            ),
        ) from exc
    except ValueError as exc:
        provider_recovery_store.release_reservations(run_id)
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _release_paid_worldlabs_starts(run_id: str) -> None:
    """Release a terminal run and surface any failed durable-intent cleanup."""
    fallback_holds = provider_start_guard.release_run(run_id)
    provider_recovery_store.release_reservations(run_id)
    if not fallback_holds:
        return
    for hold in fallback_holds:
        await manager.broadcast(
            ProviderStartAmbiguousEvent(
                run_id=str(hold["runId"]),
                node_id=str(hold["nodeId"]),
                kind=hold["kind"],
                message=(
                    f"{hold['message']} Nebula could not durably close its "
                    "pre-start intent; keep this tab open."
                ),
                durable=False,
            )
        )
    await _broadcast_graph_sync()


_shared_stop_watchers: set[asyncio.Task[None]] = set()


def _watch_for_cross_process_stop(
    run_id: str,
    execution_task: asyncio.Task[None],
) -> None:
    """Cancel the owning task when another backend records a durable Stop."""

    async def watch() -> None:
        try:
            while not execution_task.done():
                cancelled = await asyncio.to_thread(
                    provider_start_guard.is_run_cancelled,
                    run_id,
                )
                if cancelled:
                    record = execution_runs.get(run_id)
                    if record is not None and record.status == "running":
                        execution_runs.cancel(run_id)
                    return
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            return

    watcher = asyncio.create_task(watch())
    _shared_stop_watchers.add(watcher)
    watcher.add_done_callback(_shared_stop_watchers.discard)
    execution_task.add_done_callback(lambda _done: watcher.cancel())


@app.post("/api/execute")
async def execute(request: ExecuteRequest) -> dict:
    _check_workspace_revision()
    _capture_execution_workspace()
    run_id = request.run_id or str(uuid4())
    _assert_execution_admissible(run_id)
    if execution_runs.get(run_id) is not None:
        raise HTTPException(status_code=409, detail=f"run '{run_id}' already exists")
    canvas_events.note_run(run_id, actor_for_headers(current_request_headers()))
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    nodes = _normalize_execute_nodes(request.nodes)
    _validate_cinema_base_models(nodes)

    errors = validate_graph(nodes, request.edges, api_keys)
    if errors:
        await manager.broadcast(ValidationErrorEvent(errors=errors, run_id=run_id))
        return {**_validation_response(errors), "runId": run_id}

    try:
        topological_sort(nodes, request.edges)
    except CycleError as exc:
        await manager.broadcast(
            ValidationErrorEvent(
                run_id=run_id,
                errors=[
                    {
                        "node_id": "",
                        "port_id": "",
                        "message": f"Graph contains a cycle: {exc}",
                    }
                ]
            )
        )
        raise HTTPException(status_code=400, detail=f"Graph contains a cycle: {exc}")

    handler_registry = get_handler_registry(emit=_emit_and_sync)
    _claim_fresh_paid_worldlabs_starts(run_id=run_id, nodes=nodes)

    async def _run() -> None:
        import traceback, sys
        print("[exec] _run started", file=sys.stderr, flush=True)
        try:
            await execute_graph(
                nodes=nodes,
                edges=request.edges,
                api_keys=api_keys,
                handler_registry=handler_registry,
                emit=_emit_and_sync,
                cache=execution_cache,
                run_id=run_id,
            )
            # A provider's non-idempotent POST handshake may deliberately
            # absorb task cancellation long enough to capture an operation
            # ID. The engine can then return normally after suppressing its
            # own terminal events. Preserve the user's Stop as the route's
            # authoritative terminal state.
            if _execution_is_cancelling(run_id):
                raise asyncio.CancelledError
            if not request.preserve_graph_params and _sync_params_to_cli_graph(nodes):
                # ExecutedEvent carries outputs, but handlers such as
                # video-edit also enrich params. Without a final graphSync the
                # backend persisted those edits while the live Canvas stayed
                # stale until reload.
                await _broadcast_graph_sync()
            print("[exec] _run completed successfully", file=sys.stderr, flush=True)
        except asyncio.CancelledError:
            await _finalize_cancelled_execution(nodes, run_id, preserve_graph_params=request.preserve_graph_params)
            raise
        except Exception as e:
            if _execution_is_cancelling(run_id):
                await _finalize_cancelled_execution(nodes, run_id, preserve_graph_params=request.preserve_graph_params)
                raise asyncio.CancelledError from e
            print(f"[exec] _run FAILED: {e}", file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)
            raise
        finally:
            # A Stop may be absorbed while the non-idempotent provider POST
            # settles. The lease therefore belongs to the task, not the HTTP
            # acknowledgement, and releases only after the task is terminal.
            await _release_paid_worldlabs_starts(run_id)

    task: asyncio.Task[None] | None = None
    run_coroutine = _run()
    try:
        task = asyncio.create_task(run_coroutine)
        execution_runs.register(run_id, task)
        _watch_for_cross_process_stop(run_id, task)
    except ExecutionCancelledBeforeStartError as exc:
        if task is None:
            run_coroutine.close()
        else:
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExecutionCancellationCapacityError as exc:
        if task is None:
            run_coroutine.close()
        else:
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        if task is None:
            run_coroutine.close()
        else:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception:
        if task is None:
            run_coroutine.close()
        else:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise

    return {"status": "started", "runId": run_id}


@app.post("/api/execute-node")
async def execute_node(request: ExecuteNodeRequest) -> dict:
    """Execute only the subgraph feeding into a specific target node."""
    _check_workspace_revision()
    _capture_execution_workspace()
    run_id = request.run_id or str(uuid4())
    _assert_execution_admissible(run_id)
    if execution_runs.get(run_id) is not None:
        raise HTTPException(status_code=409, detail=f"run '{run_id}' already exists")
    canvas_events.note_run(run_id, actor_for_headers(current_request_headers()))
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    nodes = _normalize_execute_nodes(request.nodes)

    # Compute the subgraph: target node + all its ancestors
    sub_nodes, sub_edges = get_subgraph(
        nodes, request.edges, request.target_node_id
    )

    if not sub_nodes:
        raise HTTPException(
            status_code=404,
            detail=f"Node '{request.target_node_id}' not found in graph",
        )

    _validate_cinema_base_models(sub_nodes)

    errors = validate_graph(sub_nodes, sub_edges, api_keys)
    if errors:
        await manager.broadcast(ValidationErrorEvent(errors=errors, run_id=run_id))
        return {**_validation_response(errors), "runId": run_id}

    try:
        topological_sort(sub_nodes, sub_edges)
    except CycleError as exc:
        await manager.broadcast(
            ValidationErrorEvent(
                run_id=run_id,
                errors=[
                    {
                        "node_id": "",
                        "port_id": "",
                        "message": f"Subgraph contains a cycle: {exc}",
                    }
                ]
            )
        )
        raise HTTPException(status_code=400, detail=f"Subgraph contains a cycle: {exc}")

    handler_registry = get_handler_registry(emit=_emit_and_sync)
    _claim_fresh_paid_worldlabs_starts(run_id=run_id, nodes=sub_nodes)

    async def _run() -> None:
        import traceback
        try:
            await execute_graph(
                nodes=sub_nodes,
                edges=sub_edges,
                api_keys=api_keys,
                handler_registry=handler_registry,
                emit=_emit_and_sync,
                cache=execution_cache,
                run_id=run_id,
            )
            if _execution_is_cancelling(run_id):
                raise asyncio.CancelledError
            if not request.preserve_graph_params and _sync_params_to_cli_graph(sub_nodes):
                await _broadcast_graph_sync()
        except asyncio.CancelledError:
            await _finalize_cancelled_execution(sub_nodes, run_id, preserve_graph_params=request.preserve_graph_params)
            raise
        except Exception as exc:
            if _execution_is_cancelling(run_id):
                await _finalize_cancelled_execution(sub_nodes, run_id, preserve_graph_params=request.preserve_graph_params)
                raise asyncio.CancelledError from exc
            traceback.print_exc()
            raise
        finally:
            await _release_paid_worldlabs_starts(run_id)

    try:
        task = asyncio.create_task(_run())
        execution_runs.register(run_id, task)
        _watch_for_cross_process_stop(run_id, task)
    except ExecutionCancelledBeforeStartError as exc:
        await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExecutionCancellationCapacityError as exc:
        await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception:
        await _release_paid_worldlabs_starts(run_id)
        raise

    return {"status": "started", "nodeCount": len(sub_nodes), "runId": run_id}


@app.get("/api/executions/{run_id}")
async def get_execution_status(run_id: str) -> dict:
    record = execution_runs.get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"run '{run_id}' not found")
    return {"runId": run_id, "status": record.status}


@app.delete("/api/executions/{run_id}")
async def cancel_execution(run_id: str) -> dict:
    """Idempotently request cancellation of a tracked graph execution."""
    existing = execution_runs.get(run_id)
    try:
        # Persist every Stop, including one received by the task-owning worker.
        # Otherwise a different backend could reuse the same runId after the
        # local task becomes terminal and its paid lifecycle lease is released.
        provider_start_guard.record_cancel_intent(run_id)
    except ProviderStartCancellationCapacityError as exc:
        if existing is not None:
            execution_runs.cancel(run_id)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ProviderStartPersistenceError as exc:
        if existing is not None:
            execution_runs.cancel(run_id)
        raise HTTPException(
            status_code=507,
            detail="Could not durably record the pre-admission Stop intent",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        record = execution_runs.cancel(run_id)
    except ExecutionCancellationCapacityError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if record is None:
        # No task owns this ID, so the durable exact intent can immediately be
        # compacted: its Bloom-filter membership permanently rejects any
        # delayed POST while bounded exact-journal capacity is recovered.
        if _try_compact_execution_cancellation(run_id):
            await _broadcast_graph_sync()
        return {"runId": run_id, "status": "cancelled", "pendingAdmission": True}
    # Yield once so a cooperative task can process CancelledError and the
    # registry can report the terminal state in this acknowledgement.
    await asyncio.sleep(0)
    current = execution_runs.get(run_id) or record
    if current.status in {"cancelled", "completed", "failed"}:
        if _try_compact_execution_cancellation(run_id):
            await _broadcast_graph_sync()
    return {"runId": run_id, "status": current.status}


@app.get("/api/execution-cancellations")
async def list_execution_cancellations() -> dict:
    """List durable pre-admission Stop tombstones for explicit maintenance."""
    return {
        "cancellations": [
            {"runId": run_id, "status": "cancelled"}
            for run_id in provider_start_guard.list_cancel_intents()
        ]
    }


@app.delete("/api/execution-cancellations/{run_id}")
async def acknowledge_execution_cancellation(run_id: str) -> dict:
    """Compact one Stop tombstone while permanently denying its old run ID."""
    try:
        removed = provider_start_guard.acknowledge_cancel_intent(run_id)
    except ProviderStartConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail="Wait for all World Labs paid work to become terminal first",
        ) from exc
    except ProviderStartPersistenceError as exc:
        raise HTTPException(
            status_code=507,
            detail="Could not durably compact the execution cancellation",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # Only discard the process-local exact record after the shared journal has
    # durably moved this ID into its permanent-deny filter. A delayed POST with
    # the same runId therefore remains rejected across workers and restarts.
    execution_runs.compact_cancel_intent(run_id)
    await _broadcast_graph_sync()
    return {"status": "compacted", "runId": run_id, "removed": removed}


# Per-node locks serialize concurrent single-shot merges on the SAME cinema node.
# Generating two shots at once is supported (no global lock), so without this two
# `_merge_shot_result` tasks could read-modify-write `cli_graph.nodes[id]` and the
# last writer would drop the other's freshly-generated port. Keyed by node id so
# unrelated nodes never block each other.
_shot_merge_locks: dict[str, asyncio.Lock] = {}


def _shot_merge_lock(node_id: str) -> asyncio.Lock:
    lock = _shot_merge_locks.get(node_id)
    if lock is None:
        lock = asyncio.Lock()
        _shot_merge_locks[node_id] = lock
    return lock


async def _merge_shot_result(
    node_id: str,
    shot_id: str,
    executed_node: GraphNode | None,
    captured_outputs: dict[str, Any],
    *,
    terminal_error: str | None = None,
) -> dict[str, Any] | None:
    """Merge a single-shot regeneration into the canonical cli_graph node WITHOUT
    clobbering sibling shots.

    Reads the LIVE persisted scene (kept fresh by the editor's debounced
    param-sync) and patches ONLY the target shot's `output` + its one output PORT.
    This is the key difference from a full snapshot write: while a slow generation
    runs, the user may edit other shots on the canvas — patching the live scene
    preserves those concurrent edits instead of reverting them to a request-time
    snapshot. A per-node lock serializes overlapping single-shot merges so two
    concurrent generates never drop each other's port.

    When the target node never reaches ExecutedEvent, ``terminal_error`` marks
    only the live target shot as failed while retaining its last good image and
    output port. This prevents the request snapshot from restoring stale success
    after an upstream failure. Returns the merged shot output dict, or None.
    """
    new_output: dict[str, Any] | None = None
    if terminal_error is None and executed_node is not None:
        sub_scene = (executed_node.params or {}).get("scene") or {}
        sub_shots = sub_scene.get("shots") or []
        if sub_shots and isinstance(sub_shots[0], dict):
            new_output = sub_shots[0].get("output")

    result_output = (
        {"status": "error", "error": terminal_error}
        if terminal_error is not None
        else new_output
    )

    async with _shot_merge_lock(node_id):
        node = cli_graph.nodes.get(node_id)
        if node is None:
            return result_output

        # Patch ONLY the target shot's output on the live scene; siblings (incl.
        # any edits made during the generation) are left exactly as they are.
        params = dict(node.get("params") or {})
        scene = params.get("scene")
        if isinstance(scene, dict):
            for shot in scene.get("shots") or []:
                if isinstance(shot, dict) and str(shot.get("id")) == shot_id:
                    if terminal_error is not None:
                        # Keep the last successful image/hash available for
                        # preview and downstream reuse, but make the terminal
                        # status truthful and durable.
                        failed_output = dict(shot.get("output") or {})
                        failed_output.update({"status": "error", "error": terminal_error})
                        shot["output"] = failed_output
                        result_output = failed_output
                    elif new_output is not None:
                        shot["output"] = new_output
                    break
            params["scene"] = scene
            node["params"] = params

        # Merge the single regenerated port into the existing ports dict.
        if terminal_error is None and isinstance(captured_outputs, dict) and captured_outputs:
            shaped = {
                k: (v if isinstance(v, dict) else {"type": "Any", "value": v})
                for k, v in captured_outputs.items()
            }
            existing = dict(node.get("outputs") or {})
            existing.update(_normalize_outputs_for_storage(shaped))
            node["outputs"] = existing

        cli_graph._maybe_persist()

    return result_output


class _ShotPassError(RuntimeError):
    """Expected per-shot pass failure already expressed as user-facing text."""


def _shot_task_error_message(exc: Exception) -> str:
    if isinstance(exc, _ShotPassError):
        return str(exc)
    detail = str(exc).strip() or type(exc).__name__
    return f"Shot generation failed: {detail}"


async def _execute_single_shot_pass(
    *,
    node_id: str,
    sub_nodes: list[GraphNode],
    sub_edges: list[GraphEdge],
    api_keys: dict[str, str],
    use_cache: bool,
    seed: int | None = None,
    run_id: str | None = None,
) -> tuple[GraphNode | None, dict[str, Any]]:
    """Run one scoped Cinema pass and require a target ExecutedEvent.

    ``execute_graph`` reports normal node failures as ErrorEvent and returns, so
    awaiting it is not proof that the Cinema node executed. Capturing an error
    and then seeing no target ExecutedEvent is a terminal pass failure.
    """
    executed_node = next((node for node in sub_nodes if node.id == node_id), None)
    if executed_node is not None and seed is not None:
        pass_shots = (executed_node.params.get("scene") or {}).get("shots") or []
        if pass_shots:
            pass_shots[0]["_seedOverride"] = seed

    captured: dict[str, Any] = {"target_executed": False}

    async def _emit_scoped(event: ExecutionEvent) -> None:
        if isinstance(event, ExecutedEvent) and event.node_id == node_id:
            captured["target_executed"] = True
            captured["outputs"] = event.outputs
            return
        # Per-shot work runs outside the global graph lifecycle. A variation
        # batch executes this helper repeatedly, so forwarding GraphCompleteEvent
        # would produce one false pipeline-complete notification per pass.
        if isinstance(event, GraphCompleteEvent):
            return
        if isinstance(event, ErrorEvent) and "error" not in captured:
            captured["error"] = event.friendly or event.error
        await _emit_and_sync(event)

    await execute_graph(
        nodes=sub_nodes,
        edges=sub_edges,
        api_keys=api_keys,
        handler_registry=get_handler_registry(emit=_emit_scoped),
        emit=_emit_scoped,
        cache=execution_cache if use_cache else None,
        run_id=run_id,
    )

    if not captured["target_executed"]:
        raise _ShotPassError(
            str(captured.get("error") or "Shot generation ended before the Cinema node completed.")
        )

    return executed_node, captured.get("outputs") or {}


async def _run_single_shot_task(
    *,
    node_id: str,
    shot_id: str,
    sub_nodes: list[GraphNode],
    sub_edges: list[GraphEdge],
    api_keys: dict[str, str],
) -> None:
    """Execute and persist one per-shot task, including terminal failures."""
    import traceback

    try:
        executed_node, outputs = await _execute_single_shot_pass(
            node_id=node_id,
            sub_nodes=sub_nodes,
            sub_edges=sub_edges,
            api_keys=api_keys,
            use_cache=True,
        )
    except _ShotPassError as exc:
        await _merge_shot_result(
            node_id,
            shot_id,
            None,
            {},
            terminal_error=_shot_task_error_message(exc),
        )
    except Exception as exc:
        traceback.print_exc()
        await _merge_shot_result(
            node_id,
            shot_id,
            None,
            {},
            terminal_error=_shot_task_error_message(exc),
        )
    else:
        await _merge_shot_result(node_id, shot_id, executed_node, outputs)
    finally:
        await _broadcast_graph_sync()


async def _merge_shot_variations(
    node_id: str,
    shot_id: str,
    variations: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Store a batch of variations on the live cli_graph scene and promote the
    first as canonical (output + the one shot port). Sibling shots are untouched;
    lock-serialized like _merge_shot_result. Returns the canonical output, or None
    when the batch produced no images."""
    if not variations:
        return None
    canonical = {"imageUrl": variations[0]["url"], "status": "done"}
    async with _shot_merge_lock(node_id):
        node = cli_graph.nodes.get(node_id)
        if node is None:
            return canonical
        params = dict(node.get("params") or {})
        scene = params.get("scene")
        if isinstance(scene, dict):
            for shot in scene.get("shots") or []:
                if isinstance(shot, dict) and str(shot.get("id")) == shot_id:
                    shot["variations"] = variations
                    shot["selectedVariation"] = 0
                    shot["output"] = dict(canonical)
                    break
            params["scene"] = scene
            node["params"] = params
        existing = dict(node.get("outputs") or {})
        existing[f"shot_{shot_id}"] = {"type": "Image", "value": variations[0]["url"]}
        node["outputs"] = existing
        cli_graph._maybe_persist()
    return canonical


async def _promote_shot_variation(
    node_id: str,
    shot_id: str,
    index: int,
) -> dict[str, Any]:
    """Atomically promote one variation in the live scene and output port."""
    async with _shot_merge_lock(node_id):
        node = cli_graph.nodes.get(node_id)
        if node is None:
            raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
        if node.get("definitionId") != "cinema-scene":
            raise HTTPException(status_code=400, detail=f"Node '{node_id}' is not a cinema-scene node")

        params = dict(node.get("params") or {})
        scene = params.get("scene")
        if not isinstance(scene, dict):
            raise HTTPException(status_code=400, detail="cinema-scene node has no scene spec")

        target_shot = next(
            (
                shot
                for shot in scene.get("shots") or []
                if isinstance(shot, dict) and str(shot.get("id")) == shot_id
            ),
            None,
        )
        if target_shot is None:
            raise HTTPException(status_code=404, detail=f"Shot '{shot_id}' not found in scene")

        variations = target_shot.get("variations")
        if not isinstance(variations, list) or index >= len(variations):
            raise HTTPException(
                status_code=400,
                detail=f"Variation index {index} is not available for shot '{shot_id}'",
            )
        variation = variations[index]
        image_url = str(variation.get("url") or "") if isinstance(variation, dict) else ""
        if not image_url:
            raise HTTPException(
                status_code=400,
                detail=f"Variation index {index} for shot '{shot_id}' has no image URL",
            )

        # Replace the canonical output instead of retaining a hash or error from
        # the previously selected image. Scene state and dynamic graph output are
        # one locked, persisted mutation so downstream edges cannot disagree with
        # the Cinema rail.
        canonical = {"imageUrl": image_url, "status": "done"}
        target_shot["selectedVariation"] = index
        target_shot["output"] = canonical
        params["scene"] = scene
        node["params"] = params

        existing = dict(node.get("outputs") or {})
        existing[f"shot_{shot_id}"] = {"type": "Image", "value": image_url}
        node["outputs"] = _normalize_outputs_for_storage(existing)
        cli_graph._maybe_persist()

    return {
        "status": "promoted",
        "shotId": shot_id,
        "selectedVariation": index,
        "imageUrl": image_url,
    }


@app.post("/api/cinema/promote-shot-variation")
async def promote_cinema_shot_variation(
    request: PromoteShotVariationRequest,
) -> dict[str, Any]:
    _check_workspace_revision()
    result = await _promote_shot_variation(
        request.node_id,
        request.shot_id,
        request.index,
    )
    await _broadcast_graph_sync()
    return result


@app.post("/api/cinema/generate-shot")
async def generate_cinema_shot(request: GenerateShotRequest) -> dict:
    """Regenerate ONLY the named shot of a cinema-scene node.

    Reuses the multi-shot handler by running it over a single-shot copy of the
    scene, then merges that one result back into the canonical node so sibling
    shots' outputs/ports are untouched. Upstream character/image inputs resolve
    via the same subgraph mechanism as /api/execute-node."""
    _check_workspace_revision()
    _capture_execution_workspace()
    run_id = request.run_id or f"cinema-shot-{uuid4().hex}"
    _assert_execution_admissible(run_id)
    if execution_runs.get(run_id) is not None:
        raise HTTPException(status_code=409, detail=f"run '{run_id}' already exists")
    canvas_events.note_run(run_id, actor_for_headers(current_request_headers()))
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    nodes = _normalize_execute_nodes(request.nodes)

    target = next((n for n in nodes if n.id == request.node_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail=f"Node '{request.node_id}' not found in graph")
    if target.definition_id != "cinema-scene":
        raise HTTPException(status_code=400, detail=f"Node '{request.node_id}' is not a cinema-scene node")

    scene = (target.params or {}).get("scene")
    if not isinstance(scene, dict):
        raise HTTPException(status_code=400, detail="cinema-scene node has no scene spec")
    _validate_cinema_base_models([target])
    shots = scene.get("shots") or []
    shot = next(
        (s for s in shots if isinstance(s, dict) and str(s.get("id")) == request.shot_id),
        None,
    )
    if shot is None:
        raise HTTPException(status_code=404, detail=f"Shot '{request.shot_id}' not found in scene")

    # Build a single-shot copy of the scene so the handler regenerates ONLY this
    # shot. The seed is applied per-pass via the shot's `_seedOverride` (which the
    # handler honors LAST, so a variation seed wins even over a Character bundle).
    single_scene = copy.deepcopy(scene)
    single_scene["shots"] = [copy.deepcopy(shot)]
    single_node = target.model_copy(update={"params": {**(target.params or {}), "scene": single_scene}})
    patched_nodes = [single_node if n.id == request.node_id else n for n in nodes]

    sub_nodes, sub_edges = get_subgraph(patched_nodes, request.edges, request.node_id)
    if not sub_nodes:
        raise HTTPException(status_code=404, detail=f"Node '{request.node_id}' not found in graph")
    fresh_paid_ancestors = _fresh_paid_worldlabs_claims(sub_nodes)
    if fresh_paid_ancestors:
        blocked_ids = ", ".join(node_id for _kind, node_id in fresh_paid_ancestors)
        raise HTTPException(
            status_code=409,
            detail=(
                "Cinema shot generation cannot implicitly start fresh World Labs "
                f"paid ancestor(s): {blocked_ids}. Run those World nodes on the "
                "Canvas first, then retry the shot with their recovered outputs."
            ),
        )

    errors = validate_graph(sub_nodes, sub_edges, api_keys)
    if errors:
        await manager.broadcast(ValidationErrorEvent(errors=errors, run_id=run_id))
        return {
            "status": "validation_error",
            "errorCount": len(errors),
            "runId": run_id,
        }

    try:
        topological_sort(sub_nodes, sub_edges)
    except CycleError as exc:
        await manager.broadcast(
            ValidationErrorEvent(
                run_id=run_id,
                errors=[{"node_id": "", "port_id": "", "message": f"Subgraph contains a cycle: {exc}"}]
            )
        )
        return {"status": "cycle_error"}

    shot_port = f"shot_{request.shot_id}"
    count = request.variations or 1

    # A per-shot run does not acquire the frontend's Canvas-wide ``isExecuting``
    # gate, so sibling work remains available. It does register its background
    # Task below for strong ownership, Stop/status, and pre-first-turn cleanup,
    # and it must own the same paid-provider lifecycle lease as every other
    # execution surface. Otherwise an exact recovery deletion can race a World
    # ancestor that is still polling, then admit a stale blank payload as a
    # fresh paid start.
    _claim_fresh_paid_worldlabs_starts(run_id=run_id, nodes=sub_nodes)

    async def _run() -> None:
        import traceback

        terminal_error: str | None = None
        try:
            if count > 1:
                # Variation batch: N passes at distinct seeds (cache OFF so each
                # truly regenerates), collected into the shot's variations strip.
                variations: list[dict[str, Any]] = []
                failures: list[str] = []
                for i in range(count):
                    seed_i = (request.seed + i) if request.seed is not None else random.randint(1, 2_147_483_647)
                    try:
                        _executed_node, outputs = await _execute_single_shot_pass(
                            node_id=request.node_id,
                            sub_nodes=sub_nodes,
                            sub_edges=sub_edges,
                            api_keys=api_keys,
                            use_cache=False,
                            seed=seed_i,
                            run_id=run_id,
                        )
                    except _ShotPassError as exc:
                        failures.append(_shot_task_error_message(exc))
                        continue
                    except Exception as exc:
                        traceback.print_exc()
                        failures.append(_shot_task_error_message(exc))
                        continue
                    url = (outputs.get(shot_port) or {}).get("value")
                    if url:
                        variations.append({"url": url, "seed": seed_i})
                    else:
                        failures.append(f"Variation seed {seed_i} returned no image.")
                if variations:
                    await _merge_shot_variations(request.node_id, request.shot_id, variations)
                else:
                    last_failure = failures[-1] if failures else "No variation returned an image."
                    terminal_error = f"All {count} variation passes failed. {last_failure}"
            else:
                executed_node, outputs = await _execute_single_shot_pass(
                    node_id=request.node_id,
                    sub_nodes=sub_nodes,
                    sub_edges=sub_edges,
                    api_keys=api_keys,
                    use_cache=True,
                    seed=request.seed,
                    run_id=run_id,
                )
                await _merge_shot_result(
                    request.node_id, request.shot_id, executed_node, outputs
                )
        except _ShotPassError as exc:
            terminal_error = _shot_task_error_message(exc)
        except Exception as exc:
            traceback.print_exc()
            terminal_error = _shot_task_error_message(exc)
        finally:
            try:
                if terminal_error is not None:
                    await _merge_shot_result(
                        request.node_id,
                        request.shot_id,
                        None,
                        {},
                        terminal_error=terminal_error,
                    )
                await _broadcast_graph_sync()
            finally:
                await _release_paid_worldlabs_starts(run_id)

    task: asyncio.Task[None] | None = None
    run_coroutine = _run()
    try:
        task = asyncio.create_task(run_coroutine)
        # The registry is the strong owner and its terminal callback performs
        # an idempotent lease release. That fallback is essential when a Task
        # is cancelled after create_task succeeds but before _run receives its
        # first event-loop turn (in which case the coroutine's finally never
        # executes).
        execution_runs.register(run_id, task)
        _watch_for_cross_process_stop(run_id, task)
    except ExecutionCancelledBeforeStartError as exc:
        if task is None:
            run_coroutine.close()
        else:
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExecutionCancellationCapacityError as exc:
        if task is None:
            run_coroutine.close()
        else:
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        if task is None:
            run_coroutine.close()
        else:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception:
        if task is None:
            run_coroutine.close()
        else:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        raise

    return {
        "status": "started",
        "shotId": request.shot_id,
        "variations": count,
        "runId": run_id,
    }


# ---------- CLI: Node discovery ----------

@app.get("/api/nodes")
async def list_nodes() -> dict:
    all_nodes = node_registry.get_all()
    nodes_list = list(all_nodes.values())
    categories = node_registry.get_categories()
    return {"nodes": nodes_list, "categories": categories}


def _suggest_node_ids(query: str, all_ids: list[str]) -> list[str]:
    """Find candidate definition ids for a failed `nebula info` lookup.

    Prefix match first (catches family names: `gpt-image-2` → four variants);
    falls back to difflib close matches for typos. Returns [] if nothing is
    close enough — callers should skip the 'Did you mean:' block in that case
    rather than pad the 404 with noise.
    """
    prefix = sorted(nid for nid in all_ids if nid.startswith(query) and nid != query)
    if prefix:
        return prefix
    return difflib.get_close_matches(query, all_ids, n=5, cutoff=0.6)


@app.get("/api/nodes/{node_id}")
async def get_node(node_id: str) -> dict:
    node = node_registry.get(node_id)
    if node is None:
        all_nodes = node_registry.get_all()
        suggestions = _suggest_node_ids(node_id, list(all_nodes.keys()))
        if suggestions:
            lines = [f"Node '{node_id}' not found. Did you mean:"]
            for nid in suggestions:
                meta = all_nodes.get(nid, {})
                display = meta.get("displayName", "")
                category = meta.get("category", "")
                lines.append(f"  - {nid:32s} {display:24s} {category}")
            detail = "\n".join(lines)
        else:
            detail = f"Node '{node_id}' not found"
        raise HTTPException(status_code=404, detail=detail)
    return node


# ---------- CLI: Graph management ----------

_REPLACE_REASONS = ("import", "project-open", "project-create")


async def _broadcast_graph_sync(*, graph_replaced: bool = False, reason: str = "import") -> dict[str, Any]:
    """Push the current CLI graph to all connected frontends via WebSocket.

    `reason` (import, project-open, project-create) only matters when the
    graph was replaced: watchers are told node ids restarted, and why.
    """
    export = await export_graph_for_frontend()
    if graph_replaced:
        agent_presence.forget_graph()
    await manager.broadcast_raw({"type": "graphSync", **export,
                                 **({"graphReplaced": True} if graph_replaced else {})})
    if graph_replaced:
        # Tag, don't reset: seq stays monotonic, and the new project id rides
        # on this event and every one after it.
        try:
            canvas_events.set_project(_workspace_context()["activeProjectId"])
        except Exception:  # noqa: BLE001 - the journal must not break a project switch
            pass
        safe_reason = reason if reason in _REPLACE_REASONS else "import"
        _journal(
            "canvas.replaced",
            data={"reason": safe_reason},
            summary=f"replaced the canvas ({safe_reason})",
        )
        # Pins belong to the project record. A project open or create brings
        # that project's pins; an import into the same project detaches pins
        # whose nodes did not survive.
        canvas_pins.forget_cache()
        detached: list[dict[str, Any]] = []
        if safe_reason == "import":
            try:
                detached = canvas_pins.reanchor_missing(set(cli_graph.nodes))
            except (PinError, ProjectStoreError):
                detached = []
        await _broadcast_pins()
        await _journal_detached_pins(detached, "the canvas was replaced")
        # Proposals point at node ids that just restarted: none of them still fit.
        await _announce_closed_proposals(canvas_proposals.invalidate_all("the canvas was replaced"))
    return export


def _sync_outputs_to_cli_graph(
    node_id: str,
    outputs: dict[str, Any],
) -> dict[str, Any]:
    """Mirror an ExecutedEvent's outputs into cli_graph so endpoints like
    /api/graph/node/{id}/path can resolve to real values. Shape-matches the
    pattern used by /api/graph/run so every execution path converges on the
    same stored shape.

    Return the complete normalized recipe outputs for its execution history.
    Source previews and Cinema shot ports may preserve newer canonical state
    instead of storing every output from an older recipe.
    """
    if not isinstance(outputs, dict):
        normalized_outputs: dict[str, Any] = {}
    else:
        shaped_outputs = {
            k: v if isinstance(v, dict) else {"type": "Any", "value": v}
            for k, v in outputs.items()
        }
        normalized_outputs = _normalize_outputs_for_storage(shaped_outputs)

    if node_id not in cli_graph.nodes:
        return normalized_outputs

    # A running recipe can still be consuming source A after explicit refresh
    # to B. Its event records A, but must not rewind the live source preview.
    current_node = cli_graph.nodes[node_id]
    if current_node.get("definitionId") == "paper-source":
        pinned = current_node.get("params", {}).get("_paperSource", {}).get("snapshot", {})
        if pinned.get("filePath") and normalized_outputs.get("image", {}).get("value") != pinned["filePath"]:
            return normalized_outputs

    if current_node.get("definitionId") == "cinema-scene":
        # A whole-scene recipe owns results for its original shot IDs, not
        # today's authored shot set. Keep newer shots' ports and omit removed
        # shots from the live node, while the event still records all results.
        scene = (current_node.get("params") or {}).get("scene")
        shots = scene.get("shots") if isinstance(scene, dict) else None
        valid_ports = {
            f"shot_{shot['id']}" for shot in shots
            if isinstance(shot, dict) and isinstance(shot.get("id"), str) and shot["id"]
        } if isinstance(shots, list) else set()
        stored_outputs = {
            port: copy.deepcopy(value)
            for port, value in (current_node.get("outputs") or {}).items()
            if not port.startswith("shot_") or port in valid_ports
        }
        stored_outputs.update({
            port: copy.deepcopy(value) for port, value in normalized_outputs.items()
            if not port.startswith("shot_") or port in valid_ports
        })
        if current_node.get("outputs") != stored_outputs:
            current_node["outputs"] = stored_outputs
            cli_graph._maybe_persist()
        return normalized_outputs

    cli_graph.nodes[node_id]["outputs"] = normalized_outputs
    cli_graph._maybe_persist()
    return normalized_outputs


async def _emit_and_sync(event: ExecutionEvent) -> None:
    """Wrap manager.broadcast so ExecutedEvents also mirror their outputs
    into cli_graph. Used by /api/execute and /api/execute-node so the
    frontend-driven execution paths keep cli_graph in sync with what the
    user sees in the canvas."""
    if isinstance(event, ProviderStartAmbiguousEvent):
        # This control-plane event must survive Stop just like a recovered
        # operation ID. It is the only proof that a settled transport/5xx/
        # malformed-2xx response may have started billable provider work.
        run_id = event.run_id or execution_run_id.get()
        if run_id is None:
            event = event.model_copy(
                update={
                    "durable": False,
                    "message": (
                        f"{event.message} Nebula could not associate this hold "
                        "with an execution run; do not reload."
                    ),
                }
            )
        else:
            record = provider_start_guard.mark_ambiguous(
                run_id=run_id,
                node_id=event.node_id,
                kind=event.kind,
            )
            message = str(record["message"])
            if not bool(record["durable"]):
                message += (
                    " Nebula could not save this hold durably; keep this tab "
                    "open and do not restart until the provider state is resolved."
                )
            event = event.model_copy(
                update={
                    "run_id": run_id,
                    "message": message,
                    "durable": bool(record["durable"]),
                }
            )
        await manager.broadcast(event)
        if run_id is not None:
            await _broadcast_graph_sync()
        return

    if isinstance(event, ProviderRecoveryEvent):
        # Paid-provider checkpoints are control-plane state, not progress.
        # Persist and surface them even after Stop has marked the run as
        # cancelling so a late start response cannot strand billable work.
        changed, durability_warning, safety_hold_changed = (
            _sync_provider_recovery_to_cli_graph(event)
        )
        if durability_warning is not None:
            event = event.model_copy(
                update={"durable": False, "warning": durability_warning}
            )
        await manager.broadcast(event)
        if changed or safety_hold_changed:
            await _broadcast_graph_sync()
        return

    run_id = event.run_id or execution_run_id.get()
    record = execution_runs.get(run_id) if run_id else None
    if record is not None and record.status in {"cancelling", "cancelled"}:
        return
    _journal_execution_event(event, run_id)
    if isinstance(event, ErrorEvent) and run_id is not None:
        # The engine reports per-node failures as events and then returns
        # normally after GraphComplete. Preserve that semantic failure in the
        # reconnect/status registry instead of misreporting the task completed.
        execution_runs.mark_error(run_id)
    if isinstance(event, ExecutedEvent):
        # Hand browsers the same portable asset URLs that we persist. Engine
        # handlers intentionally use absolute paths while composing a run, but
        # those paths are not browser-loadable and may live under a relocated
        # output root whose directory name is not literally ``output``.
        normalized_outputs = _sync_outputs_to_cli_graph(event.node_id, event.outputs)
        updates: dict[str, Any] = {"outputs": normalized_outputs}
        if event.batch_outputs is not None:
            updates["batch_outputs"] = [
                _normalize_outputs_for_storage(snapshot)
                for snapshot in event.batch_outputs
            ]
        event = event.model_copy(update=updates)
    await manager.broadcast(event)


def _sync_provider_recovery_to_cli_graph(
    event: ProviderRecoveryEvent,
) -> tuple[bool, str | None, bool]:
    """Replace the durable recovery checkpoint for one canonical graph node."""
    run_id = event.run_id or execution_run_id.get()
    durability_warning: str | None = None
    safety_hold_changed = False
    if run_id is not None:
        try:
            provider_recovery_store.set(
                run_id=run_id,
                node_id=event.node_id,
                resume_operation_id=event.resume_operation_id,
                existing_world_id=event.existing_world_id,
            )
        except (ProviderRecoveryPersistenceError, ValueError) as exc:
            # A hostile/legacy node id must not turn a successfully captured
            # paid operation into an execution failure. The live event and
            # terminal in-memory param sync remain available as fallbacks.
            print(f"[provider-recovery] journal rejected checkpoint: {exc}", flush=True)
            durability_warning = (
                "Nebula captured this paid-provider recovery ID but could not "
                "save it durably. Keep this tab open and copy the ID before "
                "reloading."
            )
            try:
                safety_hold_changed = (
                    provider_start_guard.hold_nondurable_recovery(
                        run_id=run_id,
                        node_id=event.node_id,
                    )
                    is not None
                )
            except ValueError:
                # The live recovery event is still the truthful fallback for
                # a hostile/legacy node identifier that cannot enter a bounded
                # safety journal.
                safety_hold_changed = False
    else:
        durability_warning = (
            "Nebula captured this paid-provider recovery ID without a run ID, "
            "so it could not save it durably. Keep this tab open and copy the "
            "ID before reloading."
        )

    current = cli_graph.nodes.get(event.node_id)
    if current is None:
        return False, durability_warning, safety_hold_changed

    params = copy.deepcopy(current.get("params") or {})
    params.pop("resume_operation_id", None)
    params.pop("existing_world_id", None)
    if event.resume_operation_id is not None:
        params["resume_operation_id"] = event.resume_operation_id
    if event.existing_world_id is not None:
        params["existing_world_id"] = event.existing_world_id
    if current.get("params") == params:
        return False, durability_warning, safety_hold_changed

    current["params"] = params
    cli_graph._maybe_persist()
    return True, durability_warning, safety_hold_changed


def _sync_params_to_cli_graph(nodes: list[GraphNode]) -> bool:
    """Mirror handler-mutated params from in-memory GraphNode instances back
    to cli_graph. Pydantic deep-copies params at model_validate time, so any
    handler that enriches node.params (e.g. video-edit seeding clips +
    sourceDuration after probing) needs an explicit sync — otherwise the
    next /api/graph/export sees the pre-execution state and the canvas
    reverts to whatever the user last set manually."""
    persisted = False
    for node in nodes:
        current = cli_graph.nodes.get(node.id, {})
        if node.definition_id == "cinema-scene":
            # Whole-scene execution mutates only shot.output. The request's
            # authored scene and variation history are snapshots: copying
            # either would erase uploads/edits or a later promotion.
            if current.get("definitionId") != "cinema-scene":
                continue
            params = copy.deepcopy(current.get("params") or {})
            current_scene = params.get("scene")
            current_shots = current_scene.get("shots") if isinstance(current_scene, dict) else None
            if not isinstance(current_shots, list):
                continue
            produced_ports: dict[str, Any] = {}
            valid_ports: set[str] = set()
            for shot in current_shots:
                if not isinstance(shot, dict) or not isinstance(shot.get("id"), str):
                    continue
                valid_ports.add(f"shot_{shot['id']}")
                if shot["id"] in node._cinema_produced_outputs:
                    runtime = copy.deepcopy(node._cinema_produced_outputs[shot["id"]])
                    shot["output"] = runtime
                    if runtime.get("status") in {"done", "error"}:
                        produced_ports[f"shot_{shot['id']}"] = {
                            "type": "Image",
                            "value": runtime.get("imageUrl") if runtime["status"] == "done" else None,
                        }
            if current.get("params") != params:
                current["params"] = params
                persisted = True
            # Partial cancellation may occur before the whole-scene handler
            # returns an ExecutedEvent. Its completed shots still need live
            # ports that agree with the media now shown in their scene output.
            outputs = {
                port: copy.deepcopy(value) for port, value in (current.get("outputs") or {}).items()
                if not port.startswith("shot_") or port in valid_ports
            }
            outputs.update(_normalize_outputs_for_storage(produced_ports))
            if current.get("outputs") != outputs:
                current["outputs"] = outputs
                persisted = True
            continue
        if node.definition_id == "paper-source":
            live = current.get("params", {}).get("_paperSource", {})
            pinned = node.params.get("_paperSource", {})
            if live.get("id") == pinned.get("id") and live.get("sequence", 0) >= pinned.get("sequence", 0):
                continue
        if (
            node.id in cli_graph.nodes
            and cli_graph.nodes[node.id].get("params") != node.params
        ):
            cli_graph.nodes[node.id]["params"] = copy.deepcopy(node.params)
            persisted = True
    if persisted:
        cli_graph._maybe_persist()
    return persisted


def _validate_connect_handles(
    src_node_id: str,
    src_port: str,
    dst_node_id: str,
    dst_port: str,
    *,
    graph: CLIGraph | None = None,
) -> None:
    """Reject a connection that violates the shared registry contract.

    The proposed edge is checked together with existing edges so duplicate
    connections and target-port multiplicity/maxConnections are enforced at
    graph mutation time as well as immediately before execution.
    """
    target_graph = graph or cli_graph
    node_contracts = [
        ContractNode(
            node_id=node_id,
            definition_id=str(node.get("definitionId") or ""),
            params=node.get("params"),
        )
        for node_id, node in target_graph.nodes.items()
    ]
    edge_contracts = [
        ContractEdge(
            edge_id=str(edge.get("id") or ""),
            source=str(edge.get("source") or ""),
            source_handle=edge.get("sourceHandle"),
            target=str(edge.get("target") or ""),
            target_handle=edge.get("targetHandle"),
        )
        for edge in target_graph.edges
    ]
    proposed_index = len(edge_contracts)
    edge_contracts.append(
        ContractEdge(
            edge_id=f"__connect_validation__{uuid4()}",
            source=src_node_id,
            source_handle=src_port,
            target=dst_node_id,
            target_handle=dst_port,
        )
    )
    result = validate_edge_contracts(
        node_contracts,
        edge_contracts,
        node_registry.get_all(),
    )
    proposed_issue = next(
        (issue for issue in result.issues if issue.edge_index == proposed_index),
        None,
    )
    if proposed_issue is not None:
        raise HTTPException(
            status_code=400,
            detail=proposed_issue.message,
        )


def _valid_param_keys(definition_id: str) -> set[str] | None:
    """Gather the set of param keys declared by a node definition.

    Returns None for nodes whose definition isn't found or for universal/dynamic
    nodes — those accept provider-supplied params we don't know up front, so we
    skip key validation rather than produce false negatives.
    """
    defn = node_registry.get(definition_id)
    if not defn:
        return None
    if definition_id in {
        "openrouter-universal",
        "replicate-universal",
        "fal-universal",
        "nous-portal-universal",
    }:
        return None
    keys: set[str] = set()
    for source_key in ("params", "sharedParams", "falParams", "directParams"):
        for p in defn.get(source_key, []) or []:
            if isinstance(p, dict) and p.get("key"):
                keys.add(p["key"])
    return keys


def _to_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    s = str(v).strip().lower()
    if s in ("true", "1", "yes", "on"):
        return True
    if s in ("false", "0", "no", "off", ""):
        return False
    raise ValueError(f"cannot interpret {v!r} as boolean")


def _to_int(v: Any) -> int:
    if isinstance(v, bool):
        raise ValueError(f"refusing to coerce bool {v!r} to integer")
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if v.is_integer():
            return int(v)
        raise ValueError(f"cannot coerce non-integer float {v!r} to integer")
    return int(str(v).strip())


def _to_float(v: Any) -> float:
    if isinstance(v, bool):
        raise ValueError(f"refusing to coerce bool {v!r} to float")
    value = float(v) if isinstance(v, (int, float)) else float(str(v).strip())
    if not math.isfinite(value):
        raise ValueError(f"refusing to coerce non-finite value {v!r} to float")
    return value


def _coerce_params(definition_id: str, params: dict[str, Any]) -> dict[str, Any]:
    """Coerce param values to the types declared in the node definition.

    The CLI sends every `--param k=v` as a string, and some providers (Meshy,
    for one) reject string values where booleans or ints are expected. Normalise
    here so handlers always receive correctly-typed params regardless of the
    caller's transport. Optional numeric controls use ``""`` as their
    canonical UI sentinel for "unset/random/inherit"; preserve that sentinel
    instead of attempting ``int("")`` or ``float("")``.
    """
    defn = node_registry.get(definition_id)
    if not defn:
        return dict(params)
    param_specs: dict[str, tuple[str, bool]] = {}
    for source_key in ("params", "sharedParams", "falParams", "directParams"):
        for p in defn.get(source_key, []) or []:
            if isinstance(p, dict) and p.get("key") and p.get("type"):
                param_specs[p["key"]] = (p["type"], bool(p.get("required")))
    result: dict[str, Any] = {}
    for k, v in params.items():
        if k.startswith("_") or v is None:
            result[k] = v
            continue
        t, required = param_specs.get(k, (None, False))
        try:
            if (
                t in {"integer", "float"}
                and isinstance(v, str)
                and not v.strip()
                and not required
            ):
                result[k] = ""
                continue
            if t == "boolean":
                result[k] = _to_bool(v)
            elif t == "integer":
                result[k] = _to_int(v)
            elif t == "float":
                result[k] = _to_float(v)
            else:
                result[k] = v
        except (ValueError, TypeError) as e:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid value for param '{k}' ({t}): {e}",
            )
    return result


def _validate_params(definition_id: str, params: dict[str, Any]) -> None:
    """Raise 400 if params contain keys the definition doesn't declare.

    Keys starting with `_` are treated as frontend-internal state (e.g.
    `_previewUrl`, `_output_image`) and always allowed. Unknown keys usually
    mean a typo (e.g. `aspectRatio` vs `aspect_ratio`) that would otherwise
    silently fall back to defaults — surfacing it loudly here lets Claude
    correct mid-turn instead of producing an image with wrong settings.
    """
    valid = _valid_param_keys(definition_id)
    if valid is None:
        return
    unknown = [k for k in params if not k.startswith("_") and k not in valid]
    if unknown:
        suggestions: list[str] = []
        for u in unknown:
            u_low = u.lower()
            close = [v for v in valid if v.lower() == u_low or v.lower().replace("_", "") == u_low.replace("_", "")]
            if close:
                suggestions.append(f"{u} (did you mean {', '.join(close)}?)")
            else:
                suggestions.append(u)
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown param(s) for {definition_id}: {suggestions}. "
                f"Valid keys: {sorted(valid)}"
            ),
        )


def _journal_node_added(node_id: str, *, actor: dict[str, Any] | None = None, note: str = "") -> None:
    node = cli_graph.nodes.get(node_id) or {}
    data: dict[str, Any] = {
        "definitionId": str(node.get("definitionId") or ""),
        "name": _node_label(node_id),
    }
    if isinstance(node.get("position"), dict):
        data["position"] = node["position"]
    _journal(
        "node.added",
        node_id=node_id,
        data=data,
        summary=f"added {data['name']} ({node_id}){note}",
        actor=actor,
    )


def _journal_edge(kind: str, edge: dict[str, Any], *, actor: dict[str, Any] | None = None, note: str = "") -> None:
    data = _edge_data(edge)
    verb = "wired" if kind == "edge.added" else "unwired"
    _journal(
        kind,
        node_id=str(data.get("target") or "") or None,
        data=data,
        summary=(
            f"{verb} {data['source']}.{data['sourceHandle']} → "
            f"{data['target']}.{data['targetHandle']}{note}"
        ),
        actor=actor,
    )


def _journal_cluster(
    node_ids: list[str],
    edge_ids: list[str],
    *,
    actor: dict[str, Any] | None = None,
    note: str = "",
) -> None:
    """One node.added per node and edge.added per wire, each capped at 50."""
    for node_id in node_ids[:50]:
        _journal_node_added(node_id, actor=actor, note=note)
    if len(node_ids) > 50:
        rest = node_ids[50:]
        _journal(
            "node.added",
            data={"count": len(rest), "nodeIds": rest[:50]},
            summary=f"added {len(rest)} more nodes{note}",
            actor=actor,
        )
    wanted = set(edge_ids)
    for edge in [edge for edge in cli_graph.edges if edge.get("id") in wanted][:50]:
        _journal_edge("edge.added", edge, actor=actor, note=note)


def _moved_far_enough(before: Any, after: dict[str, float]) -> bool:
    if not isinstance(before, dict):
        return False
    try:
        dx = float(after["x"]) - float(before.get("x", 0.0))
        dy = float(after["y"]) - float(before.get("y", 0.0))
    except (TypeError, ValueError):
        return False
    return math.hypot(dx, dy) >= MOVE_THRESHOLD_PX


@app.post("/api/graph/node")
async def create_graph_node(body: dict[str, Any]) -> dict:
    _check_workspace_revision()
    _validate_graph_ingress_complexity(body)
    definition_id = body.get("definitionId", "")
    raw_params = body.get("params", {})
    params = {} if raw_params is None else raw_params
    if not isinstance(params, dict):
        raise HTTPException(status_code=400, detail="params must be an object")
    position = body.get("position")
    _validate_params(definition_id, params)
    params = _coerce_params(definition_id, params)
    carries_recovery = bool(
        _graph_worldlabs_recovery_checkpoints(
            [{"id": "new-node", "definitionId": definition_id, "params": params}]
        )
    )
    mutation = (
        _paid_graph_mutation("create a graph node")
        if carries_recovery
        else nullcontext()
    )
    with mutation:
        candidate = cli_graph.clone()
        short_id = candidate.add_node(definition_id, params, position=position)
        _commit_graph_candidate_with_recoveries(
            candidate,
            [candidate.nodes[short_id]],
            source="create",
        )
    await _broadcast_graph_sync()
    publish_action(f"Added {definition_id} ({short_id})")
    _journal_node_added(short_id)
    await _show_agent({"nodeId": short_id}, say=f"Added {_node_label(short_id)}")
    return cli_graph.nodes[short_id]


@app.post("/api/graph/connect")
async def connect_graph_nodes(body: dict[str, Any]) -> dict:
    _check_workspace_revision()
    _validate_connect_handles(
        body.get("source", ""),
        body.get("sourceHandle", ""),
        body.get("target", ""),
        body.get("targetHandle", ""),
    )
    try:
        edge = cli_graph.connect(
            body["source"], body["sourceHandle"],
            body["target"], body["targetHandle"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _broadcast_graph_sync()
    publish_action(
        f"Wired {edge['source']}:{edge['sourceHandle']} → "
        f"{edge['target']}:{edge['targetHandle']}"
    )
    _journal_edge("edge.added", edge)
    await _show_agent(
        {"nodeId": edge["target"], "handle": edge["targetHandle"]},
        origin={"nodeId": edge["source"], "handle": edge["sourceHandle"]},
        action="drag",
        say=f"Wiring {edge['source']} → {edge['target']}",
    )
    return {"connection": f"{edge['source']}:{edge['sourceHandle']} -> {edge['target']}:{edge['targetHandle']}"}


@app.post("/api/graph/node-and-connect")
async def create_node_and_connect(body: dict[str, Any]) -> dict:
    """Create a node and wire it to an existing node in a single atomic call.

    The ConnectionPopup flow needs both — otherwise the caller races against
    graphSync to find the freshly-created node's short ID before connecting.
    Body: {definitionId, params, position?, connect: {source, sourceHandle,
    target, targetHandle, newNodeIs: 'source' | 'target'}}. The `newNodeIs`
    field tells us which port on the `connect` spec should be filled in with
    the new node's id (the other side is the existing node).
    """
    _check_workspace_revision()
    _validate_graph_ingress_complexity(body)
    definition_id = body.get("definitionId", "")
    raw_params = body.get("params", {})
    params = {} if raw_params is None else raw_params
    if not isinstance(params, dict):
        raise HTTPException(status_code=400, detail="params must be an object")
    position = body.get("position")
    if position is not None and not isinstance(position, dict):
        raise HTTPException(status_code=400, detail="position must be an object")
    connect_spec = body.get("connect")
    if connect_spec is None:
        connect_spec = {}
    if not isinstance(connect_spec, dict):
        raise HTTPException(status_code=400, detail="connect must be an object")
    if connect_spec:
        if connect_spec.get("newNodeIs") not in ("source", "target"):
            raise HTTPException(status_code=400, detail="connect.newNodeIs must be 'source' or 'target'")
        existing_side = "source" if connect_spec["newNodeIs"] == "target" else "target"
        for key in (existing_side, "sourceHandle", "targetHandle"):
            if not isinstance(connect_spec.get(key), str) or not connect_spec[key]:
                raise HTTPException(status_code=400, detail=f"connect.{key} must be a non-empty string")
    _validate_params(definition_id, params)
    params = _coerce_params(definition_id, params)
    carries_recovery = bool(
        _graph_worldlabs_recovery_checkpoints(
            [{"id": "new-node", "definitionId": definition_id, "params": params}]
        )
    )
    mutation = (
        _paid_graph_mutation("create and connect a graph node")
        if carries_recovery
        else nullcontext()
    )
    with mutation:
        candidate = cli_graph.clone()
        try:
            short_id = candidate.add_node(definition_id, params, position=position)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"Cannot create this node: {exc}") from exc

        edge = None
        if connect_spec:
            is_target = connect_spec.get("newNodeIs") == "target"
            src = connect_spec.get("source") if is_target else short_id
            dst = short_id if is_target else connect_spec.get("target")
            try:
                if src not in candidate.nodes or dst not in candidate.nodes:
                    raise HTTPException(status_code=400, detail="connect references an unknown source or target node")
                _validate_connect_handles(
                    src,
                    connect_spec.get("sourceHandle", ""),
                    dst,
                    connect_spec.get("targetHandle", ""),
                    graph=candidate,
                )
                edge = candidate.connect(
                    src,
                    connect_spec.get("sourceHandle", ""),
                    dst,
                    connect_spec.get("targetHandle", ""),
                )
                # Deleting an earlier edge can leave the len+1 allocator at an
                # existing id. The confirmed pair needs a unique edge identity.
                used_edge_ids = {existing["id"] for existing in candidate.edges[:-1]}
                edge_number = len(candidate.edges)
                while edge["id"] in used_edge_ids:
                    edge_number += 1
                    edge["id"] = f"e{edge_number}"
            except ValueError as exc:
                # Discard the persistence-free candidate on every connection
                # failure; the caller requested a pair, not a standalone node.
                raise HTTPException(status_code=400, detail=f"Cannot connect this node: {exc}") from exc

        _commit_graph_candidate_with_recoveries(
            candidate,
            [candidate.nodes[short_id]],
            source="create-connect",
        )

    rf_edge = None
    if edge is not None:
        source_node = candidate.nodes[src]
        source_def = node_registry.get(source_node["definitionId"]) or {}
        source_ports = (cinema_output_ports(source_node.get("params"))
                        if source_node["definitionId"] == "cinema-scene"
                        else source_def.get("outputPorts", []))
        data_type = next((port["dataType"] for port in source_ports
                          if port["id"] == edge["sourceHandle"]), "Any")
        rf_edge = {**copy.deepcopy(edge), "type": "typed-edge", "data": {"dataType": data_type}}
    # Preserve the raw top-level node contract for existing CLI callers while
    # letting the canvas adopt only a connection explicitly confirmed by us.
    response = {**copy.deepcopy(candidate.nodes[short_id]), "connected": edge is not None, "edge": rf_edge}
    await _broadcast_graph_sync()
    publish_action(f"Added {definition_id} ({short_id})")
    _journal_node_added(short_id)
    if edge is not None:
        _journal_edge("edge.added", edge)
        publish_action(
            f"Wired {src}:{connect_spec.get('sourceHandle', '')} → "
            f"{dst}:{connect_spec.get('targetHandle', '')}"
        )
        await _show_agent(
            {"nodeId": dst, "handle": connect_spec.get("targetHandle", "")},
            origin={"nodeId": src, "handle": connect_spec.get("sourceHandle", "")},
            action="drag",
            say=f"Added {_node_label(short_id)} and wired it",
        )
    else:
        await _show_agent({"nodeId": short_id}, say=f"Added {_node_label(short_id)}")
    return response


def _cinema_motion_image_ref(value: Any) -> str:
    """Compare saved paths and browser previews without fetching any media."""
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError("image reference must be a trimmed non-empty string")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("image reference contains control characters")
    if value.startswith(("http://", "https://")):
        parsed = urlsplit(value)
        if not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("image reference must have a valid HTTP origin")
        if parsed.hostname in {"localhost", "127.0.0.1", "::1"} and parsed.path.startswith("/api/outputs/"):
            if parsed.query or parsed.fragment:
                raise ValueError("local image reference cannot contain a query or fragment")
            return portable_output_ref(parsed.path)
        # Remote images are opaque identities, including signed query strings.
        # A handoff connects existing media; it never downloads or generates it.
        return value
    return portable_output_ref(value)


def _cinema_motion_source_position(node_id: str) -> dict[str, float]:
    """Use the source's saved position or the same fallback as canvas export."""
    positioned = {
        node["id"]: node["position"]
        for node in cli_graph.nodes.values()
        if isinstance(node.get("position"), dict)
        and "x" in node["position"] and "y" in node["position"]
    }
    if node_id in positioned:
        position = {axis: float(positioned[node_id][axis]) for axis in ("x", "y")}
        if not all(math.isfinite(value) for value in position.values()):
            raise ValueError("Cinema source position requires finite coordinates")
        return position
    max_x = max((-300.0, *(float(position["x"]) for position in positioned.values())))
    for existing_id in cli_graph.nodes:
        if existing_id not in positioned:
            max_x += 300.0
            if existing_id == node_id:
                return {"x": max_x, "y": 100.0}
    raise ValueError("Cinema source position is unavailable")


@app.post("/api/cinema/send-to-motion")
async def send_cinema_shot_to_motion(body: dict[str, Any]) -> dict:
    """Create or reuse an exact shot-to-Veo connection without running it.

    Validation, candidate construction and durable adoption contain no await.
    Overlapping requests in this server therefore see the committed edge and
    retries after a lost acknowledgement do not produce duplicate nodes.
    """
    _check_workspace_revision()
    _validate_graph_ingress_complexity(body)
    node_id = body.get("nodeId")
    shot_id = body.get("shotId")
    if not isinstance(node_id, str) or not node_id or not isinstance(shot_id, str) or not shot_id:
        raise HTTPException(status_code=400, detail="nodeId and shotId must be non-empty strings")
    try:
        expected_image = _cinema_motion_image_ref(body.get("expectedImageUrl"))
    except (ValueError, OSError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid expected image: {exc}") from exc

    source = cli_graph.nodes.get(node_id)
    if source is None:
        raise HTTPException(status_code=409, detail="The Cinema source was removed; reopen the current scene")
    if source.get("definitionId") != "cinema-scene":
        raise HTTPException(status_code=400, detail="The source must be a cinema-scene node")
    scene = source.get("params", {}).get("scene")
    shots = scene.get("shots") if isinstance(scene, dict) else None
    matches = [shot for shot in shots if isinstance(shot, dict) and shot.get("id") == shot_id] if isinstance(shots, list) else []
    if len(matches) != 1:
        raise HTTPException(status_code=409, detail="The Cinema shot was removed or changed; reopen the current shot")
    output = matches[0].get("output")
    port_id = f"shot_{shot_id}"
    port = source.get("outputs", {}).get(port_id)
    if not isinstance(output, dict) or output.get("status") != "done" or not isinstance(port, dict) or port.get("type") != "Image":
        raise HTTPException(status_code=409, detail="Wait for this shot's image to finish before sending it to motion")
    try:
        settled_image = _cinema_motion_image_ref(output.get("imageUrl"))
        connected_image = _cinema_motion_image_ref(port.get("value"))
    except (ValueError, OSError, RuntimeError) as exc:
        raise HTTPException(status_code=409, detail="The shot's image is unavailable; refresh the current scene") from exc
    if expected_image != settled_image or connected_image != settled_image:
        raise HTTPException(status_code=409, detail="This shot's image changed; review the current image and send it again")

    contracts = validate_edge_contracts(
        [ContractNode(node_id=existing_id, definition_id=str(node.get("definitionId") or ""), params=node.get("params"))
         for existing_id, node in cli_graph.nodes.items()],
        [ContractEdge(edge_id=str(edge.get("id") or ""), source=str(edge.get("source") or ""),
                      source_handle=edge.get("sourceHandle"), target=str(edge.get("target") or ""),
                      target_handle=edge.get("targetHandle")) for edge in cli_graph.edges],
        node_registry.get_all(),
    )
    # Graph edge order is stable across persistence/reload. Choose the first
    # valid exact connection when a user has deliberately made several.
    edge = next((edge for index, edge in enumerate(cli_graph.edges)
                 if index in contracts.valid_edge_indexes
                 and edge.get("source") == node_id and edge.get("sourceHandle") == port_id
                 and edge.get("targetHandle") == "image"
                 and cli_graph.nodes.get(edge.get("target"), {}).get("definitionId") == "veo-3"), None)
    created = edge is None
    if created:
        definition = node_registry.get("veo-3")
        if not definition:
            raise HTTPException(status_code=400, detail="The Veo motion node is unavailable")
        param_sources = ([*definition["sharedParams"], *definition.get("falParams", []), *definition.get("directParams", [])]
                         if "sharedParams" in definition else definition.get("params", []))
        defaults = {param["key"]: copy.deepcopy(param["default"]) for param in param_sources if "default" in param}
        _validate_params("veo-3", defaults)
        defaults = _coerce_params("veo-3", defaults)
        try:
            position = _cinema_motion_source_position(node_id)
            candidate = cli_graph.clone()
            target_id = candidate.add_node("veo-3", defaults, position={"x": position["x"] + 360.0, "y": position["y"]})
            _validate_connect_handles(node_id, port_id, target_id, "image", graph=candidate)
            edge = candidate.connect(node_id, port_id, target_id, "image")
            # CLIGraph's sequential edge allocator can collide after deletion.
            # Keep this new connection's identity valid before durable adoption.
            used_edge_ids = {existing["id"] for existing in candidate.edges[:-1]}
            edge_number = len(candidate.edges)
            while edge["id"] in used_edge_ids:
                edge_number += 1
                edge["id"] = f"e{edge_number}"
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Cannot connect this shot to motion: {exc}") from exc
        # This action adds only an ordinary Veo node/edge. Existing recovery
        # records and every other node's authoring/results remain unchanged.
        cli_graph.replace_with(candidate)
    assert edge is not None
    target = cli_graph.nodes[edge["target"]]
    response = {
        "node": copy.deepcopy(_cli_node_to_rf(target, _cinema_motion_source_position(target["id"]), node_registry.get_all())),
        "edge": {**copy.deepcopy(edge), "type": "typed-edge", "data": {"dataType": "Image"}},
    }
    if created:
        await _broadcast_graph_sync()
        publish_action(f"Connected Cinema {node_id}:{port_id} to Veo ({target['id']})")
    return response


@app.get("/api/graph")
async def get_graph() -> dict:
    return cli_graph.get_state()


@app.put("/api/graph/node/{node_id}")
async def update_graph_node(request: Request, node_id: str, body: dict[str, Any]) -> dict:
    _check_workspace_revision()
    _validate_graph_ingress_complexity(body)
    with _paid_graph_mutation("update graph node parameters"):
        node = cli_graph.nodes.get(node_id)
        if not node:
            raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
        params_before = copy.deepcopy(node.get("params") or {})

        # §1.5 guard (mirrors /api/graph/run): when called BY Daedalus, refuse to
        # mutate params on a node that already has outputs. Without this, Daedalus
        # could route around the run-target guard via `nebula set` + `run-all`
        # (cache-bypassed because params changed). The X-Daedalus-Caller header
        # gate keeps frontend Inspector edits and curl/tests unaffected.
        if request.headers.get("x-daedalus-caller"):
            existing_outputs = node.get("outputs")
            if isinstance(existing_outputs, dict) and len(existing_outputs) > 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Node '{node_id}' already has output. Per SKILL.md §1.5, "
                        "add a new node instead of mutating params on this one — the "
                        "canvas should keep every iteration visible as craft history. "
                        "Use `nebula create <definition_id>` to start the next cut, "
                        "wire it from the corrected upstream, then `nebula run` it."
                    ),
                )

        raw_params = body.get("params", {})
        params = {} if raw_params is None else raw_params
        if not isinstance(params, dict):
            raise HTTPException(status_code=400, detail="params must be an object")
        _validate_params(node.get("definitionId", ""), params)
        params = _coerce_params(node.get("definitionId", ""), params)
        if node.get("definitionId") == "cinema-scene" and "scene" in params:
            # Studio/Inspector PUTs carry authoring snapshots captured before
            # a generation or promotion may have installed fresher media.
            # Runtime media belongs to the canonical shot, not that snapshot.
            incoming_scene = params["scene"]
            if not isinstance(incoming_scene, dict) or not isinstance(incoming_scene.get("shots"), list):
                raise HTTPException(400, "Cinema scene must be an object with a shots array")
            shots = incoming_scene["shots"]
            if any(not isinstance(shot, dict) or not isinstance(shot.get("id"), str)
                   or not shot["id"] for shot in shots):
                raise HTTPException(400, "Cinema shots require non-empty string IDs")
            if len({shot["id"] for shot in shots}) != len(shots):
                raise HTTPException(400, "Cinema shot IDs must be unique")
            current_scene = (node.get("params") or {}).get("scene")
            stored_shots = current_scene.get("shots") if isinstance(current_scene, dict) else None
            current_shots = {
                shot["id"]: shot for shot in (stored_shots if isinstance(stored_shots, list) else [])
                if isinstance(shot, dict) and isinstance(shot.get("id"), str)
            }
            authored_scene = copy.deepcopy(incoming_scene)
            for shot in authored_scene["shots"]:
                canonical = current_shots.get(shot["id"])
                for field in ("output", "variations", "selectedVariation"):
                    shot.pop(field, None)
                    if canonical is not None and field in canonical:
                        shot[field] = copy.deepcopy(canonical[field])
                if canonical is None:
                    shot["output"] = {"status": "idle"}
            params["scene"] = authored_scene
            # Deleted shots no longer own live ports/connections. Import and
            # generation/promotion routes retain their separate media contract.
            valid_ports = {f"shot_{shot['id']}" for shot in authored_scene["shots"]}
            node["outputs"] = {
                port: output for port, output in (node.get("outputs") or {}).items()
                if not port.startswith("shot_") or port in valid_ports
            }
            cli_graph.edges = [edge for edge in cli_graph.edges
                               if edge.get("source") != node_id
                               or not str(edge.get("sourceHandle", "")).startswith("shot_")
                               or edge["sourceHandle"] in valid_ports]
        recovery_update = isinstance(node.get("definitionId"), str) and uses_durable_recovery(
            str(node.get("definitionId")),
            provider="worldlabs",
        )
        if recovery_update:
            # Inspector writes are debounced whole-param snapshots. A response
            # captured after that snapshot may already have installed a provider
            # recovery ID, so a late PUT must not erase or rewind server-owned
            # safety state. The exact provider-recovery DELETE route is the only
            # way to clear a live checkpoint deliberately.
            current_params = node.get("params") or {}
            policy_fields = recovery_param_names(str(node.get("definitionId") or ""))
            checkpoint = {
                key: value
                for key in policy_fields
                if isinstance((value := current_params.get(key)), str)
                and bool(value.strip())
            }
            if checkpoint:
                for key in policy_fields:
                    params.pop(key, None)
                params.update(checkpoint)
            candidate = cli_graph.clone()
            try:
                candidate.update_params(node_id, params)
            except ValueError:
                raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
            _commit_graph_candidate_with_recoveries(
                candidate,
                [candidate.nodes[node_id]],
                source="update",
            )
        else:
            try:
                cli_graph.update_params(node_id, params)
            except ValueError:
                raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    await _broadcast_graph_sync()
    publish_action(f"Updated {node_id} params")
    changes = param_changes(params_before, (cli_graph.nodes.get(node_id) or {}).get("params") or {})
    if changes:
        _journal(
            "node.params",
            node_id=node_id,
            data=changes,
            summary=f"set {_listed(changes['keys'], 4)} on {_node_label(node_id)} ({node_id})",
        )
    changed = ", ".join(sorted(str(key) for key in params)[:4])
    await _show_agent({"nodeId": node_id}, say=f"Set {changed}" if changed else f"Updated {node_id}")
    return cli_graph.nodes[node_id]


@app.put("/api/graph/layout")
async def update_graph_layout(body: dict[str, Any]) -> dict:
    """Persist a complete or partial Canvas layout in one atomic mutation."""
    _check_workspace_revision()
    raw_positions = body.get("positions")
    if not isinstance(raw_positions, dict) or not raw_positions:
        raise HTTPException(status_code=400, detail="positions must be a non-empty object")

    normalized: dict[str, dict[str, float]] = {}
    for node_id, raw_position in raw_positions.items():
        if node_id not in cli_graph.nodes:
            raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
        if not isinstance(raw_position, dict):
            raise HTTPException(status_code=400, detail=f"Position for '{node_id}' must be an object")
        try:
            x = float(raw_position["x"])
            y = float(raw_position["y"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(
                status_code=400,
                detail=f"Position for '{node_id}' requires numeric x and y",
            )
        if not math.isfinite(x) or not math.isfinite(y):
            raise HTTPException(
                status_code=400,
                detail=f"Position for '{node_id}' requires finite x and y",
            )
        normalized[node_id] = {"x": x, "y": y}

    # Agent-created nodes have no stored position until first moved; compare
    # against where the canvas drew them, or the first drag would go unseen.
    shown = _display_positions(list(cli_graph.nodes.values()))
    previous = {node_id: shown.get(node_id) for node_id in normalized}
    try:
        cli_graph.update_positions(normalized)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    await _broadcast_graph_sync()
    publish_action(f"Updated layout for {len(normalized)} node(s)")
    # This route is the authoritative move signal (drag end, auto-layout,
    # paste).
    moved = [
        node_id
        for node_id, position in normalized.items()
        if _moved_far_enough(previous.get(node_id), position)
    ]
    if moved:
        _journal(
            "node.moved",
            node_id=moved[0] if len(moved) == 1 else None,
            data={"nodeIds": moved[:50], "count": len(moved)},
            summary=f"moved {_listed(moved)}",
        )
    return {"status": "updated", "count": len(normalized)}


@app.delete("/api/graph")
async def clear_graph() -> dict:
    # Clear Canvas is not consent to forget paid-provider state. Resolve each
    # recovery/ambiguity through its exact endpoint first; otherwise recreating
    # a node with the same identity could silently duplicate provider spend.
    _check_workspace_revision()
    with _paid_graph_mutation("clear the canvas"):
        _reject_graph_replacement_during_paid_start("clear the canvas")
        cli_graph.clear()
    agent_presence.forget_graph()
    await _broadcast_graph_sync()
    publish_action("Cleared the canvas")
    _journal("canvas.cleared", summary="cleared the canvas")
    try:
        detached = canvas_pins.reanchor_missing(set())
    except (PinError, ProjectStoreError):
        detached = []
    await _journal_detached_pins(detached, "the canvas was cleared")
    await _announce_closed_proposals(canvas_proposals.invalidate_all("the canvas was cleared"))
    return {"status": "cleared"}


@app.delete("/api/provider-recoveries/{run_id}/{node_id}")
async def delete_provider_recovery(
    run_id: str,
    node_id: str,
    resume_operation_id: str | None = None,
    existing_world_id: str | None = None,
) -> dict:
    """Forget one exact paid-provider checkpoint after an explicit clear."""
    with _paid_graph_mutation("delete a provider recovery checkpoint"):
        try:
            active = provider_start_guard.has_active_node(node_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if active:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Cannot delete a World Labs recovery checkpoint while that "
                    "node's paid start is still settling"
                ),
            )
        try:
            removed = provider_recovery_store.delete(
                run_id=run_id,
                node_id=node_id,
                resume_operation_id=resume_operation_id,
                existing_world_id=existing_world_id,
            )
        except ProviderRecoveryConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ProviderRecoveryPersistenceError as exc:
            raise HTTPException(
                status_code=507,
                detail="Could not durably delete provider recovery checkpoint",
            ) from exc
        current = cli_graph.nodes.get(node_id)
        if (
            removed
            and current is not None
            and isinstance(current.get("definitionId"), str)
            and uses_durable_recovery(
                str(current.get("definitionId")),
                provider="worldlabs",
            )
        ):
            params = copy.deepcopy(current.get("params") or {})
            policy = operation_policy(str(current.get("definitionId") or ""))
            deleted_by_param = (
                {
                    policy.recovery_operation_param: resume_operation_id,
                    policy.recovery_resource_param: existing_world_id,
                }
                if policy is not None
                else {}
            )
            deleted_by_param.pop(None, None)
            matches_deleted_checkpoint = any(
                isinstance(provider_id, str)
                and provider_id
                and params.get(param_key) == provider_id
                for param_key, provider_id in deleted_by_param.items()
            )
            if matches_deleted_checkpoint:
                for param_key in deleted_by_param:
                    params.pop(param_key, None)
                current["params"] = params
                cli_graph._maybe_persist()
    await _broadcast_graph_sync()
    return {
        "status": "deleted",
        "runId": run_id,
        "nodeId": node_id,
        "removed": removed,
    }


@app.delete("/api/provider-start-ambiguities/{kind}/{node_id}/{run_id}")
async def acknowledge_provider_start_ambiguity(
    kind: str,
    node_id: str,
    run_id: str,
) -> dict:
    """Explicitly unlock one paid-start hold after checking Marble."""
    try:
        removed = provider_start_guard.acknowledge(
            kind=kind,
            node_id=node_id,
            run_id=run_id,
        )
    except ProviderStartConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProviderStartPersistenceError as exc:
        raise HTTPException(
            status_code=507,
            detail="Could not durably acknowledge World Labs paid-start hold",
        ) from exc
    await _broadcast_graph_sync()
    return {
        "status": "acknowledged",
        "kind": kind,
        "nodeId": node_id,
        "runId": run_id,
        "removed": removed,
    }


@app.delete("/api/graph/node/{node_id}")
async def delete_graph_node(node_id: str) -> dict:
    """Remove a node and any edges touching it from cli_graph."""
    _check_workspace_revision()
    with _paid_graph_mutation("delete a graph node"):
        node = cli_graph.nodes.get(node_id)
        if node is None:
            raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
        try:
            active = provider_start_guard.has_active_node(node_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        held = any(
            record.get("nodeId") == node_id for record in provider_start_guard.list()
        )
        recovered = any(
            record.get("nodeId") == node_id
            for record in provider_recovery_store.list()
        )
        params = node.get("params") or {}
        live_checkpoint = has_recovery_identity(
            str(node.get("definitionId") or ""), params
        )
        if active or held or recovered or live_checkpoint:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Cannot delete a node with unresolved World Labs paid state. "
                    "Check Marble, then resolve its exact recovery/ambiguity record "
                    "first."
                ),
            )
        label = _node_label(node_id)
        removed_definition = str(node.get("definitionId") or "")
        removed_position = copy.deepcopy(node.get("position"))
        try:
            cli_graph.remove_node(node_id)
        except ValueError:
            raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    await _broadcast_graph_sync()
    publish_action(f"Removed {node_id}")
    _journal(
        "node.removed",
        node_id=node_id,
        data={"name": label, "definitionId": removed_definition},
        summary=f"removed {label} ({node_id})",
    )
    try:
        detached = canvas_pins.detach_node(node_id, removed_position)
    except (PinError, ProjectStoreError):
        detached = []
    await _journal_detached_pins(detached, f"{label} was deleted")
    await _announce_closed_proposals(
        canvas_proposals.invalidate_referencing(node_id, f"{label} ({node_id}) was deleted")
    )
    last_point = agent_presence.last_point(node_id)
    agent_presence.forget_node(node_id)
    if last_point is not None:
        await _show_agent(last_point, say=f"Removed {label}")
    return {"status": "deleted", "id": node_id}


@app.get("/api/graph/node/{node_id}/path")
async def get_node_image_path(node_id: str) -> dict:
    """Resolve a node's primary image file to an absolute local path.

    Only works for image-input nodes (via their `filePath`, `file`, or
    `_previewUrl` param) or model nodes with an image-typed output.
    External URLs (anything not served from OUTPUT_ROOT) are rejected.
    Used by `nebula path` so Claude can Read node images as vision content.
    """
    node = cli_graph.nodes.get(node_id)
    if not node:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")

    url = _resolve_primary_image_url(node)
    if url is None:
        raise HTTPException(
            status_code=400,
            detail=f"No image file for node '{node_id}'",
        )

    local_path = _url_to_output_path(url)
    if local_path is None:
        raise HTTPException(
            status_code=400,
            detail=f"Image for node '{node_id}' is not local (external URL)",
        )
    return {"path": str(local_path.resolve())}


def _resolve_primary_image_url(node: dict[str, Any]) -> str | None:
    """Return the best URL to read for this node, or None if it has no image."""
    params = node.get("params") or {}
    outputs = node.get("outputs") or {}
    definition_id = node.get("definitionId", "")

    if definition_id == "image-input":
        # filePath is the canonical schema key (see node_definitions.json).
        # `file` is accepted as a fallback because some backend code paths
        # (including the existing /api/upload endpoint and Task 3's new
        # chat-uploads endpoint) set that key alongside _previewUrl.
        value = (
            params.get("filePath")
            or params.get("file")
            or params.get("_previewUrl")
        )
        return str(value) if value else None

    # Model nodes with an image output produce {"image": {"type": "Image", "value": "..."}}
    # Walk outputs looking for any entry tagged as an Image with a value, preferring
    # the conventional "image" port name.
    preferred = outputs.get("image")
    if isinstance(preferred, dict) and preferred.get("value"):
        return str(preferred["value"])
    for out in outputs.values():
        if isinstance(out, dict) and out.get("type") == "Image" and out.get("value"):
            return str(out["value"])

    # Fallback: _previewUrl is currently only populated for image-input nodes.
    preview = params.get("_previewUrl")
    return str(preview) if preview else None


def _url_to_output_path(value: str) -> Path | None:
    """Resolve a node's image reference to a local filesystem path under
    OUTPUT_ROOT. Accepts either a served URL (`/api/outputs/...`) or an
    absolute local filesystem path. External URLs (http://, https://) and
    paths outside OUTPUT_ROOT return None so callers reject with a clear
    error."""
    return _output_path_from_ref(value)


@app.delete("/api/graph/edge")
async def delete_graph_edge(body: dict[str, Any]) -> dict:
    """Remove the edge matching source/sourceHandle/target/targetHandle."""
    _check_workspace_revision()
    removed = cli_graph.remove_edge(
        body.get("source", ""),
        body.get("sourceHandle", ""),
        body.get("target", ""),
        body.get("targetHandle", ""),
    )
    if removed:
        await _broadcast_graph_sync()
        _journal_edge("edge.removed", body)
        publish_action(
            f"Unwired {body.get('source', '')}:{body.get('sourceHandle', '')} → "
            f"{body.get('target', '')}:{body.get('targetHandle', '')}"
        )
        if body.get("target") in cli_graph.nodes:
            await _show_agent(
                {"nodeId": body["target"]},
                say=f"Unwired {body.get('source', '')} → {body.get('target', '')}",
            )
    return {"status": "deleted" if removed else "not_found"}


def _graph_ingress_items(body: dict[str, Any], key: str) -> list[dict[str, Any]]:
    value = body.get(key, [])
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail=f"'{key}' must be an array")
    if not all(isinstance(item, dict) for item in value):
        raise HTTPException(status_code=400, detail=f"every '{key}' item must be an object")
    return value


def _validate_graph_ingress_complexity(value: Any) -> None:
    """Bound and reject non-finite values on every mutable graph ingress."""
    _check_workspace_revision()
    stack: list[tuple[Any, int]] = [(value, 0)]
    value_count = 0
    while stack:
        current, depth = stack.pop()
        value_count += 1
        if value_count > RESTORE_MAX_GRAPH_VALUES:
            raise HTTPException(status_code=413, detail="graph payload contains too many values")
        if depth > RESTORE_MAX_GRAPH_DEPTH:
            raise HTTPException(status_code=400, detail="graph payload is nested too deeply")
        if isinstance(current, float) and not math.isfinite(current):
            raise HTTPException(status_code=400, detail="graph payload contains a non-finite number")
        if isinstance(current, dict):
            stack.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)
    validate_file_references(value)


def _stage_graph_nodes(
    candidate: CLIGraph,
    raw_nodes: list[dict[str, Any]],
    *,
    reference_key: str,
    include_outputs: bool,
    normalize_image_inputs: bool = True,
) -> dict[str, str]:
    """Validate and add ingress nodes to a persistence-free candidate graph."""
    id_map: dict[str, str] = {}
    for index, raw in enumerate(raw_nodes):
        reference = raw.get(reference_key)
        if not isinstance(reference, str) or not reference:
            raise HTTPException(
                status_code=400,
                detail=f"nodes[{index}].{reference_key} must be a non-empty string",
            )
        if reference in id_map:
            raise HTTPException(
                status_code=400,
                detail=f"duplicate node reference '{reference}'",
            )
        definition_id = raw.get("definitionId")
        if not isinstance(definition_id, str) or not definition_id:
            raise HTTPException(
                status_code=400,
                detail=f"nodes[{index}].definitionId must be a non-empty string",
            )
        if node_registry.get(definition_id) is None:
            raise HTTPException(
                status_code=400,
                detail=f"unknown node definition '{definition_id}'",
            )
        raw_params = raw.get("params", {})
        params = {} if raw_params is None else raw_params
        if not isinstance(params, dict):
            raise HTTPException(
                status_code=400,
                detail=f"nodes[{index}].params must be an object",
            )
        _validate_params(definition_id, params)
        params = _coerce_params(definition_id, params)
        if definition_id == "image-input" and normalize_image_inputs:
            params = _normalize_image_input_params(params)

        position = raw.get("position")
        if position is not None and not isinstance(position, dict):
            raise HTTPException(
                status_code=400,
                detail=f"nodes[{index}].position must be an object",
            )
        if position is not None:
            coordinates = [position.get("x"), position.get("y")]
            if any(
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(float(value))
                for value in coordinates
            ):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"nodes[{index}].position requires finite numeric x and y"
                    ),
                )
        outputs: dict[str, Any] | None = None
        if include_outputs:
            supplied_outputs = raw.get("outputs", {})
            raw_outputs = {} if supplied_outputs is None else supplied_outputs
            if not isinstance(raw_outputs, dict):
                raise HTTPException(
                    status_code=400,
                    detail=f"nodes[{index}].outputs must be an object",
                )
            try:
                _validate_imported_outputs(
                    definition_id,
                    raw_outputs,
                    node_index=index,
                    params=params,
                )
                outputs = _normalize_outputs_for_storage(raw_outputs)
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"nodes[{index}].outputs is invalid: {exc}",
                ) from exc
        try:
            new_id = candidate.add_node(
                definition_id,
                params,
                position=position,
                outputs=outputs,
            )
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=400,
                detail=f"invalid node '{reference}': {exc}",
            ) from exc
        id_map[reference] = new_id
    return id_map


def _stage_graph_edges(
    candidate: CLIGraph,
    raw_edges: list[dict[str, Any]],
    id_map: dict[str, str],
) -> list[str]:
    """Validate every endpoint/handle before adding any edge to live state."""
    edge_ids: list[str] = []
    seen: set[tuple[str, str, str, str]] = set()
    for index, raw in enumerate(raw_edges):
        source_ref = raw.get("source")
        target_ref = raw.get("target")
        if not isinstance(source_ref, str) or not isinstance(target_ref, str):
            raise HTTPException(
                status_code=400,
                detail=f"edges[{index}] source and target must be strings",
            )
        if source_ref not in id_map or target_ref not in id_map:
            raise HTTPException(
                status_code=400,
                detail=f"edges[{index}] references an unknown source or target node",
            )
        source_handle = raw.get("sourceHandle")
        target_handle = raw.get("targetHandle")
        if not isinstance(source_handle, str) or not isinstance(target_handle, str):
            raise HTTPException(
                status_code=400,
                detail=f"edges[{index}] handles must be strings",
            )
        source = id_map[source_ref]
        target = id_map[target_ref]
        signature = (source, source_handle, target, target_handle)
        if signature in seen:
            raise HTTPException(status_code=400, detail=f"duplicate edge at edges[{index}]")
        seen.add(signature)
        _validate_connect_handles(
            source,
            source_handle,
            target,
            target_handle,
            graph=candidate,
        )
        try:
            edge_ids.append(
                candidate.connect(source, source_handle, target, target_handle)["id"]
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        graph_nodes, graph_edges = candidate.to_execute_format()
        topological_sort(
            [GraphNode.model_validate(node) for node in graph_nodes],
            [GraphEdge.model_validate(edge) for edge in graph_edges],
        )
    except CycleError as exc:
        raise HTTPException(status_code=400, detail=f"graph contains a cycle: {exc}") from exc
    return edge_ids


@app.post("/api/graph/import")
async def import_graph(body: dict[str, Any]) -> dict:
    """Atomically replace cli_graph from a file-loaded graph.

    Body: {nodes: [{id, definitionId, params, outputs?, position?}], edges: [...]}
    Remaps incoming node IDs (typically UUIDs from the .nebula file) to fresh
    short IDs so the rest of the system treats the loaded graph like any other
    CLI-created graph — including Claude's `nebula graph` view.
    """
    _check_workspace_revision()
    _validate_graph_ingress_complexity(body)
    candidate = CLIGraph()
    raw_nodes = _graph_ingress_items(body, "nodes")
    raw_edges = _graph_ingress_items(body, "edges")
    id_map = _stage_graph_nodes(
        candidate,
        raw_nodes,
        reference_key="id",
        include_outputs=True,
    )
    _stage_graph_edges(candidate, raw_edges, id_map)
    with _paid_graph_mutation("replace the graph"):
        _reject_graph_replacement_during_paid_start("replace the graph")
        if execution_runs.has_active() or _synchronous_workspace_runs:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Cannot replace the graph while a run is active. "
                    "Stop the run and wait for its terminal state first."
                ),
            )
        # Check and commit are synchronous on this event loop. No other graph
        # or Cinema task can be admitted between this fence and replacement.
        _commit_graph_candidate_with_recoveries(
            candidate,
            list(candidate.nodes.values()),
            source="import",
        )
    exported = await _broadcast_graph_sync(graph_replaced=True)
    publish_action(
        f"Loaded graph ({len(cli_graph.nodes)} nodes, {len(cli_graph.edges)} edges)"
    )
    return {
        "status": "imported",
        "idMap": id_map,
        "nodeCount": len(cli_graph.nodes),
        "edgeCount": len(cli_graph.edges),
        "nodes": exported["nodes"],
        "edges": exported["edges"],
    }


def _rf_created(node_ids: list[str], edge_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """React Flow nodes and edges for just-committed ids (cluster and accepted proposals).

    Built directly from the nodes and edges a request created. Constructing
    the React Flow shape from cli_graph.nodes (keyed by the new ids) avoids a
    full graph re-export whose filtering step is sensitive to unrelated
    global state and export-time normalization of OTHER nodes. This also
    keeps the route correct when test fixtures (or production code) replace
    the module-level cli_graph reference.
    """
    all_defs = node_registry.get_all()
    rf_nodes = []
    for new_id in node_ids:
        node = cli_graph.nodes.get(new_id)
        if node is None:
            continue
        # A simple default position; the client and graphSync broadcast apply
        # the real layout. Nodes with a stored position keep it.
        pos = node.get("position") or {"x": 0.0, "y": 0.0}
        rf_nodes.append(_cli_node_to_rf(node, pos, all_defs))

    wanted = set(edge_ids)
    rf_edges = []
    for e in cli_graph.edges:
        if e["id"] not in wanted:
            continue
        src_node = cli_graph.nodes.get(e["source"], {})
        src_def = all_defs.get(src_node.get("definitionId", ""), {})
        data_type = "Any"
        for port in src_def.get("outputPorts", []):
            if port["id"] == e["sourceHandle"]:
                data_type = port["dataType"]
                break
        rf_edges.append({
            "id": e["id"],
            "source": e["source"],
            "sourceHandle": e["sourceHandle"],
            "target": e["target"],
            "targetHandle": e["targetHandle"],
            "type": "typed-edge",
            "data": {"dataType": data_type},
        })
    return {"nodes": rf_nodes, "edges": rf_edges}


@app.post("/api/graph/cluster")
async def add_graph_cluster(body: dict[str, Any]) -> dict:
    """Additively add a node cluster (e.g. authored from the Create view) to the
    CLI graph and persist it. Mirrors /api/graph/import but does NOT clear the
    existing graph. Incoming nodes carry a client 'tempId'; this maps each to a
    fresh 'n{N}' id and returns the created nodes/edges in React Flow format so
    the client can apply them without waiting for the graphSync broadcast.

    Body: {nodes: [{tempId, definitionId, params, position?}], edges: [{source, sourceHandle, target, targetHandle}]}
    where edge source/target reference tempIds.
    """
    _check_workspace_revision()
    _validate_graph_ingress_complexity(body)
    raw_nodes = _graph_ingress_items(body, "nodes")
    raw_edges = _graph_ingress_items(body, "edges")
    with _paid_graph_mutation("add a graph cluster"):
        candidate = cli_graph.clone()
        id_map = _stage_graph_nodes(
            candidate,
            raw_nodes,
            reference_key="tempId",
            include_outputs=False,
        )
        created_edge_ids = _stage_graph_edges(candidate, raw_edges, id_map)
        _commit_graph_candidate_with_recoveries(
            candidate,
            [candidate.nodes[node_id] for node_id in id_map.values()],
            source="cluster",
        )
    await _broadcast_graph_sync()
    publish_action(f"Created cluster ({len(id_map)} nodes)")
    _journal_cluster(list(id_map.values()), created_edge_ids)

    return {"idMap": id_map, **_rf_created(list(id_map.values()), created_edge_ids)}


def _rewrite_output_paths(outputs: dict[str, Any]) -> dict[str, Any]:
    """Convert local file paths in outputs to /api/outputs/ URLs for the frontend."""
    rewritten: dict[str, Any] = {}
    for port_id, port_val in outputs.items():
        if isinstance(port_val, dict) and isinstance(port_val.get("value"), str):
            url = _output_url_from_ref(port_val["value"])
            rewritten[port_id] = {**port_val, "value": url} if url else port_val
        else:
            rewritten[port_id] = port_val
    return rewritten


def _cli_node_to_rf(n: dict[str, Any], position: dict[str, float], all_defs: dict) -> dict:
    """Convert a single cli_graph node dict to a React Flow node dict.

    *position* must be pre-computed by the caller (stored or auto-laid-out).
    *all_defs* is the full node_registry snapshot (``node_registry.get_all()``).

    This helper is the single source of truth for the cli→RF shape so both
    ``export_graph_for_frontend`` and ``add_graph_cluster`` produce identical
    node representations.
    """
    definition_id = n["definitionId"]
    defn = all_defs.get(definition_id, {})
    is_dynamic_node = definition_id in DYNAMIC_NODE_PROVIDER_BY_DEFINITION
    node_type = (
        "batchNode"
        if definition_id == "batch"
        else "paperSourceNode"
        if definition_id == "paper-source"
        else "reroute-node"
        if definition_id == "reroute"
        else "editNode"
        if definition_id == "video-edit"
        else "remotionNode"
        if definition_id == "remotion-node"
        else "cinemaSceneNode"
        if definition_id == "cinema-scene"
        else "characterNode"
        if definition_id == "character"
        else "cameraRigNode"
        if definition_id == "camera-rig"
        else "referenceSetNode"
        if definition_id == "reference-set"
        else "videoQcNode"
        if definition_id in {
            "qc-loop-safety",
            "qc-frame-review",
            "qc-composited-look",
            "qc-camera-geometry",
        }
        else "moodboardNode"
        if definition_id == "nebula-moodboard"
        else "dynamic-node"
        if is_dynamic_node
        else "model-node"
    )
    outputs = _rewrite_output_paths(n.get("outputs", {}))
    node_state = "complete" if outputs else "idle"

    # For image-input nodes: keep file paths current after repo moves and
    # derive _previewUrl from local output refs when it was not stored.
    params = dict(n.get("params", {}))
    if definition_id == "paper-source":
        # Run payloads pin one input; the owned source service retains its full
        # immutable history. Reading it here is not a Paper refresh.
        linked = params.get("_paperSource", {})
        if linked.get("id"):
            from services.paper_routes import paper_sources
            try:
                current_source = paper_sources.get(linked["id"])
            except KeyError:
                current_source = None
            if current_source and current_source["sequence"] >= linked.get("sequence", 0):
                params["_paperSource"] = current_source
        snapshot = params.get("_paperSource", {}).get("snapshot")
        if snapshot:
            outputs = _rewrite_output_paths({"image": {"type": "Image", "value": snapshot["filePath"]}})
            node_state = "complete"
    if definition_id == "image-input":
        params = _normalize_image_input_params(params)

    data: dict[str, Any] = {
        "label": defn.get("displayName", definition_id),
        "definitionId": definition_id,
        "params": params,
        "state": node_state,
        "outputs": outputs,
    }
    if is_dynamic_node:
        data.update({
            "isDynamic": True,
            "providerType": DYNAMIC_NODE_PROVIDER_BY_DEFINITION[definition_id],
            "modelId": params.get("model") or params.get("model_id") or params.get("endpoint_id"),
            "dynamicInputPorts": defn.get("inputPorts", []),
            "dynamicOutputPorts": defn.get("outputPorts", []),
            "dynamicParams": [],
            "providerMeta": {},
        })
    elif definition_id == "cinema-scene":
        # Saved scenes retain shot identities but not runtime port metadata.
        # Rebuild the visible shot handles for imports and graphSync alike.
        data.update({
            "isDynamic": True,
            "providerType": "fal",  # inert for the custom Cinema node
            "dynamicInputPorts": defn.get("inputPorts", []),
            "dynamicOutputPorts": cinema_output_ports(params),
            "dynamicParams": [],
            "providerMeta": {},
        })

    return {
        "id": n["id"],
        "type": node_type,
        "position": position,
        "data": data,
    }


def _project_id_or_404(project_id: str, catalog: dict[str, Any]) -> dict[str, Any]:
    try:
        validate_project_id(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    project = catalog["projects"].get(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _project_revision(body: dict[str, Any], catalog: dict[str, Any], *, required: bool = False) -> None:
    revision = body.get("workspaceRevision")
    if (required and revision is None) or (revision is not None and revision != catalog["workspaceRevision"]):
        raise HTTPException(status_code=409, detail="This project view is out of date. Reload projects before saving or switching.")


def _stage_project_snapshot(snapshot: Any, *, historical: dict[str, str] | None = None) -> tuple[dict[str, Any], CLIGraph]:
    """Validate a saved RF graph with canonical definitions, retaining its IDs.

    A removed definition can still be viewed when it was already in this
    project's history or live canvas. It cannot acquire execution authority
    from a frontend-supplied definition object.
    """
    if not isinstance(snapshot, dict):
        raise HTTPException(status_code=400, detail="Project snapshot must be an object")
    _validate_graph_ingress_complexity(snapshot)
    if len(json.dumps(snapshot, allow_nan=False, ensure_ascii=False).encode("utf-8")) > MAX_PROJECT_BYTES:
        raise HTTPException(status_code=413, detail="Project snapshot exceeds the 16 MiB limit")
    nodes = _graph_ingress_items(snapshot, "nodes")
    edges = _graph_ingress_items(snapshot, "edges")
    if len(nodes) > RESTORE_MAX_GRAPH_NODES or len(edges) > RESTORE_MAX_GRAPH_EDGES:
        raise HTTPException(status_code=413, detail="Project contains too many nodes or connections")
    history = snapshot.get("runHistory", [])
    if not isinstance(history, list) or len(history) > 500:
        raise HTTPException(status_code=400, detail="Project run history must be an array of at most 500 records")
    history_ids: set[str] = set()
    for record in history:
        if not isinstance(record, dict) or not isinstance(record.get("id"), str) or not 0 < len(record["id"]) <= 256:
            raise HTTPException(status_code=400, detail="Project history requires bounded run IDs")
        if record["id"] in history_ids or record.get("status") not in {"running", "complete", "failed", "cancelled"}:
            raise HTTPException(status_code=400, detail="Project history contains a duplicate run ID or invalid status")
        history_ids.add(record["id"])
        recipe = record.get("snapshot")
        if not isinstance(recipe, dict) or not isinstance(recipe.get("nodes"), list) or not isinstance(recipe.get("edges"), list):
            raise HTTPException(status_code=400, detail="Project history requires immutable graph snapshots")
    viewport = snapshot.get("viewport")
    if viewport is not None:
        if not isinstance(viewport, dict) or any(
            not isinstance(viewport.get(key), (int, float)) or isinstance(viewport[key], bool)
            or not math.isfinite(float(viewport[key])) for key in ("x", "y", "zoom")
        ) or viewport["zoom"] <= 0:
            raise HTTPException(status_code=400, detail="Project viewport requires finite x/y and positive zoom")
    session_id = snapshot.get("createSessionId")
    if session_id is not None and (not isinstance(session_id, str) or not 0 < len(session_id) <= 128):
        raise HTTPException(status_code=400, detail="Invalid Creator Studio session ID")
    if snapshot.get("createDraft") is not None and not isinstance(snapshot["createDraft"], dict):
        raise HTTPException(status_code=400, detail="Creator Studio draft must be an object")

    result = copy.deepcopy(snapshot)
    result.update({"runHistory": copy.deepcopy(history), "viewport": copy.deepcopy(viewport), "createSessionId": session_id})
    candidate = CLIGraph()
    known: set[str] = set()
    for index, node in enumerate(nodes):
        node_id = node.get("id")
        if not isinstance(node_id, str) or not 0 < len(node_id) <= 256 or node_id in candidate.nodes:
            raise HTTPException(status_code=400, detail=f"nodes[{index}] has an invalid or duplicate ID")
        data = node.get("data")
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail=f"nodes[{index}].data must be an object")
        definition_id = data.get("definitionId")
        if not isinstance(definition_id, str) or not 0 < len(definition_id) <= 256:
            raise HTTPException(status_code=400, detail=f"nodes[{index}] has an invalid definition ID")
        params = data.get("params", {})
        outputs = data.get("outputs", {})
        if not isinstance(params, dict) or not isinstance(outputs, dict):
            raise HTTPException(status_code=400, detail=f"nodes[{index}] params and outputs must be objects")
        position = node.get("position")
        if not isinstance(position, dict) or any(
            not isinstance(position.get(key), (int, float)) or isinstance(position[key], bool)
            or not math.isfinite(float(position[key])) for key in ("x", "y")
        ):
            raise HTTPException(status_code=400, detail=f"nodes[{index}] requires a finite position")
        isolated = CLIGraph()
        if node_registry.get(definition_id) is not None:
            staged = _stage_graph_nodes(isolated, [{
                "id": node_id, "definitionId": definition_id, "params": params,
                "outputs": outputs, "position": position,
            }], reference_key="id", include_outputs=True, normalize_image_inputs=False)
            staged_node = isolated.nodes[staged[node_id]]
            known.add(node_id)
        elif (historical or {}).get(node_id) == definition_id:
            if any(not isinstance(port, dict) or not isinstance(port.get("type"), str) for port in outputs.values()):
                raise HTTPException(status_code=400, detail="Historical outputs must be typed port objects")
            staged_node = {"id": node_id, "definitionId": definition_id, "params": copy.deepcopy(params), "outputs": copy.deepcopy(outputs), "position": copy.deepcopy(position)}
        else:
            raise HTTPException(status_code=400, detail=f"Unknown node definition '{definition_id}'")
        staged_node["id"] = node_id
        candidate.nodes[node_id] = staged_node
        result["nodes"][index]["data"]["params"] = copy.deepcopy(staged_node["params"])
        result["nodes"][index]["data"]["outputs"] = _rewrite_output_paths(staged_node["outputs"])
        if match := re.fullmatch(r"n(\d+)", node_id):
            candidate._counter = max(candidate._counter, int(match.group(1)))

    edge_ids: set[str] = set()
    signatures: set[tuple[str, str, str, str]] = set()
    for index, edge in enumerate(edges):
        edge_id = edge.get("id")
        if not isinstance(edge_id, str) or not 0 < len(edge_id) <= 256 or edge_id in edge_ids:
            raise HTTPException(status_code=400, detail=f"edges[{index}] has an invalid or duplicate ID")
        edge_ids.add(edge_id)
        values = [edge.get(key) for key in ("source", "sourceHandle", "target", "targetHandle")]
        if any(not isinstance(value, str) or not value or len(value) > 256 for value in values):
            raise HTTPException(status_code=400, detail=f"edges[{index}] requires valid endpoints and handles")
        source, source_handle, target, target_handle = values
        if source not in candidate.nodes or target not in candidate.nodes:
            raise HTTPException(status_code=400, detail=f"edges[{index}] references a missing node")
        signature = (source, source_handle, target, target_handle)
        if signature in signatures:
            raise HTTPException(status_code=400, detail="Duplicate project connection")
        signatures.add(signature)
        if source in known and target in known:
            _validate_connect_handles(source, source_handle, target, target_handle, graph=candidate)
        candidate.edges.append({"id": edge_id, "source": source, "sourceHandle": source_handle, "target": target, "targetHandle": target_handle})
    try:
        graph_nodes, graph_edges = candidate.to_execute_format()
        topological_sort([GraphNode.model_validate(node) for node in graph_nodes], [GraphEdge.model_validate(edge) for edge in graph_edges])
    except CycleError as exc:
        raise HTTPException(status_code=400, detail=f"Project contains a cycle: {exc}") from exc
    return result, candidate


def _overlay_live_project(project: dict[str, Any], exported: dict[str, Any]) -> bool:
    """Overlay CLI changes while retaining frontend-only data and run recipes."""
    previous = project["snapshot"]
    old_nodes = {node["id"]: node for node in previous["nodes"]}
    live_ids = {node["id"] for node in exported["nodes"]}
    backend_ids = set(project.get("_backendNodeIds", old_nodes))
    merged_nodes = []
    for node in exported["nodes"]:
        old = old_nodes.get(node["id"], {})
        merged_nodes.append({**old, **node, "data": {**old.get("data", {}), **node["data"]}})
    merged_nodes.extend(node for node in previous["nodes"] if node["id"] not in live_ids and node["id"] not in backend_ids)
    retained_ids = {node["id"] for node in merged_nodes}
    old_edges = {edge["id"]: edge for edge in previous["edges"]}
    live_edge_ids = {edge["id"] for edge in exported["edges"]}
    backend_edge_ids = set(project.get("_backendEdgeIds", old_edges))
    merged_edges = [{**old_edges.get(edge["id"], {}), **edge, "data": {**old_edges.get(edge["id"], {}).get("data", {}), **edge.get("data", {})}} for edge in exported["edges"]]
    merged_edges.extend(edge for edge in previous["edges"] if edge["id"] not in live_edge_ids and edge["id"] not in backend_edge_ids and edge["source"] in retained_ids and edge["target"] in retained_ids)
    updated = {**previous, "nodes": merged_nodes, "edges": merged_edges}
    changed = updated != previous
    project["snapshot"] = updated
    project["_backendNodeIds"] = sorted(live_ids)
    project["_backendEdgeIds"] = sorted(live_edge_ids)
    project["_nodeCounter"] = cli_graph._counter
    if changed:
        refresh_metadata(project)
    return changed


async def _projects_live_export() -> dict[str, Any]:
    return await export_graph_for_frontend()


def _project_replacement_guard() -> None:
    _reject_graph_replacement_during_paid_start("switch projects")
    if execution_runs.has_active() or _synchronous_workspace_runs:
        raise HTTPException(status_code=409, detail="Cannot switch projects while a run is active. Wait for the run to finish or stop it first.")


def _commit_project_workspace(catalog: dict[str, Any], candidate: CLIGraph) -> None:
    """Prepare both disk writes before adopting any new live graph in memory."""
    previous = cli_graph.clone()
    temporary = project_store.prepare(catalog)
    additions = []
    graph_written = False
    try:
        additions = _seed_shared_graph_recoveries_for_api(list(candidate.nodes.values()), source="project-open")
        if cli_graph._persist_path is not None:
            candidate.save(cli_graph._persist_path)
            graph_written = True
        project_store.commit_prepared(temporary)
    except Exception as exc:
        try:
            if graph_written and cli_graph._persist_path is not None:
                previous.save(cli_graph._persist_path)
            provider_recovery_store.delete_many_exact(additions)
        except Exception as rollback_error:
            raise HTTPException(status_code=507, detail="Project switch failed and storage rollback could not finish. The live canvas was preserved; resolve storage before restarting.") from rollback_error
        if isinstance(exc, HTTPException):
            raise
        raise ProjectStoreError("Project switch could not be saved; the live canvas was preserved") from exc
    finally:
        temporary.unlink(missing_ok=True)
    cli_graph.nodes = copy.deepcopy(candidate.nodes)
    cli_graph.edges = copy.deepcopy(candidate.edges)
    cli_graph._counter = candidate._counter


@app.get("/api/projects")
async def list_projects() -> dict[str, Any]:
    exported = await _projects_live_export()
    with project_store.transaction() as catalog:
        changed = False
        if not catalog["projects"] and cli_graph.nodes:
            snapshot = {**empty_snapshot(), "nodes": exported["nodes"], "edges": exported["edges"]}
            project = make_project("Recovered canvas", snapshot)
            _overlay_live_project(project, exported)
            catalog["projects"][project["id"]] = project
            catalog["activeProjectId"] = project["id"]
            catalog["workspaceRevision"] = uuid4().hex
            catalog["migratedProjectId"] = project["id"]
            changed = True
        elif active := catalog["activeProjectId"]:
            changed = _overlay_live_project(catalog["projects"][active], exported)
        if changed:
            project_store.commit(catalog)
        return {
            "projects": sorted((project_metadata(project) for project in catalog["projects"].values()), key=lambda project: project["updatedAt"], reverse=True),
            "activeProjectId": catalog["activeProjectId"], "workspaceRevision": catalog["workspaceRevision"],
            **({"migratedProjectId": catalog["migratedProjectId"]} if catalog.get("migratedProjectId") else {}),
        }


@app.get("/api/projects/{project_id}")
async def get_saved_project(project_id: str) -> dict[str, Any]:
    exported = await _projects_live_export()
    with project_store.transaction() as catalog:
        project = _project_id_or_404(project_id, catalog)
        if catalog["activeProjectId"] == project_id and _overlay_live_project(project, exported):
            project_store.commit(catalog)
        return public_project(project)


@app.post("/api/projects/recover")
async def recover_project_copy(body: dict[str, Any]) -> dict[str, Any]:
    """Save a stale tab as an inactive copy without replacing current work.

    The caller supplies one stable recoveryId per snapshot so an unknown
    acknowledgement can be retried without making duplicate projects.
    """
    recovery_id = body.get("recoveryId")
    try:
        validate_project_id(recovery_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Recovery requires a UUID hex recoveryId") from exc
    with project_store.transaction() as catalog:
        source = _project_id_or_404(body.get("sourceProjectId"), catalog)
        # Hash the submitted JSON, before canonical coercion. A retry of the
        # same request remains idempotent even if source metadata changes.
        _validate_graph_ingress_complexity(body)
        fingerprint = hashlib.sha256(json.dumps({"sourceProjectId": source["id"], "snapshot": body.get("snapshot"), "name": body.get("name")}, sort_keys=True, allow_nan=False, ensure_ascii=False).encode("utf-8")).hexdigest()
        if existing := catalog["projects"].get(recovery_id):
            if existing.get("_recoveryFingerprint") != fingerprint:
                raise HTTPException(status_code=409, detail="Recovery ID already belongs to a different snapshot")
            return {"project": public_project(existing), "workspaceRevision": catalog["workspaceRevision"]}
        historical = {node["id"]: node.get("data", {}).get("definitionId") for node in source["snapshot"]["nodes"]}
        snapshot, candidate = _stage_project_snapshot(body.get("snapshot"), historical=historical)
        try:
            project = make_project(body.get("name", f"{source['name'][:100]} (recovered)"), snapshot)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        project.update({
            "id": recovery_id, "lastOpenedAt": None, "_recoveryFingerprint": fingerprint,
            "_recoverySourceId": source["id"], "_nodeCounter": max(candidate._counter, source.get("_nodeCounter", 0)),
            "_backendNodeIds": [], "_backendEdgeIds": [],
        })
        catalog["projects"][recovery_id] = project
        project_store.commit(catalog)
        return {"project": public_project(project), "workspaceRevision": catalog["workspaceRevision"]}


@app.post("/api/projects")
async def create_saved_project(body: dict[str, Any] | None = None) -> dict[str, Any]:
    body = body or {}
    exported = await _projects_live_export()
    with project_store.transaction() as catalog, _paid_graph_mutation("create a project"):
        _project_revision(body, catalog)
        _project_replacement_guard()
        # API callers need not visit the menu first. Never erase a legacy
        # live canvas merely because no catalog migration request preceded it.
        if not catalog["projects"] and cli_graph.nodes:
            recovered = make_project("Recovered canvas", {**empty_snapshot(), "nodes": exported["nodes"], "edges": exported["edges"]})
            _overlay_live_project(recovered, exported)
            catalog["projects"][recovered["id"]] = recovered
            catalog["activeProjectId"] = recovered["id"]
            catalog["migratedProjectId"] = recovered["id"]
        if active := catalog["activeProjectId"]:
            _overlay_live_project(catalog["projects"][active], exported)
        try:
            project = make_project(body.get("name", "Untitled project"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        catalog["workspaceRevision"] = uuid4().hex
        _commit_project_workspace(catalog, CLIGraph())
        revision = catalog["workspaceRevision"]
    await _broadcast_graph_sync(graph_replaced=True, reason="project-create")
    return {"project": public_project(project), "workspaceRevision": revision}


@app.post("/api/projects/{project_id}/open")
async def open_saved_project(project_id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    exported = await _projects_live_export()
    with project_store.transaction() as catalog, _paid_graph_mutation("open a project"):
        _project_revision(body or {}, catalog)
        _project_replacement_guard()
        project = _project_id_or_404(project_id, catalog)
        if active := catalog["activeProjectId"]:
            _overlay_live_project(catalog["projects"][active], exported)
        historical = {node["id"]: node.get("data", {}).get("definitionId") for node in project["snapshot"]["nodes"]}
        project["snapshot"], candidate = _stage_project_snapshot(project["snapshot"], historical=historical)
        candidate._counter = max(candidate._counter, project.get("_nodeCounter", 0))
        project["lastOpenedAt"] = project_now()
        catalog["activeProjectId"] = project_id
        catalog["workspaceRevision"] = uuid4().hex
        _commit_project_workspace(catalog, candidate)
        revision = catalog["workspaceRevision"]
    await _broadcast_graph_sync(graph_replaced=True, reason="project-open")
    return {"project": public_project(project), "workspaceRevision": revision}


@app.put("/api/projects/{project_id}")
async def save_project(project_id: str, body: dict[str, Any]) -> dict[str, Any]:
    with project_store.transaction() as catalog:
        project = _project_id_or_404(project_id, catalog)
        _project_revision(body, catalog, required="snapshot" in body)
        if "snapshot" in body:
            if catalog["activeProjectId"] != project_id:
                raise HTTPException(status_code=409, detail="Only the currently open project can autosave its canvas")
            historical = {node["id"]: node.get("data", {}).get("definitionId") for node in project["snapshot"]["nodes"]}
            historical.update({node_id: node["definitionId"] for node_id, node in cli_graph.nodes.items()})
            project["snapshot"], _ = _stage_project_snapshot(body["snapshot"], historical=historical)
            project["_backendNodeIds"] = sorted(set(cli_graph.nodes) & {node["id"] for node in project["snapshot"]["nodes"]})
            project["_backendEdgeIds"] = sorted({edge["id"] for edge in cli_graph.edges} & {edge["id"] for edge in project["snapshot"]["edges"]})
            project["_nodeCounter"] = cli_graph._counter
            if catalog.get("migratedProjectId") == project_id:
                catalog.pop("migratedProjectId", None)
        if "name" in body:
            try:
                project["name"] = project_name(body["name"])
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        refresh_metadata(project)
        project_store.commit(catalog)
        return {"project": public_project(project), "workspaceRevision": catalog["workspaceRevision"]}


def _display_positions(
    nodes: list[dict[str, Any]], *, y_offset: float = 100.0
) -> dict[str, dict[str, float]]:
    """Where the canvas draws each node.

    Nodes with a stored position (imported, or moved by the person) keep it.
    Nodes without one (created through `nebula create`) are placed to the
    right of any positioned node so new additions don't pile on top of
    existing work. The layout route uses this too, so the person's first drag
    of an agent-created node is measured from where they actually saw it.
    """
    stored_positions: dict[str, dict[str, float]] = {}
    max_x: float = -300.0
    for n in nodes:
        pos = n.get("position")
        if isinstance(pos, dict) and "x" in pos and "y" in pos:
            stored_positions[n["id"]] = {"x": float(pos["x"]), "y": float(pos["y"])}
            if pos["x"] > max_x:
                max_x = float(pos["x"])
    computed_positions: dict[str, dict[str, float]] = {}
    for n in nodes:
        if n["id"] in stored_positions:
            computed_positions[n["id"]] = stored_positions[n["id"]]
        else:
            max_x += 300.0
            computed_positions[n["id"]] = {"x": max_x, "y": y_offset}
    return computed_positions


@app.get("/api/graph/export")
async def export_graph_for_frontend() -> dict:
    """Export CLI graph in React Flow format for the frontend canvas."""
    # Run normalization on every export so image-input nodes added or
    # re-pointed AFTER server start (CLI sets, post-boot imports) still get
    # their external filePath auto-imported and cross-node output refs
    # rewritten. Idempotent — does no work when no migration is needed.
    _normalize_cli_graph_output_refs()
    state = cli_graph.get_state()
    if not state["nodes"]:
        return {
            **_workspace_context(),
            "nodes": [],
            "edges": [],
            "empty": True,
            "providerRecoveries": provider_recovery_store.list(),
            "providerStartAmbiguities": provider_start_guard.list(),
            "executionStatuses": execution_runs.list_statuses(),
            "executionCancellationIntents": [
                {"runId": run_id, "status": "cancelled"}
                for run_id in provider_start_guard.list_cancel_intents()
            ],
        }

    all_defs = node_registry.get_all()
    rf_nodes = []
    y_offset = 100

    computed_positions = _display_positions(state["nodes"], y_offset=float(y_offset))

    for n in state["nodes"]:
        rf_nodes.append(_cli_node_to_rf(n, computed_positions[n["id"]], all_defs))

    rf_edges = []
    for e in state["edges"]:
        # Determine data type for edge styling
        src_node = cli_graph.nodes.get(e["source"], {})
        src_def = all_defs.get(src_node.get("definitionId", ""), {})
        data_type = "Any"
        src_ports = (cinema_output_ports(src_node.get("params"))
                     if src_node.get("definitionId") == "cinema-scene"
                     else src_def.get("outputPorts", []))
        for port in src_ports:
            if port["id"] == e["sourceHandle"]:
                data_type = port["dataType"]
                break

        rf_edges.append({
            "id": e["id"],
            "source": e["source"],
            "sourceHandle": e["sourceHandle"],
            "target": e["target"],
            "targetHandle": e["targetHandle"],
            "type": "typed-edge",
            "data": {"dataType": data_type},
        })

    return {
        **_workspace_context(),
        "nodes": rf_nodes,
        "edges": rf_edges,
        "empty": False,
        "providerRecoveries": provider_recovery_store.list(),
        "providerStartAmbiguities": provider_start_guard.list(),
        "executionStatuses": execution_runs.list_statuses(),
        "executionCancellationIntents": [
            {"runId": run_id, "status": "cancelled"}
            for run_id in provider_start_guard.list_cancel_intents()
        ],
    }


# ---------- CLI: Synchronous execution ----------

@app.post("/api/graph/run")
@_track_synchronous_project_run
async def run_graph(request: Request, body: dict[str, Any] | None = None) -> dict:
    """Execute the CLI graph synchronously and return results.

    §1.5 guard: when called BY Daedalus (header X-Daedalus-Caller set) and
    TARGETING a specific node that already has outputs, block with 400 and
    point him at the rule. Iteration must ADD a new node — re-running the
    same node in place overwrites the craft log we want on the canvas. The
    header gate lets humans (frontend Run button, curl, tests) keep the
    rerun-in-place affordance; only the agent is disciplined here."""
    _check_workspace_revision()
    _capture_execution_workspace()
    if not cli_graph.nodes:
        raise HTTPException(status_code=400, detail="Graph is empty")

    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    _normalize_cli_graph_output_refs()
    nodes_list, edges_list = cli_graph.to_execute_format()

    target = body.get("targetNodeId") if body else None

    if target and request.headers.get("x-daedalus-caller"):
        existing_outputs = cli_graph.nodes.get(target, {}).get("outputs")
        if isinstance(existing_outputs, dict) and len(existing_outputs) > 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Node '{target}' already has output. Per SKILL.md §1.5, "
                    "add a new node instead of re-running in place — the canvas "
                    "should keep every iteration visible as craft history. "
                    "Use `nebula add <family>-<variant>` to create the next cut, "
                    "wire it from the corrected upstream, then `nebula run` the "
                    "new node id."
                ),
            )

    if target:
        sub_nodes, sub_edges = get_subgraph(
            [GraphNode.model_validate(n) for n in nodes_list],
            [GraphEdge.model_validate(e) for e in edges_list],
            target,
        )
        if not sub_nodes:
            raise HTTPException(status_code=404, detail=f"Node '{target}' not found in graph")
    else:
        sub_nodes = [GraphNode.model_validate(n) for n in nodes_list]
        sub_edges = [GraphEdge.model_validate(e) for e in edges_list]

    _validate_cinema_base_models(sub_nodes)

    results: dict[str, Any] = {}
    errors: dict[str, str] = {}
    run_id = str(uuid4())
    canvas_events.note_run(run_id, actor_for_headers(current_request_headers()))

    import time

    async def collect_events(event: ExecutionEvent) -> None:
        # This path keeps per-node events to itself (it returns results in
        # the response), so journal them here for watchers.
        _journal_execution_event(event, run_id)
        if isinstance(event, (ProviderRecoveryEvent, ProviderStartAmbiguousEvent)):
            await _emit_and_sync(event)
        elif isinstance(event, ExecutedEvent):
            results[event.node_id] = event.outputs
        elif isinstance(event, ErrorEvent):
            errors[event.node_id] = event.error

    handler_registry = get_handler_registry(emit=collect_events)

    publish_action(
        f"Running {target}..." if target else f"Running {len(sub_nodes)} node(s)..."
    )
    if target:
        await _show_agent({"nodeId": target}, say=f"Running {_node_label(target)}")

    start = time.time()
    _claim_fresh_paid_worldlabs_starts(run_id=run_id, nodes=sub_nodes)
    try:
        await execute_graph(
            nodes=sub_nodes,
            edges=sub_edges,
            api_keys=api_keys,
            handler_registry=handler_registry,
            emit=collect_events,
            cache=execution_cache,
            run_id=run_id,
        )
    finally:
        await _release_paid_worldlabs_starts(run_id)
        canvas_events.forget_run(run_id)
    duration = time.time() - start

    # Update CLI graph node outputs
    for node_id, outputs in results.items():
        if node_id in cli_graph.nodes:
            _sync_outputs_to_cli_graph(node_id, outputs)

    _sync_params_to_cli_graph(sub_nodes)

    # Sync outputs to frontend canvas
    await _broadcast_graph_sync()

    if errors:
        publish_action(
            f"Ran {len(results) + len(errors)} node(s) in {duration:.1f}s — "
            f"{len(errors)} errored: {', '.join(errors.keys())}"
        )
    else:
        publish_action(
            f"Ran {len(results)} node(s) cleanly in {duration:.1f}s"
        )

    return {
        "results": results,
        "errors": errors,
        "duration": round(duration, 2),
        "nodesExecuted": len(results) + len(errors),
    }


# Image reference suffixes recognized by /api/quick (matches the scalar
# extension-based detection below).
_QUICK_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


def _quick_input_port_def(definition_id: str, port_id: str) -> dict[str, Any] | None:
    """Return the target node's input port definition for *port_id*, if any."""
    defn = node_registry.get(definition_id)
    if not defn:
        return None
    for port in defn.get("inputPorts", []):
        if isinstance(port, dict) and port.get("id") == port_id:
            return port
    return None


def _is_quick_image_ref(value: Any) -> bool:
    """True when *value* is usable as an image reference: an http(s) URL, a
    data: URI, or a local path with a recognized image extension."""
    if not isinstance(value, str) or not value:
        return False
    if is_remote_or_data_uri(value):
        return True
    return value.lower().endswith(_QUICK_IMAGE_SUFFIXES)


def _validated_quick_image_refs(port_id: str, value: list[Any]) -> list[str]:
    """Validate a /api/quick array input destined for an Image port.

    Every item must be an http(s) URL, a data: URI, or a local image path.
    Local paths are normalized to absolute (same as the scalar branch); URLs
    and data URIs pass through untouched. Raises HTTP 400 on an empty array
    or any invalid item.
    """
    if not value:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Input '{port_id}' got an empty array — provide at least one "
                "image reference (URL, data: URI, or local image path)."
            ),
        )
    invalid = [item for item in value if not _is_quick_image_ref(item)]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Input '{port_id}' has {len(invalid)} invalid image reference(s): "
                f"{invalid!r}. Each item must be an http(s) URL, a data: URI, or a "
                f"local image path ({'/'.join(_QUICK_IMAGE_SUFFIXES)})."
            ),
        )
    normalized = [
        item if is_remote_or_data_uri(item) else str(Path(item).expanduser().resolve())
        for item in value
    ]
    # Fail fast (HTTP 400) on local files that don't exist — otherwise the
    # temp input node raises at execution time, the main node is never
    # scheduled, and the endpoint would return 200 with empty outputs.
    missing = [
        item
        for item in normalized
        if not is_remote_or_data_uri(item) and not Path(item).exists()
    ]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Input '{port_id}' references {len(missing)} local image file(s) "
                f"that do not exist: {missing!r}. Check the paths — downstream "
                "nodes would otherwise receive a reference no model can load."
            ),
        )
    return normalized


async def _quick_multi_image_input_handler(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    """Temp /api/quick input node: emit a typed multi-image list output.

    The engine's built-in ``image-input`` branch only emits a scalar from
    ``params["filePath"]``, so /api/quick registers this request-scoped
    handler for its ``multi-image-input`` temp nodes. Mirrors
    ``engine._image_input_output``'s fail-at-the-source check for missing
    local files, but emits every reference as one Image-typed list so the
    downstream port receives ``PortValueDict(type="Image", value=[...])``.
    """
    refs = node.params.get("filePaths") or []
    values: list[str] = []
    for ref in refs:
        resolved = resolve_output_ref(str(ref))
        if resolved and not is_remote_or_data_uri(resolved) and not Path(resolved).exists():
            raise ValueError(
                f"Image Input file not found: {resolved!r}. Set a valid path — "
                "downstream nodes would otherwise receive a reference no model can load."
            )
        values.append(resolved)
    return {"image": {"type": "Image", "value": values}}


@app.post("/api/quick")
@_track_synchronous_project_run
async def quick_execute(body: dict[str, Any]) -> dict:
    """One-shot: create a temp node, execute, return output."""
    _check_workspace_revision()
    _capture_execution_workspace()
    definition_id = body.get("definitionId", "")
    if not quick_execution_allowed(definition_id):
        raise HTTPException(
            status_code=409,
            detail=(
                "World Labs nodes cannot run through /api/quick because paid-start "
                "recovery must be attached to a durable graph node. Add the node to "
                "the canvas and execute it there."
            ),
        )
    inputs = body.get("inputs", {})
    params = body.get("params", {})
    validate_file_references(inputs)
    validate_file_references(params)
    if definition_id == "cinema-scene" and isinstance(params, dict):
        _validate_cinema_base_models(
            [
                GraphNode(
                    id="_quick_main",
                    definition_id=definition_id,
                    params=params,
                    outputs={},
                )
            ]
        )

    settings = load_settings()
    api_keys = settings.get("apiKeys", {})

    temp_nodes = []
    temp_edges = []
    node_counter = 0

    for port_id, value in inputs.items():
        node_counter += 1
        input_node_id = f"_quick_input_{node_counter}"

        # Array input for an Image-typed port (a single ``image`` port or an
        # ``images`` port with ``multiple: true``): build ONE typed multi-image
        # input node whose output is PortValueDict(type="Image", value=[...]),
        # so the downstream node receives an image list — not a text dump of
        # the JSON array (the previous fall-through behavior). Arrays for
        # non-Image ports keep the legacy text handling below.
        if isinstance(value, list):
            port_def = _quick_input_port_def(definition_id, port_id)
            if port_def is not None and port_def.get("dataType") == "Image":
                refs = _validated_quick_image_refs(port_id, value)
                temp_nodes.append(GraphNode(
                    id=input_node_id,
                    definition_id="multi-image-input",
                    params={"filePaths": refs},
                    outputs={},
                ))
                temp_edges.append(GraphEdge(
                    id=f"_quick_edge_{node_counter}",
                    source=input_node_id,
                    source_handle="image",
                    target="_quick_main",
                    target_handle=port_id,
                ))
                continue

        if isinstance(value, str) and value.endswith(('.png', '.jpg', '.jpeg', '.webp')):
            input_type = "image-input"
            port_type = "Image"
        elif isinstance(value, str) and value.endswith(('.mp4', '.mov', '.webm')):
            input_type = "video-input"
            port_type = "Video"
        elif isinstance(value, str) and value.endswith(('.mp3', '.wav', '.m4a')):
            input_type = "audio-input"
            port_type = "Audio"
        else:
            input_type = "text-input"
            port_type = "Text"

        # File-backed inputs (image/video/audio) are resolved by the engine via
        # ``params["filePath"]`` (see execution/engine.py), NOT ``params["value"]``
        # — the latter is only read by text-input. Mirror the /api/uploads param
        # shape (absolute filePath) so a local file reference is actually readable.
        if input_type == "text-input":
            input_params: dict[str, Any] = {"value": value}
        elif is_remote_or_data_uri(value):
            # URLs and data URIs are used as-is — Path.resolve() would turn
            # "https://host/ref.png" into a bogus local path ("/cwd/https:/...").
            input_params = _normalize_image_input_params({"filePath": value})
        else:
            input_params = _normalize_image_input_params(
                {"filePath": str(Path(value).expanduser().resolve())}
            )

        temp_nodes.append(GraphNode(
            id=input_node_id,
            definition_id=input_type,
            params=input_params,
            outputs={},
        ))
        temp_edges.append(GraphEdge(
            id=f"_quick_edge_{node_counter}",
            source=input_node_id,
            source_handle="text" if input_type == "text-input" else port_type.lower(),
            target="_quick_main",
            target_handle=port_id,
        ))

    temp_nodes.append(GraphNode(
        id="_quick_main",
        definition_id=definition_id,
        params=params,
        outputs={},
    ))

    results: dict[str, Any] = {}
    errors: dict[str, str] = {}

    async def collect_events(event: ExecutionEvent) -> None:
        if isinstance(event, ExecutedEvent):
            results[event.node_id] = event.outputs
        elif isinstance(event, ErrorEvent):
            errors[event.node_id] = event.error

    handler_registry = get_handler_registry(emit=collect_events)
    # Temp multi-image input nodes are executed by this request-scoped handler —
    # the engine's built-in image-input branch only emits a scalar value.
    handler_registry["multi-image-input"] = _quick_multi_image_input_handler

    import time
    start = time.time()
    await execute_graph(
        nodes=temp_nodes,
        edges=temp_edges,
        api_keys=api_keys,
        handler_registry=handler_registry,
        emit=collect_events,
        cache=execution_cache,
    )
    duration = time.time() - start

    if "_quick_main" in errors:
        raise HTTPException(status_code=500, detail=errors["_quick_main"])

    # A failed temp input node means the main node was never scheduled —
    # surface that as an HTTP error instead of returning 200 with empty
    # outputs (the engine records the failure under the temp node's id).
    input_errors = {nid: err for nid, err in errors.items() if nid != "_quick_main"}
    if input_errors:
        detail = "; ".join(
            f"{nid}: {err}" for nid, err in sorted(input_errors.items())
        )
        raise HTTPException(status_code=400, detail=f"Quick input error: {detail}")

    main_outputs = results.get("_quick_main", {})
    return {"outputs": main_outputs, "duration": round(duration, 2)}


# ---------- Characters: project-scoped & global character store ----------

from pydantic import BaseModel, Field

from services.prompt_enhance import (
    enhance_prompt,
    NoEnhanceProviderError,
    EnhanceProviderError,
)


class EnhancePromptRequest(BaseModel):
    prompt: str


@app.post("/api/enhance-prompt")
async def enhance_prompt_route(body: EnhancePromptRequest) -> dict[str, str]:
    """One-shot LLM rewrite of a Create prompt, using the first configured provider."""
    prompt = (body.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is empty.")
    api_keys = load_settings().get("apiKeys", {})
    try:
        return await enhance_prompt(prompt, api_keys)
    except NoEnhanceProviderError:
        raise HTTPException(
            status_code=400,
            detail="No LLM API key configured (OpenAI, Anthropic, or Google). Add one in Settings.",
        )
    except EnhanceProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


class CharacterCreate(BaseModel):
    name: str
    subjectType: str
    referenceViews: list[str]
    frozenTraitString: str
    seed: int
    consistencyStrength: float
    projectId: str | None = None


class CharacterUpdate(BaseModel):
    name: str | None = None
    subjectType: str | None = None
    referenceViews: list[str] | None = None
    frozenTraitString: str | None = None
    seed: int | None = None
    consistencyStrength: float | None = None


class MoodboardImageModel(BaseModel):
    id: str | None = None
    url: str
    weight: float = 1.0
    notes: str = ""
    excluded: bool = False


class MoodboardCreate(BaseModel):
    name: str
    images: list[MoodboardImageModel] = Field(default_factory=list)
    notes: str = ""
    mode: str = "look"
    strength: float = 0.7
    analysis: dict[str, Any] | None = None
    projectId: str | None = None


class MoodboardUpdate(BaseModel):
    name: str | None = None
    images: list[MoodboardImageModel] | None = None
    notes: str | None = None
    mode: str | None = None
    strength: float | None = None
    analysis: dict[str, Any] | None = None


class PresetCreate(BaseModel):
    name: str
    category: str = "Style"
    prompt: str = ""
    params: dict[str, Any] = Field(default_factory=dict)
    modelId: str | None = None
    refImages: list[str] = Field(default_factory=list)
    scope: str = "global"
    projectId: str | None = None
    thumbnail: str = ""


class PresetUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    prompt: str | None = None
    params: dict[str, Any] | None = None
    modelId: str | None = None
    refImages: list[str] | None = None
    thumbnail: str | None = None


def _char_store():
    from services.character_store import CharacterStore
    return CharacterStore()


def _moodboard_store():
    from services.moodboard_store import MoodboardStore
    return MoodboardStore()


def _validate_project_id_param(project_id: str | None) -> None:
    """Raise HTTP 400 if *project_id* is present but fails the safe-charset check.

    Reuses the same regex enforced by the store layer so the route gives a clean
    400 (not a 500 or 422) before any filesystem path is constructed.
    """
    if project_id is None:
        return
    import re as _re
    _safe = _re.compile(r"^[A-Za-z0-9_-]{1,64}$")
    if not _safe.fullmatch(project_id):
        raise HTTPException(status_code=400, detail="invalid projectId")


@app.get("/api/characters")
async def list_characters(scope: str = "global", projectId: str | None = None) -> list[dict]:
    """List Characters by scope.

    scope=global           → global characters
    scope=project&projectId=X → project-scoped characters for project X
    """
    _validate_project_id_param(projectId)
    store = _char_store()
    try:
        return store.list(scope=scope, projectId=projectId)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/characters")
async def create_character(body: CharacterCreate) -> dict:
    """Create a new Character."""
    _validate_project_id_param(body.projectId)
    store = _char_store()
    try:
        return store.create(
            name=body.name,
            subjectType=body.subjectType,
            referenceViews=body.referenceViews,
            frozenTraitString=body.frozenTraitString,
            seed=body.seed,
            consistencyStrength=body.consistencyStrength,
            projectId=body.projectId,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/characters/{char_id}")
async def get_character(char_id: str) -> dict:
    """Fetch a Character by id."""
    store = _char_store()
    try:
        char = store.get(char_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Character '{char_id}' not found")
    if char is None:
        raise HTTPException(status_code=404, detail=f"Character '{char_id}' not found")
    return char


@app.put("/api/characters/{char_id}")
async def update_character(char_id: str, body: CharacterUpdate) -> dict:
    """Update mutable fields on a Character; bumps version."""
    store = _char_store()
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    try:
        return store.update(char_id, **updates)
    except (KeyError, ValueError):
        raise HTTPException(status_code=404, detail=f"Character '{char_id}' not found")


@app.delete("/api/characters/{char_id}")
async def delete_character(char_id: str) -> dict:
    """Delete a Character by id."""
    store = _char_store()
    try:
        store.delete(char_id)
    except (KeyError, ValueError):
        raise HTTPException(status_code=404, detail=f"Character '{char_id}' not found")
    return {"status": "deleted", "id": char_id}


# ---------- Moodboards: provider-neutral creative-direction store ----------

@app.get("/api/moodboards")
async def list_moodboards(scope: str = "global", projectId: str | None = None) -> list[dict]:
    _validate_project_id_param(projectId)
    store = _moodboard_store()
    try:
        return store.list(scope=scope, projectId=projectId)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/moodboards")
async def create_moodboard(body: MoodboardCreate) -> dict:
    _validate_project_id_param(body.projectId)
    store = _moodboard_store()
    try:
        return store.create(
            name=body.name,
            images=[img.model_dump() for img in body.images],
            notes=body.notes,
            mode=body.mode,
            strength=body.strength,
            analysis=body.analysis,
            projectId=body.projectId,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/moodboards/{moodboard_id}")
async def get_moodboard(moodboard_id: str) -> dict:
    store = _moodboard_store()
    try:
        moodboard = store.get(moodboard_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Moodboard '{moodboard_id}' not found")
    if moodboard is None:
        raise HTTPException(status_code=404, detail=f"Moodboard '{moodboard_id}' not found")
    return moodboard


@app.put("/api/moodboards/{moodboard_id}")
async def update_moodboard(moodboard_id: str, body: MoodboardUpdate) -> dict:
    store = _moodboard_store()
    updates = {
        key: value
        for key, value in body.model_dump().items()
        if value is not None
    }
    if "images" in updates:
        updates["images"] = [img.model_dump() if hasattr(img, "model_dump") else img for img in body.images or []]
    try:
        return store.update(moodboard_id, **updates)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Moodboard '{moodboard_id}' not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/api/moodboards/{moodboard_id}/analyze")
async def analyze_moodboard_route(moodboard_id: str) -> dict:
    store = _moodboard_store()
    try:
        moodboard = store.get(moodboard_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Moodboard '{moodboard_id}' not found")
    if moodboard is None:
        raise HTTPException(status_code=404, detail=f"Moodboard '{moodboard_id}' not found")

    from services.moodboard_analysis import analyze_moodboard

    analysis = analyze_moodboard(moodboard)
    try:
        return store.update(moodboard_id, analysis=analysis)
    except (KeyError, ValueError):
        raise HTTPException(status_code=404, detail=f"Moodboard '{moodboard_id}' not found")


@app.delete("/api/moodboards/{moodboard_id}")
async def delete_moodboard(moodboard_id: str) -> dict:
    store = _moodboard_store()
    try:
        store.delete(moodboard_id)
    except (KeyError, ValueError):
        raise HTTPException(status_code=404, detail=f"Moodboard '{moodboard_id}' not found")
    return {"status": "deleted", "id": moodboard_id}


# ---------- Presets: named styles / prompt fragments + params ----------

@app.get("/api/presets")
async def list_presets(scope: str = "global", projectId: str | None = None) -> list[dict]:
    _validate_project_id_param(projectId)
    try:
        return preset_store.list(scope, projectId)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/presets")
async def create_preset(body: PresetCreate) -> dict:
    _validate_project_id_param(body.projectId)
    try:
        return preset_store.create(
            name=body.name, category=body.category, prompt=body.prompt, params=body.params,
            modelId=body.modelId, refImages=body.refImages, scope=body.scope, projectId=body.projectId,
            thumbnail=body.thumbnail,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/presets/thumbnails/{slug}")
async def get_preset_thumbnail(slug: str):
    """Serve a shipped preset thumbnail by slug. Defined ABOVE /{preset_id} to
    prevent FastAPI from shadowing it with the parameterised route."""
    if not re.fullmatch(r"[a-z0-9-]{1,64}", slug):
        raise HTTPException(status_code=404, detail="thumbnail not found")
    thumbnails_dir = (_PRESET_SEED_PATH.parent / "thumbnails").resolve()
    path = (thumbnails_dir / f"{slug}.webp").resolve()
    # Traversal guard: resolved path must stay inside the thumbnails dir
    try:
        path.relative_to(thumbnails_dir)
    except ValueError:
        raise HTTPException(status_code=404, detail="thumbnail not found")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="thumbnail not found")
    return FileResponse(str(path), media_type="image/webp")


@app.get("/api/presets/{preset_id}")
async def get_preset(preset_id: str) -> dict:
    preset = preset_store.get(preset_id)
    if preset is None:
        raise HTTPException(status_code=404, detail="preset not found")
    return preset


@app.put("/api/presets/{preset_id}")
async def update_preset(preset_id: str, body: PresetUpdate) -> dict:
    try:
        return preset_store.update(preset_id, **body.model_dump(exclude_none=True))
    except KeyError:
        raise HTTPException(status_code=404, detail="preset not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.delete("/api/presets/{preset_id}")
async def delete_preset(preset_id: str) -> dict:
    try:
        preset_store.delete(preset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="preset not found")
    return {"status": "deleted", "id": preset_id}


# ---------- Preset seeding (first-run starter styles) ----------

_PRESET_SEED_PATH = Path(__file__).resolve().parent / "data" / "presets" / "seed.json"


def seed_presets_if_empty() -> None:
    """Populate the global preset store with shipped starter styles on first run.
    Idempotent: does nothing if any global preset already exists."""
    try:
        if preset_store.list("global"):
            return
        if not _PRESET_SEED_PATH.exists():
            return
        seeds = json.loads(_PRESET_SEED_PATH.read_text(encoding="utf-8"))
        for s in seeds:
            preset_store.create(
                name=s["name"], category=s.get("category", "Style"), prompt=s.get("prompt", ""),
                params=s.get("params", {}), modelId=s.get("modelId"), refImages=s.get("refImages", []),
                scope="global", projectId=None,
            )
    except Exception as exc:  # never let seeding break boot
        print(f"[presets] seed failed: {exc}", flush=True)


def backfill_preset_thumbnails() -> None:
    """Idempotent: for each seeded global preset that has NO thumbnail yet and a
    shipped thumbnail webp on disk, write the /api/presets/thumbnails/<slug> URL
    into the preset record. Runs every boot; never raises (boot must not break).

    Only fills *empty* thumbnails — so a user who creates a global preset that
    happens to share a seed name AND captures a custom thumbnail keeps it (we
    never overwrite a non-empty thumbnail). This also makes it naturally
    idempotent: once filled the thumbnail is non-empty, so later boots skip it
    (no version churn)."""
    try:
        if not _PRESET_SEED_PATH.exists():
            return
        seeds = json.loads(_PRESET_SEED_PATH.read_text(encoding="utf-8"))
        thumbnails_dir = _PRESET_SEED_PATH.parent / "thumbnails"
        # Build a name→preset map for all global presets
        global_presets = {p["name"]: p for p in preset_store.list("global")}
        from services.preset_store import slug_for_preset
        for s in seeds:
            name = s["name"]
            preset = global_presets.get(name)
            if preset is None:
                continue  # not yet seeded — seed_presets_if_empty handles it
            if preset.get("thumbnail"):
                continue  # already has a thumbnail (shipped or user-custom) — never clobber
            slug = slug_for_preset(name)
            webp = thumbnails_dir / f"{slug}.webp"
            if not webp.exists():
                continue  # thumbnail not shipped for this preset
            preset_store.update(preset["id"], thumbnail=f"/api/presets/thumbnails/{slug}")
    except Exception as exc:
        print(f"[presets] thumbnail backfill failed: {exc}", flush=True)


# ---------- File actions (Reveal in Finder / Save to folder) ----------

@app.post("/api/reveal")
async def reveal_in_finder(body: dict[str, Any]) -> dict:
    """Reveal an output file in the OS file manager (Finder / Nautilus / Explorer)."""
    url = body.get("url", "")
    local = _output_path_from_ref(url)
    if local is None:
        raise HTTPException(status_code=400, detail="not a local output path")

    import sys as _sys

    platform = _sys.platform
    if platform == "darwin":
        cmd = ["open", "-R", str(local)]
    elif platform == "win32":
        cmd = ["explorer", f"/select,{local}"]
    else:
        # Linux: open the parent directory
        cmd = ["xdg-open", str(local.parent)]

    await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    return {"status": "ok"}


@app.post("/api/export")
async def export_file(body: dict[str, Any]) -> dict:
    """Copy an output file to the user's configured export folder (default ~/Downloads)."""
    import shutil as _shutil

    url = body.get("url", "")
    src = _output_path_from_ref(url)
    if src is None:
        raise HTTPException(status_code=400, detail="not a local output path")

    settings = load_settings()
    folder = settings.get("exportFolder")
    dest_dir = require_allowed_path(Path(folder).expanduser() if folder else Path.home() / "Downloads")
    filename = body.get("filename") or src.name
    if not isinstance(filename, str) or filename in {".", ".."} or Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="filename must be a single file name")

    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    # Determine filename with collision avoidance
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    dest = dest_dir / filename
    counter = 1
    while dest.exists():
        dest = dest_dir / f"{stem} -{counter}{suffix}"
        counter += 1

    try:
        _shutil.copy2(require_allowed_path(src), require_allowed_path(dest))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return {"status": "ok", "savedPath": str(dest)}


@app.post("/api/transcode-image")
async def transcode_image_route(body: dict[str, Any]) -> Response:
    """Transcode a local output image to PNG/JPG/WEBP for the gallery download menu."""
    from services.image_transcode import transcode_image_file, UnsupportedFormatError

    src = _output_path_from_ref(body.get("url", ""))
    if src is None:
        raise HTTPException(status_code=400, detail="not a local output path")
    try:
        data, mime, filename = transcode_image_file(src, str(body.get("format", "")))
    except UnsupportedFormatError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # corrupt/unreadable image, etc.
        raise HTTPException(status_code=500, detail=f"transcode failed: {exc}")
    return Response(
        content=data,
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# F-21: manifest metadata for a single generated output. Registered BEFORE
# the catch-all serve_output below so "/api/outputs/<rel>/meta" reaches this
# handler instead of being treated as a file request.
@app.get("/api/outputs/{rel:path}/meta")
async def output_meta(rel: str):
    roots = [OUTPUT_ROOT] + ([DEFAULT_OUTPUT_ROOT] if DEFAULT_OUTPUT_ROOT != OUTPUT_ROOT else [])
    candidate: Path | None = None
    for root in roots:
        try:
            resolved = require_allowed_path(root / rel)
            resolved.relative_to(root.resolve())  # containment — block ../ traversal
        except (ValueError, OSError):
            continue
        candidate = resolved
        break
    if candidate is None or not candidate.is_file():
        raise HTTPException(status_code=404, detail="output not found")
    try:
        manifest = read_manifest(candidate.parent)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="no manifest for this output")
    except ManifestError:
        raise HTTPException(status_code=500, detail="malformed manifest")
    record = find_output_record(manifest, candidate, candidate.parent)
    if record is None:
        raise HTTPException(status_code=404, detail="output not listed in manifest")
    # Whitelisted keys only, output_path forced relative — the response never
    # exposes absolute host paths, even from a hand-edited manifest.
    output_path = record.get("output_path")
    if isinstance(output_path, str) and Path(output_path).is_absolute():
        output_path = Path(output_path).name
    params = record.get("params")
    return {
        "run_id": manifest.get("run_id"),
        "node_id": record.get("node_id"),
        "node_type": record.get("node_type"),
        "model": record.get("model"),
        "endpoint": record.get("endpoint"),
        "prompt": record.get("prompt"),
        "params": params if isinstance(params, dict) else {},
        "output_path": output_path,
        "timestamp": record.get("timestamp"),
    }


# Dynamic catch-all replaces the old StaticFiles mount so the serve root can
# change without restarting. Also falls back to DEFAULT_OUTPUT_ROOT so outputs
# created before a relocation remain accessible. MUST be last — it is a catch-all.
# Outputs that a browser would run as a document. Provider SVGs (Quiver, fal,
# Replicate, Krea Files) can carry script, and this origin is Nebula's API, so
# they are served sandboxed: no script, no requests, inline styles and data
# images only. <img> rendering is unaffected.
_ACTIVE_OUTPUT_SUFFIXES = {".svg", ".svgz", ".html", ".htm", ".xhtml", ".xml"}
_ACTIVE_OUTPUT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; sandbox"


@app.get("/api/outputs/{rel:path}")
async def serve_output(rel: str):
    roots = [OUTPUT_ROOT] + ([DEFAULT_OUTPUT_ROOT] if DEFAULT_OUTPUT_ROOT != OUTPUT_ROOT else [])
    for root in roots:
        try:
            candidate = require_allowed_path(root / rel)
            candidate.relative_to(root.resolve())  # containment — block ../ traversal
        except (ValueError, OSError):
            continue
        if candidate.is_file():
            headers = {"X-Content-Type-Options": "nosniff"}
            if candidate.suffix.lower() in _ACTIVE_OUTPUT_SUFFIXES:
                headers["Content-Security-Policy"] = _ACTIVE_OUTPUT_CSP
            return FileResponse(candidate, headers=headers)
    raise HTTPException(status_code=404, detail="output not found")

# Seed starter presets on first boot. seed_presets_if_empty() is defined above
# and is idempotent + wrapped in try/except so it can never break startup.
seed_presets_if_empty()
# Backfill thumbnail URLs on every boot (idempotent, only touches seeded presets).
backfill_preset_thumbnails()
