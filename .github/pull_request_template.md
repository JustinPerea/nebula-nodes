## What and why

<!-- What this changes, and why. -->

## Agent support (AGENTS.md, "Every feature ships with agent support")

- [ ] New or changed route, CLI command, UI action, event or `_` param: its `backend/agent_surface.py` row is added or updated (tool, read view, propose path or reasoned exemption), and `backend/data/agent_surface.json` is refreshed (`cd backend && .venv/bin/python agent_surface_check.py --write`).
- [ ] The MCP tool calls the same route or service as the UI. Logic that ran only in the frontend moved into the backend first.
- [ ] The tool returns what the UI relies on: `undo`/`previous` when the action can be undone, `baseVersion` and 409 on stale writes, a journal event so `wait_for_canvas_change` sees it.
- [ ] Spend, provider keys, auth, the person token, `_provider`/`_kreaAuth`: agents get a propose path or a read-only view, and the route has a person gate the test can see.
- [ ] `docs/MCP-SETUP.md`, `skills/nebula/SKILL.md` (if the CLI changed), the INSTRUCTIONS text and `NEBULA_MCP_TOOLS` are updated in this PR.
- [ ] `backend/tests/test_agent_surface.py` and `frontend/scripts/check-agent-surface.mjs` pass, and no new `Gap(...)` was added.
- [ ] Changes the guard can't see were checked by hand: new behaviour inside an existing route, tool or store action (a new body field, new logic in `autoLayout`), anything only the canvas computes, and state kept only in localStorage.

## Tests

<!-- What you ran, what failed first. -->
