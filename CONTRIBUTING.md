# Contributing to Nebula Nodes

Issues and pull requests are welcome. Keep changes focused, describe the behavior
they change, and include the checks you ran. Read [AGENTS.md](AGENTS.md) for
repository conventions and [the quickstart](README.md#quickstart) for setup.

## Development checks

Run commands from the repository root, using the installed dependencies:

```bash
backend/.venv/bin/python -m pytest -o pythonpath=backend backend/tests
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
node scripts/check-node-contracts.mjs
```

For desktop changes, also install its dependencies, build the desktop renderer,
and run the desktop checks:

```bash
npm --prefix desktop ci
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

See [desktop/README.md](desktop/README.md) for runtime and integration-test setup.
Document any check you could not run rather than reporting it as passed.

## Adding or updating a node

1. Verify the current behavior against the provider's official API documentation.
   Check the [provider contracts](docs/contracts/README.md) and
   [audit notes](docs/model-providers/) for existing decisions.
2. Update `backend/data/node_definitions.json`, the source of truth, and its
   frontend mirror in `frontend/src/constants/nodeDefinitions.ts`.
3. Implement the handler under `backend/handlers/` and add relevant tests for
   inputs, outputs, errors, and provider behavior.
4. Regenerate the catalog with `node scripts/generate-model-reference.mjs`.
   Do not edit `docs/MODEL_REFERENCE.md` by hand.
5. Run the node contract checks above and update the relevant provider guide.
   If the node closes a logged gap, update [the Flora audit](docs/flora-gap-audit.md).

Keep credentials, local outputs, and user data out of commits. Record unexpected
decisions and tradeoffs in `implementation-notes.md` during implementation.

## Agent integration

Repo-backed agent skills live in [.agents/skills/](.agents/skills/).
Daedalus's playbook is [.hermes/skills/daedalus-core/SKILL.md](.hermes/skills/daedalus-core/SKILL.md),
and its persona contract is [.hermes/profiles/daedalus/SOUL.md](.hermes/profiles/daedalus/SOUL.md).
See [agent setup](docs/HERMES-SETUP.md) for how these are installed.
