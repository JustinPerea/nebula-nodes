# Risk tiers

How a pull request gets from open to merged. The change sets the tier, not who
wrote it: an agent's patch and a person's patch to the same file get the same
review. A PR that touches more than one tier takes the highest, and when it is
unclear which tier applies, take the one above. An agent's approval never
counts as Justin's.

## Low

Docs, notes in `docs/notes/`, test-only additions, internal tooling and scripts,
and code that sits behind a flag that is off.

Needs: CI green and one agent review in a fresh context. The agent merges
(auto-merge is fine).

## Medium

Features, UI and behavior changes, user-facing copy, and node additions.

Needs: CI green, a finder agent that reviews the diff, and a second agent that
tries to refute each of the finder's findings. Findings that survive are fixed
before merge. The agent merges, and Justin checks the result afterwards.

## High

Needs: Justin's explicit OK, in his own words in his own message, before merge.
Record the date and his words in the PR description.

These paths are high tier:

- Token and credential files: `backend/services/app_tokens.py`,
  `backend/services/agent_token_file.py`, `desktop/credentials.mjs`,
  `desktop/connector-vault.mjs`, `desktop/person-token.mjs`.
- Agent spend and process control: `backend/services/agent_spend.py`,
  `backend/services/agent_process.py`, `backend/services/agent_guardian.py`.
- Paid provider handlers: everything in `backend/handlers/` and
  `backend/routes/*_proxy.py`.
- Asset and project deletion: `backend/services/asset_trash.py`,
  `backend/services/project_asset_purge.py` and `backend/services/project_store.py`.
  The delete and purge routes themselves are in `backend/main.py`, which is too
  large to mark as a whole, so a change to `delete_saved_project` or the
  Recently deleted routes is high tier by hand.
- Desktop packaging and migration: `desktop/packaging/` and
  `desktop/migration.mjs`.

`.claude/high-tier-paths` holds the same list as globs (Python `fnmatch`, where
`*` also matches `/`), one per line, matched against repo-relative paths. A
guard hook reads it to block `gh pr merge` on a diff that touches one of them.
Keep the two lists in step when you change either.

## Verification hooks

`.claude/settings.json` runs `.claude/hooks/verify.py` for Claude Code sessions
in this repo. After each edit it lints the edited file (eslint for frontend
files, ruff or `py_compile` for backend files). When a turn ends it runs the
tests related to the changed files (`vitest related`, the matching backend
pytest files, and `scripts/check-node-contracts.mjs` when node definitions
changed). A failure is sent back to the session; after two failed attempts in a
session the hook stops blocking and reports the failure instead. These checks
supplement CI and do not replace it.
