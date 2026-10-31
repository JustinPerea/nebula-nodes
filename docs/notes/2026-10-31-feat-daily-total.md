# Daily total for everything that isn't the person (feat/daily-total, 2026-10-31)

Justin decided: "Add a default daily total for everything that isn't you, shown and changeable in Settings (you pick the amount; $5 a day is a starting point). Over it, runs wait for your OK like a run over $1 does. Its own PR." GM - Design designed the surfaces and wrote every line; they're used verbatim.

## What it does

- **Setting:** `agentSpend.dailyTotalUsd`. Unset is $5 (`DEFAULT_DAILY_TOTAL_USD`). An explicit null is "No limit". An unreadable value is $5, never no limit. Only the person can change it (the settings route is person-only; agents get 403).
- **What counts:** every run that isn't the person's: chat agents, outside agents, connected apps, personal agents, scripts, and a tab not opened from the link. It covers the last 24 hours, rolling.
  - `SpendLedger.spent_daily()` sums the outside keys' events (the same records the outside cap counts).
  - It also sums `daily:chats`, a timed copy of every chat run. A chat key keeps a session total, which doesn't roll, so the copy is what lets chats roll in the same window.
  - A give-back with a time subtracts from the copy at the run's own time. One without a time stays counted (over-counting is the safe side).
  - The copy is pruned with the outside events and is never dropped by the chat-session cap.
- **Order:** the daily total is the first budget for every key (`session_budgets(..., daily_spent=)`). `decide` checks it first.
- **Over the total:**
  - `decide` returns a refusal with `Decision.wait` set (`DailyWait`).
  - Canvas run routes (`/api/graph/run`, `/api/execute`, `/api/execute-node`) pass `propose=True`. There `_require_spend_approval` raises `_WaitForOk`, and `_propose_waiting_run` opens a run-only proposal.
    - The note is the bar line. `proposal.wait` holds the lines, node ids and names.
    - The caller gets `202 {status: "waiting", proposalId, message, dailyTotal, alsoNeeds?, runId?}`.
    - Accept runs it as the person's, with an approval id, uncounted.
    - The same caller, project and nodes asking again get the proposal they already have.
    - A caller with no name gets an "Unnamed client" proposal.
    - More nodes than a proposal runs, a node not on the canvas, or a proposal that can't open falls back to the refusal, saying why.
  - Off-canvas runs (`/api/quick`, a moodboard read, a Cinema shot) have no canvas nodes to propose, so they're refused in the total's words.
- **Combined reason:** when the run also needs an OK for another reason, the line names the total first, then that reason (`also`).
  - The reasons are a per-run limit that trips (the per-model cap first, then the general one) or, when a USD limit applies, a node with no list price.
  - The total itself is left out of `usd_limited`, so the total alone never makes an unpriced node ask.
- **Atomic:** `SpendLedger.reserve(key, label, check)` runs the decision and the count under one lock. `_require_spend_approval` and the moodboard reader's hold both go through it. Two runs that each fit alone can't both pass.
- **The person's runs:** `_require_spend_approval` returns before any check for the person, as before. Their runs never reach the ledger, so they never count and never wait.
- **Agents read it:**
  - `GET /api/agent/spend` → `dailyTotal {limitUsd, usedUsd, leftUsd, window: "24h"}`.
  - `/api/agent/apps` → `daily.spentUsd`.
  - `nebula spend` prints the line, and `get_spend_limits` describes it.
  - `run_nodes` and `nebula run` report the waiting proposal; `nebula run` exits with 4.
- **UI:**
  - Settings › Preferences › Agent spending, first row: Daily total. Choices are $1, $2, $5, $10, $20 and $50 a day, plus Other amount… and No limit, with GM's usage line and a thin meter. The row lives in the lazy PreferencesTab chunk, not the entry.
  - The proposal bar shows `wait.barLine`.
  - Each waiting card gets a "Waiting for your OK" tag (role=status) whose `aria-describedby` points at the bar line while the bar shows that proposal.
  - The Updates card reads "<agent> wants to run “Writer” and “Editor”. <bar line>".
  - A tab not opened from the link whose run waits leaves its nodes idle and its Run history unchanged (`settleWaitingStart`).
