# Nebula Desktop

Electron shell with a managed FastAPI sidecar. One click on **Nebula.app**
(or `npm run start`) starts a dynamic-port backend and then the packaged
renderer — no manual `uvicorn` or Vite dev server is required. Browser dev
(`backend/devserver.py` + Vite, see the root README) stays the way to develop.

## Nebula.app (everyday use)

`npm run package` builds a real macOS app, **Nebula.app**, with the Nebula
icon. Double-click it (or click it in the Dock) and it starts the backend and
opens the canvas; quit it and the backend stops.

```bash
cd desktop
npm install          # once
npm run package      # builds desktop/out/Nebula-darwin-arm64/Nebula.app
npm run install-app  # copies it to ~/Applications (run this yourself, in a terminal)
```

Then open **Nebula** from `~/Applications`, Spotlight or Launchpad. To keep it
in the Dock, right-click its Dock icon while it runs and choose
Options > Keep in Dock. `npm run package` rebuilds `frontend/dist-desktop`
first when it is missing or older than the frontend sources
(`--rebuild-renderer` forces it).

**It runs your checkout, not a copy.** The bundle holds Electron, the icon and
a small bootstrap (`packaging/bootstrap.mjs`) plus `nebula-app.json`, which
records this checkout's absolute path. At every launch the bootstrap checks
that the checkout still has `desktop/main.mjs`, `backend/main.py` and an
executable `backend/.venv/bin/python`, then runs the checkout's own
`desktop/main.mjs`. So after `git pull`:

| What changed | What to do |
|---|---|
| Backend (`backend/`) or Electron main/preload (`desktop/*.mjs`, `preload.cjs`) | Nothing. Quit and reopen Nebula. |
| Frontend (`frontend/`) | `cd frontend && npm run build:desktop` (or `cd desktop && npm run package`), then reopen. |
| Electron version in `desktop/package.json` | `cd desktop && npm install && npm run package && npm run install-app`. The app logs a warning when the checkout pins a different Electron than the bundle runs. |
| You moved the checkout | Re-run `npm run package && npm run install-app` from the new place. Until then the app shows a dialog naming the missing path and quits. |

If the venv is missing, the app shows a dialog with the command that creates
it and quits, before it creates any app data or starts anything. Python is not
bundled.

