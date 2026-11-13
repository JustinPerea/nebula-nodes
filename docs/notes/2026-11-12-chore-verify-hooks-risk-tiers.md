# chore/verify-hooks-risk-tiers

Adds `.claude/hooks/verify.py` (edit and stop hooks for Claude Code sessions),
`RISK-TIERS.md`, and `.claude/high-tier-paths`.

Decisions

- `.claude/settings.json` was already tracked (the `SessionStart` hook) and the
  `.gitignore` negation for it already existed, so the file is extended, not
  replaced. `.claude/hooks/` and `.claude/high-tier-paths` were not ignored.
- The project delete route (`delete_saved_project`) is in `backend/main.py`,
  which is too large to put under high tier as a whole. The path list covers
  `project_store.py` and `project_asset_purge.py`, and `RISK-TIERS.md` tells
  reviewers to treat a change to the route as high tier by hand.
- The stop hook caches a passing fingerprint only when every applicable check
  ran to completion. A missing tool, a missing venv, no related backend tests
  or a timeout is a skip with a stderr notice and is never cached.
- Timeouts kill the whole process group (`start_new_session` and `killpg`) and
  count as skips.
- The edit hook records every in-repo path it sees under the session id in
  `<git-dir>/claude-verify/state.json`. The stop hook blocks only when the
  session edited a changed file that the failing check covers; otherwise it
  exits 0 with a systemMessage naming the files. This keeps a lane from being
  blocked by another lane's changes in a shared checkout.
- State is per worktree (`git rev-parse --git-dir`) and written with
  `mkstemp` plus `os.replace`.
- Binaries resolve from the worktree first, then the main checkout. If a tool
  found in the main checkout cannot load its packages from the worktree, the
  check is skipped.

Surprises

- `vitest related` on a widely imported lib file (`agentCursorLabel.ts`) takes
  about 80 to 90 s on this Mac, so a stop run on a central file uses half the
  180 s cap.

CI

- `backend/tests/test_cloud_session_setup.py` asserted that settings.json holds
  only a `SessionStart` hook; it now lists the two verify hooks too.
- `ProjectHome.test.tsx` ("Delete forever confirms on its own row") failed in
  CI on this branch with a date-dependent string ("Deleted Oct 10 ... Removed
  for good within" instead of "in"). It does not touch files in this PR and is
  not addressed here.
