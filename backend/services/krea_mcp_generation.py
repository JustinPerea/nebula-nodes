"""Account-backed generation through discovered Krea MCP tool contracts.

This adapter only runs from an explicit graph execution. Tool schemas are
checked before submission; unfamiliar contracts fail before spending compute.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any
from urllib.parse import urlsplit

import httpx
from jsonschema import Draft202012Validator

from services.cancellation import schedule_detached_cancel
from models.events import ProgressEvent


def _balance_reason(value) -> str | None:
    """Krea answers an empty workspace with status 402 / INSUFFICIENT_BALANCE
    and the units still available; say that plainly and what to do."""
    if not isinstance(value, dict):
        return None
    response = value.get('response') if isinstance(value.get('response'), dict) else {}
    if value.get('status') != 402 and response.get('message') != 'INSUFFICIENT_BALANCE':
        return None
    units = value.get('availableUnits')
    left = f' ({units:g} compute units left)' if isinstance(units, (int, float)) and not isinstance(units, bool) else ''
    return (f'the connected Krea workspace is out of compute{left}. Add compute or change plan on krea.ai '
            '(Settings → Krea MCP → Show Krea plans), or switch this node to the API token. Nothing was generated')


def rejection_detail(result) -> str:
    """Krea's own reason for refusing a tool call, with links and anything
    token-like removed and the length capped. Krea sends either plain text or
    a JSON object with a ``message`` field (plus admin emails, not shown)."""
    balance = _balance_reason(result.structuredContent)
    if balance:
        return balance
    message = ''
    for block in result.content:
        text = getattr(block, 'text', None) if getattr(block, 'type', None) == 'text' else None
        if not isinstance(text, str) or not text.strip():
            continue
        try:
            value = json.loads(text)
        except (ValueError, TypeError):
            message = message or text
            continue
        if _balance_reason(value):
            return _balance_reason(value)
        if isinstance(value, dict):
            found = value.get('message') or value.get('error')
            found = found.get('message') if isinstance(found, dict) else found
            if isinstance(found, str) and found.strip():
                message = found
                break
    message = re.sub(r'\S+://\S+', '[link]', message)
    message = re.sub(r'[A-Za-z0-9_\-.=+/]{32,}', '[redacted]', message)
    return ' '.join(message.split())[:240]


def tool_value(result) -> Any:
    if result.isError:
        detail = rejection_detail(result)
        raise RuntimeError(f'Krea MCP tool rejected the request: {detail}' if detail else
                           'Krea MCP tool rejected the request; check your connection, model inputs and workspace compute')
    if result.structuredContent is not None:
        return result.structuredContent
    texts = [block.text for block in result.content if getattr(block, 'type', None) == 'text']
    candidates = []
    for text in texts:
        try:
            candidates.append(json.loads(text))
        except (ValueError, TypeError):
            pass
    if len(candidates) == 1:
        return candidates[0]
    if not candidates and len(texts) == 1:
        return texts[0]
    raise RuntimeError('Krea MCP returned no usable structured result')


def _upload_asset_url(response: httpx.Response) -> str:
    """Decode the MCP upload's raw URL or the legacy JSON asset object."""
    from handlers.krea_gateway import _http_url

    content_type = response.headers.get('content-type', '').split(';', 1)[0].strip().lower()
    text = response.text.strip()
    error = 'Krea asset upload returned no usable asset URL; no job was submitted'
    if content_type == 'application/json' or (not content_type and text.startswith('{')):
        try:
            answer = response.json()
        except ValueError:
            raise RuntimeError(error) from None
        if not isinstance(answer, dict):
            raise RuntimeError(error)
        asset_url = answer.get('image_url') or answer.get('asset_url') or answer.get('url')
    elif content_type in {'', 'text/plain'}:
        # get_upload_url promises an asset URL in the response body. The
        # current signed upload returns that URL without a Content-Type.
        asset_url = text
    else:
        raise RuntimeError(error)
    try:
        parsed = _http_url(asset_url)
        if parsed.username is not None or parsed.password is not None:
            raise ValueError('Asset URLs cannot contain userinfo')
    except ValueError:
        # Never surface a signed URL or provider response body in the error.
        raise RuntimeError(error) from None
    return asset_url


