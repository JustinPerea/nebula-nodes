"""A universal node's ports, worked out from its model.

The OpenRouter, Nous Portal and Replicate nodes have no fixed ports: an
OpenRouter vision model takes `images`, an image model outputs `image`, a
Replicate model's file inputs are its ports. This module is the one place
those rules live. The canvas's model pickers ask the backend for them
(POST /api/graph/node/{id}/model), an agent's edit that sets `model` /
`model_id` runs them (main._stage_proposal), and the canvas export and the
wire checks read the result back (port_contracts.node_ports).

What a node keeps: configuring writes canvas-owned (``_``) params, the same
ones the picker always wrote (`_output_image`; `_version_id` and
`_schema_fetched` and the schema's defaults for Replicate) plus
``_model_ports``: the ports, stamped with the model they belong to. A saved
node without it (anything configured before 2026-10-20) keeps its
definition's ports, as it always had; one whose model no longer matches the
stamp does too, until it is configured again.

The rules are the pickers' (graphStore's configureOpenRouterModel and
fetchReplicateSchemaAndConfigure on main 23f11b8e; pinned by
contracts/fixtures/universal-ports/picker-cases.json), with two changes: a
Replicate model whose output is a list of plain strings has a Text `text`
output, as its run names it, where the picker drew an Image `image` port;
and a Replicate file output is typed from the model's own metadata (its
schema's content hints, else its example run's file) as `video`, `audio`,
`image`, `svg` or `mesh`, where the picker called every file `image`
(2026-10-21; replicate_output). The run fills that port
(handlers/replicate_universal.py).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Mapping

from services.media_types import MEDIA_PORT_IDS, media_named_in_text, media_of_extension, media_of_mime, media_of_value

MODEL_PARAM: dict[str, str] = {
    "openrouter-universal": "model",
    "nous-portal-universal": "model",
    "replicate-universal": "model_id",
}
PROVIDER: dict[str, str] = {
    "openrouter-universal": "openrouter",
    "nous-portal-universal": "nous",
    "replicate-universal": "replicate",
}
PROVIDER_NAME = {"openrouter": "OpenRouter", "nous": "Nous Portal", "replicate": "Replicate"}
PORTS_PARAM = "_model_ports"
# The stamp's revision. 2 (2026-10-21): a Replicate file output is typed from
# the model's metadata. A Replicate stamp without it (written 2026-10-20 by
# #132) called every file output Image `image`; untyped_output_stamp.
PORTS_REV = 2
# The canvas-owned params configuring writes, per node. A model change drops
# the old model's values when the new model can't be read.
DERIVED_PARAMS: dict[str, tuple[str, ...]] = {
    "openrouter-universal": (PORTS_PARAM, "_output_image"),
    "nous-portal-universal": (PORTS_PARAM, "_output_image"),
    "replicate-universal": (PORTS_PARAM, "_version_id", "_schema_fetched"),
}
REPLICATE_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}")
_MAX_PORTS = 64


@dataclass(frozen=True)
class Configured:
    """A node configured for one model: its params and what the canvas draws."""

    params: dict[str, Any]
    inputs: list[dict[str, Any]]
    outputs: list[dict[str, Any]]
    # Replicate's non-file inputs, as the Inspector's controls (the canvas's
    # DynamicParamDefinition); [] for OpenRouter and Nous.
    dynamic_params: list[dict[str, Any]] = field(default_factory=list)
    # Merged into the canvas's providerMeta (Replicate: version_id, description).
    provider_meta: dict[str, Any] = field(default_factory=dict)


def is_universal(definition_id: str) -> bool:
    return definition_id in MODEL_PARAM


def model_of(definition_id: str, params: Mapping[str, Any] | None) -> str:
    key = MODEL_PARAM.get(definition_id)
    value = params.get(key) if key and isinstance(params, Mapping) else None
    return value.strip() if isinstance(value, str) else ""


# -- the rules ---------------------------------------------------------------

def _modalities(row: Mapping[str, Any], key: str) -> list[Any]:
    # The picker read `model.input_modalities || ['text']`: only a missing
    # value falls back, an empty list stays empty.
    value = row.get(key)
    if value is None or value is False or value == "" or value == 0:
        return ["text"]
    return list(value) if isinstance(value, (list, tuple)) else ["text"]


def modality_ports(row: Mapping[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """An OpenRouter or Nous Portal model's ports from its catalog row."""
    inputs_in = _modalities(row, "input_modalities")
    outputs_in = _modalities(row, "output_modalities")
    inputs: list[dict[str, Any]] = [{"id": "messages", "label": "Messages", "dataType": "Text", "required": True}]
    if "image" in inputs_in:
        inputs.append({"id": "images", "label": "Images", "dataType": "Image", "required": False, "multiple": True})
    outputs: list[dict[str, Any]] = []
    if "text" in outputs_in:
        outputs.append({"id": "text", "label": "Text", "dataType": "Text", "required": False})
    if "image" in outputs_in:
        outputs.append({"id": "image", "label": "Image", "dataType": "Image", "required": False})
    return inputs, outputs


