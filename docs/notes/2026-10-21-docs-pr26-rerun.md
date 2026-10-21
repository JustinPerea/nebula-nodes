# 2026-10-21 — PR26 rerun after PR26b

Branch `docs/pr26-rerun` from origin/main a330dc64. Docs only. Justin's Q94 a: "Yes, all nine, stop at $3."

- **What ran.** Arms B, C and E, three runs each, on #134's merge (772cabc6), with the method, prompts and isolation of `docs/agent-runs/2026-10-20-pr26-first-turn-measurement.md`. The driver checked the running total before each run and would have stopped before one that could pass $3; the nine cost $1.96. All 263 connection samples were 0 and no backend log had a provider attempt; every CLI run's `nebula` calls all went through the guard.
- **Same counter for both days.** PR26b changed `count_agent_turns.py` (ToolSearch and MCP argument errors now count as orientation), so the doc recounts the 2026-10-20 runs with the merged script before comparing. D and E's old numbers go up under it; A, B and C don't change.
- **Result.** Orientation at most 3 in all nine runs (medians B 5 → 3, C 3 → 1, E 4 → 2). Four runs made a usage error: three `nebula info moodboard` (the id is `nebula-moodboard`, which `nebula context` already names, but those agents guessed before reading it), and E3 calling three MCP tools by bare names before loading them, which Claude Code refused. C1 read `nebula apply --help`.
- **Load.** Other sessions kept the machine at load 20 to 54, so the doc says durations aren't comparable with the first run.
- **Checked.** An independent pass recomputed every number in the new section from the transcripts and the driver log; it found two wording errors, both fixed before the PR opened (the Moodboard claim, and "up to six times" where the worst case was about twelve).
- **Next, not built here.** Let `nebula info` and `describe_node` take a node's exact display name when it is unique. (A first draft also proposed naming the Moodboard node next to the boards; the number check found `nebula context` and `start_here` already do.) A further rerun is new spend and needs Justin's OK.
- **Raw transcripts** stay out of the repo (they hold session ids); the per-run counts are in the doc.
