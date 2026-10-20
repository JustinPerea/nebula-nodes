# Headless CLI run, 2026-10-20: where the turns went

GM - Design recorded this run on Justin's dev Nebula for the moodboard demo. Plan v2.7 (`docs/moodboard-canvas-plan.md`, PR26 "First-turn context") uses it as its baseline. This file is a sanitized copy: commands, timings and the CLI's own error text only. Nothing the commands printed about the board is kept. The raw stream-json lived in GM's session scratchpad, which gets cleaned.

## Setup

- `claude -p`, model `claude-sonnet-5-5`, `--allowedTools Bash(nebula:*)`, strict MCP config with no MCP servers, so every action went through the `nebula` CLI.
- `NEBULA_AGENT_NAME="Claude Code"`.
- `nebula` on PATH was a guard wrapper (below) that refuses paid runs, `run-all`, `clear`, project switching, deletes and `propose --wait`, then forwards to the real CLI. It blocked nothing in this run.
- Result: `num_turns` 16, `duration_ms` 38,226 (API 22,813), `total_cost_usd` 0.226.

**Prompt**

> Turn my Good Machines moodboard (it's in my Good Machines project) into a hero image for the site: a quiet lake at dawn. Show me what the board gives you first, and ask me before anything that costs money.

**System prompt**

> You are working on the person's open Nebula Nodes canvas; they are watching it. Stay in the open project (a board from another project works by its id). Run only `nebula` commands, one per Bash call, never chained with other shell commands. Useful: `nebula projects`, `nebula moodboard list --project <id>`, `nebula moodboard show <id>`, `nebula nodes`, `nebula info <definitionId>`, `nebula apply --help`, `nebula look`, `nebula point`. Narrate as you work with `nebula point <node> --say "..."`: short lines, a few words. Build with `nebula apply` (several nodes and wires in one call, with --at positions about 450 px apart so nothing overlaps). To show the person what a board gives, wire the Moodboard's moodboard output into a Preview node and run the Preview; Moodboard, Preview and Text input are free to run. Anything that calls a paid model goes through `nebula propose` (no --wait); then stop and tell the person it is waiting for their Accept. Keep chat replies to one or two short sentences.

## The 15 tool calls

`t` is seconds on GM's recorder clock, from launch. GM's classification: 7 needed, 8 orientation. The 16th turn is the final reply.

| # | t (s) | Command | Result | Kind |
|---|---|---|---|---|
| 1 | 14.6 | `nebula projects` | ok | needed |
| 2 | 17.7 | `nebula moodboard list --project <id>` | ok | needed |
| 3 | 19.1 | `nebula moodboard show <board>` | ok (8,319 chars) | needed |
| 4 | 21.2 | `nebula apply --help` | ok | orientation |
| 5 | 21.3 | `nebula info moodboard` | exit 1: "Node 'moodboard' not found. Did you mean: krea-moodboard, nebula-moodboard, krea-moodboard-search, krea-moodboard-create" | orientation |
| 6 | 23.9 | `nebula info nebula-moodboard` | ok | orientation |
| 7 | 24.0 | `nebula nodes preview` | exit 2: "unrecognized arguments: preview" | orientation |
| 8 | 25.7 | `nebula nodes` | ok (20,489 chars) | orientation |
| 9 | 28.8 | `nebula apply --add +mb=nebula-moodboard --param +mb.moodboard=<board> --add +pv=preview …` | ok | needed |
| 10 | 30.6 | `nebula run n2` | ok | needed |
| 11 | 30.7 | `nebula point n1 --say "Here's what your board gives"` | ok | needed |
| 12 | 36.8 | `nebula info gpt-image-2-generate` | ok | orientation |
| 13 | 43.9 | `nebula propose --note … --add +p=text-input … --rename +g=Lake hero …` | exit 2: "unrecognized arguments: --rename +g=Lake hero" | orientation |
| 14 | 45.5 | `nebula propose --help` | ok | orientation |
| 15 | 47.7 | `nebula propose --note … ` | ok | needed |

**What the eight orientation calls were:**

- **Reading syntax (2):** `apply --help` (#4) and `propose --help` (#14).
- **Finding a node id (3):**
  - `info moodboard` failed, though its "Did you mean" named the right id (#5);
  - `info nebula-moodboard` (#6);
  - the full `nodes` list (#8, 20 KB).
- **Wrong options (2):**
  - `nodes` takes no search word (#7);
  - `propose` has no `--rename`, which `apply` has (#13).
- **A paid node's params (1):** `info gpt-image-2-generate` (#12).

The first orientation call is at t = 21.2 s and the last at 45.5 s. That 24 s span also holds the three needed build calls (#9 to #11), so it is an upper bound on the time orientation cost, not a measurement of it. `t` is GM's recorder clock, which starts before Claude's own (`duration_ms` 38.2 s; the final reply came at t = 50.1 s).

## The guard wrapper

The run went to Justin's dev Nebula: GM's recorder pointed at `http://127.0.0.1:8000` for the graph and `:5173` for the page, and the run's events were written at 10:59. At run time the wrapper forwarded to that backend, with the same guards as below (no paid runs, `run-all`, `clear`, project switching, `load` or `save`). The copy below is from a later rewrite (11:47) for an isolated-instance attempt GM then abandoned, so its docstring names `$NEBULA_URL` and "the isolated demo backend". That is the rewrite's target, not this run's.

```python
#!/usr/bin/env python3
"""Demo guard around the real nebula CLI, pointed at the isolated demo backend ($NEBULA_URL).
Refuses anything that could spend money, delete, or switch projects. `run` only when the node
and everything feeding it are free local nodes."""
import json, os, subprocess, sys, urllib.request
REPO = os.environ["NEBULA_DEMO_REPO"]; URL = os.environ["NEBULA_URL"]
FREE = {"nebula-moodboard", "preview", "text-input", "sticky-note"}
BLOCKED = {"run-all", "quick", "clear", "project", "load", "save", "keys", "mcp", "delete", "trash"}
a = sys.argv[1:]
def die(msg): print(msg, file=sys.stderr); sys.exit(2)
if a and a[0] in BLOCKED: die(f"Not allowed in this demo: nebula {a[0]}. Paid runs go through `nebula propose`.")
if a[:2] in (["moodboard", "delete"], ["moodboard", "move"]): die("Not allowed in this demo: that moodboard command.")
if a and a[0] == "propose" and "--wait" in a: die("Not allowed in this demo: --wait. Propose, then tell the person it is waiting for them.")
if a and a[0] == "run":
    refs = [x for x in a[1:] if not x.startswith("-") and x.startswith("n")]
    g = json.load(urllib.request.urlopen(URL + "/api/graph"))
    defs = {n["id"]: n["definitionId"] for n in g["nodes"]}
    up = {}
    for e in g["edges"]: up.setdefault(e["target"], []).append(e["source"])
    seen, todo = set(), list(refs)
    while todo:
        n = todo.pop()
        if n in seen: continue
        seen.add(n); todo += up.get(n, [])
    paid = sorted(f"{n} ({defs.get(n)})" for n in seen if defs.get(n) not in FREE)
    if not refs or paid: die("Not allowed in this demo: that run would call a paid model (" + ", ".join(paid) + "). Use `nebula propose` so the person decides.")
sys.exit(subprocess.run(["python", "-m", "nebula", "--url", URL, *a], cwd=REPO).returncode)
```
