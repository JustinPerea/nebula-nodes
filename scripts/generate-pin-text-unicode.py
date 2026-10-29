"""Generates the Unicode data the pin-text strip and count read (PR #200 fix
round 13: review 12 M-1 and L-2, GM r21). One run writes the same bytes to
both sides, so the backend (services/canvas_pins.py) and the canvas
(frontend lib/canvasPins.ts) read the same data:

  backend/data/pin_text_unicode.json
  frontend/src/lib/pinTextUnicode.json

It is data, not a package. Download the Unicode files into an empty folder
first (from https://www.unicode.org/Public/):

  emoji/latest/emoji-zwj-sequences.txt
  emoji/latest/emoji-sequences.txt
  UCD/latest/ucd/emoji/emoji-variation-sequences.txt
  UCD/latest/ucd/StandardizedVariants.txt
  UCD/latest/ucd/PropList.txt
  UCD/latest/ucd/Scripts.txt

then run, from the repo root:

  python3 -I scripts/generate-pin-text-unicode.py <that folder>
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUTS = (ROOT / "backend/data/pin_text_unicode.json", ROOT / "frontend/src/lib/pinTextUnicode.json")
SELECTORS_DROPPED_FROM_KEYS = {0xFE0E, 0xFE0F}
SKIN_TONES = range(0x1F3FB, 0x1F400)


def rows(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            yield [field.strip() for field in line.split(";")]


def header(path: Path, key: str) -> str:
    for line in path.read_text(encoding="utf-8").splitlines()[:40]:
        match = re.match(rf"#\s*{key}:\s*(.+)", line)
        if match:
            return match.group(1).strip()
    return ""


def file_version(path: Path) -> str:
    """The emoji files say "Version: 18.0"; the UCD files name it, "# PropList-18.0.0.txt"."""
    version = header(path, "Version")
    if version:
        return version
    first = path.read_text(encoding="utf-8").splitlines()[0]
    match = re.search(r"-(\d[\d.]*\d)\.txt", first)
    return match.group(1) if match else ""


def span(field: str) -> tuple[int, int]:
    low, _, high = field.partition("..")
    return int(low, 16), int(high or low, 16)


def ranges(codes: set[int]) -> list[list[int]]:
    out: list[list[int]] = []
    for code in sorted(codes):
        if out and out[-1][1] == code - 1:
            out[-1][1] = code
        else:
            out.append([code, code])
    return out


def main(source: Path) -> None:
    files = {name: source / name for name in (
        "emoji-zwj-sequences.txt", "emoji-sequences.txt", "emoji-variation-sequences.txt",
        "StandardizedVariants.txt", "PropList.txt", "Scripts.txt")}

    # GM r21: E0100-E01EF only after a CJK unified ideograph (every extension block).
    cjk: set[int] = set()
    for fields in rows(files["PropList.txt"]):
        if fields[1] == "Unified_Ideograph":
            low, high = span(fields[0])
            cjk.update(range(low, high + 1))

    # GM r21: 180B-180F only after a Mongolian letter (script Mongolian, a letter category).
    mongolian: set[int] = set()
    for line in files["Scripts.txt"].read_text(encoding="utf-8").splitlines():
        match = re.match(r"([0-9A-F.]+)\s*;\s*Mongolian\s*#\s*(L[a-z])", line)
        if match:
            low, high = span(match.group(1))
            mongolian.update(range(low, high + 1))

    # GM r21: FE00-FE0F only after a base listed for that selector, in
    # StandardizedVariants.txt or emoji-variation-sequences.txt.
    pairs: dict[int, set[int]] = {}
    for name in ("StandardizedVariants.txt", "emoji-variation-sequences.txt"):
        for fields in rows(files[name]):
            base, selector = (int(part, 16) for part in fields[0].split())
            if 0xFE00 <= selector <= 0xFE0F:
                pairs.setdefault(selector, set()).add(base)

    # Review 12 L-2, GM r21: a ZWJ chain is one character only when it is an
    # RGI ZWJ sequence. Keys leave out FE0E/FE0F and the skin tones, so every
    # tone of a sequence is one key (a chain matches whatever tones it has).
    zwj: set[str] = set()
    longest = 0
    for fields in rows(files["emoji-zwj-sequences.txt"]):
        if fields[1] != "RGI_Emoji_ZWJ_Sequence":
            continue
        parts = []
        for component in " ".join(fields[0].split()).split(" 200D "):
            codes = [int(part, 16) for part in component.split()]
            parts.append(" ".join("%X" % code for code in codes
                                  if code not in SELECTORS_DROPPED_FROM_KEYS and code not in SKIN_TONES))
        zwj.add("|".join(parts))
        longest = max(longest, len(parts))

    # Review 12 M-1, GM r21: a tag run is kept only when it spells an RGI
    # subdivision flag after U+1F3F4 (England, Scotland, Wales).
    flags: set[str] = set()
    for fields in rows(files["emoji-sequences.txt"]):
        if fields[1] == "RGI_Emoji_Tag_Sequence":
            codes = [int(part, 16) for part in fields[0].split()]
            assert codes[0] == 0x1F3F4 and codes[-1] == 0xE007F, fields
            flags.add("".join(chr(code - 0xE0000) for code in codes[1:-1]))

    data = {
        "about": "Generated by scripts/generate-pin-text-unicode.py from the Unicode data files named in sources; "
                 "the same bytes on both sides (backend data/pin_text_unicode.json, frontend src/lib/pinTextUnicode.json). "
                 "Do not edit by hand.",
        "sources": {name: {"version": file_version(path),
                           "date": header(path, "Date")} for name, path in sorted(files.items())},
        "cjkUnified": ranges(cjk),
        "mongolianLetters": ranges(mongolian),
        "variationBases": {"%X" % selector: ranges(bases) for selector, bases in sorted(pairs.items())},
        "rgiZwjLongest": longest,
        "rgiZwj": sorted(zwj),
        "tagFlags": sorted(flags),
    }
    text = json.dumps(data, ensure_ascii=True, separators=(",", ":"), sort_keys=False) + "\n"
    for path in OUTPUTS:
        path.write_text(text, encoding="utf-8")
    print(f"{len(text):,} bytes; {len(zwj)} ZWJ keys (longest {longest}); flags {sorted(flags)}; "
          f"{sum(len(b) for b in pairs.values())} variation pairs; {len(cjk):,} CJK; {len(mongolian)} Mongolian")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