class KreaTools:
    def __init__(self, session, tools):
        self.session = session
        self.tools = {tool.name: tool for tool in tools}

    def arguments(self, name: str, values: list[tuple[tuple[str, ...], Any]]) -> dict:
        tool = self.tools.get(name)
        if tool is None:
            raise RuntimeError(f'Krea server does not expose the {name} tool; no job was submitted')
        schema = tool.inputSchema
        properties = schema.get('properties', {})
        arguments = {}
        for alternatives, value in values:
            matches = [key for key in alternatives if key in properties]
            if len(matches) != 1:
                raise RuntimeError(f'Unsupported Krea {name} tool contract; no job was submitted')
            arguments[matches[0]] = value
        try:
            Draft202012Validator(schema).validate(arguments)
        except Exception as exc:
            raise RuntimeError(f'Krea {name} tool inputs do not match the discovered schema; no retry was submitted') from exc
        return arguments

    async def call(self, name: str, values: list[tuple[tuple[str, ...], Any]] = ()) -> Any:
        return tool_value(await self.session.call_tool(name, self.arguments(name, values)))


# Krea's MCP names the enhance tool after images, but it serves every enhance
# model, including the video upscalers.
CATEGORY_TOOLS = {'image': 'generate_image', 'video': 'generate_video', 'audio': 'generate_audio',
                  'enhance': 'enhance_image', '3d': 'generate_3d'}
MODEL_KEYS = ('model', 'model_id', 'modelId')
INPUT_KEYS = ('input', 'inputs', 'params', 'parameters', 'data')
JOB_KEYS = ('jobId', 'job_id', 'id')


def _schema(value) -> dict:
    if isinstance(value, dict):
        if isinstance(value.get('properties'), dict) and value.get('type', 'object') == 'object':
            return value
        for key in ('inputSchema', 'input_schema', 'requestSchema', 'request_schema', 'schema'):
            if key in value:
                return _schema(value[key])
    raise RuntimeError('Krea model schema could not be inspected; no job was submitted')


def _job(value) -> dict:
    if not isinstance(value, dict):
        raise RuntimeError('Krea MCP returned no job payload')
    job = value.get('job')
    if isinstance(job, dict):
        return {**job, **({'job_id': value['job_id']} if value.get('job_id') else {})}
    return value


def _generation_values(tools, name, model_id, body):
    values = [(MODEL_KEYS, model_id), (INPUT_KEYS, body)]
    if 'sync' in tools.tools[name].inputSchema.get('properties', {}):
        values.append((('sync',), False))
    return values


async def prepare_generation(tools, model, preview_body, validate):
    """Discover and validate the exact saved route, without uploading or generating."""
    endpoint = model['endpoint'].removeprefix('/generate/')
    category = endpoint.split('/', 1)[0]
    if category not in CATEGORY_TOOLS:
        raise RuntimeError('Krea model category does not match its saved route; no job was submitted')
    category_tool = CATEGORY_TOOLS[category]
    name = category_tool if category_tool in tools.tools else 'generate'
    if name not in tools.tools:
        raise RuntimeError(f'Krea server does not expose {category_tool} or generate; no job was submitted')
    tools.arguments('get_job', [(JOB_KEYS, '00000000-0000-4000-8000-000000000000')])
    tools.arguments('cancel_job', [(JOB_KEYS, '00000000-0000-4000-8000-000000000000')])

    # Current MCP model IDs omit the media category; older contracts include it.
    # Bind only IDs actually advertised for this exact saved category/route.
    discovery = tools.tools.get('list_models')
    discovery_args = [(('category',), category)] if discovery and 'category' in discovery.inputSchema.get('properties', {}) else []
    listing = await tools.call('list_models', discovery_args)
    models = listing.get('models') if isinstance(listing, dict) else None
    if not isinstance(models, list):
        raise RuntimeError('Krea model catalog could not be inspected; no job was submitted')
    matches = {entry['id'] for entry in models if isinstance(entry, dict)
               and entry.get('category') == category
               and isinstance(entry.get('id'), str)
               and entry['id'] in {endpoint, endpoint.removeprefix(category + '/')}}
    if len(matches) != 1:
        raise RuntimeError('The saved Krea model is unavailable or ambiguous in this account; no job was submitted')
    model_id = matches.pop()
    schema_value = await tools.call('get_model_schema', [(MODEL_KEYS, model_id)])
    if not isinstance(schema_value, dict):
        raise RuntimeError('Krea model schema could not be inspected; no job was submitted')
    schema_endpoint = schema_value.get('endpointPath')
    if (schema_value.get('model') != model_id or schema_value.get('category') != category
            or not isinstance(schema_endpoint, str)
            or schema_endpoint.lstrip('/').removeprefix('generate/') != endpoint):
        raise RuntimeError('Krea model schema does not match the saved route; no job was submitted')
    live_schema = _schema(schema_value)
    validate(preview_body, live_schema)
    values = _generation_values(tools, name, model_id, preview_body)
    tools.arguments(name, values)
    return name, model_id, live_schema, values


