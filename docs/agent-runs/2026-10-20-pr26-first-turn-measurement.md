# PR26 measurement: orientation turns before and after (not run yet)

**Status: waiting for Justin's OK.** The fifteen runs start Claude Code sessions on Justin's Claude plan. GM's single run cost $0.226, so fifteen come to about $3.40 at that rate (MCP runs may differ). Nothing in Nebula is spent: no paid node runs (below). When they have run, the counts go in `implementation-notes.md` and plan §10, and this file keeps the sanitized table per run, as GM's record does (`2026-10-20-cli-headless.md`).

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
# 0. Once: a checkout per side. The baseline is a detached worktree of origin/main.
git -C ~/Developer/projects/nebula_nodes worktree add --detach "$SCRATCH/nebula_nodes-pr26-baseline" origin/main
ln -s ~/Developer/projects/nebula_nodes/backend/.venv "$SCRATCH/nebula_nodes-pr26-baseline/backend/.venv"
REPO=$SCRATCH/nebula_nodes-pr26-baseline   # arms A and D
REPO=~/Developer/projects/nebula_nodes-pr26-first-turn   # arms B, C and E

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

cd $T && PATH="$T/bin:$REPO/backend/.venv/bin:$PATH" NEBULA_URL=http://127.0.0.1:8787 NEBULA_DEMO_REPO=$REPO NEBULA_AGENT_NAME="Claude Code" \
  claude -p "$PROMPT" --model claude-sonnet-5-5 --append-system-prompt "$SYSTEM" \
    --allowedTools "Bash(nebula:*)" --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    --max-budget-usd 0.6 --output-format stream-json --verbose > $T/run.jsonl
```

### MCP arms (D, E)

```bash
cat > $T/mcp.json <<JSON
{"mcpServers": {"nebula": {"command": "$REPO/backend/.venv/bin/python",
  "args": ["$REPO/backend/mcp_server.py", "--url", "http://127.0.0.1:8787"],
  "env": {"NEBULA_AGENT_NAME": "Claude Code"}}}}
JSON
SYSTEM_MCP='You are working on the person'"'"'s open Nebula Nodes canvas; they are watching it. Stay in the open project (a board from another project works by its id). Use only the nebula tools. Narrate as you work with point_at and a short say: a few words. To show the person what a board gives, wire the Moodboard'"'"'s moodboard output into a Preview node and run the Preview; Moodboard, Preview and Text input are free to run. Anything that calls a paid model goes through propose_change; then stop and tell the person it is waiting for their Accept. Keep chat replies to one or two short sentences.'

cd $T && claude -p "$PROMPT" --model claude-sonnet-5-5 --append-system-prompt "$SYSTEM_MCP" \
    --allowedTools "mcp__nebula" --strict-mcp-config --mcp-config $T/mcp.json \
    --max-budget-usd 0.6 --output-format stream-json --verbose > $T/run.jsonl
```

### Count, then clean up

```bash
python3 ~/Developer/projects/nebula_nodes-pr26-first-turn/scripts/count_agent_turns.py $T/run.jsonl          # table
python3 ~/Developer/projects/nebula_nodes-pr26-first-turn/scripts/count_agent_turns.py A1.jsonl A2.jsonl A3.jsonl   # an arm: median and range
kill $(cat $T/backend.pid); lsof -ti tcp:8787 | xargs kill 2>/dev/null; rm -rf $T     # the state dir holds the person token
```

During each run, sample `lsof -nP -a -p <backend pid> -i` a few times and keep only the count of non-loopback connections (expected 0).

## Two choices to confirm before running

- **`--append-system-prompt`.** GM's record gives his system prompt but not the flag that carried it. Appending keeps Claude Code's own system prompt, as a normal Claude Code session has; `--system-prompt` would replace it. Use the one GM used, if he can say.
- **The MCP arms' system prompt** (`SYSTEM_MCP` above) is GM's with the CLI words changed to the tools': no command list (the server's instructions name `start_here`), `point_at`, `propose_change`. The plan says "the same task on the MCP path" without the text; this is the closest equivalent.

## Results

Not run. One table per arm goes here (run, orientation/turns, usage errors, help reads, `num_turns`, duration, cost), then the median and range per arm, from `count_agent_turns.py`.
