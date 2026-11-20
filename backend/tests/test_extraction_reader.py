"""The extract-1 reader: its command is reader-1's, its output is validated and converted to pixels, code
measures inside the model's boxes. Every read here goes through a fake process; none reaches the real CLI."""
from __future__ import annotations

import copy

import pytest

from commons import analysis_errors
from commons import reader as commons_reader
from commons.vocab import load_vocabulary
from extraction import intake, record as rec, store
from extraction import reader
from extraction.errors import ExtractionRefused
from tests.extraction_fakes import (LANDING, answering, block_real_spawn, failing, init_event, landing_structured,
                                    result_event, Spawner)

pytestmark = pytest.mark.usefixtures("block_real_spawn")

VOCAB = load_vocabulary()
SIZE = (1440, 900)


@pytest.fixture(scope="module")
def landing():
    item = intake.intake(LANDING.read_bytes(), name="landing.png", kind="file")
    return rec.build_record(item), item.image


def validate(structured, palette_len=7, size=SIZE):
    return reader.validate_read(structured, palette_len, VOCAB, size)


def changed(**edits):
    data = landing_structured()
    data.update(edits)
    return data


# -- commons.reader: the optional prompt, schema and message --------------------------------------


def test_extract_1_command_is_reader_1_command_except_the_prompt_and_schema():
    one = commons_reader.build_command(commons_reader.SYSTEM_PROMPT, commons_reader.analysis_schema(VOCAB, 7))
    two = commons_reader.build_command(reader.SYSTEM_PROMPT, reader.analysis_schema(VOCAB, 7))
    assert len(one) == len(two)
    differing = [i for i, (a, b) in enumerate(zip(one, two)) if a != b]
    allowed = {one.index("--system-prompt") + 1, one.index("--json-schema") + 1}
    assert set(differing) == allowed
    for flag in ("--restricted", "--strict-mcp-config", "--no-session-persistence"):
        assert flag in two
    assert two[two.index("--tools") + 1] == ""
    assert two[two.index("--mcp-config") + 1] == '{"mcpServers":{}}'
    assert two[two.index("--model") + 1] == commons_reader.MODEL_ID


@pytest.mark.asyncio
async def test_the_command_a_read_really_spawns_matches_reader_1s(landing):
    record, image = landing
    one = answering({"a": 1})
    await commons_reader.read_image(b"png", [], [], vocab=VOCAB, spawn=one)
    two = answering()
    await reader.ask(record, image, spawn=two)
    cmd_one, cmd_two = one.calls[0][0], two.calls[0][0]
    assert len(cmd_one) == len(cmd_two)
    assert {i for i, (a, b) in enumerate(zip(cmd_one, cmd_two)) if a != b} == {
        cmd_one.index("--system-prompt") + 1, cmd_one.index("--json-schema") + 1}
    assert one.calls[0][1]["env"] == two.calls[0][1]["env"] and two.calls[0][1]["cwd"]


@pytest.mark.asyncio
async def test_reader_1_is_unchanged_with_no_prompt_schema_or_message():
    spawner = answering({"a": 1})
    await commons_reader.read_image(b"png", [], [], vocab=VOCAB, spawn=spawner)
    cmd = spawner.calls[0][0]
    assert cmd[cmd.index("--system-prompt") + 1] == commons_reader.SYSTEM_PROMPT
    assert "reader-1" == commons_reader.PROMPT_VERSION


@pytest.mark.asyncio
async def test_an_extract_1_read_fails_when_the_cli_lists_another_tool(landing):
    record, image = landing
    with pytest.raises(reader.ReadFailed) as caught:
        await reader.ask(record, image, spawn=answering(tools=("Read", "StructuredOutput")))
    assert caught.value.kind == analysis_errors.OTHER


@pytest.mark.asyncio
async def test_a_provider_error_is_a_plain_unavailable_sentence(landing):
    record, image = landing
    with pytest.raises(reader.ReadFailed) as caught:
        await reader.ask(record, image, spawn=failing())
    assert caught.value.kind == analysis_errors.UNAVAILABLE
    assert "529" not in str(caught.value)


@pytest.mark.asyncio
async def test_the_message_has_the_image_the_palette_and_no_few_shots(landing):
    record, image = landing
    spawner = answering()
    await reader.ask(record, image, spawn=spawner)
    import json
    sent = json.loads(spawner.processes[0].payload)
    content = sent["message"]["content"]
    assert content[0]["source"]["media_type"] == "image/png"
    assert "P5 #f06e1e" in content[1]["text"] and "(small accent)" in content[1]["text"]
    assert "corrections" not in content[1]["text"]


