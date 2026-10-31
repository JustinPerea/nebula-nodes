#!/bin/bash
# Installs what CI installs, so a Claude Code cloud session can run the same
# suites. .claude/settings.json runs this whenever a session starts, resumes,
# clears, compacts or forks. It does nothing outside the cloud: Claude Code
# sets CLAUDE_CODE_REMOTE=true only in cloud sessions, and it refuses macOS
# and any other machine that isn't Linux.
#
# Installs run at start and resume only. A clear, compaction or fork starts a
# new session id with an empty env file, so then it only puts the venv back on
# PATH: an `npm ci` in the middle of the agent's work would empty
# node_modules under anything it left running.
#
# To run it by hand in a cloud session the hook didn't reach (several
# repositories, a project thread), from the repository root:
#   CLAUDE_CODE_REMOTE=true bash scripts/cloud-session-setup.sh
# then run the `export PATH=...` line it prints.
#
# Each install is skipped while its inputs and this script are unchanged since
# its last success. It always exits 0, so the session starts, and its stdout
# (Claude's context) says what's ready.

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi
# The variable alone isn't enough: a person can set it by hand on a Mac, where
# npm ci would empty the frontend's node_modules under a running dev server.
if [ "$(uname -s)" != "Linux" ]; then
  echo "Cloud setup: this isn't a cloud machine ($(uname -s)), so nothing was installed."
  exit 0
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root" || { echo "Cloud setup: couldn't enter $root."; exit 0; }

script=scripts/cloud-session-setup.sh
venv=backend/.venv
backend_stamp=$venv/.cloud-setup.sha256
frontend_stamp=frontend/node_modules/.cloud-setup.sha256
venv_owned=$venv/.cloud-setup-owned
started=$SECONDS

# The hook's input names why it ran ("source"). A run by hand has none.
input=""
if [ ! -t 0 ]; then
  IFS= read -r -t 2 -d '' input
fi
source_pattern='"source"[[:space:]]*:[[:space:]]*"(clear|compact|fork)"'
light=""
if [[ $input =~ $source_pattern ]]; then
  light=${BASH_REMATCH[1]}
fi

# Puts the venv first on PATH, so CI's `python -m pytest` uses it.
export_path() {
  local line
  line=$(printf 'export PATH=%q:"$PATH"' "$root/$venv/bin")
  if [ -n "$CLAUDE_ENV_FILE" ]; then
    echo "$line" >> "$CLAUDE_ENV_FILE"
  else
    echo "Run this before CI's commands (only the hook can set PATH for later commands): $line"
  fi
}

if [ -n "$light" ]; then
  if [ -x "$venv/bin/python" ]; then
    export_path
    if sha256sum --check --status "$backend_stamp" 2>/dev/null \
      && sha256sum --check --status "$frontend_stamp" 2>/dev/null; then
      echo "Nebula cloud setup ($light): backend/.venv is on PATH; dependencies are up to date."
    else
      echo "Nebula cloud setup ($light): backend/.venv is on PATH, but the dependencies changed since the last install. When nothing is running, run \`CLAUDE_CODE_REMOTE=true bash $script\`."
    fi
  else
    echo "Nebula cloud setup ($light): there's no backend/.venv yet. Run \`CLAUDE_CODE_REMOTE=true bash $script\`."
  fi
  exit 0
fi

log_dir=$(mktemp -d "${TMPDIR:-/tmp}/nebula-cloud-setup.XXXXXX")

# One run at a time per checkout, since runs share its venv and node_modules.
# Installs left running by a run that hit the hook timeout still hold the
# lock, so a resume waits for them instead of racing them.
if command -v flock >/dev/null 2>&1; then
  exec 9>".cloud-setup.lock"
  if ! flock -w 600 9; then
    echo "Cloud setup: another setup run is still going after 10 minutes. Run \`CLAUDE_CODE_REMOTE=true bash $script\` once it ends."
    exit 0
  fi
fi

