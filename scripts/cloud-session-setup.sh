#!/bin/bash
# Installs what CI installs, so a Claude Code cloud session can run the same
# suites. .claude/settings.json runs this on every session start and resume.
# It does nothing outside the cloud: Claude Code sets CLAUDE_CODE_REMOTE=true
# only in cloud sessions. To run it by hand in a cloud session the hook didn't
# reach (several repositories, a project thread):
#   CLAUDE_CODE_REMOTE=true bash scripts/cloud-session-setup.sh
#
# Each install is skipped while its inputs and this script are unchanged since
# its last success, so a resume costs a hash check. It always exits 0, so the
# session starts, and its stdout (Claude's context) says what's ready.

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$root" || { echo "Cloud setup: couldn't enter $root."; exit 0; }

script=scripts/cloud-session-setup.sh
venv=backend/.venv
log_dir=$(mktemp -d /tmp/nebula-cloud-setup.XXXXXX)
backend_stamp=$venv/.cloud-setup.sha256
frontend_stamp=frontend/node_modules/.cloud-setup.sha256
started=$SECONDS

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

setup_backend() {
  if sha256sum --check --status "$backend_stamp" 2>/dev/null; then
    echo "backend: up to date"
    return 0
  fi
  # Remove the stamp first, so a failed install runs again next time.
  rm -f "$backend_stamp"
  # A venv left without pip by an earlier failure is made again.
  if ! "$venv/bin/python" -m pip --version >/dev/null 2>&1; then
    rm -rf "$venv"
    local python
    python=$(pick_python)
    # Ubuntu's own python3 can lack ensurepip (python3-venv); uv can seed pip.
    "$python" -m venv "$venv" \
      || { command -v uv >/dev/null 2>&1 && rm -rf "$venv" && uv venv --quiet --seed --python "$python" "$venv"; } \
      || return 1
  fi
  "$venv/bin/python" -m pip install --quiet --disable-pip-version-check \
    --requirement backend/requirements.txt || return 1
  # cairosvg loads libcairo at import time; the image may not ship it.
  if ! "$venv/bin/python" -c "import cairosvg" >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq libcairo2 || return 1
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
  (cd frontend && npm ci --no-audit --no-fund --loglevel=error) || return 1
  sha256sum "$script" frontend/package.json frontend/package-lock.json > "$frontend_stamp" \
    || rm -f "$frontend_stamp"
  echo "frontend: installed (node $(node --version))"
}

# The two installs share nothing, so they run side by side.
setup_backend > "$log_dir/backend.log" 2>&1 &
backend_pid=$!
setup_frontend > "$log_dir/frontend.log" 2>&1 &
frontend_pid=$!
wait "$backend_pid"; backend_rc=$?
wait "$frontend_pid"; frontend_rc=$?

# CI runs `python -m pytest`; put the venv first so that same command works.
if [ "$backend_rc" -eq 0 ] && [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "export PATH=\"$root/$venv/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

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
