#!/usr/bin/env python3
"""Generate Nebula's explicit Krea generation nodes from a pinned API catalog.

Covers image, video, audio, enhance (upscale) and 3D routes.

Default and --check are offline. --refresh fetches Krea's official public
OpenAPI (or --openapi reads a previously fetched copy); no token or job is used.

Also writes the Krea entries of backend/data/model_pricing.json from each
operation's `x-krea-pricing` block. These are API-token (USD) prices; Krea
account runs bill workspace compute units, which Krea doesn't publish per
option, so they stay unpriced. A model whose price dimensions don't map onto
its request fields is left unpriced and listed, never guessed.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "backend/data/krea_gateway_models.json"
REGISTRY = ROOT / "backend/data/node_definitions.json"
PRICING = ROOT / "backend/data/model_pricing.json"
PRICING_GENERATOR = "scripts/sync-krea-catalog.py"
FRONTEND = ROOT / "frontend/src/constants/nodeDefinitions.ts"
SOURCE_URL = "https://api.krea.ai/openapi.json"
DOC_URL = "docs/model-providers/krea/krea-gateway.md"
# Route family -> output media type. Enhance outputs whatever it was given:
# routes with a video_url input upscale video, the rest upscale images.
MEDIA_ROUTES = {"/generate/image/": "Image", "/generate/video/": "Video",
                "/generate/audio/": "Audio", "/generate/enhance/": "Enhance",
                "/generate/3d/": "Mesh"}
CATEGORIES = {"Image": "image-gen", "Video": "video-gen", "Audio": "audio-gen",
              "Mesh": "3d-gen"}
PLURALS = {"Image": "images", "Video": "videos", "Audio": "audios", "Mesh": "meshes"}
# Price rows that only hold when a request field is left empty. Kling 3.0
# takes multi_prompt (shots, each with its own duration), and Kling's API
# reference says "sum of all shot durations must equal the total video
# duration"; Krea's price list keys on the duration field and doesn't say how
# a multi-shot run is billed (NOT VERIFIED). So a multi-shot run is unpriced.
# A multi_prompt that arrives by wire is caught by the wired-port rule
# (backend services/model_pricing.py).
PRICE_GUARDS = {
    "/generate/video/kling/kling-3.0": {
        "match": {"multi_prompt": ""},
        "note": "Multi-prompt runs are unpriced: Krea's price list keys on the duration field and doesn't say "
                "how shot durations are billed.",
        "source": {"url": "https://kling.ai/document-api/apiReference/model/textToVideo",
                   "quote": "sum of all shot durations must equal the total video duration"},
    },
}
# Request fields a model takes that Krea's price list leaves out, said
# outright so an audit doesn't flag them again: Krea does price audio where it
# charges for it (Veo 3, Kling 3.0 list generateAudio as a dimension).
UNPRICED_FIELD_NOTES = {
    "generate_audio": "Krea's price doesn't vary with generate_audio (x-krea-pricing dimensions: {dims}).",
}


# Krea copies that can also run on the model maker's own API with the
# person's key (backend execution/maker_routes.py, services/node_route.py).
# Keyed by Krea endpoint. Each generated node then gets envKeyName [maker key,
# KREA_API_TOKEN], directKeyName, and its params split by route: `params`
# keeps the full Krea request list (so every `_kreaAuth` reader still finds the
# billing choice there), sharedParams are what both routes read, falParams
# the Krea-only fields the maker has no equivalent for (`kreaOnly`), and
# directParams the maker-only extras. `directRoute` names the backend
# translation and the maker's model id, plus `blockedBy` (`directBlockedBy`):
# Krea-only fields that keep a run on Krea when set, since the maker can't
# honor them (an explicit width/height would otherwise silently become
# Google's default shape). `pricing` is the maker route's
# model_pricing.json entry, in the node's own param names; the Krea route's
# entry is generated from x-krea-pricing as for every other model.
#
# Route precedence (the same in pricing, readiness, the engine and the
# router): _kreaAuth "mcp" bills the Krea plan; else the maker key; else
# KREA_API_TOKEN.
GOOGLE_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing"
GOOGLE_CHECKED = "2026-10-14"
# Reference images cost input tokens on every call. Google: "Up to 14
# reference images" (https://ai.google.dev/gemini-api/docs/image-generation),
# so a Google-route price is a range: the output image alone, up to the output
# plus 14 references. Per-image input cost, by model:
# - gemini-3-pro-image: "Image input is set at 560 tokens or $0.0011 per image"
#   (pricing page).
# - gemini-3.1-flash-image / -flash-lite-image: Gemini 3's default image media
#   resolution, 1120 tokens (docs/media-resolution), at $0.50 / $0.25 per 1M.
# - gemini-2.5-flash-image: 258 tokens per 768x768 tile (docs/image-
#   understanding); up to 8 tiles for an image up to 21:9, at $0.30 per 1M.
MAX_REFERENCE_IMAGES = 14
REFERENCE_IMAGE_COST = {
    "gemini-3-pro-image": (0.0011, "$0.0011 per reference image"),
    "gemini-3.1-flash-image": (1120 * 0.50 / 1e6, "1,120 tokens per reference image at $0.50 per 1M"),
    "gemini-3.1-flash-lite-image": (1120 * 0.25 / 1e6, "1,120 tokens per reference image at $0.25 per 1M"),
    "gemini-2.5-flash-image": (8 * 258 * 0.30 / 1e6,
                               "up to 8 tiles of 258 tokens per reference image (up to 21:9) at $0.30 per 1M"),
}
_GOOGLE_NOTE = ("Gemini API standard (paid tier) price, for runs on the person's GOOGLE_API_KEY (model {model}). "
                "The low end is the output image; the high end adds up to {refs} reference images "
                "(Google's limit) at {ref_cost}. Prompt text input isn't counted (well under $0.01 for a normal "
                "prompt). Ignores Batch/Flex/Priority rates.")
_GOOGLE_INPUT_SOURCES = {
    "gemini-3-pro-image": {"url": GOOGLE_PRICING_URL,
                           "quote": "Image input is set at 560 tokens or $0.0011 per image."},
    "gemini-3.1-flash-image": {"url": "https://ai.google.dev/gemini-api/docs/media-resolution",
                               "quote": "`unspecified` (Default) | 1120 | ... (Gemini 3 models, Image)"},
    "gemini-3.1-flash-lite-image": {"url": "https://ai.google.dev/gemini-api/docs/media-resolution",
                                    "quote": "`unspecified` (Default) | 1120 | ... (Gemini 3 models, Image)"},
    "gemini-2.5-flash-image": {"url": "https://ai.google.dev/gemini-api/docs/image-understanding",
                               "quote": "Larger images are tiled into 768x768 pixel tiles, each costing 258 tokens."},
}
_REFERENCE_LIMIT_SOURCE = {"url": "https://ai.google.dev/gemini-api/docs/image-generation",
                           "quote": "Up to 14 reference images: Mix up to 14 reference images to produce the final image."}


def with_references(price, model):
    """[output price, output price + the most reference images Google takes]."""
    import math

    per_image = REFERENCE_IMAGE_COST[model][0]
    return [price, math.ceil((price + MAX_REFERENCE_IMAGES * per_image) * 1e5) / 1e5]


DIRECT_ROUTES = {
    "/generate/image/google/nano-banana-2": {
        "directKeyName": "GOOGLE_API_KEY", "translation": "krea-nano-banana", "model": "gemini-3.1-flash-image",
        "kreaOnly": ["width", "height"], "directBlockedBy": ["width", "height"], "directParams": [],
        "pricing": {"provider": "google", "per": "image", "priceParams": ["resolution"],
                    "rows": [{"match": {"resolution": "1K"}, "price": 0.067},
                             {"match": {"resolution": "2K"}, "price": 0.101},
                             {"match": {"resolution": "4K"}, "price": 0.151}],
                    "sources": [{"url": GOOGLE_PRICING_URL,
                                 "quote": "$60.00 (images) Equivalent to $0.045 per 0.5K image* $0.067 per 1K "
                                          "image*, $0.101 per 2K image*, and $0.151 per 4K image*."},
                                {"url": GOOGLE_PRICING_URL, "quote": "Input price | Not available | $0.50 (text/image)"}]},
    },
    "/generate/image/google/nano-banana-pro": {
        "directKeyName": "GOOGLE_API_KEY", "translation": "krea-nano-banana", "model": "gemini-3-pro-image",
        "kreaOnly": ["width", "height"], "directBlockedBy": ["width", "height"], "directParams": [],
        "pricing": {"provider": "google", "per": "image", "priceParams": ["resolution"],
                    "rows": [{"match": {"resolution": "1K"}, "price": 0.134},
                             {"match": {"resolution": "2K"}, "price": 0.134},
                             {"match": {"resolution": "4K"}, "price": 0.24}],
                    "sources": [{"url": GOOGLE_PRICING_URL,
                                 "quote": "$120.00 (images) Equivalent to $0.134 per 1K/2K image** and $0.24 per "
                                          "4K image**"}]},
    },
    "/generate/image/google/nano-banana-flash-lite": {
        "directKeyName": "GOOGLE_API_KEY", "translation": "krea-nano-banana",
        "model": "gemini-3.1-flash-lite-image", "kreaOnly": ["width", "height"],
        "directBlockedBy": ["width", "height"], "directParams": [],
        "pricing": {"provider": "google", "per": "image", "priceParams": [],
                    "rows": [{"match": {}, "price": 0.0336}],
                    "sources": [{"url": GOOGLE_PRICING_URL,
                                 "quote": "$30.00 (images) Equivalent to $0.0336 per 1K resolution image*"},
                                {"url": GOOGLE_PRICING_URL,
                                 "quote": "Input price | Not available | $0.25 (text/image/video)"}]},
    },
    "/generate/image/google/nano-banana": {
        "directKeyName": "GOOGLE_API_KEY", "translation": "krea-nano-banana", "model": "gemini-2.5-flash-image",
        "kreaOnly": ["width", "height"], "directBlockedBy": ["width", "height"], "directParams": [],
        "pricing": {"provider": "google", "per": "image", "priceParams": [],
                    "rows": [{"match": {}, "price": 0.039}],
                    "sources": [{"url": GOOGLE_PRICING_URL,
                                 "quote": "Output images up to 1024x1024px consume 1290 tokens and are equivalent "
                                          "to $0.039 per image."},
                                {"url": GOOGLE_PRICING_URL, "quote": "Input price | Not available | $0.30 (text / image)"}]},
    },
}


def direct_route_definition(endpoint, params):
    """The dual-route fields a Krea node with a maker route adds (DIRECT_ROUTES)."""
    route = DIRECT_ROUTES.get(endpoint)
    if not route:
        return {}
    keys = {param["key"] for param in params}
    unknown = sorted(set(route["kreaOnly"]) - keys)
    if unknown:
        raise ValueError(f"DIRECT_ROUTES {endpoint}: kreaOnly names fields Krea doesn't take: {unknown}")
    blocked = route.get("directBlockedBy") or []
    if set(blocked) - set(route["kreaOnly"]):
        raise ValueError(f"DIRECT_ROUTES {endpoint}: directBlockedBy must be kreaOnly fields")
    defaulted = sorted(param["key"] for param in params if param["key"] in blocked and param.get("default") is not None)
    if defaulted:
        # A default would block the maker route for every new node.
        raise ValueError(f"DIRECT_ROUTES {endpoint}: directBlockedBy fields have defaults: {defaulted}")
    clash = sorted(keys & {param["key"] for param in route["directParams"]})
    if clash:
        raise ValueError(f"DIRECT_ROUTES {endpoint}: directParams repeat Krea fields: {clash}")
    return {
        "envKeyName": [route["directKeyName"], "KREA_API_TOKEN"],
        "directKeyName": route["directKeyName"],
        "sharedParams": [param for param in params if param["key"] not in route["kreaOnly"]],
        "falParams": [param for param in params if param["key"] in route["kreaOnly"]],
        "directParams": list(route["directParams"]),
        "directRoute": {"translation": route["translation"], "model": route["model"],
                        **({"blockedBy": list(blocked)} if blocked else {})},
    }


def direct_route_pricing(endpoint):
    route = DIRECT_ROUTES.get(endpoint)
    if not route:
        return None
    pricing = dict(route["pricing"])
    provider = pricing.pop("provider")
    model = route["model"]
    pricing["rows"] = [{**row, "price": with_references(row["price"], model)} for row in pricing["rows"]]
    pricing["sources"] = [*pricing["sources"], _GOOGLE_INPUT_SOURCES[model], _REFERENCE_LIMIT_SOURCE]
    note = _GOOGLE_NOTE.format(model=model, refs=MAX_REFERENCE_IMAGES, ref_cost=REFERENCE_IMAGE_COST[model][1])
    return provider, {"currency": "usd", **pricing, "notes": note, "checked": GOOGLE_CHECKED}


def route_family(endpoint):
    return endpoint[len("/generate/"):].split("/", 1)[0]


def category_for(endpoint, media_type):
    return "transform" if route_family(endpoint) == "enhance" else CATEGORIES[media_type]
BEGIN = "  // BEGIN GENERATED KREA CATALOG (scripts/sync-krea-catalog.py)"
END = "  // END GENERATED KREA CATALOG"


def compact_schema(value):
    if isinstance(value, list):
        return [compact_schema(item) for item in value]
    if isinstance(value, dict):
        return {key: compact_schema(item) for key, item in value.items()
                if key not in {"description", "examples", "example", "title"}}
    return value


def branches(schema):
    alternatives = schema.get("anyOf", schema.get("oneOf"))
    if alternatives:
        return [leaf for part in alternatives for leaf in branches(part)
                if leaf.get("type") != "null"]
    if isinstance(schema.get("type"), list):
        return [{**schema, "type": kind} for kind in schema["type"] if kind != "null"]
    return [schema] if schema.get("type") != "null" else []


def simple_schema(schema):
    parts = branches(schema)
    if len(parts) == 1:
        return {**parts[0], **{key: value for key, value in schema.items()
                              if key not in {"anyOf", "oneOf"}
                              and not (key == "type" and isinstance(value, list))}}
    if parts and all("const" in part for part in parts):
        return {**schema, "type": parts[0].get("type"),
                "enum": [part["const"] for part in parts]}
    return schema


def label(field):
    return field.replace("_", " ").capitalize().replace(" url", " URL")


def port_type(field, schema):
    simple = simple_schema(schema)
    if simple.get("type") == "array":
        simple = simple_schema(simple.get("items", {}))
    if field == "prompt":
        return "Text"
    if simple.get("type") == "string" and simple.get("format") == "uri":
        if "mask" in field:
            return "Mask"
        if "video" in field:
            return "Video"
        if "audio" in field:
            return "Audio"
        return "Image"
    return "Any" if simple.get("type") in ("object", "array") else None


def fields_for(schema):
    params, ports, json_params = [], [], []
    required = set(schema.get("required", []))
    for field, original in schema.get("properties", {}).items():
        simple = simple_schema(original)
        kind = simple.get("type")
        param = {"key": field, "label": label(field), "required": field in required}
        if "enum" in simple:
            param.update(type="enum", options=[{"label": str(item), "value": item}
                                               for item in simple["enum"]])
        elif kind == "boolean":
            param["type"] = "boolean"
        elif kind in ("number", "integer"):
            param["type"] = "integer" if kind == "integer" else "float"
            for source, target in (("minimum", "min"), ("maximum", "max")):
                if source in simple:
                    param[target] = simple[source]
            param["step"] = 1 if kind == "integer" else 0.01
        elif kind == "string":
            param["type"] = "textarea" if field == "prompt" else "string"
        else:
            param.update(type="textarea", label=label(field) + " (JSON)",
                         placeholder="JSON array or object matching this model")
            json_params.append(field)
        if "default" in simple and simple["default"] is not None:
            default = simple["default"]
            param["default"] = json.dumps(default, ensure_ascii=False) if field in json_params else default
        params.append(param)
        data_type = port_type(field, original)
        if data_type:
            port = {"id": field, "label": label(field), "dataType": data_type,
                    "required": False}
            if kind == "array":
                port["multiple"] = True
                if "maxItems" in simple:
                    port["maxConnections"] = simple["maxItems"]
            ports.append(port)
    return params, ports, json_params


def snake(name):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def refresh(raw, checked_on):
    api = json.loads(raw)
    models = {}
    for endpoint, operations in api["paths"].items():
        media_type = next((kind for prefix, kind in MEDIA_ROUTES.items()
                           if endpoint.startswith(prefix)), None)
        if media_type is None:
            continue
        operation = operations.get("post")
        if not operation or operation.get("deprecated"):
            continue
        schema = compact_schema(operation["requestBody"]["content"]["application/json"]["schema"])
        if media_type == "Enhance":
            media_type = "Video" if "video_url" in schema.get("properties", {}) else "Image"
        node_id = "krea-" + re.sub(r"[^a-z0-9]+", "-", endpoint[len("/generate/"):].lower()).strip("-")
        if node_id in models:
            raise ValueError(f"Krea ID collision: {node_id}")
        _, ports, json_params = fields_for(schema)
        models[node_id] = {"endpoint": endpoint, "displayName": operation["summary"],
                           "requestSchema": schema, "mediaType": media_type,
                           "inputPorts": ports, "jsonParams": json_params}
        pricing = operation.get("x-krea-pricing")
        if isinstance(pricing, dict):
            # Keep price points only when every dimension is a request field we
            # send; the rest can't be estimated before a run, so record why.
            fields = set(schema.get("properties", {}))
            unmapped = sorted({key for point in pricing.get("price_points") or []
                               for key in point.get("dimensions", {}) if snake(key) not in fields})
            if unmapped:
                models[node_id]["pricingUnmapped"] = unmapped
            else:
                models[node_id]["pricing"] = {key: pricing[key] for key in
                                              ("type", "currency", "unit", "price_points") if key in pricing}
    if not models:
        raise ValueError("Krea OpenAPI has no generation models")
    return {"sourceUrl": SOURCE_URL, "fetchedAt": checked_on,
            "openapiSha256": hashlib.sha256(raw).hexdigest(), "models": models}


def definitions(catalog):
    result = {}
    for node_id, model in catalog["models"].items():
        media_type = model["mediaType"]
        params, ports, json_params = fields_for(model["requestSchema"])
        params.insert(0, {"key": "_kreaAuth", "label": "Krea connection", "type": "enum",
                          "required": False, "options": [
                              {"value": "api-token", "label": "API token · API balance"},
                              {"value": "mcp", "label": "Krea account · workspace compute"}],
                          "default": "api-token"})
        if ports != model["inputPorts"] or json_params != model["jsonParams"]:
            raise ValueError(f"Catalog mapping drift: {node_id}; refresh the catalog")
        singular = media_type.lower()
        plural = PLURALS[media_type]
        name = model["displayName"]
        if model["endpoint"] == "/generate/image/openai/gpt-image-2":
            name = "GPT Image 2"
        if model["endpoint"].endswith("/grok-imagine-2-edit"):
            name += " Edit"
        result[node_id] = {
            "id": node_id, "displayName": name + " (Krea)",
            "category": category_for(model["endpoint"], media_type),
            "apiProvider": "krea", "apiEndpoint": model["endpoint"],
            "envKeyName": "KREA_API_TOKEN", "executionPattern": "async-poll",
            "inputPorts": ports,
            "outputPorts": [
                {"id": singular, "label": media_type, "dataType": media_type, "required": True},
                {"id": plural, "label": "All " + plural, "dataType": "Array", "required": False},
                {"id": "artifacts", "label": "All artifacts", "dataType": "Array", "required": False},
                {"id": "job", "label": "Job", "dataType": "Any", "required": False},
            ],
            "params": params, "docUrl": DOC_URL,
        }
        result[node_id].update(direct_route_definition(model["endpoint"], params))
    return result


def pricing_entries(catalog):
    """model_pricing.json entries for every Krea model whose price points map
    onto its own request fields. Returns (entries, skipped reasons)."""
    entries, skipped = {}, {}
    for node_id, model in catalog["models"].items():
        krea_entry(node_id, model, catalog, entries, skipped)
        direct = direct_route_pricing(model["endpoint"])
        if direct:
            # A dual-route node prices each route; the Krea plan stays unpriced.
            routes = {}
            if node_id in entries:
                entries[node_id].pop("generatedBy")
                routes["krea"] = entries[node_id]
            routes[direct[0]] = direct[1]
            entries[node_id] = {"routes": routes, "generatedBy": PRICING_GENERATOR}
    return entries, skipped


def krea_entry(node_id, model, catalog, entries, skipped):
    """The Krea API-token entry for one model, into ``entries`` (or a reason into ``skipped``)."""
    if model.get("pricingUnmapped"):
        skipped[node_id] = ("price depends on " + ", ".join(model["pricingUnmapped"])
                            + ", which the request doesn't set directly")
        return
    pricing = model.get("pricing")
    if not pricing:
        return
    points = pricing.get("price_points") or []
    fields = set(model["requestSchema"].get("properties", {}))
    if pricing.get("currency") != "USD" or pricing.get("unit") != "request" or not points:
        skipped[node_id] = f"unsupported pricing {pricing.get('currency')}/{pricing.get('unit')}"
        return
    unmapped = sorted({key for point in points for key in point.get("dimensions", {})
                       if snake(key) not in fields})
    if unmapped:
        skipped[node_id] = "price depends on " + ", ".join(unmapped) + ", which the request doesn't set directly"
        return
    properties = model["requestSchema"].get("properties", {})

    def reachable(point):
        # Krea's price list sometimes covers values its own request schema
        # rejects (e.g. a 5 s Veo clip); a run can never match those.
        for key, value in point.get("dimensions", {}).items():
            allowed = simple_schema(properties[snake(key)]).get("enum")
            if allowed is not None and value not in allowed:
                return False
        return True

    guard = PRICE_GUARDS.get(model["endpoint"], {})
    rows = [{"match": {"_kreaAuth": "api-token",
                       **{snake(key): value for key, value in point.get("dimensions", {}).items()},
                       **guard.get("match", {})},
             "price": point["amount"]} for point in points if reachable(point)]
    if not rows:
        skipped[node_id] = "no price point matches values the request accepts"
        return
    notes = ["API-token runs only. Krea account runs bill workspace compute units, "
             "which Krea doesn't publish per option, so they stay unpriced."]
    if guard.get("note"):
        notes.append(guard["note"])
    dimensions = sorted({snake(key) for point in points for key in point.get("dimensions", {})})
    for field, note in UNPRICED_FIELD_NOTES.items():
        if field in properties and field not in dimensions:
            notes.append(note.format(dims=", ".join(dimensions) or "none"))
    sources = [{"url": catalog["sourceUrl"],
                "quote": f"x-krea-pricing on POST {model['endpoint']} "
                         f"(spec sha256 {catalog['openapiSha256'][:12]})"}]
    if guard.get("source"):
        sources.append(guard["source"])
    entries[node_id] = {
        "currency": "usd", "per": "request",
        "priceParams": sorted({key for row in rows for key in row["match"]}),
        "rows": rows,
        "notes": " ".join(notes),
        "sources": sources,
        "checked": catalog["fetchedAt"],
        "generatedBy": PRICING_GENERATOR,
    }


def pricing_source(source, entries):
    """Replace only this script's entries; hand-curated ones stay as they are."""
    data = json.loads(source)
    nodes = {key: value for key, value in data["nodes"].items()
             if value.get("generatedBy") != PRICING_GENERATOR}
    collisions = sorted(set(nodes) & set(entries))
    if collisions:
        raise ValueError(f"Hand-curated pricing collides with generated Krea pricing: {collisions}")
    data["nodes"] = dict(sorted({**nodes, **entries}.items()))
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def frontend_source(source, generated):
    blocks = [BEGIN]
    for node_id, definition in generated.items():
        body = json.dumps(definition, indent=2, ensure_ascii=False).splitlines()
        blocks.append(f"  '{node_id}': " + body[0])
        blocks.extend("  " + line for line in body[1:-1])
        blocks.append("  " + body[-1] + ",")
    blocks.append(END)
    block = "\n".join(blocks)
    if BEGIN in source:
        start = source.index(BEGIN)
        end = source.index(END, start) + len(END)
        return source[:start] + block + source[end:]
    insertion = source.index("\n};", source.index("export const NODE_DEFINITIONS"))
    return source[:insertion] + "\n" + block + source[insertion:]


