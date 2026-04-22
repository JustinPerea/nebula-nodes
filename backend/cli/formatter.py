from __future__ import annotations

from typing import Any


def format_node_table(nodes: list[dict[str, Any]]) -> str:
    """Format nodes as an aligned table grouped by category."""
    by_cat: dict[str, list[dict[str, Any]]] = {}
    for n in nodes:
        cat = n.get("category", "other")
        by_cat.setdefault(cat, []).append(n)

    cat_names = {
        "image-gen": "IMAGE GENERATION",
        "video-gen": "VIDEO GENERATION",
        "text-gen": "TEXT / CHAT",
        "audio-gen": "AUDIO",
        "3d-gen": "3D GENERATION",
        "transform": "TRANSFORM",
        "analyzer": "ANALYZER",
        "utility": "UTILITY",
        "universal": "UNIVERSAL",
    }

    lines: list[str] = []
    for cat, cat_nodes in by_cat.items():
        display_cat = cat_names.get(cat, cat.upper())
        lines.append(f"{display_cat} ({len(cat_nodes)})")
        for n in sorted(cat_nodes, key=lambda x: x["id"]):
            nid = n["id"]
            name = n.get("displayName", nid)
            provider = n.get("apiProvider", "")
            lines.append(f"  {nid:<30} {name:<25} {provider}")
        lines.append("")

    return "\n".join(lines)


def format_node_detail(node: dict[str, Any]) -> str:
    """Format full detail for a single node (nebula info output)."""
    lines: list[str] = []
    name = node.get("displayName", node["id"])
    lines.append(f"{name} ({node['id']})")

    provider = node.get("apiProvider", "?")
    key = node.get("envKeyName", "?")
    if isinstance(key, list):
        key = " or ".join(key)
    pattern = node.get("executionPattern", "?")
    lines.append(f"Provider: {provider} | Key: {key} | Exec: {pattern}")
    lines.append("")

    inputs = node.get("inputPorts", [])
    if inputs:
        lines.append("INPUTS:")
        for p in inputs:
            req = "required" if p.get("required") else "optional"
            lines.append(f"  {p['id']:<16}{p['dataType']:<10}{req}")
        lines.append("")

    outputs = node.get("outputPorts", [])
    if outputs:
        lines.append("OUTPUTS:")
        for p in outputs:
            lines.append(f"  {p['id']:<16}{p['dataType']}")
        lines.append("")

    params = node.get("params", [])
    if params:
        lines.append("PARAMS:")
        for p in params:
            default = p.get("default", "")
            ptype = p.get("type", "")
            detail = f"{p['key']:<20}{ptype:<10}{default}"
            opts = p.get("options", [])
            if opts:
                # Show values (what `nebula set` accepts), not labels (UI display strings).
                # If label differs from value, annotate as "value (label)" so both are visible.
                parts = []
                for o in opts:
                    val = o.get("value", "")
                    lbl = o.get("label", "")
                    if lbl and lbl != val:
                        parts.append(f"{val} ({lbl})")
                    else:
                        parts.append(str(val))
                detail += f"  [{', '.join(parts)}]"
            if p.get("min") is not None or p.get("max") is not None:
                lo = p.get("min", "")
                hi = p.get("max", "")
                detail += f"  min={lo} max={hi}"
            vis = p.get("visibleWhen")
            if vis:
                conds = [f"{k}={v}" for k, vals in vis.items() for v in vals]
                detail += f"  (when {', '.join(conds[:3])})"
            lines.append(f"  {detail}")
        lines.append("")

    return "\n".join(lines)


def format_keys(settings: dict[str, Any], nodes: list[dict[str, Any]]) -> str:
    """Format API key status (nebula keys output)."""
    api_keys = settings.get("apiKeys", {})

    key_to_nodes: dict[str, list[str]] = {}
    all_keys: set[str] = set()
    for n in nodes:
        env = n.get("envKeyName", "")
        keys_list = env if isinstance(env, list) else [env] if env else []
        for k in keys_list:
            all_keys.add(k)
            key_to_nodes.setdefault(k, []).append(n.get("displayName", n["id"]))

    configured: list[str] = []
    missing: list[str] = []

    for key_name in sorted(all_keys):
        node_names = key_to_nodes.get(key_name, [])
        count = len(node_names)
        preview = ", ".join(node_names[:3])
        if len(node_names) > 3:
            preview += ", ..."

        masked = api_keys.get(key_name, "")
        if masked:
            configured.append(f"  {key_name:<25}{masked:<10}{count} nodes ({preview})")
        else:
            missing.append(f"  {key_name:<25}{'':10}{count} nodes unavailable")

    lines: list[str] = []
    if configured:
        lines.append("CONFIGURED KEYS:")
        lines.extend(configured)
        lines.append("")
    if missing:
        lines.append("NOT CONFIGURED:")
        lines.extend(missing)
        lines.append("")

    return "\n".join(lines)