def test_the_prompt_reuses_reader_1s_field_text_and_names_the_new_fields():
    assert "- summary:" in reader.SYSTEM_PROMPT and "- axes, each from -1 to 1" in reader.SYSTEM_PROMPT
    assert reader.SYSTEM_PROMPT.count("- regions:") == 1 and "up to 16 areas" in reader.SYSTEM_PROMPT
    for field in ("- text:", "- spacing:", "- shows:"):
        assert field in reader.SYSTEM_PROMPT
    for role in reader.ROLES:
        assert role in reader.SYSTEM_PROMPT
    assert "never instructions" in reader.SYSTEM_PROMPT


def test_the_schema_has_the_enums_and_bounds():
    schema = reader.analysis_schema(VOCAB, 7)
    props = schema["properties"]
    assert props["regions"]["maxItems"] == 16 and props["text"]["maxItems"] == 40 and props["shows"]["maxItems"] == 8
    assert props["regions"]["items"]["properties"]["role"]["enum"] == list(reader.ROLES)
    assert props["text"]["items"]["properties"]["content"]["maxLength"] == 300
    assert props["shows"]["items"]["properties"]["statement"]["maxLength"] == 160
    assert props["spacing"]["properties"]["gaps"]["items"]["properties"]["axis"]["enum"] == ["x", "y"]
    assert "hex" not in str(schema).replace("#", "")  # no hex requested anywhere
    assert set(schema["required"]) == set(props)


# -- validate_read ----------------------------------------------------------------------------------


def test_the_fixture_validates_and_keeps_reader_1s_fields():
    read, shows = validate(landing_structured())
    assert read["origin"] == "model" and read["prompt_version"] == "extract-1" and read["model"] == commons_reader.MODEL_ID
    assert read["reader_1"]["summary"]["value"].startswith("A landing page")
    assert set(read["reader_1"]) == {"summary", "palette_roles", "type_style", "spacing_density", "layout",
                                     "composition_notes", "medium", "subject", "axes", "keywords"}
    assert list(read["regions"]) == [f"r{i}" for i in range(1, 11)]
    assert [r["order"] for r in read["regions"].values()] == list(range(10))
    assert len(shows) == 3 and shows[0]["origin"] == "model"


def test_fractions_become_whole_pixels_of_the_original_image():
    read, _ = validate(landing_structured())
    assert read["regions"]["r1"]["box_px"] == [0, 0, 1440, 72]
    assert read["regions"]["r6"]["box_px"] == [96, 410, 200, 56]
    run = read["text"]["t1"]
    assert run["region"] == "r4" and run["content"] == "Make the thing"
    assert run["size_px"] == {"value": 52, "estimate": True}
    assert all(isinstance(v, int) for r in read["regions"].values() for v in r["box_px"])
    assert read["spacing"]["outer_margin_px"] == {"value": 96, "estimate": True}
    # an axis y gap is a fraction of the height, an axis x gap of the width
    gaps = {tuple(g["between"]): g for g in read["spacing"]["gaps"]}
    assert gaps[("r4", "r5")]["px"] == 42 and gaps[("r4", "r5")]["axis"] == "y" and gaps[("r4", "r5")]["estimate"] is True
    assert gaps[("r8", "r9")]["px"] == 40 and gaps[("r8", "r9")]["axis"] == "x"


def test_pixels_come_from_the_original_size_not_the_sent_size():
    data = changed(regions=[{"id": "r1", "box": [0.5, 0.5, 0.25, 0.1], "role": "header", "label": "x"}], text=[],
                   spacing={"outer_margin": 0.1, "gaps": []}, shows=[])
    read, _ = validate(data, size=(3000, 2000))
    assert read["regions"]["r1"]["box_px"] == [1500, 1000, 750, 200]
    assert read["spacing"]["outer_margin_px"]["value"] == 300
    tiny, _ = validate(data, size=(1, 1))
    assert tiny["regions"]["r1"]["box_px"] == [0, 0, 1, 1]  # kept inside, at least 1 px


