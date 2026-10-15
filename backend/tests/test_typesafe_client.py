"""services/typesafe_client.py: request building, image preparation, retries,
error mapping and response parsing. httpx is mocked; nothing reaches TypeSafe."""
from __future__ import annotations

import base64
import email
import io
import json
import re
import uuid

import httpx
import pytest
from PIL import Image

from execution.missing_credential import MissingCredentialError
from services import typesafe_client as ts

KEY = "ts-test-key-123"
NOUL = {"model": "jev-1.14.0", "answers": {"q": {"type": "noul", "noul": 0.9}},
        "usage": {"input_tokens": 296, "output_tokens": 20}}


def _data_uri(image: Image.Image, fmt: str = "PNG", **save) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **save)
    mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif"}[fmt]
    return f"data:{mime};base64,{base64.b64encode(buffer.getvalue()).decode()}"


def _install(monkeypatch, respond):
    """Route system_one through an httpx.MockTransport; record requests and sleeps."""
    calls: list[httpx.Request] = []
    sleeps: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return respond(request, len(calls))

    monkeypatch.setattr(ts, "_make_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(ts, "_sleep", fake_sleep)
    return calls, sleeps


def _parts(request: httpx.Request) -> list[tuple[str, str, bytes]]:
    """(name, content type, payload) for each multipart part, in order."""
    raw = b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + request.content
    message = email.message_from_bytes(raw)
    return [(part.get_param("name", header="content-disposition"), part.get_content_type(),
             part.get_payload(decode=True)) for part in message.get_payload()]


def _ask(**overrides):
    kwargs = {"model": "jev-1.14.0", "state": "A red mug on a desk.",
              "questions": {"q": {"type": "noul", "instructions": "Is there a mug?"}}}
    kwargs.update(overrides)
    return ts.system_one(KEY, **kwargs)


# -- request shape ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_text_request_is_plain_json_with_bearer_auth_and_no_danger_headers(monkeypatch):
    calls, _ = _install(monkeypatch, lambda request, n: httpx.Response(200, json=NOUL))

    result = await _ask(model="jev-latest")

    request = calls[0]
    assert str(request.url) == "https://api.typesafe.ai/v1/systemone"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert request.headers["content-type"] == "application/json"
    assert ts.IMAGES_HEADER.lower() not in request.headers
    assert ts.LONG_CONTEXT_HEADER.lower() not in request.headers
    body = json.loads(request.content)
    assert body == {"model": "jev-latest", "state": "A red mug on a desk.",
                    "questions": {"q": {"type": "noul", "instructions": "Is there a mug?"}}}
    # The real versioned id that answered is kept apart from the alias asked for.
    assert (result.model, result.requested_model) == ("jev-1.14.0", "jev-latest")
    assert (result.input_tokens, result.output_tokens) == (296, 20)


@pytest.mark.asyncio
async def test_long_context_header_only_when_turned_on(monkeypatch):
    calls, _ = _install(monkeypatch, lambda request, n: httpx.Response(200, json=NOUL))
    await _ask(long_context=True)
    await _ask(long_context=False)
    assert calls[0].headers[ts.LONG_CONTEXT_HEADER] == "true"
    assert ts.LONG_CONTEXT_HEADER.lower() not in calls[1].headers


def test_a_box_question_turns_on_images_even_without_an_image():
    headers, _ = ts.build_request(model="jev-1.14.0", state="x",
                                  questions={"where": {"type": "box", "instructions": "the mug"}})
    assert headers[ts.IMAGES_HEADER] == "true"


@pytest.mark.asyncio
async def test_images_go_multipart_with_fresh_uuid_placeholders_each_referenced_once(monkeypatch):
    calls, _ = _install(monkeypatch, lambda request, n: httpx.Response(200, json=NOUL))
    images = await ts.prepare_images([
        _data_uri(Image.new("RGB", (600, 400), "red")),
        _data_uri(Image.new("RGB", (500, 500), "blue"), "JPEG"),
    ])
    placeholders = [image.placeholder for image in images]
    assert len(set(placeholders)) == 2
    assert all(uuid.UUID(p).version == 4 for p in placeholders)

    await _ask(state={"images": placeholders}, images=images)

    request = calls[0]
    assert request.headers[ts.IMAGES_HEADER] == "true"
    parts = _parts(request)
    assert [name for name, _type, _ in parts] == ["request", "image-1", "image-2"]
    assert parts[0][1] == "application/json"
    body = json.loads(parts[0][2])
    assert body["model"] == "jev-1.14.0"
    assert body["assets"] == {
        images[0].placeholder: {"type": "image", "part": "image-1", "format": images[0].format},
        images[1].placeholder: {"type": "image", "part": "image-2", "format": images[1].format},
    }
    for (name, content_type, payload), image in zip(parts[1:], images):
        assert content_type == image.mime and payload == image.data
    content = json.dumps({"state": body["state"], "questions": body["questions"]})
    assert all(content.count(p) == 1 for p in placeholders)


@pytest.mark.parametrize("state", [{"a": "nothing"}, None])
def test_an_unreferenced_or_doubled_image_fails_before_sending(state):
    image = ts.PreparedImage(source="x", placeholder=str(uuid.uuid4()), part="image-1", data=b"x", format="png",
                             transform=None)  # type: ignore[arg-type]
    if state is None:
        state = {"a": image.placeholder, "b": image.placeholder}
    with pytest.raises(RuntimeError, match="placeholder"):
        ts.build_request(model="jev-1.14.0", state=state,
                         questions={"q": {"type": "noul", "instructions": "?"}}, images=[image])


def test_model_ids_are_sent_verbatim_and_checked_for_shape():
    for model in ts.MODELS:
        _headers, kwargs = ts.build_request(model=model, state="x", questions={"q": {"type": "noul",
                                                                                      "instructions": "?"}})
        assert json.loads(kwargs["content"])["model"] == model
    assert ts.check_model("") == ts.DEFAULT_MODEL
    with pytest.raises(ValueError, match="Unknown Jev model"):
        ts.check_model("gpt-4o")


@pytest.mark.asyncio
async def test_a_missing_key_raises_before_any_request(monkeypatch):
    calls, _ = _install(monkeypatch, lambda request, n: httpx.Response(200, json=NOUL))
    with pytest.raises(MissingCredentialError, match="TYPESAFE_API_KEY"):
        await ts.system_one("", model="jev-1.14.0", state="x", questions={"q": {"type": "noul",
                                                                                  "instructions": "?"}})
    assert calls == []


# -- retries ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_overloaded_and_rate_limited_responses_are_retried_with_backoff(monkeypatch):
    statuses = [529, 429]
    calls, sleeps = _install(monkeypatch, lambda request, n: httpx.Response(statuses[n - 1]) if n <= 2
                             else httpx.Response(200, json=NOUL))
    result = await _ask()
    assert len(calls) == 3 and result.answers["q"].noul == 0.9
    assert len(sleeps) == 2 and 0 < sleeps[0] <= ts.BACKOFF_INITIAL and sleeps[1] <= 2 * ts.BACKOFF_INITIAL


@pytest.mark.asyncio
async def test_retry_after_is_honoured_and_capped(monkeypatch):
    waits = iter(["3", "600"])
    calls, sleeps = _install(monkeypatch, lambda request, n: httpx.Response(
        429, headers={"retry-after": next(waits)}) if n <= 2 else httpx.Response(200, json=NOUL))
    await _ask()
    assert sleeps == [3.0, ts.RETRY_AFTER_MAX]


@pytest.mark.asyncio
@pytest.mark.parametrize(("status", "phrase"), [(429, "rate limit hit (429) after 3 tries"),
                                               (529, "overloaded (529) after 3 tries"),
                                               (503, "server error (503) after 3 tries"),
                                               (408, "timed out (408) after 3 tries")])
async def test_gives_up_after_two_retries_with_a_clear_message(monkeypatch, status, phrase):
    calls, _ = _install(monkeypatch, lambda request, n: httpx.Response(status, json={"message": "busy"}))
    with pytest.raises(ts.TypeSafeError, match=re.escape(phrase)):
        await _ask()
    assert len(calls) == ts.MAX_RETRIES + 1


@pytest.mark.asyncio
async def test_client_errors_are_not_retried(monkeypatch):
    calls, _ = _install(monkeypatch, lambda request, n: httpx.Response(400, json={"message": "bad"}))
    with pytest.raises(ts.TypeSafeError):
        await _ask()
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_connection_failures_are_retried_then_reported(monkeypatch):
    def fail(request, n):
        raise httpx.ConnectError("refused", request=request)

    calls, _ = _install(monkeypatch, fail)
    with pytest.raises(ts.TypeSafeError, match="Couldn't reach TypeSafe"):
        await _ask()
    assert len(calls) == 3


# -- errors ----------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("status", "body", "expected"), [
    (400, {"error": {"code": "max_tokens_exceeded", "message": "too long"}},
     "fewer or smaller images, shorten the context, or turn on Long context"),
    (400, {"message": "Images are not turned on"}, "refused the images"),
    (400, {"message": "unknown field"}, "rejected the request (400 bad request): unknown field"),
    (401, {"message": f"bad key {KEY}"}, "TypeSafe rejected TYPESAFE_API_KEY (401 unauthorized)"),
    (413, {"message": "body too large"}, "too large (413)"),
    (415, {}, "couldn't read the request encoding (415)"),
    (422, {"detail": [{"loc": ["body", "questions", "q", "criteria"], "msg": "field required"}]},
     "(422): body.questions.q.criteria: field required"),
])
async def test_errors_are_actionable_and_never_hold_the_key(monkeypatch, status, body, expected):
    _install(monkeypatch, lambda request, n: httpx.Response(status, json=body,
                                                            headers={ts.REQUEST_ID_HEADER: "req-1"}))
    with pytest.raises(ts.TypeSafeError) as caught:
        await _ask()
    message = str(caught.value)
    assert expected in message
    assert KEY not in message
    assert caught.value.status == status and caught.value.request_id == "req-1"


