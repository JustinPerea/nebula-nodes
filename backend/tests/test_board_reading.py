"""Read the board (services/board_reading.py): the images and their names, the
prompt, the fingerprint and staleness, citations, the route choice, the env
allow-list, the sandbox folder and its write check, and both routes.

agy is always FAKE (tests/fixtures/board_reading/fake_agy.py) and Google is
an httpx MockTransport: no test runs the person's agy or calls a paid API.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import stat
import sys
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from PIL import Image

from services import board_reading as br
from services.output import OUTPUT_ROOT

FAKE = Path(__file__).parent / "fixtures" / "board_reading" / "fake_agy.py"


# -- helpers ----------------------------------------------------------------------------------------

def make_image(color=(200, 80, 40), suffix=".png") -> tuple[str, Path]:
    path = OUTPUT_ROOT / "board-reading-tests" / f"{uuid4().hex[:10]}{suffix}"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), color).save(path, format="PNG" if suffix == ".png" else "JPEG")
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}", path


def board_of(*images: dict) -> dict:
    return {"id": "b1", "name": "Desert light", "images": list(images)}


def image(url: str, image_id: str | None = None, **extra) -> dict:
    return {"id": image_id or uuid4().hex[:12], "url": url, "weight": 1.0, "excluded": False, **extra}


def install_fake(folder: Path, behavior: str = "ok", status: str = "signed_in") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    agy = folder / "agy"
    agy.write_text(f"#!{sys.executable}\n" + FAKE.read_text())
    agy.chmod(0o755)
    (folder / "behavior").write_text(behavior)
    (folder / "status").write_text(status)
    return agy


def calls(folder: Path) -> list[dict]:
    path = folder / "calls.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


@pytest.fixture(autouse=True)
def _never_the_real_agy(monkeypatch):
    """No test may find the person's own agy: every lookup Nebula makes
    (agent_binaries.resolve, PATH and the login shell) refuses it, so only a
    test's FAKE, passed in or patched over find_agy, ever runs."""
    from services import agent_binaries

    real = agent_binaries.resolve

    def resolve(command, **kwargs):
        if str(command).rsplit("/", 1)[-1] == "agy":
            return None
        return real(command, **kwargs)

    monkeypatch.setattr(agent_binaries, "resolve", resolve)
    monkeypatch.setattr(br, "find_agy", lambda: None)


@pytest.fixture(autouse=True)
def _fresh_status():
    br.forget_status()
    yield
    br.forget_status()


# -- images, names and the prompt ----------------------------------------------------------------

def test_sendable_images_are_the_steering_files_in_board_order_named_by_tile_id():
    a, _ = make_image()
    b, _ = make_image((10, 10, 200), ".jpg")
    c, _ = make_image((0, 200, 0))
    d, _ = make_image((9, 9, 9))
    board = board_of(image(a, "img-a"), image(b, "img-b"), image(c, "img-c", excluded=True),
                     image(d, "img-d", weight=0), image("https://example.com/x.png", "img-out"))
    sent = br.sendable_images(board)
    assert [(s.image_id, s.number, s.name) for s in sent] == [("img-a", 1, "tile-img-a.png"),
                                                              ("img-b", 2, "tile-img-b.jpg")]


def test_a_tile_id_is_cleaned_into_a_file_name():
    assert br.citation_name("../../etc/passwd", ".PNG") == "tile-etcpasswd.png"
    assert br.citation_name("x y", ".tiff") == "tile-xy.png"


def test_a_symlinked_image_is_refused(tmp_path):
    url, path = make_image()
    link = path.with_name(f"link-{uuid4().hex[:6]}.png")
    os.symlink(path, link)
    link_url = url.rsplit("/", 1)[0] + "/" + link.name
    try:
        assert br.source_path(link_url) is None
        assert br.sendable_images(board_of(image(link_url, "l"))) == []
        assert br.source_path(url) == Path(os.path.normpath(path.resolve()))
    finally:
        link.unlink()


