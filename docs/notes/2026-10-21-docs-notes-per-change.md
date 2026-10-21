# 2026-10-21 — Notes move to one file per change

Branch `docs/notes-per-change` from origin/main aec631f9. Docs only. Justin's answer to Q84 and Q99 (both a).

- **Why.** Every change added its entry at the top of `implementation-notes.md`, so whenever one PR merged, every other open PR conflicted on that file and needed a re-merge and a fresh CI run before it could merge. On 2026-10-20, 43 PRs merged and branches took main in 53 times. Git's `merge=union` attribute would have merged the file locally, but GitHub's merge button most likely ignores it (rubocop-hq/rubocop#3594, 2016), so it wouldn't have unblocked PRs.
- **What changed.** New notes go in `docs/notes/<YYYY-MM-DD>-<branch>.md`, the branch name with `/` as `-`, so the folder lists in date order and two PRs never write the same file. `implementation-notes.md` keeps every entry so far and says where new ones go. `AGENTS.md` and `CONTRIBUTING.md` say the same.
- **Open PRs.** Each branch that still has an entry at the top of `implementation-notes.md` moves it into its own file here when it next takes main in.
- **Not changed.** Code comments and docs that point at existing entries in `implementation-notes.md` stay right, since those entries stay there. The plan's "every PR updates implementation-notes.md" line (`docs/moodboard-canvas-plan.md`) is changed on the plan's own open branch (#112), not here, so the two don't conflict.
