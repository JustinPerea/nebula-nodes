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

## Failure surfaces

Startup failures are shown in the window with actionable text — the normal
workspace is never loaded:

- **Invalid Python**: names the attempted path and remediation guidance.
- **Early exit**: shows the exit code, signal, and a bounded stderr tail.
- **Health timeout**: names the sidecar, the budget, and terminates the child.

No child process or listening port remains after any failure path.

## Tests

```bash
cd desktop && npm test         # sidecar lifecycle + Electron integration
cd desktop && npm run test:smoke  # end-to-end dynamic endpoint smoke
```

## Deferred

Bundled Python, App Support migration, Keychain, per-launch bearer auth,
signing/notarization, auto-update, and paid-provider validation are not in
scope for this phase.