# Error bodies exactly as TypeSafe sent them in the live probe (2026-10-14).
LIVE_IMAGES_OFF = {"detail": {"error_type": "api_usage_error", "message": (
    "Images are experimental. Send the header TypeSafe-Danger-Zone-Images: true to use them.")}}
LIVE_BAD_KEY = {"detail": {"error_type": "authentication_error", "message": (
    "Cannot authenticate with the server. Please check your API key and try again.")}}


@pytest.mark.asyncio
async def test_the_live_images_header_error_reads_its_message_and_type(monkeypatch):
    _install(monkeypatch, lambda request, n: httpx.Response(400, json=LIVE_IMAGES_OFF,
                                                            headers={ts.REQUEST_ID_HEADER: "req-5"}))
    images = await ts.prepare_images([_data_uri(Image.new("RGB", (300, 300)))])
    with pytest.raises(ts.TypeSafeError) as caught:
        await _ask(state={"image": images[0].placeholder}, images=images)
    message = str(caught.value)
    assert message.startswith("TypeSafe refused the images (400): Images are experimental. "
                              "Send the header TypeSafe-Danger-Zone-Images: true to use them. This build")
    assert "may have renamed it or changed its value" in message
    assert message.endswith("[request req-5]")
    assert caught.value.code == "api_usage_error"


