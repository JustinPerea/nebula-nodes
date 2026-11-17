"""A personal agent's name inside a CLI sentence goes through in_sentence (the
copy sweep): "Your Codex" reads "your Codex" mid-sentence, a name that doesn't
start with "Your " and the fallback words are left as they are. The leaf module
carries the function so the CLI doesn't load the personal-agent stack; the
personal_agents re-export is the same function."""
from __future__ import annotations

from cli.commands.trash import _who
from cli.formatter import format_pin, format_proposal
from services import agent_name_in_sentence, personal_agents


def test_personal_agents_re_exports_the_leaf_function():
    assert personal_agents.in_sentence is agent_name_in_sentence.in_sentence


def test_a_deleted_by_line_lowers_the_name():
    assert _who({"deletedBy": {"kind": "agent", "name": "Your Claude"}}) == "your Claude (agent)"
    assert _who({"deletedBy": {"kind": "agent", "name": "Hermes"}}) == "Hermes (agent)"
    assert _who({"deletedBy": {"kind": "agent"}}) == "Agent (agent)"


def test_a_resolved_pin_lowers_the_name_and_keeps_the_fallback():
    def pin(agent):
        return {"id": "pin_1", "anchor": {"nodeId": "n4"}, "status": "resolved", "text": "warmer",
                "reply": {"agent": agent, "text": "done"}}

    assert "resolved by your Codex:" in format_pin(pin({"name": "Your Codex"}))
    assert "resolved by Hermes:" in format_pin(pin({"name": "Hermes"}))
    assert "resolved by an agent:" in format_pin(pin({}))


def test_a_proposal_line_lowers_the_name_and_keeps_the_fallback():
    def view(agent):
        return {"id": "prop_1", "status": "open", "agent": agent, "expiresAt": 0, "note": "n"}

    assert "prop_1 by your Gemini [" in format_proposal(view({"name": "Your Gemini"}), now_ms=0)
    assert "prop_1 by an agent [" in format_proposal(view({}), now_ms=0)
