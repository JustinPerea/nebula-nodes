"""What the spending check may measure, and how (security review, 2026-10-21).

Finding 1 (TOCTOU): the price is measured when the run is checked, but the
handler reads the file later. So the check measures only inputs no API-only
agent can change after it: inline ``data:`` images and files inside
Nebula's output folder (its path and its resolved path both inside, no
``..``), never a file Nebula is still writing. Anything else is OUTSIDE,
and the refusal says how to add the file to Nebula first.

Finding 2 (parser differential): a clip is measured as an upper bound of
what a demuxer delivers: every video stream is looked at, frames and
seconds come from the demuxed packets as well as the header, and a stream
that signals a parameter change, or more than one real video stream, is
left unmeasured. Multi-frame and multi-size images are left unmeasured.

The measurement runs off the event loop on every path that prices a run.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_spend, input_sizes, model_pricing  # noqa: E402
from services.node_registry import NodeRegistry  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_price_from_input_size import _limit, client  # noqa: E402,F401  (client is a fixture)

REGISTRY = NodeRegistry().get_all()
PRICING = model_pricing.load_pricing()
SEEDVR = "seedvr2-upscale"
SEEDVR_VIDEO = "seedvr-video-upscale"
needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
                                  reason="needs ffmpeg and ffprobe")


@pytest.fixture(autouse=True)
def _fresh_cache():
    input_sizes._CACHE.clear()
    yield
    input_sizes._CACHE.clear()


def _store(*parts: str) -> Path:
    from services.output import OUTPUT_ROOT

    path = OUTPUT_ROOT.joinpath("size-security", *parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _png(path: Path, width: int, height: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (width, height), (10, 20, 30)).save(path, "PNG")
    return path


def _ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True, timeout=120)


def _clip(path: Path, *, size="64x48", rate=10, seconds=2, extra: tuple[str, ...] = ()) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    codec = ("-c:v", "libvpx", "-b:v", "200k") if path.suffix == ".webm" else ("-pix_fmt", "yuv420p")
    _ffmpeg("-f", "lavfi", "-i", f"testsrc=size={size}:rate={rate}:duration={seconds}", *codec, *extra, str(path))
    return path


def _reasons(ref: str, definition: str = SEEDVR, port: str = "image", source: str = "image-input"):
    items = [{"id": "in", "definitionId": source, "params": {"filePath": ref}},
             {"id": "up", "definitionId": definition, "params": {}}]
    reasons: dict[str, str] = {}
    sizes = input_sizes.run_input_sizes(items, [("in", port, "up", port)], PRICING, REGISTRY, reasons=reasons)
    return sizes, reasons


# -- Finding 1: only the output folder and inline images are measured ----------

def test_a_file_outside_the_output_folder_is_outside(tmp_path):
    """A workspace or temp file can be rewritten after the check, so it isn't priced."""
    path = _png(tmp_path / "workspace" / "small.png", 100, 100)
    assert input_sizes.measure(str(path), "Image") is None
    assert _reasons(str(path)) == ({}, {"up": input_sizes.OUTSIDE})
    assert input_sizes.OUTSIDE == "outside"


def test_a_stored_file_is_still_measured_by_path_served_ref_and_loopback_url():
    path = _png(_store("kept.png"), 640, 480)
    assert input_sizes.measure(str(path), "Image") == {"width": 640, "height": 480}
    ref = "/api/outputs/size-security/kept.png"
    assert input_sizes.measure(ref, "Image") == {"width": 640, "height": 480}
    assert input_sizes.measure(f"http://127.0.0.1:8000{ref}", "Image") == {"width": 640, "height": 480}
    assert _reasons(ref) == ({"up": {"width": 640, "height": 480}}, {})


def test_a_symlink_in_the_store_pointing_outside_is_outside(tmp_path):
    outside = _png(tmp_path / "elsewhere.png", 100, 100)
    link = _store("link.png")
    link.unlink(missing_ok=True)
    link.symlink_to(outside)
    assert input_sizes.measure(str(link), "Image") is None
    assert input_sizes.measure("/api/outputs/size-security/link.png", "Image") is None
    assert _reasons(str(link))[1] == {"up": input_sizes.OUTSIDE}


def test_a_symlinked_folder_in_the_store_pointing_outside_is_outside(tmp_path):
    outside = tmp_path / "folder"
    _png(outside / "x.png", 100, 100)
    link = _store("linked-folder")
    if link.is_symlink():
        link.unlink()
    link.symlink_to(outside, target_is_directory=True)
    assert input_sizes.measure(str(link / "x.png"), "Image") is None
    assert _reasons(str(link / "x.png"))[1] == {"up": input_sizes.OUTSIDE}


def test_a_path_with_dot_dot_is_outside_even_when_it_lands_in_the_store():
    _png(_store("dots.png"), 100, 100)
    _store("sub", "keep")  # makes size-security/sub
    sneaky = str(_store("sub") / ".." / "dots.png")
    assert ".." in sneaky
    assert input_sizes.measure(sneaky, "Image") is None
    assert _reasons(sneaky)[1] == {"up": input_sizes.OUTSIDE}


def test_a_data_uri_is_still_measured():
    buffer = io.BytesIO()
    Image.new("RGB", (300, 200)).save(buffer, "PNG")
    import base64

    uri = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
    assert _reasons(uri) == ({"up": {"width": 300, "height": 200}}, {})


