from pathlib import Path
from services.output import resolve_output_ref, OUTPUT_ROOT


def test_passes_through_absolute_paths():
    assert resolve_output_ref("/tmp/x.png") == "/tmp/x.png"

def test_passes_through_http_and_data_urls():
    assert resolve_output_ref("https://x/y.png") == "https://x/y.png"
    assert resolve_output_ref("data:image/png;base64,AAAA") == "data:image/png;base64,AAAA"

def test_resolves_api_outputs_url_to_absolute():
    got = resolve_output_ref("/api/outputs/run1/abc.png")
    assert got == str((OUTPUT_ROOT / "run1" / "abc.png").resolve())

def test_blocks_path_traversal():
    # ../ escapes must not resolve outside OUTPUT_ROOT
    got = resolve_output_ref("/api/outputs/../../etc/passwd")
    assert got == "/api/outputs/../../etc/passwd"  # refused → returned unchanged
