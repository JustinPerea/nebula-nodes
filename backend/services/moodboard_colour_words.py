"""The colour-word check: measured colours against a board's own words
(design-canvas gap 18, Justin's P2).

A board's Direction and Avoid list are the person's words; its palette and
accents are what Nebula measured. When the words rule a measured colour out,
the brief shouldn't ask a generator for it. This check finds those clashes.
It is deterministic and free and always runs. A later check (a text-only
model for style words this lexicon can't resolve) can add findings of its
own: every finding records ``foundBy``, and services/moodboard_brief.py
merges findings from any check.

How it works (research note: Obsidian vault,
Research/topics/colour-text-contradiction-detection-2026-10.md):

1. **Parse first.** Each Direction sentence and each Avoid item is split
   into clauses (``. ; ! ?`` and line breaks); a colon splits a clause into
   a head and a list. Colour terms are whole words (case-insensitive, a
   plural ``-s``/``-es`` dropped; ``blue-grey`` is a hue plus a grey). Each
   term takes the modifiers just before it and a scope: *object* (a noun
   follows it or the comma/and/or list it's in; a list item after a colon
   with no noun takes the head's), *cast* (cast, tint, varnish, wash, glaze,
   toning) or *global* (palette words, style words such as tonalist, or the
   term standing alone). Every Avoid term is an exclusion; in the Direction a
   term after no / not / without / never / avoid / minus is one too, up to
   the end of the noun phrase it governs (a comma, "and" or "&" after its
   noun, "but", or the clause's end), and never an allowance. Every other
   Direction term is an allowance: it protects colours, never removes them. A hex in
   the text matches colours within dE00 5. Unknown words are ignored.
2. **Match in OKLCH** (Ottosson's OKLab) by hue arcs and chroma gates, not by
   colour distance: CIEDE2000 is only valid for small differences, so it is
   used only to pair a colour with a hex written in the text.
3. **Scope decides the test.** Object and global exclusions test each
   colour. A cast is a tint over the whole image, so a cast exclusion tests
   the share-weighted mean of the board's colours. A Direction's global
   style words set a chroma ceiling (silver: C < 0.04; tonalist: C < 0.08):
   a large colour over it conflicts; a small one is exempt when an object
   allowance in the Direction covers it, a warning when it's only in an
   allowance's hue arc. An exclusion is softened to a warning only by an
   allowance that names the colour (``cover``), never by a hue arc alone or
   a temperature word.

Results have two levels: ``conflict`` (the words rule the colour out) and
``warning`` (it may clash; the Direction allows that hue, or it's muted).

Every number below is our own first value: no published OKLCH colour-name
boundaries exist, and the naming datasets (Lindner's Colour Thesaurus is
CC BY-NC-SA; XKCD, StanfordHCI c3 and LUX have no confirmed licence) are not
used. The arcs and gates are hand-defined. Retune them against boards GM
labels, and bump LEXICON_VERSION, which refreshes every saved check.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

# Bumped whenever the table or the rules change: it is part of each saved
# check's basis, so every board's check runs again.
LEXICON_VERSION = 2
FOUND_BY = "words"

# -- the one table ------------------------------------------------------------
# Starting values from the research note; tune here and nowhere else.

HUE_FLOOR = 0.03            # below this chroma a colour is near-neutral: only neutral terms or a hex match it
CONFLICT_CHROMA = 0.08      # an excluded hue at or above this is a conflict; HUE_FLOOR up to it, a warning
LARGE_SHARE = 0.10          # a palette colour covering this much of the board is large
CAST_MEAN_CHROMA = 0.015    # the board's mean colour leans toward a cast from here
CAST_COLOUR_CHROMA = 0.04   # with the cast confirmed, colours from here in its arc conflict
CAST_WARNING_CHROMA = 0.08  # without it, colours from here in its arc are a warning
REFERENCE_HEADROOM = 0.04   # an allowance with a reference colour covers up to its chroma plus this
HEX_DELTA_E = 5.0           # a hex in the text matches colours this close (dE00, Commons' "same colour")
NEUTRAL_CEILING = 0.04      # silver, grey, monochrome
MUTED_CEILING = 0.08        # tonalist, muted, desaturated, subdued, faded


@dataclass(frozen=True)
class Gate:
    """Where a colour term sits in OKLCH: a hue arc (degrees, may wrap past
    360) and bounds on lightness L and chroma C. None is no bound."""
    arc: tuple[float, float] | None = None
    lmin: float | None = None
    lmax: float | None = None
    cmin: float | None = None
    cmax: float | None = None

    def __and__(self, other: "Gate") -> "Gate":
        return Gate(
            arc=other.arc or self.arc,
            lmin=_max(self.lmin, other.lmin), lmax=_min(self.lmax, other.lmax),
            cmin=_max(self.cmin, other.cmin), cmax=_min(self.cmax, other.cmax),
        )


def _g(arc=None, **bounds: float) -> Gate:
    return Gate(arc=arc, **bounds)


_RED, _PINK, _ORANGE = _g((350, 35), lmax=0.80), _g((340, 35), lmin=0.65), _g((35, 70))
_AMBER, _BLUE, _VIOLET = _g((70, 100)), _g((230, 270)), _g((270, 320))
_TEAL, _LILAC, _MAGENTA = _g((165, 230)), _g((280, 340), lmin=0.70, cmax=0.12), _g((320, 350), cmin=0.12)
_CREAM = _g((70, 110), lmin=0.88, cmin=0.02, cmax=0.06)

HUES: dict[str, Gate] = {
    "red": _RED, "crimson": _RED, "scarlet": _RED,
    "pink": _PINK, "salmon": _PINK, "rose-pink": _PINK,
    "orange": _ORANGE, "rust": _ORANGE, "terracotta": _ORANGE,
    "brown": _g((20, 75), lmax=0.55, cmin=0.03, cmax=0.13),
    "amber": _AMBER, "gold": _AMBER, "ochre": _AMBER,
    "yellow": _g((70, 115), lmin=0.60),
    "olive": _g((95, 130), lmax=0.60),
    "green": _g((115, 165)),
    "sage": _g((115, 165), cmax=0.08),
    "teal": _TEAL, "cyan": _TEAL, "aqua": _TEAL,
    "blue": _BLUE, "azure": _BLUE, "navy": _g((230, 270), lmax=0.40),
    "violet": _VIOLET, "purple": _VIOLET,
    "lilac": _LILAC, "lavender": _LILAC,
    "magenta": _MAGENTA, "fuchsia": _MAGENTA,
    "cream": _CREAM, "ivory": _CREAM,
}
# Hue words that name a soft colour: their upper chroma bound is what the
# word means, so they conflict from HUE_FLOOR. Brown's bound only separates it
# from orange; it conflicts from CONFLICT_CHROMA like any hue, so a board's
# near-black shadows (C 0.03-0.04) are at most a warning under "brown".
SOFT_HUES = {"sage", "lilac", "lavender", "cream", "ivory"}
# Temperature words standing alone. As an allowance they name a side of the
# wheel, not a colour, so they never exempt one: only "in its arc".
TEMPERATURES: dict[str, Gate] = {"warm": _g((350, 110)), "cool": _g((165, 320))}
_GREY = _g(cmax=0.03, lmin=0.25, lmax=0.90)
NEUTRALS: dict[str, Gate] = {
    "white": _g(cmax=0.03, lmin=0.90), "black": _g(cmax=0.03, lmax=0.25),
    "grey": _GREY, "gray": _GREY, "silver": _g(cmax=0.03, lmin=0.65, lmax=0.90),
    "pearl": _g(lmin=0.85, cmax=0.04), "pearl-grey": _g(lmin=0.85, cmax=0.04), "pearl-gray": _g(lmin=0.85, cmax=0.04),
}
MODIFIERS: dict[str, Gate] = {
    "pale": _g(lmin=0.80, cmax=0.08), "light": _g(lmin=0.70), "dark": _g(lmax=0.45), "deep": _g(lmax=0.45),
    "muted": _g(cmax=0.08), "dusty": _g(cmax=0.08), "greyish": _g(cmax=0.08), "grayish": _g(cmax=0.08),
    "saturated": _g(cmin=0.12), "vivid": _g(cmin=0.12), "bright": _g(cmin=0.12), "neon": _g(cmin=0.12),
    "jewel": _g(cmin=0.12),
}
GREY_COMPOUND = _g(cmax=0.06)  # the hue in "blue-grey", "grey-green"
# warm / cool before a neutral set its side of the wheel ("warm grey").
NEUTRAL_SIDES: dict[str, Gate] = {"warm": _g((40, 110), cmin=0.01, cmax=0.04),
                                  "cool": _g((180, 280), cmin=0.01, cmax=0.04)}
# A modifier naming a reference colour (an allowance covers up to its chroma
# plus REFERENCE_HEADROOM). CSS cornflowerblue.
REFERENCES: dict[str, tuple[str, str]] = {"cornflower": ("blue", "#6495ed")}
# Style words that make a Direction clause a palette rule, with its ceiling.
# A clause with several takes the loosest: never leave out more than the
# words rule out.
STYLE_CEILINGS: dict[str, float] = {
    "tonalist": MUTED_CEILING, "muted": MUTED_CEILING, "desaturated": MUTED_CEILING,
    "subdued": MUTED_CEILING, "faded": MUTED_CEILING, "monochrome": NEUTRAL_CEILING,
}
NEUTRAL_STYLE_TERMS = {"silver": NEUTRAL_CEILING, "grey": NEUTRAL_CEILING, "gray": NEUTRAL_CEILING}
CAST_WORDS = {"cast", "tint", "varnish", "wash", "glaze", "toning"}
PALETTE_NOUNS = {"palette", "colors", "colours", "color", "colour", "tones", "tone", "hues", "hue", "scheme"}
NEGATORS = {"no", "not", "without", "never", "avoid", "minus"}
# Words that end a term's run without being its noun.
_STOP = {
    "a", "an", "the", "in", "on", "at", "of", "with", "for", "to", "from", "by", "into", "onto", "over", "under",
    "near", "against", "about", "than", "that", "this", "these", "those", "which", "while", "is", "are", "be",
    "as", "like", "only", "very", "more", "less", "some", "any", "all", "each", "its", "their", "our", "your",
    "ok", "okay", "fine", "please", "allowed", "but", "so", "then", "too", "also", "it", "they", "where",
    *NEGATORS,
}

_LEXICON = {*HUES, *TEMPERATURES, *NEUTRALS, *MODIFIERS, *REFERENCES, *STYLE_CEILINGS, *CAST_WORDS,
            *PALETTE_NOUNS}


# -- OKLab ----------------------------------------------------------------------

def _linear(channel: int) -> float:
    value = channel / 255
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def oklab(hex_value: str) -> tuple[float, float, float]:
    """OKLab (L, a, b) of a hex colour (Ottosson 2020)."""
    digits = str(hex_value).strip().lstrip("#")
    if len(digits) == 3:
        digits = "".join(ch * 2 for ch in digits)
    r, g, b = (_linear(int(digits[i:i + 2], 16)) for i in (0, 2, 4))
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def oklch(hex_value: str) -> tuple[float, float, float]:
    """OKLCH (L, C, h in degrees) of a hex colour."""
    lightness, a, b = oklab(hex_value)
    return lightness, math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360


# -- parsing -----------------------------------------------------------------------

_TOKEN = re.compile(
    r"(?P<hex>#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9A-Za-z]))"
    r"|(?P<word>[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*)"
    r"|(?P<join>[,&/])|(?P<colon>:)|(?P<brk>[.;!?\n]+)")


@dataclass
class _Item:
    """One word (or part of a hyphenated word) in a clause."""
    kind: str           # hue, neutral, temperature, hex, modifier, reference, style, cast, palette, negator,
    #                     but, join, stop, noun
    word: str           # the canonical word
    start: int
    end: int
    grey_compound: bool = False   # the hue of "blue-grey"
    partner: str = ""             # the hue a compound's grey belongs to


@dataclass
class Term:
    kind: str                     # hue, neutral, temperature, hex
    name: str
    gate: Gate
    exclusion: bool
    source: str                   # avoid or direction
    scope: str                    # object, cast or global
    noun: str | None
    phrase: str                   # the words naming it, as written
    clause: str                   # what a reason quotes
    hex: str | None = None
    reference: str | None = None  # a reference colour's hex
    chroma_gated: bool = False    # the words name a soft colour (an upper chroma bound)


@dataclass
class Ceiling:
    value: float
    phrase: str


@dataclass
class Rules:
    exclusions: list[Term] = field(default_factory=list)
    allowances: list[Term] = field(default_factory=list)
    ceilings: list[Ceiling] = field(default_factory=list)


def _canonical(word: str) -> str | None:
    """The lexicon word for a written word: lower case, without a possessive
    or a plural -s / -es; None when it isn't one."""
    lower = word.lower().replace("’", "'")
    if lower.endswith("'s"):
        lower = lower[:-2]
    for candidate in (lower, lower[:-2] if lower.endswith("es") else None, lower[:-1] if lower.endswith("s") else None):
        if candidate and candidate in _LEXICON:
            return candidate
    return None


