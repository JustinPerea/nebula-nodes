"""A copy lint over the strings a person reads, backend side.

The frontend half is frontend/scripts/check-copy.mjs. Both read
scripts/copy-lint-rules.json (rule names, the one line each rule says, the
allowlists, the source lists) and both run the cases in
scripts/copy-lint-cases.json, so the two implementations of a rule cannot
drift. The ratchet at the bottom scans the backend's person-facing strings and
fails on a violation the baseline (tests/copy_lint_baseline.json) doesn't
list, and on a baseline entry that no longer matches anything. The baseline
only shrinks: ``python tests/test_copy_lint.py --write-baseline`` removes
entries and lowers counts, never adds one.

Which backend strings a person reads:

- a call that attaches a person's line to an error (``as_person_line``,
  ``with_person_line``, ``with_provider_line``, ``with_details_line``) and a
  ``person=`` keyword (``ValidationErrorDetail(person=...)``);
- the prose strings in the modules that hold the person's lines (the
  ``backend.copyModules`` list in the rules file), apart from log lines,
  exceptions, comparisons and regular expressions.

Exempt, by the rules file: tests, scripts, the CLI (terminal output) and the
``cinema`` package (dev-only); the MCP server files and ``node_readiness``
(agent lines). A line in a mixed file can opt out with
``# copy-lint-ignore: <reason>`` (on the line, or alone on the line above), or
a block between ``# copy-lint-ignore-start: <reason>`` and
``# copy-lint-ignore-end``. A marker with no reason fails the check.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import pytest

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent
RULES_PATH = REPO / "scripts" / "copy-lint-rules.json"
CASES_PATH = REPO / "scripts" / "copy-lint-cases.json"
BASELINE_PATH = BACKEND / "tests" / "copy_lint_baseline.json"


def load_rules() -> dict[str, Any]:
    return json.loads(RULES_PATH.read_text(encoding="utf-8"))


# -- names -------------------------------------------------------------------------------------


def catalogue_names(rules: dict[str, Any], repo: Path = REPO) -> tuple[set[str], set[str]]:
    """(phrases, words): display names and brand words from the node catalogue and the provider list."""
    phrases: set[str] = set()
    words: set[str] = set()
    first_words: dict[str, int] = {}

    def clean(name: str) -> str:
        return re.sub(r"\s*\[[^\]]*\]", "", re.sub(r"\s*\([^)]*\)", "", name)).strip()

    def add_phrase(name: str) -> str:
        c = clean(name)
        if " " in c:
            phrases.add(c)
        return c

    def count_first(name: str) -> None:
        # A node's first word is a brand when it has a hump, a digit or is all capitals
        # (ElevenLabs, MiniMax, Hunyuan3D, FLUX). A plain word ("World", "Black", "Style") never
        # stands for a name alone; its whole phrase ("World Labs Marble") is matched instead.
        c = add_phrase(name)
        if c:
            first_words[c.split()[0]] = first_words.get(c.split()[0], 0) + 1

    defs_file = repo / "backend" / rules["backend"]["catalogueFile"]
    if defs_file.exists():
        for definition in json.loads(defs_file.read_text(encoding="utf-8")).values():
            if definition.get("apiProvider") != "utility" and isinstance(definition.get("displayName"), str):
                count_first(definition["displayName"])
            # The options of a model picker are model names ("GPT Image 2.5 Sunburst").
            for param in definition.get("params") or []:
                key = param.get("key", "")
                if key != "model" and not key.endswith("_model"):
                    continue
                for option in param.get("options") or []:
                    if isinstance(option.get("label"), str):
                        add_phrase(option["label"])
    for word in first_words:
        if re.search(r"[A-Z].*[A-Z]|\d", word):
            words.add(word)

    def name(n: str) -> None:
        # A one-word provider name is a name; the first word of a longer one ("World Labs") is not.
        c = add_phrase(n)
        if c and (" " not in c or re.search(r"[A-Z].*[A-Z]|\d", c.split()[0])):
            words.add(c.split()[0])

    for rel in rules["frontend"]["catalogueFiles"]:
        file = repo / "frontend" / rel
        if not file.exists():
            continue
        text = file.read_text(encoding="utf-8")
        for match in re.finditer(r"\blabel: '([^']+)'", text):
            for part in match.group(1).split("\u00b7"):
                name(part.strip())
        for match in re.finditer(r"\bbrand: \[([^\]]*)\]", text):
            for brand in re.finditer(r"'([^']+)'", match.group(1)):
                name(brand.group(1))
    return phrases, words


class Context:
    def __init__(self, rules: dict[str, Any], repo: Path = REPO) -> None:
        self.rules = rules
        phrases, words = catalogue_names(rules, repo)
        self.proper: set[str] = set()
        for name in [*rules["properNames"], *rules["initialisms"], *rules["modelWords"], *rules["calendarWords"]]:
            # A name of several words is stripped whole; only a one-word name lets its word through anywhere.
            if re.search(r"[\s-]", name):
                phrases.add(name)
            else:
                self.proper.add(name.lower())
        for word in words:
            self.proper.add(word.lower())
        self.phrases = sorted(phrases, key=len, reverse=True)
        # Key names count as names only as a key reference; some place and product names only after a verb.
        self.keys = {k.lower() for k in rules["keyNames"]}
        self.key_verbs = {v.lower() for v in rules["keyVerbs"]}
        self.gated = [({n.lower() for n in g["names"]}, [v.lower().split() for v in g["after"]],
                       bool(g.get("inParens")), bool(g.get("beforeLowerCase"))) for g in rules["gatedNames"]]
        self.retry = re.compile(rules["retryPattern"])
        self.units = set(rules["units"])


# -- the rules ---------------------------------------------------------------------------------

URL_RE = re.compile(r"https?://\S+|\b(?:localhost|127\.0\.0\.1)(?::\d+)?\S*")
CODE_RE = re.compile(r"`[^`]*`")
CURLY_SPAN_RE = re.compile("“[^”]*”")
TIME_RE = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")
RATIO_RE = re.compile(r"\b\d+(?::\d+)+\b")
WORD_RE = re.compile(r"[A-Za-z]")


def _has_lower_run(t: str) -> bool:
    """Two lower-case words in a row: the shape of a sentence, never of a Title Case label."""
    return bool(re.search(r"(?:^|[\s(])[a-z][a-z'\u2019]*\s+[a-z][a-z'\u2019]*(?:\s|$|[.,!?)])", t))


def is_sentence(text: str, rules: dict[str, Any]) -> bool:
    """A sentence ends in . ? or !, has a comma, or is long and runs lower-case words together; length alone doesn't make one."""
    t = text.strip()
    if not re.search(r"\s", t):
        return False
    # A comma inside parentheses ("Jev (TypeSafe, experimental)") does not make a sentence.
    if t[-1] in rules["sentence"]["endings"] or "," in re.sub(r"\([^)]*\)", "", t):
        return True
    return len(t) > rules["sentence"]["minLength"] and _has_lower_run(t)


