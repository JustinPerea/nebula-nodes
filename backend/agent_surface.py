"""Every way into Nebula, and how an agent gets the same thing over MCP.

Justin, 2026-10-20: "Every feature we add needs to make sure we include MCP
support for agents." This manifest is how a feature can't ship without it.
tests/test_agent_surface.py fails when something the person can reach (an
HTTP route or websocket, a `nebula` CLI command or option, a broadcast or
journal event, an internal "_" node param, a canvas store action) has no row
here, when a row is stale, or when a row doesn't match the code (a tool that
doesn't exist, a person-only route an agent can get through).
frontend/scripts/check-agent-surface.mjs does the same for the canvas (its
/api calls, graphStore actions and "_" params) from data/agent_surface.json.

Each row is one of:

- ``Tool(name)``: an agent does this with MCP tool ``name``, which calls this
  route (``via``: the route the tool calls instead, for the same feature).
- ``ReadOnly(name)``: a read, and the read-only MCP tool ``name`` gives it.
- ``Propose(name)``: the person's call; an agent asks through ``name`` and the
  route itself is person-gated.
- ``PersonOnly(reason, view=None)``: the person's alone (spend, keys, auth,
  the person token, deleting for good). The route must show a person gate the
  test can see; ``view`` is the read-only tool that shows agents the state.
- ``Exempt(reason)``: not something an agent does; ``reason`` from EXEMPT_REASONS.
- ``Gap(issue)``: no agent path yet. ``issue`` is the audit unit (U1-U16) or
  open question (Q1-Q11) of 2026-10-20. Only keys in GAPS_2026_10_20 may be a
  Gap, and that set may only shrink: a new feature gets a real row.

``partial`` on Tool/ReadOnly/Journal marks a row whose agent path is missing
part of what the UI does (that key is in GAPS_2026_10_20 too).

Keep one row per line and every table sorted, so parallel PRs touch
different lines. To see what's unmapped:

    cd backend && .venv/bin/python agent_surface_check.py
    cd backend && .venv/bin/python agent_surface_check.py --write   # after editing rows
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

# Why something needs no agent path. Keep this set closed: a new reason is a
# product decision, not a way past the guard.
EXEMPT_REASONS = frozenset({
    "browser-state",    # the person's tab reporting itself (viewport, selection, drafts, telemetry)
    "client-side",      # CLI: the client reads or writes a local file around the same call
    "desktop-only",     # brings an OS app or Finder to the front
    "health",           # liveness and capability probes
    "in-app-chat",      # the in-app chat panel's own plumbing (status, model lists)
    "maintenance",      # housekeeping the person runs, or legacy data the backend migrates
    "mcp-internal",     # the MCP server's and CLI's own plumbing (address proof, workspace scope)
    "presentation",     # CLI: output format only (--json, --quiet, --as)
    "server-computed",  # a value the server writes itself, never sent by a client
    "static",           # serves bytes the canvas displays (outputs, thumbnails)
    "transport",        # sockets and feeds that carry other features
})

# CLI options that only change how the result prints. Accepted on any command.
PRESENTATION_ARGS = frozenset({"agent_name", "json", "once", "quiet"})


@dataclass(frozen=True)
class Tool:
    name: str
    also: tuple[str, ...] = ()
    via: str = ""
    args: dict[str, Any] = field(default_factory=dict, compare=False, hash=False)
    partial: str = ""


@dataclass(frozen=True)
class ReadOnly:
    name: str
    via: str = ""
    partial: str = ""


@dataclass(frozen=True)
class Propose:
    name: str


@dataclass(frozen=True)
class PersonOnly:
    reason: str
    view: str | None = None


@dataclass(frozen=True)
class Exempt:
    reason: str
    note: str = ""


@dataclass(frozen=True)
class Gap:
    issue: str


@dataclass(frozen=True)
class Journal:
    """EVENTS only: agents see this broadcast as these journal kinds
    (space-separated; ``group.*`` for every kind in a group)."""
    kinds: str
    partial: str = ""


def row_dict(value: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": type(value).__name__}
    for key, item in asdict(value).items():
        if key == "args":
            item = {arg: row_dict(v) if not isinstance(v, str) else v for arg, v in value.args.items()}
        if item not in ("", (), [], {}, None):
            out[key] = list(item) if isinstance(item, tuple) else item
    return out


# Every HTTP route ("METHOD /path") and websocket ("WS /path") main.app serves.
ROUTES: dict[str, Any] = {
    "DELETE /api/agent/spend/apps/{app_id}": PersonOnly("app tokens and spending limits are the person's", view="get_spend_limits"),
    "DELETE /api/canvas/approvals/{approval_id}": PersonOnly("releases a paid run the person approved"),
    "DELETE /api/canvas/pins/{pin_id}": PersonOnly("pins are the person's notes to agents", view="look_at_canvas"),
    "DELETE /api/canvas/proposals/{proposal_id}": Tool("withdraw_proposal"),
    "DELETE /api/characters/{char_id}": Gap("U2"),
    "DELETE /api/commons/assets/{asset_id}": PersonOnly("deleting a reference for good"),
    "DELETE /api/execution-cancellations/{run_id}": Exempt("maintenance", "compacts Stop tombstones"),
    "DELETE /api/executions/{run_id}": Tool("cancel_run"),
    "DELETE /api/graph": Gap("Q6"),
    "DELETE /api/graph/edge": Tool("remove_from_canvas", via="POST /api/graph/apply"),
    "DELETE /api/graph/node/{node_id}": Tool("remove_from_canvas", via="POST /api/graph/apply"),
    "DELETE /api/krea/connection": PersonOnly("the Krea account is the person's to connect or drop"),
    "DELETE /api/moodboards/{moodboard_id}": Tool("moodboard_delete"),
    "DELETE /api/personal-agents/{agent_id}": PersonOnly("which agents run in the app is the person's"),
    "DELETE /api/presets/{preset_id}": Gap("Q1"),
    "DELETE /api/projects/trash/{project_id}": PersonOnly("deleting a project for good", view="list_trash"),
    "DELETE /api/projects/{project_id}": Gap("U3"),
    "DELETE /api/provider-recoveries/{run_id}/{node_id}": Gap("Q2"),
    "DELETE /api/provider-start-ambiguities/{kind}/{node_id}/{run_id}": Gap("Q2"),
    "DELETE /api/render-jobs/{job_id}": Gap("U9"),
    "DELETE /api/settings/api-keys/{provider}": PersonOnly("provider keys are the person's"),
    "DELETE /api/trash/{kind}/{item_id}": PersonOnly("deleting for good", view="list_trash"),
    "GET /api/agent/address-proof": Exempt("mcp-internal", "a client checks the backend before sending its token"),
    "GET /api/agent/context": Exempt("mcp-internal", "the agent's workspace scope"),
    "GET /api/agent/nodes": ReadOnly("find_nodes"),
    "GET /api/agent/nodes/{definition_id}": ReadOnly("describe_node"),
    "GET /api/agent/spend": ReadOnly("get_spend_limits"),
    "GET /api/agent/spend/apps": PersonOnly("other apps' tokens and spend are the person's", view="get_spend_limits"),
    "GET /api/agents/claude/status": Exempt("in-app-chat"),
    "GET /api/agents/codex/login/chatgpt": Exempt("in-app-chat"),
    "GET /api/agents/codex/status": Exempt("in-app-chat"),
    "GET /api/agents/{agent}/models": Exempt("in-app-chat", "the chat picker's model list"),
    "GET /api/canvas/events": ReadOnly("wait_for_canvas_change", partial="U6"),
    "GET /api/canvas/pins": ReadOnly("look_at_canvas", via="GET /api/canvas/snapshot"),
    "GET /api/canvas/proposals": ReadOnly("look_at_canvas", via="GET /api/canvas/snapshot"),
    "GET /api/canvas/proposals/{proposal_id}": ReadOnly("get_proposal"),
    "GET /api/canvas/selection": ReadOnly("get_selected_nodes"),
    "GET /api/canvas/snapshot": ReadOnly("look_at_canvas"),
    "GET /api/capabilities/commons": Tool("commons_add"),
    "GET /api/capabilities/worldlabs": Exempt("health", "World Labs support, no credentials"),
    "GET /api/characters": Gap("U2"),
    "GET /api/characters/{char_id}": Gap("U2"),
    "GET /api/commons/assets/{asset_id}": ReadOnly("commons_get"),
    "GET /api/commons/blobs/{blob_key}": ReadOnly("commons_get"),
    "GET /api/commons/borrowings": Gap("U13"),
    "GET /api/commons/collections": Gap("U13"),
    "GET /api/commons/concentration": Gap("U13"),
    "GET /api/commons/evaluation": PersonOnly("evaluation stays human-only"),
    "GET /api/commons/evaluation/items/{position}/image": PersonOnly("evaluation stays human-only"),
    "GET /api/commons/export": PersonOnly("the whole library leaves the app"),
    "GET /api/commons/folders": PersonOnly("linked folders are the person's"),
    "GET /api/commons/review": PersonOnly("review stays human-only"),
    "GET /api/commons/settings": PersonOnly("commons settings are the person's"),
    "GET /api/commons/status": Gap("U13"),
    "GET /api/commons/vocabulary/candidates": PersonOnly("vocabulary curation is the person's (Q10)"),
    "GET /api/convert-to-glb": Exempt("static", "converts a 3D output for the viewer"),
    "GET /api/execution-cancellations": Exempt("maintenance", "Stop tombstones"),
    "GET /api/executions/{run_id}": Gap("U6"),
    "GET /api/fal/health": Exempt("health"),
    "GET /api/graph": ReadOnly("view_output"),
    "GET /api/graph/export": Gap("U6"),
    "GET /api/graph/node/{node_id}/path": Gap("U4"),
    "GET /api/graph/node/{node_id}/preview": ReadOnly("view_output"),
    "GET /api/graph/runs/{run_id}": ReadOnly("get_run", partial="U6"),
    "GET /api/health": Exempt("health"),
    "GET /api/health/providers": Gap("U6"),
    "GET /api/krea/connection": Gap("U6"),
    "GET /api/krea/plans": Gap("U6"),
    "GET /api/krea/tools": Gap("U14"),
    "GET /api/moodboards": ReadOnly("moodboard_list"),
    "GET /api/moodboards/{moodboard_id}": ReadOnly("moodboard_get"),
    "GET /api/nodes": ReadOnly("find_nodes", via="GET /api/agent/nodes"),
    "GET /api/nodes/{node_id}": ReadOnly("describe_node", via="GET /api/agent/nodes/{definition_id}"),
    "GET /api/nous/models": Gap("U10"),
    "GET /api/openrouter/models": Gap("U10"),
    "GET /api/outputs/{rel:path}": Exempt("static", "agents see outputs through view_output"),
    "GET /api/outputs/{rel:path}/meta": Gap("U4"),
    "GET /api/paper/files": Gap("U11"),
    "GET /api/paper/files/{file_id}": Gap("U11"),
    "GET /api/paper/object": Gap("U11"),
    "GET /api/paper/selection": Gap("U11"),
    "GET /api/paper/snapshots/{snapshot_id}": Gap("U11"),
    "GET /api/paper/sources/{source_id}": Gap("U11"),
    "GET /api/personal-agents": PersonOnly("which agents run in the app is the person's"),
    "GET /api/presets": Gap("U5"),
    "GET /api/presets/thumbnails/{slug}": Exempt("static"),
    "GET /api/presets/{preset_id}": Gap("U5"),
    "GET /api/pricing": ReadOnly("describe_node", via="GET /api/agent/nodes/{definition_id}"),
    "GET /api/project": ReadOnly("list_projects", via="GET /api/projects"),
    "GET /api/projects": ReadOnly("list_projects"),
    "GET /api/projects/{project_id}": Gap("U3"),
    "GET /api/projects/{project_id}/covers": Gap("Q8"),
    "GET /api/quiver/models": Gap("U10"),
    "GET /api/render-jobs/{job_id}": Gap("U9"),
    "GET /api/replicate/schema/{owner}/{name}": Gap("U10"),
    "GET /api/settings": Gap("U6+Q3"),
    "GET /api/trash": ReadOnly("list_trash", partial="U6"),
    "PATCH /api/commons/collections/{collection_id}": PersonOnly("collections are the person's"),
    "PATCH /api/commons/folders/{link_id}": PersonOnly("linked folders are the person's"),
    "PATCH /api/commons/memberships/{membership_id}": PersonOnly("membership curation is the person's (Q10)"),
    "PATCH /api/commons/regions/{region_id}": PersonOnly("region curation is the person's (Q10)"),
    "PATCH /api/commons/settings": PersonOnly("commons settings are the person's"),
    "POST /api/agent/spend/apps": PersonOnly("app tokens and spending limits are the person's", view="get_spend_limits"),
    "POST /api/agents/codex/login/chatgpt": PersonOnly("signs Codex in with the person's account"),
    "POST /api/canvas/cursor": Tool("point_at"),
    "POST /api/canvas/pins": PersonOnly("pins are the person's notes to agents", view="look_at_canvas"),
    "POST /api/canvas/pins/{pin_id}/resolve": Tool("resolve_pin"),
    "POST /api/canvas/proposals": Tool("propose_change"),
    "POST /api/canvas/proposals/{proposal_id}/accept": Propose("propose_change"),
    "POST /api/canvas/proposals/{proposal_id}/reject": Propose("propose_change"),
    "POST /api/canvas/selection": Exempt("browser-state", "the tab publishes its selection; agents read it"),
    "POST /api/canvas/view": Exempt("browser-state", "the tab reports its viewport"),
    "POST /api/characters": Gap("U2"),
    "POST /api/characters/{char_id}/move": Tool("character_move"),
    "POST /api/cinema/generate-shot": Gap("U8"),
    "POST /api/cinema/promote-shot-variation": Gap("U8"),
    "POST /api/cinema/send-to-motion": Gap("U8"),
    "POST /api/commons/add": Tool("commons_add"),
    "POST /api/commons/add/upload": Tool("commons_add"),
    "POST /api/commons/assets/{asset_id}/corrections": PersonOnly("corrections are the person's (Q10)"),
    "POST /api/commons/assets/{asset_id}/reanalyze": PersonOnly("reanalysis is the person's"),
    "POST /api/commons/assets/{asset_id}/regions": PersonOnly("region curation is the person's (Q10)"),
    "POST /api/commons/borrow": Tool("commons_borrow"),
    "POST /api/commons/borrowings/{borrowing_id}/fidelity": Gap("U13"),
    "POST /api/commons/collections": PersonOnly("collections are the person's"),
    "POST /api/commons/comments": Tool("commons_comment", partial="U13"),
    "POST /api/commons/evaluation/close": PersonOnly("evaluation stays human-only"),
    "POST /api/commons/evaluation/items/{position}/accents": PersonOnly("evaluation stays human-only"),
    "POST /api/commons/evaluation/prepare": PersonOnly("evaluation stays human-only"),
    "POST /api/commons/evaluation/seal": PersonOnly("evaluation stays human-only"),
    "POST /api/commons/folders": PersonOnly("linked folders are the person's"),
    "POST /api/commons/folders/{link_id}/rescan": PersonOnly("linked folders are the person's"),
    "POST /api/commons/intake/files": PersonOnly("intake is the person's"),
    "POST /api/commons/intake/moodboards": PersonOnly("intake is the person's"),
    "POST /api/commons/intake/url": PersonOnly("intake is the person's"),
    "POST /api/commons/memberships/{membership_id}/accept": PersonOnly("membership curation is the person's (Q10)"),
    "POST /api/commons/reanalyze-stale": PersonOnly("reanalysis is the person's"),
    "POST /api/commons/review/items/{position}/propose": PersonOnly("review stays human-only"),
    "POST /api/commons/search": ReadOnly("commons_search"),
    "POST /api/commons/worker/start": PersonOnly("the analysis worker is the person's"),
    "POST /api/commons/worker/stop": PersonOnly("the analysis worker is the person's"),
    "POST /api/credentials/update": PersonOnly("provider keys are the person's"),
    "POST /api/enhance-prompt": PersonOnly("spends the person's keys with no list price; agents rewrite prompts themselves"),
    "POST /api/execute": Tool("run_nodes", via="POST /api/graph/run", partial="U8"),
    "POST /api/execute-node": Tool("run_nodes", via="POST /api/graph/run", partial="U8"),
    "POST /api/export": Gap("U4"),
    "POST /api/graph/apply": Tool("edit_canvas", also=("remove_from_canvas",), partial="U1"),
    "POST /api/graph/cluster": Tool("edit_canvas", via="POST /api/graph/apply"),
    "POST /api/graph/connect": Tool("edit_canvas", via="POST /api/graph/apply"),
    "POST /api/graph/import": Gap("Q7"),
    "POST /api/graph/node": Tool("edit_canvas", via="POST /api/graph/apply"),
    "POST /api/graph/node-and-connect": Tool("edit_canvas", via="POST /api/graph/apply"),
    "POST /api/graph/restore": Gap("U1"),
    "POST /api/graph/run": Tool("run_nodes", partial="U8"),
    "POST /api/krea/connection/check": PersonOnly("the Krea account is the person's to connect or drop"),
    "POST /api/krea/connection/connect": PersonOnly("the Krea account is the person's to connect or drop"),
    "POST /api/krea/tools/call": Gap("U14"),
    "POST /api/krea/trial": PersonOnly("starts a payment checkout"),
    "POST /api/moodboards": Tool("moodboard_create"),
    "POST /api/moodboards/{moodboard_id}/analyze": Tool("moodboard_analyze"),
    "POST /api/moodboards/{moodboard_id}/analyze/dry-run": Tool("moodboard_analyze"),
    "POST /api/moodboards/{moodboard_id}/brief-override/keep": Tool("moodboard_update"),
    "POST /api/moodboards/{moodboard_id}/edits": Tool("moodboard_update", also=("moodboard_add",), partial="U7"),
    "POST /api/moodboards/{moodboard_id}/move": Tool("moodboard_move"),
    "POST /api/moodboards/{moodboard_id}/read": Tool("moodboard_analyze"),
    "POST /api/moodboards/{moodboard_id}/read/estimate": Tool("moodboard_analyze"),
    "POST /api/outputs/archive": Exempt("maintenance", "moves old output folders aside"),
    "POST /api/outputs/restore": Gap("Q7"),
    "POST /api/paper/sources": Gap("U11"),
    "POST /api/paper/sources/{source_id}/open": Exempt("desktop-only", "brings Paper to the front"),
    "POST /api/paper/sources/{source_id}/reconnect": Gap("U11"),
    "POST /api/paper/sources/{source_id}/refresh": Gap("U11"),
    "POST /api/personal-agents": PersonOnly("which agents run in the app is the person's"),
    "POST /api/personal-agents/acknowledge-warning": PersonOnly("the person read the notice"),
    "POST /api/presets": Gap("U5"),
    "POST /api/projects": Tool("new_project"),
    "POST /api/projects/recover": Exempt("browser-state", "a stale tab saves its copy"),
    "POST /api/projects/trash/empty": PersonOnly("deleting projects for good", view="list_trash"),
    "POST /api/projects/{project_id}/open": Tool("open_project"),
    "POST /api/projects/{project_id}/restore": Tool("restore_from_trash", via="POST /api/trash/{kind}/{item_id}/restore"),
    "POST /api/quick": Gap("U8"),
    "POST /api/remotion-render": Gap("U9"),
    "POST /api/reveal": Exempt("desktop-only", "shows a file in Finder"),
    "POST /api/transcode-image": Gap("U4"),
    "POST /api/trash/empty": PersonOnly("deleting for good", view="list_trash"),
    "POST /api/trash/{kind}/{item_id}/restore": Tool("restore_from_trash"),
    "POST /api/uploads": Tool("moodboard_create", also=("moodboard_add",), partial="U4"),
    "POST /api/video-edit/export": Gap("U9"),
    "POST /api/video-edit/preview-render": Gap("U9"),
    "POST /api/zoom-manifest/entry": Exempt("browser-state", "demo-video telemetry from the tab"),
    "POST /api/zoom-manifest/init": Exempt("browser-state", "demo-video telemetry from the tab"),
    "PUT /api/agent/spend/apps/{app_id}": PersonOnly("app tokens and spending limits are the person's", view="get_spend_limits"),
    "PUT /api/characters/{char_id}": Gap("U2"),
    "PUT /api/commons/evaluation/items/{position}/labels": PersonOnly("evaluation stays human-only"),
    "PUT /api/commons/review/items/{position}": PersonOnly("review stays human-only"),
    "PUT /api/graph/layout": Tool("edit_canvas", via="POST /api/graph/apply", partial="U15"),
    "PUT /api/graph/node/{node_id}": Tool("edit_canvas", via="POST /api/graph/apply"),
    "PUT /api/graph/node/{node_id}/label": Tool("edit_canvas", via="POST /api/graph/apply"),
    "PUT /api/moodboards/{moodboard_id}": Tool("moodboard_update"),
    "PUT /api/personal-agents/{agent_id}": PersonOnly("which agents run in the app is the person's"),
    "PUT /api/presets/{preset_id}": Gap("U5"),
    "PUT /api/projects/{project_id}": Gap("U3"),
    "PUT /api/projects/{project_id}/cover": PersonOnly("the person's pin (Q8 open)"),
    "PUT /api/settings": PersonOnly("Settings are the person's"),
    "WS /ws": Exempt("transport", "the canvas socket; agents read the same changes from the journal"),
    "WS /ws/chat": Exempt("transport", "the in-app chat's own channel"),
}

# Every `nebula` leaf command. ``args`` maps an option's argparse dest to the
# tool argument it becomes when the names differ, or to Exempt/Gap.
CLI: dict[str, Any] = {
    "nebula apply": Tool("edit_canvas", args={"add": "nodes", "at": "nodes", "file": Gap("U1"), "param": "nodes", "remove": Gap("U1"), "set_params": "params", "unwire": Gap("U1"), "wire": "edges"}),
    "nebula cancel": Tool("cancel_run"),
    "nebula character move": Tool("character_move"),
    "nebula clear": Gap("Q6"),
    "nebula commons add": Tool("commons_add"),
    "nebula commons borrow": Tool("commons_borrow", args={"region": "region_id"}),
    "nebula commons comment": Tool("commons_comment", args={"region": "region_id"}),
    "nebula commons fetch": Tool("commons_get", args={"out": Exempt("client-side")}),
    "nebula commons get": Tool("commons_get"),
    "nebula commons search": Tool("commons_search"),
    "nebula commons status": Gap("U13"),
    "nebula connect": Tool("edit_canvas", args={"dst": "edges", "src": "edges"}),
    "nebula context": Tool("find_nodes"),
    "nebula create": Tool("edit_canvas", args={"node_id": "nodes", "param": "nodes"}),
    "nebula delete": Tool("remove_from_canvas", args={"node_refs": "node_ids"}),
    "nebula disconnect": Tool("remove_from_canvas", args={"dst": "wires", "src": "wires"}),
    "nebula graph": Tool("look_at_canvas"),
    "nebula info": Tool("describe_node", args={"node_id": "definition_id"}),
    "nebula keys": Gap("U6"),
    "nebula load": Gap("Q7"),
    "nebula look": Tool("look_at_canvas"),
    "nebula mcp connect": PersonOnly("gives an app the person's token"),
    "nebula mcp disconnect": PersonOnly("changes the person's app config"),
    "nebula moodboard add": Tool("moodboard_add"),
    "nebula moodboard analyze": Tool("moodboard_analyze", args={"estimate": "estimate_only"}),
    "nebula moodboard delete": Tool("moodboard_delete"),
    "nebula moodboard list": Tool("moodboard_list", args={"global_only": "project_id", "project": "project_id"}),
    "nebula moodboard move": Tool("moodboard_move"),
    "nebula moodboard new": Tool("moodboard_create", args={"project": "project_id"}),
    "nebula moodboard set": Tool("moodboard_update", args={"avoid": "avoid_add", "brief": "brief_override", "clear_avoid": "avoid", "clear_brief": "brief_override", "image_note": "images", "keep_out_color": "keep_out_colors", "pin_color": "pin_colors", "private_note": "images", "reset_color": "reset_colors", "restore": "undo", "set_aside": "images", "unavoid": "avoid_remove", "unpin_color": "unpin_colors", "use": "images", "weight": "images"}),
    "nebula moodboard show": Tool("moodboard_get"),
    "nebula move": Tool("edit_canvas", args={"moves": "move"}),
    "nebula nodes": Tool("find_nodes"),
    "nebula path": Gap("U4"),
    "nebula pin resolve": Tool("resolve_pin", args={"say": "reply"}),
    "nebula pins": Tool("look_at_canvas"),
    "nebula point": Tool("point_at", args={"origin": "from_node_id", "target": "node_id"}),
    "nebula project new": Tool("new_project"),
    "nebula project open": Tool("open_project"),
    "nebula projects": Tool("list_projects"),
    "nebula proposal": Tool("get_proposal", also=("withdraw_proposal",), args={"id_or_action": "proposal_id", "timeout": "wait_seconds", "wait": "wait_seconds"}),
    "nebula proposals": Tool("look_at_canvas"),
    "nebula propose": Tool("propose_change", also=("get_proposal",), args={"add": "nodes", "at": "nodes", "file": Exempt("client-side"), "param": "nodes", "set_params": "params", "timeout": "wait_seconds", "wait": "wait_seconds", "wire": "edges"}),
    "nebula quick": Gap("U8"),
    "nebula rename": Tool("edit_canvas", args={"label": "rename", "node_ref": "rename"}),
    "nebula result": Tool("get_run", args={"wait": "wait_seconds"}),
    "nebula run": Tool("run_nodes", args={"node_ref": "node_id", "wait": "wait_seconds"}),
    "nebula run-all": Tool("run_nodes", args={"wait": "wait_seconds"}),
    "nebula save": Tool("look_at_canvas", args={"file": Exempt("client-side")}),
    "nebula selection": Tool("get_selected_nodes"),
    "nebula set": Tool("edit_canvas", args={"node_ref": "params"}),
    "nebula skill install": Exempt("mcp-internal", "installs the nebula skill into agent apps"),
    "nebula spend": Tool("get_spend_limits"),
    "nebula status": Tool("look_at_canvas"),
    "nebula trash list": Tool("list_trash"),
    "nebula trash restore": Tool("restore_from_trash", args={"target": "id"}),
    "nebula watch": Tool("wait_for_canvas_change", args={"journal": Gap("U6"), "timeout": "timeout_seconds"}),
}

# Journal kinds ("kind <kind>", services/canvas_events.py EVENT_KINDS) and the
# message types sent on /ws ("ws <type>"): broadcasts and the handler's own replies.
EVENTS: dict[str, Any] = {
    "kind board.added": ReadOnly("wait_for_canvas_change"),
    "kind board.arranged": ReadOnly("wait_for_canvas_change"),
    "kind board.frame": ReadOnly("wait_for_canvas_change"),
    "kind board.grouped": ReadOnly("wait_for_canvas_change"),
    "kind board.moved": ReadOnly("wait_for_canvas_change"),
    "kind board.noted": ReadOnly("wait_for_canvas_change"),
    "kind board.removed": ReadOnly("wait_for_canvas_change"),
    "kind board.resized": ReadOnly("wait_for_canvas_change"),
    "kind board.setAside": ReadOnly("wait_for_canvas_change"),
    "kind board.sorted": ReadOnly("wait_for_canvas_change"),
    "kind board.suggested": ReadOnly("wait_for_canvas_change"),
    "kind canvas.cleared": ReadOnly("wait_for_canvas_change"),
    "kind canvas.replaced": ReadOnly("wait_for_canvas_change"),
    "kind edge.added": ReadOnly("wait_for_canvas_change"),
    "kind edge.removed": ReadOnly("wait_for_canvas_change"),
    "kind node.added": ReadOnly("wait_for_canvas_change"),
    "kind node.moved": ReadOnly("wait_for_canvas_change"),
    "kind node.params": ReadOnly("wait_for_canvas_change"),
    "kind node.removed": ReadOnly("wait_for_canvas_change"),
    "kind node.renamed": ReadOnly("wait_for_canvas_change"),
    "kind pin.added": ReadOnly("wait_for_canvas_change"),
    "kind pin.detached": ReadOnly("wait_for_canvas_change"),
    "kind pin.removed": ReadOnly("wait_for_canvas_change"),
    "kind pin.resolved": ReadOnly("wait_for_canvas_change"),
    "kind proposal.accepted": ReadOnly("wait_for_canvas_change"),
    "kind proposal.created": ReadOnly("wait_for_canvas_change"),
    "kind proposal.expired": ReadOnly("wait_for_canvas_change"),
    "kind proposal.invalidated": ReadOnly("wait_for_canvas_change"),
    "kind proposal.rejected": ReadOnly("wait_for_canvas_change"),
    "kind proposal.withdrawn": ReadOnly("wait_for_canvas_change"),
    "kind run.cancelled": ReadOnly("wait_for_canvas_change"),
    "kind run.failed": ReadOnly("wait_for_canvas_change"),
    "kind run.finished": ReadOnly("wait_for_canvas_change"),
    "kind run.skipped": ReadOnly("wait_for_canvas_change"),
    "kind run.started": ReadOnly("wait_for_canvas_change"),
    "kind selection.changed": ReadOnly("wait_for_canvas_change"),
    "ws agentPresence": ReadOnly("look_at_canvas"),
    "ws canvasPins": Journal("pin.*"),
    "ws error": Journal("run.failed"),
    "ws executed": Journal("run.finished"),
    "ws executing": Journal("run.started"),
    "ws executionStatus": ReadOnly("get_run", partial="U6"),
    "ws graphSync": Journal("node.* edge.* canvas.*"),
    "ws graph_cancelled": Journal("run.cancelled"),
    "ws graph_complete": ReadOnly("get_run"),
    "ws personRequired": Exempt("transport", "the socket's answer to a hello without the person token"),
    "ws progress": Gap("U6"),
    "ws projectsChanged": Gap("U3"),
    "ws proposalClosed": Journal("proposal.*"),
    "ws proposalOpened": Journal("proposal.created"),
    "ws proposalSync": ReadOnly("look_at_canvas"),
    "ws provider_recovery": Gap("U6"),
    "ws provider_start_ambiguous": Gap("U6"),
    "ws queued": ReadOnly("get_run"),
    "ws skipped": Journal("run.skipped"),
    "ws storedAssetChanged": Journal("board.*", partial="U2"),
    "ws stream_delta": Gap("U6"),
    "ws stream_partial_image": Gap("U6"),
    "ws stream_partial_svg": Gap("U6"),
    "ws validation_error": ReadOnly("get_run"),
}

# "_" node params: the backend reads them (agent_surface_check.backend_internal_params)
# or the canvas writes them (check-agent-surface.mjs). Agents can't send "_"
# params (main._refuse_agent_internal_params), so each needs its own path.
INTERNAL_PARAMS: dict[str, Any] = {
    "_characterId": Exempt("maintenance", "legacy id key; retired_nodes.migrate_params moves it"),
    "_kreaAuth": Propose("propose_change"),
    "_kreaConnectionRevision": Exempt("server-computed", "a run's cache key, not a node param"),
    "_maskData": Gap("U12"),
    "_meshy_task": Exempt("server-computed", "the Meshy route adapter sets it for its own handler"),
    "_moodboardId": Exempt("maintenance", "legacy id key; retired_nodes.migrate_params moves it"),
    "_output_image": Gap("U10"),
    "_paperSource": Gap("U11"),
    "_previewUrl": Gap("U4"),
    "_provider": Propose("propose_change"),
    "_route": Exempt("server-computed", "a run's cache key, not a node param"),
    "_schema_fetched": Gap("U10"),
    "_sourceDuration": Gap("U4"),
    "_sourceFps": Gap("U4"),
    "_sourceIsVfr": Gap("U4"),
    "_variant": Gap("U15"),
    "_version_id": Gap("U10"),
}

# "_" names the canvas uses that are not node params (check-agent-surface.mjs).
FRONTEND_NOT_PARAMS: dict[str, str] = {
    "_blank": "window.open target",
    "_createOrigin": "node.data tag for the Create view, never a param",
}

# Members of the GraphState interface in frontend/src/store/graphStore.ts.
FRONTEND_ACTIONS: dict[str, Any] = {
    "graphStore.acknowledgeProviderStartAmbiguity": Gap("Q2"),
    "graphStore.acknowledgeUncertainWorldLabsRun": Gap("Q2"),
    "graphStore.activeRuns": ReadOnly("look_at_canvas"),
    "graphStore.addCharacterNode": Tool("edit_canvas"),
    "graphStore.addDynamicNode": Gap("U10"),
    "graphStore.addLocalCinemaMotionNode": Tool("edit_canvas"),
    "graphStore.addMoodboardNode": Tool("edit_canvas"),
    "graphStore.addNode": Tool("edit_canvas"),
    "graphStore.addNodeAndConnect": Tool("edit_canvas"),
    "graphStore.addOrUpdateKeyframe": Tool("edit_canvas"),
    "graphStore.addShot": Tool("edit_canvas"),
    "graphStore.addTrackItemWithCanvasMirror": Tool("edit_canvas"),
    "graphStore.adoptAcceptedProposal": Propose("propose_change"),
    "graphStore.applyPaperSource": Gap("U11"),
    "graphStore.authorGenerationCluster": Tool("edit_canvas"),
    "graphStore.autoLayout": Gap("U15"),
    "graphStore.autoLayoutSelected": Gap("U15"),
    "graphStore.backendFreshStartPending": Exempt("browser-state"),
    "graphStore.beginUndoStep": Gap("U1"),
    "graphStore.canSwitchProject": Exempt("browser-state"),
    "graphStore.cancelCreateGeneration": Tool("cancel_run"),
    "graphStore.cancelExecution": Tool("cancel_run"),
    "graphStore.cancelRun": Tool("cancel_run"),
    "graphStore.cancelUndoStep": Gap("U1"),
    "graphStore.clearGraph": Gap("Q6"),
    "graphStore.clearRunHistory": Gap("U15"),
    "graphStore.clipboard": Exempt("browser-state"),
    "graphStore.configureOpenRouterModel": Gap("U10"),
    "graphStore.copySelected": Exempt("browser-state"),
    "graphStore.createCancelledLaunchIds": Exempt("browser-state"),
    "graphStore.createLaunchingIds": Exempt("browser-state"),
    "graphStore.cutEditNodeAtSource": Gap("U15"),
    "graphStore.deleteGeneration": Tool("remove_from_canvas"),
    "graphStore.deleteKeyframe": Tool("edit_canvas"),
    "graphStore.deleteNode": Tool("remove_from_canvas"),
    "graphStore.deleteProviderRecovery": Gap("Q2"),
    "graphStore.deleteSelected": Tool("remove_from_canvas"),
    "graphStore.deleteTrackItem": Tool("edit_canvas"),
    "graphStore.dismissProviderRecoveryWarning": Exempt("browser-state"),
    "graphStore.dismissUndoNotice": Exempt("browser-state"),
    "graphStore.duplicateNode": Gap("U15"),
    "graphStore.duplicateSelected": Gap("U15"),
    "graphStore.duplicateTrackItemAtPlayhead": Tool("edit_canvas"),
    "graphStore.edges": ReadOnly("look_at_canvas"),
    "graphStore.executeCluster": Gap("U8"),
    "graphStore.executeClusterConcurrent": Gap("U8"),
    "graphStore.executeGraph": Tool("run_nodes"),
    "graphStore.executeNode": Tool("run_nodes"),
    "graphStore.executeShot": Gap("U8"),
    "graphStore.fetchReplicateSchemaAndConfigure": Gap("U10"),
    "graphStore.getOrCreateEditNodeDownstream": Gap("U15"),
    "graphStore.handleExecutionEvent": Exempt("transport"),
    "graphStore.hydrateExecutionStatuses": Exempt("transport"),
    "graphStore.hydrateProviderRecoveries": Exempt("transport"),
    "graphStore.hydrateProviderStartAmbiguities": Exempt("transport"),
    "graphStore.isCancelling": Exempt("browser-state"),
    "graphStore.isExecuting": Exempt("browser-state"),
    "graphStore.isImportingGraph": Exempt("browser-state"),
    "graphStore.isShotAdmissionBlocked": Exempt("browser-state"),
    "graphStore.loadGraph": Gap("Q7"),
    "graphStore.loadProjectGraph": Tool("open_project"),
    "graphStore.loadSampleGraph": Gap("Q7"),
    "graphStore.nodes": ReadOnly("look_at_canvas"),
    "graphStore.onConnect": Tool("edit_canvas"),
    "graphStore.onEdgesChange": Tool("remove_from_canvas"),
    "graphStore.onNodesChange": Tool("edit_canvas"),
    "graphStore.pasteClipboard": Gap("U15"),
    "graphStore.promoteShotVariation": Gap("U8"),
    "graphStore.providerRecoveries": Gap("U6"),
    "graphStore.providerRecoveryWarning": Gap("U6"),
    "graphStore.providerStartAmbiguities": Gap("U6"),
    "graphStore.reconcilePersistedWorldLabsRun": Exempt("browser-state"),
    "graphStore.redo": Gap("U1"),
    "graphStore.redoStack": Gap("U1"),
    "graphStore.releaseCreateGeneration": Exempt("browser-state"),
    "graphStore.releaseGraphImport": Exempt("browser-state"),
    "graphStore.removeEditNodeClip": Gap("U15"),
    "graphStore.removeEmptyEditNode": Gap("U15"),
    "graphStore.removeShot": Tool("edit_canvas"),
    "graphStore.renameNode": Tool("edit_canvas"),
    "graphStore.reorderTrackItem": Tool("edit_canvas"),
    "graphStore.rerunHistoryRecord": Gap("U15"),
    "graphStore.rerunHistoryWithLatestPaperSource": Gap("U15"),
    "graphStore.reserveCreateGeneration": Exempt("browser-state"),
    "graphStore.reserveGraphImport": Exempt("browser-state"),
    "graphStore.resetExecution": Exempt("browser-state"),
    "graphStore.retryFailedRun": Gap("U15"),
    "graphStore.runHistory": Gap("U15"),
    "graphStore.selectAll": Exempt("browser-state"),
    "graphStore.uncertainWorldLabsRunId": Gap("U6"),
    "graphStore.undo": Gap("U1"),
    "graphStore.undoNotice": Exempt("browser-state"),
    "graphStore.undoStack": Gap("U1"),
    "graphStore.updateEditNodeClip": Gap("U15"),
    "graphStore.updateKeyframe": Tool("edit_canvas"),
    "graphStore.updateNodeData": Tool("edit_canvas"),
    "graphStore.updateRemotionManifest": Tool("edit_canvas"),
    "graphStore.updateScene": Tool("edit_canvas"),
    "graphStore.updateTrackItemProps": Tool("edit_canvas"),
    "graphStore.updateTrackItemSpatial": Tool("edit_canvas"),
    "graphStore.updateTrackItemTime": Tool("edit_canvas"),
}

# Tool arguments docs/MCP-SETUP.md doesn't name yet ("tool.arg"). May only shrink.
DOCS_GAPS_2026_10_20: frozenset[str] = frozenset({
    "cancel_run.run_id",
    "describe_node.definition_id",
    "find_nodes.category",
    "get_proposal.proposal_id",
    "get_run.run_id",
    "moodboard_create.strength",
    "moodboard_update.images",
    "moodboard_update.strength",
    "point_at.action",
    "point_at.node_id",
    "point_at.port",
    "remove_from_canvas.node_ids",
    "run_nodes.node_id",
    "view_output.node_id",
    "view_output.port",
    "view_output.size",
    "wait_for_canvas_change.include_self",
    "wait_for_canvas_change.timeout_seconds",
    "withdraw_proposal.proposal_id",
})

# Everything above that is a Gap or partial on 2026-10-20 (audit of main
# 0e6e645d). May only shrink: remove a key when its row gets a real agent path.
GAPS_2026_10_20: frozenset[str] = frozenset({
    "DELETE /api/characters/{char_id}",
    "DELETE /api/graph",
    "DELETE /api/presets/{preset_id}",
    "DELETE /api/projects/{project_id}",
    "DELETE /api/provider-recoveries/{run_id}/{node_id}",
    "DELETE /api/provider-start-ambiguities/{kind}/{node_id}/{run_id}",
    "DELETE /api/render-jobs/{job_id}",
    "GET /api/canvas/events",
    "GET /api/characters",
    "GET /api/characters/{char_id}",
    "GET /api/commons/borrowings",
    "GET /api/commons/collections",
    "GET /api/commons/concentration",
    "GET /api/commons/status",
    "GET /api/executions/{run_id}",
    "GET /api/graph/export",
    "GET /api/graph/node/{node_id}/path",
    "GET /api/graph/runs/{run_id}",
    "GET /api/health/providers",
    "GET /api/krea/connection",
    "GET /api/krea/plans",
    "GET /api/krea/tools",
    "GET /api/nous/models",
    "GET /api/openrouter/models",
    "GET /api/outputs/{rel:path}/meta",
    "GET /api/paper/files",
    "GET /api/paper/files/{file_id}",
    "GET /api/paper/object",
    "GET /api/paper/selection",
    "GET /api/paper/snapshots/{snapshot_id}",
    "GET /api/paper/sources/{source_id}",
    "GET /api/presets",
    "GET /api/presets/{preset_id}",
    "GET /api/projects/{project_id}",
    "GET /api/projects/{project_id}/covers",
    "GET /api/quiver/models",
    "GET /api/render-jobs/{job_id}",
    "GET /api/replicate/schema/{owner}/{name}",
    "GET /api/settings",
    "GET /api/trash",
    "POST /api/characters",
    "POST /api/cinema/generate-shot",
    "POST /api/cinema/promote-shot-variation",
    "POST /api/cinema/send-to-motion",
    "POST /api/commons/borrowings/{borrowing_id}/fidelity",
    "POST /api/commons/comments",
    "POST /api/execute",
    "POST /api/execute-node",
    "POST /api/export",
    "POST /api/graph/apply",
    "POST /api/graph/import",
    "POST /api/graph/restore",
    "POST /api/graph/run",
    "POST /api/krea/tools/call",
    "POST /api/moodboards/{moodboard_id}/edits",
    "POST /api/outputs/restore",
    "POST /api/paper/sources",
    "POST /api/paper/sources/{source_id}/reconnect",
    "POST /api/paper/sources/{source_id}/refresh",
    "POST /api/presets",
    "POST /api/quick",
    "POST /api/remotion-render",
    "POST /api/transcode-image",
    "POST /api/uploads",
    "POST /api/video-edit/export",
    "POST /api/video-edit/preview-render",
    "PUT /api/characters/{char_id}",
    "PUT /api/graph/layout",
    "PUT /api/presets/{preset_id}",
    "PUT /api/projects/{project_id}",
    "_maskData",
    "_output_image",
    "_paperSource",
    "_previewUrl",
    "_schema_fetched",
    "_sourceDuration",
    "_sourceFps",
    "_sourceIsVfr",
    "_variant",
    "_version_id",
    "graphStore.acknowledgeProviderStartAmbiguity",
    "graphStore.acknowledgeUncertainWorldLabsRun",
    "graphStore.addDynamicNode",
    "graphStore.applyPaperSource",
    "graphStore.autoLayout",
    "graphStore.autoLayoutSelected",
    "graphStore.beginUndoStep",
    "graphStore.cancelUndoStep",
    "graphStore.clearGraph",
    "graphStore.clearRunHistory",
    "graphStore.configureOpenRouterModel",
    "graphStore.cutEditNodeAtSource",
    "graphStore.deleteProviderRecovery",
    "graphStore.duplicateNode",
    "graphStore.duplicateSelected",
    "graphStore.executeCluster",
    "graphStore.executeClusterConcurrent",
    "graphStore.executeShot",
    "graphStore.fetchReplicateSchemaAndConfigure",
    "graphStore.getOrCreateEditNodeDownstream",
    "graphStore.loadGraph",
    "graphStore.loadSampleGraph",
    "graphStore.pasteClipboard",
    "graphStore.promoteShotVariation",
    "graphStore.providerRecoveries",
    "graphStore.providerRecoveryWarning",
    "graphStore.providerStartAmbiguities",
    "graphStore.redo",
    "graphStore.redoStack",
    "graphStore.removeEditNodeClip",
    "graphStore.removeEmptyEditNode",
    "graphStore.rerunHistoryRecord",
    "graphStore.rerunHistoryWithLatestPaperSource",
    "graphStore.retryFailedRun",
    "graphStore.runHistory",
    "graphStore.uncertainWorldLabsRunId",
    "graphStore.undo",
    "graphStore.undoStack",
    "graphStore.updateEditNodeClip",
    "nebula apply --file",
    "nebula apply --remove",
    "nebula apply --unwire",
    "nebula clear",
    "nebula commons status",
    "nebula keys",
    "nebula load",
    "nebula path",
    "nebula quick",
    "nebula watch --journal",
    "ws executionStatus",
    "ws progress",
    "ws projectsChanged",
    "ws provider_recovery",
    "ws provider_start_ambiguous",
    "ws storedAssetChanged",
    "ws stream_delta",
    "ws stream_partial_image",
    "ws stream_partial_svg",
})