def registry_source(source, generated):
    """Keep existing node formatting while replacing only this catalog."""
    decoder = json.JSONDecoder()
    position = source.index("{") + 1
    blocks = []
    while True:
        while source[position].isspace() or source[position] == ",":
            position += 1
        if source[position] == "}":
            break
        key, position = decoder.raw_decode(source, position)
        while source[position].isspace():
            position += 1
        if source[position] != ":":
            raise ValueError("Invalid node registry entry")
        position += 1
        while source[position].isspace():
            position += 1
        start = position
        value, position = decoder.raw_decode(source, position)
        if value.get("docUrl") != DOC_URL:
            if key in generated:
                raise ValueError(f"Existing node ID collision: {key}")
            blocks.append(f"  {json.dumps(key)}: {source[start:position]}")
    for key, value in generated.items():
        lines = json.dumps(value, indent=2, ensure_ascii=False).splitlines()
        blocks.append(f"  {json.dumps(key)}: " + lines[0] + "\n" +
                      "\n".join("  " + line for line in lines[1:]))
    return "{\n" + ",\n".join(blocks) + "\n}\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--openapi", type=Path)
    parser.add_argument("--date", default=datetime.date.today().isoformat())
    args = parser.parse_args()
    if args.check and (args.refresh or args.openapi):
        parser.error("--check is offline; refresh separately")
    if args.refresh or args.openapi:
        if args.openapi:
            raw = args.openapi.read_bytes()
        else:
            with urllib.request.urlopen(SOURCE_URL, timeout=30) as response:
                raw = response.read()
        catalog = refresh(raw, args.date)
    else:
        catalog = json.loads(CATALOG.read_text())
    generated = definitions(catalog)
    prices, unpriced = pricing_entries(catalog)
    expected = {
        CATALOG: json.dumps(catalog, indent=2, ensure_ascii=False) + "\n",
        REGISTRY: registry_source(REGISTRY.read_text(), generated),
        FRONTEND: frontend_source(FRONTEND.read_text(), generated),
        PRICING: pricing_source(PRICING.read_text(), prices),
    }
    for path, content in expected.items():
        if args.check:
            if path.read_text() != content:
                raise SystemExit(f"Krea catalog drift: {path.relative_to(ROOT)}; run scripts/sync-krea-catalog.py")
        else:
            path.write_text(content)
    print(f"Krea catalog {'check passed' if args.check else 'generated'}: {len(generated)} generation models, "
          f"{len(prices)} priced")
    for node_id, reason in sorted(unpriced.items()):
        print(f"  unpriced {node_id}: {reason}")


if __name__ == "__main__":
    main()