def _strip_unit_parens(text: str, units: set[str]) -> str:
    return re.sub(r"\(([^()\s]{1,5})\)", lambda m: "" if m.group(1) in units else m.group(0), text)


def _named_here(low: str, prev: list[str], key_ref: bool, plus: bool, keycaps: bool, paren: bool,
                next_lower: bool, ctx: Context) -> bool:
    """Is this capitalised word a name where it stands? Key names and gated place or product names depend on context."""
    if low in ctx.keys and (key_ref or plus or keycaps or paren):
        return True
    return any(low in names and ((in_parens and paren) or (before_lower and next_lower)
                                 or any(prev[-len(v):] == v for v in verbs))
               for names, verbs, in_parens, before_lower in ctx.gated)


def _title_case_breaks(text: str, ctx: Context) -> bool:
    if re.match(r"e\.g\.", text, re.IGNORECASE):
        return False
    rest = text
    for phrase in ctx.phrases:
        rest = rest.replace(phrase, " ")
    rest = URL_RE.sub(" ", CODE_RE.sub(" ", CURLY_SPAN_RE.sub(" ", rest)))
    tokens = rest.split()
    bares = [re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$", "", t).lower() for t in tokens if re.search(r"[A-Za-z]", t) and not re.search(r"[/~]", t)]
    keycaps = bool(bares) and all(b in ctx.keys or b in ctx.key_verbs for b in bares)
    pending = True
    letter_words = 0
    hit = False
    prev: list[str] = []
    key_ref = False
    for i, token in enumerate(tokens):
        ends_sentence = bool(re.search(r"[.?!:]$", token))
        if not re.search(r"[A-Za-z]", token) or re.search(r"[/~]", token):
            if ends_sentence:
                pending = True
            continue
        letter_words += 1
        bare = re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$", "", token)
        if not pending:
            plus = (i > 0 and tokens[i - 1] == "+") or (i + 1 < len(tokens) and tokens[i + 1] == "+")
            paren = bool(re.search(r"^\(|\)$", token))
            next_lower = i + 1 < len(tokens) and bool(re.match(r"[a-z]", tokens[i + 1]))
            for part in re.split("[-‑]", bare):
                if (re.fullmatch(r"[A-Z][a-z]+", part) and part.lower() not in ctx.proper
                        and not _named_here(part.lower(), prev, key_ref, plus, keycaps, paren, next_lower, ctx)):
                    hit = True
        low = bare.lower()
        key_ref = low in ctx.key_verbs or (key_ref and (low in ctx.keys or low in ("or", "and")))
        prev.append(low)
        pending = ends_sentence
    return letter_words >= 2 and hit


def _raw_key(text: str, ctx: Context) -> bool:
    t = text.strip()
    if re.search(r"\s", t) or len(t) < 3:
        return False
    if t.lower() in ctx.proper:
        return False
    return bool(
        re.fullmatch(r"[a-z]+(?:[A-Z][a-z0-9]*)+", t)  # camelCase
        or re.fullmatch(r"[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+", t)  # PascalCase, two or more humps
        or re.fullmatch(r"[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+", t)  # snake_case
    )


def _code_like(t: str) -> bool:
    # A string that opens with a value reads as "{} ..." and is a sentence, not an object literal.
    if re.match(r"\{\}(?![}\]])", t):
        return bool(re.search(r"\[(?:aria|data|role|hidden|inert)[-\w]*[\]=]|:not\(|:scope|=>", t))
    return bool(re.match(r"[\[{]", t) or re.match(r"[:.#][\w-]", t)
                or re.search(r"\[(?:aria|data|role|hidden|inert)[-\w]*[\]=]|:not\(|:scope|=>", t))


def _key_shape(t: str) -> bool:
    """"sk-...", "r8_...", "AIza...": a short key prefix before the dots, no English word in it."""
    m = re.fullmatch(r"(\S+?)\.\.\.", t)
    if not m:
        return False
    prefix = m.group(1)
    # A prefix that ends in "-" or "_" ("sk-", "r8_", "ideogram_") is a key; a hump ("AIza") needs no English word in it.
    return bool(re.search(r"[_-]$", prefix)
                or (not re.search(r"[a-z]{5,}", prefix) and re.search(r"[a-z][A-Z]|[A-Z]{2}[a-z]", prefix)))


def check(text: str, kind: str, ctx: Context) -> list[str]:
    """The rules `text` breaks, in order. kind is "label" for a param or field label, else "text"."""
    hits: list[str] = []
    t = re.sub(r"\s+", " ", text).strip()
    if not t or not WORD_RE.search(t) or _code_like(t):
        return hits
    no_code = CODE_RE.sub(" ", t)
    no_url = URL_RE.sub(" ", no_code)
    if re.search(r"[\"']", no_url):
        hits.append("straight-quote")
    if "..." in no_url and not _key_shape(t):
        hits.append("three-dots")
    if "—" in no_code:
        hits.append("em-dash")
    if is_sentence(t, ctx.rules):
        plain = _strip_unit_parens(
            RATIO_RE.sub(" ", TIME_RE.sub(" ", CURLY_SPAN_RE.sub(" ", no_url))), ctx.units)
        if re.search(r"[;()]|:(?=\s|$)", plain):
            hits.append("sentence-punctuation")
    elif _title_case_breaks(no_code, ctx):
        hits.append("title-case")
    if kind == "label" and _raw_key(t, ctx):
        hits.append("raw-key-label")
    # A button or action label, not a finished sentence that happens to start with the word.
    if ctx.retry.search(t) and t[-1] not in ctx.rules["sentence"]["endings"]:
        hits.append("retry-button")
    return hits


# -- markers -----------------------------------------------------------------------------------

MARKER_RE = re.compile(r"#\s*copy-lint-ignore(-start|-end)?\b[:\s-]*(.*)$")


def read_markers(source: str) -> tuple[set[int], list[dict[str, Any]]]:
    exempt: set[int] = set()
    markers: list[dict[str, Any]] = []
    block_from: int | None = None
    for i, line in enumerate(source.split("\n"), start=1):
        m = MARKER_RE.search(line)
        if not m:
            continue
        kind, reason = m.group(1) or "", m.group(2).strip()
        if kind == "-end":
            if block_from is not None:
                exempt.update(range(block_from, i + 1))
            block_from = None
            continue
        markers.append({"line": i, "reason": reason, "ok": len(reason) >= 3})
        if kind == "-start":
            block_from = i
            continue
        exempt.add(i)
        if line.strip().startswith("#"):
            exempt.add(i + 1)
    return exempt, markers


# -- extraction --------------------------------------------------------------------------------

_SKIP_CALLEES = {
    "compile", "match", "search", "fullmatch", "sub", "subn", "findall", "finditer", "split", "startswith",
    "endswith", "replace", "get", "pop", "setdefault", "getattr", "hasattr", "setattr", "debug", "info",
    "warning", "error", "exception", "critical", "log", "print", "getLogger", "format_exc", "ValueError",
    "TypeError", "RuntimeError", "KeyError", "OSError", "Exception", "AssertionError", "NotImplementedError",
    "HTTPException", "join", "strip", "lstrip", "rstrip", "encode", "decode", "open", "Path", "environ", "getenv",
    "isinstance", "add_argument", "add_parser", "echo", "write", "field", "Field", "Query", "Header", "Depends",
}


def _callee(call: ast.Call) -> str:
    f = call.func
    return f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else "")


