from __future__ import annotations

# Must run before ANY third-party import (fastapi/pydantic): an inherited
# PYTHONPATH pointing at another Python version's site-packages (e.g. Hermes
# exporting 3.11 paths while Nebula runs on 3.12) breaks pydantic_core at
# import time. env_check is stdlib-only so it is safe to import this early.
import env_check as _env_check

_env_check.run_startup_checks()

import asyncio
import copy
import errno
import hashlib
import json
import logging
import math
import os
import random
import re
import secrets
import shutil
import stat
import tempfile
import time as _time_module
import unicodedata
import zipfile
from collections import OrderedDict, deque
from contextlib import ExitStack, aclosing, contextmanager, nullcontext
from contextvars import Context, ContextVar
import dataclasses
from dataclasses import dataclass
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, BinaryIO, Callable, Iterable, Mapping, NoReturn, Sequence
from urllib.parse import quote, urlsplit

from uuid import uuid4

from dotenv import load_dotenv
from fastapi import Body, FastAPI, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
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
    SkippedEvent,
    GraphCancelledEvent,
    GraphCompleteEvent,
    ProviderRecoveryEvent,
    ProviderStartAmbiguousEvent,
    execution_run_id,
)
from execution.engine import execute_graph, validate_graph, topological_sort, get_subgraph, CycleError
from execution.sync_runner import get_handler_registry
from execution import provider_calls
from services.settings import (
    load_settings,
    save_settings,
    get_api_key,
    validate_provider_keys,
    clear_provider_validation_cache,
    is_injected_mode,
    update_injected_keys,
)
from services.credential_catalog import CREDENTIAL_PROVIDERS
from services.node_registry import NodeRegistry
from services.input_file_name import PARAM as INPUT_FILE_NAME_PARAM, file_name_param
from services import agent_connect, agent_spend, backend_address, app_tokens, maker_sizes, model_pricing, node_readiness, node_route, output_preview
from services import agent_start, input_sizes, node_categories, node_lookup, node_names
from services import output_thumbnail
from services import refusal_copy
from services.node_errors import NodeErrors
from services import project_cover
from services import graph_file_links, project_size
from services.cli_graph import SHORT_ID_RE, CLIGraph
from services.retired_nodes import folded_entry, migrate_graph, migrate_node, migrate_param_update, migrate_params, retired_message
from services.saved_graph_upgrades import PARAMS_VERSION, request_version, upgrade_flat_nodes, upgrade_project
from services.project_store import (
    MAX_PROJECT_BYTES, ProjectLimitError, ProjectStore, ProjectStoreError, empty_snapshot,
    make_project, metadata as project_metadata, needs_cover, now as project_now,
    project_name, public_project, recorded_cover_owner, refresh_metadata, validate_project_id,
    move_to_trash, purge_expired_trash, restore_from_trash, trash_metadata,
)
from services.port_contracts import (
    ContractEdge,
    ContractNode,
    cinema_output_ports,
    node_ports,
    validate_edge_contracts,
)
from services import universal_ports
from services.media_types import MEDIA_PORT_IDS
from services.file_access import ProtectedPathError, require_allowed_path, validate_file_references
from services.qc_common import extract_frames
from services.output import OUTPUT_ROOT, DEFAULT_OUTPUT_ROOT, resolve_output_ref, portable_output_ref, ManifestError, find_output_record, read_manifest, write_new_file, link_new, is_being_written
from services.image_input import is_remote_or_data_uri
from services.cache import ExecutionCache
from services.execution_runs import (
    ExecutionCancellationCapacityError,
    ExecutionCancelledBeforeStartError,
    ExecutionRunRegistry,
)
from services.chat_session import run_claude
from services import antigravity_agent, personal_agents
from services.acp_session import PersonalSessionError, acp_sessions
from services.agent_profiles import (
    GrantOverlapsProtectedDir,
    agent_read_grants,
    protected_agent_dirs,
)
from services.local_guard import LocalRequestGuard
from services.json_number_guard import JsonNumberGuard, JsonNumberOutOfRange, loads_checked
from services.agent_workspaces import AgentWorkspaceContext, WorkspaceSessions, WorkspaceSessionError, workspace_scope
from services.chat_actions import publish_action
from services import moodboard_actions
from services.agent_presence import (
    AgentIdentity,
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
    actor_record,
    actor_label,
    canvas_events,
    param_changes,
    parse_kinds,
)
from services.canvas_pins import ANOTHER_PROJECT, CanvasPins, PinError, pin_left, pin_summary
from services.node_removals import RemovalLedger
from services.agent_notes import AgentNotes, NoteError, note_summary
from services import person_session
from services import asset_trash
from services.child_env import scrubbed_env
from services.person_gate import (
    PERSON_HEADER,
    PERSON_REQUIRED,
    PersonGateError,
    has_agent_marker,
    is_person,
    person_gate_error,
    require_person,
)
from services.canvas_edits import INTERNAL_OK as BILLING_PARAMS, EditSpec, parse_edit
from services.canvas_arrange import canvas_arrange
from services.canvas_undo import (
    EDIT_ID_RE, UNDONE_VERBS, CanvasUndoBook, UndoError, build_inverse, capture_before, nothing_went_back,
    plan_undo, touched_nodes,
)
from services.agent_params import ASSET_PARAM_TYPES, asset_params, internal_keys, internal_refusal
from services.canvas_proposals import (
    MAX_REASON,
    Proposal,
    ProposalError,
    ProposalSpec,
    agent_wording,
    canvas_proposals,
    clean_note,
    clean_positions,
    cost_for,
    parse_spec,
    place_new_nodes,
    summarize_cost,
)
# Proposals outside the graph: a project's cover, a board's Send notes (U16).
from services.asset_proposals import AssetProposal, asset_proposals
from services.asset_proposals import parse_change as parse_asset_change, summary as asset_proposal_summary
from services.asset_proposals import RESTART_OUTCOME, outcome_line as asset_outcome_line, update_text as asset_update_text
# Each canvas proposal's Update too (Justin's Q112 a).
from services.canvas_proposals import update_outcome as canvas_outcome_line, update_text as canvas_update_text
# Questions an agent asks the person (Q125 item 1), modelled on proposals.
from services.agent_questions import (
    CLOSED_OUTCOME as QUESTIONS_CLOSED_OUTCOME,
    RESTART_OUTCOME as QUESTIONS_RESTART_OUTCOME,
    WITHDRAW_HTTP as QUESTIONS_WITHDRAW_HTTP,
    QuestionBook,
    QuestionError,
    QuestionSet,
    parse_answers as parse_question_answers,
    parse_questions,
    still_open_rows,
    update_outcome as question_outcome_line,
    update_text as question_update_text,
)
from services.agent_presence import request_headers_scope
# The Agents panel (Q125 item 2): each agent's status line and the roster.
from services.agent_status import AgentStatusBook, StatusError, Waiting, build_roster, clean_status_text
from services.local_guard import host_allowed
from services import run_approvals as approvals
from services.run_approvals import RunApprovals
from services.zoom_manifest import init_manifest, append_entry
from routes.openrouter_proxy import router as openrouter_router
from routes.replicate_proxy import router as replicate_router
from routes.fal_proxy import router as fal_router
from routes.nous_proxy import router as nous_router
from routes.quiver_proxy import router as quiver_router
from routes.video_edit_preview import router as video_edit_preview_router
from routes.render_exports import router as render_exports_router
from routes.krea_connector import router as krea_connector_router
from services.krea_connector import get_connector as _krea_connector
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
# The serving loop, for a catalog restore made in a worker thread (set at startup).
_main_loop: asyncio.AbstractEventLoop | None = None


def _catalog_restore_note(record: Mapping[str, Any]) -> str:
    """What agents read about a catalog restore (GET /api/projects
    `catalogRestore.note`, start_here, the journal): what happened, from
    where, what came back, where the damaged file is kept. Not the person's
    notice (frontend catalogRestoreCopy.ts has GM's lines)."""
    where = f" from {record.get('source')}" if record.get("source") else " from the projects its damaged files still held"
    did = "restored" if record.get("kind") == "restored" else "had no good copy and rebuilt"
    parts = [f"Nebula found its project list (catalog.json) {record.get('reason') or 'damaged'} and {did} it{where}."]
    added = int(record.get("addedBackCount") or 0)
    if added:
        parts.append(f"{added} project{'s' if added != 1 else ''} the copy lacked {'were' if added != 1 else 'was'} "
                     "added back from the damaged file.")
    missing = int(record.get("notAddedBackCount") or 0)
    if missing:
        parts.append(f"{missing} project{'s' if missing != 1 else ''} in the damaged file could not be added back "
                     f"and {'stay' if missing != 1 else 'stays'} only there (notAddedBack).")
    if record.get("openProjectMissing"):
        parts.append("The project that was open didn't come back, so none is open.")
    kept = [path for path in record.get("setAside") or [] if path]
    if kept:
        parts.append(f"The damaged file{'s are' if len(kept) > 1 else ' is'} kept at {', '.join(kept)}.")
    parts.append("Project ids read before it may be stale: list the projects again "
                 "(list_projects, `nebula projects`).")
    return " ".join(parts)


def _catalog_restore_view(record: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """A restore record as GET /api/projects carries it (`catalogRestore`):
    the person's notice reads kind and addedBack; agents and support read
    the rest and `note`."""
    if not record:
        return None
    keys = ("id", "at", "kind", "reason", "source", "damagedFile", "setAside", "addedBack", "addedBackCount",
            "updatedFromDisk", "updatedFromDiskCount", "notAddedBack", "notAddedBackCount", "projectCount",
            "trashCount", "openProjectMissing")
    return {**{key: copy.deepcopy(record.get(key)) for key in keys}, "note": _catalog_restore_note(record)}


def _on_catalog_restore(record: dict[str, Any]) -> None:
    """ProjectStore restored a damaged catalog (services/project_store.py,
    after it let go of the lock): journal it for agents
    (`project.catalogRestored`, with where it came from and where the
    damaged file is kept) and tell open tabs to list again, which shows the
    person's notice. On the serving loop; a restore at boot has none yet and
    is only journaled."""
    view = _catalog_restore_view(record) or {}
    print(f"[projects] {view.get('note')}", flush=True)

    def tell() -> None:
        data = {key: view.get(key) for key in ("id", "kind", "reason", "source", "addedBackCount",
                                               "notAddedBackCount", "projectCount")}
        # By name in their folder: the journal cuts strings at 160 characters.
        kept = [Path(path) for path in view.get("setAside") or [] if path]
        data["folder"] = str(kept[0].parent) if kept else None
        data["damagedFile"] = Path(view["damagedFile"]).name if view.get("damagedFile") else None
        data["setAside"] = [path.name for path in kept]
        data["addedBack"] = [{"id": row.get("id"), "name": row.get("name")} for row in (view.get("addedBack") or [])[:20]]
        _journal("project.catalogRestored", data=data, summary=view.get("note", ""), actor={"kind": "system"})
        try:
            asyncio.get_running_loop().create_task(_broadcast_projects_changed("catalogRestored"))
        except RuntimeError:
            pass  # no loop (boot): tabs list on load anyway

    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None:
        running.call_soon(tell)
    elif _main_loop is not None and not _main_loop.is_closed():
        _main_loop.call_soon_threadsafe(tell)
    else:
        tell()


project_store.on_restore = _on_catalog_restore


def _open_project_id() -> str | None:
    """The project catalog.json has open now (ProjectStore.projection: no
    catalog copy, read again only once the file changes)."""
    return project_store.projection().project_id


def _journal_project() -> str | None:
    """The journal's project tag: the open project as every canvas event
    names it (_workspace_context, from ProjectStore.projection)."""
    return _workspace_context()["activeProjectId"]


def _events_journal():
    """The canvas event journal, tagging events and answers with the project
    the catalog has open (CanvasEventJournal.follow). Through here so a
    journal a test swaps in follows it too."""
    if not canvas_events.following:
        canvas_events.follow(_journal_project)
    return canvas_events


# Which delete of which node each removal record undoes (services/node_removals.py).
node_removals = RemovalLedger()
# Updates (plan section 5.9): the agent's and the reader's notices, kept with
# the project (main canvas) or beside each board. Same getter as pins.
agent_notes = AgentNotes(lambda: project_store)
# Questions agents ask the person (Q125 item 1), kept on the project record
# like pins and Updates (services/agent_questions.py). Same getter.
agent_questions = QuestionBook(store=lambda: project_store)
# Each agent's status line (Q125 item 2): in memory only, like cursors.
agent_status = AgentStatusBook()


def _agent_sign(identity: AgentIdentity) -> None:
    """Any identified request (RequestHeadersContext): the agent is still
    there, so its status line lasts another STATUS_IDLE_SECONDS."""
    agent_status.saw(identity)


_request_workspace_revision: ContextVar[str | None] = ContextVar("workspace_revision", default=None)
_execution_workspace_context: ContextVar[dict[str, Any] | None] = ContextVar("execution_workspace", default=None)
_live_graph_load_failed = False
if _STATE_PATH is not None and _STATE_PATH.exists():
    try:
        cli_graph.load(_STATE_PATH)
        print(f"[main] restored graph from {_STATE_PATH} — {len(cli_graph.nodes)} nodes, {len(cli_graph.edges)} edges", flush=True)
        if cli_graph.params_advanced_on_load:
            # Write the upgraded params and the version marker now, so the
            # file matches what the canvas, agents and runs read, and the
            # next boot doesn't count it as advanced again
            # (services/saved_graph_upgrades.py).
            cli_graph._maybe_persist()
            if cli_graph.upgraded_on_load:
                print(f"[main] upgraded saved params on {cli_graph.upgraded_on_load} node(s)", flush=True)
    except Exception as exc:
        _live_graph_load_failed = True
        print(f"[main] failed to restore graph from {_STATE_PATH}: {exc} — starting fresh", flush=True)


def _finish_params_upgrade_at_boot(*, live_graph_advanced: bool) -> bool:
    """A one-time params upgrade ran at this boot: rotate the workspace
    revision so tabs loaded before it stop writing (ProjectStore.
    advance_params_version). Best effort: a storage error is printed, and the
    params-version gate (project_workspace_fence) still refuses stale tabs."""
    try:
        rotated = project_store.advance_params_version(live_graph_advanced=live_graph_advanced)
    except ProjectStoreError as exc:
        print(f"[main] could not write the params upgrade to the project catalog: {exc}", flush=True)
        return False
    if rotated:
        print(f"[main] saved params are at version {PARAMS_VERSION}; tabs opened before this restart will reload", flush=True)
    return rotated


# Not after a failed state.json load: that boot already started from an empty
# live graph, and nothing here should build on it.
if not _live_graph_load_failed:
    _finish_params_upgrade_at_boot(live_graph_advanced=cli_graph.params_advanced_on_load)

provider_recovery_store = ProviderRecoveryStore(
    _STATE_DIR / "provider-recoveries.json" if _STATE_PATH is not None else None
)
# Each node's last run error, per project, kept across restarts (services/node_errors.py).
node_errors = NodeErrors(_STATE_DIR / "node-errors.json" if _STATE_PATH is not None else None)


def _restore_node_errors() -> None:
    """Boot: point the saved errors at the open project and drop projects deleted for good."""
    try:
        catalog = project_store.read()
    except ProjectStoreError as exc:
        print(f"[main] node errors: project catalog unreadable ({exc}); keeping them all", flush=True)
        return
    node_errors.use_project(catalog.get("activeProjectId"))
    node_errors.keep_projects(set(catalog.get("projects") or {}) | set(catalog.get("trash") or {}))


_restore_node_errors()
provider_start_guard = ProviderStartGuard(
    _STATE_DIR / "provider-start-ambiguities.json" if _STATE_PATH is not None else None
)


# A node's World Labs paid state, in the person's words. GM - Design's
# wording for round 13 of PR #114 (verbatim, each line under the screen's own
# "Couldn't <action>." heading; node names are card titles in curly quotes):
# - active (a start still in flight): "A World Labs run is still starting.
#   Try again in a moment."
# - ambiguity (and the browser's own unconfirmed run): "A World Labs run
#   needs your check first. Use the notice at the top of the screen." (the
#   status bar's "I've checked Marble")
# - recovery: "“<node>” has a saved World Labs recovery ID. Check the run in
#   Marble, then forget the ID in Run History." (Run History's "Forget ID")
# - params: "“<node>” has a World Labs ID in its settings. Check it in
#   Marble, then clear “Resume Operation ID”.", naming the field that
#   actually holds the ID.
# The wording only: which states refuse is unchanged. Agents keep the
# specific text.
WORLD_LABS_STARTING_PERSON = "A World Labs run is still starting. Try again in a moment."
WORLD_LABS_NEEDS_CHECK_PERSON = "A World Labs run needs your check first. Use the notice at the top of the screen."
# Nebula couldn't journal a recovery it read from the canvas at boot, and the
# retry's real journal write just failed too. A reload doesn't re-run that
# bootstrap (it runs once, when the backend starts; the notes for round 13
# give the mechanism), so the line says restart. GM, round 15 of PR #114
# (item 5): "Couldn't <action>. Nebula couldn't save its World Labs
# safeguards. Restart Nebula, then try again." The screen's own heading
# supplies "Couldn't <action>.".
WORLD_LABS_BOOTSTRAP_PERSON = "Nebula couldn't save its World Labs safeguards. Restart Nebula, then try again."
_RECOVERY_FIELDS_FALLBACK = ("Resume Operation ID", "Existing World ID")


def _quoted_fields(fields: Sequence[str]) -> str:
    """“A”, or “A” and “B”: the ID fields, as the node labels them."""
    quoted = [f"\u201c{field}\u201d" for field in fields] or [f"\u201c{_RECOVERY_FIELDS_FALLBACK[0]}\u201d"]
    return quoted[0] if len(quoted) == 1 else ", ".join(quoted[:-1]) + " and " + quoted[-1]


def _paid_state_person(state: str, *, node: str | None = None, fields: Sequence[str] = ()) -> str:
    """GM's line for a World Labs `state`. `node` is the held node's card
    title (recovery, params); `fields` the labels of the ID fields that hold
    an ID (params)."""
    if state == "active":
        return WORLD_LABS_STARTING_PERSON
    if state == "ambiguity":
        return WORLD_LABS_NEEDS_CHECK_PERSON
    if state == "bootstrap":
        return WORLD_LABS_BOOTSTRAP_PERSON
    name = f"\u201c{node}\u201d" if node else "\u201cWorld Labs Environment\u201d"
    if state == "recovery":
        return (f"{name} has a saved World Labs recovery ID. "
                "Check the run in Marble, then forget the ID in Run History.")
    return f"{name} has a World Labs ID in its settings. Check it in Marble, then clear {_quoted_fields(fields)}."


# The two buttons, by GM's round 13 labels.
UNLOCK_BUTTON = "\u201cI've checked Marble\u201d"
FORGET_BUTTON = "\u201cForget ID\u201d"
# Round 3b: a canvas edit that raced a change to the shared recovery journal.
CANVAS_JOB_CHANGED_PERSON = "A node's World Labs job changed while Nebula saved the canvas. Reload, then try again."


def _paid_capacity_person(limit: int | None) -> str:
    """A full World Labs journal (GM - Design, after 3b: "Nebula is already
    waiting on {n} World Labs jobs, the most it can track. Check them in
    Marble and clear some in Run History, then try again." Used for a run and
    a canvas edit alike)."""
    if limit == 1:
        return ("Nebula is already waiting on 1 World Labs job, the most it can track. "
                "Check it in Marble and clear it in Run History, then try again.")
    head = (f"Nebula is already waiting on {limit} World Labs jobs, the most it can track." if limit else
            "Nebula is already waiting on as many World Labs jobs as it can track.")
    return f"{head} Check them in Marble and clear some in Run History, then try again."


def _paid_job_changed_person(button: str) -> str:
    """The hold or record the button acts on changed since the page read it
    (a newer start replaced it): round 3b."""
    return f"This node is waiting on a newer World Labs job. Reload to see it, check it in Marble, then use {button}."


def _start_refusal(exc: ProviderStartConflictError, *, own_node: bool = False) -> HTTPException:
    """409 for a paid start the guard refused, worded by the code it was
    raised with (ProviderStartConflictError.reason, never its text): the
    person reads _paid_state_person's line for the state that holds the
    canvas, agents the exact text. `own_node`: the request names the node
    whose start is in flight (the status bar's "I've checked Marble")."""
    reason = getattr(exc, "reason", "active")
    if reason == "cancelled":
        # A Stop that beat the run's admission: it names no World Labs state
        # (listed for GM, round 3b).
        return HTTPException(status_code=409, detail=str(exc))
    if reason == "capacity":
        person = _paid_capacity_person(getattr(exc, "limit", None))
    elif reason == "changed":
        person = _paid_job_changed_person(UNLOCK_BUTTON)
    else:
        state = "active" if reason in {"active", "busy"} else reason
        fields = getattr(exc, "fields", None)
        person = _paid_state_person(state, node=getattr(exc, "node", None),
                                    fields=[fields] if isinstance(fields, str) else fields or ())
    return refusal_copy.refusal(409, str(exc), person, route="run")


def _recovery_field_labels(nodes: list[dict[str, Any]]) -> list[str]:
    """The labels (node_definitions.json) of the recovery ID fields `nodes`
    hold, in policy order: a World node's "Resume Operation ID" and "Existing
    World ID", a World export node's "Resume Export Operation ID"."""
    labels: list[str] = []
    for node in nodes:
        definition_id = str(node.get("definitionId") or "")
        policy = operation_policy(definition_id)
        if policy is None:
            continue
        operation, resource = recovery_identifiers(definition_id, node.get("params") or {})
        definition = node_registry.get(definition_id) or {}
        names = {param.get("key"): param.get("label") for param in definition.get("params") or []
                 if isinstance(param, dict)}
        for key, value in ((policy.recovery_operation_param, operation), (policy.recovery_resource_param, resource)):
            label = names.get(key) if key and value else None
            if isinstance(label, str) and label and label not in labels:
                labels.append(label)
    return labels


def _graph_paid_refusal(specific: str, state: str, *, node: str | None = None,
                        fields: Sequence[str] = ()) -> HTTPException:
    """409 for replacing the whole canvas (clear it, open or make a project,
    replace the graph, restore a bundle) while World Labs state holds a node.
    The person's line (GM, round 13: _paid_state_person) leaves the action
    out: the screen's own heading ("Couldn't clear the canvas.") names it."""
    return refusal_copy.refusal(409, specific, _paid_state_person(state, node=node, fields=fields), route="canvas")


def _graph_settling_specific(action: str) -> str:
    return (f"Cannot {action} while a World Labs paid start is settling. "
            "Stop the run and wait for its terminal state first.")


def _reject_graph_replacement_during_paid_start(action: str) -> None:
    if provider_start_guard.has_active():
        raise _graph_paid_refusal(_graph_settling_specific(action), "active")
    nodes = list(cli_graph.nodes.values())
    canonical_checkpoints = _graph_worldlabs_recovery_checkpoints(nodes)
    node: str | None = None
    fields: list[str] = []
    # One read of the ambiguity list (review 13, nit 7): the rule is
    # literally b2b1529e's, never an ambiguity seen by one read and not the next.
    ambiguities = provider_start_guard.list()
    records = provider_recovery_store.list() if not ambiguities else []
    if ambiguities:
        state = "ambiguity"
    elif records:
        state = "recovery"
        node = _node_label(str(records[0].get("nodeId") or ""))
    elif canonical_checkpoints:
        state = "params"
        held = cli_graph.nodes.get(canonical_checkpoints[0][0]) or {}
        node = _node_label(canonical_checkpoints[0][0])
        fields = _recovery_field_labels([held])
    elif _graph_recovery_bootstrap_error is not None and not _retry_graph_recovery_bootstrap(action):
        # Nebula couldn't journal a recovery it read from the canvas at boot
        # (see WORLD_LABS_BOOTSTRAP_PERSON), and retrying that just now failed.
        raise _graph_paid_refusal(_graph_bootstrap_specific(action), "bootstrap")
    else:
        return
    raise _graph_paid_refusal(
        f"Cannot {action} while unresolved World Labs paid state exists. "
        "Check Marble and resolve the exact recovery/ambiguity record first.",
        state, node=node, fields=fields,
    )


def _graph_bootstrap_specific(action: str) -> str:
    """Agents' detail for the bootstrap state (round 14 of PR #114): the
    retry was made, the journal still can't be written, and only a backend
    restart helps. The person reads WORLD_LABS_BOOTSTRAP_PERSON."""
    return (f"Cannot {action}: Nebula retried saving its World Labs recovery journal and "
            "couldn't write it. Restart the Nebula backend, then try again.")


def _retry_graph_recovery_bootstrap(action: str) -> bool:
    """The bootstrap retry path (round 14 of PR #114). Before the bootstrap
    state refuses, re-run the re-seed a run start does
    (_claim_fresh_paid_worldlabs_starts' prepare_recovery_journal) under the
    lifecycle fence a canvas replacement takes (_paid_graph_mutation), then
    prove the journal takes a real write (round 15, review 14's M4:
    ProviderRecoveryStore.verify_writable; the store's sticky health flag
    isn't asked, and a re-seed with no IDs to seed writes nothing). True
    (and the error cleared) only when that write held; False (the error
    kept) when it still can't be written. Reached only where the error is
    set, outside the fence: the bundle restore's pre-check and the open's
    ahead-of-time check (_open_ingress_verdict_off_loop).

    The paid-start fence's own storage failing (review 14's L7) is that
    store's error, not the journal's: it answers the 507 a canvas
    replacement answers for it and leaves the bootstrap error as it was."""
    global _graph_recovery_bootstrap_error
    try:
        with provider_start_guard.exclusive_lifecycle():
            _ensure_shared_graph_recoveries(list(cli_graph.nodes.values()), source="bootstrap-retry")
            provider_recovery_store.verify_writable()
    except ProviderStartConflictError as exc:
        # A start began since has_active() was read: the settling refusal, as
        # _paid_graph_mutation answers it.
        raise _graph_paid_refusal(_graph_settling_specific(action), "active") from exc
    except ProviderStartPersistenceError as exc:
        raise _paid_fence_unverifiable(action) from exc
    except (
        ProviderRecoveryCapacityError,
        ProviderRecoveryConflictError,
        ProviderRecoveryPersistenceError,
        ValueError,
    ) as exc:
        _graph_recovery_bootstrap_error = str(exc)
        return False
    _graph_recovery_bootstrap_error = None
    return True


def _paid_fence_unverifiable(action: str) -> HTTPException:
    """507: the cross-process paid-start fence's storage can't be read or
    written, so nothing that needs the fence goes on."""
    return RunSafetyStorageRefusal(
        detail=(
            f"Cannot {action} because Nebula cannot verify the durable "
            "World Labs paid-start fence."
        ),
    )


def _clear_bootstrap_error_after_real_write() -> None:
    """Under the lifecycle fence, with the bootstrap error set: clear it only
    when the recovery journal takes a real write now (verify_writable), else
    keep it, with the store's latest reason. Never refuses by itself, so an
    ordinary edit that takes the fence isn't refused for this state (round
    15: which states refuse is unchanged); it only stops clearing it on a
    seed that wrote nothing."""
    global _graph_recovery_bootstrap_error
    if _graph_recovery_bootstrap_error is None:
        return
    try:
        provider_recovery_store.verify_writable()
    except ProviderRecoveryPersistenceError as exc:
        _graph_recovery_bootstrap_error = str(exc)
        return
    _graph_recovery_bootstrap_error = None


@contextmanager
def _paid_graph_mutation(action: str):
    """Hold the cross-process paid lifecycle fence through a graph commit."""
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
            # Round 15: the seed may have written nothing (no IDs on the
            # canvas), so it alone can't clear the bootstrap error.
            _clear_bootstrap_error_after_real_write()
            yield
    except ProviderStartConflictError as exc:
        raise _graph_paid_refusal(_graph_settling_specific(action), "active") from exc
    except ProviderStartPersistenceError as exc:
        raise _paid_fence_unverifiable(action) from exc


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
        raise refusal_copy.refusal(409, str(exc), _paid_capacity_person(exc.limit),
                                   route="canvas") from exc
    except ProviderRecoveryConflictError as exc:
        raise refusal_copy.refusal(409, str(exc), CANVAS_JOB_CHANGED_PERSON, route="canvas") from exc
    except ProviderRecoveryPersistenceError as exc:
        raise RunSafetyStorageRefusal(
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
            raise RunSafetyStorageRefusal(
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
# This backend process's id, new on every start (the socket's first graphSync).
BACKEND_BOOT_ID = uuid4().hex


_DISK_FULL_ERRNOS = {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}


def _storage_full(exc: BaseException) -> bool:
    """The store failed because the disk (or the person's quota) is full: an
    OSError with ENOSPC or EDQUOT in the error's causes. Read from the cause,
    never the text (error copy round 3f)."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, OSError) and current.errno in _DISK_FULL_ERRNOS:
            return True
        current = current.__cause__ or current.__context__
    return False


def _storage_error_body(exc: ProjectStoreError) -> dict[str, Any]:
    """A storage refusal's JSON: ``detail`` as before (agents read it), and an
    additive ``storage: "full"`` when the disk is full, so the Projects view
    can say the one cause a person can fix (GM, round 3f). A store limit (413)
    adds ``limit``: "projects" or "storage", so the Projects screen doesn't
    call a full store "too large" when it can't keep a tab's unsaved edits
    (Q116 a)."""
    return {"detail": str(exc), **({"storage": "full"} if _storage_full(exc) else {}),
            **({"limit": exc.limit} if isinstance(exc, ProjectLimitError) else {})}


# Which store a 507 came from (round 17 of PR #114, review 16 L5), so the
# canvas words a refused run start by its cause: the project store (catalog
# or project storage unreadable) or the run-safety stores (the paid-start
# fence, the recovery journal, durable Stop state). Additive, beside detail.
PROJECT_STORE_STORAGE_CODE = "project_store"
RUN_SAFETY_STORAGE_CODE = "run_safeguards"


@app.exception_handler(ProjectStoreError)
async def project_storage_error(request, exc: ProjectStoreError):
    if isinstance(exc, ProjectLimitError):
        return JSONResponse(status_code=413, content=_storage_error_body(exc))
    return JSONResponse(status_code=507, content={**_storage_error_body(exc), "code": PROJECT_STORE_STORAGE_CODE})


class RunSafetyStorageRefusal(HTTPException):
    """507: a run-safety store (the paid-start fence, the World Labs recovery
    journal, durable Stop state) couldn't be read or written, before any
    provider call. Answers ``code: "run_safeguards"`` beside ``detail``."""

    def __init__(self, detail: str) -> None:
        super().__init__(status_code=507, detail=detail)


@app.exception_handler(RunSafetyStorageRefusal)
async def run_safety_storage_refusal(request, exc: RunSafetyStorageRefusal):
    return JSONResponse(status_code=507, content={"detail": exc.detail, "code": RUN_SAFETY_STORAGE_CODE})


class ProjectSizeRefusal(HTTPException):
    """A 413 because a project would be over the save limit (Q118): the
    snapshot a tab sent, or what an agent's edit would leave the open project
    at. Its answer carries ``limit: "size"`` (beside the store's "projects"
    and "storage"), ``sizeBytes`` and ``limitBytes`` beside ``detail``, so the
    canvas can pause saving from the answer, never its words. A tab's save
    keeps its old detail word for word; an agent's refusal has its own text."""

    def __init__(self, size: int, detail: str = "Project snapshot exceeds the 16 MiB limit",
                 scope: str | None = None) -> None:
        super().__init__(status_code=413, detail=detail)
        self.size = size
        self.scope = scope


@app.exception_handler(ProjectSizeRefusal)
async def project_size_refusal(request, exc: ProjectSizeRefusal):
    content = {"detail": exc.detail, "limit": "size", "sizeBytes": exc.size, "limitBytes": MAX_PROJECT_BYTES}
    if exc.scope:
        content["scope"] = exc.scope
    return JSONResponse(status_code=413, content=content)


def _workspace_context() -> dict[str, Any]:
    # Read on every canvas event: only these two fields, never a copy of every
    # project (ProjectStore.workspace).
    workspace = project_store.workspace()
    # paramsVersion: a tab built for another version reloads (graphSync,
    # GET /api/projects; services/saved_graph_upgrades.py).
    return {"activeProjectId": workspace["activeProjectId"], "workspaceRevision": workspace["workspaceRevision"],
            "paramsVersion": PARAMS_VERSION}


CANVAS_OUT_OF_DATE = "This canvas is out of date. Open the current project before editing or running it."


def _check_workspace_revision(revision: str | None = None) -> None:
    supplied = revision if revision is not None else _request_workspace_revision.get()
    if supplied is None:
        return
    current = _workspace_context()
    if supplied == current["workspaceRevision"]:
        return
    # A tab still on the unfiled canvas's revision is on the same canvas, if
    # nothing replaced it since its filing (round 13, H1).
    filed = _filed_canvases.get(supplied)
    if (filed is not None and filed[1]["workspaceRevision"] == current["workspaceRevision"]
            and filed[1]["activeProjectId"] == current["activeProjectId"]
            and filed[2] == canvas_undo_book.epoch(current["activeProjectId"])):
        return
    raise HTTPException(status_code=409, detail=CANVAS_OUT_OF_DATE)


# A write that awaits lands only on the canvas that was open when it was asked
# (review 9 of PR #114). Node ids restart per project and after a clear or an
# import, and agents send no workspace revision, so a route that awaits (the
# model catalog, a spend check, a file read) and then writes by node id would
# otherwise write the project opened meanwhile. Such a route takes
# _graph_fence() before its first await and calls _refuse_if_graph_moved()
# right before it writes; the notes for round 10 list every route.
# "changed since", not "another project is open": true after a switch away
# and back to the same project too (round 11).
GRAPH_MOVED_DETAIL = ("The open project changed since this started, so nothing was changed. Read the canvas again "
                      "and send the change again if it still fits.")
GRAPH_RESTARTED_DETAIL = ("The canvas was cleared or replaced since, so nothing was changed. Read the canvas again "
                          "and send the change again if it still fits.")


def _graph_fence() -> tuple[str, str | None, int]:
    """Which canvas is live: the workspace revision (new on every open,
    create and delete of a project, so a switch away and back counts), the
    open project, and its id epoch (new on a clear or an import)."""
    workspace = _workspace_context()
    project_id = workspace["activeProjectId"]
    return workspace["workspaceRevision"], project_id, canvas_undo_book.epoch(project_id)


# Filing the unfiled canvas is a rename, not a move (round 13 of PR #114,
# review 12's H1/H2). GET /api/projects on an empty catalog files the live
# unfiled canvas as "Recovered canvas": the same graph and ids under a new
# project id and workspace revision. Each filing notes, in the step that
# commits it, the unfiled canvas's (revision, id epoch) and what it became,
# so a write fenced on the unfiled canvas, a tab request carrying its
# revision, and a run admitted on it all read as the filed project. Only that
# exact canvas translates: a clear or a switch after the filing moves the new
# project's revision or epoch, and the comparison then refuses as before.
_FILED_CANVASES_KEPT = 64
_filed_canvases: OrderedDict[str, tuple[int, dict[str, Any], int]] = OrderedDict()


def _note_canvas_filed(old_revision: str, old_epoch: int, new_context: dict[str, Any]) -> None:
    """Record that the unfiled canvas at ``old_revision``/``old_epoch`` is now
    ``new_context`` (its _workspace_context). Call it in the filing's step."""
    project_id = new_context["activeProjectId"]
    _filed_canvases[old_revision] = (old_epoch, dict(new_context), canvas_undo_book.epoch(project_id))
    while len(_filed_canvases) > _FILED_CANVASES_KEPT:
        _filed_canvases.popitem(last=False)


def _filed_as(revision: Any, project_id: Any) -> tuple[int, dict[str, Any], int] | None:
    """What the unfiled canvas at ``revision`` was filed as, if it was."""
    if project_id is not None or not isinstance(revision, str):
        return None
    return _filed_canvases.get(revision)


def _filed_context(context: dict[str, Any] | None) -> dict[str, Any] | None:
    """A captured workspace context (a run's admission), read through a
    filing: the unfiled canvas's context becomes the filed project's, so
    the run's late events carry the revision the tab now holds."""
    if not context:
        return context
    filed = _filed_as(context.get("workspaceRevision"), context.get("activeProjectId"))
    return {**context, **filed[1]} if filed else context


def _filed_fence(fence: tuple[str, str | None, int]) -> tuple[str, str | None, int]:
    filed = _filed_as(fence[0], fence[1])
    if filed is None or filed[0] != fence[2]:
        return fence
    return filed[1]["workspaceRevision"], filed[1]["activeProjectId"], filed[2]


def _refuse_if_graph_moved(fence: tuple[str, str | None, int]) -> None:
    """409 when the live canvas is no longer the one ``fence`` noted. The
    person reads the canvas's own out-of-date line (a tab that sent its
    revision gets it from _check_workspace_revision); agents the detail."""
    _check_workspace_revision()
    fence = _filed_fence(fence)
    revision, project_id, epoch = _graph_fence()
    if (revision, project_id) != fence[:2]:
        raise refusal_copy.refusal(409, GRAPH_MOVED_DETAIL, CANVAS_OUT_OF_DATE, route="canvas")
    if epoch != fence[2]:
        raise refusal_copy.refusal(409, GRAPH_RESTARTED_DETAIL, CANVAS_OUT_OF_DATE, route="canvas")


# A run writes back only to the canvas it registered on (round 11 of PR #114,
# review 10's F4). Node ids restart after a clear or an import and per
# project, and a run's outputs, params, node errors, node events and Cinema
# merges land by node id, so each checks the canvas the run noted at
# registration (_register_run) and drops itself if the open project or its
# id epoch moved. Nothing is journaled for a write that didn't happen.
# Normally unreachable: a registered run blocks a clear, an import, a switch
# and a delete of the open project (_project_replacement_guard).
def _run_canvas_now() -> tuple[str | None, int]:
    project_id = _workspace_context()["activeProjectId"]
    return project_id, canvas_undo_book.epoch(project_id)


def _register_run(run_id: str, task: asyncio.Task[Any], canvas: tuple[str | None, int]) -> Any:
    """execution_runs.register, noting the canvas the run starts on
    (``canvas``, _run_canvas_now()). Callers read it, and check
    _refuse_if_graph_moved, before the task exists, with no await between:
    nothing that reads storage can fail once the task is made."""
    return execution_runs.register(run_id, task, canvas=canvas)


def _adopt_run_canvases(new_project_id: str) -> None:
    """The unfiled canvas becomes project ``new_project_id`` with the same
    live graph and ids (GET /api/projects or POST /api/projects filing it as
    "Recovered canvas"): nothing was replaced, so the runs noted on it, and
    its nodes' last errors, move to the new project. Call it in the step
    that commits the catalog, before any await (round 12 of PR #114, G1m).
    Only runs noted on the unfiled canvas as it is now move: one noted on an
    older unfiled canvas (its epoch moved since) stays dropped."""
    execution_runs.adopt_canvas((None, canvas_undo_book.epoch(None)),
                                (new_project_id, canvas_undo_book.epoch(new_project_id)))
    node_errors.adopt(None, new_project_id)


_runs_told_moved: OrderedDict[str, None] = OrderedDict()


def _run_canvas_moved(run_id: str | None, what: str) -> bool:
    """Whether a write-back (``what``) from run ``run_id`` must be dropped:
    the canvas it registered on is no longer the open one. Logged once per
    run. An unknown run, or one registered without a canvas, writes as before."""
    record = execution_runs.get(run_id) if run_id else None
    noted = getattr(record, "canvas", None)
    if noted is None:
        return False
    try:
        if _run_canvas_now() == noted:
            return False
    except ProjectStoreError:
        pass  # which canvas is open can't be read: don't write by node id
    if run_id not in _runs_told_moved:
        _runs_told_moved[run_id] = None
        while len(_runs_told_moved) > 256:
            _runs_told_moved.popitem(last=False)
        print(f"[run] run {run_id} started on a canvas that was cleared or replaced since; "
              f"dropped its {what} (and any later write-back)", flush=True)
    return True


def _capture_execution_workspace() -> None:
    # asyncio tasks inherit this immutable admission identity; late events
    # never borrow whichever project happens to be active when broadcast.
    _execution_workspace_context.set(_workspace_context())


# Routes where a tab's request stores or runs params. A tab whose bundle was
# built for another params version gets 409 params_outdated on them, so a tab
# loaded before a one-time upgrade can't save, run or push its old values
# (services/saved_graph_upgrades.py). Recovery stays open: it is how such a tab
# keeps its unsaved work, and it upgrades the copy from the body's version.
_PARAMS_GATED_PREFIXES = ("/api/graph", "/api/execute", "/api/cinema", "/api/quick", "/api/projects", "/api/presets")
_PARAMS_GATE_EXEMPT = frozenset({"/api/projects/recover"})
# Shown verbatim by main's bundle (its project and run errors print `detail`).
PARAMS_OUTDATED_DETAIL = (
    "Nebula was updated while this tab was open, so this tab can't save or run until it reloads. "
    "Reload the tab; your saved work is kept. If this keeps happening after a reload, this window's "
    "frontend build doesn't match the backend: rebuild the frontend, or restart the backend."
)


def _from_a_browser(request: Request) -> bool:
    """Whether a browser sent this request (never a proof of who, only of what).

    Every browser sends ``Origin`` on a request that isn't GET or HEAD. The
    packaged desktop renderer (a file: page) sends no Origin but does send
    ``Sec-Fetch-Site``. curl, Python (the CLI, MCP, agent tools) send neither,
    and Node's fetch sends only ``Sec-Fetch-Mode``. Checked 2026-10-17 against
    Electron 44.3 and Node 22.16."""
    return request.headers.get("origin") is not None or request.headers.get("sec-fetch-site") is not None


def _params_outdated(request: Request) -> bool:
    """Whether a request comes from a tab built for another params version.

    Every bundle since the gate sends ``X-Nebula-Params-Version`` on every
    request (frontend/src/lib/backend.ts ``apiFetch``, which every write to a
    gated route goes through). Older bundles send none. A request without it
    is version 0 when it came from the canvas or a browser:

    - ``X-Nebula-Workspace-Revision`` is set only by the canvas (the same
      function, while a project context exists; nothing in the backend, CLI,
      MCP or agent skills sets it).
    - A browser request (``_from_a_browser``) without it. Main's bundle can
      reach the canvas with no project context, so the revision alone doesn't
      cover it: after its conflict flow, Try again while no project is active
      clears the context but keeps ``activeProject``, and Open of that same
      project then takes ``open()``'s shortcut to the canvas without
      ``applyProject`` (main's projectStore.ts). Its runs, param pushes and
      saves then carry neither canvas header, but always an Origin (or, from
      the desktop renderer, Sec-Fetch-Site).

    A request with neither marker is an agent, the CLI, MCP or a script,
    whose values are set now and pass as sent. A script that writes an Origin
    is treated as a browser: it is refused until it sends the version."""
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return False
    path = request.url.path
    if path in _PARAMS_GATE_EXEMPT or not path.startswith(_PARAMS_GATED_PREFIXES):
        return False
    supplied = request.headers.get("x-nebula-params-version")
    if supplied is None:
        return request.headers.get("x-nebula-workspace-revision") is not None or _from_a_browser(request)
    # Lower (loaded before an upgrade) or higher (a backend older than the
    # bundle) are both refused: neither side can upgrade the other's values.
    return supplied.strip() != str(PARAMS_VERSION)


@app.middleware("http")
async def project_workspace_fence(request: Request, call_next):
    if _params_outdated(request):
        return JSONResponse(status_code=409, content={
            "code": "params_outdated", "detail": PARAMS_OUTDATED_DETAIL, "paramsVersion": PARAMS_VERSION,
        })
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
            return JSONResponse(status_code=507, content={**_storage_error_body(exc), "code": PROJECT_STORE_STORAGE_CODE})
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

# Refuses a JSON body with NaN, Infinity or a number past float's range (422),
# for every router, before any route parses it. Added before CORS and
# LocalRequestGuard so it runs inside both: a foreign Host or Origin is refused
# before the body is read, and the 422 carries CORS headers.
app.add_middleware(JsonNumberGuard)
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
# Every identified request is also a sign that the agent is still there,
# which keeps its status line alive (Q125 item 2, services/agent_status.py).
app.add_middleware(RequestHeadersContext, on_agent=lambda identity: _agent_sign(identity))
app.add_middleware(LocalRequestGuard)


_DESKTOP_RENDERER_ORIGINS = frozenset({"null", "file://"})
_DESKTOP_CORS_HEADERS = ", ".join((
    "Content-Type", "Authorization", "X-Nebula-Person", "X-Nebula-Workspace-Revision", "X-Nebula-Proposal-Key",
    "X-Nebula-Params-Version", "X-Nebula-Tab",
))


@app.middleware("http")
async def desktop_renderer_cors(request: Request, call_next):
    # The packaged Electron renderer is a file: page. Checked live in the
    # desktop pass (2026-10-13, Electron 44, GrantFileProtocolExtraPrivileges
    # on): its fetches carry no Origin header and send no preflight, and it
    # reads responses without Access-Control-Allow-Origin, so this branch
    # isn't reached from Nebula.app today. Its /ws handshake carries
    # "Origin: file://" (local_guard allows that). The branch stays for a
    # renderer that does send an opaque Origin ("null" or "file://", e.g. if
    # that fuse is turned off): in desktop mode, answer its preflights, and
    # let it read responses only for requests that carry this launch's person
    # token: a website can also send "Origin: null" (sandboxed iframe), but it
    # can't know the token.
    origin = request.headers.get("origin")
    desktop = (
        os.environ.get("NEBULA_DESKTOP_MODE") == "1"
        and origin in _DESKTOP_RENDERER_ORIGINS
        and host_allowed(request.headers.get("host"))
        and request.client is not None
        and request.client.host in {"127.0.0.1", "::1"}
    )
    if desktop and request.method == "OPTIONS":
        response = Response(status_code=204)
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = _DESKTOP_CORS_HEADERS
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        return response
    response = await call_next(request)
    if desktop and person_session.verify(request.headers.get(PERSON_HEADER)):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    return response


app.add_exception_handler(PersonGateError, person_gate_error)


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
# A bundle's graph.json may be as large as the bundle Load graph accepts (the
# frontend's GRAPH_BUNDLE_MAX_IMPORT_BYTES, 512 MiB of files + 16 MiB), the
# size a plain .nebula opens up to (Q121 a, Justin 2026-10-24: "Bundles work
# like plain files"). The save limit is the import's to check, not this one:
# a graph over 16 MiB opens as a new project with saving paused (Q118/Q120).
RESTORE_MAX_GRAPH_BYTES = 528 * 1024 * 1024
RESTORE_MAX_GRAPH_NODES = 10_000
RESTORE_MAX_GRAPH_EDGES = 50_000
RESTORE_MAX_GRAPH_DEPTH = 64
RESTORE_MAX_GRAPH_VALUES = 1_000_000
RESTORE_CONTENT_TYPE = "application/zip"


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
    """Return once-decoded NFC text and its browser-compatible identity: the
    one component rule (services/graph_file_links.py), which agents' link
    rewrite shares, refused here as the restore's 400."""
    try:
        return graph_file_links.decoded_portable_component(raw_part)
    except graph_file_links.PortablePathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
        if state is not None and state not in {"idle", "queued", "executing", "complete", "error", "skipped"}:
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
    ingress_nodes, ingress_edges, _warnings, _folded = _migrate_ingress(
        ingress_nodes, ingress_edges, reference_key="id")
    id_map = _stage_graph_nodes(
        candidate,
        ingress_nodes,
        reference_key="id",
        include_outputs=True,
        normalize_image_inputs=False,
    )
    _stage_graph_edges(candidate, ingress_edges, id_map, saved=True)
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
        # NaN, Infinity and numbers past float's range are refused here:
        # float(10**400) in the checks below would raise OverflowError.
        graph = loads_checked(text, object_pairs_hook=_reject_duplicate_json_keys)
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


def _output_file_time(url: str) -> float | None:
    path = _output_path_from_ref(url)
    try:
        return path.stat().st_mtime if path is not None and path.is_file() else None
    except OSError:
        return None


# Project cards pick their newest image by file time (services/project_cover.py).
project_cover.configure(url_for=_output_url_from_ref, time_for=_output_file_time)


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
    output_ports = node_ports(definition_id, params, definition, "outputPorts")
    # displayOutputs are values a node keeps only to show on its card (Image
    # Compare's two inputs). They are saved with the node but never wired.
    declared_ports = {
        str(port["id"]): str(port.get("dataType") or "Any")
        for port in [*output_ports, *(definition.get("displayOutputs", []) or [])]
        if isinstance(port, dict) and isinstance(port.get("id"), str)
    }
    handles_are_dynamic = (
        definition_id in _DYNAMIC_OUTPUT_DEFINITION_IDS and not declared_ports
        and universal_ports.stored_ports(definition_id, params) is None
    ) or (
        # A Replicate node configured before its file output was typed (every
        # file `image`): its run named the output by the returned file, as it
        # still does, so a saved `video`/`audio` output is its own.
        definition_id in _DYNAMIC_OUTPUT_DEFINITION_IDS
        and universal_ports.untyped_output_stamp(definition_id, params)
    )
    guessed = (universal_ports.declared_output(definition_id, params)
               if definition_id in _DYNAMIC_OUTPUT_DEFINITION_IDS else None)
    if guessed and guessed.get("typeUnconfirmed"):
        # The port was a guess (the model's data said nothing): its run keeps
        # a file of another type under that type's own port
        # (handlers/replicate_universal._fill_declared_port).
        for media, port_id in MEDIA_PORT_IDS.items():
            declared_ports.setdefault(port_id, media)
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


def _drop_outputs_off_ports(graph: CLIGraph, node_id: str, params: dict[str, Any]) -> None:
    """Before a universal node takes ``params`` (another model, or its model
    read again), drop each saved output its new ports don't take: one left on
    a port the node no longer declares fails every save of the project
    (_validate_imported_outputs). The run history keeps the old result."""
    node = graph.nodes.get(node_id)
    if not node or not isinstance(node.get("outputs"), dict) or not node["outputs"]:
        return
    definition_id = str(node.get("definitionId") or "")
    kept: dict[str, Any] = {}
    for handle, value in node["outputs"].items():
        try:
            _validate_imported_outputs(definition_id, {handle: value}, node_index=0, params=params)
        except ValueError:
            continue
        kept[handle] = value
    node["outputs"] = kept


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
        # Whole or not at all: a price may be measured from it (write_new_file).
        write_new_file(saved_path, data)
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
        # A canvas opened before a shutdown date and run after it still holds
        # the retired value; send the replacement (services/retired_nodes.py).
        params = migrate_params(node.definition_id, node.params)
        if node.definition_id == "image-input":
            params = _normalize_image_input_params(params)
        normalized.append(node if params == node.params else node.model_copy(update={"params": params}))
    return normalized


def _end_node_ids(nodes: list[GraphNode], edges: list[GraphEdge]) -> list[str]:
    """Nodes nothing else reads from: what a proposal should ask to run."""
    sources = {edge.source for edge in edges}
    return [node.id for node in nodes if node.id not in sources]


def _is_person_request() -> bool:
    """The person: no agent marker and this launch's person token (see
    services/person_gate.py). Not an agent, the CLI, curl, or a forged Origin."""
    return is_person(current_request_headers())


def _person_only_refusal(detail: str) -> HTTPException | PersonGateError:
    """The 403 for a request refused only because it isn't the person's (who
    bills a node, a run the person approved, the agents' spending limits the
    person isn't held to). One with an agent marker gets the plain refusal it
    always got, ``{detail}``. One without (a canvas tab with no person token,
    or a token from before Nebula restarted; also curl, or the CLI without
    NEBULA_AGENT_NAME) gets the person gate's ``code: person_required`` beside
    the same detail, as require_person answers: reconnecting fixes it, and
    the canvas reads the code, never the words (GM - Design, Q116 a: "Use it
    for every person-only refusal, not just Krea billing."). Nothing more is
    allowed either way: only the answer says why."""
    if has_agent_marker(current_request_headers()):
        return HTTPException(status_code=403, detail=detail)
    return PersonGateError(403, detail, PERSON_REQUIRED)


agent_spend_ledger = agent_spend.SpendLedger(_STATE_DIR / "agent-spend.json")
# Tokens the person made for outside apps (Settings > Agent spending), each
# also in its own private file (services/app_token_file.py).
app_token_store = app_tokens.AppTokens(_STATE_DIR / "app-tokens.json", token_dir=_STATE_DIR)
app_tokens.install(app_token_store)


def _spend_session(headers: Mapping[str, str] | None) -> tuple[str, str]:
    """Which running total a non-person request counts against: (key, label).

    A token Nebula minted for an in-app chat (Claude or Codex) names
    that chat's own budget, and a token the person made for an outside app
    names that app's line. Names and headers are set by the caller, so
    everything else (outside agents, scripts) shares one budget that doesn't
    change with a restart: a caller can't start a fresh budget by renaming
    itself or relaunching Nebula."""
    lower = {k.lower(): v for k, v in (headers or {}).items()}
    auth = lower.get("authorization", "")
    if auth.lower().startswith("agent "):
        token = auth[6:].strip()
        record = commons_actors.agent_registry.lookup(token)
        if record is not None and record.get("spend_key"):
            # A personal agent's session token names its budget outright
            # (outside:personal:<id>, services/agent_spend.py).
            identity = identify_agent(headers)
            return str(record["spend_key"]), str(record.get("display_name") or (identity.name if identity else "Agent"))
        if record is not None and record.get("session"):
            identity = identify_agent(headers)
            return f"chat:{record['session']}", identity.name if identity else "Agent"
        connected = app_tokens.lookup(token)
        if connected is not None:
            return f"{agent_spend.APP_PREFIX}{connected['id']}", connected["name"]
    return agent_spend.OUTSIDE_SHARED, agent_spend.OUTSIDE_LABEL


def _spend_budgets(key: str, settings: Mapping[str, Any]) -> list[agent_spend.Budget]:
    """The budgets a run counted against ``key`` is checked against."""
    caps = agent_spend.caps_from_settings(settings)
    spent = agent_spend_ledger.spent(key)
    if not agent_spend.is_outside(key):
        return agent_spend.session_budgets(key, spent, caps)
    connected = app_token_store.get(key[len(agent_spend.APP_PREFIX):]) if key.startswith(agent_spend.APP_PREFIX) else None
    return agent_spend.session_budgets(
        key, spent, caps, outside_spent=agent_spend_ledger.spent_outside(),
        app_name=connected["name"] if connected else None,
        app_daily_usd=connected["dailyUsd"] if connected else None)


@dataclass
class _SpendHold:
    """What an agent run was counted at, per node, so a node that turns out to
    have spent nothing can be given back (see _release_unspent_hold). ``at``
    is when it was counted: an outside budget's give-back lands then."""
    key: str
    per_node: dict[str, tuple[str, float]]
    plan_nodes: dict[str, tuple[str, int]]
    at: float | None

    def take(self, node_ids: Iterable[str] | None = None) -> tuple[dict[str, float], dict[str, int]]:
        """Remove these nodes' shares (all of them with None) and total them per model."""
        ids = list(self.per_node) + [i for i in self.plan_nodes if i not in self.per_node] if node_ids is None else list(node_ids)
        by_model: dict[str, float] = {}
        plan: dict[str, int] = {}
        for node_id in ids:
            share = self.per_node.pop(node_id, None)
            if share is not None:
                by_model[share[0]] = by_model.get(share[0], 0.0) + share[1]
            runs = self.plan_nodes.pop(node_id, None)
            if runs is not None:
                plan[runs[0]] = plan.get(runs[0], 0) + runs[1]
        return by_model, plan

    def give_back(self, by_model: Mapping[str, float], plan: Mapping[str, int]) -> None:
        if by_model or plan:
            agent_spend_ledger.refund(self.key, by_model, plan, at=self.at)


_spend_holds: OrderedDict[str, _SpendHold] = OrderedDict()
_MAX_SPEND_HOLDS = 500


def _release_unspent_hold(event: Any, run_id: str | None) -> None:
    """Give back a node's share of its run's count when it stopped at its own
    key check (no provider request, so nothing spent). Never fails the run."""
    try:
        if not (isinstance(event, ErrorEvent) and event.missing_credential and run_id):
            return
        hold = _spend_holds.get(run_id)
        if hold is None:
            return
        hold.give_back(*hold.take([event.node_id]))
    except Exception:  # noqa: BLE001 - bookkeeping must not break a run
        pass


def _return_hold(run_id: str) -> None:
    """Give back everything a run was counted at, for a request refused after
    the spend check but before the run started (it can't have cost anything)."""
    provider_calls.take(run_id)
    hold = _spend_holds.pop(run_id, None)
    if hold is None:
        return
    try:
        hold.give_back(*hold.take())
    except Exception:  # noqa: BLE001 - bookkeeping must not mask the refusal
        pass


def _settle_hold(run_id: str) -> None:
    """At the end of a run, give back the share of every counted node that
    never reached its handler (cache hit, upstream failure, stopped first):
    it made no provider request. Untracked runs keep their whole count."""
    hold = _spend_holds.pop(run_id, None)
    called = provider_calls.take(run_id)
    if hold is None or called is None:
        return
    unspent = [node_id for node_id in {**hold.per_node, **hold.plan_nodes} if node_id not in called]
    try:
        hold.give_back(*hold.take(unspent))
    except Exception:  # noqa: BLE001 - bookkeeping must not break a run
        pass


async def _require_run_spend_approval(
    run_id: str, nodes: list[GraphNode], edges: list[GraphEdge], *, approval_id: str | None = None,
    fence: tuple[str, str | None, int] | None = None, **kwargs: Any,
) -> None:
    """The approval and spend checks for a run already noted for its actor: a
    refusal forgets the note. The inputs a price reads are measured first,
    off the event loop (_measure_run_inputs); the approval is taken and the
    limits checked after that, with no await between them. ``fence``
    (_graph_fence, taken before the route's first await) is checked right
    after the measure, before the approval is used up or anything counts
    (round 11, as run_graph does)."""
    try:
        measured = await _measure_run_inputs(nodes, edges)
        if fence is not None:
            _refuse_if_graph_moved(fence)
        approval = _check_run_approval(approval_id, nodes, edges)
        _require_spend_approval(nodes, edges, run_id=run_id, measured=measured, **kwargs)
    except (HTTPException, PersonGateError):
        canvas_events.forget_run(run_id)
        raise
    if approval is not None:
        # The run an Accept approved: its run events name the proposal, so
        # its agent knows the run as its own (nebula-mcp --channel), and a
        # run the person starts by hand on the same nodes stays theirs.
        canvas_events.note_run_proposal(run_id, approval.proposal_id)


# What the person's Accept clicks approved, waiting for the canvas to run it.
# See services/run_approvals.py.
run_approvals = RunApprovals()


def _approval_shape(graph: CLIGraph, run_ids: list[str]) -> dict[str, list[Any]]:
    return approvals.shape(graph.nodes, graph.edges, approvals.run_scope(graph.edges, run_ids))


def _check_run_approval(approval_id: str | None, nodes: list[GraphNode], edges: list[GraphEdge]) -> Any:
    """A run that says it is the one the person approved on Accept must be
    exactly that run: the person's, the approved nodes and wires, and the
    live graph still holding the approved values. It uses the approval up,
    and returns it (None for a run that carries none)."""
    if approval_id is None:
        return None
    if not _is_person_request():
        raise _person_only_refusal(
            "Only the person's canvas starts a run they approved. Agents run through "
            "/api/graph/run, inside the spending limits.")
    approval = run_approvals.take(approval_id)
    if approval is None:
        raise HTTPException(status_code=409, detail=(
            "This approved run expired or was already started, so nothing ran. "
            "Look over the nodes, then click Run on them yourself."))
    requested_nodes = {node.id: {"definitionId": node.definition_id} for node in nodes}
    requested_edges = [
        {"source": edge.source, "sourceHandle": edge.source_handle,
         "target": edge.target, "targetHandle": edge.target_handle}
        for edge in edges
    ]
    requested = approvals.shape(requested_nodes, requested_edges, requested_nodes)
    live = approvals.fingerprint(cli_graph.nodes, cli_graph.edges, approval.run_node_ids)
    changed = set(approvals.changed_nodes(approval.fingerprint, live))
    changed.update(key for key in set(requested) | set(approval.shape) if requested.get(key) != approval.shape.get(key))
    if changed:
        names = sorted(changed, key=_node_order)
        raise HTTPException(status_code=409, detail=(
            f"{_listed(names, 4)} changed since you accepted {approval.agent_name}'s proposal, so nothing ran. "
            "Look over the nodes, then click Run on them yourself."))
    return approval


def _refuse_agent_change_to_approved_runs(candidate: CLIGraph) -> None:
    """409 when an edit that isn't the person's would change a run the person
    approved on Accept and the canvas hasn't started yet: params, deletes and
    wires into it all count. The person's own edits always pass."""
    waiting = run_approvals.open_list()
    if not waiting or _is_person_request():
        return
    for approval in waiting:
        now = approvals.fingerprint(candidate.nodes, candidate.edges, approval.run_node_ids)
        changed = sorted(approvals.changed_nodes(approval.fingerprint, now), key=_node_order)
        if changed:
            raise HTTPException(status_code=409, detail=(
                f"{_listed(changed, 4)} {'is' if len(changed) == 1 else 'are'} in a run the person approved "
                f"from {approval.agent_name}'s proposal {approval.proposal_id}, and it hasn't started yet. "
                "Leave it until that run starts, or propose the change instead."))


def _guard_approved_runs(change: Callable[[CLIGraph], Any]) -> None:
    """Try a direct edit on a copy of the graph, then apply the check above.

    A copy that refuses the edit means the real edit will refuse it in its
    own words. If it somehow didn't, the run itself still checks the live
    graph against what was approved (see _check_run_approval)."""
    if not run_approvals.open_list() or _is_person_request():
        return
    probe = cli_graph.clone()
    try:
        change(probe)
    except Exception:  # noqa: BLE001 - the real edit reports its own error
        return
    _refuse_agent_change_to_approved_runs(probe)


def _guard_agent_growth_past_save_limit(change: Callable[[CLIGraph], Any]) -> None:
    """_refuse_agent_growth_past_save_limit for a direct edit (the CLI's
    connect and rename), tried on a copy of the graph first. A copy that
    refuses the edit means the real edit reports its own error."""
    if _is_person_request():
        return
    probe = cli_graph.clone()
    try:
        change(probe)
    except Exception:  # noqa: BLE001 - the real edit reports its own error
        return
    _refuse_agent_growth_past_save_limit(probe)


async def _measure_run_inputs(nodes: list[GraphNode], edges: list[GraphEdge]) -> input_sizes.Measured | None:
    """The input sizes the spending check prices size-priced nodes at
    (services/input_sizes.py), measured in a worker thread: reading every
    packet of a clip takes seconds, and on the event loop it would hold up
    every other request. Each run route awaits this just before its
    synchronous check and passes the result to _require_spend_approval.

    None for the person's own runs, which the limits don't bind. A project
    switch while it measured makes the run refuse (409) rather than start
    against a different project than the one it was checked in."""
    if _is_person_request():
        return None
    try:
        pricing = model_pricing.load_pricing()
    except (OSError, ValueError):
        return input_sizes.Measured()  # the check itself refuses: the table is unavailable
    items = [{"id": n.id, "definitionId": n.definition_id, "params": n.params} for n in nodes]
    if not input_sizes.needs_measuring(items, pricing):
        return input_sizes.Measured()
    before = _workspace_context()["workspaceRevision"]
    measured = await input_sizes.measure_run(
        items, [(e.source, e.source_handle, e.target, e.target_handle) for e in edges], pricing,
        node_registry.get_all(), {n.id: n for n in nodes})
    _check_workspace_revision(before)
    return measured


def _require_spend_approval(
    nodes: list[GraphNode], edges: list[GraphEdge], *, settings: Mapping[str, Any],
    measured: input_sizes.Measured | None, how_to_ask: str | None = None,
    run_ids: list[str] | None = None, run_id: str | None = None, passes: int = 1, on_canvas: bool = True,
) -> None:
    """Refuse a run that isn't the person's when it breaks a spending limit, and
    count it against the caller's session when it doesn't.

    ``measured`` is what _measure_run_inputs found for these nodes, awaited
    by the caller (off the event loop), for prices read from an input's size.

    ``settings`` is the snapshot the caller read for this run: its ``apiKeys``
    are the ones the run receives, so the provider route priced here (a
    dual-route node, or which vision model QC calls) is the one it bills.
    Re-reading settings here could price a different route than the run uses.

    The person's own runs pass (the canvas asks them itself). Anything else
    is held to the limits in Settings; see services/agent_spend.py. It also
    can't bill a Krea node differently from the canvas (``on_canvas`` False:
    nodes that only exist for this run, like /api/quick's, which start on the
    API token): run routes take params in the request, so the billing-mode
    check on edits alone wouldn't hold."""
    headers = current_request_headers()
    if _is_person_request():
        return
    _refuse_agent_billing_in_run(nodes, on_canvas=on_canvas)
    ask = how_to_ask or agent_spend.propose_hint(run_ids or [])
    try:
        pricing = model_pricing.load_pricing()
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=503, detail=f"Can't check this run's cost (pricing table unavailable: {exc}). {ask}",
        ) from exc
    key, label = _spend_session(headers)
    items = [{"id": n.id, "definitionId": n.definition_id, "params": n.params} for n in nodes]
    run_nodes = {n.id: n for n in nodes}
    definitions = node_registry.get_all()
    # A price that depends on the input's size is checked at the size of the
    # file this run will send (services/input_sizes.py), measured before this
    # synchronous check by the caller (_measure_run_inputs).
    if measured is None:
        raise RuntimeError("_require_spend_approval needs the run's measured inputs (_measure_run_inputs)")
    decision = agent_spend.decide(
        items, [(e.source, e.target, e.target_handle) for e in edges],
        settings=settings, pricing=pricing, definitions=definitions,
        budgets=_spend_budgets(key, settings), how_to_ask=ask, passes=passes, sizes=measured.sizes,
        size_reasons=measured.reasons,
        # What is connected to a port with more than one input, by name, for the refusal to list.
        # Named from this run's own nodes (/api/execute and a shot price the
        # request's nodes, which needn't match the open canvas): _run_node_name.
        size_inputs={node_id: (port, [(_run_node_name(source, run_nodes), source, handle)
                                      for source, handle in sources])
                     for node_id, (port, sources) in measured.connected.items()},
    )
    if decision.refusal:
        raise _person_only_refusal(decision.refusal)
    at = agent_spend_ledger.record(key, label, decision.charge, decision.plan_charge)
    if run_id is not None and (decision.per_node or decision.plan_per_node):
        _place_hold(run_id, key, dict(decision.per_node), dict(decision.plan_per_node), at=at)


def _refuse_agent_billing_in_run(nodes: list[GraphNode], *, on_canvas: bool = True) -> None:
    """403 when a run that isn't the person's bills a node other than the
    way the canvas node it names does (_billing_choice: a route-table node's
    provider, a dual-mode Krea node's billing mode). A node that isn't on the
    canvas, or is there as another definition, starts on the defaults (Auto,
    the API token).

    It reads the params the run runs with: the engine migrates retired params
    before a node runs (execution/engine.py _with_current_params), and not
    every route normalizes its nodes first (Cinema shots, /api/quick), so a
    retired key (a Moodboard's ``_moodboardId``) can't name what the check
    didn't see."""
    changes = []
    for node in nodes:
        live = cli_graph.nodes.get(node.id) if on_canvas else None
        before = live.get("params") or {} if live and live.get("definitionId") == node.definition_id else None
        if before is not None:
            before = migrate_params(node.definition_id, before)
        after = migrate_params(node.definition_id, node.params)
        changes.append((node.id if on_canvas else node.definition_id, node.definition_id, before, after))
    _refuse_agent_billing_change(changes)


def _place_hold(run_id: str, key: str, per_node: dict[str, tuple[str, float]],
                plan_nodes: dict[str, tuple[str, int]] | None = None, *, at: float | None = None) -> None:
    """Remember what a run was counted at, per node, and start recording which
    nodes call their provider. A hold dropped to keep the table bounded takes
    its record with it, so that run keeps its whole count."""
    _spend_holds[run_id] = _SpendHold(key, per_node, dict(plan_nodes or {}), at)
    _spend_holds.move_to_end(run_id)
    while len(_spend_holds) > _MAX_SPEND_HOLDS:
        dropped, _ = _spend_holds.popitem(last=False)
        provider_calls.take(dropped)
    provider_calls.begin(run_id)


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
        if is_being_written(entry):
            # A run still writing here would go on writing into the moved
            # folder, where the spending check could measure a half-written
            # file (services/input_sizes.py); it is archived another time.
            continue
        dest = archive_root / entry.name
        if dest.exists():
            # Don't clobber an existing archive slot — append a uuid suffix.
            from uuid import uuid4
            dest = archive_root / f"{entry.name}-{uuid4().hex[:6]}"
        shutil.move(str(entry), str(dest))
        archived.append(entry.name)

    return {"archived": archived, "archive_dir": str(archive_root)}


def _restore_with_rewritten_links(zip_file: BinaryIO) -> dict[str, Any]:
    """The restore, then the link rewrite the canvas's Load graph does next
    (services/graph_file_links.py): the graph's local output links point at
    the restored files (or are null, with the canvas's warnings), and World
    and spatial outputs are checked."""
    restored = _restore_zip_bundle(zip_file)
    graph = restored["graph"]
    try:
        mapping = graph_file_links.validated_restore_mapping(restored["urlMapping"])
    except graph_file_links.GraphFileLinkError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    warnings = graph_file_links.rewrite_asset_urls(graph["nodes"], mapping)
    warnings += graph_file_links.sanitize_imported_spatial_outputs(graph["nodes"])
    return {**restored, "warnings": warnings}


@app.post("/api/outputs/restore")
async def restore_outputs(request: Request, rewriteLinks: bool = False) -> dict:
    """Bound, validate, and restore a complete .nebula.zip atomically.

    The browser does not inflate graph.json. This endpoint returns the parsed
    graph with the old-path → served-URL mapping only after both graph
    validation and asset extraction succeed.

    ``?rewriteLinks=true`` (agents: graph_file_client.py, Q123 a) also
    rewrites the graph's links to the restored files as the canvas does
    after this answer, and adds the canvas's ``warnings``: a graph ready for
    POST /api/graph/import. The person's tab doesn't ask for it.
    """
    _reject_graph_replacement_during_paid_start("restore a graph bundle")
    _validate_restore_request_headers(request)
    spool = await _spool_restore_request(request)
    try:
        return await asyncio.to_thread(_restore_with_rewritten_links if rewriteLinks else _restore_zip_bundle, spool)
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


# ISO base media brands that mean sound only (an .m4a/.m4b), not a clip.
_AUDIO_FTYP_BRANDS = {b"M4A ", b"M4B "}


def _iso_sound_only(data: bytes) -> bool:
    """Whether an ISO base media file (ftyp) holds sound tracks and no video
    track, read from its tracks' handler boxes: size(4) 'hdlr' version and
    flags(4) pre_defined(4) handler_type(4), 'soun' or 'vide'. The brand
    alone doesn't say: ffmpeg's `-f mp4`, Android recorders and many
    exporters write an audio-only file as isom/mp42. Needs the whole file,
    since the moov box sits at the end of one that isn't faststart."""
    handlers: set[bytes] = set()
    index = data.find(b"hdlr")
    while index != -1 and index + 16 <= len(data):
        handlers.add(bytes(data[index + 12:index + 16]))
        index = data.find(b"hdlr", index + 4)
    return b"soun" in handlers and b"vide" not in handlers


def _sniff_audio_type(data: bytes) -> tuple[str, str] | None:
    """Return (mime, ext) if *data* starts like a supported audio file, else None.

    Checked by signature, like images, clips and PDFs: WAV (RIFF....WAVE),
    MP3 (an ID3 tag, or an MPEG audio frame sync), AAC (ADTS frame sync),
    M4A (ftyp with an M4A/M4B brand, or any ftyp file whose tracks are all
    sound: pass the whole file for that), FLAC (fLaC) and Ogg (OggS: Vorbis or
    Opus). These are what the Audio Input's consumers read (speech to text,
    lip sync, audio-driven video). Run after the image sniff, so a JPEG
    (FF D8) never reads as a frame sync.
    """
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return ("audio/wav", ".wav")
    if data[:3] == b"ID3":
        return ("audio/mpeg", ".mp3")
    if len(data) >= 12 and data[4:8] == b"ftyp" and (
        data[8:12] in _AUDIO_FTYP_BRANDS or _iso_sound_only(data)
    ):
        return ("audio/mp4", ".m4a")
    if data[:4] == b"fLaC":
        return ("audio/flac", ".flac")
    if data[:4] == b"OggS":
        return ("audio/ogg", ".ogg")
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        # The frame sync. ADTS (AAC) has a 12-bit sync and layer bits 00;
        # MPEG audio's layer 00 and version 01 are reserved, so no real MP3
        # starts that way.
        layer, version = data[1] & 0x06, data[1] & 0x18
        if (data[1] & 0xF6) == 0xF0:
            return ("audio/aac", ".aac")
        if layer != 0 and version != 0x08:
            return ("audio/mpeg", ".mp3")
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
async def _catalog_restore_loop_startup() -> None:
    """The loop a catalog restore made in a worker thread is told on
    (_on_catalog_restore)."""
    global _main_loop
    _main_loop = asyncio.get_running_loop()


@app.on_event("startup")
async def _person_startup() -> None:
    """Set this launch's person token before serving (services/person_session.py),
    then read the desktop's provider keys and Krea vault key from the next
    stdin line (services/launch_secrets.py)."""
    person_session.initialize()
    from services import launch_secrets
    launch_secrets.initialize()


@app.on_event("startup")
async def _parent_watch_startup() -> None:
    """Desktop sidecar: exit if Electron dies without stopping us (services/parent_watch.py)."""
    from services import parent_watch
    parent_watch.start_from_env()


# This launch's backend-url secret, set once the file is written. Clients
# check the address with it before sending a token (backend_address_proof).
_backend_address_secret: str | None = None


@app.on_event("startup")
async def _publish_backend_address() -> None:
    """Desktop mode: write this launch's address where outside MCP clients look
    for it (services/backend_address.py). The sidecar's port changes every launch."""
    global _backend_address_secret
    url = os.environ.get("NEBULA_URL", "")
    if not backend_address.launch_assigned() or not url:
        return
    secret = backend_address.new_secret()
    try:
        backend_address.publish(_STATE_DIR, url, secret)
    except (OSError, ValueError) as exc:
        print(f"[main] couldn't publish the backend address for outside agents: {exc}", flush=True)
        return
    _backend_address_secret = secret


@app.on_event("shutdown")
async def _withdraw_backend_address() -> None:
    if _backend_address_secret:
        backend_address.withdraw(_STATE_DIR, _backend_address_secret)


@app.get(backend_address.PROOF_PATH)
async def backend_address_proof(challenge: str = "") -> dict[str, str]:
    """Answer a client that read the backend-url file and wants to know this is
    the backend that wrote it before sending its token. Only this launch knows
    the secret, so a program squatting on a dead launch's port can't answer."""
    if _backend_address_secret is None:
        raise HTTPException(status_code=404, detail="This Nebula publishes no backend-url file.")
    try:
        return {"proof": backend_address.prove(_backend_address_secret, challenge)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.on_event("startup")
async def _personal_agents_startup() -> None:
    """Delete token files a dead backend left behind (services/agent_token_file.py).
    Their tokens died with it; this only removes litter. Also delete app
    token files whose app is no longer active (services/app_token_file.py):
    revoked while the delete failed, say."""
    from services import agent_token_file
    await asyncio.to_thread(agent_token_file.clear_stale, _STATE_DIR)
    await asyncio.to_thread(app_token_store.clear_unknown_files)


@app.on_event("shutdown")
async def _personal_agents_shutdown() -> None:
    """Kill every personal agent's process tree and revoke its token."""
    await acp_sessions.shutdown()


@app.on_event("startup")
async def _moodboard_brief_fields_startup() -> None:
    """Give boards saved before Direction / Avoid / pinned colours existed those
    fields, once, backing each file up first (services/moodboard_brief.py).
    Then save the colour check (gap 18) on boards whose saved one is missing
    or stale, so it isn't run again on every generation and read."""
    from services.moodboard_store import migrate_brief_fields, save_colour_checks
    try:
        await asyncio.to_thread(migrate_brief_fields)
    except Exception as exc:  # never block startup; boards still migrate in memory on read
        print(f"[main] moodboard brief migration skipped: {type(exc).__name__}: {exc}", flush=True)
    try:
        await asyncio.to_thread(save_colour_checks)
    except Exception as exc:  # never block startup; the check runs in memory until a board is saved
        print(f"[main] moodboard colour check not saved: {type(exc).__name__}: {exc}", flush=True)


@app.on_event("startup")
async def _asset_project_rehome_startup() -> None:
    """Every start: move project Characters, Moodboards and Styles saved under
    an old-style project id (not a canvas project) into canvas projects or
    Global, backing each file up first (services/asset_project_rehome.py).
    Silent when there's nothing to move. After the brief-fields migration, so
    both see the same files."""
    from services.asset_project_rehome import rehome_legacy_assets

    if os.environ.get("NEBULA_NO_ASSET_REHOME") == "1":  # the test suite (tests/conftest.py)
        return

    def read_catalog() -> dict[str, Any] | None:
        return project_store.read() if project_store.path.exists() else None

    try:
        report = await asyncio.to_thread(
            rehome_legacy_assets, read_catalog, _STATE_DIR, live_nodes=list(cli_graph.nodes.values()))
    except Exception as exc:  # never block startup; it runs again next start
        print(f"[main] project asset re-home skipped: {type(exc).__name__}: {exc}", flush=True)
        return
    if report["status"] == "nothing to do":
        return
    if report["moved"] or report["skipped"] or report["status"] != "done":
        logs = ", ".join(report["logs"]) or "none"
        print(f"[main] project asset re-home ({report['status']}): {report['moved']} moved "
              f"({report['global']} to Global), {report['skipped']} skipped; logs: {logs}", flush=True)


@app.on_event("startup")
async def _commons_startup() -> None:
    """Scan linked folders. Human authority is the person session, set above."""
    from commons.activation import is_enabled
    if not is_enabled():
        return
    if os.environ.get("NEBULA_COMMONS_NO_STARTUP_SCAN") == "1":
        return
    from commons import folders as commons_folders, records as commons_records, review as commons_review, runtime as commons_runtime

    store = commons_runtime.get_store()
    await asyncio.to_thread(commons_records.requeue_stale_analyzing, store)
    await asyncio.to_thread(commons_review.fail_interrupted, store)
    for link in store.list_folder_links():
        commons_runtime.spawn(commons_folders.scan_and_fetch(store, link["id"],
                                                             downloader=commons_runtime.get_downloader()))


def _upload_position(x: str | None, y: str | None) -> dict[str, float] | None:
    """The spot /api/uploads puts a created node at: both of `x` and `y` as
    finite numbers, or neither (None: today's placement). Anything else is
    a 422 before a byte is stored."""
    if x is None and y is None:
        return None
    if x is None or y is None:
        raise HTTPException(status_code=422, detail="Send both x and y for where the node goes, or neither")
    try:
        spot = {"x": float(x), "y": float(y)}
    except ValueError:
        raise HTTPException(status_code=422, detail="x and y must be numbers") from None
    if not all(math.isfinite(value) for value in spot.values()):
        raise HTTPException(status_code=422, detail="x and y must be finite numbers")
    return spot


def _is_upload_node(definition_id: Any, params: Any, node_type: str, file_name: str) -> bool:
    """A node holding the file an upload just stored (by its content-hash name)."""
    if definition_id != node_type or not isinstance(params, dict):
        return False
    return any(isinstance(params.get(key), str) and Path(params[key]).name == file_name
               for key in ("filePath", "_previewUrl", "file"))


def _roll_back_upload_node(project_id: str | None, epoch: int, node_id: str, node_type: str,
                           file_name: str) -> bool:
    """Take back the node an upload added to ``project_id`` when its sync
    failed. Node ids restart per project, so the id alone says nothing once
    another project opened during the sync (review 8 of PR #114: the
    rollback removed the other project's n1). Still open: from the live
    graph, as before. Closed since: from its stored snapshot, where the
    switch saved it with the node. Either way only while the project's ids
    are the ones the upload saw (no clear or import since: its undo epoch)
    and the id still holds this upload's node; otherwise nothing is
    touched. True when it came off the live graph: the caller syncs the
    open canvas, which may have been sent it (a switch away and back
    during the sync reopened the project with the node in it)."""
    if canvas_undo_book.epoch(project_id) != epoch:
        return False
    if _open_project_id() == project_id:
        node = cli_graph.nodes.get(node_id)
        if node is not None and _is_upload_node(node.get("definitionId"), node.get("params"), node_type, file_name):
            cli_graph.remove_node(node_id)
            return True
        return False
    if project_id is None:
        return False
    with project_store.transaction() as catalog:
        project = catalog["projects"].get(project_id)
        if project is None or catalog["activeProjectId"] == project_id:
            return False  # deleted since, or opened again in between (the live branch above reads it)
        snapshot = project["snapshot"]
        node = next((item for item in snapshot.get("nodes") or [] if item.get("id") == node_id), None)
        data = node.get("data") if isinstance(node, dict) else None
        if not isinstance(data, dict) or not _is_upload_node(data.get("definitionId"), data.get("params"),
                                                              node_type, file_name):
            return False
        edges = [edge for edge in snapshot.get("edges") or []
                 if edge.get("source") == node_id or edge.get("target") == node_id]
        gone_edges = {edge.get("id") for edge in edges}
        project["snapshot"] = {**snapshot,
                               "nodes": [item for item in snapshot["nodes"] if item.get("id") != node_id],
                               "edges": [edge for edge in snapshot.get("edges") or [] if edge not in edges]}
        project["_backendNodeIds"] = [item for item in project.get("_backendNodeIds") or [] if item != node_id]
        project["_backendEdgeIds"] = [item for item in project.get("_backendEdgeIds") or []
                                      if item not in gone_edges]
        refresh_metadata(project)
        project_store.commit(catalog)
    return False


@app.post("/api/uploads")
async def upload_file_consolidated(
    file: UploadFile,
    create_node: str = Form("false"),
    x: str | None = Form(None),
    y: str | None = Form(None),
) -> dict:
    """Accept an image, video, audio or document upload with strict validation
    and content-hash dedup.

    Routes by magic bytes: PNG/JPEG/GIF/WebP → image-input node; WAV/MP3/AAC/
    M4A/FLAC/Ogg → audio-input node; MP4/MOV/WebM → video-input node (with
    ffprobe-derived private source metadata stored on the node's params so
    the editor surface can read source metadata without waiting for the edit
    handler to run); PDF or a text file → document-input node.

    When `create_node` is truthy, atomically creates the routed node in
    cli_graph and broadcasts graphSync. When absent or falsy, returns only
    the upload metadata so callers can handle node creation themselves (or
    use the URL for an existing node). `x` and `y` (both or neither, finite
    flow coordinates) put the created node there: the canvas sends the drop
    point, an agent its own spot. Without them the node goes right of the
    rightmost node, as before. The export keeps a stored position
    (_display_positions), so the spot is where the canvas draws it.

    Probe failure on a video that passed the magic-byte sniff deletes the
    just-written file (unless it pre-existed via content-hash dedup) and
    returns 415. A graphSync broadcast failure after node creation rolls the
    node back out of cli_graph and returns 500. Pre-write rejections (oversize,
    unsupported bytes, too small) never touch disk, graph, or the broadcast.

    Supersedes the deprecated /api/upload and /api/chat/uploads endpoints;
    both shapes of caller can migrate to this one.
    """
    requested_position = _upload_position(x, y)
    wants_node = create_node.strip().lower() in ("true", "1", "yes")
    # Only an upload that adds a node reads which canvas is open (a plain
    # upload still works with the project catalog unreadable).
    fence = _graph_fence() if wants_node else None
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
    # A text name wins over a bare audio guess: a .txt saved as UTF-16 starts
    # FF FE (an MPEG frame sync) and one can start "ID3"; both stay documents.
    is_text_name = Path(file.filename or "").suffix.lower() in _DOC_TEXT_EXTS
    audio_sniffed = (_sniff_audio_type(content)
                     if image_sniffed is None and not is_text_name else None)
    video_sniffed = (_sniff_video_type(content[:16])
                     if image_sniffed is None and audio_sniffed is None else None)

    if image_sniffed is not None:
        if len(content) > MAX_CHAT_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Image exceeds 20 MB limit")
        _, ext = image_sniffed
        node_type = "image-input"
    elif audio_sniffed is not None:
        # Sound shares the clip cap (MAX_VIDEO_UPLOAD_BYTES, checked above):
        # an hour of WAV is far past the 20 MB image cap.
        _, ext = audio_sniffed
        node_type = "audio-input"
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
        raise HTTPException(status_code=415, detail="Nebula takes images, video, audio, PDFs and text files.")

    digest = hashlib.sha256(content).hexdigest()
    saved_path = require_allowed_path(CHAT_UPLOADS_DIR / f"{digest}{ext}")
    # Track whether THIS request created the file: content-hash dedup means the
    # file may already exist from an earlier upload, in which case a later
    # failure must NOT delete it (other nodes/requests may reference it).
    file_created = False
    if not saved_path.exists():
        # Dedup by content hash: identical bytes collapse to one file on disk.
        # It appears whole under its served name, never half-written, so a
        # price measured from it (services/input_sizes.py) is of the whole
        # file; a concurrent upload of the same bytes finds it there.
        file_created = write_new_file(saved_path, content)

    url = f"/api/outputs/chat-uploads/{saved_path.name}"
    filename = file.filename or f"{digest}{ext}"

    # Base response — present for every caller.
    response: dict[str, Any] = {
        "url": url,
        "filePath": str(saved_path.resolve()),
        "filename": filename,
        # The input node it routes to (upload_client: `nebula upload`, MCP upload_file).
        "nodeType": node_type,
    }

    # Opt-in node creation: parse create_node laxly so any reasonable truthy
    # string works (supports callers composing forms in different tools).
    if wants_node and fence is not None:
        if requested_position is not None:
            new_position = requested_position
        else:
            positions = [n.get("position", {}) for n in cli_graph.nodes.values()]
            max_x = max((p.get("x", 0) for p in positions), default=-300)
            new_position = {"x": float(max_x) + 300.0, "y": 100.0}

        if node_type in ("image-input", "audio-input", "document-input"):
            # filePath is the absolute local path (handlers open() this; the
            # engine's audio-input branch reads it), _previewUrl is the served
            # URL. Only Image Input draws the preview; the shape matches the
            # Inspector's own upload for each of them.
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

        # The name it was sent with, for the card (the stored name is a hash).
        kept_name = file_name_param(node_params["filePath"], file.filename)
        if kept_name is not None:
            node_params[INPUT_FILE_NAME_PARAM] = kept_name
        # The file stays stored either way (content-addressed), but the node
        # goes only to the canvas it was dropped on (review 9 of PR #114).
        _refuse_if_graph_moved(fence)
        node_id = cli_graph.add_node(node_type, node_params, position=new_position)
        # The event as the write made it, and the project it went to: it is
        # published only once the sync went out (a failed one rolls the node
        # back), which may be after a switch (round 8 of PR #114).
        added_event = _node_added_event(node_id)
        written_to = _open_project_id()
        written_epoch = canvas_undo_book.epoch(written_to)
        try:
            await _broadcast_graph_sync(edit=True)
        except Exception as exc:
            # Roll back the graph mutation so a failed broadcast doesn't leave
            # a node the frontend never heard about. Removal is best-effort —
            # even if it errors, the caller still gets an error response with
            # no success fields. The uploaded file stays on disk (it is a
            # valid, content-addressed artifact, same as a create_node=false
            # upload); only the graph mutation is rolled back, in the project
            # it was made in, never in one opened during the sync (review 8).
            try:
                live = _roll_back_upload_node(written_to, written_epoch, node_id, node_type, saved_path.name)
            except Exception:
                live = False
            if live:
                # The stored project too, at once: a switch away and back
                # during the sync saved the node into it, and a crash before
                # the next save would bring it back (round 10).
                try:
                    await _save_live_project(written_to)
                except Exception:
                    pass
                # Canvas = backend: the sync any server-side removal sends
                # (round 10). Best-effort, like the rollback: the socket that
                # failed may fail again, and the 500 below still stands.
                try:
                    await _broadcast_graph_sync()
                except Exception:
                    pass
            raise HTTPException(
                status_code=500,
                detail=f"Upload succeeded but graph sync failed: {exc}",
            ) from exc
        # The same record /api/graph/node keeps: the history, `nebula watch`
        # and the chat's action line credit the node to whoever uploaded it
        # (an agent's `nebula upload` / upload_file, or the person's drop).
        publish_action(f"Added {node_type} ({node_id})")
        _journal("node.added", project_id=written_to, **added_event)
        await _show_agent({"nodeId": node_id}, say=f"Added {_quoted(_node_label(node_id))}", did=_did("Added", node_id))
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

def _websocket_has_agent_marker(websocket: WebSocket) -> bool:
    try:
        return has_agent_marker(websocket.headers)
    except Exception:  # noqa: BLE001 - a malformed handshake is never the person
        return True


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []
        self.browser_connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)

    def promote(self, websocket: WebSocket, person_token: object) -> bool:
        """Mark a socket as the person's canvas after a valid hello frame.

        The hello carries this launch's person token; a handshake with an agent
        marker never qualifies. Only these sockets get proposal accept keys."""
        if _websocket_has_agent_marker(websocket) or not person_session.verify(person_token):
            return False
        if websocket in self.active_connections:
            self.browser_connections.add(websocket)
        return True

    def is_browser(self, websocket: WebSocket) -> bool:
        return websocket in self.browser_connections

    def canvas_open(self) -> bool:
        """Whether a canvas is connected: any socket without an agent marker.

        Not only the person's verified canvas: a tab opened without the person
        link still draws the graph and lays out an arrange (services/canvas_arrange.py)."""
        return bool(self.browser_connections) or any(
            not _websocket_has_agent_marker(connection) for connection in self.active_connections)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        self.browser_connections.discard(websocket)

    async def broadcast(self, event: ExecutionEvent) -> None:
        data = _event_to_camel(event)
        data.update(_filed_context(_execution_workspace_context.get()) or _workspace_context())
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

    async def broadcast_others(self, data: dict[str, Any]) -> None:
        """Send to every socket that isn't the person's canvas (CLI/MCP listeners)."""
        message = json.dumps(data)
        disconnected: list[WebSocket] = []
        for connection in [c for c in self.active_connections if c not in self.browser_connections]:
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
                **(_filed_context(_execution_workspace_context.get()) or _workspace_context()),
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
                    # The card's line (error copy round 3e); None: GM's general line.
                    "person": e.get("person"),
                }
                for e in value
            ]
    return result


def _validation_response(errors: list[ValidationErrorDetail]) -> dict[str, Any]:
    """Keep REST validation details aligned with the WebSocket event shape.

    The canvas's own run calls (/api/execute, a node's run, a shot): each
    error's `message` is the specific text and `person` the card's line
    (error copy round 3e). Agents' runs answer with _refused_cli_run, which
    keeps `message` alone."""
    return {
        "status": "validation_error",
        "errorCount": len(errors),
        "errors": [
            {
                "nodeId": error.node_id,
                "portId": error.port_id,
                "message": error.message,
                "person": error.person,
            }
            for error in errors
        ],
    }


def _validation_person_lines(errors: list[ValidationErrorDetail]) -> dict[str, str | None]:
    """Node id -> the card's line for its pre-call errors (joined_lines:
    None when one of them has none)."""
    from execution.person_line import joined_lines

    by_node: dict[str, list[str | None]] = {}
    for error in errors:
        by_node.setdefault(error.node_id, []).append(error.person)
    return {node_id: joined_lines(lines) for node_id, lines in by_node.items()}


def _validation_messages(errors: list[ValidationErrorDetail]) -> dict[str, str]:
    """Node id -> its pre-call errors joined in order ('' for graph-wide ones)."""
    by_node: dict[str, list[str]] = {}
    for error in errors:
        messages = by_node.setdefault(error.node_id, [])
        if error.message not in messages:
            messages.append(error.message)
    return {node_id: "; ".join(messages) for node_id, messages in by_node.items()}


async def _announce_validation_errors(errors: list[ValidationErrorDetail], run_id: str) -> None:
    """Every run path's pre-call refusal, told the same way.

    Each node it names shows the message on its card (validationError, which
    a canvas applies to another tab's or an agent's run too), agents read it
    (node_errors: look_at_canvas, view_output), and the journal says which
    nodes failed and for whom (run.failed). So an agent's refused run_nodes
    looks on the canvas like the person's refused click on Run.
    """
    node_errors.record_validation(errors)
    # Journaled before the broadcast's await (round 8 of PR #114).
    for node_id, message in _validation_messages(errors).items():
        if node_id:
            _journal_execution_event(ErrorEvent(node_id=node_id, error=message, run_id=run_id), run_id)
    canvas_events.forget_run(run_id)
    await manager.broadcast(ValidationErrorEvent(errors=errors, run_id=run_id))


# ---------- WebSocket endpoint ----------

def _proposal_sync_message() -> dict[str, Any]:
    return {
        "type": "proposalSync",
        "proposals": [
            {**_proposal_view(p), "acceptKey": p.accept_key,
             "personValues": canvas_proposals.person_values(p)}
            for p in canvas_proposals.open_list()
        ],
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Canvas events. Every socket gets the graph, pins and broadcasts (the CLI
    and MCP listen here too). Proposal accept keys go only to a socket that
    sent {type: "hello", personToken} with this launch's person token."""
    await manager.connect(websocket)
    try:
        # Events emitted while a browser is disconnected are not replayed.
        # Reconnect therefore starts with an authoritative graph, provider
        # safety journal, and retained execution-status snapshot.
        export = await export_graph_for_frontend()
        # bootId: which backend process this is (round 15 of PR #114). A tab
        # holding a create whose answer was lost releases it only when the
        # backend restarted (a new bootId); after a mere reconnect the create
        # may still land, and a later sync shows it.
        await websocket.send_text(json.dumps({"type": "graphSync", **export, "bootId": BACKEND_BOOT_ID}))
        await websocket.send_text(json.dumps(_pins_message()))
        await _settle_proposal_updates()
        await websocket.send_text(json.dumps(_canvas_notes_message()))
        while True:
            raw = await websocket.receive_text()
            if manager.is_browser(websocket):
                continue
            try:
                # ValueError, not only JSONDecodeError: an int past 4,300
                # digits (or NaN, 1e400) raised out of this loop and ended it.
                frame = loads_checked(raw)
            except (ValueError, RecursionError):
                continue
            if not isinstance(frame, dict) or frame.get("type") != "hello":
                continue
            if manager.promote(websocket, frame.get("personToken")):
                # Accept keys travel only to the person's canvas sockets.
                await websocket.send_text(json.dumps(_proposal_sync_message()))
                await websocket.send_text(json.dumps(await _asset_proposal_sync_message()))
                # Open question sets with their answer keys (Q125 item 1), same rule.
                await _send_questions_sync(websocket)
            else:
                await websocket.send_text(json.dumps({
                    "type": "personRequired",
                    "message": "This tab isn't connected as you, so it can't accept or reject proposals.",
                }))
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
        personToken: str (this launch's person token, required on every send;
            the old name commonsToken is still read),
        brand: str|null (Commons-enabled Claude/Codex turns),
        model: str|null,
        effort: str|null (model-specific effort, Claude/Codex),
        agent: "claude" | "codex" (default "claude"),
        autonomy: accepted for old clients and ignored by both runners
    }
    Server sends events matching AGENT_RUNNERS' event contract.
    """
    from services.chat_session import AGENT_RUNNERS
    from services.chat_actions import register_action_handler, unregister_action_handler
    from services.chat_models import ChatModelSelectionError, validate_chat_model_selection

    await websocket.accept()
    chat_marked_as_agent = _websocket_has_agent_marker(websocket)
    server_host, server_port = websocket.scope.get("server") or ("127.0.0.1", 8000)
    backend_url = f"http://{server_host}:{server_port}"
    current_task: asyncio.Task[None] | None = None
    current_agent: str | None = None
    current_finished: asyncio.Event | None = None
    send_lock = asyncio.Lock()
    # Who owns this socket's personal agent sessions (services/acp_session.py):
    # only this connection may answer their permission cards or close them.
    connection_id = uuid4().hex

    async def send_event(event: dict[str, Any]) -> None:
        """Serialize every chat WebSocket write, including cancellation acks."""
        async with send_lock:
            await websocket.send_text(json.dumps(event))

    def _event_source(agent: str) -> str:
        if agent.startswith("personal:"):
            return "personal"
        return agent if agent in {"claude", "codex"} else "system"

    async def personal_turn(agent: str, session_id: str | None, message: str, selection: str,
                            enqueue: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        """One turn on the person's own agent over ACP. The session (process,
        token, workspace) outlives the turn; acp_sessions owns it."""
        agent_id = agent.split(":", 1)[1]
        ended = {"type": "error", "code": "personal_session_ended",
                 "message": "This chat's agent has stopped. Send again to start a new conversation."}
        if session_id:
            host = acp_sessions.get(session_id, connection_id)
            if host is None or host.agent_id != agent_id:
                why = acp_sessions.ended_message(session_id, connection_id) if host is None else None
                enqueue({**ended, "message": why} if why else ended)
                return {"type": "done"}
        else:
            try:
                host = await acp_sessions.open(
                    connection_id, agent_id, state_dir=_STATE_DIR, output_root=OUTPUT_ROOT,
                    backend_url=backend_url, workspace_sessions=workspace_sessions)
            except PersonalSessionError as exc:
                enqueue({"type": "error", "code": exc.code, "message": exc.message})
                return {"type": "done"}
            enqueue({"type": "session", "sessionId": host.id, "agentName": host.display_name, "color": host.color,
                     "agentInfo": {"name": str(host.agent_info.get("name") or "")[:64],
                                   "version": str(host.agent_info.get("version") or "")[:32]},
                     # The models (and thinking levels) the person may pick
                     # for this session, and whether its prompts take images.
                     "options": host.option_view(), "promptImages": host.prompt_images})
        # Reused or just started, Settings must still allow it before it gets
        # a prompt: switched off, removed or changed since it started.
        if host.closed or not acp_sessions.still_allowed(host, _STATE_DIR):
            await acp_sessions.close_stale(_STATE_DIR)
            enqueue({**ended, "message": host.ended_message()})
            return {"type": "done"}
        try:
            with workspace_scope(host.workdir):
                agen = host.prompt(message, selection)
                async with aclosing(agen):
                    async for event in agen:
                        task = asyncio.current_task()
                        if task is not None and task.cancelling():
                            raise asyncio.CancelledError
                        enqueue(event)
        except PersonalSessionError as exc:
            enqueue({"type": "error", "code": exc.code, "message": exc.message})
        return {"type": "done"}

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
            if agent.startswith("personal:"):
                terminal_done = await personal_turn(agent, session_id, message, turn_selection_context, enqueue)
                return
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
                # Every in-app agent runs from a private workspace with a minted
                # turn token: it names the chat's own spending budget and is how
                # its Nebula MCP server proves which chat it belongs to.
                if agent in {"claude", "codex"}:
                    workspace_session = workspace_sessions.acquire(_STATE_DIR, agent, brand, session_id)
                    workdir = workspace_session.workspace
                    read_grants = agent_read_grants(output_root=OUTPUT_ROOT, workdir=workdir,
                                                    protected=protected_agent_dirs())
                    agent_token = commons_actors.agent_registry.mint(
                        agent, [OUTPUT_ROOT, workdir], brand=workspace_session.brand, workspace=workdir,
                        session=workspace_session.id)
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
                payload = loads_checked(raw)
            except JsonNumberOutOfRange as exc:
                await send_event({"type": "error", "message": str(exc), "source": "system"})
                continue
            except (ValueError, RecursionError):
                # ValueError, not only JSONDecodeError: an int past 4,300
                # digits raised out of this loop and ended the socket.
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
            if msg_type in {"permission", "close_session", "personal_option"}:
                # The person's answers to a personal agent: they carry the
                # person token, and only this socket's own sessions count.
                if chat_marked_as_agent or not person_session.verify(payload.get("personToken")):
                    await send_event({"type": "error", "code": "person_required", "message": (
                        "Only the person can answer or close a personal agent, from a Nebula canvas connected as them."
                    ), "source": "system"})
                    continue
                if msg_type == "permission":
                    for host in acp_sessions.live():
                        if host.owner == connection_id:
                            host.resolve_permission(payload.get("requestId"), payload.get("decision"), connection_id)
                    continue
                if msg_type == "personal_option":
                    # The person picked a model (or thinking level) for this session.
                    target = acp_sessions.get(payload.get("sessionId"), connection_id)
                    if target is None:
                        await send_event({"type": "error", "code": "personal_session_ended", "message": (
                            "This chat's agent has stopped. Send again to start a new conversation."),
                            "source": "personal"})
                        continue
                    try:
                        options = await target.set_option(payload.get("configId"), payload.get("value"))
                    except PersonalSessionError as exc:
                        await send_event({"type": "personal_options", "sessionId": target.id,
                                          "options": target.option_view(), "error": exc.message,
                                          "source": "personal"})
                        continue
                    await send_event({"type": "personal_options", "sessionId": target.id, "options": options,
                                      "source": "personal"})
                    continue
                target = acp_sessions.get(payload.get("sessionId"), connection_id)
                if target is not None and current_task is not None and not current_task.done() \
                        and (current_agent or "").startswith("personal:"):
                    current_task.cancel()
                    try:
                        await current_task
                    except (asyncio.CancelledError, Exception):
                        pass
                    current_task = None
                    current_agent = None
                closed = await acp_sessions.close(payload.get("sessionId"), connection_id, "closed_by_person")
                await send_event({"type": "session_closed", "sessionId": payload.get("sessionId") if closed else None,
                                  "source": "personal"})
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

            # Only the person starts chats: every send carries this launch's
            # person token (commonsToken is the old name), checked before any
            # workspace or agent token exists. Without it, an agent could
            # start turns of its own, each with a fresh chat budget.
            human_token = payload.get("personToken")
            if human_token is None:
                human_token = payload.get("commonsToken")
            if chat_marked_as_agent or not person_session.verify(human_token):
                await send_event({"type": "error", "code": "person_required", "message": (
                    "Only the person can start a chat, from a Nebula canvas connected as them. Open the "
                    "link the backend printed at launch (backend/devserver.py, or restart it with --open)."
                ), "source": "system"})
                await send_event({"type": "done", "source": "system"})
                continue
            from commons.activation import is_enabled
            commons_enabled = is_enabled()
            user_message = payload.get("message", "")
            if not isinstance(user_message, str):
                await send_event({"type": "error", "message": "message must be text.", "source": "system"})
                continue
            session_id = payload.get("sessionId") or None
            agent_raw = payload.get("agent")
            agent = "claude" if agent_raw is None else agent_raw
            if isinstance(agent, str) and agent.startswith("personal:") \
                    and not personal_agents.ID_RE.fullmatch(agent.split(":", 1)[1]):
                agent = ""
            if not isinstance(agent, str) or not agent.strip():
                await send_event({"type": "error", "code": "agent_invalid", "message": "agent must be text and a nonempty agent identifier.", "source": "system"})
                await send_event({"type": "done", "source": "system"})
                continue
            if commons_enabled and agent not in {"claude", "codex"}:
                if agent.startswith("personal:"):
                    # Commons keeps personal agents off; stop any this socket still has.
                    await acp_sessions.close_owned(connection_id, "commons_enabled")
                await send_event({"type": "error", "message": "Commons private reference turns support Claude and Codex.", "source": "system"})
                await send_event({"type": "done", "source": "system"})
                continue
            model_raw = payload.get("model")
            autonomy = payload.get("autonomy") or "auto"
            # No in-app agent takes a provider override (Claude and Codex use
            # their own CLI's provider); any `provider` field is refused below.
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
            if provider_raw is not None:
                await send_event({"type": "error", "code": "provider_invalid", "message": "Claude and Codex use their local official CLI provider; provider overrides aren't available.", "source": _event_source(agent)})
                await send_event({"type": "done", "source": _event_source(agent)})
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
        # A personal agent dies with the chat socket that started it: its
        # process tree is killed and its token revoked.
        await acp_sessions.close_owned(connection_id, "disconnected")


# ---------- Personal agents (person-only) ----------

def _personal_agent_http_error(exc: personal_agents.PersonalAgentError) -> HTTPException:
    status = {"not_found": 404, "conflict": 409}.get(exc.code, 400)
    if status == 404:  # GM's 404 pattern (error-copy round 3); these routes are the person's only
        return refusal_copy.not_found(exc.message, "agent", "agents")
    return HTTPException(status_code=status, detail=exc.message)


@app.get("/api/personal-agents")
async def list_personal_agents() -> dict[str, Any]:
    """Settings > Personal agents and the chat picker. The person's only."""
    require_person(current_request_headers())
    views = await asyncio.to_thread(personal_agents.list_agents, _STATE_DIR)
    return {"warningAcknowledged": personal_agents.warning_acknowledged(_STATE_DIR),
            "agents": [view.as_dict() for view in views]}


@app.post("/api/personal-agents")
async def create_personal_agent(body: dict[str, Any]) -> dict[str, Any]:
    """Add a custom ACP agent (an absolute path or a bare command, plus args)."""
    require_person(current_request_headers())
    try:
        view = await asyncio.to_thread(personal_agents.create_custom, _STATE_DIR, body)
    except personal_agents.PersonalAgentError as exc:
        raise _personal_agent_http_error(exc) from exc
    return {"agent": view.as_dict()}


@app.put("/api/personal-agents/{agent_id}")
async def update_personal_agent(agent_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Switch an agent on or off, rename or recolor it (custom: also its command)."""
    require_person(current_request_headers())
    if not personal_agents.ID_RE.fullmatch(agent_id):
        raise refusal_copy.not_found("No agent with that id", "agent", "agents")
    try:
        view = await asyncio.to_thread(personal_agents.update_agent, _STATE_DIR, agent_id, body)
    except personal_agents.PersonalAgentError as exc:
        raise _personal_agent_http_error(exc) from exc
    # Switching an agent off (or changing a custom agent's command) stops its
    # running sessions now: process tree killed, token revoked.
    await acp_sessions.close_stale(_STATE_DIR)
    return {"agent": view.as_dict()}


@app.delete("/api/personal-agents/{agent_id}")
async def delete_personal_agent(agent_id: str) -> dict[str, Any]:
    """Remove a custom agent. Built-in ones can only be switched off."""
    require_person(current_request_headers())
    try:
        removed = personal_agents.delete_custom(_STATE_DIR, agent_id)
    except personal_agents.PersonalAgentError as exc:
        raise _personal_agent_http_error(exc) from exc
    if not removed:
        raise refusal_copy.not_found("No custom agent with that id", "agent", "agents")
    await acp_sessions.close_stale(_STATE_DIR)
    return {"ok": True}


def _antigravity_signed_in(value: bool) -> None:
    personal_agents.set_signed_in(_STATE_DIR, antigravity_agent.AGENT_ID, value)


def _antigravity_view() -> dict[str, Any]:
    view = personal_agents.get_agent(_STATE_DIR, antigravity_agent.AGENT_ID)
    assert view is not None
    return {"agent": view.as_dict()}


def _antigravity_http_error(exc: antigravity_agent.AntigravityError) -> HTTPException:
    return HTTPException(status_code=409 if exc.code in {"not_installed", "unsupported"} else 400, detail=exc.message)


@app.post("/api/personal-agents/antigravity/install")
async def install_antigravity() -> dict[str, Any]:
    """Download Google's Antigravity ACP server, pinned and SHA-256 checked
    (services/antigravity_agent.py). Runs in the background; GET shows progress."""
    require_person(current_request_headers())
    try:
        antigravity_agent.start_install(_STATE_DIR)
    except antigravity_agent.AntigravityError as exc:
        raise _antigravity_http_error(exc) from exc
    return await asyncio.to_thread(_antigravity_view)


@app.delete("/api/personal-agents/antigravity/install")
async def remove_antigravity() -> dict[str, Any]:
    """Stop a download in progress, or delete the downloaded server."""
    require_person(current_request_headers())
    if not await antigravity_agent.cancel(_STATE_DIR, "install"):
        await antigravity_agent.cancel(_STATE_DIR, "sign_in")
        await asyncio.to_thread(antigravity_agent.remove, _STATE_DIR)
    await acp_sessions.close_stale(_STATE_DIR)
    return await asyncio.to_thread(_antigravity_view)


@app.post("/api/personal-agents/antigravity/sign-in")
async def sign_in_antigravity() -> dict[str, Any]:
    """The person asked to sign in with Google. Google's server opens the
    browser and keeps the login in the Keychain; Nebula never sees it."""
    require_person(current_request_headers())
    try:
        antigravity_agent.start_sign_in(_STATE_DIR, _antigravity_signed_in)
    except antigravity_agent.AntigravityError as exc:
        raise _antigravity_http_error(exc) from exc
    return await asyncio.to_thread(_antigravity_view)


@app.delete("/api/personal-agents/antigravity/sign-in")
async def cancel_antigravity_sign_in() -> dict[str, Any]:
    require_person(current_request_headers())
    await antigravity_agent.cancel(_STATE_DIR, "sign_in")
    return await asyncio.to_thread(_antigravity_view)


@app.post("/api/personal-agents/antigravity/sign-out")
async def sign_out_antigravity() -> dict[str, Any]:
    """Stop using the Google login at once (running sessions stop), then ask
    Google's server to delete it."""
    require_person(current_request_headers())
    try:
        message = await antigravity_agent.sign_out(_STATE_DIR, _antigravity_signed_in)
    except antigravity_agent.AntigravityError as exc:
        message = exc.message
    finally:
        await acp_sessions.close_stale(_STATE_DIR)
    return {**(await asyncio.to_thread(_antigravity_view)), "message": message}


@app.post("/api/personal-agents/acknowledge-warning")
async def acknowledge_personal_agent_warning() -> dict[str, Any]:
    """The person read the notice (what Nebula can and can't limit)."""
    require_person(current_request_headers())
    return {"warningAcknowledgedAt": personal_agents.acknowledge_warning(_STATE_DIR)}


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

@app.get("/api/agent/spend")
async def agent_spend_status(request: Request) -> dict[str, Any]:
    """The spending limits and what the calling agent's session has used, so an
    agent can plan before it runs anything. The person's canvas isn't limited."""
    settings = load_settings()
    caps = agent_spend.caps_from_settings(settings)
    limits = {"perRunUsd": agent_spend.threshold_from_settings(settings), **caps}
    if _is_person_request():
        return {"limited": False, "limits": limits}
    key, label = _spend_session(request.headers)

    def view(spent: agent_spend.Spent) -> dict[str, Any]:
        return {"totalUsd": round(spent.total, 4), "models": spent.models, "kreaPlanRuns": spent.plan_runs}

    # "chat": this in-app chat's own budget. "shared": the one budget every
    # agent without a Nebula chat or app token shares, over the last 24 hours.
    # "app": an outside app's own line, which also counts inside "shared".
    budget = "chat" if not agent_spend.is_outside(key) else "app" if key.startswith(agent_spend.APP_PREFIX) else "shared"
    result: dict[str, Any] = {"limited": True, "agent": label, "budget": budget, "limits": limits,
                              "spent": view(agent_spend_ledger.spent(key))}
    if budget != "chat":
        result["window"] = "24h"
        result["outsideSpent"] = view(agent_spend_ledger.spent_outside())
    if budget == "app":
        connected = app_token_store.get(key[len(agent_spend.APP_PREFIX):])
        result["limits"] = {**limits, "appDailyUsd": connected["dailyUsd"] if connected else None}
        # What `nebula mcp connect` writes into the client's config.
        result["mcpAddress"] = _mcp_address(request)
    return result


def _outside_view() -> dict[str, Any]:
    """The outside agents' last 24 hours and each connected app's share, for Settings."""
    outside = agent_spend_ledger.spent_outside()
    apps = []
    for connected in app_token_store.list():
        spent = agent_spend_ledger.spent(f"{agent_spend.APP_PREFIX}{connected['id']}")
        apps.append({**connected, "spentUsd": round(spent.total, 4), "kreaPlanRuns": spent.plan_runs})
    personal = []
    for agent_id, name in personal_agents.known_names(_STATE_DIR):
        spent = agent_spend_ledger.spent(f"{agent_spend.PERSONAL_AGENT_PREFIX}{agent_id}")
        personal.append({"id": agent_id, "name": name, "spentUsd": round(spent.total, 4), "kreaPlanRuns": spent.plan_runs})
    return {"outside": {"spentUsd": round(outside.total, 4), "kreaPlanRuns": outside.plan_runs}, "apps": apps,
            "personal": personal}


@app.get("/api/agent/spend/apps")
async def list_agent_apps() -> dict[str, Any]:
    """Settings > Agent spending: what the outside agents spent and the apps with tokens. The person's only."""
    require_person(current_request_headers())
    return {**_outside_view(), "connect": _connect_view()}


def _connect_view() -> dict[str, Any]:
    """The clients Settings > Connect your agent offers, and whether this
    backend can point them at a checkout (a packaged app can't yet)."""
    try:
        agent_connect.checkout_paths()
        reason = None
    except agent_connect.ConnectError as exc:
        reason = str(exc)
    return {"clients": agent_connect.client_list(), "available": reason is None, "reason": reason}


def _mcp_address(request: Request) -> dict[str, str]:
    """How an outside MCP client reaches this backend from now on: the
    backend-url file when the port changes per launch (desktop), else this
    backend's own address."""
    if backend_address.launch_assigned():
        return {"urlFile": str(backend_address.url_file(_STATE_DIR))}
    return {"url": _own_url(request)}


def _own_url(request: Request) -> str:
    """This backend as an MCP server on this machine reaches it: the address
    the request actually arrived on (not a Host header, which the Vite proxy
    or the caller writes)."""
    server = request.scope.get("server") or ("127.0.0.1", 8000)
    host, port = server[0] or "127.0.0.1", server[1]
    if host in ("0.0.0.0", "::", "localhost"):
        host = "127.0.0.1"
    if ":" in host:
        host = f"[{host}]"
    return f"http://{host}:{port}" if port else f"http://{host}"


@app.post("/api/agent/spend/apps")
async def create_agent_app(body: dict[str, Any], request: Request) -> dict[str, Any]:
    """Make a token for an outside app. The person's only.

    Nebula keeps a hash of it and writes the token to a private file
    (services/app_token_file.py); ``tokenFile`` is that file's path. The token
    itself is in this response too, for scripts that call this route; Settings
    doesn't show it unless the person asks.

    With ``client`` (Settings > Connect your agent), the response also holds
    ``setup``: the exact config for that client (services/agent_connect.py),
    which names the token file and never holds the token."""
    require_person(current_request_headers())
    client_id = body.get("client")
    paths = None
    if client_id is not None:
        try:
            agent_connect.client(client_id)
            paths = agent_connect.checkout_paths()
        except agent_connect.ConnectError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        app_view, token = app_token_store.create(body.get("name"), body.get("dailyUsd"),
                                                 client=client_id, color=body.get("color"))
    except app_tokens.AppTokenError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token_file = app_token_store.token_file(app_view["id"])
    result: dict[str, Any] = {"app": {**app_view, "spentUsd": 0.0, "kreaPlanRuns": 0}, "token": token,
                              "tokenFile": str(token_file) if token_file else None}
    if paths is not None and token_file is not None:
        address = _mcp_address(request)
        result["setup"] = agent_connect.render(client_id, paths=paths, url=address.get("url"),
                                               url_file=address.get("urlFile"), token_file=str(token_file),
                                               app_name=app_view["name"], daily_usd=app_view["dailyUsd"])
    return result


@app.put("/api/agent/spend/apps/{app_id}")
async def update_agent_app(app_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Change an app's daily limit (null: only the shared outside budget)
    and/or its cursor color (#RRGGBB, null for the default). The person's only."""
    require_person(current_request_headers())
    if not body or not set(body) <= {"dailyUsd", "color"}:
        raise HTTPException(status_code=400,
                            detail="Send {dailyUsd} (a positive number of USD, or null) and/or {color} (#RRGGBB or null)")
    try:
        app_view = None
        if app_tokens.valid_id(app_id):
            # Check both before saving either, so a bad color doesn't half-apply.
            if "color" in body:
                app_tokens.clean_color(body["color"])
            if "dailyUsd" in body:
                app_view = app_token_store.set_limit(app_id, body["dailyUsd"])
            if "color" in body and (app_view is not None or "dailyUsd" not in body):
                app_view = app_token_store.set_color(app_id, body["color"])
    except app_tokens.AppTokenError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if app_view is None:
        raise refusal_copy.not_found("No connected app with that id", "app", "apps")
    return {"app": app_view}


@app.delete("/api/agent/spend/apps/{app_id}")
async def revoke_agent_app(app_id: str) -> dict[str, Any]:
    """Revoke an app's token: its requests are refused from now on, and its
    token file is deleted. What it spent stays counted in the outside budget.
    The person's only."""
    require_person(current_request_headers())
    if not (app_tokens.valid_id(app_id) and app_token_store.revoke(app_id)):
        raise refusal_copy.not_found("No connected app with that id", "app", "apps")
    return {"status": "revoked"}


def _short(text: Any, limit: int = 140) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _cinema_price_note() -> str:
    via = node_readiness.provider_via(node_registry.get(model_pricing.CINEMA_SCENE) or {}) or {}
    try:
        priced = model_pricing.load_pricing().get("nodes") or {}
    except (OSError, ValueError):
        priced = {}
    unpriced = sorted(base for base in via.get("models") or [] if base not in priced)
    note = (f"Calls its base model (scene.base.model, default {via.get('default')}) once per shot, and is "
            "priced and limited as that model: shots x its list price.")
    if unpriced:
        note += f" {', '.join(unpriced)} have no list price, so agent runs with them must be proposed (propose_change)."
    return note


def _keyed_mode_hint(definition: Mapping[str, Any]) -> str | None:
    """find_nodes' short form of a param-picked provider call (vision-llm or
    Jev QC): which keys each paid value needs, and whether it has a list price."""
    via = node_readiness.provider_via(definition)
    if not via or via.get("kind") != "param":
        return None
    free = set(via.get("freeWhen") or [])
    paid = [option.get("value") for param in definition.get("params") or [] if param.get("key") == via.get("param")
            for option in param.get("options") or [] if isinstance(option, dict) and option.get("value") not in free]
    try:
        entry = (model_pricing.load_pricing().get("nodes") or {}).get(definition.get("id"))
    except (OSError, ValueError):
        entry = None
    groups: dict[tuple[str, bool], list[str]] = {}
    for value in paid:
        keys, _ = node_readiness.param_route(via, value)
        priced = model_pricing.estimate_node(entry, definition, {via.get("param"): value}) is not None
        groups.setdefault((" or ".join(keys), priced), []).append(str(value))
    return "; ".join(f"{via.get('param')}={'/'.join(values)} needs {keys} and "
                     f"{'is priced per run (describe_node)' if priced else 'has no list price'}"
                     for (keys, priced), values in groups.items())


def _agent_node_context() -> dict[str, Any]:
    """What find_nodes and the start call read once per request: settings, keys, Krea sign-in, prices."""
    settings = load_settings()
    try:
        krea_signed_in = _krea_connector().status().get("status") == "connected"
    except Exception:  # noqa: BLE001 - an unreadable Krea vault just means not signed in
        krea_signed_in = False
    try:
        pricing = model_pricing.load_pricing().get("nodes") or {}
    except (OSError, ValueError):
        pricing = {}
    return {"settings": settings, "keys": node_readiness.configured_keys(settings), "krea": krea_signed_in,
            "pricing": pricing, "definitions": node_registry.get_all()}


# find_nodes' and `nebula context`'s price for a node priced from its input's size.
SIZED_PRICE = "by input size"


def _agent_node_row(definition: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any]:
    """One node type as find_nodes lists it: whether it runs here (and if not,
    what's missing) and its list price at default settings."""
    settings = context["settings"]
    definitions = context["definitions"]
    name = str(definition.get("displayName") or definition["id"])
    access = node_readiness.node_access(definition, context["keys"], context["krea"], definitions)
    row: dict[str, Any] = {
        "id": definition["id"], "name": name, "category": definition.get("category"),
        "runsWith": access,
    }
    if definition.get("description"):
        row["description"] = _short(definition["description"])
    if access is None:
        row["missing"] = node_readiness.missing(definition, context["krea"], definitions)
    hint = _keyed_mode_hint(definition)
    if hint:
        row["needsKeyFor"] = hint  # free at its defaults; describe_node has the detail
    if node_route.has_routes(definition):
        # Each provider route it can run on, in Auto order (describe_node has each one).
        row["providers"] = [str(route["id"]) for route in node_route.routes_of(definition)]
    if definition["id"] == model_pricing.CINEMA_SCENE:
        row["price"] = None  # its base model's price, once per shot (describe_node)
    elif model_pricing.is_local(definition):
        row["price"] = "free"
    elif definition.get("apiProvider") == "utility":
        row["price"] = None
    else:
        provider = (model_pricing.route_price_key(
                        definition, node_route.select_route(definition, {}, settings.get("apiKeys") or {}))
                    if node_route.has_routes(definition)
                    else model_pricing.route_provider(definition, settings.get("apiKeys") or {}))
        entry = context["pricing"].get(definition["id"])
        estimate = model_pricing.estimate_node(entry, definition, {}, provider)
        row["price"] = ([round(estimate["low"], 4), round(estimate["high"], 4)]
                        if estimate and estimate.get("currency") == "usd" else None)
        note = model_pricing.size_note(model_pricing.entry_for_route(entry, provider), definition)
        if row["price"] is None and note:
            # Priced at run time from the input file (model_pricing sizing).
            row["price"] = SIZED_PRICE
            row["priceNote"] = note
    return row


# GET /api/agent/nodes' largest `limit`: above the catalog (308 node types,
# 2026-10-21), so `nebula nodes --all` gets every one in one call.
AGENT_NODES_MAX = 2000


@app.get("/api/agent/nodes")
async def agent_find_nodes(query: str = "", category: str = "", ready_only: bool = True, limit: int = 20) -> dict[str, Any]:
    """Node types an agent can use, best matches first: whether each can run
    here (and if not, what's missing) and its list price at default settings.

    Every word of `query` must appear in the id, name or description.
    `category` is a category id (image-gen) or its short name (image),
    services/node_categories.py. `limit` goes up to AGENT_NODES_MAX: MCP's
    find_nodes asks for at most 100 rows, `nebula nodes` for every match."""
    context = _agent_node_context()
    words = [word for word in query.lower().split() if word]
    limit = max(1, min(int(limit), AGENT_NODES_MAX))
    definitions = context["definitions"]
    wanted = (node_categories.resolve(category, {str(d.get("category")) for d in definitions.values()}) or category
              if category else "")
    rows: list[tuple[tuple[int, int, str], dict[str, Any]]] = []
    for definition in definitions.values():
        if wanted and definition.get("category") != wanted:
            continue
        name = str(definition.get("displayName") or definition["id"])
        haystack = f"{definition['id']} {name} {definition.get('description') or ''}".lower()
        if any(word not in haystack for word in words):
            continue
        if ready_only and node_readiness.node_access(definition, context["keys"], context["krea"], definitions) is None:
            continue
        row = _agent_node_row(definition, context)
        if isinstance(row["price"], list):
            row["price"] = {"usd": row["price"]}
        # Ready first; then exact id, id prefix, name hits; then by name.
        idq = " ".join(words)
        rank = 0 if definition["id"] == idq else 1 if idq and definition["id"].startswith(idq) else \
            2 if idq and idq in name.lower() else 3
        rows.append(((0 if row["runsWith"] else 1, rank, name.lower()), row))
    rows.sort(key=lambda pair: pair[0])
    return {"total": len(rows), "nodes": [row for _, row in rows[:limit]],
            "krea": "signed in" if context["krea"] else "not signed in"}


PROVIDER_CHOICE_NOTE = (
    "Runs on one provider route: _provider names it (a route id), or auto takes the first route "
    "whose key is set, in this order. A run never moves to another route by itself: when the "
    "chosen route can't take a setting, or its key isn't set, the run stops and says which "
    "routes could. Each route's params list what that provider offers, as the card shows it "
    "there: a setting it doesn't offer is absent (`hides` names it) or has `onlyWhen`. That "
    "route never receives it, and a saved non-default value of it stops the run when another "
    "route would use it. The fix that lets it run where it is comes as `fixes` ([{param, value}], "
    "null = clear: ordinary param edits) on a propose_change cost entry; a run error or the estimate "
    "says the same fix in its message. Which route runs decides whose key pays, so it's the "
    "person's call: propose a _provider change with propose_change; direct edits of _provider "
    "are refused."
)


def _describe_routes(
    definition: Mapping[str, Any], api_keys: Mapping[str, Any],
    shown: Callable[[str], list[dict[str, Any]]],
) -> dict[str, Any]:
    """describe_node's fields for a route-table node (services/node_route.py
    routes): the provider choice at defaults, which route Auto resolves to
    here, and each route with its keys, the params it takes as it offers
    them (node_route.route_param_definitions), any block at the defaults and
    its list price.

    A route's ``params`` are exactly what the card shows on that provider:
    a setting it never offers (its ``paramVisibleWhen`` false) is absent,
    and one it offers only under some values carries them as ``onlyWhen``,
    merged with the param's own condition. ``hides`` says the same in the
    card's words (node_route.route_hides). docs/MODEL_REFERENCE.md's
    per-provider tables and directRoute.ts routeParamDefinitions list the
    same (tests/test_route_agent_surfaces.py checks all three agree)."""
    route = node_route.select_route(definition, {}, api_keys)
    try:
        pricing = model_pricing.load_pricing()
    except (OSError, ValueError):
        pricing = {"nodes": {}}
    prices = model_pricing.estimate_routes(definition, {}, (), pricing)
    rows = []
    for spec in node_route.routes_of(definition):
        estimate = prices.get(str(spec["id"]))
        row: dict[str, Any] = {
            "id": spec["id"], "provider": spec.get("provider"),
            "name": node_route.provider_label(spec.get("provider")),
            "keys": list(spec.get("keys") or []),
            "keySet": any(api_keys.get(key) for key in spec.get("keys") or []),
            # What this route takes: the shared params and its own, each as
            # it offers them (enums cut, ranges narrowed), the list the
            # Inspector shows on this provider.
            "params": [_brief_param(dict(param))
                       for param in node_route.route_param_definitions(definition, str(spec["id"]))
                       if not str(param.get("key", "")).startswith("_") and not param.get("hidden")],
            "block": node_route.block_dict(node_route.route_block(definition, spec, {})),
            "price": ({"usd": [round(estimate["low"], 4), round(estimate["high"], 4)]}
                      if estimate and estimate.get("currency") == "usd" else None),
        }
        sized = model_pricing.size_note(model_pricing.entry_for_route(
            (pricing.get("nodes") or {}).get(str(definition.get("id") or "")), str(spec.get("pricing") or spec["id"])),
            definition)
        if row["price"] is None and sized:
            row["priceBy"] = sized
        if row["price"] and model_pricing.route_price_unconfirmed(
                (pricing.get("nodes") or {}).get(str(definition.get("id") or "")), definition, str(spec["id"])):
            row["priceUnconfirmed"] = True
        if spec.get("maker"):
            row["maker"] = True
        if spec.get("plan"):
            row["plan"] = spec["plan"]
        if spec.get("note"):
            row["note"] = spec["note"]
        hides = node_route.route_hides(definition, str(spec["id"]))
        if hides:
            # What this provider doesn't offer, in the card's words ("no Seed").
            row["hides"] = hides
        rows.append(row)
    return {
        "providerChoice": {
            "param": node_route.PROVIDER_PARAM, "value": node_route.AUTO,
            "resolved": route.route_id if route.kind != node_route.UNSET else None,
        },
        "routes": rows,
        "providerNote": PROVIDER_CHOICE_NOTE,
    }


def _brief_param(param: dict[str, Any]) -> dict[str, Any]:
    brief: dict[str, Any] = {"key": param["key"], "type": param.get("type")}
    if param.get("type") in ASSET_PARAM_TYPES:
        # An asset reference: its value is an id this route lists.
        brief["idsFrom"] = ASSET_PARAM_TYPES[str(param["type"])]["list"]
    for field in ("default", "min", "max", "required"):
        # `is False`, not `in (None, False)`: 0 == False, and a 0 minimum or
        # default is real (Safety 0-4 would otherwise read as "up to 4").
        if param.get(field) is not None and param.get(field) is not False:
            brief[field] = param[field]
    option_rows = [option for option in param.get("options") or [] if isinstance(option, dict)]
    options = [option.get("value") for option in option_rows]
    if options:
        brief["options"] = options[:40] + (["…"] if len(options) > 40 else [])
    # An option the card shows only for some values of another param, e.g.
    # claude-chat effort "xhigh": {"model": [...]} (not Opus 4.6 / Sonnet 4.6).
    limited = {str(option.get("value")): option["visibleWhen"] for option in option_rows[:40]
               if option.get("visibleWhen")}
    if limited:
        brief["optionsOnlyWhen"] = limited
    if param.get("visibleWhen"):
        brief["onlyWhen"] = param["visibleWhen"]
    if param.get("defaultBy"):
        # e.g. {"model": {"claude-opus-5-5": 64000}}: the default for those values.
        brief["defaultBy"] = param["defaultBy"]
    return brief


_CHAT_MODEL_PORTS = (
    "These ports follow the node's `model`: `messages` always; `images` (Image, several connections) when the model "
    "takes images; `text` when it writes text and `image` (Image) when it makes images. Set `model` with "
    "edit_canvas and the node gets that model's ports (the edit's `modelPorts` lists them; look_at_canvas shows "
    "a node's `ports`). Nebula reads the model list with the person's key, which costs nothing; without it the "
    "edit says so and the node keeps the ports above.")
_MODEL_PORTS_NOTES = {
    "openrouter-universal": _CHAT_MODEL_PORTS,
    "nous-portal-universal": _CHAT_MODEL_PORTS,
    "replicate-universal": (
        "No ports until `model_id` (owner/name) is set. Set it with edit_canvas and the node gets the model's "
        "version and defaults, a port for each file input (named as the model names it) and one output: for a "
        "file or a list of them, typed from the model's data (its schema's content hints, else its "
        "`default_example` run's file) as `video`, `audio`, `image`, `svg` or `mesh` (`image` with "
        "`typeUnconfirmed` when nothing says; a run then keeps a file of another type under that type's own port), "
        "else `text`; a run fills that port. A node whose ports were saved before outputs were typed shows its file "
        "output as `typeUnconfirmed` with a note: set its model_id again. The model's other inputs are params of "
        "the same name. The edit's `modelPorts` lists the ports; look_at_canvas shows a node's `ports`. Nebula "
        "reads the schema with the person's Replicate token, which costs nothing; without it the edit says so."),
}


# `{...:path}`: a display name may hold a slash ("Jev Decide (judge / classify / yes-no)").
@app.get("/api/agent/nodes/{definition_id:path}")
async def agent_describe_node(definition_id: str) -> dict[str, Any]:
    """One node type, in what an agent needs to wire and set it: ports, params
    (options, defaults, ranges), whether it can run here, and its list prices.
    Takes an id, or the exact display name of one node type (ignoring case
    and outer spaces); a name answer starts with `lookup`, saying the id."""
    found = node_lookup.resolve(definition_id, node_registry.get_all())
    if found.definition_id is None:
        if len(found.named) > 1:
            line = node_lookup.shared_name_line(definition_id, found.named, node_registry.get_all())
            raise HTTPException(status_code=404, detail=f"No node type '{definition_id}': {line}: "
                                f"{', '.join(found.named)}. Use one of those ids.")
        hint = ", ".join(_suggest_node_ids(definition_id, node_registry.get_all()))
        raise HTTPException(status_code=404, detail=f"No node type '{definition_id}'." + (
            f" Close matches: {hint}." if hint else " find_nodes lists them."))
    definition_id = found.definition_id
    definition = node_registry.get(definition_id)
    settings = load_settings()
    try:
        krea_signed_in = _krea_connector().status().get("status") == "connected"
    except Exception:  # noqa: BLE001
        krea_signed_in = False
    keys = node_readiness.configured_keys(settings)
    definitions = node_registry.get_all()
    access = node_readiness.node_access(definition, keys, krea_signed_in, definitions)
    ports = lambda key: [  # noqa: E731
        {"id": port["id"], "type": port.get("dataType"), **({"required": True} if port.get("required") else {}),
         **({"multiple": True} if port.get("multiple") else {}),
         # A gate output: on some runs it's withheld, and nodes wired to it are skipped.
         **({"gate": True} if port.get("conditional") else {})}
        for port in definition.get(key) or []
    ]
    result: dict[str, Any] = {
        # A name, not the id, picked it: say which id (first, so it's read first).
        **({"lookup": found.note} if found.note else {}),
        "id": definition["id"],
        "name": definition.get("displayName") or definition["id"],
        "category": definition.get("category"),
        "runsWith": access,
        "inputs": ports("inputPorts"),
        "outputs": ports("outputPorts"),
    }
    if definition.get("description"):
        result["description"] = definition["description"]
    if definition_id in _MODEL_PORTS_NOTES:
        # Its ports come from its model (services/universal_ports.py).
        result["modelPorts"] = _MODEL_PORTS_NOTES[definition_id]
    shown = lambda key: [_brief_param(param) for param in definition.get(key) or []  # noqa: E731
                         if not str(param.get("key", "")).startswith("_") and not param.get("hidden")]
    # A dual-route node lists its shared params here and each route's own
    # below (a generated Krea copy keeps its full Krea list in `params` too).
    result["params"] = shown("sharedParams") if "sharedParams" in definition else shown("params")
    fallback = None if node_route.has_routes(definition) else node_route.fallback_provider(definition)
    if node_route.has_routes(definition):
        result.update(_describe_routes(definition, settings.get("apiKeys") or {}, shown))
    if fallback:
        # Which route a run takes here at defaults (services/node_route.py):
        # "direct" (the maker's API with your key), the fallback copy ("fal",
        # "krea", or "runway" for the ElevenLabs models Runway resells), or
        # None when none of its keys are set. A node whose
        # _kreaAuth is "mcp" bills the Krea plan whatever keys are set.
        route = node_route.select_route(definition, {}, settings.get("apiKeys") or {})
        result["route"] = ("direct" if route.kind == node_route.DIRECT
                           else fallback if route.kind == node_route.FALLBACK else None)
        result["routeProvider"] = route.provider if result["route"] else None
        result["fallback"] = fallback
        result["paramsDirect"] = shown("directParams")
        result["paramsFallback"] = shown("falParams")
        size_note = maker_sizes.rule_note(definition)
        if size_note:
            # A maker that takes a fixed size list (Ideogram 3, Ideogram 2a,
            # Runway Gen-4 Image): width/height round on its route; Seedance
            # 2.5 on BytePlus keeps a start image's shape.
            result["sizeNote"] = size_note
    if access is None:
        result["missing"] = node_readiness.missing(definition, krea_signed_in, definitions)
    board = _moodboard_adapter(definition, settings)
    if board is not None:
        result["moodboardAdapter"] = board
    options = node_readiness.detail(definition, keys, krea_signed_in, definitions)
    if options:
        result["runsWithOptions"] = options
    modes = node_readiness.krea_modes(definition)
    if modes:
        result["kreaModes"] = modes
        if len(modes) > 1:
            result["kreaNote"] = ("Billing mode is the person's choice, and new nodes start on the API token. "
                                  'To bill the signed-in Krea plan instead, propose {"_kreaAuth": "mcp"} with '
                                  "propose_change; direct edits of _kreaAuth are refused.")
    if definition["id"] == model_pricing.CINEMA_SCENE:
        result["price"] = None
        result["priceNote"] = _cinema_price_note()
    elif model_pricing.is_local(definition):
        result["price"] = "free"
        if options and options.get("note"):
            # Free at its defaults; the other values of that param are not.
            result["priceNote"] = f"Free at its defaults. {options['note']}"
        try:
            entry = (model_pricing.load_pricing().get("nodes") or {}).get(definition["id"])
        except (OSError, ValueError):
            entry = None
        if entry:
            # A paid value with its own rows (QC mode jev): what a run in it costs.
            result["pricedWhen"] = {
                "per": entry.get("per"), "dependsOn": entry.get("priceParams") or [],
                "rows": [{**row.get("match", {}), "usd": row.get("price")} for row in entry.get("rows") or []][:40],
            }
    elif definition.get("apiProvider") == "utility":
        result["price"] = None
        result["priceNote"] = (options or {}).get("note") or (
            "Calls a provider with no list price; agent runs of it must be proposed (propose_change).")
    else:
        try:
            entry = (model_pricing.load_pricing().get("nodes") or {}).get(definition["id"])
        except (OSError, ValueError):
            entry = None
        if not entry:
            result["price"] = None
            if modes == ["mcp"]:
                result["priceNote"] = ("Billed to the signed-in Krea plan. Agent runs count against the Krea plan-run "
                                       "limit set in Nebula Settings.")
            elif modes:
                result["priceNote"] = ("On the API token it has no list price, so agent runs of it must be proposed "
                                       "(propose_change). Switched to the Krea plan (the person's call), agent runs "
                                       "count against the Krea plan-run limit set in Nebula Settings.")
            else:
                result["priceNote"] = "No list price; agent runs of it must be proposed (propose_change)."
        else:
            provider = (model_pricing.route_price_key(
                            definition, node_route.select_route(definition, {}, settings.get("apiKeys") or {}))
                        if node_route.has_routes(definition)
                        else model_pricing.route_provider(definition, settings.get("apiKeys") or {}))
            estimate = model_pricing.estimate_node(entry, definition, {}, provider)

            def price_table(priced: Mapping[str, Any]) -> dict[str, Any]:
                rows = [{**row.get("match", {}), "usd": row.get("price")} for row in priced.get("rows") or []]
                table = {"per": priced.get("per"), "dependsOn": priced.get("priceParams") or [], "rows": rows[:40]}
                sized = model_pricing.size_note(priced, definition)
                if sized:
                    # The rows' multiplyBy quantities come from the input file at run time.
                    table["byInputSize"] = sized
                    table["multiplyBy"] = list(priced.get("multiplyBy") or [])
                return table

            routed = model_pricing.entry_for_route(entry, provider)
            result["price"] = {
                **price_table(routed or entry),
                "atDefaultsUsd": ([round(estimate["low"], 4), round(estimate["high"], 4)]
                                  if estimate and estimate.get("currency") == "usd" else None),
            }
            if (routed or entry).get("unconfirmed") is True:
                # The vendor's page doesn't state it exactly (the entry's notes say what's assumed).
                result["price"]["unconfirmed"] = True
            if isinstance(entry.get("routes"), Mapping):
                # Each route's own price; the run bills the route it takes.
                result["price"]["billedBy"] = provider if routed else None
                result["price"]["routes"] = {name: price_table(priced)
                                             for name, priced in entry["routes"].items()}
    return result


@app.get("/api/health")
async def health() -> dict:
    # paramsVersion: the desktop app compares it with its built frontend's
    # stamp (nebula-build.json) at launch and refuses to open a bundle built
    # for another version (desktop/frontend-build.mjs). Not a secret.
    # bootId: which backend process answers (round 16 of PR #114, M4). A tab
    # notes it from every health probe and socket hello, with or without a
    # project open, and a new one means the backend restarted. Not a secret.
    return {"status": "ok", "app": "nebula", "version": "0.1.0", "paramsVersion": PARAMS_VERSION,
            "bootId": BACKEND_BOOT_ID}


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


def _did(verb: str, node_id: str | None = None, label: str | None = None) -> dict[str, Any]:
    """What an agent's action was, for the Agents panel's line when it has no
    status (Q125 item 2, GM: Moved “Hero shots” · 2 min ago): a past-tense
    verb and the node it names, by the node's label (else its model's name)."""
    if node_id is not None and label is None and node_id in cli_graph.nodes:
        label = _node_label(node_id)
    return {"verb": verb, "nodeId": node_id if node_id in cli_graph.nodes else None, "label": label}


def _point(identity: AgentIdentity, **kwargs: Any) -> dict[str, Any]:
    """agent_presence.point for the open project: every cursor event says
    which project it happened in (the roster lists a cursor only there)."""
    try:
        project_id = _workspace_context()["activeProjectId"]
    except Exception:  # noqa: BLE001 - the catalog unreadable: the cursor still moves
        project_id = None
    return agent_presence.point(identity, project_id=project_id, **kwargs)


async def _show_agent(
    target: dict[str, Any],
    *,
    action: str = "click",
    say: str = "",
    origin: dict[str, Any] | None = None,
    did: dict[str, Any] | None = None,
) -> None:
    """Move the calling agent's cursor; a no-op for the browser's own requests.

    ``did`` (_did) is what the action was, for the Agents panel. Never fails
    the route that called it: presence is decoration on top of an edit that
    already succeeded.
    """
    identity = identify_agent(current_request_headers())
    if identity is None:
        return
    try:
        event = _point(identity, target=target, origin=origin, action=action, say=say, did=did)
        await manager.broadcast_raw(event)
    except Exception:  # noqa: BLE001 - decoration must not break graph edits
        pass


async def _say_agent_action(say: str) -> None:
    """Tell open canvases what the calling agent did where no cursor can go
    (a moodboard write, a run of the whole canvas). It is the cursor's own
    event without a target, so the Agent log lists it under the agent's name
    and colour and no cursor moves (frontend store/agentLogStore.ts). A no-op
    for the browser's own requests; like _show_agent, it never fails the
    route that called it.
    """
    identity = identify_agent(current_request_headers())
    if identity is None:
        return
    try:
        await manager.broadcast_raw(_point(identity, target=None, action="click", say=say))
    except Exception:  # noqa: BLE001 - decoration must not break a saved write
        pass


def _journal(
    kind: str,
    *,
    node_id: str | None = None,
    data: dict[str, Any] | None = None,
    summary: str = "",
    actor: dict[str, Any] | None = None,
    project_id: str | None | Any = ...,
) -> None:
    """Record a canvas change for `nebula watch`; never fails the route that called it.

    The actor defaults to whoever sent the current request (agent, person or
    anonymous). Like presence, the journal is decoration on top of an edit
    that already succeeded. The event names the project the catalog has open
    as it is journaled (_events_journal), or ``project_id`` when the caller
    knows where the change was made (a pin's own project).
    """
    try:
        _events_journal().publish(
            kind,
            actor=actor or actor_for_headers(current_request_headers()),
            node_id=node_id,
            data=data,
            summary=summary,
            edit=_canvas_edit_link.get(),
            **({"project_id": project_id} if project_id is not ... else {}),
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
    SkippedEvent: "run.skipped",
}
_RUN_EVENT_VERBS = {"run.started": "started", "run.finished": "finished", "run.failed": "failed",
                    "run.skipped": "skipped"}


def _note_run(run_id: str) -> None:
    """Who asked for a run, and when: the journal credits its node events to
    them, and an agent's undo (POST /api/graph/apply/undo) leaves a node
    someone else ran after the agent's edit (services/canvas_undo.py)."""
    actor = actor_for_headers(current_request_headers())
    canvas_events.note_run(run_id, actor)
    try:
        canvas_undo_book.run_started(run_id, actor=actor, project_id=_workspace_context()["activeProjectId"])
    except Exception:  # noqa: BLE001 - never refuse a run over undo bookkeeping
        pass


def _note_run_nodes(run_id: str, nodes: list[GraphNode]) -> None:
    """The canvas nodes a run set out to run: while it is going they count as
    run for an agent's undo, before the engine reaches them."""
    canvas_undo_book.run_nodes(run_id, [node.id for node in nodes])


def _run_is_active(run_id: str) -> bool:
    record = execution_runs.get(run_id)
    return record is not None and record.status in {"running", "cancelling"}


def _note_node_ran(event: Any, run_id: str | None) -> None:
    """A run started a canvas node (its ExecutingEvent), for an agent's undo."""
    node_id = getattr(event, "node_id", None)
    if not isinstance(event, ExecutingEvent) or not isinstance(node_id, str) or node_id not in cli_graph.nodes:
        return
    try:
        project_id = (_filed_context(_execution_workspace_context.get()) or _workspace_context())["activeProjectId"]
        canvas_undo_book.node_ran(run_id, node_id, actor=canvas_events.run_actor(run_id), project_id=project_id)
    except Exception:  # noqa: BLE001 - never break execution over undo bookkeeping
        pass


def _run_project() -> str | None | Any:
    """The project a run was admitted in (_capture_execution_workspace), for
    its journal events; ``...`` (the open project) outside a run's context."""
    captured = _filed_context(_execution_workspace_context.get())
    return captured["activeProjectId"] if captured else ...


def _journal_execution_event(event: Any, run_id: str | None) -> None:
    """Journal one node's run start/finish/failure, attributed to whoever
    started the run, tagged with the project the run was admitted in."""
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
        proposal_id = canvas_events.run_proposal(run_id)
        if proposal_id:
            data["proposalId"] = proposal_id  # the run an Accept approved (_require_run_spend_approval)
        # Agents read these (wait_for_canvas_change, `nebula watch`): hide a key
        # a provider quoted (services/key_echoes.py) before cutting to 200, so
        # a key cut short can't slip under the 8-character run check.
        if isinstance(event, ErrorEvent):
            error = _hide_key_echoes(event.friendly or event.error or "", _agent_key_secrets())
            data["error"] = str(_journal_safe_value(error, key="error"))[:200]
        if isinstance(event, SkippedEvent):
            reason = _hide_key_echoes(event.reason, _agent_key_secrets())
            data["reason"] = str(_journal_safe_value(reason, key="reason"))[:200]
            if event.gate_node_id:
                data["gateNodeId"] = event.gate_node_id
        _journal(
            kind,
            node_id=node_id,
            data=data,
            summary=f"{_node_label(node_id)} ({node_id}) {_RUN_EVENT_VERBS[kind]}",
            actor=canvas_events.run_actor(run_id),
            project_id=_run_project(),
        )
    except Exception:  # noqa: BLE001 - never break execution for the journal
        pass


MAX_NODE_LABEL_LENGTH = 80


def _custom_node_label(raw: Any, definition_id: str) -> str | None:
    """A user's name for a node, or None when it is blank or just the model name.

    Only custom names are stored, so a node without one keeps following its
    definition's display name.
    """
    if not isinstance(raw, str):
        return None
    label = " ".join(raw.split())[:MAX_NODE_LABEL_LENGTH]
    definition = node_registry.get(definition_id) or {}
    if not label or label == definition.get("displayName"):
        return None
    return label


def _node_label(node_id: str) -> str:
    node = cli_graph.nodes.get(node_id) or {}
    if isinstance(node.get("label"), str) and node["label"]:
        return node["label"]
    definition = node_registry.get_all().get(str(node.get("definitionId", "")), {})
    return str(definition.get("displayName") or node.get("definitionId") or node_id)


def _run_node_name(node_id: str, run_nodes: Mapping[str, GraphNode]) -> str:
    """A node's name in a run, from the run's own nodes, for a refusal: the
    label it carries (a run's node has none today: GraphNode keeps no label),
    else the open canvas's label when the canvas node with that id is the
    same definition (a run of the canvas: /api/graph/run), else the run
    node's type name, else its id. Never raises: it only names things in a
    refusal that is already decided."""
    try:
        node = run_nodes.get(node_id)
        if node is None:
            return node_id
        own = getattr(node, "label", None)
        if isinstance(own, str) and own.strip():
            return own
        live = cli_graph.nodes.get(node_id)
        if isinstance(live, dict) and live.get("definitionId") == node.definition_id:
            canvas_label = live.get("label")
            if isinstance(canvas_label, str) and canvas_label.strip():
                return canvas_label
        definition = node_registry.get_all().get(node.definition_id) or {}
        return str(definition.get("displayName") or node_id)
    except Exception:  # noqa: BLE001 - a name in a refusal must never turn it into a 500
        return node_id


def _quoted(label: str) -> str:
    """A node's name in a cursor bubble, in curly quotes as the Agents panel
    shows it (GM - Design, 2026-10-25: Connecting “A” to “B”), without
    doubling quotes already around the name (services/node_names.py)."""
    return node_names.quoted(label)


# The Agents panel's verb for a point_at with nothing else behind it (Q125
# item 2). GM - Design's review of PR #193: keep only "Pointed at “X”" and
# "Looked at “X”" on a node and "Looked around" at a spot; "Clicked",
# "Dragged to" and a bare "Moved", "Clicked" or "Dragged" at a spot are cut
# ("'Moved · just now' reads like the agent moved a node, and the rest is
# noise"). A cut gesture names nothing: the cursor keeps the agent's previous
# action, with that action's own time (agent_presence.point).
_POINTED_AT_NODE = {"move": "Pointed at", "look": "Looked at"}
_POINTED_AT_SPOT = {"look": "Looked around"}


def _pointed(action: str, target: Mapping[str, Any]) -> dict[str, Any] | None:
    node_id = target.get("nodeId") if isinstance(target, Mapping) else None
    if isinstance(node_id, str):
        verb = _POINTED_AT_NODE.get(action)
        return _did(verb, node_id) if verb else None
    verb = _POINTED_AT_SPOT.get(action)
    return {"verb": verb, "nodeId": None, "label": None} if verb else None


@app.post("/api/canvas/cursor")
async def point_agent_cursor(body: dict[str, Any]) -> dict[str, Any]:
    """Point the calling agent's cursor at a node, a port, or a canvas spot.

    Body: {target?: {nodeId, handle?} | {x, y}, from?: same shape,
    action?: move|click|drag|look, say?: text}. The caller must identify
    itself (agent token or X-Nebula-Agent).

    With `say` and no target, the line shows where the agent's cursor
    already is, without moving it; an agent with no cursor yet gets one at
    the middle of the person's view (when the browser reported one), else
    at (0, 0). `placed` says which: cursor, view or origin.
    """
    identity = identify_agent(current_request_headers())
    if identity is None:
        raise HTTPException(
            status_code=400,
            detail="Identify the agent with an X-Nebula-Agent header (e.g. 'Claude Code') or an agent token",
        )
    placed = "target"
    try:
        if body.get("target") is None:
            if body.get("from") is not None:
                raise PresenceError("a drag's `from` needs a target to drag to (nodeId, or x and y)")
            if not str(body.get("say") or "").strip():
                raise PresenceError("give a target (nodeId, or x and y), or only `say` to narrate where your "
                                    "cursor is")
            target, placed = agent_presence.here(identity)
        else:
            target = parse_target(body.get("target"), cli_graph.nodes)
        origin = parse_target(body["from"], cli_graph.nodes, "from") if body.get("from") is not None else None
        action = body.get("action") or "move"
        event = _point(
            identity,
            target=target,
            origin=origin,
            action=action,
            say=body.get("say"),
            # A line said in place, or a cut gesture (_pointed gives None),
            # keeps the agent's last action and its time.
            did=None if placed == "cursor" else _pointed(action, target),
        )
    except PresenceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await manager.broadcast_raw(event)
    return {"agent": identity.as_dict(), "target": target, "action": event["action"], "say": event["say"],
            "placed": placed}


# ---------- The Agents panel: status lines and the roster (Q125 item 2) ----------
#
# Justin, 2026-10-24 ("Yes, all four, in that order"), item 2: "An Agents
# panel: Needs you / Working ... MCP: set_status(text, node_id). Proposals
# and questions feed 'Needs you' on their own." Every surface sets a status
# through set_agent_status (MCP set_status, `nebula status`) and reads the
# roster through list_canvas_agents (the panel, MCP list_agents, `nebula
# agents`). services/agent_status.py has the rules.

_STATUS_KEYS = frozenset({"text", "nodeId"})
_status_expiry: asyncio.TimerHandle | None = None
_status_sweeps: set[asyncio.Task[Any]] = set()


async def _broadcast_status_events(events: list[dict[str, Any]]) -> None:
    for event in events:
        try:
            await manager.broadcast_raw(event)
        except Exception:  # noqa: BLE001 - a canvas that missed it reads the roster on reconnect
            pass


def _schedule_status_expiry() -> None:
    """Check again just after the next status would run out. A sign that
    came meanwhile moves that out, and the check schedules itself again."""
    global _status_expiry
    if _status_expiry is not None:
        _status_expiry.cancel()
        _status_expiry = None
    deadline = agent_status.next_deadline()
    if deadline is None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # no running loop (a script): the next roster read sweeps
        return
    # A fresh context, as in _call_later: armed by whatever request set a status.
    _status_expiry = loop.call_later(max(0.0, deadline - agent_status.now()) + 0.5, _start_status_sweep,
                                     context=Context())


def _start_status_sweep() -> None:
    task = asyncio.get_running_loop().create_task(_sweep_agent_statuses())
    _status_sweeps.add(task)
    task.add_done_callback(_status_sweeps.discard)


async def _sweep_agent_statuses() -> None:
    """Drop the statuses whose agent went quiet, and tell every canvas."""
    await _broadcast_status_events(agent_status.sweep())
    _schedule_status_expiry()


async def _forget_status_anchors(*, node_id: str | None = None) -> None:
    """A node deleted (``node_id``) or the graph cleared or replaced: the
    lines on those nodes stay, without them (as cursors re-anchor)."""
    events = agent_status.forget_node(node_id) if node_id is not None else agent_status.forget_graph()
    await _broadcast_status_events(events)


@app.post("/api/canvas/status")
async def set_agent_status(body: Any = Body(None)) -> dict[str, Any]:
    """Set the calling agent's status: one line about what it is working on,
    optionally on a node. Body: {text, nodeId?}; empty text clears it. It
    lasts until replaced or cleared, or until the agent has made no request
    for 10 minutes. The caller must identify itself (agent token or
    X-Nebula-Agent); it sets only its own."""
    headers = current_request_headers()
    identity = identify_agent(headers)
    if identity is None:
        if is_person(headers):
            raise HTTPException(status_code=403, detail=(
                "A status says what an agent is working on: the person doesn't set one"))
        raise HTTPException(status_code=400, detail=(
            "Name yourself with NEBULA_AGENT_NAME or --as (an X-Nebula-Agent header) to set your status"))
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="The body must be an object: {text, nodeId?}")
    unknown = sorted(set(body) - _STATUS_KEYS)
    if unknown:
        raise HTTPException(status_code=422, detail=(
            f"unknown field '{unknown[0]}': a status takes text and nodeId, and it is always your own"))
    if "text" not in body:
        raise HTTPException(status_code=422, detail="text is required: one line about what you're working on "
                                                    "(\"\" clears it)")
    node_id = body.get("nodeId")
    try:
        text = clean_status_text(body.get("text"))
        if text and node_id is not None:
            # Checked as a cursor target is: a node on the open canvas.
            node_id = parse_target({"nodeId": node_id}, cli_graph.nodes, "nodeId")["nodeId"]
        events = agent_status.set(identity, text, node_id=node_id if text else None,
                                  project_id=_workspace_context()["activeProjectId"])
    except (StatusError, PresenceError) as exc:
        raise HTTPException(status_code=422, detail=str(exc).replace("nodeId.nodeId", "nodeId")) from exc
    await _broadcast_status_events(events)
    _schedule_status_expiry()
    status = agent_status.get(identity.id)
    return {"agent": identity.as_dict(), "status": agent_status.view(status) if status is not None else None}


def _waiting_in(project_id: str | None) -> list[Waiting]:
    """The open project's open question sets and proposals (canvas and
    asset), by agent and age: what "Needs you" counts. Nothing else of them."""
    waiting = [Waiting(agent=s.agent, kind="question", created_at=s.created_at, count=len(s.spec.questions))
               for s in agent_questions.open_list() if s.project_id == project_id]
    waiting += [Waiting(agent=p.agent, kind="proposal", created_at=p.created_at)
                for p in canvas_proposals.open_list() if p.project_id == project_id]
    for proposal in asset_proposals.open_list():
        # Kept with the project whose Updates hold it; one with no Update (made
        # with no project open) waits wherever the person is, as the panel
        # counts it (agentRosterModel), so the two reads agree.
        ref = getattr(proposal, "update", None) or {}
        where = ref.get("projectId") or project_id
        if where == project_id:
            waiting.append(Waiting(agent=proposal.agent, kind="proposal", created_at=proposal.created_at))
    return waiting


@app.get("/api/canvas/agents")
async def list_canvas_agents() -> dict[str, Any]:
    """The agents around in the open project: each one's status, its
    cursor's last action, and how many questions and proposals wait for the
    person (counts only, never their content). Needs you first (longest
    wait first), then Working (most recent first)."""
    await _sweep_agent_statuses()
    await _sweep_proposals()
    await _sweep_asset_proposals()
    project_id = _workspace_context()["activeProjectId"]
    agents = build_roster(project_id=project_id, now=agent_status.now(), cursors=agent_presence.active(),
                          statuses=agent_status.for_project(project_id), waiting=_waiting_in(project_id),
                          status_view=agent_status.view)
    return {"projectId": project_id, "agents": agents, "rev": agent_status.revision}


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
    # Why a node's last run failed, as its card says it (services/node_errors.py).
    key_words = _agent_key_secrets()
    for node in snapshot.get("nodes") or []:
        failed = node_errors.get(node["id"])
        if failed:
            node["error"] = _hide_key_echoes(failed["error"], key_words)
            if failed.get("hint"):
                node["errorHint"] = failed["hint"]
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
    snapshot["providerHolds"] = _provider_holds_for_agents()
    return snapshot


def _provider_holds_for_agents() -> dict[str, Any]:
    """Paid starts Nebula holds, read-only (graph export has the same two
    lists): `recoveries` are accepted World Labs operations a rerun resumes
    instead of paying again; `startAmbiguities` are starts Nebula couldn't
    confirm, which keep the node from starting again until someone checks
    Marble and clears it. Agents have no tool to clear either."""
    try:
        recoveries = provider_recovery_store.list()
    except Exception:  # noqa: BLE001 - a read surface never fails the snapshot
        recoveries = []
    try:
        ambiguities = provider_start_guard.list()
    except Exception:  # noqa: BLE001
        ambiguities = []
    return {
        "recoveries": [{key: record.get(key) for key in ("runId", "nodeId", "resumeOperationId", "existingWorldId")}
                       for record in recoveries],
        "startAmbiguities": [{key: record.get(key) for key in ("runId", "nodeId", "kind", "message", "durable")}
                             for record in ambiguities],
    }


def _journal_provider_hold(hold: str, change: str, *, run_id: str | None, node_id: str,
                           kind: str | None = None, durable: bool | None = None,
                           actor: dict[str, Any] | None = None) -> None:
    """One ``provider.hold`` event: a paid start held (`change` "held") or
    cleared ("cleared"). `hold` is "recovery" or "startAmbiguity"."""
    data: dict[str, Any] = {"hold": hold, "change": change, "runId": run_id}
    if kind:
        data["kind"] = kind
    if durable is not None:
        data["durable"] = durable
    what = "a paid start Nebula couldn't confirm" if hold == "startAmbiguity" else "a recovery checkpoint"
    summary = (f"{_node_label(node_id)} ({node_id}) is held: {what}" if change == "held"
               else f"{what} on {_node_label(node_id)} ({node_id}) was cleared")
    _journal("provider.hold", node_id=node_id, data=data, summary=summary, actor=actor, project_id=_run_project())


def _start_node_notes(rows: list[dict[str, Any]], context: Mapping[str, Any], via: str) -> list[str]:
    """What the start call's node list can't say in a price: nodes free at
    their defaults that call a provider in another mode, a local node whose
    default base model can't run here, Krea plan billing and provider routes.
    The CLI's `nebula context` said the same before it moved onto the route."""
    ready = [row for row in rows if row.get("runsWith")]
    notes: list[str] = []
    keyed: dict[str, list[str]] = {}
    for row in ready:
        if row.get("needsKeyFor"):
            keyed.setdefault(str(row["needsKeyFor"]), []).append(str(row["id"]))
    for hint, ids in keyed.items():
        notes.append(f"{', '.join(ids)}: free at the defaults; {hint}.")
    definitions = context["definitions"]
    for row in ready:
        definition = definitions.get(str(row["id"])) or {}
        via_spec = node_readiness.provider_via(definition) or {}
        if via_spec.get("kind") == "model":
            options = node_readiness.detail(definition, context["keys"], context["krea"], definitions) or {}
            if options.get("note"):
                notes.append(f"{row['id']}: {options['note']}")
    look = "`nebula info <id>`" if via == "cli" else "describe_node"
    propose = "`nebula propose`" if via == "cli" else "propose_change"
    if any(row.get("runsWith") == "krea" for row in ready):
        notes.append(f"runsWith krea: runs on the signed-in Krea account. Billing a node differently (_kreaAuth) "
                     f"is the person's call: {propose} it.")
    if any(row.get("providers") for row in ready):
        notes.append(f"A node with providers runs on one route (_provider; {look} lists them); switching it is "
                     f"the person's call: {propose} it.")
    if via == "cli":
        # find_nodes' hints name MCP tools; a shell-only agent reads the `nebula` commands.
        notes = [_cli_words(note) for note in notes]
    return notes


_CLI_WORDS = {"describe_node": "`nebula info <id>`", "propose_change": "`nebula propose`",
              "find_nodes": "`nebula nodes`", "edit_canvas": "`nebula apply`"}


def _cli_words(text: str) -> str:
    return re.sub(r"\b(" + "|".join(_CLI_WORDS) + r")\b", lambda match: _CLI_WORDS[match.group(1)], text)


@app.get("/api/agent/start")
async def agent_start_here(request: Request, via: str = "mcp") -> dict[str, Any]:
    """An agent's first call: the canvas, open pins and proposals, every board,
    the node types that run here with prices, and the spend limits, each in
    its own budget (services/agent_start.py). MCP `start_here` and `nebula
    context` print it; `via=cli` words its hints as `nebula` commands."""
    if via not in agent_start.VIAS:
        raise HTTPException(status_code=422, detail="via must be mcp or cli")
    headers = current_request_headers()
    caller = identify_agent(headers)
    selected = selection_context.snapshot(cli_graph, node_registry).get("selectedNodeIds", [])
    snapshot = agent_presence.snapshot(cli_graph, node_registry, selected_ids=selected)
    catalog = project_store.read()  # every project's name, for the boards part
    active_id = catalog.get("activeProjectId")
    projects = catalog.get("projects") or {}
    active = projects.get(active_id) if active_id else None
    project = {"id": active_id, "name": active.get("name")} if active else None
    try:
        pins = canvas_pins.list()["pins"]
    except (PinError, ProjectStoreError):
        pins = []
    await _sweep_proposals()
    briefs = [canvas_proposals.brief(p) for p in canvas_proposals.open_list()]
    # Asset proposals too (a cover, Send notes, Commons curation), with the
    # Update each posted; a commons one only where the caller sees it.
    await _sweep_asset_proposals()
    briefs += [asset_proposals.brief(p) for p in asset_proposals.open_list()
               if isinstance(p, AssetProposal) and await _commons_proposal_visible(p, headers)]
    # Reads every board file; off the event loop.
    summaries = await asyncio.to_thread(lambda: _moodboard_store().summaries())
    context = await asyncio.to_thread(_agent_node_context)
    rows = await asyncio.to_thread(
        lambda: [_agent_node_row(definition, context) for definition in context["definitions"].values()])
    spend = await agent_spend_status(request)
    restore = _catalog_restore_view(project_store.restore_notice())
    return agent_start.build(
        **({"catalogRestore": agent_start.catalog_restore_part(restore)} if restore else {}),
        canvas=agent_start.canvas_part(snapshot, project=project, caller_id=caller.id if caller else None, via=via),
        pins=agent_start.pins_part(pins, via=via),
        proposals=agent_start.proposals_part(briefs, via=via),
        boards=agent_start.boards_part(
            summaries, active_project_id=active_id,
            project_names={str(pid): str(p.get("name") or pid) for pid, p in projects.items() if isinstance(p, dict)},
            via=via),
        nodes=agent_start.nodes_part(rows, total=len(rows), notes=_start_node_notes(rows, context, via),
                                     krea="signed in" if context["krea"] else "not signed in", via=via),
        spend=agent_start.spend_part(spend),
        next=agent_start.next_part({"journal": canvas_events.journal_id, "cursor": canvas_events.latest}, via=via),
    )


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


class _ClientGone(Exception):
    """The client of a journal long-poll hung up (see _journal_wait)."""


@app.exception_handler(_ClientGone)
async def _client_gone(request, exc: _ClientGone):
    # Nobody reads it: the connection is closed. 499 is the usual name for it.
    return JSONResponse(status_code=499, content={"detail": "The client closed the request."})


async def _until_disconnected(request: Request) -> None:
    """Returns when the client hangs up. These routes are GETs with no body,
    so after the (empty) request message the server's next message is the
    disconnect (uvicorn sends it when the connection closes; test clients
    once the response is complete)."""
    while True:
        message = await request.receive()
        if message.get("type") == "http.disconnect":
            return


async def _journal_wait(request: Request, **kwargs: Any) -> dict[str, Any]:
    """canvas_events.wait for a route's client, ended when that client hangs up.

    Every long-poll on the journal holds one of its MAX_WAITERS (32) slots.
    Without this, a client that gave up (an MCP client cancelling its poll,
    a closed terminal) held its slot for the rest of the wait, up to 25 s, and
    33 of them made every watcher's next poll a 429 (review 1 of PR #114).
    Now the wait stops and frees the slot at once (_ClientGone, a 499 nobody
    reads). A connected client sees no difference."""
    journal = _events_journal()
    if not kwargs.get("wait"):
        return await journal.wait(**kwargs)
    waiting = asyncio.ensure_future(journal.wait(**kwargs))
    gone = asyncio.ensure_future(_until_disconnected(request))
    try:
        await asyncio.wait({waiting, gone}, return_when=asyncio.FIRST_COMPLETED)
        if not waiting.done() and gone.exception() is not None:
            await asyncio.wait({waiting})  # the server's receive failed: wait it out as before
    finally:
        if gone.done() and not gone.cancelled():
            gone.exception()  # a receive that failed as the wait ended: read it, nothing more (review 2)
        gone.cancel()
        abandoned = not waiting.done()
        if abandoned:
            waiting.cancel()
    if abandoned:
        await asyncio.wait({waiting})  # let its cancellation run: that frees the slot
        raise _ClientGone()
    return waiting.result()


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
        return await _journal_wait(
            request,
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


def _journal_detached(pins: list[dict[str, Any]], reason: str) -> None:
    """Journal pins that just lost their node. In the same step as the write
    that detached them, before any await (round 8 of PR #114): the event then
    names the project the pins are in, and lands before any switch that
    follows (a late one named the project opened next, and the --channel
    listener read A's change as B's)."""
    for pin in pins[:50]:
        node_id = pin.get("detachedFrom")
        _journal(
            "pin.detached",
            node_id=node_id if isinstance(node_id, str) else None,
            data={"pinId": pin.get("id"), "text": pin.get("text"), "anchor": pin.get("anchor"), "reason": reason},
            summary=f"note {pin.get('id')} lost its node {node_id} ({reason}); it stays where the node was",
        )


# ---------- What a node delete removed, and its undo (GM, 2026-10-23) ----------
#
# GM - Design, item 1: "Make undo complete. ... Reopen a proposal only if it's
# still valid against the restored graph. If one can't be reopened, the Undo
# notice says so." Every node delete (DELETE /api/graph/node, an agent's
# apply, a restore that removes nodes: Cmd+Z of an add, redo of a delete)
# detaches the pins on the node and closes the proposals that read it. Each
# one gets a removal record, {id: "rm_...", nodeId, projectId, definitionId,
# replaces?, pins, proposals}: the delete's answer carries it, so does the
# edit's graphSync (edit.removals, for a canvas that didn't send it) and an
# agent's undo record. The restore that brings the node back names it
# (``removals``), and _reattach_removed_pins / _reopen_removed_proposals
# re-check each pin and proposal rather than trusting the list: a pin goes
# back only if this very removal detached it from a node of this model (it
# keeps the id, persisted with the project, canvas_pins.reattach), a
# proposal reopens only if this (removal, node) pair
# closed it and the accept checks still pass (_proposal_reopen_misfit).
#
# Node ids are not unique over time (an import or a clear restarts the
# counter at n1, a restore may put any id back, each project has its own n1),
# so a record undoes exactly one delete of exactly one node and nothing
# matches it by the node id alone (second review): the record carries its
# project and model, node_removals knows what each id was minted for, and a
# later delete of a node a restore brought back names the removal that
# restore consumed (``replaces``), the only record renewed to it.

REMOVAL_ID_RE = re.compile(r"^rm_[0-9a-f]{16}$")
MAX_REMOVAL_PINS = 200
MAX_REMOVAL_PROPOSALS = 50
# The removal records of the request deleting nodes now: its graphSync's edit
# carries them, and cover proposals that sync closes keep their ids.
_removals_ctx: ContextVar[list[dict[str, Any]] | None] = ContextVar("node_removals", default=None)


def _remove_side_effects(gone: list[dict[str, Any]], reason: Callable[[dict[str, Any]], str]) -> list[dict[str, Any]]:
    """For each deleted node ({id, name, definitionId, position}): detach its
    pins and close the proposals that read it, under a new removal id. Right
    after the mutation, before any await, so the project the record names is
    the one the node was deleted from; before the delete's graphSync, so the
    sync can name them; journaled after it (_announce_removed_nodes). Returns
    one entry per node: the public ``record`` plus what the journal needs
    (``detached``, ``closed``)."""
    project_id = _workspace_context()["activeProjectId"]
    entries: list[dict[str, Any]] = []
    for item in gone:
        definition_id = str(item.get("definitionId") or "")
        lineage = node_removals.lineage(project_id, item["id"])
        record = node_removals.mint(node_id=item["id"], project_id=project_id, definition_id=definition_id)
        try:
            detached = canvas_pins.detach_node(item["id"], item.get("position"), removal=record["id"],
                                               definition_id=definition_id)
        except (PinError, ProjectStoreError):
            detached = []
        closed = canvas_proposals.invalidate_referencing(item["id"], reason(item), removal=record["id"],
                                                         project_id=project_id, lineage=lineage)
        entries.append({
            "gone": item,
            "detached": detached,
            "closed": closed,
            "record": {**record,
                       "pins": [str(pin.get("id")) for pin in detached if pin.get("id")],
                       # Only those it tagged: one in another project isn't this undo's.
                       "proposals": [proposal.id for proposal in closed if record["id"] in proposal.closed_by]},
        })
    return entries


def _removal_records(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [copy.deepcopy(entry["record"]) for entry in entries]


def _renew_kept_removals(removals: list[dict[str, Any]]) -> None:
    """These deletes took nodes a restore had brought back by undoing an
    earlier delete (the person's redo of an agent's edit, their Cmd+Z of the
    agent's undo): each record says which removal it supersedes
    (``replaces``), and an agent's kept edit that names that one names the
    new one now. By the records' own project, not the one open after the
    graphSync's await. After the sync, so the records carry its cover proposals."""
    if not any(record.get("replaces") for record in removals):
        return
    try:
        canvas_undo_book.renew_removals(removals)
    except Exception:  # noqa: BLE001 - never fail a delete over undo bookkeeping
        pass


def _journal_removed_nodes(entries: list[dict[str, Any]], *, note: str,
                           pin_reason: Callable[[dict[str, Any]], str]) -> None:
    """node.removed, then its pins (pin.detached) and the proposals it closed
    (proposal.invalidated), node by node. Right after _remove_side_effects,
    before the delete's graphSync: in the step that made the delete, so each
    event names the project the node was deleted from (round 8 of PR #114)."""
    for entry in entries:
        gone = entry["gone"]
        _journal(
            "node.removed",
            node_id=gone["id"],
            data={"name": gone["name"], "definitionId": gone["definitionId"]},
            summary=f"removed {gone['name']} ({gone['id']}){note}",
        )
        _journal_detached(entry["detached"], pin_reason(gone))
        _journal_closed_proposals(entry["closed"])


async def _announce_removed_nodes(entries: list[dict[str, Any]]) -> None:
    """After the delete's graphSync (its events journaled before it,
    _journal_removed_nodes): the pins and closed proposals to the open
    canvases, and the deleted nodes' cursors and status anchors let go."""
    if any(entry["detached"] for entry in entries):
        await _broadcast_pins()
    for entry in entries:
        await _broadcast_closed_proposals(entry["closed"])
    for entry in entries:
        agent_presence.forget_node(entry["gone"]["id"])
        await _forget_status_anchors(node_id=entry["gone"]["id"])


def _restore_removals(raw: Any) -> list[dict[str, Any]]:
    """The ``removals`` a restore names: the removal records of the deletes it undoes."""
    if raw is None:
        return []
    shape = ("removals must be a list of the removal records the delete answered with "
             "({id, nodeId, projectId, definitionId, replaces?, pins, proposals})")
    if not isinstance(raw, list) or len(raw) > RESTORE_MAX_GRAPH_NODES:
        raise HTTPException(status_code=400, detail=shape)
    records: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail=shape)
        removal, node_id = item.get("id"), item.get("nodeId")
        if not isinstance(removal, str) or REMOVAL_ID_RE.fullmatch(removal) is None:
            raise HTTPException(status_code=400, detail=f"removals[{index}].id must be a removal id like rm_0123456789abcdef")
        if not isinstance(node_id, str) or SHORT_ID_RE.fullmatch(node_id) is None:
            raise HTTPException(status_code=400, detail=f"removals[{index}].nodeId must be a node id like n3")
        bound: dict[str, Any] = {}
        project_id = item.get("projectId")
        if project_id is not None:
            if not isinstance(project_id, str) or not 0 < len(project_id) <= 64:
                raise HTTPException(status_code=400, detail=f"removals[{index}].projectId must be a project id")
            bound["projectId"] = project_id
        definition_id = item.get("definitionId")
        if definition_id is not None:
            if not isinstance(definition_id, str) or not 0 < len(definition_id) <= 128:
                raise HTTPException(status_code=400, detail=f"removals[{index}].definitionId must be a model id")
            bound["definitionId"] = definition_id
        replaces = item.get("replaces")
        if replaces is not None:
            if not isinstance(replaces, str) or REMOVAL_ID_RE.fullmatch(replaces) is None:
                raise HTTPException(status_code=400,
                                    detail=f"removals[{index}].replaces must be a removal id like rm_0123456789abcdef")
            bound["replaces"] = replaces
        lists: dict[str, list[str]] = {}
        for key, cap in (("pins", MAX_REMOVAL_PINS), ("proposals", MAX_REMOVAL_PROPOSALS)):
            values = item.get(key, [])
            if (not isinstance(values, list) or len(values) > cap
                    or not all(isinstance(value, str) and 0 < len(value) <= 64 for value in values)):
                raise HTTPException(status_code=400, detail=f"removals[{index}].{key} must be a list of ids")
            lists[key] = list(dict.fromkeys(values))
        records.append({"id": removal, "nodeId": node_id, **bound, **lists})
    return records


_PROPOSAL_GONE = "Nebula no longer has it (it restarted, or the proposal closed too long ago)"


async def _proposal_reopen_misfit(proposal: Proposal) -> str | None:
    """Why a proposal a delete closed can't reopen on the restored graph, or
    None when it can: the checks Accept runs (the params it sets unchanged
    since, the whole proposal staged on the live graph, what its runs would
    start unchanged), and it hasn't expired and is for the open project."""
    if proposal.project_id != _workspace_context()["activeProjectId"]:
        return "it belongs to another project"
    if proposal.expires_at <= canvas_proposals.now():
        return "it expired"
    models = await _look_up_models(_spec_models_wanted(proposal.spec))
    if proposal.project_id != _workspace_context()["activeProjectId"]:
        # Another project opened during the lookup (review 8): the live graph
        # is that project's now, so the checks below would read the wrong one.
        return ANOTHER_PROJECT
    try:
        _refuse_overwriting_later_edits(proposal)
        candidate, id_map, _edge_ids, run_ids = _stage_proposal(proposal.spec, positions=proposal.positions,
                                                                models=models)
        _refuse_changed_runs(proposal, candidate, id_map, run_ids)
    except HTTPException as exc:
        return str(exc.detail)
    return None


async def _asset_reopen_misfit(proposal: AssetProposal, exported: dict[str, Any] | None = None) -> str | None:
    """Accept's check, against the restored live graph as Accept reads it
    (``exported``, _projects_live_export): the stored snapshot may be an
    autosave from after the delete, without the node's image."""
    if proposal.expires_at <= asset_proposals.now():
        return "it expired"
    try:
        if exported is None and proposal.kind == "project":
            exported = await _projects_live_export()
        return await _asset_proposal_misfit(proposal, exported)
    except Exception:  # noqa: BLE001 - a target that can't be read doesn't reopen
        return "its target can't be read"


async def _reopen_update(ref: Mapping[str, Any] | None, proposal_id: str) -> None:
    """Its Update reviews the proposal again (op "changed", the note as it is now)."""
    if not ref:
        return
    try:
        result = await asyncio.to_thread(agent_notes.reopen_proposal, ref["projectId"], ref["id"], proposal_id)
    except (NoteError, ProjectStoreError):
        return
    if result is not None and result["projectId"] == _open_project_id():
        await _broadcast_raw_quietly(_notes_message("canvas", "changed", project_id=result["projectId"],
                                                    ids=[ref["id"]], note=result["note"], unread=result["unread"]))


def _bound_removals(records: list[dict[str, Any]], back: Mapping[str, str],
                    project_id: str | None) -> list[tuple[dict[str, Any], bool | None]]:
    """The records that may undo the delete of a node this restore brought
    back (``back``: node id -> its model, in ``project_id``), each with
    node_removals' verdict: True when this backend minted it for exactly
    this node, False when for anything else (another node, project or
    model), None when it doesn't know the id (after a restart). A record
    that says it is for another project or model is dropped here."""
    bound: list[tuple[dict[str, Any], bool | None]] = []
    for record in records:
        node_id = record["nodeId"]
        if node_id not in back:
            continue
        if record.get("projectId", project_id) != project_id:
            continue
        if record.get("definitionId", back[node_id]) != back[node_id]:
            continue
        bound.append((record, node_removals.verdict(record, project_id=project_id, definition_id=back[node_id])))
    return bound


def _note_restored(project_id: str | None, back: Mapping[str, str], consumed: Mapping[str, str]) -> None:
    """Each node this restore brought back, with the removal it undid (or
    none): the next delete of that node names it (``replaces``)."""
    for node_id in back:
        node_removals.restored(project_id, node_id, consumed.get(node_id))


def _reattach_removed_pins(records: list[dict[str, Any]], back: Mapping[str, str],
                           project_id: str | None) -> dict[str, Any]:
    """The restore brought ``back`` these nodes (node id -> model) in
    ``project_id``: undo what their deletes removed, first half. Only
    records bound to those very nodes count (_bound_removals), and only pins
    and proposals those removals detached or closed: a pin by its
    ``detachedBy`` and model, a proposal by a (removal, node) pair in its
    ``closed_by``. Synchronous, in the restore's own step, before the
    caller's edit.undone (review 8 of PR #114): the pins go back and are
    journaled (pin.reattached) here. Returns what the second half
    (_reopen_removed_proposals, after the sync) needs, with the restore's
    ``reattached`` (pin ids) and ``pinsLeft`` ({id, reason, code}) so far."""
    out: dict[str, list[Any]] = {"reattached": [], "pinsLeft": [], "reopened": [], "notReopened": []}
    bound = _bound_removals(records, back, project_id)
    # Pins check their own persisted binding (detachedBy, detachedFrom,
    # detachedDefinition), so a record minted for something else still gets
    # each pin it names reported as left; proposals and ``replaces`` take only
    # the records not known to be another delete's.
    for_pins = [record for record, _verdict in bound]
    relevant = [record for record, verdict in bound if verdict is not False]
    plan: dict[str, Any] = {"out": out, "relevant": relevant, "pins_back": False}
    consumed = {record["nodeId"]: record["id"] for record, verdict in bound if verdict}
    if not for_pins:
        _note_restored(project_id, back, consumed)
        return plan
    try:
        pins = canvas_pins.reattach(for_pins, back, project_id)
    except (PinError, ProjectStoreError):
        pins = {"reattached": [], "left": []}
    out["reattached"] = [str(pin.get("id")) for pin in pins["reattached"]]
    out["pinsLeft"] = pins["left"]
    # After a restart only a pin proves which delete a record undid.
    by_pin = {str(pin.get("id")): str((pin.get("anchor") or {}).get("nodeId")) for pin in pins["reattached"]}
    for record, verdict in bound:
        if verdict is None and any(by_pin.get(str(pin_id)) == record["nodeId"] for pin_id in record.get("pins") or []):
            consumed.setdefault(record["nodeId"], record["id"])
    _note_restored(project_id, back, consumed)
    # Journaled in the step that put them back, broadcast after the sync (round 8 of PR #114).
    for pin in pins["reattached"][:50]:
        node_id = (pin.get("anchor") or {}).get("nodeId")
        _journal(
            "pin.reattached",
            node_id=node_id if isinstance(node_id, str) else None,
            data={"pinId": pin.get("id"), "text": pin.get("text"), "anchor": pin.get("anchor")},
            summary=f"note {pin.get('id')} is back on {node_id}: the undo put its node back",
            project_id=project_id,
        )
    plan["pins_back"] = bool(pins["reattached"])
    return plan


def _note_reopen_in_link() -> None:
    """Right after a proposal.reopened: the restore's link (if it has one)
    lists it at once. A later proposal's fit check awaits, and the person's
    Cmd+Z of this undo landing then reads the link (review 9 of PR #114)."""
    link = _canvas_edit_link.get()
    if link is not None:
        _note_link_events(link["id"])


async def _reopen_removed_proposals(plan: dict[str, Any], project_id: str | None) -> dict[str, list[Any]]:
    """Second half, after the restore's sync: the pins put back
    (_reattach_removed_pins) go to the canvases, and the proposals the
    deletes closed reopen where they still fit. Returns the restore's
    ``reattached``, ``pinsLeft``, ``reopened`` (proposal ids) and
    ``notReopened`` ({id, reason}): a proposal the delete closed that
    doesn't fit the restored graph, expired, lost its tag to a clear, an
    import or a project switch, or that Nebula no longer has (a restart;
    proposals live in memory). A proposal is reopened (and journaled) only
    while its project is still the one open (review 8)."""
    out: dict[str, list[Any]] = plan["out"]
    relevant: list[dict[str, Any]] = plan["relevant"]
    if plan["pins_back"]:
        await _broadcast_pins()
    if not relevant:
        return out
    if _workspace_context()["activeProjectId"] != project_id:
        # Another project opened while the restore was on its way: its
        # proposals aren't these; say so rather than touch them.
        out["notReopened"] = [{"id": proposal_id, "reason": ANOTHER_PROJECT}
                              for proposal_id in dict.fromkeys(p for r in relevant for p in r.get("proposals") or [])]
        return out
    pairs = {(record["id"], record["nodeId"]) for record in relevant}

    named = {proposal_id for record in relevant for proposal_id in record.get("proposals") or []}
    found = sorted(canvas_proposals.closed_by_pairs(pairs, project_id), key=lambda p: p.created_at)
    reopened: list[Proposal] = []
    for proposal in found:
        # Its tags stay as they are until it reopens: only a matching pair
        # counts, and nothing is taken off before the checks pass.
        waiting_on = {node_id for removal, node_id in proposal.closed_by.items() if (removal, node_id) not in pairs}
        missing = {node_id for node_id in proposal.references if node_id not in cli_graph.nodes}
        if missing and missing <= waiting_on:
            # It still needs nodes other deletes took, and undoing those may
            # bring them back: it waits for that, closed, and isn't counted.
            continue
        reason = await _proposal_reopen_misfit(proposal)
        if reason is None and proposal.project_id != _workspace_context()["activeProjectId"]:
            # Another project opened during the check's await (review 8): no reopen, no event.
            reason = ANOTHER_PROJECT
        if reason is None:
            try:
                canvas_proposals.reopen(proposal.id)
            except ProposalError as exc:
                reason = exc.detail
        if reason is None:
            reopened.append(proposal)
            # In the step that reopened it, tagged with its project (round 8 of PR #114).
            _journal(
                "proposal.reopened",
                node_id=next(iter(sorted(proposal.references, key=_node_order)), None),
                data={"proposalId": proposal.id, "agentId": proposal.agent.id, "note": proposal.spec.note},
                summary=f"reopened {proposal.agent.name}'s proposal {proposal.id}: the undo put back the node it needs",
                project_id=proposal.project_id,
            )
            _note_reopen_in_link()
        else:
            out["notReopened"].append({"id": proposal.id, "reason": reason})
    assets = [p for p in asset_proposals.closed_by_pairs(pairs, project_id) if isinstance(p, AssetProposal)]
    found_ids = {proposal.id for proposal in found} | {proposal.id for proposal in assets}
    for proposal_id in sorted(named - found_ids):
        proposal_now = canvas_proposals.get(proposal_id) or asset_proposals.get(proposal_id)
        if proposal_now is None:
            out["notReopened"].append({"id": proposal_id, "reason": _PROPOSAL_GONE})
        elif (proposal_now.status == "invalidated" and proposal_now.project_id == project_id
              and any(pair in pairs for pair in proposal_now.dropped_by.items())):
            # A clear, an import or a project switch spent this delete's tag.
            out["notReopened"].append({"id": proposal_id,
                                       "reason": f"{proposal_now.dropped_reason or 'the canvas was replaced'} since"})
        # One that is there but this delete didn't close (decided, or another
        # delete's) isn't this undo's: it stays as it is and isn't counted.
    for proposal in reopened:
        out["reopened"].append(proposal.id)
        if not proposal.is_open or proposal.project_id != _workspace_context()["activeProjectId"]:
            # A switch after it reopened closed it again (the canvas was
            # replaced): no ghost bar on the project open now.
            continue
        try:
            await manager.broadcast_browser({
                "type": "proposalOpened",
                "proposal": _proposal_view(proposal),
                "acceptKey": proposal.accept_key,
                "personValues": canvas_proposals.person_values(proposal),
            })
        except Exception:  # noqa: BLE001 - a browser that missed it gets proposalSync on reconnect
            pass
        await _reopen_update(proposal.update, proposal.id)
        _schedule_canvas_expiry(proposal)

    reopened_assets: list[AssetProposal] = []
    live: dict[str, Any] | None = None
    if any(p.kind == "project" for p in assets):
        try:
            live = await _projects_live_export()
        except Exception:  # noqa: BLE001 - each proposal tries again, and fails closed
            live = None
    for proposal in sorted(assets, key=lambda p: p.created_at):
        reason = await _asset_reopen_misfit(proposal, live if proposal.kind == "project" else None)
        if reason is None:
            try:
                asset_proposals.reopen(proposal.id)
            except ProposalError as exc:
                reason = exc.detail
        if reason is None:
            reopened_assets.append(proposal)
            out["reopened"].append(proposal.id)
            _journal(
                "proposal.reopened",
                data=_asset_journal_data(proposal),
                summary=f"reopened {proposal.agent.name}'s proposal {proposal.id}: the undo put back the image it needs",
            )
            _note_reopen_in_link()
        else:
            out["notReopened"].append({"id": proposal.id, "reason": reason})
    for proposal in reopened_assets:
        await _reopen_update(proposal.update, proposal.id)
        _schedule_asset_expiry(proposal)
    if reopened_assets:
        try:
            await manager.broadcast_browser(_asset_proposal_open_message())
        except Exception:  # noqa: BLE001 - the screens relist on reconnect
            pass
    return out


def _undo_extras_text(result: Mapping[str, Any]) -> str:
    """What else an undo put back, and what it couldn't, for its message: "1
    pin back on its node; 1 pin left as it is (pin_3: deleted since);
    reopened 1 proposal; 1 proposal couldn't be reopened (it expired)."."""
    parts: list[str] = []
    pins = len(result.get("reattached") or [])
    if pins:
        parts.append(f"{pins} pin{'s' if pins != 1 else ''} back on {'its node' if pins == 1 else 'their nodes'}")
    left = result.get("pinsLeft") or []
    if left:
        reasons = "; ".join(f"{row['id']}: {row['reason']}" for row in left[:3])
        parts.append(f"{len(left)} pin{'s' if len(left) != 1 else ''} left as "
                     f"{'it is' if len(left) == 1 else 'they are'} ({reasons})")
    reopened = len(result.get("reopened") or [])
    if reopened:
        parts.append(f"reopened {reopened} proposal{'s' if reopened != 1 else ''}")
    missed = result.get("notReopened") or []
    if missed:
        reasons = "; ".join(f"{row['id']}: {row['reason']}" for row in missed[:3])
        parts.append(f"{len(missed)} proposal{'s' if len(missed) != 1 else ''} couldn't be reopened ({reasons})")
    return ("; ".join(parts) + ".") if parts else ""


def _pin_http_error(exc: PinError) -> HTTPException:
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
    require_person(current_request_headers())
    try:
        project_id, pin = canvas_pins.add_in(
            body.get("text"),
            node_id=body.get("nodeId"),
            position=body.get("position"),
            graph_nodes=cli_graph.nodes,
        )
    except PinError as exc:
        raise _pin_http_error(exc) from exc
    # Journaled at once, before any await, tagged with the project the write
    # went to: a switch (and a pin on the project it opens) journaled during
    # an await here would come first, and this event, naming the project
    # left, would then make the --channel listener drop the open project's
    # pin (review 6 of PR #114, LOW-1). The same in delete and resolve.
    anchor = pin.get("anchor") or {}
    _journal(
        "pin.added",
        node_id=anchor.get("nodeId"),
        data={"pinId": pin["id"], "text": pin["text"], "anchor": anchor},
        summary=pin_summary(pin),
        project_id=project_id,
    )
    await _broadcast_pins()
    return {"pin": pin}


@app.delete("/api/canvas/pins/{pin_id}")
async def delete_canvas_pin(pin_id: str) -> dict[str, Any]:
    """Delete a note. Only the person can do this."""
    require_person(current_request_headers())
    try:
        project_id, pin = canvas_pins.remove_in(pin_id)
    except PinError as exc:
        raise _pin_http_error(exc) from exc
    _journal(  # before any await, tagged with the write's project (see create_canvas_pin)
        "pin.removed",
        node_id=(pin.get("anchor") or {}).get("nodeId"),
        data={"pinId": pin_id, "text": pin.get("text")},
        summary=f"deleted the note {pin_id}",
        project_id=project_id,
    )
    await _broadcast_pins()
    return {"status": "deleted"}


@app.post("/api/canvas/pins/{pin_id}/resolve")
async def resolve_canvas_pin(pin_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """An agent answers a note in one line, which resolves it and moves its cursor there."""
    identity = identify_agent(current_request_headers())
    if identity is None:
        raise HTTPException(status_code=400, detail="Name yourself with NEBULA_AGENT_NAME or --as")
    try:
        project_id, pin = canvas_pins.resolve_in(pin_id, body.get("reply"), identity)
    except PinError as exc:
        raise _pin_http_error(exc) from exc
    reply = (pin.get("reply") or {}).get("text", "")
    anchor = pin.get("anchor") or {}
    _journal(  # before any await, tagged with the write's project (see create_canvas_pin)
        "pin.resolved",
        node_id=anchor.get("nodeId"),
        data={"pinId": pin_id, "text": pin.get("text"), "reply": reply},
        summary=f'answered the note {pin_id} ("{str(pin.get("text"))[:40]}"): {reply}',
        project_id=project_id,
    )
    await _broadcast_pins()
    try:
        target = anchor if anchor.get("nodeId") in cli_graph.nodes else (
            pin.get("position") or {"x": anchor.get("x", 0.0), "y": anchor.get("y", 0.0)}
        )
        target = {"nodeId": target["nodeId"]} if "nodeId" in target else {"x": target["x"], "y": target["y"]}
        node = target.get("nodeId")
        await manager.broadcast_raw(_point(identity, target=target, action="click", say=reply,
                                           did=_did("Replied on", node) if node else {"verb": "Replied"}))
    except Exception:  # noqa: BLE001 - the cursor is decoration on a saved reply
        pass
    return {"pin": pin}


# ---------- Updates: what an agent or the reader noticed (plan section 5.9) ----------
# On screen "Updates"; in code agentNotes (services/agent_notes.py).

from pydantic import BaseModel, ConfigDict, Field  # noqa: E402 - the models below need them here


class AgentNoteBody(BaseModel):
    """POST .../agent-notes: what an agent noticed, reports or suggests."""
    model_config = ConfigDict(extra="forbid")

    text: Any = None
    refs: Any = None
    about: Any = None
    # Refused with a reason (services/agent_notes.py): agents' updates carry no actions.
    actions: Any = None


class AgentNotesReadBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    upTo: str | None = None
    # Just these updates (a click on one dropped card), instead of upTo.
    ids: list[str] | None = Field(default=None, max_length=200)


def _note_http_error(exc: NoteError) -> HTTPException | JSONResponse:
    if exc.code == "note_not_found":
        # GM's 404 pattern for the person (error-copy round 3); agents keep the detail.
        detail = refusal_copy.refusal_detail(exc.detail, refusal_copy.gone("update", "updates"))
        return JSONResponse(status_code=exc.status, content={"detail": detail, "code": exc.code})
    if exc.code:
        return JSONResponse(status_code=exc.status, content={"detail": exc.detail, "code": exc.code})
    return HTTPException(status_code=exc.status, detail=exc.detail)


def _raise_note_error(exc: NoteError):
    error = _note_http_error(exc)
    if isinstance(error, HTTPException):
        raise error from exc
    return error


def _notes_message(surface: str, op: str, *, project_id: str | None = None, board_id: str | None = None,
                   **extra: Any) -> dict[str, Any]:
    message: dict[str, Any] = {"type": "agentNotes", "surface": surface, "op": op,
                               "at": int(_time_module.time() * 1000), **extra}
    if surface == "board":
        message["boardId"] = board_id
    else:
        message["projectId"] = project_id
    return message


def _canvas_notes_message() -> dict[str, Any]:
    """Every update of the open project, sent on connect and after a project
    switch, so a tab that reconnects has the list (op "sync")."""
    try:
        listing = agent_notes.canvas_list()
    except (NoteError, ProjectStoreError):
        listing = {"projectId": None, "notes": [], "unread": 0}
    return _notes_message("canvas", "sync", project_id=listing["projectId"], notes=listing["notes"],
                          unread=listing["unread"])


async def _broadcast_raw_quietly(message: dict[str, Any]) -> None:
    try:
        await manager.broadcast_raw(message)
    except Exception:  # noqa: BLE001 - saved already; a reconnect resyncs
        pass


def _journal_note(note: dict[str, Any], surface: str, *, board: dict[str, Any] | None = None,
                  actor: dict[str, Any] | None = None, project_id: str | None | Any = ...) -> None:
    """note.posted. ``project_id``: the project the Update was saved in, when
    a worker thread saved it (the open project may have changed since)."""
    data: dict[str, Any] = {"surface": surface, "noteId": note.get("id"), "about": note.get("about"),
                            "refs": list(note.get("refs") or [])[:12], "text": note.get("text")}
    if board is not None:
        data["boardId"] = board.get("id")
        data["boardName"] = board.get("name")
    _journal("note.posted", data=data, summary=note_summary(note), actor=actor, project_id=project_id)


def _note_author() -> AgentIdentity:
    identity = identify_agent(current_request_headers())
    if identity is None:
        raise HTTPException(status_code=400, detail=(
            "Name yourself with NEBULA_AGENT_NAME or --as: an update is posted by an agent, "
            "and the person reads it under Updates"))
    return identity


@app.get("/api/canvas/agent-notes")
async def list_canvas_agent_notes(unread: int = 0) -> Any:
    """The open project's Updates, newest first (``?unread=1`` for unread only)."""
    try:
        await _settle_proposal_updates()  # never list an expired proposal as waiting
        return agent_notes.canvas_list(unread_only=bool(unread))
    except NoteError as exc:
        return _raise_note_error(exc)


@app.post("/api/canvas/agent-notes", status_code=201)
async def post_canvas_agent_note(body: AgentNoteBody) -> Any:
    """An agent posts what it noticed on the main canvas: ``{text, refs?, about?}``.
    ``refs`` are node ids; unknown ones are dropped and listed in ``dropped``."""
    identity = _note_author()
    try:
        result = agent_notes.canvas_post(identity, body.model_dump(exclude_unset=True),
                                         graph_nodes=cli_graph.nodes)
    except NoteError as exc:
        return _raise_note_error(exc)
    _journal_note(result["note"], "canvas")  # before any await (round 8 of PR #114)
    await _broadcast_raw_quietly(_notes_message("canvas", "added", project_id=result["projectId"],
                                                note=result["note"], unread=result["unread"],
                                                removed=result["removed"]))
    return result


@app.post("/api/canvas/agent-notes/read")
async def read_canvas_agent_notes(body: AgentNotesReadBody | None = None) -> Any:
    """The person opened the list: every update up to ``upTo`` (all when left
    out) is read, or just ``ids`` (a dropped card they clicked). Person only,
    so an agent can't hide an update."""
    require_person(current_request_headers())
    try:
        result = agent_notes.canvas_mark_read(body.upTo if body else None, ids=body.ids if body else None)
    except NoteError as exc:
        return _raise_note_error(exc)
    if result["ids"]:
        await _broadcast_raw_quietly(_notes_message("canvas", "read", project_id=result["projectId"],
                                                    ids=result["ids"], unread=result["unread"]))
    return result


@app.post("/api/canvas/agent-notes/{note_id}/dismiss")
async def dismiss_canvas_agent_note(note_id: str) -> Any:
    """× on a card, or "Not now": the update stays in the list, greyed. Person only."""
    require_person(current_request_headers())
    try:
        result = agent_notes.canvas_dismiss(note_id)
    except NoteError as exc:
        return _raise_note_error(exc)
    await _broadcast_raw_quietly(_notes_message("canvas", "dismissed", project_id=result["projectId"],
                                                ids=[note_id], note=result["note"], unread=result["unread"]))
    return result


def _live_board_for_notes(moodboard_id: str) -> dict[str, Any] | JSONResponse:
    store = _moodboard_store()
    try:
        board = store.get(moodboard_id, laid_out=False)
    except ValueError:
        raise refusal_copy.not_found(f"Moodboard '{moodboard_id}' not found", "board", "boards")
    if board is None:
        return _asset_not_found("moodboard", moodboard_id)
    return board


@app.get("/api/moodboards/{moodboard_id}/agent-notes")
async def list_board_agent_notes(moodboard_id: str, unread: int = 0) -> Any:
    """A board's Updates, newest first, numbers drawn as the board is now."""
    board = await asyncio.to_thread(_live_board_for_notes, moodboard_id)
    if isinstance(board, JSONResponse):
        return board
    return agent_notes.board_list(board, unread_only=bool(unread))


@app.post("/api/moodboards/{moodboard_id}/agent-notes", status_code=201)
async def post_board_agent_note(moodboard_id: str, body: AgentNoteBody) -> Any:
    """An agent posts what it noticed on a board. ``#n`` in the text is saved
    as that image's id (a ``#n`` not on the board refuses it); ``refs`` are
    image ids or numbers. Never writes the board file."""
    identity = _note_author()
    board = await asyncio.to_thread(_live_board_for_notes, moodboard_id)
    if isinstance(board, JSONResponse):
        return board
    try:
        result = await asyncio.to_thread(agent_notes.board_post, identity, board,
                                         body.model_dump(exclude_unset=True))
    except NoteError as exc:
        return _raise_note_error(exc)
    _journal_note(result["note"], "board", board=board)
    await _broadcast_raw_quietly(_notes_message("board", "added", board_id=board["id"], note=result["note"],
                                                unread=result["unread"], removed=result["removed"]))
    return result


@app.post("/api/moodboards/{moodboard_id}/agent-notes/read")
async def read_board_agent_notes(moodboard_id: str, body: AgentNotesReadBody | None = None) -> Any:
    require_person(current_request_headers())
    board = await asyncio.to_thread(_live_board_for_notes, moodboard_id)
    if isinstance(board, JSONResponse):
        return board
    try:
        result = agent_notes.board_mark_read(board, body.upTo if body else None, ids=body.ids if body else None)
    except NoteError as exc:
        return _raise_note_error(exc)
    if result["ids"]:
        await _broadcast_raw_quietly(_notes_message("board", "read", board_id=board["id"], ids=result["ids"],
                                                    unread=result["unread"]))
    return result


@app.post("/api/moodboards/{moodboard_id}/agent-notes/{note_id}/dismiss")
async def dismiss_board_agent_note(moodboard_id: str, note_id: str) -> Any:
    require_person(current_request_headers())
    board = await asyncio.to_thread(_live_board_for_notes, moodboard_id)
    if isinstance(board, JSONResponse):
        return board
    try:
        result = agent_notes.board_dismiss(board, note_id)
    except NoteError as exc:
        return _raise_note_error(exc)
    await _broadcast_raw_quietly(_notes_message("board", "dismissed", board_id=board["id"], ids=[note_id],
                                                note=result["note"], unread=result["unread"]))
    return result


# ---------- Proposals: agents propose, the person approves ----------

_PROPOSAL_KEY_HEADER = "x-nebula-proposal-key"
_SYSTEM_ACTOR: dict[str, Any] = {"kind": "system"}
_PERSON_ACTOR: dict[str, Any] = {"kind": "person"}


def _proposal_http_error(exc: ProposalError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)


def _wire_end_ports(end: str, definition_id: str | None, kind: str) -> tuple[str, list[str]] | None:
    """canvas_proposals.PortLookup over the canvas: the ports a wire's end
    has, so a wire with no port gets them named in its error, as a wrong
    port name does (port_contracts)."""
    node = None if definition_id else cli_graph.nodes.get(end)
    definition_id = definition_id or str((node or {}).get("definitionId") or "")
    definition = node_registry.get(definition_id) if definition_id else None
    if not definition:
        return None
    declared = (cinema_output_ports((node or {}).get("params"))
                if kind == "outputPorts" and definition_id == "cinema-scene"
                else definition.get(kind, []))
    return definition_id, [str(port["id"]) for port in declared or []
                           if isinstance(port, dict) and isinstance(port.get("id"), str)]


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
    """Journal and broadcast proposals that just closed (expired, invalidated, ...):
    every journal event first, before any await (_journal_closed_proposals)."""
    _journal_closed_proposals(proposals, actor=actor)
    await _broadcast_closed_proposals(proposals, actor=actor)


def _journal_closed_proposals(proposals: list[Proposal], *, actor: dict[str, Any] | None = None) -> None:
    """In the step that closed them (round 8 of PR #114), each tagged with
    the project it was made in."""
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
            project_id=proposal.project_id,
        )


async def _broadcast_closed_proposals(proposals: list[Proposal], *, actor: dict[str, Any] | None = None) -> None:
    """The open canvases hear of proposals already journaled as closed, and each one's Update settles."""
    for proposal in proposals:
        try:
            await manager.broadcast_raw(_proposal_closed_message(proposal))
        except Exception:  # noqa: BLE001 - the canvas also hides expired proposals locally
            pass
    await _follow_canvas_updates(proposals, actor=actor)


async def _sweep_proposals() -> None:
    """Expire overdue proposals; called before every proposal read and decision."""
    try:
        expired = canvas_proposals.sweep()
    except Exception:  # noqa: BLE001 - never fail a read over housekeeping
        return
    await _announce_closed_proposals(expired, actor=dict(_SYSTEM_ACTOR))


def _proposal_view(proposal: Proposal) -> dict[str, Any]:
    return canvas_proposals.view(proposal, registry=node_registry)


def _spec_models_wanted(spec: ProposalSpec) -> list[tuple[str, str]]:
    """(definition id, model) for each universal node a proposal or edit
    creates with a model or sets the model of: what _look_up_models reads."""
    wanted: list[tuple[str, str]] = []
    for node in spec.nodes:
        if universal_ports.is_universal(node.definition_id):
            wanted.append((node.definition_id, universal_ports.model_of(node.definition_id, node.params)))
    for change in spec.params:
        node = cli_graph.nodes.get(change.node_id) or {}
        definition_id = str(node.get("definitionId") or "")
        key = universal_ports.MODEL_PARAM.get(definition_id)
        if key and key in change.params:
            wanted.append((definition_id, universal_ports.model_of(
                definition_id, {**(node.get("params") or {}), **change.params})))
    return wanted


async def _look_up_models(wanted: Iterable[tuple[str, str]]) -> dict[tuple[str, str], Any]:
    """The provider's data (or why there is none) for each wanted model,
    read before staging: staging can't wait on the network. Cached by the
    model-list routes, so a second edit with the same model reads nothing."""
    found: dict[tuple[str, str], Any] = {}
    for definition_id, model in wanted:
        if model and (definition_id, model) not in found:
            found[(definition_id, model)] = await universal_ports.look_up(definition_id, model)
    return found


def _basic_ports_line(definition_id: str, params: Mapping[str, Any]) -> str:
    definition = node_registry.get(definition_id) or {}
    inputs = universal_ports.port_ids(node_ports(definition_id, params, definition, "inputPorts"))
    outputs = universal_ports.port_ids(node_ports(definition_id, params, definition, "outputPorts"))
    if not inputs and not outputs:
        return "no ports"
    return f"inputs {', '.join(inputs) or '(none)'}; outputs {', '.join(outputs) or '(none)'}"


def _refuse_orphaned_wires(graph: CLIGraph, node_id: str, name: str | None = None, reason: str = "") -> None:
    """400 when a node's model change leaves wires on ports it no longer has:
    the new model's, or, when the model was cleared or can't be read
    (``reason``), its definition's. An agent's edit is all or nothing, so the
    wires aren't dropped for it: it unwires them in the same edit (the picker
    drops them for the person). Left in place they would fail every save."""
    node = graph.nodes.get(node_id) or {}
    definition_id = str(node.get("definitionId") or "")
    params = node.get("params") or {}
    definition = node_registry.get(definition_id) or {}
    inputs = node_ports(definition_id, params, definition, "inputPorts")
    outputs = node_ports(definition_id, params, definition, "outputPorts")
    configured = universal_ports.stored_ports(definition_id, params) is not None
    # A node never configured with no declared ports in a direction takes any
    # handle there (port_contracts.DYNAMIC_PORT_DEFINITION_IDS): Replicate.
    def fits(edge: dict[str, Any]) -> bool:
        if edge.get("source") == node_id and (outputs or configured):
            return edge.get("sourceHandle") in universal_ports.port_ids(outputs)
        if edge.get("target") == node_id and (inputs or configured):
            return edge.get("targetHandle") in universal_ports.port_ids(inputs)
        return True
    orphans = [edge for edge in graph.edges if not fits(edge)]
    if orphans:
        wires = ", ".join(f"{e['source']}.{e['sourceHandle']} → {e['target']}.{e['targetHandle']}" for e in orphans[:6])
        model = universal_ports.model_of(definition_id, params)
        who = name or node_id
        if configured:
            why = f"{who}'s new model {model} doesn't have the ports these connections use"
        elif model:
            why = (f"{reason}, so Nebula can't tell which ports {model} has and {who} keeps only "
                   f"{_basic_ports_line(definition_id, params)}; these connections use others")
        else:
            why = f"Without a model {who} has {_basic_ports_line(definition_id, params)}; these connections use others"
        raise HTTPException(status_code=400, detail=(
            f"{why}: {wires}. Disconnect them in the same edit (`unwire`), or pick a model that takes them."))


def _stage_proposal(
    spec: ProposalSpec,
    *,
    positions: dict[str, dict[str, float]] | None = None,
    base: CLIGraph | None = None,
    what: str = "a proposal",
    models: Mapping[tuple[str, str], Any] | None = None,
    report: dict[str, dict[str, Any]] | None = None,
) -> tuple[CLIGraph, dict[str, str], list[str], list[str]]:
    """Stage a proposal on a clone of the live graph with the cluster validators.

    Returns (candidate, id_map ref→new id, new edge ids, run node ids). Raises
    HTTPException from the same validators create/connect/update use, so a
    proposal that would fail as direct edits fails here, before anything is
    committed. Missing referenced nodes raise 409 (the canvas moved on).
    `base` stages onto an already-staged candidate instead (direct edits
    remove nodes first); `what` names the change in refusals.

    `models` (from _look_up_models) configures each universal node whose
    model the spec sets, as the canvas's picker does: its ports follow the
    model (services/universal_ports.py). A wire to a port that can't be
    known (no key, unknown model) is refused with the reason. `report`, when
    given, gets `ports` {node id: {model, inputs, outputs}} and `notes`
    {node id: reason} for those nodes.
    """
    candidate = base if base is not None else cli_graph.clone()
    for node_id in sorted(spec.references):
        if node_id not in candidate.nodes:
            raise HTTPException(status_code=409, detail=f"{node_id} is no longer on the canvas")
    # node id -> why its model's ports are unknown ("" when they are known).
    configured: dict[str, str] = {}
    # Existing nodes first: their ports can depend on their params.
    for change in spec.params:
        node = candidate.nodes[change.node_id]
        definition_id = str(node.get("definitionId") or "")
        if definition_id == "cinema-scene" and "scene" in change.params:
            raise HTTPException(status_code=400, detail=f"Cinema scenes can't be changed by {what}; edit them in Cinema")
        if uses_durable_recovery(definition_id, provider="worldlabs"):
            raise HTTPException(status_code=400, detail=f"World Labs nodes can't be changed by {what}; add a new node instead")
        _validate_params(definition_id, change.params)
        update = migrate_param_update(definition_id, node.get("params"), _coerce_params(definition_id, change.params))
        model_key = universal_ports.MODEL_PARAM.get(definition_id)
        if models is not None and model_key and model_key in change.params:
            full, reason = universal_ports.agent_update(definition_id, node.get("params") or {}, update, models)
            _drop_outputs_off_ports(candidate, change.node_id, full)
            candidate.set_params(change.node_id, full)
            configured[change.node_id] = reason or ""
        else:
            candidate.update_params(change.node_id, update)
    names = spec.names
    raw_nodes = [
        {
            "tempId": node.ref,
            "definitionId": node.definition_id,
            "params": copy.deepcopy(node.params),
            "position": (positions or {}).get(node.ref) or node.position,
            # A proposal's name for its own new node (canvas_proposals._names).
            **({"label": names[node.ref]} if node.ref in names else {}),
        }
        for node in spec.nodes
    ]
    raw_nodes, raw_edges, _warnings, _folded = _migrate_ingress(
        raw_nodes, [edge.as_dict() for edge in spec.edges], reference_key="tempId")
    configured_refs: dict[str, str] = {}
    for raw in raw_nodes:
        definition_id = str(raw.get("definitionId") or "")
        params = raw.get("params")
        if (models is not None and universal_ports.is_universal(definition_id) and isinstance(params, dict)
                and universal_ports.model_of(definition_id, params)):
            raw["params"], reason = universal_ports.agent_update(definition_id, {}, params, models)
            configured_refs[str(raw.get("tempId"))] = reason or ""
    id_map = _stage_graph_nodes(candidate, raw_nodes, reference_key="tempId", include_outputs=False)
    configured.update({id_map[ref]: reason for ref, reason in configured_refs.items() if ref in id_map})
    new_ids = set(id_map.values())
    refs: dict[str, str] = {node_id: node_id for node_id in candidate.nodes if node_id not in new_ids}
    refs.update(id_map)
    ref_for = {new_id: ref for ref, new_id in id_map.items()}
    # A wire to a port the model's data would have to say exists: refused in
    # plain words when that data can't be read (a missing key, say).
    for raw in raw_edges:
        for end, handle_key, port_key in (("source", "sourceHandle", "outputPorts"),
                                          ("target", "targetHandle", "inputPorts")):
            node_id = refs.get(raw.get(end)) if isinstance(raw.get(end), str) else None
            reason = configured.get(node_id or "")
            if not reason:
                continue
            node = candidate.nodes[node_id]
            definition_id = str(node.get("definitionId") or "")
            ports = node_ports(definition_id, node.get("params"), node_registry.get(definition_id) or {}, port_key)
            handle = raw.get(handle_key)
            if handle not in universal_ports.port_ids(ports):
                name = ref_for.get(node_id, node_id)
                model = universal_ports.model_of(definition_id, node.get("params"))
                raise HTTPException(status_code=400, detail=(
                    f"Can't connect {name}.{handle}: {reason}, so Nebula can't tell which ports {model} has. "
                    f"Until it can, {name} has {_basic_ports_line(definition_id, node.get('params') or {})}."))
    try:
        edge_ids = _stage_graph_edges(candidate, raw_edges, refs)
        for node_id, reason in configured.items():
            _refuse_orphaned_wires(candidate, node_id, reason=reason)
    except HTTPException as exc:
        # The validators name nodes by id; a new node's staged id (n12) means
        # nothing to the agent, which wrote +img.
        detail = exc.detail
        if isinstance(detail, str) and ref_for:
            detail = re.sub(r"\bn\d+\b", lambda match: ref_for.get(match.group(0), match.group(0)), detail)
        raise HTTPException(status_code=exc.status_code, detail=detail) from exc
    if report is not None:
        for node_id, reason in configured.items():
            node = candidate.nodes[node_id]
            definition_id = str(node.get("definitionId") or "")
            stored = universal_ports.stored_ports(definition_id, node.get("params"))
            if stored is not None:
                model = universal_ports.model_of(definition_id, node.get("params"))
                report.setdefault("ports", {})[node_id] = {
                    "model": model,
                    "inputs": universal_ports.port_ids(stored[0]), "outputs": universal_ports.port_ids(stored[1])}
                # A port typed without the model's data saying so (Replicate),
                # or kept before file outputs were typed.
                guessed = universal_ports.stored_port_note(definition_id, node.get("params"))
                if guessed:
                    report.setdefault("notes", {})[node_id] = guessed
            elif reason:
                report.setdefault("notes", {})[node_id] = (
                    f"{reason}, so Nebula can't tell which ports "
                    f"{universal_ports.model_of(definition_id, node.get('params'))} has; until it can, the node has "
                    f"{_basic_ports_line(definition_id, node.get('params') or {})}")
        # A wire this edit makes on a node already there whose port is a guess
        # (a Replicate stamp kept before file outputs were typed, say): the
        # agent learns it now, not from a run that fills another port.
        for raw in raw_edges:
            for end in ("source", "target"):
                node_id = refs.get(raw.get(end)) if isinstance(raw.get(end), str) else None
                node = candidate.nodes.get(node_id or "")
                if node is None or node_id in new_ids or node_id in report.get("notes", {}):
                    continue
                guessed = universal_ports.stored_port_note(str(node.get("definitionId") or ""), node.get("params"))
                if guessed:
                    report.setdefault("notes", {})[node_id] = guessed
    run_ids: list[str] = []
    for item in spec.run:
        if item not in refs:
            raise HTTPException(status_code=400, detail=f"run names '{item[:30]}', which is not on the canvas or in the proposal")
        run_ids.append(refs[item])
    return candidate, id_map, edge_ids, run_ids


def _proposal_run_fingerprint(candidate: CLIGraph, id_map: dict[str, str], run_ids: list[str]) -> dict[str, str]:
    """What the proposal's runs would start on this staged graph, with new
    nodes named by their refs (their ids differ each time it is staged)."""
    ref_for = {new_id: ref for ref, new_id in id_map.items()}
    return approvals.fingerprint(candidate.nodes, candidate.edges, run_ids, name=lambda node_id: ref_for.get(node_id, node_id))


def _outputs_available(outputs: Any) -> bool:
    if not isinstance(outputs, dict):
        return False
    return any(bool(value.get("value") if isinstance(value, dict) else value) for value in outputs.values())


def _proposal_run_scope(
    candidate: CLIGraph, run_ids: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], list[str], bool, list[dict[str, Any]]]:
    """A proposal's run as the cost sees it: the staged graph (nodes, edges),
    the nodes it may start (``chosen``: the targets plus ancestors without
    outputs), every node its pre-call check reads (``scope``), whether
    ancestors are counted (``up_to``), and the chosen nodes as price items."""
    graph_nodes, graph_edges = candidate.to_execute_format()
    nodes = [GraphNode.model_validate(node) for node in graph_nodes]
    edges = [GraphEdge.model_validate(edge) for edge in graph_edges]
    chosen: list[str] = []
    # Every node the run's pre-call check reads, cached ancestors too.
    scope: list[str] = []
    up_to = False
    for target in run_ids:
        sub_nodes, _ = get_subgraph(nodes, edges, target)
        for node in sorted(sub_nodes, key=lambda n: _node_order(n.id)):
            if node.id not in scope:
                scope.append(node.id)
            if node.id in chosen:
                continue
            if node.id not in run_ids:
                if _outputs_available((candidate.nodes.get(node.id) or {}).get("outputs")):
                    continue
                up_to = True
            chosen.append(node.id)
    items = [
        {
            "id": node_id,
            "definitionId": str(candidate.nodes[node_id].get("definitionId") or ""),
            "params": candidate.nodes[node_id].get("params") or {},
        }
        for node_id in chosen
    ]
    return graph_nodes, graph_edges, chosen, scope, up_to, items


async def _measure_proposal_inputs(candidate: CLIGraph, run_ids: list[str]) -> input_sizes.Measured:
    """The proposal estimate's input sizes (_estimate_proposal_run),
    measured in a worker thread from copies of the staged nodes, so the
    event loop serves other requests meanwhile (_measure_run_inputs)."""
    if not run_ids:
        return input_sizes.Measured()
    try:
        pricing = model_pricing.load_pricing()
    except (OSError, ValueError):
        return input_sizes.Measured()
    _graph_nodes, graph_edges, chosen, _scope, _up_to, items = _proposal_run_scope(candidate, run_ids)
    if not input_sizes.needs_measuring(items, pricing):
        return input_sizes.Measured()
    wired = [(str(e.get("source")), e.get("sourceHandle"), str(e.get("target")), e.get("targetHandle"))
             for e in graph_edges if str(e.get("target")) in chosen]
    # The thread reads copies: the staged graph stays this request's own.
    sources = {source for source, _handle, _target, _port in wired}
    known = {node_id: copy.deepcopy(candidate.nodes[node_id]) for node_id in sources if node_id in candidate.nodes}
    return await input_sizes.measure_run(copy.deepcopy(items), wired, pricing, node_registry.get_all(), known)


def _proposal_cost(candidate: CLIGraph, id_map: dict[str, str], run_ids: list[str], *,
                   measured: input_sizes.Measured) -> dict[str, Any]:
    """Which nodes a run after acceptance may start: the targets plus ancestors without outputs.

    Each node is free (utility) or paid (a provider call), with its list
    price when model_pricing.json has one. "Up to" when ancestors are counted,
    because the execution cache may skip them. ``measured`` holds the input
    sizes for prices read from them (_measure_proposal_inputs, awaited first).
    """
    ref_for = {new_id: ref for ref, new_id in id_map.items()}
    definitions = node_registry.get_all()
    # Who would bill a route-table node depends on the keys set (cost_for).
    api_keys = load_settings().get("apiKeys", {}) or {}
    entries: list[dict[str, Any]] = []
    up_to = False
    if run_ids:
        graph_nodes, graph_edges, chosen, scope, up_to, items = _proposal_run_scope(candidate, run_ids)
        estimate = _estimate_proposal_run(items, graph_nodes, graph_edges, definitions, measured)
        for node_id in chosen:
            definition = definitions.get(str(candidate.nodes[node_id].get("definitionId") or ""), {})
            line = (estimate or {}).get("priced", {}).get(node_id)
            entries.append({
                "ref": ref_for.get(node_id, node_id),
                "nodeId": None if node_id in ref_for else node_id,
                **cost_for(definition, candidate.nodes[node_id].get("params") or {}, definitions, api_keys),
                "price": {"low": line["low"], "high": line["high"]} if line else None,
            })
        if estimate:
            estimate = {
                **estimate,
                "unpriced": [ref_for.get(i, i) for i in estimate["unpriced"]],
                "plan": [ref_for.get(i, i) for i in estimate["plan"]],
                "unavailable": {ref_for.get(i, i): why for i, why in (estimate.get("unavailable") or {}).items()},
                "awaitingInput": [ref_for.get(i, i) for i in estimate.get("awaitingInput") or []],
            }
        not_ready = _not_ready_nodes(candidate, graph_edges, scope, ref_for, definitions)
        needs = {row["ref"]: row["missing"] for row in not_ready}
        for entry in entries:
            if entry["ref"] in needs:
                entry["missing"] = needs[entry["ref"]]
        return summarize_cost(entries, up_to=up_to, estimate=estimate, not_ready=not_ready)
    return summarize_cost(entries, up_to=up_to)


def _not_ready_nodes(
    candidate: CLIGraph,
    graph_edges: list[dict[str, Any]],
    node_ids: list[str],
    ref_for: dict[str, str],
    definitions: dict[str, Any],
) -> list[dict[str, Any]]:
    """The nodes of a proposal's run that can't run here as set up: no key,
    no Krea sign-in, a route that can't take it. In the words find_nodes and
    describe_node use (node_readiness.instance_missing), read at the values
    Accept would write. The run after Accept would fail at these nodes."""
    keys = node_readiness.configured_keys(load_settings())
    try:
        krea_signed_in = _krea_connector().status().get("status") == "connected"
    except Exception:  # noqa: BLE001 - an unreadable Krea vault just means not signed in
        krea_signed_in = False
    wired: dict[str, dict[str, int]] = {}
    for edge in graph_edges:
        ports = wired.setdefault(str(edge.get("target")), {})
        handle = str(edge.get("targetHandle") or "")
        ports[handle] = ports.get(handle, 0) + 1
    rows: list[dict[str, Any]] = []
    for node_id in node_ids:
        node = candidate.nodes.get(node_id) or {}
        definition = definitions.get(str(node.get("definitionId") or ""))
        if not definition:
            continue
        need = node_readiness.instance_missing(definition, node.get("params") or {}, keys, krea_signed_in,
                                               definitions, wired.get(node_id, {}))
        if need:
            name = str(node.get("label") or definition.get("displayName") or definition.get("id"))
            rows.append({
                "ref": ref_for.get(node_id, node_id),
                "nodeId": None if node_id in ref_for else node_id,
                "name": name,
                "missing": need,
                # The line the proposal bar and layer show (error copy round
                # 3f): the key by its provider, the node by its name. Agents
                # keep `missing`, find_nodes' words, as before.
                "person": node_readiness.instance_missing_line(
                    definition, node.get("params") or {}, keys, krea_signed_in, definitions,
                    wired.get(node_id, {}), name=name) or need,
            })
    return rows


def _estimate_proposal_run(
    items: list[dict[str, Any]],
    graph_nodes: list[dict[str, Any]],
    graph_edges: list[dict[str, Any]],
    definitions: dict[str, Any],
    measured: input_sizes.Measured,
) -> dict[str, Any] | None:
    """List-price estimate for a proposal's run; None when the table can't load.
    ``measured`` are the input sizes for a price read from an upload or an
    ancestor's existing output (_measure_proposal_inputs)."""
    try:
        pricing = model_pricing.load_pricing()
    except (OSError, ValueError):
        return None
    api_keys = load_settings().get("apiKeys", {}) or {}
    multipliers = model_pricing.run_multipliers(
        [{"id": n.get("id"), "definitionId": n.get("definitionId"), "params": n.get("params") or {}}
         for n in graph_nodes],
        [(str(e.get("source")), str(e.get("target"))) for e in graph_edges],
    )
    wired = model_pricing.wired_counts(
        items, [(str(e.get("source")), str(e.get("target")), e.get("targetHandle")) for e in graph_edges])
    # Measured from the file the run would get: an upload, or an ancestor's
    # output that already exists (it isn't in the run: see _proposal_cost).
    return model_pricing.estimate_run(items, pricing, definitions, api_keys, multipliers, wired, measured.sizes)


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
    params?: [{nodeId, params}], run?: [ref or node id], rename?: {"+up": name}}
    (names for the proposal's own new nodes only). Nothing changes on the
    canvas until the person accepts in Nebula.
    """
    headers = current_request_headers()
    identity = identify_agent(headers)
    if identity is None:
        if is_person(headers):
            raise HTTPException(status_code=403, detail="The person doesn't need to propose; edit directly")
        raise HTTPException(status_code=400, detail="Name yourself with NEBULA_AGENT_NAME or --as")
    fence = _graph_fence()
    await _sweep_proposals()
    _validate_graph_ingress_complexity(body)
    try:
        # A proposal is where an agent asks to change who bills a node
        # (_provider, _kreaAuth): direct edits refuse that (_refuse_agent_billing_change).
        spec = parse_spec(body, internal_ok=BILLING_PARAMS, ports=_wire_end_ports)
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    for node in spec.nodes:
        _check_krea_auth(node.definition_id, node.params, node.ref)
        _check_provider(node.definition_id, node.params, node.ref)
        _check_asset_refs(node.definition_id, node.params, node.ref, must_exist=True)
    for change in spec.params:
        current = cli_graph.nodes.get(change.node_id) or {}
        _check_krea_auth(str(current.get("definitionId") or ""), change.params, change.node_id)
        _check_provider(str(current.get("definitionId") or ""), change.params, change.node_id)
        _check_asset_refs(str(current.get("definitionId") or ""), change.params, change.node_id,
                          before=current.get("params") or {}, must_exist=True)
    models = await _look_up_models(_spec_models_wanted(spec))
    _refuse_if_graph_moved(fence)  # staged on, and made for, the canvas the agent read
    try:
        candidate, id_map, _edge_ids, run_ids = _stage_proposal(spec, models=models)
    except HTTPException as exc:
        # A missing node is a bad proposal here (the agent's view is stale), not a conflict.
        raise HTTPException(status_code=400 if exc.status_code == 409 else exc.status_code,
                            detail=exc.detail) from exc
    known, visible_area = _proposal_layout_hints()
    positions = place_new_nodes(spec, known, visible_area)
    measured = await _measure_proposal_inputs(candidate, run_ids)
    _refuse_if_graph_moved(fence)
    cost = _proposal_cost(candidate, id_map, run_ids, measured=measured)
    run_fingerprint = _proposal_run_fingerprint(candidate, id_map, run_ids)
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
            run_fingerprint=run_fingerprint,
        )
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    # Which node it reads under each id, so only a delete of that very node tags it (second review).
    proposal.lineage = {node_id: node_removals.lineage(proposal.project_id, node_id) for node_id in spec.references}
    first_reference = next(iter(sorted(proposal.references, key=_node_order)), None)
    _journal(  # in the step that made it, before any await (round 8 of PR #114)
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
    await _post_canvas_update(proposal)  # Q112 a: the person hears of it on every screen
    view = _proposal_view(proposal)
    # The agent's other open proposals here that can't run: Justin (Q109)
    # keeps them, and the agent is told to withdraw one this replaces.
    still_open = [{"id": p.id, "note": p.spec.note} for p in canvas_proposals.open_unrunnable(proposal)]
    if not proposal.is_open:
        # It closed while its Update was being written (see
        # _post_canvas_update): the canvas already heard proposalClosed, so
        # it never gets it as open (Accept would only fail). The agent reads
        # the real status, and its reason, in the view; agent_wording gives a
        # closed one no readiness warning, but still names the agent's others.
        return agent_wording({"proposal": view, **({"stillOpen": still_open} if still_open else {})})
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
        await _show_agent(target, action="click", say=spec.note,
                          did=_did("Proposed", target.get("nodeId")))
    # Nodes of the run that can't run here, so the agent can say so or pick
    # another model before the person accepts (the canvas shows it too), and
    # the call that withdraws this one or an earlier one this replaces.
    return agent_wording({"proposal": view, **({"stillOpen": still_open} if still_open else {})})


@app.get("/api/canvas/proposals")
async def list_canvas_proposals() -> dict[str, Any]:
    """Open proposals waiting for the person (never their accept keys)."""
    await _sweep_proposals()
    return {"proposals": [_proposal_view(p) for p in canvas_proposals.open_list()]}


def _gone_proposal_detail(proposal_id: str) -> str:
    """A proposal Nebula no longer has: decided ones go after 30 minutes, and
    open ones live in memory, so a restart closes them (Q108 a)."""
    return (f"No proposal {proposal_id[:20]} (decided proposals are kept for 30 minutes, and a restart of "
            "Nebula closes open ones: propose again if you still want it)")


@app.get("/api/canvas/proposals/{proposal_id}")
async def get_canvas_proposal(proposal_id: str, request: Request) -> dict[str, Any]:
    """One proposal; with ?wait=<seconds> (≤25) wait for the person to decide."""
    wait = _query_number(request.query_params.get("wait"), "wait", integer=False, low=0, high=None) or 0.0
    wait = min(wait, 25.0)
    await _sweep_proposals()
    proposal = canvas_proposals.get(proposal_id)
    if proposal is None and asset_proposals.get(proposal_id) is not None:
        return await _get_asset_proposal(proposal_id, wait, request)  # a project's or a board's (U16)
    if proposal is None:
        raise refusal_copy.not_found(_gone_proposal_detail(proposal_id), "proposal", "proposals")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait
    cursor = canvas_events.latest
    while proposal.is_open:
        # Expiry is only noticed by a sweep, so never sleep past it.
        remaining = min(deadline - loop.time(), proposal.expires_at - canvas_proposals.now() + 0.05)
        if remaining <= 0:
            break
        try:
            result = await _journal_wait(request, after=cursor, journal=canvas_events.journal_id,
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
    if proposal is None and asset_proposals.get(proposal_id) is not None:
        return await _withdraw_asset_proposal(proposal_id, identity)  # a project's or a board's (U16)
    if proposal is None:
        raise refusal_copy.not_found(f"No proposal {proposal_id[:20]}", "proposal", "proposals")
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

    1. No agent markers and this launch's person token.
    2. The per-proposal accept key, which only sockets that said hello with
       the person token ever received.
    3. Still open, and for the project that is open now.
    """
    headers = current_request_headers()
    require_person(headers)
    lower = {k.lower(): v for k, v in (headers or {}).items()}
    supplied = lower.get(_PROPOSAL_KEY_HEADER) or ""
    proposal = canvas_proposals.get(proposal_id)
    if proposal is None:
        raise refusal_copy.not_found("This proposal is no longer available", "proposal", "proposals")
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


def _refuse_changed_runs(proposal: Proposal, candidate: CLIGraph, id_map: dict[str, str], run_ids: list[str]) -> None:
    """409 when what the proposal's runs would start has changed since it was
    proposed: a node's settings, its wires in, or a node gone. The person is
    deciding on the runs and cost the proposal showed, not on newer values."""
    now = _proposal_run_fingerprint(candidate, id_map, run_ids)
    changed = approvals.changed_nodes(proposal.run_fingerprint, now)
    if changed:
        raise HTTPException(status_code=409, detail=(
            f"what it runs changed after it was proposed ({_listed(sorted(changed, key=_node_order), 4)})"))


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
        # Parsed whatever the content type, so a text/plain body skips
        # JsonNumberGuard: check its numbers here.
        body = loads_checked(raw)
    except JsonNumberOutOfRange as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
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
    fence = _graph_fence()
    proposal = await _decidable_proposal(proposal_id)
    _check_workspace_revision()
    body = await _proposal_body(request)
    # The models it sets, read now: nothing below may await.
    models = await _look_up_models(_spec_models_wanted(proposal.spec))
    # Reading the body can yield to the event loop, and in that gap the agent
    # may withdraw, the sweep may expire it, or a second tab may accept it.
    # Check again here. From this line to close() below nothing awaits, so no
    # other request can decide this proposal while it is being applied.
    _ensure_still_decidable(proposal)
    _refuse_if_graph_moved(fence)  # the person's canvas, as they saw it (a switch away and back too)
    try:
        dragged = clean_positions(body.get("positions"), proposal.spec.refs)
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    positions = {**proposal.positions, **dragged}
    staging_error: HTTPException | None = None
    with _paid_graph_mutation("accept a proposal"):
        try:
            _refuse_overwriting_later_edits(proposal)
            candidate, id_map, edge_ids, run_ids = _stage_proposal(proposal.spec, positions=positions, models=models)
            _refuse_changed_runs(proposal, candidate, id_map, run_ids)
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
    # Still before any await: from here no agent edit can change what the
    # canvas is about to run, and the run must match it value for value.
    approval = run_approvals.grant(
        proposal_id=proposal.id,
        agent_name=proposal.agent.name,
        run_node_ids=run_ids,
        fingerprint=approvals.fingerprint(cli_graph.nodes, cli_graph.edges, run_ids),
        shape=_approval_shape(cli_graph, run_ids),
    ) if run_ids else None
    # Journaled here, before any await (round 8 of PR #114): each event names
    # the project the accept changed and reads the canvas as it left it.
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
    # Each names the proposal in data: nebula-mcp --channel leaves these out
    # of the person's edits by that field, never by the summary's note.
    _journal_cluster(list(id_map.values()), edge_ids, actor=person, note=note, proposal_id=proposal.id)
    for change in proposal.spec.params:
        before = (proposal.existing.get(change.node_id) or {}).get("params") or {}
        changes = param_changes(before, (cli_graph.nodes.get(change.node_id) or {}).get("params") or {})
        if changes:
            _journal(
                "node.params",
                node_id=change.node_id,
                data={**changes, "proposalId": proposal.id},
                summary=f"set {_listed(changes['keys'], 4)} on {_node_label(change.node_id)} ({change.node_id}){note}",
                actor=person,
            )
    all_defs = node_registry.get_all()
    updated = [
        _cli_node_to_rf(cli_graph.nodes[node_id], cli_graph.nodes[node_id].get("position") or {"x": 0.0, "y": 0.0}, all_defs)
        for node_id in [change.node_id for change in proposal.spec.params]
        if node_id in cli_graph.nodes
    ]
    created = _rf_created(list(id_map.values()), edge_ids)
    await _broadcast_graph_sync(edit=True)
    publish_action(f"Accepted {proposal.agent.name}'s proposal ({len(id_map)} nodes)")
    try:
        await manager.broadcast_raw(_proposal_closed_message(proposal))
    except Exception:  # noqa: BLE001
        pass
    await _follow_canvas_updates([proposal], actor=person)
    focus = next(iter(id_map.values()), None) or next(iter(sorted(proposal.references, key=_node_order)), None)
    if focus is not None:
        try:
            event = _point(proposal.agent, target={"nodeId": focus}, action="click", say="Accepted",
                           did=_did("Proposed", focus))
            await manager.broadcast_raw(event)
        except Exception:  # noqa: BLE001 - the cursor is decoration on a committed change
            pass
    return {
        "status": "accepted",
        "proposalId": proposal.id,
        "idMap": id_map,
        "runNodeIds": run_ids,
        # Only the person's canvas gets this; it sends it with the run it starts.
        "approvalId": approval.id if approval is not None else None,
        **created,
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


@app.delete("/api/canvas/approvals/{approval_id}")
async def release_run_approval(approval_id: str) -> dict[str, Any]:
    """The person let go of a run they approved on Accept (dismissed the held
    run, or the canvas didn't start it). The nodes it locked are free again."""
    require_person(current_request_headers())
    return {"status": "released" if run_approvals.drop(approval_id) else "not_found"}


# ---------- Questions: agents ask, the person answers (Q125 item 1) ----------
#
# Justin, 2026-10-24: "Yes, all four, in that order"; then "go with your
# suggestions". Modelled on the canvas proposals above: open caps, the same
# two-layer person gate (require_person, then a per-set key only the
# person's browser sockets get, in the proposal key's header), and an Update
# that settles when the set closes. Unlike proposals, sets are kept on the
# project record (services/agent_questions.py), so a restart keeps them open
# with their answers to come; the key is new each launch. Every surface (MCP
# ask_person, `nebula ask`, HTTP) asks through create_agent_questions.

def _question_view(question_set: QuestionSet) -> dict[str, Any]:
    return agent_questions.view(question_set)


def _question_http_error(exc: QuestionError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)


def _questions_sync_message() -> dict[str, Any]:
    """For the person's sockets only, after hello: every open set with its
    key, and the recently closed ones (their answers included, for the
    closed view; the person wrote them)."""
    return {
        "type": "questionsSync",
        "sets": [{**_question_view(s), "answerKey": s.answer_key} for s in agent_questions.open_list()]
        + [_question_view(s) for s in agent_questions.closed_list()],
    }


async def _send_questions_sync(websocket: WebSocket) -> None:
    """The person's socket after hello. Not sent when the sets can't be read
    (the catalog is unavailable): an empty sync would drop the tab's drafts."""
    try:
        message = _questions_sync_message()
    except ProjectStoreError:
        return
    await websocket.send_text(json.dumps(message))


def _journal_question(question_set: QuestionSet, *, actor: dict[str, Any] | None = None) -> None:
    # Tagged with the project the set is kept on (round 8 of PR #114).
    """One journal event per step. Never the questions' text nor the
    answers: every agent on the canvas reads the journal."""
    kind = "asked" if question_set.is_open else question_set.status
    count = len(question_set.spec.questions)
    noun = "question" if count == 1 else "questions"
    summaries = {
        "asked": f"asked the person {count} {noun} ({question_set.id})",
        "answered": f"answered {question_set.agent.name}'s {noun} ({question_set.id})",
        "dismissed": f"dismissed {question_set.agent.name}'s {noun} ({question_set.id})",
        "withdrawn": f"withdrew its {noun} ({question_set.id})",
    }
    _journal(f"question.{kind}", node_id=next(iter(question_set.spec.node_ids), None),
             data={"questionId": question_set.id, "agentId": question_set.agent.id, "count": count},
             summary=summaries[kind], actor=actor, project_id=question_set.project_id)


def _gone_question_detail(set_id: str) -> str:
    """A set Nebula doesn't have for this agent: another agent's, closed too
    long ago, or gone with its project (deleted for good). Open sets survive
    a restart: they are kept with the project."""
    return (f"No question set {set_id[:20]} of yours (closed ones are kept for 30 minutes, and a project deleted "
            "for good takes its sets with it): ask again if you still need to know")


def _questions_owner(set_id: str) -> tuple[AgentIdentity, QuestionSet]:
    """The asking agent's own set, or 404 (another agent's set is not there for it)."""
    identity = identify_agent(current_request_headers())
    if identity is None:
        raise HTTPException(status_code=400, detail="Name yourself with NEBULA_AGENT_NAME or --as")
    question_set = agent_questions.get(set_id)
    if question_set is None or question_set.agent.id != identity.id:
        raise refusal_copy.not_found(_gone_question_detail(set_id), "question", "questions")
    return identity, question_set


async def _post_question_update(question_set: QuestionSet) -> bool:
    """Its Update on the project's list, with Answer: where the person answers
    it. The set is saved on the project's record in the same commit."""
    book = agent_questions

    def save_set(catalog: dict[str, Any], project_id: str, note_id: str) -> bool:
        question_set.project_id = project_id
        question_set.update = {"id": note_id, "projectId": project_id}
        return book.write_into(catalog, [project_id])

    try:
        result = await asyncio.to_thread(
            agent_notes.post_questions, author={"kind": "agent", **question_set.agent.as_dict()},
            text=question_update_text(question_set), questions={"id": question_set.id},
            refs=list(question_set.spec.node_ids), project_id=question_set.project_id, save_set=save_set)
    except (NoteError, ProjectStoreError):
        question_set.update = None  # never committed: no later save may keep it
        return False
    note = result["note"]
    # Saved by a worker thread: tagged with the project it went to, journaled
    # before the broadcast's await (round 8 of PR #114).
    _journal_note(note, "canvas", project_id=result["projectId"])
    _journal_question(question_set)  # asked: with its Update, before the broadcast's await
    await _broadcast_raw_quietly(_notes_message("canvas", "added", project_id=result["projectId"], note=note,
                                                unread=result["unread"], removed=result["removed"]))
    return True


def _question_resolved_by(question_set: QuestionSet) -> dict[str, Any]:
    if question_set.status == "withdrawn":
        return {"kind": "agent", "name": question_set.agent.name}
    return {"kind": "person"}


async def _follow_question_updates(sets: list[QuestionSet]) -> None:
    """Closed sets: each one's Update says how it ended and is read, so its Answer goes."""
    for question_set in sets:
        ref = question_set.update
        if not ref or question_set.is_open:
            continue
        try:
            result = await asyncio.to_thread(agent_notes.resolve_questions, ref["projectId"], ref["id"],
                                             outcome=question_outcome_line(question_set),
                                             by=_question_resolved_by(question_set))
        except (NoteError, ProjectStoreError):
            continue
        if result is None:
            continue
        if result["projectId"] == _open_project_id():
            await _broadcast_raw_quietly(_notes_message("canvas", "resolved", project_id=result["projectId"],
                                                        ids=[ref["id"]], note=result["note"], unread=result["unread"]))


async def _announce_closed_questions(sets: list[QuestionSet], *, actor: dict[str, Any] | None = None) -> None:
    """Journal each, tell the person's sockets (only theirs: the message
    carries their answers back to them), then settle each one's Update.
    Every event first, before any await (round 8 of PR #114)."""
    for question_set in sets:
        _journal_question(question_set, actor=actor)
    for question_set in sets:
        try:
            await manager.broadcast_browser({"type": "questionsClosed", "questionId": question_set.id,
                                             "status": question_set.status, "agentId": question_set.agent.id,
                                             "set": _question_view(question_set)})
        except Exception:  # noqa: BLE001 - a browser that missed it gets questionsSync on reconnect
            pass
    await _follow_question_updates(sets)


@app.post("/api/canvas/questions", status_code=201)
async def create_agent_questions(body: dict[str, Any]) -> Any:
    """An agent asks the person 1-5 questions; they answer in Nebula's Updates.

    Body: {questions: [{text, options?, multiple?, allowText?}], note?,
    nodeIds?}. Posts an Update with Answer on the open project's list.
    Answers come back only to this agent (GET /api/canvas/questions/{id})."""
    headers = current_request_headers()
    identity = identify_agent(headers)
    if identity is None:
        if is_person(headers):
            raise HTTPException(status_code=403, detail="The person doesn't need to ask: these questions are for them")
        raise HTTPException(status_code=400, detail="Name yourself with NEBULA_AGENT_NAME or --as")
    try:
        spec = parse_questions(body)
    except QuestionError as exc:
        raise _question_http_error(exc) from exc
    # Like an Update's refs: unknown ones are dropped and listed, never guessed.
    kept = [node_id for node_id in spec.node_ids if node_id in cli_graph.nodes]
    dropped = [node_id for node_id in spec.node_ids if node_id not in kept]
    spec = dataclasses.replace(spec, node_ids=tuple(kept))
    project_id = _workspace_context()["activeProjectId"]
    if not project_id:
        raise HTTPException(status_code=409, detail=(
            "Open or create a project first: the person answers questions from its Updates, which are kept "
            "with a project"))
    try:
        question_set = agent_questions.create(agent=identity, project_id=project_id, spec=spec)
    except QuestionError as exc:
        if exc.status == 429:
            return JSONResponse(status_code=429, content={
                "detail": exc.detail, "code": "questions_open_limit",
                "stillOpen": still_open_rows(exc.still_open, withdraw=QUESTIONS_WITHDRAW_HTTP)})
        raise _question_http_error(exc) from exc
    if not await _post_question_update(question_set):
        # No Update, no Answer: the person couldn't reach it, so it isn't kept.
        agent_questions.drop(question_set.id)
        raise HTTPException(status_code=409, detail=(
            "Couldn't post the questions' Update on the open project, so nothing was asked; try again"))
    if not question_set.is_open:
        # Withdrawn while its Update was being written: settle that now.
        await _follow_question_updates([question_set])
    else:
        try:
            await manager.broadcast_browser({"type": "questionsOpened", "set": _question_view(question_set),
                                             "answerKey": question_set.answer_key})
        except Exception:  # noqa: BLE001 - a browser that missed it gets questionsSync on reconnect
            pass
    return {"questions": _question_view(question_set), **({"dropped": dropped} if dropped else {})}


@app.get("/api/canvas/questions/{set_id}")
async def get_agent_questions(set_id: str, request: Request) -> dict[str, Any]:
    """Your own question set; with ?wait=<seconds> (≤25) wait for the person."""
    wait = _query_number(request.query_params.get("wait"), "wait", integer=False, low=0, high=None) or 0.0
    wait = min(wait, 25.0)
    _identity, question_set = _questions_owner(set_id)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait
    cursor = canvas_events.latest
    while question_set.is_open:
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        try:
            result = await _journal_wait(request, after=cursor, journal=canvas_events.journal_id,
                                         wait=remaining, kinds={"question"})
        except TooManyWaiters as exc:
            raise HTTPException(status_code=429, detail=str(exc)) from exc
        cursor = result.get("cursor", cursor)
        if result.get("timedOut") and deadline - loop.time() <= 0:
            break
    return {"questions": _question_view(question_set)}


@app.delete("/api/canvas/questions/{set_id}")
async def withdraw_agent_questions(set_id: str) -> dict[str, Any]:
    """The asking agent takes its questions back."""
    _identity, question_set = _questions_owner(set_id)
    try:
        await asyncio.to_thread(agent_questions.close, question_set.id, "withdrawn")
    except QuestionError as exc:
        raise _question_http_error(exc) from exc
    await _announce_closed_questions([question_set])
    return {"questions": _question_view(question_set)}


def _answerable_questions(set_id: str) -> QuestionSet:
    """The person-only checks shared by answer and dismiss, in order, as
    accepting a proposal (_decidable_proposal):

    1. No agent markers and this launch's person token.
    2. The set's answer key, which only sockets that said hello with the
       person token ever received (sent in the proposal key's header).
    3. Still open."""
    headers = current_request_headers()
    require_person(headers)
    lower = {k.lower(): v for k, v in (headers or {}).items()}
    supplied = lower.get(_PROPOSAL_KEY_HEADER) or ""
    question_set = agent_questions.get(set_id)
    if question_set is None:
        raise refusal_copy.not_found("These questions are no longer available", "question", "questions")
    if not supplied or not secrets.compare_digest(supplied.encode(), question_set.answer_key.encode()):
        raise HTTPException(status_code=403, detail="These questions can only be answered from the Nebula canvas.")
    _ensure_questions_open(question_set)
    return question_set


def _ensure_questions_open(question_set: QuestionSet) -> None:
    if not question_set.is_open:
        raise HTTPException(status_code=409, detail=f"These questions are already {question_set.status}")


@app.post("/api/canvas/questions/{set_id}/answer")
async def answer_agent_questions(set_id: str, request: Request) -> dict[str, Any]:
    """The person answers. Body: {answers: [{questionId, choices?, text?}]};
    a question left out is blank, and at least one must be answered."""
    question_set = _answerable_questions(set_id)
    body = await _proposal_body(request)
    # Reading the body can yield: the agent may have withdrawn meanwhile.
    _ensure_questions_open(question_set)
    try:
        answers = parse_question_answers(question_set.spec, body)
    except QuestionError as exc:
        raise _question_http_error(exc) from exc
    # Saved before the answer is acknowledged; a failed save leaves it open.
    try:
        await asyncio.to_thread(agent_questions.close, question_set.id, "answered", answers=answers)
    except QuestionError as exc:
        raise _question_http_error(exc) from exc
    await _announce_closed_questions([question_set], actor=dict(_PERSON_ACTOR))
    return {"status": "answered", "questionId": question_set.id}


@app.post("/api/canvas/questions/{set_id}/dismiss")
async def dismiss_agent_questions(set_id: str) -> dict[str, Any]:
    """The person closes the questions without answering."""
    question_set = _answerable_questions(set_id)
    try:
        await asyncio.to_thread(agent_questions.close, question_set.id, "dismissed")
    except QuestionError as exc:
        raise _question_http_error(exc) from exc
    await _announce_closed_questions([question_set], actor=dict(_PERSON_ACTOR))
    return {"status": "dismissed", "questionId": question_set.id}


# ---------- Asset proposals: changes outside the graph (U16) ----------
#
# The canvas proposals' life cycle and accept gate for a project's cover and
# a board's Send notes (services/asset_proposals.py). Accept applies the
# change through the route the person's own click uses (the cover route, the
# board PUT), as the person.

# Proposals being applied right now: an agent can't withdraw one and the
# sweep leaves it alone until Accept has closed it.
_asset_deciding: set[str] = set()
_ASSET_WAIT_KINDS = {"proposal", "project", "board", "commons"}


def _asset_proposal_view(proposal: AssetProposal) -> dict[str, Any]:
    return asset_proposals.view(proposal)


def _asset_proposal_closed_message(proposal: AssetProposal) -> dict[str, Any]:
    # Every socket gets it, agents' too: a commons proposal's reason (the
    # person's words) reaches only those who may read it (get_proposal).
    return {"type": "assetProposalClosed", "proposalId": proposal.id, "status": proposal.status,
            "reason": None if proposal.kind == "commons" else proposal.reason, "kind": proposal.kind,
            "targetId": proposal.target_id}


def _asset_journal_data(proposal: AssetProposal) -> dict[str, Any]:
    data = {"proposalId": proposal.id, "agentId": proposal.agent.id, "kind": proposal.kind,
            "targetId": proposal.target_id, "targetName": proposal.target_name, "note": proposal.note}
    if proposal.kind == "commons":
        # Every agent on the canvas reads the journal, whatever its brand; the
        # note and the person's reason reach only those who see the reference.
        data.pop("note")
    return data


async def _announce_closed_asset_proposals(proposals: list[AssetProposal], *,
                                           actor: dict[str, Any] | None = None) -> None:
    """Journal and broadcast asset proposals that just closed: every event
    first, before any await (round 8 of PR #114)."""
    for proposal in proposals:
        reason = f": {proposal.reason}" if proposal.reason and proposal.kind != "commons" else ""
        _journal(
            f"proposal.{proposal.status}",
            data={**_asset_journal_data(proposal), "reason": proposal.reason if proposal.kind != "commons" else None},
            summary=f"{proposal.status} {proposal.agent.name}'s proposal {proposal.id}{reason}",
            actor=actor,
        )
    for proposal in proposals:
        try:
            await manager.broadcast_raw(_asset_proposal_closed_message(proposal))
        except Exception:  # noqa: BLE001 - the screens also hide expired proposals locally
            pass
    await _follow_asset_updates(proposals)


# ---- the Update each asset proposal posts (Justin's Q92 a, 2026-10-21) ----
#
# "Keep the wording, and each proposal also posts an Update ("Claude Code asks
# to change the cover of X", with Review)." Posted on the open project's
# Updates (the corner on the canvas), the way Nebula posts its own updates,
# attributed to the agent; one per agent and target. When the proposal closes
# the Update says how and is read.

_RESOLVED_BY = {"accepted": {"kind": "person"}, "rejected": {"kind": "person"}}


async def _post_asset_update(proposal: AssetProposal) -> None:
    try:
        result = await asyncio.to_thread(
            agent_notes.post_proposal, author={"kind": "agent", **proposal.agent.as_dict()},
            text=asset_update_text(proposal),
            proposal={"id": proposal.id, "kind": proposal.kind, "targetId": proposal.target_id})
    except (NoteError, ProjectStoreError):
        return  # no project open: the Agent log line is the only notice, as before
    note = result["note"]
    ref = {"id": note["id"], "projectId": result["projectId"]}
    # The agent's earlier open proposals on this target share the one Update.
    for other in asset_proposals.open_list():
        if isinstance(other, AssetProposal) and _same_asker(other, proposal):
            other.update = dict(ref)
    proposal.update = dict(ref)
    # Saved by a worker thread: tagged with the project it went to, journaled
    # before the broadcast's await (round 8 of PR #114).
    _journal_note(note, "canvas", project_id=result["projectId"])
    await _broadcast_raw_quietly(_notes_message("canvas", "added", project_id=result["projectId"], note=note,
                                                unread=result["unread"], removed=result["removed"]))


def _same_asker(one: AssetProposal, other: AssetProposal) -> bool:
    return one.agent.id == other.agent.id and one.kind == other.kind and one.target_id == other.target_id


async def _follow_asset_updates(proposals: list[AssetProposal]) -> None:
    """Closed proposals: each one's Update says how it ended, unless the same
    agent still has another proposal open on that target (the Update then
    reviews that one)."""
    for proposal in proposals:
        ref = proposal.update
        if not ref or proposal.is_open:
            continue
        waiting = [p for p in asset_proposals.open_list()
                   if isinstance(p, AssetProposal) and _same_asker(p, proposal) and p.update == ref]
        try:
            if waiting:
                newest = max(waiting, key=lambda p: p.created_at)
                result = await asyncio.to_thread(agent_notes.retarget_proposal, ref["projectId"], ref["id"], newest.id)
                op, extra = "changed", {}
            else:
                by = _RESOLVED_BY.get(proposal.status) or (
                    {"kind": "agent", "name": proposal.agent.name} if proposal.status == "withdrawn" else {"kind": "system"})
                result = await asyncio.to_thread(agent_notes.resolve_proposal, ref["projectId"], ref["id"],
                                                 outcome=asset_outcome_line(proposal), by=by)
                op, extra = "resolved", ({"unread": result["unread"]} if result else {})
        except (NoteError, ProjectStoreError):
            continue
        if result is None:
            continue
        # Only the open project's list is on the person's screen; another
        # project's reloads with it when they open it.
        if result["projectId"] == _open_project_id():
            await _broadcast_raw_quietly(_notes_message("canvas", op, project_id=result["projectId"],
                                                        ids=[ref["id"]], note=result["note"], **extra))


async def _asset_proposal_misfit(proposal: AssetProposal, exported: dict[str, Any] | None = None) -> str | None:
    """Why the proposal no longer fits its target, or None while it does."""
    if proposal.kind == "commons":
        return await _commons_proposal_misfit(proposal)
    if proposal.kind == "project":
        catalog = project_store.read()
        project = catalog["projects"].get(proposal.target_id)
        if project is None:
            return "the project was deleted"
        return _cover_proposal_misfit(proposal, project, _cover_images_now(project, catalog, exported))
    try:
        board = await asyncio.to_thread(_moodboard_store().get, proposal.target_id)
    except ValueError:
        board = None
    if board is None:
        return "the board was deleted"
    if board.get("sendNotes") is True:
        return "Send notes to generators is already on"
    return None


def _cover_proposal_misfit(proposal: AssetProposal, project: Mapping[str, Any],
                           images: Mapping[str, Any]) -> str | None:
    """A cover proposal against its project (``images``: its snapshot as it is
    now), refreshing what its view shows: a lost pin and the automatic cover."""
    if _cover_state(project) != proposal.before:
        return "the project's cover changed since it was proposed"
    # The pin it was proposed against may have lost its image, or got it back (Q90 a).
    proposal.lost_pin = _lost_pin(project, images)
    proposal.auto_cover = _automatic_cover(images)
    url = proposal.change.get("cover")
    if url is None and proposal.lost_pin:
        # "Back to automatic" against a pin whose image is gone changes
        # nothing (a new one is refused with 409); Accepting it would only
        # drop the stored pin an undo brings back.
        return "the project's cover is already the automatic one"
    if url is not None and not project_cover.is_choice(dict(images), url):
        return "that image is no longer one of the project's images"
    return None


async def _sweep_asset_proposals() -> None:
    """Expire overdue asset proposals and invalidate those whose target moved
    on (another cover pinned, the project or board deleted, notes already
    sent). Called before every asset proposal read and decision, after a
    cover change, and on each proposal's expiry timer (_schedule_asset_expiry)."""
    try:
        expired = [p for p in asset_proposals.sweep() if isinstance(p, AssetProposal)]
    except Exception:  # noqa: BLE001 - never fail a read over housekeeping
        return
    misfits: list[AssetProposal] = []
    waiting = [p for p in asset_proposals.open_list() if p.id not in _asset_deciding]
    exported = None
    if any(p.kind == "project" for p in waiting):
        try:
            exported = await _projects_live_export()
        except Exception:  # noqa: BLE001 - checked against the saved snapshot then
            exported = None
    for proposal in waiting:
        try:
            reason = await _asset_proposal_misfit(proposal, exported)
            if reason and proposal.is_open and proposal.id not in _asset_deciding:
                asset_proposals.close(proposal.id, "invalidated", reason=reason)
                misfits.append(proposal)
        except Exception:  # noqa: BLE001 - one odd target never blocks the rest
            continue
    await _announce_closed_asset_proposals(expired + misfits, actor=dict(_SYSTEM_ACTOR))


# ---- on time, not on the next read (review of Q92 a) ----
#
# The sweep above runs when something reads proposals. An agent that proposes
# and stops, with the person on the canvas, reads nothing: without a timer the
# Update would keep "waiting for your OK" and a live Review past expiry.

_asset_expiry_tasks: set[asyncio.Task[Any]] = set()


def _call_later(delay: float, callback: Callable[..., Any], *args: Any) -> None:
    """A timer that outlives the request arming it runs in a fresh context:
    loop.call_later would copy the request's (its _canvas_edit_link, the
    caller's headers), and an expiry armed inside an undo then journaled
    proposal.expired under that undo's edit tag, for every proposal its sweep
    closed (review 9 of PR #114). The task it starts inherits the fresh one."""
    asyncio.get_running_loop().call_later(delay, callback, *args, context=Context())


def _schedule_asset_expiry(proposal: AssetProposal) -> None:
    """Check the proposal just after it is due (asset_proposals' clock)."""
    delay = max(0.0, proposal.expires_at - asset_proposals.now()) + 0.5
    try:
        _call_later(delay, _start_asset_expiry_check, proposal.id)
    except RuntimeError:  # no running loop (a script): the next read sweeps
        pass


def _start_asset_expiry_check(proposal_id: str) -> None:
    task = asyncio.get_running_loop().create_task(_asset_expiry_check(proposal_id))
    _asset_expiry_tasks.add(task)
    task.add_done_callback(_asset_expiry_tasks.discard)


async def _asset_expiry_check(proposal_id: str) -> None:
    await _sweep_asset_proposals()
    proposal = asset_proposals.get(proposal_id)
    if isinstance(proposal, AssetProposal) and proposal.is_open:
        _schedule_asset_expiry(proposal)  # its expiry moved out (an accept under way)


_ASSET_UPDATE_KINDS = ("project", "moodboard", "commons")


async def _settle_proposal_updates() -> None:
    """Before the open project's Updates are listed: sweep, then resolve any
    proposal Update (an asset proposal's, or a canvas proposal's since
    Justin's Q112 a) whose proposal can no longer be decided. Proposals live
    in memory and Updates on the project, so after a restart an Update can
    outlive its proposal; its Review would lead nowhere. Runs on list_notes,
    on a tab's socket connect and on a project switch."""
    await _sweep_asset_proposals()
    await _sweep_proposals()
    try:
        listing = await asyncio.to_thread(agent_notes.canvas_list)
    except (NoteError, ProjectStoreError):
        return
    project_id = listing.get("projectId")
    for note in listing.get("notes") or []:
        if note.get("about") == "question":
            # A question set's Update (Q125 item 1): the same rule, with GM's line for a restart.
            await _settle_question_update(project_id, note)
            continue
        ref = note.get("proposal")
        if (note.get("about") != "proposal" or note.get("source") != "nebula" or note.get("resolvedAt")
                or not isinstance(ref, Mapping)):
            continue
        kind = ref.get("kind")
        if kind in _ASSET_UPDATE_KINDS:
            proposal: Any = asset_proposals.get(str(ref.get("id") or ""))
            known = isinstance(proposal, AssetProposal)
        elif kind == "canvas":
            proposal = canvas_proposals.get(str(ref.get("id") or ""))
            known = isinstance(proposal, Proposal)
        else:
            continue
        if known and proposal.is_open:
            continue
        # Not in memory: Nebula restarted while it was open (Q108 a).
        if not known:
            outcome = RESTART_OUTCOME
        else:
            outcome = asset_outcome_line(proposal) if kind in _ASSET_UPDATE_KINDS else canvas_outcome_line(proposal)
        try:
            result = await asyncio.to_thread(agent_notes.resolve_proposal, project_id, note["id"],
                                             outcome=outcome, by={"kind": "system"})
        except (NoteError, ProjectStoreError):
            continue
        if result is not None:
            await _broadcast_raw_quietly(_notes_message("canvas", "resolved", project_id=project_id,
                                                        ids=[note["id"]], note=result["note"],
                                                        unread=result["unread"]))


async def _settle_question_update(project_id: str | None, note: Mapping[str, Any]) -> None:
    """A question set's Update whose set can't be answered any more: closed
    (its outcome); closed and since pruned before this Update heard ("Closed.",
    GM's PR #193 review); or not there at all ("Closed when Nebula
    restarted.", GM's line for questions). Sets are kept with the project, so
    a restart alone never gets there; a set whose record couldn't be read
    back does (damaged, or from a build that didn't keep sets)."""
    ref = note.get("questions")
    if note.get("source") != "nebula" or note.get("resolvedAt") or not isinstance(ref, Mapping):
        return
    question_set = agent_questions.get(str(ref.get("id") or ""))
    if isinstance(question_set, QuestionSet) and question_set.is_open:
        return
    if isinstance(question_set, QuestionSet):
        outcome = question_outcome_line(question_set)
    elif agent_questions.closed_before(project_id, str(note.get("id") or "")):
        # Closed, then pruned before its Update heard (GM's review, item 6).
        outcome = QUESTIONS_CLOSED_OUTCOME
    else:
        outcome = QUESTIONS_RESTART_OUTCOME
    try:
        result = await asyncio.to_thread(agent_notes.resolve_questions, project_id, note["id"],
                                         outcome=outcome, by={"kind": "system"})
    except (NoteError, ProjectStoreError):
        return
    if outcome == QUESTIONS_CLOSED_OUTCOME:
        agent_questions.forget_closed_update(project_id, str(note.get("id") or ""))
    if result is not None:
        await _broadcast_raw_quietly(_notes_message("canvas", "resolved", project_id=project_id, ids=[note["id"]],
                                                    note=result["note"], unread=result["unread"]))


# ---- the Update each canvas proposal posts (Justin's Q112 a, 2026-10-21) ----
#
# "a) Yes, every one: "Claude Code proposes 3 changes on the canvas", with
# Review taking you to the canvas and its bar. It settles like the others
# (Accepted, Rejected, Expired, Closed: Nebula restarted)." Every surface
# (MCP propose_change, `nebula propose`, HTTP) proposes through
# create_canvas_proposal, which posts it here. Nebula writes it for the agent:
# it skips the agent's post_note rate limit, and the project's cap prunes it.

async def _post_canvas_update(proposal: Proposal) -> None:
    if not proposal.project_id:
        return  # no project open: the bar and the Agent log are the only notice, as before
    try:
        result = await asyncio.to_thread(
            agent_notes.post_proposal, author={"kind": "agent", **proposal.agent.as_dict()},
            text=canvas_update_text(proposal), project_id=proposal.project_id,
            proposal={"id": proposal.id, "kind": "canvas", "targetId": proposal.project_id})
    except (NoteError, ProjectStoreError):
        return
    note = result["note"]
    proposal.update = {"id": note["id"], "projectId": result["projectId"]}
    # Saved by a worker thread: tagged with the project it went to, journaled
    # before the broadcast's await (round 8 of PR #114).
    _journal_note(note, "canvas", project_id=result["projectId"])
    await _broadcast_raw_quietly(_notes_message("canvas", "added", project_id=result["projectId"], note=note,
                                                unread=result["unread"], removed=result["removed"]))
    if not proposal.is_open:
        # It closed while the Update was being written (a node it needs
        # deleted, the canvas cleared, another project opened, withdrawn):
        # that close found no Update to settle, so settle it now.
        await _follow_canvas_updates([proposal])
        return
    _schedule_canvas_expiry(proposal)


def _canvas_resolved_by(proposal: Proposal, actor: Mapping[str, Any] | None) -> dict[str, Any]:
    if proposal.status == "withdrawn":
        return {"kind": "agent", "name": proposal.agent.name}
    if proposal.status in ("accepted", "rejected") or (actor or {}).get("kind") == "person":
        return {"kind": "person"}
    return {"kind": "system"}


async def _follow_canvas_updates(proposals: list[Proposal], *, actor: Mapping[str, Any] | None = None) -> None:
    """Closed canvas proposals: each one's Update says how it ended and is
    read, so its Review goes. Every way one ends comes through here:
    accepted, rejected, withdrawn, expired (the sweep and the timer below),
    and invalidated (a node it needs deleted, the canvas cleared or replaced
    by an import or another project, or no longer fitting at Accept)."""
    for proposal in proposals:
        ref = proposal.update
        if not ref or proposal.is_open:
            continue
        try:
            result = await asyncio.to_thread(agent_notes.resolve_proposal, ref["projectId"], ref["id"],
                                             outcome=canvas_outcome_line(proposal),
                                             by=_canvas_resolved_by(proposal, actor))
        except (NoteError, ProjectStoreError):
            continue
        if result is None:
            continue
        # Only the open project's list is on the person's screen; another
        # project's reloads with it when they open it.
        if result["projectId"] == _open_project_id():
            await _broadcast_raw_quietly(_notes_message("canvas", "resolved", project_id=result["projectId"],
                                                        ids=[ref["id"]], note=result["note"], unread=result["unread"]))


# On time, not on the next read: an agent that proposes and stops, with the
# person on Projects, reads nothing, so without a timer the Update would keep
# its Review past the proposal's 15 minutes.
_proposal_expiry_tasks: set[asyncio.Task[Any]] = set()


def _schedule_canvas_expiry(proposal: Proposal) -> None:
    """Check the proposal just after it is due (canvas_proposals' clock)."""
    delay = max(0.0, proposal.expires_at - canvas_proposals.now()) + 0.5
    try:
        _call_later(delay, _start_canvas_expiry_check, proposal.id)
    except RuntimeError:  # no running loop (a script): the next read sweeps
        pass


def _start_canvas_expiry_check(proposal_id: str) -> None:
    task = asyncio.get_running_loop().create_task(_canvas_expiry_check(proposal_id))
    _proposal_expiry_tasks.add(task)
    task.add_done_callback(_proposal_expiry_tasks.discard)


async def _canvas_expiry_check(proposal_id: str) -> None:
    await _sweep_proposals()
    proposal = canvas_proposals.get(proposal_id)
    if isinstance(proposal, Proposal) and proposal.is_open and proposal.expires_at > canvas_proposals.now():
        _schedule_canvas_expiry(proposal)  # not due yet: look again then


async def _follow_cover_proposals(exported: dict[str, Any]) -> None:
    """After any change to the live canvas (every one goes through
    _broadcast_graph_sync): re-check the open project's cover proposals, so
    the person's tab hears at once when the pin lost its image or got it back,
    or the automatic cover moved, instead of on the autosave's relist. Those
    that no longer fit close (assetProposalClosed); if a view still open
    changed, the person's tabs get assetProposalSync. Bounded: nothing to do
    unless a cover proposal waits on the open project, then only its
    proposals, against the export the sync already made. Never fails or
    holds up the canvas edit."""
    try:
        waiting = [p for p in asset_proposals.open_list()
                   if isinstance(p, AssetProposal) and p.kind == "project" and p.id not in _asset_deciding]
        if not waiting:
            return
        active = project_store.workspace().get("activeProjectId")  # no catalog copy
        mine = [p for p in waiting if p.target_id == active]
        if not mine:
            return
        project = _open_project_record(active)
        if project is None:
            return  # the sweep on the next read says "deleted"
        images = _cover_images_now(project, {"activeProjectId": active}, exported)
        shown = {p.id: _asset_proposal_view(p) for p in mine}
        closed: list[AssetProposal] = []
        for proposal in mine:
            reason = _cover_proposal_misfit(proposal, project, images)
            if reason and proposal.is_open and proposal.id not in _asset_deciding:
                asset_proposals.close(proposal.id, "invalidated", reason=reason)
                # A node delete took its image: that delete's undo may reopen
                # it. Its records name it too, so an undo after a restart
                # (asset proposals live in memory) still counts it as lost.
                # Only deletes in its own project tag it (second review).
                records = [record for record in _removals_ctx.get() or []
                           if record.get("projectId") == proposal.project_id]
                proposal.closed_by = {str(record["id"]): str(record["nodeId"]) for record in records}
                for record in records:
                    named = record.setdefault("proposals", [])
                    if proposal.id not in named:
                        named.append(proposal.id)
                closed.append(proposal)
        if closed:
            await _announce_closed_asset_proposals(closed, actor=dict(_SYSTEM_ACTOR))
        if any(p.is_open and _asset_proposal_view(p) != shown[p.id] for p in mine):
            await manager.broadcast_browser(_asset_proposal_open_message())
    except Exception:  # noqa: BLE001 - housekeeping; the autosave's projectsChanged relists anyway
        return


# (catalog.json's signature, the open project's record): a run's many output
# syncs reuse it; the catalog is read again only once it is written.
_open_project_cache: tuple[Any, str, dict[str, Any]] | None = None


def _open_project_record(project_id: str) -> dict[str, Any] | None:
    global _open_project_cache
    signature = project_store.signature()
    cached = _open_project_cache
    if signature is not None and cached is not None and cached[0] == signature and cached[1] == project_id:
        return cached[2]
    project = project_store.read()["projects"].get(project_id)
    _open_project_cache = (signature, project_id, project) if project is not None and signature is not None else None
    return project


def _asset_proposal_open_message() -> dict[str, Any]:
    return {"type": "assetProposalSync",
            "proposals": [{**_asset_proposal_person_view(p), "acceptKey": p.accept_key}
                          for p in asset_proposals.open_list()]}


async def _asset_proposal_sync_message() -> dict[str, Any]:
    """Every open asset proposal with its accept key, for a socket that just
    said hello as the person (the Projects screen and Moodboard Studio)."""
    await _sweep_asset_proposals()
    return _asset_proposal_open_message()


async def _asset_proposal_target(kind: str, target_id: str, change: dict[str, Any]
                                 ) -> tuple[str, dict[str, Any], dict[str, Any] | None, str | None]:
    """(the target's name, its state now, a lost pin, the automatic cover's
    image) for a new proposal; 404
    for a missing target, 400 for an image not in the project, 409 for a
    change that is already so."""
    if kind == "project":
        exported = await _projects_live_export()
        catalog = project_store.read()
        project = _project_id_or_404(target_id, catalog)
        images = _cover_images_now(project, catalog, exported)
        url = change.get("cover")
        if url is not None and not project_cover.is_choice(images, url):
            raise HTTPException(status_code=400, detail=(
                "Pick one of this project's own images for its cover (list_project_covers, "
                f"GET /api/projects/{target_id}/covers, lists them)."))
        state = _cover_state(project)
        lost = _lost_pin(project, images)
        # Against what the card shows: a pin whose image is gone shows the automatic cover.
        if (None if lost else state["cover"]) == url:
            raise HTTPException(status_code=409, detail=(
                "That is already the project's cover; nothing to propose." if url is not None
                else "The project's cover is already the automatic one; nothing to propose."))
        return str(project.get("name") or ""), state, lost, _automatic_cover(images)
    try:
        board = await asyncio.to_thread(_moodboard_store().get, target_id)
    except ValueError:
        board = None
    if board is None:
        raise HTTPException(status_code=404, detail=f"No moodboard '{target_id[:40]}' (moodboard_list lists them)")
    if board.get("sendNotes") is True:
        raise HTTPException(status_code=409, detail=(
            f'Send notes to generators is already on for board "{board.get("name")}"; nothing to propose.'))
    return str(board.get("name") or ""), {"sendNotes": False}, None, None


@app.post("/api/asset-proposals", status_code=201)
async def create_asset_proposal(body: dict[str, Any]) -> dict[str, Any]:
    """An agent proposes a change outside the graph; the person decides where
    they work on that thing (a project's cover on the Projects screen, a
    board's Send notes in Moodboard Studio). Nothing changes until they accept.

    Body: {kind: "project" | "moodboard", id, change, note}. ``change`` is
    {"cover": url | null} for a project, {"sendNotes": true} for a board."""
    headers = current_request_headers()
    identity = identify_agent(headers)
    if identity is None:
        if is_person(headers):
            raise HTTPException(status_code=403, detail="The person doesn't need to propose; change it directly")
        raise HTTPException(status_code=400, detail="Name yourself with NEBULA_AGENT_NAME or --as")
    await _sweep_asset_proposals()
    try:
        spec = parse_asset_change(body)
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    lost = auto = None
    if spec.kind == "commons":
        spec, name, before = await _commons_proposal_target(spec, headers)
    else:
        name, before, lost, auto = await _asset_proposal_target(spec.kind, spec.target_id, spec.change)
    try:
        proposal = asset_proposals.create_asset(agent=identity, spec=spec, target_name=name, before=before)
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    proposal.lost_pin = lost
    proposal.auto_cover = auto
    said = asset_proposal_summary(proposal)
    # In the step that made it, before any await (round 8 of PR #114).
    _journal("proposal.created", data={**_asset_journal_data(proposal), "change": sorted(spec.change)},
             summary=(f"proposed {proposal.id} ({said})" if spec.kind == "commons"
                      else f'proposed {proposal.id}: "{spec.note}" ({said})'))
    # The Update in the corner (Q92 a), before the view so the answer names it.
    await _post_asset_update(proposal)
    _schedule_asset_expiry(proposal)
    view = _asset_proposal_view(proposal)
    try:
        # The accept key goes only to the person's canvas sockets.
        await manager.broadcast_browser({"type": "assetProposalOpened",
                                         "proposal": _asset_proposal_person_view(proposal),
                                         "acceptKey": proposal.accept_key})
    except Exception:  # noqa: BLE001 - a screen that missed it gets assetProposalSync on reconnect
        pass
    where = {"project": "on the Projects screen", "commons": "in the Commons"}.get(spec.kind, "in Moodboard Studio")
    # No cursor can go there, so the Agent log names it.
    await _say_agent_action(f"Asks to {said} (decide {where})")
    return {"proposal": view}


@app.get("/api/asset-proposals")
async def list_asset_proposals(kind: str | None = None, id: str | None = None) -> dict[str, Any]:  # noqa: A002
    """Open asset proposals, optionally for one kind or one target (never their accept keys)."""
    await _sweep_asset_proposals()
    headers = current_request_headers()
    return {"proposals": [_asset_proposal_view(p) for p in asset_proposals.for_target(kind, id)
                          if await _commons_proposal_visible(p, headers)]}


async def _get_asset_proposal(proposal_id: str, wait: float, request: Request) -> dict[str, Any]:
    """``GET /api/canvas/proposals/{id}`` for an asset proposal: with ``wait``
    (≤25 s), wait for the decision, or for its target to move on."""
    await _sweep_asset_proposals()
    proposal = asset_proposals.get(proposal_id)
    if not isinstance(proposal, AssetProposal) or not await _commons_proposal_visible(proposal, current_request_headers()):
        raise refusal_copy.not_found(_gone_proposal_detail(proposal_id), "proposal", "proposals")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait
    cursor = canvas_events.latest
    while proposal.is_open:
        remaining = min(deadline - loop.time(), proposal.expires_at - asset_proposals.now() + 0.05)
        if remaining <= 0:
            break
        try:
            result = await _journal_wait(request, after=cursor, journal=canvas_events.journal_id,
                                         wait=remaining, kinds=set(_ASSET_WAIT_KINDS))
        except TooManyWaiters as exc:
            raise HTTPException(status_code=429, detail=str(exc)) from exc
        cursor = result.get("cursor", cursor)
        await _sweep_asset_proposals()
        if result.get("timedOut") and deadline - loop.time() <= 0:
            break
    return {"proposal": _asset_proposal_view(proposal)}


async def _withdraw_asset_proposal(proposal_id: str, identity: Any) -> dict[str, Any]:
    await _sweep_asset_proposals()
    proposal = asset_proposals.get(proposal_id)
    if not isinstance(proposal, AssetProposal) or not await _commons_proposal_visible(proposal, current_request_headers()):
        raise refusal_copy.not_found(f"No proposal {proposal_id[:20]}", "proposal", "proposals")
    if proposal.agent.id != identity.id:
        raise HTTPException(status_code=403, detail="Only the agent that proposed this can withdraw it")
    if proposal.id in _asset_deciding:
        raise HTTPException(status_code=409, detail="The person is accepting this proposal right now")
    try:
        asset_proposals.close(proposal_id, "withdrawn", reason="withdrawn by the agent")
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    await _announce_closed_asset_proposals([proposal])
    return {"proposal": _asset_proposal_view(proposal)}


async def _decidable_asset_proposal(proposal_id: str) -> AssetProposal:
    """The person-only checks of accept and reject, as for canvas proposals:
    no agent markers and the person token, then the proposal's accept key,
    then still open."""
    headers = current_request_headers()
    require_person(headers)
    lower = {k.lower(): v for k, v in (headers or {}).items()}
    supplied = lower.get(_PROPOSAL_KEY_HEADER) or ""
    proposal = asset_proposals.get(proposal_id)
    if not isinstance(proposal, AssetProposal):
        raise refusal_copy.not_found("This proposal is no longer available", "proposal", "proposals")
    if not supplied or not secrets.compare_digest(supplied.encode(), proposal.accept_key.encode()):
        raise HTTPException(status_code=403, detail="This proposal can only be decided from Nebula, where you saw it.")
    await _sweep_asset_proposals()
    if not proposal.is_open or proposal.id in _asset_deciding:
        raise HTTPException(status_code=409, detail=f"This proposal is already {proposal.status}")
    return proposal


async def _apply_asset_proposal(proposal: AssetProposal) -> dict[str, Any]:
    """Make the change as the person, through the route their own click uses."""
    note = f" (accepted from {proposal.agent.name})"
    if proposal.kind == "commons":
        return await _apply_commons_proposal(proposal)
    if proposal.kind == "project":
        url = proposal.change.get("cover")
        result = await _set_project_cover(proposal.target_id, url, expect=proposal.before, note=note)
        return {"applied": {"cover": url}, "project": result["project"]}
    # Without the tab id, the write isn't this tab's echo: the Studio that
    # clicked Accept reads the board again like every other open one.
    headers = {k: v for k, v in (current_request_headers() or {}).items() if k.lower() != "x-nebula-tab"}
    with request_headers_scope(headers):
        # Its board.* events name the proposal, as a canvas accept's do.
        answer = await _update_moodboard(proposal.target_id, MoodboardUpdate(sendNotes=True), proposal_id=proposal.id)
    if isinstance(answer, Response):
        detail = ""
        try:
            detail = str(json.loads(bytes(answer.body)).get("detail") or "")
        except Exception:  # noqa: BLE001
            pass
        raise HTTPException(status_code=409, detail=detail or "the board can't take it now")
    return {"applied": {"sendNotes": True}, "board": answer}


@app.post("/api/asset-proposals/{proposal_id}/accept")
async def accept_asset_proposal(proposal_id: str) -> dict[str, Any]:
    """The person accepts: the change is made as theirs, or nothing is (409,
    and the proposal closes as invalidated when it no longer fits)."""
    proposal = await _decidable_asset_proposal(proposal_id)
    _asset_deciding.add(proposal.id)
    # Expiry must not land while the change is being made.
    proposal.expires_at = max(proposal.expires_at, asset_proposals.now() + 120)
    try:
        exported = await _projects_live_export() if proposal.kind == "project" else None
        misfit = await _asset_proposal_misfit(proposal, exported)
        if misfit is not None:
            raise HTTPException(status_code=409, detail=misfit)
        outcome = await _apply_asset_proposal(proposal)
    except (HTTPException, PersonGateError) as exc:
        detail = str(getattr(exc, "detail", "") or exc)
        _asset_deciding.discard(proposal.id)
        if proposal.is_open:
            asset_proposals.close(proposal.id, "invalidated", reason=detail[:200])
            await _announce_closed_asset_proposals([proposal], actor=dict(_PERSON_ACTOR))
        raise HTTPException(status_code=409, detail=f"This proposal no longer fits: {detail}") from exc
    except BaseException:
        _asset_deciding.discard(proposal.id)
        raise
    proposal.applied = dict(outcome["applied"])
    try:
        asset_proposals.close(proposal.id, "accepted")
    except ProposalError:
        pass  # unreachable while it is in _asset_deciding; the change is made either way
    _asset_deciding.discard(proposal.id)
    _journal("proposal.accepted", data={**_asset_journal_data(proposal), "applied": proposal.applied},
             summary=f"accepted {proposal.agent.name}'s proposal {proposal.id} ({asset_proposal_summary(proposal)})",
             actor=dict(_PERSON_ACTOR))
    try:
        await manager.broadcast_raw(_asset_proposal_closed_message(proposal))
    except Exception:  # noqa: BLE001
        pass
    await _follow_asset_updates([proposal])
    publish_action(f"Accepted {proposal.agent.name}'s proposal to {asset_proposal_summary(proposal)}")
    return {"status": "accepted", "proposalId": proposal.id, "kind": proposal.kind,
            "targetId": proposal.target_id, **outcome}


@app.post("/api/asset-proposals/{proposal_id}/reject")
async def reject_asset_proposal(proposal_id: str, request: Request) -> dict[str, Any]:
    """The person says no. Body: {reason?} (one short line the agent will read)."""
    proposal = await _decidable_asset_proposal(proposal_id)
    body = await _proposal_body(request)
    if not proposal.is_open or proposal.id in _asset_deciding:
        raise HTTPException(status_code=409, detail=f"This proposal is already {proposal.status}")
    reason: str | None = None
    if body.get("reason") not in (None, ""):
        try:
            reason = clean_note(body.get("reason"), limit=MAX_REASON, label="reason")
        except ProposalError as exc:
            raise _proposal_http_error(exc) from exc
    asset_proposals.close(proposal.id, "rejected", reason=reason)
    await _announce_closed_asset_proposals([proposal], actor=dict(_PERSON_ACTOR))
    return {"status": "rejected", "proposalId": proposal.id}


# ---------- Commons curation as asset proposals (Justin's Q63 b, U13) ----------
#
# Curating the Commons (corrections, regions, a reference's role, why or
# inbox place) stays the person's: agents propose it with kind "commons"
# and the person decides on the reference's detail in the Commons. Accept
# makes each edit through the Commons route the person's own click uses
# (services/commons_proposals.py). Every curation write, the person's own
# and an accepted proposal's, journals a commons.* event.

def _asset_proposal_person_view(proposal: AssetProposal) -> dict[str, Any]:
    """The view plus what only the person's screen may see (a commons
    proposal's ``before``: Commons text), for the browser-only messages."""
    return {**_asset_proposal_view(proposal), **asset_proposals.person_values(proposal)}


def _commons_proposal_store() -> Any:
    from commons import activation as commons_activation, runtime as commons_runtime

    if not commons_activation.is_enabled():
        raise HTTPException(status_code=404, detail="The Commons is off on this backend, so there is nothing to propose.")
    return commons_runtime.get_store()


async def _commons_proposal_target(spec: Any, headers: Mapping[str, str] | None) -> tuple[Any, str, dict[str, Any]]:
    """(the spec with edits already so dropped, the target's name, ``before``).
    The agent must see the reference in its own scope, as commons_get does."""
    import dataclasses

    from routes import commons as commons_routes
    from services import commons_proposals

    store = _commons_proposal_store()
    try:
        actor = commons_actors.resolve_actor(headers or {})
    except commons_actors.AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    change, before = await asyncio.to_thread(commons_proposals.target, store, actor, spec.target_id,
                                             spec.change, spec.brand)
    # The scope it was proposed in: who else may read it (_commons_proposal_visible).
    scope = {"brand": commons_routes._effective_brand(actor, spec.brand),
             "workspace": str(actor.workspace) if actor.workspace is not None else None}
    return dataclasses.replace(spec, change=change), "", {"edits": before, "scope": scope}


async def _commons_proposal_visible(proposal: AssetProposal, headers: Mapping[str, str] | None) -> bool:
    """Whether this caller may read a proposal: any proposal but a commons
    one; that one only for the person, the session that proposed it (which
    reads the outcome even once the reference is gone), and callers who see
    its reference in the brand it was proposed for, as commons_get does. A
    brand-bound agent session never sees another brand's (the Commons fence)."""
    if proposal.kind != "commons" or is_person(headers):
        return True
    from commons import activation as commons_activation, runtime as commons_runtime
    from routes import commons as commons_routes

    scope = proposal.before.get("scope") or {}
    try:
        actor = commons_actors.resolve_actor(headers or {})
    except commons_actors.AuthError:
        return False
    identity = identify_agent(headers)
    workspace = str(actor.workspace) if actor.workspace is not None else None
    if identity is not None and identity.id == proposal.agent.id and workspace == scope.get("workspace"):
        return True
    if not commons_activation.is_enabled():
        return False

    def sees_reference() -> bool:
        try:
            commons_routes._asset_access(commons_runtime.get_store(), actor, proposal.target_id, scope.get("brand"))
        except HTTPException:
            return False
        return True

    return await asyncio.to_thread(sees_reference)


async def _commons_proposal_misfit(proposal: AssetProposal) -> str | None:
    from commons import activation as commons_activation, runtime as commons_runtime
    from services import commons_proposals

    if not commons_activation.is_enabled():
        return "the Commons was turned off"
    return await asyncio.to_thread(commons_proposals.misfit, commons_runtime.get_store(), proposal.target_id,
                                   proposal.change, list(proposal.before.get("edits") or []))


async def _apply_commons_proposal(proposal: AssetProposal) -> dict[str, Any]:
    from services import commons_proposals

    store = _commons_proposal_store()
    said = commons_proposals.accepted_from.set(proposal.agent.name)
    try:
        made = await asyncio.to_thread(commons_proposals.apply, store, proposal.target_id, proposal.change)
    finally:
        commons_proposals.accepted_from.reset(said)
    # Other proposals on this reference may no longer fit (this one is still deciding).
    await _sweep_asset_proposals()
    return {"applied": {"edits": made}}


_COMMONS_EVENT_KINDS = {"corrected": "commons.corrected", "region": "commons.region",
                        "membership": "commons.membership"}


def _commons_curation_summary(kind: str, data: Mapping[str, Any]) -> str:
    asset_id = data.get("assetId") or "?"
    if kind == "corrected":
        return f"corrected {data.get('fieldPath')} ({data.get('op')}) on Commons reference {asset_id}"
    changed = ", ".join(data.get("change") or []) or "nothing"
    if kind == "region":
        return f"{'added a region' if changed == 'added' else f'changed a region ({changed})'} on Commons reference {asset_id}"
    return f"changed {changed} of Commons reference {asset_id} in a collection"


def _journal_commons_curation(kind: str, data: dict[str, Any], actor: Any) -> None:
    """routes/commons.py's curation hook: one commons.* event per write, with
    who made it, and never Commons text (no values, labels or whys). Then the
    proposals waiting on that reference are checked, from the route's worker
    thread (an accepted proposal sweeps for itself)."""
    from services import commons_proposals

    event = _COMMONS_EVENT_KINDS.get(kind)
    if event is None:
        return
    who = dict(_PERSON_ACTOR) if getattr(actor, "is_human", False) else actor_for_headers(current_request_headers())
    origin = commons_proposals.accepted_from.get()
    note = f" (accepted from {origin})" if origin else ""
    _journal(event, data=dict(data), summary=_commons_curation_summary(kind, data) + note, actor=who)
    if origin or not asset_proposals.for_target("commons", str(data.get("assetId") or "")):
        return
    try:
        import anyio.from_thread

        anyio.from_thread.run(_sweep_asset_proposals)
    except Exception:  # noqa: BLE001 - not on a route's worker thread; the next read sweeps
        pass


def _register_commons_curation_journal() -> None:
    from routes import commons as commons_routes

    if _journal_commons_curation not in commons_routes.curation_listeners:
        commons_routes.curation_listeners.append(_journal_commons_curation)


_register_commons_curation_journal()


@app.get("/api/project")
async def current_project() -> dict[str, str]:
    """The project open on the canvas, ``{id, name}``: what "this project"
    means for project-scoped Characters, Moodboards and Styles, in the app,
    the CLI and MCP alike. 404 when no project is open."""
    view = project_store.projection()  # no catalog copy
    if view.project_id is None:
        raise HTTPException(status_code=404, detail="No project is open.")
    return {"id": view.project_id, "name": view.name}


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
    """Sign Codex in to ChatGPT. It runs `codex logout` first, which clears the
    person's stored Codex credentials, so only the person may start it."""
    require_person(current_request_headers())
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
        # Justin, Q55 a: "Only the app (your person token) gets the endings.
        # Everything else learns which providers are set, and nothing more."
        # An agent's curl or `nebula keys` sees a bare "***" for a set key.
        person = _is_person_request()
        masked["apiKeys"] = {
            k: (("***" + v[-4:] if len(v) > 4 else "***") if person else "***") if v else ""
            for k, v in masked["apiKeys"].items()
        }
    if agent_spend.CAPS_KEY in masked:
        masked[agent_spend.CAPS_KEY] = agent_spend.saved_caps_view(masked[agent_spend.CAPS_KEY])
    return masked


@app.put("/api/settings")
async def update_settings(body: dict[str, Any]) -> dict:
    # Settings are the person's: keys, output paths, routing and the limits
    # that hold agents back. Agents only ever read them (GET).
    require_person(current_request_headers())
    if "kreaConnectionMode" in body and body["kreaConnectionMode"] not in ("api-token", "mcp"):
        raise HTTPException(400, "Krea connection mode must be api-token or mcp")
    if "zoomTelemetryEnabled" in body and not isinstance(body["zoomTelemetryEnabled"], bool):
        raise HTTPException(400, "zoomTelemetryEnabled must be a boolean")
    if agent_spend.SETTING_KEY in body or agent_spend.CAPS_KEY in body:
        try:
            if agent_spend.SETTING_KEY in body:
                body[agent_spend.SETTING_KEY] = agent_spend.validate_threshold(body[agent_spend.SETTING_KEY])
            if agent_spend.CAPS_KEY in body:
                body[agent_spend.CAPS_KEY] = agent_spend.validate_caps(body[agent_spend.CAPS_KEY], node_registry.get_all())
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
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
        agent_spend.SETTING_KEY,
        agent_spend.CAPS_KEY,
    ):
        if key in body:
            current[key] = body[key]
    save_settings(current)
    # API keys may have changed — drop cached validation results so the next
    # GET /api/health/providers re-checks providers instead of serving stale
    # status for up to PROVIDER_CHECK_TTL_SECONDS.
    clear_provider_validation_cache()
    return {"status": "saved"}


# The credential-update allowlist (services/credential_catalog.py; the
# desktop app's credentials.mjs mirrors it).
_CREDENTIAL_PROVIDER_ALLOWLIST = CREDENTIAL_PROVIDERS


@app.delete("/api/settings/api-keys/{provider}")
async def remove_settings_api_key(provider: str) -> dict:
    """Explicitly remove one browser credential without replacing Settings.

    Credential values and Krea MCP OAuth state never enter the response. The
    desktop credential bridge remains responsible for injected credentials.
    """
    require_person(current_request_headers())
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

    Called by the desktop Settings panel after it stores a provider key
    through the credential IPC. Person-only: an agent that could call this
    could swap or clear the person's injected keys. Never persists to disk.
    """
    require_person(current_request_headers())
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
    submitted: Mapping[str, Mapping[str, Any]] | None = None,
) -> None:
    """Sync late live-run params, preserve replay canvas params, then emit Stop.
    run.cancelled is journaled first, before any await, with the run's own
    project (_run_project; round 8 of PR #114)."""
    synced = not preserve_graph_params and _sync_params_to_cli_graph(nodes, submitted=submitted, run_id=run_id)
    stopped_by, started_by = _run_cancelled_actor(run_id)
    _journal(
        "run.cancelled",
        data={"runId": run_id, "startedBy": started_by},
        summary="run stopped",
        actor=stopped_by,
        project_id=_run_project(),
    )
    if synced:
        await _broadcast_graph_sync(run_params=run_id)
    await manager.broadcast(GraphCancelledEvent(run_id=run_id))


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
        raise RunSafetyStorageRefusal(
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
                # Round 15 (review 14, M4): a re-seed with no IDs to seed
                # writes nothing, so prove the journal takes a real write
                # before the error clears.
                provider_recovery_store.verify_writable()
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
            # The person's line names what clears it (round 3b): Run History's
            # forget for a record, else the node's own ID fields.
            journaled = any(node_id in recovered_node_ids for node_id in stale_nodes)
            # The node GM's line names (its card title): the first with a
            # record when any has one, else the first with an ID in params.
            held_node = next((node_id for node_id in stale_nodes if node_id in recovered_node_ids), stale_nodes[0])
            raise ProviderStartConflictError(
                "Fresh World Labs start blocked because Nebula already has a "
                "recovery checkpoint for node(s): "
                + ", ".join(stale_nodes)
                + ". Restore or explicitly delete the checkpoint before starting "
                "new paid work.",
                reason="recovery" if journaled else "params",
                node=_run_node_name(held_node, {node.id: node for node in nodes}),
                fields=None if journaled else _recovery_field_labels(
                    [cli_graph.nodes[held_node]] if held_node in cli_graph.nodes else []),
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
        raise refusal_copy.refusal(409, str(exc), _paid_capacity_person(exc.limit),
                                   route="run") from exc
    except ProviderRecoveryPersistenceError as exc:
        provider_recovery_store.release_reservations(run_id)
        raise RunSafetyStorageRefusal(
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
        raise _start_refusal(exc) from exc
    except ProviderStartPersistenceError as exc:
        provider_recovery_store.release_reservations(run_id)
        raise RunSafetyStorageRefusal(
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
    fence = _graph_fence()
    run_id = request.run_id or str(uuid4())
    _assert_execution_admissible(run_id)
    if execution_runs.get(run_id) is not None:
        raise HTTPException(status_code=409, detail=f"run '{run_id}' already exists")
    # This process saw the start begin (round 17, review 16 L1): a Stop that
    # finds no record of it may say it never started.
    execution_runs.note_start_begun(run_id)
    _note_run(run_id)
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    nodes = _normalize_execute_nodes(request.nodes)
    _note_run_nodes(run_id, nodes)
    submitted = _submitted_params(nodes)
    _validate_cinema_base_models(nodes)

    errors = validate_graph(nodes, request.edges, api_keys)
    if errors:
        await _announce_validation_errors(errors, run_id)
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

    # After validation, so a graph that can't run reports why, not its cost.
    await _require_run_spend_approval(run_id, nodes, request.edges, approval_id=request.approval_id,
                                run_ids=_end_node_ids(nodes, request.edges), settings=settings, fence=fence)

    handler_registry = get_handler_registry(emit=_emit_and_sync)
    try:
        # The run's outputs land by node id on the live graph: start it only
        # on the canvas it was asked on. Checked after the measure too (in
        # _require_run_spend_approval); again here, the last check before it
        # registers, with no await between (round 11).
        _refuse_if_graph_moved(fence)
        # A Stop that arrived while this start awaited (round 16, M2: the tab
        # stops a run whose status check answered 404) refuses it here.
        _assert_execution_admissible(run_id)
        # The canvas the run registers on, read now (round 17, review 16 L5):
        # a project-store read that fails after the task exists could leave
        # a started run behind a 507 that says nothing was started.
        run_canvas = _run_canvas_now()
        _claim_fresh_paid_worldlabs_starts(run_id=run_id, nodes=nodes)
    except BaseException:
        _return_hold(run_id)
        canvas_events.forget_run(run_id)  # its proposal mark too (review 2)
        raise

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
            if not request.preserve_graph_params and _sync_params_to_cli_graph(nodes, submitted=submitted,
                                                                                run_id=run_id):
                # ExecutedEvent carries outputs, but handlers such as
                # video-edit also enrich params. Without a final graphSync the
                # backend persisted those edits while the live Canvas stayed
                # stale until reload.
                await _broadcast_graph_sync(run_params=run_id)
            print("[exec] _run completed successfully", file=sys.stderr, flush=True)
        except asyncio.CancelledError:
            await _finalize_cancelled_execution(nodes, run_id, preserve_graph_params=request.preserve_graph_params,
                                                submitted=submitted)
            raise
        except Exception as e:
            if _execution_is_cancelling(run_id):
                await _finalize_cancelled_execution(nodes, run_id, preserve_graph_params=request.preserve_graph_params,
                                                submitted=submitted)
                raise asyncio.CancelledError from e
            print(f"[exec] _run FAILED: {e}", file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)
            raise
        finally:
            # A Stop may be absorbed while the non-idempotent provider POST
            # settles. The lease therefore belongs to the task, not the HTTP
            # acknowledgement, and releases only after the task is terminal.
            await _release_paid_worldlabs_starts(run_id)
            _settle_hold(run_id)

    task: asyncio.Task[None] | None = None
    run_coroutine = _run()
    try:
        task = asyncio.create_task(run_coroutine)
        _register_run(run_id, task, run_canvas)
        _watch_for_cross_process_stop(run_id, task)
    except ExecutionCancelledBeforeStartError as exc:
        if task is None:
            run_coroutine.close()
        else:
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        canvas_events.forget_run(run_id)  # its proposal mark too (review 2)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExecutionCancellationCapacityError as exc:
        if task is None:
            run_coroutine.close()
        else:
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        canvas_events.forget_run(run_id)  # its proposal mark too (review 2)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        if task is None:
            run_coroutine.close()
        else:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        canvas_events.forget_run(run_id)  # its proposal mark too (review 2)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception:
        if task is None:
            run_coroutine.close()
        else:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)  # it never had a turn (round 17, review 16 L5)
        canvas_events.forget_run(run_id)  # its proposal mark too (review 2)
        raise

    return {"status": "started", "runId": run_id}


@app.post("/api/execute-node")
async def execute_node(request: ExecuteNodeRequest) -> dict:
    """Execute only the subgraph feeding into a specific target node."""
    _check_workspace_revision()
    _capture_execution_workspace()
    fence = _graph_fence()
    run_id = request.run_id or str(uuid4())
    _assert_execution_admissible(run_id)
    if execution_runs.get(run_id) is not None:
        raise HTTPException(status_code=409, detail=f"run '{run_id}' already exists")
    # This process saw the start begin (round 17, review 16 L1): a Stop that
    # finds no record of it may say it never started.
    execution_runs.note_start_begun(run_id)
    _note_run(run_id)
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    nodes = _normalize_execute_nodes(request.nodes)
    submitted = _submitted_params(nodes)

    # Compute the subgraph: target node + all its ancestors
    sub_nodes, sub_edges = get_subgraph(
        nodes, request.edges, request.target_node_id
    )

    if not sub_nodes:
        raise _node_gone(request.target_node_id, f"Node '{request.target_node_id}' not found in graph")
    _note_run_nodes(run_id, sub_nodes)

    _validate_cinema_base_models(sub_nodes)

    errors = validate_graph(sub_nodes, sub_edges, api_keys)
    if errors:
        await _announce_validation_errors(errors, run_id)
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

    # After validation, so a graph that can't run reports why, not its cost.
    await _require_run_spend_approval(run_id, sub_nodes, sub_edges, approval_id=request.approval_id,
                                run_ids=[request.target_node_id], settings=settings, fence=fence)

    handler_registry = get_handler_registry(emit=_emit_and_sync)
    try:
        _refuse_if_graph_moved(fence)  # as in execute
        _assert_execution_admissible(run_id)  # as in execute
        run_canvas = _run_canvas_now()  # as in execute
        _claim_fresh_paid_worldlabs_starts(run_id=run_id, nodes=sub_nodes)
    except BaseException:
        _return_hold(run_id)
        canvas_events.forget_run(run_id)  # its proposal mark too (review 2)
        raise

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
            if not request.preserve_graph_params and _sync_params_to_cli_graph(sub_nodes, submitted=submitted,
                                                                                run_id=run_id):
                await _broadcast_graph_sync(run_params=run_id)
        except asyncio.CancelledError:
            await _finalize_cancelled_execution(sub_nodes, run_id, preserve_graph_params=request.preserve_graph_params,
                                                submitted=submitted)
            raise
        except Exception as exc:
            if _execution_is_cancelling(run_id):
                await _finalize_cancelled_execution(sub_nodes, run_id, preserve_graph_params=request.preserve_graph_params,
                                                submitted=submitted)
                raise asyncio.CancelledError from exc
            traceback.print_exc()
            raise
        finally:
            await _release_paid_worldlabs_starts(run_id)
            _settle_hold(run_id)

    try:
        task = asyncio.create_task(_run())
        _register_run(run_id, task, run_canvas)
        _watch_for_cross_process_stop(run_id, task)
    except ExecutionCancelledBeforeStartError as exc:
        await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        canvas_events.forget_run(run_id)  # its proposal mark too (review 2)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExecutionCancellationCapacityError as exc:
        await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        canvas_events.forget_run(run_id)  # its proposal mark too (review 2)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        canvas_events.forget_run(run_id)  # its proposal mark too (review 2)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception:
        # The task never had a turn (nothing awaited since it was made): it
        # never starts, so its hold goes back (round 17, review 16 L5).
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        canvas_events.forget_run(run_id)  # its proposal mark too (review 2)
        raise

    return {"status": "started", "nodeCount": len(sub_nodes), "runId": run_id}


# -- who may stop a run (Justin, 2026-10-20, MCP parity Q61 a) --------------------
# Agents stop only runs an agent started; the person stops anything. The rule
# is services/execution_runs.py stop_refusal; here is who the caller is.

def _run_party(headers: Mapping[str, str] | None = None) -> dict[str, Any]:
    """The caller as a run's starter or stopper, as the journal names actors:
    the person, a named agent, or anonymous (no marker, no person token: the
    `nebula` CLI without NEBULA_AGENT_NAME, curl, a tab not connected as the
    person). A request with an agent marker but no name is still an agent."""
    headers = current_request_headers() if headers is None else headers
    actor = actor_for_headers(headers)
    if actor.get("kind") != "agent" and has_agent_marker(headers):
        actor = {"kind": "agent", "name": "An agent"}
    return actor


execution_runs.set_starter_source(_run_party)


def _refuse_stopping_the_persons_run(run_id: str, record: Any) -> None:
    """Refuse a Stop the caller may not make, before anything is recorded.

    A run still being admitted (its POST noted the starter in the journal but
    hasn't registered it) is judged by the journal. A run ID nobody started
    here keeps today's pre-admission tombstone for any caller, and a run that
    already ended answers its status (there is nothing left to stop)."""
    from services.execution_runs import stop_refusal
    from services.person_gate import AGENT_REFUSED, PERSON_REQUIRED

    if record is not None and record.status not in {"running", "cancelling"}:
        return
    headers = current_request_headers()
    started_by = record.started_by if record is not None else canvas_events.run_actor(run_id)
    refusal = stop_refusal(started_by, caller_is_person=is_person(headers))
    if refusal is not None:
        raise PersonGateError(403, refusal, AGENT_REFUSED if has_agent_marker(headers) else PERSON_REQUIRED)
    if record is not None and record.stopped_by is None:
        record.stopped_by = _run_party(headers)


def _run_cancelled_actor(run_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """(who stopped it, who started it) for the run.cancelled journal event.
    A Stop another backend recorded has no stopper here: the starter stands in."""
    record = execution_runs.get(run_id)
    started_by = record.started_by if record is not None else canvas_events.run_actor(run_id)
    stopped_by = record.stopped_by if record is not None and record.stopped_by else started_by
    return stopped_by, {key: started_by[key] for key in ("kind", "name") if started_by.get(key)}


def _tombstoned_answer(run_id: str) -> dict[str, Any]:
    """A Stop's answer for a run id with no record here: cancelled, and the id
    can't start here from now on (``pendingAdmission``, which the canvas
    settles by). ``noRecord`` when this process never saw that run's start
    begin (round 17 of PR #114, review 16 L1): it may have run before a
    restart, been pruned, or never arrived, so nobody may say it never ran."""
    answer: dict[str, Any] = {"runId": run_id, "status": "cancelled", "pendingAdmission": True}
    if not execution_runs.start_seen(run_id):
        answer["noRecord"] = True
    return answer


@app.get("/api/executions/{run_id}")
async def get_execution_status(run_id: str) -> dict:
    record = execution_runs.get(run_id)
    if record is None:
        # A Stop arrived before this run did (round 16 of PR #114, M2): the id
        # is tombstoned and can't start here, so it reads as cancelled.
        if execution_runs.tombstoned(run_id):
            return _tombstoned_answer(run_id)
        raise refusal_copy.not_found(f"run '{run_id}' not found", "run", "runs")
    return {"runId": run_id, "status": record.status}


@app.delete("/api/executions/{run_id}")
async def cancel_execution(run_id: str) -> dict:
    """Idempotently request cancellation of a tracked graph execution.

    Only the person stops a run the person started (_refuse_stopping_the_persons_run)."""
    existing = execution_runs.get(run_id)
    _refuse_stopping_the_persons_run(run_id, existing)
    try:
        # Persist every Stop, including one received by the task-owning worker.
        # Otherwise a different backend could reuse the same runId after the
        # local task becomes terminal and its paid lifecycle lease is released.
        provider_start_guard.record_cancel_intent(run_id)
    except ProviderStartCancellationCapacityError as exc:
        if existing is not None:
            execution_runs.cancel(run_id)
        else:
            execution_runs.tombstone(run_id)  # still refused here if it arrives
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ProviderStartPersistenceError as exc:
        if existing is not None:
            execution_runs.cancel(run_id)
        else:
            execution_runs.tombstone(run_id)
        raise RunSafetyStorageRefusal(
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
        return _tombstoned_answer(run_id)
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
        raise RunSafetyStorageRefusal(
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
    terminal_fields: dict[str, str] | None = None,
    run_id: str | None = None,
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

    ``terminal_fields`` are what the Cinema panel reads the failure with, as
    a node card does (error copy round 3c-2): ``errorCategory``,
    ``errorFriendly``, ``errorPerson`` and ``errorRaw`` (_shot_failure_fields).
    ``error`` stays the text agents read, word for word.

    ``run_id``: the shot's run. Nothing is merged if the canvas it registered
    on was cleared or replaced since (_run_canvas_moved, round 11).
    """
    new_output: dict[str, Any] | None = None
    if terminal_error is None and executed_node is not None:
        sub_scene = (executed_node.params or {}).get("scene") or {}
        sub_shots = sub_scene.get("shots") or []
        if sub_shots and isinstance(sub_shots[0], dict):
            new_output = sub_shots[0].get("output")

    failure = {"status": "error", "error": terminal_error, **(terminal_fields or {})}
    result_output = failure if terminal_error is not None else new_output

    async with _shot_merge_lock(node_id):
        node = cli_graph.nodes.get(node_id)
        if node is None or _run_canvas_moved(run_id, "shot result"):
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
                        failed_output = {key: value for key, value in (shot.get("output") or {}).items()
                                         if key not in _SHOT_FAILURE_FIELDS}
                        failed_output.update(failure)
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
    """Expected per-shot pass failure already expressed as user-facing text.

    ``failure`` is the node run error behind it, as the card reads one:
    category, friendly, person and the raw text (round 3c-2)."""

    def __init__(self, message: str, failure: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.failure = failure


# What a failed shot's output carries beside ``error`` for the Cinema panel.
_SHOT_FAILURE_FIELDS = ("errorCategory", "errorFriendly", "errorPerson", "errorProviderText", "errorProvider",
                        "errorRaw")


def _shot_task_error_message(exc: Exception) -> str:
    if isinstance(exc, _ShotPassError):
        return str(exc)
    detail = str(exc).strip() or type(exc).__name__
    return f"Shot generation failed: {detail}"


def _shot_failure_fields(exc: Exception) -> dict[str, Any]:
    """How the Cinema panel reads a failed shot, the way a node card reads its
    run error (lib/nodeErrorCopy.ts): the handler's person line, the
    classifier's category and line, and the full raw text for Details. A
    shot that ended for a reason Nebula wrote itself carries none and shows
    as it is; an unexpected exception reads GM's general line."""
    if isinstance(exc, _ShotPassError):
        failure = exc.failure or {}
        fields = {"errorCategory": failure.get("category"), "errorFriendly": failure.get("friendly"),
                  "errorPerson": failure.get("person"), "errorProviderText": failure.get("provider_text"),
                  "errorProvider": failure.get("provider"), "errorRaw": failure.get("raw")}
        return {key: value for key, value in fields.items() if value}
    return {"errorCategory": "unknown"}


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
            if event.category:
                captured["failure"] = {"category": event.category, "friendly": event.friendly,
                                       "person": event.person, "provider_text": event.provider_text,
                                       "provider": event.provider,
                                       "raw": event.error}
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
            str(captured.get("error") or "Shot generation ended before the Cinema node completed."),
            captured.get("failure"),
        )

    return executed_node, captured.get("outputs") or {}


async def _merge_shot_variations(
    node_id: str,
    shot_id: str,
    variations: list[dict[str, Any]],
    *,
    run_id: str | None = None,
) -> dict[str, Any] | None:
    """Store a batch of variations on the live cli_graph scene and promote the
    first as canonical (output + the one shot port). Sibling shots are untouched;
    lock-serialized like _merge_shot_result. Returns the canonical output, or None
    when the batch produced no images. ``run_id`` as in _merge_shot_result."""
    if not variations:
        return None
    canonical = {"imageUrl": variations[0]["url"], "status": "done"}
    async with _shot_merge_lock(node_id):
        node = cli_graph.nodes.get(node_id)
        if node is None or _run_canvas_moved(run_id, "shot variations"):
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
            raise _node_gone(node_id)
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
            raise refusal_copy.not_found(f"Shot '{shot_id}' not found in scene", "shot", "shots")

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
    fence = _graph_fence()
    run_id = request.run_id or f"cinema-shot-{uuid4().hex}"
    _assert_execution_admissible(run_id)
    if execution_runs.get(run_id) is not None:
        raise HTTPException(status_code=409, detail=f"run '{run_id}' already exists")
    # This process saw the start begin (round 17, review 16 L1): a Stop that
    # finds no record of it may say it never started.
    execution_runs.note_start_begun(run_id)
    _note_run(run_id)
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    nodes = _normalize_execute_nodes(request.nodes)

    target = next((n for n in nodes if n.id == request.node_id), None)
    if target is None:
        raise _node_gone(request.node_id, f"Node '{request.node_id}' not found in graph")
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
        raise refusal_copy.not_found(f"Shot '{request.shot_id}' not found in scene", "shot", "shots")

    # Build a single-shot copy of the scene so the handler regenerates ONLY this
    # shot. The seed is applied per-pass via the shot's `_seedOverride` (which the
    # handler honors LAST, so a variation seed wins even over a Character bundle).
    single_scene = copy.deepcopy(scene)
    single_scene["shots"] = [copy.deepcopy(shot)]
    single_node = target.model_copy(update={"params": {**(target.params or {}), "scene": single_scene}})
    patched_nodes = [single_node if n.id == request.node_id else n for n in nodes]

    sub_nodes, sub_edges = get_subgraph(patched_nodes, request.edges, request.node_id)
    if not sub_nodes:
        raise _node_gone(request.node_id, f"Node '{request.node_id}' not found in graph")
    _note_run_nodes(run_id, sub_nodes)
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
        await _announce_validation_errors(errors, run_id)
        # With each error (error copy round 3e), so the shot panel can say
        # the scene's own line rather than a general one.
        return {**_validation_response(errors), "runId": run_id}

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

    # Priced as the whole scene: an upper bound for one shot. Variations run
    # the whole subgraph again with the cache off, once per variation, so
    # each one counts in full. Checked after validation, so a request that
    # can't run doesn't count.
    spend_nodes, spend_edges = get_subgraph(request.nodes, request.edges, request.node_id)
    await _require_run_spend_approval(run_id, spend_nodes, spend_edges, run_ids=[request.node_id], passes=count,
                                settings=settings, fence=fence)

    # A per-shot run does not acquire the frontend's Canvas-wide ``isExecuting``
    # gate, so sibling work remains available. It does register its background
    # Task below for strong ownership, Stop/status, and pre-first-turn cleanup,
    # and it must own the same paid-provider lifecycle lease as every other
    # execution surface. Otherwise an exact recovery deletion can race a World
    # ancestor that is still polling, then admit a stale blank payload as a
    # fresh paid start.
    try:
        _refuse_if_graph_moved(fence)  # as in execute
        _assert_execution_admissible(run_id)  # as in execute
        run_canvas = _run_canvas_now()  # as in execute
        _claim_fresh_paid_worldlabs_starts(run_id=run_id, nodes=sub_nodes)
    except BaseException:
        _return_hold(run_id)
        raise

    async def _run() -> None:
        import traceback

        terminal_error: str | None = None
        terminal_fields: dict[str, str] | None = None
        try:
            if count > 1:
                # Variation batch: N passes at distinct seeds (cache OFF so each
                # truly regenerates), collected into the shot's variations strip.
                variations: list[dict[str, Any]] = []
                failures: list[str] = []
                last_fields: dict[str, str] = {}
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
                        last_fields = _shot_failure_fields(exc)
                        continue
                    except Exception as exc:
                        traceback.print_exc()
                        failures.append(_shot_task_error_message(exc))
                        last_fields = _shot_failure_fields(exc)
                        continue
                    url = (outputs.get(shot_port) or {}).get("value")
                    if url:
                        variations.append({"url": url, "seed": seed_i})
                    else:
                        failures.append(f"Variation seed {seed_i} returned no image.")
                        last_fields = {}
                if variations:
                    await _merge_shot_variations(request.node_id, request.shot_id, variations, run_id=run_id)
                else:
                    last_failure = failures[-1] if failures else "No variation returned an image."
                    terminal_error = f"All {count} variation passes failed. {last_failure}"
                    terminal_fields = last_fields
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
                    request.node_id, request.shot_id, executed_node, outputs, run_id=run_id,
                )
        except _ShotPassError as exc:
            terminal_error = _shot_task_error_message(exc)
            terminal_fields = _shot_failure_fields(exc)
        except Exception as exc:
            traceback.print_exc()
            terminal_error = _shot_task_error_message(exc)
            terminal_fields = _shot_failure_fields(exc)
        finally:
            try:
                if terminal_error is not None:
                    await _merge_shot_result(
                        request.node_id,
                        request.shot_id,
                        None,
                        {},
                        terminal_error=terminal_error,
                        terminal_fields=terminal_fields,
                        run_id=run_id,
                    )
                await _broadcast_graph_sync()
            finally:
                await _release_paid_worldlabs_starts(run_id)
                _settle_hold(run_id)

    task: asyncio.Task[None] | None = None
    run_coroutine = _run()
    try:
        task = asyncio.create_task(run_coroutine)
        # The registry is the strong owner and its terminal callback performs
        # an idempotent lease release. That fallback is essential when a Task
        # is cancelled after create_task succeeds but before _run receives its
        # first event-loop turn (in which case the coroutine's finally never
        # executes).
        _register_run(run_id, task, run_canvas)
        _watch_for_cross_process_stop(run_id, task)
    except ExecutionCancelledBeforeStartError as exc:
        if task is None:
            run_coroutine.close()
        else:
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExecutionCancellationCapacityError as exc:
        if task is None:
            run_coroutine.close()
        else:
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        if task is None:
            run_coroutine.close()
        else:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception:
        if task is None:
            run_coroutine.close()
        else:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)  # it never had a turn (round 17, review 16 L5)
        raise

    return {
        "status": "started",
        "shotId": request.shot_id,
        "variations": count,
        "runId": run_id,
    }


# ---------- CLI: Node discovery ----------

@app.get("/api/pricing")
async def get_pricing() -> dict:
    """The curated price table for the Run button's estimate. Read per request,
    so a price update needs no restart. Nodes absent here are unpriced."""
    try:
        data = model_pricing.load_pricing()
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"Pricing table unavailable: {exc}") from exc
    return {"currencies": data.get("currencies") or {}, "nodes": data.get("nodes") or {}}


MAX_SIZE_REFS = 64


@app.post("/api/pricing/input-sizes")
async def get_input_sizes(body: dict[str, Any]) -> dict:
    """The size of input files, for the canvas's estimate of a price that
    depends on it (model_pricing ``sizing``: SeedVR2, FLUX Video Upscale and
    Edit). ``refs`` is a list of {ref, kind: Image | Video}; each comes back
    as {width, height[, seconds, frames]} or null. Only files in the output
    store are read, by the same rule the spending check uses (the path as
    given and its resolved path both inside the store, no ``..``, nothing
    Nebula is still writing: services/input_sizes.py), so the canvas and the
    check agree; an outside URL or any other path is null, never fetched or
    opened. An inline data: image is null here (the canvas sends files)."""
    refs = body.get("refs") if isinstance(body, dict) else None
    if not isinstance(refs, list) or len(refs) > MAX_SIZE_REFS:
        raise HTTPException(status_code=400, detail=f"refs must be a list of at most {MAX_SIZE_REFS} {{ref, kind}}")
    wanted: list[tuple[str, str]] = []
    for item in refs:
        ref = item.get("ref") if isinstance(item, dict) else None
        kind = item.get("kind") if isinstance(item, dict) else None
        if not isinstance(ref, str) or kind not in ("Image", "Video"):
            raise HTTPException(status_code=400, detail="each ref must be {ref: text, kind: Image or Video}")
        wanted.append((ref, kind))

    def measure_all() -> dict[str, Any]:
        return {ref: input_sizes.measure(ref, kind, inline=False) for ref, kind in wanted}

    return {"sizes": await asyncio.to_thread(measure_all)}


@app.get("/api/moodboard/adapters")
async def get_moodboard_adapters() -> dict:
    """How each node takes a wired Nebula moodboard (services/moodboard_adapters.py,
    contract 07 section 1.16): the hand-written and the generated Krea entries,
    unresolved. Read per request, like prices."""
    from services import moodboard_adapters

    try:
        return moodboard_adapters.public_table()
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"Moodboard adapter table unavailable: {exc}") from exc


@app.get("/api/nodes")
async def list_nodes() -> dict:
    all_nodes = node_registry.get_all()
    nodes_list = list(all_nodes.values())
    categories = node_registry.get_categories()
    return {"nodes": nodes_list, "categories": categories}


def _suggest_node_ids(query: str, definitions: Mapping[str, Mapping[str, Any]]) -> list[str]:
    """Candidate definition ids for a failed lookup (services/node_lookup.py):
    the node types the text is the exact name of first, then ids it starts
    (a family name: `gpt-image-2` lists its four variants), else difflib close
    matches for a typo. [] when nothing is close: callers then skip the
    'Did you mean:' block rather than pad the 404 with noise."""
    return node_lookup.suggestions(query, definitions)


# `{...:path}`: a display name may hold a slash ("Jev Decide (judge / classify / yes-no)").
@app.get("/api/nodes/{node_id:path}")
async def get_node(node_id: str) -> dict:
    """One node definition, for `nebula info`. Takes an id, or the exact
    display name of one node type (ignoring case and outer spaces); a name
    answer starts with `lookup`, the line saying which id it used."""
    all_nodes = node_registry.get_all()
    found = node_lookup.resolve(node_id, all_nodes)
    if found.definition_id is None:
        suggestions = _suggest_node_ids(node_id, all_nodes)
        head = f"Node '{node_id}' not found"
        if len(found.named) > 1:
            head += f": {node_lookup.shared_name_line(node_id, found.named, all_nodes)}"
        if suggestions:
            lines = [f"{head}. Did you mean:"]
            for nid in suggestions:
                meta = all_nodes.get(nid, {})
                display = meta.get("displayName", "")
                category = meta.get("category", "")
                lines.append(f"  - {nid:32s} {display:24s} {category}")
            detail = "\n".join(lines)
        else:
            detail = head
        raise HTTPException(status_code=404, detail=detail)
    node = all_nodes[found.definition_id]
    board = _moodboard_adapter(node)
    # `nebula info` prints them; the definition itself stays as registered.
    lookup = {"lookup": found.note} if found.note else {}
    return {**lookup, **node, **({"moodboardAdapter": board} if board is not None else {})}


def _moodboard_adapter(definition: Mapping[str, Any], settings: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    """What a wired moodboard does on this node type (moodboard_adapters.describe),
    for describe_node and `nebula info`; None without a Moodboard port.
    Settings (for the route the keys pick) are read only for a node with that
    port, so other lookups stay as cheap as before. A table or settings file
    that can't be read leaves it out rather than failing the lookup."""
    from services import moodboard_adapters

    if moodboard_adapters.board_port(definition) is None:
        return None
    try:
        keys = (settings if settings is not None else load_settings()).get("apiKeys") or {}
        return moodboard_adapters.describe(definition, keys)
    except (OSError, ValueError, AttributeError):
        logging.getLogger("nebula.moodboard").exception("Moodboard adapter table or settings unavailable")
        return None


# ---------- CLI: Graph management ----------

_REPLACE_REASONS = ("import", "project-open", "project-create", "project-delete")


_TAB_ID_RE = re.compile(r"[A-Za-z0-9_-]{8,64}")


def _graph_edit_origin() -> dict[str, Any]:
    """Who made the graph edit this request is broadcasting, for open canvases.

    ``actor`` is the journal's actor (services/canvas_events.py): a named
    agent, the person, or anonymous. ``tab`` is the canvas tab that sent the
    request (``X-Nebula-Tab``, set by the canvas's apiFetch), so that tab
    knows the sync is the echo of its own write. A canvas makes every edit it
    didn't send one undo step, named after the actor.
    """
    headers = current_request_headers() or {}
    actor = actor_for_headers(headers)
    origin: dict[str, Any] = {"actor": {key: actor[key] for key in ("kind", "id", "name", "color") if key in actor}}
    tab = next((value for key, value in headers.items() if key.lower() == "x-nebula-tab"), None)
    # Only the person's canvas is a tab (services/person_gate.py: no agent
    # marker AND this launch's person token). A tab id is broadcast on every
    # graphSync, so an agent, or a script that leaves out X-Nebula-Agent,
    # could send one back to pass its edit off as that tab's own echo and
    # keep it off the person's undo stack. A tab without the person token
    # gets no echo match either; it can't be told apart from a script.
    if is_person(headers) and isinstance(tab, str) and _TAB_ID_RE.fullmatch(tab):
        origin["tab"] = tab
    # The edit this sync carries (services/canvas_undo.py), so the canvas's
    # undo step knows which edit it holds and its Cmd+Z can say so.
    link = _canvas_edit_link.get()
    if link:
        origin.update({key: link[key] for key in ("id", "undoes", "redoes") if key in link})
    # The nodes this edit deleted, with the pins and proposals each delete
    # removed: a canvas that didn't send the edit keeps them in its undo step,
    # so its Cmd+Z puts them back too (_reattach_removed_pins).
    removals = _removals_ctx.get()
    if removals:
        origin["removals"] = copy.deepcopy(removals)
    return origin


async def _broadcast_graph_sync(
    *, graph_replaced: bool = False, reason: str = "import", moved: Iterable[str] = (), edit: bool = False,
    project_switch: dict[str, Any] | None = None, arranged: dict[str, Any] | None = None,
    cleared: bool = False, run_params: str | None = None,
) -> dict[str, Any]:
    """Push the current CLI graph to all connected frontends via WebSocket.

    `run_params` (a run id) marks a run's own param write-back
    (_sync_params_to_cli_graph: a handler that enriches params, such as
    video-edit). It carries ``runParams`` and no ``edit``: the canvas treats
    those values as run output, not anyone's edit (round 17 of PR #114,
    review 16 L3).

    `cleared` marks the sync of a Clear (DELETE /api/graph): node ids start
    again at n1 in the same project, so a canvas treats it as a replacement
    for its runs (round 12 of PR #114) while keeping its own frontend-only
    work and the clear's undo step.

    `reason` (import, project-open, project-create) only matters when the
    graph was replaced: watchers are told node ids restarted, and why.
    `moved` names existing nodes this change put somewhere new. A canvas keeps
    its own position for nodes it already shows (the person may be mid-drag),
    so without the list an agent's move didn't show on an open canvas until
    it reloaded.
    `project_switch` (an agent or script opened or made a project) rides on
    the event so the person's canvas follows it and offers the way back
    (frontend projectStore), and names the project in the journal.
    `edit` marks a sync caused by a graph edit request (not a run's outputs or
    status): the sync carries ``edit`` = {actor, tab?} (_graph_edit_origin),
    and an open canvas that didn't send it makes it one undo step. A
    replacement carries it only for an import into the open project (``nebula
    graph load``, a file loaded in another window), which is an edit like any
    other; opening, creating or deleting a project is not.
    `arranged` ({id, nodeIds}) marks the person's canvas finishing an agent's
    arrange (update_graph_layout). It is not an edit: each canvas folds the
    positions into the undo step that added those nodes.
    """
    if graph_replaced:
        # Node ids restart with another project; no open arrange can apply to
        # it. Node errors are kept per project (export points them at the one
        # open now); a graph loaded over this project replaces its nodes, so
        # their errors go.
        canvas_arrange.clear()
        if reason == "import":
            # (The import moved the id epoch itself, with its commit.)
            node_errors.forget_canvas()
        # Journaled here, in the step that replaced the canvas (a switch's
        # commit, an import's), before any await (round 8 of PR #114): the
        # event names the project it opened or loaded into, and lands before
        # a switch that follows. Late, it named whatever project was open
        # then, and the --channel listener dropped that project's pins.
        safe_reason = reason if reason in _REPLACE_REASONS else "import"
        data: dict[str, Any] = {"reason": safe_reason}
        summary = f"replaced the canvas ({safe_reason})"
        if project_switch:
            data.update({key: project_switch[key] for key in ("projectId", "projectName", "previousProjectId",
                                                               "previousProjectName") if key in project_switch})
            verb = "made and opened" if safe_reason == "project-create" else "opened"
            summary = f"{verb} project “{project_switch.get('projectName', '')}”"
            if project_switch.get("previousProjectName"):
                summary += f" (was “{project_switch['previousProjectName']}”)"
        _journal("canvas.replaced", data=data, summary=summary)
        # Pins belong to the project record. A project open or create brings
        # that project's pins; an import into the same project detaches pins
        # whose nodes did not survive: that project's, so here too.
        detached: list[dict[str, Any]] = []
        if safe_reason == "import":
            try:
                detached = canvas_pins.reanchor_missing(set(cli_graph.nodes))
            except (PinError, ProjectStoreError):
                detached = []
        _journal_detached(detached, "the canvas was replaced")
        # Proposals point at node ids that just restarted: none of them still fit.
        closed = canvas_proposals.invalidate_all("the canvas was replaced")
        _journal_closed_proposals(closed)
    export = await export_graph_for_frontend()
    # A cover proposal's view follows the live canvas (a pin's image deleted
    # or back). Before the sync goes out: one a delete closes is named in the
    # delete's removal records, which the sync's ``edit`` carries.
    await _follow_cover_proposals(export)
    if graph_replaced:
        agent_presence.forget_graph()
        await _forget_status_anchors()
    moved_ids = sorted({str(node_id) for node_id in moved if node_id in cli_graph.nodes})
    await manager.broadcast_raw({"type": "graphSync", **export,
                                 **({"graphReplaced": True} if graph_replaced else {}),
                                 **({"cleared": True} if cleared and not graph_replaced else {}),
                                 **({"moved": moved_ids} if moved_ids and not graph_replaced else {}),
                                 **({"projectSwitch": project_switch} if project_switch and graph_replaced else {}),
                                 **({"arranged": arranged} if arranged and not graph_replaced else {}),
                                 **({"runParams": run_params} if run_params and not graph_replaced else {}),
                                 **({"edit": _graph_edit_origin()}
                                    if edit and (not graph_replaced or reason == "import") else {})})
    if graph_replaced:
        # Its events went to the journal above, before any await. (The pins
        # listing follows catalog.json, so one taken between the commit and
        # here names the project open now: ProjectStore.projection.)
        await _broadcast_pins()
        # Updates belong to the project record too: an open or create brings
        # that project's list; an import keeps the project, and its list.
        if safe_reason != "import":
            await _settle_proposal_updates()
            await _broadcast_raw_quietly(_canvas_notes_message())
        # Runs approved on Accept that haven't started don't fit either.
        run_approvals.clear()
        await _broadcast_closed_proposals(closed)
        # Node ids started again, or another project's are live: no earlier
        # delete's undo may reopen a cover proposal by its node id either.
        asset_proposals.drop_removal_tags("the canvas was replaced")
    return export


def _normalized_event_outputs(outputs: Any) -> dict[str, Any]:
    """An ExecutedEvent's outputs in the shape cli_graph stores and browsers get."""
    if not isinstance(outputs, dict):
        return {}
    shaped_outputs = {
        k: v if isinstance(v, dict) else {"type": "Any", "value": v}
        for k, v in outputs.items()
    }
    return _normalize_outputs_for_storage(shaped_outputs)


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
    normalized_outputs = _normalized_event_outputs(outputs)

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
    user sees in the canvas, and by agent runs (/api/graph/run) so the
    canvas shows them node by node, failures included."""
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
        _journal_provider_hold("startAmbiguity", "held", run_id=run_id, node_id=event.node_id, kind=event.kind,
                               durable=event.durable, actor=canvas_events.run_actor(run_id))
        # The hold above is kept; the canvas puts the event on its node by id,
        # so not from a run whose canvas was cleared or replaced since (round
        # 12, as the recovery event below; unreachable while Clear, import and
        # a switch wait for runs).
        if not _run_canvas_moved(run_id, "start-ambiguity event"):
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
        _journal_provider_hold("recovery", "held", run_id=event.run_id or execution_run_id.get(),
                               node_id=event.node_id, durable=event.durable,
                               actor=canvas_events.run_actor(event.run_id or execution_run_id.get()))
        # The checkpoint above is kept (run and node); the canvas puts the
        # event on its node by id, so not from a run whose canvas was cleared
        # or replaced since (round 11; unreachable while Clear, import and a
        # switch wait for runs).
        if not _run_canvas_moved(event.run_id or execution_run_id.get(), "recovery event"):
            await manager.broadcast(event)
        if changed or safety_hold_changed:
            await _broadcast_graph_sync()
        return

    run_id = event.run_id or execution_run_id.get()
    _release_unspent_hold(event, run_id)
    record = execution_runs.get(run_id) if run_id else None
    if record is not None and record.status in {"cancelling", "cancelled"}:
        return
    # A node's event from a run whose canvas was cleared or replaced since
    # names a node id that is now another node (round 11): it writes nothing
    # there (outputs, error, the canvas's card, the journal). The run's own
    # record and its report (get_run) still get it.
    moved = isinstance(getattr(event, "node_id", None), str) and _run_canvas_moved(run_id, "node events")
    if not moved:
        _journal_execution_event(event, run_id)
        _note_node_ran(event, run_id)
        node_errors.observe(event)
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
        normalized_outputs = (_normalized_event_outputs(event.outputs) if moved
                              else _sync_outputs_to_cli_graph(event.node_id, event.outputs))
        updates: dict[str, Any] = {"outputs": normalized_outputs}
        if event.batch_outputs is not None:
            updates["batch_outputs"] = [
                _normalize_outputs_for_storage(snapshot)
                for snapshot in event.batch_outputs
            ]
        event = event.model_copy(update=updates)
    # What get_run reports for the run (services/run_reports.py).
    _run_reports().observe(event, run_id)
    if moved:
        # The canvas would put it on its node with that id (graphStore).
        return
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
                "Nebula captured this World Labs recovery ID but couldn't "
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
            "Nebula captured this World Labs recovery ID without a run ID, "
            "so it couldn't save it durably. Keep this tab open and copy the "
            "ID before reloading."
        )

    current = cli_graph.nodes.get(event.node_id)
    if current is None:
        return False, durability_warning, safety_hold_changed
    # The checkpoint above is kept by run and node (the paid-state record);
    # the node's params only on the canvas the run started on (round 11).
    if _run_canvas_moved(run_id, "recovery params"):
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


def _sync_params_to_cli_graph(
    nodes: list[GraphNode], *, submitted: Mapping[str, Mapping[str, Any]] | None = None,
    run_id: str | None = None,
) -> bool:
    """Mirror handler-mutated params from in-memory GraphNode instances back
    to cli_graph. Pydantic deep-copies params at model_validate time, so any
    handler that enriches node.params (e.g. video-edit seeding clips +
    sourceDuration after probing) needs an explicit sync — otherwise the
    next /api/graph/export sees the pre-execution state and the canvas
    reverts to whatever the user last set manually.

    Only a canvas node of the same definition is written. ``submitted`` is
    for a run whose params came from a request that isn't the person's
    (``_submitted_params``): the params as that request sent them. Then
    only what the run itself changed is copied, never who bills it
    (``_provider``, ``_kreaAuth``: BILLING_PARAMS), so a request can't edit
    the canvas by running a node with the canvas node's id; edits go through
    the edit routes and their checks.

    ``run_id``: the run they came from. Nothing is written if the canvas it
    registered on was cleared or replaced since (_run_canvas_moved)."""
    if _run_canvas_moved(run_id, "params"):
        return False
    persisted = False
    for node in nodes:
        current = cli_graph.nodes.get(node.id, {})
        if current and current.get("definitionId") != node.definition_id:
            continue
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
        if node.id not in cli_graph.nodes:
            continue
        params = node.params
        if submitted is not None:
            sent = submitted.get(node.id) or {}
            params = {
                key: value for key, value in (cli_graph.nodes[node.id].get("params") or {}).items()
                if key in BILLING_PARAMS or key not in sent or key in node.params
            }
            params.update({key: value for key, value in node.params.items()
                           if key not in BILLING_PARAMS and (key not in sent or sent[key] != value)})
        params = _declared_run_params(node.definition_id, params)
        if cli_graph.nodes[node.id].get("params") != params:
            cli_graph.nodes[node.id]["params"] = copy.deepcopy(params)
            persisted = True
    if persisted:
        cli_graph._maybe_persist()
    return persisted


def _declared_run_params(definition_id: str, params: Mapping[str, Any]) -> dict[str, Any]:
    """The run's params minus keys a handler added that the definition doesn't declare.

    Many fal handlers route by writing ``endpoint_id`` into ``node.params``
    (``params.setdefault("endpoint_id", ...)`` in execution/sync_runner.py).
    Mirrored onto the canvas, that key then failed every project autosave
    ("Unknown param(s) for flux-fill-inpaint: ['endpoint_id']", the same check
    as ``_validate_params``), so the top bar stuck on "Save failed". Declared
    keys and ``_``-prefixed canvas state still sync; universal nodes (no fixed
    key list) sync everything, as before. A key that already leaked onto a
    canvas node is dropped by its next run, since the run sends the canvas
    params back.
    """
    valid = _valid_param_keys(definition_id)
    if valid is None:
        return dict(params)
    return {key: value for key, value in params.items() if key.startswith("_") or key in valid}


def _submitted_params(nodes: list[GraphNode]) -> dict[str, dict[str, Any]] | None:
    """The params a run request sent, for ``_sync_params_to_cli_graph``; None
    for the person's own runs, whose params are theirs to keep."""
    if _is_person_request():
        return None
    return {node.id: copy.deepcopy(node.params) for node in nodes}


def _validate_connect_handles(
    src_node_id: str,
    src_port: str,
    dst_node_id: str,
    dst_port: str,
    *,
    graph: CLIGraph | None = None,
    saved: bool = False,
) -> None:
    """Reject a connection that violates the shared registry contract.

    ``saved``: the edge comes from a saved project, which keeps a wire that
    was valid before its input port's type changed (port_contracts
    RETYPED_PORTS); a run refuses it and says what to do instead.

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
    if proposed_issue is not None and not (saved and proposed_issue.kind == "retyped"):
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
    return {str(p["key"]) for p in node_route.all_param_definitions(defn)}


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
    param_specs: dict[str, tuple[str, bool]] = {
        str(p["key"]): (p["type"], bool(p.get("required")))
        for p in node_route.all_param_definitions(defn) if p.get("type")
    }
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


def _journal_node_added(node_id: str, *, actor: dict[str, Any] | None = None, note: str = "",
                        proposal_id: str | None = None) -> None:
    _journal("node.added", actor=actor, **_node_added_event(node_id, note=note, proposal_id=proposal_id))


def _node_added_event(node_id: str, *, note: str = "", proposal_id: str | None = None) -> dict[str, Any]:
    """node.added's node_id, data and summary, read from the canvas now."""
    node = cli_graph.nodes.get(node_id) or {}
    data: dict[str, Any] = {
        "definitionId": str(node.get("definitionId") or ""),
        "name": _node_label(node_id),
    }
    if isinstance(node.get("position"), dict):
        data["position"] = node["position"]
    if proposal_id:
        data["proposalId"] = proposal_id
    return {"node_id": node_id, "data": data, "summary": f"added {data['name']} ({node_id}){note}"}


def _journal_edge(kind: str, edge: dict[str, Any], *, actor: dict[str, Any] | None = None, note: str = "",
                  proposal_id: str | None = None) -> None:
    data = _edge_data(edge)
    if proposal_id:
        data["proposalId"] = proposal_id
    verb = "connected" if kind == "edge.added" else "disconnected"
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
    proposal_id: str | None = None,
) -> None:
    """One node.added per node and edge.added per wire, each capped at 50.
    With `proposal_id` (an accepted proposal's), each names it in data, so a
    reader can tell what the accept applied from the person's own edits."""
    for node_id in node_ids[:50]:
        _journal_node_added(node_id, actor=actor, note=note, proposal_id=proposal_id)
    if len(node_ids) > 50:
        rest = node_ids[50:]
        data: dict[str, Any] = {"count": len(rest), "nodeIds": rest[:50]}
        if proposal_id:
            data["proposalId"] = proposal_id
        _journal(
            "node.added",
            data=data,
            summary=f"added {len(rest)} more nodes{note}",
            actor=actor,
        )
    wanted = set(edge_ids)
    for edge in [edge for edge in cli_graph.edges if edge.get("id") in wanted][:50]:
        _journal_edge("edge.added", edge, actor=actor, note=note, proposal_id=proposal_id)


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
    fence = _graph_fence()
    _validate_graph_ingress_complexity(body)
    definition_id = body.get("definitionId", "")
    if message := retired_message(str(definition_id)):
        raise HTTPException(status_code=400, detail=message)
    _refuse_unknown_definition(definition_id)
    raw_params = body.get("params", {})
    params = {} if raw_params is None else raw_params
    if not isinstance(params, dict):
        raise HTTPException(status_code=400, detail="params must be an object")
    position = body.get("position")
    _validate_params(definition_id, params)
    _refuse_agent_internal_params(params, str(definition_id))
    _check_provider(str(definition_id), params, str(definition_id))
    params = migrate_params(definition_id, _coerce_params(definition_id, params))
    if (not _is_person_request() and universal_ports.is_universal(str(definition_id))
            and universal_ports.model_of(str(definition_id), params)):
        # Anyone but the person (an agent, the unnamed CLI) gets the node
        # configured for its model, as the picker would.
        models = await _look_up_models([(str(definition_id), universal_ports.model_of(str(definition_id), params))])
        _refuse_if_graph_moved(fence)
        params, _reason = universal_ports.agent_update(str(definition_id), {}, params, models)
    _check_asset_refs(str(definition_id), params, str(definition_id))
    _refuse_agent_billing_change([(str(definition_id), str(definition_id), None, params)])
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
        _refuse_agent_growth_past_save_limit(candidate)
        _commit_graph_candidate_with_recoveries(
            candidate,
            [candidate.nodes[short_id]],
            source="create",
        )
    # Journaled before any await, so it names the project the node went to
    # (round 8 of PR #114); the reply is the node as it was made.
    _journal_node_added(short_id)
    created = copy.deepcopy(cli_graph.nodes[short_id])
    await _broadcast_graph_sync(edit=True)
    publish_action(f"Added {definition_id} ({short_id})")
    await _show_agent({"nodeId": short_id}, say=f"Added {_quoted(_node_label(short_id))}", did=_did("Added", short_id))
    return created


@app.post("/api/graph/connect")
async def connect_graph_nodes(body: dict[str, Any]) -> dict:
    _check_workspace_revision()
    _validate_connect_handles(
        body.get("source", ""),
        body.get("sourceHandle", ""),
        body.get("target", ""),
        body.get("targetHandle", ""),
    )
    _guard_approved_runs(lambda probe: probe.connect(
        body["source"], body["sourceHandle"], body["target"], body["targetHandle"],
    ))
    _guard_agent_growth_past_save_limit(lambda probe: probe.connect(
        body["source"], body["sourceHandle"], body["target"], body["targetHandle"],
    ))
    try:
        edge = cli_graph.connect(
            body["source"], body["sourceHandle"],
            body["target"], body["targetHandle"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _journal_edge("edge.added", edge)  # before any await (round 8 of PR #114)
    await _broadcast_graph_sync(edit=True)
    publish_action(
        f"Connected {edge['source']}:{edge['sourceHandle']} → "
        f"{edge['target']}:{edge['targetHandle']}"
    )
    await _show_agent(
        {"nodeId": edge["target"], "handle": edge["targetHandle"]},
        origin={"nodeId": edge["source"], "handle": edge["sourceHandle"]},
        action="drag",
        say=f"Connecting {_quoted(_node_label(edge['source']))} to {_quoted(_node_label(edge['target']))}",
        did=_did("Connected", edge["target"]),
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
    if message := retired_message(str(definition_id)):
        raise HTTPException(status_code=400, detail=message)
    _refuse_unknown_definition(definition_id)
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
    _refuse_agent_internal_params(params, str(definition_id))
    _check_provider(str(definition_id), params, str(definition_id))
    params = migrate_params(definition_id, _coerce_params(definition_id, params))
    _check_asset_refs(str(definition_id), params, str(definition_id))
    _refuse_agent_billing_change([(str(definition_id), str(definition_id), None, params)])
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
            except ValueError as exc:
                # Discard the persistence-free candidate on every connection
                # failure; the caller requested a pair, not a standalone node.
                raise HTTPException(status_code=400, detail=f"Cannot connect this node: {exc}") from exc

        _refuse_agent_change_to_approved_runs(candidate)
        _refuse_agent_growth_past_save_limit(candidate)
        _commit_graph_candidate_with_recoveries(
            candidate,
            [candidate.nodes[short_id]],
            source="create-connect",
        )

    rf_edge = None
    if edge is not None:
        source_node = candidate.nodes[src]
        source_def = node_registry.get(source_node["definitionId"]) or {}
        source_ports = node_ports(source_node["definitionId"], source_node.get("params"), source_def, "outputPorts")
        data_type = next((port["dataType"] for port in source_ports
                          if port["id"] == edge["sourceHandle"]), "Any")
        rf_edge = {**copy.deepcopy(edge), "type": "typed-edge", "data": {"dataType": data_type}}
    # Preserve the raw top-level node contract for existing CLI callers while
    # letting the canvas adopt only a connection explicitly confirmed by us.
    response = {**copy.deepcopy(candidate.nodes[short_id]), "connected": edge is not None, "edge": rf_edge}
    # Before any await (round 8 of PR #114).
    _journal_node_added(short_id)
    if edge is not None:
        _journal_edge("edge.added", edge)
    await _broadcast_graph_sync(edit=True)
    publish_action(f"Added {definition_id} ({short_id})")
    if edge is not None:
        publish_action(
            f"Connected {src}:{connect_spec.get('sourceHandle', '')} → "
            f"{dst}:{connect_spec.get('targetHandle', '')}"
        )
        await _show_agent(
            {"nodeId": dst, "handle": connect_spec.get("targetHandle", "")},
            origin={"nodeId": src, "handle": connect_spec.get("sourceHandle", "")},
            action="drag",
            say=f"Added {_quoted(_node_label(short_id))} and connected it",
            did=_did("Added", short_id),
        )
    else:
        await _show_agent({"nodeId": short_id}, say=f"Added {_quoted(_node_label(short_id))}", did=_did("Added", short_id))
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
        defaults = {param["key"]: copy.deepcopy(param["default"])
                    for param in node_route.all_param_definitions(definition) if "default" in param}
        _validate_params("veo-3", defaults)
        defaults = _coerce_params("veo-3", defaults)
        try:
            position = _cinema_motion_source_position(node_id)
            candidate = cli_graph.clone()
            target_id = candidate.add_node("veo-3", defaults, position={"x": position["x"] + 360.0, "y": position["y"]})
            _validate_connect_handles(node_id, port_id, target_id, "image", graph=candidate)
            edge = candidate.connect(node_id, port_id, target_id, "image")
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
        await _broadcast_graph_sync(edit=True)
        publish_action(f"Connected Cinema {node_id}:{port_id} to Veo ({target['id']})")
    return response


@app.get("/api/graph")
async def get_graph() -> dict:
    return cli_graph.get_state()


def _author_cinema_scene(graph: CLIGraph, node_id: str, node: dict[str, Any], params: dict[str, Any]) -> None:
    """Keep a Cinema scene's runtime media when a write sets its authoring.

    Shared by PUT /api/graph/node/{id} and POST /api/graph/restore. Changes
    ``params["scene"]`` in place, and drops the node's outputs and the wires
    of shots the new scene no longer has (on ``graph``)."""
    if node.get("definitionId") != "cinema-scene" or "scene" not in params:
        return
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
    graph.edges = [edge for edge in graph.edges
                   if edge.get("source") != node_id
                   or not str(edge.get("sourceHandle", "")).startswith("shot_")
                   or edge["sourceHandle"] in valid_ports]


def _keep_recovery_checkpoint(node: dict[str, Any], params: dict[str, Any]) -> bool:
    """For a World Labs recovery node, keep its live checkpoint in ``params``
    (in place) and return True; False for every other node.

    Shared by PUT /api/graph/node/{id} and POST /api/graph/restore."""
    recovery_update = isinstance(node.get("definitionId"), str) and uses_durable_recovery(
        str(node.get("definitionId")),
        provider="worldlabs",
    )
    if not recovery_update:
        return False
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
    return True


@app.put("/api/graph/node/{node_id}")
async def update_graph_node(request: Request, node_id: str, body: dict[str, Any]) -> dict:
    _check_workspace_revision()
    fence = _graph_fence()
    _validate_graph_ingress_complexity(body)
    # Anyone but the person (an agent, the unnamed CLI) who sets a universal
    # node's model reconfigures it (its ports follow the model): when the model
    # changes, or its ports are stale (a node saved before ports were kept, or
    # a Replicate node whose file output was kept untyped: universal_ports.needs_configuring).
    # The same model again reads nothing. The canvas's own pushes are stored
    # as sent; its picker uses /model.
    models: dict[tuple[str, str], Any] | None = None
    current = cli_graph.nodes.get(node_id) or {}
    current_definition = str(current.get("definitionId") or "")
    current_params = current.get("params") or {}
    model_key = universal_ports.MODEL_PARAM.get(current_definition)
    if (model_key and not _is_person_request() and isinstance(body.get("params"), dict)
            and model_key in body["params"]):
        model = universal_ports.model_of(current_definition, {**current_params, **body["params"]})
        if (model != universal_ports.model_of(current_definition, current_params)
                or universal_ports.needs_configuring(current_definition, current_params)):
            models = await _look_up_models([(current_definition, model)])
    _refuse_if_graph_moved(fence)  # another project may have opened during the lookup
    with _paid_graph_mutation("update graph node parameters"):
        node = cli_graph.nodes.get(node_id)
        if not node:
            raise _node_gone(node_id)
        params_before = copy.deepcopy(node.get("params") or {})

        raw_params = body.get("params", {})
        params = {} if raw_params is None else raw_params
        if not isinstance(params, dict):
            raise HTTPException(status_code=400, detail="params must be an object")
        _validate_params(node.get("definitionId", ""), params)
        _refuse_agent_internal_params(params, node_id)
        _check_provider(str(node.get("definitionId") or ""), params, node_id)
        params = migrate_param_update(node.get("definitionId", ""), params_before,
                                      _coerce_params(node.get("definitionId", ""), params))
        _check_asset_refs(str(node.get("definitionId") or ""), params, node_id, before=params_before)
        _refuse_agent_billing_change([(node_id, str(node.get("definitionId") or ""), params_before,
                                            {**params_before, **params})])
        if models is not None and node.get("definitionId") == current_definition:
            # Universal nodes carry no recovery checkpoint or Cinema scene.
            full, reason = universal_ports.agent_update(current_definition, params_before, params, models)
            probe = cli_graph.clone()
            probe.set_params(node_id, full)
            _refuse_orphaned_wires(probe, node_id, reason=reason or "")
            _refuse_agent_growth_past_save_limit(probe)
            _guard_approved_runs(lambda probe: probe.set_params(node_id, copy.deepcopy(full)))
            _drop_outputs_off_ports(cli_graph, node_id, full)
            cli_graph.set_params(node_id, full)
        else:
            _guard_approved_runs(lambda probe: probe.update_params(node_id, copy.deepcopy(params)))
            if not _is_person_request():
                grown = cli_graph.clone()
                grown.update_params(node_id, copy.deepcopy(params))
                _refuse_agent_growth_past_save_limit(grown)
            _author_cinema_scene(cli_graph, node_id, node, params)
            recovery_update = _keep_recovery_checkpoint(node, params)
            if recovery_update:
                candidate = cli_graph.clone()
                try:
                    candidate.update_params(node_id, params)
                except ValueError:
                    raise _node_gone(node_id)
                _commit_graph_candidate_with_recoveries(
                    candidate,
                    [candidate.nodes[node_id]],
                    source="update",
                )
            else:
                try:
                    cli_graph.update_params(node_id, params)
                except ValueError:
                    raise _node_gone(node_id)
    # Journaled before any await, so it names the project the change was made
    # in (round 8 of PR #114); the reply is the node as the change left it.
    changes = param_changes(params_before, (cli_graph.nodes.get(node_id) or {}).get("params") or {})
    if changes:
        _journal(
            "node.params",
            node_id=node_id,
            data=changes,
            summary=f"set {_listed(changes['keys'], 4)} on {_node_label(node_id)} ({node_id})",
        )
    updated = copy.deepcopy(cli_graph.nodes[node_id])
    await _broadcast_graph_sync(edit=True)
    publish_action(f"Updated {node_id} params")
    changed = ", ".join(sorted(str(key) for key in params)[:4])
    await _show_agent({"nodeId": node_id}, say=f"Set {changed}" if changed else f"Updated {_quoted(_node_label(node_id))}",
                      did=_did("Changed", node_id))
    return updated


def _universal_request(body: Any, definition_id: str | None = None) -> tuple[str, str]:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be an object")
    definition_id = definition_id if definition_id is not None else str(body.get("definitionId") or "")
    if not universal_ports.is_universal(definition_id):
        raise HTTPException(status_code=400, detail=(
            "Only the OpenRouter, Nous Portal and Replicate nodes take their ports from a model"))
    model = body.get("model")
    if not isinstance(model, str) or not model.strip() or len(model) > 300:
        raise HTTPException(status_code=400, detail="model must be a model id")
    return definition_id, model.strip()


async def _universal_data(definition_id: str, model: str) -> dict[str, Any]:
    found = await universal_ports.look_up(definition_id, model)
    if isinstance(found, str):
        raise HTTPException(status_code=400, detail=found[0].upper() + found[1:] + ".")
    return found


@app.post("/api/universal/ports")
async def universal_model_ports(body: dict[str, Any]) -> dict[str, Any]:
    """The ports and settings a universal node has for one model, without a node.

    Body: {definitionId: "openrouter-universal" | "nous-portal-universal" |
    "replicate-universal", model, params?}. Reads the provider's model list or
    schema with the person's key (cached; nothing billed). Returns `inputs`,
    `outputs` (the canvas's port shape), `nodeParams` (`params`, or {},
    configured for the model as the picker sets them), `providerMeta` and,
    for Replicate, `params` (the model's other inputs, set as params) and
    `versionId`."""
    _validate_graph_ingress_complexity(body)
    definition_id, model = _universal_request(body)
    base = body.get("params") if isinstance(body.get("params"), dict) else {}
    configured = universal_ports.configure(definition_id, base, model, await _universal_data(definition_id, model))
    result: dict[str, Any] = {"definitionId": definition_id, "model": model,
                              "inputs": configured.inputs, "outputs": configured.outputs,
                              "nodeParams": configured.params, "providerMeta": configured.provider_meta}
    if definition_id == "replicate-universal":
        result["params"] = configured.dynamic_params
        result["versionId"] = configured.provider_meta.get("version_id")
    return result


@app.post("/api/graph/node/{node_id}/model")
async def configure_universal_node(node_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """The canvas's model picker: set a universal node's model and the ports,
    params and Inspector controls that come with it (services/universal_ports.py).

    Body: {model}. Writes the node's params as the picker always did, drops
    wires on ports the new model doesn't have, and syncs the canvas. Returns
    the node's `params`, `dynamicInputPorts`, `dynamicOutputPorts`,
    `dynamicParams`, `providerMeta` (additions) and `removedEdges`. Only the
    person: it drops wires, past the approved-run and billing checks an edit
    gets. Anyone else (agents, the unnamed CLI, a tab without the person
    link) sets the model with an edit (edit_canvas, `nebula apply`) or PUT
    /api/graph/node/{id}, which configure the node the same way and refuse
    rather than drop wires."""
    require_person(current_request_headers(), hint=(
        "Set a universal node's model with an edit (edit_canvas or `nebula apply`, params {model: ...}) "
        "or PUT /api/graph/node/{id}: its ports follow the model."))
    _check_workspace_revision()
    fence = _graph_fence()
    node = cli_graph.nodes.get(node_id)
    if node is None:
        raise _node_gone(node_id)
    definition_id, model = _universal_request(body, str(node.get("definitionId") or ""))
    data = await _universal_data(definition_id, model)
    _refuse_if_graph_moved(fence)
    with _paid_graph_mutation("set a node's model"):
        node = cli_graph.nodes.get(node_id)
        if node is None or node.get("definitionId") != definition_id:
            raise _node_gone(node_id)
        params_before = copy.deepcopy(node.get("params") or {})
        configured = universal_ports.configure(definition_id, params_before, model, data)
        removed = [copy.deepcopy(edge) for edge in cli_graph.edges
                   if not universal_ports.edge_fits(node_id, edge, configured.inputs, configured.outputs)]
        candidate = cli_graph.clone()
        for edge in removed:
            candidate.remove_edge(edge["source"], edge["sourceHandle"], edge["target"], edge["targetHandle"])
        _drop_outputs_off_ports(candidate, node_id, configured.params)
        candidate.set_params(node_id, configured.params)
        _commit_graph_candidate_with_recoveries(candidate, [candidate.nodes[node_id]], source="update")
    # Before any await (round 8 of PR #114).
    changes = param_changes(params_before, (cli_graph.nodes.get(node_id) or {}).get("params") or {})
    if changes:
        _journal("node.params", node_id=node_id, data=changes,
                 summary=f"set {_listed(changes['keys'], 4)} on {_node_label(node_id)} ({node_id})")
    for edge in removed:
        _journal_edge("edge.removed", edge)
    await _broadcast_graph_sync(edit=True)
    publish_action(f"Set {node_id}'s model to {model}")
    return {
        "params": configured.params,
        "dynamicInputPorts": configured.inputs,
        "dynamicOutputPorts": configured.outputs,
        "dynamicParams": configured.dynamic_params,
        "providerMeta": configured.provider_meta,
        "removedEdges": [{"id": edge.get("id"), **_edge_data(edge)} for edge in removed],
    }


@app.put("/api/graph/node/{node_id}/label")
async def rename_graph_node(node_id: str, body: dict[str, Any]) -> dict:
    """Rename a node on the canvas. A blank name, or the model's own name,
    clears the custom name. Names don't affect execution, so this stays out of
    the paid-mutation fence, like layout."""
    _check_workspace_revision()
    node = cli_graph.nodes.get(node_id)
    if not node:
        raise _node_gone(node_id)
    raw = body.get("label")
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="label must be a string")
    previous = _node_label(node_id)
    label = _custom_node_label(raw, str(node.get("definitionId", "")))
    _guard_agent_growth_past_save_limit(lambda probe: probe.set_label(node_id, label))
    cli_graph.set_label(node_id, label)
    current = _node_label(node_id)
    if current != previous:
        _journal(  # before any await (round 8 of PR #114)
            "node.renamed",
            node_id=node_id,
            data={"from": previous, "to": current},
            summary=f"renamed {previous} ({node_id}) to {current}",
        )
    await _broadcast_graph_sync(edit=True)
    if current != previous:
        publish_action(f"Renamed {node_id}")
        # An agent's rename is an action like any edit (the Agents panel's
        # line, Q125 item 2); a no-op for the person's own.
        await _show_agent({"nodeId": node_id}, say=f"Renamed {_quoted(current)}", did=_did("Renamed", node_id))
    return {"id": node_id, "label": current}


@app.put("/api/graph/layout")
async def update_graph_layout(body: dict[str, Any]) -> dict:
    """Persist a complete or partial Canvas layout in one atomic mutation.

    With ``arrangeId`` this is a canvas finishing an agent's arrange request
    (services/canvas_arrange.py): only that request's nodes may be in
    ``positions``, and only the first write for the id applies. A later one
    (another open tab) returns ``already-arranged`` and changes nothing.
    From the person's canvas it is no edit of its own (see the broadcast below).
    Without it, the nodes it positions drop out of any open arrange.
    """
    _check_workspace_revision()
    raw_positions = body.get("positions")
    if not isinstance(raw_positions, dict) or not raw_positions:
        raise HTTPException(status_code=400, detail="positions must be a non-empty object")
    arrange_id = body.get("arrangeId")
    arrange = None
    if arrange_id is not None:
        if not isinstance(arrange_id, str):
            raise HTTPException(status_code=400, detail="arrangeId must be a string")
        arrange = canvas_arrange.get(arrange_id)
        if arrange is None:
            return {"status": "already-arranged", "count": 0}
        outside = sorted(set(raw_positions) - set(arrange.node_ids))
        if outside:
            raise HTTPException(status_code=400, detail=(
                f"{outside[0]} isn't one of the new nodes this arrange lays out; "
                "an arrange never moves other nodes"))
        # Nodes deleted since the request are simply skipped.
        raw_positions = {node_id: point for node_id, point in raw_positions.items() if node_id in cli_graph.nodes}

    normalized: dict[str, dict[str, float]] = {}
    for node_id, raw_position in raw_positions.items():
        if node_id not in cli_graph.nodes:
            raise _node_gone(node_id)
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
    if arrange is not None:
        # Close it before anything awaits, so a second tab's write can't also apply.
        canvas_arrange.complete(arrange.id)
        if not normalized:
            await _broadcast_graph_sync()
            return {"status": "arranged", "count": 0}
    try:
        cli_graph.update_positions(normalized)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if arrange is None:
        canvas_arrange.forget_nodes(normalized)
    # This route is the authoritative move signal (drag end, auto-layout,
    # paste). Journaled before any await (round 8 of PR #114).
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
            summary=f"{'arranged' if arrange is not None else 'moved'} {_listed(moved)}",
            # The agent asked for the arrange; a canvas only measured. An agent
            # that writes it (the arrangeId is on every graphSync) is credited
            # itself, so it can't put its positions under another agent's name.
            actor=arrange.actor if arrange is not None and not has_agent_marker(current_request_headers()) else None,
        )
    if arrange is not None and is_person(current_request_headers()):
        # The person's canvas laying out an agent's new nodes finishes that
        # agent's edit; it is not a new one. No `edit`, so no tab makes it a
        # step of its own; `arranged` tells each tab to fold these positions
        # into the step that added the nodes, so its redo puts them here.
        # Anyone else's write (an agent or script can read the arrangeId off
        # a graphSync) stays a normal edit, credited to it, as before.
        await _broadcast_graph_sync(moved=normalized, arranged={"id": arrange.id, "nodeIds": sorted(normalized)})
    else:
        await _broadcast_graph_sync(edit=True, moved=normalized)
    publish_action(f"Updated layout for {len(normalized)} node(s)")
    if moved:
        if arrange is None:
            # An agent's move (`nebula move`) is an action too (the Agents
            # panel's line, Q125 item 2); a no-op for the person's drags.
            await _show_agent({"nodeId": moved[0]}, action="move", say=f"Moved {_quoted(_node_label(moved[0]))}",
                              did=_did("Moved", moved[0]))
    if arrange is not None:
        return {"status": "arranged", "count": len(normalized), "positions": normalized}
    return {"status": "updated", "count": len(normalized)}


def _require_clear_intent(force: bool) -> None:
    """Clearing a project that has nodes needs an explicit ``force``, from
    every caller (Justin's D3, 2026-10-18). This is a check of intent, not of
    who is asking: agents may clear too, because an open canvas makes the
    clear one undo step (the graphSync carries ``edit``; Undo sends the nodes,
    wires, names and outputs back through POST /api/graph/restore). The
    canvas's Clear button and chat /clear send force after the person
    confirms, and `nebula clear --force` sends it when asked to. No MCP tool
    clears the canvas: MCP agents start fresh work with new_project, and
    remove_from_canvas deletes nodes (its result's undo token puts them back)."""
    if force or not cli_graph.nodes:
        return
    count = len(cli_graph.nodes)
    raise HTTPException(status_code=409, detail=(
        f"The open project has {count} node{'s' if count != 1 else ''}, and clearing removes all of them. "
        "To start fresh and keep this work, make a new project: `nebula project new \"<name>\"` "
        "(MCP: new_project). To clear it anyway, pass force: `nebula clear --force` "
        "(DELETE /api/graph?force=true). The person can undo a clear on an open canvas."
    ))


@app.delete("/api/graph")
async def clear_graph(force: bool = False) -> dict:
    # Clear Canvas is not consent to forget paid-provider state. Resolve each
    # recovery/ambiguity through its exact endpoint first; otherwise recreating
    # a node with the same identity could silently duplicate provider spend.
    _check_workspace_revision()
    _require_clear_intent(force)
    with _paid_graph_mutation("clear the canvas"):
        # As a switch, an import and a delete of the open project (round 11 of
        # PR #114): a registered run writes back by node id, and ids start
        # again after a clear. Its paid-start fence and the run fence.
        _project_replacement_guard("clear the canvas", person=CLEAR_DURING_RUN_PERSON)
        cli_graph.clear()
        # The id epoch moves in the step that restarted the ids, before any
        # await (review 10's F6): a write fenced before this clear that
        # rechecks during the awaits below must see it.
        _forget_canvas_undo("the canvas was cleared since")
        run_approvals.clear()
        # Ids start again at n1: no node now is one a restore brought back.
        node_removals.forget_project(_workspace_context()["activeProjectId"])
    # In the step that cleared it, before any await (round 8 of PR #114): the
    # pins that lost their nodes are this project's (after an await another
    # project may be open, and its pins would be detached instead), and every
    # event names the project cleared.
    _journal("canvas.cleared", summary="cleared the canvas")
    try:
        detached = canvas_pins.reanchor_missing(set())
    except (PinError, ProjectStoreError):
        detached = []
    _journal_detached(detached, "the canvas was cleared")
    closed = canvas_proposals.invalidate_all("the canvas was cleared")
    _journal_closed_proposals(closed)
    asset_proposals.drop_removal_tags("the canvas was cleared")
    agent_presence.forget_graph()
    await _forget_status_anchors()
    await _broadcast_graph_sync(edit=True, cleared=True)
    publish_action("Cleared the canvas")
    if detached:
        await _broadcast_pins()
    await _broadcast_closed_proposals(closed)
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
            # Run History's "Forget ID": the same "still
            # waiting" line as the node's own refusal (round 3 review).
            raise refusal_copy.refusal(
                409,
                "Cannot delete a World Labs recovery checkpoint while that "
                "node's paid start is still settling",
                _paid_state_person("active"),
                route="canvas",
            )
        try:
            removed = provider_recovery_store.delete(
                run_id=run_id,
                node_id=node_id,
                resume_operation_id=resume_operation_id,
                existing_world_id=existing_world_id,
            )
        except ProviderRecoveryConflictError as exc:
            raise refusal_copy.refusal(409, str(exc), _paid_job_changed_person(f"{FORGET_BUTTON} in Run History"),
                                       route="canvas") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ProviderRecoveryPersistenceError as exc:
            raise RunSafetyStorageRefusal(
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
    if removed:
        _journal_provider_hold("recovery", "cleared", run_id=run_id, node_id=node_id)  # before any await
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
        # The status bar's "I've checked Marble" (round 3b): the person reads the line for
        # why it can't unlock yet; agents keep the exact text.
        raise _start_refusal(exc, own_node=True) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProviderStartPersistenceError as exc:
        raise RunSafetyStorageRefusal(
            detail="Could not durably acknowledge World Labs paid-start hold",
        ) from exc
    if removed:
        _journal_provider_hold("startAmbiguity", "cleared", run_id=run_id, node_id=node_id, kind=kind)  # before any await
    await _broadcast_graph_sync()
    return {
        "status": "acknowledged",
        "kind": kind,
        "nodeId": node_id,
        "runId": run_id,
        "removed": removed,
    }


# What the person's canvas reads when a node can't go (error-copy review, GM:
# never ids in what the person reads; "People get the written line and agents
# keep the specific detail"). Round 3: _paid_state_person, by the record that
# holds the node; an ID in its params names that node's own fields by their
# labels (round 3 review: a World export node has only "Resume Export
# Operation ID"). Agents keep the detail with the id, unchanged.
NODE_GONE_PERSON = "That node isn't on the canvas anymore."


def _node_refusal(status: int, specific: str, person: str) -> HTTPException:
    return refusal_copy.refusal(status, specific, person, route="canvas")


def _node_gone(node_id: str, specific: str | None = None) -> HTTPException:
    """404 for a node that isn't on the canvas: GM's line for the person
    (approved round 3), the id for agents."""
    return _node_refusal(404, specific or f"Node '{node_id}' not found", NODE_GONE_PERSON)


def _ensure_node_deletable(node_id: str, node: dict[str, Any]) -> None:
    """Refuse (409) to delete a node that still carries World Labs paid state.

    Call inside _paid_graph_mutation so no paid start can land in between.
    The person reads _paid_state_person for the record that holds it; an
    agent reads the node's id.
    """
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
    state = ("active" if active else "ambiguity" if held else "recovery" if recovered
             else "params" if live_checkpoint else None)
    if state is not None:
        raise _node_refusal(
            409,
            f"Cannot delete {node_id}: it has unresolved World Labs paid state. "
            "Check Marble, then resolve its exact recovery/ambiguity record "
            "first.",
            _paid_state_person(state, node=_node_label(node_id),
                               fields=_recovery_field_labels([node]) if state == "params" else ()),
        )


@app.delete("/api/graph/node/{node_id}")
async def delete_graph_node(node_id: str) -> dict:
    """Remove a node and any edges touching it from cli_graph."""
    _check_workspace_revision()
    with _paid_graph_mutation("delete a graph node"):
        node = cli_graph.nodes.get(node_id)
        if node is None:
            raise _node_gone(node_id)
        _ensure_node_deletable(node_id, node)
        _guard_approved_runs(lambda probe: probe.remove_node(node_id))
        label = _node_label(node_id)
        removed_definition = str(node.get("definitionId") or "")
        removed_position = copy.deepcopy(node.get("position"))
        try:
            cli_graph.remove_node(node_id)
        except ValueError:
            raise _node_gone(node_id)
    entries = _remove_side_effects(
        [{"id": node_id, "name": label, "definitionId": removed_definition, "position": removed_position}],
        lambda gone: f"{gone['name']} ({gone['id']}) was deleted")
    _journal_removed_nodes(entries, note="", pin_reason=lambda gone: f"{gone['name']} was deleted")
    removals = _removal_records(entries)
    token = _removals_ctx.set(removals)
    try:
        await _broadcast_graph_sync(edit=True)
    finally:
        _removals_ctx.reset(token)
    _renew_kept_removals(removals)
    publish_action(f"Removed {node_id}")
    last_point = agent_presence.last_point(node_id)
    await _announce_removed_nodes(entries)
    if last_point is not None:
        await _show_agent(last_point, say=f"Removed {_quoted(label)}", did={"verb": "Removed", "nodeId": None, "label": label})
    # What the delete removed, for its undo (POST /api/graph/restore `removals`).
    # `label` is its name as the canvas showed it (the type's name when it has none): `nebula delete` says it.
    return {"status": "deleted", "id": node_id, "label": label, "removal": removals[0]}


def _billing_choice(definition_id: str, params: Mapping[str, Any]) -> tuple[str, str] | None:
    """Who bills a node's run with these params, as far as the person
    chooses it: (provider choice, Krea mode). The provider choice is a
    route-table node's ``_provider`` (a route id, or "auto"; '' on every
    other node); the Krea mode is ``_kreaAuth`` on a node that offers both
    API-token and plan billing ('' when it doesn't). None when the node has
    neither choice (account-only Krea nodes have no choice to change)."""
    definition = node_registry.get(definition_id) or {}
    provider = node_route.provider_choice(params) if node_route.has_routes(definition) else ""
    modes = node_readiness.krea_modes(definition)
    mode = ""
    if len(modes) >= 2:
        param = next((p for p in definition.get("params") or [] if p.get("key") == "_kreaAuth"), {})
        mode = str(params.get("_kreaAuth") or param.get("default") or "api-token")
    return (provider, mode) if provider or mode else None


KREA_BILLING_REFUSAL = (
    "Changing how a Krea node is billed (_kreaAuth: the API token's balance or the signed-in Krea "
    "plan) is the person's call, so it needs their OK. Leave _kreaAuth as it is, and propose the "
    "change instead with propose_change (`nebula propose`); the person accepts it on the canvas."
)
PROVIDER_CHOICE_REFUSAL = (
    "Changing which provider a node runs on (_provider: a route id, or auto) decides whose key "
    "pays for it, so it's the person's call and needs their OK. Leave _provider as it is, and "
    "propose the change instead with propose_change (`nebula propose`); the person accepts it "
    "on the canvas."
)


NOTES_TO_GENERATORS_REFUSAL = (
    "Sending a board's notes to generators (send_notes on a Moodboard node) is the person's call: "
    "notes are their words about the board, for them, their team and agents. Leave send_notes as it "
    "is (an agent may set it to no), don't point a node that sends notes at another board (set "
    "send_notes to board or no in the same edit), and propose the change instead with propose_change "
    "(`nebula propose`); the person accepts it on the canvas."
)
# How far each send_notes value opens the notes: "board" follows the board's
# own switch, so it may send them; "yes" always does.
_SEND_NOTES_RANK = {"no": 0, "board": 1, "yes": 2}


def _send_notes_rank(params: Mapping[str, Any] | None) -> int:
    value = (params or {}).get("send_notes")
    return _SEND_NOTES_RANK.get(value if isinstance(value, str) else "board", 1)


def _notes_opened(before: Mapping[str, Any] | None, after: Mapping[str, Any] | None) -> bool:
    """Whether a Moodboard node edit sends notes the person didn't opt in to:
    ``send_notes`` opened further, or a node on "yes" moved to another board."""
    rank = _send_notes_rank(after)
    if rank > _send_notes_rank(before):
        return True
    return (before is not None and rank == _SEND_NOTES_RANK["yes"]
            and (before or {}).get("moodboard") != (after or {}).get("moodboard"))


def _refuse_agent_billing_change(changes: Iterable[tuple[str, str, Mapping[str, Any] | None, Mapping[str, Any]]]) -> None:
    """403 when an edit that isn't the person's would change who bills a
    node's run: a route-table node's ``_provider``, or a Krea node's billing
    mode (_billing_choice). ``changes`` are (label, definitionId, params
    before or None for a new node, params after). A new node counts as
    changed unless it starts on Auto and the default mode (the API token).
    The person's own edits and accepted proposals always pass. The refusal
    is _person_only_refusal's: plain for an agent, ``person_required`` for a
    request with no agent marker (a canvas tab not connected as the person).

    The same gate keeps a Moodboard node's ``send_notes`` (gap 18, P4): an
    agent may close it (toward "no"), never open it (a new node may start on
    "board", which follows the board's own switch). The person's "yes" is
    for the board it was set on: an agent pointing a "yes" node at another
    board would send that board's notes, so it is refused too."""
    if _is_person_request():
        return
    provider_switched: list[str] = []
    mode_switched: list[str] = []
    notes_opened: list[str] = []
    for label, definition_id, before, after in changes:
        if definition_id == "nebula-moodboard" and _notes_opened(before, after):
            notes_opened.append(label)
        choice = _billing_choice(definition_id, after)
        if choice is None:
            continue
        was = _billing_choice(definition_id, before or {}) or ("", "")
        if choice[0] != was[0]:
            provider_switched.append(label)
        elif choice[1] != was[1]:
            mode_switched.append(label)
    if provider_switched:
        raise _person_only_refusal(f"{_listed(provider_switched, 4)}: {PROVIDER_CHOICE_REFUSAL}")
    if mode_switched:
        raise _person_only_refusal(f"{_listed(mode_switched, 4)}: {KREA_BILLING_REFUSAL}")
    if notes_opened:
        raise _person_only_refusal(f"{_listed(notes_opened, 4)}: {NOTES_TO_GENERATORS_REFUSAL}")


def _check_krea_auth(definition_id: str, params: dict[str, Any], label: str) -> None:
    """Direct edits may set `_kreaAuth`; only to a billing mode the node offers."""
    if "_kreaAuth" not in params:
        return
    modes = node_readiness.krea_modes(node_registry.get(definition_id) or {})
    if params["_kreaAuth"] not in modes:
        offered = f"one of {', '.join(modes)}" if modes else "left out (it isn't a Krea node)"
        raise HTTPException(status_code=400, detail=f"_kreaAuth on {label} must be {offered}")


def _refuse_agent_internal_params(params: Mapping[str, Any], label: str) -> None:
    """422 when an agent's create or update writes an internal (``_``) param.

    Proposals and /api/graph/apply refuse those for every body; the node
    routes also serve the canvas, which keeps them, so here only a request
    with an agent marker is refused (services/agent_params.py)."""
    if not has_agent_marker(current_request_headers()):
        return
    for key in internal_keys(params):
        raise HTTPException(status_code=422, detail=internal_refusal(f"{label}.params", key))


def _stored_asset(kind: str, asset_id: str) -> dict[str, Any] | None:
    store = _asset_store(kind)
    try:
        return store.get(asset_id)
    except ValueError:  # not an id the store can hold
        return None


def _asset_out(kind: str, asset: dict[str, Any]) -> dict[str, Any]:
    """A saved board or character as the API returns it (a board with its brief)."""
    return _moodboard_out(asset) if kind == "moodboard" else asset


def _trashed_asset(kind: str, asset_id: str) -> dict[str, Any] | None:
    store = _asset_store(kind)
    try:
        return store.trashed(asset_id)
    except ValueError:
        return None


def _check_asset_refs(definition_id: str, params: Mapping[str, Any], label: str, *,
                      before: Mapping[str, Any] | None = None, must_exist: bool | None = None) -> None:
    """400 unless each asset-reference param (a Moodboard's ``moodboard``, a
    Character's ``character``) in ``params`` is empty or an id. For an agent
    (``must_exist`` defaults to whether the request has an agent marker) the
    asset must also exist, so a typo fails here and not at run time. A value
    equal to ``before``'s isn't checked again: a node whose board was deleted
    still saves its other params, and pasting it keeps the dangling id."""
    refs = asset_params(node_registry.get(definition_id))
    if not refs:
        return
    if must_exist is None:
        must_exist = has_agent_marker(current_request_headers())
    for key, kind in refs:
        value = params.get(key)
        if key not in params or value in (None, "") or (before is not None and before.get(key) == value):
            continue
        source = ASSET_PARAM_TYPES[kind]
        if not isinstance(value, str):
            raise HTTPException(status_code=400, detail=(
                f"{label}.{key} must be a {source['noun']} id; {source['list']} lists them"))
        if must_exist and _stored_asset(kind, value.strip()) is None:
            if _trashed_asset(kind, value.strip()) is not None:
                raise HTTPException(status_code=400, detail=(
                    f"{label}.{key}: {source['noun']} {value.strip()[:64]!r} is in Recently deleted; "
                    f"restore it first (POST /api/trash/{kind}/{value.strip()[:64]}/restore, "
                    f"or nebula trash restore {kind} {value.strip()[:64]})"))
            raise HTTPException(status_code=400, detail=(
                f"{label}.{key}: there's no {source['noun']} {value.strip()[:64]!r}; {source['list']} lists them"))


def _check_provider(definition_id: str, params: dict[str, Any], label: str) -> None:
    """Direct edits may set `_provider`; only to "auto" or one of the node's
    route ids, and only on a route-table node (services/node_route.py)."""
    if node_route.PROVIDER_PARAM not in params:
        return
    definition = node_registry.get(definition_id) or {}
    if not node_route.has_routes(definition):
        raise HTTPException(status_code=400,
                            detail=f"_provider on {label} must be left out (it has one provider route)")
    allowed = [node_route.AUTO, *(str(route["id"]) for route in node_route.routes_of(definition))]
    if params[node_route.PROVIDER_PARAM] not in allowed:
        raise HTTPException(status_code=400, detail=f"_provider on {label} must be one of {', '.join(allowed)}")


@app.post("/api/graph/apply")
async def apply_graph_edit(body: dict[str, Any]) -> dict[str, Any]:
    """An agent edits the canvas directly: everything in the body, or nothing.

    Body: the proposal shape (nodes with +refs, edges, params) plus
    rename {id|ref: name}, move {id|ref: {x, y}}, remove [id] and unwire
    [{source, sourceHandle, target, targetHandle}]. Staged on a copy of the
    graph in that order (unwire, remove, add and change, rename, move) with
    the validators single edits use, then committed at once. Never runs
    anything; runs go through /api/graph/run and its spending limits.

    No per-edit caps (decision C1): the staged graph must stay within what a
    project can save (RESTORE_MAX_GRAPH_NODES / _EDGES), as on restore.

    `arrange` (true, or {direction: right|down, gap}) asks the canvas to lay
    out this edit's new nodes once it has drawn them; see
    services/canvas_arrange.py. The response's `arrange` says so.
    """
    headers = current_request_headers()
    identity = identify_agent(headers)
    if identity is None:
        if is_person(headers):
            raise HTTPException(status_code=403, detail="This route is for agents; the canvas edits directly")
        raise HTTPException(status_code=400, detail="Name yourself with NEBULA_AGENT_NAME or --as")
    fence = _graph_fence()
    _validate_graph_ingress_complexity(body)
    try:
        spec: EditSpec = parse_edit(body, ports=_wire_end_ports)
    except ProposalError as exc:
        raise _proposal_http_error(exc) from exc
    additions = spec.additions
    for node in additions.nodes:
        _check_krea_auth(node.definition_id, node.params, node.ref)
        _check_provider(node.definition_id, node.params, node.ref)
        _check_asset_refs(node.definition_id, node.params, node.ref, must_exist=True)
    for change in additions.params:
        current = cli_graph.nodes.get(change.node_id) or {}
        _check_krea_auth(str(current.get("definitionId") or ""), change.params, change.node_id)
        _check_provider(str(current.get("definitionId") or ""), change.params, change.node_id)
        _check_asset_refs(str(current.get("definitionId") or ""), change.params, change.node_id,
                          before=current.get("params") or {}, must_exist=True)
    _refuse_agent_billing_change(
        [(node.ref, node.definition_id, None, node.params) for node in additions.nodes]
        + [(change.node_id, str((cli_graph.nodes.get(change.node_id) or {}).get("definitionId") or ""),
            (cli_graph.nodes.get(change.node_id) or {}).get("params") or {},
            {**((cli_graph.nodes.get(change.node_id) or {}).get("params") or {}), **change.params})
           for change in additions.params])

    models = await _look_up_models(_spec_models_wanted(additions))
    # From here to the commit nothing awaits: the canvas checked above is the one written.
    _refuse_if_graph_moved(fence)
    model_report: dict[str, dict[str, Any]] = {}
    positions: dict[str, dict[str, float]] = {}
    if additions.nodes:
        known, visible_area = _proposal_layout_hints()
        positions = place_new_nodes(additions, known, visible_area)
    positions.update({ref: point for ref, point in spec.move.items() if ref.startswith("+")})
    shown = _display_positions(list(cli_graph.nodes.values()))
    params_before = {
        change.node_id: copy.deepcopy((cli_graph.nodes.get(change.node_id) or {}).get("params") or {})
        for change in additions.params
    }
    labels_before = {key: _node_label(key) for key in spec.rename if not key.startswith("+")}
    undo_before = _canvas_undo_before(spec, shown)

    removed: list[dict[str, Any]] = []
    with _paid_graph_mutation("edit the canvas"):
        candidate = cli_graph.clone()
        for edge in spec.unwire:
            if not candidate.remove_edge(edge.source, edge.source_handle, edge.target, edge.target_handle):
                raise HTTPException(status_code=404, detail=(
                    f"There's no connection {edge.source}.{edge.source_handle} → {edge.target}.{edge.target_handle}; "
                    "look_at_canvas lists the current connections."))
        for node_id in spec.remove:
            node = candidate.nodes.get(node_id)
            if node is None:
                raise HTTPException(status_code=404, detail=f"{node_id} is not on the canvas")
            _ensure_node_deletable(node_id, node)
            removed.append({
                "id": node_id,
                "name": _node_label(node_id),
                "definitionId": str(node.get("definitionId") or ""),
                "position": copy.deepcopy(node.get("position")),
            })
            candidate.remove_node(node_id)
        id_map: dict[str, str] = {}
        edge_ids: list[str] = []
        if additions.nodes or additions.edges or additions.params:
            try:
                candidate, id_map, edge_ids, _ = _stage_proposal(
                    additions, positions=positions, base=candidate, what="an edit",
                    models=models, report=model_report,
                )
            except HTTPException as exc:
                # A missing node means the agent's view is stale.
                raise HTTPException(status_code=404 if exc.status_code == 409 else exc.status_code,
                                    detail=exc.detail) from exc
        for key, raw in spec.rename.items():
            node_id = id_map.get(key, key)
            node = candidate.nodes.get(node_id)
            if node is None:
                raise HTTPException(status_code=404, detail=f"{node_id} is not on the canvas")
            candidate.set_label(node_id, _custom_node_label(raw, str(node.get("definitionId") or "")))
        moves = {key: point for key, point in spec.move.items() if not key.startswith("+")}
        missing = [node_id for node_id in moves if node_id not in candidate.nodes]
        if missing:
            raise HTTPException(status_code=404, detail=f"{missing[0]} is not on the canvas")
        if moves:
            candidate.update_positions(moves)
        _refuse_oversized_graph(candidate)
        _refuse_agent_growth_past_save_limit(candidate)
        touched = sorted(set(id_map.values()) | set(params_before))
        _refuse_agent_change_to_approved_runs(candidate)
        _commit_graph_candidate_with_recoveries(
            candidate,
            [candidate.nodes[node_id] for node_id in touched],
            source="agent-edit",
        )

    edit_link = _canvas_edit_link.set({"id": canvas_undo_book.new_id()})
    # Before any await: a request that lands while this one broadcasts is not part of this edit.
    undo_after = _canvas_undo_after(undo_before, list(id_map.values()))
    # An explicit move wins over any arrange still waiting for these nodes.
    canvas_arrange.forget_nodes(moves)
    arrange = None
    if spec.arrange is not None and id_map:
        arrange = canvas_arrange.add(id_map.values(), direction=spec.arrange.direction, gap=spec.arrange.gap,
                                     actor=actor_for_headers(headers))
    entries = _remove_side_effects(removed, lambda gone: f"{gone['name']} ({gone['id']}) was deleted")
    # Every event of the edit is journaled here, before any await (round 8
    # of PR #114): it names the project the edit was made in and reads the
    # canvas as the edit left it, and it lands before any switch that follows.
    note = f" ({additions.note})" if additions.note != "edit" else ""
    for edge in spec.unwire:
        _journal_edge("edge.removed", edge.as_dict())
    _journal_removed_nodes(entries, note=note, pin_reason=lambda gone: f"{gone['name']} was deleted")
    _journal_cluster(list(id_map.values()), edge_ids, note=note)
    changed: list[str] = []
    for node_id, before in params_before.items():
        changes = param_changes(before, (cli_graph.nodes.get(node_id) or {}).get("params") or {})
        if changes:
            changed.append(node_id)
            _journal(
                "node.params",
                node_id=node_id,
                data=changes,
                summary=f"set {_listed(changes['keys'], 4)} on {_node_label(node_id)} ({node_id}){note}",
            )
    renamed: dict[str, str] = {}
    for key in spec.rename:
        node_id = id_map.get(key, key)
        renamed[node_id] = _node_label(node_id)
        if key in labels_before and labels_before[key] != renamed[node_id]:
            _journal(
                "node.renamed",
                node_id=node_id,
                data={"from": labels_before[key], "to": renamed[node_id]},
                summary=f"renamed {labels_before[key]} ({node_id}) to {renamed[node_id]}",
            )
    moved = [node_id for node_id, point in moves.items() if _moved_far_enough(shown.get(node_id), point)]
    if moved:
        _journal(
            "node.moved",
            node_id=moved[0] if len(moved) == 1 else None,
            data={"nodeIds": moved[:50], "count": len(moved)},
            summary=f"moved {_listed(moved)}",
        )
    added = list(id_map.values())
    # The reply's view of what it added and wired, as the edit left them.
    added_rows = [{"id": node_id, "definitionId": cli_graph.nodes[node_id].get("definitionId"),
                   "name": _node_label(node_id)} for node_id in added]
    wanted = set(edge_ids)
    wired_rows = [{"id": edge["id"], **_edge_data(edge)} for edge in cli_graph.edges if edge.get("id") in wanted]

    removals = _removal_records(entries)
    removals_token = _removals_ctx.set(removals)
    try:
        await _broadcast_graph_sync(edit=True, moved=moves)
    finally:
        _removals_ctx.reset(removals_token)
    # Its undo puts back the pins and proposals these deletes removed (after
    # the sync, which adds the cover proposals it closed).
    undo_after["removals"] = copy.deepcopy(removals)
    _renew_kept_removals(removals)
    await _announce_removed_nodes(entries)

    parts = [
        f"added {len(added)}" if added else "",
        f"connected {len(edge_ids)}" if edge_ids else "",
        f"changed {len(changed)}" if changed else "",
        f"renamed {len(renamed)}" if renamed else "",
        f"moved {len(moves)}" if moves else "",
        f"removed {len(removed)}" if removed else "",
        f"disconnected {len(spec.unwire)}" if spec.unwire else "",
    ]
    summary = ", ".join(part for part in parts if part) or "no change"
    publish_action(f"{identity.name} edited the canvas: {summary}")
    focus = next(iter(added), None) or next(iter(changed or list(renamed) or list(moves)), None)
    if focus is not None and focus in cli_graph.nodes:
        verb = ("Added" if focus in added else "Changed" if focus in (changed or ())
                else "Renamed" if focus in renamed else "Moved")
        await _show_agent({"nodeId": focus}, say=additions.note if note else summary, did=_did(verb, focus))
    undo = _canvas_undo_keep(identity, undo_after)
    _canvas_edit_link.reset(edit_link)
    return {
        "status": "applied",
        "summary": summary,
        "idMap": id_map,
        "added": added_rows,
        "wired": wired_rows,
        "changed": changed,
        "renamed": renamed,
        "moved": list(moves),
        "removed": [gone["id"] for gone in removed],
        # Per node it deleted: the pins detached and proposals closed (undo puts them back).
        **({"removals": removals} if removals else {}),
        "unwired": [edge.as_dict() for edge in spec.unwire],
        **({"arrange": _arrange_reply(arrange)} if arrange is not None else {}),
        # Universal nodes whose model this edit set: the ports they have now,
        # or why they can't be known yet (services/universal_ports.py).
        **({"modelPorts": model_report["ports"]} if model_report.get("ports") else {}),
        **({"modelPortNotes": model_report["notes"]} if model_report.get("notes") else {}),
        "undo": undo,
    }


def _refuse_oversized_graph(candidate: CLIGraph) -> None:
    """413 when a staged edit would make a canvas bigger than a project can save."""
    nodes, edges = len(candidate.nodes), len(candidate.edges)
    if nodes > RESTORE_MAX_GRAPH_NODES or edges > RESTORE_MAX_GRAPH_EDGES:
        raise HTTPException(status_code=413, detail=(
            f"A canvas holds at most {RESTORE_MAX_GRAPH_NODES:,} nodes and {RESTORE_MAX_GRAPH_EDGES:,} connections "
            f"(the most a project can save). This edit would leave {nodes:,} nodes and {edges:,} connections, "
            "so nothing changed."))


def _arrange_reply(arrange: Any) -> dict[str, Any]:
    """What `arrange` on an edit did: the canvas lays the new nodes out, now or when one opens."""
    count = len(arrange.node_ids)
    nodes = f"{count} new node{'' if count == 1 else 's'}"
    if manager.canvas_open():
        status, message = "waiting", (
            f"The open canvas lays out the {nodes} once it has drawn them, and saves the positions.")
    else:
        status, message = "waiting-for-canvas", (
            f"No canvas is open, so the {nodes} stay where they were placed. "
            "The first canvas that opens lays them out.")
    return {**arrange.view(), "status": status, "message": message}
RESTORE_ACTIONS = ("undo", "redo")


def _restore_wire(raw: Any, where: str) -> tuple[str, str, str, str]:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail=f"{where} must be an object")
    parts = tuple(raw.get(key) for key in ("source", "sourceHandle", "target", "targetHandle"))
    if not all(isinstance(part, str) and part for part in parts):
        raise HTTPException(status_code=400, detail=f"{where} needs source, sourceHandle, target and targetHandle")
    return parts  # type: ignore[return-value]


def _kept_paper_source(current: Mapping[str, Any], incoming: Mapping[str, Any]) -> Any:
    """The newer of two ``_paperSource`` records: undo restores a recipe, not an
    older capture of the same Paper source (the canvas merges them the same way)."""
    now, then = current.get("_paperSource"), incoming.get("_paperSource")
    if (isinstance(now, dict) and isinstance(then, dict) and now.get("id") == then.get("id")
            and isinstance(now.get("sequence"), int) and isinstance(then.get("sequence"), int)
            and now["sequence"] >= then["sequence"]):
        return now
    return then


@app.post("/api/graph/restore")
async def restore_graph_state(body: dict[str, Any]) -> dict[str, Any]:
    """Put nodes and wires back the way they were: the canvas's undo and redo.

    The canvas keeps its own undo history. When the person undoes or redoes a
    step (theirs or an agent's), it sends what changed so the backend graph,
    and through it agents and other open canvases, match the canvas again.
    Body: {action: "undo"|"redo", nodes: [{id, definitionId, params, label?,
    position?, outputs?}], remove: [id], wire: [edge], unwire: [edge]}, where
    an edge is {source, sourceHandle, target, targetHandle}.

    A node in ``nodes`` that exists gets the params (replaced, not merged),
    name and position the item carries; a key the item leaves out is left as
    it is, and the node keeps its current outputs. One that doesn't exist
    comes back under the same id, with the outputs sent. An id listed in both
    ``remove`` and ``nodes`` is swapped: whatever holds it now goes, and the
    node sent comes back there (undoing an import, which gives ids out
    again). Without that, an id that now holds a different model is refused
    (409). Removing a node that is already gone, or a wire that isn't there, is not an error, so two tabs
    undoing the same step agree. Staged on a copy (unwire, remove, nodes,
    wire) with the checks single edits use, then committed at once. Never
    runs anything. Anyone can call it, agents too: it is itself undoable.

    ``edit`` (an edit id, ``ed_...``) is the edit this step undoes or redoes,
    when the canvas's step came from that edit's graphSync (its ``edit.id``).
    From the person's canvas it links the restore to that edit: its journal
    events say so (``edit: {id, undoes|redoes, of}``), an ``edit.undone`` or
    ``edit.redone`` event follows, and the agent's undo token for it knows
    the person undid it (services/canvas_undo.py). From anyone else it is
    ignored: agents undo their own edits with POST /api/graph/apply/undo.

    ``removals`` (the removal records of the deletes this step undoes) are
    the person's too. From the person's canvas they re-attach the pins and
    reopen the proposals those deletes removed; from anyone else they are
    ignored, since graphSync shows every socket an edit's removals and pins
    are the person's. An agent's own undo puts back what its deletes removed
    from the records the backend keeps.
    """
    if body.get("removals") is not None and not _is_person_request():
        body = {key: value for key, value in body.items() if key != "removals"}
    link = _restore_edit_link(body)
    if link is None:
        return await _restore_graph(body)
    token = _canvas_edit_link.set(link)
    closed: list[bool] = []

    def journal_done(_done: dict[str, list[Any]]) -> None:
        _journal_restored_edit(link, body.get("action", "undo"))
        closed.append(True)

    try:
        result = await _restore_graph(body, journal_done=journal_done)
    finally:
        _canvas_edit_link.reset(token)
        if closed:
            # The proposals it reopened are journaled after its edit.undone
            # (their fit check awaits): the link lists them too (review 8).
            _note_link_events(link["id"])
    return result


def _note_link_events(link_id: str) -> None:
    """Every event journaled under an undo's (or redo's) link but its own
    closing edit.undone / edit.redone, kept with the link: what a later
    edit.undone of that undo lists as its ``events``. Taken again once the
    restore returns, since proposal.reopened can follow edit.undone (review
    8 of PR #114); merged with what was taken before, in case those events
    have left the journal's buffer since."""
    link = canvas_undo_book.link_of(link_id)
    if link is None:
        return
    canvas_undo_book.note_events(
        link_id, canvas_events.events_of_edit(link_id, skip_kinds=frozenset({"edit.undone", "edit.redone"})),
        merge=True)


async def _restore_graph(
    body: dict[str, Any],
    *,
    trusted: frozenset[str] = frozenset(),
    skipped_wires: list[dict[str, Any]] | None = None,
    journal_done: Callable[[dict[str, list[Any]]], None] | None = None,
) -> dict[str, Any]:
    """The restore itself, for POST /api/graph/restore and an agent's undo
    (POST /api/graph/apply/undo). ``trusted`` are node ids whose items the
    server wrote (an edit's kept inverse): they may carry ``_`` params, a
    billing choice the node had, and a moodboard or character that is gone
    since, as the node had them. With ``skipped_wires`` a wire that can't go
    back is listed there instead of refusing the whole restore.
    ``journal_done`` journals the caller's own closing event (edit.undone,
    edit.redone) with what changed ({added, removed, changed, renamed, moved,
    wired, unwired}), right after the restore's own events and before any
    await, so it too names the project the restore was made in (round 8 of
    PR #114). The pins put back (pin.reattached) come before it; the
    proposals reopened (proposal.reopened) can follow it, since their fit
    check awaits, so a caller with a link takes its events again once this
    returns (_note_link_events, review 8)."""
    _check_workspace_revision()
    _validate_graph_ingress_complexity(body)
    action = body.get("action", "undo")
    if action not in RESTORE_ACTIONS:
        raise HTTPException(status_code=400, detail="action must be undo or redo")
    raw_nodes = _graph_ingress_items(body, "nodes")
    raw_remove = body.get("remove", [])
    if not isinstance(raw_remove, list) or not all(isinstance(node_id, str) and node_id for node_id in raw_remove):
        raise HTTPException(status_code=400, detail="remove must be a list of node ids")
    wires = [_restore_wire(raw, f"wire[{index}]") for index, raw in enumerate(_graph_ingress_items(body, "wire"))]
    unwires = [_restore_wire(raw, f"unwire[{index}]") for index, raw in enumerate(_graph_ingress_items(body, "unwire"))]
    named_removals = _restore_removals(body.get("removals"))
    seen_ids: set[str] = set()
    for index, raw in enumerate(raw_nodes):
        node_id = raw.get("id")
        if not isinstance(node_id, str) or SHORT_ID_RE.fullmatch(node_id) is None:
            raise HTTPException(status_code=400, detail=f"nodes[{index}].id must be a node id like n3")
        # An id in both ``remove`` and ``nodes`` is a swap: the id holds a
        # different model now (an import gave it out again), so the node
        # there goes and the one sent comes back in its place.
        if node_id in seen_ids:
            raise HTTPException(status_code=400, detail=f"{node_id} is listed twice")
        seen_ids.add(node_id)
    note = f" ({action})"

    shown = _display_positions(list(cli_graph.nodes.values()))
    added: list[str] = []
    changed: dict[str, dict[str, Any]] = {}
    renamed: dict[str, tuple[str, str]] = {}
    moved: list[str] = []
    removed: list[dict[str, Any]] = []
    added_models: dict[str, str] = {}
    with _paid_graph_mutation(f"{action} an edit"):
        # The project these nodes come back into: their deletes' records must name it.
        project_id = _workspace_context()["activeProjectId"]
        candidate = cli_graph.clone()
        unwired: list[dict[str, Any]] = []
        for source, source_handle, target, target_handle in unwires:
            if candidate.remove_edge(source, source_handle, target, target_handle):
                unwired.append({"source": source, "sourceHandle": source_handle,
                                "target": target, "targetHandle": target_handle})
        for node_id in raw_remove:
            node = candidate.nodes.get(node_id)
            if node is None:
                continue
            _ensure_node_deletable(node_id, node)
            removed.append({
                "id": node_id,
                "name": _node_label(node_id),
                "definitionId": str(node.get("definitionId") or ""),
                "position": copy.deepcopy(node.get("position")),
            })
            candidate.remove_node(node_id)
        billing: list[tuple[str, str, Mapping[str, Any] | None, Mapping[str, Any]]] = []
        for index, raw in enumerate(raw_nodes):
            node_id = raw["id"]
            current = candidate.nodes.get(node_id)
            definition_id, params, position, outputs, label = _validated_ingress_node(
                raw, index, include_outputs=current is None,
            )
            if node_id not in trusted:
                _refuse_agent_internal_params(params, node_id)
            _check_provider(definition_id, params, node_id)
            _check_krea_auth(definition_id, params, node_id)
            params = migrate_params(definition_id, params)
            if current is None:
                _check_asset_refs(definition_id, params, node_id, must_exist=False if node_id in trusted else None)
                if node_id not in trusted:
                    billing.append((node_id, definition_id, None, params))
                try:
                    candidate.add_node(definition_id, params, position=position, outputs=outputs, node_id=node_id)
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc
                if label:
                    candidate.set_label(node_id, label)
                added.append(node_id)
                added_models[node_id] = definition_id
                continue
            if str(current.get("definitionId") or "") != definition_id:
                raise HTTPException(status_code=409, detail=(
                    f"{node_id} is a different node now, so this step can't be put back. "
                    "Reload the canvas to see the current graph."))
            # A node that is still there changes only what the item sends: the
            # canvas leaves out params and name when the step didn't touch them.
            if "params" in raw:
                params_before = copy.deepcopy(current.get("params") or {})
                _check_asset_refs(definition_id, params, node_id, before=params_before,
                                  must_exist=False if node_id in trusted else None)
                if definition_id == "paper-source":
                    kept = _kept_paper_source(params_before, params)
                    if kept is not None:
                        params["_paperSource"] = kept
                _author_cinema_scene(candidate, node_id, current, params)
                _keep_recovery_checkpoint(current, params)
                if node_id not in trusted:
                    billing.append((node_id, definition_id, params_before, params))
                if params != params_before:
                    candidate.set_params(node_id, params)
                    changed[node_id] = params_before
            previous_label = str(current.get("label") or "")
            if "label" in raw and (label or "") != previous_label:
                candidate.set_label(node_id, label)
                renamed[node_id] = (previous_label, label or "")
            if position is not None:
                point = {"x": float(position["x"]), "y": float(position["y"])}
                if current.get("position") != point:
                    candidate.update_positions({node_id: point})
                    moved.append(node_id)
        _refuse_agent_billing_change(billing)
        wired: list[dict[str, Any]] = []
        for source, source_handle, target, target_handle in wires:
            if any(edge["source"] == source and edge["sourceHandle"] == source_handle
                   and edge["target"] == target and edge["targetHandle"] == target_handle
                   for edge in candidate.edges):
                continue
            missing = next((node_id for node_id in (source, target) if node_id not in candidate.nodes), None)
            if missing is not None:
                raise HTTPException(status_code=409, detail=(
                    f"{missing} is no longer on the canvas, so its connection can't be put back. "
                    "Reload the canvas to see the current graph."))
            try:
                _validate_connect_handles(source, source_handle, target, target_handle, graph=candidate)
            except HTTPException as exc:
                if skipped_wires is None:
                    raise
                skipped_wires.append({"source": source, "sourceHandle": source_handle, "target": target,
                                      "targetHandle": target_handle, "reason": str(exc.detail)})
                continue
            wired.append(candidate.connect(source, source_handle, target, target_handle))
        try:
            graph_nodes, graph_edges = candidate.to_execute_format()
            topological_sort(
                [GraphNode.model_validate(node) for node in graph_nodes],
                [GraphEdge.model_validate(edge) for edge in graph_edges],
            )
        except CycleError as exc:
            raise HTTPException(status_code=400, detail=f"graph contains a cycle: {exc}") from exc
        _refuse_agent_change_to_approved_runs(candidate)
        # An agent's undo or restore is an edit like any other (Q118 review):
        # it can't put the open project back over the save limit. The
        # person's Cmd+Z never is refused (the check skips the person).
        _refuse_agent_growth_past_save_limit(candidate)
        touched = sorted(set(added) | set(changed))
        _commit_graph_candidate_with_recoveries(
            candidate,
            [candidate.nodes[node_id] for node_id in touched],
            source="restore",
        )
    # A swapped id now holds another node, which never failed here. A node
    # put back under its own id keeps its error, as the canvas's undo does.
    for node_id in {gone["id"] for gone in removed} & set(added):
        node_errors.forget(node_id)

    # A redo of a delete (or an undo of an add) deletes like any delete: its
    # own removal records, which the canvas keeps for the next undo.
    entries = _remove_side_effects(removed, lambda gone: f"{gone['name']} ({gone['id']}) was removed{note}")
    # Every event of the restore is journaled here, before any await (round
    # 8 of PR #114): it names the project the restore was made in.
    for edge in unwired:
        _journal_edge("edge.removed", edge, note=note)
    _journal_removed_nodes(entries, note=note, pin_reason=lambda gone: f"{gone['name']} was removed{note}")
    for node_id in added:
        _journal_node_added(node_id, note=note)
    for node_id, before in changed.items():
        changes = param_changes(before, (cli_graph.nodes.get(node_id) or {}).get("params") or {})
        if changes:
            _journal(
                "node.params",
                node_id=node_id,
                data=changes,
                summary=f"set {_listed(changes['keys'], 4)} on {_node_label(node_id)} ({node_id}){note}",
            )
    for node_id, (was, now) in renamed.items():
        definition_id = str((cli_graph.nodes.get(node_id) or {}).get("definitionId") or "")
        display = (node_registry.get(definition_id) or {}).get("displayName", definition_id)
        _journal(
            "node.renamed",
            node_id=node_id,
            data={"from": was or display, "to": now or display},
            summary=f"renamed {was or display} ({node_id}) to {now or display}{note}",
        )
    far = [node_id for node_id in moved
           if _moved_far_enough(shown.get(node_id), cli_graph.nodes[node_id].get("position") or {})]
    if far:
        _journal(
            "node.moved",
            node_id=far[0] if len(far) == 1 else None,
            data={"nodeIds": far[:50], "count": len(far)},
            summary=f"moved {_listed(far)}{note}",
        )
    for edge in wired:
        _journal_edge("edge.added", edge, note=note)
    # The nodes it brought back: their pins on them again, in this step, so
    # pin.reattached comes before the caller's edit.undone (review 8 of PR
    # #114). The proposals their deletes closed reopen after the sync
    # (_reopen_removed_proposals). A swapped id (in ``remove`` too) holds
    # another node now, not the one deleted.
    swapped = {gone["id"] for gone in removed}
    putting_back = _reattach_removed_pins(named_removals, {node_id: added_models[node_id] for node_id in added
                                                           if node_id not in swapped}, project_id)
    for node_id in swapped & set(added):
        node_removals.restored(project_id, node_id, None)
    if journal_done is not None:
        journal_done({"added": added, "removed": [gone["id"] for gone in removed], "changed": sorted(changed),
                      "renamed": sorted(renamed), "moved": moved, "wired": [_edge_data(edge) for edge in wired],
                      "unwired": unwired})
    removals = _removal_records(entries)
    removals_token = _removals_ctx.set(removals)
    try:
        await _broadcast_graph_sync(edit=True, moved=moved)
    finally:
        _removals_ctx.reset(removals_token)
    _renew_kept_removals(removals)
    await _announce_removed_nodes(entries)
    publish_action(f"{action.capitalize()} on the canvas: {len(added)} back, {len(removed)} removed, "
                   f"{len(changed)} changed, {len(wired)} connected, {len(unwired)} disconnected")
    # The proposals their deletes closed open again where they still fit (GM, 2026-10-23).
    undone = await _reopen_removed_proposals(putting_back, project_id)
    return {
        "status": "restored",
        "action": action,
        "added": added,
        "removed": [gone["id"] for gone in removed],
        "changed": sorted(changed),
        "renamed": sorted(renamed),
        "moved": moved,
        "wired": [_edge_data(edge) for edge in wired],
        "unwired": unwired,
        **undone,
        "removals": removals,
    }


# -- Undo of an agent's own edit (POST /api/graph/apply/undo) -----------------------
# Each apply that changes something keeps its inverse in canvas_undo_book
# (services/canvas_undo.py) and hands the agent an undo token. The undo puts
# back each part the canvas still has as the edit left it, through the same
# restore the canvas's Cmd+Z uses. The journal names the edit an undo reverts
# (event ``edit``), for that undo and for the person's Cmd+Z of the edit.

canvas_undo_book = CanvasUndoBook()
# The edit the current request makes ({id}, or {id, undoes|redoes, of?}): it
# tags the request's journal events (_journal) and its graphSync (_graph_edit_origin).
_canvas_edit_link: ContextVar[dict[str, Any] | None] = ContextVar("canvas_edit_link", default=None)


def _open_project_brief() -> tuple[str | None, str]:
    view = project_store.projection()  # no catalog copy
    return view.project_id, view.name


def _canvas_undo_before(spec: EditSpec, shown: Mapping[str, Any]) -> dict[str, Any]:
    """The canvas as an apply is about to change it (only what the edit names)."""
    return capture_before(
        cli_graph.nodes, cli_graph.edges,
        removed=list(spec.remove),
        changed=[change.node_id for change in spec.additions.params],
        renamed=[key for key in spec.rename if not key.startswith("+")],
        moved=[key for key in spec.move if not key.startswith("+")],
        shown=shown,
    )


def _canvas_undo_after(before: dict[str, Any], added: list[str]) -> dict[str, Any]:
    """Right after an apply commits, before it awaits anything: its inverse
    and the project it was made in. Built later, it would take in whatever
    another request changed while this one was still broadcasting."""
    project_id, project_name = _open_project_brief()
    return {"inverse": build_inverse(before, cli_graph.nodes, cli_graph.edges, added=added),
            "projectId": project_id, "projectName": project_name, "epoch": canvas_undo_book.epoch(project_id),
            "mark": canvas_undo_book.mark()}


def _canvas_undo_keep(identity: Any, after: dict[str, Any]) -> dict[str, Any] | None:
    """At the end of an apply: keep its inverse, and the reply's ``undo`` (None when nothing changed)."""
    edit_id = (_canvas_edit_link.get() or {}).get("id")
    if not edit_id or after["inverse"] is None:
        return None
    actor = actor_for_headers(current_request_headers())
    canvas_undo_book.link(edit_id, kind="edit", actor=actor)
    canvas_undo_book.note_events(edit_id, canvas_events.events_of_edit(edit_id))
    return canvas_undo_book.keep(edit_id=edit_id, actor=actor, agent_id=identity.id, project_id=after["projectId"],
                                 project_name=after["projectName"], inverse=after["inverse"], epoch=after["epoch"],
                                 mark=after.get("mark"), removals=after.get("removals"))


def _forget_canvas_undo(why: str, *, project_id: Any = ...) -> None:
    """The open project's node ids start again: its undo tokens end, and its
    id epoch moves (_graph_fence, _run_canvas_now). ``project_id``: that
    project, when the caller knows it (inside a catalog transaction)."""
    try:
        if project_id is ...:
            project_id = _workspace_context()["activeProjectId"]
        canvas_undo_book.forget_project(project_id, why)
    except Exception:  # noqa: BLE001 - never break a clear or a load over undo bookkeeping
        pass


def _undo_refused_change(node_id: str, definition_id: str, before: dict[str, Any], after: dict[str, Any]) -> str | None:
    try:
        _refuse_agent_billing_change([(node_id, definition_id, before, after)])
    except (HTTPException, PersonGateError) as exc:
        return str(exc.detail)
    return None


def _undo_cannot_remove(node_id: str, node: dict[str, Any]) -> str | None:
    try:
        _ensure_node_deletable(node_id, node)
    except HTTPException as exc:
        return str(exc.detail)
    return None


def _undo_owner_text(of: Mapping[str, Any] | None, *, by: Mapping[str, Any]) -> str:
    """Whose edit an undo reverted, in a summary: "its own", "Claude Code's"."""
    if not of:
        return "an edit Nebula no longer knows"
    if of.get("kind") == "agent" and of.get("id") and of.get("id") == by.get("id"):
        return "its own edit"
    return f"{actor_label(of)}'s edit"


def _restore_edit_link(body: dict[str, Any]) -> dict[str, Any] | None:
    """The link for a restore whose ``edit`` names the edit the canvas's step
    came from: only the person's canvas links (anyone else is ignored)."""
    raw = body.get("edit")
    if raw is None:
        return None
    if not isinstance(raw, str) or EDIT_ID_RE.fullmatch(raw) is None:
        raise HTTPException(status_code=400, detail=(
            "edit must be an edit id like ed_0123456789abcdef: the edit.id of the graphSync the step came from"))
    headers = current_request_headers()
    action = body.get("action", "undo")
    if action not in RESTORE_ACTIONS or not is_person(headers):
        return None
    target = canvas_undo_book.link_of(raw)
    link: dict[str, Any] = {"id": canvas_undo_book.new_id(), ("undoes" if action == "undo" else "redoes"): raw}
    if target is not None:
        link["of"] = target.actor
    canvas_undo_book.link(link["id"], kind=action, actor=actor_for_headers(headers), target=raw)
    return link


def _journal_restored_edit(link: dict[str, Any], action: str) -> None:
    """After the person's linked Cmd+Z (or redo): the edit.undone (edit.redone)
    event, and the agent's undo token learns where its edit stands."""
    target_id = str(link.get("undoes") or link.get("redoes"))
    target = canvas_undo_book.link_of(target_id)
    canvas_undo_book.note_events(link["id"], canvas_events.events_of_edit(link["id"]))
    by = actor_for_headers(current_request_headers())
    data: dict[str, Any] = {"editId": target_id, f"{action}Id": link["id"]}
    noun = "edit"
    if target is not None:
        data.update({"of": target.actor, "editKind": target.kind, **target.events_view()})
        if target.kind == "undo" and target.target:
            data["undid"] = target.target
            noun = "undo"
    owner = _undo_owner_text(link.get("of"), by=by)
    if noun == "undo":
        owner = owner.removesuffix("edit") + "undo"
    where = "Cmd+Z on the canvas" if action == "undo" else "redo on the canvas"
    _journal("edit.undone" if action == "undo" else "edit.redone", data=data,
             summary=f"{'undid' if action == 'undo' else 'redid'} {owner} ({where})")
    # Where the agent's edit stands now, for its undo token.
    if target is None:
        return
    person = actor_record(by)
    if target.kind == "edit":
        record = canvas_undo_book.by_edit(target_id)
        if record is not None:
            record.state, record.undone_by = ("undone", person) if action == "undo" else ("applied", None)
    elif target.kind == "undo" and target.target:
        record = canvas_undo_book.by_edit(target.target)
        if record is not None:
            record.state, record.undone_by = (("applied", None) if action == "undo"
                                              else ("undone", actor_record(target.actor)))


def _undo_ran_since(record: Any) -> dict[str, list[dict[str, Any]]]:
    """The nodes an edit touched that someone other than its agent ran since
    the edit (the person, another agent, an unnamed client), with who."""
    ran: dict[str, list[dict[str, Any]]] = {}
    for node_id in touched_nodes(record.inverse):
        if node_id not in cli_graph.nodes:
            continue
        who = canvas_undo_book.ran_since(record.project_id, node_id, since=record.mark,
                                         agent_id=record.agent_id, active=_run_is_active)
        if who:
            ran[node_id] = who
    return ran


def _undo_left_text(skipped: list[dict[str, Any]]) -> str:
    """The parts an undo left, in its reply's message."""
    messages = [str(item.get("message") or item.get("reason") or "") for item in skipped]
    return "Left as is: " + "; ".join(message for message in messages if message) + "."


@app.post("/api/graph/apply/undo")
async def undo_graph_edit(body: dict[str, Any]) -> dict[str, Any]:
    """An agent undoes one of its own edits: ``{token}``, the ``undo.token``
    its POST /api/graph/apply reply carried (MCP undo_canvas_edit, ``nebula undo``).

    Only the agent that made the edit, while the project it was made in is
    open, within UNDO_TTL_SECONDS. Each part (a node it added, a param,
    name or position it changed, a node or wire it removed) goes back only
    if the canvas still has it as the edit left it; a part someone changed
    since stays and is listed in ``skipped``. A node someone ran since the
    edit counts as changed (Q82): the person, another agent or an unnamed
    client; only this agent's own runs don't. That node stays whole (not
    removed, params, name and position not put back, no wire into it taken
    away or put back) as one skipped item, reason "ran since", with
    ``ranBy``. The rest goes through one restore, as the canvas's Cmd+Z
    does, so it lands whole or not at all. ``message`` says what went back
    and what was left and why.

    ``status`` is ``undone``; ``skipped`` when nothing could go back (the
    token still works, say after the person puts a changed part back, but a
    node someone ran since stays for good, and the message says which); or
    ``already-undone`` (by this agent, or by the person on the canvas) with
    ``undoneBy``. The journal tags each event ``edit: {id, undoes, of}``;
    ``edit.undone`` comes after the node, wire and pin events, and only a
    ``proposal.reopened`` this undo brought back can follow it (its fit
    check awaits). ``edit.undone``'s ``events`` lists the edit's events:
    every pin.* and proposal.* one, and at most MAX_LINK_EVENTS of the rest
    (``eventsTruncated`` and ``eventsTotal`` say when it was cut).
    """
    headers = current_request_headers()
    identity = identify_agent(headers)
    if identity is None:
        if is_person(headers):
            raise HTTPException(status_code=403, detail=(
                "This route is for agents; the canvas undoes an agent's edit with Cmd+Z or the notice's Undo"))
        raise HTTPException(status_code=400, detail="Name yourself with NEBULA_AGENT_NAME or --as")
    extra = sorted(set(body) - {"token"})
    if extra:
        raise HTTPException(status_code=400, detail=f"Undo takes only the token; '{extra[0][:40]}' isn't part of it")
    token = body.get("token")
    if not isinstance(token, str) or not token:
        raise HTTPException(status_code=400, detail="token must be the undo.token of one of your edits")
    project_id, _ = _open_project_brief()
    try:
        record = canvas_undo_book.take(token.strip(), agent_id=identity.id, project_id=project_id)
    except UndoError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    if record.state == "undone":
        by = record.undone_by or {}
        who = "you" if by.get("kind") == "agent" and record.undo_id else (
            "the person, on the canvas" if by.get("kind") == "person" else actor_label(by))
        return {"status": "already-undone", "editId": record.edit_id, "undoId": record.undo_id,
                "undoneBy": by, "skipped": record.last_skipped,
                "message": f"This edit was already undone by {who}; nothing changed."}
    plan = plan_undo(record.inverse, cli_graph.nodes, cli_graph.edges,
                     cannot_remove=_undo_cannot_remove, refused_change=_undo_refused_change,
                     ran=_undo_ran_since(record))
    owner = record.actor
    actor = actor_for_headers(headers)
    if plan.empty:
        if plan.skipped:
            return {"status": "skipped", "editId": record.edit_id, "added": [], "removed": [], "changed": [],
                    "renamed": [], "moved": [], "wired": [], "unwired": [], "skipped": plan.skipped,
                    "message": nothing_went_back(plan.skipped, _undo_left_text(plan.skipped))}
        record.state, record.undone_by, record.last_skipped = "undone", actor_record(actor), []
        return {"status": "undone", "editId": record.edit_id, "undoId": None, "added": [], "removed": [],
                "changed": [], "renamed": [], "moved": [], "wired": [], "unwired": [], "skipped": [],
                "message": "The canvas already looks as it did before this edit; nothing changed."}
    undo_id = canvas_undo_book.new_id()
    link = {"id": undo_id, "undoes": record.edit_id, "of": owner}
    canvas_undo_book.link(undo_id, kind="undo", actor=actor, target=record.edit_id)
    wire_skips: list[dict[str, Any]] = []
    said: dict[str, Any] = {}

    def journal_undone(changed: dict[str, list[Any]]) -> None:
        # With the restore's own events, before any await (round 8 of PR #114).
        skipped = plan.skipped + [{
            "part": "wire", "nodeId": wire["target"], "reason": "can't be wired now",
            "wire": {key: wire[key] for key in ("source", "sourceHandle", "target", "targetHandle")},
            "message": (f"the connection {wire['source']}.{wire['sourceHandle']} → {wire['target']}.{wire['targetHandle']} "
                        f"can't come back: {wire['reason']}")} for wire in wire_skips]
        record.state, record.undone_by, record.undo_id = "undone", actor_record(actor), undo_id
        record.last_skipped = skipped
        canvas_undo_book.note_events(undo_id, canvas_events.events_of_edit(undo_id))
        link_entry = canvas_undo_book.link_of(record.edit_id)
        counts = {key: len(changed.get(key) or []) for key in (
            "added", "removed", "changed", "renamed", "moved", "wired", "unwired")}
        done = ", ".join(f"{verb} {counts[key]}" for key, verb in UNDONE_VERBS if counts[key])
        left = f"; left {len(skipped)} part{'s' if len(skipped) != 1 else ''} as is" if skipped else ""
        _journal("edit.undone", data={
            "editId": record.edit_id, "undoId": undo_id, "of": owner, "editKind": "edit",
            **(link_entry.events_view() if link_entry else {"events": []}), "counts": counts,
            "skipped": len(skipped)},
            summary=f"undid {_undo_owner_text(owner, by=actor)} ({done or 'no change'}){left}")
        said.update(skipped=skipped, done=done, left=left)

    context = _canvas_edit_link.set(link)
    try:
        # The pins and proposals the edit's deletes removed go back with the nodes.
        restore = {**plan.restore, **({"removals": record.removals} if record.removals else {})}
        result = await _restore_graph(restore, trusted=plan.trusted, skipped_wires=wire_skips,
                                      journal_done=journal_undone)
        skipped, done, left = said["skipped"], said["done"], said["left"]
    finally:
        _canvas_edit_link.reset(context)
        if said:
            # The proposals it reopened are journaled after its edit.undone
            # (their fit check awaits): the link lists them too (review 8).
            _note_link_events(undo_id)
    stays = [item["nodeId"] for item in skipped if item.get("reason") == "ran since"]
    publish_action(f"{identity.name} undid its edit: {done or 'no change'}{left}"
                   + (f" ({_listed(stays)} ran since, so {'it stays' if len(stays) == 1 else 'they stay'})"
                      if stays else ""))
    extras = _undo_extras_text(result)
    return {"status": "undone", "editId": record.edit_id, "undoId": undo_id,
            **{key: result.get(key) for key in ("added", "removed", "changed", "renamed", "moved", "wired",
                                                 "unwired", "reattached", "pinsLeft", "reopened", "notReopened")},
            "skipped": skipped,
            "message": f"Undone: {done or 'no change'}." + (f" Also {extras}" if extras else "")
            + (f" {_undo_left_text(skipped)}" if skipped else "")}


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
        _raise_last_run_failed(node_id)
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


_PREVIEWABLE = ("Image", "Video")
_PREVIEW_PORT_ORDER = ("image", "video", "images", "frames")


def _preview_port(node_id: str, outputs: dict[str, Any], port: str | None) -> tuple[str, dict[str, Any]]:
    if port is not None:
        entry = outputs.get(port)
        if not isinstance(entry, dict):
            have = ", ".join(sorted(outputs)) or "none yet"
            raise HTTPException(status_code=404, detail=f"{node_id} has no output '{port}' (outputs: {have}).")
        return port, entry
    candidates = [(name, entry) for name, entry in outputs.items()
                  if isinstance(entry, dict) and entry.get("value") not in (None, "", [])]
    if not candidates:
        _raise_last_run_failed(node_id)
        raise HTTPException(status_code=404, detail=f"{node_id} has no output yet. Run it first.")
    candidates.sort(key=lambda item: (item[1].get("type") not in _PREVIEWABLE,
                                      _PREVIEW_PORT_ORDER.index(item[0]) if item[0] in _PREVIEW_PORT_ORDER else 99))
    return candidates[0]


def _raise_last_run_failed(node_id: str) -> None:
    """409 with why the node's last run failed, when it did: the answer an
    agent needs instead of "no output yet" (view_output, `nebula path`)."""
    failed = node_errors.get(node_id)
    if failed:
        hint = f" ({failed['hint']})" if failed.get("hint") else ""
        # An agent read: hide a key the provider quoted (services/key_echoes.py).
        error = _hide_key_echoes(failed["error"], _agent_key_secrets())
        raise HTTPException(status_code=409, detail=f"{node_id} has no output: its last run failed: {error}{hint}")


def _preview_path(value: Any, node_id: str, port: str) -> Path:
    path = _output_path_from_ref(value) if isinstance(value, str) else None
    if path is None:
        raise HTTPException(status_code=415, detail=(
            f"{node_id}:{port} isn't a file in Nebula's outputs (an external URL or a value), so there's "
            "nothing to preview here."))
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"The file for {node_id}:{port} is missing from disk.")
    return path


@app.get("/api/graph/node/{node_id}/preview")
async def preview_node_output(node_id: str, port: str | None = None, size: str = "medium") -> Response:
    """A small image of a node's output for an agent to look at: an image
    downscaled, a video as three frames, an image list as up to four tiles.
    Only files in Nebula's outputs are read; external URLs are never fetched."""
    node = cli_graph.nodes.get(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    if size not in output_preview.SIZES:
        raise HTTPException(status_code=400, detail=f"size must be one of {', '.join(output_preview.SIZES)}")
    name, entry = _preview_port(node_id, node.get("outputs") or {}, port)
    kind, value = entry.get("type"), entry.get("value")
    if kind not in _PREVIEWABLE and not (isinstance(value, list) and value):
        raise HTTPException(status_code=415, detail=(
            f"{node_id}:{name} is {kind or 'data'}, not an image or video; its value is in the run "
            "result and look_at_canvas."), headers=_last_run_error_header(node_id))
    try:
        if kind == "Video":
            path = _preview_path(value, node_id, name)
            with tempfile.TemporaryDirectory(prefix="nebula-preview-") as work:
                frames = await extract_frames(path, (0.1, 0.5, 0.9), Path(work))
                data, mime = await asyncio.to_thread(output_preview.contact_sheet, frames, size)
        elif isinstance(value, list):
            paths = [_preview_path(item, node_id, name) for item in value[:4]]
            data, mime = await asyncio.to_thread(output_preview.contact_sheet, paths, size)
        else:
            data, mime = await asyncio.to_thread(output_preview.image_preview, _preview_path(value, node_id, name), size)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - unreadable media is the caller's answer, not a 500
        raise HTTPException(status_code=422, detail=f"Couldn't preview {node_id}:{name}: {exc}") from exc
    return Response(content=data, media_type=mime,
                    headers={"X-Nebula-Preview-Port": name, **(_last_run_error_header(node_id) or {})})


def _last_run_error_header(node_id: str) -> dict[str, str] | None:
    """The node's output is from before a run that failed: view_output says
    so beside it, a picture (200) or a value (415) alike."""
    failed = node_errors.get(node_id)
    if not failed:
        return None
    # Hide a quoted key (services/key_echoes.py) before quote() encodes it.
    error = _hide_key_echoes(failed["error"], _agent_key_secrets())
    return {"X-Nebula-Last-Run-Error": quote(error, safe=" :,.()'")}


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
    _guard_approved_runs(lambda probe: probe.remove_edge(
        body.get("source", ""), body.get("sourceHandle", ""), body.get("target", ""), body.get("targetHandle", ""),
    ))
    removed = cli_graph.remove_edge(
        body.get("source", ""),
        body.get("sourceHandle", ""),
        body.get("target", ""),
        body.get("targetHandle", ""),
    )
    if removed:
        _journal_edge("edge.removed", body)  # before any await (round 8 of PR #114)
        await _broadcast_graph_sync(edit=True)
        publish_action(
            f"Disconnected {body.get('source', '')}:{body.get('sourceHandle', '')} → "
            f"{body.get('target', '')}:{body.get('targetHandle', '')}"
        )
        if body.get("target") in cli_graph.nodes:
            await _show_agent(
                {"nodeId": body["target"]},
                say=(f"Disconnected {_quoted(_node_label(str(body.get('source', ''))))} "
                     f"from {_quoted(_node_label(body['target']))}"),
                did=_did("Disconnected", body["target"]),
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
    _check_graph_ingress_values(value)


def _check_graph_ingress_values(value: Any) -> None:
    """The walk behind _validate_graph_ingress_complexity: bounds, finite
    numbers and protected file references (validate_file_references). Reads
    nothing but the value, the filesystem and the request's context, so it can
    run in a worker thread (_ingress_verdict)."""
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


class _IngressVerdict:
    """What checking one whole graph value off the event loop found
    (_ingress_verdict): the value checked and the refusal, if any.

    The check walks every string in a project (its run records repeat the
    graph) and stats each distinct one as a path, seconds on a large project.
    On the event loop that held up every request and canvas event, so the
    routes that check a whole snapshot (project save, open and recover, graph
    import) run it in a worker thread before their transaction, and apply the
    verdict with ``require`` where the check used to run: its refusal keeps
    its place behind the route's own (a missing project, a stale revision),
    and the revision check still runs there, on the loop.
    """

    __slots__ = ("value", "error")

    def __init__(self, value: Any, error: BaseException | None) -> None:
        self.value = value
        self.error = error

    def require(self, current: Any) -> None:
        """Refuse ``current`` as the check did, or pass it. ``current`` must be
        what is committed: the same object (a request's own body, which nothing
        else holds) or, read again inside the transaction, equal to what was
        checked. Anything else changed after the check (another writer saved
        the project in between), so it is checked again, here."""
        _check_workspace_revision()
        if current is not self.value and current != self.value:
            _check_graph_ingress_values(current)
            return
        if self.error is not None:
            raise self.error

    def part(self, key: str) -> "_IngressVerdict":
        """The verdict for ``value[key]`` (a recovery body's snapshot), which
        the check of the whole value covered. Only after ``require`` passed."""
        assert self.error is None, "require() refuses before a part is used"
        return _IngressVerdict(self.value.get(key) if isinstance(self.value, dict) else None, None)


def _ingress_verdict(value: Any) -> _IngressVerdict:
    """Check a whole graph value (in a worker thread) and keep the refusal
    for _IngressVerdict.require instead of raising it here."""
    try:
        _check_graph_ingress_values(value)
    except Exception as exc:  # noqa: BLE001 - re-raised by require(), where the check ran before
        return _IngressVerdict(value, exc)
    return _IngressVerdict(value, None)


async def _ingress_verdict_off_loop(value: Any) -> _IngressVerdict:
    # asyncio.to_thread runs it in a copy of this request's context, so the
    # agent workspace the path check reads (agent_workspaces) is the caller's.
    return await asyncio.to_thread(_ingress_verdict, value)


def _migrate_ingress(
    raw_nodes: list[dict[str, Any]],
    raw_edges: list[dict[str, Any]],
    *,
    reference_key: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], set[str]]:
    """Ingress nodes and edges with folded Krea nodes moved onto their new
    node (services/retired_nodes.py MERGED): (nodes, edges, warnings, the
    references of the folded nodes). Runs before staging, so validation sees
    the new definitions and ports; malformed items pass through for staging
    to refuse as before."""
    if not any(isinstance(node, dict) and folded_entry(node.get("definitionId")) for node in raw_nodes):
        return raw_nodes, raw_edges, [], set()
    folded = {str(node.get(reference_key)) for node in raw_nodes
              if isinstance(node, dict) and folded_entry(node.get("definitionId"))}
    nodes, edges, warnings = migrate_graph(
        [node for node in raw_nodes if isinstance(node, dict)],
        [edge for edge in raw_edges if isinstance(edge, dict)],
        key=reference_key,
    )
    return nodes, edges, warnings, folded


def _folded_billing_baseline(reference: str, folded: set[str]) -> dict[str, Any] | None:
    """What a folded Krea node billed before it loaded as its new node, for
    _refuse_agent_billing_change: the Krea route on the default mode. Moving
    it to the Krea route isn't the agent's change; a plan mode it carries
    still is, as it was on the old node."""
    return {node_route.PROVIDER_PARAM: "krea"} if reference in folded else None


def _refuse_unknown_definition(definition_id: Any) -> None:
    """400 for a node type the registry doesn't have, on every path that
    stores or runs one (create, node-and-connect, quick, and every staged
    import, cluster, restore, edit and proposal). Writes take ids only, never
    a display name (services/node_lookup.py), so what a saved command adds
    can't change when names do; the refusal names the node the text is the
    name of ("did you mean nebula-moodboard (Moodboard)?")."""
    if not isinstance(definition_id, str) or node_registry.get(definition_id) is None:
        raise HTTPException(status_code=400,
                            detail=node_lookup.unknown_definition(str(definition_id), node_registry.get_all()))


def _validated_ingress_node(
    raw: dict[str, Any],
    index: int,
    *,
    include_outputs: bool,
    normalize_image_inputs: bool = True,
) -> tuple[str, dict[str, Any], dict[str, Any] | None, dict[str, Any] | None, str | None]:
    """Validate one ingress node: (definitionId, params, position, outputs, custom label).

    Shared by imports, clusters (_stage_graph_nodes) and POST /api/graph/restore."""
    definition_id = raw.get("definitionId")
    if not isinstance(definition_id, str) or not definition_id:
        raise HTTPException(
            status_code=400,
            detail=f"nodes[{index}].definitionId must be a non-empty string",
        )
    raw_params = raw.get("params", {})
    params = {} if raw_params is None else raw_params
    if not isinstance(params, dict):
        raise HTTPException(
            status_code=400,
            detail=f"nodes[{index}].params must be an object",
        )
    # A retired definition (its provider shut the model down) becomes its
    # replacement, so saved graphs and exports still load.
    definition_id, params, retired_label = migrate_node(definition_id, params)
    _refuse_unknown_definition(definition_id)
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
    label = _custom_node_label(raw.get("label"), definition_id) or retired_label
    return definition_id, params, position, outputs, label


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
        definition_id, params, position, outputs, label = _validated_ingress_node(
            raw, index, include_outputs=include_outputs, normalize_image_inputs=normalize_image_inputs,
        )
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
        if label:
            candidate.nodes[new_id]["label"] = label
        id_map[reference] = new_id
    return id_map


def _stage_graph_edges(
    candidate: CLIGraph,
    raw_edges: list[dict[str, Any]],
    id_map: dict[str, str],
    *,
    saved: bool = False,
) -> list[str]:
    """Validate every endpoint/handle before adding any edge to live state.
    ``saved``: the edges come from a saved graph (_validate_connect_handles)."""
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
            saved=saved,
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
    # A whole graph file: checked in a worker thread (_IngressVerdict). The
    # rest stays synchronous from the revision check to the commit, as before.
    fence = _graph_fence()
    verdict = await _ingress_verdict_off_loop(body)
    _refuse_if_graph_moved(fence)
    verdict.require(body)
    candidate = CLIGraph()
    raw_nodes = _graph_ingress_items(body, "nodes")
    raw_edges = _graph_ingress_items(body, "edges")
    # The canvas forwards the .nebula file's paramsVersion (0 for a file saved
    # before the marker existed), and an older file gets the one-time upgrades
    # (services/saved_graph_upgrades.py) once its folded and retired nodes are
    # on the nodes they became. A body without the key is a graph written now
    # (an agent or script), so its values are taken as set.
    try:
        version = request_version(body, None)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raw_nodes, raw_edges, warnings, folded = _migrate_ingress(raw_nodes, raw_edges, reference_key="id")
    if version is not None:
        upgrade_flat_nodes(raw_nodes, version)
    id_map = _stage_graph_nodes(
        candidate,
        raw_nodes,
        reference_key="id",
        include_outputs=True,
    )
    _refuse_agent_billing_change(
        (node_id, str(candidate.nodes[node_id].get("definitionId") or ""), _folded_billing_baseline(ref, folded),
         candidate.nodes[node_id].get("params") or {}) for ref, node_id in id_map.items())
    _stage_graph_edges(candidate, raw_edges, id_map, saved=True)
    if body.get("refuseOverSaveLimit") is True:
        _refuse_graph_over_save_limit_on_its_own(candidate)
    # The person's Load graph opens a file of any size (Q118); anyone else's
    # import can't leave the project over the save limit, except a graph file
    # an agent opens in the empty project it just made for it (Q123 a, Justin:
    # "A big one opens as a new project."; graph_file_client.py). Saving that
    # project pauses on the canvas, as after the person's own Load graph.
    if body.get("newProjectForFile") is True:
        _require_empty_canvas_for_a_new_project_file()
    else:
        _refuse_agent_growth_past_save_limit(candidate)
    with _paid_graph_mutation("replace the graph"):
        _reject_graph_replacement_during_paid_start("replace the graph")
        if execution_runs.has_active():
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
        # The id epoch moves with the commit, in the same step (round 11).
        _forget_canvas_undo("a graph was loaded into the project since, so its node ids started again")
        # Ids start again under this project: no node now is one a restore
        # brought back. Here, with the commit, not after the sync's awaits: a
        # delete landing during the sync would name the old node's removal.
        node_removals.forget_project(_workspace_context()["activeProjectId"])
    exported = await _broadcast_graph_sync(graph_replaced=True, edit=True)
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
        # What loading changed that the person should know (a folded Krea
        # node's dropped job-output connections).
        "warnings": warnings,
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
        for port in node_ports(str(src_node.get("definitionId") or ""), src_node.get("params"), src_def, "outputPorts"):
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
        raw_nodes, raw_edges, _warnings, folded = _migrate_ingress(raw_nodes, raw_edges, reference_key="tempId")
        id_map = _stage_graph_nodes(
            candidate,
            raw_nodes,
            reference_key="tempId",
            include_outputs=False,
        )
        _refuse_agent_billing_change(
            (node_id, str(candidate.nodes[node_id].get("definitionId") or ""), _folded_billing_baseline(ref, folded),
             candidate.nodes[node_id].get("params") or {}) for ref, node_id in id_map.items())
        created_edge_ids = _stage_graph_edges(candidate, raw_edges, id_map)
        _refuse_agent_change_to_approved_runs(candidate)
        _refuse_agent_growth_past_save_limit(candidate)
        _commit_graph_candidate_with_recoveries(
            candidate,
            [candidate.nodes[node_id] for node_id in id_map.values()],
            source="cluster",
        )
    _journal_cluster(list(id_map.values()), created_edge_ids)  # before any await (round 8 of PR #114)
    created = _rf_created(list(id_map.values()), created_edge_ids)
    await _broadcast_graph_sync(edit=True)
    publish_action(f"Created cluster ({len(id_map)} nodes)")

    return {"idMap": id_map, **created}


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
        "label": n.get("label") or defn.get("displayName", definition_id),
        "definitionId": definition_id,
        "params": params,
        "state": node_state,
        "outputs": outputs,
    }
    # Its last run failed: the card says so after a reload or a project
    # switch, over any older output, until it runs again (services/node_errors.py).
    failed = node_errors.card(str(n.get("id") or ""))
    if failed:
        data.update(failed)
    if is_dynamic_node:
        data.update({
            "isDynamic": True,
            "providerType": DYNAMIC_NODE_PROVIDER_BY_DEFINITION[definition_id],
            "modelId": params.get("model") or params.get("model_id") or params.get("endpoint_id"),
            # A configured universal node's ports are its model's
            # (services/universal_ports.py); otherwise the definition's.
            "dynamicInputPorts": node_ports(definition_id, params, defn, "inputPorts"),
            "dynamicOutputPorts": node_ports(definition_id, params, defn, "outputPorts"),
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
        raise refusal_copy.not_found("Project not found", "project", "projects")
    return project


def _project_revision(body: dict[str, Any], catalog: dict[str, Any], *, required: bool = False) -> None:
    revision = body.get("workspaceRevision")
    if (required and revision is None) or (revision is not None and revision != catalog["workspaceRevision"]):
        raise HTTPException(status_code=409, detail="This project view is out of date. Reload projects before saving or switching.")


_INPUT_DATA_TYPES = {"text": "Text", "image": "Image", "video": "Video"}


def _migrate_rf_graph(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """A saved React Flow graph with its folded Krea nodes moved onto their
    new node (retired_nodes.migrate_graph), still in React Flow shape. Input
    nodes it adds take the next free ``<node>-<port>`` id; edges, a fresh
    ``migrated-<n>`` id."""
    if not all(isinstance(item, dict) for item in (*nodes, *edges)):
        # Unvalidated project file: leave it for staging to refuse as before.
        return nodes, edges, []
    if not any(isinstance(node.get("data"), dict) and folded_entry(node["data"].get("definitionId")) for node in nodes):
        return nodes, edges, []
    flat: list[dict[str, Any]] = []
    for node in nodes:
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        item = {"id": node.get("id"), "definitionId": data.get("definitionId"), "params": data.get("params"),
                "position": node.get("position")}
        if "label" in data:
            item["label"] = data["label"]
        if "outputs" in data:
            item["outputs"] = data["outputs"]
        flat.append(item)
    flat_out, edges_out, warnings = migrate_graph(flat, edges)
    # migrate_graph hands back the nodes it didn't change as the same objects.
    unchanged = {id(item): node for item, node in zip(flat, nodes)}
    by_id = {node.get("id"): node for node in nodes}
    rf_nodes: list[dict[str, Any]] = []
    for item in flat_out:
        if id(item) in unchanged:
            rf_nodes.append(unchanged[id(item)])
            continue
        original = by_id.get(item["id"])
        definition_id = str(item["definitionId"])
        label = item.get("label") or (node_registry.get(definition_id) or {}).get("displayName") or definition_id
        if original is not None:
            data = {**original["data"], "definitionId": definition_id, "params": item["params"], "label": label}
            if "outputs" in item:
                data["outputs"] = item["outputs"]
            rf_nodes.append({**original, "data": data})
        else:
            rf_nodes.append({"id": item["id"], "type": "model-node", "position": item.get("position") or {"x": 0.0, "y": 0.0},
                             "data": {"definitionId": definition_id, "params": item["params"], "label": label,
                                      "outputs": {}, "state": "idle"}})
    edge_ids = {edge.get("id") for edge in edges_out}
    counter = 0
    for edge in edges_out:
        if edge.get("id"):
            continue
        counter += 1
        while f"migrated-{counter}" in edge_ids:
            counter += 1
        edge.update({"id": f"migrated-{counter}", "type": "typed-edge",
                     "data": {"dataType": _INPUT_DATA_TYPES.get(str(edge.get("sourceHandle")), "Any")}})
        edge_ids.add(edge["id"])
    return rf_nodes, edges_out, warnings


def _stage_project_snapshot(snapshot: Any, *, historical: dict[str, str] | None = None,
                            warnings: list[str] | None = None,
                            ingress: _IngressVerdict | None = None,
                            size_checked: bool = True) -> tuple[dict[str, Any], CLIGraph]:
    """Validate a saved RF graph with canonical definitions, retaining its IDs.

    A removed definition can still be viewed when it was already in this
    project's history or live canvas. It cannot acquire execution authority
    from a frontend-supplied definition object. A folded Krea node loads as
    its new node (_migrate_rf_graph); what that dropped goes in ``warnings``.
    ``ingress``: the check already ran on this snapshot in a worker thread
    (the project routes do); without it, it runs here.
    ``size_checked``: refuse a snapshot over the save limit (every save).
    Opening a stored project doesn't: one can be stored over it (a switch
    keeps the live canvas in the project it leaves), and it opens, so the
    canvas can pause saving it until the person trims it (Q118), instead of
    the project never opening again.
    """
    if not isinstance(snapshot, dict):
        raise HTTPException(status_code=400, detail="Project snapshot must be an object")
    if ingress is None:
        _validate_graph_ingress_complexity(snapshot)
    else:
        ingress.require(snapshot)
    if size_checked and (size := project_size.snapshot_bytes(snapshot)) > MAX_PROJECT_BYTES:
        raise ProjectSizeRefusal(size)
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

    nodes, edges, folded_warnings = _migrate_rf_graph(nodes, edges)
    if warnings is not None:
        warnings.extend(folded_warnings)
    result = copy.deepcopy(snapshot)
    result.update({"runHistory": copy.deepcopy(history), "viewport": copy.deepcopy(viewport), "createSessionId": session_id,
                   "nodes": copy.deepcopy(nodes), "edges": copy.deepcopy(edges)})
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
        if node_registry.get(migrate_node(definition_id, params)[0]) is not None:
            staged = _stage_graph_nodes(isolated, [{
                "id": node_id, "definitionId": definition_id, "params": params,
                "outputs": outputs, "position": position, "label": data.get("label"),
            }], reference_key="id", include_outputs=True, normalize_image_inputs=False)
            staged_node = isolated.nodes[staged[node_id]]
            known.add(node_id)
        elif (historical or {}).get(node_id) == definition_id:
            if any(not isinstance(port, dict) or not isinstance(port.get("type"), str) for port in outputs.values()):
                raise HTTPException(status_code=400, detail="Historical outputs must be typed port objects")
            staged_node = {"id": node_id, "definitionId": definition_id, "params": copy.deepcopy(params), "outputs": copy.deepcopy(outputs), "position": copy.deepcopy(position)}
            if isinstance(data.get("label"), str) and data["label"].strip():
                staged_node["label"] = " ".join(data["label"].split())[:MAX_NODE_LABEL_LENGTH]
        else:
            raise HTTPException(status_code=400, detail=retired_message(definition_id) or f"Unknown node definition '{definition_id}'")
        staged_node["id"] = node_id
        candidate.nodes[node_id] = staged_node
        if staged_node["definitionId"] != definition_id:
            # Migrated from a retired definition: the canvas shows the replacement.
            result["nodes"][index]["data"]["definitionId"] = staged_node["definitionId"]
            result["nodes"][index]["data"]["label"] = staged_node.get("label") or (
                node_registry.get(staged_node["definitionId"]) or {}).get("displayName")
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
            _validate_connect_handles(source, source_handle, target, target_handle, graph=candidate, saved=True)
        candidate.edges.append({"id": edge_id, "source": source, "sourceHandle": source_handle, "target": target, "targetHandle": target_handle})
    try:
        graph_nodes, graph_edges = candidate.to_execute_format()
        topological_sort([GraphNode.model_validate(node) for node in graph_nodes], [GraphEdge.model_validate(edge) for edge in graph_edges])
    except CycleError as exc:
        raise HTTPException(status_code=400, detail=f"Project contains a cycle: {exc}") from exc
    return result, candidate


def _snapshot_nodes(snapshot: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """A saved RF snapshot's nodes as {id: {definitionId, params}}."""
    nodes: dict[str, dict[str, Any]] = {}
    for node in snapshot.get("nodes") or []:
        data = node.get("data") if isinstance(node, dict) else None
        if isinstance(data, dict) and isinstance(node.get("id"), str):
            params = data.get("params")
            params = params if isinstance(params, dict) else {}
            definition_id = data.get("definitionId")
            if folded_entry(definition_id):
                # Saved before the fold: what it loads as (same provider and mode).
                definition_id, params, _label = migrate_node(definition_id, params)
            nodes[node["id"]] = {"definitionId": definition_id, "params": params}
    return nodes


def _refuse_agent_billing_in_project(candidate: CLIGraph, *before: Mapping[str, Mapping[str, Any]]) -> None:
    """A project snapshot from a request that isn't the person's can't change
    who bills a node (_billing_choice): opening the project later loads it
    onto the canvas. ``before`` holds what each node was, by id, most current
    first (the live canvas, then the project as saved); a node in none of
    them, or there as another definition, starts on the defaults (Auto, the
    API token)."""
    changes = []
    for node_id, node in candidate.nodes.items():
        definition_id = str(node.get("definitionId") or "")
        prior = next((known.get("params") or {} for graph in before
                      if (known := graph.get(node_id)) and known.get("definitionId") == definition_id), None)
        changes.append((node_id, definition_id, prior, node.get("params") or {}))
    # A canvas tab sends these snapshots (autosave, the handoff save, a stale
    # tab's recovered copy). One that carries no agent marker is refused only
    # because it isn't connected as the person (no person token, or one from
    # an earlier launch): the refusal says person_required
    # (_person_only_refusal), so the canvas shows its reconnect banner and
    # keeps Try again instead of treating the copy as refused for good (Q116 a
    # review). The detail stays word for word; an agent's refusal is unchanged.
    _refuse_agent_billing_change(changes)


async def _save_live_project(project_id: str | None) -> None:
    """Write the live graph into the open project's stored snapshot now, the
    way a listing or a project read saves it (_overlay_live_project): only
    while ``project_id`` is still the one open, and only when it changed."""
    if project_id is None:
        return
    exported = await _projects_live_export()
    with project_store.transaction() as catalog:
        project = catalog["projects"].get(project_id)
        if project is not None and catalog["activeProjectId"] == project_id \
                and _overlay_live_project(project, exported):
            project_store.commit(catalog)


def _overlay_live_project(project: dict[str, Any], exported: dict[str, Any]) -> bool:
    """Overlay CLI changes while retaining frontend-only data and run recipes."""
    previous = project["snapshot"]
    updated = _overlaid_snapshot(project, exported)
    changed = updated != previous
    project["snapshot"] = updated
    project["_backendNodeIds"] = sorted({node["id"] for node in exported["nodes"]})
    project["_backendEdgeIds"] = sorted({edge["id"] for edge in exported["edges"]})
    project["_nodeCounter"] = cli_graph._counter
    if changed:
        refresh_metadata(project)
    return changed


def _overlaid_snapshot(project: dict[str, Any], exported: dict[str, Any]) -> dict[str, Any]:
    """The project's snapshot with the live canvas (``exported``, as the
    canvas gets it) overlaid, as a switch or a listing stores it
    (_overlay_live_project); nothing is changed. The project's size for
    agents (project_size) and their edits' size check read this."""
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
    return {**previous, "nodes": merged_nodes, "edges": merged_edges}


def _graph_canvas_export(graph: CLIGraph) -> dict[str, list[dict[str, Any]]]:
    """``graph``'s nodes and wires as the canvas gets them
    (export_graph_for_frontend's shape), without its side effects: for
    measuring what a project would hold with this graph on its canvas."""
    all_defs = node_registry.get_all()
    state = graph.get_state()
    positions = _display_positions(state["nodes"], y_offset=100.0)
    nodes = [_cli_node_to_rf(node, positions[node["id"]], all_defs) for node in state["nodes"]]
    edges = []
    for edge in state["edges"]:
        source = graph.nodes.get(edge["source"], {})
        ports = node_ports(str(source.get("definitionId") or ""), source.get("params"),
                           all_defs.get(source.get("definitionId", ""), {}), "outputPorts")
        data_type = next((port["dataType"] for port in ports if port["id"] == edge["sourceHandle"]), "Any")
        edges.append({"id": edge["id"], "source": edge["source"], "sourceHandle": edge["sourceHandle"],
                      "target": edge["target"], "targetHandle": edge["targetHandle"], "type": "typed-edge",
                      "data": {"dataType": data_type}})
    return {"nodes": nodes, "edges": edges}


def _open_project_with(graph: CLIGraph) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """(the open project, its snapshot with ``graph`` on its canvas), or None
    with no project open."""
    active = project_store.workspace().get("activeProjectId")
    project = _open_project_record(active) if active else None
    if project is None:
        return None
    return project, _overlaid_snapshot(project, _graph_canvas_export(graph))


def _require_empty_canvas_for_a_new_project_file() -> None:
    """``newProjectForFile`` loads a graph file only into an empty canvas: the
    project an agent just made for a file over the save limit (Q123 a). It
    never replaces nodes."""
    if cli_graph.nodes or cli_graph.edges:
        raise HTTPException(status_code=409, detail=(
            "newProjectForFile loads a graph file only into an empty project (make one with new_project, "
            "`nebula project new`), and the open project has nodes. Nothing changed."))


def _refuse_graph_over_save_limit_on_its_own(candidate: CLIGraph) -> None:
    """Refuse, before anything changes, a graph that would be over the save
    limit as a project of its own, measured as the save check measures a
    project (Q120). The person's Load graph asks for this (the body's
    ``refuseOverSaveLimit``): on the 413 it opens the file as a new project
    instead of replacing the open one, since Justin chose "Files over the
    limit open as a new project named after the file. The open project is
    left as it was." The tab's own measure can't decide alone: the export
    adds fields to dynamic nodes and remaps ids."""
    exported = _graph_canvas_export(candidate)
    size = project_size.snapshot_bytes({**empty_snapshot(), "nodes": exported["nodes"], "edges": exported["edges"]})
    if size <= MAX_PROJECT_BYTES:
        return
    limit = f"{MAX_PROJECT_BYTES / (1024 * 1024):g} MiB ({MAX_PROJECT_BYTES:,} bytes)"
    detail = (f"This graph would be {size:,} bytes as a project of its own, over Nebula's save limit of {limit}. "
              "Nothing changed (refuseOverSaveLimit).")
    # A canvas tab with a person token from before Nebula restarted gets the
    # person gate's refusal (GM's reconnect line), as its unflagged import
    # would, so it doesn't make a new project it can't then load into.
    if not _is_person_request():
        refusal = _person_only_refusal(detail)
        if isinstance(refusal, PersonGateError):
            raise refusal
    # scope "graph": the file alone is over, not the open project with it
    # (agents word their answer from it: graph_file_client.py).
    raise ProjectSizeRefusal(size, detail, scope="graph")


def _refuse_agent_growth_past_save_limit(candidate: CLIGraph) -> None:
    """Refuse an edit from anyone but the person (an agent, the CLI) that
    would leave the open project over the save limit and larger than it is
    (Q118). The person's canvas can't save such a project, so its saving
    would stop, unseen by the agent. An edit that makes a project already
    over the limit smaller (a removal, a shorter param) goes through: that is
    how agents help trim it, with their existing tools. The person's own
    edits and Load graph are never refused: their canvas pauses saving and
    shows what's large. Measured as project_size measures it: the stored
    project with the canvas overlaid (run history from its last save)."""
    if _is_person_request():
        return
    after_export = _graph_canvas_export(candidate)
    try:
        catalog_bytes = project_store.path.stat().st_size if project_store.path.exists() else 0
    except OSError:
        catalog_bytes = 0
    # The stored project is within the catalog file, so a catalog and canvas
    # this small can't make a project over the limit: no catalog read. The
    # catalog is written compact (",", ":") and the save check measures with
    # ", " and ": ", one byte more per separator, and compact JSON has at most
    # one separator per two bytes ("0,0,0"): 1.5x the catalog bounds it.
    if (catalog_bytes * 3 + 1) // 2 + project_size.json_bytes(after_export) <= MAX_PROJECT_BYTES:
        return
    try:
        found = _open_project_with(candidate)
    except ProjectStoreError:
        return
    if found is None:
        return
    project, after_snapshot = found
    after = project_size.snapshot_bytes(after_snapshot)
    if after <= MAX_PROJECT_BYTES:
        return
    before = project_size.snapshot_bytes(_overlaid_snapshot(project, _graph_canvas_export(cli_graph)))
    if after <= before:
        return
    limit = f"{MAX_PROJECT_BYTES / (1024 * 1024):g} MiB ({MAX_PROJECT_BYTES:,} bytes)"
    if before > MAX_PROJECT_BYTES:
        detail = (f"The open project is already over Nebula's save limit of {limit} at {before:,} bytes, so the "
                  "person's canvas has paused saving it, and this edit would make it larger. Nothing changed. "
                  "Call project_size (`nebula project size`) to see what's large. Edits that make it smaller "
                  "go through (remove_from_canvas, shorter params); ask the person before deleting their work.")
    else:
        detail = (f"This edit would leave the open project at {after:,} bytes, over Nebula's save limit of {limit}, "
                  "and the person's canvas can't save a project that large. Nothing changed. Call project_size "
                  "(`nebula project size`) to see what takes the space, and make the edit smaller.")
    # No agent marker: most likely the person's canvas tab with a token from
    # before Nebula restarted, whose Load graph is never refused for size once
    # it reconnects. The person gate's refusal tells it so (GM's reconnect line,
    # this text behind Details), not a pause or the agents' text as its reason.
    refusal = _person_only_refusal(detail)
    if isinstance(refusal, PersonGateError):
        raise refusal
    raise ProjectSizeRefusal(after, detail)


async def _projects_live_export() -> dict[str, Any]:
    return await export_graph_for_frontend()


def _project_replacement_guard(action: str = "switch projects", *, person: str | None = None) -> None:
    """409 while a paid start settles or a run is registered. ``person``: the
    person's own line for the run refusal (refusal_copy), where GM wrote one
    (Clear, round 11); agents keep the specific text either way."""
    _reject_graph_replacement_during_paid_start(action)
    if execution_runs.has_active():
        specific = f"Cannot {action} while a run is active. Wait for the run to finish or stop it first."
        if person is None:
            raise HTTPException(status_code=409, detail=specific)
        raise refusal_copy.refusal(409, specific, person, route="canvas")


# GM (round 11 of PR #114), under the canvas's "Couldn't clear the canvas."
# heading: "Couldn't clear the canvas. A run is still going. Wait for it to
# finish or stop it first." The reason replaces "Nothing was removed.", which
# stays for refusals that give no reason.
CLEAR_DURING_RUN_PERSON = "A run is still going. Wait for it to finish or stop it first."


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
    # The incoming project's nodes' last run errors, kept while it was closed.
    node_errors.use_project(catalog["activeProjectId"])


@app.get("/api/projects")
async def list_projects() -> dict[str, Any]:
    exported = await _projects_live_export()
    with project_store.transaction() as catalog:
        changed = False
        adopted: str | None = None
        filed_from: tuple[str, int] | None = None
        if not catalog["projects"] and cli_graph.nodes:
            filed_from = (catalog["workspaceRevision"], canvas_undo_book.epoch(None))
            snapshot = {**empty_snapshot(), "nodes": exported["nodes"], "edges": exported["edges"]}
            project = make_project("Recovered canvas", snapshot)
            _overlay_live_project(project, exported)
            catalog["projects"][project["id"]] = project
            catalog["activeProjectId"] = project["id"]
            catalog["workspaceRevision"] = uuid4().hex
            catalog["migratedProjectId"] = project["id"]
            changed = True
            adopted = project["id"]
        elif active := catalog["activeProjectId"]:
            changed = _overlay_live_project(catalog["projects"][active], exported)
        for project in catalog["projects"].values():
            if needs_cover(project):  # saved before covers existed
                refresh_metadata(project, touch=False)
                changed = True
        expired = purge_expired_trash(catalog)
        changed = expired or changed
        if changed:
            project_store.commit(catalog)
        if adopted is not None:
            # In the commit's step: the same live graph, now this project's.
            _adopt_run_canvases(adopted)
            if filed_from is not None:
                _note_canvas_filed(*filed_from, _workspace_context())
        listing = {
            "projects": sorted((project_metadata(project) for project in catalog["projects"].values()), key=lambda project: project["updatedAt"], reverse=True),
            "trash": _trash_listing(catalog),
            "activeProjectId": catalog["activeProjectId"], "workspaceRevision": catalog["workspaceRevision"],
            # The canvas reloads instead of loading a project when it differs
            # from its own (frontend/src/store/projectStore.ts).
            "paramsVersion": PARAMS_VERSION,
            **({"migratedProjectId": catalog["migratedProjectId"]} if catalog.get("migratedProjectId") else {}),
        }
        kept = set(catalog["projects"]) | set(catalog.get("trash") or {})
    # A restore of a damaged catalog the person hasn't closed the notice of
    # (ProjectStore.restore_notice): the Projects home shows GM's line,
    # agents read `note` and where the damaged file is kept.
    if restore := _catalog_restore_view(project_store.restore_notice()):
        listing["catalogRestore"] = restore
    if expired:
        # Trash past its 30 days took its question sets with it.
        agent_questions.keep_projects(kept)
    return listing


@app.post("/api/projects/catalog-restore/dismiss")
async def dismiss_catalog_restore(body: dict[str, Any]) -> dict[str, Any]:
    """The person closed the restore notice on the Projects home (×): it
    isn't shown again. The person's only: an agent closing it would keep the
    person from ever reading it. ``dismissed`` is false when ``id`` isn't the
    restore the notice shows (already closed, or a newer one came)."""
    if not _is_person_request():
        raise _person_only_refusal("Only the person closes the project list's restore notice.")
    record_id = body.get("id") if isinstance(body, dict) else None
    if not isinstance(record_id, str) or not record_id:
        raise HTTPException(status_code=400, detail="id must be the restore's id (GET /api/projects catalogRestore.id)")
    return {"dismissed": project_store.dismiss_restore(record_id)}


@app.get("/api/projects/{project_id}")
async def get_saved_project(project_id: str, view: str | None = None) -> dict[str, Any]:
    """The project the canvas loads. ``view=agent``: the same project as
    agents read it (MCP get_project), redacted like look_at_canvas
    (services/project_view.py)."""
    if view not in (None, "agent"):
        raise HTTPException(status_code=400, detail="view must be agent, or left out for the saved project")
    exported = await _projects_live_export()
    with project_store.transaction() as catalog:
        project = _project_id_or_404(project_id, catalog)
        if catalog["activeProjectId"] == project_id and _overlay_live_project(project, exported):
            project_store.commit(catalog)
        if view == "agent":
            from services.project_view import agent_project

            return agent_project(project, node_registry.get_all(), open_id=catalog["activeProjectId"],
                                 secrets=_agent_key_secrets())
        return public_project(project)


@app.get("/api/projects/{project_id}/size")
async def get_project_size(project_id: str) -> dict[str, Any]:
    """A project's size and what is large, for agents (MCP project_size,
    `nebula project size`; Q118). Read-only. The size is what a save measures
    (services/project_size.py); for the open project, its stored snapshot
    with the live canvas overlaid, as a switch would store it (the person's
    tab may hold newer run history it hasn't saved). `savingPaused`: the
    open project is over the limit, so the person's canvas can't save it.
    `largest` holds the largest rows of 0.1 MiB and up, at most ten, with
    node ids (the person's panel shows the same rows without them), `smaller`
    the rest."""
    exported = _graph_canvas_export(cli_graph)
    catalog = project_store.read()
    project = _project_id_or_404(project_id, catalog)
    is_open = catalog["activeProjectId"] == project_id
    snapshot = _overlaid_snapshot(project, exported) if is_open else project["snapshot"]
    found = project_size.breakdown(snapshot)
    size, limit = found["bytes"], MAX_PROJECT_BYTES
    all_defs = node_registry.get_all()

    def shown(row: dict[str, Any]) -> dict[str, Any]:
        if row["kind"] != "node":
            return {"kind": row["kind"], "name": project_size.ROW_NAMES[row["kind"]],
                    **({"count": row["count"]} if "count" in row else {}),
                    "bytes": row["bytes"], "size": project_size.row_size(row["bytes"])}
        definition_id = str(row.get("definitionId") or "")
        model = (all_defs.get(definition_id) or {}).get("displayName") or definition_id
        label = row.get("label") if isinstance(row.get("label"), str) and row["label"].strip() else model
        return {"kind": "node", "nodeId": row["nodeId"], "name": label, "definitionId": definition_id,
                "part": project_size.PART_LABELS[row["part"]], "bytes": row["bytes"],
                "size": project_size.row_size(row["bytes"])}

    rows = found["rows"]
    listed = project_size.listed_count(rows)
    rest = rows[listed:]
    over = size > limit
    if over and is_open:
        note = (f"Saving is paused: the person's canvas can't save this project until it is "
                f"{project_size.limit_text(limit)} or less. Make it {project_size.over_by(size, limit)} smaller "
                "with edit_canvas or remove_from_canvas (`nebula apply`), asking the person before deleting their "
                "work; it saves again by itself. Run history clears only from the Run History panel, the person's.")
    elif over:
        note = (f"This project is over the {project_size.limit_text(limit)} save limit. It opens, but the canvas "
                "can't save it until it is made smaller.")
    else:
        note = f"Under the {project_size.limit_text(limit)} save limit: it saves as usual."
    return {
        "project": {"id": project["id"], "name": project["name"], "open": is_open},
        "sizeBytes": size, "limitBytes": limit,
        "size": project_size.megabytes(size, limit), "limit": project_size.limit_text(limit),
        "overLimit": over, "savingPaused": over and is_open, "overByBytes": max(0, size - limit),
        "largest": [shown(row) for row in rows[:listed]],
        "smaller": {"count": len(rest), "bytes": sum(row["bytes"] for row in rest),
                    "size": project_size.row_size(sum(row["bytes"] for row in rest))},
        "note": note,
    }


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
    # The copy holds the tab's canvas, so the version that canvas was loaded
    # at decides its one-time upgrades (services/saved_graph_upgrades.py), not
    # the source project's: the source may be gone, or upgraded after the tab
    # loaded. The canvas sends it; a body without it came from a bundle older
    # than the marker, so its canvas predates every upgrade (version 0).
    try:
        params_version = request_version(body, 0)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # The tab's whole snapshot: checked in a worker thread, refused (if it
    # is) below where the check ran before (_IngressVerdict).
    verdict = await _ingress_verdict_off_loop(body)
    with project_store.transaction() as catalog:
        source_id = body.get("sourceProjectId")
        try:
            validate_project_id(source_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        # The source may have been deleted in another window while this tab
        # held unsaved edits to it. Those edits still deserve a copy.
        source = catalog["projects"].get(source_id) or (catalog.get("trash") or {}).get(source_id) or {
            "id": source_id, "name": "Deleted project", "snapshot": empty_snapshot(),
        }
        # Hash the submitted JSON, before canonical coercion. A retry of the
        # same request remains idempotent even if source metadata changes.
        verdict.require(body)
        fingerprint = hashlib.sha256(json.dumps({"sourceProjectId": source["id"], "snapshot": body.get("snapshot"), "name": body.get("name")}, sort_keys=True, allow_nan=False, ensure_ascii=False).encode("utf-8")).hexdigest()
        if existing := catalog["projects"].get(recovery_id):
            if existing.get("_recoveryFingerprint") != fingerprint:
                raise HTTPException(status_code=409, detail="Recovery ID already belongs to a different snapshot")
            return {"project": public_project(existing), "workspaceRevision": catalog["workspaceRevision"]}
        historical = {node["id"]: node.get("data", {}).get("definitionId") for node in source["snapshot"]["nodes"]}
        # The body's check covered its snapshot; staging doesn't walk it twice.
        snapshot, candidate = _stage_project_snapshot(body.get("snapshot"), historical=historical,
                                                      ingress=verdict.part("snapshot"))
        _refuse_agent_billing_in_project(
            candidate, *([cli_graph.nodes] if catalog["activeProjectId"] == source["id"] else []),
            _snapshot_nodes(source["snapshot"]))
        try:
            project = make_project(body.get("name", f"{source['name'][:100]} (recovered)"), snapshot)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        project.update({
            "id": recovery_id, "lastOpenedAt": None, "_recoveryFingerprint": fingerprint,
            "_recoverySourceId": source["id"], "_nodeCounter": max(candidate._counter, source.get("_nodeCounter", 0)),
            "_backendNodeIds": [], "_backendEdgeIds": [],
            "_paramsVersion": params_version,
        })
        upgrade_project(project)
        catalog["projects"][recovery_id] = project
        project_store.commit(catalog)
        result = {"project": public_project(project), "workspaceRevision": catalog["workspaceRevision"]}
    _journal_project_change("project.created", result["project"])  # before any await (round 8 of PR #114)
    await _broadcast_projects_changed("created", recovery_id)
    return result


def _switch_actor() -> dict[str, Any] | None:
    """Who opened or made a project, when it wasn't the person's own canvas:
    an agent (named by its token or X-Nebula-Agent) or an unnamed script. The
    person's canvas follows such a switch instead of calling it a conflict."""
    headers = current_request_headers()
    if is_person(headers):
        return None
    actor = actor_for_headers(headers)
    if actor.get("kind") != "agent" and has_agent_marker(headers):
        actor = {"kind": "agent", "name": "An agent"}
    return {key: actor[key] for key in ("kind", "name", "color") if actor.get(key)}


# How many projects an agent's switches left that a tab may still save into
# (round 17 of PR #114, review 16 M1). A tab follows a switch within moments
# online; offline it waits, and an agent may switch again (or back) meanwhile.
_MAX_SWITCH_HANDOFFS = 32


def _switch_handoffs(catalog: dict[str, Any]) -> dict[str, str]:
    """{projectId: the workspace revision the canvas had when an agent's
    switch left that project}. A catalog written before round 17 kept one
    ``handoff`` ({projectId, revision}); it reads as one of these."""
    handoffs = {key: value for key, value in (catalog.get("handoffs") or {}).items()
                if isinstance(key, str) and isinstance(value, str)} if isinstance(catalog.get("handoffs"), dict) else {}
    legacy = catalog.get("handoff")
    if isinstance(legacy, dict) and isinstance(legacy.get("projectId"), str) and isinstance(legacy.get("revision"), str):
        handoffs.setdefault(legacy["projectId"], legacy["revision"])
    return handoffs


def _begin_switch(catalog: dict[str, Any], actor: dict[str, Any] | None,
                  opening: str | None = None) -> dict[str, Any] | None:
    """Note what was open before a switch. For a switch the person didn't
    make, their open tab may still hold a few unsaved changes (a pan, a run
    record) for the project it was showing: a handoff lets that tab save them
    into it (save_project), with the revision it had.

    One handoff per project an agent's switches left (round 17 of PR #114,
    review 16 M1): a tab that was offline through two switches (A to B to C)
    still saves into A. A project's handoff ends when that project is opened
    again (``opening``; reopening the open project takes a fresh one, as
    before) and every one ends at the person's own switch."""
    previous_id = catalog.get("activeProjectId")
    previous = catalog["projects"].get(previous_id) if previous_id else None
    handoffs = _switch_handoffs(catalog)
    catalog.pop("handoff", None)
    if actor is None:
        catalog.pop("handoffs", None)
        return None
    if opening is not None:
        handoffs.pop(opening, None)
    if previous is not None:
        handoffs.pop(previous_id, None)
        handoffs[previous_id] = catalog["workspaceRevision"]
    while len(handoffs) > _MAX_SWITCH_HANDOFFS:
        handoffs.pop(next(iter(handoffs)))
    if handoffs:
        catalog["handoffs"] = handoffs
    else:
        catalog.pop("handoffs", None)
    return {
        "actor": actor,
        "previousProjectId": previous_id if previous is not None else None,
        "previousProjectName": previous["name"] if previous is not None else None,
        "previousRevision": catalog["workspaceRevision"],
    }


def _switch_notice(start: dict[str, Any] | None, project: dict[str, Any], *, created: bool) -> dict[str, Any] | None:
    if start is None:
        return None
    verb = "Made and opened" if created else "Opened"
    publish_action(f"{verb} project “{project['name']}”")
    return {**start, "projectId": project["id"], "projectName": project["name"], "created": created}


async def _broadcast_projects_changed(change: str, project_id: str | None = None) -> None:
    """Tell open tabs the saved-project list changed (a project made, opened,
    saved, renamed, given a cover, deleted, restored or deleted for good),
    whoever changed it: an agent, the CLI, another tab. The Projects screen
    lists again (frontend projectStore); graphSync only follows the open
    project, and most of these don't touch it."""
    try:
        await manager.broadcast_raw({"type": "projectsChanged", "change": change, "projectId": project_id})
    except Exception:  # noqa: BLE001 - the catalog is saved; a tab lists it again on its next visit to Projects
        pass


_PROJECT_SUMMARIES = {
    "project.created": 'made project "{name}"',
    "project.renamed": 'renamed project "{previous}" to "{name}"',
    "project.deleted": 'moved project "{name}" to Recently deleted',
    "project.restored": 'restored project "{name}" from Recently deleted',
}


def _journal_project_change(kind: str, project: Mapping[str, Any], *, previous_name: str | None = None,
                            was_open: bool | None = None) -> None:
    """Journal a project made, renamed, deleted or restored (``project.*``),
    in the name of whoever asked, so wait_for_canvas_change and `nebula
    watch` see the person's changes and other agents'. Next to
    _broadcast_projects_changed, which tells open tabs; opening, saving, the
    cover and deleting for good aren't journaled here (an open is
    ``canvas.replaced``). Never fails the route."""
    name = str(project.get("name") or "")
    data: dict[str, Any] = {"projectId": project.get("id"), "name": name}
    if previous_name is not None:
        data.update({"from": previous_name, "to": name})
    if was_open is not None:
        data["wasOpen"] = was_open
    if kind == "project.created" and isinstance(project.get("createdBy"), dict):
        data["createdBy"] = project["createdBy"].get("name")
    _journal(kind, data=data, summary=_PROJECT_SUMMARIES[kind].format(name=name, previous=previous_name or ""))


@app.post("/api/projects")
async def create_saved_project(body: dict[str, Any] | None = None) -> dict[str, Any]:
    body = body or {}
    exported = await _projects_live_export()
    actor = _switch_actor()
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
            # Unreachable with a run registered (the guard above refuses), but
            # the same filing as list_projects', so the same bookkeeping.
            _adopt_run_canvases(recovered["id"])
        if active := catalog["activeProjectId"]:
            _overlay_live_project(catalog["projects"][active], exported)
        try:
            project = make_project(body.get("name", "Untitled project"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if actor is not None and actor.get("kind") == "agent":
            project["createdBy"] = {"kind": "agent", "name": actor.get("name") or "An agent"}
        start = _begin_switch(catalog, actor)
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        catalog["workspaceRevision"] = uuid4().hex
        _commit_project_workspace(catalog, CLIGraph())
        revision = catalog["workspaceRevision"]
    # In the step that made it, before any await (round 8 of PR #114); its
    # canvas.replaced follows (_broadcast_graph_sync journals it first thing).
    _journal_project_change("project.created", project)
    await _broadcast_graph_sync(graph_replaced=True, reason="project-create",
                                project_switch=_switch_notice(start, project, created=True))
    await _broadcast_projects_changed("created", project["id"])
    # A bundle built for another version doesn't load it (projectStore.ts activate).
    return {"project": public_project(project), "workspaceRevision": revision, "paramsVersion": PARAMS_VERSION}


async def _open_ingress_verdict_off_loop(project_id: str, body: dict[str, Any]) -> _IngressVerdict | None:
    """Check the snapshot an open will stage, in a worker thread, before the
    open's transaction. None when it can't be known ahead (no such project,
    an unreadable catalog) or the open is going to be refused anyway (a stale
    revision, an active run): the open then answers its own 404, 409 or
    storage error at once, as before, and checks inline if it gets past
    them after all."""
    live = None
    try:
        workspace = project_store.workspace()
        # The transaction's own refusals, ahead of time: what it then holds
        # decides, so this only spares a refused open the check's wait.
        _project_revision(body, workspace)
        _project_replacement_guard()
    except (ProjectStoreError, HTTPException):
        return None
    reopening = workspace["activeProjectId"] == project_id
    if reopening:
        # Reopening the open project stages it with the live canvas merged in
        # (_overlay_live_project), so the thread checks that merge. A copy:
        # the export shares nested values with the live graph, which requests
        # on the loop can change while the thread reads.
        live = copy.deepcopy(await _projects_live_export())
    return await asyncio.to_thread(_open_ingress_verdict, project_id, live)


def _open_ingress_verdict(project_id: str, live: dict[str, Any] | None) -> _IngressVerdict | None:
    # No catalog lock: the loop takes it, and a thread holding it would stall
    # the loop. Commits replace catalog.json whole (os.replace), so this reads
    # one complete version; the open compares what it stages inside its
    # transaction with what was checked here (_IngressVerdict.require).
    # Anything else that fails here (an unreadable catalog, a saved project
    # the merge can't read) leaves the check to the open, which then fails
    # where it always did, after its own refusals.
    try:
        catalog = project_store.read_unlocked()
        project = catalog["projects"].get(project_id)
        if project is None:
            return None
        if catalog.get("activeProjectId") == project_id:
            if live is None:
                return None
            _overlay_live_project(project, live)
        snapshot = project["snapshot"]
    except Exception:  # noqa: BLE001 - see above
        return None
    return _ingress_verdict(snapshot)


@app.post("/api/projects/{project_id}/open")
async def open_saved_project(project_id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    # The saved snapshot's check (seconds on a large project) runs in a worker
    # thread first. From the live export to the commit the open stays
    # synchronous on the loop, as before: no edit lands between the export
    # and the overlay. If the project changed after the check (another writer
    # saved it), staging checks it again, inline (_IngressVerdict.require).
    verdict = await _open_ingress_verdict_off_loop(project_id, body or {})
    exported = await _projects_live_export()
    actor = _switch_actor()
    with project_store.transaction() as catalog, _paid_graph_mutation("open a project"):
        _project_revision(body or {}, catalog)
        _project_replacement_guard()
        project = _project_id_or_404(project_id, catalog)
        if active := catalog["activeProjectId"]:
            _overlay_live_project(catalog["projects"][active], exported)
        historical = {node["id"]: node.get("data", {}).get("definitionId") for node in project["snapshot"]["nodes"]}
        warnings: list[str] = []
        project["snapshot"], candidate = _stage_project_snapshot(project["snapshot"], historical=historical, warnings=warnings,
                                                                 ingress=verdict, size_checked=False)
        candidate._counter = max(candidate._counter, project.get("_nodeCounter", 0))
        project["lastOpenedAt"] = project_now()
        start = _begin_switch(catalog, actor, opening=project_id)
        catalog["activeProjectId"] = project_id
        catalog["workspaceRevision"] = uuid4().hex
        _commit_project_workspace(catalog, candidate)
        revision = catalog["workspaceRevision"]
    await _broadcast_graph_sync(graph_replaced=True, reason="project-open",
                                project_switch=_switch_notice(start, project, created=False))
    await _broadcast_projects_changed("opened", project_id)
    # What opening changed that the person should know (a folded Krea node's
    # dropped job-output connections); the snapshot is saved migrated, so
    # this is said once.
    return {"project": public_project(project), "workspaceRevision": revision, "warnings": warnings,
            "paramsVersion": PARAMS_VERSION}


@app.put("/api/projects/{project_id}")
async def save_project(project_id: str, body: dict[str, Any]) -> dict[str, Any]:
    verdict = None
    if isinstance(body.get("snapshot"), dict):
        # The canvas autosaves after every edit, and the check walks every
        # string in the project (run records repeat the graph) and stats file
        # paths. On the event loop it held up every request and canvas event
        # for seconds (an Accept's run waited 24 s), so it runs in a worker
        # thread, before the catalog lock, which other requests take to read.
        # Its refusal comes where the check ran before (_IngressVerdict).
        verdict = await _ingress_verdict_off_loop(body["snapshot"])
    result = _save_project(project_id, body, ingress=verdict)
    if "previousName" in result and result["previousName"] != result["project"]["name"]:
        # Before any await (round 8 of PR #114).
        _journal_project_change("project.renamed", result["project"], previous_name=result["previousName"])
    # A save moves the card up and can change its picture and node count.
    await _broadcast_projects_changed("renamed" if "name" in body else "saved", project_id)
    return result


def _save_project(project_id: str, body: dict[str, Any], *, ingress: _IngressVerdict | None = None) -> dict[str, Any]:
    """The save itself. ``ingress``: the snapshot's check, already run (in a
    worker thread, by the route)."""
    with project_store.transaction() as catalog:
        project = _project_id_or_404(project_id, catalog)
        handoff = _switch_handoffs(catalog).get(project_id)
        if ("snapshot" in body and handoff is not None and body.get("workspaceRevision") == handoff):
            # Not once: an autosave already in flight at the switch lands
            # first, and the tab's own last save must still land after it.
            # It ends when this project is opened again or the person
            # switches (_begin_switch). The project may be the open one
            # again: an agent reopened the project the tab was showing,
            # which reloads it from what was saved.
            _save_handoff(project, body["snapshot"], ingress=ingress)
            refresh_metadata(project)
            project_store.commit(catalog)
            return {"project": public_project(project), "workspaceRevision": catalog["workspaceRevision"],
                    "handoff": True}
        _project_revision(body, catalog, required="snapshot" in body)
        if "snapshot" in body:
            if catalog["activeProjectId"] != project_id:
                raise HTTPException(status_code=409, detail="Only the currently open project can autosave its canvas")
            historical = {node["id"]: node.get("data", {}).get("definitionId") for node in project["snapshot"]["nodes"]}
            historical.update({node_id: node["definitionId"] for node_id, node in cli_graph.nodes.items()})
            staged, candidate = _stage_project_snapshot(body["snapshot"], historical=historical, ingress=ingress)
            _refuse_agent_billing_in_project(candidate, cli_graph.nodes, _snapshot_nodes(project["snapshot"]))
            _keep_person_viewport(staged, project["snapshot"])
            project["snapshot"] = staged
            project["_backendNodeIds"] = sorted(set(cli_graph.nodes) & {node["id"] for node in project["snapshot"]["nodes"]})
            project["_backendEdgeIds"] = sorted({edge["id"] for edge in cli_graph.edges} & {edge["id"] for edge in project["snapshot"]["edges"]})
            project["_nodeCounter"] = cli_graph._counter
            if catalog.get("migratedProjectId") == project_id:
                catalog.pop("migratedProjectId", None)
        previous_name = project["name"]
        if "name" in body:
            try:
                project["name"] = project_name(body["name"])
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        refresh_metadata(project)
        project_store.commit(catalog)
        result = {"project": public_project(project), "workspaceRevision": catalog["workspaceRevision"]}
        if "name" in body:
            # The name it had, so a rename can be undone (MCP rename_project).
            result["previousName"] = previous_name
        return result


def _keep_person_viewport(staged: dict[str, Any], stored: dict[str, Any]) -> None:
    """Only the person's own tab saves the project's view (design-canvas gap 19).

    A save from any other tab (an agent's browser, a tab opened without the
    person link) keeps the view the project already had, so looking around
    there never moves it. Its nodes, wires and history still save.
    """
    if not _is_person_request():
        staged["viewport"] = copy.deepcopy(stored.get("viewport"))


def _save_handoff(project: dict[str, Any], raw: Any, *, ingress: _IngressVerdict | None = None) -> None:
    """The last save from a tab whose project an agent switched away from.

    The switch already merged the live canvas into this project
    (_overlay_live_project), so nodes and wires the backend had stay as
    saved. The tab adds what only it holds: nodes and wires it never sent to
    the backend, its viewport, run history and Create draft.
    """
    stored = project["snapshot"]
    historical = {node["id"]: node.get("data", {}).get("definitionId") for node in stored["nodes"]}
    staged, candidate = _stage_project_snapshot(raw, historical=historical, ingress=ingress)
    _refuse_agent_billing_in_project(candidate, _snapshot_nodes(stored))
    _keep_person_viewport(staged, stored)
    backend_nodes = set(project.get("_backendNodeIds") or [])
    backend_edges = set(project.get("_backendEdgeIds") or [])
    stored_nodes = {node["id"]: node for node in stored["nodes"]}
    nodes = [stored_nodes.get(node["id"], node) if node["id"] in backend_nodes else node for node in staged["nodes"]]
    listed = {node["id"] for node in nodes}
    nodes += [node for node in stored["nodes"] if node["id"] in backend_nodes and node["id"] not in listed]
    kept = {node["id"] for node in nodes}
    stored_edges = {edge["id"]: edge for edge in stored["edges"]}
    edges = [stored_edges.get(edge["id"], edge) if edge["id"] in backend_edges else edge for edge in staged["edges"]]
    listed_edges = {edge["id"] for edge in edges}
    edges += [edge for edge in stored["edges"] if edge["id"] in backend_edges and edge["id"] not in listed_edges]
    edges = [edge for edge in edges if edge["source"] in kept and edge["target"] in kept]
    project["snapshot"] = {**staged, "nodes": nodes, "edges": edges}


@app.get("/api/projects/{project_id}/covers")
async def list_project_covers(project_id: str) -> dict[str, Any]:
    """The images the person can pin as this project's card picture."""
    exported = await _projects_live_export()
    with project_store.transaction() as catalog:
        project = _project_id_or_404(project_id, catalog)
        if catalog["activeProjectId"] == project_id and _overlay_live_project(project, exported):
            project_store.commit(catalog)
        images = project["snapshot"]
        counts = project_cover.pin_counts(images, project.get("coverPin"))
        return {"images": project_cover.choices(images), "pinned": project.get("coverPin") if counts else None,
                "cover": project.get("cover"), "pinnedBy": _cover_owner(project, images),
                "lostPin": _lost_pin(project, images)}


@app.put("/api/projects/{project_id}/cover")
async def pin_project_cover(project_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Pin one of the project's images as its card picture ({"url": ...}), or
    go back to the automatic one ({"url": null}).

    The person may always. Anyone else (an agent, a script) may while the
    person hasn't pinned one; a cover the person pinned changes only through
    a proposal they accept on the Projects screen (``POST
    /api/asset-proposals``, Justin's Q60 a, 2026-10-20). A pin whose image
    left the project (its node deleted) no longer counts (Q90 a): the card is
    automatic, so anyone may set it, and the person's next pin counts again.
    Who set the pin is saved as ``coverBy``. The answer's ``previous``
    ({"cover": url or null}, the cover the card showed) put back through this
    route undoes the change."""
    return await _set_project_cover(project_id, body.get("url"))


def _cover_owner(project: Mapping[str, Any], images: Mapping[str, Any]) -> dict[str, str] | None:
    """Who pinned the project's cover, or None for the automatic one: no pin,
    or a pin whose image is no longer one of the project's (``images``: its
    snapshot as it is now; Justin's Q90 a). A pin saved before ``coverBy``
    existed is the person's: only they could pin."""
    if not project_cover.pin_counts(dict(images), project.get("coverPin")):
        return None
    return recorded_cover_owner(dict(project))


def _lost_pin(project: Mapping[str, Any], images: Mapping[str, Any]) -> dict[str, Any] | None:
    """The stored pin while its image is gone ({url, by}), else None. It
    counts again if the image comes back (an undo), so it isn't deleted."""
    pin = project.get("coverPin")
    if not pin or project_cover.pin_counts(dict(images), pin):
        return None
    return {"url": pin, "by": recorded_cover_owner(dict(project))}


def _automatic_cover(images: Mapping[str, Any]) -> str | None:
    """The image the card shows with no pin (its first, for a mosaic), or None."""
    return project_cover.first_image(project_cover.cover(dict(images)))


def _cover_state(project: Mapping[str, Any]) -> dict[str, Any]:
    """The stored pin as a proposal records it (``before``), counting or not:
    the image leaving and coming back doesn't change it, so a proposal stays
    open through an undo."""
    return {"cover": project.get("coverPin") or None, "coverBy": recorded_cover_owner(dict(project))}


def _cover_images_now(project: dict[str, Any], catalog: Mapping[str, Any], exported: dict[str, Any] | None) -> dict[str, Any]:
    """The project's snapshot as its images are now: the open project's
    saved snapshot lags the live canvas, so it is overlaid on a copy."""
    if exported is None or catalog.get("activeProjectId") != project.get("id"):
        return project["snapshot"]
    copied = copy.deepcopy(project)
    _overlay_live_project(copied, exported)
    return copied["snapshot"]


async def _set_project_cover(project_id: str, url: Any, *, expect: dict[str, Any] | None = None,
                             note: str = "") -> dict[str, Any]:
    """The cover change itself, for the route and for an accepted proposal
    (``expect``: the cover as the proposal saw it, else 409)."""
    headers = current_request_headers()
    person = is_person(headers)
    exported = await _projects_live_export()
    with project_store.transaction() as catalog:
        project = _project_id_or_404(project_id, catalog)
        if catalog["activeProjectId"] == project_id:
            _overlay_live_project(project, exported)
        if expect is not None and _cover_state(project) != expect:
            raise HTTPException(status_code=409, detail="The project's cover changed since it was proposed.")
        images = project["snapshot"]
        owner = _cover_owner(project, images)
        if not person and owner is not None and owner.get("kind") == "person":
            require_person(headers, hint=(
                f'The person pinned the cover of project "{project["name"]}", so only they can change it. '
                f'To ask them, propose it: propose_asset_change(kind="project", id="{project_id}", '
                'change={"cover": <url or null>}, note=...) (POST /api/asset-proposals); they decide on the '
                "Projects screen."))
        recorded = _cover_state(project)
        # What the card showed: a pin whose image is gone showed the automatic cover.
        previous = project.get("coverPin") if owner is not None else None
        if url is None or url == "":
            url = None
            # A lost pin is already the automatic cover; only the person's own
            # reset drops it, so an undo can still bring it back otherwise.
            if person or owner is not None:
                project.pop("coverPin", None)
                project.pop("coverBy", None)
        else:
            if not isinstance(url, str) or not project_cover.is_choice(images, url):
                raise HTTPException(status_code=400, detail="Pick one of this project's own images for its cover.")
            project["coverPin"] = url
            project["coverBy"] = actor_record(actor_for_headers(headers))
        changed = recorded != _cover_state(project)
        refresh_metadata(project, touch=False)
        project_store.commit(catalog)
        name = str(project.get("name") or "")
        result = {"project": project_metadata(project), "previous": {"cover": previous}}
    if changed:
        _journal(
            "project.cover",
            data={"projectId": project_id, "projectName": name, "cover": url},
            summary=(f'pinned a cover on project "{name}"' if url is not None
                     else f'set the cover of project "{name}" back to automatic') + note,
        )
    await _broadcast_projects_changed("cover", project_id)
    # A cover proposal for this project may no longer fit (the person picked another).
    await _sweep_asset_proposals()
    return result


@app.delete("/api/projects/{project_id}")
async def delete_saved_project(project_id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Move a project to Recently deleted. Generated media stays on disk.

    Deleting the open project also empties the live canvas, so it carries
    the same run and paid-start fences as switching projects. The project
    itself, pins included, can be restored until the trash expires.
    """
    body = body or {}
    with project_store.transaction() as catalog, ExitStack() as fences:
        _project_id_or_404(project_id, catalog)
        _project_revision(body, catalog, required=True)
        deleting_active = catalog["activeProjectId"] == project_id
        if deleting_active:
            fences.enter_context(_paid_graph_mutation("delete the open project"))
            _project_replacement_guard("delete the open project")
        trashed = move_to_trash(catalog, project_id,
                                actor_record(actor_for_headers(current_request_headers())))
        if deleting_active:
            catalog["activeProjectId"] = None
            catalog["workspaceRevision"] = uuid4().hex
            _commit_project_workspace(catalog, CLIGraph())
            # The canvas is now the unfiled one, empty, its ids starting again at n1.
            node_removals.forget_project(None)
            # So the unfiled canvas's id epoch moves, in this step (round 11):
            # a write or run noted on an earlier unfiled canvas isn't this one.
            _forget_canvas_undo("the open project was deleted since, so the canvas started again", project_id=None)
        else:
            project_store.commit(catalog)
        result = {
            "deletedProjectId": project_id,
            "trashedProject": trash_metadata(trashed),
            "activeProjectId": catalog["activeProjectId"],
            "workspaceRevision": catalog["workspaceRevision"],
        }
    # Before any await (round 8 of PR #114).
    _journal_project_change("project.deleted", result["trashedProject"], was_open=deleting_active)
    if deleting_active:
        await _broadcast_graph_sync(graph_replaced=True, reason="project-delete")
    await _broadcast_projects_changed("deleted", project_id)
    return result


def _trash_listing(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    entries = (catalog.get("trash") or {}).values()
    return sorted((trash_metadata(entry) for entry in entries), key=lambda entry: entry["deletedAt"], reverse=True)


def _trashed_or_404(project_id: str, catalog: dict[str, Any]) -> dict[str, Any]:
    try:
        validate_project_id(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    entry = (catalog.get("trash") or {}).get(project_id)
    if entry is None:
        raise refusal_copy.refusal(404, "That project is no longer in Recently deleted", refusal_copy.gone_from_trash("project"))
    return entry


# Trash routes never touch the live canvas, so unlike delete they don't
# need the workspace revision: a gone entry is a plain 404.
@app.post("/api/projects/{project_id}/restore")
async def restore_saved_project(project_id: str) -> dict[str, Any]:
    with project_store.transaction() as catalog:
        expired = purge_expired_trash(catalog)
        _trashed_or_404(project_id, catalog)
        project = restore_from_trash(catalog, project_id)
        project_store.commit(catalog)
        result = {"project": project_metadata(project), "workspaceRevision": catalog["workspaceRevision"]}
        kept = set(catalog["projects"]) | set(catalog.get("trash") or {})
    if expired:
        agent_questions.keep_projects(kept)
    _journal_project_change("project.restored", result["project"])  # before any await (round 8 of PR #114)
    await _broadcast_projects_changed("restored", project_id)
    return result


@app.delete("/api/projects/trash/{project_id}")
async def purge_trashed_project(project_id: str) -> dict[str, Any]:
    # Deleting for good can't be undone, so only the person may (agents restore).
    require_person(current_request_headers(), hint=_RESTORE_HINT)
    with project_store.transaction() as catalog:
        _trashed_or_404(project_id, catalog)
        del catalog["trash"][project_id]
        project_store.commit(catalog)
        node_errors.keep_projects(set(catalog["projects"]) | set(catalog.get("trash") or {}))
        kept = set(catalog["projects"]) | set(catalog.get("trash") or {})
        result = {"trash": _trash_listing(catalog)}
    # Its question sets went with its record; the book forgets them too.
    agent_questions.keep_projects(kept)
    await _broadcast_projects_changed("purged", project_id)
    return result


@app.post("/api/projects/trash/empty")
async def empty_project_trash(body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Delete the trashed projects for good. Person only. With ``{"ids": [...]}``
    (what the person's list showed) only those go, so a project an agent
    deleted after the list loaded stays restorable."""
    require_person(current_request_headers(), hint=_RESTORE_HINT)
    shown = _shown_trash_ids(body, "ids")
    with project_store.transaction() as catalog:
        trash = catalog.get("trash") or {}
        doomed = [project_id for project_id in trash if shown is None or project_id in shown]
        for project_id in doomed:
            del trash[project_id]
        if doomed:
            project_store.commit(catalog)
            node_errors.keep_projects(set(catalog["projects"]) | set(trash))
        kept = set(catalog["projects"]) | set(trash)
        result = {"trash": _trash_listing(catalog)}
    if doomed:
        agent_questions.keep_projects(kept)
        await _broadcast_projects_changed("purged")
    return result


def _shown_trash_ids(body: dict[str, Any] | None, key: str) -> set[str] | None:
    """The ids an empty request says the person was shown, or None when it
    doesn't say (then everything that matches goes, as before)."""
    if not body or key not in body:
        return None
    raw = body.get(key)
    if not isinstance(raw, list) or len(raw) > 10_000 or not all(isinstance(value, str) for value in raw):
        raise HTTPException(status_code=400, detail=f"{key} must be a list of ids")
    for value in raw:
        try:
            validate_project_id(value)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return set(raw)


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
    workspace = _workspace_context()
    # The open project's nodes' last errors (ids restart in each project).
    node_errors.use_project(workspace["activeProjectId"])
    if not state["nodes"]:
        # No open arrange can apply to an empty canvas. A cleared one
        # (CLIGraph.clear) restarts node ids, so an old node's last run error
        # must not reach a new one; one emptied node by node keeps its errors
        # for the undo that puts the nodes back (services/node_errors.py).
        canvas_arrange.clear()
        if cli_graph._counter == 0:
            node_errors.forget_canvas()
        return {
            **workspace,
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
        src_ports = node_ports(str(src_node.get("definitionId") or ""), src_node.get("params"), src_def, "outputPorts")
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
        **workspace,
        "nodes": rf_nodes,
        "edges": rf_edges,
        "empty": False,
        # Agent edits that asked the canvas to lay out their new nodes once
        # drawn (services/canvas_arrange.py). A canvas that connects later
        # gets them too.
        "arrange": canvas_arrange.pending(cli_graph.nodes),
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
async def run_graph(request: Request, body: dict[str, Any] | None = None) -> dict:
    """Run the CLI graph (or one node and what feeds it) and return the results.

    The run happens in a background task, so it survives the caller giving up.
    Without ``wait`` the request waits for it, as it always has. With ``wait``
    (seconds) it returns ``{"status": "running", "runId"}`` if the run is still
    going then; GET /api/graph/runs/{runId} reports it later. Agents use this so
    a long video run doesn't outlast their tool's time limit.

    Status is "finished", or "failed" when any node failed (`errors` has each
    node's message, `error` says it in one line, and the nodes that finished
    keep their outputs), as the canvas's own run status says. A node that
    can't run as set up (the canvas Run's pre-call check: a missing key, an
    unwired required input) fails the run before it starts, so nothing ran
    and nothing was spent. Either way the canvas shows each node's state and
    message, as it does for its own runs."""
    _check_workspace_revision()
    _capture_execution_workspace()
    fence = _graph_fence()
    if not cli_graph.nodes:
        raise HTTPException(status_code=400, detail="Graph is empty")

    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    _normalize_cli_graph_output_refs()
    nodes_list, edges_list = cli_graph.to_execute_format()

    target = body.get("targetNodeId") if body else None

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
    wait = body.get("wait") if body else None
    if wait is not None and (isinstance(wait, bool) or not isinstance(wait, (int, float)) or wait < 0):
        raise HTTPException(status_code=400, detail="wait must be a number of seconds")

    run_id = str(uuid4())
    # The canvas Run's own pre-call check (/api/execute): a node that can't
    # run as set up (no key, a required input unwired) stops the run here,
    # before the spending check and any provider call, and shows on its card.
    errors = validate_graph(sub_nodes, sub_edges, api_keys)
    try:
        topological_sort(sub_nodes, sub_edges)
    except CycleError as exc:
        errors.append(ValidationErrorDetail(node_id="", port_id="", message=f"Graph contains a cycle: {exc}"))
    if errors:
        return await _refused_cli_run(run_id, target, errors)

    # Checked last: a request refused for anything else must not count.
    measured = await _measure_run_inputs(sub_nodes, sub_edges)
    # Its nodes were read from the live graph before that await, and its
    # outputs land there by node id: only on the canvas it was asked on.
    _refuse_if_graph_moved(fence)
    _require_spend_approval(sub_nodes, sub_edges, run_id=run_id, settings=settings, measured=measured,
                            run_ids=[target] if target else _end_node_ids(sub_nodes, sub_edges))
    _note_run(run_id)
    _note_run_nodes(run_id, sub_nodes)
    try:
        # Right before it registers, with no await between (round 11): the
        # run notes this canvas as the one its write-backs go to.
        _refuse_if_graph_moved(fence)
        run_canvas = _run_canvas_now()  # as in execute
    except (HTTPException, ProjectStoreError):
        _return_hold(run_id)
        canvas_events.forget_run(run_id)
        raise

    outcome: dict[str, Any] = {"results": {}, "errors": {}, "skipped": {}}
    task = asyncio.create_task(_execute_cli_run(run_id, sub_nodes, sub_edges, api_keys, outcome))
    # Registered like canvas runs: it fences project switching until it ends,
    # and DELETE /api/executions/{runId} (`nebula cancel`) stops it.
    try:
        _register_run(run_id, task, run_canvas)
    except (ExecutionCancelledBeforeStartError, ExecutionCancellationCapacityError, ValueError) as exc:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await _release_paid_worldlabs_starts(run_id)
        _return_hold(run_id)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    _watch_for_cross_process_stop(run_id, task)
    _cli_runs.start(run_id, task, target, outcome)
    # The canvas says "Running X" / "Ran X" only for a run that started
    # (review 10's F3: one its fence refused still said it ran).
    publish_action(
        f"Running {target}..." if target else f"Running {len(sub_nodes)} node(s)..."
    )
    if target:
        await _show_agent({"nodeId": target}, say=f"Running {_quoted(_node_label(target))}", did=_did("Ran", target))
    else:
        # The whole canvas has no one node to point at: the Agent log only.
        await _say_agent_action(f"Running {len(sub_nodes)} node{'' if len(sub_nodes) == 1 else 's'}")
    return _hide_run_key_echoes(await _cli_run_response(run_id, None if wait is None else float(wait)))


async def _refused_cli_run(run_id: str, target: str | None, errors: list[ValidationErrorDetail]) -> dict[str, Any]:
    """A CLI run the pre-call check stopped: nothing ran and nothing was spent.

    The canvas shows it as it shows a refused click on Run
    (_announce_validation_errors); the caller gets the run result's own
    shape with status "failed", each node's message in `errors`."""
    _note_run(run_id)
    await _announce_validation_errors(errors, run_id)
    messages = _validation_messages(errors)
    per_node = {node_id: message for node_id, message in messages.items() if node_id}
    summary = "; ".join(f"{node_id} ({_node_label(node_id)}): {message}" if node_id else message
                        for node_id, message in messages.items())
    # The Agent Log and the cursor speak on the person's canvas: the card's
    # lines, not the keys and ids agents read in `error` and `errors` (error
    # copy round 3e). A graph-wide refusal alone (a cycle) has no node to name.
    person = _validation_person_lines(errors)
    said = {node_id: f"{_node_label(node_id)} can't run." + (f" {person[node_id]}" if person.get(node_id) else "")
            for node_id in per_node}
    publish_action("Run stopped before it started. "
                   + (" ".join(said.values()) or person.get("") or "Couldn't run the canvas."))
    first = next(iter(per_node), None)
    if first is not None:
        # The cursor quotes the node like every other bubble; the log keeps its line.
        bubble = f"{_quoted(_node_label(first))} can't run." + (f" {person[first]}" if person.get(first) else "")
        await _show_agent({"nodeId": first}, say=bubble, did=_did("Tried to run", first))
    response = {
        "runId": run_id,
        "targetNodeId": target,
        "status": "failed",
        "error": f"Nothing ran, so nothing was spent. {summary}",
        "results": {},
        "errors": per_node,
        "skipped": {},
        "nodesExecuted": 0,
    }
    _cli_runs.refused(run_id, target, response)
    return response


async def _execute_cli_run(
    run_id: str, sub_nodes: list[GraphNode], sub_edges: list[GraphEdge], api_keys: dict[str, Any],
    outcome: dict[str, Any],
) -> dict[str, Any]:
    results: dict[str, Any] = outcome["results"]
    errors: dict[str, str] = outcome["errors"]
    # Nodes a gate upstream skipped: node id -> reason. They never ran.
    skipped: dict[str, str] = outcome.setdefault("skipped", {})

    async def collect_events(event: ExecutionEvent) -> None:
        # The response carries what each node made or why it failed. The
        # events also go to the canvas as a canvas run's do (_emit_and_sync:
        # journal, spend hold, outputs saved as each node finishes, so a
        # stopped run keeps what it made), so the person sees an agent's run
        # node by node: queued, running, done, or failed with the message on
        # the card. Before, only the outputs arrived, by the closing graphSync,
        # and a node that failed stayed idle.
        if isinstance(event, ExecutedEvent):
            results[event.node_id] = event.outputs
            if event.notes:
                outcome.setdefault("notes", {})[event.node_id] = list(event.notes)
        elif isinstance(event, ErrorEvent):
            errors[event.node_id] = event.error
        elif isinstance(event, SkippedEvent):
            skipped[event.node_id] = event.reason
        await _emit_and_sync(event)

    handler_registry = get_handler_registry(emit=collect_events)
    start = _time_module.time()
    try:
        _claim_fresh_paid_worldlabs_starts(run_id=run_id, nodes=sub_nodes)
    except BaseException:
        _return_hold(run_id)
        raise
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
        if _execution_is_cancelling(run_id):
            raise asyncio.CancelledError
    except asyncio.CancelledError:
        await _finalize_cancelled_execution(sub_nodes, run_id)
        publish_action(f"Stopped after {len(results)} node(s)")
        raise
    except Exception as exc:
        if _execution_is_cancelling(run_id):
            await _finalize_cancelled_execution(sub_nodes, run_id)
            raise asyncio.CancelledError from exc
        raise
    finally:
        await _release_paid_worldlabs_starts(run_id)
        _settle_hold(run_id)
        canvas_events.forget_run(run_id)
    duration = _time_module.time() - start

    _sync_params_to_cli_graph(sub_nodes, run_id=run_id)

    # Sync outputs to frontend canvas
    await _broadcast_graph_sync(run_params=run_id)

    skipped_note = f", {len(skipped)} skipped by a gate" if skipped else ""
    if errors:
        publish_action(
            f"Ran {len(results) + len(errors)} node(s) in {duration:.1f}s — "
            f"{len(errors)} errored: {', '.join(errors.keys())}{skipped_note}"
        )
    else:
        publish_action(
            f"Ran {len(results)} node(s) cleanly in {duration:.1f}s{skipped_note}"
        )

    return {
        "results": results,
        "errors": errors,
        "skipped": skipped,
        # Per node, what each run said beside its outputs (the size a maker made).
        **({"notes": outcome["notes"]} if outcome.get("notes") else {}),
        "duration": round(duration, 2),
        "nodesExecuted": len(results) + len(errors),
    }


class _CliRuns:
    """CLI runs by id, so a caller that stopped waiting can collect the result."""

    KEEP_FINISHED = 50

    def __init__(self) -> None:
        self._runs: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def start(self, run_id: str, task: asyncio.Task, target: str | None, outcome: dict[str, Any]) -> None:
        self._runs[run_id] = {"task": task, "target": target, "outcome": outcome, "started": _time_module.time()}
        # Once forgotten here, get_run still answers from the run's events, as an agent's run.
        _run_reports().mark_source(run_id, "agent")
        finished = [key for key, entry in self._runs.items() if entry["task"].done()]
        for key in finished[:max(0, len(finished) - self.KEEP_FINISHED)]:
            self._runs.pop(key, None)

    def refused(self, run_id: str, target: str | None, response: dict[str, Any]) -> None:
        """A run the pre-call check stopped: get_run and `nebula result` answer
        with the same reply the caller got."""
        done: asyncio.Future = asyncio.get_running_loop().create_future()
        done.set_result(None)
        self.start(run_id, done, target, {"results": {}, "errors": dict(response.get("errors") or {})})
        self._runs[run_id]["refused"] = response

    def get(self, run_id: str) -> dict[str, Any] | None:
        return self._runs.get(run_id)


_cli_runs = _CliRuns()


async def _cli_run_response(run_id: str, wait: float | None, *, report_failure: bool = False) -> dict[str, Any]:
    entry = _cli_runs.get(run_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"No run '{run_id}' (finished runs are kept for a while, then forgotten)")
    if "refused" in entry:
        return entry["refused"]
    task: asyncio.Task = entry["task"]
    # asyncio.wait never cancels the run, even when this request is cancelled.
    await asyncio.wait({task}, timeout=None if wait is None else min(wait, 3600.0))
    head = {"runId": run_id, "targetNodeId": entry["target"]}
    if not task.done():
        return {**head, "status": "running", "elapsed": round(_time_module.time() - entry["started"], 1)}
    if task.cancelled():
        made = entry["outcome"]
        return {**head, "status": "cancelled", "results": made["results"], "errors": made["errors"],
                "skipped": made.get("skipped", {}),
                **({"notes": made["notes"]} if made.get("notes") else {}),
                "nodesExecuted": len(made["results"]) + len(made["errors"])}
    if report_failure and task.exception() is not None:
        return {**head, "status": "failed", "error": str(task.exception())}
    result = task.result()
    if result.get("errors"):
        # As the canvas's run status says (execution_runs: a node error makes
        # the run "failed"). Outputs of the nodes that finished are still here.
        failed = list(result["errors"])
        error = (f"{failed[0]} failed: {result['errors'][failed[0]]}" if len(failed) == 1
                 else f"{len(failed)} nodes failed: {', '.join(failed)} (errors has each message)")
        return {**head, "status": "failed", "error": error, **result}
    return {**head, "status": "finished", **result}


@app.get("/api/graph/runs/{run_id}")
async def get_graph_run(run_id: str, wait: float = 0) -> dict[str, Any]:
    """A run's outcome; with ``wait`` (seconds, max 300), wait for it to finish first.

    A run an agent or the CLI started answers as it always has. Any other run
    (the person's Run on the canvas, an accepted proposal's run) answers from
    the execution registry and the run's own events (services/run_reports.py),
    in the same shape with `source: "canvas"` (`"agent"` for an agent's run
    this route no longer keeps), `startedBy` (``{kind, name}``)
    and `nodes`: each node's state, latest `progress`, streamed `partialText`
    and `error`. A CLI run still going carries `nodes` too; once it ends it
    answers exactly as its start did."""
    wait = max(0.0, min(float(wait), 300.0))
    reports = _run_reports()
    if (_cli_runs.get(run_id) is None and execution_runs.get(run_id) is None and not reports.known(run_id)
            and execution_runs.tombstoned(run_id)):
        # A Stop beat this run's start (round 16 of PR #114, M2): the id can't
        # start here, so nothing ran and nothing was spent. Only when this
        # process saw that start begin (round 17, review 16 L1); otherwise it
        # has no record of the run, which may have run before a restart.
        if not execution_runs.start_seen(run_id):
            return {"runId": run_id, "status": "unknown", "source": "canvas", "noRecord": True}
        return {"runId": run_id, "status": "cancelled", "source": "canvas", "neverStarted": True}
    if _cli_runs.get(run_id) is None and (execution_runs.get(run_id) is not None or reports.known(run_id)):
        response = await _canvas_run_response(run_id, wait)
        return _hide_run_key_echoes({**response, "startedBy": actor_record(canvas_events.run_actor(run_id)),
                                     "nodes": reports.progress(run_id)})
    response = await _cli_run_response(run_id, wait, report_failure=True)
    if response.get("status") == "running" and reports.known(run_id):
        response = {**response, "nodes": reports.progress(run_id),
                    "startedBy": actor_record(canvas_events.run_actor(run_id))}
    return _hide_run_key_echoes(response)


def _agent_key_secrets() -> list[str]:
    """The configured keys, for hiding wherever a provider quoted one in an
    error agents read (services/key_echoes.py). Never fails the read."""
    from services.key_echoes import configured_secrets

    try:
        return configured_secrets(load_settings().get("apiKeys"))
    except Exception:  # noqa: BLE001
        return []


def _hide_key_echoes(text: Any, key_words: list[str]) -> Any:
    from services.key_echoes import hide_key_echoes

    return hide_key_echoes(text, key_words)


def _hide_run_key_echoes(response: dict[str, Any]) -> dict[str, Any]:
    from services.key_echoes import hide_in_run

    return hide_in_run(response, _agent_key_secrets())


def _run_reports():
    from services.run_reports import run_reports

    return run_reports


_CANVAS_RUN_STATUS = {"completed": "finished", "failed": "failed", "cancelled": "cancelled",
                      "running": "running", "cancelling": "running"}


async def _canvas_run_response(run_id: str, wait: float) -> dict[str, Any]:
    """A run the canvas started, as _cli_run_response words a CLI run."""
    record = execution_runs.get(run_id)
    if record is not None and not record.task.done():
        # asyncio.wait never cancels the run, even when this request is cancelled.
        await asyncio.wait({record.task}, timeout=wait)
        await asyncio.sleep(0)  # the registry marks it terminal in a done callback
    record = execution_runs.get(run_id)
    made = _run_reports().outcome(run_id)
    head = {"runId": run_id, "targetNodeId": None, "source": _run_reports().source(run_id) or "canvas"}
    nodes_executed = made.pop("nodesExecuted", len(made["results"]) + len(made["errors"]))
    if record is None:
        # Pruned from the registry (it keeps the last 256): what its events said.
        status = "failed" if made["errors"] else "finished"
    else:
        status = _CANVAS_RUN_STATUS.get(record.status, record.status)
        if status == "finished" and made["errors"]:
            status = "failed"
    response = {**head, "status": status, **made, "nodesExecuted": nodes_executed}
    if status == "failed" and made["errors"]:
        failed = list(made["errors"])
        response["error"] = (f"{failed[0]} failed: {made['errors'][failed[0]]}" if len(failed) == 1
                             else f"{len(failed)} nodes failed: {', '.join(failed)} (errors has each message)")
    elif status == "failed":
        # The run raised before any node reported. Its exception stays in
        # Nebula's log: its text can be anything, a provider's reply included.
        response["error"] = "The run stopped with an error before any node reported one; Nebula's log has the details."
    return response


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
async def quick_execute(body: dict[str, Any]) -> dict:
    """One-shot: create a temp node, execute, return output.

    Its nodes are temporary (``_quick_*``), never on the canvas, and its
    events go to this request's own dicts, so nothing is written back by node
    id: a quick run in flight doesn't hold up a Clear, a project switch, an
    import or a delete of the open project (round 12 of PR #114; it did
    through _track_synchronous_project_run, now gone)."""
    _check_workspace_revision()
    _capture_execution_workspace()
    definition_id = body.get("definitionId", "")
    if message := retired_message(str(definition_id)):
        raise HTTPException(status_code=400, detail=message)
    _refuse_unknown_definition(definition_id)
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
        elif isinstance(value, str) and value.endswith(('.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg')):
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
    # A quick run has no canvas node to propose, so point at one.
    quick_run = f"quick-{uuid4().hex}"
    measured = await _measure_run_inputs(temp_nodes, temp_edges)
    _require_spend_approval(temp_nodes, temp_edges, run_id=quick_run, on_canvas=False, settings=settings,
                            measured=measured, how_to_ask=(
        f"Add it to the canvas instead (`nebula create {definition_id}`), then propose the run: "
        "`nebula propose --note \"<why>\" --run <node id>` (MCP: propose_change). "
        "The person accepts on the canvas, and the canvas runs it."
    ))

    results: dict[str, Any] = {}
    errors: dict[str, str] = {}

    async def collect_events(event: ExecutionEvent) -> None:
        if isinstance(event, ExecutedEvent):
            results[event.node_id] = event.outputs
        elif isinstance(event, ErrorEvent):
            errors[event.node_id] = event.error
            _release_unspent_hold(event, quick_run)

    handler_registry = get_handler_registry(emit=collect_events)
    # Temp multi-image input nodes are executed by this request-scoped handler —
    # the engine's built-in image-input branch only emits a scalar value.
    handler_registry["multi-image-input"] = _quick_multi_image_input_handler

    import time
    start = time.time()
    try:
        await execute_graph(
            nodes=temp_nodes,
            edges=temp_edges,
            api_keys=api_keys,
            handler_registry=handler_registry,
            emit=collect_events,
            cache=execution_cache,
            run_id=quick_run,
        )
    finally:
        _settle_hold(quick_run)
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

from pydantic import BaseModel, ConfigDict, Field

from services.prompt_enhance import (
    enhance_prompt,
    NoEnhanceProviderError,
    EnhanceProviderError,
)


class EnhancePromptRequest(BaseModel):
    prompt: str


# Generous for a Create prompt (the enhancer writes one paragraph back), and a
# bound on what one call can send to a paid provider.
ENHANCE_PROMPT_MAX_CHARS = 4000
# A person clicks Enhance now and then. Anything faster is a loop, and with a
# fall-through over three providers each call can cost up to three requests.
ENHANCE_RATE_LIMIT = 20
ENHANCE_RATE_WINDOW_S = 60.0
_enhance_calls: deque[float] = deque()
_enhance_log = logging.getLogger("nebula.enhance_prompt")


def _admit_enhance_call() -> None:
    """Count one Enhance call, or 429 when the last minute already had the limit."""
    now = _time_module.monotonic()
    while _enhance_calls and now - _enhance_calls[0] > ENHANCE_RATE_WINDOW_S:
        _enhance_calls.popleft()
    if len(_enhance_calls) >= ENHANCE_RATE_LIMIT:
        _enhance_log.warning("enhance-prompt refused: %d calls in the last %.0fs",
                             len(_enhance_calls), ENHANCE_RATE_WINDOW_S)
        raise HTTPException(
            status_code=429,
            detail=f"Enhance was used {ENHANCE_RATE_LIMIT} times in the last minute. Wait a moment and try again.",
        )
    _enhance_calls.append(now)


@app.post("/api/enhance-prompt")
async def enhance_prompt_route(body: EnhancePromptRequest) -> dict[str, str]:
    """One-shot LLM rewrite of a Create prompt, using the first configured provider.

    Person-only: it calls an LLM with the person's keys and has no list price,
    so it can't be held to the agent spending limits. Agents rewrite prompts
    themselves, or add a text node, whose run is held to the limits. The gate
    runs before anything else, so a refused caller learns nothing about which
    keys exist. Every call is logged (provider, prompt length, outcome) and
    rate-limited, so use that gets past the gate still shows up."""
    try:
        require_person(current_request_headers())
    except PersonGateError as exc:
        exc.detail = (f"{exc.detail} Prompt enhancement is the person's Create button. Rewrite the prompt "
                      "yourself, or add a text node (claude-chat, gpt-4o-chat, gemini-chat) to the graph; "
                      "running it is held to the spending limits.")
        raise
    prompt = (body.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is empty.")
    if len(prompt) > ENHANCE_PROMPT_MAX_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"Prompt is too long for Enhance ({len(prompt)} characters; the limit is {ENHANCE_PROMPT_MAX_CHARS}).",
        )
    _admit_enhance_call()
    api_keys = load_settings().get("apiKeys", {})
    try:
        result = await enhance_prompt(prompt, api_keys)
    except NoEnhanceProviderError:
        _enhance_log.info("enhance-prompt: chars=%d outcome=no_key", len(prompt))
        raise HTTPException(
            status_code=400,
            detail="No LLM API key configured (OpenAI, Anthropic, or Google). Add one in Settings.",
        )
    except EnhanceProviderError as exc:
        _enhance_log.info("enhance-prompt: chars=%d outcome=provider_error", len(prompt))
        raise HTTPException(status_code=502, detail=str(exc))
    _enhance_log.info("enhance-prompt: provider=%s chars=%d outcome=ok", result.get("provider"), len(prompt))
    return result


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
    # The version the caller read: any other is a 409 with the Character as
    # it is (contract 07, 2.1). Left out, the write isn't checked.
    baseVersion: Any = None


# Moodboard bodies refuse unknown fields: an image list sent under any other
# key used to make a board with no images and a 200.
class MoodboardPlacementModel(BaseModel):
    """One card of an image on the board (services/moodboard_layout.py). On
    an image already on the board it is ignored (the saved cards stay); on a
    new image it is where the card goes. The server writes ``w``/``h`` from
    the weight and stamps ``placedBy``/``placedAt``, so a client may send
    just ``x`` and ``y``. Every key GET returns is accepted, so a client can
    send back what it read."""
    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    frameId: str | None = None
    x: float
    y: float
    w: float | None = None
    h: float | None = None
    weight: float | None = None
    placedBy: str | None = None
    placedAt: str | None = None


class MoodboardImageModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    url: str
    weight: float = 1.0
    notes: str = ""
    # The person's own label, never sent anywhere (services/moodboard_store.py).
    privateNote: str = ""
    excluded: bool = False
    # Where its cards sit (services/moodboard_layout.py). Ignored on an
    # image already on the board; on a new one, where it goes.
    placements: list[MoodboardPlacementModel] | None = None


class MoodboardPinnedColorsModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    include: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)


class MoodboardBriefOverrideModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str


class MoodboardCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    images: list[MoodboardImageModel] = Field(default_factory=list)
    notes: str = ""
    mode: str = "look"
    strength: float = 0.7
    analysis: dict[str, Any] | None = None
    projectId: str | None = None
    # The person's brief fields (services/moodboard_brief.py). They live on
    # the board, so analyzing again keeps them.
    direction: str = ""
    avoid: list[str] = Field(default_factory=list)
    pinnedColors: MoodboardPinnedColorsModel | None = None
    briefOverride: MoodboardBriefOverrideModel | None = None
    # What happens when the words clash with a measured colour, the person's
    # Keep anyway / Leave out, and whether notes reach generators (gap 18).
    # Any, so the store checks the raw value ("yes" isn't true).
    clashMode: Any = None
    colorChoices: Any = None
    sendNotes: Any = None
    # The image the board opens on, by its id among ``images`` (the store
    # checks it); left out, the board opens on #1.
    coverImageId: Any = None
    # The saved colour check is the store's; a sent one is ignored.
    colorCheck: Any = None
    # The board's layout: never set here (see _refuse_moodboard_layout).
    frames: Any = None
    suggestions: Any = None
    readings: Any = None
    layoutVersion: Any = None
    lastRead: Any = None
    # Updates are written only through /agent-notes (refused here by name).
    agentNotes: Any = None


class MoodboardUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    images: list[MoodboardImageModel] | None = None
    notes: str | None = None
    mode: str | None = None
    strength: float | None = None
    # An explicit null clears the saved analysis (Moodboard Studio sends one
    # when the board changes); leaving the field out keeps it.
    analysis: dict[str, Any] | None = None
    # Moodboard Studio sends the board's own project back; a different one is
    # refused, since a board can't move between projects.
    projectId: str | None = None
    direction: str | None = None
    avoid: list[str] | None = None
    pinnedColors: MoodboardPinnedColorsModel | None = None
    # {"text": ...} sets a hand-written brief; an explicit null removes it
    # (the board goes back to the generated brief).
    briefOverride: MoodboardBriefOverrideModel | None = None
    # Gap 18 (see MoodboardCreate). Turning sendNotes on is the person's call.
    clashMode: Any = None
    colorChoices: Any = None
    sendNotes: Any = None
    # The image the board opens on: an image's id, or an explicit null for
    # none (it opens on #1). Left out, the cover stays. A pick, not a
    # reorder: no image changes number (services/moodboard_store.py).
    coverImageId: Any = None
    colorCheck: Any = None
    # The board's layout: never set here (see _refuse_moodboard_layout).
    frames: Any = None
    suggestions: Any = None
    readings: Any = None
    layoutVersion: Any = None
    lastRead: Any = None
    # Updates are written only through /agent-notes (refused here by name).
    agentNotes: Any = None
    # The board's version the client read: a different one is refused (409)
    # with the board as it is now. Left out, the write isn't checked.
    baseVersion: Any = None


class MoodboardEditsBody(BaseModel):
    """POST /api/moodboards/{id}/edits (services/moodboard_edits.py)."""
    model_config = ConfigDict(extra="forbid")

    ops: list[Any]
    baseVersion: Any = None
    # The agent's own words for what it did ("Moved #12 into Dither").
    say: str | None = None


class MoodboardThresholdsModel(BaseModel):
    """Colour thresholds for a dry run (services/moodboard_analysis.Thresholds).
    Any left out keep Commons' defaults; ranges are checked by the service."""
    model_config = ConfigDict(extra="forbid")

    accentMinChroma: Any = None
    accentSeparation: Any = None
    mergeDeltaE: Any = None


class MoodboardDryRunRequest(BaseModel):
    """The optional body of POST /api/moodboards/{id}/analyze/dry-run."""
    model_config = ConfigDict(extra="forbid")

    thresholds: MoodboardThresholdsModel | None = None


class MoodboardReadRequest(BaseModel):
    """The body of POST /api/moodboards/{id}/read/estimate and /read: the
    reader (a key of data/moodboard_reader_models.json), the images to read
    (all of them when left out) and the thinking level (the model's default)."""
    model_config = ConfigDict(extra="forbid")

    model: str
    imageIds: list[str] | None = None
    thinkingLevel: str | None = None


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
    # The params version ``params`` were made at, checked by the shared
    # request_version rule in the route (Any keeps the raw JSON value, so
    # "1", true and 1.5 are refused rather than coerced).
    paramsVersion: Any = None


class PresetUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    prompt: str | None = None
    params: dict[str, Any] | None = None
    modelId: str | None = None
    refImages: list[str] | None = None
    thumbnail: str | None = None
    paramsVersion: Any = None
    # The Style's ``version`` the caller read: a checked write (409 when it
    # moved on). The MCP's style_update and `nebula style set` send it.
    baseVersion: Any = None


def _preset_params_version(body: BaseModel, missing: int) -> int:
    """The body's ``paramsVersion`` (``missing`` when the key wasn't sent), or 422."""
    sent = {"paramsVersion": body.paramsVersion} if "paramsVersion" in body.model_fields_set else {}
    try:
        return request_version(sent, missing)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _check_stored_images(kind: str, fields: Mapping[str, Any], before: Mapping[str, Any] | None = None) -> None:
    """422 unless every image a Style (``kind="style"``: refImages, thumbnail
    and its image params) or a Character (``"character"``: referenceViews)
    write names is one of Nebula's own files (services/stored_image_refs.py).
    Every caller is checked, the person too; a value ``before`` (the asset as
    stored) already holds isn't checked again."""
    from services.stored_image_refs import StoredImageError, check

    if kind == "style":
        # The params the Style will have under the model it will have: a
        # write that changes only the model can make a held value an image
        # param, so a held param counts as held only under its own model.
        stored = before or {}
        model = fields["modelId"] if "modelId" in fields else stored.get("modelId")
        definition = node_registry.get(str(model or "")) or {}
        param_keys = ["_previewUrl", *(str(p.get("key")) for p in definition.get("params") or []
                                       if isinstance(p, dict) and p.get("type") == "file")]
        image_fields: tuple[str, ...] = ("refImages", "thumbnail")
        if "params" not in fields or fields["params"] is None:
            fields = {**fields, "params": stored.get("params")}
        if before is not None and (model or None) != (stored.get("modelId") or None):
            before = {key: value for key, value in before.items() if key != "params"}
    else:
        param_keys, image_fields = [], ("referenceViews", "thumbnail")
    try:
        check(fields, image_fields=image_fields, before=before, param_keys=param_keys,
              shipped_thumbnail=lambda value: _preset_thumbnail_path_from_ref(value) is not None)
    except StoredImageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _char_store():
    from services.character_store import CharacterStore
    return CharacterStore()


def _moodboard_store():
    from services.moodboard_store import MoodboardStore
    return MoodboardStore()


def _moodboard_author() -> str:
    """Who is changing a board's hand-written brief: "person" only when the
    person gate says so (services/person_gate.py), else "agent"."""
    return "person" if _is_person_request() else "agent"


def _refuse_override_change(exc: Exception) -> NoReturn:
    """Turn the store's BriefOverrideProtected (or NotesOptInProtected) into the person gate's refusal
    (403, ``agent_refused`` or ``person_required``) with the store's reason."""
    try:
        require_person(current_request_headers())
    except PersonGateError as gate:
        gate.detail = f"{exc} {gate.detail}"
        raise
    raise HTTPException(status_code=403, detail=str(exc))  # unreachable: only non-persons are refused


def _refuse_moodboard_layout(body: BaseModel) -> None:
    """422 when a create or PUT body sets the board's layout (frames,
    suggestions, readings, layoutVersion, lastRead). It is written only by
    board edits and by Nebula placing new images; an image's own
    ``placements`` are fine (services/moodboard_store.py)."""
    from services.moodboard_store import LAYOUT_BOARD_KEYS, LAYOUT_REFUSED

    sent = [key for key in LAYOUT_BOARD_KEYS if key in body.model_fields_set]
    if sent:
        raise HTTPException(status_code=422, detail=f"{', '.join(sent)} {LAYOUT_REFUSED}")
    if "agentNotes" in body.model_fields_set:
        raise HTTPException(status_code=422, detail=(
            "agentNotes can't be set on a board: an agent posts an update with POST "
            "/api/moodboards/{id}/agent-notes (MCP post_note, `nebula note --board`), and the person "
            "marks them read in the Updates list. They are kept beside the board, not in it."))


def _moodboard_out(board: dict) -> dict:
    """A board as the API returns it: the saved board plus ``brief``, what
    generators get from it (services/moodboard_brief.compose). ``brief`` is
    computed on every read and never saved.

    ``outsideImages`` (only when there are any): the ids of images that are
    links to another site, which a board saved before writes were checked
    can hold (services/stored_image_refs.py). They stay on the board, but
    nothing in Nebula loads them: the app shows a placeholder, and runs and
    the analysis leave them out. Computed on read, never saved."""
    from services.moodboard_brief import with_brief
    from services.stored_image_refs import outside_image_ids

    out = with_brief(board)
    if isinstance(out, dict) and (outside := outside_image_ids(out)):
        out = {**out, "outsideImages": outside}
    return out


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


def _require_canvas_project(project_id: str | None) -> None:
    """A new project-scoped Character, Moodboard or Style must name a canvas
    project in the catalog (GET /api/projects), else 422. A project in
    Recently deleted doesn't count: nothing can open it, so nothing would show
    the asset. None or "" is Global. Lists still take any safe id."""
    _validate_project_id_param(project_id)
    if not project_id:
        return
    catalog = project_store.read()
    if project_id in catalog["projects"]:
        return
    trashed = (catalog.get("trash") or {}).get(project_id)
    if trashed is not None:
        raise HTTPException(status_code=422, detail=(
            f"The project “{trashed.get('name') or project_id}” is in Recently deleted. Restore it first, "
            "or leave projectId out to save this as Global."))
    raise HTTPException(status_code=422, detail=(
        f"No project has the id '{project_id}'. Use the id of a project from GET /api/projects "
        "(activeProjectId is the one open on the canvas), or leave projectId out to save this as Global."))


async def _broadcast_stored_asset(kind: str, asset: Mapping[str, Any] | None, asset_id: str = "",
                                  *, deleted: bool = False, moved: bool = False,
                                  edit: Mapping[str, Any] | None = None) -> None:
    """Tell canvases a saved moodboard, character or Style (kind "style")
    changed, so a card that shows it (MoodboardNode, CharacterNode) or a list
    of them (the Assets panel, Create's Styles) fetches it again. A move also
    says where it lives now (``projectId``, null for Global), so a Studio
    draft kept for it this session follows (frontend assetStudioDraftStore
    ``rehome``).

    A board write says more (``edit``, plan section 5.1): the board's new
    ``version``, ``edit`` = {actor, tab?} (_graph_edit_origin, so the tab
    that wrote it knows its own echo), ``touched`` {images, frames, looks}
    and ``undo`` (null for a PUT, or a batch over 200 ops). An open Studio
    that didn't write it refetches the board and replays its own pending
    edits on top.

    Private-note text is never broadcast past the person's own tabs: an
    ``undo`` that holds one goes whole to the person's canvas sockets only,
    and as null to every other listener (CLI, MCP)."""
    from services.moodboard_edits import holds_private_note

    message: dict[str, Any] = {"type": "storedAssetChanged", "kind": kind,
                               "id": str((asset or {}).get("id") or asset_id), "deleted": deleted}
    if moved:
        message["projectId"] = (asset or {}).get("projectId") or None
    if edit is not None:
        message.update({"version": (asset or {}).get("version"), "edit": _graph_edit_origin(), **edit})
    try:
        if holds_private_note(message.get("undo")):
            await manager.broadcast_browser(message)
            await manager.broadcast_others({**message, "undo": None})
        else:
            await manager.broadcast_raw(message)
    except Exception:  # noqa: BLE001 - the asset is saved; a card fetches it again when it next mounts
        pass


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
    _require_canvas_project(body.projectId)
    _check_stored_images("character", body.model_dump())
    store = _char_store()
    try:
        character = store.create(
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
    await _broadcast_stored_asset("character", character)
    return character


@app.get("/api/characters/{char_id}")
async def get_character(char_id: str) -> dict:
    """Fetch a Character by id."""
    store = _char_store()
    try:
        char = store.get(char_id)
    except ValueError:
        raise refusal_copy.not_found(f"Character '{char_id}' not found", "character", "characters")
    if char is None:
        return _asset_not_found("character", char_id)
    return char


@app.put("/api/characters/{char_id}")
async def update_character(char_id: str, body: CharacterUpdate) -> dict:
    """Update mutable fields on a Character; bumps version. With
    ``baseVersion``, a Character saved elsewhere since is a 409 carrying it as
    it is now, and nothing is written. The broadcast carries the new
    ``version`` and who wrote it (``edit``), so an open Character Studio
    follows an outside edit and skips its own echo."""
    from services.character_store import CharacterVersionConflict

    if body.baseVersion is not None and (isinstance(body.baseVersion, bool) or not isinstance(body.baseVersion, int)):
        raise HTTPException(status_code=422, detail="baseVersion must be a whole number: the Character's version you read")
    store = _char_store()
    updates = {k: v for k, v in body.model_dump().items() if v is not None and k != "baseVersion"}
    if "referenceViews" in updates:
        try:
            stored = store.get(char_id)
        except ValueError:
            raise refusal_copy.not_found(f"Character '{char_id}' not found", "character", "characters")
        # Not live: the in_trash 404 the Studio offers Restore from, before
        # any check (a Studio sends the views it read, held links too).
        if stored is None:
            return _asset_not_found("character", char_id)
        # A version behind (versions only grow): the update below is the 409
        # the Studio merges from and writes nothing, so the views aren't
        # checked against a Character they can't land on.
        version = stored.get("version")
        behind = (body.baseVersion is not None and isinstance(version, int) and version > body.baseVersion)
        if not behind:
            _check_stored_images("character", updates, before=stored)
    try:
        character = store.update(char_id, base_version=body.baseVersion, **updates)
    except KeyError:
        # In Recently deleted (an agent may have deleted it): say so, so the
        # Studio can tell the person to restore it and keep their edits.
        return _asset_not_found("character", char_id)
    except CharacterVersionConflict as exc:
        return JSONResponse(status_code=409, content={
            "detail": (f"The Character changed since you read it: it is at version {exc.character.get('version')}. "
                       "Read it again (it is in this answer), redo your change on it and send it with that baseVersion."),
            "code": "version_conflict",
            "version": exc.character.get("version"),
            "character": exc.character,
        })
    except ValueError:
        raise refusal_copy.not_found(f"Character '{char_id}' not found", "character", "characters")
    await _broadcast_stored_asset("character", character, edit={})
    return character


@app.delete("/api/characters/{char_id}")
async def delete_character(char_id: str) -> dict:
    """Move a Character to Recently deleted. Anyone, agents included, may:
    it can be restored (POST /api/trash/character/{id}/restore)."""
    store = _char_store()
    try:
        record = store.delete(char_id, deleted_by=actor_record(actor_for_headers(current_request_headers())))
    except (KeyError, ValueError):
        raise refusal_copy.not_found(f"Character '{char_id}' not found", "character", "characters")
    await _broadcast_stored_asset("character", None, char_id, deleted=True)
    return {"status": "trashed", "id": char_id, "trashed": record}


# ---------- Moodboards: provider-neutral creative-direction store ----------

@app.get("/api/moodboards")
async def list_moodboards(scope: str = "global", projectId: str | None = None) -> list[dict]:
    _validate_project_id_param(projectId)
    store = _moodboard_store()
    try:
        return [_moodboard_out(board) for board in store.list(scope=scope, projectId=projectId)]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/moodboards")
async def create_moodboard(body: MoodboardCreate) -> dict:
    _refuse_moodboard_layout(body)
    from services.moodboard_store import NotesOptInProtected
    _require_canvas_project(body.projectId)
    store = _moodboard_store()
    try:
        moodboard = store.create(
            name=body.name,
            # Only what was sent: an image's weight left out comes from its
            # placements, if it asks for any.
            images=[img.model_dump(exclude_unset=True) for img in body.images],
            notes=body.notes,
            mode=body.mode,
            strength=body.strength,
            analysis=body.analysis,
            projectId=body.projectId,
            direction=body.direction,
            avoid=body.avoid,
            pinnedColors=body.pinnedColors.model_dump() if body.pinnedColors else None,
            briefOverride=body.briefOverride.model_dump() if body.briefOverride else None,
            clashMode=body.clashMode,
            colorChoices=body.colorChoices,
            sendNotes=body.sendNotes,
            coverImageId=body.coverImageId,
            by=_moodboard_author(),
        )
    except NotesOptInProtected as exc:
        _refuse_override_change(exc)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    await _broadcast_stored_asset("moodboard", moodboard)
    await _say_agent_action(moodboard_actions.describe_create(moodboard))
    return _moodboard_out(moodboard)


@app.get("/api/moodboards/{moodboard_id}")
async def get_moodboard(moodboard_id: str) -> dict:
    store = _moodboard_store()
    try:
        # Off the event loop: an old board is laid out on read, and the first
        # read of its image headers since Nebula started takes about 2 ms an
        # image (services/moodboard_layout.file_aspect). Reading writes nothing.
        moodboard = await asyncio.to_thread(store.get, moodboard_id)
    except ValueError:
        raise refusal_copy.not_found(f"Moodboard '{moodboard_id}' not found", "board", "boards")
    if moodboard is None:
        return _asset_not_found("moodboard", moodboard_id)
    return _moodboard_out(moodboard)


# A board write that changed no image or frame (a Keep, an analysis saved).
_UNTOUCHED_LAYOUT: dict[str, Any] = {"touched": {"images": [], "frames": [], "looks": []}, "undo": None}


def _moodboard_conflict(exc: Any) -> JSONResponse:
    """409 for a write made against an older board: the current version and
    the board, so the caller rebases on it and sends again."""
    return JSONResponse(status_code=409, content={
        "detail": (f"The board changed since you read it: it is at version {exc.board.get('version')}. "
                   "Read it again (the board is in this answer), redo your change on it and send it with "
                   "that baseVersion."),
        "code": "version_conflict",
        "version": exc.board.get("version"),
        "board": _moodboard_out(exc.board),
    })


def _journal_board_change(before: dict, after: dict, changes: dict, *, say: str = "",
                          proposal_id: str | None = None) -> None:
    """The journal events for a board write (plan section 5.2): an edit
    batch or a PUT. One ``board.*`` event for its images, cards and frames,
    and one ``board.fields`` event naming the board fields it changed
    (Justin's Q91). Every board write goes through here (the Studio, MCP,
    the CLI, an undo's ``restore``, an accepted proposal's PUT), so none is
    missed. Tagged with the open canvas project; the board's own scope is in
    ``data`` (a Global board is in every project). Never any note text, and
    never a field's value. ``proposal_id``: the accepted asset proposal that
    made the write (only _apply_asset_proposal passes it, as canvas accepts
    name theirs), so nebula-mcp --channel tells it from the person's edits."""
    from services.moodboard_edits import journal_entries

    for entry in journal_entries(changes, before, after):
        data: dict[str, Any] = {"boardId": after.get("id"), "boardName": after.get("name"),
                                "scope": after.get("projectId") or "global"}
        if entry["kind"] == "board.fields":
            data["fields"] = entry["fields"]
        else:
            data.update({"refs": entry["refs"], "kinds": entry["kinds"]})
        if say:
            data["say"] = say
        if proposal_id:
            data["proposalId"] = proposal_id
        _journal(entry["kind"], data=data, summary=entry["summary"])


async def _say_agent_board_change(before: dict, after: dict, changes: dict, *, say: str = "",
                                  undo: bool = False) -> None:
    """One Agent log line for an agent's board write (an edit batch or a
    PUT): the agent's own ``say`` when it sent one, else the journal's
    summary of the change (services/moodboard_actions.describe_change),
    marked "Undo:" for a batch of ``restore`` ops. A write that changed
    nothing, and the person's own writes, send nothing."""
    if not changes.get("slices") or identify_agent(current_request_headers()) is None:
        return
    await _say_agent_action(say or moodboard_actions.describe_change(changes, before, after, undo=undo))


def _base_version(raw: Any) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise HTTPException(status_code=422, detail="baseVersion must be a whole number: the board's version you read")
    return raw


@app.put("/api/moodboards/{moodboard_id}")
async def update_moodboard(moodboard_id: str, body: MoodboardUpdate) -> dict:
    return await _update_moodboard(moodboard_id, body)


async def _update_moodboard(moodboard_id: str, body: MoodboardUpdate, *, proposal_id: str | None = None) -> dict:
    """The PUT itself. ``proposal_id`` is for an accepted asset proposal's
    write only (_apply_asset_proposal); the route never takes one."""
    _refuse_moodboard_layout(body)
    store = _moodboard_store()
    base_version = _base_version(body.baseVersion)
    updates = {
        key: value
        for key, value in body.model_dump().items()
        if value is not None and key != "baseVersion"
    }
    if "analysis" in body.model_fields_set and body.analysis is None:
        updates["analysis"] = None
    if "briefOverride" in body.model_fields_set and body.briefOverride is None:
        updates["briefOverride"] = None
    if "coverImageId" in body.model_fields_set and body.coverImageId is None:
        updates["coverImageId"] = None
    if "images" in updates:
        # Images merge by id: a key an image leaves out keeps its saved value
        # (services/moodboard_store._normalize_images), so only what was sent.
        updates["images"] = [img.model_dump(exclude_unset=True) for img in body.images or []]
    updates.pop("colorCheck", None)
    from services.moodboard_edits import diff
    from services.moodboard_store import BriefOverrideProtected, NotesOptInProtected, VersionConflict
    try:
        before, moodboard = store.update_with_before(moodboard_id, by=_moodboard_author(),
                                                     base_version=base_version, **updates)
    except KeyError:
        # In Recently deleted (an agent may have deleted it): say so, so the
        # Studio can tell the person to restore it and keep their edits.
        return _asset_not_found("moodboard", moodboard_id)
    except VersionConflict as exc:
        return _moodboard_conflict(exc)
    except (BriefOverrideProtected, NotesOptInProtected) as exc:
        _refuse_override_change(exc)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    # An older client edits images through PUT: its edits are journaled too.
    changes = diff(before, moodboard)
    _journal_board_change(before, moodboard, changes, proposal_id=proposal_id)
    await _broadcast_stored_asset("moodboard", moodboard, edit={"touched": changes["touched"], "undo": None})
    await _say_agent_board_change(before, moodboard, changes)
    # The answer is the board plus `undo`, the `restore` that takes this
    # write back (the shape `/edits` answers with), made from the same diff:
    # Moodboard Studio's field steps undo with it, and so can any caller.
    # Only the caller gets it; the broadcast's stays null.
    undo = {"ops": [{"op": "restore", "slices": changes["slices"]}]} if changes["slices"] else {"ops": []}
    return {**_moodboard_out(moodboard), "undo": undo}


@app.post("/api/moodboards/{moodboard_id}/edits")
async def edit_moodboard(moodboard_id: str, body: MoodboardEditsBody) -> dict:
    """Checked board edits (services/moodboard_edits.py, plan section 5.1):
    the ops land together with ``version + 1``, or none do (422 naming the
    op). ``baseVersion`` that isn't the board's is a 409 with the board as it
    is now. The answer is ``{board, version, applied, undo}``; ``undo`` is a
    ``restore`` that puts the board back, skipping (and reporting) what
    changed since. Anyone may edit, agents included: every batch is undoable,
    and journaled as one ``board.*`` event."""
    from services.moodboard_edits import UNDO_BROADCAST_LIMIT, EditError, clean_say
    from services.moodboard_store import VersionConflict

    base_version = _base_version(body.baseVersion)
    store = _moodboard_store()
    try:
        before, board, result = store.apply_edits(moodboard_id, body.ops, by=_moodboard_author(),
                                                  base_version=base_version)
    except KeyError:
        return _asset_not_found("moodboard", moodboard_id)
    except VersionConflict as exc:
        return _moodboard_conflict(exc)
    except ValueError as exc:  # EditError, or an id no board can have
        if not isinstance(exc, EditError) and "moodboard id" in str(exc):
            return _asset_not_found("moodboard", moodboard_id)
        raise HTTPException(status_code=422, detail=str(exc))
    if result.changed:
        say = clean_say(body.say)
        _journal_board_change(before, board, result.changes, say=say)
        undo = result.undo if len(body.ops) <= UNDO_BROADCAST_LIMIT else None
        await _broadcast_stored_asset("moodboard", board, edit={"touched": result.touched, "undo": undo})
        undo_batch = all(isinstance(op, dict) and op.get("op") == "restore" for op in body.ops)
        await _say_agent_board_change(before, board, result.changes, say=say, undo=undo_batch)
    return {"board": _moodboard_out(board), "version": board.get("version"), "applied": result.applied,
            "undo": result.undo}


@app.post("/api/moodboards/{moodboard_id}/brief-override/keep")
async def keep_moodboard_brief_override(moodboard_id: str) -> dict:
    """Keep the board's hand-written brief after the board changed: clears
    "changed since you edited this" until the next change. Only the person
    may keep text the person wrote; an agent may keep its own."""
    from services.moodboard_store import BriefOverrideProtected
    store = _moodboard_store()
    try:
        moodboard = store.keep_brief_override(moodboard_id, by=_moodboard_author())
    except KeyError:
        return _asset_not_found("moodboard", moodboard_id)
    except BriefOverrideProtected as exc:
        _refuse_override_change(exc)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    await _broadcast_stored_asset("moodboard", moodboard, edit=_UNTOUCHED_LAYOUT)
    await _say_agent_action(moodboard_actions.describe_write("kept the brief on", moodboard))
    return _moodboard_out(moodboard)


# Saves Analyze tries before a board that keeps changing is a 409.
MOODBOARD_ANALYZE_TRIES = 3


@app.post("/api/moodboards/{moodboard_id}/analyze")
async def analyze_moodboard_route(moodboard_id: str) -> dict:
    store = _moodboard_store()
    try:
        # Laid out off the event loop, so saving the analysis below (which
        # saves an old board's layout) finds its image headers already read.
        moodboard = await asyncio.to_thread(store.get, moodboard_id)
    except ValueError:
        raise refusal_copy.not_found(f"Moodboard '{moodboard_id}' not found", "board", "boards")
    if moodboard is None:
        # In Recently deleted: say so (and how to restore it), as GET does.
        return _asset_not_found("moodboard", moodboard_id)

    from services.moodboard_analysis import analysis_is_current, analyze_moodboard
    from services.moodboard_store import VersionConflict

    # It reads every image file, so it runs off the event loop.
    analysis = await asyncio.to_thread(analyze_moodboard, moodboard)
    # Saved against the version it read: an edit while it ran (a weight, a
    # note) would otherwise sit beside an analysis of the board before it.
    # On a conflict the analysis is kept when it still describes the board
    # (a rename, a brief field), and made again from the board when not.
    for attempt in range(1, MOODBOARD_ANALYZE_TRIES + 1):
        try:
            moodboard = store.update(moodboard_id, analysis=analysis, base_version=moodboard.get("version"))
            break
        except VersionConflict as exc:
            if attempt == MOODBOARD_ANALYZE_TRIES:
                return _moodboard_conflict(exc)
            moodboard = exc.board
            if not analysis_is_current(moodboard, analysis):
                analysis = await asyncio.to_thread(analyze_moodboard, moodboard)
        except (KeyError, ValueError):
            raise refusal_copy.not_found(f"Moodboard '{moodboard_id}' not found", "board", "boards")
    await _broadcast_stored_asset("moodboard", moodboard, edit=_UNTOUCHED_LAYOUT)
    await _say_agent_action(moodboard_actions.describe_write("analyzed", moodboard))
    return _moodboard_out(moodboard)


@app.post("/api/moodboards/{moodboard_id}/analyze/dry-run")
async def dry_run_moodboard_analysis(moodboard_id: str, body: MoodboardDryRunRequest | None = None) -> dict:
    """What Analyze would give now, saving nothing: no board write, no
    broadcast. Returns the analysis, the brief generators would get, and what
    changed from the saved ones (services/moodboard_analysis.dry_run).

    ``thresholds`` tries other colour thresholds; nothing saves them, and
    Analyze always uses the defaults. A route of its own rather than a flag
    on /analyze: an older backend ignores a body it doesn't know, so a flag
    sent there would analyze and save; this route is simply missing (404).
    Agents may call it freely, since it changes nothing."""
    from services.moodboard_analysis import dry_run, parse_thresholds

    request = body or MoodboardDryRunRequest()
    try:
        thresholds = parse_thresholds(
            request.thresholds.model_dump(exclude_unset=True) if request.thresholds else None)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    try:
        moodboard = _moodboard_store().get(moodboard_id, laid_out=False)  # nor does the dry run
    except ValueError:
        raise refusal_copy.not_found(f"Moodboard '{moodboard_id}' not found", "board", "boards")
    if moodboard is None:
        raise refusal_copy.not_found(f"Moodboard '{moodboard_id}' not found", "board", "boards")
    # It reads every image file, so it runs off the event loop.
    return await asyncio.to_thread(dry_run, moodboard, thresholds)


# ---------- Moodboards: reading references with a vision model (PR4, dry run) ----------
# docs/moodboard-canvas-plan.md sections 5.6 and 5.6.1, contract 07 section 1.13.

# Tests point the reader's requests at a mock transport (an httpx.AsyncBaseTransport);
# None is the real network.
_moodboard_reader_transport: Any = None


def _reader_board(moodboard_id: str) -> dict:
    try:
        board = _moodboard_store().get(moodboard_id, laid_out=False)  # a read never writes the board
    except ValueError:
        raise refusal_copy.not_found(f"Moodboard '{moodboard_id}' not found", "board", "boards")
    if board is None:
        raise refusal_copy.not_found(f"Moodboard '{moodboard_id}' not found", "board", "boards")
    return board


def _reader_plan(moodboard_id: str, body: MoodboardReadRequest) -> tuple[dict, dict, Any, list, dict]:
    """The board, the reader's entry, its reading source (no key yet), the
    targets and the estimate, or 404/422. A source Nebula doesn't pay for gets
    no estimate maths (moodboard_reader.read_estimate)."""
    from services import moodboard_reader as reader

    board = _reader_board(moodboard_id)
    try:
        entry = reader.reader_entry(body.model)
        targets = reader.select_targets(board, body.imageIds)
        source = reader.model_source(entry, level=body.thinkingLevel)
        estimate = reader.read_estimate(source, board, targets)
    except reader.ReaderError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return board, entry, source, targets, estimate


def _reader_spend_hold(source: Any, estimate: dict, settings: Mapping[str, Any], board_ref: str) -> _SpendHold | None:
    """Refuse a read that isn't the person's when it breaks a spending limit,
    and count it at its high estimate when it doesn't (Q11: as one Gemini
    chat run, so the chat model's own limits in Settings apply). The hold is
    split per request, so requests that never start are given back.
    The person's reads pass: the Studio asks them itself (PR10). A source
    Nebula doesn't pay for (``source.priced`` false) has nothing to gate or
    hold; an Argon entry with no list price is still priced, and refused
    under any USD limit."""
    from services import moodboard_reader as reader

    if _is_person_request():
        return None
    gate = reader.gate_items(source, estimate)
    if gate is None:
        return None
    items, pricing = gate
    name, key_id = source.identity["name"], reader.reader_key(source.identity)
    ask = (f"To let agents read it, the person can raise the per-run limit for {name} "
           f"(the Gemini chat node) in Settings > Agent spending. Price it first: "
           f"`nebula moodboard analyze {board_ref} --read-with {key_id} --estimate` "
           "(MCP: moodboard_analyze with estimate_only).")
    key, label = _spend_session(current_request_headers())
    decision = agent_spend.decide(items, [], settings=settings, pricing=pricing, definitions=node_registry.get_all(),
                                  budgets=_spend_budgets(key, settings), how_to_ask=ask)
    if decision.refusal:
        raise _person_only_refusal(decision.refusal)
    at = agent_spend_ledger.record(key, label, decision.charge, decision.plan_charge)
    node = str(items[0]["definitionId"])
    shares = {part: (node, amount) for part, amount in (estimate.get("shares") or {}).items()}
    if not decision.charge or not shares:
        return None
    # The shares add up to the charge; any rounding left over rides on the first request.
    left = round(sum(decision.charge.values()) - sum(amount for _, amount in shares.values()), 6)
    first = next(iter(shares))
    shares[first] = (shares[first][0], round(shares[first][1] + left, 6))
    return _SpendHold(key, shares, {}, at)


def _settle_reader_hold(hold: _SpendHold | None, sent: Iterable[str] | None) -> None:
    """Give back the share of every request that never started. A request
    that started stays charged at its high estimate, even if its stream was
    closed: whether an aborted stream is billed is unconfirmed."""
    if hold is None:
        return
    started = set(sent or [])
    try:
        hold.give_back(*hold.take([part for part in list(hold.per_node) if part not in started]))
    except Exception:  # noqa: BLE001 - bookkeeping must not break a read
        pass


@app.post("/api/moodboards/{moodboard_id}/read/estimate")
async def estimate_moodboard_read(moodboard_id: str, body: MoodboardReadRequest) -> dict:
    """What reading these references would cost (C10, Q16), sending nothing:
    ``{count, batches, low, high, unconfirmed, sources}`` and the parts behind
    them. ``available`` says whether the reader's key is set."""
    _, entry, _, _, estimate = _reader_plan(moodboard_id, body)
    keys = node_readiness.configured_keys(load_settings())
    return {**estimate, "available": str(entry["keyName"]) in keys}


@app.post("/api/moodboards/{moodboard_id}/read")
async def read_moodboard(moodboard_id: str, body: MoodboardReadRequest, dryRun: bool = False,
                         stream: bool = False) -> Any:
    """Read references with the vision model the caller names, and say how
    Analyze would sort them. Only a dry run exists yet (``dryRun=1``): it
    pays for the read, saves nothing and moves nothing; PR10 applies the sort.

    Agents go through the spending limits first (the high estimate is held,
    unstarted requests are given back). ``stream=1`` answers as NDJSON: one
    ``moodboardReadTrace`` line per trace line as it is written, then one
    ``moodboardReadResult``. Without it the result comes whole, with its trace."""
    import httpx

    from services import moodboard_reader as reader

    if not dryRun:
        raise HTTPException(status_code=422, detail=(
            "Reading references can only be a dry run in this version of Nebula: send dryRun=1. "
            "It reads and prices them and says how Analyze would sort them, and moves nothing."))
    board, entry, source, targets, estimate = _reader_plan(moodboard_id, body)
    if not estimate["count"]:
        raise HTTPException(status_code=422, detail=(
            "Nothing to read: none of these references is a file on this computer."
            if targets else "Nothing to read: the board has no references."))
    settings = load_settings()
    hold = _reader_spend_hold(source, estimate, settings, str(board.get("id")))
    requested_by = actor_record(actor_for_headers(current_request_headers()))
    lines: asyncio.Queue | None = asyncio.Queue() if stream else None
    client = httpx.AsyncClient(transport=_moodboard_reader_transport, timeout=httpx.Timeout(30.0, read=None)) \
        if _moodboard_reader_transport is not None else None
    try:
        run_source = reader.model_source(entry, reader.check_key(entry, settings.get("apiKeys") or {}),
                                         level=source.level, client=client)
        run = reader.MoodboardRead(board, source=run_source, targets=targets, requested_by=requested_by,
                                   sink=lines.put_nowait if lines is not None else None)
    except reader.NoReaderKeyError as exc:
        _settle_reader_hold(hold, [])
        if client is not None:
            await client.aclose()
        raise HTTPException(status_code=400, detail=str(exc))

    async def finish() -> dict:
        result: dict | None = None
        try:
            result = await run.run()
            return {**result, "estimate": estimate}
        finally:
            # Cancelled mid-read (the caller left): what started stays charged.
            _settle_reader_hold(hold, result["sent"] if result else run.sent_so_far())
            if client is not None:
                await client.aclose()

    if lines is None:
        return await finish()

    async def ndjson():
        task = asyncio.create_task(finish())
        try:
            while True:
                getter = asyncio.ensure_future(lines.get())
                done, _ = await asyncio.wait({getter, task}, return_when=asyncio.FIRST_COMPLETED)
                if getter in done:
                    yield json.dumps(getter.result(), ensure_ascii=False) + "\n"
                    continue
                getter.cancel()
                while not lines.empty():
                    yield json.dumps(lines.get_nowait(), ensure_ascii=False) + "\n"
                try:
                    result = task.result()
                except Exception as exc:  # noqa: BLE001 - the stream has started, so say it in the stream
                    logging.getLogger("nebula.moodboard_reader").exception("Moodboard read %s failed", run.run_id)
                    yield json.dumps({"type": "moodboardReadError", "detail": f"The read stopped: {exc}"}) + "\n"
                    return
                yield json.dumps({"type": "moodboardReadResult", **{k: v for k, v in result.items() if k != "trace"}},
                                 ensure_ascii=False) + "\n"
                return
        finally:
            if not task.done():
                task.cancel()

    from fastapi.responses import StreamingResponse
    return StreamingResponse(ndjson(), media_type="application/x-ndjson")


@app.delete("/api/moodboards/{moodboard_id}")
async def delete_moodboard(moodboard_id: str) -> dict:
    """Move a board to Recently deleted. Anyone, agents included, may: it
    can be restored (POST /api/trash/moodboard/{id}/restore)."""
    store = _moodboard_store()
    try:
        record = store.delete(moodboard_id, deleted_by=actor_record(actor_for_headers(current_request_headers())))
    except (KeyError, ValueError):
        raise refusal_copy.not_found(f"Moodboard '{moodboard_id}' not found", "board", "boards")
    await _broadcast_stored_asset("moodboard", None, moodboard_id, deleted=True)
    await _say_agent_action(moodboard_actions.describe_write("deleted", record))
    return {"status": "trashed", "id": moodboard_id, "trashed": record}


# ---------- Move a board or Character between Global and a canvas project ----------
#
# Justin's call P4 (2026-10-19): "Move to Global" / "Move to <project>", so a
# re-home that guessed wrong can be put right and a project board can become
# house style. Anyone may move, agents included: moving it back undoes it.
# Contract 07, 1.10.

class AssetMoveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required, and null means Global: a body that forgot it is a 422, never a
    # silent move to Global.
    projectId: str | None


def _scope_name(catalog: Mapping[str, Any], project_id: str | None) -> str:
    """"Global", or a canvas project's name (Recently deleted too), else its id."""
    if not project_id:
        return "Global"
    for key in ("projects", "trash"):
        project = (catalog.get(key) or {}).get(project_id)
        if isinstance(project, dict) and project.get("name"):
            return str(project["name"])
    return project_id


async def _move_stored_asset(kind: str, asset_id: str, body: AssetMoveBody) -> dict:
    """POST /api/{moodboards|characters}/{id}/move. 400 for an unsafe
    projectId; 404 for no such asset; 409 for one in Recently deleted (restore
    it first) or an id already in the target; 422 for a target that isn't a
    live canvas project. Already there: 200, ``status: "unchanged"``, nothing
    written or broadcast."""
    target = body.projectId
    _validate_project_id_param(target)
    store = _asset_store(kind)
    noun = _asset_noun(kind)
    try:
        live = store.get(asset_id)
    except ValueError:
        raise _stored_asset_gone(kind, f"{noun} '{asset_id}' not found")
    if live is None:
        record = _trashed_asset(kind, asset_id)
        if record is None:
            raise _stored_asset_gone(kind, f"{noun} '{asset_id}' not found")
        return JSONResponse(status_code=409, content={
            "detail": refusal_copy.refusal_detail(
                f"{noun} '{asset_id}' is in Recently deleted. Restore it first "
                f"(nebula trash restore {kind} {asset_id}, or POST /api/trash/{kind}/{asset_id}/restore), "
                "then move it.",
                f"That {_person_noun(kind)} is in Recently deleted. Restore it first, then move it."),
            "code": "in_trash",
            "trashed": record,
        })
    _require_canvas_project(target)
    try:
        before, after, moved = store.move(asset_id, target)
    except KeyError:  # deleted between the read and the move
        raise _stored_asset_gone(kind, f"{noun} '{asset_id}' not found")
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=(
            f"{noun} '{asset_id}' can't move: {exc}. Nothing was changed.")) from exc
    catalog = project_store.read()
    source = before.get("projectId") or None
    names = {"from": _scope_name(catalog, source), "to": _scope_name(catalog, target)}
    name = after.get("name") or asset_id
    out = _moodboard_out(after) if kind == "moodboard" else after
    result: dict[str, Any] = {"status": "moved" if moved else "unchanged", "kind": kind, "id": asset_id,
                              "from": source, "to": target, "fromName": names["from"], "toName": names["to"],
                              "asset": out}
    if not moved:
        where = "Global" if not target else f"in {names['to']}"
        result["detail"] = f"“{name}” is already {where}. Nothing changed."
        return result
    # Who moved it, as Recently deleted's deletedBy keeps it. Boards and
    # Characters keep no "changed by" field, so it is in the answer only.
    result["movedBy"] = actor_record(actor_for_headers(current_request_headers()))
    result["detail"] = f"Moved “{name}” from {names['from']} to {names['to']}."
    await _broadcast_stored_asset(kind, after, moved=True)
    if kind == "moodboard":
        await _say_agent_action(moodboard_actions.describe_write("moved", after, f"to {names['to']}"))
    return result


@app.post("/api/moodboards/{moodboard_id}/move")
async def move_moodboard(moodboard_id: str, body: AssetMoveBody) -> dict:
    """Move a board to a canvas project (``projectId``) or to Global (null)."""
    return await _move_stored_asset("moodboard", moodboard_id, body)


@app.post("/api/characters/{char_id}/move")
async def move_character(char_id: str, body: AssetMoveBody) -> dict:
    """Move a Character to a canvas project (``projectId``) or to Global (null)."""
    return await _move_stored_asset("character", char_id, body)


# ---------- Recently deleted: moodboards, characters and projects ----------
#
# Deleting a board, a character or a project moves it here, and anyone,
# agents included, may restore it. Deleting for good can't be undone, so it is
# the person's alone (services/person_gate.py). Boards and characters stay
# until the person deletes them for good; projects keep their 30-day expiry
# (services/project_store.py TRASH_RETENTION).

TRASH_KINDS = ("moodboard", "character", "style", "project")
# The kinds kept in a store's own .trash folder (services/asset_trash.py);
# projects keep theirs in the catalog. Styles joined 2026-10-20 (Q53 a).
_ASSET_TRASH_KINDS = ("moodboard", "character", "style")
_RESTORE_HINT = ("Deleting for good can't be undone, so only the person can. You can restore it instead: "
                 "nebula trash restore <kind> <id>, the restore_from_trash tool, or "
                 "POST /api/trash/<kind>/<id>/restore.")


def _trash_kind(kind: str) -> str:
    if kind not in TRASH_KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {', '.join(TRASH_KINDS)}")
    return kind


def _asset_store(kind: str):
    if kind == "style":
        return preset_store
    return _moodboard_store() if kind == "moodboard" else _char_store()


def _asset_noun(kind: str) -> str:
    if kind == "style":
        return "Style"
    return "Moodboard" if kind == "moodboard" else "Character"


def _person_noun(kind: str) -> str:
    """The thing as the person's UI names it (GM's 404 pattern, error-copy round 3)."""
    return {"style": "style", "moodboard": "board"}.get(kind, "character")


def _stored_asset_gone(kind: str, specific: str) -> HTTPException:
    noun = _person_noun(kind)
    return refusal_copy.not_found(specific, noun, f"{noun}s")


def _asset_not_found(kind: str, asset_id: str) -> JSONResponse:
    """404 for a board or character that isn't live. When it is in Recently
    deleted the body says so (code "in_trash", with the trash record), so a
    card can offer Restore instead of "not found". The person reads GM's
    lines (error-copy round 3); agents keep the id and the restore command."""
    record = _trashed_asset(kind, asset_id)
    noun = _person_noun(kind)
    if record is None:
        return JSONResponse(status_code=404, content={"detail": refusal_copy.refusal_detail(
            f"{_asset_noun(kind)} '{asset_id}' not found", refusal_copy.gone(noun, f"{noun}s"))})
    return JSONResponse(status_code=404, content={
        "detail": refusal_copy.refusal_detail(
            f"{_asset_noun(kind)} '{asset_id}' is in Recently deleted. Restore it with "
            f"nebula trash restore {kind} {asset_id} (POST /api/trash/{kind}/{asset_id}/restore).",
            f"That {noun} is in Recently deleted. Restore it, then try again."),
        "code": "in_trash",
        "trashed": record,
    })


def _trash_scope(scope: str | None, project_id: str | None) -> None:
    _validate_project_id_param(project_id)
    if scope not in (None, "global", "project"):
        raise HTTPException(status_code=400, detail="scope must be global or project")
    if scope == "project" and not project_id:
        raise HTTPException(status_code=400, detail="projectId is required for scope=project")


def _project_trash_items() -> list[dict[str, Any]]:
    with project_store.transaction() as catalog:
        expired = purge_expired_trash(catalog)
        if expired:
            project_store.commit(catalog)
        items = [{"kind": "project", **entry} for entry in _trash_listing(catalog)]
        kept = set(catalog["projects"]) | set(catalog.get("trash") or {})
    if expired:
        # Trash past its 30 days took its question sets with it.
        agent_questions.keep_projects(kept)
    return items


@app.get("/api/trash")
async def list_trash(kind: str | None = None, scope: str | None = None,
                     projectId: str | None = None) -> dict[str, Any]:
    """What's in Recently deleted, newest first. ``kind`` narrows it to
    moodboards, characters or projects; ``scope`` (global, or project with
    ``projectId``) narrows boards and characters the way their lists do."""
    if kind is not None:
        _trash_kind(kind)
    _trash_scope(scope, projectId)
    items: list[dict[str, Any]] = []
    for asset_kind in _ASSET_TRASH_KINDS:
        if kind in (None, asset_kind):
            try:
                items.extend(_asset_store(asset_kind).list_trash(scope=scope, projectId=projectId))
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
    if kind in (None, "project") and scope is None:
        items.extend(_project_trash_items())
    items.sort(key=lambda item: str(item.get("deletedAt") or ""), reverse=True)
    return {"items": items}


@app.post("/api/trash/{kind}/{item_id}/restore")
async def restore_trashed(kind: str, item_id: str) -> dict[str, Any]:
    """Bring something back from Recently deleted with the same id and
    contents. Agents may: a restore undoes a delete."""
    _trash_kind(kind)
    if kind == "project":
        result = await restore_saved_project(item_id)
        return {"restored": "project", "id": item_id, **result}
    try:
        asset = _asset_store(kind).restore(item_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except asset_trash.AlreadyLive:
        raise HTTPException(status_code=409, detail=(
            f"{_asset_noun(kind)} '{item_id}' is already back; nothing to restore"))
    except KeyError:
        # Already restored (another tab, an agent, or a retry): nothing to do,
        # and the caller gets what it asked for.
        live = _stored_asset(kind, item_id)
        if live is not None:
            return {"restored": kind, "id": item_id, "asset": _asset_out(kind, live), "alreadyRestored": True}
        raise refusal_copy.refusal(404, f"{_asset_noun(kind)} '{item_id}' isn't in Recently deleted", refusal_copy.gone_from_trash(_person_noun(kind)))
    await _broadcast_stored_asset(kind, asset)
    if kind == "moodboard":
        await _say_agent_action(moodboard_actions.describe_write("restored", asset))
    if kind == "style":  # broadcast above
        await _style_written("restored", asset, broadcast=False)
    # Read back through the store, as GET does (a board gets its brief).
    return {"restored": kind, "id": item_id, "asset": _asset_out(kind, _stored_asset(kind, item_id) or asset)}


@app.delete("/api/trash/{kind}/{item_id}")
async def purge_trashed(kind: str, item_id: str) -> dict[str, Any]:
    """Delete one item for good. Only the person may."""
    _trash_kind(kind)
    require_person(current_request_headers(), hint=_RESTORE_HINT)
    if kind == "project":
        await purge_trashed_project(item_id)
        return {"purged": "project", "id": item_id}
    record = _trashed_asset(kind, item_id) if kind == "style" else None
    try:
        _asset_store(kind).purge(item_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError:
        raise refusal_copy.refusal(404, f"{_asset_noun(kind)} '{item_id}' isn't in Recently deleted", refusal_copy.gone_from_trash(_person_noun(kind)))
    # A card that showed it "in Recently deleted" now says it's gone.
    if kind == "style":
        _journal_style("purged", record, style_id=item_id)  # before any await (round 8 of PR #114)
    await _broadcast_stored_asset(kind, None, item_id, deleted=True)
    return {"purged": kind, "id": item_id}


@app.post("/api/trash/empty")
async def empty_trash(kind: str | None = None, scope: str | None = None,
                      projectId: str | None = None, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Delete for good everything ``GET /api/trash`` lists with the same
    filters. Only the person may.

    The canvas sends ``{"items": [{"kind", "id"}, ...]}``, what its list
    showed, and then only those go: an agent's delete that landed after the
    list loaded stays restorable. Without ``items`` everything listed goes."""
    if kind is not None:
        _trash_kind(kind)
    _trash_scope(scope, projectId)
    require_person(current_request_headers(), hint=_RESTORE_HINT)
    shown = _shown_trash_items(body)
    purged = 0
    for asset_kind in _ASSET_TRASH_KINDS:
        if kind in (None, asset_kind):
            store = _asset_store(asset_kind)
            for record in store.list_trash(scope=scope, projectId=projectId):
                if shown is not None and (asset_kind, record["id"]) not in shown:
                    continue
                try:
                    store.purge(record["id"])
                except KeyError:
                    continue
                purged += 1
                if asset_kind == "style":
                    _journal_style("purged", record, style_id=record["id"])  # before any await
                await _broadcast_stored_asset(asset_kind, None, record["id"], deleted=True)
    if kind in (None, "project") and scope is None:
        with project_store.transaction() as catalog:
            trash = catalog.get("trash") or {}
            doomed = [project_id for project_id in trash if shown is None or ("project", project_id) in shown]
            for project_id in doomed:
                del trash[project_id]
            if doomed:
                purged += len(doomed)
                project_store.commit(catalog)
                node_errors.keep_projects(set(catalog["projects"]) | set(trash))
            kept = set(catalog["projects"]) | set(trash)
        if doomed:
            # Their question sets went with their records; the book forgets them too.
            agent_questions.keep_projects(kept)
            await _broadcast_projects_changed("purged")
    return {"purged": purged}


def _shown_trash_items(body: dict[str, Any] | None) -> set[tuple[str, str]] | None:
    """``items`` from an empty request as {(kind, id)}, or None when absent."""
    if not body or "items" not in body:
        return None
    raw = body.get("items")
    if not isinstance(raw, list) or len(raw) > 10_000:
        raise HTTPException(status_code=400, detail="items must be a list of {kind, id}")
    shown: set[tuple[str, str]] = set()
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise HTTPException(status_code=400, detail="items must be a list of {kind, id}")
        item_kind = _trash_kind(str(item.get("kind")))
        try:
            if item_kind == "project":
                validate_project_id(item["id"])
            else:
                asset_trash.validate_id(item["id"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        shown.add((item_kind, item["id"]))
    return shown


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
    # Only a project Style is filed under projectId (services/preset_store.py).
    if body.scope == "project":
        _require_canvas_project(body.projectId)
    else:
        _validate_project_id_param(body.projectId)
    # Create's "Save current" sends the version its draft is at, and so do
    # the MCP's style_create and `nebula style new` (the version of the code
    # they run). Main's bundle from before the marker (a tab open across an
    # update) POSTs without the key, so a body without it is read as holding
    # params from before every upgrade: version 0 (services/saved_graph_upgrades.py).
    params_version = _preset_params_version(body, 0)
    _check_style_write(body.name, body.modelId, body.params, None)
    _check_stored_images("style", body.model_dump())
    try:
        preset = preset_store.create(
            name=body.name, category=body.category, prompt=body.prompt, params=body.params,
            modelId=body.modelId, refImages=body.refImages, scope=body.scope, projectId=body.projectId,
            thumbnail=body.thumbnail, params_version=params_version,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    await _style_written("created", preset)
    return preset


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
        # In Recently deleted: say so (code "in_trash", with the record).
        return _asset_not_found("style", preset_id)
    return preset


@app.put("/api/presets/{preset_id}")
async def update_preset(preset_id: str, body: PresetUpdate) -> dict:
    # No bundle sends PUT (old or new), so a caller here is deliberate API use
    # writing params now: a body without the key is taken as current.
    from services.preset_store import VersionConflict

    params_version = _preset_params_version(body, PARAMS_VERSION)
    base_version = _style_base_version(body.baseVersion)
    fields = body.model_dump(exclude_none=True, exclude={"paramsVersion", "baseVersion"})
    before = preset_store.get(preset_id)
    if before is None:
        return _asset_not_found("style", preset_id)
    if "params" in fields:
        fields["params"] = _style_params_keeping_internal(before.get("params") or {}, fields["params"])
    after_model = fields.get("modelId", before.get("modelId")) or None
    _check_style_write(fields.get("name", before.get("name")), after_model,
                       fields.get("params", before.get("params") or {}),
                       before if after_model == (before.get("modelId") or None) else None,
                       before_params=before.get("params") or {})
    # A version behind (versions only grow): the update below is the 409 the
    # caller re-reads from, so an outside link it still holds isn't the answer.
    version = before.get("version")
    if not (base_version is not None and isinstance(version, int) and version > base_version):
        _check_stored_images("style", fields, before=before)
    try:
        preset = preset_store.update(preset_id, params_version=params_version, base_version=base_version, **fields)
    except KeyError:
        # In Recently deleted since the read (an agent may have deleted it).
        return _asset_not_found("style", preset_id)
    except VersionConflict as exc:
        return JSONResponse(status_code=409, content={
            "detail": (f"The Style changed since you read it: it is at version {exc.preset.get('version')}. "
                       "Read it again (the Style is in this answer), redo your change on it and send it "
                       "with that baseVersion."),
            "code": "version_conflict",
            "version": exc.preset.get("version"),
            "style": exc.preset,
        })
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    from services.style_actions import changed_fields

    await _style_written("updated", preset, fields=changed_fields(before, preset))
    return preset


@app.delete("/api/presets/{preset_id}")
async def delete_preset(preset_id: str) -> dict:
    """Move a Style to Recently deleted. Anyone, agents included, may: it
    can be restored (POST /api/trash/style/{id}/restore). Deleting it for
    good is the person's (DELETE /api/trash/style/{id})."""
    try:
        record = preset_store.delete(preset_id, deleted_by=actor_record(actor_for_headers(current_request_headers())))
    except (KeyError, ValueError):
        raise refusal_copy.not_found(f"Style '{preset_id}' not found", "style", "styles")
    await _style_written("deleted", record, deleted=True)
    return {"status": "trashed", "id": preset_id, "trashed": record}


# Styles: who may write what, and what every write tells the others.

def _style_base_version(raw: Any) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise HTTPException(status_code=422, detail="baseVersion must be a whole number: the Style's version you read")
    return raw


def _check_style_write(name: Any, model_id: str | None, params: Mapping[str, Any],
                       before: Mapping[str, Any] | None, *, before_params: Mapping[str, Any] | None = None) -> None:
    """The node routes' rules, for a Style's params: applying a Style in
    Create puts its params on the draft, billing included, so a Style is
    held to what a node edit is.

    - An agent may not write an internal (``_``) param it didn't read back
      unchanged (``_refuse_agent_internal_params``).
    - Nobody but the person may make a Style that changes who bills its
      model's run (``_provider``, ``_kreaAuth``; ``_refuse_agent_billing_change``).
      ``before`` is the Style as it was when the model stays the same.
    - An agent's ``modelId`` must be a node id in the catalog; a display
      name is refused naming its id (``node_lookup.unknown_definition``)."""
    params = params if isinstance(params, Mapping) else {}
    label = f"Style “{str(name or '')[:60]}”"
    if has_agent_marker(current_request_headers()):
        was = before_params if before_params is not None else {}
        _refuse_agent_internal_params({key: value for key, value in params.items()
                                       if key not in was or was.get(key) != value}, "style")
        if model_id and node_registry.get(model_id) is None:
            # Strict like the node writes (a Style stores its modelId and Create
            # applies it), and the refusal names the exact-name match the same way.
            raise HTTPException(status_code=400, detail=(
                f"style.modelId: {node_lookup.unknown_definition(str(model_id)[:64], node_registry.get_all())}; "
                "find_nodes (`nebula nodes`) lists them"))
    if model_id:
        try:
            _refuse_agent_billing_change([(label, model_id, (before or {}).get("params") if before else None, params)])
        except (HTTPException, PersonGateError) as exc:
            # The node sentences end "propose the change instead with
            # propose_change"; a Style change can't be proposed.
            status = exc.status_code if isinstance(exc, HTTPException) else exc.status
            if status == 403 and isinstance(exc.detail, str):
                exc.detail = _STYLE_PROPOSE_RE.sub(_STYLE_BILLING_INSTEAD, exc.detail)
            raise


_STYLE_PROPOSE_RE = re.compile(
    r",? and propose the change instead with propose_change \(`nebula propose`\); "
    r"the person accepts it on the canvas\.")
_STYLE_BILLING_INSTEAD = (
    " (or leave it out: the model's default). A Style change can't be proposed: ask the person to "
    "pick it in Create and save the Style there.")


def _style_params_keeping_internal(before: Mapping[str, Any], params: Any) -> Any:
    """An agent's ``params`` for a Style, with the Style's internal (``_``)
    params it left out put back. An agent can't write those (it may only send
    them back unchanged), so it can't take them off either; then the
    ``previous`` an update returns undoes it. Billing params aren't internal:
    leaving them out is a billing change, which the billing rule judges. The
    person's own save replaces the settings whole."""
    if not isinstance(params, Mapping) or not has_agent_marker(current_request_headers()):
        return params
    kept = {key: before[key] for key in internal_keys(before) if key not in params}
    return {**kept, **params} if kept else params


def _journal_style(change: str, style: Mapping[str, Any] | None, *, style_id: str = "",
                   fields: list[str] | None = None) -> str:
    """One ``style.*`` journal event in the caller's name; returns its line."""
    from services import style_actions

    line = style_actions.describe(change, style, fields=fields, style_id=style_id)
    _journal(f"style.{change}", data=style_actions.journal_data(style, fields=fields, style_id=style_id),
             summary=line)
    return line


async def _style_written(change: str, style: Mapping[str, Any], *, fields: list[str] | None = None,
                         deleted: bool = False, broadcast: bool = True) -> None:
    """After a Style write: the journal, ``storedAssetChanged`` (kind
    "style") so the Assets panel and Create's Styles list again, and, for an
    agent, the same line in the Agent log."""
    from services import style_actions

    style_id = str(style.get("id") or "")
    line = _journal_style(change, style, style_id=style_id, fields=fields)
    if broadcast:
        await _broadcast_stored_asset("style", None if deleted else style, style_id, deleted=deleted)
    await _say_agent_action(style_actions.sentence(line))


# ---------- Preset seeding (first-run starter styles) ----------

_PRESET_SEED_PATH = Path(__file__).resolve().parent / "data" / "presets" / "seed.json"
# A dot file in the preset root: the stores and the re-home skip dot names.
_PRESET_SEEDED_MARKER = ".seeded"


def _mark_presets_seeded(marker: Path) -> None:
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("seeded starter Styles once; delete this file to seed them again\n", encoding="utf-8")


def seed_presets_if_empty() -> None:
    """Populate the global preset store with shipped starter styles on first run.
    Idempotent: does nothing if any global preset already exists."""
    try:
        # Once seeded, never again: the person may delete the starters, in
        # Recently deleted or for good, and they mustn't come back on the next
        # start. An install from before the marker that has a global Style
        # (live or in Recently deleted) was seeded.
        from services.preset_store import store_root as _preset_root

        marker = _preset_root() / _PRESET_SEEDED_MARKER
        if marker.exists():
            return
        if preset_store.list("global") or preset_store.list_trash(scope="global"):
            _mark_presets_seeded(marker)
            return
        if not _PRESET_SEED_PATH.exists():
            return
        seeds = json.loads(_PRESET_SEED_PATH.read_text(encoding="utf-8"))
        for s in seeds:
            preset_store.create(
                name=s["name"], category=s.get("category", "Style"), prompt=s.get("prompt", ""),
                params=s.get("params", {}), modelId=s.get("modelId"), refImages=s.get("refImages", []),
                scope="global", projectId=None, params_version=PARAMS_VERSION,
            )
        _mark_presets_seeded(marker)
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
        env=scrubbed_env(),
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

    # Determine filename with collision avoidance. The copy goes to a
    # dot-named temporary file and is linked into place under a name nothing
    # holds yet, so an export never replaces a file and never shows half
    # written (the export folder may be inside the output store, whose files
    # the spending check measures: services/input_sizes.py). On a drive with
    # no hard links (exFAT, FAT) link_new copies it in exclusively instead.
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    dest = dest_dir / filename
    counter = 1
    try:
        partial = require_allowed_path(dest_dir / f".{filename}.{uuid4().hex}.part")
        _shutil.copy2(require_allowed_path(src), partial)
        try:
            while True:
                try:
                    link_new(partial, require_allowed_path(dest))
                    break
                except FileExistsError:
                    dest = dest_dir / f"{stem} -{counter}{suffix}"
                    counter += 1
        finally:
            partial.unlink(missing_ok=True)
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
        # What the run said about this output (models/events.py add_run_note),
        # e.g. the size a maker made when it couldn't make the one asked for.
        "notes": [note for note in record.get("notes") or [] if isinstance(note, str)],
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


# Thumbnails for the zoomed-out canvas (?thumb=1), made once and kept here.
_THUMBNAIL_DIR = _STATE_DIR / "thumbnails"


@app.get("/api/outputs/{rel:path}")
async def serve_output(rel: str, thumb: bool = False):
    roots = [OUTPUT_ROOT] + ([DEFAULT_OUTPUT_ROOT] if DEFAULT_OUTPUT_ROOT != OUTPUT_ROOT else [])
    for root in roots:
        try:
            candidate = require_allowed_path(root / rel)
            candidate.relative_to(root.resolve())  # containment — block ../ traversal
        except (ValueError, OSError):
            continue
        if candidate.is_file():
            headers = {"X-Content-Type-Options": "nosniff"}
            if thumb:
                # A small still of an image or video; the canvas falls back to
                # the file itself when there is none.
                try:
                    small = await output_thumbnail.thumbnail(candidate, _THUMBNAIL_DIR)
                except output_thumbnail.ThumbnailUnavailable as exc:
                    raise HTTPException(status_code=415, detail=str(exc)) from exc
                return FileResponse(small, headers=headers)
            if candidate.suffix.lower() in _ACTIVE_OUTPUT_SUFFIXES:
                headers["Content-Security-Policy"] = _ACTIVE_OUTPUT_CSP
            return FileResponse(candidate, headers=headers)
    raise HTTPException(status_code=404, detail="output not found")

# Seed starter presets on first boot. seed_presets_if_empty() is defined above
# and is idempotent + wrapped in try/except so it can never break startup.
seed_presets_if_empty()
# Backfill thumbnail URLs on every boot (idempotent, only touches seeded presets).
backfill_preset_thumbnails()
