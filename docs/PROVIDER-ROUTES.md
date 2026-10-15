# Provider routes

One node per model. A model that more than one provider sells (FLUX 3 on BFL, fal, Replicate, OpenRouter and Krea) is **one node** with a `routes` table. The person picks the provider, or leaves it on Auto. Nothing else decides who bills.

```mermaid
flowchart TD
    run([Run the node]) --> plan{Krea route on<br/>the Krea plan?}
    plan -- yes --> PLAN[Run on the plan]
    plan -- no --> choice{_provider}
    choice -- "a route id" --> explicit[That route]
    choice -- auto --> first[First route, in table order,<br/>whose key is set<br/>and isn't plan-only]
    explicit --> ok{Key set, and the<br/>route takes these<br/>settings and inputs?}
    first --> ok
    ok -- yes --> go[Run on it]
    ok -- no --> stop[Stop before any spend.<br/>Say why, and which<br/>routes could run it]
```

- **Auto never moves.** If the route Auto lands on can't take a setting (a 4K resolution, a seventh reference image), the run stops and says which other routes could. It doesn't quietly try the next one. Who bills depends only on the choice and the keys.
- **Switching is the person's call.** An agent that wants another provider proposes it (`propose_change`). A direct edit of `_provider` is refused, the same as `_kreaAuth`.
- **Old nodes are untouched.** The ~72 dual-route nodes (a fal or Krea copy that also runs on the maker's API) keep their own `directRoute` rule, byte for byte. Only new nodes use `routes`.

## The switcher

```mermaid
flowchart LR
    chip["Card chip<br/>Auto · BFL"] --> menu
    inspector["Inspector<br/>Provider section"] --> menu
    pill["Create pill"] --> menu
    menu["One menu:<br/>Auto · runs on X<br/>one row per route<br/>(Krea: API balance + plan)"] -- a person's pick --> snap["Write _provider (+ _kreaAuth),<br/>snap values the route lacks,<br/>note on the card"]
    keys["Keys change, a shared graph,<br/>an import"] --> keep["Values kept.<br/>Chip turns accent,<br/>menu offers the routes<br/>that take the recipe"]
```

- **Where.** A route-table node (`routeSwitch`, lib/directRoute.ts) shows `components/nodes/ProviderSwitcher.tsx` three ways: the first section of the Inspector, a chip next to the id chip on the card (it replaces the missing-key badge, and turns accent with a warning glyph when the run can't start), and a pill in Create Studio. Older dual-route nodes never show it.
- **Rows.** `Auto · runs on Black Forest Labs`, or `Auto · can't run: 1.5k isn't on fal.ai` with one-click switches to the keyed routes that take the recipe. Then one row per route: provider, `Key set` or `Add key →` (opens Settings → Providers at that key), the price at the current settings (`*` when the route's price entry says `unconfirmed`, `-` when there's no list price, the route can't take the settings, or it bills the Krea plan) and a note when the route can't take them ("Doesn't take 1.5k"). A Krea route that can bill the plan shows two rows, `Krea · API balance` and `Krea · plan` (`Sign in` when signed out); each writes `_provider` and `_kreaAuth`.
- **Per-provider options.** The Inspector and the pills list only the shown route's options (`routeParamDefinitions` / `route_param_definitions`): an enum cut to the values the route takes (its `valueMap`, `accepts` and `rejects`), a number range narrowed to its `accepts`, and other routes' own params left out. Shown route: the chosen one; under Auto, the route Auto lands on with the current keys; with no key, the maker's (`shownRouteId` / `shown_route_id`). A saved value off the list stays and reads "(not on fal.ai)". `rejectsWhen` combinations stay a run-time block.
- **A click snaps, nothing else does.** Picking a provider moves each saved value the new route doesn't take to its closest one there (an enum's nearest option by list order, a tie going up: 1.5k → 2k; a number clamped into range; else the default), and the card shows one dismissible line ("1.5k isn't on fal.ai: set to 2k"). A route change without a click (a key added or removed, a shared graph, an import) keeps every value; the run stops before billing and the switcher offers the routes that take it. The `.nebula` import summary names nodes set to a provider you have no key for.
- **Saving** accepts any route's params and values, since they stay flat in `node.params`; `route_block` decides at run time.
- **Agents and the CLI** see the same per-route lists: describe_node's route rows carry each route's params as it offers them (and `priceUnconfirmed`), and `nebula info` prints what each route takes that the PARAMS list doesn't say.

## Where it lives

| Piece | Backend | Frontend |
|---|---|---|
| The route table, Auto, blocks, messages | `backend/services/node_route.py` | `frontend/src/lib/directRoute.ts` |
| Running a route | `backend/execution/maker_routes.py` `multi_route`, clients in `backend/execution/route_clients.py` | |
| Preflight (fail before spend) | `backend/execution/engine.py` `validate_graph` | |
| Prices | `backend/services/model_pricing.py` `estimate_routes`, `route_price_key` | `frontend/src/lib/pricing.ts` `estimateRoutes`, `frontend/src/lib/runScope.ts` |
| Readiness | `backend/services/node_readiness.py` `instance_access`, `keys_needed` | `frontend/src/lib/kreaConnection.ts` `ownKeyStatus` |
| Who may change billing | `backend/main.py` `_billing_choice`, `_refuse_agent_billing_change`, `_check_provider` | `frontend/src/lib/billingParams.ts` |
| Agents and CLI | `describe_node` / `find_nodes` in `main.py`, `backend/cli/formatter.py` | |
| Per-route options | `node_route.route_param_definitions`, `shown_route_id` | `directRoute.ts` `routeParamDefinitions`, `shownRouteId` |
| The switcher | | `components/nodes/ProviderSwitcher.tsx`, `lib/providerSwitch.ts`, `store/providerNoteStore.ts`, `styles/provider-switcher.css` |

The Python and TypeScript twins behave the same. Shared fixtures keep them honest (see Tests).

## A route table

A route-table node keeps its usual fields (`apiProvider` is the maker, `envKeyName` is every route's keys in order) and adds:

- `params`: the hidden `_provider` choice (`auto` plus each route id), and `_kreaAuth` when a Krea route exists.
- `sharedParams`: the settings every route takes.
- `routes`: the table, in Auto order. Each route:

| Field | What it says |
|---|---|
| `id` | What `_provider` names. Usually the provider; two routes on one provider need different ids. |
| `provider` | Who bills: a `KEY_PROVIDERS` value (`bfl`, `fal`, `replicate`, `openrouter`, `krea`, ...). |
| `maker` | `true` on the model maker's own API. At most one. |
| `keys` | Any one of these keys runs it. |
| `plan` | Krea only: `optional` (API token or the Krea plan, by `_kreaAuth`) or `only` (plan only; Auto skips it). |
| `handler` | Which client runs it (`bfl`, `fal`, `replicate-model`, `openrouter-images`, `openrouter-videos`, `krea`). |
| `endpoint`, `endpointWhen` | The provider's model or path, and an override when settings match (`{"images": "(set)"}` for an edit endpoint once images are wired). |
| `params` | Settings only this route takes. |
| `rename`, `valueMap` | Our spelling to the provider's: a param name, or a value (`1k` to `1K`). A `valueMap` also says which values the route takes. |
| `rules` | `accepts`, `rejects`, `rejectsWhen`, `blockedBy`, `size` (the `directRoute` grammar), plus `ports: {"images": {"max": 4}}` for how many inputs a port may carry. |
| `pricing` | The key its price is under in `model_pricing.json` (default: its `id`). |
| `note` | One line for the person. |

`node_route.routes_problems` and `scripts/check-node-contracts.mjs` both check this shape.

## What a run sees

- `select_route` returns a `Route`: `kind` (`plan`, `direct` for the maker, `fallback` for any other route, `unset` when it can't run), `provider`, `key`, plus `routeId`, `block` and `missing` on route-table nodes.
- `route_unavailable` explains an `unset` run: `{routeId, missing, block, alternatives, message}`. The same `message` shows on the node, in the run error, in the preflight and in the run estimate.
- Wired inputs count. A port rule reads how many inputs arrive, under the reserved `"(wired ports)"` key that `with_wired_blockers` adds. The router and the cache key count items (`filled_counts`: a list counts its length, which is what the provider gets). The preflight, the estimate and the switcher count edges, all that is known before upstream nodes run. So one edge bringing a list of six images to a route that takes four passes the preflight and stops in the router, before that provider is called.
- The Krea plan is decided from the same routed values (`with_wired_blockers`), so a wired input that blocks or unblocks the plan route changes the preflight's sign-in check, the estimate's plan runs and the spend gate the same way it changes the router.
- The cache key names the route that ran: `direct:bfl`, `fallback:replicate`, `plan:krea`, so a result from one provider never replays as another's.
- The handler gets only the route's own settings, renamed and value-mapped (`translate_params`). A Krea route also gets `_kreaAuth` for how this run bills.

## Prices

A route-table node's price entry keys each route by its `pricing` key (default its id):

```json
"flux-3": { "routes": {
  "bfl": { "currency": "usd", "per": "image", "rows": [...] },
  "fal": { "currency": "usd", "per": "image", "provider": "fal", "rows": [...] }
} }
```

- The run is priced on the route it takes. A run that can't start is `unavailable` with the reason, never priced at another route.
- `estimate_routes` gives every route's price at the current settings, for the provider switcher.
- A route entry with `"unconfirmed": true` is a price the provider's page doesn't state exactly; the switcher shows it with `*` (`route_price_unconfirmed` / `routePriceUnconfirmed`).

## Adding a route-table node

1. Write the node in `frontend/src/constants/nodeDefinitions.ts` and the same entry in `backend/data/node_definitions.json`. `scripts/export-node-defs.ts` writes the JSON from the TS, but the two already differ in a few labels, so check its diff before keeping it.
2. Each route's `handler` needs a client in `route_clients.ROUTE_CLIENTS`. A route without one fails with "can't run on X in this version of Nebula yet".
3. Price it per route in `backend/data/model_pricing.json`, with sources.
4. Regenerate: `backend/.venv/bin/python scripts/generate-route-tables.py` and `node scripts/generate-model-reference.mjs`.
5. Run `node scripts/check-node-contracts.mjs`.

## Tests

- `backend/tests/fixtures/route_cases.json`: shared Python/TS cases. The first 147 are the legacy rule, unchanged; the `definitions` block holds three fixture route tables and the cases that run on them.
- `backend/tests/fixtures/route_tables.json`: every node's computed routes and param list, and each route-table route's offered params (`routeParams`), pinned (`scripts/generate-route-tables.py --check`). Route cases with `shownRoute` / `routeParams` pin the narrowing in both languages.
- `backend/tests/fixtures/pricing_cases.json`: the `table` node, a five-route fixture, with `runCases` and `routeEstimateCases`.
- `test_node_route.py`, `test_maker_routes.py`, `test_route_preflight.py`, `test_billing_choice.py`, `test_route_agent_surfaces.py`; `directRoute.test.ts`, `routeTables.test.ts`, `pricing.test.ts`, `runScope.test.ts`, `billingParams.test.ts`, `providerSwitch.test.ts`, `ProviderSwitcher.test.tsx`.
