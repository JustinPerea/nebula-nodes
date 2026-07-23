# Nebula contracts

Platform-neutral contract documentation for Nebula Nodes. Used so **iPad**, **browser/web**, and **Mac** ports implement the same node shape, handler semantics, graph format, and events — without each surface re-deriving behavior from the Python/React codebase.

**Primary use:** agents and engineers **converting contracts to other languages** while keeping structure consistent across platforms. Not a general “how to use Nebula” guide.

| Volume | File | Stability | Purpose |
|--------|------|-----------|---------|
| 0 | [00-meta.md](./00-meta.md) | Rare changes | What contracts are, versioning, sources of truth, parity rules |
| 1 | [01-node-schema.md](./01-node-schema.md) | Rare changes | Universal node shape (ports, params, execution pattern) |
| 2 | [02-handler-patterns.md](./02-handler-patterns.md) | Occasional | Sync / stream / async-poll / local-engine |
| 3 | [03-handler-families/](./03-handler-families/) | Grows over time | `openai.md`, `fal.md`, `google.md`, … |
| 4 | `04-graph-and-persistence.md` | Occasional | `.nebula` graph JSON, validation, cache |
| 5 | `05-api-and-events.md` | Occasional | REST routes, WebSocket execution events |
| 6 | `06-platform-emission.md` | Occasional | What each platform generates from contracts |
| 7 | `07-studios-and-resources.md` | Grows with studios | Moodboard, Character, Cinema, Video/Remotion editors — assets + APIs + graph bridges |
| 8 | [08-model-contract-pipeline.md](./08-model-contract-pipeline.md) | Occasional | Repeatable workflow: inventory → exemplar → fixtures → parity tests |

**Contract pipeline:** `node scripts/contract-inventory.mjs` — gap report for exemplars/fixtures.

**Live node catalog (changes often):** `backend/data/node_definitions.json` → generated `docs/MODEL_REFERENCE.md`

**iPad port inventory:** `docs/ipad-conversion/NODE-CONTRACT-AUDIT.md` (generated)

**Drift gate:** `node scripts/check-node-contracts.mjs`

**Golden fixtures:** [`contracts/fixtures/`](../../contracts/fixtures/) (repo root)

**Exemplar contracts (porting templates):**

- **OpenAI direct (`OPENAI_API_KEY`):**
  - [examples/gpt-image-2.md](./examples/gpt-image-2.md) — GPT Image 2 generate + edit (stream)
  - [examples/gpt-image-1.md](./examples/gpt-image-1.md) — GPT Image 1 generate + edit (sync)
  - [examples/gpt-4o-chat.md](./examples/gpt-4o-chat.md) — OpenAI Chat token stream
  - [examples/openai-audio.md](./examples/openai-audio.md) — TTS, STT, Translate (sync)
- **FAL (`FAL_KEY`):**
  - [examples/gpt-image-2-fal.md](./examples/gpt-image-2-fal.md) — GPT Image 2 FAL stream passthrough
  - [examples/nano-banana-fal.md](./examples/nano-banana-fal.md) — Nano Banana FAL generate + edit (async-poll)
  - [examples/gpt-image-1-5.md](./examples/gpt-image-1-5.md) — GPT Image 1.5 FAL generate + edit (async-poll)
  - [examples/hunyuan3d.md](./examples/hunyuan3d.md) — Hunyuan3D V3 text + image to mesh (async-poll)
- **Google direct (`GOOGLE_API_KEY`):**
  - [examples/nano-banana.md](./examples/nano-banana.md) — Gemini image sync
- **Google family (all direct nodes):**
  - [examples/gemini-chat.md](./examples/gemini-chat.md)
  - [examples/imagen-4-generate.md](./examples/imagen-4-generate.md)
  - [examples/lyria-3.md](./examples/lyria-3.md)
  - [examples/gemini-tts.md](./examples/gemini-tts.md)
  - [examples/gemini-embeddings.md](./examples/gemini-embeddings.md)
  - [examples/veo-3.md](./examples/veo-3.md)
  - [examples/gemini-omni-flash.md](./examples/gemini-omni-flash.md)
  - [examples/style-reference.md](./examples/style-reference.md)
