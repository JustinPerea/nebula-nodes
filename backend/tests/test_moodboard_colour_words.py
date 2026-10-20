"""The colour-word check (design-canvas gap 18, P2): measured colours against
the words in a board's Direction and Avoid list.

Deterministic and free: the text is parsed into colour terms with their
modifiers and scope, then matched in OKLCH by hue arcs and chroma gates
(services/moodboard_colour_words.py). The labelled cases come from the Good
Machines board 4df26f93ff63 and the research note
Research/topics/colour-text-contradiction-detection-2026-10.md.
"""
from __future__ import annotations

import pytest

from services.moodboard_colour_words import LEXICON_VERSION, check, oklch

GM_DIRECTION = (
    "Real 19th-century landscape oil (Hudson River School, Luminism, Tonalism) in a silver tonalist palette: "
    "cool pearl-grey sky, pale blue-grey water, sage and grey-green land, soft mist. Fine detail confined to "
    "about a third of the canvas; the rest is quiet sky, mist or water. Flowers in cool jewel tones: cornflower "
    "blue, violet, lilac and white."
)
GM_AVOID = ["busy all-over detail", "warm yellow varnish cast", "red, orange or pink flowers",
            "digital or illustration look", "people, buildings, text"]
GM_PALETTE = [("#f7f8f7", 0.2037), ("#111010", 0.136), ("#2a2b28", 0.0478), ("#dce0e2", 0.0344),
              ("#16121f", 0.0245), ("#1c70f2", 0.0232), ("#98acac", 0.0208), ("#e7e2d4", 0.0197)]
GM_ACCENTS = [("#a6392d", 0.0015), ("#ef8172", 0.0019), ("#9b492b", 0.0006), ("#c8b03e", 0.0005)]
BRICK, SALMON, RUST, OCHRE, BLUE, PIN = "#a6392d", "#ef8172", "#9b492b", "#c8b03e", "#1c70f2", "#e8593c"
NEUTRALS = ["#f7f8f7", "#111010", "#2a2b28", "#dce0e2", "#16121f", "#98acac", "#e7e2d4"]


def colours(palette=GM_PALETTE, accents=GM_ACCENTS) -> list[dict]:
    return ([{"hex": hex_value, "role": "palette", "share": share} for hex_value, share in palette]
            + [{"hex": hex_value, "role": "accent", "share": share} for hex_value, share in accents])


def worst(findings: list[dict]) -> dict:
    """The worst level per colour (None: a whole-palette finding)."""
    levels: dict = {}
    for finding in findings:
        if finding["level"] == "conflict" or finding["hex"] not in levels:
            levels[finding["hex"]] = finding["level"]
    return levels


def of(findings: list[dict], hex_value) -> list[dict]:
    return [finding for finding in findings if finding["hex"] == hex_value]


def gm(direction=GM_DIRECTION, avoid=GM_AVOID, palette=GM_PALETTE, accents=GM_ACCENTS, pinned=(PIN,)):
    return check(direction, list(avoid), colours(palette, accents), list(pinned))


@pytest.mark.parametrize(("hex_value", "expected"), [
    (BRICK, (0.499, 0.146, 29)), (SALMON, (0.722, 0.138, 29)), (RUST, (0.504, 0.118, 40)),
    (OCHRE, (0.757, 0.133, 97)), (BLUE, (0.575, 0.210, 260)), ("#6495ED", (0.675, 0.141, 261)),
])
def test_oklch_matches_the_research_note(hex_value, expected):
    lightness, chroma, hue = oklch(hex_value)
    assert lightness == pytest.approx(expected[0], abs=0.002)
    assert chroma == pytest.approx(expected[1], abs=0.002)
    assert hue == pytest.approx(expected[2], abs=1.0)