def test_a_rewrite_that_keeps_size_and_mtime_is_measured_again(monkeypatch):
    path = _store("rewritten.png")
    path.write_bytes(b"A" * 64)
    calls: list[bytes] = []

    def fake_image_size(source):
        calls.append(Path(source).read_bytes())
        return {"width": 10, "height": 10}

    monkeypatch.setattr(input_sizes, "_image_size", fake_image_size)
    assert input_sizes.measure(str(path), "Image") == {"width": 10, "height": 10}
    before = path.stat()
    time.sleep(0.01)
    path.write_bytes(b"B" * 64)  # same size
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))  # same mtime
    assert path.stat().st_size == before.st_size and path.stat().st_mtime_ns == before.st_mtime_ns
    input_sizes.measure(str(path), "Image")
    assert calls == [b"A" * 64, b"B" * 64]


def test_a_file_replaced_by_rename_is_measured_again(monkeypatch):
    path = _store("renamed.png")
    path.write_bytes(b"A" * 64)
    seen: list[bytes] = []
    monkeypatch.setattr(input_sizes, "_image_size",
                        lambda source: seen.append(Path(source).read_bytes()) or {"width": 1, "height": 1})
    input_sizes.measure(str(path), "Image")
    stat = path.stat()
    other = _store("renamed.tmp")
    other.write_bytes(b"C" * 64)
    os.utime(other, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    os.replace(other, path)
    input_sizes.measure(str(path), "Image")
    assert seen == [b"A" * 64, b"C" * 64]


def test_a_file_nebula_is_still_writing_is_not_measured():
    """A run's folder is written while the run goes on (a clip can grow), so
    its files are measured only once the run has finished."""
    from services.output import create_run_dir, seal_run_dir

    folder = create_run_dir("size-security")
    path = _png(folder / "growing.png", 100, 100)
    assert input_sizes.measure(str(path), "Image") is None
    assert _reasons(str(path))[1] == {"up": input_sizes.PENDING}
    seal_run_dir(folder)
    assert input_sizes.measure(str(path), "Image") == {"width": 100, "height": 100}


def test_a_dot_file_in_the_store_is_not_measured():
    """Nebula's partial and temporary files start with a dot (``.x.part``)."""
    path = _png(_store(".half.png.part"), 100, 100)
    assert input_sizes.measure(str(path), "Image") is None
    assert _reasons(str(path))[1] == {"up": input_sizes.PENDING}


def test_an_unreadable_stored_file_is_still_unreadable():
    path = _store("not-an-image.png")
    path.write_text("nope")
    assert _reasons(str(path))[1] == {"up": input_sizes.UNREADABLE}


def test_a_missing_or_protected_outside_path_is_unreadable_not_outside(tmp_path):
    assert _reasons(str(tmp_path / "gone.png"))[1] == {"up": input_sizes.UNREADABLE}


# -- the refusal for a file outside the store -------------------------------------

def _decide_why(reason, definition=SEEDVR, port="image"):
    items = [{"id": "up", "definitionId": definition, "params": {}}]
    return agent_spend.decide(items, [("in", "up", port)], settings={"apiKeys": {"FAL_KEY": "set"}},
                              pricing=PRICING, definitions=REGISTRY, spent=agent_spend.Spent(), how_to_ask="ASK.",
                              sizes=None, size_reasons={"up": reason}).refusal


@pytest.mark.parametrize(("definition", "port"), [(SEEDVR, "image"), (SEEDVR_VIDEO, "video")])
def test_an_outside_file_is_refused_with_how_to_add_it(definition, port):
    refusal = _decide_why("outside", definition, port)
    assert "outside Nebula's output folder" in refusal
    assert "could change after" in refusal
    # The real tools that copy a local file into Nebula's output folder.
    assert "`nebula upload <file>`" in refusal and "upload_file" in refusal
    assert refusal.endswith("ASK.")
    assert "couldn't read" not in refusal and "doesn't exist yet" not in refusal


def test_the_video_refusals_never_suggest_quick_on_a_local_clip():
    """`nebula quick` copies a local image into Nebula, never a clip: a local
    clip there would be outside the store again."""
    for reason in ("pending", "remote", "outside"):
        refusal = _decide_why(reason, SEEDVR_VIDEO, "video")
        assert "--input video=<file>" not in refusal and "--input video=<local file path>" not in refusal
        assert "`nebula upload <file>`" in refusal


def test_quick_on_a_local_clip_is_refused_as_outside(client, tmp_path):
    import main

    _limit_video(client, 1.0)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\x00" * 64)
    response = client.post("/api/quick", json={"definitionId": SEEDVR_VIDEO, "inputs": {"video": str(clip)},
                                               "params": {}})
    assert response.status_code == 403, response.text
    assert "outside Nebula's output folder" in response.json()["detail"]
    main.execute_graph.assert_not_awaited()


def test_quick_on_a_local_image_still_prices_nebulas_copy(client, tmp_path):
    """/api/quick copies a local image into chat-uploads before the check
    (main._normalize_image_input_params), so the check measures that copy."""
    path = _png(tmp_path / "local.png", 1000, 1000)
    _limit(client, 0.004)
    response = client.post("/api/quick", json={"definitionId": SEEDVR, "inputs": {"image": str(path)}, "params": {}})
    assert response.status_code == 403 and "$0.004" in response.json()["detail"]


def _limit_video(client, cap):
    response = client.put("/api/settings", headers=PERSON, json={
        "apiKeys": {"FAL_KEY": "placeholder-not-a-key"}, "runCostConfirmUsd": 1,
        "agentSpend": {"sessionUsd": None, "models": {SEEDVR_VIDEO: {"perRunUsd": cap}}}})
    assert response.status_code == 200, response.text


def test_the_canvas_measure_route_uses_the_same_rule(client, tmp_path):
    outside = _png(tmp_path / "outside.png", 10, 10)
    link = _store("route-link.png")
    link.unlink(missing_ok=True)
    link.symlink_to(outside)
    _png(_store("route.png"), 30, 20)
    _store("sub", "keep")
    dots = str(_store("sub") / ".." / "route.png")
    response = client.post("/api/pricing/input-sizes", json={"refs": [
        {"ref": str(link), "kind": "Image"},
        {"ref": "/api/outputs/size-security/route-link.png", "kind": "Image"},
        {"ref": dots, "kind": "Image"},
        {"ref": str(_store("route.png")), "kind": "Image"},
    ]})
    assert response.status_code == 200
    sizes = response.json()["sizes"]
    assert sizes[str(link)] is None and sizes["/api/outputs/size-security/route-link.png"] is None
    assert sizes[dots] is None
    assert sizes[str(_store("route.png"))] == {"width": 30, "height": 20}


# -- the premise: nothing an API-only agent runs rewrites a stored file ----------

def test_codex_cannot_write_the_output_folder_even_under_tmp(tmp_path):
    """Codex's ':workspace' base makes /tmp and $TMPDIR writable (checked live
    with `codex sandbox`, 0.163.0). An output folder there gets a read entry,
    which wins over the base's write."""
    import tomllib

    from services import agent_profiles

    work = tmp_path / "state" / "agent-workspace"
    work.mkdir(parents=True)
    output = tmp_path / "output"
    output.mkdir()
    args = agent_profiles.codex_filesystem_args(workdir=work, deny_paths=[], output_root=output)
    config = tomllib.loads("\n".join(value for flag, value in zip(args, args[1:]) if flag == "-c"))
    filesystem = config["permissions"]["nebula-agent"]["filesystem"]
    assert filesystem[str(output.resolve())] == "read"
    assert filesystem[str(output.absolute())] == "read"


def test_codex_refuses_a_workspace_inside_the_output_folder(tmp_path):
    from services import agent_profiles

    output = tmp_path / "output"
    work = output / "agent-workspace"
    work.mkdir(parents=True)
    with pytest.raises(agent_profiles.GrantOverlapsProtectedDir):
        agent_profiles.codex_filesystem_args(workdir=work, deny_paths=[], output_root=output)


def test_codex_turns_launch_with_the_output_folder_read_only(tmp_path, monkeypatch):
    from services import codex_session
    from services.output import OUTPUT_ROOT

    work = tmp_path / "state" / "agent-workspace"
    work.mkdir(parents=True)
    args = codex_session._codex_base_args(None, workdir=work)
    joined = " ".join(args)
    assert f'"{OUTPUT_ROOT.resolve()}" = "read"' in joined


def test_nebula_save_never_replaces_a_file_that_is_not_a_saved_graph(tmp_path, capsys):
    from cli.commands import graph

    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)

    class Client:
        def get_graph(self):
            return {"nodes": [], "edges": []}

    with pytest.raises(SystemExit):
        graph.run_save(Client(), str(clip))
    assert clip.read_bytes().startswith(b"\x00\x00\x00\x18ftyp")
    assert "isn't a saved graph" in capsys.readouterr().err
    saved = tmp_path / "graph.json"
    graph.run_save(Client(), str(saved))
    graph.run_save(Client(), str(saved))  # replacing an earlier export is fine
    assert json.loads(saved.read_text()) == {"nodes": [], "edges": []}