def test_references_to_regions_that_do_not_exist_are_dropped():
    data = landing_structured()
    data["text"][0]["region"] = "r99"
    data["spacing"]["gaps"].append({"between": ["r1", "r77"], "size": 0.1, "axis": "x"})
    read, _ = validate(data)
    assert read["text"]["t1"]["region"] is None
    assert all("r77" not in g["between"] for g in read["spacing"]["gaps"]) and len(read["spacing"]["gaps"]) == 3


def _edit(path_edit):
    data = copy.deepcopy(landing_structured())
    path_edit(data)
    return data


MALFORMED = {
    "not an object": lambda d: ["a list"],
    "missing regions": lambda d: d.pop("regions"),
    "missing shows": lambda d: d.pop("shows"),
    "regions not a list": lambda d: d.update(regions="r1"),
    "too many regions": lambda d: d.update(regions=[{"id": f"r{i}", "box": [0, 0, 0.1, 0.1], "role": "other", "label": ""}
                                                     for i in range(17)]),
    "bad role": lambda d: d["regions"][0].update(role="sidebar"),
    "box out of range": lambda d: d["regions"][0].update(box=[0.5, 0.5, 0.9, 0.2]),
    "negative box": lambda d: d["regions"][0].update(box=[-0.1, 0, 0.2, 0.2]),
    "zero size box": lambda d: d["regions"][0].update(box=[0.1, 0.1, 0, 0.2]),
    "box of three": lambda d: d["regions"][0].update(box=[0, 0, 1]),
    "box with text": lambda d: d["regions"][0].update(box=["a", 0, 1, 1]),
    "box with nan": lambda d: d["regions"][0].update(box=[float("nan"), 0, 1, 1]),
    "duplicate region id": lambda d: d["regions"][1].update(id="r1"),
    "region id not text": lambda d: d["regions"][0].update(id=7),
    "region id with a path": lambda d: d["regions"][0].update(id="r1.role"),
    "text weight": lambda d: d["text"][0].update(weight="heavy"),
    "text type style": lambda d: d["text"][0].update(type_style="comic"),
    "text size over one": lambda d: d["text"][0].update(size=1.5),
    "text content empty": lambda d: d["text"][0].update(content="  "),
    "text content too long": lambda d: d["text"][0].update(content="x" * 301),
    "text box out of range": lambda d: d["text"][0].update(box=[0.9, 0.9, 0.5, 0.5]),
    "too many text runs": lambda d: d.update(text=d["text"] * 9),
    "spacing not an object": lambda d: d.update(spacing=[]),
    "margin over one": lambda d: d["spacing"].update(outer_margin=2),
    "gap axis": lambda d: d["spacing"]["gaps"][0].update(axis="z"),
    "gap between one": lambda d: d["spacing"]["gaps"][0].update(between=["r1"]),
    "gap size negative": lambda d: d["spacing"]["gaps"][0].update(size=-0.1),
    "show statement empty": lambda d: d["shows"][0].update(statement=""),
    "show statement too long": lambda d: d["shows"][0].update(statement="x" * 161),
    "show evidence not a list": lambda d: d["shows"][0].update(evidence="P1"),
    "too many shows": lambda d: d.update(shows=d["shows"] * 3),
    "reader 1 part: type style": lambda d: d["type_style"].update(value="comic"),
    "reader 1 part: palette index": lambda d: d["palette_roles"].append({"index": 40, "role": "text"}),
    "reader 1 part: axis range": lambda d: d["axes"]["quiet_loud"].update(value=3),
    "reader 1 part: keyword": lambda d: d["keywords"].append("not_a_word"),
}


@pytest.mark.parametrize("name", sorted(MALFORMED))
def test_malformed_output_raises_a_readable_analysis_invalid(name):
    data = copy.deepcopy(landing_structured())
    replaced = MALFORMED[name](data)
    if name == "not an object":
        data = replaced
    with pytest.raises(commons_reader.AnalysisInvalid) as caught:
        validate(data)
    assert str(caught.value)


def test_wrong_shapes_inside_the_output_are_analysis_invalid_not_crashes():
    for data in (changed(regions=[None]), changed(text=["x"]), changed(shows=[3]), changed(spacing={"gaps": []}),
                 changed(spacing={"outer_margin": 0.1, "gaps": [5]})):
        with pytest.raises(commons_reader.AnalysisInvalid):
            validate(data)


# -- code measures inside the model's boxes ------------------------------------------------------------


