# PR26 measurement: orientation turns before and after

**Status: run on 2026-10-20 with Justin's OK on the spend. PR26 missed its target on all three arms** ([Results](#results)). The runs were Claude Code sessions on Justin's Claude plan: $4.18 in all, under the $5 stop cap set for them. Nothing in Nebula was spent: no paid node ran, every connection sample was 0. The counts are also in `implementation-notes.md` and plan §10. This file keeps the sanitized table per run, as GM's record does (`2026-10-20-cli-headless.md`).

Plan v2.7 §5.10.1 sets the method. This file is the exact commands.

## Arms

| Arm | Checkout | Path | System prompt | Runs |
|---|---|---|---|---|
| A. Baseline CLI | `origin/main` | `nebula` CLI only | GM's, unchanged | 3 |
| B. Branch CLI | `feat/agent-first-turn` | `nebula` CLI only | GM's, unchanged | 3 |
| C. Branch CLI, swapped prompt | `feat/agent-first-turn` | `nebula` CLI only | GM's, with "`nebula apply --help`" replaced by "`nebula context`" and nothing else | 3 (reported apart) |
| D. Baseline MCP | `origin/main` | the `nebula` MCP server only | see "MCP arms" | 3 |
| E. Branch MCP | `feat/agent-first-turn` | the `nebula` MCP server only | see "MCP arms" | 3 |

Arm A checks that the baseline reproduces GM's 8 of 16. The target on B, C and E (§5.10.1): at most 3 orientation turns and no usage error; no help read on C and E.

## One run, step by step

Every run gets a fresh isolated stack, so no run sees another's canvas. Ports 8787 (backend) only; never 8000-8010 or 5173.

```bash
# 0. Once: a detached checkout per side, pinned around PR26's merge so later
#    merges don't move either side. Before PR26 merges: origin/main and the branch.
MAIN=~/Developer/projects/nebula_nodes
MERGE=$(git -C $MAIN log origin/main --merges --first-parent --grep 'feat/agent-first-turn' -1 --format=%H)
BEFORE=${MERGE:+$MERGE^1}; BEFORE=${BEFORE:-origin/main}; AFTER=${MERGE:-origin/feat/agent-first-turn}
for side in baseline after; do
  ref=$([ $side = baseline ] && echo "$BEFORE" || echo "$AFTER")
  git -C $MAIN worktree add --detach "$SCRATCH/nebula_nodes-pr26-$side" "$ref"
  ln -s $MAIN/backend/.venv "$SCRATCH/nebula_nodes-pr26-$side/backend/.venv"
done
REPO=$SCRATCH/nebula_nodes-pr26-baseline   # arms A and D
REPO=$SCRATCH/nebula_nodes-pr26-after      # arms B, C and E

# 1. Isolated state. Placeholder keys make GM's models show as ready (as on his
#    Nebula). Two locks keep every provider call from leaving the machine:
#    - runCostConfirmUsd 0.0001: an agent's run of any priced paid node is over the
#      per-run limit and refused (send it as a proposal), and a node with no list
#      price is refused under any limit. No one accepts a proposal. It must be a
#      positive number: 0 is not a valid limit, and Nebula then falls back to its
#      $1.00 default, under which an MCP arm (which has no guard wrapper) could
#      start a real gpt-image-2 run.
#    - HTTP(S)_PROXY points at a dead port for the backend, with loopback exempt,
#      so a provider request that got past the limit fails on this machine.
T=$(mktemp -d "$SCRATCH/pr26-measure.XXXXXX"); mkdir -p $T/home
cat > $T/settings.json <<'JSON'
{"apiKeys": {"OPENAI_API_KEY": "sk-measurement-placeholder", "GOOGLE_API_KEY": "measurement-placeholder"},
 "runCostConfirmUsd": 0.0001}
JSON
ISO=(env -i PATH="$(dirname $(command -v node)):/usr/bin:/bin:/usr/sbin:/sbin" HOME=$T/home TMPDIR=$T LANG=en_US.UTF-8
     NEBULA_SETTINGS_PATH=$T/settings.json NEBULA_STATE_DIR=$T/state NEBULA_OUTPUT_ROOT=$T/output
     NEBULA_MOODBOARD_ROOT=$T/moodboards NEBULA_CHARACTER_ROOT=$T/characters NEBULA_PRESET_ROOT=$T/presets
     HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9
     NO_PROXY=127.0.0.1,localhost)

# 2. Backend (capture the PID; stop it by PID at the end).
(cd $REPO/backend && "${ISO[@]}" .venv/bin/python devserver.py --port 8787 --no-reload > $T/backend.log 2>&1 &
 echo $! > $T/backend.pid)
until curl -sf http://127.0.0.1:8787/api/health >/dev/null; do sleep 1; done
# Before any run: the limit is the one set above, not the $1.00 fallback.
curl -sf -H 'X-Nebula-Agent: Claude Code' http://127.0.0.1:8787/api/agent/spend \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["limits"]["perRunUsd"] == 0.0001, d; print("limit ok")'

# 3. Seed a Good Machines-style project and board: eight 640x480 solid-colour PNGs
#    (stdlib only). The board is not analyzed (below).
"${ISO[@]}" $REPO/backend/.venv/bin/python - $T/imgs <<'PY'
import struct, sys, zlib, pathlib
out = pathlib.Path(sys.argv[1]); out.mkdir()
def png(path, rgb, w=640, h=480):
    row = b"\x00" + bytes(rgb) * w
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(row * h)) + chunk(b"IEND", b""))
for i, rgb in enumerate([(32, 44, 52), (210, 200, 182), (120, 140, 128), (238, 226, 205),
                         (70, 86, 96), (180, 150, 110), (20, 24, 28), (226, 214, 190)]):
    png(out / f"gm-{i}.png", rgb)
PY
N=("${ISO[@]}" NEBULA_AGENT_NAME=Seeder $REPO/backend/.venv/bin/python -m nebula --url http://127.0.0.1:8787)
(cd $REPO && "${N[@]}" project new "Good Machines" && "${N[@]}" moodboard new "Good Machines" $T/imgs --project current \
  && "${N[@]}" moodboard set "Good Machines" --direction "quiet, warm, early light; restrained type")
```

