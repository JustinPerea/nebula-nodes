"""The error a handler raises when its provider key isn't set."""
from __future__ import annotations


class MissingCredentialError(ValueError):
    """A handler's credential check failed before it contacted any provider.

    Raise it only from a check that runs before the handler's first provider
    request. The engine marks the node's ErrorEvent with it, and the agent
    spending limits give that node's share of the run's hold back: a node
    that never reached its provider can't have cost anything. Anywhere a
    request may already have gone out, raise a plain ValueError instead, so
    the hold stays counted.
    """
