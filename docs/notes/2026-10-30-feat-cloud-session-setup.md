# Cloud-session setup (feat/cloud-session-setup, 2026-10-30)

Why: full test suites on the maintainer's Mac were pinning its CPU (several agent lanes running vitest and pytest at once). Full suites now belong in a Claude Code cloud session or in CI on a pushed branch. A cloud session needs Nebula's dependencies installed before it can run them.

## What it does

- `.claude/settings.json` has one SessionStart hook, with no matcher. It runs `node` with `${CLAUDE_PROJECT_DIR}/scripts/cloud-session-setup.mjs` as its argument, in exec form. The hooks docs advise exec form for a path placeholder, so no shell (sh, Git Bash or PowerShell) parses the path.
- The `.mjs` wrapper starts `bash scripts/cloud-session-setup.sh` only when `CLAUDE_CODE_REMOTE` is `true` and the platform is Linux, passing the hook's stdin and the script's stdout straight through. Review 4: a hook that ran `bash` directly fails at every start on native Windows without bash on PATH, or boots WSL with a Windows path it can't open. Node is the one runtime every checkout of this repo has.
- The script exits at once unless both hold:
  - `CLAUDE_CODE_REMOTE` is exactly `true`. The Claude Code docs (env-vars, cloud-environments and hooks, read 2026-10-30) say cloud sessions set it and local ones never do.
  - `uname -s` is `Linux`.
- Every local session in this repo runs the hook, so on the Mac it spawns a bash that exits.
- At start and resume, in the cloud, it runs two installs side by side, matching ci.yml:
  - **backend:** a venv at `backend/.venv`, the path AGENTS.md and CONTRIBUTING.md already use, then `pip install -r backend/requirements.txt`. If `import cairosvg` fails, it runs `apt-get install libcairo2`, non-interactive with a dpkg lock timeout.
  - **frontend:** `npm ci` in `frontend`.
