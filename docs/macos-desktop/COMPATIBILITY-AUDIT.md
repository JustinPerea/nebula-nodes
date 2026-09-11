# macOS Desktop Compatibility Audit

The React/Vite frontend and FastAPI backend remain the shared application.
This audit identifies the current assumptions that the Electron integration
must replace or preserve.

| Area | Current assumption | Desktop adaptation | Phase |
|---|---|---|---|
| API transport | Vite proxies `/api` and `/ws` to fixed port 8000 | Inject dynamic loopback HTTP/WS bases from preload | 1 |
| Backend startup | Developer starts uvicorn manually | Main process owns sidecar start, health probe, restart/error state, and shutdown | 1 |
| Browser APIs | `window`, download links, and web dialogs are available | Keep browser-compatible surfaces; use reviewed IPC for native actions | 1-3 |
| File selection | Browser upload/download flows | Native dialogs for open/save when they improve the macOS workflow | 3 |
| Finder reveal | Existing local development path | Main-process `shell.showItemInFolder` with path-containment validation | 3 |
| Settings and keys | Local backend settings files | App Support data root plus Keychain-backed secret provider | 2 |
| Outputs | Configurable local output directory | Default to App Support outputs; retain explicit user-selected export directories | 2-3 |
| WebSocket streaming | Browser connects through Vite proxy | Renderer connects to authenticated dynamic loopback sidecar | 1 |
| CSP and workers | Browser build policy, Spark/Lottie runtime-codegen guards | Packaged CSP plus equivalent worker/asset loading tests | 1 |
| Python dependencies | Local Python 3.12 environment | Bundle and codesign a tested Python runtime and all native dependencies | 0, 4 |
| ffmpeg/ffprobe | Assumed on developer PATH | Bundle approved binaries or detect and clearly report managed prerequisites | 0, 4 |
| Agent subprocesses | Codex, Claude, and Hermes rely on local CLI/auth state | Preserve as optional macOS capabilities with explicit availability checks | 3, 5 |
| Three/Spark viewers | Chromium/WebGL behavior | Test packaged Electron GPU, worker, and file-URL policies | 1, 5 |
| Remotion | Node and browser runtime tooling | Package renderer dependencies and validate render subprocess paths | 4, 5 |
| Diagnostics | Developer terminal logs | Redacted app logs, startup failure UI, and exportable support bundle | 3 |

## Required proof tests

1. Dynamic port and sidecar token are unavailable to non-Electron processes.
2. Renderer reload reconnects to the running sidecar without losing run state.
3. Sidecar crash produces an actionable recovery UI and no orphaned process.
4. API keys are unreadable from renderer JavaScript, app settings, and logs.
5. Packaged World/3D and video workflows pass on a clean Apple Silicon system.