async def _cancel(job_id, revision):
    from services.krea_connector import get_connector, connection_revision
    try:
        if connection_revision() != revision:
            return
        async with get_connector().session(expected_revision=revision) as session:
            tools = KreaTools(session, await get_connector().list_tools(session))
            await tools.call('cancel_job', [(JOB_KEYS, job_id)])
    except Exception:
        # Cancellation is best effort, and must not disclose auth or responses.
        pass


def _checked_upload_url(answer) -> str:
    upload_url = answer if isinstance(answer, str) else next((answer.get(key) for key in ('upload_url', 'uploadUrl', 'url') if answer.get(key)), None) if isinstance(answer, dict) else None
    try:
        url = httpx.URL(upload_url)
        parsed = urlsplit(upload_url)
    except (ValueError, TypeError, httpx.InvalidURL) as exc:
        raise RuntimeError('Krea returned an invalid upload URL') from exc
    # The current MCP contract signs this exact route; retain
    # the older path-token route without allowing lookalikes.
    upload_path_allowed = (parsed.path == '/assets/presigned'
                           or parsed.path.startswith('/public-api/assets/presigned/'))
    if url.scheme != 'https' or url.host != 'api.krea.ai' or parsed.username is not None or parsed.password is not None or url.port not in (None, 443) or not upload_path_allowed:
        raise RuntimeError('Krea returned an unexpected upload destination')
    return upload_url


async def upload_asset(tools, client, asset) -> str:
    """Upload one local file through Krea's presigned MCP route; return its asset URL."""
    from handlers.krea import _raise_for_krea_response
    upload_url = _checked_upload_url(await tools.call('get_upload_url'))
    response = await client.post(upload_url, files={'file': asset})
    _raise_for_krea_response(response, 'MCP asset upload')
    return _upload_asset_url(response)


async def poll_job(tools, job, node_id, emit, *, max_polls, poll_interval, on_completed=None):
    """Poll an accepted account job to a terminal state. ``on_completed`` runs
    before returning so callers can mark the job settled for cancellation."""
    from handlers.krea import KREA_STATUS_PENDING
    job_id = str(job.get('job_id') or job.get('id') or '')
    for index in range(max_polls + 1):
        status = str(job.get('status', '')).lower()
        if status == 'completed':
            if on_completed:
                on_completed()
            return job
        if status in ('failed', 'cancelled', 'canceled'):
            if on_completed:
                on_completed()
            raise RuntimeError(f'Krea job {status}; inspect the saved run before retrying')
        if status not in KREA_STATUS_PENDING:
            raise RuntimeError(f'Krea job returned unknown status: {status}')
        if index == max_polls:
            raise RuntimeError('Krea MCP job timed out; cancellation requested')
        await asyncio.sleep(poll_interval)
        job = _job(await tools.call('get_job', [(JOB_KEYS, job_id)]))
        if emit:
            await emit(ProgressEvent(node_id=node_id, value=min((index + 1) / max_polls, 0.99)))
    raise RuntimeError('Krea MCP job timed out; cancellation requested')


async def generate(node, body, model, assets, map_body, validate, emit, *, max_polls, poll_interval):
    from services.krea_connector import get_connector, connection_revision

    job_id = None
    revision = connection_revision()
    completed = False

    def settled():
        nonlocal completed
        completed = True

    try:
        async with get_connector().session(expected_revision=revision) as session:
            tools = KreaTools(session, await get_connector().list_tools(session))
            # Resolve all required contracts before any upload/submission.
            # Local paths are replaced only for validation, then uploaded.
            async def placeholder(value):
                return 'https://assets.krea.ai/validated-local-input' if assets[value] else value
            preview_body = await map_body(body, model, placeholder)
            generation_name, model_id, live_schema, _ = await prepare_generation(tools, model, preview_body, validate)
            uploaded = {}
            async with httpx.AsyncClient(timeout=120.0, follow_redirects=False) as client:
                async def upload(value):
                    asset = assets[value]
                    if asset is None:
                        return value
                    if value not in uploaded:
                        uploaded[value] = await upload_asset(tools, client, asset)
                    return uploaded[value]
                body = await map_body(body, model, upload)
            validate(body, model['requestSchema'])
            validate(body, live_schema)
            job = _job(await tools.call(generation_name, _generation_values(tools, generation_name, model_id, body)))
            from handlers.krea_gateway import _JOB_ID
            job_id = str(job.get('job_id') or job.get('id') or '')
            if not _JOB_ID.fullmatch(job_id):
                raise RuntimeError('Krea MCP submit returned no valid job_id; submission was not retried')
            return await poll_job(tools, job, node.id, emit, max_polls=max_polls,
                                  poll_interval=poll_interval, on_completed=settled)
    finally:
        if job_id and not completed:
            schedule_detached_cancel(lambda: _cancel(job_id, revision))
