"""Error copy round 3f: GM - Design's rules for every card line (GM's 3f message).

GM: "RULES FOR EVERY CARD LINE (the "shown again, word for word" list breaks
these all over; each one can be applied mechanically)":

1. Every line ends with a period.
2. No em dashes or semicolons. Split into two sentences, or join with "so".
3. No parentheses. A count in parentheses becomes a clause.
4. "wired" / "Wire" -> "connected" / "Connect", everywhere.
5. Field labels are written exactly as the node shows them, in quotes. Never
   a param key, a port id or a code name ("filePath param", "Array input",
   "CameraPose input").
6. "{X} input is required" -> "Connect {a/an X in words} to this node, then
   run it again." A required field: "Fill in “{Field}”, then run the node again."
7. Lines that stop before sending end with "Nothing was sent to {Provider}."
8. "Run again." / "run again" -> "Run the node again." / "then run the node again."
9. One name and one unit style each: fal.ai, Black Forest Labs, Vertex AI,
   MB, "seconds", 1080p.
10. "Unknown {Provider} {kind} model" -> "This node's model isn't one
    {Provider} offers. Pick one in “Model”, then run the node again."
11. "Couldn't {verb} {object}." first, then the reason, for downloads and reaches.

The guard below reads every line a card or the Cinema shot panel can show
(every as_person_line text, every with_person_line / with_provider_line /
with_details_line line, route_clients' refuse tails, the pre-run check's
person lines, and the shared helpers' lines) and fails on what can be
checked mechanically. What agents read (the exception text, a validation
error's message) is never a card line and stays word for word.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any

import pytest

from execution.person_line import person_line

BACKEND = Path(__file__).resolve().parent.parent
FIXTURE = json.loads((BACKEND / "tests" / "fixtures" / "route_cases.json").read_text())


# -- the rules, as a check ---------------------------------------------------

# A label the node shows sits in curly quotes (rule 5), and may carry its own
# parentheses (“Requested Duration (s)”): a quoted span is left out of the
# parenthesis check.
_QUOTED = re.compile(r"“[^”]*”")
_URL = re.compile(r"https?://\S+")
_CHECKS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("an em dash or a semicolon", re.compile(r"[—–;]")),
    ("a parenthesis", re.compile(r"[()]")),
    ("wired / Wire", re.compile(r"\bwired\b|\bWire\b")),
    # Every resolution in lowercase p (512p, 768p, 1080p), not just 1080p (review).
    ("FAL / BFL / MiB / 1080P", re.compile(r"\bFAL\b|\bBFL\b|\bMiB\b|\b\d{3,4}P\b")),
    ("a number followed by s", re.compile(r"(?:\b\d+(?:\.\d+)?|\{\}) ?s\b")),
    ("run again without the node", re.compile(r"\b[Rr]un again\b")),
    ("a code name", re.compile(r"\b\w+ param\b|\bArray input\b|\bCameraPose\b|\b[a-z]+[A-Z][A-Za-z]*\b")),
)


# Names spelled the provider's way, which the code-name check would catch.
_NAMES = ("xAI",)

# Rule 9: "Vertex AI", not "Vertex". A later "Vertex" in a line that already
# said "Vertex AI" is a short second mention ("…run Veo 3.1 on Vertex.").
_VERTEX = re.compile(r"\bVertex\b(?! AI)")


def _field_labels() -> frozenset[str]:
    """Every field label a node shows (node_definitions.json), capitalized ones:
    rule 5's bare-label check reads them after a verb that names a field."""
    definitions = json.loads((BACKEND / "data" / "node_definitions.json").read_text())
    return frozenset(str(param.get("label") or "").strip() for definition in definitions.values()
                     for param in definition.get("params") or []
                     if str(param.get("label") or "").strip()[:1].isupper())


_LABELS = "|".join(sorted((re.escape(label) for label in _field_labels()), key=len, reverse=True))
# Rule 5: a field named after a verb that sets it ("Set Duration to 10",
# "Clear the node's Quality field", "doesn't offer Reasoning Effort Low") is
# written as the node shows it, in quotes. GM's verbatim xAI edit-video line
# ("Pick it in the node's Model field") is GM's own and isn't one of these verbs.
_BARE_LABEL = re.compile(r"\b(?:[Ss]et|[Cc]lear|offer|fewer|[Ll]ower|[Rr]aise|[Tt]urn (?:on|off)|[Ff]ill in)\s+"
                         r"(?:the\s+(?:node's\s+)?)?(?:" + _LABELS + r")\b"
                         # "the node's Tags field": a label by name, not in quotes. A port
                         # ("the node's Prompt input") is an input, not a field.
                         r"|\b[Tt]he node's (?!Model field)(?:" + _LABELS + r")\b(?! input| output)"
                         # "in the Palette field" (round 3g review): a field named bare, the node's or not.
                         r"|\bthe (?:" + _LABELS + r") field\b"
                         # A label filled in from a table ("Set the node's {} to"), never quoted.
                         r"|\b[Ss]et the node's \{\}")


def _port_labels() -> list[str]:
    """Every port label a node shows, input or output, exactly as it shows it."""
    definitions = json.loads((BACKEND / "data" / "node_definitions.json").read_text())
    return sorted({str(port.get("label") or "").strip() for definition in definitions.values()
                   for port in [*(definition.get("inputPorts") or []), *(definition.get("outputPorts") or []),
                                *(definition.get("displayOutputs") or [])]} - {""}, key=len, reverse=True)


_PORTS = "|".join(re.escape(label) for label in _port_labels())
# Round 3g (GM): "anything a person reads as a label on the node goes in
# quotes, field or port." A port named by its label, bare.
_BARE_PORT = re.compile(
    # "the node's Prompt input", "Krea 2's Moodboard input", "this node's Image input"
    r"\b(?:" + _PORTS + r")\s+(?:input|output|port)s?\b"
    # "Connect the audio track to Audio" ("save to Krea Files" names where a
    # node saves, not a port)
    r"|\b(?:[Cc]onnect|[Dd]isconnect)\b[^.]*?(?<!save )\b(?:to|into)\s+(?:the\s+)?(?:node's\s+)?(?:" + _PORTS + r")\b"
    # "Disconnect End image"
    r"|\b[Dd]isconnect\s+(?:the\s+)?(?:node's\s+)?(?:" + _PORTS + r")\b"
    # a label filled in at run time: "the node's {} input"
    r"|\{\}\s+(?:input|output|port)s?\b")