The analysis step is left out on purpose: `nebula moodboard analyze` can call a vision model. GM's board was analyzed; if the comparison needs that, analyze once with a mocked analyzer and copy the board file into each run's `$T/moodboards`, and say so in the results.

### CLI arms (A, B, C)

```bash
# GM's guard wrapper (2026-10-20-cli-headless.md, "The guard wrapper"), saved as $T/bin/nebula. It runs
# `python -m nebula`, so the venv's bin goes on PATH after it.
mkdir -p $T/bin && cp guard.py $T/bin/nebula && chmod +x $T/bin/nebula   # guard.py = the record's listing

SYSTEM='You are working on the person'"'"'s open Nebula Nodes canvas; they are watching it. ...'   # GM's text, verbatim from the record
# Arm C only: the same text with `nebula apply --help` replaced by `nebula context`.
PROMPT="Turn my Good Machines moodboard (it's in my Good Machines project) into a hero image for the site: a quiet lake at dawn. Show me what the board gives you first, and ask me before anything that costs money."

# Claude Code's Bash tool loads the login profile, which can put another `nebula` (one on ~/.local/bin,
# say) ahead of $T/bin. CLAUDE_ENV_FILE runs before every Bash command, after the profile, so the guard
# wins every time. The guard also logs each call (one line in $PR26_GUARD_LOG) so the run can prove it.
printf 'export PATH="%s/bin:%s/backend/.venv/bin:$PATH"\nexport PR26_GUARD_LOG="%s/guard.log"\n' "$T" "$REPO" "$T" > $T/env.sh

mkdir -p $T/agentcwd && cd $T/agentcwd && PATH="$T/bin:$REPO/backend/.venv/bin:$PATH" CLAUDE_ENV_FILE=$T/env.sh \
  PR26_GUARD_LOG=$T/guard.log NEBULA_URL=http://127.0.0.1:8787 NEBULA_DEMO_REPO=$REPO NEBULA_AGENT_NAME="Claude Code" \
  claude -p "$PROMPT" --model claude-sonnet-5-5 --append-system-prompt "$SYSTEM" \
    --allowedTools "Bash(nebula:*)" --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    --max-budget-usd 0.6 --output-format stream-json --verbose > $T/run.jsonl
# After the run: the `nebula` calls in the transcript's Bash commands must equal the lines in guard.log.
```

