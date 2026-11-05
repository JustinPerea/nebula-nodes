"""A stand-in for Google's ``agy`` CLI, for tests and live checks only.

Never the real thing: Nebula's tests and screenshots must not spend the
person's Antigravity plan. ``tests/test_board_reading.py`` writes this file
next to a ``behavior`` file with a shebang for the test's Python, and puts its
folder where Nebula looks for ``agy``. The behavior file names what it does:

- ``ok``: answer like ``agy --output-format json``, citing two of the files;
- ``timeout``: sleep past any limit;
- ``signed_out``: refuse as a signed-out agy does (exit 1);
- ``plan_limit``: an ``AGY_ERROR`` line for an exhausted quota (exit 3);
- ``write``: write a file into its working folder, then answer;
- ``garbage``: print text that isn't JSON;
- ``huge``: print more than Nebula reads;
- ``print_timeout``: answer with ``finished_reason: print_timeout``.

``-p /usage`` answers JSON while ``status`` (another file, default
``signed_in``) says signed in, else exits 1. Every call is appended to
``calls.jsonl`` beside it: argv, cwd, the environment's names and the files
it could see.
"""
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def read(name, default):
    try:
        return (HERE / name).read_text().strip() or default
    except OSError:
        return default


argv = sys.argv[1:]
cwd = Path.cwd()
images = sorted(p.name for p in (cwd / "images").iterdir()) if (cwd / "images").is_dir() else []
with open(HERE / "calls.jsonl", "a") as log:
    log.write(json.dumps({"argv": argv, "cwd": str(cwd), "env": dict(os.environ), "images": images,
                          "entries": sorted(str(p.relative_to(cwd)) for p in cwd.rglob("*"))}) + "\n")

prompt = argv[argv.index("-p") + 1] if "-p" in argv and argv.index("-p") + 1 < len(argv) else ""
if prompt == "/usage":
    if read("status", "signed_in") == "signed_in":
        print(json.dumps({"models": [{"name": "Gemini 4 Argon", "remaining_percentage": 40}]}))
        sys.exit(0)
    print("Error: authentication failed: not signed in", file=sys.stderr)
    sys.exit(1)

behavior = read("behavior", "ok")
cites = images[:2] or ["tile-unknown.png"]
answer = ("The style is **ultramarine monochrome** with dithered textures.\n\n"
          "### What makes it distinctive\n\n"
          f"- Halftone dithering across the surfaces (`{cites[0]}`).\n"
          f"- Condensed display type over quiet product UI (`{cites[-1]}`, `tile-notsent.png`).\n\n"
          "### Why it works\n\nOne filter unifies eclectic sources.")
if behavior == "timeout":
    time.sleep(600)
elif behavior == "signed_out":
    print("Error: authentication failed: please sign in again", file=sys.stderr)
    sys.exit(1)
elif behavior == "plan_limit":
    print('AGY_ERROR: {"status": "RESOURCE_EXHAUSTED", "code": 429, "retryable": false}', file=sys.stderr)
    sys.exit(3)
elif behavior == "write":
    (cwd / "notes.md").write_text("I was told not to.")
    print(json.dumps({"result": answer}))
elif behavior == "garbage":
    print("Working... done! Here is your answer, not as JSON.")
elif behavior == "huge":
    sys.stdout.write("x" * (3 * 1024 * 1024))
elif behavior == "print_timeout":
    print(json.dumps({"result": answer[:40], "finished_reason": "print_timeout"}))
else:
    print(json.dumps({"result": answer, "conversation_id": "c-1", "num_turns": 3}))