def _kind(canonical: str) -> str:
    if canonical in HUES:
        return "hue"
    if canonical in NEUTRALS:
        return "neutral"
    if canonical in TEMPERATURES:
        return "temperature"
    if canonical in REFERENCES:
        return "reference"
    if canonical in MODIFIERS:
        return "modifier"
    if canonical in STYLE_CEILINGS:
        return "style"
    if canonical in CAST_WORDS:
        return "cast"
    return "palette"


def _items(text: str, start: int, end: int, matches: list[re.Match[str]]) -> list[_Item]:
    items: list[_Item] = []
    for match in matches:
        if match.start() < start or match.end() > end:
            continue
        s, e = match.start(), match.end()
        if match.group("hex"):
            items.append(_Item("hex", match.group("hex").lower(), s, e))
            continue
        if match.group("join"):
            items.append(_Item("join", match.group("join"), s, e))
            continue
        word = match.group("word")
        if not word:
            continue
        whole = _canonical(word)
        if whole is not None:
            parts = [whole]
        elif "-" in word:
            parts = [_canonical(part) or part.lower() for part in word.split("-")]
        else:
            parts = [word.lower()]
        known = [part for part in parts if part in _LEXICON]
        hues = [part for part in known if _kind(part) == "hue"]
        greys = [part for part in known if part in ("grey", "gray")]
        for part in parts:
            if part in _LEXICON:
                kind = _kind(part)
                items.append(_Item(kind, part, s, e, grey_compound=kind == "hue" and bool(greys) and len(parts) > 1,
                                   partner=hues[0] if part in ("grey", "gray") and hues and len(parts) > 1 else ""))
            elif part in NEGATORS:
                items.append(_Item("negator", part, s, e))
            elif part == "but":
                items.append(_Item("but", part, s, e))
            elif part in ("and", "or"):
                items.append(_Item("join", part, s, e))
            elif part in _STOP:
                items.append(_Item("stop", part, s, e))
            else:
                items.append(_Item("noun", part, s, e))
    return items


