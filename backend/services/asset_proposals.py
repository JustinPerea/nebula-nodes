"""Proposals for changes outside the graph: a project's cover, a board's notes.

Canvas proposals (services/canvas_proposals.py) carry graph changes only.
Some of the person's calls live on an asset or a project instead:

- ``project`` ``{"cover": url | None}``: change a cover the person pinned
  (None goes back to the automatic one). While the person hasn't pinned one,
  an agent sets the cover directly (``PUT /api/projects/{id}/cover``); a
  proposal is how it asks to change the person's own pick. Decided on the
  Projects screen.
- ``moodboard`` ``{"sendNotes": true}``: send the board's notes to
  generators, which only the person may turn on (moodboard_store
  ``NotesOptInProtected``). Decided in Moodboard Studio.
- ``commons`` (a reference's asset id) ``{"correction" | "region" |
  "membership": {...}}`` or ``{"edits": [...]}``: curating the Commons,
  which only the person may do (services/commons_proposals.py, Justin's
  Q63 b). The body may also name the ``brand`` whose scope the agent works
  in. Decided in the Commons, on the reference's detail.

Characters and Styles have nothing that needs the person's decision yet;
their kinds are refused by name until they do (``LATER_KINDS``).

The life cycle, caps, expiry and accept gate are the canvas proposals' own:
``AssetProposalBook`` is a ``ProposalBook`` with its own records, so open,
accepted, rejected, withdrawn, expired and invalidated mean the same, three
are open per agent and twelve in all, and each expires after 15 minutes.
Every proposal has an ``accept_key`` that only the person's canvas sockets
receive (``assetProposalOpened`` / ``assetProposalSync``); ``view()`` never
holds it. Ids start with ``pa_``, and ``GET`` / ``DELETE
/api/canvas/proposals/{id}`` answer for them too, so ``get_proposal``,
``withdraw_proposal`` and ``nebula proposal`` work unchanged.

Each proposal records the target as it was when proposed (``before``).
Accept applies the change only while the target is still that way (the
same pin, notes still off); otherwise it closes as invalidated, as a canvas
proposal does when the canvas moved under it. main checks this on every
read and decision (``_sweep_asset_proposals``).

Memory-only, like canvas proposals: lost on restart.
"""
from __future__ import annotations

import copy
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from services.agent_presence import AgentIdentity
from services.canvas_proposals import (
    OPEN,
    PROPOSAL_TTL_SECONDS,
    ProposalBook,
    ProposalError,
    clean_note,
)

KINDS = ("project", "moodboard", "commons")
# Assets whose Studio has nothing only the person may change yet.
LATER_KINDS = ("character", "style")
# What each kind may propose, and where the person decides it.
CHANGE_KEYS = {"project": ("cover",), "moodboard": ("sendNotes",),
               "commons": ("edits", "correction", "region", "membership")}
DECIDE_IN = {"project": "projects", "moodboard": "moodboard-studio", "commons": "commons"}
_ALLOWED_KEYS = frozenset({"kind", "id", "change", "note", "brand"})
MAX_BRAND = 64
MAX_TARGET_ID = 128
MAX_URL = 8192


def new_asset_proposal_id() -> str:
    return "pa_" + secrets.token_hex(4)


@dataclass(frozen=True)
class AssetChange:
    """A proposal body, shape-checked. ``change`` is normalized per kind."""
    kind: str
    target_id: str
    change: dict[str, Any]
    note: str
    # The brand whose Commons scope the agent works in (kind commons only).
    brand: str | None = None


def _refuse_later_kind(kind: str) -> None:
    raise ProposalError(422, (
        f"kind '{kind}' has nothing to propose yet: Characters and Styles have no setting only the person "
        "may change. kind must be one of: " + ", ".join(KINDS)))


