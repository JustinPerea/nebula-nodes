"""A node run error's line for the person (error copy round 3c, GM - Design).

A handler's exception text is the specific text: ids, record and parameter
names, what to call. Agents read it (MCP run results, the node's stored error,
the run record), so it stays exactly as it is. GM: "the person reads these on
the node, so their lines shouldn't carry ids or record names. ... The node's
error stores the specific text for agents (and the run record and MCP keep
it), and the canvas shows the written line. If a fact helps the person act,
put it in words, like "the node's Resume Operation ID field"."

So the handler attaches the person's line to the exception it raises
(``with_person_line``) and the engine carries it on the ErrorEvent as the
additive ``person`` field (execution/engine.py), beside ``error``. Only the
raised exception's own line counts: a wrapper that turns one failure into
another writes its own line, so a cause's line never leaks into a different
failure. A node error with no person line shows "Couldn't run the node." and
GM's general line on the card, the raw text behind "Details" (the frontend's
lib/nodeErrorCopy.ts).

The rule for every raise during a node's run (round 3c-2). GM's guard:
"provider run errors often carry the one fact the person needs ... Don't let
the general fallback hide them." A line Nebula wrote for the person is a
written line, so it never goes without a person line:

- The text is Nebula's own words for the person and names no id, file path,
  record name, env-var name, parameter key (snake_case) or provider text:
  ``raise as_person_line(ValueError("..."))``. The card shows the text itself.
- It names one of those: ``raise with_person_line(ValueError("..."), line)``
  with an id-free line that names the node's field by its label in
  node_definitions.json, or the input in words ("A connected image file
  can't be found."). ``missing_file_line`` and ``key_line`` are the shared
  ones; a plain "<KEY> is required" MissingCredentialError gets ``key_line``
  by itself (execution/missing_credential.py).
- A shared check that names its caller (route_clients' ``where``, which is
  the provider's model or endpoint id) puts the node's name on its provider
  on the card ("FLUX 3 Video on Replicate"), never the id:
  ``raise refuse(where, text, person_tail)`` with a ``Where``
  (execution/route_clients.py). No value the run was given (``{size!r}``)
  goes in a line.
- Provider text (a provider's body or message), malformed provider answers,
  timeouts the classifier names, moderation blocks (their own card) and
  developer-only states keep no line at the raise: the card says the
  classifier's line or GM's general line, with the raw text behind Details.
  Since round 3d the engine gives a provider's answer GM's line from one
  shared table (execution/provider_status.py: a rejected key, no credits,
  busy, trouble, an empty or malformed answer), naming the provider the node
  called, and keeps the raw text behind Details.
- A line of Nebula's own around a provider's words (a validator's message, a
  provider's reason) is ``with_provider_line(exc, line)``: the card shows the
  line and keeps the exception text behind Details. GM: "Raw provider text
  stays behind Details in every case."

GM's rules for every line: no ids, no parameter keys, no parentheses in error
copy, model names in their own spelling (round 3d strengthened the guard to
catch kebab-case and dated model ids and parentheses).

Either way the exception text stays word for word. A guard counts the raises
with no line (tests/test_error_copy_round3c2.py) in handlers/, execution/ and
the services a run raises from (its RUN_TIME_SERVICES; add a new one there): a
new raise in Nebula's own words without one fails it. A raise the guard can't
read (a re-raise of another exception's text) needs its own test.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from typing import TypeVar

_ATTRIBUTE = "nebula_person_line"
_PROVIDER_TEXT = "nebula_provider_text"

E = TypeVar("E", bound=BaseException)


def with_person_line(exc: E, line: str) -> E:
    """Attach the person's line to `exc` and return it (``raise with_person_line(...)``)."""
    setattr(exc, _ATTRIBUTE, line)
    return exc


def as_person_line(exc: E) -> E:
    """`exc`'s own text is already the person's line: the card shows it as it is."""
    return with_person_line(exc, str(exc))


def with_provider_line(exc: E, line: str) -> E:
    """The person's line for a failure whose exception text carries the
    provider's own words: the card shows ``line`` and keeps that text behind
    Details (round 3d)."""
    setattr(exc, _PROVIDER_TEXT, True)
    return with_person_line(exc, line)


def with_details_line(exc: E, line: str) -> E:
    """The person's line for a failure whose exception text carries a fact
    that belongs behind the card's Details, not in prose (a settings link,
    round 3f: GM "The URL goes behind Details or becomes a link, not prose"):
    the card shows ``line`` and keeps the text behind Details."""
    setattr(exc, _PROVIDER_TEXT, True)
    return with_person_line(exc, line)