The guard logs with one line after `a = sys.argv[1:]`: `open(os.environ["PR26_GUARD_LOG"], "a").write(json.dumps(a) + "\n")`. Nothing the agent sees changes.

### MCP arms (D, E)

```bash
cat > $T/mcp.json <<JSON
{"mcpServers": {"nebula": {"command": "$REPO/backend/.venv/bin/python",
  "args": ["$REPO/backend/mcp_server.py", "--url", "http://127.0.0.1:8787"],
  "env": {"NEBULA_AGENT_NAME": "Claude Code"}}}}
JSON
SYSTEM_MCP='You are working on the person'"'"'s open Nebula Nodes canvas; they are watching it. Stay in the open project (a board from another project works by its id). Use only the nebula tools. Narrate as you work with point_at and a short say: a few words. To show the person what a board gives, wire the Moodboard'"'"'s moodboard output into a Preview node and run the Preview; Moodboard, Preview and Text input are free to run. Anything that calls a paid model goes through propose_change; then stop and tell the person it is waiting for their Accept. Keep chat replies to one or two short sentences.'

mkdir -p $T/agentcwd && cd $T/agentcwd && claude -p "$PROMPT" --model claude-sonnet-5-5 --append-system-prompt "$SYSTEM_MCP" \
    --allowedTools "mcp__nebula" --strict-mcp-config --mcp-config $T/mcp.json \
    --max-budget-usd 0.6 --output-format stream-json --verbose > $T/run.jsonl
```

### Count, then clean up

```bash
python3 $SCRATCH/nebula_nodes-pr26-after/scripts/count_agent_turns.py $T/run.jsonl          # table
python3 $SCRATCH/nebula_nodes-pr26-after/scripts/count_agent_turns.py A1.jsonl A2.jsonl A3.jsonl   # an arm: median and range
kill $(cat $T/backend.pid); lsof -ti tcp:8787 | xargs kill 2>/dev/null; rm -rf $T     # the state dir holds the person token
```

During each run, sample `lsof -nP -a -p <backend pid> -i` a few times and keep only the count of non-loopback connections (expected 0).

## Settled with GM (2026-10-20)

GM checked his recorder script and the files it read:
- **The flag was `--append-system-prompt`.**
- **The record's system prompt and user prompt are the exact text used.** GM compared them programmatically.
- **His command:** `claude -p PROMPT --output-format stream-json --verbose --model claude-sonnet-5-5 --allowedTools "Bash(nebula:*)" --strict-mcp-config --append-system-prompt SYS`, with `NEBULA_AGENT_NAME="Claude Code"` and the guard wrapper first on PATH.
- **It ran from an empty folder,** so no project CLAUDE.md was loaded. The commands above `cd` into an empty `$T/agentcwd` for the same reason.
- **There was no `--bare` or `--setting-sources`,** so user-level settings and `~/.claude/CLAUDE.md` applied, as for any `claude -p` on this Mac. The runs here leave those as they are.

Still a choice: **the MCP arms' system prompt** (`SYSTEM_MCP` above). It is GM's text with the CLI words changed to the tools' words:
- no command list, because the server's instructions name `start_here`;
- `point_at` and `propose_change` in place of the CLI commands.

The plan says "the same task on the MCP path" without giving the text, so this is the closest equivalent.

## Results