def parse_change(body: Any) -> AssetChange:
    """Shape-check a ``POST /api/asset-proposals`` body (422 on anything off).

    Whether the target exists and the change fits it is main's (404, 400,
    409), since that needs the project store or the board."""
    if not isinstance(body, dict):
        raise ProposalError(422, "the proposal must be a JSON object")
    unknown = sorted(set(body) - _ALLOWED_KEYS)
    if unknown:
        raise ProposalError(422, f"unknown proposal field '{str(unknown[0])[:40]}' (send kind, id, change, note)")
    if "brand" in body and body.get("kind") != "commons":
        raise ProposalError(422, "brand is only for a commons proposal (the brand whose references you work on)")
    kind = body.get("kind")
    if kind in LATER_KINDS:
        _refuse_later_kind(str(kind))
    if kind not in KINDS:
        raise ProposalError(422, "kind must be one of: " + ", ".join(KINDS))
    target_id = body.get("id")
    if not isinstance(target_id, str) or not target_id.strip() or len(target_id) > MAX_TARGET_ID:
        raise ProposalError(422, f"id must be the {kind}'s id")
    raw = body.get("change")
    if not isinstance(raw, dict) or not raw:
        raise ProposalError(422, "change must be an object, e.g. " + {
            "project": '{"cover": "/api/outputs/..."}', "moodboard": '{"sendNotes": true}',
            "commons": '{"correction": {"field_path": "summary", "value": "..."}}'}[kind])
    if kind == "commons":
        return _parse_commons(body, target_id.strip(), raw)
    allowed = CHANGE_KEYS[kind]
    extra = sorted(set(raw) - set(allowed))
    if extra:
        raise ProposalError(422, (f"a {kind} proposal can change only {', '.join(allowed)}; "
                                  f"'{str(extra[0])[:40]}' isn't one"))
    note = clean_note(body.get("note"))
    if kind == "project":
        cover = raw.get("cover")
        if cover == "":
            cover = None
        if cover is not None and (not isinstance(cover, str) or len(cover) > MAX_URL):
            raise ProposalError(422, "cover must be one of the project's image URLs (list_project_covers), "
                                "or null for the automatic cover")
        change: dict[str, Any] = {"cover": cover}
    else:
        value = raw.get("sendNotes")
        if not isinstance(value, bool):
            raise ProposalError(422, "sendNotes must be true (sending the board's notes to generators)")
        if value is False:
            raise ProposalError(422, ("turning Send notes off needs no proposal: set it directly "
                                      "(moodboard_update(send_notes=false))"))
        change = {"sendNotes": True}
    return AssetChange(kind=kind, target_id=target_id.strip(), change=change, note=note)


def _parse_commons(body: dict[str, Any], target_id: str, raw: dict[str, Any]) -> AssetChange:
    from services import commons_proposals

    brand = body.get("brand")
    if brand in (None, ""):
        brand = None
    elif not isinstance(brand, str) or len(brand) > MAX_BRAND:
        raise ProposalError(422, "brand must be the brand's name, as the commons_* tools take it")
    change = commons_proposals.parse_change(raw)
    return AssetChange(kind="commons", target_id=target_id, change=change, note=clean_note(body.get("note")),
                       brand=brand)


@dataclass
class AssetProposal:
    id: str
    agent: AgentIdentity
    kind: str
    target_id: str
    target_name: str
    change: dict[str, Any]
    # The target as proposed against: {"cover": url|None, "coverBy": {...}|None}
    # or {"sendNotes": False}, or for commons {"edits": [state per edit]}.
    # Accept refuses once it no longer holds.
    before: dict[str, Any]
    note: str
    created_at: float
    expires_at: float
    status: str = OPEN
    reason: str | None = None
    # Only ever sent to the person's canvas sockets; never in view(), REST, journal or logs.
    accept_key: str = field(default_factory=lambda: secrets.token_urlsafe(24), repr=False)
    applied: dict[str, Any] | None = None
    closed_at: float | None = None
    # ProposalBook.close sets these on every record it closes.
    id_map: dict[str, str] | None = None
    run_node_ids: list[str] | None = None
    # The canvas book invalidates by node id; an asset proposal refers to none.
    references: frozenset[str] = frozenset()

    @property
    def is_open(self) -> bool:
        return self.status == OPEN

    @property
    def project_id(self) -> str | None:
        return self.target_id if self.kind == "project" else None