**Signing.** Nebula.app is not signed with a Developer ID and not notarized;
it is for local use on the Mac that built it. `npm run package` ad-hoc signs it
(`codesign --sign -`) so the bundle is internally consistent after packager
rewrites `Info.plist` and the icon. Apple's
[Gatekeeper documentation](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web)
describes the identified-developer, notarization and first-open approval checks
as applying to software that is downloaded and opened. A bundle built locally
has no `com.apple.quarantine` attribute (checked on the build:
`xattr -l` shows only `com.apple.provenance`), and it opened with `open`
without a prompt in validation, although `spctl --assess` reports it as
`rejected`. If you copy it to another Mac through a download, AirDrop or a
browser, it arrives quarantined and macOS blocks the first open. Apple's
[steps](https://support.apple.com/en-us/102445) then apply: try to open it,
then System Settings > Privacy & Security > **Open Anyway**. Building on that
Mac avoids this.

**Hardening.** Before the codesign, `npm run package` flips Electron's fuses
(`packaging/fuses.mjs`, with `@electron/fuses`) and reads them back:
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and the `--inspect` arguments are
compiled out, so the app binary can't be run as plain Node or have the Node
inspector attached, and cookie encryption is on. That hardens the binary, not
the code it runs: see [What the keychain prompt does and doesn't
protect](#what-the-keychain-prompt-does-and-doesnt-protect). Check with
`npx electron-fuses read --app out/Nebula-darwin-arm64/Nebula.app`. The
file:// privilege fuse stays on: without it Chromium gives the renderer the
origin `null` and blocks its own scripts. Instead, `renderer-files.mjs`
intercepts the `file:` scheme and serves only files inside
`frontend/dist-desktop`, so the renderer can't read the repo-root
`settings.json` or anything else on disk. A normal Nebula.app opened with
Chromium or Node debug switches (`open -a Nebula --args
--remote-debugging-port=9222`, `--remote-debugging-pipe`, `--inspect*`) shows
a dialog and quits, before it opens a port or starts the backend.
`npm run start` keeps the stock Electron binary and its fuses.

**Keychain.** The bundle keeps the Electron app name `nebula-desktop` (no
`productName`), so it uses the same profile directory, single-instance lock and
"nebula-desktop Safe Storage" keychain item as `npm run start`. Only one of the
two can run at a time. Because the ad-hoc signature differs from the
`npm run start` Electron binary's, macOS may ask whether Nebula may use that
keychain item. Apple's
[Keychain Access guide](https://support.apple.com/guide/keychain-access/if-youre-asked-for-access-to-your-keychain-kyca1243/mac)
describes the three answers:

- **Always Allow**: this build of Nebula reads the item from now on without
  asking. Re-packaging gives the bundle a new ad-hoc signature, so the
  question may come back after `npm run package`.
- **Allow Once**: this time only; it asks again next time.
- **Deny**: Nebula can't read the key, so it can't decrypt saved API keys or
  encrypt new ones. Nothing falls back to plaintext. (Not tried live: that
  would touch the real login keychain.)

Always Allow is the convenient choice and costs little, for the reason in
[What the keychain prompt does and doesn't protect](#what-the-keychain-prompt-does-and-doesnt-protect):
the prompt keeps *other apps* away from the item, but it can't
vouch for the code Nebula itself runs. (Electron's
[code-signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing)
also notes that ad-hoc signed apps can behave inconsistently with
`safeStorage`.)

**Your data.** Nebula.app and `npm run start` both keep data in
`~/Library/Application Support/Nebula Nodes/`. Browser dev
(`backend/devserver.py` + Vite) keeps using `~/.nebula`, `<repo>/output` and the
repo's `settings.json`. The first desktop launch *copies* from those into App
Support (it never deletes or moves anything; see
[App Support migration](#app-support-migration)), and from then on the two
sets of data are separate: projects, outputs and settings made in the app don't
show up in browser dev, and the other way round.

If App Support already has a `migration-state.json` with `"status": "complete"`
(this is the case on a Mac where the desktop app ran before), the migration is
skipped entirely. The app opens with what App Support already holds and copies
nothing newer from browser dev, and API keys added to the repo's
`settings.json` since then are not imported: the app asks for them again, so
add them in the app's Settings (they go to the Keychain). Two ways to import
instead, both with Nebula quit and neither deleting anything:

- **Start fresh from browser dev:** move the whole
  `~/Library/Application Support/Nebula Nodes` folder aside (rename it, say to
  `Nebula Nodes.old`). The next launch finds no folder and runs the full copy.
- **Top up the existing data:** move only `migration-state.json` out of that
  folder. The next launch re-runs the copy into what's there: it encrypts repo
  keys for providers not already in `credentials.json`, keeps the existing App
  Support `settings.json`, and copies only files that don't exist at the
  destination (it never overwrites).

**Quitting.** Cmd-Q, Nebula > Quit, or a SIGTERM/SIGINT/SIGHUP to the app stop
the backend (SIGTERM, then SIGKILL after 5 s) before the app exits, and free its
port. Closing the window keeps the app and backend running (macOS
convention); click the Dock icon, or open Nebula again from Finder,
Spotlight or `npm run start`, to bring the window back (`window-recovery.mjs`;
a second launch never starts a second backend). If the app crashes or is
force-quit, the backend notices on its own: Electron hands it one end of a
pipe as fd 3 (`NEBULA_PARENT_WATCH_FD`) and never writes to it, the kernel
closes Electron's end when Electron dies, and
`backend/services/parent_watch.py` then shuts uvicorn down (hard exit after
5 s). In validation the backend was gone 0.2 s after a `kill -9` of the app.
The backend removes `NEBULA_PARENT_WATCH_FD` from its environment as soon as
it reads it, and `services/child_env.py` strips it as well, so an agent's
shell, ffmpeg or a backend test run started from inside the app never
inherits it (a child that did would watch an unrelated fd and stop itself).

Agent chats (Claude Code, Codex) run in their own process group, so stopping
the backend doesn't signal them directly. On a normal stop (Cmd-Q, SIGTERM to
the app or to the backend) the backend's chat socket closes, the turn is
cancelled and the agent's whole process tree is killed before it exits. If the
backend is killed outright (the SIGKILL after 5 s, the parent watch's hard
exit, a crash), a small guardian process it started
(`backend/services/agent_guardian.py`) sees its pipe close and kills every
agent tree that's still running. Checked live in the validation app with a
fake agent CLI that starts a descendant in its own session: quitting the app,
SIGTERM or SIGKILL to the backend, and `kill -9` of the app all left no agent
process behind.

**Validation builds.** A normal Nebula.app ignores every dev/test override
(see [Runtime overrides](#runtime-overrides)), so it can't be launched against
a throwaway profile. `npm run package -- --validation` builds a separate,
test-only bundle in `desktop/out/validation/` that honours them, for checking
the real bundle without touching your data:

```bash
open -n --env NEBULA_DESKTOP_USER_DATA_DIR=/tmp/nebula-check \
  --env NEBULA_DESKTOP_APP_ID=nebula-check --env NEBULA_DESKTOP_TEST=1 \
  desktop/out/validation/Nebula-darwin-arm64/Nebula.app
```

`install-app` refuses validation builds.

**Icon.** `build/icon.icns` (bundle) and `build/icon.png` (Dock icon for
`npm run start`) are generated from `frontend/public/favicon.svg` by
`npm run make-icon` (`scripts/make-icon.sh`, macOS `sips` + `iconutil` only)
and committed, so packaging doesn't need to regenerate them.

## Quick start (development, `npm run start`)

```bash
cd frontend && npm run build:desktop
cd ../desktop && npm run start
```

`npm run start` runs the stock Electron binary; it sets the Dock icon to
`build/icon.png` so it looks like Nebula.app.

`build:desktop` writes the packaged renderer to `frontend/dist-desktop/`, built
with relative asset URLs so it resolves over `file://`. It has its own folder
because the web build (`npm run build`, absolute `/assets/...` URLs) used to
overwrite it in `frontend/dist/`, and the window then loaded an empty `#root`.
If `dist-desktop/index.html` is missing, the window says so and names the
command before it creates any app data, runs the migration or starts a sidecar. The build's budget check also refuses a
desktop bundle with root-absolute asset URLs.

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
decrypts keys from the Keychain and writes them to the sidecar's stdin as one
JSON line right after the person token, together with the Krea connector
vault key (`{"injectedKeys": {...}, "connectorEncryptionKey": "..."}`,
`NEBULA_LAUNCH_SECRETS_STDIN=1`; `sidecar.mjs` `launchSecretsLine`,
`backend/services/launch_secrets.py`). They never go in the sidecar's
environment: any program running as you can read a process's initial
environment with `ps -E`, and the desktop pass found a planted key there when
they did (`NEBULA_INJECTED_KEYS` / `NEBULA_CONNECTOR_ENCRYPTION_KEY`, now
stripped from the child env). A missing or malformed line fails closed: no
provider keys and no Krea connection that launch.

Keys a terminal already had don't get through either. Opening Nebula.app from
a shell that exports `OPENAI_API_KEY`, `FAL_KEY`, `REPLICATE_API_TOKEN` and so
on used to pass them into the sidecar's environment. `sidecar.mjs` now drops
every provider key name (`INHERITED_CREDENTIAL_ENV_KEYS`: `credentials.mjs`
`ALLOWED_PROVIDERS`, which a test keeps equal to
`backend/services/credential_catalog.py`) plus `NEBULA_APP_TOKEN` and
`NEBULA_AGENT_TOKEN`. The Keychain is the only key source in the app. A shell
key would otherwise sit in `ps -E`, reach every agent child (Claude in `-p`
mode bills an `ANTHROPIC_API_KEY` ahead of your subscription login), and quietly
back up a provider SDK that reads its own variable. The backend stores the keys
in a module-level `_INJECTED_KEYS` dict (memory only, never persisted). The
`POST /api/credentials/update` endpoint allows in-memory key updates when
the user changes a key via Settings — no sidecar restart needed. It is
person-only, like `PUT /api/settings`: it needs this launch's person token.

### What the keychain prompt does and doesn't protect

Nebula.app is trusted with the "nebula-desktop Safe Storage" item, but at
every launch it imports `desktop/main.mjs`, `preload.cjs` and the other
modules from your checkout, which any program running as you can edit. So
anything that can write the repo (a script, a dependency's install hook, an
agent with write access to the checkout) gets its code run inside the
keychain-trusted app on the next launch, where it can decrypt
`credentials.json` the same way Nebula does. The fuses above don't change
that: they stop the *binary* being used as Node or debugged, not the app
loading changed JavaScript from the checkout.

How that compares:

- **Browser dev** keeps keys in plaintext in the repo's `settings.json`, which
  any process running as you can read at any time, no launch needed. The app
  is no worse than that, and better against a program that only *reads*
  files: `credentials.json` is useless without the keychain item.
- **But the keychain prompt isn't protection against local code.** Once
  Nebula is allowed, whoever can change the checkout can read the keys
  through Nebula. Treat write access to this repo as access to your API keys.

This is the price of "`git pull` updates the app" (see
[It runs your checkout](#nebulaapp-everyday-use)), and it's kept on purpose.
Closing this takes more than locking down the Electron side. At launch the
main process decrypts every provider key and the connector encryption key and
sends them over stdin to the checkout's backend, which runs as
`backend/.venv/bin/python` from the checkout. The backend code and the venv
stay writable too. A dependency install hook that edits
`backend/services/launch_secrets.py`, or a `.pth`/`sitecustomize.py` dropped
into `backend/.venv`, gets every key in plaintext on the next launch, with no
rebuild and no keychain prompt.

So any later fix has to cover all three: the main-process code, the backend
code, and the interpreter with its site-packages. One option is to bundle the
main-process code (`main.mjs`, `preload.cjs` and their imports) into an asar
with Electron's integrity fuses on, and ship a frozen backend and Python inside
the app, so a change to any of it needs `npm run package` (and a new keychain
approval) before it runs with the keys. A lighter variant would check hashes of
`desktop/*.mjs`, `backend/**/*.py` and the venv at launch against ones recorded
at packaging time. A third is to stop handing keys to the checkout's Python
at all and make provider calls through a component inside the bundle. Every
option makes a code change a rebuild, which is why none is done yet. Bundling
or hashing only the Electron side would leave the backend path open, so it's
not a partial fix.

### Person token

Electron main makes one person token per launch (`person-token.mjs`). It goes
to the sidecar over stdin (`NEBULA_PERSON_TOKEN_STDIN=1`), never argv or env,
and to the renderer only through the frozen `nebulaDesktop.person.token()`
preload method, whose `person:token` IPC handler answers only the application
window's main frame. The renderer sends it as `X-Nebula-Person` on requests to
its own sidecar, in the `/ws` hello frame and with each chat turn; Settings,
keys, Krea connections, proposals and chats need it (see
[docs/MCP-SETUP.md](../docs/MCP-SETUP.md#who-counts-as-the-person)).

- `NEBULA_DESKTOP_DEBUG_PORT` set, or debug switches on the command line
  (`--remote-debugging-port`, `--remote-debugging-pipe`, `--inspect*`, also in
  `NODE_OPTIONS`): no token at all, because anything on the machine can drive
  a renderer with an open debug port. Person-only actions stay locked and the
  window says why. A normal Nebula.app refuses to start with those switches.
- `VITE_DEV_SERVER_URL` (desktop dev): no token unless
  `NEBULA_DESKTOP_DEV_PERSON=1`.

### Settings panel integration

In desktop mode (detected via `window.nebulaDesktop.credentials`):
- The Providers tab notes that keys are stored in the macOS Keychain.
- Each key saves on its own. **Save key** calls
  `nebulaDesktop.credentials.set(provider, key)` → IPC →
  `safeStorage.encryptStringAsync()` → `credentials.json` →
  `POST /api/credentials/update`, then runs a read-only connection check.
- **Remove** (two presses, in the row's ⋯ menu) calls
  `nebulaDesktop.credentials.clear(provider)`, then
  `POST /api/credentials/update` with an empty value.
- The renderer never receives plaintext keys — the preload bridge exposes
  `set`, `has`, and `clear` but deliberately has no `get` method.
- Non-secret settings (outputPath, executionMode, etc.) still use
  `PUT /api/settings` normally.

In browser mode (no `nebulaDesktop` bridge): keys are stored in
`settings.json`. Saving one sends `PUT /api/settings` with just that key;
removing one calls `DELETE /api/settings/api-keys/{provider}`.

### Folder picker

The Storage tab's **Choose…** buttons call the frozen
`nebulaDesktop.folders.choose(defaultPath)` preload method, which invokes the
`dialog:choose-folder` IPC handler (`folder-picker.mjs`). The handler shows the
native folder dialog over the main window and returns `{ ok, path }`, with
`path: null` on cancel. It accepts calls only from the application window's
main frame, and uses `defaultPath` only when it is an absolute path without
control characters. Picking a folder saves it through `PUT /api/settings`;
the renderer never touches the filesystem itself.

Checked in the packaged validation app (renderer served through
`renderer-files.mjs`, secrets over stdin), with only the native dialog
stubbed: Storage > Choose… opened the picker over the main window
(`openDirectory`, `createDirectory`), the save was a `PUT /api/settings` 200
carrying the person token, the picked path landed in `outputPath`, and the
same PUT without the token got 403.

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
`/api/health` returns the Nebula identity, and `/ws` handshakes. In an
isolated profile (`NEBULA_DESKTOP_USER_DATA_DIR`) it also saves a setting the
way the Settings panel does (person token over IPC, then `PUT /api/settings`
with `X-Nebula-Person`) and checks that the same save without the token is
refused. In the same profiles it checks the other person paths from the
packaged page: `GET /api/agent/spend` (`limited: false` only with the token),
the `/ws` hello (`proposalSync` with the token, `personRequired` with a wrong
one), and the Krea connector's status, check and disconnect (200 with the
token, 403 `person_required` without; none of them reaches Krea). With a
debug port open there is no token, so those checks report `skipped`. It never writes settings in a real profile. `NEBULA_DESKTOP_SMOKE=1`
works the same against a validation Nebula.app binary. It exits 0
on success and emits `NEBULA_DESKTOP_SMOKE {"passed":true,...}` to stdout.

## Runtime overrides

| Variable | Purpose |
|---|---|
| `NEBULA_DESKTOP_PYTHON` | Explicit Python executable for the sidecar. Defaults to `backend/.venv/bin/python`. Dev/test only: that process receives the person token and the provider keys. |
| `NEBULA_DESKTOP_HEALTH_TIMEOUT_MS` | Test-only shorter health timeout. Production default is 60 s. Dev/test only. |
| `NEBULA_DESKTOP_DEBUG_PORT` | Loopback CDP port for Electron validation. Dev/test only. |
| `NEBULA_DESKTOP_USER_DATA_DIR` | Test-only isolated profile. Electron's user data, the app data root (`<dir>/Nebula Nodes/`) and the migration sources (`<dir>/legacy/`, normally absent) all stay inside it, so an isolated launch never reads the repo's `settings.json` or `~/.nebula` and never writes to `~/Library/Application Support`. On its own it still uses the real login keychain for safeStorage. |
| `NEBULA_DESKTOP_APP_ID` | Test-only isolated application identity for concurrent validators. Must be paired with `NEBULA_DESKTOP_USER_DATA_DIR`. |
| `NEBULA_DESKTOP_TEST` | Set to `1` together with `NEBULA_DESKTOP_USER_DATA_DIR` for a throwaway test profile: safeStorage switches to Chromium's mock keychain, so the run leaves no "<app id> Safe Storage" item in the login keychain. The mock key is a fixed public constant, so anything saved in that profile is effectively unencrypted (main logs a warning). Never type real API keys into such a profile. Without a user-data dir it does nothing. |
| `NEBULA_DESKTOP_SMOKE` | Set to `1` to run the end-to-end smoke test (exits 0/1). Dev/test only. |
| `VITE_DEV_SERVER_URL` | Set to the Vite dev server URL for development mode (used by `npm run start:dev`). |

A packaged build (`app.isPackaged`) ignores `NEBULA_DESKTOP_DEBUG_PORT`,
`NEBULA_DESKTOP_USER_DATA_DIR`, `NEBULA_DESKTOP_APP_ID`, `NEBULA_DESKTOP_TEST`,
`VITE_DEV_SERVER_URL`, `NEBULA_DESKTOP_DEV_PERSON`, `NEBULA_DESKTOP_PYTHON`,
`NEBULA_DESKTOP_SMOKE` and `NEBULA_DESKTOP_HEALTH_TIMEOUT_MS`, and logs which
ones it ignored. A test (`launch-overrides.test.mjs`) fails if desktop code
reads a new `NEBULA_DESKTOP_*` variable that isn't on that list. Its environment can be
set from outside (`launchctl setenv`, a wrapper script), and none of these
should be able to move its profile, weaken its keychain, open a debug port,
swap its renderer or swap the interpreter that gets the keys. Command-line
debug switches are handled separately (see the person token section). `launch-overrides.mjs` holds
that rule. The one exception is a validation bundle
(`npm run package -- --validation`, `packaged-launch.mjs`), which is built
for testing, lives in `desktop/out/validation/` and is refused by
`install-app`.

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
| "The desktop renderer is not built" | `frontend/dist-desktop/` is missing | Run `cd frontend && npm run build:desktop`. |
| Blank window | Renderer build is stale | Run `cd frontend && npm run build:desktop` to rebuild the packaged renderer. |
| Port already in use | A previous sidecar did not shut down cleanly | Check `lsof -nP -iTCP -sTCP:LISTEN` for orphaned uvicorn processes and kill them by PID. Sidecars started by this version exit on their own when Electron dies (parent watchdog). |
| Nebula.app: "Nebula can't find its code." | The checkout named in the bundle's `nebula-app.json` moved or was deleted | From the checkout: `cd desktop && npm run package && npm run install-app`. |
| Nebula.app: "Nebula's backend environment is missing." | `backend/.venv` is missing or broken | `cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`. |
| Nebula.app asks to use "nebula-desktop Safe Storage" | The ad-hoc signed bundle is a different binary from the one that created the keychain item | Always Allow stops the question for this build; Allow Once asks every launch; Deny leaves keys unusable this launch. Re-packaging may ask again. See [what the prompt protects](#what-the-keychain-prompt-does-and-doesnt-protect). |
| Migration failed | Disk full, permission error, or safeStorage unavailable | Check the error message in the migration overlay. Click Retry after resolving the cause. If safeStorage is unavailable, ensure the Keychain is accessible (System Settings > Privacy & Security). |
| Plaintext key warning after migration | User manually edited App Support `settings.json` and added API keys | Remove the keys from `settings.json` and re-enter them through the Settings panel so they are encrypted via Keychain. |
| Keys not persisting across restarts | safeStorage encryption key changed (e.g., after OS reinstall or keychain reset) | Re-enter keys through the Settings panel. The old encrypted blobs cannot be decrypted. |
| "SAFE_STORAGE_UNAVAILABLE" in Settings | Keychain access denied or safeStorage not ready | Ensure the app has Keychain access. On first use macOS may prompt for permission. |

## Tests

```bash
cd desktop && npm test            # 348 Node lifecycle, credential, migration, packaging and integration tests
cd desktop && npm run test:smoke  # end-to-end dynamic endpoint + bridge surface smoke
```

The integration and resilience files launch the real Electron binary against a
real sidecar (they skip if `frontend/dist-desktop/` is not built). Every launch
uses its own `NEBULA_DESKTOP_USER_DATA_DIR` under `os.tmpdir()`, its own
`NEBULA_DESKTOP_APP_ID` and `NEBULA_DESKTOP_TEST=1`; set `TMPDIR` to keep
those profiles somewhere specific. Process checks compare against a snapshot
of `uvicorn main:app` PIDs taken before each test and only count new PIDs
whose environment points inside the test's own temp profile, so a dev backend
on port 8000 (or another worktree's), even one restarted mid-run, doesn't
fail them, and the quit-during-startup test polls for its
fixture child instead of sleeping a fixed time (a fresh profile shows the
migration overlay first).

The Node test suite covers: runtime override and fallback, ephemeral port
allocation and collision retry, spawn argv/cwd, health and WebSocket readiness
identity, early exit, timeout, bounded diagnostics and secret sanitization,
SIGTERM grace, SIGKILL escalation, post-readiness no-auto-restart, normal and
escalated child cleanup, single-instance lock and isolation, quit during cold
startup, App Support path computation and env-var injection, credential
encryption round-trip and persistence, provider allowlist validation, sender
validation, safeStorage unavailability handling, one-time migration (copy,
encrypt, idempotent, non-destructive), migration status overlay, plaintext
key detection, how Nebula.app finds and checks its checkout, when a packaged
build honours overrides, and the parent lifeline (a real backend exits within
seconds of its launcher being SIGKILLed).

## Validation

The full Phase 2 regression gate runs every programmatic command and the
required live checks:

```bash
# Programmatic gate — all must exit zero
cd desktop && npm test                          # 348 Node lifecycle, credential, migration, packaging and integration tests
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

Bundled Python, Developer ID signing and notarization, a DMG, auto-update,
and paid-provider validation are not in scope yet. Nebula.app is a local,
ad-hoc signed build that runs from the checkout (see
[Nebula.app](#nebulaapp-everyday-use)); the distributable target is
described in [docs/macos-desktop/MACOS-DESKTOP-SPEC.md](../docs/macos-desktop/MACOS-DESKTOP-SPEC.md).