def test_the_prompt_is_the_reference_prompt_with_the_file_list():
    text = br.prompt(["tile-a.png", "tile-b.jpg"])
    assert text == ("The folder images/ holds 2 screenshots: tile-a.png, tile-b.jpg. Look at every one of them "
                    "(open each image file). Don't create or change any files. Analyze the visual style. What is "
                    "it, what makes it distinctive, and why does it work? Write plain prose for a designer. Say "
                    "which images you're drawing each point from.")
    assert br.prompt(["tile-a.png"]).startswith("The folder images/ holds 1 screenshot: tile-a.png.")


# -- fingerprints, staleness and citations -----------------------------------------------------------

def test_the_fingerprint_is_ids_and_content_in_any_order():
    one = [{"id": "a", "hash": "1"}, {"id": "b", "hash": "2"}]
    assert br.fingerprint(one) == br.fingerprint(list(reversed(one)))
    assert br.fingerprint(one) != br.fingerprint([{"id": "a", "hash": "1"}, {"id": "b", "hash": "3"}])
    assert br.fingerprint(one) != br.fingerprint([{"id": "a", "hash": "1"}, {"id": "c", "hash": "2"}])
    assert br.fingerprint(one) != br.fingerprint(one[:1])


def _reading_for(board: dict) -> dict:
    sent = br.sendable_images(board)
    return br.build_reading("Look at `" + sent[0].name + "`.", sent, route="antigravity", by={"kind": "person"},
                            entry={"name": "Gemini 4 Argon"})


def test_staleness_counts_added_removed_set_aside_and_replaced():
    urls = [make_image((n * 40, 20, 20)) for n in range(4)]
    board = board_of(*(image(u, f"i{n}") for n, (u, _) in enumerate(urls[:3])))
    reading = _reading_for(board)
    assert br.staleness(reading, board) == {"stale": False, "added": [], "removed": [], "setAside": [],
                                            "replaced": []}
    # Notes, a private note, a weight above 0 and the order don't make it stale.
    moved = {**board, "images": [dict(board["images"][1], notes="warm"), board["images"][0],
                                 dict(board["images"][2], weight=0.4, privateNote="liked")]}
    assert br.staleness(reading, moved)["stale"] is False
    changed = {**board, "images": [board["images"][0], dict(board["images"][1], excluded=True),
                                   image(urls[3][0], "i3")]}
    stale = br.staleness(reading, changed)
    assert stale == {"stale": True, "added": ["i3"], "removed": ["i2"], "setAside": ["i1"], "replaced": []}
    # The same tile with other bytes is a replaced file.
    Image.new("RGB", (32, 24), (1, 2, 3)).save(urls[0][1])
    assert br.staleness(reading, board)["replaced"] == ["i0"]
    assert br.staleness(None, board) is None


def test_citations_map_to_tiles_and_an_unknown_name_stays_plain():
    citations = [{"imageId": "a", "number": 1, "file": "tile-a.png"},
                 {"imageId": "b", "number": 3, "file": "tile-b.jpg"}]
    text = "From `tile-b.jpg` and images/tile-a.png, also `tile-zzz.png`; again tile-B.JPG."
    assert br.cited_ids(text, citations) == ["b", "a"]
    reading = {"markdown": text, "citations": citations, "cited": ["b", "a"]}
    board = {"images": [{"id": "x"}, {"id": "b"}]}
    markdown, tiles = br.numbered_markdown(reading, board)
    assert markdown == ("From #2 and #1 (removed from the board), also `tile-zzz.png`; again #2.")
    assert tiles == [
        {"number": 1, "imageId": "a", "file": "tile-a.png", "onBoard": False, "numberWhenRead": 1, "cited": True},
        {"number": 2, "imageId": "b", "file": "tile-b.jpg", "onBoard": True, "numberWhenRead": 3, "cited": True}]