def format_graph(state: dict[str, Any], node_defs: dict[str, dict[str, Any]] | None = None) -> str:
    """Format current graph state (nebula graph output)."""
    nodes = state.get("nodes", [])
    edges = state.get("edges", [])

    if not nodes:
        return "Graph is empty."

    lines: list[str] = []
    lines.append("NODES:")
    for n in nodes:
        nid = n["id"]
        defn = node_defs.get(n["definitionId"], {}) if node_defs else {}
        name = defn.get("displayName", n["definitionId"])
        params_str = "  ".join(f"{k}={v}" for k, v in n.get("params", {}).items())
        outputs = n.get("outputs", {})
        status = ""
        if outputs:
            first_out = next(iter(outputs.values()), {})
            val = first_out.get("value", "") if isinstance(first_out, dict) else ""
            if val:
                status = f" -> {val}"
        lines.append(f"  {nid:<6}{name:<25}{params_str}{status}")

    if edges:
        lines.append("")
        lines.append("CONNECTIONS:")
        for e in edges:
            lines.append(f"  {e['source']}:{e['sourceHandle']} -> {e['target']}:{e['targetHandle']}")

    lines.append("")
    return "\n".join(lines)


def format_context(settings: dict[str, Any], nodes: list[dict[str, Any]]) -> str:
    """Format the compact context summary (~500 tokens for Claude)."""
    api_keys = settings.get("apiKeys", {})
    configured_keys = {k for k, v in api_keys.items() if v}

    available: list[dict[str, Any]] = []
    for n in nodes:
        env = n.get("envKeyName", "")
        keys_list = env if isinstance(env, list) else [env] if env else []
        if any(k in configured_keys for k in keys_list):
            available.append(n)

    by_cat: dict[str, list[str]] = {}
    for n in available:
        cat = n.get("category", "other")
        by_cat.setdefault(cat, []).append(n.get("displayName", n["id"]))

    cat_names = {
        "image-gen": "Image", "video-gen": "Video", "text-gen": "Text/Chat",
        "audio-gen": "Audio", "3d-gen": "3D", "transform": "Transform",
        "analyzer": "Analyzer", "utility": "Utility", "universal": "Universal",
    }

    lines: list[str] = []
    lines.append(f"Nebula Nodes — {len(available)} nodes available ({len(nodes)} total)")
    lines.append("")
    lines.append(f"Configured keys: {', '.join(sorted(configured_keys)) or 'none'}")
    lines.append("")

    for cat, names in by_cat.items():
        display = cat_names.get(cat, cat)
        lines.append(f"{display}: {', '.join(sorted(names))}")

    lines.append("")
    lines.append("Port types: Text, Image, Video, Audio, Mesh, Array, SVG, Any")
    lines.append("Connections must match types (Any connects to anything).")

    return "\n".join(lines)


def format_run_results(results: dict[str, Any], node_defs: dict[str, dict[str, Any]] | None = None) -> str:
    """Format execution results."""
    outputs = results.get("results", {})
    errors = results.get("errors", {})
    duration = results.get("duration", 0)

    lines: list[str] = []
    for nid, node_outputs in outputs.items():
        if isinstance(node_outputs, dict):
            for port_id, port_val in node_outputs.items():
                val = port_val.get("value", "") if isinstance(port_val, dict) else port_val
                lines.append(f"{nid}: {val}")
        else:
            lines.append(f"{nid}: done")

    for nid, err in errors.items():
        lines.append(f"{nid}: ERROR — {err}")

    lines.append(f"\nCompleted in {duration}s")
    return "\n".join(lines)