- Docs: `docs/MCP-SETUP.md` (Spending limits, the spend read, the table row) and `skills/nebula/SKILL.md` (waiting runs, `nebula spend`).

## Decisions not in the brief

- **Auto-proposal only on canvas run routes.** GM's agent line says "Sent as proposal <id>", so a canvas run that passes the total opens the proposal itself; the agent doesn't have to ask. Every other refusal still leaves proposing to the agent, as before. Off-canvas routes can't be proposals, so they refuse.
- **The total doesn't make unpriced nodes ask.** Changing that would alter rows that don't pass the total, which the brief rules out. Unpriced spend can't be counted against the total either way. Question for Justin below.
- **`node_name_list` in the backend** mirrors the frontend `nodeNameList`, so the Updates line names nodes the same way the bar does: up to three quoted, repeats counted, then a count.
- **The waiting tag is an overlay in ProposalLayer**, positioned on each node, not drawn inside every card component. That keeps one place for it across all node kinds.
- **The focus ring for the Other amount field** sits on the field wrapper (`:has(input:focus-visible)`), like the API key field. focusRingCss's list names it.

## Guard tables (1944d052 → this branch)

**`agent_spend.decide` table:** 720 rows (5 runs × per-run on/off × 3 cap sets × daily unset/null/$2 × 4 used amounts × chat/outside key). 228 rows changed, and every one now waits. An independent check found that a row changed exactly when `used + run > limit` (0 mismatches). Rows at or under the total and rows with "No limit" are unchanged.

| Before | After | Rows |
|---|---|---|
| runs | wait: "…which has $X left." | 28 |
| runs | wait: "…which is used up." | 60 |
| refused: per-run limit | wait: "…and costs more than $1 per run." | 88 |
| refused: no list price | wait: "…and has a node with no list price." | 40 |
| refused: session or outside cap | wait: "…which has $X left." / "…is used up." | 12 |

**HTTP matrix:** 120 rows (6 scenarios × 4 routes × 5 callers). 32 rows changed, all in scenarios B (passes the total) and D (over $1 and the total), and all for callers that aren't the person.

| Scenario, route | Chat agent, outside agent, script, unconnected tab |
|---|---|
| B, graph/run | 200 finished → 202 waiting |
| B, execute / execute-node | 200 started → 202 waiting |
| B, quick | 200 → 403 in the total's words |
| D, graph/run / execute / execute-node | 403 per-run → 202 waiting |
| D, quick | 403 per-run → 403 in the total's words (total first) |

Unchanged: every person row, A (under everything), C (over $1 only), E (unpriced) and F (exactly at the total: $4.60 + $0.40 = $5.00 runs).

## Gates

Run on 2026-10-31 in the worktree, on a machine at load average 30–50. All npm calls used `NO_UPDATE_NOTIFIER=1 npm_config_update_notifier=false`.

- **Frontend:**
  - `tsc -b --noEmit` clean. `npm run lint` clean (check:inline-styles with 255 files, check:slava-css-scope, eslint).
  - `vite build` plus `check-build-budget.mjs` passed: entry 444,808 bytes raw (limit 512,000). The Daily total row is only in the `PreferencesTab` chunk.
- **Focused vitest:** 198 files, `--maxWorkers=2`, from an explicit non-empty zsh array, including every ratchet that reads src/ or styles/. Run in five chunks: 3,055 passed and 9 failed. No "Errors" line in any chunk.
  - focusRingCss caught the new field, which cleared its outline without naming its focus rule. Fixed (see Decisions), and it passed on the rerun.
  - Six were timeouts under load: lazyText, r27pin, the ratchet's 120 s corpus, AgentRosterCorner, round21Store, and canvasPinsStore's first test. All passed on a one-worker rerun.
  - Settings.test fails 2–3 tests on the branch, waiting for the lazy Providers tab and the setup-link focus. The same file fails 4 tests on 1944d052 under the same load, so it isn't this change.