@pytest.mark.asyncio
async def test_the_live_auth_error_reads_its_message_and_type(monkeypatch):
    _install(monkeypatch, lambda request, n: httpx.Response(401, json=LIVE_BAD_KEY))
    with pytest.raises(ts.TypeSafeError) as caught:
        await _ask()
    assert str(caught.value) == (
        "TypeSafe rejected TYPESAFE_API_KEY (401 unauthorized): Cannot authenticate with the server. "
        "Please check your API key and try again. Check the key in Settings → TypeSafe.")
    assert caught.value.code == "authentication_error"


def test_nested_detail_messages_stay_capped_and_key_free():
    body = {"detail": {"error_type": "api_usage_error", "message": f"key {KEY} " + "x" * 500}}
    text, code = ts._error_detail(httpx.Response(400, json=body), KEY)
    assert KEY not in text and "***" in text
    assert len(text) == 301 and text.endswith("…")
    assert code == "api_usage_error"


def test_max_tokens_exceeded_wins_over_a_broad_error_type():
    body = {"detail": {"error_type": "api_usage_error", "message": "max_tokens_exceeded: 40000 > 32768"}}
    assert ts._error_detail(httpx.Response(400, json=body), KEY)[1] == "max_tokens_exceeded"


@pytest.mark.asyncio
async def test_an_image_rejection_says_what_to_do(monkeypatch):
    _install(monkeypatch, lambda request, n: httpx.Response(400, json={"message": "asset image-1 is damaged"}))
    images = await ts.prepare_images([_data_uri(Image.new("RGB", (300, 300)))])
    with pytest.raises(ts.TypeSafeError, match="rejected an image .* Re-export it as PNG or JPEG"):
        await _ask(state={"image": images[0].placeholder}, images=images)


