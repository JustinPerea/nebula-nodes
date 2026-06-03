from execution import engine
from services import output as output_mod


def test_image_input_resolves_api_outputs_url(tmp_path, monkeypatch):
    # An image-input whose filePath is a served /api/outputs URL must resolve to
    # the absolute on-disk path in the node's Image output.
    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", tmp_path)
    f = tmp_path / "run1" / "img.png"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"\x89PNG\r\n\x1a\n")
    out = engine._image_input_output({"filePath": "/api/outputs/run1/img.png"})
    assert out["image"]["value"] == str(f.resolve())
