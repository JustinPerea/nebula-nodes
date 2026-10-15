"""The provider clients route-table nodes run on (definition ``routes``).

A route names its client in ``handler`` (services/node_route.py RouteSpec).
:data:`ROUTE_CLIENTS` maps that name to a :class:`RouteClient`, and
:func:`register_route_nodes` gives every route-table node in the registry an
``execution/maker_routes.py`` ``multi_route`` handler over those clients.

What a client gets, per run: a ``model_copy`` of the node holding only the
route's params (``sharedParams`` plus that route's own), already renamed and
value-mapped into the provider's names (maker_routes.translate_params), the
run's inputs and keys, and its ``route`` spec, so it can pick its endpoint
(node_route.route_endpoint) and do what is structural (images into
``image_urls``, a mode from the wired ports). A Krea route's copy carries
``_kreaAuth`` set to how this run bills, plan or API token.

The clients themselves (BFL, Replicate by model, OpenRouter media, fal, the
Krea catalog) come with the first route-table nodes. Until a handler has one,
its routes fail before any provider request, with a message that says so.
"""
from __future__ import annotations

from functools import partial
from typing import Any, Awaitable, Callable, Mapping, NamedTuple

from models.graph import GraphNode, PortValueDict

RouteRun = Callable[..., Awaitable[dict[str, Any]]]


class RouteClient(NamedTuple):
    """``run(node, inputs, api_keys, *, route, emit)`` makes the call."""
    run: RouteRun


# handler name (node_route.ROUTE_HANDLERS) -> client. Filled as the clients land.
ROUTE_CLIENTS: dict[str, RouteClient] = {}


def clients_for(definition: Mapping[str, Any], emit: Any = None) -> dict[str, Callable[
        [GraphNode, dict[str, PortValueDict], dict[str, str]], Awaitable[dict[str, Any]]]]:
    """Route id -> a registry-shaped handler for each route whose client exists."""
    from services import node_route

    clients = {}
    for route in node_route.routes_of(definition):
        client = ROUTE_CLIENTS.get(str(route.get("handler") or ""))
        if client is not None:
            clients[str(route["id"])] = partial(client.run, route=route, emit=emit)
    return clients


def register_route_nodes(registry: dict[str, Any], definitions: Mapping[str, Mapping[str, Any]], emit: Any = None) -> None:
    """A ``multi_route`` handler for every route-table node in ``definitions``
    (execution/sync_runner.py get_handler_registry calls it). It replaces any
    handler registered for that id, so one rule picks the provider."""
    from execution import maker_routes
    from services import node_route

    for node_id, definition in definitions.items():
        if node_route.has_routes(definition):
            registry[node_id] = maker_routes.multi_route(clients_for(definition, emit))