# -- responses -------------------------------------------------------------------


def test_every_answer_type_parses():
    result = ts.parse_response({
        "model": "jev-1.14.0",
        "answers": {
            "n": {"type": "noul", "noul": 0.25},
            "c": {"type": "choice", "choice": "b", "probabilities": {"a": 0.2, "b": 0.8}, "confidence": 0.6},
            "s": {"type": "score", "score": 1.4, "legend": {"0": "x", "1": "y", "2": "z"},
                  "probabilities": {"0": 0.1, "1": 0.4, "2": 0.5}, "confidence": 0.35},
            "b": {"type": "box", "box": {"top": 0.1, "bottom": 0.5, "left": 0.2, "right": 0.9}, "confidence": None},
        },
        "usage": {"input_tokens": 290},
    }, requested_model="jev-1.14.0")
    assert result.answer("n", "noul").noul == 0.25
    assert result.answer("c", "choice").choice == "b"
    assert result.answer("s", "score").score == 1.4
    box = result.answer("b", "box")
    assert box.box == {"top": 0.1, "bottom": 0.5, "left": 0.2, "right": 0.9}
    assert box.confidence is None  # null stays null, never 0
    assert result.output_tokens is None
    with pytest.raises(ts.TypeSafeError, match="no score answer"):
        result.answer("n", "score")


@pytest.mark.parametrize("body", [{}, {"answers": {"q": {"type": "noul"}}}, {"answers": {"q": {"type": "mystery"}}},
                                  {"answers": {"q": {"type": "box", "box": {"top": 0.1}}}}])
def test_unreadable_responses_raise_a_typesafe_error(body):
    with pytest.raises(ts.TypeSafeError, match="can't read"):
        ts.parse_response(body, requested_model="jev-1.14.0")


# -- question helpers ------------------------------------------------------------


def test_neutral_keys_run_a_to_z_then_aa():
    keys = ts.neutral_keys(ts.MAX_CHOICE_OPTIONS)
    assert keys[:3] == ["a", "b", "c"] and keys[25:28] == ["z", "aa", "ab"]
    assert len(set(keys)) == ts.MAX_CHOICE_OPTIONS
    with pytest.raises(ValueError):
        ts.neutral_keys(ts.MAX_CHOICE_OPTIONS + 1)


def test_choice_options_send_neutral_keys_and_read_back_labels():
    options = ts.ChoiceOptions.from_labels(["On brief", "Off brief", "Unclear"])
    assert options.criteria() == {"a": "On brief", "b": "Off brief", "c": "Unclear"}
    assert options.criteria(["<img1>", "<img2>", "<img3>"]) == {"a": "<img1>", "b": "<img2>", "c": "<img3>"}
    reading = options.read(ts.JevAnswer(type="choice", choice="b", probabilities={"a": 0.1, "b": 0.85, "c": 0.05},
                                        confidence=0.78))
    assert (reading.label, reading.index, reading.probability, reading.confidence) == ("Off brief", 1, 0.85, 0.78)
    assert list(reading.probabilities) == ["On brief", "Off brief", "Unclear"]
    with pytest.raises(ValueError):
        ts.ChoiceOptions.from_labels(["same", "same"])
    with pytest.raises(ts.TypeSafeError):
        options.read(ts.JevAnswer(type="choice", choice="z"))


def test_score_uses_criteria_and_reads_the_most_likely_level():
    levels = ts.score_criteria(["Calm", "Frustrated", "Very angry"])
    reading = ts.read_score(ts.JevAnswer(type="score", score=1.05, probabilities={"0": 0.0, "1": 0.95, "2": 0.05},
                                         confidence=0.92), levels)
    assert reading.normalized == pytest.approx(0.525)
    assert (reading.level, reading.label) == (1, "Frustrated")
    with pytest.raises(ValueError):
        ts.score_criteria(["only one"])
    with pytest.raises(ValueError):
        ts.score_criteria([str(i) for i in range(11)])


def test_noul_confidence_is_distance_from_a_coin_flip():
    assert ts.noul_confidence(0.5) == 0
    assert ts.noul_confidence(0.9) == pytest.approx(0.8)
    assert ts.noul_confidence(0.1) == pytest.approx(0.8)
    assert ts.noul_confidence(1.0) == 1


# -- image preparation -----------------------------------------------------------