def _named_values(scope: ast.AST, name: str, module: bool) -> list[ast.AST]:
    """Values assigned to `name` (plain and annotated assignments): anywhere in a function, or at the top level of the module."""
    if module:
        body = getattr(scope, "body", [])
        nodes: list[ast.AST] = [n for n in body if isinstance(n, (ast.Assign, ast.AnnAssign))]
    else:
        nodes = [n for n in ast.walk(scope) if isinstance(n, (ast.Assign, ast.AnnAssign))]
    out: list[ast.AST] = []
    for sub in nodes:
        targets = sub.targets if isinstance(sub, ast.Assign) else [sub.target]
        if sub.value is not None and any(isinstance(t, ast.Name) and t.id == name for t in targets):
            out.append(sub.value)
    return out


def texts_of(node: ast.AST | None, scope: ast.AST | None = None, depth: int = 0, module: ast.AST | None = None) -> list[tuple[str, ast.AST]]:
    """[(text, origin node)] for a string, f-string, concatenation, choice, `.format()` call or name assigned a string.

    {} stands for a value. A name is looked up in the enclosing function first, then at the top level of
    the module; its origin is the assigned value, so a constant read from two places counts once."""
    if node is None or depth > 3:
        return []
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [(node.value, node)]
    if isinstance(node, ast.JoinedStr):
        return [("".join(p.value if isinstance(p, ast.Constant) else "{}" for p in node.values), node)]
    if isinstance(node, ast.IfExp):
        return texts_of(node.body, scope, depth, module) + texts_of(node.orelse, scope, depth, module)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = texts_of(node.left, scope, depth, module), texts_of(node.right, scope, depth, module)
        if len(left) == 1 and len(right) == 1:
            return [(left[0][0] + right[0][0], node)]
        return left + right
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
        return [(re.sub(r"%[sdrf]", "{}", t), n) for t, n in texts_of(node.left, scope, depth, module)]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format":
        return [(re.sub(r"\{[^{}]*\}", "{}", t), n) for t, n in texts_of(node.func.value, scope, depth, module)]
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
        # LINES["key"]: the dict's lines (the one for a constant key, else every value).
        out: list[tuple[str, ast.AST]] = []
        for where, is_module in ((scope, False), (module, True)):
            for table in ([] if where is None else _named_values(where, node.value.id, is_module)):
                if not isinstance(table, ast.Dict):
                    continue
                key = node.slice.value if isinstance(node.slice, ast.Constant) else None
                for k, v in zip(table.keys, table.values):
                    if key is None or (isinstance(k, ast.Constant) and k.value == key):
                        out += texts_of(v, scope, depth + 1, module)
            if out:
                return out
        return out
    if isinstance(node, ast.Name):
        for where, is_module in ((scope, False), (module, True)):
            if where is None:
                continue
            found = _named_values(where, node.id, is_module)
            if found:
                return [pair for value in found for pair in texts_of(value, scope, depth + 1, module)]
    return []