_COLOUR = {"hue", "neutral", "hex"}
_ADJ = {"modifier", "reference", "temperature", "style"}


def _next_colour(items: list[_Item], index: int) -> int | None:
    """The index of the colour term the adjectives from ``index`` lead to."""
    k = index
    while k < len(items) and items[k].kind in _ADJ:
        k += 1
    if k < len(items) and items[k].kind in _COLOUR:
        return k
    return None


def _run(items: list[_Item], index: int) -> tuple[str | None, int, bool, bool]:
    """From the term at ``index``, walk right over its list to its noun.
    Returns (noun, last index of the run, saw a cast word, the noun is a palette word)."""
    k, last, cast = index + 1, index, False
    while k < len(items):
        item = items[k]
        if item.kind in _COLOUR or item.kind in _ADJ:
            last = k
            k += 1
        elif item.kind == "cast":
            cast, last = True, k
            k += 1
        elif item.kind == "join":
            j = k
            while j < len(items) and items[j].kind == "join":
                j += 1
            if j < len(items) and (items[j].kind in _COLOUR or items[j].kind in _ADJ):
                k = j
                continue
            break
        elif item.kind == "palette":
            return item.word, k, cast, True
        elif item.kind == "noun":
            return item.word, k, cast, False
        else:
            break
    return None, last, cast, False


