"""A file param's preview and name follow the file (GM r46 Q2 on #222).

The canvas shows a file param through two private params it writes with
the file: ``_previewUrl`` (the image drawn under the control) and, for
``filePath``, ``_fileName`` (the name it was uploaded with,
services/input_file_name.py). Agents can't write either (agent_params.py),
so an agent that sets the file itself (MCP edit_canvas, ``nebula set``,
/api/graph/apply, the REST param route) left the old upload's preview
showing while a run read the new file.

``follow_file_params`` is applied to every partial params write. When it
changes a file param and leaves ``_previewUrl`` out, the preview follows
the new file: its served URL when Nebula holds the file, else it is
cleared (the canvas then shows "No preview"). A changed ``filePath`` whose
write leaves ``_fileName`` out drops the old name: the canvas then shows
the path's own base name, and agents' reads (look_at_canvas's
``fileName``) name nothing stale. A write that carries those fields (the
canvas's own upload) is kept as sent.
"""
from __future__ import annotations

from typing import Any, Callable, Mapping

from services.input_file_name import PARAM as FILE_NAME_PARAM
from services.node_route import all_param_definitions

PREVIEW_PARAM = "_previewUrl"


def file_param_keys(definition: Mapping[str, Any] | None) -> list[str]:
    """The keys of a definition's ``file`` params, in declared order."""
    if not definition:
        return []
    return [str(param["key"]) for param in all_param_definitions(definition) if param.get("type") == "file"]


def follow_file_params(definition: Mapping[str, Any] | None, before: Mapping[str, Any], update: Mapping[str, Any],
                       preview_url: Callable[[Any], str | None]) -> tuple[dict[str, Any], list[str]]:
    """``update`` with the preview (and name) following a changed file param,
    and the keys to drop from the node's params after it is merged."""
    out = dict(update)
    changed = [key for key in file_param_keys(definition) if key in update and update[key] != before.get(key)]
    if not changed:
        return out, []
    drop: list[str] = []
    if PREVIEW_PARAM not in update:
        url = preview_url(update[changed[-1]])
        if url:
            out[PREVIEW_PARAM] = url
        elif PREVIEW_PARAM in before:
            drop.append(PREVIEW_PARAM)
    if "filePath" in changed and FILE_NAME_PARAM not in update and FILE_NAME_PARAM in before:
        drop.append(FILE_NAME_PARAM)
    return out, drop