Run on 2026-10-20, with the checkouts pinned at `466235b2^1` (baseline, arms A and D) and `466235b2` (#125's merge, arms B, C and E). Model `claude-sonnet-5-5`, one board of eight unanalyzed images, a fresh isolated stack per run. Counts are from `count_agent_turns.py` as merged with PR26.

### Against the target

The target for B, C and E (§5.10.1): at most 3 orientation turns and no usage error; no help read on C and E.

| Arm | Orientation, median (range) | Usage errors, median | Help reads, median | Target |
|---|---|---|---|---|
| A. Baseline CLI | 2 (1 to 5) | 1 | 1 | (baseline) |
| B. Branch CLI | 5 (2 to 5) | 0 | 2 | **Missed**: two of three runs took 5 orientation turns |
| C. Branch CLI, swapped prompt | 3 (1 to 3) | 0 | 1 | **Missed**: every run read `nebula apply --help` |
| D. Baseline MCP | 5 (3 to 6) | 0 | 0 | (baseline) |
| E. Branch MCP | 2 (1 to 3) | 3 | 0 | **Missed**: E1 and E2 made three usage errors each |

PR26 did cut MCP orientation (D's median 5 to E's 2). On the CLI the baseline was already at a median of 2, so B and C had little to gain, and B did worse.

### What the transcripts show

- **A doesn't reproduce GM's 8 of 16.** GM's run went to Justin's dev Nebula, with many projects and boards, an analyzed board, and the CLI of that morning. These runs start from one project, one unanalyzed board, and a CLI that already has #118 (the Undo line) and #123 (the cover). That is the likely reason: fewer things to look through, and better errors, leave less to orient on.
- **B follows GM's system prompt, which says to read `nebula apply --help`.** Every B run did, and also ran `nebula context`, so B pays for both. B1's usage error is `nebula point --say "..."` with no node or x and y.
- **C: `nebula context` names `apply` but not its flags.** With the prompt pointing at `nebula context` instead, no run made a usage error and none took more than 3 orientation turns. But each still ran `nebula apply --help` to learn `--add`, `--param`, `--wire` and `--at`.
- **E: `start_here` first means no tool schemas loaded.** Claude Code defers MCP tool schemas behind its ToolSearch tool. `start_here` takes no arguments, so in E1 and E2 the agent called it straight away, never loaded a schema, and guessed the argument names of the tools after it:
  - `moodboard_get {"id": ...}` (it takes `board`);
  - `describe_node {"id": ...}`, twice (it takes `definition_id`);
  - `point_at` with only `say` (it needs `node_id`, or `x` and `y`);
  - `edit_canvas` nodes with `type` and edges with `from`/`to` (it takes `definitionId`, and `source`, `sourceHandle`, `target`, `targetHandle`).

  The pydantic errors were enough for the agent to fix each call, one turn later. E3, and every D run, called ToolSearch first and made none of these errors.
- **The counter undercounts two things.** It counts ToolSearch as a needed call, though it is orientation. And it counts a failed call as a usage error only when the error text matches its patterns: the `point_at` and `edit_canvas` failures above, and the wrong `text` param on Text input (D2, E3), show up only in the "Other failed calls" column below.

### Per run

"Other failed calls" are failed calls the counter didn't class as usage errors. "ToolSearch" is how often the agent loaded tool schemas.

#### A. Baseline CLI

| Run | Orientation / turns | Usage errors | Help reads | Other failed calls | ToolSearch | `num_turns` | Duration | Cost |
|---|---|---|---|---|---|---|---|---|
| A1 | 5 / 12 | 2 | 2 | 0 | 0 | 14 | 24.2 s | $0.221 |
| A2 | 1 / 7 | 1 | 1 | 0 | 0 | 11 | 30.5 s | $0.221 |
| A3 | 2 / 8 | 0 | 1 | 0 | 0 | 9 | 23.2 s | $0.222 |

Orientation median 2 (range 1 to 5); usage errors median 1; help reads median 1.

#### B. Branch CLI

| Run | Orientation / turns | Usage errors | Help reads | Other failed calls | ToolSearch | `num_turns` | Duration | Cost |
|---|---|---|---|---|---|---|---|---|
| B1 | 5 / 12 | 1 | 2 | 0 | 0 | 13 | 70.8 s | $0.259 |
| B2 | 5 / 13 | 0 | 2 | 0 | 0 | 16 | 53.0 s | $0.288 |
| B3 | 2 / 8 | 0 | 1 | 0 | 0 | 10 | 22.9 s | $0.223 |

Orientation median 5 (range 2 to 5); usage errors median 0; help reads median 2.

#### C. Branch CLI, swapped prompt

| Run | Orientation / turns | Usage errors | Help reads | Other failed calls | ToolSearch | `num_turns` | Duration | Cost |
|---|---|---|---|---|---|---|---|---|
| C1 | 1 / 6 | 0 | 1 | 0 | 0 | 8 | 13.8 s | $0.183 |
| C2 | 3 / 11 | 0 | 1 | 1 | 0 | 12 | 23.4 s | $0.220 |
| C3 | 3 / 10 | 0 | 1 | 0 | 0 | 12 | 35.7 s | $0.245 |

Orientation median 3 (range 1 to 3); usage errors median 0; help reads median 1.

#### D. Baseline MCP

| Run | Orientation / turns | Usage errors | Help reads | Other failed calls | ToolSearch | `num_turns` | Duration | Cost |
|---|---|---|---|---|---|---|---|---|
| D1 | 6 / 13 | 0 | 0 | 0 | 1 | 17 | 29.8 s | $0.300 |
| D2 | 3 / 11 | 0 | 0 | 1 | 1 | 13 | 24.8 s | $0.276 |
| D3 | 5 / 14 | 0 | 0 | 0 | 2 | 18 | 30.8 s | $0.293 |

Orientation median 5 (range 3 to 6); usage errors median 0; help reads median 0.

#### E. Branch MCP

| Run | Orientation / turns | Usage errors | Help reads | Other failed calls | ToolSearch | `num_turns` | Duration | Cost |
|---|---|---|---|---|---|---|---|---|
| E1 | 3 / 10 | 3 | 0 | 3 | 0 | 15 | 31.0 s | $0.223 |
| E2 | 1 / 9 | 3 | 0 | 4 | 0 | 16 | 21.7 s | $0.222 |
| E3 | 2 / 12 | 0 | 0 | 1 | 2 | 17 | 27.9 s | $0.298 |

Orientation median 2 (range 1 to 3); usage errors median 3; help reads median 0.

### Isolation and the two reruns

Every connection sample was 0, and no backend log had a provider attempt. Spend: $3.69 for the fifteen runs below, $0.48 for two runs set aside, and $0.006 for a check of the PATH fix: $4.18 in all.

The first C1 and C2 ran the wrong CLI. Claude Code's Bash tool loads the login profile, and on this Mac that put another `nebula` ahead of the guard on PATH: a wrapper that runs the main checkout, which was older than either side. Those runs still reached only the isolated backend on 8787 (fresh project ids, the seeded board, and the dev backend's log shows only health checks over the window). But they skipped the guard and ran old code, so they were set aside. C1 and C2 were run again with `CLAUDE_ENV_FILE` and the guard log ([CLI arms](#cli-arms-a-b-c)): 7 of 7 and 11 of 11 `nebula` calls went through the guard. The other CLI runs had no guard log. Their transcripts carry text only code newer than the main checkout prints ("Undo: nebula undo", "Cover: #"). The two runs set aside have neither.

### Next

The fixes for what the transcripts show go in a follow-up, PR26b:
- `nebula context` gives the `apply` flags in a few lines;
- `start_here` shows the exact arguments of the calls that come next;
- argument errors name the right parameters in one line;
- `point --say` and `point_at(say=...)` work without a target;
- the counter counts ToolSearch and argument failures as orientation.

Then B, C and E run again: nine runs, about $2.20, after Justin's OK on that spend.
