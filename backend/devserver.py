"""Start the dev backend with a person link: `backend/.venv/bin/python backend/devserver.py`.

It makes this launch's person token (services/person_session.py) and prints
the link that connects a browser tab as you:

    http://localhost:5173/#nebula-person=<token>&backend=http://127.0.0.1:8000

With --open it opens that link in your default browser instead. The token
stays the same across --reload restarts, so an open tab stays connected
while you edit backend code.

The token never goes into an environment variable, argv or a file. The
reload supervisor (this process) keeps it in memory and hands it to each
worker inside the pickled server object multiprocessing sends over its pipe;
the worker gives it to person_session before the app is imported.

Residual, stated plainly: a program running as you with an unsandboxed shell
can still read the token (this process's memory, Chrome's on-disk Session
Storage and History). The person token stops agents that reach Nebula only
through its API, not those.
"""
from __future__ import annotations

import argparse
import sys
import webbrowser
from pathlib import Path

import uvicorn
from uvicorn.supervisors import ChangeReload

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import person_session  # noqa: E402


class PersonServer(uvicorn.Server):
    """A uvicorn server that gives the worker this launch's person token
    before the app (and its startup) runs."""

    def __init__(self, config: uvicorn.Config, person_token: str) -> None:
        super().__init__(config)
        self.person_token = person_token

    def run(self, sockets=None) -> None:
        person_session.provide(self.person_token)
        super().run(sockets=sockets)


def _parse(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Nebula dev backend with a person link.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--ui", default=None,
                        help="the canvas origin for the link (default: $NEBULA_DEV_UI_ORIGIN or http://localhost:5173)")
    parser.add_argument("--open", action="store_true", help="open the person link in the default browser")
    parser.add_argument("--no-reload", action="store_true", help="don't restart on backend code changes")
    return parser.parse_args(argv)


def announce(token: str, backend_origin: str, *, ui: str | None, open_browser: bool, stdout=None) -> str | None:
    """Print or open the person link. Returns the link (None if not shown)."""
    stdout = sys.stdout if stdout is None else stdout
    link = person_session.person_link(token, backend_origin, ui)
    if link is None:
        print("Nebula: no person link (the canvas or backend address isn't loopback). "
              "The canvas will run unverified.", file=stdout, flush=True)
        return None
    if open_browser:
        # `open` briefly holds the link in its argv, and the browser keeps it in
        # History; the page strips it from the address bar.
        webbrowser.open(link)
        print("Nebula: opened the canvas as you in your browser.", file=stdout, flush=True)
        return link
    if stdout.isatty():
        print(f"Nebula: open the canvas as you: {link}", file=stdout, flush=True)
        return link
    print("Nebula: no terminal to show the person link, so the canvas will run unverified "
          "(Settings, proposals and chats stay locked). Restart with --open, or from a terminal.",
          file=stdout, flush=True)
    return None


def main(argv: list[str] | None = None) -> None:
    args = _parse(argv)
    host = "127.0.0.1" if args.host in ("0.0.0.0", "") else args.host
    backend_origin = f"http://{f'[{host}]' if ':' in host else host}:{args.port}"
    token = person_session.new_token()
    # uvicorn.Config has no app_dir: BACKEND_DIR is on sys.path (above), and
    # each reload worker re-runs this module's top level, so it is there too.
    config = uvicorn.Config(
        "main:app", host=args.host, port=args.port,
        reload=not args.no_reload, reload_dirs=[str(BACKEND_DIR)],
    )
    server = PersonServer(config, token)
    announce(token, backend_origin, ui=args.ui, open_browser=args.open)
    if config.should_reload:
        sock = config.bind_socket()
        ChangeReload(config, target=server.run, sockets=[sock]).run()
    else:
        server.run()


if __name__ == "__main__":
    main()
