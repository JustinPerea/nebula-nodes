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
# PR #200 fix round 13: review 12 M-1 (only the three real subdivision
# flags), L-2 (a ZWJ chain is one only as an RGI sequence), NIT-5 (a BOM at
# the ends), and GM r21 (one selector, valid for its base).
TAGS = lambda spec: "".join(chr(0xE0000 + ord(char)) for char in spec)
THUMB = "\U0001F44D"
named += [
    ["review 12 M-1: 280 flags of 7 ASCII tags", ("\U0001F3F4" + TAGS("ignorea") + "\U000E007F") * 280],
    ["a valid flag with an extra tag", "\U0001F3F4" + TAGS("gbengg") + "\U000E007F"],
    ["a truncated flag", "\U0001F3F4" + TAGS("gben") + "\U000E007F"],
    ["a valid flag spec with no cancel tag", "\U0001F3F4" + TAGS("gbeng")],
    ["Scotland and Wales", "\U0001F3F4" + TAGS("gbsct") + "\U000E007F" + "\U0001F3F4" + TAGS("gbwls") + "\U000E007F"],
    ["review 12 L-2: 11 thumbs joined", "‍".join([THUMB] * 11)],
    ["review 12 L-2: 140 chains of 11 thumbs", ("‍".join([THUMB] * 11) + " ") * 140],
    ["a kiss", "\U0001F469‍❤️‍\U0001F48B‍\U0001F468"],
    ["a family then a thumb, joined", FAMILY + "‍" + THUMB],
    ["two RGI sequences joined", "\U0001F469\U0001F3FD‍\U0001F52C‍\U0001F469\U0001F3FD‍\U0001F52C"],
    ["a handshake with two skin tones", "\U0001FAF1\U0001F3FB‍\U0001FAF2\U0001F3FC"],
    ["a rainbow flag", "\U0001F3F3️‍\U0001F308"],
    ["GM r21: 葛 and an ideographic selector", "葛\U000E0100"],
    ["GM r21: 葛 and 20 ideographic selectors", "葛" + "\U000E0100" * 20],
    ["GM r21: a Latin letter and an ideographic selector", "a\U000E0100"],
    ["GM r21: a Mongolian letter and FVS1", "ᠠ᠋"],
    ["GM r21: a Latin letter and FVS1", "a᠋"],
    ["an extension-B ideograph and a selector", "\U00020000\U000E0101"],
    ["a CJK compatibility variant (FE00 listed)", "\u2229\ufe00"],
    ["FE00 after a letter it isn't listed for", "a\ufe00"],
    ["FE0F after an emoji with no text form", "\U0001F600\ufe0f"],
    ["a BOM at the start and end", "\ufeff note \ufeff"],
]
rng = random.Random(20261028)
alphabet = (list("ab xy\n\t\r") + ["́", "︎", "️", "︀", "͏", "᠋", "឴", "‍", "​",
            "‮", "\U0001F468", "\U0001F469", "\U0001F3FD", "\U0001F3F4", "\U000E0067", "\U000E0062", "\U000E007F",
            "\U000E0100", "♥", "❤", "1", "#", "葛", "ᠠ", "ᄀ", "ᅡ", "ᆨ", "가",
            "\U0001F1EB", "\U0001F1F7", "\x1b[31m", "\x1b]0;t\x07", "\x00", "\x85", " ", "　", " "])
fuzz = [["fuzz %d" % i, "".join(rng.choice(alphabet) for _ in range(rng.randint(1, 24)))] for i in range(400)]
rng13 = random.Random(20261029)
alphabet13 = alphabet + [THUMB, "‍", "\U0001F52C", "\U0001F308", "\U0001F3F3", "\U0001F3FB", "\U000E0073", "\U000E0065",
                         "\U000E006E", "\U000E0063", "\U000E0074", "\U000E0101", "\U00020000", "∩", "︀", "᠌", "ᠡ", "\ufeff", "\U0001F600"]
fuzz += [["fuzz r13 %d" % i, "".join(rng13.choice(alphabet13) for _ in range(rng13.randint(1, 32)))] for i in range(400)]
cases = []
for name, typed in named + fuzz:
    note = shown_text(typed, multiline=True)
    reply = shown_text(typed, multiline=False)
    cases.append({"name": name, "typed": typed, "note": note, "noteLength": text_length(note), "reply": reply, "replyLength": text_length(reply)})
json.dump({"about": "PR #200 fix rounds 12 and 13 (review 11, GM r19; review 12, GM r21): pin text as every output shows it and as it counts. Both strips (services/canvas_pins.py, frontend lib/canvasPins.ts) must give these. Generated once from the backend, seeded; a changed rule regenerates it on purpose.", "cases": cases},
          open('tests/fixtures/pin_text_cases.json', 'w'), ensure_ascii=True, indent=1)
print(len(cases))