def test_the_good_machines_board_as_labelled():
    findings = gm()
    levels = worst(findings)
    # Brick, salmon and rust are the red, orange and pink flowers the person avoids.
    for hex_value in (BRICK, SALMON, RUST):
        assert levels[hex_value] == "conflict"
        assert any(f["clause"] == "red, orange or pink flowers" and f["source"] == "avoid"
                   and f["reason"].startswith("Avoid: red, orange or pink flowers") for f in of(findings, hex_value))
    # Ochre is not "orange", but the silver tonalist palette has no room for it,
    # and it counts toward the warm yellow cast (a warning only: the board is cool).
    ochre = of(findings, OCHRE)
    assert levels[OCHRE] == "conflict"
    assert not any(f["clause"] == "red, orange or pink flowers" for f in ochre)
    assert any(f["level"] == "conflict" and f["source"] == "direction" and f["rule"] == "global"
               and f["reason"].startswith("Direction: silver tonalist palette") for f in ochre)
    assert any(f["level"] == "warning" and f["rule"] == "cast" and "warm yellow varnish cast" in f["reason"]
               for f in ochre)
    # The blue: allowed for the flowers, but more saturated than cornflower. A warning.
    blue = of(findings, BLUE)
    assert levels[BLUE] == "warning"
    assert any(f["rule"] == "allowance-chroma" and "cornflower" in f["reason"].lower() for f in blue)
    # The pinned colour clashes; it is flagged like any other.
    assert levels[PIN] == "conflict"
    assert any(f["role"] == "pinned" and f["clause"] == "red, orange or pink flowers" for f in of(findings, PIN))
    # The near-neutrals are consistent, and the cool board has no warm cast.
    for hex_value in NEUTRALS:
        assert hex_value not in levels, hex_value
    assert None not in levels


def test_every_finding_says_which_check_found_it():
    findings = gm()
    assert findings and {finding["foundBy"] for finding in findings} == {"words"}
    assert isinstance(LEXICON_VERSION, int)
    for finding in findings:
        assert set(finding) >= {"hex", "role", "share", "level", "source", "clause", "rule", "reason", "foundBy"}
        assert finding["level"] in ("conflict", "warning")
        assert finding["rule"] in ("hue", "neutral", "hex", "cast", "global", "allowance-chroma")


def test_the_blue_as_a_large_cluster_conflicts_with_the_silver_palette():
    palette = [(hex_value, 0.15 if hex_value == BLUE else share) for hex_value, share in GM_PALETTE]
    assert worst(gm(palette=palette))[BLUE] == "conflict"


def test_the_research_cases_that_are_consistent():
    # Silver leads, as on a silver tonalist board. (A board of pearl #eae0c8
    # alone averages warm yellow, C 0.034, and would trip the cast line:
    # a tuning case for GM's labels, noted in implementation-notes.md.)
    palette = [("#c0c0c0", 0.4), ("#eae0c8", 0.15), ("#e2dfd2", 0.15)]
    levels = worst(gm(palette=palette, accents=[("#6495ed", 0.002)], pinned=()))
    assert levels == {}


def test_an_invented_saturated_orange_cluster_conflicts():
    levels = worst(gm(palette=[*GM_PALETTE, ("#f07818", 0.18)], pinned=()))
    assert levels["#f07818"] == "conflict"


def test_dropping_the_palette_rule_drops_the_blue_warning():
    direction = GM_DIRECTION.replace(" in a silver tonalist palette", "")
    levels = worst(gm(direction=direction))
    assert BLUE not in levels
    # Without the palette rule, ochre is only the cast warning.
    assert levels[OCHRE] == "warning"


def test_no_red_in_the_direction_excludes_and_never_allows():
    findings = check("Soft daylight, no red.", [], colours(accents=[(BRICK, 0.002)]), [])
    assert worst(findings)[BRICK] == "conflict"
    assert of(findings, BRICK)[0]["source"] == "direction"
    # A negated word is never an allowance: it can't soften an Avoid conflict.
    both = check("Soft daylight, no red.", ["red flowers"], colours(accents=[(BRICK, 0.002)]), [])
    assert worst(both)[BRICK] == "conflict"


@pytest.mark.parametrize(("direction", "hex_value", "level"), [
    ("Quiet greens, no warm tones.", BRICK, "conflict"),
    ("Quiet greens, without pink.", SALMON, "conflict"),
    ("Quiet greens, without pink.", BRICK, None),          # brick is too dark to be pink
    ("Pink sky ok.", SALMON, None),                          # an allowance protects, never removes
    ("No red but blue flowers.", BLUE, None),                # "but" ends the negation
])
def test_negation_perturbations(direction, hex_value, level):
    levels = worst(check(direction, [], colours(palette=[], accents=[(hex_value, 0.002)]), []))
    assert levels.get(hex_value) == level


def test_reordered_clauses_give_the_same_findings():
    sentences = [s.strip() for s in GM_DIRECTION.split(". ") if s.strip()]
    reordered = ". ".join(reversed([s.rstrip(".") for s in sentences])) + "."

    def key(findings):
        return sorted((f["hex"] or "", f["level"], f["clause"], f["rule"]) for f in findings)

    assert key(gm(direction=reordered, avoid=list(reversed(GM_AVOID)))) == key(gm())


