# Nebula Desktop

Electron shell with a managed FastAPI sidecar. A single command starts a
dynamic-port backend and then the packaged renderer — no manual `uvicorn`
or Vite dev server is required.

## Quick start (packaged renderer)

```bash
cd frontend && npm run build:desktop
cd ../desktop && npm run start
```

Electron acquires the single-instance lock, starts one uvicorn sidecar on an
OS-assigned loopback port, waits for confirmed Nebula health, injects the
immutable API/WS endpoints through the sandboxed preload bridge, and then
mounts the normal renderer.

## Development mode

```bash
cd frontend
npm run dev
```

```bash
cd desktop
npm run start:dev
```

In development mode the renderer loads from the Vite dev server. The managed
sidecar still starts and injects endpoints through preload.

## Smoke test

```bash
cd desktop && npm run test:smoke
```

The smoke run starts the sidecar, loads the packaged renderer, and verifies
that the injected `apiBaseUrl`/`wsBaseUrl` are on a dynamic non-8000 port,
`/api/health` returns the Nebula identity, and `/ws` handshakes. It exits 0
on success and emits `NEBULA_DESKTOP_SMOKE {"passed":true,...}` to stdout.

## Runtime overrides

| Variable | Purpose |
|---|---|
| `NEBULA_DESKTOP_PYTHON` | Explicit Python executable for the sidecar. Defaults to `backend/.venv/bin/python`. |
| `NEBULA_DESKTOP_HEALTH_TIMEOUT_MS` | Test-only shorter health timeout. Production default is 60 s. |
| `NEBULA_DESKTOP_DEBUG_PORT` | Loopback CDP port for Electron validation. |
| `NEBULA_DESKTOP_USER_DATA_DIR` | Test-only isolated user-data directory. |
| `NEBULA_DESKTOP_APP_ID` | Test-only isolated application identity for concurrent validators. Must be paired with `NEBULA_DESKTOP_USER_DATA_DIR`. |
| `NEBULA_DESKTOP_SMOKE` | Set to `1` to run the end-to-end smoke test (exits 0/1). |
| `VITE_DEV_SERVER_URL` | Set to the Vite dev server URL for development mode (used by `npm run start:dev`). |

## Failure surfaces and diagnostics

Startup failures are shown in the window with actionable text — the normal
workspace is never loaded. A loading spinner appears while the sidecar is
starting; it is replaced by the failure surface on error.

- **Invalid Python**: the window shows the attempted absolute path and
  remediation guidance (correct the override or restore the verified runtime).
  Fails within seconds — no child is spawned.
- **Early exit**: shows the exit code, signal, and a bounded stderr tail
  (diagnostics are capped at a fixed byte limit and never contain credentials).
  Fails within seconds.
- **Health timeout**: after the 60-second production budget, the child is
  terminated and the window shows an actionable timeout message naming the
  sidecar and the budget.
- **Mid-session exit**: if the sidecar exits after the renderer has loaded,
  a "Backend disconnected" overlay appears. No auto-restart occurs and
  reconnect attempts target only the dead injected origin — no rediscovery.

No child process or listening port remains after any failure path.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "NEBULA_DESKTOP_PYTHON is invalid" | Override path does not exist or is not executable | Set `NEBULA_DESKTOP_PYTHON` to a valid Python executable, or unset it to use `backend/.venv/bin/python`. |
| "Sidecar failed to start" with exit code | Python exits before health (import error, missing dependency) | Check the stderr tail in the failure surface; run `backend/.venv/bin/python -c "import fastapi, uvicorn"` to verify the venv. |
| Health timeout after 60 s | Cold startup exceeds budget or backend import hangs | First cold import can take ~40 s. If it exceeds 60 s, check for `PYTHONPATH` contamination or missing dependencies. |
| Blank window | Renderer build is stale or missing | Run `cd frontend && npm run build:desktop` to rebuild the packaged renderer. |
| Port already in use | A previous sidecar did not shut down cleanly | Check `lsof -nP -iTCP -sTCP:LISTEN` for orphaned uvicorn processes and kill them by PID. |

## Tests

```bash
cd desktop && npm test            # sidecar lifecycle + Electron integration (59 tests)
cd desktop && npm run test:smoke  # end-to-end dynamic endpoint smoke
```

The Node test suite covers: runtime override and fallback, ephemeral port
allocation and collision retry, spawn argv/cwd, health and WebSocket readiness
identity, early exit, timeout, bounded diagnostics and secret sanitization,
SIGTERM grace, SIGKILL escalation, post-readiness no-auto-restart, and
normal/escalated child cleanup.

## Validation

The full Phase 2 regression gate runs every programmatic command and the
required live checks:

```bash
# Programmatic gate — all must exit zero
cd desktop && npm test                          # 59 Node lifecycle + integration tests
cd desktop && npm audit                         # 0 vulnerabilities
cd frontend && npm test                         # 762 Vitest tests
cd frontend && npm run lint                     # ESLint + style guards
cd frontend && npm run build:desktop            # tsc + vite build + budget check
backend/.venv/bin/python -m pytest backend     # 1,973 backend tests

# Live Electron smoke — proves dynamic endpoint injection
cd desktop && npm run test:smoke
```

Live browser and Electron validation use `agent-browser` with isolated CDP
ports and user-data directories. The Vite browser check confirms no preload
bridge and normal backend discovery. The Electron smoke confirms the injected
`apiBaseUrl`/`wsBaseUrl` are on a dynamic non-8000 port with health and
WebSocket confirmed.

After every validation run, verify no orphan processes remain:

```bash
pgrep -f "uvicorn main:app" || echo "No uvicorn orphans"
pgrep -f "nebula_nodes/desktop.*[Ee]lectron" || echo "No Electron orphans"
```

## Deferred

Bundled Python, App Support migration, Keychain, per-launch bearer auth,
signing/notarization, auto-update, and paid-provider validation are not in
scope for this phase.