- **Backend:** 66 files, isolated (temp HOME and every NEBULA_* path): 2,491 passed in 9 m 45 s.
  - They cover every test that touches agent_spend, the spend ledger or runCostConfirm, every test that reads SKILL.md or MCP-SETUP.md, and the CLI tests.
  - Also test_daily_total, test_canvas_proposals, test_canvas_proposal_updates, test_mcp_tools, test_agent_notes, test_round19_node_names, test_unprivileged_marker and test_ci_shard.
- **New tests on 1944d052:**
  - `tests/dailyTotal.test.tsx` fails to import `lib/dailyTotal`.
  - Both tests in `tests/graphStore.dailyTotalWait.test.ts` fail: the node ends in "error", not "idle".
  - `tests/test_daily_total.py` fails at collection: `node_name_list` and the daily names don't exist.
- **Mutants:** each was applied, the new tests run, and the file restored byte for byte. All 18 were killed.
  - Backend (test_daily_total.py):
    - `>` becomes `>=` in the total check.
    - No daily budget in `_spend_budgets`.
    - Chat runs not copied into `daily:chats`.
    - `reserve` without its lock.
    - `reserve` that checks but never counts.
    - Unset becomes no limit.
    - Unreadable becomes no limit.
    - The total counts toward `usd_limited`.
    - `propose` forced off.
    - No read-time window. The first run survived, because a later write prunes old events anyway. I added a read before any write, and it's killed now.
    - A chat give-back skips the daily copy.
    - No dedupe of a waiting proposal.
    - The person's runs are checked too.
  - Frontend (dailyTotal.test.tsx, graphStore.dailyTotalWait.test.ts):
    - `>=` becomes `>` in the usage line.
    - The waiting start isn't settled (all four call sites).
    - The tag always points at the bar line.
    - Escape saves.
    - The bar doesn't carry the wait line's id.
- **Live check:** backend on 127.0.0.1:8791 with a temp HOME and every NEBULA_* path, and an in-process socket guard (canary 1.1.1.1:443 refused). Vite on 5791 with `VITE_NEBULA_BACKEND_PORT=8791`.
  - Puppeteer blocked 8000–8010, 5173, 8840 and 5840 through CDP `setBlockedURLs`, with a dead proxy for every other host. Canaries 8000, 5173 and example.com were all blocked, and 0 requests were blocked during the shots.
  - The key was fake, the $0.20 gpt-image-1 price was a fixture, and the spend was fixture spend. Nothing ran a provider.
  - Shots: 10 of Settings (nothing, $3.40, $5.20, No limit and Other amount…, each at 1440 and 700) and 5 of the canvas (full frame with the arrival card, full frame, bar, cards, Updates card). No two share an md5 (`uniq -d` is empty), and I opened every one.

## Open questions

For GM:
1. **The combined line for a node with no list price.** It reads "This would pass the $5 daily total and has a node with no list price." Your design gives the per-run variant; this one follows its pattern.
2. **A per-model per-run cap in the combined line.** I used that model's cap: "…costs more than $0.50 per run".
3. **A session or outside cap passed together with the total.** The line names only the total ("which has $X left"), with no second reason. Should it say the cap too?
4. **A caller with no name.** Its proposal shows "Unnamed client". Is that the right name?
5. **The Updates line names the nodes** ("“Writer” and “Editor”", up to three, then a count) rather than your example's "2 nodes".
6. **The combined case for agents.** The agent line stays your single line, and `alsoNeeds` sits beside it in the JSON.
7. **The waiting tag position.** It's an overlay above each card, not drawn inside the card.

For Justin:
1. **Unpriced nodes.** Should the total alone make a node with no list price ask? Today it doesn't (no other USD limit set means unpriced nodes run). Turning that on would change rows that don't pass the total, so I left it off.