# -- the route choice ---------------------------------------------------------------------------------

@pytest.mark.parametrize("installed, signed_in, has_key, wanted, route", [
    (True, True, True, "auto", "antigravity"),
    (True, True, False, "auto", "antigravity"),
    (True, False, True, "auto", "gemini_key"),
    (False, False, True, "auto", "gemini_key"),
    (True, False, False, "auto", None),
    (False, False, False, "auto", None),
    (True, True, True, "gemini_key", "gemini_key"),
    (True, True, False, "gemini_key", None),
    (True, False, True, "antigravity", None),
    (False, True, True, "antigravity", None),
])
def test_route_choice_puts_a_signed_in_antigravity_first(installed, signed_in, has_key, wanted, route):
    assert br.choose_route({"installed": installed, "signedIn": signed_in}, has_key, wanted) == route


def test_an_unknown_route_is_refused():
    with pytest.raises(ValueError):
        br.choose_route({}, True, "openai")


# -- the environment -------------------------------------------------------------------------------

def test_agy_gets_an_allow_listed_environment():
    source = {"HOME": "/Users/p", "LANG": "en_US.UTF-8", "USER": "p", "TMPDIR": "/tmp/x", "PATH": "/evil:/usr/bin",
              "HTTPS_PROXY": "http://proxy:8080", "NEBULA_PERSON_TOKEN": "t", "NEBULA_STATE_DIR": "/s",
              "GEMINI_API_KEY": "k", "GOOGLE_API_KEY": "k", "ANTHROPIC_API_KEY": "k", "SOME_SECRET": "s",
              "AWS_SESSION_TOKEN": "t", "PYTHONPATH": "/x", "NODE_OPTIONS": "--require /x", "SSH_AUTH_SOCK": "/a",
              "DYLD_INSERT_LIBRARIES": "/x.dylib", "GOOGLE_APPLICATION_CREDENTIALS": "/c.json"}
    env = br.agy_env(source, Path("/opt/agy/bin/agy"))
    assert set(env) == {"HOME", "LANG", "USER", "TMPDIR", "HTTPS_PROXY", "PATH", "NO_COLOR"}
    assert env["PATH"] == "/opt/agy/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    for name in env:
        assert not name.startswith("NEBULA") and not any(w in name for w in ("KEY", "TOKEN", "SECRET"))


