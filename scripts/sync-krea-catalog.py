#!/usr/bin/env python3
"""Generate Nebula's explicit Krea image/video/audio nodes from a pinned API catalog.

Default and --check are offline. --refresh fetches Krea's official public
OpenAPI (or --openapi reads a previously fetched copy); no token or job is used.
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
FRONTEND = ROOT / "frontend/src/constants/nodeDefinitions.ts"
SOURCE_URL = "https://api.krea.ai/openapi.json"
DOC_URL = "docs/model-providers/krea/krea-gateway.md"
# Enhance, 3D and node-app routes need different inputs and outputs; they stay out.
MEDIA_ROUTES = {"/generate/image/": "Image", "/generate/video/": "Video",
                "/generate/audio/": "Audio"}
CATEGORIES = {"Image": "image-gen", "Video": "video-gen", "Audio": "audio-gen"}
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
        node_id = "krea-" + re.sub(r"[^a-z0-9]+", "-", endpoint[len("/generate/"):].lower()).strip("-")
        if node_id in models:
            raise ValueError(f"Krea ID collision: {node_id}")
        _, ports, json_params = fields_for(schema)
        models[node_id] = {"endpoint": endpoint, "displayName": operation["summary"],
                           "requestSchema": schema, "mediaType": media_type,
                           "inputPorts": ports, "jsonParams": json_params}
    if not models:
        raise ValueError("Krea OpenAPI has no image/video/audio generation models")
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
        name = model["displayName"]
        if model["endpoint"] == "/generate/image/openai/gpt-image-2":
            name = "GPT Image 2"
        if model["endpoint"].endswith("/grok-imagine-2-edit"):
            name += " Edit"
        result[node_id] = {
            "id": node_id, "displayName": name + " (Krea)",
            "category": CATEGORIES[media_type],
            "apiProvider": "krea", "apiEndpoint": model["endpoint"],
            "envKeyName": "KREA_API_TOKEN", "executionPattern": "async-poll",
            "inputPorts": ports,
            "outputPorts": [
                {"id": singular, "label": media_type, "dataType": media_type, "required": True},
                {"id": singular + "s", "label": "All " + singular + "s", "dataType": "Array", "required": False},
                {"id": "artifacts", "label": "All artifacts", "dataType": "Array", "required": False},
                {"id": "job", "label": "Job", "dataType": "Any", "required": False},
            ],
            "params": params, "docUrl": DOC_URL,
        }
    return result


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
    expected = {
        CATALOG: json.dumps(catalog, indent=2, ensure_ascii=False) + "\n",
        REGISTRY: registry_source(REGISTRY.read_text(), generated),
        FRONTEND: frontend_source(FRONTEND.read_text(), generated),
    }
    for path, content in expected.items():
        if args.check:
            if path.read_text() != content:
                raise SystemExit(f"Krea catalog drift: {path.relative_to(ROOT)}; run scripts/sync-krea-catalog.py")
        else:
            path.write_text(content)
    print(f"Krea catalog {'check passed' if args.check else 'generated'}: {len(generated)} image/video/audio models")


if __name__ == "__main__":
    main()
