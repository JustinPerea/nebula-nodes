# Gemini Model IDs

Sourced from https://ai.google.dev/gemini-api/docs/models (fetched 2026-04-16). This list moves. When in doubt, fetch the live page.

## Text + multimodal reasoning

| ID | Family | Role |
|---|---|---|
| `gemini-3.1-pro-preview` | Gemini 3 | Advanced reasoning, agentic, hardest problems |
| `gemini-3-flash-preview` | Gemini 3 | Frontier cost/perf for everyday use |
| `gemini-3.1-flash-lite-preview` | Gemini 3 | High throughput, lowest cost in 3.x |
| `gemini-2.5-pro` | Gemini 2.5 | Previous-gen deep reasoning |
| `gemini-2.5-flash` | Gemini 2.5 | Previous-gen everyday |
| `gemini-2.5-flash-lite` | Gemini 2.5 | Previous-gen budget |

## Image generation / editing

| ID | Friendly name | Role |
|---|---|---|
| `gemini-3.1-flash-image-preview` | Nano Banana 2 | High-volume, 512/1K/2K/4K, image-search grounding, thinking_level |
| `gemini-3-pro-image-preview` | Nano Banana Pro | Studio-quality, text rendering, 1K/2K/4K, reasoning |
| `gemini-2.5-flash-image` | Nano Banana | Lowest latency, simple generation |
| `imagen-4` | Imagen | Dedicated text-to-image, up to 2K |

## Video generation

| ID | Audio | 4K | Refs | Extension | First/Last Frame |
|---|---|---|---|---|---|
| `veo-3.1-generate-preview` | ✅ | ✅ | up to 3 | ✅ | ✅ |
| `veo-3.1-fast-generate-preview` | ✅ | | up to 3 | ✅ | ✅ |
| `veo-3.1-lite-generate-preview` | ✅ | | | | ✅ |
| `veo-3.0-generate-001` | ✅ | | | | |
| `veo-3.0-fast-generate-001` | ✅ | | | | |
| `veo-2.0-generate-001` | | | | | |

## Live / realtime

| ID | Role |
|---|---|
| `gemini-3.1-flash-live-preview` | Real-time audio-to-audio, low-latency dialogue |
| `gemini-2.5-flash-native-audio-preview-12-2025` | Sub-second native audio streaming |

## Text-to-speech

| ID | Role |
|---|---|
| `gemini-3.1-flash-tts-preview` | Low-latency TTS with expressive tags |
| `gemini-2.5-flash-preview-tts` | Fast controllable TTS |
| `gemini-2.5-pro-preview-tts` | High-fidelity for podcast/audiobook |

## Embeddings

| ID | Role |
|---|---|
| `gemini-embedding-2-preview` | Multimodal embeddings — text, images, video, audio, PDFs |
| `gemini-embedding-001` | Text-only embeddings, semantic search, RAG |

## Music

| ID | Role |
|---|---|
| `lyria-3-pro-preview` | Full-length song generation |
| `lyria-3-clip-preview` | Short clips up to 30 seconds |

## Specialist

| ID | Role |
|---|---|
| `gemini-2.5-computer-use-preview-10-2025` | UI automation — clicking, typing, navigation |
| `deep-research-pro-preview-12-2025` | Multi-step research across hundreds of sources |
| `gemini-robotics-er-1.6-preview` | Spatial reasoning for robotics |

## Deprecated

- `gemini-2.0-flash` — deprecated
- `gemini-2.0-flash-lite` — deprecated
- `gemini-3-pro-preview` — shut down 2026-03-09 (note: different from the `-image-preview` variant which is active)

## Version semantics

| Suffix | Meaning |
|---|---|
| `-preview` | Production-capable, 2-week deprecation notice on changes |
| `-latest` | Auto-updates to newest version, 2-week change notice |
| `-NNN` (e.g. `-001`) | Stable pinned version |
| `-experimental` | Not for production; may break |

Prefer pinned versions in production code. The nebula node definitions should use preview/pinned IDs — avoid `-latest` to prevent silent behavioral shifts.
