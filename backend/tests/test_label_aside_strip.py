"""A label's aside never reaches a person line: the note in parentheses and, since
option labels read "A · b", what follows the middle dot are both left out."""
from execution.person_line import option_label, port_name
from services.node_route import _plain


def test_a_label_with_a_middle_dot_aside_is_quoted_as_its_name():
    assert port_name("A · b") == "A"
    assert _plain("A · b") == "A"


def test_a_note_in_parentheses_is_still_left_out():
    assert port_name("Mask (white = edit)") == "Mask"
    assert _plain("Safety 5 (Permissive)") == "Safety 5"


def test_either_aside_goes_and_a_name_without_one_stays_whole():
    assert port_name("A (x) · b") == "A"
    assert _plain("A · b (c)") == "A"
    assert port_name("Reference images") == "Reference images"
    assert _plain("Hailuo 02") == "Hailuo 02"


def test_an_option_shown_with_a_middle_dot_note_is_named_without_it():
    # claude-chat's model list shows "Claude Fable 5.1 · flagship".
    assert option_label("claude-chat", "model", "claude-fable-5-1") == "Claude Fable 5.1"


def test_a_port_whose_note_moved_to_an_aside_is_named_as_before():
    # The note was in parentheses ("Mask (white = edit)", "Image (alpha)",
    # "Mask (unavailable)"); it now follows a middle dot. The short name a line
    # quotes is the same either way.
    for was, now, short in (
        ("Mask (white = edit)", "Mask · white means edit", "Mask"),
        ("Image (alpha)", "Image · alpha", "Image"),
        ("Mask (unavailable)", "Mask · unavailable", "Mask"),
    ):
        assert port_name(was) == port_name(now) == short


def test_a_setting_label_with_an_aside_is_named_without_it():
    from services.node_route import _param_label
    assert _param_label({"label": "Draft · fast preview"}, "draft") == "Draft"
    assert _param_label({"label": "Steps · flex only"}, "num_inference_steps") == "Steps"
    assert _param_label({"label": "Duration (s)"}, "duration") == "Duration (s)"