@pytest.mark.asyncio
async def test_a_big_webp_shrinks_to_the_long_side_limit():
    [image] = await ts.prepare_images([_data_uri(Image.new("RGB", (4096, 2048), "green"), "WEBP")])
    sent = Image.open(io.BytesIO(image.data))
    assert sent.format in {"PNG", "JPEG"} and max(sent.size) == ts.MAX_SIDE
    transform = image.transform
    assert (transform.width, transform.height, transform.source_format) == (4096, 2048, "WEBP")
    assert (transform.sent_width, transform.sent_height) == (1568, 784) and not transform.padded


@pytest.mark.asyncio
async def test_max_side_shrinks_further_for_a_retry_and_boxes_still_map_back():
    [image] = await ts.prepare_images([_data_uri(Image.new("RGB", (2000, 1000), "green"))], max_side=768)
    t = image.transform
    assert (t.sent_width, t.sent_height) == (768, 384) and (t.width, t.height) == (2000, 1000)
    assert t.to_original_box(top=0.5, bottom=1, left=0.25, right=0.5)["px"] == {"x": 500, "y": 500, "w": 500, "h": 500}
    for bad in (100, 2000):
        with pytest.raises(ValueError, match="max_side must be from 256 to 1568"):
            await ts.prepare_images([], max_side=bad)


@pytest.mark.asyncio
async def test_a_small_image_is_padded_never_stretched():
    [image] = await ts.prepare_images([_data_uri(Image.new("RGBA", (200, 200), (0, 0, 255, 128)))])
    t = image.transform
    assert (t.content_width, t.content_height) == (200, 200) and t.scale_x == 1.0
    assert (t.sent_width, t.sent_height) == (280, 280) and (t.pad_left, t.pad_top) == (40, 40)
    assert image.format == "png"  # alpha keeps PNG
    sent = Image.open(io.BytesIO(image.data))
    assert sent.size[0] >= ts.MIN_SIDE and sent.size[0] * sent.size[1] >= ts.MIN_PIXELS
    assert sent.getpixel((0, 0))[3] == 0  # transparent padding


@pytest.mark.parametrize(("size", "expected"), [((256, 256), (280, 280)), ((256, 300), (259, 304)),
                                                ((1568, 40), (1568, 256)), ((300, 300), (300, 300))])
def test_padding_meets_both_the_side_and_the_area_minimum(size, expected):
    _cw, _ch, width, height = ts._target_size(*size)
    assert (width, height) == expected
    assert width >= ts.MIN_SIDE and height >= ts.MIN_SIDE and width * height >= ts.MIN_PIXELS


@pytest.mark.asyncio
async def test_exif_rotation_is_applied_to_the_pixels():
    photo = Image.new("RGB", (400, 300), "white")
    photo.paste((255, 0, 0), (0, 0, 40, 40))  # red mark at the stored top-left
    exif = Image.Exif()
    exif[0x0112] = 6  # display rotated 90 degrees clockwise
    [image] = await ts.prepare_images([_data_uri(photo, "JPEG", exif=exif.tobytes())])
    t = image.transform
    assert t.transposed and (t.source_width, t.source_height) == (400, 300) and (t.width, t.height) == (300, 400)
    sent = Image.open(io.BytesIO(image.data)).convert("RGB")
    assert sent.size == (300, 400)
    r, g, b = sent.getpixel((295, 5))  # the mark lands top-right once upright
    assert r > 200 and g < 80 and b < 80