def port_breaks(line: str) -> bool:
    """Whether `line` names a port by its label without quotes (round 3g)."""
    return bool(_BARE_PORT.search(_QUOTED.sub("“”", _URL.sub("", line.strip()))))


def rule_breaks(line: str, *, ends_in_a_sentence: bool | None = None) -> list[str]:
    """What `line` breaks of GM's mechanical rules ([] for none). ``{}`` stands
    for a value; ``ends_in_a_sentence`` says whether a line ending in one ends
    with a whole sentence (it_was, a shared sentence constant)."""
    broken = []
    text = line.strip()
    if text.endswith("{}"):
        ends = bool(ends_in_a_sentence)
    else:
        ends = bool(re.search(r"[.]['\"”’]?$", text))
    if not ends:
        broken.append("no final period")
    plain = _QUOTED.sub("“”", _URL.sub("", text))
    for name in _NAMES:  # a provider's own spelling is not a code name
        plain = plain.replace(name, "Name")
    broken += [name for name, pattern in _CHECKS if pattern.search(plain)]
    if any("Vertex AI" not in plain[:match.start()] for match in _VERTEX.finditer(plain)):
        broken.append("Vertex without AI")
    if _BARE_LABEL.search(plain):
        broken.append("a field label not in quotes")
    if port_breaks(text):
        broken.append("a port label not in quotes")
    return broken


def test_the_rules_check_catches_each_shape_and_lets_gms_lines_through() -> None:
    # Round 3g: "Prompt input" names a port by its label, bare, too.
    assert rule_breaks("Prompt input is required") == ["no final period", "a port label not in quotes"]
    assert "an em dash or a semicolon" in rule_breaks("No mask painted yet — open the Mask Painter node.")
    assert "an em dash or a semicolon" in rule_breaks("It can't be found; it may be gone.")
    assert "a parenthesis" in rule_breaks("Turn off HD Texture (4K) or pick another model.")
    assert "wired / Wire" in rule_breaks("Wire a Krea 3D job or enter its job ID.")
    assert "wired / Wire" in rule_breaks("This node app takes 1 more image, and 2 are wired.")
    assert "FAL / BFL / MiB / 1080P" in rule_breaks("The request is 40 MiB.")
    assert "FAL / BFL / MiB / 1080P" in rule_breaks("MiniMax makes 1080P clips at 6 seconds only.")
    assert "a number followed by s" in rule_breaks("Pick one of: 5, 10 s.")
    assert "a number followed by s" in rule_breaks("It took longer than {} s to download.")
    assert "run again without the node" in rule_breaks("Replace them with uploads and run again.")
    assert "a code name" in rule_breaks("Style Reference needs a reference image, the filePath param.")
    assert "a code name" in rule_breaks("Iterator requires an Array input.")
    assert "a code name" in rule_breaks("Camera Path requires at least one CameraPose input.")
    # Review: every resolution's p, Vertex AI, and a bare field label.
    assert "FAL / BFL / MiB / 1080P" in rule_breaks("MiniMax renders 512P only from a start image.")
    assert "Vertex without AI" in rule_breaks("On Vertex only Veo 3.1 Standard renders 4K. Pick 1080p.")
    assert "Vertex without AI" in rule_breaks("Vertex takes up to 3 reference images, and 4 are connected.")
    assert "Vertex without AI" not in rule_breaks("Google Vertex AI needs a project. Then run Veo 3.1 on Vertex.")
    assert "a field label not in quotes" in rule_breaks("Set Duration to 10 or less.")
    assert "a field label not in quotes" in rule_breaks("Clear the node's Quality field, then run the node again.")
    assert "a field label not in quotes" in rule_breaks("GPT-6 Astra doesn't offer Reasoning Effort None.")
    assert "a field label not in quotes" in rule_breaks("Use fewer references or fewer Images per Generation.")
    assert "a field label not in quotes" in rule_breaks("Raise Max Tokens or lower Effort.")
    assert "a field label not in quotes" in rule_breaks("Set the node's {} to a number from 0 to {}.")
    assert "a field label not in quotes" in rule_breaks("Set the node's Seed to a whole number from 0 to 9.")
    assert "a field label not in quotes" in rule_breaks("The node's Tags field takes up to 10 tags.")
    # Round 3g review: "in the Palette field" names a field bare too.
    assert "a field label not in quotes" in rule_breaks("Add hex swatches in the Palette field, then run the node again.")
    assert "a field label not in quotes" not in rule_breaks("The wire into the node's Prompt input brings something.")
    # Round 3g: a port is quoted too.
    assert "a port label not in quotes" in rule_breaks("The wire into the node's Prompt input brings something.")
    assert "a port label not in quotes" not in rule_breaks("The wire into “Prompt” brings something it can't take.")
    assert "a field label not in quotes" not in rule_breaks("Set “Duration” to 10 or less.")
    assert "a field label not in quotes" not in rule_breaks(
        "xAI edits videos only on Grok Imagine. Pick it in the node's Model field, or disconnect the video to edit.")
    # GM's own lines pass.
    for line in (
        "Set “Item cap” to a whole number from 1 to 25.",
        "Connect a prompt to this node, then run it again.",
        "Fill in “Style ID”, then run the node again.",
        "Connect a duration, or set “Requested Duration (s)”, then run it again.",
        "This node's model isn't one Runway offers. Pick one in “Model”, then run the node again.",
        "Couldn't download the result from Black Forest Labs. Its download link may have expired. "
        "Run the node again.",
        "Seedream takes up to 10 reference images, and 12 are connected.",
        "Training FLUX.2 styles needs the “Krea account” connection. Nothing was sent to Krea.",
        "Verify it at https://platform.openai.com/settings/organization/general (a link).",
    ):
        assert not rule_breaks(line.replace(" (a link)", "")), line


# -- every line a card can show ------------------------------------------------

RUN_TIME_DIRS = ("handlers", "execution")
# The services a run raises from (test_error_copy_round3c2.RUN_TIME_SERVICES),
# and the ones that write the pre-run check's and the route switcher's lines.
SERVICES = ("media_input", "qc_common", "qc_jev", "typesafe_client", "vision_llm", "google_vertex", "quiver_client",
            "krea_mcp_generation", "edit_masks", "ffmpeg", "krea_account", "nous_auth", "image_input", "node_route",
            "port_contracts", "paper_copy", "node_readiness")
LINE_WRAPPERS = {"with_person_line", "with_provider_line", "with_details_line"}
MARKERS = {"with_api_status", "as_job_failure", "with_call_facts"}
# A line may end with one of these: each is a whole sentence (checked below).
SENTENCE_ENDINGS = {"it_was", "NOTHING_SENT_TO_KREA", "KREA_ONLY_HINT", "MESHY_KREA_HINT", "it_was_line"}


