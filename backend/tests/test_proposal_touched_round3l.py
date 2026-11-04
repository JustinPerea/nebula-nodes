"""PR #216 round 3l, review 4 logic NIT-1 (B2, B4): the nodes a proposal's card
names, and the name each had when it was made.

``Proposal.touched`` is the existing nodes the card names: those it references
and BOTH ends of each connection Accept removes (review 3 LOW-2). Its
``shown_names`` gives each one's name as made: the node's own title wins over
the name a removed connection carried for it. Both read only ``existing`` and
``removed_edges``, so they run here on a stand-in."""
from __future__ import annotations

from types import SimpleNamespace

from services.canvas_proposals import Proposal


def _proposal(existing, removed_edges):
    return SimpleNamespace(existing=existing, removed_edges=removed_edges)


def test_touched_holds_both_ends_of_every_removed_connection():
    proposal = _proposal(
        {"eye": {"title": "Second take"}},
        [
            {"source": "photo1", "target": "eye", "sourceName": "Photo 1", "targetName": "Second take"},
            # A wire from the swapped node to a node the card names nowhere else.
            {"source": "eye", "target": "upscale", "sourceName": "Second take", "targetName": "Upscale"},
        ],
    )
    assert Proposal.touched.fget(proposal) == {"eye", "photo1", "upscale"}


def test_shown_names_take_the_nodes_own_title_over_a_removed_connections_name():
    proposal = _proposal(
        {"eye": {"title": "Final look"}},
        [{"source": "photo1", "target": "eye", "sourceName": "Photo 1", "targetName": "Second take"}],
    )
    assert Proposal.shown_names(proposal) == {"photo1": "Photo 1", "eye": "Final look"}
