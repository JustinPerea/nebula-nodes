"""``python -m extraction``: measure an image into a folder of records, list them, show one."""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Sequence

from extraction import record as rec
from extraction import store
from extraction.errors import ExtractionRefused
from extraction.intake import IMAGE_CAP, intake, rendering_png


def _line(record: dict[str, Any]) -> str:
    row = store.summary(record)
    accents = f"{row['accents']} accent" + ("" if row["accents"] == 1 else "s")
    text = f"{row['id']}  {row['width']}x{row['height']}  {row['colors']} colours, {accents}  {record['status']}"
    if row["corrections"]:
        text += f"  {row['corrections']} corrections"
    return text


def _read_image(path: str) -> tuple[bytes, str]:
    real = os.path.realpath(os.path.expanduser(path))
    if not os.path.isfile(real):
        raise ExtractionRefused("That image file doesn't exist.")
    try:
        with open(real, "rb") as handle:
            return handle.read(IMAGE_CAP + 1), real
    except OSError:
        raise ExtractionRefused("That image file couldn't be read.") from None


def _measure(args: argparse.Namespace) -> int:
    data, real = _read_image(args.image)
    item = intake(data, name=os.path.basename(real), kind="file", path=real)
    record = rec.build_record(item)
    saved = store.save(record, rendering_png(item.image), item.data, item.ext, args.out, replace=args.replace)
    if args.json:
        print(json.dumps(saved, indent=2, ensure_ascii=False))
    else:
        note = "already there, kept" if saved["existed"] and not args.replace else ("replaced" if saved["existed"] else "saved")
        print(f"{_line(saved['record'])}\n{note}: {saved['dir']}")
    return 0


def _list(args: argparse.Namespace) -> int:
    rows = store.list_records(args.folder)
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0
    if not rows:
        print("No records in that folder.")
    for row in rows:
        if "error" in row:
            print(f"{row['id']}  can't be read: {row['error']}")
        else:
            print(f"{row['id']}  {row['width']}x{row['height']}  {row['name'] or '(unnamed)'}  {row['status']}")
    return 0


def _show(args: argparse.Namespace) -> int:
    record = store.load(args.record)
    shown = rec.effective(record) if args.effective else record
    if args.json:
        print(json.dumps(shown, indent=2, ensure_ascii=False))
        return 0
    print(_line(shown))
    source = shown["source"]
    print(f"source: {source['kind']} {source['name'] or '(unnamed)'}")
    print("palette: " + "  ".join(f"P{p['index']} {p['hex']} {p['share']:.0%}{'*' if p['is_accent'] else ''}"
                                  for p in shown["structure"]["measured"]["palette"]))
    return 0


def _serve(args: argparse.Namespace) -> int:
    from extraction.server import serve

    return serve(port=args.port, dev=args.dev)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m extraction", description="Measure images into records.")
    sub = parser.add_subparsers(dest="command", required=True)
    measure = sub.add_parser("measure", help="measure an image and save its record")
    measure.add_argument("image")
    measure.add_argument("--out", required=True, help="an existing folder to keep the record in")
    measure.add_argument("--replace", action="store_true", help="measure again, keeping corrections")
    measure.add_argument("--json", action="store_true")
    measure.set_defaults(run=_measure)
    listing = sub.add_parser("list", help="list the records in a folder")
    listing.add_argument("folder")
    listing.add_argument("--json", action="store_true")
    listing.set_defaults(run=_list)
    show = sub.add_parser("show", help="show one record")
    show.add_argument("record", help="a record folder or its record.json")
    show.add_argument("--json", action="store_true")
    show.add_argument("--effective", action="store_true", help="with corrections applied")
    show.set_defaults(run=_show)
    serve = sub.add_parser("serve", help="run the local page's server on 127.0.0.1")
    serve.add_argument("--port", type=int, default=8870, help="the port to listen on (default 8870)")
    serve.add_argument("--dev", action="store_true",
                       help="the page comes from the Vite dev server on 5870, which proxies /api here")
    serve.set_defaults(run=_serve)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.run(args)
    except (ExtractionRefused, rec.RecordInvalid) as exc:
        print(f"extraction: {exc}", file=sys.stderr)
        return 2