def _title(key: str) -> str:
    """A Replicate file input's port label, in the Title Case every other
    port label uses ("input_image" → "Input Image")."""
    return re.sub(r"\b\w", lambda match: match.group(0).upper(), key.replace("_", " "), flags=re.ASCII)


def setting_label(key: str) -> str:
    """A universal node's provider setting as the Inspector and an agent's
    cursor name it (GM, PR #198 r1 item 7): the key in sentence case,
    "guidance_scale" → "Guidance scale". The frontend's twin is
    lib/universalSettingLabel.ts."""
    words = key.replace("_", " ")
    return words[:1].upper() + words[1:]


def replicate_inputs(schema: Mapping[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """A Replicate model's ports (file inputs: `x-uploadable` or a `uri`
    string) and params (every other input), in the schema's order."""
    input_schema = schema.get("input_schema") if isinstance(schema.get("input_schema"), Mapping) else {}
    properties = input_schema.get("properties") if isinstance(input_schema.get("properties"), Mapping) else {}
    required_raw = input_schema.get("required")
    required = set(required_raw) if isinstance(required_raw, list) else set()
    ports: list[dict[str, Any]] = []
    params: list[dict[str, Any]] = []
    for key, prop in properties.items():
        if not isinstance(key, str) or not isinstance(prop, Mapping):
            continue
        if prop.get("x-uploadable") is True or prop.get("format") == "uri":
            ports.append({"id": key, "label": _title(key), "dataType": "Image", "required": key in required})
            continue
        kind = prop.get("type")
        param_type = ("integer" if kind == "integer" else "float" if kind == "number"
                      else "boolean" if kind == "boolean" else "enum" if prop.get("enum") else "string")
        description = prop.get("description") if isinstance(prop.get("description"), str) else ""
        param: dict[str, Any] = {"key": key, "label": setting_label(key), "type": param_type, "required": key in required}
        if "default" in prop:
            param["default"] = prop["default"]
        param["placeholder"] = description[:80]
        if prop.get("enum"):
            param["options"] = [{"label": _js_string(value), "value": value} for value in prop["enum"]]
        if "minimum" in prop:
            param["min"] = prop["minimum"]
        if "maximum" in prop:
            param["max"] = prop["maximum"]
        params.append(param)
    return ports, params


def _js_string(value: Any) -> str:
    if value is True or value is False:
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _hinted_media(node: Mapping[str, Any]) -> str | None:
    """A media type one output-schema node states: `contentMediaType`, an
    `x-` hint holding a MIME type or extension, or a MIME type / extension
    written in its description or title. Not words alone."""
    hint = node.get("contentMediaType")
    if isinstance(hint, str) and media_of_mime(hint):
        return media_of_mime(hint)
    for key, value in node.items():
        if isinstance(key, str) and key.startswith("x-") and isinstance(value, str):
            found = media_of_mime(value) or (media_of_extension(value) if len(value) <= 6 else None)
            if found:
                return found
    for key in ("description", "title"):
        found = media_named_in_text(node.get(key))
        if found:
            return found
    return None


def _example_media(example: Any) -> str | None:
    """The media type of the file the model's example run returned (a URL's
    extension, a data: URI's MIME type; a list by its first file)."""
    values = example if isinstance(example, list) else [example]
    return next((found for found in map(media_of_value, values) if found), None)


def replicate_file_media(schema: Mapping[str, Any]) -> tuple[str, str | None]:
    """(media type, where it was read) for a Replicate model whose output is a
    file or a list of files: "schema" (a content hint), "example" (the
    model's `default_example` output, which the schema route keeps), or None
    when nothing says, and the file is taken to be an Image, unconfirmed."""
    output = schema.get("output_schema") if isinstance(schema.get("output_schema"), Mapping) else {}
    items = output.get("items") if isinstance(output.get("items"), Mapping) else {}
    found = _hinted_media(items) or _hinted_media(output)
    if found:
        return found, "schema"
    found = _example_media(schema.get("default_example_output"))
    if found:
        return found, "example"
    return "Image", None


# Output-schema keys that say what a model returns; a schema with none of
# them (no Output component at all, or only a title) says nothing.
_SAYS_WHAT = ("type", "anyOf", "oneOf", "allOf", "$ref", "properties", "items", "enum", "const")


def replicate_output(schema: Mapping[str, Any]) -> dict[str, Any]:
    """The port a Replicate model's run fills. A file URL, or a list of them,
    is typed from the model's metadata (replicate_file_media): `video`,
    `audio`, `image`, `svg` or `mesh`, with `typeUnconfirmed` when nothing
    said (then `image`, as before). Anything else (text, a list of plain
    strings, an object) is `text`. An output schema that says nothing is
    typed by the model's example run's file when there is one, else `text`
    marked `typeUnconfirmed` (a run that returns a file keeps it under that
    file's own port: handlers/replicate_universal._fill_declared_port)."""
    output = schema.get("output_schema") if isinstance(schema.get("output_schema"), Mapping) else {}
    items = output.get("items") if isinstance(output.get("items"), Mapping) else {}
    is_file = (output.get("type") == "string" and output.get("format") == "uri") or (
        output.get("type") == "array" and items.get("format") == "uri")
    if is_file:
        media, source = replicate_file_media(schema)
        port: dict[str, Any] = {"id": MEDIA_PORT_IDS[media], "label": "Output", "dataType": media, "required": False}
        if source is None:
            port["typeUnconfirmed"] = True
        return port
    text: dict[str, Any] = {"id": "text", "label": "Output", "dataType": "Text", "required": False}
    if not any(key in output for key in _SAYS_WHAT):
        media = _example_media(schema.get("default_example_output"))
        if media:
            return {"id": MEDIA_PORT_IDS[media], "label": "Output", "dataType": media, "required": False}
        text["typeUnconfirmed"] = True
    return text


def unconfirmed_note(model: str, outputs: list[dict[str, Any]]) -> str | None:
    """What to tell an agent when a port's type is a guess (model_schema's
    `note`, an edit's `modelPortNotes`, look_at_canvas, `nebula apply`)."""
    guessed = [port for port in outputs if isinstance(port, Mapping) and port.get("typeUnconfirmed")]
    if not guessed:
        return None
    port = guessed[0]
    port_id = port.get("id")
    what = ("what it returns (no output schema, no example run)" if port.get("dataType") == "Text" else
            "what file it returns (no content hint in its output schema, no example run)")
    return (f"Replicate's data for {model} doesn't say {what}, so its output `{port_id}` is typed "
            f"{port.get('dataType')}, unconfirmed (`typeUnconfirmed`). A run that returns a file of another "
            f"type keeps it under that type's own port (`video`, `audio`, ...), which this node doesn't declare, "
            f"so a connection on `{port_id}` gets nothing then. Nebula doesn't guess the type from the model's name.")


def stale_note(model: str) -> str:
    """What to tell an agent about a node whose ports were kept before file
    outputs were typed (untyped_output_stamp)."""
    return (f"This node's ports for {model} were saved before Nebula typed Replicate file outputs from the "
            "model's data, so its file output is a guess (`typeUnconfirmed`) and a run names the output by the "
            "returned file (`video`, `audio`, ...), not by this port. Set its model_id again (edit_canvas) to "
            "re-read them.")


def stored_port_note(definition_id: str, params: Mapping[str, Any] | None) -> str | None:
    """The note for a configured node's kept ports, or None: stale_note for
    an untyped stamp, else unconfirmed_note for a guessed type."""
    stored = stored_ports(definition_id, params)
    if stored is None:
        return None
    model = model_of(definition_id, params or {})
    if untyped_output_stamp(definition_id, params):
        return stale_note(model)
    return unconfirmed_note(model, stored[1])


def _stamp(model: str, inputs: list[dict[str, Any]], outputs: list[dict[str, Any]]) -> dict[str, Any]:
    return {"model": model, "inputs": inputs, "outputs": outputs, "rev": PORTS_REV}


def configure(definition_id: str, params: Mapping[str, Any], model: str, data: Mapping[str, Any]) -> Configured:
    """The node's params and ports for ``model``, from the provider's data for
    it (an OpenRouter/Nous catalog row, a Replicate schema), as the picker set
    them: over ``params``, the model and its canvas-owned params (Replicate:
    the schema's defaults too, over the old values, as "Fetch Schema" did)."""
    base = dict(params)
    if definition_id == "replicate-universal":
        inputs, dynamic_params = replicate_inputs(data)
        outputs = [replicate_output(data)]
        defaults = {param["key"]: param["default"] for param in dynamic_params if "default" in param}
        version = data.get("version_id")
        configured = {**base, **defaults, "model_id": model, "_version_id": version, "_schema_fetched": True,
                      PORTS_PARAM: _stamp(model, inputs, outputs)}
        meta = {"version_id": version, "description": data.get("description")}
        return Configured(configured, inputs, outputs, dynamic_params, meta)
    if definition_id not in MODEL_PARAM:
        raise ValueError(f"{definition_id} is not a universal node")
    inputs, outputs = modality_ports(data)
    configured = {**base, "model": model, "_output_image": "image" in _modalities(data, "output_modalities"),
                  PORTS_PARAM: _stamp(model, inputs, outputs)}
    return Configured(configured, inputs, outputs)


# -- what a node keeps ------------------------------------------------------

def _clean_port(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        return None
    port_id, data_type = raw.get("id"), raw.get("dataType")
    if not (isinstance(port_id, str) and 0 < len(port_id) <= 128
            and isinstance(data_type, str) and 0 < len(data_type) <= 32):
        return None
    label = raw.get("label")
    port: dict[str, Any] = {"id": port_id, "label": label[:120] if isinstance(label, str) and label else port_id,
                            "dataType": data_type, "required": raw.get("required") is True}
    if raw.get("multiple") is True:
        port["multiple"] = True
    if raw.get("typeUnconfirmed") is True:
        port["typeUnconfirmed"] = True
    return port


def _clean_ports(raw: Any) -> list[dict[str, Any]] | None:
    if not isinstance(raw, list):
        return None
    ports: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw[:_MAX_PORTS]:
        port = _clean_port(item)
        if port is not None and port["id"] not in seen:
            seen.add(port["id"])
            ports.append(port)
    return ports


def stored_ports(definition_id: str, params: Mapping[str, Any] | None) -> tuple[list, list] | None:
    """(inputs, outputs) a configured node keeps for its current model, or
    None: not a universal node, never configured, or configured for a model
    it no longer has (its definition's ports apply then)."""
    if definition_id not in MODEL_PARAM or not isinstance(params, Mapping):
        return None
    raw = params.get(PORTS_PARAM)
    if not isinstance(raw, Mapping) or raw.get("model") != model_of(definition_id, params) or not raw.get("model"):
        return None
    inputs, outputs = _clean_ports(raw.get("inputs")), _clean_ports(raw.get("outputs"))
    if inputs is None or outputs is None:
        return None
    if definition_id == "replicate-universal" and raw.get("rev") != PORTS_REV:
        # #132's stamp (2026-10-20) called every file output Image `image`
        # without reading what the file is: a guess (untyped_output_stamp).
        outputs = [{**port, "typeUnconfirmed": True} if port["dataType"] != "Text" else port for port in outputs]
    return inputs, outputs


def untyped_output_stamp(definition_id: str, params: Mapping[str, Any] | None) -> bool:
    """Whether a Replicate node's kept ports were written before its file
    output was typed from the model's metadata (#132's stamp, 2026-10-20,
    which called every file output Image `image`). Its run keeps naming the
    output by the returned file, as it did (handlers/replicate_universal), and
    sending its model again (an edit, PUT, or the picker) reads it again."""
    if definition_id != "replicate-universal" or stored_ports(definition_id, params) is None:
        return False
    raw = params.get(PORTS_PARAM) if isinstance(params, Mapping) else None
    return not (isinstance(raw, Mapping) and raw.get("rev") == PORTS_REV)


def needs_configuring(definition_id: str, params: Mapping[str, Any] | None) -> bool:
    """Whether a node's kept ports are stale for its model: never kept, kept
    for another model, or kept before the current rules (untyped_output_stamp)."""
    return stored_ports(definition_id, params) is None or untyped_output_stamp(definition_id, params)


def declared_output(definition_id: str, params: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The one output port a configured Replicate node declares, for its run
    to fill; None when it was never configured for its model."""
    stored = stored_ports(definition_id, params)
    if stored is None or not stored[1]:
        return None
    return stored[1][0]


# -- an agent's change ------------------------------------------------------

def agent_update(definition_id: str, before: Mapping[str, Any], update: Mapping[str, Any],
                 looked_up: Mapping[tuple[str, str], Any]) -> tuple[dict[str, Any], str | None]:
    """The node's whole params after an agent's ``update``, which sets its
    model param, and why its ports couldn't be worked out (None when they
    were, or when the model is cleared).

    ``looked_up`` maps (definition id, model) to the provider's data for it
    or the reason it couldn't be read (look_up). With data, the node is
    configured as the picker would, with the agent's own values in
    ``update`` kept over the schema's defaults; for the model the node
    already had, its current values are kept too. Without data, a new model
    drops the old model's canvas-owned params; the same model keeps them."""
    derived = DERIVED_PARAMS[definition_id]
    merged = {**before, **update}
    model = model_of(definition_id, merged)
    same_model = model == model_of(definition_id, before)
    if not model:
        return {key: value for key, value in merged.items() if key not in derived}, None
    found = looked_up.get((definition_id, model))
    if isinstance(found, Mapping):
        configured = configure(definition_id, before, model, found).params
        kept = {key: value for key, value in before.items() if key not in derived} if same_model else {}
        full = {**configured, **kept, **update}
        full.update({key: configured[key] for key in derived if key in configured})
        full[MODEL_PARAM[definition_id]] = model
        return full, None
    reason = found if isinstance(found, str) else f"Nebula has no data for {model}"
    if same_model:
        return merged, reason
    return {key: value for key, value in merged.items() if key not in derived}, reason


# -- reading the provider ---------------------------------------------------

def _http_status(exc: Exception) -> tuple[int, str] | None:
    status, detail = getattr(exc, "status_code", None), getattr(exc, "detail", None)
    if isinstance(status, int):
        return status, detail if isinstance(detail, str) else ""
    return None


class LookupFailure(str):
    """Why look_up has no data for a model, and which kind of why (review 13,
    L-5): ``kind`` is "missing-key" (the provider's key isn't set),
    "invalid" (the model id can't be one) or "model-settings" (reading the
    provider's settings for the model failed: no answer, an error, no such
    model). The canvas says "Couldn't load the model settings for “X”." only
    for the last."""

    kind: str

    def __new__(cls, text: str, kind: str) -> "LookupFailure":
        failure = super().__new__(cls, text)
        failure.kind = kind
        return failure


def _missing(provider: str, what: str, credential: str) -> LookupFailure:
    return LookupFailure(f"Nebula can't read {PROVIDER_NAME[provider]}'s {what} because {credential} isn't set, "
                         "and only the person can add it (Settings in Nebula)", "missing-key")


def _unread(text: str) -> LookupFailure:
    return LookupFailure(text, "model-settings")


async def look_up(definition_id: str, model: str) -> dict[str, Any] | LookupFailure:
    """The provider's data for ``model`` (a catalog row, a Replicate schema)
    through the routes the pickers read, which cache it (5 minutes, Replicate
    an hour); or a plain sentence saying why it can't be had. Reads only:
    nothing is generated or billed."""
    import httpx

    provider = PROVIDER[definition_id]
    name = PROVIDER_NAME[provider]
    try:
        if provider == "replicate":
            if not REPLICATE_MODEL.fullmatch(model):
                return LookupFailure("a Replicate model_id is owner/name, e.g. black-forest-labs/flux-kontext-pro", "invalid")
            from routes.replicate_proxy import get_model_schema

            owner, model_name = model.split("/", 1)
            return dict(await get_model_schema(owner, model_name))
        if provider == "openrouter":
            from routes.openrouter_proxy import get_models
        else:
            from routes.nous_proxy import get_models
        catalog = await get_models()
    except httpx.HTTPError:
        return _unread(f"Nebula couldn't reach {name} to read {model}'s ports; try again")
    except Exception as exc:  # noqa: BLE001 - the routes raise HTTPException
        found = _http_status(exc)
        if found is None:
            raise
        status, detail = found
        if provider == "openrouter" and status == 400 and "OPENROUTER_API_KEY" in detail:
            return _missing("openrouter", "model list", "OPENROUTER_API_KEY")
        if provider == "replicate" and status == 400 and "REPLICATE_API_TOKEN" in detail:
            return _missing("replicate", f"schema for {model}", "REPLICATE_API_TOKEN")
        if provider == "nous" and status == 401:
            return _unread(f"Nebula can't read Nous Portal's model list: {detail.rstrip('.')}. "
                           "Only the person can sign in (Hermes, on this machine)")
        if provider == "replicate" and status == 404:
            return _unread(f"Replicate has no model {model}")
        return _unread(f"Nebula couldn't read {name}'s data for {model} (HTTP {status})")
    rows = catalog.get("models") if isinstance(catalog, Mapping) else None
    row = next((item for item in rows or [] if isinstance(item, Mapping) and item.get("id") == model), None)
    if row is None:
        return _unread(f"{name} lists no model {model}; check the model id")
    return dict(row)


def port_ids(ports: list[dict[str, Any]]) -> list[str]:
    return [str(port.get("id")) for port in ports if isinstance(port, Mapping)]


def edge_fits(node_id: str, edge: Mapping[str, Any], inputs: list[dict[str, Any]],
              outputs: list[dict[str, Any]]) -> bool:
    """Whether a wire still has its ends on ``node_id``'s new ports (the
    picker's rule: a wire leaving the node is checked at its source end)."""
    if edge.get("source") == node_id:
        return edge.get("sourceHandle") in port_ids(outputs)
    if edge.get("target") == node_id:
        return edge.get("targetHandle") in port_ids(inputs)
    return True