def _head_context(items: list[_Item]) -> tuple[str, str | None]:
    """What a list after a colon inherits from its head: ("global", None)
    when the head is a palette rule, else ("object", its first noun), or
    ("none", None)."""
    if any(item.kind == "style" for item in items) or any(item.kind == "palette" for item in items[:1]):
        return "global", None
    for item in items:
        if item.kind == "palette":
            return "global", None
        if item.kind == "noun":
            return "object", item.word
    return "none", None


def _first_content(items: list[_Item]) -> _Item | None:
    for item in items:
        if item.kind in ("noun", "palette"):
            return item
    return None


def parse(direction: str, avoid: Iterable[str]) -> Rules:
    """The colour rules in a Direction and an Avoid list."""
    rules = Rules()
    for item_text in avoid or []:
        text = " ".join(str(item_text).split())
        if text:
            _parse_text(text, "avoid", rules, quote=text)
    if str(direction or "").strip():
        _parse_text(str(direction), "direction", rules, quote=None)
    return rules


def _parse_text(text: str, source: str, rules: Rules, *, quote: str | None) -> None:
    matches = list(_TOKEN.finditer(text))
    bounds: list[tuple[int, int]] = []
    start = 0
    for match in matches:
        if match.group("brk"):
            bounds.append((start, match.start()))
            start = match.end()
    bounds.append((start, len(text)))
    for clause_start, clause_end in bounds:
        colon = next((m for m in matches if m.group("colon") and clause_start <= m.start() < clause_end), None)
        if colon is None:
            segments = [(clause_start, clause_end, None)]
        else:
            segments = [(clause_start, colon.start(), None), (colon.end(), clause_end, "list")]
        negated = False
        head_items: list[_Item] = []
        for seg_start, seg_end, role in segments:
            items = _items(text, seg_start, seg_end, matches)
            inherited = _head_context(head_items) if role == "list" else ("none", None)
            negated = _segment(text, items, source, rules, quote=quote, negated=negated, inherited=inherited)
            if role is None:
                head_items = items


