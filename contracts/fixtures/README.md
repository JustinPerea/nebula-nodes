# Contract fixtures

Golden request/response bytes for cross-platform parity. **Web pytest is the oracle** until Swift/TS ports add matching tests.

| Path | Used by |
|------|---------|
| `handlers/openai/gpt-image-2-generate-request.json` | `test_openai_request_body_matches_fixture`, `test_build_generate_body_*` |
| `handlers/openai/gpt-image-2-generate-sse.txt` | `test_e2e_generate_emits_partials`, `test_stream_runner_image`, `test_openai_contract_sse_fixtures` |
| `handlers/openai/gpt-image-2-edit-multipart.json` | `test_openai_request_body_matches_fixture` |
| `handlers/openai/gpt-image-2-edit-sse.txt` | `test_edit_streams_partial_and_returns_final_image`, `test_openai_contract_sse_fixtures` |
| `handlers/openai/gpt-image-1-generate-request.json` | `test_openai_request_body_matches_fixture` |
| `handlers/openai/gpt-image-1-edit-multipart.json` | `test_openai_request_body_matches_fixture` |
| `handlers/openai/gpt-4o-chat-request.json` | `test_openai_request_body_matches_fixture` |
| `handlers/openai/gpt-4o-chat-sse.txt` | `test_gpt_4o_chat_sse_fixture_accumulates_text` |
| `handlers/openai/openai-tts-request.json` | `test_openai_request_body_matches_fixture` |
| `handlers/openai/openai-stt-request.json` | `test_openai_request_body_matches_fixture` |
| `handlers/openai/openai-translate-request.json` | `test_openai_request_body_matches_fixture` |
| `handlers/fal/gpt-image-2-fal-generate-request.json` | `test_fal_request_body_matches_fixture`, `test_gpt_image_2_fal_generate_key_params_forwarded` |
| `handlers/fal/gpt-image-2-fal-generate-sse.txt` | `test_fal_image_stream_parses_partials` |
| `handlers/fal/gpt-image-2-fal-edit-request.json` | `test_fal_request_body_matches_fixture`, `test_gpt_image_2_fal_edit_images_map_to_image_urls` |
| `handlers/fal/gpt-image-2-fal-edit-sse.txt` | `test_gpt_image_2_fal_edit_sse_fixture_emits_partial_and_final` |
| `handlers/fal/gpt-image-1-5-generate-request.json` | `test_fal_request_body_matches_fixture` |
| `handlers/fal/gpt-image-1-5-edit-request.json` | `test_fal_request_body_matches_fixture` |
| `handlers/fal/nano-banana-fal-generate-request.json` | `test_fal_request_body_matches_fixture` |
| `handlers/fal/nano-banana-fal-edit-request.json` | `test_fal_request_body_matches_fixture` |
| `handlers/fal/hunyuan3d-text-to-3d-request.json` | `test_fal_request_body_matches_fixture` |
| `handlers/fal/hunyuan3d-image-to-3d-request.json` | `test_fal_request_body_matches_fixture` |
| `handlers/google/gemini-chat-generate-request.json` | `test_google_request_body_matches_fixture` |
| `handlers/google/gemini-chat-sse.txt` | `test_gemini_chat_sse_fixture_accumulates_text` |
| `handlers/google/gemini-embeddings-request.json` | `test_google_request_body_matches_fixture` |
| `handlers/google/gemini-omni-flash-submit-request.json` | `test_google_request_body_matches_fixture` |
| `handlers/google/gemini-tts-generate-request.json` | `test_google_request_body_matches_fixture` |
| `handlers/google/imagen-4-generate-request.json` | `test_google_request_body_matches_fixture` |
| `handlers/google/lyria-3-generate-request.json` | `test_google_request_body_matches_fixture` |
| `handlers/google/nano-banana-generate-request.json` | `test_google_request_body_matches_fixture`, `test_nano_banana_aspect_ratio_uses_image_config` |
| `handlers/google/nano-banana-edit-request.json` | `test_google_request_body_matches_fixture` |
| `handlers/google/style-reference-auto-request.json` | `test_google_request_body_matches_fixture` |
| `handlers/google/veo-3-text-to-video-request.json` | `test_google_request_body_matches_fixture` |
| `handlers/google/veo-3-fal-request.json` | `test_google_request_body_matches_fixture` |

**OpenAI parity suite:** `backend/tests/test_openai_contract_fixtures.py` (JSON) + `backend/tests/test_openai_contract_sse_fixtures.py` (SSE).

**FAL parity suite:** `backend/tests/test_fal_contract_fixtures.py` (JSON) + `backend/tests/test_fal_contract_sse_fixtures.py` (SSE).

**Google parity suite:** `backend/tests/test_google_contract_fixtures.py` (JSON) + `backend/tests/test_google_contract_sse_fixtures.py` (SSE).

`contracts/fixtures/handlers/` is the single golden source. Backend and future Swift/TypeScript parity tests load these same bytes directly; do not create provider-family copies under `backend/tests/fixtures/`.
