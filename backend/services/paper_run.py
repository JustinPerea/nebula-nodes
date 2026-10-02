"""Accepted Paper inputs + saved recipe receipt; no Paper or provider calls."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from services.output import _is_manifest_secret_key

_SECRETS = {"apikey", "apikeys", "token", "accesstoken", "refreshtoken", "authorization", "password", "secret", "clientsecret", "credentials"}
_OUTPUT_METADATA = {"_sourceDuration", "_sourceFps", "_sourceIsVfr"}


def safe_value(value):
    if isinstance(value, dict):
        return {k: safe_value(v) for k, v in value.items()
                if not _is_manifest_secret_key(k) and k.lower().replace("_", "").replace("-", "") not in _SECRETS}
    if isinstance(value, list):
        return [safe_value(v) for v in value]
    return value


def write_paper_receipt(nodes, edges, run_dir, run_id):
    inputs = []
    recipe_nodes = []
    for node in nodes:
        params = {k: v for k, v in node.params.items() if k not in _OUTPUT_METADATA}
        source = params.pop("_paperSource", None)
        if node.definition_id == "paper-source" and source and source.get("snapshot"):
            inputs.append({"nodeId": node.id, "sourceId": source["id"], "snapshot": safe_value(source["snapshot"])})
            params["_paperSource"] = {"identity": {k: source["identity"][k] for k in ("fileId", "pageId", "objectId")}, "exportSettings": source["exportSettings"]}
        recipe_nodes.append({"id": node.id, "definitionId": node.definition_id, "params": safe_value(params)})
    if not inputs:
        return
    recipe = {"nodes": sorted(recipe_nodes, key=lambda n: n["id"]),
              "edges": sorted([e.model_dump(by_alias=True) for e in edges], key=lambda e: e["id"])}
    revision = hashlib.sha256(json.dumps(recipe, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    receipt = {"schemaVersion": 1, "runId": run_id, "capturedAt": datetime.now(timezone.utc).isoformat(),
               "recipeRevision": revision, "recipe": recipe, "paperInputs": inputs}
    with (run_dir / "paper-inputs.json").open("x") as out:
        json.dump(receipt, out, indent=2)
