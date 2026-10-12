---
title: Contract exemplar — Imagen 4 Generate (retired)
kind: contract-exemplar
contract_version: 1
handler_family: google
handler_pattern: sync
status: retired
nodes:
  - imagen-4-generate
verified: 2026-10-10
---

# Contract exemplar: Imagen 4 (`imagen-4-generate`) — retired

Google shut Imagen 4 down on 2026-08-17 and names Nano Banana 2.1 as its replacement. Nebula removed the node, its `handle_imagen4` handler and its request fixture on 2026-10-10 (checked 2026-10-10).

- Creating an `imagen-4-generate` node returns a 400 that explains the retirement.
- Saved graphs migrate in `backend/services/retired_nodes.py` to `nano-banana` with `model: gemini-nano-banana-2.1`. `aspectRatio` becomes `aspect_ratio`, a 1K/2K `imageSize` carries over, and the node is titled "Nano Banana (was Imagen 4)" unless it was renamed.
- For a Google text-to-image contract, use [nano-banana.md](./nano-banana.md). The earlier `:predict` contract is in git history.