def _segment(text: str, items: list[_Item], source: str, rules: Rules, *, quote: str | None, negated: bool,
             inherited: tuple[str, str | None]) -> bool:
    """Read one head or list. Returns whether a negation is still open at its end."""
    negation_start: int | None = None if not negated else (items[0].start if items else None)
    negated_at: list[bool] = []
    # A negation governs one noun phrase: "no red or orange flowers" negates
    # both colours, "No people, red flowers" only the people. Once a noun has
    # followed the negator, the next comma, "and" or "&" closes it; "or" and
    # "/" carry it on ("no people or red flowers").
    noun_seen = False
    for item in items:
        if item.kind == "negator":
            negated, negation_start, noun_seen = True, item.start, False
        elif item.kind == "but":
            negated, negation_start, noun_seen = False, None, False
        elif negated and noun_seen and item.kind == "join" and item.word not in ("or", "/"):
            negated, negation_start, noun_seen = False, None, False
        elif negated and item.kind in ("noun", "palette"):
            noun_seen = True
        negated_at.append(negated)

    terms_here: list[tuple[int, Term]] = []
    for index, item in enumerate(items):
        if item.kind not in _COLOUR and item.kind not in ("temperature", "reference"):
            continue
        if item.kind in ("temperature", "reference") and _next_colour(items, index + 1) is not None:
            continue  # it modifies the colour after it
        term = _term(text, items, index, source=source, exclusion=source == "avoid" or negated_at[index],
                     quote=quote, inherited=inherited, negation_start=negation_start if negated_at[index] else None)
        if term is not None:
            terms_here.append((index, term))
            (rules.exclusions if term.exclusion else rules.allowances).append(term)

    if source == "direction":
        _ceiling(text, items, terms_here, negated_at, rules)
    return negated