# CI pins Python 3.12. Use it when the image has it, else let uv fetch it,
# else fall back to the image's python3 and say which version that is.
pick_python() {
  if command -v python3.12 >/dev/null 2>&1; then
    echo python3.12
  elif command -v uv >/dev/null 2>&1 && uv python find 3.12 >/dev/null 2>&1; then
    uv python find 3.12
  elif command -v uv >/dev/null 2>&1 && uv python install 3.12 >/dev/null 2>&1; then
    uv python find 3.12
  else
    echo python3
  fi
}

make_venv() {
  local python
  python=$(pick_python)
  # Ubuntu's own python3 can lack ensurepip (python3-venv); uv can seed pip.
  "$python" -m venv "$venv" \
    || { command -v uv >/dev/null 2>&1 && rm -rf "$venv" && uv venv --quiet --seed --python "$python" "$venv"; } \
    || return 1
  : > "$venv_owned"
}

setup_backend() {
  if sha256sum --check --status "$backend_stamp" 2>/dev/null; then
    echo "backend: up to date"
    return 0
  fi
  # Remove the stamp first, so a failed install runs again next time.
  rm -f "$backend_stamp"
  if [ ! -e "$venv" ]; then
    make_venv || return 1
  elif ! "$venv/bin/python" -m pip --version >/dev/null 2>&1; then
    # A venv this script made and left without pip is made again. Anyone
    # else's venv is never deleted: pip is added to it in place.
    if [ -e "$venv_owned" ]; then
      rm -rf "$venv"
      make_venv || return 1
    else
      "$venv/bin/python" -m ensurepip --upgrade || {
        echo "backend/.venv has no pip and this script didn't make it, so it was left as it is."
        return 1
      }
    fi
  fi
  "$venv/bin/python" -m pip install --quiet --disable-pip-version-check \
    --requirement backend/requirements.txt || return 1
  # cairosvg loads libcairo at import time; the image may not ship it.
  if ! "$venv/bin/python" -c "import cairosvg" >/dev/null 2>&1; then
    local apt=(env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 -qq)
    { "${apt[@]}" update && "${apt[@]}" install -y --no-install-recommends libcairo2; } </dev/null || return 1
    "$venv/bin/python" -c "import cairosvg" || return 1
  fi
  sha256sum "$script" backend/requirements.txt > "$backend_stamp" || rm -f "$backend_stamp"
  echo "backend: installed ($("$venv/bin/python" --version 2>&1))"
}

setup_frontend() {
  if sha256sum --check --status "$frontend_stamp" 2>/dev/null; then
    echo "frontend: up to date"
    return 0
  fi
  rm -f "$frontend_stamp"
  (cd frontend && npm ci --no-audit --no-fund --loglevel=error) </dev/null || return 1
  sha256sum "$script" frontend/package.json frontend/package-lock.json > "$frontend_stamp" \
    || rm -f "$frontend_stamp"
  echo "frontend: installed (node $(node --version))"
}

# The two installs share nothing, so they run side by side.
setup_backend > "$log_dir/backend.log" 2>&1 </dev/null &
backend_pid=$!
setup_frontend > "$log_dir/frontend.log" 2>&1 </dev/null &
frontend_pid=$!
wait "$backend_pid"; backend_rc=$?
# Put the venv on PATH as soon as the backend is ready, so a hook timeout
# while the frontend is still installing doesn't lose it.
if [ "$backend_rc" -eq 0 ]; then
  export_path
fi
wait "$frontend_pid"; frontend_rc=$?

echo "Nebula cloud setup ($((SECONDS - started)) s, logs in $log_dir):"
if [ "$backend_rc" -eq 0 ]; then
  tail -n 1 "$log_dir/backend.log"
else
  echo "backend: FAILED (exit $backend_rc). Last lines of $log_dir/backend.log:"
  tail -n 15 "$log_dir/backend.log"
fi
if [ "$frontend_rc" -eq 0 ]; then
  tail -n 1 "$log_dir/frontend.log"
else
  echo "frontend: FAILED (exit $frontend_rc). Last lines of $log_dir/frontend.log:"
  tail -n 15 "$log_dir/frontend.log"
fi
echo "The CI jobs here: (cd backend && python -m pytest); (cd frontend && npm test && npm run lint && npm run build); node scripts/check-node-contracts.mjs && node scripts/contract-inventory.mjs && node scripts/generate-model-reference.mjs --check"
exit 0