@pytest.mark.parametrize("avoid", [["Reds"], ["RED FLOWER"], ["red flower"], ["red  flowers."]])
def test_plural_singular_and_capitals(avoid):
    assert worst(check("", avoid, colours(palette=[], accents=[(BRICK, 0.002)]), []))[BRICK] == "conflict"


def test_warm_alone_against_warm_yellow():
    warm = worst(check("", ["warm"], colours(), []))
    for hex_value in (BRICK, SALMON, RUST, OCHRE):
        assert warm[hex_value] == "conflict"
    assert "#e7e2d4" not in warm                          # warm-ish, but near-neutral
    warm_yellow = worst(check("", ["warm yellow"], colours(), []))
    assert warm_yellow == {OCHRE: "conflict"}


def test_a_cast_tests_the_whole_palette():
    cool = check("", ["warm yellow varnish cast"], colours(), [])
    assert "conflict" not in {f["level"] for f in cool}
    assert worst(cool) == {OCHRE: "warning"}
    warm_board = [("#e8d9a0", 0.35), ("#f2e6c0", 0.3), ("#c8b03e", 0.2), ("#2a2b28", 0.15)]
    warm = check("", ["warm yellow varnish cast"], colours(palette=warm_board, accents=[]), [])
    levels = worst(warm)
    assert levels[None] == "conflict"                     # the whole palette leans that way
    assert levels["#c8b03e"] == "conflict" and levels["#e8d9a0"] == "conflict"
    assert "#2a2b28" not in levels                        # near-neutrals never go for a cast


def test_a_hex_in_the_text_matches_that_colour_only():
    levels = worst(check("", ["#a6392d"], colours(), []))
    assert levels == {BRICK: "conflict"}
    assert worst(check("", ["no #A6392D please"], colours(), [])) == {BRICK: "conflict"}


def test_colour_words_inside_other_words_match_nothing():
    assert check("A redwood grove, Fred's boat, a bored cat, shredded paper, Tangerineville.",
                 ["redwood", "Fred", "bored", "shredded"], colours(), [PIN]) == []


def test_avoid_blue_flowers_with_a_cornflower_direction_is_a_warning():
    findings = check("Flowers in cornflower blue.", ["blue flowers"],
                     colours(palette=[], accents=[("#6495ed", 0.002)]), [])
    assert worst(findings) == {"#6495ed": "warning"}
    reason = " ".join(f["reason"] for f in findings)
    assert "Avoid: blue flowers" in reason and "cornflower blue" in reason


def test_scope_swap_blue_sky_still_names_blue():
    assert worst(check("", ["blue sky"], colours(palette=[], accents=[(BLUE, 0.002)]), [])) == {BLUE: "conflict"}


def test_pinned_colours_are_checked_but_carry_their_role():
    findings = check("", ["red, orange or pink flowers"], [], [PIN])
    assert [(f["hex"], f["role"], f["level"]) for f in findings] == [(PIN, "pinned", "conflict")]


# -- review fixes (gap 18 review, 2026-10-19) ------------------------------------

@pytest.mark.parametrize("direction", [
    "No people, red flowers and a blue sky.",
    "No people, warm red poppies in the foreground.",
    "Without people, with red roses and a blue sky.",
    "without text, blue sky, red flowers",
])
def test_a_negation_ends_with_the_noun_it_governs(direction):
    """The colours after "No people," are what the person asked for: allowances,
    never exclusions."""
    rules_findings = check(direction, [], colours(palette=[], accents=[(BRICK, 0.002), (SALMON, 0.002),
                                                                         (BLUE, 0.002)]), [])
    assert rules_findings == []
    from services.moodboard_colour_words import parse

    rules = parse(direction, [])
    assert rules.exclusions == []
    assert {term.name for term in rules.allowances} >= ({"red"} if "blue" not in direction else {"red", "blue"})


@pytest.mark.parametrize(("direction", "excluded"), [
    ("No red or orange flowers.", {"red", "orange"}),
    ("no red, orange or pink flowers, blue sky", {"red", "orange", "pink"}),
    ("No people or red flowers.", {"red"}),        # "or" carries the negation on
    ("no red", {"red"}),
])
def test_a_negation_still_covers_its_own_list(direction, excluded):
    from services.moodboard_colour_words import parse

    rules = parse(direction, [])
    assert {term.name for term in rules.exclusions} == excluded
    assert not ({term.name for term in rules.allowances} & excluded)


