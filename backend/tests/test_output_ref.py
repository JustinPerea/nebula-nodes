from pathlib import Path
import pytest
from services.output import resolve_output_ref, portable_output_ref, OUTPUT_ROOT


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


@pytest.mark.parametrize("filename", ["clip with spaces.mp4", "logo-é.png", "literal%20clip.mp4"])
def test_roundtrips_canonical_escaped_filenames(filename):
    source = (OUTPUT_ROOT / "restored" / filename).resolve()
    ref = portable_output_ref(str(source))
    assert resolve_output_ref(ref) == str(source)


@pytest.mark.parametrize("ref", [
    "/api/outputs/%2e%2e/outside.mp4",
    "/api/outputs/one%2ftwo.mp4",
    "/api/outputs/one%5ctwo.mp4",
    "/api/outputs/bad%00.mp4",
    "/api/outputs/clip%GG.mp4",
    "/api/outputs/clip.mp4?token=fixture",
])
def test_refuses_unsafe_or_noncanonical_served_references(ref):
    assert resolve_output_ref(ref) == ref


def test_refuses_owned_reference_to_symlink_escape(tmp_path):
    link = OUTPUT_ROOT / "resolver-escape-test"
    link.symlink_to(tmp_path, target_is_directory=True)
    try:
        ref = "/api/outputs/resolver-escape-test/outside.mp4"
        assert resolve_output_ref(ref) == ref
    finally:
        link.unlink()
