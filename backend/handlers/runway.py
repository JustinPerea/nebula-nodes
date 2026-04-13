from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.async_poll_runner import AsyncPollConfig, async_poll_execute
from services.output import get_run_dir, save_video_from_url, image_to_data_uri

RUNWAY_API_BASE = "https://api.dev.runwayml.com/v1"


async def handle_runway_gen4_turbo(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    image_input = inputs.get("image")
    if not image_input or not image_input.value:
        raise ValueError("Image input is required for Runway Gen-4 Turbo")

    image_value = str(image_input.value)

    if not image_value.startswith(("http://", "https://", "data:")):
        image_path = Path(image_value)
        if not image_path.exists():
            raise ValueError(f"Image file not found: {image_value}")
        image_value = image_to_data_uri(image_path)

    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise ValueError("RUNWAY_API_KEY is required")

    model = node.params.get("model", "gen4_turbo")
    duration = int(node.params.get("duration", 5))

    submit_body: dict[str, Any] = {
        "model": model,
        "promptImage": image_value,
        "duration": duration,
        "ratio": node.params.get("ratio", "1280:720"),
    }

    prompt_input = inputs.get("prompt")
    if prompt_input and prompt_input.value:
        submit_body["promptText"] = str(prompt_input.value)[:1000]

    seed = node.params.get("seed")
    if seed is not None:
        submit_body["seed"] = int(seed)

    config = AsyncPollConfig(
        submit_url=f"{RUNWAY_API_BASE}/image_to_video",
        poll_url_template=f"{RUNWAY_API_BASE}/tasks/{{task_id}}",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-Runway-Version": "2024-11-06",
        },
        terminal_success={"SUCCEEDED"},
        terminal_failure={"FAILED"},
        status_path="status",
        task_id_path="id",
        poll_interval=2.0,
        max_polls=300,
    )

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway returned no output URLs")

    video_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)

    run_dir = get_run_dir()
    video_path = await save_video_from_url(video_url, run_dir)

    return {"video": {"type": "Video", "value": str(video_path)}}