def test_no_people_then_blue_sky_allows_blue():
    from services.moodboard_colour_words import parse

    rules = parse("without text, blue sky", [])
    assert [term.name for term in rules.allowances] == ["blue"] and rules.exclusions == []


def test_a_warm_direction_never_softens_an_avoid():
    """A temperature word only names a side of the wheel: Avoid colours stay conflicts."""
    findings = check("Warm evening light.", ["red, orange or pink flowers"], colours(), [])
    levels = worst(findings)
    for hex_value in (BRICK, SALMON, RUST):
        assert levels[hex_value] == "conflict", hex_value
    assert not any("may clash" in f["reason"] for f in findings)


def test_an_allowance_arc_alone_never_softens_an_avoid():
    """'pale blue' covers pale blues (C < 0.08), not a C 0.21 blue."""
    levels = worst(check("Pale blue sky.", ["blue"], colours(palette=[], accents=[(BLUE, 0.002)]), []))
    assert levels == {BLUE: "conflict"}
    # A pale blue is named by the allowance, so it only may clash.
    pale = worst(check("Pale blue sky.", ["blue"], colours(palette=[], accents=[("#b4c8e6", 0.002)]), []))
    assert pale == {"#b4c8e6": "warning"}


@pytest.mark.parametrize("hex_value", ["#1a0505", "#201008", "#3a0a0a"])
def test_near_black_shadows_are_not_brown_conflicts(hex_value):
    lightness, chroma, _hue = oklch(hex_value)
    assert lightness < 0.25 and chroma < 0.08
    assert worst(check("", ["brown"], colours(palette=[(hex_value, 0.2)], accents=[]), [])).get(hex_value) != "conflict"


def test_a_real_brown_still_conflicts_with_avoid_brown():
    assert worst(check("", ["brown"], colours(palette=[("#7b4a24", 0.2)], accents=[]), [])) == {"#7b4a24": "conflict"}


def test_sage_stays_a_soft_colour():
    # A muted green conflicts with Avoid "sage" from C 0.03, as before.
    assert worst(check("", ["sage"], colours(palette=[("#8a9a80", 0.2)], accents=[]), [])) == {"#8a9a80": "conflict"}


# -- reason wording (demo dry run, 2026-10-20) ------------------------------------
# A reason quotes the person's own words. It used to build "allows <term> for
# the <first noun>", and the first noun of "late-summer" was "late": "The
# Direction allows Warm for the late, but this one is more saturated." Every
# quote must now be the person's words as written, whole words only, in one of
# the sentences below.

SUMMER = "Warm late-summer light for a sunscreen campaign: soft, sun-faded, optimistic"
SUMMER_AVOID = ["neon", "harsh magenta", "cold blue"]
# The demo board's measured colours (dry run, 5 images, shot 06).
SUMMER_PALETTE = [("#edb495", 0.086), ("#e9e2d1", 0.076), ("#1d1e45", 0.072), ("#0f2941", 0.059),
                  ("#f7b550", 0.057), ("#a4b499", 0.053), ("#f7c762", 0.049), ("#536c4e", 0.043)]
SUMMER_ACCENTS = [("#f69c7a", 0.0083), ("#640c5a", 0.0053), ("#0f2875", 0.0035), ("#faad63", 0.0007)]

_QUOTE = r"“[^”]+”(?: in the [^,.]+)?"
_TAILS = [
    r"",
    rf"\. The Direction also asks for {_QUOTE}, so it may clash\.",
    rf"\. This color is more saturated than that, though the Direction also asks for {_QUOTE}\.",
    r"\. The board's colors lean that way overall\.",
    r"\. The board leans that way, and this color adds to it\.",
    r"\. It may tint the image toward the cast you avoid\.",
]


def _norm(text: str) -> str:
    """Spaces collapsed, and without brackets or quotation marks: a clause
    drops one its span would cut in half."""
    return " ".join(str(text).translate(str.maketrans("", "", "“”()[]\"")).split())