def shows_details(exc: BaseException) -> bool:
    """The card keeps `exc`'s text behind Details beside its line
    (with_provider_line, with_details_line)."""
    return carries_provider_text(exc)


def person_line(exc: BaseException) -> str | None:
    """The person's line `exc` was raised with, or None (the card's fallback)."""
    line = getattr(exc, _ATTRIBUTE, None)
    return line.strip() if isinstance(line, str) and line.strip() else None


def carries_provider_text(exc: BaseException) -> bool:
    """`exc`'s line was written around the provider's own words (with_provider_line)."""
    return getattr(exc, _PROVIDER_TEXT, False) is True


# The provider's answer, as facts the raise knows (round 3d, part 2). GM's
# status table (execution/provider_status.py) reads these, never the text: a
# number in a provider's body or in Nebula's own words ("Prompt is too long:
# 500 characters over") is not a status, and a storage upload's 403 is not the
# provider refusing the key.
_API_STATUS = "nebula_api_status"
_JOB_FAILURE = "nebula_job_failure"


def with_api_status(exc: E, status: object) -> E:
    """The provider's own API, called with the person's key, answered this
    run with HTTP ``status``, and `exc` is raised for that answer. Attach it
    and return `exc` (``raise with_api_status(RuntimeError(...), resp.status_code)``).

    Not for a presigned or storage upload, a download of a result or an input,
    or any call that isn't the provider's API with the person's key: those
    raises say why with a ``# no API status:`` comment and keep today's line
    (tests/test_error_copy_round3d2.py's guard). A value that isn't an HTTP
    status attaches nothing."""
    if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
        setattr(exc, _API_STATUS, status)
    return exc


def api_status(exc: BaseException) -> int | None:
    """The HTTP status `exc` was raised with (with_api_status), or None."""
    value = getattr(exc, _API_STATUS, None)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def as_job_failure(exc: E) -> E:
    """`exc` is a terminal job failure: the provider took the job (submit and
    polling answered), then reported it failed, cancelled or expired. Its
    error is about the job (an input URL it couldn't fetch, a model crash),
    so the card never says the key, busy or trouble line for it, and the
    classifier never calls it ``auth``. Mark it where it is raised."""
    setattr(exc, _JOB_FAILURE, True)
    return exc


def is_job_failure(exc: BaseException) -> bool:
    """`exc` was raised as a terminal job failure (as_job_failure)."""
    return getattr(exc, _JOB_FAILURE, False) is True


def with_call_facts(exc: E, cause: BaseException) -> E:
    """`exc` rewrites `cause`'s text (a hint added for agents): it keeps what
    the call said, the provider's status and the job-failure mark, so the
    card reads the same. A person line never carries over (round 3c: a
    wrapper writes its own)."""
    status = api_status(cause)
    if status is not None:
        with_api_status(exc, status)
    if is_job_failure(cause):
        as_job_failure(exc)
    return exc


# A connected file's kind, in words (GM: "A connected {image|audio|video} file
# can't be found."), from what the input is called or the file's extension.
_KIND_WORDS = (
    ("image", ("image", "frame", "mask", "photo", "picture", "still", "thumbnail")),
    ("video", ("video", "clip", "footage")),
    ("audio", ("audio", "voice", "speech", "sound", "music", "dubbing", "song")),
)
_KIND_EXTENSIONS = {
    "image": {"png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif", "heic", "svg"},
    "video": {"mp4", "mov", "webm", "mkv", "avi", "m4v"},
    "audio": {"mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aiff", "aif"},
}


def _file_kind(what: str, value: object = None) -> str:
    words = what.strip().lower()
    for kind, names in _KIND_WORDS:
        if any(name in words for name in names):
            return kind
    if value is not None:
        suffix = str(value).rsplit("?", 1)[0].rsplit(".", 1)[-1].lower() if "." in str(value) else ""
        for kind, extensions in _KIND_EXTENSIONS.items():
            if suffix in extensions:
                return kind
    # The input's own name ("Mesh" -> "mesh"), less a trailing "file" or "input".
    name = re.sub(r"\b(file|input|media)\b", "", words).strip()
    return name or ""