def template(node: ast.AST | None, scope: ast.AST | None = None, depth: int = 0, module: ast.AST | None = None) -> list[str]:
    return [t for t, _ in texts_of(node, scope, depth, module)]


def _docstring_ids(tree: ast.AST) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                ids.add(id(first.value))
    return ids


def _enclosing_function(tree: ast.AST, line: int) -> ast.AST:
    best: ast.AST = tree
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.lineno <= line <= (node.end_lineno or node.lineno):
            if best is tree or node.lineno > getattr(best, "lineno", 0):
                best = node
    return best


def extract_strings(source: str, rel: str, rules: dict[str, Any],
                    unresolved: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Every person-facing string in one file: [{text, kind, line, source}].

    `unresolved`, when given, collects the person-line arguments that resolved to no text."""
    tree = ast.parse(source)
    cfg = rules["backend"]
    parents: dict[int, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node
    found: list[dict[str, Any]] = []
    seen: set[int] = set()
    pushed: set[tuple[int, str]] = set()

    def push(text: str, node: ast.AST, origin: str) -> None:
        if (id(node), text) in pushed or not WORD_RE.search(text):
            return
        pushed.add((id(node), text))
        seen.add(id(node))
        found.append({"text": re.sub(r"\s+", " ", text).strip(), "kind": "text", "line": node.lineno, "source": origin})

    def mark(node: ast.AST) -> None:
        for sub in ast.walk(node):
            seen.add(id(sub))

    line_calls = set(cfg["lineCalls"])
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _callee(node)
        values: list[ast.AST] = []
        if name == "as_person_line" and node.args:
            inner = node.args[0]
            while isinstance(inner, ast.Call) and _callee(inner) in {"with_api_status", "as_job_failure", "with_call_facts"} and inner.args:
                inner = inner.args[0]
            if isinstance(inner, ast.Call) and inner.args:
                values.append(inner.args[0])
        elif name in line_calls and len(node.args) > 1:
            values.append(node.args[1])
        for keyword in node.keywords:
            if keyword.arg in cfg["personKeywords"] and keyword.value is not None:
                values.append(keyword.value)
            elif keyword.arg == "line" and name in line_calls:
                values.append(keyword.value)
        if not values:
            continue
        scope = _enclosing_function(tree, node.lineno)
        for value in values:
            resolved = [(t, n) for t, n in texts_of(value, None if scope is tree else scope, module=tree)
                        if t.replace("{}", "").strip()]
            for text, origin in resolved:
                push(text, origin, "person-line")
            if not resolved and unresolved is not None:
                unresolved.append({"file": rel, "line": value.lineno, "code": ast.unparse(value)})
            mark(value)

    if rel in cfg["copyModules"]:
        docs = _docstring_ids(tree)
        for node in ast.walk(tree):
            if id(node) in seen or id(node) in docs:
                continue
            if not (isinstance(node, ast.JoinedStr) or (isinstance(node, ast.Constant) and isinstance(node.value, str))):
                continue
            parent = parents.get(id(node))
            if isinstance(parent, ast.JoinedStr):
                continue
            if isinstance(parent, ast.Dict) and node in parent.keys:
                continue
            skip = False
            p: ast.AST | None = parent
            while p is not None and not isinstance(p, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Module, ast.ClassDef)):
                if isinstance(p, ast.Call) and _callee(p) in _SKIP_CALLEES:
                    skip = True
                if isinstance(p, (ast.Raise, ast.Compare, ast.Assert, ast.Subscript)):
                    skip = True
                if isinstance(p, ast.Call) and isinstance(p.func, ast.Name) and p.func.id == "as_person_line":
                    skip = False
                p = parents.get(id(p))
            if skip:
                continue
            for text in template(node):
                clean = re.sub(r"\s+", " ", text).strip()
                if re.search(r"\s", clean) or re.match(r"Retry", clean):
                    push(text, node, "copy-module")
    return found


# -- the scan ----------------------------------------------------------------------------------


def source_files(rules: dict[str, Any], backend: Path = BACKEND) -> list[str]:
    cfg = rules["backend"]
    out = []
    for root, dirs, files in os.walk(backend):
        here = Path(root).relative_to(backend)
        # Prune skipped folders (a copy module inside one is still read), and any hidden folder.
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and (
            d not in cfg["skipDirs"] or any(m.startswith((here / d).as_posix() + "/") for m in cfg["copyModules"])))
        for name in sorted(files):
            rel = (here / name).as_posix()
            if not name.endswith(".py") or name in cfg["skipFiles"] or name.startswith("test_"):
                continue
            if any(part in cfg["skipDirs"] for part in here.parts) and rel not in cfg["copyModules"]:
                continue
            out.append(rel)
    return sorted(out)


def scan(backend: Path = BACKEND, repo: Path = REPO, rules: dict[str, Any] | None = None,
         unresolved: list[dict[str, Any]] | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(violations, markers). `unresolved`, when given, collects person-line arguments that resolved to no text."""
    rules = rules or load_rules()
    ctx = Context(rules, repo)
    violations: list[dict[str, Any]] = []
    markers_seen: list[dict[str, Any]] = []
    for rel in source_files(rules, backend):
        source = (backend / rel).read_text(encoding="utf-8")
        exempt, markers = read_markers(source)
        markers_seen += [{"file": f"backend/{rel}", **m} for m in markers]
        try:
            strings = extract_strings(source, rel, rules, unresolved)
        except SyntaxError as exc:
            # A file the lint cannot read is a failure, never a silent skip.
            raise RuntimeError(f"copy lint could not parse backend/{rel}: {exc}") from exc
        for s in strings:
            if s["line"] in exempt:
                continue
            for rule in check(s["text"], s["kind"], ctx):
                violations.append({"file": f"backend/{rel}", "line": s["line"], "rule": rule, "text": s["text"]})
    return violations, markers_seen


# -- the baseline ------------------------------------------------------------------------------

_FAMILY = {
    "straight-quote": "straight-quotes", "three-dots": "three-dots", "em-dash": "em-dashes",
    "sentence-punctuation": "sentence-punctuation", "title-case": "title-case-labels",
    "raw-key-label": "raw-key-labels", "retry-button": "retry-buttons",
}


def family_of(rule: str, file: str) -> str:
    return _FAMILY.get(rule, rule)


def _key(e: dict[str, Any]) -> tuple[str, str, str]:
    return (e["file"], e["rule"], e["text"])


def tally(violations: list[dict[str, Any]]) -> dict[tuple[str, str, str], dict[str, Any]]:
    out: dict[tuple[str, str, str], dict[str, Any]] = {}
    for v in violations:
        k = _key(v)
        if k in out:
            out[k]["count"] += 1
            out[k]["lines"].append(v["line"])
        else:
            out[k] = {**{f: v[f] for f in ("file", "rule", "text")}, "count": 1, "lines": [v["line"]]}
    return out


def sort_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(entries, key=lambda e: (e["file"], e["rule"], e["text"]))


def read_baseline(path: Path = BASELINE_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"entries": []}


def write_baseline_file(entries: list[dict[str, Any]], path: Path = BASELINE_PATH) -> None:
    rows = []
    for e in sort_entries(entries):
        row = {"family": e["family"], "file": e["file"], "rule": e["rule"], "text": e["text"]}
        if e.get("count", 1) > 1:
            row["count"] = e["count"]
        rows.append(row)
    path.write_text(json.dumps({"entries": rows}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def compare(violations: list[dict[str, Any]], baseline: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(new violations, baseline entries that no longer match)."""
    today = tally(violations)
    base = {_key(e): e for e in baseline["entries"]}
    fresh = [{**t, "extra": t["count"] - base.get(k, {}).get("count", 1 if k in base else 0)}
             for k, t in today.items() if t["count"] > base.get(k, {}).get("count", 1 if k in base else 0)]
    stale = [{**e, "have": today.get(k, {}).get("count", 0)} for k, e in base.items()
             if today.get(k, {}).get("count", 0) < e.get("count", 1)]
    return fresh, stale


def shrink(violations: list[dict[str, Any]], baseline: dict[str, Any]) -> list[dict[str, Any]]:
    """The baseline after --write-baseline: entries the code no longer breaks go, counts that fell are lowered; nothing is added or raised."""
    today = tally(violations)
    kept = []
    for e in baseline["entries"]:
        count = min(e.get("count", 1), today.get(_key(e), {}).get("count", 0))
        if count > 0:
            kept.append({**e, "count": count})
    return kept


def seed(violations: list[dict[str, Any]], baseline: dict[str, Any]) -> list[dict[str, Any]]:
    if baseline["entries"]:
        raise RuntimeError("A baseline already exists. Adding an entry is a hand edit; --write-baseline only removes.")
    return [{**t, "family": family_of(t["rule"], t["file"])} for t in tally(violations).values()]


def format_failure(item: dict[str, Any], rules: dict[str, Any]) -> str:
    return f"{item['file']}:{item['lines'][-1] if 'lines' in item else item.get('line')} [{item['rule']}] {json.dumps(item['text'], ensure_ascii=False)}\n    {rules['rules'][item['rule']]}"


# -- tests -------------------------------------------------------------------------------------
# Lines below are the test suite, run by pytest; the rest of the file is the engine and the command.

RULES = load_rules()
CTX = Context(RULES)
CASES = json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]


def test_every_shared_case_gives_the_rules_it_lists():
    for case in CASES:
        assert check(case["text"], case["kind"], CTX) == case["rules"], case["text"]


def test_every_rule_has_a_failing_and_a_passing_example_in_the_shared_cases():
    for rule in RULES["rules"]:
        assert any(rule in c["rules"] for c in CASES), f"no failing case for {rule}"
        assert any(rule not in c["rules"] and c["text"] for c in CASES), f"no passing case for {rule}"


def test_every_rule_the_check_returns_is_named_in_the_rules_file():
    named = set(RULES["rules"])
    for case in CASES:
        assert set(check(case["text"], case["kind"], CTX)) <= named
    assert all(isinstance(w, str) and len(w) > 10 for w in RULES["rules"].values())


def test_a_catalogue_name_is_not_title_case():
    assert check("Open Nano Banana Pro", "text", CTX) == []
    assert check("Switch to ElevenLabs Music", "text", CTX) == []
    assert check("Switch To ElevenLabs Music", "text", CTX) == ["title-case"]


def _read(source: str, rel: str = "services/sample.py", copy_modules: tuple[str, ...] = ()) -> list[str]:
    rules = {**RULES, "backend": {**RULES["backend"], "copyModules": list(copy_modules)}}
    return [s["text"] for s in extract_strings(source, rel, rules)]


def test_person_line_calls_and_person_keywords_are_read():
    source = (
        "def f(exc):\n"
        "    line = 'Nebula can\\'t find it.' if exc else 'Pick another.'\n"
        "    raise with_person_line(ValueError('Agent text here'), line)\n"
        "def g():\n"
        "    raise as_person_line(ValueError(f'Needs {x} first.'))\n"
        "def h():\n"
        "    return ValidationErrorDetail(message='Agent text', person='Fill in \u201cSeed\u201d.')\n"
        "def i():\n"
        "    print('Plain words here')\n"
        "    raise ValueError('Developer words here')\n"
    )
    assert _read(source) == ["Nebula can't find it.", "Pick another.", "Needs {} first.", "Fill in \u201cSeed\u201d."]


def test_a_copy_module_is_read_apart_from_logs_errors_comparisons_regexes_and_docstrings():
    source = (
        '"""A docstring here."""\n'
        "import re\n"
        "LINE = 'Nothing ran here.'\n"
        "TABLE = {'a key here': 'Value words here.'}\n"
        "def f(a):\n"
        "    if a == 'two words':\n"
        "        return 1\n"
        "    logger.info('log words here')\n"
        "    re.compile('a b')\n"
        "    raise ValueError('Developer words here')\n"
        "    return f'Reloaded {a}.'\n"
    )
    assert _read(source, "commons/x.py", ("commons/x.py",)) == ["Nothing ran here.", "Value words here.", "Reloaded {}."]
    assert _read(source, "commons/x.py") == []


def test_a_line_kept_in_a_constant_a_format_call_or_a_table_is_read():
    source = (
        "GEMINI_LINE = 'Gemini can\\'t make it longer.'\n"
        "TYPED: str = 'Nebula can\\'t read {name}.'\n"
        "TABLE = {'a': 'Nebula can\\'t do a.', 'b': 'Nebula can\\'t do b.'}\n"
        "def f(exc):\n"
        "    raise with_person_line(exc, GEMINI_LINE)\n"
        "def g(exc):\n"
        "    raise with_person_line(exc, TYPED.format(name='x'))\n"
        "def h(exc):\n"
        "    raise with_person_line(exc, line=TABLE['a'])\n"
        "def i(exc, other):\n"
        "    raise with_person_line(exc, other)\n"
    )
    assert _read(source) == ["Gemini can't make it longer.", "Nebula can't read {}.", "Nebula can't do a."]
    unresolved: list[dict] = []
    extract_strings(source, "services/sample.py", RULES, unresolved)
    assert [u["code"] for u in unresolved] == ["other"]


def test_a_constant_read_from_two_places_counts_once():
    source = (
        "LINE = 'Nebula can\\'t do it.'\n"
        "def f(exc):\n"
        "    raise with_person_line(exc, LINE)\n"
        "def g(exc):\n"
        "    raise with_person_line(exc, LINE)\n"
    )
    assert _read(source, "commons/x.py", ("commons/x.py",)) == ["Nebula can't do it."]


def test_a_file_that_does_not_parse_fails_the_scan_with_its_name(tmp_path):
    (tmp_path / "services").mkdir()
    (tmp_path / "services" / "broken.py").write_text("def f(:\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="services/broken.py"):
        scan(backend=tmp_path)


def test_tests_scripts_the_cli_and_agent_files_are_not_scanned():
    files = source_files(RULES)
    assert not any(f.startswith(("tests/", "scripts/", "cli/", "cinema/")) for f in files)
    assert not any(f.endswith(("mcp_server.py", "node_readiness.py")) for f in files)
    assert "handlers/bfl.py" in files


def test_markers_exempt_a_line_a_line_below_and_a_block_and_need_a_reason():
    source = "\n".join([
        "a = 1  # copy-lint-ignore: shows the literal character",
        "# copy-lint-ignore: agent line",
        "b = 2",
        "c = 3",
        "# copy-lint-ignore-start: a block of agent lines",
        "d = 4",
        "# copy-lint-ignore-end",
        "# copy-lint-ignore",
    ])
    exempt, markers = read_markers(source)
    assert sorted(exempt) == [1, 2, 3, 5, 6, 7, 8, 9]
    assert [m["line"] for m in markers if not m["ok"]] == [8]


def test_a_marked_string_is_left_out_of_a_scan(tmp_path):
    (tmp_path / "services").mkdir()
    (tmp_path / "services" / "m.py").write_text(
        "def f():\n"
        "    raise as_person_line(ValueError(\"Can't one.\"))  # copy-lint-ignore: agent line\n"
        "def g():\n"
        "    raise as_person_line(ValueError(\"Can't two.\"))\n"
        "def h():\n"
        "    raise as_person_line(ValueError(\"Can't three.\"))  # copy-lint-ignore\n",
        encoding="utf-8")
    violations, markers = scan(backend=tmp_path)
    assert [v["text"] for v in violations] == ["Can't two."]
    assert [m["ok"] for m in markers] == [True, False]


def _v(text, line=1, rule="straight-quote", file="backend/services/a.py"):
    return {"file": file, "line": line, "rule": rule, "text": text}


def _e(text, count=None, rule="straight-quote"):
    return {"family": "straight-quotes", "file": "backend/services/a.py", "rule": rule, "text": text,
            **({"count": count} if count else {})}


def test_a_new_violation_and_a_repeat_beyond_the_count_fail():
    baseline = {"entries": [_e("Can't", 2)]}
    assert compare([_v("Can't"), _v("Can't", 5)], baseline)[0] == []
    fresh, _ = compare([_v("Can't"), _v("Can't", 5), _v("Can't", 9)], baseline)
    assert [f["extra"] for f in fresh] == [1]
    assert [f["text"] for f in compare([_v("Won't")], baseline)[0]] == ["Won't"]


def test_a_line_number_change_does_not_break_an_entry():
    fresh, stale = compare([_v("Can't", 400)], {"entries": [_e("Can't")]})
    assert fresh == [] and stale == []


def test_an_entry_that_matches_nothing_or_fewer_than_its_count_is_stale():
    _, stale = compare([_v("Can't")], {"entries": [_e("Can't", 2), _e("Gone")]})
    assert [(s["text"], s["have"]) for s in stale] == [("Can't", 1), ("Gone", 0)]


def test_write_baseline_drops_fixed_entries_and_lowers_counts_and_adds_or_raises_nothing():
    baseline = {"entries": [_e("Can't", 3), _e("Gone"), _e("Same")]}
    today = [_v("Can't"), _v("Can't", 2), _v("Same"), _v("Brand new"), _v("Same", 7), _v("Same", 8)]
    kept = {e["text"]: e["count"] for e in shrink(today, baseline)}
    assert kept == {"Can't": 2, "Same": 1}


def test_the_baseline_file_is_sorted_and_keeps_the_family(tmp_path):
    path = tmp_path / "baseline.json"
    write_baseline_file([_e("b"), _e("a", 2)], path)
    back = read_baseline(path)
    assert [e["text"] for e in back["entries"]] == ["a", "b"]
    assert back["entries"][0] == {"family": "straight-quotes", "file": "backend/services/a.py",
                                  "rule": "straight-quote", "text": "a", "count": 2}


def test_seeding_refuses_when_a_baseline_with_entries_exists():
    with pytest.raises(RuntimeError, match="hand edit"):
        seed([_v("x")], {"entries": [_e("y")]})
    assert len(seed([_v("x")], {"entries": []})) == 1


def test_the_backend_has_no_copy_violation_the_baseline_lacks_and_no_entry_that_matches_nothing():
    violations, markers = scan()
    fresh, stale = compare(violations, read_baseline())
    assert [f"{f['file']}:{f['lines'][0]} {f['text']}" for f in fresh] == [], "\n".join(
        format_failure(f, RULES) for f in fresh)
    assert [f"{s['file']} {s['text']}" for s in stale] == [], "a fixed string's entry must go: python tests/test_copy_lint.py --write-baseline"
    assert [m for m in markers if not m["ok"]] == []


def test_every_baseline_entry_names_a_family_and_a_known_rule():
    for entry in read_baseline()["entries"]:
        assert entry["family"] and entry["rule"] in RULES["rules"]


# -- the command -------------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Backend copy lint baseline tools")
    parser.add_argument("--write-baseline", action="store_true")
    parser.add_argument("--seed-baseline", action="store_true")
    args = parser.parse_args(argv)
    violations, _ = scan()
    baseline = read_baseline()
    if args.seed_baseline:
        write_baseline_file(seed(violations, baseline))
    elif args.write_baseline:
        write_baseline_file(shrink(violations, baseline))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
