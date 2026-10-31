# Cloud-session setup (feat/cloud-session-setup, 2026-10-30)

Why: full test suites on the person's Mac were pinning its CPU (several agent lanes running vitest and pytest at once). Full suites now belong in a Claude Code cloud session or in CI on a pushed branch, and a cloud session needs Nebula's dependencies installed before it can run them.

## What it does

- `.claude/settings.json` has one SessionStart hook (`startup|resume`) that runs `bash "$CLAUDE_PROJECT_DIR"/scripts/cloud-session-setup.sh`.
- The script exits at once unless `CLAUDE_CODE_REMOTE` is exactly `true`. The Claude Code docs (env-vars, cloud-environments and hooks, read 2026-10-30) say cloud sessions set that variable and local ones never do. Every local session in this repo runs the hook, so on the Mac it spawns a bash that exits.
- In the cloud it runs two installs side by side, matching ci.yml:
  - **backend:** a venv at `backend/.venv`, the path AGENTS.md and CONTRIBUTING.md already use. The installs are `pip install -r backend/requirements.txt`, then `apt-get install libcairo2` only if `import cairosvg` fails.
  - **frontend:** `npm ci` in `frontend`.
- After a successful backend install it appends `export PATH="<repo>/backend/.venv/bin:$PATH"` to `CLAUDE_ENV_FILE`, so CI's own `python -m pytest` uses the venv.
- Its stdout goes into the session's context: how long setup took, what's ready or what failed (with the last lines of that log), and CI's commands.

## Decisions

- **The hook timeout is 900 s.** Claude Code cancels a SessionStart command hook at 600 s by default. A cold install of both halves on the cloud machine (4 vCPUs) is expected to take well under that, but a slow registry day shouldn't cut it off halfway. The real cold time is measured in the PR.
- **Idempotent through hash stamps,** following the docs' own example.
  - `backend/.venv/.cloud-setup.sha256` hashes the script and requirements.txt.
  - `frontend/node_modules/.cloud-setup.sha256` hashes the script, package.json and package-lock.json.
  - The stamp is removed before an install and written only after a successful one, so a failure installs again next time.
- **Python 3.12, as CI pins it.** The script uses `python3.12` if the image has it, else uv's 3.12 (found, or installed), else `python3`. It prints the version it got.
  - A venv instead of the system Python, because Ubuntu 24.04's system Python is externally managed (PEP 668), so a bare `pip install` there is refused.
  - If `python -m venv` fails (no ensurepip), it falls back to `uv venv --seed`.
- **Always exits 0.** A failed install shouldn't stop the session from starting; the context line says FAILED, and Claude can rerun the script.
- **No desktop install.** CI doesn't install `desktop/`, and Electron's binary download isn't needed for CI parity. Desktop checks stay on the Mac.
- **.gitignore:**
  - The repo ignored every `settings.json`, so that Nebula's own settings file (API keys) can never be committed.
  - `!/.claude/settings.json` un-ignores only the root `.claude/settings.json`. Every other `settings.json` stays ignored.
  - `.claude/settings.local.json` (each person's own Claude Code permissions) is now ignored by the repo too, not only by a person's global ignore.
  - A test pins all three, reading the repo's own rules with the global excludes file turned off.

## Tests

`backend/tests/test_cloud_session_setup.py` runs the real script with stand-in `python`, `npm` and `node` that only record their calls. It checks:
- the settings wiring;
- the no-op for an unset, empty, `false`, `1`, `TRUE` or `yes` value: no output, no calls, no files;
- the install once, then the skip;
- a changed lockfile reinstalling only the frontend;
- the pip and npm failure paths: the report, no stamp, a retry next time, and no PATH entry for a broken venv;
- the .gitignore rules.

Mutation check: each of these fails at least one test:
- dropping the remote check, or loosening it to any non-empty value;
- dropping either skip;
- leaving the lockfile out of the hash;
- dropping the PATH export, or exporting it after a failure;
- ignoring a pip or npm failure;
- skipping the cairosvg check;
- dropping the un-ignore.

## Limits

- A cloud session with several repositories, or a project's cloud thread, doesn't load repository hooks (cloud-environments docs). AGENTS.md gives the manual command.
- What still needs the Mac is listed in AGENTS.md under "Where tests run".
