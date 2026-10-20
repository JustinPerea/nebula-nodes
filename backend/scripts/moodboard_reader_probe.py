#!/usr/bin/env python3
"""The one real Argon probe for the moodboard reader (PR4; plan section 5.6.1).

PAID: it sends one batch of up to 6 references to Google twice. Run it only
after Justin approves the spend; it refuses without --yes-spend, and prints
the estimate first.

It measures what the plan leaves unconfirmed:

- whether any bytes arrive while Argon thinks with summaries off (the time of
  every SSE chunk, and the first-byte time);
- the time to the first finished item at the level asked;
- ``thoughtsTokenCount`` for the batch, to set the thinking allowance;
- in a second request with ``includeThoughts: true``, whether thought
  summaries come back alongside the response schema on image batches, and
  what they add to the output tokens (Q29 c sets Argon's ``thoughtSummaries``
  from this; above 10% more output, raise it with Justin first).

Whether an aborted stream is billed is not probed (it would need a third
paid request and Google's billing export).

    cd backend
    .venv/bin/python scripts/moodboard_reader_probe.py --board <id> --only 1-6 --level medium --yes-spend
    .venv/bin/python scripts/moodboard_reader_probe.py ref1.jpg ref2.png --level high --yes-spend

The key comes from GOOGLE_API_KEY in the environment, else Nebula's settings.
The report is JSON on stdout; nothing is saved to the board.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import moodboard_reader as reader  # noqa: E402
from services.moodboard_reader_stream import GeminiStreamParser  # noqa: E402


def _numbers(spec: str, count: int) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return [n for n in out if 1 <= n <= count]


def _targets(args: argparse.Namespace) -> tuple[dict[str, Any], list[reader.Target]]:
    if args.board:
        from services.moodboard_store import MoodboardStore

        board = MoodboardStore().get(args.board, laid_out=False)
        if board is None:
            sys.exit(f"No board {args.board}")
        images = board.get("images") or []
        wanted = _numbers(args.only, len(images)) if args.only else list(range(1, len(images) + 1))
        ids = [images[n - 1]["id"] for n in wanted[: reader.BATCH_SIZE]]
        return board, reader.select_targets(board, ids)
    files = [Path(p).expanduser().resolve() for p in args.files[: reader.BATCH_SIZE]]
    board = {"id": "probe", "images": [{"id": f"file{i}", "url": str(p), "notes": ""} for i, p in enumerate(files)],
             "frames": [], "sendNotes": False}
    return board, [reader.Target(i, image, files[i]) for i, image in enumerate(board["images"])]


class _TimedParser(GeminiStreamParser):
    def __init__(self, start: float, **kwargs: Any) -> None:
        self.start = start
        self.chunk_times: list[float] = []
        self.thought_chars = 0
        self.thought_parts = 0
        self.first_item: float | None = None
        self.items = 0

        def on_item(item: Any) -> None:
            self.items += 1
            if self.first_item is None:
                self.first_item = round(time.monotonic() - start, 3)

        def on_thought(text: str) -> None:
            self.thought_parts += 1
            self.thought_chars += len(text)

        super().__init__(items_key="readings", on_item=on_item, on_thought=on_thought, **kwargs)

    def feed_bytes(self, chunk: bytes) -> None:
        self.chunk_times.append(round(time.monotonic() - self.start, 3))
        super().feed_bytes(chunk)


async def _one(entry: dict[str, Any], key: str, board: dict, targets: list[reader.Target], level: str,
               thoughts: bool) -> dict[str, Any]:
    labels = reader.LABELS[: len(targets)]
    images = [reader.encode_image(t.path) for t in targets]  # type: ignore[arg-type]
    probe_entry = {**entry, "thoughtSummaries": True if thoughts else False}
    body = reader.gemini_body(probe_entry, parts=reader.phase1_parts(board, targets, images),
                              schema=reader.phase1_schema(labels), level=level,
                              max_output_tokens=reader.batch_cap(entry, level, len(targets)))
    transport = reader.GeminiTransport(entry, key)
    start = time.monotonic()
    parser = _TimedParser(start)
    error = None
    try:
        await transport.send(body, parser, reader.TimeBounds(600, 600, 900))  # wide: this measures the bounds
    except reader.ReaderRequestError as exc:
        error = f"{exc.text} {exc.detail}".strip()
    outcome = parser.close()
    return {
        "level": level, "includeThoughts": thoughts, "images": len(targets),
        "maxOutputTokens": body["generationConfig"]["maxOutputTokens"],
        "firstByteSeconds": parser.chunk_times[0] if parser.chunk_times else None,
        "firstItemSeconds": parser.first_item, "totalSeconds": round(time.monotonic() - start, 3),
        "chunkTimes": parser.chunk_times, "items": parser.items, "validJson": outcome.value is not None,
        "thoughtParts": parser.thought_parts, "thoughtChars": parser.thought_chars,
        "finishReason": outcome.finish_reason, "usage": outcome.usage, "error": error,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", help="Up to 6 image files (or use --board)")
    parser.add_argument("--board", help="A board id from `nebula moodboard list`")
    parser.add_argument("--only", help="Image numbers on the board, e.g. 1-6 or 2,5,9 (first 6 used)")
    parser.add_argument("--model", default="gemini-4-argon")
    parser.add_argument("--level", default=None, help="low, medium or high (default: the model's own)")
    parser.add_argument("--no-thoughts-request", action="store_true", help="Skip the includeThoughts request")
    parser.add_argument("--yes-spend", action="store_true", help="Confirm the spend was approved")
    args = parser.parse_args()
    if not args.board and not args.files:
        sys.exit("Name a board (--board) or up to 6 image files.")
    entry = reader.reader_entry(args.model)
    level = reader.thinking_level(entry, args.level)
    board, targets = _targets(args)
    one = reader.estimate(board, entry, level=level, targets=targets)
    requests = 1 if args.no_thoughts_request else 2
    if one["perBatch"] and not one["unpriced"]:
        batch = one["perBatch"][0]
        row = one["price"]["high"]
        input_usd = batch["inputTokens"][1] * float(row["inputPerMTok"]) / 1e6
        print(f"{len(targets)} images at {level}, {requests} request(s): at most "
              f"${one['shares']['batch:1'] * requests:.3f} (each output capped at {batch['maxOutputTokens']} tokens, "
              f"thinking included; no retries). Input alone is about ${input_usd * requests:.3f}; the rest is "
              "whatever output and thinking Argon actually uses.", file=sys.stderr)
    if not args.yes_spend:
        sys.exit("This calls Google and is paid. Run it again with --yes-spend once the spend is approved.")
    key = os.environ.get("GOOGLE_API_KEY")
    if not key:
        from services.settings import load_settings

        key = (load_settings().get("apiKeys") or {}).get(entry["keyName"])
    if not key:
        sys.exit(f"{entry['keyName']} isn't set.")

    async def run() -> list[dict[str, Any]]:
        report = [await _one(entry, key, board, targets, level, thoughts=False)]
        if not args.no_thoughts_request:
            report.append(await _one(entry, key, board, targets, level, thoughts=True))
        return report

    report = asyncio.run(run())
    if len(report) == 2:
        off, on = (r["usage"] or {} for r in report)
        out_off = (off.get("candidatesTokenCount") or 0) + (off.get("thoughtsTokenCount") or 0)
        out_on = (on.get("candidatesTokenCount") or 0) + (on.get("thoughtsTokenCount") or 0)
        summary = {"summariesCameBack": report[1]["thoughtParts"] > 0, "schemaHeldWithSummaries": report[1]["validJson"],
                   "extraOutputTokens": out_on - out_off,
                   "extraOutputShare": round((out_on - out_off) / out_off, 3) if out_off else None}
        report.append({"comparison": summary})
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
