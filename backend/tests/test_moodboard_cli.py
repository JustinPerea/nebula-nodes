"""Moodboards from the CLI and MCP (design-canvas gap 3, decision D6).

`nebula moodboard ...` and the MCP moodboard_* tools turn files, folders and
links into board images. Links are downloaded by the caller's process and
uploaded as bytes; the backend never fetches a URL for a board.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import ipaddress
import os
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import mcp_server
import moodboard_client as boards
from commons import net
from cli.__main__ import build_parser
from cli.client import NebulaClient
from cli.commands import moodboard as moodboard_cmd
from cli.commands import trash as trash_cmd
from nebula_api import NebulaAPI, NebulaAPIError


def _png(path: Path, color=(200, 80, 40), size=(24, 16)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path, format="PNG")
    return path


def _png_bytes(color=(10, 120, 200)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (20, 20), color).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def app(tmp_path, monkeypatch):
    import main as main_module

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    http = TestClient(main_module.app)
    client = NebulaClient("http://testserver")
    client._client = http
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=http))
    return client


# A public address to resolve test hosts to. Downloads go only to public
# addresses, so a real server on 127.0.0.1 can't stand in for the web.
PUBLIC_IP = ipaddress.ip_address("93.184.216.34")


def _public_resolver(host: str, port: int):
    """Like net.resolve_pinned, but every name is public: an address in the
    link still gets the real check."""
    if net.parse_literal_host(host) is not None:
        return net.resolve_pinned(host, port)
    return PUBLIC_IP


@pytest.fixture
def web(tmp_path, monkeypatch):
    """Links on a made-up public host, served from tmp_path/web."""
    root = tmp_path / "web"
    root.mkdir()

    def serve(request: httpx.Request) -> httpx.Response:
        # The fetcher connects to the address it checked and names the site in Host.
        assert request.url.host == str(PUBLIC_IP)
        assert request.headers["host"] == "images.example.com"
        file = root / request.url.path.lstrip("/")
        if not file.is_file():
            return httpx.Response(404)
        return httpx.Response(200, content=file.read_bytes(), headers={"content-type": "image/png"})

    download = boards.download_image
    monkeypatch.setattr(boards, "download_image", lambda url, transport=None, resolver=None: download(
        url, transport=httpx.MockTransport(serve), resolver=_public_resolver))
    return root, "https://images.example.com"


def _cli(client: NebulaClient, argv: list[str], capsys) -> str:
    args = build_parser().parse_args(argv)
    moodboard_cmd.run(client, args)
    return capsys.readouterr().out


def test_new_from_a_folder_and_a_link_then_set_analyze_and_delete(app, web, tmp_path, capsys, monkeypatch):
    folder = tmp_path / "refs"
    for name, color in (("10-last.png", (0, 0, 255)), ("2-second.png", (0, 255, 0)), ("1-first.png", (255, 0, 0))):
        _png(folder / name, color)
    (folder / "notes.txt").write_text("not an image")
    (folder / ".hidden.png").write_bytes(_png_bytes())
    web_root, base = web
    (web_root / "ref.png").write_bytes(_png_bytes((250, 140, 20)))

    out = _cli(app, ["moodboard", "new", "Nature + tech", str(folder), f"{base}/ref.png"], capsys)
    assert "with 4 images" in out
    board = boards.get_board(app.api, "nature + tech")
    images = board["images"]
    assert len(images) == 4
    # Every image is a Nebula upload: the backend was never handed the link.
    assert all(image["url"].startswith("/api/outputs/chat-uploads/") for image in images)
    assert not any(base in image["url"] for image in images)
    # Folder images in name order ("2" before "10"), then the link.
    folder_hashes = [_cli_hash(folder / name) for name in ("1-first.png", "2-second.png", "10-last.png")]
    assert [Path(image["url"]).stem for image in images[:3]] == folder_hashes

    _cli(app, ["moodboard", "analyze", board["id"]], capsys)
    assert boards.get_board(app.api, board["id"])["analysis"]

    out = _cli(app, ["moodboard", "set", board["id"], "--weight", "2=0.5", "--image-note", "4=the orange accent",
                     "--exclude", images[0]["id"], "--strength", "0.4"], capsys)
    assert "out of date" in out
    changed = boards.get_board(app.api, board["id"])
    assert changed["images"][1]["weight"] == 0.5
    assert changed["images"][3]["notes"] == "the orange accent"
    assert changed["images"][0]["excluded"] is True
    assert changed["strength"] == 0.4
    assert changed["analysis"] is None  # like Moodboard Studio: a changed board drops its old analysis

    out = _cli(app, ["moodboard", "analyze", board["id"]], capsys)
    assert "Palette:" in out

    out = _cli(app, ["moodboard", "set", board["id"], "--name", "Renamed"], capsys)
    assert boards.get_board(app.api, board["id"])["analysis"]  # a rename keeps it

    out = _cli(app, ["moodboard", "list", "--global"], capsys)
    assert board["id"] in out and "Renamed" in out

    # This Nebula has Recently deleted, so the CLI may delete: a restore undoes it.
    out = _cli(app, ["moodboard", "delete", "Renamed"], capsys)
    assert "Recently deleted" in out and f"nebula trash restore moodboard {board['id']}" in out
    with pytest.raises(boards.MoodboardError, match="no board"):
        boards.get_board(app.api, board["id"])
    assert trash_cmd.run_restore(app, ["moodboard", board["id"]]) == 0
    assert "Restored moodboard" in capsys.readouterr().out
    restored = boards.get_board(app.api, board["id"])
    assert restored["name"] == "Renamed" and len(restored["images"]) == 4


def _cli_hash(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_add_skips_images_already_on_the_board_and_remove_hands_back_the_url(app, tmp_path, capsys):
    first = _png(tmp_path / "a.png", (1, 2, 3))
    second = _png(tmp_path / "b.png", (4, 5, 6))
    board, _ = boards.create_board(app.api, "Board", [str(first)])

    out = _cli(app, ["moodboard", "add", board["id"], str(first), str(second)], capsys)
    assert "Added 1 image (1 already on the board, skipped)" in out
    images = boards.get_board(app.api, board["id"])["images"]
    assert len(images) == 2

    out = _cli(app, ["moodboard", "set", board["id"], "--remove", "1"], capsys)
    assert images[0]["url"] in out
    assert [image["url"] for image in boards.get_board(app.api, board["id"])["images"]] == [images[1]["url"]]


def test_a_bad_source_fails_before_anything_is_uploaded(app, tmp_path, capsys, monkeypatch):
    good = _png(tmp_path / "good.png")
    (tmp_path / "fake.png").write_text("not really a png")
    uploads = []
    original = boards._upload
    monkeypatch.setattr(boards, "_upload", lambda *a, **k: uploads.append(a) or original(*a, **k))

    with pytest.raises(SystemExit):
        _cli(app, ["moodboard", "new", "Nope", str(good), str(tmp_path / "fake.png")], capsys)
    assert "not a PNG, JPEG, GIF or WebP image" in capsys.readouterr().err
    assert uploads == []
    assert boards.list_boards(app.api) == []

    for source, message in (("ftp://example.com/x.png", "only http and https"),
                            (str(tmp_path / "missing.png"), "no such file or folder")):
        with pytest.raises(SystemExit):
            _cli(app, ["moodboard", "new", "Nope", source], capsys)
        assert message in capsys.readouterr().err
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(boards.MoodboardError, match="no PNG, JPEG, GIF or WebP images"):
        boards.create_board(app.api, "Nope", [str(empty)])


def test_set_refuses_out_of_range_values_and_unknown_images(app, tmp_path):
    board, _ = boards.create_board(app.api, "Board", [str(_png(tmp_path / "a.png"))])
    with pytest.raises(boards.MoodboardError, match="weight must be from 0 to 1"):
        boards.update_board(app.api, board["id"], images=[{"image": 1, "weight": 3}])
    with pytest.raises(boards.MoodboardError, match="no image '7'"):
        boards.update_board(app.api, board["id"], images=[{"image": 7, "weight": 0.5}])
    with pytest.raises(boards.MoodboardError, match="mode must be one of"):
        boards.update_board(app.api, board["id"], mode="vibes")
    with pytest.raises(boards.MoodboardError, match="nothing to change"):
        boards.update_board(app.api, board["id"])


def test_a_nebula_output_is_used_as_is(app, tmp_path):
    from services.output import OUTPUT_ROOT

    picture = _png(OUTPUT_ROOT / "moodboard-cli-tests" / "out.png")
    url = "/api/outputs/moodboard-cli-tests/out.png"
    board, _ = boards.create_board(app.api, "From outputs", [url])
    assert [image["url"] for image in board["images"]] == [url]
    with pytest.raises(boards.MoodboardError, match="no such output"):
        boards.create_board(app.api, "Missing", ["/api/outputs/moodboard-cli-tests/nope.png"])
    picture.unlink()


def test_board_in_the_open_project(app, tmp_path, monkeypatch):
    monkeypatch.setattr(boards, "active_project", lambda api, headers=None: "proj_open")
    board, _ = boards.create_board(app.api, "Here", [str(_png(tmp_path / "a.png"))], project="current")
    assert board["projectId"] == "proj_open"
    listed = boards.list_boards(app.api, project="proj_open", include_global=False)
    assert [b["id"] for b in listed] == [board["id"]]


# -- downloads ---------------------------------------------------------------------

def _transport(handler):
    return httpx.MockTransport(handler)


def test_download_refuses_what_isnt_a_small_http_image():
    png = _png_bytes()

    def serve(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/ok.png":
            return httpx.Response(200, content=png, headers={"content-type": "image/png"})
        if path == "/page":
            return httpx.Response(200, content=b"<html></html>", headers={"content-type": "text/html"})
        if path == "/liar.png":
            return httpx.Response(200, content=b"<html>" * 10, headers={"content-type": "image/png"})
        if path == "/huge-declared.png":
            return httpx.Response(200, content=png, headers={"content-type": "image/png",
                                                            "content-length": str(boards.MAX_IMAGE_BYTES + 1)})
        if path == "/huge.png":
            return httpx.Response(200, content=png + b"\0" * boards.MAX_IMAGE_BYTES,
                                  headers={"content-type": "image/png"})
        if path == "/to-file":
            return httpx.Response(302, headers={"location": "file:///etc/passwd"})
        if path == "/hop":
            return httpx.Response(302, headers={"location": "/ok.png"})
        if path == "/loop":
            return httpx.Response(302, headers={"location": "/loop"})
        return httpx.Response(404)

    transport = _transport(serve)
    get = partial(boards.download_image, transport=transport, resolver=_public_resolver)
    name, data, content_type = get("https://example.com/ok.png")
    assert (name, data, content_type) == ("ok.png", png, "image/png")
    assert get("https://example.com/hop")[1] == png

    for path, message in (("/page", r"not an image \(text/html\)"), ("/liar.png", "isn't a PNG"),
                          ("/huge-declared.png", "over 20 MB"), ("/huge.png", "over 20 MB"),
                          ("/to-file", r"won't download this link \(scheme not allowed"),
                          ("/loop", r"won't download this link \(too many redirects\)"),
                          ("/gone", "answered 404")):
        with pytest.raises(boards.MoodboardError, match=message):
            get(f"https://example.com{path}")
    for url in ("file:///etc/passwd", "ftp://example.com/a.png", "https:///nohost.png"):
        with pytest.raises(boards.MoodboardError, match="only http and https"):
            get(url)


def test_download_times_out():
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(boards.MoodboardError, match="timed out"):
        boards.download_image("https://example.com/slow.png", transport=_transport(slow), resolver=_public_resolver)


def test_download_never_reaches_this_computer_or_a_private_network():
    # The security fix: a link can't make this process (the MCP server runs
    # outside an in-app agent's sandbox) fetch from this machine, its
    # network, or a cloud metadata address. No request is sent.
    sent = []

    def record(request: httpx.Request) -> httpx.Response:
        sent.append(str(request.url))
        return httpx.Response(200, content=_png_bytes(), headers={"content-type": "image/png"})

    transport = _transport(record)
    for url in ("http://127.0.0.1/a.png", "http://[::1]/a.png", "http://169.254.169.254/latest/meta-data",
                "http://10.0.0.5/a.png", "http://192.168.1.1/a.png", "http://[::ffff:127.0.0.1]/a.png",
                "http://[fe80::1]/a.png", "http://0.0.0.0/a.png"):
        with pytest.raises(boards.MoodboardError, match="this computer or a private network"):
            boards.download_image(url, transport=transport)
    # A name that resolves to a private address, and other spellings of an address.
    with pytest.raises(boards.MoodboardError, match="this computer or a private network"):
        boards.download_image("http://internal.example/a.png", transport=transport,
                              resolver=lambda host, port: ipaddress.ip_address("10.1.2.3"))
    for url in ("http://2130706433/a.png", "http://0x7f.1/a.png"):
        with pytest.raises(boards.MoodboardError, match="won't download this link"):
            boards.download_image(url, transport=transport)
    # Only the usual web ports, and no user name or password in the link.
    for url in ("https://example.com:8443/a.png", "https://user:pw@example.com/a.png"):
        with pytest.raises(boards.MoodboardError, match="won't download this link"):
            boards.download_image(url, transport=transport, resolver=_public_resolver)
    assert sent == []


def test_a_redirect_to_a_private_address_is_refused_before_it_is_followed():
    sent = []

    def serve(request: httpx.Request) -> httpx.Response:
        sent.append(request.url.path)
        target = {"/to-loopback.png": "http://127.0.0.1/api/settings",
                  "/to-metadata.png": "http://169.254.169.254/latest/meta-data/"}[request.url.path]
        return httpx.Response(302, headers={"location": target})

    for path in ("/to-loopback.png", "/to-metadata.png"):
        with pytest.raises(boards.MoodboardError, match="this computer or a private network"):
            boards.download_image(f"https://example.com{path}", transport=_transport(serve),
                                  resolver=_public_resolver)
    assert sent == ["/to-loopback.png", "/to-metadata.png"]


def test_a_real_server_on_this_computer_gets_no_request(tmp_path):
    # End to end with the real network stack: nothing connects.
    hits = []

    class Recording(SimpleHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            super().do_GET()

        def log_message(self, *args):
            pass

    (tmp_path / "a.png").write_bytes(_png_bytes())
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Recording, directory=str(tmp_path)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for host in ("127.0.0.1", "localhost"):
            with pytest.raises(boards.MoodboardError, match="won't download this link|this computer or a private"):
                boards.download_image(f"http://{host}:{server.server_address[1]}/a.png")
    finally:
        server.shutdown()
        server.server_close()
    assert hits == []


def test_download_works_inside_a_running_event_loop():
    # FastMCP calls sync tools on its event loop; the download still runs.
    def serve(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_png_bytes(), headers={"content-type": "image/png"})

    async def inside_a_loop():
        return boards.download_image("https://example.com/a.png", transport=_transport(serve),
                                     resolver=_public_resolver)

    assert asyncio.run(inside_a_loop())[2] == "image/png"


def test_the_backend_has_no_url_fetching_for_boards(app):
    # A link handed to the backend directly stays a string: it isn't downloaded.
    board = app.api.request("POST", "/api/moodboards", json={
        "name": "Direct", "images": [{"url": "https://example.com/never-fetched.png"}]})
    assert board["images"][0]["url"] == "https://example.com/never-fetched.png"


# -- agents' local files -----------------------------------------------------------

def test_an_in_app_turn_reads_only_its_own_workspace(app, tmp_path, monkeypatch):
    from services import agent_workspaces

    workspace = tmp_path / "ws"
    workspace.mkdir()
    _png(workspace / "inside.png")
    outside = _png(tmp_path / "outside.png")
    monkeypatch.setattr(agent_workspaces, "active_workspace", lambda: workspace)
    monkeypatch.setattr(agent_workspaces, "workspace_deny_roots", lambda workdir=None: [])

    assert boards.expand_sources(["inside.png"]) == [("file", str((workspace / "inside.png").resolve()))]
    with pytest.raises(boards.MoodboardError, match="outside this chat's workspace"):
        boards.expand_sources([str(outside)])


def _in_app_workspace(tmp_path, monkeypatch):
    from services import agent_workspaces

    workspace = tmp_path / "ws"
    workspace.mkdir()
    monkeypatch.setattr(agent_workspaces, "active_workspace", lambda: workspace)
    monkeypatch.setattr(agent_workspaces, "workspace_deny_roots", lambda workdir=None: [])
    return workspace


def test_a_link_inside_a_folder_cant_reach_past_the_workspace(app, tmp_path, monkeypatch):
    # The security fix: each image found in a folder gets the same checks as
    # a file named on its own.
    workspace = _in_app_workspace(tmp_path, monkeypatch)
    _png(workspace / "refs" / "1-inside.png")
    outside = _png(tmp_path / "private" / "photo.png")
    (workspace / "refs" / "2-link.png").symlink_to(outside)
    with pytest.raises(boards.MoodboardError, match="outside this chat's workspace"):
        boards.expand_sources(["refs"])
    with pytest.raises(boards.MoodboardError, match="outside this chat's workspace"):
        boards.create_board(app.api, "Nope", ["refs"])
    assert boards.list_boards(app.api) == []
    # A link that stays inside the workspace is fine.
    (workspace / "refs" / "2-link.png").unlink()
    (workspace / "refs" / "2-link.png").symlink_to(workspace / "refs" / "1-inside.png")
    assert len(boards.expand_sources(["refs"])) == 2


def test_a_file_swapped_for_a_link_after_the_check_is_not_read(app, tmp_path, monkeypatch):
    workspace = _in_app_workspace(tmp_path, monkeypatch)
    inside = _png(workspace / "inside.png")
    outside = _png(tmp_path / "private" / "photo.png", (1, 2, 3))
    [(kind, checked)] = boards.expand_sources(["inside.png"])
    inside.unlink()
    inside.symlink_to(outside)
    with pytest.raises(boards.MoodboardError, match="outside this chat's workspace"):
        boards._read_local_image(Path(checked), "inside.png")


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="needs O_NOFOLLOW")
def test_a_folder_swapped_for_a_link_between_check_and_open_fails_the_read(tmp_path, monkeypatch):
    # The narrowest race: the path passes its checks, then a folder on it
    # becomes a link before the open. The open follows no links, so it fails.
    folder = tmp_path / "refs"
    picture = _png(folder / "a.png")
    elsewhere = _png(tmp_path / "elsewhere" / "a.png", (5, 5, 5)).parent
    checked = picture.resolve()

    def swap_then_return(source):
        folder.rename(tmp_path / "refs-old")
        folder.symlink_to(elsewhere)
        return checked

    monkeypatch.setattr(boards, "_local_path", swap_then_return)
    with pytest.raises(boards.MoodboardError, match="a link took its place"):
        boards._read_local_image(checked, "refs/a.png")


# -- MCP -----------------------------------------------------------------------------

def _tool(name: str):
    return next(tool for tool in mcp_server.mcp._tool_manager.list_tools() if tool.name == name)


def test_mcp_tools_make_change_analyze_and_delete_a_board(app, web, tmp_path):
    web_root, base = web
    (web_root / "a.png").write_bytes(_png_bytes((9, 9, 9)))
    local = _png(tmp_path / "b.png", (90, 30, 30))

    made = asyncio.run(mcp_server.moodboard_create("Agent board", [f"{base}/a.png", str(local)], mode="world",
                                                   strength=0.5))
    assert made["mode"] == "world" and len(made["images"]) == 2
    assert all(image["url"].startswith("/api/outputs/chat-uploads/") for image in made["images"])

    added = asyncio.run(mcp_server.moodboard_add(made["id"], [str(local)]))
    assert added["added"] == 0 and added["duplicatesSkipped"] == 1

    updated = mcp_server.moodboard_update(made["id"], images=[{"image": 2, "weight": 0.25, "excluded": True}])
    assert updated["images"][1]["weight"] == 0.25 and updated["images"][1]["excluded"] is True

    analyzed = mcp_server.moodboard_analyze(made["id"])
    assert analyzed["analysis"]["palette"]
    assert mcp_server.moodboard_get("agent board")["id"] == made["id"]
    assert [b["id"] for b in mcp_server.moodboard_list(project_id="none")] == [made["id"]]

    with pytest.raises(RuntimeError, match="no image '9'"):
        mcp_server.moodboard_update(made["id"], remove=["9"])

    # This Nebula has Recently deleted: the delete is restorable, with the same id.
    deleted = mcp_server.moodboard_delete(made["id"])
    assert deleted["restorable"] is True and deleted["status"] == "trashed"
    with pytest.raises(RuntimeError, match="no board"):
        mcp_server.moodboard_get(made["id"])
    mcp_server._api().request("POST", f"/api/trash/moodboard/{made['id']}/restore")
    assert mcp_server.moodboard_get(made["id"])["id"] == made["id"]


def test_mcp_tool_annotations_say_what_each_one_does():
    for name in ("moodboard_list", "moodboard_get"):
        assert _tool(name).annotations.readOnlyHint is True
    for name in ("moodboard_create", "moodboard_add"):
        annotations = _tool(name).annotations
        assert annotations.readOnlyHint is False and annotations.openWorldHint is True  # they fetch links
        assert annotations.destructiveHint is False
    assert _tool("moodboard_update").annotations.destructiveHint is False
    assert _tool("moodboard_delete").annotations.destructiveHint is True


def test_cli_help_lists_the_moodboard_verbs():
    parser = build_parser()
    action = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
    verbs = action.choices["moodboard"]._actions[-1].choices
    assert set(verbs) == {"list", "show", "new", "add", "set", "analyze", "delete"}


def test_mcp_tools_run_off_the_event_loop_without_errors(app, tmp_path):
    # FastMCP calls sync tools directly; make sure the call path works through call_tool too.
    local = _png(tmp_path / "c.png")

    async def go():
        return await mcp_server.mcp.call_tool("moodboard_create", {"name": "Via call_tool", "sources": [str(local)]})

    result = asyncio.run(go())
    assert "Via call_tool" in str(result)


# -- agents may do what can be undone -------------------------------------------------

def test_nothing_in_the_client_deletes_a_board_for_good(app, tmp_path, capsys, monkeypatch):
    # On a Nebula without Recently deleted (an older backend, no /api/trash) a
    # delete can't be undone, so the CLI and MCP refuse for everyone, with
    # what to do instead. The client never decides who the person is (a
    # terminal, a typed name or an unset agent name proves nothing).
    board, _ = boards.create_board(app.api, "Keep me", [str(_png(tmp_path / "a.png"))])
    deletes = []
    original = NebulaAPI.request

    def older_backend(self, method, path, **kw):
        if method == "DELETE":
            deletes.append(path)
        if method == "GET" and path == "/api/trash":
            raise NebulaAPIError("Not Found", status=404)
        return original(self, method, path, **kw)

    # On the class: the CLI and the MCP server each make their own NebulaAPI.
    monkeypatch.setattr(NebulaAPI, "request", older_backend)
    monkeypatch.setattr(moodboard_cmd.sys.stdin, "isatty", lambda: True, raising=False)
    monkeypatch.setattr(moodboard_cmd.sys.stdout, "isatty", lambda: True, raising=False)
    monkeypatch.setattr("builtins.input", lambda prompt="": "Keep me")
    for agent in (None, "Claude Code"):
        if agent:
            monkeypatch.setenv("NEBULA_AGENT_NAME", agent)
        with pytest.raises(SystemExit):
            _cli(app, ["moodboard", "delete", board["id"]], capsys)
        err = capsys.readouterr().err
        assert "Moodboard Studio" in err and "--remove" in err
    with pytest.raises(boards.MoodboardError, match="Moodboard Studio"):
        boards.delete_board(app.api, board["id"])
    with pytest.raises(Exception, match="Moodboard Studio"):
        asyncio.run(mcp_server.mcp.call_tool("moodboard_delete", {"board": board["id"]}))
    assert deletes == []
    assert boards.get_board(app.api, board["id"])["name"] == "Keep me"


class _TrashAPI:
    """A Nebula with Recently deleted: DELETE moves a board there."""

    def __init__(self, board):
        self.board = board
        self.calls = []

    def request(self, method, path, **kwargs):
        self.calls.append((method, path))
        if method == "GET" and path == "/api/trash":
            return {"items": []}
        if method == "GET" and path == f"/api/moodboards/{self.board['id']}":
            return self.board
        if method == "DELETE":
            return {"status": "trashed", "id": self.board["id"], "trashed": {"id": self.board["id"]}}
        raise AssertionError((method, path))


def test_where_deletes_can_be_undone_agents_may_delete(capsys, monkeypatch):
    board = {"id": "mb_1", "name": "Old refs", "images": []}
    api = _TrashAPI(board)
    result = boards.delete_board(api, "mb_1")
    assert result["restorable"] is True and ("DELETE", "/api/moodboards/mb_1") in api.calls

    # An agent's CLI (no terminal, agent name set) may too: a restore undoes it.
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(NebulaClient, "api", property(lambda self: api))
    moodboard_cmd.run(NebulaClient("http://testserver"), build_parser().parse_args(["moodboard", "delete", "mb_1"]))
    out = capsys.readouterr().out
    assert "Recently deleted" in out and "nebula trash restore moodboard mb_1" in out


def test_a_change_hands_back_what_puts_it_back(app, tmp_path):
    board, _ = boards.create_board(app.api, "Undo me", [str(_png(tmp_path / "a.png")), str(_png(tmp_path / "b.png", (1, 1, 1)))],
                                   notes="the person's notes", strength=0.7)
    before = boards.get_board(app.api, board["id"])
    _, _, previous = boards.update_board(app.api, board["id"], notes="agent notes", strength=0.2, mode="world",
                                         images=[{"image": 2, "weight": 0.1, "excluded": True, "notes": "x"}])
    boards.update_board(app.api, board["id"], name=previous["name"], notes=previous["notes"], mode=previous["mode"],
                        strength=previous["strength"], images=previous["images"])
    after = boards.get_board(app.api, board["id"])
    for key in ("name", "notes", "mode", "strength"):
        assert after[key] == before[key]
    strip = lambda images: [{k: image[k] for k in ("id", "url", "weight", "notes", "excluded")} for image in images]
    assert strip(after["images"]) == strip(before["images"])


def test_add_keeps_an_edit_made_while_it_downloaded(app, tmp_path, monkeypatch):
    first = _png(tmp_path / "a.png", (1, 2, 3))
    second = _png(tmp_path / "b.png", (4, 5, 6))
    board, _ = boards.create_board(app.api, "Busy", [str(first)])
    original = boards.source_urls

    def slow_download(api, sources, **kwargs):
        # Meanwhile the person sets a weight in Moodboard Studio.
        image = boards.get_board(app.api, board["id"])["images"][0]
        app.api.request("PUT", f"/api/moodboards/{board['id']}",
                        json={"images": [{**image, "weight": 0.3}]})
        return original(api, sources, **kwargs)

    monkeypatch.setattr(boards, "source_urls", slow_download)
    updated, added, _ = boards.add_to_board(app.api, board["id"], [str(second)])
    assert added == 1
    assert updated["images"][0]["weight"] == 0.3 and len(updated["images"]) == 2

def test_an_in_app_turns_workspace_reaches_the_mcp_tools_worker_thread(app, tmp_path):
    # moodboard_create/add work off the event loop; the turn's workspace
    # scope (a context variable) must still confine what they read.
    from services.agent_workspaces import workspace_scope

    workspace = tmp_path / "ws"
    workspace.mkdir()
    outside = _png(tmp_path / "outside.png")

    async def go():
        return await mcp_server.mcp.call_tool("moodboard_create", {"name": "Scoped", "sources": [str(outside)]})

    with workspace_scope(workspace):
        with pytest.raises(Exception, match="outside this chat's workspace"):
            asyncio.run(go())
    assert boards.list_boards(app.api) == []


# -- the brief: Direction, Avoid, pinned colours and the override (#73 x #76) ---------
# Agents used to read analysis.styleBrief as the board's brief, but generators
# get what services/moodboard_brief.compose makes of the board: the override
# when there is one, Direction and pinned colours, Avoid in the negatives.

def _person_override(board_id: str, text: str) -> None:
    """Write a hand-written brief as the person would, in Moodboard Studio."""
    from services.moodboard_store import MoodboardStore

    MoodboardStore().update(board_id, by="person", briefOverride={"text": text})


def _analyzed_board(app, tmp_path, name="Brief board"):
    board, _ = boards.create_board(app.api, name, [str(_png(tmp_path / f"{name}.png", (232, 89, 60)))])
    boards.analyze_board(app.api, board["id"])
    return boards.get_board(app.api, board["id"])


def test_brief_carries_the_board_fields_and_the_brief_generators_get(app, tmp_path):
    board = _analyzed_board(app, tmp_path)
    boards.update_board(app.api, board["id"], direction="Quiet coastal mornings", avoid_add=["neon signage"],
                        pin_colors=["#E8593C"], keep_out_colors=["#00f"])
    out = boards.brief(boards.get_board(app.api, board["id"]))
    assert out["direction"] == "Quiet coastal mornings"
    assert out["avoid"] == ["neon signage"]
    assert out["pinnedColors"] == {"include": ["#e8593c"], "exclude": ["#0000ff"]}
    assert out["briefOverride"] is None
    # The composed brief, exactly as the backend computed it.
    from services.moodboard_brief import compose
    assert out["brief"] == compose(boards.get_board(app.api, board["id"]))
    assert out["brief"]["styleBrief"].startswith("Quiet coastal mornings.")
    assert "neon signage" in out["brief"]["negativePrompt"]
    assert out["analysis"]  # brief fields don't clear the analysis


def test_brief_never_passes_the_analysis_off_as_the_brief_on_an_older_backend():
    # An older Nebula sends no computed `brief`: say so (null), never fall
    # back to analysis.styleBrief.
    old = {"id": "mb_old", "name": "Old", "images": [], "analysis": {"styleBrief": "analysis text"}}
    out = boards.brief(old)
    assert out["brief"] is None
    assert out["briefOverride"] is None and out["direction"] is None


def test_brief_says_whose_override_it_is_and_whether_it_is_stale(app, tmp_path):
    board = _analyzed_board(app, tmp_path)
    boards.update_board(app.api, board["id"], brief_override="An agent's own brief.")
    out = boards.brief(boards.get_board(app.api, board["id"]))
    assert out["briefOverride"]["text"] == "An agent's own brief."
    assert out["briefOverride"]["by"] == "agent"
    assert out["briefOverride"]["stale"] is False and out["briefOverride"]["updatedAt"]
    assert out["brief"]["styleBrief"] == "An agent's own brief."
    assert out["brief"]["override"] == {"active": True, "stale": False}

    boards.update_board(app.api, board["id"], direction="Something new")
    out = boards.brief(boards.get_board(app.api, board["id"]))
    assert out["briefOverride"]["stale"] is True

    # Keep: the agent may clear the stale badge on its own text.
    kept, _, _ = boards.update_board(app.api, board["id"], keep_brief=True)
    assert boards.brief(kept)["briefOverride"]["stale"] is False

    other = _analyzed_board(app, tmp_path, "Person board")
    _person_override(other["id"], "The person's words.")
    assert boards.brief(boards.get_board(app.api, other["id"]))["briefOverride"]["by"] == "person"


def test_update_board_sets_and_clears_direction_and_adds_and_removes_avoid(app, tmp_path):
    board = _analyzed_board(app, tmp_path)
    updated, _, _ = boards.update_board(app.api, board["id"], direction="  Warm dusk  ",
                                        avoid_add=["neon signage", "lens flare", "Neon Signage"])
    assert updated["direction"] == "Warm dusk"
    assert updated["avoid"] == ["neon signage", "lens flare"]
    assert updated["analysis"]  # brief fields survive: they aren't analysis inputs

    updated, _, _ = boards.update_board(app.api, board["id"], avoid_remove=["LENS FLARE"], avoid_add=["text"])
    assert updated["avoid"] == ["neon signage", "text"]
    updated, _, _ = boards.update_board(app.api, board["id"], avoid=["only this"])
    assert updated["avoid"] == ["only this"]
    updated, _, _ = boards.update_board(app.api, board["id"], direction="", avoid=[])
    assert updated["direction"] == "" and updated["avoid"] == []

    with pytest.raises(boards.MoodboardError, match="isn't on the Avoid list"):
        boards.update_board(app.api, board["id"], avoid_remove=["never added"])


def test_update_board_pins_and_unpins_colours(app, tmp_path):
    board = _analyzed_board(app, tmp_path)
    updated, _, _ = boards.update_board(app.api, board["id"], pin_colors=["#E8593C", "abc"],
                                        keep_out_colors=["#123456"])
    assert updated["pinnedColors"] == {"include": ["#e8593c", "#aabbcc"], "exclude": ["#123456"]}
    assert updated["analysis"]
    updated, _, _ = boards.update_board(app.api, board["id"], unpin_colors=["#ABC", "#123456"])
    assert updated["pinnedColors"] == {"include": ["#e8593c"], "exclude": []}
    updated, _, _ = boards.update_board(app.api, board["id"],
                                        pinned_colors={"include": [], "exclude": ["#e8593c"]})
    assert updated["pinnedColors"] == {"include": [], "exclude": ["#e8593c"]}

    with pytest.raises(boards.MoodboardError, match="isn't a pinned"):
        boards.update_board(app.api, board["id"], unpin_colors=["#010101"])


@pytest.mark.parametrize("kwargs, message", [
    ({"avoid_add": [f"item {n}" for n in range(41)]}, "at most 40"),
    ({"avoid_add": ["x" * 201]}, "200 characters"),
    ({"pin_colors": ["red"]}, "not a hex colour"),
    ({"pin_colors": [f"#{n:06x}" for n in range(13)]}, "at most 12"),
    ({"pin_colors": ["#e8593c"], "keep_out_colors": ["#E8593C"]}, "both"),
    ({"direction": "d" * 4001}, "4000 characters"),
    ({"brief_override": "b" * 20001}, "20000 characters"),
])
def test_update_board_refuses_what_the_backend_would_and_never_truncates(app, tmp_path, kwargs, message):
    board = _analyzed_board(app, tmp_path)
    with pytest.raises(boards.MoodboardError, match=message):
        boards.update_board(app.api, board["id"], **kwargs)
    after = boards.get_board(app.api, board["id"])
    assert after["avoid"] == [] and after["direction"] == "" and after["briefOverride"] is None
    assert after["pinnedColors"] == {"include": [], "exclude": []}


def test_update_board_sets_and_clears_an_agents_override(app, tmp_path):
    board = _analyzed_board(app, tmp_path)
    updated, _, _ = boards.update_board(app.api, board["id"], brief_override="Hand-tuned brief.")
    assert updated["brief"]["styleBrief"] == "Hand-tuned brief."
    assert updated["analysis"]
    updated, _, _ = boards.update_board(app.api, board["id"], brief_override="")
    assert updated["briefOverride"] is None
    assert updated["brief"]["styleBrief"] == updated["brief"]["generatedStyleBrief"] != ""


def test_an_agent_is_told_plainly_it_cant_change_the_persons_brief(app, tmp_path, capsys):
    board = _analyzed_board(app, tmp_path)
    _person_override(board["id"], "The person's words.")
    for kwargs in ({"brief_override": "mine now"}, {"brief_override": ""}, {"keep_brief": True}):
        with pytest.raises(boards.MoodboardError, match="The person wrote this board's brief by hand") as caught:
            boards.update_board(app.api, board["id"], **kwargs)
        assert "This tab isn't" not in str(caught.value)
    with pytest.raises(SystemExit):
        _cli(app, ["moodboard", "set", board["id"], "--brief", "mine now"], capsys)
    err = capsys.readouterr().err
    assert err.startswith("error: The person wrote this board's brief by hand") and "Traceback" not in err
    with pytest.raises(Exception, match="The person wrote this board's brief by hand"):
        asyncio.run(mcp_server.mcp.call_tool("moodboard_update", {"board": board["id"], "brief_override": "x"}))
    assert boards.get_board(app.api, board["id"])["briefOverride"]["text"] == "The person's words."


def test_brief_field_changes_hand_back_what_puts_them_back(app, tmp_path):
    board = _analyzed_board(app, tmp_path)
    boards.update_board(app.api, board["id"], direction="Before", avoid_add=["a"], pin_colors=["#111111"],
                        brief_override="Agent text before.")
    before = boards.get_board(app.api, board["id"])
    _, _, previous = boards.update_board(app.api, board["id"], direction="After", avoid_add=["b"],
                                         unpin_colors=["#111111"], keep_out_colors=["#222222"],
                                         brief_override="Agent text after.")
    assert previous["direction"] == "Before" and previous["avoid"] == ["a"]
    assert previous["pinned_colors"] == {"include": ["#111111"], "exclude": []}
    assert previous["brief_override"] == "Agent text before."
    restored, _, _ = boards.update_board(app.api, board["id"], **previous)
    for key in ("direction", "avoid", "pinnedColors"):
        assert restored[key] == before[key]
    assert restored["briefOverride"]["text"] == "Agent text before."
    # Undoing a brief-only change keeps the analysis.
    assert restored["analysis"]

    # No override before: previous clears the agent's new one.
    fresh = _analyzed_board(app, tmp_path, "Fresh")
    _, _, previous = boards.update_board(app.api, fresh["id"], brief_override="New agent text.")
    assert previous["brief_override"] == ""
    restored, _, _ = boards.update_board(app.api, fresh["id"], **previous)
    assert restored["briefOverride"] is None


def test_previous_never_makes_a_restore_trip_on_the_persons_brief(app, tmp_path):
    board = _analyzed_board(app, tmp_path)
    _person_override(board["id"], "The person's words.")
    _, _, previous = boards.update_board(app.api, board["id"], direction="Agent direction", avoid_add=["x"])
    assert "brief_override" not in previous
    restored, _, _ = boards.update_board(app.api, board["id"], **previous)
    assert restored["direction"] == "" and restored["avoid"] == []
    assert restored["briefOverride"]["text"] == "The person's words."


def test_cli_set_and_show_the_brief(app, tmp_path, capsys):
    import json

    board = _analyzed_board(app, tmp_path)
    out = _cli(app, ["moodboard", "set", board["id"], "--direction", "Quiet coastal mornings",
                     "--avoid", "neon signage", "--avoid", "lens flare", "--pin-color", "#E8593C",
                     "--keep-out-color", "#0000ff", "--json"], capsys)
    data = json.loads(out)
    assert data["direction"] == "Quiet coastal mornings"
    assert data["avoid"] == ["neon signage", "lens flare"]
    assert data["pinnedColors"] == {"include": ["#e8593c"], "exclude": ["#0000ff"]}
    assert data["brief"]["styleBrief"].startswith("Quiet coastal mornings.")
    assert data["previous"]["direction"] == "" and data["previous"]["avoid"] == []
    assert data["analysis"]

    _cli(app, ["moodboard", "set", board["id"], "--unavoid", "lens flare", "--unpin-color", "#0000FF"], capsys)
    data = json.loads(_cli(app, ["moodboard", "show", board["id"], "--json"], capsys))
    assert data["avoid"] == ["neon signage"] and data["pinnedColors"]["exclude"] == []
    assert data["brief"]["negativePrompt"] == "blurry, low-detail artifacts, neon signage"

    shown = _cli(app, ["moodboard", "show", board["id"]], capsys)
    assert "Direction: Quiet coastal mornings" in shown
    assert "Avoid: neon signage" in shown
    assert "#e8593c" in shown
    assert "Brief sent to generators (generated)" in shown
    assert data["brief"]["styleBrief"] in shown
    assert "Negative prompt: blurry, low-detail artifacts, neon signage" in shown
    # The analysis's own text isn't shown as the brief.
    analysis_brief = boards.get_board(app.api, board["id"])["analysis"]["styleBrief"]
    assert analysis_brief not in shown

    _cli(app, ["moodboard", "set", board["id"], "--brief", "My own brief.", "--direction", "Changed"], capsys)
    shown = _cli(app, ["moodboard", "show", board["id"]], capsys)
    assert "Brief sent to generators (written by an agent)" in shown and "My own brief." in shown
    _cli(app, ["moodboard", "set", board["id"], "--direction", "Changed again"], capsys)
    shown = _cli(app, ["moodboard", "show", board["id"]], capsys)
    assert "changed since" in shown and "--keep-brief" in shown
    _cli(app, ["moodboard", "set", board["id"], "--keep-brief"], capsys)
    assert "changed since" not in _cli(app, ["moodboard", "show", board["id"]], capsys)
    _cli(app, ["moodboard", "set", board["id"], "--clear-brief", "--clear-avoid", "--direction", ""], capsys)
    data = json.loads(_cli(app, ["moodboard", "show", board["id"], "--json"], capsys))
    assert data["briefOverride"] is None and data["avoid"] == [] and data["direction"] == ""

    person = _analyzed_board(app, tmp_path, "Person board")
    _person_override(person["id"], "The person's words.")
    assert "Brief sent to generators (written by the person)" in _cli(app, ["moodboard", "show", person["id"]],
                                                                       capsys)


def test_show_says_when_this_nebula_sends_no_brief(capsys, monkeypatch):
    old = {"id": "mb_old", "name": "Old", "mode": "look", "strength": 0.7, "images": [],
           "analysis": {"styleBrief": "analysis text", "negativePrompt": "old negatives", "summary": "s"}}

    class _OldAPI:
        def request(self, method, path, **kwargs):
            assert (method, path) == ("GET", "/api/moodboards/mb_old")
            return old

    monkeypatch.setattr(NebulaClient, "api", property(lambda self: _OldAPI()))
    moodboard_cmd.run(NebulaClient("http://testserver"), build_parser().parse_args(["moodboard", "show", "mb_old"]))
    shown = capsys.readouterr().out
    assert "doesn't say which brief generators get" in shown
    assert "analysis text" not in shown and "old negatives" not in shown


def test_mcp_get_and_update_carry_the_brief(app, tmp_path):
    board = _analyzed_board(app, tmp_path)
    updated = mcp_server.moodboard_update(board["id"], direction="Warm dusk", avoid_add=["neon"],
                                          pin_colors=["#E8593C"], brief_override="Agent brief.")
    assert updated["direction"] == "Warm dusk" and updated["avoid"] == ["neon"]
    assert updated["pinnedColors"]["include"] == ["#e8593c"]
    assert updated["briefOverride"]["by"] == "agent"
    assert updated["brief"]["styleBrief"] == "Agent brief."
    assert updated["analysis"]
    got = mcp_server.moodboard_get(board["id"])
    assert got["brief"] == updated["brief"]
    listed = next(b for b in mcp_server.moodboard_list(project_id="none") if b["id"] == board["id"])
    assert listed["brief"]["styleBrief"] == "Agent brief."
    # Undo through the same tool.
    restored = mcp_server.moodboard_update(board["id"], **updated["previous"])
    assert restored["direction"] == "" and restored["avoid"] == [] and restored["briefOverride"] is None
    assert restored["pinnedColors"] == {"include": [], "exclude": []}
    kept = mcp_server.moodboard_update(board["id"], avoid=["a", "b"], unpin_colors=None)
    assert kept["avoid"] == ["a", "b"]