def test_a_new_store_file_appears_whole_and_never_replaces_one(tmp_path):
    from services.output import write_new_file

    target = tmp_path / "a.bin"
    assert write_new_file(target, b"first") is True
    assert write_new_file(target, b"second") is False
    assert target.read_bytes() == b"first"
    assert [p.name for p in tmp_path.iterdir()] == ["a.bin"]


def test_an_upload_is_written_whole_under_a_temporary_name_first(client, monkeypatch):
    """The upload route writes to a dot-name and moves it into place, so a
    half-written clip is never at its served name."""
    from services import output

    seen: list[tuple[str, bool]] = []
    real = output.write_new_file

    def spy(path, data):
        seen.append((Path(path).name, Path(path).exists()))
        return real(path, data)

    import main

    monkeypatch.setattr(main, "write_new_file", spy)
    buffer = io.BytesIO()
    Image.new("RGB", (12, 12), (1, 2, 3)).save(buffer, "PNG")
    response = client.post("/api/uploads", files={"file": ("x.png", buffer.getvalue(), "image/png")})
    assert response.status_code == 200, response.text
    assert seen and seen[0][0].endswith(".png") and seen[0][1] is False


# -- Finding 2: a clip is measured as an upper bound of what a demuxer delivers ---

@needs_ffmpeg
@pytest.mark.parametrize("suffix", [".mp4", ".mov", ".webm"])
def test_a_normal_clip_measures_as_before(tmp_path, suffix):
    clip = _clip(tmp_path / f"normal{suffix}")
    size = input_sizes._probe_video(clip)
    assert size is not None and (size["width"], size["height"]) == (64, 48)
    assert abs(size["frames"] - 20) <= 1
    assert size["seconds"] == pytest.approx(2.0, abs=0.11)


@needs_ffmpeg
def test_two_video_streams_with_a_small_first_one_are_not_measured(tmp_path):
    clip = tmp_path / "two.mp4"
    _ffmpeg("-f", "lavfi", "-i", "testsrc=size=16x16:rate=10:duration=1",
            "-f", "lavfi", "-i", "testsrc=size=640x480:rate=30:duration=4",
            "-map", "0", "-map", "1", "-pix_fmt", "yuv420p", str(clip))
    assert input_sizes._probe_video(clip) is None