def _term(text: str, items: list[_Item], index: int, *, source: str, exclusion: bool, quote: str | None,
          inherited: tuple[str, str | None], negation_start: int | None) -> Term | None:
    item = items[index]
    gate = Gate()
    chroma_gated = False
    reference: str | None = None
    kind = item.kind
    name = item.word
    if kind == "hex":
        gate = Gate()
    elif kind == "reference":
        name, reference = REFERENCES[item.word]
        kind, gate = "hue", HUES[name]
    elif kind == "hue":
        gate = HUES[name]
        chroma_gated = name in SOFT_HUES
    elif kind == "neutral":
        gate = NEUTRALS[name]
        if item.partner:  # the grey of "blue-grey": a grey on that hue's side
            gate = Gate(arc=HUES[item.partner].arc, cmin=0.01, cmax=NEUTRAL_CEILING, lmin=gate.lmin, lmax=gate.lmax)
    elif kind == "temperature":
        gate = TEMPERATURES[name]
    if item.grey_compound:
        gate, chroma_gated = gate & GREY_COMPOUND, True

    # The adjectives just before it.
    first = index
    k = index - 1
    while k >= 0 and items[k].kind in _ADJ:
        modifier = items[k]
        if modifier.kind == "modifier":
            gate = gate & MODIFIERS[modifier.word]
            chroma_gated = chroma_gated or MODIFIERS[modifier.word].cmax is not None
        elif modifier.kind == "style" and STYLE_CEILINGS[modifier.word] >= MUTED_CEILING:
            gate, chroma_gated = gate & Gate(cmax=MUTED_CEILING), True
        elif modifier.kind == "reference" and kind == "hue" and REFERENCES[modifier.word][0] == name:
            reference = REFERENCES[modifier.word][1]
        elif modifier.kind == "temperature" and kind == "neutral":
            side = NEUTRAL_SIDES[modifier.word]
            gate = Gate(arc=side.arc, lmin=gate.lmin, lmax=gate.lmax, cmin=side.cmin, cmax=side.cmax)
        first = k
        k -= 1

    noun, last, cast, palette = _run(items, index)
    if cast:
        scope = "cast"
    elif palette:
        scope = "global"
    elif noun:
        scope = "object"
    elif inherited[0] == "object":
        scope, noun = "object", inherited[1]
    elif any(it.kind == "cast" for it in items):
        scope = "cast"
    else:
        scope = "global"
    phrase_start = items[first].start if negation_start is None or source == "avoid" else negation_start
    phrase_end = items[last].end if (noun or cast or palette) and last > index else item.end
    phrase = " ".join(text[phrase_start:phrase_end].split()).strip(" ,&/")
    words = " ".join(text[items[first].start:item.end].split())
    return Term(kind=kind, name=name, gate=gate, exclusion=exclusion, source=source, scope=scope, noun=noun,
                phrase=words, clause=quote if quote is not None else phrase,
                hex=item.word if kind == "hex" else None, reference=reference, chroma_gated=chroma_gated)


def _ceiling(text: str, items: list[_Item], terms: list[tuple[int, Term]], negated_at: list[bool],
             rules: Rules) -> None:
    """A Direction palette rule: style words, and neutral words in a global
    scope, set how saturated any colour may be."""
    contributing: list[tuple[int, float]] = []
    by_index = dict(terms)
    for index, item in enumerate(items):
        if negated_at[index]:
            continue
        if item.kind == "style":
            target = _next_colour(items, index + 1)
            if target is not None and target in by_index and by_index[target].scope == "object":
                continue  # "muted red flowers": a modifier, not a palette rule
            contributing.append((index, STYLE_CEILINGS[item.word]))
        elif item.kind == "neutral" and item.word in NEUTRAL_STYLE_TERMS and index in by_index \
                and by_index[index].scope == "global" and not item.partner:
            contributing.append((index, NEUTRAL_STYLE_TERMS[item.word]))
    if not contributing:
        return
    first = min(index for index, _ in contributing)
    last = max(index for index, _ in contributing)
    k = last + 1
    while k < len(items) and items[k].kind in (*_ADJ, *_COLOUR, "join"):
        k += 1
    if k < len(items) and items[k].kind == "palette":
        last = k
    phrase = " ".join(text[items[first].start:items[last].end].split()).strip(" ,&/")
    rules.ceilings.append(Ceiling(value=max(value for _, value in contributing), phrase=phrase))


# -- matching -----------------------------------------------------------------------

@dataclass(frozen=True)
class _Colour:
    hex: str
    role: str
    share: float | None
    lightness: float
    chroma: float
    hue: float

    @property
    def large(self) -> bool:
        return self.role == "palette" and self.share is not None and self.share >= LARGE_SHARE


def _in_arc(hue: float, arc: tuple[float, float] | None) -> bool:
    if arc is None:
        return True
    low, high = arc
    return low <= hue <= high if low <= high else (hue >= low or hue <= high)


def _lightness_ok(colour: _Colour, gate: Gate) -> bool:
    return ((gate.lmin is None or colour.lightness >= gate.lmin)
            and (gate.lmax is None or colour.lightness < gate.lmax))


def _hue_floor(gate: Gate) -> float:
    return min(HUE_FLOOR, gate.cmin) if gate.cmin is not None else HUE_FLOOR


def _hex_close(colour: _Colour, hex_value: str) -> bool:
    from commons.colour import delta_e00, hex_to_lab

    return float(delta_e00(hex_to_lab(colour.hex), hex_to_lab(hex_value))) < HEX_DELTA_E