def summary(proposal: AssetProposal) -> str:
    """The change in one line, for the journal, the Agent log and the CLI."""
    name = proposal.target_name or proposal.target_id
    if proposal.kind == "commons":
        from services import commons_proposals

        return commons_proposals.summary(proposal.target_id, proposal.change)
    if proposal.kind == "project":
        to = proposal.change.get("cover")
        return (f'set the cover of project "{name}" back to automatic' if to is None
                else f'make another image the cover of project "{name}"')
    return f'send the notes of board "{name}" to generators'


class AssetProposalBook(ProposalBook):
    """Open asset proposals plus recently decided ones, as ProposalBook keeps them."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        super().__init__(clock)

    def create_asset(
        self,
        *,
        agent: AgentIdentity,
        spec: AssetChange,
        target_name: str,
        before: Mapping[str, Any],
    ) -> AssetProposal:
        """Build and open a proposal (enforcing the open caps)."""
        now = self.now()
        proposal = AssetProposal(
            id=new_asset_proposal_id(),
            agent=agent,
            kind=spec.kind,
            target_id=spec.target_id,
            target_name=target_name,
            change=copy.deepcopy(spec.change),
            before=copy.deepcopy(dict(before)),
            note=spec.note,
            created_at=now,
            expires_at=now + PROPOSAL_TTL_SECONDS,
        )
        while self.get(proposal.id) is not None:  # vanishingly unlikely, but ids must be unique
            proposal.id = new_asset_proposal_id()
        self.open(proposal)  # type: ignore[arg-type]  # same shape ProposalBook relies on
        return proposal

    def for_target(self, kind: str | None = None, target_id: str | None = None) -> list[AssetProposal]:
        return [p for p in self.open_list()  # type: ignore[misc]
                if (kind is None or p.kind == kind) and (target_id is None or p.target_id == target_id)]

    # -- what agents and the person's screens see (never the accept key) ------
    def view(self, proposal: Any, *, registry: Any = None) -> dict[str, Any]:  # noqa: ARG002
        if proposal.kind == "commons":
            # The agent's own edits only: the reference as it is now is Commons
            # text, which reaches the person's screen alone (person_values).
            change = copy.deepcopy(proposal.change)
        elif proposal.kind == "project":
            change = {"cover": {"from": proposal.before.get("cover"), "to": proposal.change.get("cover"),
                                "fromBy": copy.deepcopy(proposal.before.get("coverBy"))}}
        else:
            change = {"sendNotes": {"from": bool(proposal.before.get("sendNotes")), "to": True}}
        return {
            "id": proposal.id,
            "status": proposal.status,
            "agent": proposal.agent.as_dict(),
            "note": proposal.note,
            "kind": proposal.kind,
            "target": {"kind": proposal.kind, "id": proposal.target_id, "name": proposal.target_name},
            "change": change,
            "summary": summary(proposal),
            "decideIn": DECIDE_IN[proposal.kind],
            "createdAt": int(proposal.created_at * 1000),
            "expiresAt": int(proposal.expires_at * 1000),
            "reason": proposal.reason,
            "applied": copy.deepcopy(proposal.applied),
        }

    def brief(self, proposal: Any) -> dict[str, Any]:
        return {
            "id": proposal.id,
            "agent": proposal.agent.name,
            "note": proposal.note,
            "status": proposal.status,
            "kind": proposal.kind,
            "targetId": proposal.target_id,
            "expiresInSeconds": max(0, int(proposal.expires_at - self.now())),
        }

    def person_values(self, proposal: Any) -> dict[str, Any]:
        """What only the person's screen gets beyond the view: for a commons
        proposal, each edit's target as it was (``before``, Commons text).
        A cover's URL or a switch is already whole in the view."""
        if proposal.kind == "commons":
            return {"before": copy.deepcopy(proposal.before.get("edits") or [])}
        return {}


asset_proposals = AssetProposalBook()
