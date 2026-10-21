# Contributing to Nebula Nodes

Issues and pull requests are welcome. Keep changes focused, describe the behavior
they change, and include the checks you ran. Read [AGENTS.md](AGENTS.md) for
repository conventions and [the quickstart](README.md#quickstart) for setup.

## Development checks

Run commands from the repository root, using the installed dependencies:

```bash
backend/.venv/bin/python -m pytest -o pythonpath=backend backend/tests
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
node scripts/check-node-contracts.mjs
```

For desktop changes, also install its dependencies, build the desktop renderer,
and run the desktop checks:

```bash
npm --prefix desktop ci
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

See [desktop/README.md](desktop/README.md) for runtime and integration-test setup.
Document any check you could not run rather than reporting it as passed.

## Running a second, isolated dev instance

Test runs, screenshot scripts and agents often start their own backend and Vite
next to the one you work in. Without care, that second frontend finds your main
backend on port 8000 (its `/api` proxy defaults to 8000, and the page scans ports
8000-8010) and saves test nodes into your real project. Isolate it like this:

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/home" "$TMP/state" "$TMP/output"
echo '{}' > "$TMP/settings.json"

# Backend on its own port, with its own HOME, settings, state and outputs.
# It runs in the background; stop it later with `kill $BACKEND_PID`.
HOME="$TMP/home" NEBULA_SETTINGS_PATH="$TMP/settings.json" \
NEBULA_STATE_DIR="$TMP/state" NEBULA_OUTPUT_ROOT="$TMP/output" \
  backend/.venv/bin/python backend/devserver.py --port 8155 --ui http://127.0.0.1:5275 --no-reload &
BACKEND_PID=$!

# Wait until that backend answers on its own port before starting Vite.
until curl -fsS http://127.0.0.1:8155/api/health >/dev/null; do sleep 1; done

# Vite pinned to that backend (foreground; Ctrl-C stops it).
VITE_NEBULA_BACKEND_PORT=8155 \
  npm --prefix frontend run dev -- --host 127.0.0.1 --port 5275 --strictPort
```

Or run the two commands in two terminals, as in the README quickstart, with the
same `TMP` in both.

- `VITE_NEBULA_BACKEND_PORT` is the one setting. It moves the Vite `/api` and
  `/ws` proxy to `127.0.0.1:<port>` and makes the page talk to that port only:
  no 8000-8010 scan, no backend URL stored by an earlier run, and a person link
  for another backend is refused. If that backend is down, the page says so
  instead of trying other ports. A value that isn't a port, or a
  `VITE_NEBULA_API_BASE` on a different port, stops Vite at startup.
- With nothing set, `npm run dev` behaves as before (proxy to 8000, scan
  8000-8010). `VITE_NEBULA_BACKEND_PORTS` still sets a scan list; the pin wins
  over it. The desktop app ignores all three and uses the address its preload
  bridge injects.
- Use a temp `HOME` and temp `NEBULA_SETTINGS_PATH`, `NEBULA_STATE_DIR` and
  `NEBULA_OUTPUT_ROOT` for the backend. The defaults are your real
  `settings.json`, `~/.nebula` and `output/`.
- A browser test (Playwright, Puppeteer) should also abort every request to
  `localhost` or `127.0.0.1` ports 8000-8010 and check its network log before it
  adds a node, so a mistake fails loudly instead of writing to your project.

## Adding or updating a node

1. Verify the current behavior against the provider's official API documentation.
   Check the [provider contracts](docs/contracts/README.md) and
   [audit notes](docs/model-providers/) for existing decisions.
2. Update `backend/data/node_definitions.json`, the source of truth, and its
   frontend mirror in `frontend/src/constants/nodeDefinitions.ts`.
3. Implement the handler under `backend/handlers/` and add relevant tests for
   inputs, outputs, errors, and provider behavior.
4. Regenerate the catalog with `node scripts/generate-model-reference.mjs`.
   Do not edit `docs/MODEL_REFERENCE.md` by hand.
5. Run the node contract checks above and update the relevant provider guide.
   If the node closes a logged gap, update [the Flora audit](docs/flora-gap-audit.md).

Keep credentials, local outputs, and user data out of commits. Record unexpected
decisions and tradeoffs during implementation in your change's own notes file,
`docs/notes/<YYYY-MM-DD>-<branch>.md` (the branch name with `/` as `-`).
`implementation-notes.md` keeps the entries written before 2026-10-21.

## Agent integration

Repo-backed agent skills live in [.agents/skills/](.agents/skills/).