def _exclusion_level(term: Term, colour: _Colour) -> str | None:
    if term.kind == "hex":
        return "conflict" if _hex_close(colour, term.hex or "") else None
    gate = term.gate
    if term.kind == "neutral":
        if not _in_arc(colour.hue, gate.arc) and gate.arc is not None:
            return None
        inside = (_lightness_ok(colour, gate) and (gate.cmax is None or colour.chroma < gate.cmax)
                  and (gate.cmin is None or colour.chroma >= gate.cmin))
        return "conflict" if inside else None
    if colour.chroma < _hue_floor(gate) or not _in_arc(colour.hue, gate.arc) or not _lightness_ok(colour, gate):
        return None
    low = gate.cmin if gate.cmin is not None else HUE_FLOOR
    high = gate.cmax if gate.cmax is not None else math.inf
    floor = low if term.chroma_gated else max(CONFLICT_CHROMA, low)
    if low <= colour.chroma <= high and colour.chroma >= floor:
        return "conflict"
    if HUE_FLOOR <= colour.chroma < CONFLICT_CHROMA and colour.chroma <= high:
        return "warning"
    return None


def _allowance_hit(term: Term, colour: _Colour) -> str | None:
    """"cover" when the allowance names this colour (within its reference's
    headroom), "arc" when it's only in its hue arc, else None."""
    if term.kind == "hex":
        return "cover" if _hex_close(colour, term.hex or "") else None
    gate = term.gate
    if term.kind == "neutral":
        return "cover" if _exclusion_level(term, colour) else None
    if colour.chroma < _hue_floor(gate) or not _in_arc(colour.hue, gate.arc):
        return None
    if term.kind == "temperature":
        return "arc"
    within = (_lightness_ok(colour, gate) and (gate.cmin is None or colour.chroma >= gate.cmin)
              and (gate.cmax is None or colour.chroma <= gate.cmax))
    if term.reference is not None:
        within = within and colour.chroma <= oklch(term.reference)[1] + REFERENCE_HEADROOM
    return "cover" if within else "arc"


def _allows(term: Term) -> str:
    noun = f" for the {term.noun}" if term.scope == "object" and term.noun else ""
    return f"The Direction allows {term.phrase}{noun}"


def _best_allowance(hits: list[tuple[Term, str]]) -> Term:
    """The allowance a reason names: one with a reference colour, then an
    object one, then any."""
    return sorted(hits, key=lambda hit: (hit[0].reference is None, hit[0].scope != "object"))[0][0]


def _label(term: Term) -> str:
    return f"{'Avoid' if term.source == 'avoid' else 'Direction'}: {term.clause}"


def check(direction: str, avoid: Iterable[str], colours: Iterable[dict[str, Any]],
          pinned: Iterable[str] = ()) -> list[dict[str, Any]]:
    """Findings for each measured colour (``{"hex", "role": "palette" |
    "accent", "share"}``) and each pinned "must appear" colour against the
    Direction and Avoid list. One finding per colour, rule and clause:
    ``{hex, role, share, level, source, clause, rule, reason, foundBy}``; a
    whole-palette finding (a cast) has ``hex: None``."""
    rules = parse(direction, avoid)
    measured = [_colour(c.get("hex"), c.get("role") or "palette", c.get("share")) for c in colours or []]
    measured = [c for c in measured if c is not None]
    pinned_colours = [c for c in (_colour(hex_value, "pinned", None) for hex_value in pinned or []) if c is not None]
    every = [*measured, *pinned_colours]
    if not (rules.exclusions or rules.ceilings):
        return []
    findings: list[dict[str, Any]] = []

    def add(colour: _Colour | None, level: str, term_source: str, clause: str, rule: str, reason: str) -> None:
        findings.append({
            "hex": colour.hex if colour else None, "role": colour.role if colour else "palette",
            "share": colour.share if colour else None, "level": level, "source": term_source, "clause": clause,
            "rule": rule, "reason": reason, "foundBy": FOUND_BY,
        })

    def protecting(colour: _Colour) -> list[tuple[Term, str]]:
        return [(term, hit) for term in rules.allowances if (hit := _allowance_hit(term, colour))]

    def covering(colour: _Colour) -> list[tuple[Term, str]]:
        # Only an allowance that names this colour softens an Avoid: a hue
        # within its gates, a reference colour's headroom or a hex. Being in
        # an allowance's hue arc (and any temperature word, which is only
        # ever "arc") leaves the conflict as it is.
        return [(term, hit) for term, hit in protecting(colour) if hit == "cover"]

    for term in rules.exclusions:
        if term.scope == "cast" and term.kind in ("hue", "temperature"):
            _cast(term, measured, pinned_colours, add)
            continue
        rule = {"hex": "hex", "neutral": "neutral"}.get(term.kind, "hue")
        for colour in every:
            level = _exclusion_level(term, colour)
            if level is None:
                continue
            reason = _label(term)
            protectors = covering(colour)
            if protectors:
                level = "warning"
                reason = f"{reason}. {_allows(_best_allowance(protectors))}, so it may clash."
            add(colour, level, term.source, term.clause, rule, reason)

    for ceiling in rules.ceilings:
        for colour in every:
            if colour.chroma <= ceiling.value:
                continue
            reason = f"Direction: {ceiling.phrase}"
            if colour.large:
                add(colour, "conflict", "direction", ceiling.phrase, "global", reason)
                continue
            hits = protecting(colour)
            if any(hit == "cover" and term.scope == "object" for term, hit in hits):
                continue
            if hits:
                best = _best_allowance(hits)
                add(colour, "warning", "direction", ceiling.phrase, "allowance-chroma",
                    f"{reason}. {_allows(best)}, but this one is more saturated.")
            else:
                add(colour, "conflict", "direction", ceiling.phrase, "global", reason)
    return _deduped(findings)