def missing_file_line(what: str = "file", value: object = None) -> str:
    """A connected file that isn't there, named in words, never by its path.
    GM: "A connected {image|audio|video} file can't be found. Connect it
    again, then run the node again." ``what`` is the input ("image file",
    "Veo clip", "Dubbing audio"); ``value`` (the missing path) tells the kind
    by its extension when ``what`` doesn't."""
    kind = _file_kind(what, value)
    return f"A connected {kind + ' ' if kind else ''}file can't be found. Connect it again, then run the node again."


# How a person knows each key Settings stores: the provider's own spelling
# (frontend/src/lib/providerCatalog.ts labels), and what the key is called.
KEY_NAMES: dict[str, tuple[str, str]] = {
    "ANTHROPIC_API_KEY": ("Anthropic", "API key"),
    "BFL_API_KEY": ("Black Forest Labs", "API key"),
    "BYTEPLUS_API_KEY": ("BytePlus", "API key"),
    "ELEVENLABS_API_KEY": ("ElevenLabs", "API key"),
    "FAL_KEY": ("fal.ai", "API key"),
    "GOOGLE_API_KEY": ("Gemini", "API key"),
    "GOOGLE_VERTEX_CREDENTIALS": ("Google Vertex AI", "credentials"),
    "HIGGSFIELD_API_KEY": ("Higgsfield", "API key"),
    "IDEOGRAM_API_KEY": ("Ideogram", "API key"),
    "KREA_API_TOKEN": ("Krea", "API token"),
    "KREA_USAGE_KEY": ("Krea", "usage key"),
    "MESHY_API_KEY": ("Meshy", "API key"),
    "MINIMAX_API_KEY": ("MiniMax", "API key"),
    "OPENAI_API_KEY": ("OpenAI", "API key"),
    "OPENROUTER_API_KEY": ("OpenRouter", "API key"),
    "QUIVER_API_KEY": ("QuiverAI", "API key"),
    "REPLICATE_API_TOKEN": ("Replicate", "API token"),
    "RUNWAY_API_KEY": ("Runway", "API key"),
    "TYPESAFE_API_KEY": ("TypeSafe", "API key"),
    "WORLDLABS_API_KEY": ("World Labs", "API key"),
    "XAI_API_KEY": ("xAI", "API key"),
}


def _or_list(items: list[str]) -> str:
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} or {items[-1]}"


def key_phrase(keys: Iterable[str]) -> str | None:
    """"OpenAI API key", "ElevenLabs or Runway API key", "Google Vertex AI
    credentials or Gemini API key"; None when a name isn't a key Settings stores."""
    names = [KEY_NAMES.get(key) for key in keys]
    if not names or any(name is None for name in names):
        return None
    kinds = {kind for _provider, kind in names}  # type: ignore[misc]
    if len(kinds) == 1:
        return f"{_or_list([provider for provider, _kind in names])} {kinds.pop()}"  # type: ignore[misc]
    return _or_list([f"{provider} {kind}" for provider, kind in names])  # type: ignore[misc]


def key_line(keys: Iterable[str]) -> str | None:
    """The line for a run that stopped at its own key check."""
    phrase = key_phrase(keys)
    return f"Add your {phrase} in Settings, then run the node again." if phrase else None


def key_name(key: str) -> tuple[str, str] | None:
    """(provider, what the key is called) for a key Settings stores."""
    return KEY_NAMES.get(key)


# GM's lines for a provider's answer (round 3d), one table: the engine applies
# it (execution/provider_status.py) where the handler wrote no line.
# GM: "{Provider} didn't accept your API key. ..." The key's own name stands
# in for "API key" where Settings calls it something else ("API token",
# "credentials"), as the missing-key line does.
STATUS_LINES: dict[str, str] = {
    "key": "{provider} didn't accept your {credential}. Check {it} in Settings, then run the node again.",
    "credits": "Your {provider} account is out of credits. Add credits, then run the node again.",
    "busy": "{provider} is busy. Wait a moment, then run the node again.",
    "trouble": "{provider} is having trouble right now. Try again in a few minutes.",
    "no_result": "{provider} didn't return a result. Run the node again.",
    "missing": "Add your {provider} {credential} in Settings, then run the node again.",
}


def status_line(kind: str, provider: str, credential: str = "API key") -> str:
    """GM's line for ``kind`` (STATUS_LINES), naming ``provider``."""
    it = "them" if credential.endswith("s") else "it"
    return STATUS_LINES[kind].format(provider=provider, credential=credential, it=it)


