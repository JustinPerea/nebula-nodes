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
contracts/fixtures/universal-ports/picker-cases.json), with one change: a
Replicate model whose output is a list of plain strings has a Text `text`
output, as its run names it, where the picker drew an Image `image` port.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Mapping

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
    """`key.replace(/_/g, ' ').replace(/\\b\\w/g, upper)`, as the picker labels."""
    return re.sub(r"\b\w", lambda match: match.group(0).upper(), key.replace("_", " "), flags=re.ASCII)


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
        param: dict[str, Any] = {"key": key, "label": _title(key), "type": param_type, "required": key in required}
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


def replicate_output(schema: Mapping[str, Any]) -> dict[str, Any]:
    """The port a Replicate model's run fills: a file URL, or a list of them,
    is `image`; anything else (text, a list of plain strings, an object) is
    `text` (handlers/replicate_universal._infer_output_type)."""
    output = schema.get("output_schema") if isinstance(schema.get("output_schema"), Mapping) else {}
    items = output.get("items") if isinstance(output.get("items"), Mapping) else {}
    is_file = (output.get("type") == "string" and output.get("format") == "uri") or (
        output.get("type") == "array" and items.get("format") == "uri")
    if is_file:
        return {"id": "image", "label": "Output", "dataType": "Image", "required": False}
    return {"id": "text", "label": "Output", "dataType": "Text", "required": False}


def _stamp(model: str, inputs: list[dict[str, Any]], outputs: list[dict[str, Any]]) -> dict[str, Any]:
    return {"model": model, "inputs": inputs, "outputs": outputs}


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
    return inputs, outputs


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


def _missing(provider: str, what: str, credential: str) -> str:
    return (f"Nebula can't read {PROVIDER_NAME[provider]}'s {what} because {credential} isn't set, "
            "and only the person can add it (Settings in Nebula)")


async def look_up(definition_id: str, model: str) -> dict[str, Any] | str:
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
                return "a Replicate model_id is owner/name, e.g. black-forest-labs/flux-kontext-pro"
            from routes.replicate_proxy import get_model_schema

            owner, model_name = model.split("/", 1)
            return dict(await get_model_schema(owner, model_name))
        if provider == "openrouter":
            from routes.openrouter_proxy import get_models
        else:
            from routes.nous_proxy import get_models
        catalog = await get_models()
    except httpx.HTTPError:
        return f"Nebula couldn't reach {name} to read {model}'s ports; try again"
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
            return (f"Nebula can't read Nous Portal's model list: {detail.rstrip('.')}. "
                    "Only the person can sign in (Hermes, on this machine)")
        if provider == "replicate" and status == 404:
            return f"Replicate has no model {model}"
        return f"Nebula couldn't read {name}'s data for {model} (HTTP {status})"
    rows = catalog.get("models") if isinstance(catalog, Mapping) else None
    row = next((item for item in rows or [] if isinstance(item, Mapping) and item.get("id") == model), None)
    if row is None:
        return f"{name} lists no model {model}; check the model id"
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
