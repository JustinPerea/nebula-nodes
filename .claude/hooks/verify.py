#!/usr/bin/env python3
"""Claude Code verification hook for Nebula Nodes.

    verify.py edit   PostToolUse on Edit|Write|MultiEdit: lint the one edited file.
    verify.py stop   Stop: run the tests related to the files changed in the tree.

Hook JSON arrives on stdin. Exit 2 sends stderr back to Claude as feedback;
exit 0 is silent; exit 1 means the hook itself broke (never blocks Claude).
Standard library only; runs on Python 3.9+.
"""
import glob
import hashlib
import json
import os
import shutil
import subprocess
import signal
import sys
import tempfile
import time

EDIT_TIMEOUT = 25
STOP_BUDGET = 180
MAX_ATTEMPTS = 2
TAIL_LINES = 60
CONTRACT_FILES = ("frontend/src/constants/nodeDefinitions.ts", "backend/data/node_definitions.json")

FRONTEND_EXT = (".ts", ".tsx", ".js", ".jsx")


def run(cmd, cwd, timeout, env=None):
    """Return (returncode, combined output). returncode None on timeout.

    The command runs in its own session so a timeout can kill the whole
    process tree (vitest and pytest start workers), not just the parent.
    """
    try:
        p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             universal_newlines=True, env=env, start_new_session=True)
    except OSError as e:
        return 127, str(e)
    try:
        out, _ = p.communicate(timeout=max(1, timeout))
        return p.returncode, out
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            out, _ = p.communicate(timeout=5)
        except Exception:
            out = ""
        return None, (out or "") + "\n[timed out after %ds]" % int(timeout)


def git(args, cwd):
    rc, out = run(["git"] + args, cwd, 20)
    if rc != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), out.strip()))
    return out


def roots(cwd):
    top = git(["rev-parse", "--show-toplevel"], cwd).strip()
    common = git(["rev-parse", "--git-common-dir"], top).strip()
    main = os.path.dirname(os.path.normpath(os.path.join(top, common)))
    gitdir = os.path.normpath(os.path.join(top, git(["rev-parse", "--git-dir"], top).strip()))
    return top, main, gitdir


def find_bin(rel, top, main):
    for base in (top, main):
        p = os.path.join(base, rel)
        if os.path.exists(p):
            return p
    return None


def tail(text, n=TAIL_LINES):
    """Last n lines, led by the failing test names when the output is long."""
    lines = text.rstrip().splitlines()
    if len(lines) <= n:
        return "\n".join(lines)
    fails = []
    for ln in lines:
        if ln.lstrip().startswith(("FAIL", "\u00d7", "FAILED", "ERROR")) and ln not in fails:
            fails.append(ln.strip())
    head = fails[:15]
    keep = max(10, n - len(head))
    out = ["... (%d earlier lines trimmed)" % (len(lines) - keep)]
    if head:
        out += ["failing:"] + ["  " + f for f in head] + ["last lines:"]
    return "\n".join(out + lines[-keep:])


def missing_module(out):
    return ("ERR_MODULE_NOT_FOUND" in out or "Cannot find package" in out
            or "Cannot find module" in out)


def is_frontend(rel):
    return rel.startswith("frontend/") and rel.endswith(FRONTEND_EXT)


def is_backend_py(rel):
    return rel.startswith("backend/") and rel.endswith(".py")


def state_paths(gitdir):
    d = os.path.join(gitdir, "claude-verify")
    return d, os.path.join(d, "state.json")


