"""The `nebula` argument parser: errors that point to the right option.

GM's headless run (docs/agent-runs/2026-10-20-cli-headless.md) lost turns to
argparse's bare "unrecognized arguments": an agent reads the error, then
the whole help, then tries again. `NebulaArgumentParser` keeps argparse's
behaviour and adds three things (plan v2.7, PR26, §5.10.1):

- An error ends with "Did you mean ...?" from `difflib.get_close_matches`
  over that command's own options (hidden ones too) or subcommands.
- An error prints only that command's usage line. argparse reports a word
  a subcommand didn't take from the top parser, with the whole command tree
  as its usage; here it comes from the subcommand that was parsing.
- Hidden aliases for the commands MCP names differently: `nebula describe`
  runs `info` and `nebula find` runs `nodes`. They are rewritten before
  parsing, so they never show in `--help`.

A parser made with `start_hint=True` prints START_LINE above its help.
"""
from __future__ import annotations

import argparse
import contextvars
import difflib
import re
import sys
from typing import Any, Sequence

START_LINE = "New here? Start with `nebula context`: canvas, boards, node types and prices in one call."
# MCP's names for two commands (find_nodes, describe_node).
ALIASES = {"describe": "info", "find": "nodes"}

# The parsers entered while parsing one command line, outermost first.
_chain: contextvars.ContextVar[list["NebulaArgumentParser"] | None] = contextvars.ContextVar(
    "nebula_parser_chain", default=None)
_INVALID_CHOICE = re.compile(r"^argument (?P<name>.+?): invalid choice: '(?P<value>[^']*)'")
_UNRECOGNIZED = "unrecognized arguments: "


class NebulaArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args: Any, start_hint: bool = False, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.start_hint = start_hint

    # -- parsing -------------------------------------------------------------
    def parse_args(self, args: Sequence[str] | None = None, namespace: Any = None) -> Any:  # type: ignore[override]
        argv = list(sys.argv[1:] if args is None else args)
        token = _chain.set([])
        try:
            parsed, extras = self.parse_known_args(_resolve_aliases(argv, self), namespace)
            chain = list(_chain.get() or [])
        finally:
            _chain.reset(token)
        if extras:
            (chain[-1] if chain else self).error(_UNRECOGNIZED + " ".join(extras))
        return parsed

    def parse_known_args(self, args: Sequence[str] | None = None, namespace: Any = None):  # type: ignore[override]
        chain = _chain.get()
        if chain is not None:
            chain.append(self)
        return super().parse_known_args(args, namespace)

    # -- help and errors -----------------------------------------------------
    def format_help(self) -> str:
        text = super().format_help()
        return f"{START_LINE}\n\n{text}" if self.start_hint else text

    def error(self, message: str):  # type: ignore[override]
        message = self._with_suggestion(message)
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: {message}\n")

    def _option_strings(self) -> list[str]:
        return [option for action in self._actions for option in action.option_strings if option.startswith("--")]

    def _subcommands(self) -> list[str]:
        names: list[str] = []
        for action in self._actions:
            if isinstance(action, argparse._SubParsersAction):
                names.extend(action.choices)
        return names

    def _with_suggestion(self, message: str) -> str:
        invalid = _INVALID_CHOICE.match(message)
        if invalid:
            value = invalid.group("value")
            action = next((action for action in self._actions
                           if argparse._get_action_name(action) == invalid.group("name")), None)
            choices = [str(choice) for choice in (getattr(action, "choices", None) or [])]
            if isinstance(action, argparse._SubParsersAction) and self.prog == _root_prog(self):
                choices += list(ALIASES)
            close = difflib.get_close_matches(value, choices, n=2, cutoff=0.6)
            if isinstance(action, argparse._SubParsersAction):
                # The list of every command is the help's job, not the error's.
                where = f"`{self.prog} --help` lists them"
                head = f"argument {invalid.group('name')}: invalid choice: '{value}'"
                return f"{head}. Did you mean {_either(close)}?" if close else f"{head} ({where})"
            return f"{message}. Did you mean {_either(close)}?" if close else message
        if message.startswith(_UNRECOGNIZED):
            suggestions: list[str] = []
            for word in message[len(_UNRECOGNIZED):].split():
                if word.startswith("--"):
                    name = word.split("=", 1)[0]
                    suggestions += difflib.get_close_matches(name, self._option_strings(), n=1, cutoff=0.6)
                elif not word.startswith("-"):
                    suggestions += difflib.get_close_matches(word, self._subcommands(), n=1, cutoff=0.6)
            suggestions = list(dict.fromkeys(suggestions))
            if suggestions:
                return f"{message}. Did you mean {_either(suggestions)}?"
        return message


def _either(words: Sequence[str]) -> str:
    return " or ".join(words)


def _root_prog(parser: argparse.ArgumentParser) -> str:
    return parser.prog.split()[0]


def _resolve_aliases(argv: list[str], parser: argparse.ArgumentParser) -> list[str]:
    """`describe` → `info` and `find` → `nodes`, in the command's place only
    (after the top parser's own options, such as `--url URL`)."""
    takes_value = {option for action in parser._actions if action.option_strings and action.nargs != 0
                   for option in action.option_strings}
    index = 0
    while index < len(argv):
        word = argv[index]
        if word == "--":
            return argv
        if word.startswith("-"):
            index += 2 if word in takes_value else 1
            continue
        if word in ALIASES:
            return [*argv[:index], ALIASES[word], *argv[index + 1:]]
        return argv
    return argv


__all__ = ["ALIASES", "NebulaArgumentParser", "START_LINE"]