def test_the_allow_list_itself_names_no_secret():
    for name in br.ENV_ALLOW:
        assert not name.upper().startswith("NEBULA")
        assert not any(word in name.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"))


# -- detection -------------------------------------------------------------------------------------

def test_detection_is_installed_and_signed_in_from_the_status_call(tmp_path):
    agy = install_fake(tmp_path / "bin")
    root = tmp_path / "tmp-root"
    assert br.detect_antigravity(temp_root=root, find=lambda: agy) == {"installed": True, "signedIn": True}
    call = calls(tmp_path / "bin")[-1]
    assert call["argv"] == ["--output-format", "json", "-p", "/usage"]
    assert list(root.iterdir()) == []  # its folder went
    (tmp_path / "bin" / "status").write_text("signed_out")
    # Cached for a minute, then asked again.
    assert br.detect_antigravity(temp_root=root, find=lambda: agy)["signedIn"] is True
    br.forget_status()
    assert br.detect_antigravity(temp_root=root, find=lambda: agy) == {"installed": True, "signedIn": False}
    assert br.detect_antigravity(temp_root=root, find=lambda: None) == {"installed": False, "signedIn": False}


def test_detection_never_reads_the_status_as_signed_in_on_garbage(tmp_path):
    folder = tmp_path / "bin"
    folder.mkdir()
    agy = folder / "agy"
    agy.write_text(f"#!{sys.executable}\nprint('signed in, probably')\n")
    agy.chmod(0o755)
    assert br.detect_antigravity(temp_root=tmp_path / "r", find=lambda: agy)["signedIn"] is False


# -- the sandbox folder ------------------------------------------------------------------------------

def test_the_folder_holds_only_the_copies_and_is_private(tmp_path):
    urls = [make_image((n * 50, 0, 0)) for n in range(2)]
    sent = br.sendable_images(board_of(*(image(u, f"i{n}") for n, (u, _) in enumerate(urls))))
    root = tmp_path / "root"
    folder = br.prepare_folder(root, sent)
    try:
        assert stat.S_IMODE(folder.stat().st_mode) == 0o700 and stat.S_IMODE(root.stat().st_mode) == 0o700
        assert folder.parent == root
        assert sorted(str(p.relative_to(folder)) for p in folder.rglob("*")) == [
            "images", "images/tile-i0.png", "images/tile-i1.png"]
        assert (folder / "images" / "tile-i0.png").read_bytes() == urls[0][1].read_bytes()
        assert not (folder / "images" / "tile-i0.png").is_symlink()
    finally:
        shutil.rmtree(folder)


def test_a_symlink_swapped_in_after_selection_is_refused(tmp_path):
    url, path = make_image()
    sent = br.sendable_images(board_of(image(url, "i0")))
    target = tmp_path / "secret.txt"
    target.write_text("secret")
    backup = path.with_suffix(".bak")
    path.rename(backup)
    os.symlink(target, path)
    try:
        with pytest.raises(br.ReadFailure):
            br.prepare_folder(tmp_path / "root", sent)
        assert list((tmp_path / "root").iterdir()) == []
    finally:
        path.unlink()
        backup.rename(path)


def test_the_snapshot_sees_a_write_a_touch_and_a_new_folder(tmp_path):
    folder = tmp_path / "f"
    (folder / "images").mkdir(parents=True)
    (folder / "images" / "a.png").write_bytes(b"1")
    before = br.snapshot(folder)
    assert br.snapshot(folder) == before
    (folder / "images" / "a.png").write_bytes(b"2")
    assert br.snapshot(folder) != before
    before = br.snapshot(folder)
    (folder / ".agents").mkdir()
    assert br.snapshot(folder) != before
    before = br.snapshot(folder)
    os.utime(folder / "images" / "a.png", ns=(1, 1))
    assert br.snapshot(folder) != before


# -- the Antigravity run (FAKE agy) -------------------------------------------------------------------

def _run(tmp_path: Path, behavior: str, timeout: float = 30.0, count: int = 2):
    agy = install_fake(tmp_path / "bin", behavior)
    urls = [make_image((n * 50, 9, 9)) for n in range(count)]
    sent = br.sendable_images(board_of(*(image(u, f"i{n}") for n, (u, _) in enumerate(urls))))
    root = tmp_path / "root"
    env = br.agy_env({"HOME": str(tmp_path), "NEBULA_PERSON_TOKEN": "t", "GEMINI_API_KEY": "k"}, agy)
    try:
        return asyncio.run(br.run_antigravity(sent, agy=agy, temp_root=root, timeout=timeout, env=env)), root
    finally:
        assert not root.exists() or list(root.iterdir()) == []  # the folder is always deleted


def test_a_read_runs_agy_sandboxed_in_plan_mode_in_a_folder_of_copies(tmp_path):
    answer, root = _run(tmp_path, "ok")
    assert "tile-i0.png" in answer and "### Why it works" in answer
    call = calls(tmp_path / "bin")[-1]
    argv = call["argv"]
    assert argv[:8] == ["--model", "gemini-4-argon-medium", "--mode", "plan", "--sandbox", "--output-format",
                        "json", "-p"]
    assert argv[8] == br.prompt(["tile-i0.png", "tile-i1.png"]) and len(argv) == 9
    assert Path(call["cwd"]).parent == root.resolve() or Path(call["cwd"]).parent == root
    assert call["images"] == ["tile-i0.png", "tile-i1.png"]
    assert call["entries"] == ["images", "images/tile-i0.png", "images/tile-i1.png"]
    assert set(call["env"]) <= {"HOME", "PATH", "NO_COLOR", "LANG", "USER", "TMPDIR", "__CF_USER_TEXT_ENCODING",
                                "LC_CTYPE"}
    assert "NEBULA_PERSON_TOKEN" not in call["env"] and "GEMINI_API_KEY" not in call["env"]


@pytest.mark.parametrize("behavior, cause", [
    ("signed_out", "signed_out"),
    ("plan_limit", "plan_limit"),
    ("write", "write_attempt"),
    ("garbage", "other"),
    ("huge", "other"),
    ("print_timeout", "timeout"),
])
def test_a_failed_read_says_why_and_keeps_nothing(tmp_path, behavior, cause):
    with pytest.raises(br.ReadFailure) as failure:
        _run(tmp_path, behavior)
    assert failure.value.cause == cause


def test_a_read_past_the_time_limit_is_stopped(tmp_path):
    with pytest.raises(br.ReadFailure) as failure:
        _run(tmp_path, "timeout", timeout=1.5)
    assert failure.value.cause == "timeout"


def test_a_cancelled_read_stops_agy_and_deletes_the_folder(tmp_path):
    agy = install_fake(tmp_path / "bin", "timeout")
    url, _ = make_image()
    sent = br.sendable_images(board_of(image(url, "i0")))
    root = tmp_path / "root"

    async def go():
        task = asyncio.ensure_future(br.run_antigravity(sent, agy=agy, temp_root=root, timeout=60))
        await asyncio.sleep(1.0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(go())
    assert list(root.iterdir()) == []


@pytest.mark.parametrize("stderr, cause", [
    ('AGY_ERROR: {"status": "UNAUTHENTICATED", "code": 401}', "signed_out"),
    ('AGY_ERROR: {"status": "RESOURCE_EXHAUSTED", "code": 429}', "plan_limit"),
    ("Your AI credits balance is too low to continue.", "plan_limit"),
    ("Error: authentication failed: token expired", "signed_out"),
    ('AGY_ERROR: {"status": "INTERNAL", "code": 500}', "other"),
    ("", "other"),
])
def test_agy_failures_are_classified(stderr, cause):
    assert br.classify_agy_failure(stderr, 3) == cause


# -- the Gemini API key run ---------------------------------------------------------------------------

def _gemini(reply):
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append({"url": str(request.url), "body": json.loads(request.content),
                     "key": request.headers.get("x-goog-api-key")})
        return reply(request)

    return seen, httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _sse(text: str) -> bytes:
    payload = {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}],
               "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 50}}
    return b"data: " + json.dumps(payload).encode() + b"\r\n\r\n"


def test_the_key_route_sends_the_prompt_and_each_image_under_its_name():
    urls = [make_image((n * 50, 9, 9)) for n in range(2)]
    sent = br.sendable_images(board_of(*(image(u, f"i{n}") for n, (u, _) in enumerate(urls))))
    seen, client = _gemini(lambda r: httpx.Response(200, content=_sse("It is **blue** (`tile-i1.png`).")))

    async def go():
        try:
            return await br.run_gemini_key(sent, api_key="g-test", client=client)
        finally:
            await client.aclose()

    assert asyncio.run(go()) == "It is **blue** (`tile-i1.png`)."
    body = seen[0]["body"]
    parts = body["contents"][0]["parts"]
    assert parts[0] == {"text": br.prompt(["tile-i0.png", "tile-i1.png"])}
    assert parts[1] == {"text": "images/tile-i0.png"} and "inline_data" in parts[2]
    assert parts[3] == {"text": "images/tile-i1.png"} and "inline_data" in parts[4]
    assert "systemInstruction" not in body and seen[0]["key"] == "g-test" and "gemini-4-argon" in seen[0]["url"]


@pytest.mark.parametrize("status, text, cause", [
    (400, '{"error": {"message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}}',
     "key_refused"),
    (403, '{"error": {"status": "PERMISSION_DENIED"}}', "key_refused"),
    (500, '{"error": {"status": "INTERNAL"}}', "other"),
])
def test_a_refused_key_is_its_own_failure(status, text, cause):
    url, _ = make_image()
    sent = br.sendable_images(board_of(image(url, "i0")))
    _, client = _gemini(lambda r: httpx.Response(status, content=text.encode()))

    async def go():
        try:
            await br.run_gemini_key(sent, api_key="bad", client=client)
        finally:
            await client.aclose()

    with pytest.raises(br.ReadFailure) as failure:
        asyncio.run(go())
    assert failure.value.cause == cause


def test_the_key_route_price_comes_from_argon_s_list_price():
    entry = br.reader_entry()
    from datetime import date

    est = br.estimate_key_read(15, entry, today=date(2026, 11, 1))
    tokens_in = 15 * 1120 + br.PROMPT_TOKENS
    assert est["high"] == pytest.approx(tokens_in / 1e6 * 2.0 + (6144 + 4096) / 1e6 * 10.0, abs=1e-6)
    assert 0 < est["low"] < est["high"] and est["unpriced"] is False
    later = br.estimate_key_read(15, entry, today=date(2026, 12, 2))
    assert later["high"] == pytest.approx(est["high"] * 2, rel=1e-6)


# -- the reading and runs -----------------------------------------------------------------------------

def test_a_reading_keeps_what_staleness_and_citations_need():
    urls = [make_image((n * 50, 9, 9)) for n in range(2)]
    board = board_of(*(image(u, f"i{n}") for n, (u, _) in enumerate(urls)))
    sent = br.sendable_images(board)
    reading = br.build_reading("See `tile-i1.png`.", sent, route="gemini_key", by={"kind": "person"},
                               cost={"low": 0.01, "high": 0.1})
    assert reading["cited"] == ["i1"] and reading["model"] == "gemini-4-argon"
    assert reading["modelName"] == "Gemini 4 Argon" and reading["route"] == "gemini_key"
    assert [c["file"] for c in reading["citations"]] == ["tile-i0.png", "tile-i1.png"]
    assert [e["id"] for e in reading["imageSet"]["images"]] == ["i0", "i1"]
    assert reading["imageSet"]["fingerprint"] == br.image_set(sent)["fingerprint"]
    assert br.check_reading(reading) is reading
    with pytest.raises(ValueError):
        br.check_reading({**reading, "route": "openai"})


def test_runs_one_at_a_time_and_stop_cancels():
    async def go():
        runs = br.Runs()
        ended: list[str] = []

        async def slow(run):
            await asyncio.sleep(30)

        async def end(run):
            ended.append(run.status)

        run = runs.start(br.Run("b", "antigravity", 1, {"kind": "person"}, 0.0), slow, on_end=end)
        with pytest.raises(RuntimeError):
            runs.start(br.Run("b", "antigravity", 1, {"kind": "person"}, 0.0), slow)
        stopped = await runs.stop("b")
        assert stopped is run and run.status == "stopped" and ended == ["stopped"]

        async def fails(run):
            raise br.ReadFailure("plan_limit")

        failed = runs.start(br.Run("b", "antigravity", 1, {"kind": "person"}, 0.0), fails, on_end=end)
        await failed.task
        assert failed.status == "failed" and failed.cause == "plan_limit" and ended[-1] == "failed"

    asyncio.run(go())


def test_failure_lines_are_gm_s():
    assert br.failure_line("timeout") == "Gemini didn't answer in time. Try again."
    assert br.failure_line("write_attempt") == br.FALLBACK_LINE
    assert br.agent_failure_say("plan_limit") == ("Couldn't read the board because the Antigravity plan has "
                                                  "reached its limit for now.")