@needs_ffmpeg
def test_cover_art_is_not_a_second_video_stream(tmp_path):
    clip = _clip(tmp_path / "plain.mp4")
    cover = _png(tmp_path / "cover.png", 32, 32)
    with_cover = tmp_path / "cover.mp4"
    _ffmpeg("-i", str(clip), "-i", str(cover), "-map", "0", "-map", "1", "-c:v:0", "copy", "-c:v:1", "png",
            "-disposition:v:1", "attached_pic", str(with_cover))
    size = input_sizes._probe_video(with_cover)
    assert size is not None and (size["width"], size["height"], size["frames"]) == (64, 48, 20)


@needs_ffmpeg
def test_a_fragmented_mp4_is_counted_from_its_packets(tmp_path):
    """Without empty_moov the moov describes only the first fragment, so the
    header says 10 frames of a 60-frame clip; the packets say 60."""
    clip = _clip(tmp_path / "frag.mp4", seconds=6, extra=("-movflags", "frag_keyframe", "-g", "10"))
    header = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames", "-of", "json",
         str(clip)], capture_output=True, check=True).stdout)
    assert int(header["streams"][0]["nb_frames"]) < 60  # the header understates the clip
    size = input_sizes._probe_video(clip)
    assert size is not None and size["frames"] == 60
    assert size["seconds"] == pytest.approx(6.0, abs=0.11)


@needs_ffmpeg
def test_a_falsified_container_duration_measures_the_real_packets(tmp_path):
    """An MKV whose Segment Duration says 0.5 s and DefaultDuration says 1 fps,
    over 60 frames lasting 6 s: the header alone gave 0.5 s and 5 frames."""
    clip = _clip(tmp_path / "long.mkv", seconds=6)
    data = bytearray(clip.read_bytes())
    at = data.find(b"\x44\x89")
    width = data[at + 2] & 0x7F
    data[at + 3:at + 3 + width] = struct.pack(">d", 500.0) if width == 8 else struct.pack(">f", 500.0)
    default = data.find(b"\x23\xe3\x83")
    if default >= 0 and data[default + 3] == 0x84:
        data[default + 4:default + 8] = (1_000_000_000).to_bytes(4, "big")
    fake = tmp_path / "fake.mkv"
    fake.write_bytes(bytes(data))
    header = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(fake)],
        capture_output=True, check=True).stdout)
    assert float(header["format"]["duration"]) < 1.0  # the patch took
    size = input_sizes._probe_video(fake)
    assert size is not None
    assert size["frames"] >= 60
    assert size["seconds"] >= 5.9


def _default_lines(packets):
    """Packets as ffprobe's default writer prints them, one line at a time."""
    for packet in packets:
        yield "[PACKET]\n"
        for key in ("pts_time", "dts_time", "duration_time"):
            if key in packet:
                yield f"{key}={packet[key]}\n"
        for side in packet.get("side_data_list") or []:
            yield "[SIDE_DATA]\n"
            yield f"side_data_type={side['side_data_type']}\n"
            yield "[/SIDE_DATA]\n"
        yield "[/PACKET]\n"


class _FakeProcess:
    """A stand-in for the packet pass's ffprobe process: its stdout is read
    a line at a time, and it notes whether it was read to the end or killed."""

    def __init__(self, cmd, lines, *, delay=0.0):
        self.args = cmd
        self.lines = iter(lines)
        self.delay = delay
        self.read = 0
        self.killed = False
        self.returncode = None
        self.stdout = self

    def readline(self, limit=-1):
        if self.killed:
            return ""
        if self.delay:
            time.sleep(self.delay)
        line = next(self.lines, "")
        if line:
            self.read += 1
        elif self.returncode is None:
            self.returncode = 0
        return line

    def __iter__(self):
        return iter(self.readline, "")

    def close(self):
        pass

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = -9 if self.killed else 0
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Calls(list):
    """The ffprobe commands run, and the fake packet processes started."""

    def __init__(self):
        super().__init__()
        self.processes: list[_FakeProcess] = []


def _fake_probe(monkeypatch, streams, packets, fmt=None, *, lines=None, delay=0.0):
    """Answer the probe's two ffprobe calls: the header as JSON, the packets
    as JSON (subprocess.run) or as the default writer's lines (Popen)."""
    calls = _Calls()
    processes = calls.processes

    def run(cmd, **kwargs):
        calls.append(cmd)
        if "-show_entries" in cmd and any("packet=" in part for part in cmd):
            body = {"packets": packets}
        else:
            body = {"streams": streams, "format": fmt or {"duration": "2.0"}}
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(body).encode(), stderr=b"")

    def popen(cmd, **kwargs):
        calls.append(cmd)
        process = _FakeProcess(cmd, lines if lines is not None else _default_lines(packets), delay=delay)
        processes.append(process)
        return process

    monkeypatch.setattr(input_sizes.subprocess, "run", run)
    monkeypatch.setattr(input_sizes.subprocess, "Popen", popen)
    return calls


def _video_stream(**overrides):
    return {"index": 0, "codec_type": "video", "width": 1280, "height": 720, "avg_frame_rate": "30/1",
            "r_frame_rate": "30/1", "duration": "2.0", "nb_frames": "60", "disposition": {"attached_pic": 0},
            **overrides}


def _packets(count, step=1 / 30):
    return [{"pts_time": f"{i * step:.6f}", "duration_time": f"{step:.6f}"} for i in range(count)]