def slow_job_line(provider: str) -> str:
    """A paid provider accepted the job and Nebula stopped waiting on it.
    GM (round 3f): ""Is taking longer than usual" suggests Nebula is still
    waiting, but it has stopped and the result won't come back to the canvas."""
    return (f"{provider} took too long, so Nebula stopped waiting. The job may still finish there and be billed, "
            f"so check {provider} before you run the node again.")


def download_line(provider: str) -> str:
    """A provider's result Nebula couldn't download (GM's rule 11, round 3f)."""
    return f"Couldn't download the result from {provider}. Its download link may have expired. Run the node again."


def unknown_model_line(provider: str, field: str = "Model") -> str:
    """The node's model isn't one the provider lists (GM's rule 10, round 3f)."""
    return f"This node's model isn't one {provider} offers. Pick one in “{field}”, then run the node again."


def no_result_line(provider: str) -> str:
    """The provider's answer had no result in it, or wasn't one (GM)."""
    return status_line("no_result", provider)


def or_list(items: Iterable[object]) -> str:
    """"a", "a or b", "a, b or c"."""
    words = [str(item) for item in items]
    return _or_list(words) if words else ""


def and_list(items: Iterable[object]) -> str:
    """"a", "a and b", "a, b and c"."""
    words = [str(item) for item in items]
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}" if words else ""


def _param(definition_id: str, key: str) -> dict | None:
    # The node registry, not execution.maker_routes: that imports the
    # handlers, and every module that raises a person line imports this one
    # (tests/test_node_readiness.py walks those imports for network calls).
    try:
        from services import node_route
        from services.node_registry import NodeRegistry

        definition = NodeRegistry().get_all().get(definition_id)
        return node_route.param_definition(definition, key) if definition else None  # type: ignore[return-value]
    except Exception:
        return None


def field_label(definition_id: str, key: str, default: str | None = None) -> str:
    """A field's label as the node shows it (node_definitions.json)."""
    param = _param(definition_id, key) or {}
    return str(param.get("label") or default or key)


def count_field(definition_id: str, key: str = "num_images") -> str:
    """The image-count field as the node shows it, in quotes (GM's rule 5:
    “Count”, “Images”, “Generations”), or "the number of images" in words
    for a node that doesn't show the field (Nano Banana's copies)."""
    label = str((_param(definition_id, key) or {}).get("label") or "").strip() if definition_id else ""
    return f"“{label}”" if label else "the number of images"


def option_label(definition_id: str, key: str, value: object) -> str | None:
    """How the node shows one of a field's options ("Claude Opus 5.5" for
    "claude-opus-5-5"), less any note in parentheses; None when the field
    doesn't list it."""
    param = _param(definition_id, key) or {}
    for option in param.get("options") or []:
        if isinstance(option, dict) and str(option.get("value")) == str(value):
            label = re.sub(r"\s*\([^)]*\)", "", str(option.get("label") or "")).strip()
            return label or None
    return None


def option_labels(definition_id: str, key: str, values: Iterable[object]) -> str:
    """Several of a field's options as the node shows them, "Low, Medium or
    High"; a value the field doesn't list stays as it is."""
    return or_list(option_label(definition_id, key, value) or value for value in values)


def it_was(value: object) -> str:
    """GM's rule for a value on the card: it goes in its own sentence, as the
    person set it ("Set Duration to whole seconds from 4 to 12. It was 3.5."),
    never in parentheses."""
    if isinstance(value, bool):
        return f"It was {'on' if value else 'off'}."
    if value is None or not str(value).strip():
        return "It was empty."
    text = " ".join(str(value).split())
    return f"It was {text if len(text) <= 40 else text[:39] + '…'}."


# A provider's model ids no node lists as one of its Model options, by the
# provider's own spelling (BytePlus's Seedance ids are dated; the Krea copies'
# models are the node itself).
_MODEL_NAMES = {
    "dreamina-seedance-2-5-260628": "Seedance 2.5", "dreamina-seedance-2-0-260128": "Seedance 2.0",
    "dreamina-seedance-2-0-fast-260128": "Seedance 2.0 Fast", "dreamina-seedance-2-0-mini-260615": "Seedance 2.0 Mini",
    "seedance-1-5-pro-251215": "Seedance 1.5 Pro", "seedance-1-0-pro-250528": "Seedance 1.0 Pro",
    "seedance-1-0-pro-fast-251015": "Seedance 1.0 Pro Fast",
    "MiniMax-Hailuo-02": "Hailuo 02", "MiniMax-Hailuo-2.3": "Hailuo 2.3", "MiniMax-Hailuo-2.3-Fast": "Hailuo 2.3 Fast",
    "grok-imagine-video": "Grok Imagine", "grok-imagine-video-1.5": "Grok Imagine 1.5",
    "grok-imagine-image-2.0": "Grok Imagine 2.0",
    "gpt-image-2": "GPT Image 2", "gpt-image-1.5": "GPT Image 1.5",
}