def load_state(gitdir):
    try:
        with open(state_paths(gitdir)[1]) as fh:
            st = json.load(fh)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(gitdir, state):
    state_dir, state_path = state_paths(gitdir)
    os.makedirs(state_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=state_dir, prefix="state-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(state, fh)
        os.replace(tmp, state_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def record_edit(gitdir, sid, rel):
    state = load_state(gitdir)
    edits = state.setdefault("edits", {})
    mine = edits.setdefault(sid, [])
    if rel not in mine:
        mine.append(rel)
    while len(edits) > 20:  # keep the state file small
        edits.pop(next(iter(edits)))
    save_state(gitdir, state)


# ---------------------------------------------------------------- edit mode

def edit_mode(payload):
    path = (payload.get("tool_input") or {}).get("file_path")
    if not path or not os.path.isfile(path):
        return 0
    base = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    top, main, gitdir = roots(base)
    real_top = os.path.realpath(top)
    real = os.path.realpath(path)
    if not real.startswith(real_top + os.sep):
        return 0
    rel = os.path.relpath(real, real_top)
    sid = str(payload.get("session_id") or "unknown")
    try:
        record_edit(gitdir, sid, rel)
    except OSError as e:
        print("verify: could not record edit: %s" % e, file=sys.stderr)

    if is_frontend(rel):
        eslint = find_bin("frontend/node_modules/.bin/eslint", top, main)
        if not eslint:
            print("verify: eslint not found, skipping lint of %s" % rel, file=sys.stderr)
            return 0
        rc, out = run([eslint, os.path.relpath(real, os.path.join(real_top, "frontend"))],
                      os.path.join(top, "frontend"), EDIT_TIMEOUT)
        name = "eslint"
    elif is_backend_py(rel):
        ruff = shutil.which("ruff")
        if ruff:
            rc, out = run([ruff, "check", "--select", "E9,F63,F7,F82", real], top, EDIT_TIMEOUT)
            name = "ruff"
        else:
            rc, out = run([sys.executable, "-m", "py_compile", real], top, EDIT_TIMEOUT)
            name = "py_compile"
    else:
        return 0

    if rc == 0:
        return 0
    if rc is None:
        print("verify: %s timed out on %s, skipping" % (name, rel), file=sys.stderr)
        return 0
    if missing_module(out):
        print("verify: %s could not load its dependencies, skipping %s" % (name, rel), file=sys.stderr)
        return 0
    print("verify: %s failed on %s\n%s" % (name, rel, tail(out)), file=sys.stderr)
    return 2


# ---------------------------------------------------------------- stop mode

def changed_files(top):
    tracked = git(["diff", "--name-only", "HEAD"], top).splitlines()
    untracked = git(["ls-files", "-o", "--exclude-standard"], top).splitlines()
    seen, files = set(), []
    for f in tracked + untracked:
        if f and f not in seen:
            seen.add(f)
            files.append(f)
    return files, set(untracked)


def fingerprint(top, files, untracked):
    h = hashlib.sha256()
    h.update(git(["diff", "HEAD"], top).encode("utf-8", "replace"))
    for f in sorted(untracked):
        p = os.path.join(top, f)
        h.update(b"\0" + f.encode())
        try:
            with open(p, "rb") as fh:
                h.update(fh.read())
        except OSError:
            pass
    return h.hexdigest()


def related_tests(top, files):
    tests = []
    for f in files:
        if not is_backend_py(f) or not os.path.exists(os.path.join(top, f)):
            continue
        stem = os.path.basename(f)[:-3]
        if f.startswith("backend/tests/"):
            if stem.startswith("test_"):
                tests.append(f)
            continue
        if stem in ("__init__", "conftest"):
            continue
        pattern = os.path.join(top, "backend", "tests", "**", "test_%s*.py" % stem)
        for m in glob.glob(pattern, recursive=True):
            tests.append(os.path.relpath(m, top))
    return sorted(set(tests))


def stop_mode(payload):
    base = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    top, main, gitdir = roots(base)
    files, untracked = changed_files(top)
    live = [f for f in files if os.path.exists(os.path.join(top, f))]
    fe = [f for f in live if is_frontend(f)]
    be = [f for f in files if is_backend_py(f)]
    contracts = any(f in CONTRACT_FILES for f in files)
    if not (fe or be or contracts):
        return 0

    fp = fingerprint(top, files, untracked)
    state = load_state(gitdir)
    if state.get("last_pass") == fp:
        return 0

    deadline = time.time() + STOP_BUDGET
    failures = []  # (check name, output, covered files)
    skipped = []   # reasons; any skip means this run is never cached

    def remaining():
        return deadline - time.time()

    def skip(msg):
        skipped.append(msg)
        print("verify: " + msg, file=sys.stderr)

    def check(name, cmd, cwd, covered):
        if remaining() <= 1:
            skip("time budget used up, skipping %s" % name)
            return
        rc, out = run(cmd, cwd, remaining())
        if rc == 0:
            return
        if rc is None:
            skip("%s did not finish within the time budget, skipping" % name)
        elif missing_module(out):
            skip("%s could not load its dependencies, skipping" % name)
        else:
            failures.append((name, out, covered))

    if fe:
        vitest = find_bin("frontend/node_modules/.bin/vitest", top, main)
        if vitest:
            rel = [os.path.relpath(os.path.join(top, f), os.path.join(top, "frontend")) for f in fe]
            check("vitest related", [vitest, "related", "--run"] + rel, os.path.join(top, "frontend"), fe)
        else:
            skip("vitest not found, skipping frontend tests")

    if be:
        tests = related_tests(top, files)
        py = find_bin("backend/.venv/bin/python", top, main)
        if not tests:
            skip("no backend tests found for the changed files, skipping pytest")
        elif not py:
            skip("backend/.venv not found, skipping pytest")
        else:
            check("pytest", [py, "-m", "pytest", "-q", "-x", "-o", "pythonpath=backend"] + tests, top,
                  [f for f in files if is_backend_py(f)])

    if contracts:
        node = shutil.which("node")
        if node:
            check("node-contracts", [node, "scripts/check-node-contracts.mjs"], top,
                  [f for f in files if f in CONTRACT_FILES])
        else:
            skip("node not found, skipping node contracts check")

    sid = str(payload.get("session_id") or "unknown")
    counts = state.setdefault("failures", {})
    if not failures:
        if not skipped:
            state["last_pass"] = fp
        counts.pop(sid, None)
        save_state(gitdir, state)
        return 0

    mine = set((state.get("edits") or {}).get(sid) or [])
    blocking = [(n, o, c) for n, o, c in failing_split(failures, mine)[0]]
    foreign = failing_split(failures, mine)[1]
    if foreign and not blocking:
        names = ", ".join(n for n, _, _ in foreign)
        theirs = sorted(set(f for _, _, c in foreign for f in c))
        print(json.dumps({"systemMessage": "verify: %s failing on changes this session didn't make: %s"
                          % (names, ", ".join(theirs))}))
        save_state(gitdir, state)
        return 0

    counts[sid] = counts.get(sid, 0) + 1
    save_state(gitdir, state)
    names = ", ".join(n for n, _, _ in blocking)
    if counts[sid] > MAX_ATTEMPTS:
        print(json.dumps({"systemMessage": "verify: %s still failing after %d attempts; report it"
                          % (names, MAX_ATTEMPTS)}))
        return 0
    report = ["verify: %s failed (attempt %d of %d)" % (names, counts[sid], MAX_ATTEMPTS)]
    for name, out, _ in blocking:
        report.append("--- %s ---\n%s" % (name, tail(out)))
    print("\n".join(report), file=sys.stderr)
    return 2


def failing_split(failures, mine):
    """Split failures into those on files this session edited and the rest."""
    own, other = [], []
    for item in failures:
        (own if mine.intersection(item[2]) else other).append(item)
    return own, other


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("edit", "stop"):
        print("usage: verify.py edit|stop", file=sys.stderr)
        return 1
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        return edit_mode(payload) if mode == "edit" else stop_mode(payload)
    except Exception as e:  # never block Claude because the hook itself broke
        print("verify: hook error: %s: %s" % (type(e).__name__, e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
