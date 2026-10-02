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

## App Support migration

On first desktop launch, Electron migrates application data and API keys from
legacy locations into `~/Library/Application Support/Nebula Nodes/`. Browser
and Vite dev mode are unchanged — no env vars are injected and the backend
uses its default paths (`~/.nebula/`, `<repo>/output/`, `<repo>/settings.json`).

### One-time migration flow

1. Electron computes the App Support root and creates the directory tree
   (state, output, characters, moodboards, presets).
2. Legacy `settings.json` is read from the repo root. Each non-empty API key
   is encrypted with `safeStorage.encryptStringAsync()` and stored as a
   `v1:<base64>` blob in `credentials.json`.
3. A new `settings.json` is written to App Support with `apiKeys: {}` —
   non-secret settings (routing, outputPath, executionMode, etc.) are
   preserved.
4. Legacy data is copied (never deleted) from `~/.nebula/*` and
   `<repo>/output/` into the App Support tree.
5. A `migration-state.json` completion marker is written. Subsequent launches
   skip migration and proceed directly to sidecar startup.

A migration status overlay is shown during migration (loading, complete,
failed). On failure, an error message and retry button are displayed. Retry
resumes from incomplete work without deleting already-copied data.

### App Support directory structure

```
~/Library/Application Support/Nebula Nodes/
├── settings.json          (apiKeys: {} — no secrets)
├── credentials.json       (encrypted blobs: v1:<base64>)
├── migration-state.json   (completion marker)
├── state/
│   └── state.json
├── output/
│   ├── <run-dirs>/
│   └── chat-uploads/
├── characters/
├── moodboards/
└── presets/
```

### Plaintext key detection

On every desktop launch, Electron checks if App Support `settings.json`
contains any non-empty `apiKeys` entries. If plaintext keys are detected
(e.g., the user manually edited the file), a warning is shown in the
renderer. Keys should be managed through the Settings panel or the
Keychain credential service, not by editing `settings.json` directly.

## Keychain credential storage

API keys are encrypted at rest via macOS Keychain using Electron's
`safeStorage` async API (`encryptStringAsync` / `decryptStringAsync`).
Encrypted blobs are stored as `v1:<base64>` strings in `credentials.json`.

The desktop app is the credential authority. On sidecar startup, Electron
decrypts keys from the Keychain and passes them to the backend via
`NEBULA_INJECTED_KEYS` (a JSON dict). The backend stores them in a
module-level `_INJECTED_KEYS` dict (memory only, never persisted). The
`POST /api/credentials/update` endpoint allows in-memory key updates when
the user changes a key via Settings — no sidecar restart needed.

### Settings panel integration

In desktop mode (detected via `window.nebulaDesktop.credentials`):
- API key fields show a "Managed by macOS Keychain" badge.
- Saving a key calls `nebulaDesktop.credentials.set(provider, key)` →
  IPC → `safeStorage.encryptStringAsync()` → `credentials.json` →
  `POST /api/credentials/update`.
- Clearing a key calls `nebulaDesktop.credentials.clear(provider)`.
- The renderer never receives plaintext keys — the preload bridge exposes
  `set`, `has`, and `clear` but deliberately has no `get` method.
- Non-secret settings (outputPath, executionMode, etc.) still use
  `PUT /api/settings` normally.

In browser mode (no `nebulaDesktop` bridge): unchanged behavior. Keys are
stored in `settings.json` and updated via `PUT /api/settings`.

### safeStorage unavailability

If `safeStorage.isAsyncEncryptionAvailable()` returns false (e.g., no
Keychain access), setting or migrating a credential shows a clear error
state. No plaintext fallback is used — no key is written to disk in
plaintext form.

## Paper source links

The Paper source node offers **Open in Paper** and an HTTPS **Open source link**
for the exact bound file, page, and object. A browser follows these anchors in
the original click gesture. Electron delegates them through the frozen
`paperLinks.open` preload method and `shell.openExternal`.

The dedicated IPC handler accepts only canonical artwork routes:
`paper://file/<fileId>/<pageId>/<objectId>` and the corresponding
`https://app.paper.design/file/<fileId>/<pageId>/<objectId>`. It rejects other
Paper actions, other hosts/protocols, queries, fragments, credentials,
encoded paths, and normalized traversal. Only the current application window's
main frame at the configured renderer origin or packaged entry file can call it.
Opening either link does not refresh the snapshot or execute the graph.

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
| Migration failed | Disk full, permission error, or safeStorage unavailable | Check the error message in the migration overlay. Click Retry after resolving the cause. If safeStorage is unavailable, ensure the Keychain is accessible (System Settings > Privacy & Security). |
| Plaintext key warning after migration | User manually edited App Support `settings.json` and added API keys | Remove the keys from `settings.json` and re-enter them through the Settings panel so they are encrypted via Keychain. |
| Keys not persisting across restarts | safeStorage encryption key changed (e.g., after OS reinstall or keychain reset) | Re-enter keys through the Settings panel. The old encrypted blobs cannot be decrypted. |
| "SAFE_STORAGE_UNAVAILABLE" in Settings | Keychain access denied or safeStorage not ready | Ensure the app has Keychain access. On first use macOS may prompt for permission. |

## Tests

```bash
cd desktop && npm test            # 227 Node lifecycle + credential + migration + integration tests
cd desktop && npm run test:smoke  # end-to-end dynamic endpoint + bridge surface smoke
```

The Node test suite covers: runtime override and fallback, ephemeral port
allocation and collision retry, spawn argv/cwd, health and WebSocket readiness
identity, early exit, timeout, bounded diagnostics and secret sanitization,
SIGTERM grace, SIGKILL escalation, post-readiness no-auto-restart, normal and
escalated child cleanup, single-instance lock and isolation, quit during cold
startup, App Support path computation and env-var injection, credential
encryption round-trip and persistence, provider allowlist validation, sender
validation, safeStorage unavailability handling, one-time migration (copy,
encrypt, idempotent, non-destructive), migration status overlay, and plaintext
key detection.

## Validation

The full Phase 2 regression gate runs every programmatic command and the
required live checks:

```bash
# Programmatic gate — all must exit zero
cd desktop && npm test                          # 227 Node lifecycle + credential + migration + integration tests
cd desktop && npm audit                         # 0 vulnerabilities
cd frontend && npm test                         # 777 Vitest tests
cd frontend && npm run lint                     # ESLint + style guards
cd frontend && npm run build:desktop            # tsc + vite build + budget check
backend/.venv/bin/python -m pytest backend     # 2,248 backend tests

# Live Electron smoke — proves dynamic endpoint injection + bridge surface
cd desktop && npm run test:smoke
```

Live browser and Electron validation use `agent-browser` with isolated CDP
ports and user-data directories. The Vite browser check confirms no preload
bridge and normal backend discovery. The Electron smoke confirms the injected
`apiBaseUrl`/`wsBaseUrl` are on a dynamic non-8000 port with health and
WebSocket confirmed, and verifies the credential and migration bridge surface
(frozen objects, no `get` method, no `require`/`ipcRenderer` exposure).

After every validation run, verify no orphan processes remain:

```bash
pgrep -f "uvicorn main:app" || echo "No uvicorn orphans"
pgrep -f "nebula_nodes/desktop.*[Ee]lectron" || echo "No Electron orphans"
```

## Deferred

Bundled Python, signing/notarization, auto-update, per-launch bearer auth,
and paid-provider validation are not in scope for this phase.