def model_name(model: object, definition_id: str | None = None, default: str = "This model") -> str:
    """A model's name for the card, never its id: the node's own Model option
    when it lists it, else the provider's spelling, else `default`."""
    if definition_id:
        label = option_label(definition_id, "model", model)
        if label:
            return label
    return _MODEL_NAMES.get(str(model), default)


def missing_key_line(keys: Iterable[str]) -> str:
    """The pre-run check's missing key (error copy round 3e): key_line, or,
    for a key Settings doesn't list by name, the same line without one."""
    return key_line(keys) or "Add this node's API key in Settings, then run the node again."


# An input said in words (GM's rule 6, round 3f: "Connect {a/an X in words} to
# this node, then run it again."). A label is lowercased word by word, except
# an acronym or a name ("SVG", "3D", "Krea"); a plural or a mass noun takes no
# article. A few labels read better as what they bring.
_INPUT_WORDS = {
    "prompt / guidance": "a prompt", "image(s)": "images", "model url": "a 3D model", "reference uri": "a reference",
    "krea 3d job": "a Krea 3D job", "krea job": "a Krea job", "extend video": "a video to extend",
    "edit video": "a video to edit", "continue session": "a session to continue",
}
_MASS_NOUNS = {"audio", "text", "context", "lighting", "media", "messages", "guidance"}
_NAMES = {"krea"}


def _words(name: str) -> str:
    words = []
    for word in name.split():
        keep = word.lower() in _NAMES or any(ch.isdigit() for ch in word) or word[1:] != word[1:].lower()
        words.append(word if keep else word.lower())
    return " ".join(words)


def _article(phrase: str) -> str:
    first = phrase.split()[0]
    if first.isupper() and len(first) > 1:  # an acronym is read letter by letter: "an SVG"
        return "an" if first[0] in "AEFHILMNORSX" else "a"
    return "an" if first[0].lower() in "aeiou" else "a"


def input_words(label: object) -> str:
    """An input's label in words for a line: "a prompt", "an image",
    "audio", "camera poses", "an SVG"."""
    raw = str(label or "").strip()
    known = _INPUT_WORDS.get(raw.lower())
    if known:
        return known
    name = re.sub(r"\s+(URL|URLs|uri)$", lambda m: "s" if m.group(1) == "URLs" else "", port_name(raw)).strip()
    if not name:
        return "the node's inputs"
    phrase = re.sub(r"\bRefs\b", "references", _words(name), flags=re.IGNORECASE)
    last = phrase.split()[-1].lower()
    if last in _MASS_NOUNS or (last.endswith("s") and not last.endswith("ss")):
        return phrase
    return f"{_article(phrase)} {phrase}"


def connect_line(label: object) -> str:
    """GM's rule 6 line for an input with no wire, from its label."""
    name = port_name(label)
    # A numbered or lettered input ("Item 1", "Image A") and a pass-through
    # are named by their label: "an item" wouldn't say which one.
    if re.search(r"\s(\d+|[A-Z])$", name) or name.lower() == "through":
        return f"Connect an output to “{name}”, then run the node again."
    return f"Connect {input_words(label)} to this node, then run it again."


def port_name(label: object) -> str:
    """An input's label as a line names it: a note in its parentheses
    ("Mask (white = edit)", "Images (1-4)") left out (GM: no parentheses)."""
    return re.sub(r"\s*\([^)]*\)", "", str(label or "")).strip()


def port_line(label: str) -> str:
    """A required input with no wire, before the run (error copy round 3e,
    in GM's rule 6 words since round 3f)."""
    return connect_line(label)


def joined_lines(lines: Iterable[str | None]) -> str | None:
    """Several checks' person lines on one card, in order, each once. None
    when any check has no line: the card then shows GM's general line with
    every specific text behind Details, so no check goes unsaid."""
    listed = list(lines)
    if not listed or any(not (line and line.strip()) for line in listed):
        return None
    kept: list[str] = []
    for line in listed:
        if line.strip() not in kept:  # type: ignore[union-attr]
            kept.append(line.strip())  # type: ignore[union-attr]
    return " ".join(kept)
