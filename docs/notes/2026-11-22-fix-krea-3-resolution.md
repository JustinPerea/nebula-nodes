# Fix Krea 3 required resolution on agent-made nodes and add 4K

## Decisions

- **Fill required defaults in `handle_krea_catalog`, not at node creation.** Agent-made nodes (`backend/services/cli_graph.py` `add_node`, used by `nebula apply`, the CLI, and MCP) still save no param defaults at creation. Putting `_required_defaults` in `backend/handlers/krea_gateway.py` follows `backend/services/param_defaults.py`: only a handler whose provider API requires a missing value supplies its default, while unset optional params are still left out of the request. Filling defaults globally in `multi_route` or `add_node` would change request payloads sent to fal and other routes where tests pin that only saved values are forwarded.
- **Handle both `required` and `anyOf`/`oneOf` of required sets.** Krea 3's OpenAPI schema uses `anyOf: [{"required": ["resolution"]}, {"required": ["width", "height"]}]`. `_required_defaults` fills missing `required` fields from the Krea route's translated defaults (`node_route.route_param_definitions` + `maker_routes.translate_params`), and when an `anyOf`/`oneOf` of required sets is unmet, fills the first branch for which the route defines defaults. When the body already satisfies a branch (for example `width` and `height`), it returns `{}`.
- **Readable validation and 422 errors.** `_validate` formats missing `anyOf`/`oneOf` required-set failures as `Invalid Krea <field>: needs <sets>` with a `with_person_line` message instead of dumping the raw request body. `_raise_for_krea_response` in `backend/handlers/krea.py` appends up to three 422 `details` entries (`field: message`) while keeping `with_api_status(..., response.status_code)`.
- **Add 4K and remove beta-only copy.** Krea's 2026-11-22 guide opens the Krea 3 API to every workspace and adds `4K` resolution billed as 2K plus $0.04 ($0.10 without references, $0.10-$0.66 with up to 8 references). Updated `krea-3` in both `backend/data/node_definitions.json` and `frontend/src/constants/nodeDefinitions.ts` by hand (without `scripts/export-node-defs.ts`), updated `backend/data/model_pricing.json`, removed Krea 3 beta/early-access copy across docs/skills/fixtures, and regenerated `route_tables.json` and `docs/MODEL_REFERENCE.md`.
- **Recurrence guard.** Added a parametrized test in `backend/tests/test_krea_gateway.py` over every node definition with a `provider == "krea"` route verifying that an agent-made node saved with only `_provider` leaves no schema-required field or satisfiable `anyOf`/`oneOf` required set unmet and validates against its Krea schema.

## Tradeoffs

- `width`/`height`, `regions` (bounding boxes), and `thinking_mode: ultra` (documented in the Krea guide, absent from the OpenAPI enum) are not exposed on the `krea-3` node yet; they are recorded in `docs/model-providers/krea/krea-3.md`.
- Moving `_validate` to build `exc = ValueError(...)` before branching lowered the static unlined-raise count for `handlers/krea_gateway.py` in `backend/tests/test_error_copy_round3c2.py` from 27 to 26.

## Surprises

- Today's `backend/handlers/krea.py` wraps its HTTP status `RuntimeError` in `with_api_status(..., response.status_code)` (added after commit `bce7b3db`), and the `krea-3` description uses a curly apostrophe (`Krea’s`). Both were preserved when porting the fix.

## Catalog refresh

- The Krea 3 catalog entry was refreshed alone (`scripts/sync-krea-catalog.py --openapi <file> --only /generate/image/krea/krea-3`). `--only` used to re-read the Krea 2 guide as well, and the live guide's `> [!NOTE]` blocks in Pricing stop `parse_k2_guide`, so a one-entry refresh failed. `--only` now keeps the Krea 2 guide pinned unless `--refresh-guide` or `--guide FILE` is given. Updating `parse_k2_guide` for the NOTE blocks is left for the next Krea 2 refresh.

## Review fixes

- Required ports that are connected but empty (a Text node with nothing typed) now stop the run in `handle_krea_catalog` (`_refuse_empty_required`). The refreshed Krea 3 schema leaves `prompt` optional, because a region note can stand in for it, but the node has no regions, so an empty prompt would otherwise reach Krea.
- `tests/test_error_copy_round3c2.py` `_raises` follows a name bound to an exception in the same function (`exc = RuntimeError(...)`, then `raise exc`). The first version of `_validate` here dropped the unlined count from 27 to 26 that way, without adding a line. The guard now also counts `minimax.py`'s missing task id and `stream_runner.py`'s final-event failure (provider answers, baselines 6 to 7 and 5 to 7), and `typesafe_client.py`'s oversized-file raise got the person line its twin already had.
- Plan runs of Krea 3 go through the Krea MCP, whose guide said closed beta on 2026-10-15 and was not re-checked, so the docs scope "every workspace" to API-token runs.
