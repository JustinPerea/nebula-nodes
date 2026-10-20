"""Checked board edits: a batch of ops on one moodboard, applied whole or not at all.

``POST /api/moodboards/{id}/edits`` takes ``{ops, baseVersion?, say?}``
(docs/moodboard-canvas-plan.md section 5.1). The ops are staged on a copy of
the board, each checked as it applies, and the store saves the result once
with ``version + 1``; an op that fails stops the batch and nothing is saved.
This is the pattern of ``/api/graph/apply`` (services/canvas_edits.py).

Ops are absolute sets ("card c1 at 200, 40", "image 3 weighs 0.5"), so a
batch sent twice changes nothing the second time, and the Studio can replay
the ops it hasn't seen confirmed on top of a board someone else changed.

- Images: ``add`` (``urls`` or ``images``, ``at``, ``in``, ``size``,
  ``index``, ``unique``), ``remove``.
- Cards: ``place`` (a card to x, y, optionally into a frame or out of one),
  ``resize`` (``weight``, or ``w`` x ``h`` with the card's aspect kept),
  ``link`` (a copy of an image in a frame), ``unlink``.
- Image settings: ``setAside``, ``weight`` (scales the copies), ``note``
  (``notes`` or ``privateNote``).
- Frames: ``frame.create`` (a rectangle, or ``around`` some cards),
  ``frame.update`` (name or rectangle; a move moves its cards),
  ``frame.delete`` (its cards stay), ``frame.merge``.
- ``restore``: before-slices, each with the ``expect`` after-slice; a slice
  that changed since is skipped and reported, so one stale reference
  doesn't stop the rest of an undo. Image settings and the board's own
  fields (a ``fields`` slice: name, notes, Direction... as a PUT sets
  them) are checked one by one, so "#2's weight changed since" leaves its
  notes free to go back.

Names: an image by its number (as the board was before the batch) or id; a
frame by id or name; a card by its placement id, ``image@frame``, or the
image when it has one card.

Every batch hands back ``undo``: one ``restore`` built from the difference
between the board before and after, so any batch (a ``restore`` too) has an
inverse. The same difference names what was touched (for the broadcast) and
what the journal says (``changes``), and a PUT's journal entry is read from
it too, so an older client's image edits show up as well.

The whole-board analysis is cleared when what it reads changed (each
image's url, weight, notes and Set aside switch, and their order), as the
CLI does; moving, resizing a card without changing the image's weight,
frames and private notes keep it.
"""
from __future__ import annotations

import copy
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping
from uuid import uuid4

from services import moodboard_layout as layout

MAX_OPS = 500
# Over this many ops the broadcast leaves ``undo`` out (the Studio refetches,
# and only the tab that made the batch can undo it from its answer).
UNDO_BROADCAST_LIMIT = 200
SAY_LIMIT = 140
MOVE_THRESHOLD_PX = 8.0

OPS = ("add", "remove", "place", "resize", "link", "unlink", "setAside", "weight", "note",
       "frame.create", "frame.update", "frame.delete", "frame.merge", "restore")
# Ops a later Nebula adds (plan section 5.1); refused by name until then.
LATER_OPS = ("arrange", "look.set", "look.inherit", "suggestion.accept", "suggestion.dismiss", "realPerson")
# The image settings a ``restore`` slice can put back.
SETTING_KEYS = ("weight", "excluded", "notes", "privateNote")
# What an image saved before a setting existed reads as (the store's
# _normalize_images saves these on its next write): not a change.
SETTING_DEFAULTS: dict[str, Any] = {"weight": 1.0, "excluded": False, "notes": "", "privateNote": ""}
# What the whole-board analysis reads of each image (moodboard_analysis.source_hash).
STEERING_KEYS = ("url", "weight", "notes", "excluded")
SLICE_PARTS = ("frame", "image", "settings", "card", "fields")
# The board's own fields a ``fields`` slice puts back (a PUT sets them), in
# the order they go back: the pins before the colour choices checked
# against them, the hand-written brief last (it is stamped with the board
# as it ends up). Values are as ``field_value`` reads them.
FIELD_KEYS = ("name", "notes", "mode", "strength", "direction", "avoid", "pinnedColors", "clashMode",
              "colorChoices", "sendNotes", "briefOverride")
# What the board's mode, strength and notes are to the whole-board analysis.
STEERING_FIELDS = ("mode", "strength", "notes")
FIELD_LABELS = {
    "name": "The name", "notes": "The board's notes", "mode": "Mode", "strength": "Strength",
    "direction": "Direction", "avoid": "The Avoid list", "pinnedColors": "The pinned colours",
    "clashMode": "The clash mode", "colorChoices": "The colour choices",
    "sendNotes": "Send notes to generators", "briefOverride": "The hand-written brief",
}
SETTING_LABELS = {"weight": "weight", "excluded": "Set aside switch", "notes": "notes",
                  "privateNote": "private note"}

_FRAME_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_WXH_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*$")


class EditError(ValueError):
    """An op that can't apply: the whole batch is refused (422)."""


@dataclass
class EditResult:
    board: dict[str, Any]
    applied: list[dict[str, Any]]
    undo: dict[str, Any]
    changed: bool
    touched: dict[str, list[str]]
    changes: dict[str, Any] = field(default_factory=dict)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_say(raw: Any) -> str:
    """The agent's own words for what it did, as its cursor shows them: one
    line of at most SAY_LIMIT characters."""
    return " ".join(str(raw or "").split())[:SAY_LIMIT]


# -- reading op values -----------------------------------------------------------

def _keys(op: dict[str, Any], allowed: Iterable[str]) -> None:
    unknown = sorted(set(op) - {"op", *allowed})
    if unknown:
        raise EditError(f"unknown key '{str(unknown[0])[:40]}'; {op['op']} takes {', '.join(allowed)}")


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise EditError(f"{label} must be a number")
    return float(value)


def _coordinate(value: Any, label: str) -> int:
    number = _number(value, label)
    if abs(number) > layout.COORD_LIMIT:
        raise EditError(f"{label} must be within {layout.COORD_LIMIT:,} px of the origin")
    return round(number)


def _unit(value: Any, label: str) -> float:
    number = _number(value, label)
    if not 0.0 <= number <= 1.0:
        raise EditError(f"{label} must be from 0 to 1")
    return number


def _card_weight(value: Any, label: str) -> float:
    """A card weight: a number from MIN_WEIGHT to 1, or ``"WxH"`` pixels."""
    if isinstance(value, str):
        match = _WXH_RE.match(value)
        if not match:
            raise EditError(f'{label} must be a weight or "WxH" in pixels')
        w, h = float(match.group(1)), float(match.group(2))
        if w <= 0 or h <= 0:
            raise EditError(f"{label}: width and height must be more than 0")
        return layout.clamp_weight(layout.weight_of(w, h))
    number = _number(value, label)
    if not 0 < number <= 1:
        raise EditError(f"{label} must be more than 0 and at most 1")
    return layout.clamp_weight(number)


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise EditError(f"{label} must be text")
    return value


# -- the batch ---------------------------------------------------------------------