def _files() -> list[Path]:
    files = [path for folder in RUN_TIME_DIRS for path in sorted((BACKEND / folder).glob("*.py"))]
    return files + [BACKEND / "services" / f"{name}.py" for name in SERVICES
                    if (BACKEND / "services" / f"{name}.py").exists()]


def _template(node: ast.AST) -> tuple[str, bool] | None:
    """(text with {} for values, whether a trailing value is a whole sentence)."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value, False
    if isinstance(node, ast.JoinedStr):
        text, last = "", None
        for part in node.values:
            if isinstance(part, ast.Constant):
                text += str(part.value)
                last = None
            else:
                text += "{}"
                last = part.value
        tail = last
        if isinstance(tail, ast.Call):
            tail = tail.func
        ends = isinstance(tail, ast.Name) and tail.id in SENTENCE_ENDINGS
        return text, ends
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _template(node.left), _template(node.right)
        if left is None or right is None:
            return None
        return left[0] + right[0], right[1]
    return None


def _assigned(tree: ast.AST, call: ast.AST, name: str) -> list[ast.AST]:
    """The values `name` is assigned in the function around `call`."""
    best = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and \
                node.lineno <= call.lineno <= (node.end_lineno or node.lineno):
            if best is None or node.lineno > best.lineno:
                best = node
    found = []
    for node in ast.walk(best or tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            found.append(node.value)
    return found


def card_lines() -> list[tuple[str, int, str, bool]]:
    """(file, line number, the card line's template, ends in a sentence) for every
    card line written where it is raised."""
    lines: list[tuple[str, int, str, bool]] = []
    for path in _files():
        source = path.read_text()
        tree = ast.parse(source)
        rel = str(path.relative_to(BACKEND))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
            values: list[ast.AST] = []
            if name == "as_person_line" and node.args:
                inner = node.args[0]
                while isinstance(inner, ast.Call) and getattr(inner.func, "id", "") in MARKERS:
                    inner = inner.args[0]
                if isinstance(inner, ast.Call) and inner.args:
                    values = [inner.args[0]]
            elif name in LINE_WRAPPERS and len(node.args) > 1:
                values = [node.args[1]]
            elif name == "refuse" and rel == "execution/route_clients.py" and len(node.args) >= 2:
                values = [node.args[2] if len(node.args) > 2 else node.args[1]]
            for keyword in node.keywords:
                if keyword.arg == "person" and name == "ValidationErrorDetail":
                    values.append(keyword.value)
            for value in values:
                for resolved in (_assigned(tree, node, value.id) if isinstance(value, ast.Name) else [value]):
                    for option in (resolved.body, resolved.orelse) if isinstance(resolved, ast.IfExp) else (resolved,):
                        found = _template(option)
                        if found is not None:
                            text, ends = found
                            if not text.replace("{}", "").strip():
                                continue  # all values: route_clients.refuse itself (its callers' tails are read)
                            if name == "refuse":
                                text = "{} " + text
                            lines.append((rel, node.lineno, text, ends))
    return lines


def test_the_guard_reads_lines_from_every_kind_of_site() -> None:
    lines = card_lines()
    files = {path for path, *_ in lines}
    # as_person_line, with_person_line, refuse tails, validation lines, the
    # World Labs node's lines and the route switcher's.
    for expected in ("handlers/meshy.py", "execution/route_clients.py", "execution/engine.py",
                     "handlers/krea.py", "services/typesafe_client.py"):
        assert expected in files, expected
    assert len(lines) > 300


def test_every_card_line_follows_gms_rules() -> None:
    broken = []
    for path, number, text, ends in card_lines():
        found = rule_breaks(text, ends_in_a_sentence=ends)
        if found:
            broken.append(f"{path}:{number} {found}: {text}")
    assert not broken, f"{len(broken)} card lines break GM's rules:\n" + "\n".join(broken)


def test_every_shared_sentence_a_line_ends_with_is_a_sentence() -> None:
    from execution.maker_routes_minimax_meshy import KREA_ONLY_HINT, MESHY_KREA_HINT
    from execution.person_line import it_was
    from handlers.krea import NOTHING_SENT_TO_KREA, UNSET_CONNECTION_LINE

    for line in (KREA_ONLY_HINT, MESHY_KREA_HINT, NOTHING_SENT_TO_KREA, UNSET_CONNECTION_LINE,
                 it_was(3.5), it_was(True), it_was(None), it_was("x" * 80)):
        assert not rule_breaks(line), line


def test_the_shared_helpers_lines_follow_gms_rules() -> None:
    from execution import person_line as lines
    from services.credential_catalog import CREDENTIAL_PROVIDERS

    produced = [lines.missing_file_line(what, value) for what, value in (
        ("image file", None), ("video file", None), ("audio file", None), ("file", "/x/a.mp4"), ("Media", None),
        ("file", None), ("Mesh", None))]
    produced += [lines.key_line([key]) or "" for key in CREDENTIAL_PROVIDERS if key in lines.KEY_NAMES]
    produced += [lines.missing_key_line(["NOT_A_KEY"]), lines.missing_key_line(["OPENAI_API_KEY", "FAL_KEY"])]
    produced += [lines.slow_job_line(provider) for provider in ("fal.ai", "Black Forest Labs", "Krea", "Runway")]
    produced += [lines.status_line(kind, "Runway") for kind in lines.STATUS_LINES]
    produced += [lines.status_line("key", "Replicate", "API token"),
                 lines.status_line("key", "Google Vertex AI", "credentials")]
    for line in produced:
        assert not rule_breaks(line), line


def _input_labels() -> list[str]:
    definitions = json.loads((BACKEND / "data" / "node_definitions.json").read_text())
    return sorted({str(port.get("label") or "") for definition in definitions.values()
                   for port in definition.get("inputPorts") or []} - {""})


def test_every_unwired_input_line_follows_gms_rules() -> None:
    from execution.person_line import port_line

    for label in _input_labels():
        assert not rule_breaks(port_line(label)), (label, port_line(label))


def test_every_wiring_line_follows_gms_rules() -> None:
    from services import port_contracts

    for line in (port_contracts.STALE_INPUT_LINE, port_contracts.STALE_OUTPUT_LINE,
                 *port_contracts.PORT_TYPE_PERSON_HINTS.values()):
        assert not rule_breaks(line), line
    for label in ("Prompt", "Mask (white = edit)", "Images (1-4)"):
        port = {"label": label}
        for line in (port_contracts._wrong_kind_line(port, "p"), port_contracts._too_many_line(port, "p", 1),
                     port_contracts._too_many_line(port, "p", 4)):
            assert not rule_breaks(line), line


def test_every_route_line_follows_gms_rules() -> None:
    # The pre-run check's and the provider switcher's line for every route case
    # (the frontend twin reads the same fixture: directRoute.test.ts).
    lines = sorted({case.get("unavailableLine") or "" for case in FIXTURE["cases"]} - {""})
    assert len(lines) > 40
    broken = [line for line in lines if rule_breaks(line)]
    assert not broken, "\n".join(broken)


def test_the_world_labs_nodes_lines_follow_gms_rules() -> None:
    from handlers import worldlabs

    produced = list(worldlabs.PERSON_LINES.values())
    produced += [worldlabs._job_kept_line("Resume Operation ID"), worldlabs._job_failed_line("Resume Operation ID"),
                 worldlabs._bad_recovery_id_line("Existing World ID")]
    for line in produced:
        assert not rule_breaks(line), line


def test_the_gemini_omni_guardrail_card_line_follows_gms_rules() -> None:
    from services.provider_capabilities import GEMINI_OMNI_EXTENSION_ERROR, GEMINI_OMNI_EXTENSION_LINE

    assert not rule_breaks(GEMINI_OMNI_EXTENSION_LINE)
    # Agents keep the guardrail's text word for word.
    assert GEMINI_OMNI_EXTENSION_ERROR.startswith("Gemini Omni capability guardrail: Gemini Omni can edit")


def test_the_paper_cards_lines_follow_gms_rules() -> None:
    from services import paper_copy

    strings = [node.value for node in ast.walk(ast.parse((BACKEND / "services" / "paper_copy.py").read_text()))
               if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.endswith(".")
               and " " in node.value and node.value[0].isupper()]
    assert strings
    for line in strings:
        assert not rule_breaks(line), line
    assert paper_copy  # imported: the table is the module's own


# -- the code-name guard (test_error_copy_round3c2.FORBIDDEN_IN_A_LINE) ----------


def test_the_id_guard_also_refuses_code_names() -> None:
    from tests.test_error_copy_round3c2 import forbidden_in_a_line

    for line in ("Style Reference needs a reference image (filePath param)", "Iterator requires an Array input",
                 "Camera Path requires at least one CameraPose input"):
        assert forbidden_in_a_line(line), line
    for line in ("Connect camera poses to this node, then run it again.", "Fill in “Style ID”, then run the node again.",
                 "BytePlus takes reference videos only as a public URL or a ModelArk asset ID."):
        assert not forbidden_in_a_line(line), line


# -- GM's specific lines -------------------------------------------------------


def _raised(fn, *args, **kwargs) -> BaseException:
    with pytest.raises(Exception) as info:
        fn(*args, **kwargs)
    return info.value


async def _araised(fn, *args, **kwargs) -> BaseException:
    with pytest.raises(Exception) as info:
        await fn(*args, **kwargs)
    return info.value


def _line_beside(rel: str, fragment: str) -> str:
    """The card line raised with the exception whose text contains `fragment`
    (its template: {} for values)."""
    path = BACKEND / rel
    tree = ast.parse(path.read_text())
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = node.func.id if isinstance(node.func, ast.Name) else ""
        if name not in LINE_WRAPPERS | {"as_person_line"} or not node.args:
            continue
        inner = node.args[0]
        while isinstance(inner, ast.Call) and getattr(inner.func, "id", "") in MARKERS:
            inner = inner.args[0]
        if not (isinstance(inner, ast.Call) and inner.args):
            continue
        text = _template(inner.args[0])
        if text is None or fragment not in text[0]:
            continue
        if name == "as_person_line":
            found.append(text[0])
        else:
            line = node.args[1]
            values = _assigned(tree, node, line.id) if isinstance(line, ast.Name) else [line]
            found += [t[0] for t in (_template(v) for v in values) if t is not None]
    assert found, f"no line beside {fragment!r} in {rel}"
    assert len(set(found)) == 1, found
    return found[0]


def test_line_22_the_polling_link_line_reads_like_line_111() -> None:
    line_111 = ("Black Forest Labs sent a status link from outside its own site, so Nebula didn't send your key there "
                "and stopped. The job may still run and be billed on Black Forest Labs.")
    assert _line_beside("handlers/bfl.py", "returned a polling URL outside https://*.bfl.ai; Nebula didn't send the key "
                        "to it and stopped the run.") == line_111
    assert _line_beside("handlers/bfl.py", "accepted task {} but returned a polling URL") == line_111


@pytest.mark.asyncio
async def test_line_22_live() -> None:
    import httpx

    from handlers import bfl

    async with httpx.AsyncClient() as client:
        exc = await _araised(bfl.get_result, "key", "https://evil.example.com/poll", client=client)
    assert str(exc) == ("Black Forest Labs returned a polling URL outside https://*.bfl.ai; Nebula didn't send the key "
                        "to it and stopped the run.")
    assert person_line(exc).startswith("Black Forest Labs sent a status link from outside its own site")


def test_line_48_the_openai_organization_line_keeps_the_link_behind_details() -> None:
    from execution.person_line import shows_details
    from handlers.openai_image_v2 import _raise_org_verification_error

    exc = _raised(_raise_org_verification_error, "gpt-image-2")
    assert str(exc) == ("Your OpenAI org isn't verified for gpt-image-2. "
                        "Visit https://platform.openai.com/settings/organization/general to verify.")
    assert person_line(exc) == ("OpenAI needs your organization verified to use GPT Image 2. Verify it in OpenAI's "
                                "organization settings, then run the node again.")
    # The link isn't prose: it stays in the text, behind the card's Details.
    assert "https://" not in person_line(exc)
    assert shows_details(exc)


def test_line_51_quivers_credits_line_is_the_status_tables() -> None:
    from handlers.quiver import _wrap_provider_error
    from services.quiver_client import QuiverInsufficientCreditsError

    exc = _wrap_provider_error(QuiverInsufficientCreditsError("402 from QuiverAI", status_code=402))
    assert str(exc) == "Insufficient QuiverAI credits — top up or upgrade plan"
    assert person_line(exc) == "Your QuiverAI account is out of credits. Add credits, then run the node again."


def test_line_69_the_image_inputs_file_lowercase() -> None:
    from execution.engine import _image_input_output

    exc = _raised(_image_input_output, {"filePath": "/no/such/file.png"})
    assert str(exc).startswith("Image Input file not found: '/no/such/file.png'. Set a valid path — ")
    assert person_line(exc) == "The node's file can't be found. Choose it again, then run the node again."


def test_lines_70_to_72_name_the_cap_by_the_label_the_node_shows_in_quotes() -> None:
    from execution.engine import _batch_items, _fanout_over_cap

    exc = _raised(_batch_items, {"items_text": "a", "batch_size_cap": 40})
    assert str(exc) == "Batch batch_size_cap must be an integer from 1 to 25"
    assert person_line(exc) == "Set “Item cap” to a whole number from 1 to 25."
    exc = _raised(_batch_items, {"items_text": "a\nb\nc", "batch_size_cap": 2})
    assert person_line(exc) == ("This Batch has 3 items, more than its “Item cap” of 2. Remove items or raise the "
                                "cap, then run it again. Nothing was generated.")
    assert person_line(_fanout_over_cap("batch", 12, 10)) == (
        "This Batch would make 12 items, more than its “Item cap” of 10. Make the batch smaller, then run it again. "
        "Nothing after it was generated.")
    assert person_line(_fanout_over_cap("iterator-image", 12, 10)) == (
        "This iterator would make 12 items, more than its “Batch Size Cap” of 10. Make the batch smaller, then run "
        "it again. Nothing after it was generated.")


def test_line_74_names_the_key_that_would_run_it() -> None:
    from execution.maker_routes import _blocked_key_line, definition_for
    from services import node_route

    definition = definition_for("krea-image-bytedance-seedream-4")
    block = node_route.DirectBlock(node_route.BLOCKED, param="style_images")
    assert _blocked_key_line(definition, "BYTEPLUS_API_KEY", block) == (
        "These settings need your Krea API key. Add it in Settings, then run the node again.")
    definition = definition_for("seedream-4-5")
    assert _blocked_key_line(definition, "BYTEPLUS_API_KEY", None) == (
        "These settings need your fal.ai API key. Add it in Settings, then run the node again.")
    # GM's approved form for a node whose copy runs on any of several keys.
    several = {"id": "x", "envKeyName": ["BFL_API_KEY", "FAL_KEY", "REPLICATE_API_TOKEN", "KREA_API_TOKEN"],
               "directKeyName": "BFL_API_KEY"}
    assert _blocked_key_line(several, "BFL_API_KEY", None) == (
        "These settings need your fal.ai API key, Replicate API token or Krea API key. Add one in Settings, "
        "then run the node again.")


def test_line_93_a_route_that_needs_a_prompt_says_what_to_do() -> None:
    from execution import route_clients

    where = route_clients.Where("Replicate's black-forest-labs/flux-3", "FLUX 3 Video on Replicate")
    exc = _raised(route_clients.replicate_input, {}, {}, where)
    assert str(exc) == "Replicate's black-forest-labs/flux-3 needs a prompt"
    assert person_line(exc) == "FLUX 3 Video on Replicate needs a prompt. Connect one, then run the node again."
    for tail in ("needs a video. Connect one, then run the node again.",
                 "needs a video to edit. Connect one, then run the node again.",
                 "needs a video to upscale. Connect one, then run the node again.",
                 "needs at least one keyframe image. Connect one, then run the node again."):
        assert any(text == "{} " + tail for _path, _n, text, _e in card_lines()), tail


def test_lines_110_178_189_a_download_leads_with_couldnt() -> None:
    for rel, fragment, provider in (("handlers/bfl.py", "result download failed (HTTP {});", "Black Forest Labs"),
                                    ("handlers/openrouter_media.py", "video download failed", "OpenRouter"),
                                    ("handlers/replicate_model.py", "result download failed", "Replicate")):
        assert _line_beside(rel, fragment) == (f"Couldn't download the result from {provider}. Its download link "
                                               "may have expired. Run the node again.")


def test_the_slow_job_line_says_nebula_stopped_waiting() -> None:
    from execution.person_line import slow_job_line

    assert slow_job_line("Runway") == (
        "Runway took too long, so Nebula stopped waiting. The job may still finish there and be billed, so check "
        "Runway before you run the node again.")


def test_lines_118_and_172_split_at_the_semicolon() -> None:
    assert _line_beside("handlers/character_node.py", "not found; it may have been deleted for good") == (
        "This node's character can't be found. It may have been deleted for good. Pick another character for this "
        "node.")
    assert _line_beside("handlers/moodboard.py", "not found; it may have been deleted for good") == (
        "This node's board can't be found. It may have been deleted for good. Pick another board for this node.")


def test_line_152_names_the_passing_options_by_their_labels() -> None:
    assert _line_beside("handlers/jev_decide.py", "pass_when names") == (
        "“{}” lists {}, which isn't one of the node's options. Pick from “{}”.")


def test_line_163_the_krea_agent_keeps_running_there() -> None:
    assert _line_beside("handlers/krea_workspace.py", "The Krea Agent is still working after") == (
        "The Krea Agent is still working after {} seconds. It keeps running there, so open Krea to see the result.")


def test_line_164_is_gms_3d_krea_line_8() -> None:
    assert _line_beside("handlers/krea_workspace.py", "Krea usage needs a workspace service key") == (
        "Krea usage needs a workspace service key, and Krea doesn't accept personal API tokens for it. Add one to "
        "“{}” in Settings. {}")


def test_xai_edits_videos_on_one_model_in_gms_words() -> None:
    assert _line_beside("execution/maker_routes_xai.py", "xAI edits videos on {} only, not {}") == (
        "xAI edits videos only on {}. Pick it in the node's Model field, or disconnect the video to edit.")


def test_the_veo_extension_line_names_vertex_ai_and_the_gemini_api() -> None:
    assert _line_beside("handlers/veo.py", "Vertex can't read a Gemini API file URI") == (
        "Vertex AI can't extend a clip made through the Gemini API. Connect the upstream node's “Video” output to "
        "“Extend Video” instead.")


def test_rule_6_an_input_is_required_says_connect_it() -> None:
    assert _line_beside("handlers/google_gemini.py", "Messages input is required for Gemini chat") == (
        "Connect messages to this node, then run it again.")
    assert _line_beside("handlers/meshy.py", "Model URL input is required for rigging") == (
        "Connect a 3D model to this node, then run it again.")
    assert _line_beside("handlers/openai_image.py", "Prompt input is required but was not provided") == (
        "Connect a prompt to this node, then run it again.")


def test_rule_6_a_required_field_says_fill_it_in() -> None:
    assert _line_beside("handlers/krea.py", "Krea style_id is required") == (
        "Fill in “Style ID”, then run the node again.")


def test_rule_7_a_line_that_stops_before_sending_names_the_provider() -> None:
    assert _line_beside("services/krea_mcp_generation.py", "no job was submitted").endswith(
        "Nothing was sent to Krea.")
    assert _line_beside("services/krea_account.py", "does not offer {}; nothing was sent").startswith(
        "Your Krea connection doesn't offer what this node needs. Nothing was sent to Krea.")


def test_rule_10_an_unknown_model_says_pick_one() -> None:
    assert _line_beside("handlers/runway.py", "Unknown Runway video model") == (
        "This node's model isn't one Runway offers. Pick one in “Model”, then run the node again.")


def test_rule_9_units_and_names() -> None:
    assert _line_beside("services/typesafe_client.py", "is over TypeSafe's 16 MiB per-image limit") == (
        "{} {} is over TypeSafe's 16 MB limit for one image, even as a small JPEG. Connect a smaller image.")
    assert _line_beside("execution/maker_routes_minimax_meshy.py", "MiniMax makes 1080P clips") == (
        "MiniMax makes 1080p clips at 6 seconds only.")


# -- the card knows who answered (GM's general line under the heading) ---------


@pytest.mark.asyncio
async def test_a_run_error_with_no_line_says_which_provider_the_node_called() -> None:
    from execution.engine import execute_graph
    from models.events import ErrorEvent
    from models.graph import GraphNode

    from execution.person_line import with_api_status

    async def boom(node, inputs, api_keys):
        # Runway's API answered this run with a 400 the status table has no line for.
        raise with_api_status(RuntimeError("Runway task rejected: unsupported input"), 400)

    async def before_sending(node, inputs, api_keys):
        raise RuntimeError("worker exited before writing an output")

    for handler, provider in ((boom, "Runway"), (before_sending, None)):
        events: list[Any] = []

        async def emit(event: Any) -> None:
            events.append(event)

        node = GraphNode(id="n1", definitionId="runway-image", params={}, outputs={})
        await execute_graph(nodes=[node], edges=[], api_keys={"RUNWAY_API_KEY": "fixture"},
                            handler_registry={"runway-image": handler}, emit=emit, run_id=None)
        [error] = [event for event in events if isinstance(event, ErrorEvent)]
        assert error.person is None
        # The route the run took, never the text, and only when Runway answered
        # (review): a failure Runway never saw reads "open Details".
        assert error.provider == provider


@pytest.mark.asyncio
async def test_a_local_nodes_error_names_no_provider() -> None:
    from execution.engine import execute_graph
    from models.events import ErrorEvent
    from models.graph import GraphNode

    async def boom(node, inputs, api_keys):
        raise RuntimeError("Runway said no")  # a provider's name in the text is not who ran

    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    node = GraphNode(id="n1", definitionId="svg-rasterize", params={}, outputs={})
    await execute_graph(nodes=[node], edges=[], api_keys={}, handler_registry={"svg-rasterize": boom}, emit=emit,
                        run_id=None)
    [error] = [event for event in events if isinstance(event, ErrorEvent)]
    assert error.provider is None


def test_node_errors_keep_the_provider_for_the_card_only(tmp_path) -> None:
    from models.events import ErrorEvent
    from services.node_errors import NodeErrors

    errors = NodeErrors(tmp_path / "errors.json")
    errors.observe(ErrorEvent(node_id="n1", error="worker exited", category="unknown", friendly="worker exited",
                              provider="Runway"))
    assert NodeErrors(tmp_path / "errors.json").card("n1")["errorProvider"] == "Runway"
    assert "provider" not in (errors.get("n1") or {})


def test_a_validation_entry_saved_before_round_3e_reads_the_general_line(tmp_path) -> None:
    from services.node_errors import NodeErrors

    path = tmp_path / "errors.json"
    path.write_text(json.dumps({"version": 1, "projects": {"": {
        "n1": {"error": "Missing API key: OPENAI_API_KEY"}}}}))
    card = NodeErrors(path).card("n1")
    assert card["error"] == "Missing API key: OPENAI_API_KEY"
    assert card["errorCategory"] == "unknown"
    # Agents read the same text as before.
    assert NodeErrors(path).get("n1") == {"error": "Missing API key: OPENAI_API_KEY"}


# -- the proposal's missing list gets a person line ------------------------------


def test_a_proposals_missing_node_has_a_line_in_words(monkeypatch) -> None:
    import main
    from services.cli_graph import CLIGraph
    from services.node_registry import NodeRegistry

    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})

    class _NoKrea:
        def status(self):
            return {"status": "disconnected"}

    monkeypatch.setattr(main, "_krea_connector", lambda: _NoKrea())
    candidate = CLIGraph()
    candidate.nodes["n1"] = {"id": "n1", "definitionId": "gpt-image-2-generate", "params": {}, "label": None}
    rows = main._not_ready_nodes(candidate, [], ["n1"], {}, NodeRegistry().get_all())
    [row] = rows
    # Agents keep find_nodes' words.
    assert "OPENAI_API_KEY" in row["missing"]
    # The name in curly quotes (GM, PR #203 r20 item 3).
    assert row["person"] == "“GPT Image 2” needs your OpenAI API key. Add it in Settings."
    assert not re.search(r"[A-Z]{2,}_[A-Z_]+|\(|\)|>", row["person"])


# -- a full disk is told apart from the error's cause, not its words --------------


def test_a_project_store_error_from_a_full_disk_says_so(monkeypatch, tmp_path) -> None:
    import errno

    from fastapi.testclient import TestClient

    import main
    from services.project_store import ProjectStoreError

    def full(*_args, **_kwargs):
        try:
            raise OSError(errno.ENOSPC, "No space left on device")
        except OSError as exc:
            raise ProjectStoreError("Project storage is unavailable; the canvas was preserved") from exc

    monkeypatch.setattr(main.project_store, "transaction", full)
    response = TestClient(main.app).get("/api/projects")
    assert response.status_code == 507
    assert response.json()["detail"] == "Project storage is unavailable; the canvas was preserved"
    assert response.json()["storage"] == "full"

    def other(*_args, **_kwargs):
        raise ProjectStoreError("Project catalog cannot be read safely")

    monkeypatch.setattr(main.project_store, "transaction", other)
    response = TestClient(main.app).get("/api/projects")
    assert response.status_code == 507
    assert "storage" not in response.json()


def test_the_recovery_warnings_say_couldnt() -> None:
    strings = [node.value for node in ast.walk(ast.parse((BACKEND / "main.py").read_text()))
               if isinstance(node, ast.Constant) and isinstance(node.value, str)]
    assert any("Nebula captured this World Labs recovery ID but couldn't" in text for text in strings)
    assert not any("World Labs recovery ID but could not" in text for text in strings)
    assert not any("so it could not save it durably" in text for text in strings)


# -- review fixes (round 3f's confirmed findings) ---------------------------------


def test_a_field_label_written_into_a_card_line_sits_in_quotes() -> None:
    # Rule 5, structurally: a card line that writes a field's label from the
    # node definition (field_label, or krea's _label) puts it in quotes.
    # "Set Images to a whole number" was field_label without them.
    bare = []
    for path in _files():
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.JoinedStr):
                continue
            parts = node.values
            for index, part in enumerate(parts):
                if not (isinstance(part, ast.FormattedValue) and isinstance(part.value, ast.Call)):
                    continue
                func = part.value.func
                if (func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")) not in {
                        "field_label", "_label"}:
                    continue
                before = parts[index - 1] if index else None
                after = parts[index + 1] if index + 1 < len(parts) else None
                opens = isinstance(before, ast.Constant) and str(before.value).endswith("“")
                closes = isinstance(after, ast.Constant) and str(after.value).startswith("”")
                if not (opens and closes):
                    bare.append(f"{path.relative_to(BACKEND)}:{node.lineno}")
    assert not bare, bare


def test_review_rule_5_the_grok_reference_duration_line_quotes_duration() -> None:
    assert _line_beside("execution/maker_routes_xai.py", "Reference-to-video on {} runs up to {} seconds") == (
        "Reference-to-video on {} runs up to {} seconds. Set “Duration” to {} or less. {}")


def test_review_rule_5_reasoning_effort_and_thinking_level_are_quoted() -> None:
    from handlers.openai_chat import _listed_effort

    exc = _raised(_listed_effort, "gpt-6-astra", "none")
    assert str(exc) == "Reasoning effort 'none' isn't available for gpt-6-astra. Pick one of: low, medium, high, xhigh, max."
    assert person_line(exc) == ("GPT-6 Astra doesn't offer None for “Reasoning Effort”. "
                                "Pick Low, Medium, High, X-High or Max, then run the node again.")
    assert _line_beside("handlers/openai_chat.py", "Reasoning effort 'max' isn't available") == (
        "{} doesn't offer {} for “{}”. Pick another level, then run the node again.")
    assert _line_beside("handlers/google_gemini.py", "Thinking level '{}' isn't available") == (
        "{} doesn't offer {} for “{}”. Pick {}, then run the node again.")


@pytest.mark.asyncio
async def test_review_a_gemini_thinking_level_line_reads_the_nodes_own_labels(monkeypatch) -> None:
    # The level's label comes from the node's own field (thinkingLevel), not a
    # key it doesn't have: the card said "doesn't offer Thinking Level minimal".
    from handlers import google_gemini
    from models.graph import GraphNode, PortValueDict

    model = next(name for name, levels in google_gemini.GEMINI_CHAT_THINKING_LEVELS.items()
                 if levels is not None and "minimal" not in levels)

    async def no_network(*_args, **_kwargs):
        raise AssertionError("a refused level sends nothing")

    monkeypatch.setattr(google_gemini, "stream_execute", no_network, raising=False)
    node = GraphNode(id="n1", definitionId="gemini-chat", params={"model": model, "thinkingLevel": "minimal"},
                     outputs={})
    exc = await _araised(google_gemini.handle_gemini_chat, node,
                         {"messages": PortValueDict(type="Text", value="hi")}, {"GOOGLE_API_KEY": "fixture"})
    assert str(exc).startswith(f"Thinking level 'minimal' isn't available for {model}. Pick one of: ")
    line = person_line(exc)
    assert " doesn't offer Minimal for “Thinking Level”. Pick " in line, line
    assert "minimal" not in line


@pytest.mark.asyncio
async def test_review_rule_5_xai_quality_is_quoted() -> None:
    from handlers.xai_image import QUALITY_MODELS, handle_xai_image
    from models.graph import GraphNode, PortValueDict

    node = GraphNode(id="n1", definitionId="krea-image-xai-grok-imagine-2",
                     params={"model": "grok-imagine-image", "quality": "high"}, outputs={})
    exc = await _araised(handle_xai_image, node, {"prompt": PortValueDict(type="Text", value="a cat")},
                         {"XAI_API_KEY": "fixture"})
    assert str(exc) == f"xAI takes quality only on {', '.join(sorted(QUALITY_MODELS))}, not grok-imagine-image"
    assert person_line(exc).startswith("xAI takes “Quality” only on ")
    assert person_line(exc).endswith(". Clear “Quality”, then run the node again.")


def test_review_rule_5_the_prores_profile_is_its_label_with_option_labels() -> None:
    from execution.maker_routes_ideogram_runway import runway_ruby_request

    exc = _raised(runway_ruby_request, {"video_url": "https://example.com/v.mp4", "output_format": "hdr_prores",
                                        "prores_profile": "9999"})
    assert str(exc) == "ProRes profile must be one of 422, 4444, 422 HQ (received '9999')"
    assert person_line(exc) == "Set “Prores profile” to 422, 4444 or 422 HQ, then run the node again."


def test_review_rule_5_seedream_names_images_per_generation_in_quotes() -> None:
    from execution.maker_routes_byteplus import seedream_fal_to_byteplus
    from models.graph import GraphNode, PortValueDict

    node = GraphNode(id="n1", definitionId="seedream-4-5",
                     params={"model": "4.5", "image_size": "auto_2K", "max_images": 6}, outputs={})
    refs = PortValueDict(type="Image", value=[f"https://example.com/{n}.png" for n in range(10)])
    exc = _raised(seedream_fal_to_byteplus, node, {"images": refs})
    assert str(exc).startswith("BytePlus takes at most ")
    assert person_line(exc).endswith(
        "counting references and results. Use fewer references, or lower “Images per Generation”.")


def test_review_rule_5_an_image_count_names_the_nodes_own_field() -> None:
    from execution import maker_routes, maker_routes_openai, sync_runner
    from models.graph import GraphNode

    exc = _raised(maker_routes_openai.image_count, 9, "gpt-image-2-fal-generate")
    assert str(exc) == "num_images must be an integer from 1 to 4 (received 9)"
    assert person_line(exc) == "Set “Count” to a whole number from 1 to 4."
    # A node that doesn't show the field (Nano Banana's copies) says it in words.
    exc = _raised(maker_routes._image_count, 9, "nano-banana-2")
    assert person_line(exc) == "Set the number of images to a whole number from 1 to 4."
    exc = _raised(sync_runner._validate_ideogram_fal_params,
                  GraphNode(id="n1", definitionId="ideogram-v4", params={"num_images": 9}, outputs={}))
    assert str(exc) == "ideogram-v4 num_images must be an integer from 1 to 4 (received 9)"
    assert person_line(exc) == "Set “Images” to a whole number from 1 to 4."


def test_review_rule_5_ideograms_field_checks_quote_the_label() -> None:
    from handlers.ideogram import _boolean_field, _validate_enum, _validate_int_range
    from models.graph import GraphNode

    def node(params):
        return GraphNode(id="n1", definitionId="ideogram-transparent", params=params, outputs={})

    exc = _raised(_validate_int_range, node({"num_images": 9}), "num_images", 1, 8, "Ideogram num_images")
    assert str(exc) == "Ideogram num_images must be an integer from 1 to 8 (received 9)"
    assert person_line(exc) == "Set “Images” to a whole number from 1 to 8. It was 9."
    exc = _raised(_boolean_field, node({"num_images": "yes"}), {}, "num_images", "Ideogram num_images")
    assert person_line(exc) == "Set “Images” to on or off, then run the node again."
    exc = _raised(_validate_enum, node({"num_images": "x"}), "num_images", frozenset({"1"}), "Ideogram num_images")
    assert person_line(exc) == "Pick one of the node's “Images” options, then run the node again."


def test_review_rule_5_claudes_max_tokens_line_quotes_both_fields() -> None:
    from execution.person_line import field_label

    assert _line_beside("handlers/anthropic_chat.py", "before it wrote an answer ") == (
        "Claude ran out of “{}” before it wrote an answer. Raise “{}” or lower “{}”.")
    assert (field_label("claude-chat", "max_tokens"), field_label("claude-chat", "effort")) == ("Max Tokens", "Effort")


def test_review_rule_5_the_lines_the_label_guard_found_quote_their_fields() -> None:
    from handlers import worldlabs

    assert worldlabs.PERSON_LINES["both_recovery_ids"] == (
        "Fill in “Resume Operation ID” or “Existing World ID”, not both.")
    from handlers import jev_decide, jev_pick_best

    assert worldlabs.PERSON_LINES["bad_seed"] == (
        "Set “Seed” to a whole number from 0 to 4294967295, or clear it for a random seed.")
    assert jev_decide._fraction_line("threshold", "1") == "Set “Pass Threshold” to a number from 0 to 1."
    assert jev_decide._fraction_line("min_confidence", "1") == "Set “Minimum Confidence” to a number from 0 to 1."
    assert jev_pick_best._fraction_line("min_confidence", "1") == "Set “Minimum Confidence” to a number from 0 to 1."
    assert _line_beside("handlers/style_reference.py", "GOOGLE_API_KEY required for Auto mode") == (
        "Add your Gemini API key in Settings, then run the node again. Or set “Description Mode” to Manual or "
        "Image only, which need no key.")


def test_review_rule_9_vertex_is_vertex_ai_on_every_veo_line() -> None:
    assert _line_beside("execution/maker_routes_google.py", "On Vertex only Veo 3.1 (Standard) renders 4K") == (
        "On Vertex AI, only Veo 3.1 Standard renders 4K. Pick 1080p.")
    assert _line_beside("execution/maker_routes_google.py", "Vertex takes up to {} reference images") == (
        "Vertex AI takes up to {} reference images, and {} are connected. Disconnect the extra ones, then run the "
        "node again.")
    assert _line_beside("execution/maker_routes_google.py", "Vertex documents reference images as their own mode").startswith(
        "On Vertex AI, reference images are their own mode. Disconnect the start and end images, then run the ")
    assert _line_beside("handlers/veo.py", "On Vertex only Veo 3.1 (Standard) renders 4K") == (
        "On Vertex AI, only Veo 3.1 Standard renders 4K. Pick 1080p, or pick Veo 3.1.")


def test_review_rule_9_minimax_512p_is_lowercase_and_agents_keep_512P() -> None:
    from execution.maker_routes_minimax_meshy import krea_hailuo_to_minimax
    from models.graph import GraphNode

    translate = krea_hailuo_to_minimax("MiniMax-Hailuo-02")
    node = GraphNode(id="n1", definitionId="krea-video-minimax-hailuo-02",
                     params={"resolution": "512p", "prompt": "a cat"}, outputs={})
    exc = _raised(translate, node, {})
    assert "512P only from a start image" in str(exc)  # agents read it word for word
    assert person_line(exc).startswith(
        "MiniMax renders 512p only from a start image, without an end image. Connect a start image or pick 768p. ")


# -- the general line names a provider only when it answered (review finding 1) ---


def test_review_a_failure_before_sending_names_no_provider() -> None:
    from execution.provider_status import card_line

    # handlers/worldlabs.py refuses a saved model it doesn't list before any
    # request: nothing reached World Labs, so the card says "open Details".
    card = card_line(ValueError("Unknown World Labs model 'x'; pick one of the node's models"),
                     "worldlabs-environment", {"model": "x"}, {"WORLDLABS_API_KEY": "fixture"})
    assert card.person is None
    assert card.provider is None
    assert card_line(TypeError("bad"), "runway-image", {}, {"RUNWAY_API_KEY": "fixture"}).provider is None


def test_review_a_failure_the_provider_answered_names_the_route() -> None:
    import httpx

    from execution.person_line import as_job_failure, with_api_status, with_provider_line
    from execution.provider_status import card_line

    keys = {"WORLDLABS_API_KEY": "fixture"}
    answered = with_api_status(RuntimeError("World Labs generate failed (400): bad world"), 400)
    assert card_line(answered, "worldlabs-environment", {}, keys).provider == "World Labs"
    job = as_job_failure(RuntimeError("World Labs job failed: model crashed"))
    assert card_line(job, "worldlabs-environment", {}, keys).provider == "World Labs"
    said = with_provider_line(RuntimeError("World Labs said no"), "World Labs turned this down.")
    assert card_line(said, "worldlabs-environment", {}, keys).provider == "World Labs"
    # A download's own error (raise_for_status) is Nebula's, not the provider's
    # answer (provider_status docstring, 3): no provider, "open Details".
    request = httpx.Request("GET", "https://example.com/result.glb")
    download = httpx.HTTPStatusError("Server error '500'", request=request,
                                     response=httpx.Response(500, request=request))
    assert card_line(download, "worldlabs-environment", {}, keys).provider is None