def test_region_measures_come_from_cropping_the_original(landing):
    record, image = landing
    updated = reader.apply_read(record, image, landing_structured())
    measures = updated["structure"]["measured"]["region_measures"]
    assert set(measures) == {f"r{i}" for i in range(1, 11)}
    button = measures["r6"]
    assert button["origin"] == "code" and button["from_model_box"] is True and button["box_px"] == [96, 410, 200, 56]
    assert button["palette"][0]["hex"] == "#f06e1e" and 1 <= len(button["palette"]) <= 4
    assert measures["r1"]["palette"][0]["hex"] == "#1c1c22"
    assert set(button["value_range"]) == {"low", "high"}


def test_code_gaps_between_aligned_regions_that_do_not_overlap(landing):
    record, image = landing
    gaps = {tuple(g["between"]): g for g in
            reader.apply_read(record, image, landing_structured())["structure"]["measured"]["region_gaps"]}
    assert gaps[("r8", "r9")] == {"between": ["r8", "r9"], "axis": "x", "px": 40, "origin": "code", "from_model_box": True}
    assert gaps[("r9", "r10")]["px"] == 40
    assert gaps[("r4", "r8")]["axis"] == "y" and gaps[("r4", "r8")]["px"] == 620 - 274
    assert ("r1", "r2") not in gaps  # the logo is inside the bar: they overlap
    assert ("r2", "r7") not in gaps or gaps[("r2", "r7")]["axis"] == "x"
    for gap in gaps.values():
        assert gap["origin"] == "code" and gap["from_model_box"] is True and gap["px"] >= 0


def test_gaps_ignore_boxes_that_line_up_on_neither_axis():
    regions = {"a": {"box_px": [0, 0, 10, 10]}, "b": {"box_px": [20, 20, 10, 10]}, "c": {"box_px": [5, 5, 10, 10]}}
    assert reader.region_gaps(regions) == []


# -- apply_read and read_record -------------------------------------------------------------------------


def test_apply_read_fills_the_record_and_keeps_it_valid(landing):
    record, image = landing
    updated = reader.apply_read(record, image, landing_structured())
    rec.validate(updated)
    assert record["structure"]["read"] is None and record["shows"] == {}  # the input is untouched
    assert updated["structure"]["read"]["prompt_version"] == "extract-1"
    assert updated["status"] == "proposal"
    assert [(k, v["origin"], v["status"], v["decision_ref"]) for k, v in updated["shows"].items()] == [
        ("s1", "model", "proposal", None), ("s2", "model", "proposal", None), ("s3", "model", "proposal", None)]
    assert updated["shows"]["s1"]["evidence"] == ["P5", "r6"]
    assert updated["read_requests"] == []


def test_a_show_with_no_evidence_that_exists_is_dropped(landing):
    record, image = landing
    data = changed(shows=[{"statement": "Cites nothing real.", "evidence": ["P99", "r99"]},
                          {"statement": "Cites one real id.", "evidence": ["P99", "r2"]}])
    updated = reader.apply_read(record, image, data)
    assert [s["statement"] for s in updated["shows"].values()] == ["Cites one real id."]
    assert updated["shows"]["s1"]["evidence"] == ["r2"]


def test_a_second_read_replaces_the_reading_and_model_shows_but_keeps_corrections_and_person_shows(landing):
    record, image = landing
    first = reader.apply_read(record, image, landing_structured())
    corrected = rec.add_corrections(first, [
        {"path": "structure.read.regions.r1.role", "op": "set", "value": "navigation"},
        {"path": "shows.mine", "op": "set", "value": {"statement": "My own note.", "evidence": ["r1"]}},
        {"path": "shows.s1.statement", "op": "set", "value": "Edited by a person."}], "person")
    second_data = changed(shows=[{"statement": "A fresh statement.", "evidence": ["P1"]}])
    second = reader.apply_read(corrected, image, second_data)
    assert second["corrections"] == corrected["corrections"]
    assert "mine" not in second["shows"] and [s["statement"] for s in second["shows"].values()] == ["A fresh statement."]
    assert "s1" not in second["shows"]  # s1 is named by a correction, so the new statement doesn't take its id
    view = rec.effective(second)
    assert view["shows"]["mine"]["statement"] == "My own note." and view["shows"]["mine"]["origin"] == "person"
    assert view["structure"]["read"]["regions"]["r1"]["role"] == "navigation"
    assert second["structure"]["measured"]["region_measures"].keys() == second["structure"]["read"]["regions"].keys()


