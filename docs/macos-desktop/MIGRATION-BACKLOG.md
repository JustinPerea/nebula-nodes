# macOS Desktop Migration Backlog

This is a dependency-ordered delivery plan for the Electron plus Python-sidecar
implementation described in [MACOS-DESKTOP-SPEC.md](./MACOS-DESKTOP-SPEC.md).

## Phase 0: Package audit

- Inventory Python native dependencies, binaries, and licenses.
- Establish Apple Silicon build and runtime compatibility for `trimesh`,
  `opencv-python-headless`, `numpy`, CairoSVG, ffmpeg/ffprobe, and agent
  subprocess requirements.
- Define the backend environment variables for app data root, output root,
  settings root, port, and sidecar authentication.

**Exit:** a reproducible local sidecar bundle launches `GET /api/health`.

## Phase 1: Desktop foundation

- Add Electron main and preload processes plus a development launcher.
- Package existing Vite production assets.
- Start and health-check FastAPI on a dynamic loopback port.
- Replace development-only Vite proxy assumptions with injected HTTP/WS bases.
- Add app lifecycle, single-instance, child termination, and startup-timeout
  behavior.

**Exit:** Canvas launches and communicates with a packaged sidecar in
development and release-like builds.

## Phase 2: State and secret migration

- Move application data roots to `~/Library/Application Support/Nebula Nodes/`.
- Introduce a key-provider abstraction in the backend.
- Implement a narrow Electron Keychain IPC service and one-time legacy-key
  import.
- Add migration status, retry, and plaintext-key detection UX.

**Exit:** a migrated graph runs using a Keychain-held provider key, with no
secret persisted in the new settings file.

## Phase 3: Native macOS integration

- Replace browser downloads and picker assumptions with native open/save
  dialogs where appropriate.
- Implement Finder reveal, native drag/drop intake, menu actions, shortcuts,
  Dock reopen behavior, and accessible error notifications.
- Add support-bundle export with secret redaction.

**Exit:** core Canvas and Create workflows work with macOS-native file and
window behavior.

## Phase 4: Distribution

- Build architecture-specific or universal application artifacts.
- Codesign Electron, the Python executable, native wheels, and helper tools.
- Notarize and staple the DMG.
- Add an opt-in signed update channel and upgrade tests.

**Exit:** a clean macOS account can install, pass Gatekeeper, launch, and
update the app.

## Phase 5: Beta acceptance

- Run fresh-install, upgrade, offline, provider-key, generation/streaming,
  cancellation/recovery, data-retention, and uninstall tests.
- Test all seven workspaces, outputs, and long-running child-process paths.
- Publish known limitations, architecture support, and diagnostics guidance.

**Exit:** beta release checklist is complete and manual acceptance evidence is
captured.
