# Krea full-coverage plan

Goal: every creative capability Krea exposes through its public API
(`https://api.krea.ai/openapi.json`) or its hosted MCP server
(`https://api.krea.ai/mcp`) is reachable from Nebula, through both billing
paths where Krea offers both. Branch: `feat/krea-audio-models`.

Status legend: ✅ done · 🔨 in progress · ⏳ planned · 🚫 intentionally excluded

| # | Capability | Krea surface | Nebula shape | Status |
|---|---|---|---|---|
| 0 | Image (34) / video (41) generation | `/generate/image|video/*`, MCP `generate_image|video` | Generated gateway nodes | ✅ (before this plan) |
| 0a | Audio (5) | `/generate/audio/*`, MCP `generate_audio` | Generated gateway nodes, `audio-gen` | ✅ |
| 0b | Current MCP upload response | MCP `get_upload_url` | Adapter fix (cherry-picked `bbf78e7d`) | ✅ |
| 1 | Enhance / upscale (18 API, 17 MCP) | `/generate/enhance/*`, MCP `enhance_image` | Generated gateway nodes, `transform`; Image or Video out by input | ✅ |
| 2 | 3D (10) | `/generate/3d/*`, MCP `generate_3d` | Generated gateway nodes, `3d-gen`, Mesh out | ✅ |
| 3 | 3D export OBJ/FBX/STL/PLY | `POST /export/3d` (API token only) | Krea 3D Export node | ⏳ |
| 4 | Styles, moodboards, style training on the Krea account | MCP `list_styles`, `create_style`, `update_style`, `list_moodboards`, `create_moodboard`, `update_moodboard` | `_kreaAuth` on the 6 legacy nodes | ⏳ |
| 5 | Node apps | `/node-apps*`, MCP `get_node_apps`, `get_node_app_versions`, `execute_node_app` | Krea Node App node with schema-driven inputs | ⏳ |
| 6 | Krea Files import / save | MCP `list_files`, `read_files`, `write_files_upload`, `create_folders`, `tag_files`, `list_file_tags` | Krea Files source node + Save to Krea Files node | ⏳ |
| 7 | Job history | `GET /jobs`, `GET /jobs/{id}` (API token) | Krea History source node | ⏳ |
| 8 | Agent discovery | MCP read-only tools | Add `get_prompting_guide`, `list_styles`, `list_moodboards`, `get_node_apps`, `get_node_app_versions`, `list_node_types`, `list_files` to the agent bridge | ⏳ |
| 9 | Krea Nodes round trip | MCP `list_node_types`, `create_node_workflow`, `read_node_workflow`, `update_node_workflow` | Open in Krea Nodes / import from Krea Nodes | ⏳ |
| 10 | Krea Agent | MCP `send_agent_message`, `get_agent_session`, `wait_for_agent_session` | Krea Agent node (explicit run only; billed to workspace) | ⏳ |
| 11 | Usage and plan | `GET /usage` (service key), MCP `show_plans`, `start_free_trial` | Connection card: usage, plans, trial link | ⏳ |
| 12 | Desktop apps (AE, PS, Premiere, Resolve, Blender) | MCP `list_desktop_apps`, `get_desktop_tools`, `call_desktop_tool` | Send to Desktop App node | ⏳ |
| — | API token create/list/revoke | MCP `create_api_token`, `list_api_tokens`, `revoke_api_token` | — | 🚫 credential admin stays on krea.ai (decided 2026-10-09) |

Rules that apply to every phase:

- Nothing generates, trains, uploads or spends without an explicit run.
- A node's saved billing choice (`api-token` vs `mcp`) is never switched silently.
- Credentials stay in the connector vault; never in graphs, logs or agent config.
- Where Krea offers a capability on only one billing path, the node says so and
  fails before any request on the other path.