- After a clear, compaction or fork (the hook input's `source`), it installs nothing. It appends the PATH line again only when the last backend install succeeded (its stamp exists), as after a start. It says when there's no venv yet, when the last backend or frontend install didn't finish, or when the dependencies changed since.
- As soon as the backend install succeeds, before the frontend finishes, it appends `export PATH=<repo>/backend/.venv/bin:"$PATH"` to `CLAUDE_ENV_FILE`. The path is quoted with `printf %q`. CI's own `python -m pytest` then uses the venv.
- Run by hand, a Bash command gets no `CLAUDE_ENV_FILE`, and Bash commands don't keep `PATH` between calls. So it says to start each backend command with that line and `&&`, or to call `backend/.venv/bin/python` directly.
- Its stdout goes into the session's context: how long setup took, what's ready or what failed (with the last lines of that log), and CI's commands.

## Decisions

- **Installs only at start and resume.** Review 2: with no matcher, an auto-compaction after the agent changed the lockfile would run `npm ci` mid-session. That empties node_modules under whatever vite or vitest it left running. Now a clear, compaction or fork only restores PATH.
  - The script finds the checkout from its own path, not from `CLAUDE_PROJECT_DIR`.
- **No matcher.** `/clear` and a fork start a new session id. `CLAUDE_ENV_FILE` files are kept per session id, so the new session's env file starts empty.
  - Review 1 confirmed this in Claude Code 2.1.314: `regenerateSessionId` on `/clear`, and nothing copies the session-env files across.
  - With `startup|resume`, the PATH export was lost after `/clear`. Running on every source costs two hash checks once the installs are done.
- **Two guards.** The variable alone isn't enough. A person or an agent can set `CLAUDE_CODE_REMOTE=true` by hand on a Mac. `npm ci` would then empty `frontend/node_modules` under a running dev server, and pip would re-resolve the person's venv.
  - The Linux check stops that, and says so in one line.
  - `CLAUDE_CODE_REMOTE_SESSION_ID` wasn't used as the second guard, because whether it reaches hook subprocesses isn't verified yet.
- **One run at a time per checkout.** It takes `flock` on `.cloud-setup.lock` at the repo root (ignored), waiting up to 600 s.
  - Installs that a hook-timeout kill leaves running still hold the lock, so a resume waits for them instead of running a second `npm ci` into the same folder.
  - `flock` is Linux-only (util-linux), so on a Mac the lock is skipped. The script never gets that far there anyway.
- **The hook timeout is 900 s.** Claude Code cancels a SessionStart command hook at 600 s by default. A cold install on the cloud machine (4 vCPUs) should take well under that, but a slow registry day shouldn't cut it off halfway.
- **Idempotent through hash stamps,** following the docs' own example.
  - `backend/.venv/.cloud-setup.sha256` hashes the script and requirements.txt.
  - `frontend/node_modules/.cloud-setup.sha256` hashes the script, package.json and package-lock.json.
  - The stamp is removed before an install and written only after a successful one, so a failure installs again next time.
- **Its own venv starts clean, as CI's does.** When requirements.txt or the script changes, a venv this script made is deleted and made again, so a package dropped from requirements.txt can't linger and let a test pass here that fails in CI. Review 3 caught the in-place install. npm ci already starts clean.
- **It never deletes a venv it didn't make.**
  - A venv this script makes gets a `.cloud-setup-owned` marker before anything goes into it, on both the `python -m venv` path and the `uv venv --seed --allow-existing` fallback, so a venv cut off halfway is still known as its own. A venv it fails to finish is removed.
  - Anyone else's venv without pip gets `python -m ensurepip` in place, or the backend reports FAILED and the venv is left as it is.
  - This guards a contributor on Linux who runs the manual command over their own uv-made venv.
- **Python 3.12, as CI pins it.**
  - The script uses `python3.12` if the image has it. Otherwise it uses uv's 3.12, found or installed. Otherwise `python3`. It prints the version it got.
  - A venv, not the system Python, because Ubuntu 24.04's system Python is externally managed (PEP 668): a bare `pip install` there is refused.
  - If `python -m venv` fails (no ensurepip), it falls back to `uv venv --seed`.
- **Always exits 0.** A failed install shouldn't stop the session from starting. The context line says FAILED, and Claude can rerun the script.
- **Logs go under `$TMPDIR`** (else `/tmp`), so test runs leave nothing in `/tmp`.
- **No desktop install.** CI doesn't install `desktop/`, and Electron's binary download isn't needed for CI parity. Desktop checks stay on the Mac.
- **.gitignore:**
  - The repo ignored every `settings.json`, so that Nebula's own settings file (API keys) can never be committed.
  - `!/.claude/settings.json` re-includes only the root `.claude/settings.json`. Every other `settings.json` stays ignored.
  - `**/.claude/settings.local.json` (each person's own Claude Code permissions, at any depth) is now ignored by the repo itself, not only by a person's global ignore.
  - A test pins these rules in a scratch repo, with the global excludes file off.
- **One caveat on pulling this in.** Git treats ignored files as expendable. A clone that kept its own ignored `.claude/settings.json` has it replaced by this one on the next pull or merge, with no conflict and no warning. None of the maintainer's checkouts has one. Anyone else should move theirs to `.claude/settings.local.json` first. The PR says so.

## Tests

`backend/tests/test_cloud_session_setup.py` runs the real script on a PATH of stand-in commands and the few real tools it needs. The stand-ins are `uname`, `python3.12`, `uv`, the venv's `python`, `npm`, `node` and `apt-get`. They only record their calls. The tests check:
- the settings hook entry (exec form through node, no matcher);
- the wrapper: a no-op without `CLAUDE_CODE_REMOTE=true` or off Linux, and on Linux in the cloud the script with stdin and stdout passed through;
- the marker in place before `python -m venv` or `uv venv` fills the folder;
- the light path for clear, compact and fork: PATH only, no installs, and what it says;
- the PATH line: written before the frontend finishes, and safe to source with a space, `$(...)` or `"` in the checkout path;
- the manual run printing the PATH line;
- someone else's venv never deleted, and the script's own venv made again;
- the script's own venv starting clean when requirements change, and a half-made one (python or uv cut off) removed and made again;
- mid-session, a failed backend staying off PATH, and a failed frontend named;
- the no-op for an unset, empty, `false`, `1`, `TRUE` or `yes` value, and for `true` on a Mac: no calls, no files, no env file;
- the install once, then the skip;
- a changed lockfile reinstalling only the frontend;
- the Python choice: `python3.12`, then uv's (without a second download), then `python3`, with `uv venv --seed` when ensurepip is missing;
- the libcairo install, with its exact apt flags;
- the pip and npm failure paths: the report, no stamp, a retry next time, and no PATH entry for a broken venv;
- the checkout lock being held during installs (Linux only);
- the .gitignore rules.

Mutation check: each of these fails at least one test. Round 1:
- dropping the remote check, or loosening it to any non-empty value;
- dropping either skip;
- leaving the lockfile out of the hash;
- dropping the PATH export, or exporting it after a failure;
- ignoring a pip or npm failure;
- skipping the cairosvg check;
- dropping the re-include.

Round 2:
- dropping the Linux check;
- each apt flag, and the apt update;
- `/tmp` for the logs;
- the uv fallback;
- each Python choice;
- the matcher;
- the root-only local-settings rule;
- the lock file not being ignored.

Round 3:
- installing on compact;
- `compact` left out of the light path;
- the unquoted PATH line;
- exporting only after the frontend;
- deleting any venv, or never trying ensurepip;
- no owned marker;
- no manual PATH line;
- no fresh-venv branch;
- shell form back.

Round 4:
- the marker written last;
- a half-made venv kept;
- an own venv updated in place;
- a failed backend put on PATH mid-session;
- a failed frontend not named;
- no separate no-venv line.

Round 5:
- uv without the marker first;
- no `--allow-existing`;
- `python -m venv` without the marker first;
- the wrapper ignoring the platform;
- the wrapper ignoring `CLAUDE_CODE_REMOTE`, and dropping stdin and stdout. These two can only fail on Linux, so CI's backend job catches them.

## Verifying it in the cloud

- `claude --cloud` needs a TTY. From an agent's shell, wrap it in `script -q`.
- The team account is plain `claude`, with `CLAUDE_CONFIG_DIR` unset.
- With no Claude GitHub App on the repo, `--cloud` uploads the repo instead of cloning it. This repo is too big for that: a 224 MB pack and a 116 MB tree, against a 100 MB limit. Both tries failed with "Could not upload repo bundle (SSLV3_ALERT_BAD_RECORD_MAC after 3 attempts)".
- The App has to be installed on the repo, so sessions clone it from GitHub.

## Limits

- A cloud session with several repositories, or a project's cloud thread, doesn't load repository hooks (cloud-environments docs). AGENTS.md gives the manual command.
- What still needs the maintainer's Mac is listed in AGENTS.md under "Where tests run".