def test_a_parameter_change_in_the_packets_leaves_the_clip_unmeasured(tmp_path, monkeypatch):
    clip = tmp_path / "x.mp4"
    clip.write_bytes(b"\x00")
    packets = _packets(60)
    packets[30]["side_data_list"] = [{"side_data_type": "New Extradata"}]
    _fake_probe(monkeypatch, [_video_stream()], packets)
    assert input_sizes._probe_video(clip) is None
    packets[30]["side_data_list"] = [{"side_data_type": "Param Change"}]
    assert input_sizes._probe_video(clip) is None
    packets[30]["side_data_list"] = [{"side_data_type": "Display Matrix"}]
    assert input_sizes._probe_video(clip) is not None


def test_a_timebase_frame_rate_does_not_inflate_a_phone_clip(tmp_path, monkeypatch):
    """r_frame_rate is ffmpeg's guess at a base rate; on a phone's VFR clip it
    is often the timescale (600). avg_frame_rate is frames over duration."""
    clip = tmp_path / "phone.mov"
    clip.write_bytes(b"\x00")
    stream = _video_stream(avg_frame_rate="2997/100", r_frame_rate="600/1", nb_frames="300", duration="10.01")
    _fake_probe(monkeypatch, [stream], _packets(300, 10.01 / 300), {"duration": "10.01"})
    size = input_sizes._probe_video(clip)
    assert size is not None and size["frames"] == 300


def test_more_packets_than_the_header_says_counts_the_packets(tmp_path, monkeypatch):
    clip = tmp_path / "x.mp4"
    clip.write_bytes(b"\x00")
    _fake_probe(monkeypatch, [_video_stream(nb_frames="10", duration="0.3")], _packets(900), {"duration": "0.3"})
    size = input_sizes._probe_video(clip)
    assert size is not None and size["frames"] == 900 and size["seconds"] == pytest.approx(30.0, abs=0.05)


def test_a_clip_with_no_real_video_stream_is_not_measured(tmp_path, monkeypatch):
    clip = tmp_path / "x.m4a"
    clip.write_bytes(b"\x00")
    _fake_probe(monkeypatch, [_video_stream(disposition={"attached_pic": 1}),
                              {"index": 1, "codec_type": "audio"}], _packets(1))
    assert input_sizes._probe_video(clip) is None


def test_the_packet_read_is_demux_only_and_keeps_the_input_policy(tmp_path, monkeypatch):
    clip = tmp_path / "x.mp4"
    clip.write_bytes(b"\x00")
    calls = _fake_probe(monkeypatch, [_video_stream()], _packets(60))
    assert input_sizes._probe_video(clip) is not None
    assert len(calls) == 2
    for cmd in calls:
        assert cmd[0] == "ffprobe"
        assert "-enable_drefs" in cmd and "-use_absolute_path" in cmd and "-protocol_whitelist" in cmd
        assert "-show_frames" not in cmd and "-count_frames" not in cmd  # never decodes
    assert any("packet=" in part for part in calls[1]) and "0" in calls[1][calls[1].index("-select_streams") + 1]