def _whole_words_in(fragment: str, source: str, *, any_case: bool = False) -> bool:
    """Whether ``fragment`` is in ``source`` as whole words: never part of a
    longer or hyphenated word."""
    import re

    if not fragment or fragment != fragment.strip(" ,;:&/-'’"):
        return False
    flags = re.IGNORECASE if any_case else 0
    pattern = rf"(?<![\w'’-]){re.escape(_norm(fragment))}(?![\w'’-])"
    return re.search(pattern, _norm(source), flags) is not None


def assert_reason_reads_well(finding: dict, direction: str, avoid: list[str]) -> None:
    """The reason is "<Avoid|Direction>: <the person's words>" and one of the
    sentences in _TAILS, and every quote is whole words from the text."""
    import re

    reason, clause = finding["reason"], finding["clause"]
    label = f"{'Avoid' if finding['source'] == 'avoid' else 'Direction'}: {clause}"
    assert reason.startswith(label), reason
    source = direction if finding["source"] == "direction" else next(
        (item for item in avoid if _norm(item) == clause), None)
    assert source is not None, reason
    assert _whole_words_in(clause, source), (clause, reason)
    tail = reason[len(label):]
    assert any(re.fullmatch(pattern, tail) for pattern in _TAILS), reason
    for quoted, noun in re.findall(r"“([^”]+)”(?: in the ([^,.]+))?", tail):
        assert _whole_words_in(quoted, direction), (quoted, reason)
        if noun:
            assert _whole_words_in(noun, direction, any_case=True), (noun, reason)


def summer(direction=SUMMER, avoid=SUMMER_AVOID, pinned=()):
    return check(direction, list(avoid), colours(SUMMER_PALETTE, SUMMER_ACCENTS), list(pinned))


def test_the_demo_board_reasons_quote_whole_words():
    findings = summer()
    by_hex = {}
    for finding in findings:
        by_hex.setdefault(finding["hex"], []).append(finding["reason"])
        assert_reason_reads_well(finding, SUMMER, SUMMER_AVOID)
    # The four warm colours the dry run showed as "Warm for the late".
    for hex_value in ("#f7b550", "#f7c762", "#f69c7a", "#faad63"):
        assert by_hex[hex_value] == [
            "Direction: sun-faded. This color is more saturated than that, though the Direction also asks for "
            "“Warm late-summer light”."], hex_value
    assert by_hex["#640c5a"] == ["Avoid: harsh magenta", "Direction: sun-faded"]
    assert not any("for the late" in reason for reasons in by_hex.values() for reason in reasons)


LONG = " ".join([SUMMER + "."] * 60)[:4000]


@pytest.mark.parametrize("direction", [
    SUMMER,
    SUMMER.upper(),
    SUMMER.lower(),
    "wArM lAtE-sUmMeR lIgHt: SoFt, SuN-fAdEd",
    "Muted palette. Sky-blue walls, blue-tinted glass, cornflower-blue flowers and warm-grey stone.",
    "Sun-bleached, washed-out tones; a well-worn, hand-dyed red-orange scarf. Desaturated.",
    "Soft!! warm... light? (muted) palette — with gold/amber accents; no neon-pink, please!",
    "Lumière dorée, café crème walls, muted palette; chaleur douce, warm light. Ça va, très bien.",
    "Real 19th-century landscape oil in a faded palette: warm late-afternoon sky over 1970s-style red barns.",
    "Late-summer flowers: cornflower blue. Silver tonalist palette.",
    "Flowers in cool jewel tones: cornflower blue, violet. Muted palette.",
    "Faded palette, with “warm” golden-hour light and 'soft' peach-pink skin.",
    "no blue-tinted glass, no sun-faded red flowers; muted palette, warm sky",
    LONG,
    "",
    "   ",
    GM_DIRECTION,
], ids=lambda direction: direction[:40] or "empty")
def test_every_reason_quotes_whole_words(direction):
    avoid = [*SUMMER_AVOID, "blue-tinted glass", "Rouge vif, café-au-lait", "warm yellow varnish cast"]
    findings = check(direction, avoid, colours([*SUMMER_PALETTE, *GM_PALETTE], [*SUMMER_ACCENTS, *GM_ACCENTS]),
                     [PIN])
    for finding in findings:
        assert_reason_reads_well(finding, direction, avoid)
    if not direction.strip():
        assert all(finding["source"] == "avoid" for finding in findings)


def test_an_inherited_noun_reads_in_lower_case_and_whole():
    findings = check("Late-summer flowers: cornflower blue. Silver tonalist palette.", [],
                     colours(palette=[], accents=[(BLUE, 0.002)]), [])
    assert [f["reason"] for f in findings] == [
        "Direction: Silver tonalist palette. This color is more saturated than that, though the Direction also "
        "asks for “cornflower blue” in the late-summer flowers."]


