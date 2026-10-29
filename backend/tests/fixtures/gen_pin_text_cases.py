"""Regenerates tests/fixtures/pin_text_cases.json from the backend strip and
count (PR #200 fix round 12). Run from backend/ only when a rule changes on
purpose: .venv/bin/python tests/fixtures/gen_pin_text_cases.py"""
import json
import random
import sys

sys.path.insert(0, ".")
from services.canvas_pins import shown_text, text_length
FAMILY = "\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466"
ENGLAND = "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F"
named = [
    ["family emoji", FAMILY],
    ["England flag", ENGLAND],
    ["text and emoji hearts", "♥︎♥️"],
    ["a scientist with a skin tone", "\U0001F469\U0001F3FD‍\U0001F52C"],
    ["a keycap", "1️⃣"],
    ["a second selector", "❤️️"],
    ["a selector after a letter", "a️"],
    ["an ideographic selector", "葛\U000E0100"],
    ["a Mongolian selector", "ᠠ᠋"],
    ["the grapheme joiner", "a͏b"],
    ["a ZWJ between letters", "a‍b"],
    ["a trailing ZWJ", "\U0001F44D‍"],
    ["tags without the black flag", "a\U000E0067\U000E007F"],
    ["a black flag with too many tags", "\U0001F3F4" + "\U000E0061" * 8 + "\U000E007F"],
    ["a black flag with no cancel tag", "\U0001F3F4\U000E0067\U000E0062"],
    ["32 selectors on a letter", "a" + "".join(chr(0xE0100 + i) for i in range(32))],
    ["whitespace at the ends", "  \n hi there \n\n  "],
    ["blank lines inside", "one\n\n\n   \ntwo"],
    ["only whitespace", " \n\t \n "],
    ["a mark after a line break", "a\ńb"],
    ["Hangul jamo", "각가"],
    ["a Hangul syllable and a final", "각"],
    ["a flag", "\U0001F1EB\U0001F1F7"],
]
rng = random.Random(20261028)
alphabet = (list("ab xy\n\t\r") + ["́", "︎", "️", "︀", "͏", "᠋", "឴", "‍", "​",
            "‮", "\U0001F468", "\U0001F469", "\U0001F3FD", "\U0001F3F4", "\U000E0067", "\U000E0062", "\U000E007F",
            "\U000E0100", "♥", "❤", "1", "#", "葛", "ᠠ", "ᄀ", "ᅡ", "ᆨ", "가",
            "\U0001F1EB", "\U0001F1F7", "\x1b[31m", "\x1b]0;t\x07", "\x00", "\x85", " ", "　", " "])
fuzz = [["fuzz %d" % i, "".join(rng.choice(alphabet) for _ in range(rng.randint(1, 24)))] for i in range(400)]
cases = []
for name, typed in named + fuzz:
    note = shown_text(typed, multiline=True)
    reply = shown_text(typed, multiline=False)
    cases.append({"name": name, "typed": typed, "note": note, "noteLength": text_length(note), "reply": reply, "replyLength": text_length(reply)})
json.dump({"about": "PR #200 fix round 12 (review 11, GM r19): pin text as every output shows it and as it counts. Both strips (services/canvas_pins.py, frontend lib/canvasPins.ts) must give these. Generated once from the backend, seeded; a changed rule regenerates it on purpose.", "cases": cases},
          open('tests/fixtures/pin_text_cases.json', 'w'), ensure_ascii=True, indent=1)
print(len(cases))
