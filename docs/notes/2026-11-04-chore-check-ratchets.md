# check:ratchets (2026-11-04, chore/check-ratchets)

`npm run check:ratchets` (from `frontend/`; runs `scripts/check-ratchets.mjs`) runs every test that reads the source tree or the docs from disk.

## Discovery (by content, never a hard-coded list)
- Frontend: every `*.test.ts(x)` under `frontend/src` and `frontend/tests` using `readFileSync`, `readdirSync`, `fs.`, `node:fs`, `import.meta.glob` or `?raw`. Run with `vitest run --maxWorkers=2`. On this commit: 135 files, 5046 tests.
- Backend: every `backend/tests/test_*.py` using `rglob(`, `os.walk(` or `.glob("*.py")`, or naming `SKILL.md`, `MCP-SETUP.md` or `docs/<name>.md`, plus a fixed list of four whose subject is the suite itself (`test_unprivileged_marker`, `test_ci_shard`, `test_connected_copy_sweep`, `test_round20_fence`). 78 files, 3023 passed, 3 skipped.
- Either count at 0 fails the run. Python is `backend/.venv/bin/python` when present, else `python3`.
- Backend isolation: `NEBULA_TEST_SHARD` removed; `HOME`, `NEBULA_SETTINGS_PATH`, `NEBULA_STATE_DIR` and `NEBULA_OUTPUT_ROOT` point into a fresh temp dir, deleted afterwards.

## Decisions
- No CI step. CI's frontend and backend shards already run every test, so a ratchet job would only repeat them. The command's value is local: it runs the far-away tests before a push.
- The frontend discovery is broader than the three named ratchets (it also takes any test that uses `fs`), so it will run some tests that aren't ratchets. That costs about 2 minutes and misses nothing.
- Self-test `frontend/tests/checkRatchets.test.ts` pins discovery (a known disk-reading test found, a pure unit test skipped, a known backend walker and docs reader found) and runs a probe pytest through the same runner with `NEBULA_TEST_SHARD` set in the parent, to prove HOME is a temp dir, the shard is gone and the temp dir is removed. It never touches the real HOME.
- That self-test reads no disk itself but imports the script, which does, so it is discovered by its own scan (intended; it is a ratchet on the ratchet).
- Runtime on the maintainer's Mac: about 4.6 minutes (frontend 111 s, backend 164 s).
- No root package.json exists, so the script is wired only from `frontend/package.json`.
