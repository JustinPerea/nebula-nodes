# fix/test-temp-cleanup (2026-10-23)

Base: origin/main 8246211f.

## Why

`backend/tests/conftest.py` made seven `tempfile.mkdtemp` folders per run
(`nebula-test-state-*`, `-output-*`, `-characters-*`, `-moodboards-*`,
`-presets-*`, `-settings-*`, `-commons-*`) and never removed them. On
2026-10-23 the Mac ran out of disk; /private/tmp held 273 of them from 39 runs
(153 MB). Reported by another session's disk audit.

## What changed

- One parent folder, `nebula-test-<random>`, with the seven as subfolders
  under the same names. Each env var still points at its own folder, so no
  test sees a different layout than before except the shared parent.
- `atexit.register(shutil.rmtree, root, ignore_errors=True)` removes it when
  the pytest process exits, pass or fail. `ignore_errors` because a thread or
  child process can still be writing at exit.
- A run that is killed (SIGKILL, a crashed interpreter) still leaves its one
  folder. Sweeping old folders at start up was left out: other sessions run
  the suite at the same time on this Mac, and an age guess could delete a live
  run's state.

## Checks

- Full backend suite in an isolated TMPDIR; the TMPDIR listing after the run
  has no `nebula-test-*` folder. Result in the PR body.