def test_a_probe_that_times_out_leaves_the_clip_unmeasured(tmp_path, monkeypatch):
    clip = tmp_path / "x.mp4"
    clip.write_bytes(b"\x00")

    def slow(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

    monkeypatch.setattr(input_sizes.subprocess, "run", slow)
    assert input_sizes._probe_video(clip) is None
    assert input_sizes.SIZE_PROBE_TIMEOUT_SECONDS >= 30


# -- images: one frame, one size -----------------------------------------------

def _save(path: Path, frames: list[Image.Image], **options) -> Path:
    frames[0].save(path, save_all=True, append_images=frames[1:], **options)
    return path


@pytest.mark.parametrize("kind", ["gif", "apng", "tiff"])
def test_a_multi_frame_image_is_not_measured(tmp_path, kind):
    # Different pixels in each frame: Pillow merges identical frames when it saves.
    small, other = Image.new("RGB", (10, 10), (0, 0, 0)), Image.new("RGB", (10, 10), (255, 0, 0))
    big = Image.new("RGB", (3000, 3000), (0, 255, 0))
    path = {"gif": tmp_path / "a.gif", "apng": tmp_path / "a.png", "tiff": tmp_path / "a.tiff"}[kind]
    if kind == "apng":
        _save(path, [small, other], format="PNG")
    else:
        _save(path, [small, big])
    assert input_sizes._image_size(path) is None


def test_a_multi_size_icon_is_not_measured(tmp_path):
    path = tmp_path / "a.ico"
    Image.new("RGB", (256, 256)).save(path, sizes=[(16, 16), (256, 256)])
    assert input_sizes._image_size(path) is None


def test_a_single_frame_image_is_measured(tmp_path):
    path = _png(tmp_path / "one.png", 50, 40)
    assert input_sizes._image_size(path) == {"width": 50, "height": 40}
    gif = tmp_path / "one.gif"
    Image.new("RGB", (20, 30)).save(gif)
    assert input_sizes._image_size(gif) == {"width": 20, "height": 30}


# -- the event loop: measuring never blocks another request -----------------------

def test_measuring_on_the_event_loop_is_refused():
    """run_input_sizes and measure run in a worker thread (asyncio.to_thread):
    called on the loop, they raise instead of blocking it."""
    async def on_loop():
        with pytest.raises(RuntimeError, match="event loop"):
            input_sizes.run_input_sizes([], [], PRICING, REGISTRY)
        with pytest.raises(RuntimeError, match="event loop"):
            input_sizes.measure("/api/outputs/x.png", "Image")
    asyncio.run(on_loop())


def _slow_store_clip(monkeypatch, seconds=1.5):
    clip = _store("slow.mp4")
    clip.write_bytes(b"\x00" * 64)

    def slow_probe(path):
        time.sleep(seconds)
        return {"width": 64, "height": 48, "seconds": 2.0, "frames": 20}

    monkeypatch.setattr(input_sizes, "_probe_video", slow_probe)
    return clip


def _while_slow(request) -> tuple[float, bool, int]:
    """Start ``request`` (a coroutine factory taking the client), then time a
    health check while it waits on the slow probe."""
    import httpx

    import main

    async def go():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            slow = asyncio.create_task(request(http))
            await asyncio.sleep(0.3)
            started = time.monotonic()
            health = await http.get("/api/health")
            waited = time.monotonic() - started
            still_going = not slow.done()
            response = await slow
            assert health.status_code == 200
            return waited, still_going, response.status_code
    return asyncio.run(go())


def test_quick_measures_off_the_event_loop(client, monkeypatch):
    clip = _slow_store_clip(monkeypatch)
    _limit_video(client, 0.0000001)
    waited, still_going, status = _while_slow(lambda http: http.post("/api/quick", json={
        "definitionId": SEEDVR_VIDEO, "inputs": {"video": str(clip)}, "params": {}}))
    assert still_going and waited < 0.8
    assert status == 403  # measured, then held to the limit


def test_a_graph_run_measures_off_the_event_loop(client, monkeypatch):
    clip = _slow_store_clip(monkeypatch)
    _limit_video(client, 0.0000001)
    source = client.post("/api/graph/node", json={"definitionId": "video-input",
                                                  "params": {"filePath": str(clip)}}).json()["id"]
    up = client.post("/api/graph/node", json={"definitionId": SEEDVR_VIDEO, "params": {}}).json()["id"]
    client.post("/api/graph/connect", json={"source": source, "sourceHandle": "video", "target": up,
                                         "targetHandle": "video"})
    waited, still_going, status = _while_slow(lambda http: http.post("/api/graph/run", json={"targetNodeId": up}))
    assert still_going and waited < 0.8
    assert status == 403


def test_a_proposal_estimate_measures_off_the_event_loop(client, monkeypatch):
    from tests.test_canvas_proposals import CLAUDE

    clip = _slow_store_clip(monkeypatch)
    source = client.post("/api/graph/node", json={"definitionId": "video-input",
                                                  "params": {"filePath": str(clip)}}).json()["id"]
    body = {"note": "Upscale it", "nodes": [{"ref": "+up", "definitionId": SEEDVR_VIDEO}],
            "edges": [{"source": source, "sourceHandle": "video", "target": "+up", "targetHandle": "video"}],
            "run": ["+up"]}
    waited, still_going, status = _while_slow(
        lambda http: http.post("/api/canvas/proposals", json=body, headers=CLAUDE))
    assert still_going and waited < 0.8
    assert status == 201


# -- adding a local file to Nebula first: upload_file / `nebula upload` ----------

def _api_for(client):
    from nebula_api import NebulaAPI

    return NebulaAPI("http://testserver", client=client)


@needs_ffmpeg
def test_upload_puts_a_local_clip_in_the_store_and_that_copy_is_priced(client, tmp_path, monkeypatch):
    """The step the OUTSIDE refusal names: the copy is in Nebula's output
    folder, so the run is checked at its size."""
    import upload_client
    from services.output import OUTPUT_ROOT

    clip = _clip(tmp_path / "workspace" / "local.mp4")
    result = upload_client.upload(_api_for(client), str(clip))
    assert result["kind"] == "Video" and result["nodeId"]
    stored = Path(result["filePath"])
    assert stored.is_relative_to(OUTPUT_ROOT.resolve()) and stored.read_bytes() == clip.read_bytes()
    assert result["url"].startswith("/api/outputs/")
    assert input_sizes.measure(result["filePath"], "Video")["frames"] == 20

    _limit_video(client, 0.0000001)
    up = client.post("/api/graph/node", json={"definitionId": SEEDVR_VIDEO, "params": {}}).json()["id"]
    client.post("/api/graph/connect", json={"source": result["nodeId"], "sourceHandle": "video", "target": up,
                                         "targetHandle": "video"})
    refused = client.post("/api/graph/run", json={"targetNodeId": up})
    assert refused.status_code == 403
    detail = refused.json()["detail"]
    assert "$" in detail and "outside Nebula's output folder" not in detail and "no list price" not in detail


def test_upload_reads_only_the_turns_workspace(client, tmp_path):
    import upload_client
    from services.agent_workspaces import create_workspace, workspace_scope

    workspace = create_workspace(tmp_path / "state", brand="b")
    outside = _png(tmp_path / "elsewhere.png", 10, 10)
    with workspace_scope(workspace):
        with pytest.raises(upload_client.UploadError, match="outside this chat's workspace"):
            upload_client.upload(_api_for(client), str(outside))


def test_upload_refuses_a_link_put_in_place(client, tmp_path):
    import upload_client

    target = _png(tmp_path / "real.png", 10, 10)
    link = tmp_path / "link.png"
    link.symlink_to(target)
    result = upload_client.upload(_api_for(client), str(link))  # a link named by the caller resolves first
    assert result["kind"] == "Image"
    with pytest.raises(upload_client.UploadError):
        upload_client.upload(_api_for(client), str(tmp_path / "missing.mp4"))


def test_the_mcp_tool_and_the_cli_command_exist_and_are_documented():
    import mcp_server
    from cli.__main__ import build_parser
    from services.krea_agent_mcp import NEBULA_MCP_TOOLS

    assert "upload_file" in NEBULA_MCP_TOOLS
    assert callable(mcp_server.upload_file)
    args = build_parser().parse_args(["upload", "clip.mp4"])
    assert args.command == "upload" and args.file == "clip.mp4"
    root = Path(__file__).resolve().parents[2]
    for doc in ("docs/MCP-SETUP.md", "skills/nebula/SKILL.md"):
        text = (root / doc).read_text()
        assert "upload_file" in text and "nebula upload" in text


def test_archiving_skips_a_run_folder_still_being_written(client, tmp_path, monkeypatch):
    """A run still writing into a moved folder would leave a half-written
    file where the check measures (services/output.py is_being_written)."""
    import main
    from services import output

    root = tmp_path / "out"
    live = root / "2020-01-01_00-00-00_000000-live-0000abcd"
    done = root / "2020-01-01_00-00-00_000000-done-0000abcd"
    live.mkdir(parents=True)
    done.mkdir()
    for folder in (live, done):
        os.utime(folder, (0, 0))
    monkeypatch.setattr(main, "OUTPUT_ROOT", root)
    monkeypatch.setattr(output, "_LIVE_RUN_DIRS", {str(live.resolve())})
    archived = client.post("/api/outputs/archive", params={"older_than_days": 0}).json()["archived"]
    assert archived == [done.name] and live.is_dir()


# -- review 2026-10-21: the packet pass streams, under a cap ---------------------

def test_the_packet_pass_reads_a_line_at_a_time_and_stops_at_the_packet_cap(tmp_path, monkeypatch):
    """ffprobe's packet output is read as it comes, never held whole: past
    MAX_PROBE_PACKETS the clip is unmeasured and ffprobe is stopped."""
    clip = tmp_path / "x.mkv"
    clip.write_bytes(b"\x00")
    monkeypatch.setattr(input_sizes, "MAX_PROBE_PACKETS", 100)
    calls = _fake_probe(monkeypatch, [_video_stream()], _packets(1_000_000))
    assert input_sizes._probe_video(clip) is None
    process = calls.processes[-1]
    assert process.killed and process.read < 1_000  # a few lines past the cap, not a million packets


def test_a_clip_at_the_packet_cap_is_still_measured(tmp_path, monkeypatch):
    clip = tmp_path / "x.mkv"
    clip.write_bytes(b"\x00")
    monkeypatch.setattr(input_sizes, "MAX_PROBE_PACKETS", 60)
    _fake_probe(monkeypatch, [_video_stream()], _packets(60))
    size = input_sizes._probe_video(clip)
    assert size is not None and size["frames"] == 60
    assert input_sizes.MAX_PROBE_PACKETS == 60
    monkeypatch.undo()
    assert 1_000_000 <= input_sizes.MAX_PROBE_PACKETS <= 5_000_000


def test_the_packet_pass_stops_at_the_deadline(tmp_path, monkeypatch):
    clip = tmp_path / "x.mkv"
    clip.write_bytes(b"\x00")
    monkeypatch.setattr(input_sizes, "SIZE_PROBE_TIMEOUT_SECONDS", 0.5)
    calls = _fake_probe(monkeypatch, [_video_stream()], _packets(1_000_000), delay=0.01)
    started = time.monotonic()
    assert input_sizes._probe_video(clip) is None
    assert time.monotonic() - started < 3
    assert calls.processes[-1].killed


def test_an_overlong_or_malformed_packet_line_leaves_the_clip_unmeasured(tmp_path, monkeypatch):
    clip = tmp_path / "x.mkv"
    clip.write_bytes(b"\x00")
    lines = ["[PACKET]\n", "pts_time=0.0\n", "x" * (input_sizes.MAX_PROBE_LINE + 10), "[/PACKET]\n"]
    _fake_probe(monkeypatch, [_video_stream()], [], lines=lines)
    assert input_sizes._probe_video(clip) is None


@needs_ffmpeg
def test_a_real_clip_past_the_packet_cap_is_not_measured(tmp_path, monkeypatch):
    clip = _clip(tmp_path / "x.mkv", seconds=6)
    monkeypatch.setattr(input_sizes, "MAX_PROBE_PACKETS", 59)
    assert input_sizes._probe_video(clip) is None
    monkeypatch.setattr(input_sizes, "MAX_PROBE_PACKETS", 60)
    size = input_sizes._probe_video(clip)
    assert size is not None and size["frames"] == 60


# -- review 2026-10-21: a volume with no hard links (exFAT, FAT, some SMB) -------

def _no_hard_links(monkeypatch, code=None):
    import errno

    def refuse(src, dst, *args, **kwargs):
        raise OSError(code or errno.ENOTSUP, "Operation not supported")

    monkeypatch.setattr(os, "link", refuse)


def test_a_new_store_file_is_written_where_the_volume_has_no_hard_links(tmp_path, monkeypatch):
    from services import output

    _no_hard_links(monkeypatch)
    seen: list[bool] = []
    real_copy = output.shutil.copyfileobj

    def spy(source, target, *args, **kwargs):
        seen.append(output.is_being_written(tmp_path / "a.bin"))
        return real_copy(source, target, *args, **kwargs)

    monkeypatch.setattr(output.shutil, "copyfileobj", spy)
    target = tmp_path / "a.bin"
    assert output.write_new_file(target, b"first") is True
    assert output.write_new_file(target, b"second") is False
    assert target.read_bytes() == b"first"
    assert [p.name for p in tmp_path.iterdir()] == ["a.bin"]
    # While the bytes are copied in at the final name, it reads as being written (never measured).
    assert seen and seen[0] is True
    assert output.is_being_written(target) is False


def test_other_link_errors_still_raise(tmp_path, monkeypatch):
    import errno

    from services.output import write_new_file

    _no_hard_links(monkeypatch, errno.EACCES)
    with pytest.raises(PermissionError):
        write_new_file(tmp_path / "a.bin", b"x")
    assert list(tmp_path.iterdir()) == []


def test_an_upload_works_where_the_volume_has_no_hard_links(client, monkeypatch):
    _no_hard_links(monkeypatch)
    buffer = io.BytesIO()
    Image.new("RGB", (13, 11), (4, 5, 6)).save(buffer, "PNG")
    response = client.post("/api/uploads", files={"file": ("x.png", buffer.getvalue(), "image/png")})
    assert response.status_code == 200, response.text
    stored = Path(response.json()["filePath"])
    assert stored.read_bytes() == buffer.getvalue()


def test_an_export_works_where_the_volume_has_no_hard_links(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import main
    from services import output
    from services.settings import DEFAULT_SETTINGS

    monkeypatch.setattr(output, "OUTPUT_ROOT", tmp_path)
    monkeypatch.setattr(main, "OUTPUT_ROOT", tmp_path)
    (tmp_path / "run1").mkdir()
    (tmp_path / "run1" / "img.png").write_bytes(b"data")
    exports = tmp_path / "exports"
    monkeypatch.setattr(main, "load_settings", lambda: {**DEFAULT_SETTINGS, "exportFolder": str(exports)})
    _no_hard_links(monkeypatch)
    http = TestClient(main.app)
    first = http.post("/api/export", json={"url": "/api/outputs/run1/img.png"})
    assert first.status_code == 200, first.text
    second = http.post("/api/export", json={"url": "/api/outputs/run1/img.png"})
    assert second.status_code == 200, second.text
    assert Path(first.json()["savedPath"]).name == "img.png"
    assert Path(second.json()["savedPath"]).name == "img -1.png"
    assert sorted(p.name for p in exports.iterdir()) == ["img -1.png", "img.png"]


# -- review 2026-10-21: the outside refusal never names a step that just failed ---

def test_an_outside_image_is_not_sent_back_to_quick():
    """Every run route has already tried to copy an outside image in; it
    stays outside only when that import refused it (over 20 MB, or not an
    image Nebula recognises), which `nebula quick` and the upload refuse too."""
    refusal = _decide_why("outside", SEEDVR, "image")
    assert "nebula quick" not in refusal
    assert "20 MB" in refusal and "propose" in refusal
    assert "`nebula upload <file>`" in refusal


def test_an_outside_clip_names_the_upload_limit():
    import main

    refusal = _decide_why("outside", SEEDVR_VIDEO, "video")
    assert "nebula quick" not in refusal and "500 MB" in refusal
    # The sizes the refusal names are the upload route's own caps.
    assert main.MAX_CHAT_UPLOAD_BYTES == 20 * 1024 * 1024 and main.MAX_VIDEO_UPLOAD_BYTES == 500 * 1024 * 1024


# -- review 2026-10-21: an agent's upload is journaled like any agent edit -------

def _node_added_since(client, headers, node_id, since_ms):
    """Every node.added event for ``node_id`` at or after ``since_ms``, read
    page by page (the journal is shared by every test in the session)."""
    found, after = [], 0
    while True:
        page = client.get(f"/api/canvas/events?after={after}&self=1&limit=100&kinds=node.added",
                          headers=headers).json()
        events = page["events"]
        found += [e for e in events if e.get("nodeId") == node_id and e["at"] >= since_ms]
        if not events or page["cursor"] <= after:
            return found
        after = page["cursor"]


def _upload_node(client, headers, size):
    buffer = io.BytesIO()
    Image.new("RGB", size, (7, 8, 9)).save(buffer, "PNG")
    since = int(time.time() * 1000) - 1
    response = client.post("/api/uploads", data={"create_node": "true"}, headers=headers,
                           files={"file": ("x.png", buffer.getvalue(), "image/png")})
    assert response.status_code == 200, response.text
    node_id = response.json()["nodeId"]
    return _node_added_since(client, headers, node_id, since)


def test_an_agent_upload_that_adds_a_node_is_journaled_as_the_agents(client):
    from tests.test_canvas_events import AGENT

    added = _upload_node(client, AGENT, (14, 9))
    assert len(added) == 1, added
    assert added[0]["actor"]["kind"] == "agent" and added[0]["actor"]["name"] == "Claude Code"
    assert added[0]["data"]["definitionId"] == "image-input"


def test_a_person_upload_that_adds_a_node_is_journaled_as_theirs(client):
    added = _upload_node(client, PERSON, (15, 9))
    assert len(added) == 1, added
    assert added[0]["actor"]["kind"] == "person"


# -- review 2026-10-21: `nebula upload` names the port each kind has -------------

@pytest.mark.parametrize(("kind", "port"), [("Image", "image"), ("Video", "video"), ("Document", "text")])
def test_nebula_upload_prints_the_real_output_port(kind, port, monkeypatch, capsys):
    import upload_client
    from cli.commands import upload as upload_command

    monkeypatch.setattr(upload_client, "upload", lambda api, source, headers=None: {
        "kind": kind, "nodeId": "n8", "filename": "f", "url": "/api/outputs/chat-uploads/f"})

    class FakeClient:
        api = object()

        def _identity_headers(self):
            return {}

    upload_command.run(FakeClient(), "f")
    out = capsys.readouterr().out
    assert f"nebula connect n8:{port} <node>:<port>" in out