@pytest.mark.asyncio
async def test_an_animation_sends_its_first_frame_as_a_still():
    frames = [Image.new("RGB", (300, 300), color) for color in ("red", "blue", "green")]
    buffer = io.BytesIO()
    frames[0].save(buffer, format="GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    uri = "data:image/gif;base64," + base64.b64encode(buffer.getvalue()).decode()
    [image] = await ts.prepare_images([uri])
    sent = Image.open(io.BytesIO(image.data))
    assert getattr(sent, "n_frames", 1) == 1 and image.transform.frames == 3
    r, g, b = sent.convert("RGB").getpixel((150, 150))
    assert r > 200 and g < 60 and b < 60


@pytest.mark.asyncio
async def test_oversized_canvases_are_refused_before_decoding(monkeypatch):
    monkeypatch.setattr(ts, "MAX_SOURCE_PIXELS", 10_000)
    with pytest.raises(ValueError, match="megapixel input limit"):
        await ts.prepare_images([_data_uri(Image.new("RGB", (300, 300)))])


@pytest.mark.asyncio
async def test_non_images_are_refused_with_a_readable_error():
    with pytest.raises(ValueError, match="isn't an image"):
        await ts.prepare_images(["data:image/png;base64," + base64.b64encode(b"not an image").decode()])


@pytest.mark.asyncio
async def test_too_many_images_are_refused(monkeypatch):
    with pytest.raises(ValueError, match="at most 2"):
        await ts.prepare_images(["a", "b", "c"], max_images=2)


def test_images_are_re_encoded_smaller_to_fit_the_request(monkeypatch):
    noisy = Image.effect_noise((1200, 1200), 90).convert("RGB")
    buffer = io.BytesIO()
    noisy.save(buffer, format="PNG")
    sources = [("a", buffer.getvalue()), ("b", buffer.getvalue())]
    roomy = ts._prepare_all(sources, "Image", budget=10**9)
    assert [image.format for image in roomy] == ["png", "png"]  # PNG input stays PNG when it fits
    budget = sum(len(image.data) for image in roomy) // 3
    tight = ts._prepare_all(sources, "Image", budget=budget)
    assert sum(len(image.data) for image in tight) <= budget
    assert all(image.format == "jpg" and image.transform.quality for image in tight)
    with pytest.raises(ValueError, match="32 MiB request limit"):
        ts._prepare_all(sources, "Image", budget=1000)


def test_boxes_map_back_through_scale_and_padding():
    transform = ts.ImageTransform(
        source_width=3136, source_height=200, exif_orientation=1, width=3136, height=200,
        scale_x=0.5, scale_y=0.5, content_width=1568, content_height=100, pad_left=0, pad_top=78,
        sent_width=1568, sent_height=256, source_format="PNG", frames=1, sent_format="png")
    # The content spans sent rows 78..178; a box over its middle half.
    mapped = transform.to_original_box(top=103 / 256, bottom=153 / 256, left=0.25, right=0.75)
    assert mapped["image"] == {"w": 3136, "h": 200}
    assert mapped["px"] == {"x": 784, "y": 50, "w": 1568, "h": 100}
    assert (mapped["top"], mapped["bottom"], mapped["left"], mapped["right"]) == (0.25, 0.75, 0.25, 0.75)
    # A box that strays into the padding is clamped to the image.
    edge = transform.to_original_box(top=0.0, bottom=1.0, left=0.0, right=1.0)
    assert edge["px"] == {"x": 0, "y": 0, "w": 3136, "h": 200} and edge["top"] == 0 and edge["bottom"] == 1


# -- loading ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_output_references_load_from_the_output_root():
    import main

    picture = main.OUTPUT_ROOT / f"jev-{uuid.uuid4().hex}.png"
    Image.new("RGB", (300, 300), "red").save(picture)
    try:
        expected = picture.read_bytes()
        assert await ts.load_image_source(f"/api/outputs/{picture.name}") == expected
        assert await ts.load_image_source(f"http://localhost:8000/api/outputs/{picture.name}") == expected
        assert await ts.load_image_source(str(picture)) == expected
    finally:
        picture.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_remote_urls_use_the_public_media_fetcher(monkeypatch):
    seen = {}

    async def fake_fetch(url, *, label, max_bytes, timeout=300.0):
        seen.update(url=url, max_bytes=max_bytes)
        return b"bytes", "image/png"

    monkeypatch.setattr("services.public_url.fetch_public_media", fake_fetch)
    assert await ts.load_image_source("https://cdn.example.com/a.png") == b"bytes"
    assert seen == {"url": "https://cdn.example.com/a.png", "max_bytes": ts.MAX_SOURCE_BYTES}


@pytest.mark.asyncio
async def test_missing_files_and_escaping_references_fail_loudly(tmp_path):
    with pytest.raises(ValueError, match="not found"):
        await ts.load_image_source(str(tmp_path / "missing.png"))
    with pytest.raises(ValueError, match="escapes"):
        await ts.load_image_source("/api/outputs/../../etc/passwd")


# -- hardening -------------------------------------------------------------------


EPS = (b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 300 300\n"
       b"newpath 0 0 moveto 300 300 lineto stroke showpage\n%%EOF\n")


@pytest.mark.asyncio
async def test_only_png_jpeg_webp_and_gif_reach_a_decoder(monkeypatch):
    # Pillow opens EPS by default and decodes it by running Ghostscript. An
    # image input from a URL or data URI must never get that far.
    from PIL import EpsImagePlugin

    def no_ghostscript(*args, **kwargs):
        raise AssertionError("Ghostscript was invoked on an untrusted image")

    monkeypatch.setattr(EpsImagePlugin.EpsImageFile, "load", no_ghostscript)
    for fmt, payload in (("EPS", EPS), ("BMP", None), ("TIFF", None)):
        if payload is None:
            buffer = io.BytesIO()
            Image.new("RGB", (300, 300), "red").save(buffer, format=fmt)
            payload = buffer.getvalue()
        uri = "data:image/png;base64," + base64.b64encode(payload).decode()
        with pytest.raises(ValueError, match="isn't an image Nebula can read"):
            await ts.prepare_images([uri])


@pytest.mark.asyncio
async def test_camera_multi_picture_jpegs_still_load():
    buffer = io.BytesIO()
    Image.new("RGB", (300, 300), "red").save(buffer, format="MPO", save_all=True,
                                             append_images=[Image.new("RGB", (300, 300), "blue")])
    [image] = await ts.prepare_images(["data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()])
    assert image.transform.source_format == "MPO" and image.transform.frames == 2


@pytest.mark.asyncio
async def test_protected_paths_are_refused_before_they_are_sized(monkeypatch, tmp_path):
    from services.file_access import ProtectedPathError

    secret = tmp_path / "secret.png"
    secret.write_bytes(b"x" * 10)
    sized = []
    real_stat = type(secret).stat

    def watch_stat(self, *args, **kwargs):
        if self.name == "secret.png":
            sized.append(self)
        return real_stat(self, *args, **kwargs)

    def refuse(value):
        raise ProtectedPathError("Protected file access is not allowed")

    monkeypatch.setattr(type(secret), "stat", watch_stat)
    monkeypatch.setattr("services.file_access.require_allowed_path", refuse)
    with pytest.raises(ValueError, match="Protected"):
        await ts.load_image_source(str(secret))
    assert sized == []


@pytest.mark.asyncio
async def test_the_images_of_one_request_have_a_total_size_cap(monkeypatch):
    monkeypatch.setattr(ts, "MAX_TOTAL_SOURCE_BYTES", 1000)
    picture = _data_uri(Image.effect_noise((300, 300), 90).convert("RGB"))
    with pytest.raises(ValueError, match="before resizing"):
        await ts.prepare_images([picture, picture])


@pytest.mark.asyncio
async def test_a_slow_remote_image_has_an_overall_deadline(monkeypatch):
    import asyncio

    async def drip(url, *, label, max_bytes, timeout=300.0):
        await asyncio.sleep(60)
        return b"", ""

    monkeypatch.setattr("services.public_url.fetch_public_media", drip)
    monkeypatch.setattr(ts, "URL_FETCH_DEADLINE", 0.01)
    with pytest.raises(ValueError, match="took longer than"):
        await ts.load_image_source("https://cdn.example.com/slow.png")


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["ts-test\nkey-123", f"{KEY} extra", "ts-test-k’y"])
async def test_a_malformed_key_is_reported_as_a_key_problem_without_the_key(monkeypatch, key):
    calls, _ = _install(monkeypatch, lambda request, n: httpx.Response(200, json=NOUL))
    with pytest.raises(ts.TypeSafeError, match="character a key can't have") as raised:
        await ts.system_one(key, model="jev-1.14.0", state="x",
                            questions={"q": {"type": "noul", "instructions": "y?"}})
    assert calls == []
    assert KEY not in str(raised.value) and KEY not in repr(raised.value)


@pytest.mark.asyncio
async def test_surrounding_whitespace_on_a_key_is_trimmed(monkeypatch):
    calls, _ = _install(monkeypatch, lambda request, n: httpx.Response(200, json=NOUL))
    await ts.system_one(f"  {KEY}\n", model="jev-1.14.0", state="x",
                        questions={"q": {"type": "noul", "instructions": "y?"}})
    assert calls[0].headers["authorization"] == f"Bearer {KEY}"


def test_an_error_code_is_key_free_and_capped():
    body = {"detail": {"error_type": f"bad_{KEY}_" + "y" * 200, "message": "nope"}}
    _text, code = ts._error_detail(httpx.Response(400, json=body), KEY)
    assert KEY not in code and code.startswith("bad_***_") and len(code) == 80