@pytest.mark.parametrize("direction, place", [
    # The same word earlier in the text, mid-sentence, used to keep this one's capital.
    ("Garden Flowers everywhere. Flowers: cornflower blue. Silver tonalist palette.", "flowers"),
    # ... and the same word earlier at a sentence start lower-cased this one.
    ("Flowers. Bright Flowers: cornflower blue. Silver tonalist palette.", "Flowers"),
    ("Garden\nFlowers: cornflower blue. Silver tonalist palette.", "flowers"),
])
def test_an_inherited_noun_reads_its_own_capital(direction, place):
    findings = check(direction, [], colours(palette=[], accents=[(BLUE, 0.002)]), [])
    assert [f["reason"] for f in findings] == [
        "Direction: Silver tonalist palette. This color is more saturated than that, though the Direction also "
        f"asks for “cornflower blue” in the {place}."]


def test_a_softened_avoid_quotes_the_direction():
    findings = check("Flowers in cornflower blue.", ["blue flowers"], colours(palette=[], accents=[("#6495ed", 0.002)]),
                     [])
    assert [f["reason"] for f in findings] == [
        "Avoid: blue flowers. The Direction also asks for “cornflower blue”, so it may clash."]


def test_a_direction_exclusion_quotes_its_whole_noun_phrase():
    findings = check("Bright beach, without blue-tinted glass.", [], colours(palette=[], accents=[(BLUE, 0.002)]),
                     [])
    assert [f["clause"] for f in findings] == ["without blue-tinted glass"]


def test_words_with_letters_beyond_english_stay_whole():
    """'café' used to read as 'caf': a quote never cuts a word."""
    findings = check("Faded palette, warm café light.", [],
                     colours(palette=[], accents=[("#f7b550", 0.002)]), [])
    assert [f["reason"] for f in findings] == [
        "Direction: Faded palette. This color is more saturated than that, though the Direction also asks for "
        "“warm café light”."]


def test_the_brief_lists_read_well_left_out_kept_and_may_clash():
    """The Studio's Left out, Kept anyway and May clash lists, and the Preview
    rows, show these reasons as they are (services/moodboard_brief.compose)."""
    from services.moodboard_brief import compose

    analysis = {
        "version": 4, "sourceHash": "fixture", "mode": "look", "strength": 0.7, "summary": "", "keywords": [],
        "palette": [h for h, _ in SUMMER_PALETTE], "accents": [h for h, _ in SUMMER_ACCENTS],
        "colors": ([{"hex": h, "share": s, "role": "dominant", "images": 1} for h, s in SUMMER_PALETTE]
                   + [{"hex": h, "share": s, "role": "accent", "images": 1} for h, s in SUMMER_ACCENTS]),
    }
    board = {"id": "summerboard1", "name": "Summer Light", "mode": "look", "strength": 0.7, "notes": "",
             "images": [], "direction": SUMMER, "avoid": list(SUMMER_AVOID),
             "pinnedColors": {"include": [], "exclude": []}, "briefOverride": None, "briefVersion": 1,
             "colorChoices": {"keep": ["#0f2875"], "leaveOut": []}, "analysis": analysis}
    brief = compose(board)
    assert [item["hex"] for item in brief["kept"]] == ["#0f2875"]
    assert [item["hex"] for item in brief["leftOut"]] == ["#640c5a"]
    assert len(brief["mayClash"]) == 5
    for item in [*brief["leftOut"], *brief["kept"], *brief["mayClash"]]:
        for reason in item["reasons"]:
            assert "for the late" not in reason
            source = "avoid" if reason.startswith("Avoid: ") else "direction"
            clause = next(c for c in [*SUMMER_AVOID, "sun-faded"] if reason.startswith(
                f"{'Avoid' if source == 'avoid' else 'Direction'}: {c}"))
            assert_reason_reads_well({"reason": reason, "clause": clause, "source": source}, SUMMER, SUMMER_AVOID)


def test_a_second_negation_keeps_the_first_ones_words():
    findings = check("no blue glass, no red flowers", [], colours(palette=[], accents=[(BLUE, 0.002), (BRICK, 0.002)]),
                     [])
    assert sorted(f["reason"] for f in findings) == ["Direction: no blue glass", "Direction: no red flowers"]