def _cast(term: Term, measured: list[_Colour], pinned: list[_Colour], add) -> None:
    """A cast tints the whole image: test the board's share-weighted mean."""
    weights = [c.share if c.share is not None else 0.0 for c in measured]
    if not any(weights):
        weights = [1.0] * len(measured)
    total = sum(weights)
    if total <= 0:
        return
    labs = [oklab(c.hex) for c in measured]
    a = sum(w * lab[1] for w, lab in zip(weights, labs)) / total
    b = sum(w * lab[2] for w, lab in zip(weights, labs)) / total
    mean_chroma, mean_hue = math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360
    label = _label(term)
    in_arc = [c for c in (*measured, *pinned) if _in_arc(c.hue, term.gate.arc) and _lightness_ok(c, term.gate)]
    if mean_chroma >= CAST_MEAN_CHROMA and _in_arc(mean_hue, term.gate.arc):
        add(None, "conflict", term.source, term.clause, "cast", f"{label}. The board's colors lean that way overall.")
        for colour in in_arc:
            if colour.chroma >= CAST_COLOUR_CHROMA:
                add(colour, "conflict", term.source, term.clause, "cast",
                    f"{label}. The board leans that way, and this color adds to it.")
        return
    for colour in in_arc:
        if colour.chroma >= CAST_WARNING_CHROMA:
            add(colour, "warning", term.source, term.clause, "cast",
                f"{label}. It may tint the image toward the cast you avoid.")


def _deduped(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One finding per colour, role, rule and clause: the worst level, first reason."""
    kept: dict[tuple, dict[str, Any]] = {}
    for finding in findings:
        key = (finding["hex"], finding["role"], finding["source"], finding["clause"], finding["rule"])
        held = kept.get(key)
        if held is None or (held["level"] == "warning" and finding["level"] == "conflict"):
            kept[key] = finding
    return list(kept.values())


def _colour(hex_value: Any, role: str, share: Any) -> _Colour | None:
    try:
        text = str(hex_value or "").strip().lower()
        if not re.fullmatch(r"#?([0-9a-f]{3}|[0-9a-f]{6})", text):
            return None
        text = text if text.startswith("#") else f"#{text}"
        if len(text) == 4:
            text = "#" + "".join(ch * 2 for ch in text[1:])
        lightness, chroma, hue = oklch(text)
    except (TypeError, ValueError):
        return None
    try:
        share_value = None if share is None else float(share)
    except (TypeError, ValueError):
        share_value = None
    return _Colour(text, role, share_value, lightness, chroma, hue)


def _max(a: float | None, b: float | None) -> float | None:
    return b if a is None else a if b is None else max(a, b)


def _min(a: float | None, b: float | None) -> float | None:
    return b if a is None else a if b is None else min(a, b)


__all__ = ["LEXICON_VERSION", "FOUND_BY", "Gate", "check", "oklab", "oklch", "parse"]
