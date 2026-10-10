# Krea full-coverage plan

Goal: every creative capability Krea exposes through its public API
(`https://api.krea.ai/openapi.json`) or its hosted MCP server
(`https://api.krea.ai/mcp`) is reachable from Nebula, through both billing
paths where Krea offers both. Branch: `feat/krea-audio-models`. All phases
are done; live paid runs of the new workspace nodes are still to be checked
(see `implementation-notes.md`).

Status legend: ✅ done · 🔨 in progress · ⏳ planned · 🚫 intentionally excluded

| # | Capability | Krea surface | Nebula shape | Status |
|---|---|---|---|---|
| 0 | Image (34) / video (41) generation | `/generate/image|video/*`, MCP `generate_image|video` | Generated gateway nodes | ✅ (before this plan) |
| 0a | Audio (5) | `/generate/audio/*`, MCP `generate_audio` | Generated gateway nodes, `audio-gen` | ✅ |
| 0b | Current MCP upload response | MCP `get_upload_url` | Adapter fix (cherry-picked `bbf78e7d`) | ✅ |
| 1 | Enhance / upscale (18 API, 17 MCP) | `/generate/enhance/*`, MCP `enhance_image` | Generated gateway nodes, `transform`; Image or Video out by input | ✅ |
| 2 | 3D (10) | `/generate/3d/*`, MCP `generate_3d` | Generated gateway nodes, `3d-gen`, Mesh out | ✅ |
| 3 | 3D export OBJ/FBX/STL/PLY | `POST /export/3d` (API token only) | Krea 3D Export node (`krea-3d-export`): wire a 3D job, get the model file, all files and the ZIP | ✅ |
| 4 | Styles, moodboards, style training on the Krea account | MCP `list_styles`, `create_style`, `update_style`, `list_moodboards`, `create_moodboard`, `update_moodboard` | `_kreaAuth` on Krea 2 Generate / Style Search / Style Train; new Krea Moodboards, Moodboard Create, Library Manage | ✅ |
| 5 | Node apps | `/node-apps*`, MCP `get_node_apps`, `get_node_app_versions`, `execute_node_app` | Krea Node App (`krea-node-app`): schema-checked inputs, both billing paths; the account path runs public and workspace-shared apps | ✅ |
| 6 | Krea Files import / save | MCP `list_files`, `read_files`, `create_folders`, `write_files_upload`, `write_files_inline`, `tag_files` | Krea Files (`krea-files`) and Save to Krea Files (`krea-files-save`), account only; raw-byte uploads, multipart grants refused | ✅ |
| 7 | Job history | `GET /jobs`, `GET /jobs/{id}`, MCP `get_job` | Krea Job History (`krea-job-history`): listing needs an API token, one job by ID works on either path | ✅ |
| 8 | Agent discovery | MCP read-only tools | Add `get_prompting_guide`, `list_styles`, `list_moodboards`, `get_node_apps`, `get_node_app_versions`, `list_node_types` to the agent bridge, except `list_files` (dropped after a security review: private and workspace-shared file names would reach the agent's model provider); one allowlist shared by the bridge and the backend route | ✅ |
| 9 | Krea Nodes round trip | MCP `create_node_workflow`, `read_node_workflow`, `update_node_workflow` | Krea Nodes Workflow (`krea-nodes-workflow`): create returns an Open in Krea Nodes link; read and edit take a typed workflow ID only | ✅ |
| 10 | Krea Agent | MCP `send_agent_message`, `wait_for_agent_session` | Krea Agent (`krea-agent`): explicit run only, billed to the workspace, deliverables saved into the run | ✅ |
| 11 | Usage and plan | `GET /usage` (enterprise workspace service key only; personal API keys are refused), MCP `show_plans`, `start_free_trial` | Krea Usage node (`krea-usage`, `KREA_USAGE_KEY`); plans and trial link on the Settings connection card (`GET /api/krea/plans`, `POST /api/krea/trial`) | ✅ |
| 12 | Desktop apps (AE, PS, Premiere, Resolve, Blender) | MCP `list_desktop_apps`, `get_desktop_tools`, `call_desktop_tool` | Krea Desktop Apps (`krea-desktop`): list apps, list tools, run one tool with a typed app ID and schema-checked input | ✅ |
| — | API token create/list/revoke | MCP `create_api_token`, `list_api_tokens`, `revoke_api_token` | — | 🚫 credential admin stays on krea.ai (decided 2026-10-09) |

Rules that apply to every phase:

- Nothing generates, trains, uploads or spends without an explicit run.
- A node's saved billing choice (`api-token` vs `mcp`) is never switched silently.
- Credentials stay in the connector vault; never in graphs, logs or agent config.
- Where Krea offers a capability on only one billing path, the node says so and
  fails before any request on the other path.