def test_person_and_agent_shows_stay_in_the_base_record_on_a_second_read(landing):
    record, image = landing
    base = copy.deepcopy(record)
    base["shows"] = {"a1": {"statement": "From an agent.", "evidence": ["P0"], "origin": "agent", "status": "proposal",
                            "decision_ref": None, "order": 0}}
    updated = reader.apply_read(base, image, landing_structured())
    assert updated["shows"]["a1"]["origin"] == "agent" and len(updated["shows"]) == 4
    assert [s["order"] for s in updated["shows"].values()] == [0, 1, 2, 3]


@pytest.mark.asyncio
async def test_read_record_returns_the_updated_copy(landing):
    record, image = landing
    updated = await reader.read_record(record, image, spawn=answering())
    assert updated["structure"]["read"]["model"] == commons_reader.MODEL_ID and record["structure"]["read"] is None


@pytest.mark.asyncio
async def test_an_answer_that_does_not_validate_raises_read_failed_with_a_sentence(landing):
    record, image = landing
    bad = answering(changed(regions=[{"id": "r1", "box": [0.9, 0.9, 0.5, 0.5], "role": "header", "label": ""}]))
    with pytest.raises(reader.ReadFailed) as caught:
        await reader.read_record(record, image, spawn=bad)
    assert "Nothing was changed" in str(caught.value)


@pytest.mark.asyncio
async def test_a_fully_transparent_image_is_not_sent(landing):
    from PIL import Image

    record, _ = landing
    clear = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    spawner = answering()
    with pytest.raises(reader.ReadFailed):
        await reader.ask(record, clear, spawn=spawner)
    assert spawner.calls == []


def test_load_fake_reads_a_json_object_only(tmp_path):
    good = tmp_path / "f.json"
    good.write_text('{"a": 1}')
    assert reader.load_fake(str(good)) == {"a": 1}
    for text in ("[1]", "nope"):
        bad = tmp_path / "b.json"
        bad.write_text(text)
        with pytest.raises(ExtractionRefused):
            reader.load_fake(str(bad))
    with pytest.raises(ExtractionRefused):
        reader.load_fake(str(tmp_path / "missing.json"))


# -- read requests --------------------------------------------------------------------------------------


def test_a_new_record_has_read_requests_and_an_old_one_without_loads(landing, tmp_path):
    record, image = landing
    assert record["read_requests"] == []
    old = {k: v for k, v in record.items() if k != "read_requests"}
    rec.validate(old)
    folder = tmp_path / "records"
    folder.mkdir()
    item = intake.intake(LANDING.read_bytes(), name="landing.png", kind="file")
    saved = store.save(old, rec.rendering_png(item.image), item.data, item.ext, str(folder))
    loaded = store.load(saved["dir"])
    assert "read_requests" not in loaded
    asked = store.request_read(saved["dir"], "I need the regions to compare layouts.")
    assert asked["read_requests"][0]["actor"] == "agent" and asked["read_requests"][0]["reason"].startswith("I need")


def test_read_requests_append_cap_and_refuse_bad_reasons(landing):
    record, _ = landing
    current = record
    for n in range(20):
        current = rec.add_read_request(current, f"reason {n}")
    assert len(current["read_requests"]) == 20
    with pytest.raises(rec.RecordInvalid, match="already waiting"):
        rec.add_read_request(current, "one more")
    for bad in ("", "   ", None, 5, "x" * 301):
        with pytest.raises(rec.RecordInvalid):
            rec.add_read_request(record, bad)
    assert len(rec.add_read_request(record, "x" * 300)["read_requests"]) == 1
    assert record["read_requests"] == []


def test_a_read_request_cannot_be_written_as_a_correction(landing):
    record, _ = landing
    with pytest.raises(rec.RecordInvalid):
        rec.add_corrections(record, [{"path": "read_requests", "op": "set", "value": []}], "agent")


def test_a_read_answers_and_clears_the_requests(landing):
    record, image = landing
    asked = rec.add_read_request(record, "please")
    assert reader.apply_read(asked, image, landing_structured())["read_requests"] == []


def test_a_malformed_read_request_entry_fails_validation(landing):
    record, _ = landing
    bad = copy.deepcopy(record)
    bad["read_requests"] = [{"actor": "person", "at": "now", "reason": "x"}]
    with pytest.raises(rec.RecordInvalid):
        rec.validate(bad)
