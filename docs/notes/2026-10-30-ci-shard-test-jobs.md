# CI runs each test suite in three parts (ci/shard-test-jobs, 2026-10-30)

Why: the frontend job took 13 min 51 s on main (38bb573a) against its 15-minute timeout, and the backend job took 10 min 57 s. A PR that adds tests then got cancelled after every test had passed: #199 round 17's frontend job ran 8,911 of 8,911 tests and the build and budget checks, then hit 15 min 8 s and showed as failed. Raising the timeout would only move the line, so the suites now run in parts.

## What changed

- **Backend:** three jobs, "Backend tests (Python 3.12, part N of 3)". Each runs `python -m pytest` with `NEBULA_TEST_SHARD=N/3`.
  - `backend/tests/conftest.py` keeps only that part's files. Without the variable every test runs, so local runs are unchanged.
  - Whole files stay together, since a file's module fixtures and order can matter.
  - `backend/tests/ci_shard.py` gives files, largest first, to the part with the fewest tests so far. On 38bb573a that's 4,108, 4,108 and 4,107 of 12,323.
  - A malformed value stops the run (exit 4).
- **Frontend:** three jobs, "Frontend tests (part N of 3)", each running `npm test -- --shard=N/3` (vitest's own file sharding).
- **Lint and build** run once, in "Frontend lint and build", as before.
- `fail-fast: false`, so one failing part doesn't cancel the others, and every failure shows.
- The jobs keep their 15-minute timeouts. Each part now has a wide margin.

## Decisions

- **No new dependency.** pytest-split or pytest-xdist would add a package for what a 20-line collection hook does. xdist would also run tests in one process concurrently, which this suite's shared state hasn't been checked for.
- **Split by test count, not time.** Counts are known at collection with no stored timings. If one part grows slow, the fix is a fourth part, not a timings file.
- **A part that never runs would pass silently,** so `backend/tests/test_ci_shard.py` reads ci.yml:
  - each split job's matrix lists exactly 1 to N;
  - its `/N` matches;
  - `fail-fast` is off;
  - lint and the build stay outside the split.
  - It also runs pytest's collection three times on three small files, to check the parts hold every test exactly once.
- No branch protection names the old checks, so the renamed jobs need no settings change.

## Tests

`backend/tests/test_ci_shard.py`: 15 tests. Mutation check: 8 of 9 killed. The ninth (dropping the slash check in `parse_shard`) was equivalent, since a value with no slash already fails `int("")`, so the check was removed.