class _Batch:
    """One batch being staged on a copy of the board."""

    def __init__(self, board: dict[str, Any], *, by: str, now: str) -> None:
        self.board = board
        self.by = by
        self.now = now
        # Numbers name images as the board was before the batch.
        self.numbers = [str(img.get("id")) for img in board.get("images") or [] if isinstance(img, dict)]
        self.measured = layout.analysis_sizes(board.get("analysis"))

    # -- names
    @property
    def images(self) -> list[dict[str, Any]]:
        return self.board["images"]

    @property
    def frames(self) -> list[dict[str, Any]]:
        return self.board["frames"]

    def find(self, image_id: str) -> dict[str, Any] | None:
        return next((img for img in self.images if str(img.get("id")) == image_id), None)

    def image_id(self, ref: Any, *, missing_ok: bool = False) -> str | None:
        """The id of the image ``ref`` names (a number or an id)."""
        if isinstance(ref, bool) or not isinstance(ref, (int, str)) or ref == "":
            raise EditError("an image is named by its number or id")
        text = str(ref).strip()
        if self.find(text) is not None:
            return text
        if text.isdigit():
            number = int(text)
            if not 1 <= number <= len(self.numbers):
                raise EditError(f"no image #{number} on this board (it has {len(self.numbers)})")
            image_id = self.numbers[number - 1]
            if self.find(image_id) is None:
                raise EditError(f"image #{number} was removed earlier in this batch")
            return image_id
        if missing_ok:
            return None
        raise EditError(f"no image '{text[:64]}' on this board: name it by its number or id")

    def image(self, ref: Any) -> dict[str, Any]:
        found = self.find(self.image_id(ref) or "")
        assert found is not None
        return found

    def number(self, image: dict[str, Any]) -> int:
        return self.images.index(image) + 1

    def frame(self, ref: Any, *, missing_ok: bool = False) -> dict[str, Any] | None:
        if not isinstance(ref, str) or not ref.strip():
            raise EditError("a frame is named by its id or name")
        text = ref.strip()
        found = next((f for f in self.frames if f.get("id") == text), None)
        found = found or next((f for f in self.frames if str(f.get("name", "")).casefold() == text.casefold()), None)
        if found is None and not missing_ok:
            raise EditError(f"no frame '{text[:60]}' on this board")
        return found

    def frame_label(self, frame_id: Any) -> str:
        frame = next((f for f in self.frames if f.get("id") == frame_id), None)
        return str(frame.get("name")) if frame else str(frame_id)

    def card(self, op: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        """The (image, placement) an op names with ``placement``, or with
        ``image`` (and ``frameId`` for ``unlink``)."""
        if "placement" in op:
            ref = op["placement"]
            if not isinstance(ref, str) or not ref.strip():
                raise EditError("a card is named by its placement id, image@frame, or the image")
            ref = ref.strip()
            for img in self.images:
                for p in layout.cards_of(img):
                    if p.get("id") == ref:
                        return img, p
            image_ref, at, frame_ref = ref.rpartition("@")
            if at:
                img = self.image(image_ref)
                frame = self.frame(frame_ref)
                assert frame is not None
                p = next((p for p in layout.cards_of(img) if p.get("frameId") == frame["id"]), None)
                if p is None:
                    raise EditError(f"#{self.number(img)} has no card in {frame['name']}")
                return img, p
            if self.image_id(ref, missing_ok=True) is None:
                raise EditError(f"no card '{ref[:64]}' on this board")
            return self._only_card(self.image(ref))
        if "image" in op:
            img = self.image(op["image"])
            if op.get("frameId") is not None and op["op"] == "unlink":
                frame = self.frame(op["frameId"])
                assert frame is not None
                p = next((p for p in layout.cards_of(img) if p.get("frameId") == frame["id"]), None)
                if p is None:
                    raise EditError(f"#{self.number(img)} isn't in {frame['name']}")
                return img, p
            return self._only_card(img)
        raise EditError(f"{op['op']} needs placement (a card id or image@frame) or image")

    def _only_card(self, img: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        cards = layout.cards_of(img)
        if len(cards) != 1:
            raise EditError(f"#{self.number(img)} has {len(cards)} cards: name one by its id or as "
                            f"{self.number(img)}@<look>")
        return img, cards[0]

    def placement_ids(self) -> set[str]:
        return {str(p.get("id")) for img in self.images for p in layout.cards_of(img)}

    def new_placement_id(self) -> str:
        taken = self.placement_ids()
        pid = layout.new_placement_id()
        while pid in taken:
            pid = layout.new_placement_id()
        return pid

    def aspect(self, img: dict[str, Any]) -> float:
        return layout.image_aspect(img, self.measured)

    def check_cards(self, img: dict[str, Any]) -> None:
        """The image's cards follow the rules (1 to 8, one per frame, a loose
        card only alone)."""
        try:
            layout.check_image_placements([img], {f["id"] for f in self.frames})
        except ValueError as exc:
            raise EditError(f"#{self.number(img)}: {exc}".replace("images[0].placements", "its cards")) from None

    def spot_in(self, frame: dict[str, Any], size: tuple[int, int]) -> tuple[int, int]:
        """A free spot for a card inside ``frame``; the frame grows to hold it."""
        x, y, grown = layout.place_in_frame(self.board, frame, size)
        frame.update({"x": round(grown[0]), "y": round(grown[1]), "w": round(grown[2]), "h": round(grown[3])})
        return x, y

    def set(self, target: dict[str, Any], key: str, value: Any) -> bool:
        if key in target and target[key] == value and type(target[key]) is type(value):
            return False
        target[key] = value
        return True

    # -- ops
    def apply(self, op: Any) -> dict[str, Any]:
        if not isinstance(op, dict):
            raise EditError("each op must be an object with an op name")
        name = op.get("op")
        if name in LATER_OPS:
            raise EditError(f"{name} isn't in this version of Nebula")
        if name not in OPS:
            raise EditError(f"unknown op '{str(name)[:40]}'; ops are {', '.join(OPS)}")
        handler = getattr(self, "op_" + name.replace(".", "_"))
        entry = handler(op) or {}
        changed = entry.pop("changed")
        return {"op": name, "status": "applied" if changed else "unchanged", **entry}

    def op_add(self, op: dict[str, Any]) -> dict[str, Any]:
        from services import moodboard_store

        _keys(op, ("urls", "images", "at", "in", "size", "index", "unique"))
        items: list[dict[str, Any]] = []
        urls = op.get("urls") or []
        if not isinstance(urls, list):
            raise EditError("urls must be a list")
        for url in urls:
            items.append({"url": _text(url, "each url")})
        raw_images = op.get("images") or []
        if not isinstance(raw_images, list):
            raise EditError("images must be a list of {url, ...}")
        for raw in raw_images:
            if not isinstance(raw, dict):
                raise EditError("images must be a list of {url, ...}")
            unknown = sorted(set(raw) - {*moodboard_store.IMAGE_KEYS, "placements"})
            if unknown:
                raise EditError(f"an added image has unknown key '{str(unknown[0])[:40]}'")
            if raw.get("id") is not None and (not isinstance(raw["id"], str) or not _ID_RE.fullmatch(raw["id"])):
                raise EditError("an added image's id must be 1 to 64 letters, digits, - or _")
            items.append(dict(raw))
        if not items:
            raise EditError("add needs urls or images")
        for item in items:
            if not isinstance(item.get("url"), str) or not item["url"].strip():
                raise EditError("each added image needs a url")
        index = op.get("index", len(self.images))
        if isinstance(index, bool) or not isinstance(index, int):
            raise EditError("index must be a whole number")
        index = max(0, min(index, len(self.images)))
        size = _card_weight(op["size"], "size") if op.get("size") is not None else None
        at = op.get("at")
        if at is not None and (not isinstance(at, dict) or set(at) - {"x", "y"}):
            raise EditError("at must be {x, y}")
        frame = self.frame(op["in"]) if op.get("in") is not None else None

        on_board = {str(img.get("url")) for img in self.images}
        ids = {str(img.get("id")) for img in self.images}
        fresh: list[dict[str, Any]] = []
        skipped = 0
        for item in items:
            url = item["url"].strip()
            if (item.get("id") and item["id"] in ids) or (op.get("unique") and url in on_board):
                skipped += 1
                continue
            on_board.add(url)
            if item.get("id"):
                ids.add(item["id"])
            if size is not None and "weight" not in item and "placements" not in item:
                item["weight"] = size
            fresh.append(item)
        if not fresh:
            return {"changed": False, "added": [], "skipped": skipped}
        if at is not None and "placements" not in fresh[0]:
            fresh[0]["placements"] = [{"x": _coordinate(at.get("x"), "at.x"), "y": _coordinate(at.get("y"), "at.y"),
                                       "frameId": frame["id"] if frame else None}]
        try:
            images = moodboard_store._normalize_images(
                self.images[:index] + fresh + self.images[index:], stored=self.images, board=self.board,
                by=self.by)
        except ValueError as exc:
            raise EditError(str(exc)) from None
        added = images[index:index + len(fresh)]
        self.board["images"] = images
        if frame is not None:
            # In a frame: each card Nebula placed takes a free spot inside it, in order.
            spots = [(img, img["placements"][0]) for img, item in zip(added, fresh) if "placements" not in item]
            for img, _p in spots:
                img["placements"] = []
            for img, p in spots:
                x, y = self.spot_in(frame, (p["w"], p["h"]))
                img["placements"] = [{**p, "x": x, "y": y, "frameId": frame["id"]}]
        return {"changed": True, "added": [str(img["id"]) for img in added], "skipped": skipped}

    def op_remove(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("images", "image"))
        refs = op["images"] if "images" in op else [op.get("image")]
        if not isinstance(refs, list) or not refs:
            raise EditError("remove takes images: a list of numbers or ids")
        gone = {image_id for image_id in (self.image_id(ref, missing_ok=True) for ref in refs) if image_id}
        before = len(self.images)
        self.board["images"] = [img for img in self.images if str(img.get("id")) not in gone]
        return {"changed": len(self.images) != before}

    def op_place(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("placement", "image", "x", "y", "frameId"))
        img, p = self.card(op)
        x, y = _coordinate(op.get("x"), "x"), _coordinate(op.get("y"), "y")
        changed = False
        if "frameId" in op and (op["frameId"] or None) != p.get("frameId"):
            target = self.frame(op["frameId"]) if op["frameId"] is not None else None
            if target is not None:
                if any(q.get("frameId") == target["id"] for q in layout.cards_of(img) if q is not p):
                    raise EditError(f"Already in {target['name']}: #{self.number(img)} has a card there")
                p["frameId"] = target["id"]
            elif len(layout.cards_of(img)) > 1:
                # Out of a look onto the canvas: this copy goes; the image stays in its other looks.
                img["placements"] = [q for q in layout.cards_of(img) if q is not p]
                return {"changed": True}
            else:
                p["frameId"] = None
            changed = True
        changed |= self.set(p, "x", x)
        changed |= self.set(p, "y", y)
        self.check_cards(img)
        return {"changed": changed}

    def op_resize(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("placement", "image", "weight", "w", "h"))
        img, p = self.card(op)
        if op.get("weight") is not None:
            weight = _card_weight(op["weight"], "weight")
        elif op.get("w") is not None and op.get("h") is not None:
            w, h = _number(op["w"], "w"), _number(op["h"], "h")
            if w <= 0 or h <= 0:
                raise EditError("w and h must be more than 0")
            weight = layout.clamp_weight(layout.weight_of(w, h))
        else:
            raise EditError("resize takes weight, or w and h (the card keeps its aspect)")
        rect = layout.card_rect(p)
        aspect = rect[2] / rect[3] if rect else self.aspect(img)
        resized = layout.resized(p, weight, aspect)
        changed = any([self.set(p, key, resized[key]) for key in ("weight", "w", "h")])
        # A steering image weighs what its largest card shows (plan section
        # 4.3); weight 0 stays until the image is used again (Q8).
        if img.get("weight", 0) > 0:
            changed |= self.set(img, "weight", max(q["weight"] for q in layout.cards_of(img)))
        return {"changed": changed}

    def op_link(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("image", "frameId", "x", "y", "weight"))
        img = self.image(op.get("image"))
        if op.get("frameId") is None:
            raise EditError("link needs frameId: the look to add a copy to")
        frame = self.frame(op["frameId"])
        assert frame is not None
        cards = layout.cards_of(img)
        if any(p.get("frameId") == frame["id"] for p in cards):
            raise EditError(f"Already in {frame['name']}: #{self.number(img)} has a card there")
        if len(cards) >= layout.PLACEMENTS_PER_IMAGE:
            raise EditError(f"#{self.number(img)} has {layout.PLACEMENTS_PER_IMAGE} cards, the most an image has")
        weight = (_card_weight(op["weight"], "weight") if op.get("weight") is not None
                  else layout.clamp_weight(max((p.get("weight") or 0 for p in cards), default=1.0) or 1.0))
        w, h = layout.size_for(weight, self.aspect(img))
        if "x" in op or "y" in op:
            x, y = _coordinate(op.get("x"), "x"), _coordinate(op.get("y"), "y")
        else:
            x, y = self.spot_in(frame, (w, h))
        loose = [p for p in cards if p.get("frameId") is None]
        if loose:
            # A loose card can't sit beside a framed one: it joins the look.
            loose[0].update({"frameId": frame["id"], "x": x, "y": y, "weight": weight, "w": w, "h": h})
        else:
            img["placements"] = [*cards, {"id": self.new_placement_id(), "frameId": frame["id"], "x": x, "y": y,
                                          "w": w, "h": h, "weight": weight, "placedBy": self.by,
                                          "placedAt": self.now}]
        self.check_cards(img)
        return {"changed": True}

    def op_unlink(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("placement", "image", "frameId"))
        img, p = self.card(op)
        if p.get("frameId") is None:
            raise EditError(f"#{self.number(img)}'s card is in no look")
        if len(layout.cards_of(img)) > 1:
            img["placements"] = [q for q in layout.cards_of(img) if q is not p]
        else:
            p["frameId"] = None
        return {"changed": True}

    def _targets(self, op: dict[str, Any]) -> list[dict[str, Any]]:
        refs = op["images"] if "images" in op else [op.get("image")]
        if not isinstance(refs, list) or not refs:
            raise EditError(f"{op['op']} takes image, or images: a list of numbers or ids")
        return [self.image(ref) for ref in refs]

    def op_setAside(self, op: dict[str, Any]) -> dict[str, Any]:  # noqa: N802 - the op's name
        _keys(op, ("image", "images", "value"))
        if not isinstance(op.get("value"), bool):
            raise EditError("value must be true (set aside) or false (use it)")
        changed = False
        for img in self._targets(op):
            changed |= self.set(img, "excluded", op["value"])
            if not op["value"] and not (img.get("weight") or 0) > 0:
                # Used again from weight 0: it weighs what its card shows (section 4.4).
                weights = [p.get("weight") for p in layout.cards_of(img) if (p.get("weight") or 0) > 0]
                changed |= self.set(img, "weight", min(1.0, max(weights)) if weights else 1.0)
        return {"changed": changed}

    def op_weight(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("image", "images", "value"))
        value = _unit(op.get("value"), "value")
        changed = False
        for img in self._targets(op):
            if self.set(img, "weight", value):
                changed = True
                if layout.has_card(img):
                    img["placements"] = layout.rescale(img["placements"], value, self.aspect(img))
        return {"changed": changed}

    def op_note(self, op: dict[str, Any]) -> dict[str, Any]:
        from services.moodboard_store import PRIVATE_NOTE_LIMIT

        _keys(op, ("image", "notes", "privateNote"))
        if "notes" not in op and "privateNote" not in op:
            raise EditError("note takes notes or privateNote (or both)")
        img = self.image(op.get("image"))
        changed = False
        if "notes" in op:
            changed |= self.set(img, "notes", _text(op["notes"], "notes"))
        if "privateNote" in op:
            text = _text(op["privateNote"], "privateNote")
            if len(text) > PRIVATE_NOTE_LIMIT:
                raise EditError(f"privateNote is longer than {PRIVATE_NOTE_LIMIT} characters")
            changed |= self.set(img, "privateNote", text)
        return {"changed": changed}

    def _rect(self, op: dict[str, Any], label: str) -> tuple[int, int, int, int] | None:
        raw = op.get("rect") if op.get("rect") is not None else (
            {key: op[key] for key in ("x", "y", "w", "h") if key in op} or None)
        if raw is None:
            return None
        if not isinstance(raw, dict) or set(raw) - {"x", "y", "w", "h"}:
            raise EditError(f"{label} is {{x, y, w, h}}")
        x, y = _coordinate(raw.get("x"), "x"), _coordinate(raw.get("y"), "y")
        w, h = _coordinate(raw.get("w"), "w"), _coordinate(raw.get("h"), "h")
        if w < layout.FRAME_MIN_SIDE or h < layout.FRAME_MIN_SIDE:
            raise EditError(f"a frame's sides are at least {layout.FRAME_MIN_SIDE} px")
        return x, y, w, h

    def _name(self, raw: Any, *, keep: dict[str, Any] | None = None) -> str:
        name = _text(raw, "name").strip()
        if not 1 <= len(name) <= layout.FRAME_NAME_LIMIT:
            raise EditError(f"a frame's name is 1 to {layout.FRAME_NAME_LIMIT} characters")
        if any(str(f.get("name", "")).casefold() == name.casefold() for f in self.frames if f is not keep):
            raise EditError(f"there is already a frame called {name} on this board")
        return name

    def members(self, frame_id: str) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        return [(img, p) for img in self.images for p in layout.cards_of(img) if p.get("frameId") == frame_id]

    def op_frame_create(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("id", "name", "kind", "x", "y", "w", "h", "rect", "around"))
        frame_id = op.get("id")
        if frame_id is not None:
            if not isinstance(frame_id, str) or not _FRAME_ID_RE.fullmatch(frame_id):
                raise EditError("a frame id is 12 hex characters")
            existing = next((f for f in self.frames if f.get("id") == frame_id), None)
            if existing is not None:
                if op.get("name") is None or str(existing.get("name")) == str(op["name"]).strip():
                    return {"changed": False, "frame": frame_id}  # sent again
                raise EditError(f"frame {frame_id} is already on this board")
        else:
            frame_id = uuid4().hex[:12]
            while any(f.get("id") == frame_id for f in self.frames):
                frame_id = uuid4().hex[:12]
        if len(self.frames) >= layout.FRAME_LIMIT:
            raise EditError(f"a board has at most {layout.FRAME_LIMIT} frames")
        kind = op.get("kind", "look")
        if kind not in layout.FRAME_KINDS:
            raise EditError(f"kind is {' or '.join(layout.FRAME_KINDS)}")
        if kind == "unsorted" and any(f.get("kind") == "unsorted" for f in self.frames):
            raise EditError("a board has at most one Unsorted frame")
        if op.get("name") is not None:
            name = self._name(op["name"])
        else:
            taken = {str(f.get("name", "")).casefold() for f in self.frames}
            name = "Unsorted" if kind == "unsorted" else next(
                f"Look {n}" for n in range(1, layout.FRAME_LIMIT + 2) if f"look {n}" not in taken)
        rect = self._rect(op, "frame.create's rectangle")
        around: list[tuple[dict[str, Any], dict[str, Any]]] = []
        if op.get("around") is not None:
            if rect is not None:
                raise EditError("frame.create takes a rectangle or around, not both")
            if not isinstance(op["around"], list) or not op["around"]:
                raise EditError("around is a list of cards")
            around = [self.card({"op": "frame.create", "placement": ref}) for ref in op["around"]]
            box = layout.bounds(layout.card_rect(p) for _, p in around)
            assert box is not None
            gap = layout.PLACE_GAP
            w, h = max(layout.FRAME_MIN_SIDE, box[2] + 2 * gap), max(layout.FRAME_MIN_SIDE, box[3] + 2 * gap)
            rect = (round(box[0] - gap), round(box[1] - gap), round(w), round(h))
        if rect is None:
            raise EditError("frame.create needs x, y, w and h (or rect), or around: the cards to frame")
        frame = {"id": frame_id, "name": name, "kind": kind, "x": rect[0], "y": rect[1], "w": rect[2], "h": rect[3],
                 "createdBy": self.by, "namedBy": self.by, "createdAt": self.now}
        self.frames.append(frame)
        if around:
            seen: set[int] = set()
            for img, p in around:
                if id(img) in seen:
                    raise EditError(f"#{self.number(img)} is named twice: a look holds one card of an image")
                seen.add(id(img))
                p["frameId"] = frame_id
        else:
            # Drawing a frame takes in the loose cards wholly inside it (Q6).
            for img in self.images:
                for p in layout.cards_of(img):
                    card = layout.card_rect(p)
                    if p.get("frameId") is None and card and layout.contains(rect, card):
                        p["frameId"] = frame_id
        for img in self.images:
            self.check_cards(img)
        return {"changed": True, "frame": frame_id}

    def op_frame_update(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("frame", "name", "x", "y", "w", "h", "rect"))
        frame = self.frame(op.get("frame"))
        assert frame is not None
        changed = False
        if op.get("name") is not None:
            changed |= self.set(frame, "name", self._name(op["name"], keep=frame))
            if changed:
                frame["namedBy"] = self.by
        raw = op.get("rect") if op.get("rect") is not None else {key: op[key] for key in ("x", "y", "w", "h") if key in op}
        if raw:
            if not isinstance(raw, dict) or set(raw) - {"x", "y", "w", "h"}:
                raise EditError("frame.update's rectangle is {x, y, w, h}")
            new = {key: _coordinate(raw[key], key) if key in raw else frame[key] for key in ("x", "y", "w", "h")}
            if new["w"] < layout.FRAME_MIN_SIDE or new["h"] < layout.FRAME_MIN_SIDE:
                raise EditError(f"a frame's sides are at least {layout.FRAME_MIN_SIDE} px")
            dx, dy = new["x"] - frame["x"], new["y"] - frame["y"]
            members = self.members(frame["id"])
            if dx or dy:
                # Moving a frame moves its cards.
                for _img, p in members:
                    p["x"], p["y"] = _coordinate(p["x"] + dx, "x"), _coordinate(p["y"] + dy, "y")
            box = layout.bounds(layout.card_rect(p) for _img, p in members)
            if box is not None and not layout.contains((new["x"], new["y"], new["w"], new["h"]), box):
                raise EditError(f"{frame['name']} would be smaller than its cards")
            for key, value in new.items():
                changed |= self.set(frame, key, value)
        return {"changed": changed}

    def op_frame_delete(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("frame",))
        ref = op.get("frame")
        frame = self.frame(ref, missing_ok=isinstance(ref, str) and bool(_FRAME_ID_RE.fullmatch(ref)))
        if frame is None:
            return {"changed": False}  # deleted already
        for img, p in self.members(frame["id"]):
            # Its cards stay where they are: a copy goes, a last card is loose.
            if len(layout.cards_of(img)) > 1:
                img["placements"] = [q for q in layout.cards_of(img) if q is not p]
            else:
                p["frameId"] = None
        self.board["frames"] = [f for f in self.frames if f is not frame]
        return {"changed": True}

    def op_frame_merge(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("frame", "into"))
        source, target = self.frame(op.get("frame")), self.frame(op.get("into"))
        assert source is not None and target is not None
        if source is target:
            raise EditError("a frame can't merge into itself")
        moved: list[dict[str, Any]] = []
        for img, p in self.members(source["id"]):
            there = next((q for q in layout.cards_of(img) if q.get("frameId") == target["id"]), None)
            if there is not None and (there.get("weight") or 0) >= (p.get("weight") or 0):
                img["placements"] = [q for q in layout.cards_of(img) if q is not p]  # the heavier copy stays
                continue
            if there is not None:
                img["placements"] = [q for q in layout.cards_of(img) if q is not there]
            p["frameId"] = target["id"]
            moved.append(p)
        box = layout.bounds([layout.card_rect(target), *(layout.card_rect(p) for p in moved)])
        assert box is not None
        target.update({"x": round(box[0]), "y": round(box[1]), "w": round(box[2]), "h": round(box[3])})
        self.board["frames"] = [f for f in self.frames if f is not source]
        return {"changed": True}

    # -- restore
    def op_restore(self, op: dict[str, Any]) -> dict[str, Any]:
        _keys(op, ("slices",))
        slices = op.get("slices")
        if not isinstance(slices, list):
            raise EditError("restore takes slices: a list")
        for index, item in enumerate(slices):
            _check_slice(item, f"slices[{index}]")
        skipped: list[dict[str, Any]] = []
        changed = False
        order = sorted(range(len(slices)), key=lambda i: (_phase(slices[i]), i))
        cards: dict[str, list[dict[str, Any]]] = {}
        put_back: set[str] = set()  # the frames and images this restore changed
        removed: list[str] = []  # the images it took off the board
        for i in order:
            item = slices[i]
            if item["part"] == "card":
                cards.setdefault(item["image"], []).append(item)
                if _phase(item) == 3 and (i == order[-1] or _phase(slices[order[order.index(i) + 1]]) != 3):
                    for image_id, group in cards.items():
                        if self._restore_cards(image_id, group, skipped):
                            changed = True
                            put_back.add(image_id)
                    cards = {}
                continue
            if item["part"] == "fields":
                changed = self._restore_fields(item, skipped) or changed
                continue
            if item["part"] == "settings":
                outcome = self._restore_settings(item, skipped)
            else:
                outcome = self._restore(item)
                if outcome == "skipped":
                    skipped.append(self._skip_report(item))
            if outcome == "applied":
                changed = True
                put_back.add(str(item.get("frame") or item.get("image")))
                if item["part"] == "image" and item.get("before") is None:
                    removed.append(str(item["image"]))
        self._hold_cards(put_back)
        # An image whose settings changed since says so once: its cards,
        # which the same edit rescaled, add nothing to that.
        said = {report.get("image") for report in skipped if report["part"] == "settings"}
        skipped = [report for report in skipped if report["part"] != "card" or report.get("image") not in said]
        return {"changed": changed, "skipped": skipped, "removed": removed}

    def _hold_cards(self, put_back: set[str]) -> None:
        """Each frame a restore touched (its rectangle, or a card in it) grows
        to hold its cards: with one slice put back and another skipped as
        changed since, a frame could otherwise go back smaller than a card
        still in it, which ``frame.update`` refuses."""
        for frame in self.frames:
            members = self.members(frame["id"])
            if frame["id"] not in put_back and not any(str(img.get("id")) in put_back for img, _p in members):
                continue
            rects = [rect for rect in (layout.card_rect(frame), *(layout.card_rect(p) for _img, p in members)) if rect]
            box = layout.bounds(rects)
            if box is not None and box != layout.card_rect(frame):
                frame.update({"x": round(box[0]), "y": round(box[1]), "w": round(box[2]), "h": round(box[3])})

    def _restore_settings(self, item: dict[str, Any], skipped: list[dict[str, Any]]) -> str:
        """Put back one image's settings, each on its own: one that changed
        since is left as it is (and reported), the others go back."""
        img = self.find(str(item["image"]))
        if img is None:
            skipped.append(self._skip_report(item, "removed since"))
            return "skipped"
        stale = [key for key, value in item["before"].items()
                 if img.get(key) != value and img.get(key) != item["expect"][key]]
        back = {key: copy.deepcopy(value) for key, value in item["before"].items()
                if img.get(key) != value and key not in stale}
        if stale:
            report = self._skip_report(item)
            words = " and ".join(SETTING_LABELS[key] for key in stale)
            report.update({"settings": stale, "message": f"#{report['number']}'s {words} changed since, left as is"
                           if "number" in report else f"An image's {words} changed since, left as is"})
            skipped.append(report)
        if not back:
            return "skipped" if stale else "unchanged"
        img.update(back)
        return "applied"

    def _restore_fields(self, item: dict[str, Any], skipped: list[dict[str, Any]]) -> bool:
        """Put back the board's own fields, each on its own, as a PUT sets
        them (moodboard_store.apply_fields): one that changed since is left
        as it is, and so is one only the person may set this way (turning
        Send notes on, the person's own brief) when an agent undoes. Each is
        judged by the board as the restore found it, and one whose going
        back would also undo a colour choice made since (a pin back on
        drops a Keep anyway colour) is left as is too."""
        from services import moodboard_store as store

        by = self.by if self.by in store.OVERRIDE_AUTHORS else "agent"
        found = {key: field_value(self.board, key) for key in {*item["before"], "colorChoices"}}
        # colorChoices goes back in this slice, from what the call saved, so
        # a pin taking a Keep anyway colour off it is put right after.
        choices_back = ("colorChoices" in item["before"]
                        and found["colorChoices"] in (item["before"]["colorChoices"], item["expect"]["colorChoices"]))
        changed = False
        for key in sorted(item["before"], key=FIELD_KEYS.index):
            before, expect = item["before"][key], item["expect"][key]
            if found[key] not in (before, expect):
                skipped.append(self._field_skip(key, "changed since"))
                continue
            if field_value(self.board, key) == before:
                continue
            held = {name: copy.deepcopy(self.board[name]) for name in ("pinnedColors", "colorChoices")
                    if name in self.board}
            try:
                store.apply_fields(self.board, {key: {"text": before} if key == "briefOverride" else before}, by=by)
            except (store.BriefOverrideProtected, store.NotesOptInProtected):
                skipped.append(self._field_skip(key, "is the person's to turn on" if key == "sendNotes"
                                                else "is the person's to change"))
                continue
            except ValueError:
                # Checked up front, so only the board as it is now can refuse it
                # (a Keep anyway colour pinned out since).
                skipped.append(self._field_skip(key, "can't go back"))
                continue
            if (key != "colorChoices" and not choices_back
                    and field_value(self.board, "colorChoices") != found["colorChoices"]):
                for name in ("pinnedColors", "colorChoices"):
                    self.board.pop(name, None)
                self.board.update(held)
                skipped.append(self._field_skip(key, "would undo a colour choice made since"))
                continue
            changed = True
        return changed

    @staticmethod
    def _field_skip(key: str, reason: str) -> dict[str, Any]:
        return {"part": "fields", "field": key, "reason": reason,
                "message": f"{FIELD_LABELS[key]} {reason}, left as is"}

    def _skip_report(self, item: dict[str, Any], reason: str = "changed since") -> dict[str, Any]:
        report: dict[str, Any] = {"part": item["part"]}
        if item.get("image") is not None:
            image_id = str(item["image"])
            report["image"] = image_id
            img = self.find(image_id)
            if img is not None:
                report["number"] = self.number(img)
            elif image_id in self.numbers:
                report["number"] = self.numbers.index(image_id) + 1
            label = f"#{report['number']}" if "number" in report else "An image"
        else:
            report["frame"] = item.get("frame")
            label = self.frame_label(item.get("frame"))
        report["reason"] = reason
        report["message"] = f"{label} {reason}, left as is"
        return report

    def _restore(self, item: dict[str, Any]) -> str:
        """Put one slice back: "applied", "unchanged" (already as it was) or "skipped"."""
        part = item["part"]
        before, expect = item.get("before"), item.get("expect")
        if part == "frame":
            current = next((f for f in self.frames if f.get("id") == item["frame"]), None)
            if current == before:
                return "unchanged"
            if current != expect:
                return "skipped"
            if before is None:
                if self.members(item["frame"]):
                    return "skipped"
                self.board["frames"] = [f for f in self.frames if f is not current]
            elif current is None:
                if any(str(f.get("name", "")).casefold() == str(before.get("name", "")).casefold() for f in self.frames):
                    return "skipped"
                self.frames.insert(max(0, min(int(item.get("index") or 0), len(self.frames))), copy.deepcopy(before))
            else:
                current.clear()
                current.update(copy.deepcopy(before))
            return "applied"
        if part == "image":
            current = self.find(str(item["image"]))
            if current == before:
                return "unchanged"
            if current != expect:
                return "skipped"
            if before is None:
                self.board["images"] = [img for img in self.images if img is not current]
                return "applied"
            record = copy.deepcopy(before)
            frames = {f["id"] for f in self.frames}
            taken = self.placement_ids() - {str(p.get("id")) for p in layout.cards_of(current)}
            if any(p.get("frameId") not in (None, *frames) or str(p.get("id")) in taken
                   for p in layout.cards_of(record)):
                return "skipped"
            if current is None:
                self.images.insert(max(0, min(int(item.get("index") or 0), len(self.images))), record)
            else:
                self.images[self.images.index(current)] = record
            return "applied"
        raise AssertionError(f"no restore for a {part} slice here")

    def _restore_cards(self, image_id: str, group: list[dict[str, Any]], skipped: list[dict[str, Any]]) -> bool:
        """Put back one image's card slices together, then check its cards:
        a merge's undo moves one copy out of a look and another in, which only
        holds once both are back."""
        img = self.find(image_id)
        if img is None:
            skipped.extend(self._skip_report(item, "removed since") for item in group)
            return False
        saved = copy.deepcopy(img.get("placements"))
        applied: list[dict[str, Any]] = []
        for item in group:
            cards = layout.cards_of(img)
            current = next((p for p in cards if p.get("id") == item["placement"]), None)
            if current == item.get("before"):
                continue
            if current != item.get("expect"):
                skipped.append(self._skip_report(item))
                continue
            if item.get("before") is None:
                img["placements"] = [p for p in cards if p is not current]
            elif current is None:
                img["placements"] = [*cards, copy.deepcopy(item["before"])]
            else:
                current.clear()
                current.update(copy.deepcopy(item["before"]))
            applied.append(item)
        if not applied:
            return False
        frames = {f["id"] for f in self.frames}
        taken = {str(p.get("id")) for other in self.images if other is not img for p in layout.cards_of(other)}
        try:
            layout.check_image_placements([img], frames)
            if any(str(p.get("id")) in taken for p in layout.cards_of(img)):
                raise ValueError("a card id is taken")
        except ValueError:
            img["placements"] = saved
            skipped.extend(self._skip_report(item, "can't go back there") for item in applied)
            return False
        return True


def _check_slice(item: Any, label: str) -> None:
    if not isinstance(item, dict) or item.get("part") not in SLICE_PARTS:
        raise EditError(f"{label}.part must be one of {', '.join(SLICE_PARTS)}")
    part = item["part"]
    if part == "fields":
        _check_fields_slice(item, label)
        return
    needs = {"frame": ("frame",), "image": ("image",), "settings": ("image",), "card": ("image", "placement")}[part]
    for key in needs:
        if not isinstance(item.get(key), str) or not item[key]:
            raise EditError(f"{label} ({part}) needs {key}")
    for key in ("before", "expect"):
        if key not in item:
            raise EditError(f"{label} needs before and expect")
        value = item[key]
        if part == "settings":
            if not isinstance(value, dict) or set(value) - set(SETTING_KEYS) or not value:
                raise EditError(f"{label}: a settings slice holds {', '.join(SETTING_KEYS)}")
        elif value is not None and not isinstance(value, dict):
            raise EditError(f"{label}.{key} must be an object or null")
    if part == "settings" and set(item["before"]) != set(item["expect"]):
        raise EditError(f"{label}: before and expect name the same settings")
    if "index" in item and (isinstance(item["index"], bool) or not isinstance(item["index"], int)):
        raise EditError(f"{label}.index must be a whole number")
    before = item["before"]
    if before is None:
        return
    # What goes back is checked as the ops and a PUT check it, so a restore
    # can't save a board that a later op or the analysis would choke on.
    own = {"frame": ("id", "frame"), "image": ("id", "image"), "card": ("id", "placement")}.get(part)
    if own and str(before.get(own[0])) != item[own[1]]:
        raise EditError(f"{label}.before is another {part} than the one it names")
    if part == "image":
        if not isinstance(before.get("url"), str) or not before["url"].strip():
            raise EditError(f"{label}.before needs a url")
        if before.get("placements") is not None and not isinstance(before["placements"], list):
            raise EditError(f"{label}.before.placements must be a list")
    if part in ("image", "settings"):
        _check_settings(before, f"{label}.before")


def _check_fields_slice(item: dict[str, Any], label: str) -> None:
    """A ``fields`` slice: the same board fields in ``before`` and
    ``expect``, and a ``before`` a PUT would take."""
    from services import moodboard_brief as brief
    from services.moodboard_store import _VALID_MODES

    for key in ("before", "expect"):
        value = item.get(key)
        if not isinstance(value, dict) or not value or set(value) - set(FIELD_KEYS):
            raise EditError(f"{label}: a fields slice holds {', '.join(FIELD_KEYS)}")
    if set(item["before"]) != set(item["expect"]):
        raise EditError(f"{label}: before and expect name the same fields")
    for key, value in item["before"].items():
        where = f"{label}.before.{key}"
        try:
            if key == "name" and (not isinstance(value, str) or not value.strip()):
                raise ValueError("a board needs a name")
            if key == "notes" and not isinstance(value, str):
                raise ValueError("must be text")
            if key == "mode" and value not in _VALID_MODES:
                raise ValueError(f"must be one of {', '.join(sorted(_VALID_MODES))}")
            if key == "strength":
                _unit(value, where)
            if key == "direction" and not isinstance(value, str):
                raise ValueError("must be text")
            if key in ("direction", "avoid", "pinnedColors", "clashMode", "colorChoices", "sendNotes"):
                {"direction": brief.normalize_direction, "avoid": brief.normalize_avoid,
                 "pinnedColors": brief.normalize_pinned_colors, "clashMode": brief.normalize_clash_mode,
                 "colorChoices": brief.normalize_color_choices, "sendNotes": brief.normalize_send_notes}[key](value)
            if key in ("clashMode", "sendNotes") and value is None:
                raise ValueError("can't be null")
            if key == "briefOverride":
                if not isinstance(value, str):
                    raise ValueError("is the brief's text (\"\" for none)")
                brief.normalize_override_text(value)
        except EditError:
            raise
        except ValueError as exc:
            raise EditError(f"{where}: {exc}") from None


def field_value(board: dict[str, Any], key: str) -> Any:
    """A board field as a write reads it, to tell whether it changed: the
    brief fields normalized (a board without them reads as their defaults),
    the hand-written brief as its text ("" for none)."""
    from services import moodboard_brief as brief

    if key in ("direction", "avoid", "pinnedColors"):
        return brief.board_fields(board)[("direction", "avoid", "pinnedColors").index(key)]
    if key in ("clashMode", "colorChoices"):
        return brief.board_options(board)[("clashMode", "colorChoices").index(key)]
    if key == "sendNotes":
        return board.get("sendNotes") is True
    if key == "briefOverride":
        saved = board.get("briefOverride")
        return str(saved.get("text") or "").strip() if isinstance(saved, dict) else ""
    return copy.deepcopy(board.get(key))


def fields_slice(before: dict[str, Any], after: dict[str, Any],
                 keys: Iterable[str] = FIELD_KEYS) -> dict[str, Any] | None:
    """The ``fields`` slice that puts back ``keys`` that differ from
    ``before`` to ``after`` (None when none do)."""
    changed = [key for key in keys if field_value(before, key) != field_value(after, key)]
    if not changed:
        return None
    return {"part": "fields", "before": {key: field_value(before, key) for key in changed},
            "expect": {key: field_value(after, key) for key in changed}}


def _check_settings(values: dict[str, Any], label: str) -> None:
    """An image's settings as the store saves them (moodboard_store._normalize_images)."""
    from services.moodboard_store import PRIVATE_NOTE_LIMIT

    if "weight" in values:
        _unit(values["weight"], f"{label}.weight")
    if "excluded" in values and not isinstance(values["excluded"], bool):
        raise EditError(f"{label}.excluded must be true or false")
    for key in ("notes", "privateNote"):
        if key in values:
            _text(values[key], f"{label}.{key}")
    if len(values.get("privateNote") or "") > PRIVATE_NOTE_LIMIT:
        raise EditError(f"{label}.privateNote is longer than {PRIVATE_NOTE_LIMIT} characters")


def _phase(item: dict[str, Any]) -> int:
    """The order slices go back in: frames that come back first, then images
    that come back, settings, cards, images that go, frames that go, and
    the board's fields last (a hand-written brief is stamped with the board
    as it ends up)."""
    part, before = item["part"], item.get("before")
    if part == "fields":
        return 6
    if part == "frame":
        return 0 if before is not None else 5
    if part == "image":
        return 1 if before is not None else 4
    return 2 if part == "settings" else 3


# -- the difference between two boards -------------------------------------------

def _images_by_id(board: dict[str, Any]) -> dict[str, tuple[int, dict[str, Any]]]:
    return {str(img.get("id")): (index, img) for index, img in enumerate(board.get("images") or [])
            if isinstance(img, dict)}


def _setting(img: dict[str, Any], key: str) -> Any:
    value = img.get(key)
    return SETTING_DEFAULTS[key] if value is None else value


def diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """What changed from ``before`` to ``after``: the slices that undo it,
    the ids it touched and what the journal says (kinds and the images
    named). Images, their cards, the frames and the board's own fields (a
    ``fields`` slice); of those, only the board's notes are journaled."""
    old, new = _images_by_id(before), _images_by_id(after)
    slices: list[dict[str, Any]] = []
    touched_images: list[str] = []
    kinds: dict[str, list[str]] = {}
    private: list[str] = []

    def note(kind: str, image_id: str) -> None:
        refs = kinds.setdefault(kind, [])
        if image_id not in refs:
            refs.append(image_id)
        if image_id not in touched_images:
            touched_images.append(image_id)

    for image_id, (index, img) in new.items():
        if image_id not in old:
            slices.append({"part": "image", "image": image_id, "index": index, "before": None,
                           "expect": copy.deepcopy(img)})
            note("added", image_id)
    for image_id, (index, img) in old.items():
        if image_id not in new:
            slices.append({"part": "image", "image": image_id, "index": index, "before": copy.deepcopy(img),
                           "expect": None})
            note("removed", image_id)
    for image_id, (_index, img) in new.items():
        if image_id not in old:
            continue
        was = old[image_id][1]
        changed = [key for key in SETTING_KEYS if _setting(was, key) != _setting(img, key)]
        if changed:
            slices.append({"part": "settings", "image": image_id,
                           "before": {key: copy.deepcopy(was.get(key)) for key in changed},
                           "expect": {key: copy.deepcopy(img.get(key)) for key in changed}})
            for key in changed:
                note({"weight": "resized", "excluded": "setAside", "notes": "noted", "privateNote": "noted"}[key],
                     image_id)
            if "privateNote" in changed:
                private.append(image_id)
        old_cards = {str(p.get("id")): p for p in layout.cards_of(was)}
        new_cards = {str(p.get("id")): p for p in layout.cards_of(img)}
        for pid in [*new_cards, *(pid for pid in old_cards if pid not in new_cards)]:
            a, b = old_cards.get(pid), new_cards.get(pid)
            if a == b:
                continue
            slices.append({"part": "card", "image": image_id, "placement": pid, "before": copy.deepcopy(a),
                           "expect": copy.deepcopy(b)})
            if a is None or b is None or a.get("frameId") != b.get("frameId"):
                note("grouped", image_id)
                continue
            if any(a.get(key) != b.get(key) for key in ("w", "h", "weight")):
                note("resized", image_id)
            if math.hypot(_delta(a, b, "x"), _delta(a, b, "y")) >= MOVE_THRESHOLD_PX:
                note("moved", image_id)
            elif image_id not in touched_images:
                touched_images.append(image_id)  # a nudge: touched, not worth a journal line

    old_frames = {str(f.get("id")): (i, f) for i, f in enumerate(layout.frames_of(before))}
    new_frames = {str(f.get("id")): (i, f) for i, f in enumerate(layout.frames_of(after))}
    touched_frames: list[str] = []
    for frame_id in [*new_frames, *(fid for fid in old_frames if fid not in new_frames)]:
        a, b = old_frames.get(frame_id), new_frames.get(frame_id)
        if (a and a[1]) == (b and b[1]):
            continue
        slices.append({"part": "frame", "frame": frame_id, "index": (a or b)[0],
                       "before": copy.deepcopy(a[1]) if a else None, "expect": copy.deepcopy(b[1]) if b else None})
        touched_frames.append(frame_id)
    if touched_frames:
        kinds.setdefault("frame", [])
    if before.get("notes") != after.get("notes") and "notes" in after:
        kinds.setdefault("noted", [])
    fields = fields_slice(before, after)
    if fields is not None:
        slices.append(fields)

    slices.sort(key=_phase)
    return {"slices": slices, "touched": {"images": touched_images, "frames": touched_frames, "looks": []},
            "kinds": kinds, "private": private}


def holds_private_note(undo: Any) -> bool:
    """Whether an ``undo`` carries private-note text: a settings slice that
    names it, or an image record with one."""
    ops = undo.get("ops") if isinstance(undo, dict) else None
    slices = [item for op in ops or [] if isinstance(op, dict) for item in op.get("slices") or []
              if isinstance(item, dict)]
    for item in slices:
        for value in (item.get("before"), item.get("expect")):
            if isinstance(value, dict) and (("privateNote" in value) if item.get("part") == "settings"
                                            else item.get("part") == "image" and bool(value.get("privateNote"))):
                return True
    return False


def _delta(a: dict[str, Any], b: dict[str, Any], key: str) -> float:
    try:
        return float(b.get(key) or 0) - float(a.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def steering(board: dict[str, Any]) -> list[tuple[Any, ...]]:
    """What the whole-board analysis reads of each image, in order."""
    return [tuple(img.get(key) for key in STEERING_KEYS) for img in board.get("images") or [] if isinstance(img, dict)]


# -- the journal's words ----------------------------------------------------------

# One event per batch: the kind of the most telling change, the rest in data.kinds.
KIND_ORDER = ("added", "removed", "frame", "grouped", "setAside", "resized", "noted", "moved")


# A board's name in a summary is cut to this many characters.
MAX_BOARD_NAME_CHARS = 60


def board_where(board: Mapping[str, Any] | None, *fallbacks: Mapping[str, Any] | None) -> str:
    """"board Dusk": how a board is named in the journal's summaries and in
    the Agent log's lines (services/moodboard_actions), so the two never name
    one board two ways. The first of ``board`` and ``fallbacks`` with a name
    (a deleted board's record, the board before a rename), else its id."""
    boards = [item for item in (board, *fallbacks) if item]
    name = next((str(item["name"]) for item in boards if item.get("name")), None)
    if name is None:
        name = next((str(item["id"]) for item in boards if item.get("id")), "Untitled board")
    name = " ".join(name.split())
    if len(name) > MAX_BOARD_NAME_CHARS:
        name = name[: MAX_BOARD_NAME_CHARS - 1].rstrip() + "…"
    return f"board {name}"


def journal_entry(changes: dict[str, Any], before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any] | None:
    """The journal event for a change (``diff``'s), or None when nothing worth
    journaling changed (a move under 8 px, a rename). Never any note text:
    a private note changed is "private note changed"."""
    kinds = [kind for kind in KIND_ORDER if kind in changes["kinds"]]
    if not kinds:
        return None
    old, new = _images_by_id(before), _images_by_id(after)
    named: list[str] = []
    for kind in kinds:
        named += [image_id for image_id in changes["kinds"][kind] if image_id not in named]

    def number(image_id: str) -> int | None:
        index = new.get(image_id, old.get(image_id, (None, None)))[0]
        return None if index is None else index + 1

    refs = [{"number": number(image_id), "id": image_id} for image_id in named]
    listed = _listed([f"#{ref['number']}" for ref in refs if ref["number"]])
    kind = kinds[0]
    where = board_where(after, before)
    if kind == "added":
        summary = f"added {listed} to {where}"
    elif kind == "removed":
        summary = f"removed {listed} from {where}"
    elif kind == "frame":
        summary = f"changed the frames on {where}"
    elif kind == "grouped":
        summary = f"changed the looks {listed} is in on {where}"
    elif kind == "setAside":
        ids = changes["kinds"]["setAside"]
        states = {bool((new.get(image_id) or (0, {}))[1].get("excluded")) for image_id in ids}
        verb = "set aside" if states == {True} else "used again" if states == {False} else "switched Set aside on"
        summary = f"{verb} {_listed([f'#{number(i)}' for i in ids])} on {where}"
    elif kind == "resized":
        summary = f"resized {listed} on {where}"
    elif kind == "noted":
        noted = changes["kinds"]["noted"]
        if not noted:
            summary = f"changed the notes of {where}"
        elif all(image_id in changes["private"] for image_id in noted):
            summary = f"private note changed on {_listed([f'#{number(i)}' for i in noted])} on {where}"
        else:
            summary = f"changed the notes on {_listed([f'#{number(i)}' for i in noted])} on {where}"
    else:
        summary = f"moved {listed} on {where}"
    if changes["private"] and "private note changed" not in summary:
        summary += " (private note changed)"
    return {"kind": f"board.{kind}", "kinds": [f"board.{k}" for k in kinds], "refs": refs[:50],
            "summary": summary}


def _listed(items: list[str], limit: int = 6) -> str:
    shown = ", ".join(items[:limit])
    return shown + (f" and {len(items) - limit} more" if len(items) > limit else "")


# -- one batch --------------------------------------------------------------------

def parse_ops(raw: Any) -> list[dict[str, Any]]:
    """The batch's ops, shaped (each is checked against the board as it applies)."""
    if not isinstance(raw, list) or not raw:
        raise EditError("ops must be a list of 1 to 500 ops")
    if len(raw) > MAX_OPS:
        raise EditError(f"a batch holds at most {MAX_OPS} ops (got {len(raw)}); send it in parts")
    return raw


def apply_edits(board: dict[str, Any], ops: Any, *, by: str, now: str | None = None) -> EditResult:
    """``ops`` staged on a copy of ``board`` (laid out, as the store reads
    it). Raises EditError naming the op that failed; ``board`` is never
    changed. ``by`` ("person", "agent" or "analyze") stamps new cards and
    frames."""
    ops = parse_ops(ops)
    staged = copy.deepcopy(board)
    staged["images"] = [img for img in staged.get("images") or [] if isinstance(img, dict)]
    staged["frames"] = layout.frames_of(staged)
    batch = _Batch(staged, by=by, now=now or _now_iso())
    applied: list[dict[str, Any]] = []
    for index, op in enumerate(ops):
        name = op.get("op") if isinstance(op, dict) else None
        try:
            entry = batch.apply(op)
        except EditError as exc:
            raise EditError(f"ops[{index}] ({str(name)[:40]}): {exc}") from None
        applied.append({"index": index, **entry})
    try:
        layout.check_frames(staged["frames"])
        layout.check_image_placements(staged["images"], {f["id"] for f in staged["frames"]})
    except ValueError as exc:
        raise EditError(f"the board after these ops: {exc}") from None
    changes = diff(board, staged)
    changed = bool(changes["slices"])
    if changed:
        staged["thumbnail"] = staged["images"][0]["url"] if staged["images"] else ""
        if steering(board) != steering(staged) or any(board.get(key) != staged.get(key) for key in STEERING_FIELDS):
            staged["analysis"] = None
    undo = {"ops": [{"op": "restore", "slices": changes["slices"]}]} if changed else {"ops": []}
    if not changed:
        for entry in applied:
            entry["status"] = "unchanged"
    return EditResult(board=staged if changed else board, applied=applied, undo=undo, changed=changed,
                      touched=changes["touched"], changes=changes)


__all__ = ["EditError", "EditResult", "FIELD_KEYS", "MAX_OPS", "OPS", "UNDO_BROADCAST_LIMIT", "apply_edits",
           "board_where", "clean_say", "diff", "field_value", "fields_slice", "holds_private_note", "journal_entry",
           "parse_ops", "steering"]
