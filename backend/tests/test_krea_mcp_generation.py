"""Account routing, upload/poll/materialization, and no automatic retry/spend."""
from __future__ import annotations

import asyncio
import io
import json
import shutil
import subprocess
from pathlib import Path
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import httpx
import pytest
import respx
from PIL import Image
from mcp.types import Tool, CallToolResult, TextContent
from jsonschema import Draft202012Validator

from handlers import krea_gateway as gateway
from models.graph import GraphNode, PortValueDict
from services import output, cancellation
from services import krea_mcp_generation as adapter


IMAGE_ID = 'krea-image-openai-gpt-image-2'
MODEL_ID = 'image/openai/gpt-image-2'
CDN = 'https://media.example.test/output.png'
UPLOAD = 'https://api.krea.ai/public-api/assets/presigned/fixture'
CURRENT_UPLOAD = 'https://api.krea.ai/assets/presigned?workspaceId=fixture-workspace&userId=fixture-user&sig=fixture-signature&exp=9999999999'


def png():
    buffer = io.BytesIO()
    Image.new('RGBA', (16, 12), (10, 200, 150, 130)).save(buffer, format='PNG')
    return buffer.getvalue()


def result(value):
    return CallToolResult(content=[], structuredContent=value)


def tool(name, properties=None, required=None):
    return Tool(name=name, inputSchema={'type': 'object', 'properties': properties or {},
                'required': required or [], 'additionalProperties': False})


class Session:
    def __init__(self, jobs=None):
        self.calls = []
        self.upload_url = UPLOAD
        self.jobs = jobs or [{'job_id': 'job-fixture', 'status': 'completed', 'result': {'urls': [CDN]}}]
        self.definitions = [
            tool('get_model_schema', {'model': {'type': 'string'}}, ['model']),
            tool('generate', {'model': {'type': 'string'}, 'input': {'type': 'object'}}, ['model', 'input']),
            tool('get_job', {'jobId': {'type': 'string'}}, ['jobId']),
            tool('cancel_job', {'jobId': {'type': 'string'}}, ['jobId']),
            tool('get_upload_url'),
            tool('list_models', {'category': {'type': 'string', 'enum': ['image', 'video']} }),
        ]

    async def list_tools(self):
        from types import SimpleNamespace
        return SimpleNamespace(tools=self.definitions)

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        if name == 'list_models':
            return result({'models': [{'id': model['endpoint'].removeprefix('/generate/'),
                                      'category': model['mediaType'].lower()}
                                     for model in gateway.catalog_models().values()
                                     if model['mediaType'].lower() == arguments.get('category', model['mediaType'].lower())]})
        if name == 'get_model_schema':
            definition = next(model for model in gateway.catalog_models().values()
                              if model['endpoint'] == '/generate/' + arguments['model'])
            return result({'model': arguments['model'], 'category': definition['mediaType'].lower(),
                           'endpointPath': definition['endpoint'].removeprefix('/generate/'),
                           'inputSchema': definition['requestSchema'], 'outputSchemas': {}})
        if name == 'get_upload_url':
            return result({'url': self.upload_url})
        if name == 'generate':
            return result({'job_id': 'job-fixture', 'job': {'status': 'queued'}})
        if name == 'get_job':
            answer = self.jobs.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return result(answer)
        return result({'job_id': 'job-fixture', 'deleted': True})


@pytest.fixture
def setup(monkeypatch, tmp_path):
    from services import krea_connector
    session = Session()
    class Connector:
        async def list_tools(self, active):
            return (await active.list_tools()).tools

        @asynccontextmanager
        async def session(self, **kwargs):
            yield session
    monkeypatch.setattr(krea_connector, 'get_connector', Connector)
    monkeypatch.setattr(krea_connector, 'connection_revision', lambda: 'fixture-workspace')
    monkeypatch.setattr(gateway, 'get_run_dir', lambda: tmp_path)
    monkeypatch.setattr(output, 'OUTPUT_ROOT', tmp_path)
    monkeypatch.setattr(gateway, 'POLL_INTERVAL', 0)
    return session, tmp_path


async def run(inputs=None, auth='mcp'):
    return await gateway.handle_krea_gateway(
        GraphNode(id='account-image', definitionId=IMAGE_ID, params={'_kreaAuth': auth}),
        inputs or {'prompt': PortValueDict(type='Text', value='test artwork')}, {}, emit=AsyncMock())


@pytest.mark.asyncio
@pytest.mark.parametrize('upload_url', [UPLOAD, CURRENT_UPLOAD])
@pytest.mark.parametrize('upload_body,content_type', [
    (b'{"image_url":"https://assets.krea.ai/source.png"}', 'application/json'),
    (b'{"image_url":"https://assets.krea.ai/source.png"}', None),
    (b'https://assets.krea.ai/source.png', None),
    (b'https://assets.krea.ai/source.png\n', 'text/plain; charset=utf-8'),
])
async def test_account_generation_uploads_local_artwork_and_saves_real_outputs(setup, upload_url, upload_body, content_type):
    session, root = setup
    session.upload_url = upload_url
    source = root / 'source.png'
    source.write_bytes(png())
    with respx.mock as router:
        upload = router.post(upload_url).respond(200, content=upload_body,
                                                headers={'content-type': content_type} if content_type else {})
        download = router.get(CDN).respond(200, content=png(), headers={'content-type': 'image/png'})
        outputs = await run({'prompt': PortValueDict(type='Text', value='test artwork'),
                             'image_urls': PortValueDict(type='Image', value=str(source))})
        assert upload.call_count == download.call_count == 1
        assert source.read_bytes() in upload.calls[0].request.content
        assert 'authorization' not in upload.calls[0].request.headers
        assert 'authorization' not in download.calls[0].request.headers
    calls = dict(session.calls)
    assert calls['generate'] == {'model': MODEL_ID, 'input': {'prompt': 'test artwork', 'image_urls': ['https://assets.krea.ai/source.png']}}
    assert '_kreaAuth' not in calls['generate']['input']
    assert [name for name, _ in session.calls] == ['list_models', 'get_model_schema', 'get_upload_url', 'generate', 'get_job']
    assert outputs['image']['value'] != str(source)
    with Image.open(outputs['image']['value']) as image:
        assert image.mode == 'RGBA'
    assert outputs['images']['value'][0].startswith('/api/outputs/')


@pytest.mark.asyncio
async def test_api_token_recipe_never_falls_back_to_connected_account(setup):
    session, _ = setup
    with pytest.raises(ValueError, match='KREA_API'):
        await run(auth='api-token')
    assert not session.calls


@pytest.mark.asyncio
async def test_schema_drift_fails_before_upload_or_generation(setup):
    session, _ = setup
    session.definitions[1] = tool('generate', {'unfamiliar_model': {'type': 'string'}}, ['unfamiliar_model'])
    with pytest.raises(RuntimeError, match='Unsupported Krea generate'):
        await run()
    assert [name for name, _ in session.calls] == ['list_models', 'get_model_schema']


@pytest.mark.asyncio
async def test_lost_poll_cancels_accepted_job_without_resubmission(setup):
    session, _ = setup
    session.jobs = [RuntimeError('synthetic lost poll')]
    with pytest.raises(RuntimeError, match='lost poll'):
        await run()
    await asyncio.gather(*tuple(cancellation._pending_cancel_tasks))
    names = [name for name, _ in session.calls]
    assert names.count('generate') == names.count('cancel_job') == 1


@pytest.mark.asyncio
async def test_canvas_stop_requests_provider_cancellation(setup):
    session, _ = setup
    entered = asyncio.Event()
    original = session.call_tool
    async def waiting(name, arguments):
        if name == 'get_job':
            entered.set()
            await asyncio.Event().wait()
        return await original(name, arguments)
    session.call_tool = waiting
    task = asyncio.create_task(run())
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.gather(*tuple(cancellation._pending_cancel_tasks))
    assert sum(name == 'cancel_job' for name, _ in session.calls) == 1


@pytest.mark.asyncio
async def test_cancellation_never_uses_a_reconnected_workspace(setup, monkeypatch):
    from services import krea_connector
    session, _ = setup
    monkeypatch.setattr(krea_connector, 'connection_revision', lambda: 'different-workspace')
    await adapter._cancel('original-job', 'fixture-workspace')
    assert not session.calls


@pytest.mark.asyncio
@pytest.mark.parametrize('upload_url', [
    'https://evil.test/upload',
    'http://api.krea.ai/assets/presigned',
    'https://api.krea.ai.evil.test/assets/presigned',
    'https://api.krea.ai:8443/assets/presigned',
    'https://fixture@api.krea.ai/assets/presigned',
    'https://fixture:fixture@api.krea.ai/assets/presigned',
    'https://@api.krea.ai/assets/presigned',
    'https://:@api.krea.ai/assets/presigned',
    'https://api.krea.ai/assets/presigned/fixture',
    'https://api.krea.ai/assets/presigned-extra',
    'https://api.krea.ai/other/assets/presigned',
    'https://api.krea.ai/assets/%70resigned',
])
async def test_malformed_upload_destination_never_receives_local_file(setup, upload_url):
    session, root = setup
    session.upload_url = upload_url
    source = root / 'source.png'
    source.write_bytes(png())
    with respx.mock as router:
        with pytest.raises(RuntimeError, match='upload destination'):
            await run({'prompt': PortValueDict(type='Text', value='fixture'),
                       'image_urls': PortValueDict(type='Image', value=str(source))})
        assert not router.calls
    assert not any(name == 'generate' for name, _ in session.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize('status', [302, 307, 308])
async def test_upload_redirect_never_forwards_local_file_or_submits_job(setup, status):
    session, root = setup
    session.upload_url = CURRENT_UPLOAD
    source = root / 'source.png'
    source.write_bytes(png())
    with respx.mock as router:
        upload = router.post(CURRENT_UPLOAD).respond(status, headers={'location': 'https://evil.test/upload'})
        redirect = router.route(host='evil.test').respond(200)
        with pytest.raises(RuntimeError, match=f'MCP asset upload failed \\({status}\\)'):
            await run({'prompt': PortValueDict(type='Text', value='fixture'),
                       'image_urls': PortValueDict(type='Image', value=str(source))})
        assert upload.call_count == 1
        assert not redirect.calls
    assert not any(name == 'generate' for name, _ in session.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize('status,content_type,body', [
    (200, None, b''),
    (204, None, b''),
    (200, None, b'<html>private-provider-body</html>'),
    (200, 'text/plain', b'<html>private-provider-body</html>'),
    (200, 'text/html', b'https://assets.krea.ai/source.png'),
    (200, 'application/json', b'https://assets.krea.ai/source.png?sig=private-provider-body'),
    (200, 'application/json', b'{private-provider-body'),
    (200, 'application/json', b'[]'),
    (200, 'application/json', b'null'),
    (200, 'application/json', b'{"message":"private-provider-body"}'),
    (200, 'application/json', b'{"image_url":"javascript:private-provider-body"}'),
    (200, None, b'https://assets.krea.ai/one.png\nhttps://assets.krea.ai/two.png'),
    (200, 'text/plain', b'Uploaded: https://assets.krea.ai/source.png'),
    (200, None, b'https://private-provider-body:private-provider-body@app-uploads.krea.ai/source.png'),
    (200, None, b'https://private-provider-body@app-uploads.krea.ai/source.png'),
    (200, None, b'https://:private-provider-body@app-uploads.krea.ai/source.png'),
    (200, None, b'https://@app-uploads.krea.ai/source.png'),
    (200, 'application/json', b'{"image_url":"https://private-provider-body:private-provider-body@app-uploads.krea.ai/source.png"}'),
    (200, 'application/json', b'{"image_url":"https://private-provider-body@app-uploads.krea.ai/source.png"}'),
    (200, 'application/json', b'{"image_url":"https://:private-provider-body@app-uploads.krea.ai/source.png"}'),
    (200, 'application/json', b'{"image_url":"https://@app-uploads.krea.ai/source.png"}'),
])
async def test_unusable_upload_response_never_submits_or_exposes_body(setup, status, content_type, body):
    session, root = setup
    session.upload_url = CURRENT_UPLOAD
    source = root / 'source.png'
    source.write_bytes(png())
    with respx.mock as router:
        upload = router.post(CURRENT_UPLOAD).respond(status, content=body,
            headers={'content-type': content_type} if content_type else {})
        with pytest.raises(RuntimeError, match='no usable asset URL') as failure:
            await run({'prompt': PortValueDict(type='Text', value='fixture'),
                       'image_urls': PortValueDict(type='Image', value=str(source))})
        assert upload.call_count == len(router.calls) == 1
        assert 'private-provider-body' not in str(failure.value)
    assert not any(name == 'generate' for name, _ in session.calls)


def test_mcp_structured_and_text_responses_and_errors():
    assert adapter.tool_value(CallToolResult(content=[TextContent(type='text', text='{"status":"queued"}')])) == {'status': 'queued'}
    assert adapter.tool_value(CallToolResult(content=[TextContent(type='text', text=UPLOAD)])) == UPLOAD
    assert adapter.tool_value(CallToolResult(content=[TextContent(type='text', text='Job submitted'),
                    TextContent(type='text', text='{"job_id":"job-1","status":"queued"}')]))['job_id'] == 'job-1'
    with pytest.raises(RuntimeError, match='no usable'):
        adapter.tool_value(CallToolResult(content=[TextContent(type='text', text='{"job_id":"job-1"}'),
                          TextContent(type='text', text='{"job_id":"job-2"}')]))
    with pytest.raises(RuntimeError, match='rejected'):
        adapter.tool_value(CallToolResult(isError=True, content=[TextContent(type='text', text='sensitive provider error')]))


def test_graph_validation_requires_selected_connection_and_legacy_wrappers_keep_api(setup, monkeypatch):
    from execution.engine import validate_graph
    from services import krea_connector
    account = GraphNode(id='account', definitionId=IMAGE_ID, params={'_kreaAuth': 'mcp'})
    monkeypatch.setattr(krea_connector, 'is_krea_connected', lambda: False)
    assert any('Connect your Krea account' in error.message for error in validate_graph([account], [], {'KREA_API_TOKEN': 'fixture'}))
    monkeypatch.setattr(krea_connector, 'is_krea_connected', lambda: True)
    assert not validate_graph([account], [], {})
    old = GraphNode(id='old', definitionId=IMAGE_ID, params={})
    assert any('Missing API key' in error.message for error in validate_graph([old], [], {}))
    legacy = GraphNode(id='legacy', definitionId='krea-image-style-reference', params={'_kreaAuth': 'mcp'})
    assert all('Connect your Krea' not in error.message for error in validate_graph([legacy], [], {}))


@pytest.mark.asyncio
async def test_real_executor_image_to_video_and_reconnection_cache_scope(setup, monkeypatch):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('Existing FFmpeg tools required for real video decoding')
    from execution import engine
    from execution.sync_runner import get_handler_registry
    from services import cache as cache_module, krea_connector
    from services.cache import ExecutionCache
    from models.events import ErrorEvent, ExecutedEvent
    from models.graph import GraphEdge
    session, root = setup
    movie = root / 'fixture.mp4'
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=cyan:size=16x16:rate=5',
                    '-t', '0.2', '-pix_fmt', 'yuv420p', str(movie)], check=True, capture_output=True)
    for module in (engine, cache_module):
        monkeypatch.setattr(module, 'OUTPUT_ROOT', root)
    monkeypatch.setattr(gateway, 'get_run_dir', output.get_run_dir)
    monkeypatch.setattr(krea_connector, 'is_krea_connected', lambda: True)
    revision = ['workspace-1']
    monkeypatch.setattr(krea_connector, 'connection_revision', lambda: revision[0])
    movie_url = 'https://media.example.test/animation.mp4'
    # Two explicit uncached image/video runs, separated by a workspace reconnect.
    session.jobs = [{'job_id': 'job-fixture', 'status': 'completed', 'result': {'urls': urls}}
                    for _ in range(2) for urls in ([CDN], [{'type': 'preview', 'url': CDN}, {'type': 'video', 'url': movie_url}])]
    # A cache hit copies the image into the new run. The downstream input path
    # is therefore new, matching the executor's existing cache semantics.
    session.jobs.append({'job_id': 'job-fixture', 'status': 'completed', 'result': {'urls': [{'type': 'video', 'url': movie_url}]}})
    cache = ExecutionCache()
    async def execute(run_id):
        nodes = [GraphNode(id='logo', definitionId=IMAGE_ID, params={'prompt': 'logo', '_kreaAuth': 'mcp'}),
                 GraphNode(id='motion', definitionId='krea-video-google-veo-3-1', params={'prompt': 'animate', '_kreaAuth': 'mcp'})]
        edges = [GraphEdge(id='logo-to-motion', source='logo', sourceHandle='image', target='motion', targetHandle='start_image')]
        events = []
        async def emit(event):
            events.append(event)
        assert not engine.validate_graph(nodes, edges, {})
        await engine.execute_graph(nodes, edges, {}, get_handler_registry(), emit, cache=cache, run_id=run_id, max_parallel_nodes=1)
        assert not [event for event in events if isinstance(event, ErrorEvent)]
        return {event.node_id: event.outputs for event in events if isinstance(event, ExecutedEvent)}
    with respx.mock as router:
        router.post(UPLOAD).respond(200, json={'image_url': 'https://assets.krea.ai/owned-logo.png'})
        router.get(CDN).respond(200, content=png(), headers={'content-type': 'image/png'})
        router.get(movie_url).respond(200, content=movie.read_bytes(), headers={'content-type': 'video/mp4'})
        first = await execute('account-first')
        revision[0] = 'workspace-2'
        second = await execute('account-second')
        third = await execute('account-cached')
    generations = [args for name, args in session.calls if name == 'generate']
    assert sum(args['model'] == MODEL_ID for args in generations) == 2
    assert len(generations) == 5
    assert sum(name == 'get_upload_url' for name, _ in session.calls) == 3
    assert Path(first['motion']['video']['value']).is_file()
    assert Path(second['motion']['video']['value']).is_file()
    assert Path(third['motion']['video']['value']).is_file()
    assert len({Path(value['motion']['video']['value']).parent for value in (first, second, third)}) == 3
    assert next(args for name, args in session.calls if name == 'generate' and args['model'].startswith('video/'))['input']['start_image'] == 'https://assets.krea.ai/owned-logo.png'


# These contracts were captured from authenticated, read-only Krea discovery.
# Only public names and input/output schemas are retained in the fixture.
LIVE_TOOLS = Path(__file__).with_name('fixtures') / 'krea_mcp_tools.json'
VIDEO_ID = 'krea-video-kling-kling-3-0'
VIDEO_MODEL_ID = 'kling/kling-3.0'
VIDEO_CDN = 'https://media.example.test/kling.mp4'
MUSIC_ID = 'krea-audio-elevenlabs-music-v2-5'
MUSIC_MODEL_ID = 'elevenlabs/music-v2.5'
MUSIC_CDN = 'https://media.example.test/track.mp3'


class LiveSession(Session):
    def __init__(self):
        super().__init__()
        self.definitions = [Tool.model_validate(value) for value in json.loads(LIVE_TOOLS.read_text())]
        self.inventory = [
            {'id': 'openai/gpt-image-2', 'category': 'image', 'name': 'ChatGPT 2'},
            {'id': VIDEO_MODEL_ID, 'category': 'video', 'name': 'Kling 3.0'},
            {'id': MUSIC_MODEL_ID, 'category': 'audio', 'name': 'ElevenLabs Music v2.5'},
            {'id': 'magnific/precise-enhance', 'category': 'enhance', 'name': 'Magnific Precise'},
            {'id': 'microsoft/trellis-2', 'category': '3d', 'name': 'TRELLIS 2'},
        ]
        self.schemas = {}
        for entry, node_id in zip(self.inventory, (IMAGE_ID, VIDEO_ID, MUSIC_ID,
                                                   'krea-enhance-magnific-precise-enhance', 'krea-3d-microsoft-trellis-2')):
            definition = gateway.catalog_models()[node_id]
            self.schemas[entry['id']] = {
                'model': entry['id'], 'category': entry['category'], 'name': entry['name'],
                'endpointPath': definition['endpoint'].removeprefix('/generate/'),
                'inputSchema': definition['requestSchema'], 'outputSchemas': {},
            }
        self.rejected = False

    async def call_tool(self, name, arguments):
        definition = next(tool for tool in self.definitions if tool.name == name)
        Draft202012Validator(definition.inputSchema).validate(arguments)
        self.calls.append((name, arguments))
        if name == 'list_models':
            # Return the complete actual category/name shape; the adapter must
            # check each entry's category even if a server ignores the filter.
            return result({'models': self.inventory})
        if name == 'get_model_schema':
            return result(self.schemas[arguments['model']])
        if name == 'get_upload_url':
            return CallToolResult(content=[TextContent(type='text', text=UPLOAD)])
        if name in {'generate_image', 'generate_video', 'generate_audio', 'enhance_image', 'generate_3d', 'generate'}:
            if self.rejected:
                return CallToolResult(content=[TextContent(type='text', text='synthetic rejection')], isError=True)
            return result({'mode': 'async', 'completed': False, 'timedOut': False,
                           'job_id': 'job-live-fixture',
                           'job': {'job_id': 'job-live-fixture', 'status': 'queued', 'type': 'fixture'}})
        if name == 'get_job':
            answer = self.jobs.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return result(answer)
        assert name == 'cancel_job'
        return result({'job_id': arguments['jobId'], 'deleted': True})


@pytest.fixture
def live_setup(setup, monkeypatch):
    from services import krea_connector
    _, root = setup
    session = LiveSession()
    class Connector:
        async def list_tools(self, active):
            return (await active.list_tools()).tools

        @asynccontextmanager
        async def session(self, **kwargs):
            assert kwargs.get('expected_revision') == 'fixture-workspace'
            yield session
    monkeypatch.setattr(krea_connector, 'get_connector', Connector)
    return session, root


async def live_run(node_id=VIDEO_ID, inputs=None):
    return await gateway.handle_krea_gateway(
        GraphNode(id='actual-category-model', definitionId=node_id, params={'_kreaAuth': 'mcp'}),
        inputs or {'prompt': PortValueDict(type='Text', value='test artwork')}, {}, emit=AsyncMock())


@pytest.mark.asyncio
@pytest.mark.parametrize('node_id,category,model_id', [(IMAGE_ID, 'image', 'openai/gpt-image-2'),
    (VIDEO_ID, 'video', VIDEO_MODEL_ID)])
async def test_actual_category_contract_binds_model_submits_once_polls_and_materializes(live_setup, node_id, category, model_id):
    session, root = live_setup
    # A generic tool is also available: the exact category tool must win.
    session.definitions.append(tool('generate', {'model': {'type': 'string'}, 'input': {'type': 'object'}}, ['model', 'input']))
    source = root / 'immutable-paper-snapshot.png'
    source.write_bytes(png())
    value = png()
    url = CDN
    content_type = 'image/png'
    if category == 'video':
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            pytest.skip('Existing FFmpeg tools required for real video decoding')
        movie = root / 'fixture.mp4'
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=cyan:size=16x16:rate=5',
                        '-t', '0.2', '-pix_fmt', 'yuv420p', str(movie)], check=True, capture_output=True)
        value, url, content_type = movie.read_bytes(), VIDEO_CDN, 'video/mp4'
    session.jobs = [{'job_id': 'job-live-fixture', 'status': 'processing', 'type': 'fixture'},
                    {'job_id': 'job-live-fixture', 'status': 'completed', 'type': 'fixture', 'result': {'urls': [url]}}]
    media_port = 'image_urls' if category == 'image' else 'start_image'
    with respx.mock as router:
        uploaded = router.post(UPLOAD).respond(200, json={'image_url': 'https://assets.krea.ai/actual-input.png'})
        downloaded = router.get(url).respond(200, content=value, headers={'content-type': content_type})
        outputs = await live_run(node_id, {'prompt': PortValueDict(type='Text', value='test artwork'),
                                         media_port: PortValueDict(type='Image', value=str(source))})
        assert uploaded.call_count == downloaded.call_count == 1
        assert 'authorization' not in uploaded.calls[0].request.headers
        assert 'authorization' not in downloaded.calls[0].request.headers
    calls = session.calls
    assert calls[0] == ('list_models', {'category': category})
    assert calls[1] == ('get_model_schema', {'model': model_id})
    submissions = [(name, args) for name, args in calls if name.startswith('generate')]
    assert len(submissions) == 1
    name, args = submissions[0]
    assert name == f'generate_{category}' and args['model'] == model_id and args['sync'] is False
    assert args['input'][media_port] == (['https://assets.krea.ai/actual-input.png'] if category == 'image' else 'https://assets.krea.ai/actual-input.png')
    assert [args for name, args in calls if name == 'get_job'] == [{'jobId': 'job-live-fixture'}] * 2
    assert Path(outputs[category]['value']).read_bytes() == value
    plural = outputs[f'{category}s']['value']
    assert plural[0].startswith('/api/outputs/') and Path(output.resolve_output_ref(plural[0])).read_bytes() == value
    assert source.read_bytes() == png()


@pytest.mark.asyncio
@pytest.mark.parametrize('field,value', [('model', 'other/model'), ('category', 'image'),
    ('endpointPath', 'video/kling/kling-2.6'), ('endpointPath', 'image/kling/kling-3.0'), ('endpointPath', None)])
async def test_actual_model_schema_binding_mismatch_fails_before_spend(live_setup, field, value):
    session, root = live_setup
    session.schemas[VIDEO_MODEL_ID][field] = value
    source = root / 'source.png'
    source.write_bytes(png())
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(RuntimeError, match='does not match the saved route'):
            await live_run(inputs={'prompt': PortValueDict(type='Text', value='test artwork'),
                                   'start_image': PortValueDict(type='Image', value=str(source))})
        assert not router.calls
    assert session.calls == [('list_models', {'category': 'video'}), ('get_model_schema', {'model': VIDEO_MODEL_ID})]


@pytest.mark.asyncio
@pytest.mark.parametrize('inventory', [[], [{'id': VIDEO_MODEL_ID, 'category': 'image'}],
    [{'id': VIDEO_MODEL_ID, 'category': 'video'}, {'id': 'video/' + VIDEO_MODEL_ID, 'category': 'video'}]])
async def test_actual_category_model_must_have_unique_discovered_identity(live_setup, inventory):
    session, _ = live_setup
    session.inventory = inventory
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(RuntimeError, match='unavailable or ambiguous'):
            await live_run()
        assert not router.calls
    assert session.calls == [('list_models', {'category': 'video'})]


@pytest.mark.asyncio
async def test_actual_live_schema_limits_are_checked_before_upload_or_submit(live_setup):
    session, root = live_setup
    schema = json.loads(json.dumps(session.schemas[VIDEO_MODEL_ID]['inputSchema']))
    schema['properties']['prompt']['maxLength'] = 1
    session.schemas[VIDEO_MODEL_ID]['inputSchema'] = schema
    source = root / 'source.png'
    source.write_bytes(png())
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(ValueError, match='prompt'):
            await live_run(inputs={'prompt': PortValueDict(type='Text', value='test artwork'),
                                   'start_image': PortValueDict(type='Image', value=str(source))})
        assert not router.calls
    assert [name for name, _ in session.calls] == ['list_models', 'get_model_schema']


@pytest.mark.asyncio
@pytest.mark.parametrize('missing,reason', [('list_models', 'does not expose the list_models'),
    ('generate_video', 'does not expose generate_video or generate')])
async def test_actual_category_contract_requires_discovery_and_correct_generation_tool(live_setup, missing, reason):
    session, _ = live_setup
    session.definitions = [definition for definition in session.definitions if definition.name != missing]
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(RuntimeError, match=reason):
            await live_run()
        assert not router.calls
    assert not session.calls


@pytest.mark.asyncio
async def test_category_tool_rejection_never_falls_back_or_retries(live_setup):
    session, _ = live_setup
    session.definitions.append(tool('generate', {'model': {'type': 'string'}, 'input': {'type': 'object'}}, ['model', 'input']))
    session.rejected = True
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(RuntimeError, match='tool rejected'):
            await live_run()
        assert not router.calls
    assert [name for name, _ in session.calls] == ['list_models', 'get_model_schema', 'generate_video']
    assert not cancellation._pending_cancel_tasks


@pytest.mark.asyncio
async def test_actual_video_stop_cancels_exact_accepted_job_without_resubmit(live_setup):
    session, _ = live_setup
    entered = asyncio.Event()
    original = session.call_tool
    async def waiting(name, arguments):
        if name == 'get_job':
            entered.set()
            await asyncio.Event().wait()
        return await original(name, arguments)
    session.call_tool = waiting
    task = asyncio.create_task(live_run())
    await asyncio.wait_for(entered.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.gather(*tuple(cancellation._pending_cancel_tasks))
    submissions = [(name, args) for name, args in session.calls if name.startswith('generate')]
    assert len(submissions) == 1 and submissions[0][0] == 'generate_video'
    assert [('cancel_job', {'jobId': 'job-live-fixture'})] == [(name, args) for name, args in session.calls if name == 'cancel_job']


@pytest.mark.asyncio
async def test_actual_video_poll_loss_cancels_without_category_fallback(live_setup):
    session, _ = live_setup
    session.jobs = [RuntimeError('synthetic lost category poll')]
    with pytest.raises(RuntimeError, match='lost category poll'):
        await live_run()
    await asyncio.gather(*tuple(cancellation._pending_cancel_tasks))
    names = [name for name, _ in session.calls]
    assert names.count('generate_video') == names.count('get_job') == names.count('cancel_job') == 1
    assert 'generate_image' not in names and 'generate' not in names


@pytest.mark.asyncio
async def test_account_music_binds_audio_tool_submits_once_and_saves_local_track(live_setup):
    session, _ = live_setup
    track = b'ID3' + bytes(64)
    session.jobs = [{'job_id': 'job-live-fixture', 'status': 'completed', 'type': 'fixture', 'result': {'urls': [MUSIC_CDN]}}]
    with respx.mock as router:
        downloaded = router.get(MUSIC_CDN).respond(200, content=track, headers={'content-type': 'audio/mpeg'})
        outputs = await gateway.handle_krea_gateway(
            GraphNode(id='account-music', definitionId=MUSIC_ID,
                      params={'_kreaAuth': 'mcp', 'music_length_ms': 40000, 'force_instrumental': True}),
            {'prompt': PortValueDict(type='Text', value='quiet ambient pulse')}, {}, emit=AsyncMock())
        assert 'authorization' not in downloaded.calls[0].request.headers
    assert session.calls[0] == ('list_models', {'category': 'audio'})
    assert session.calls[1] == ('get_model_schema', {'model': MUSIC_MODEL_ID})
    submissions = [(name, args) for name, args in session.calls if name.startswith('generate')]
    assert submissions == [('generate_audio', {'model': MUSIC_MODEL_ID, 'sync': False, 'input': {
        'music_length_ms': 40000, 'force_instrumental': True, 'prompt': 'quiet ambient pulse'}})]
    assert outputs['audio']['type'] == 'Audio'
    assert Path(outputs['audio']['value']).read_bytes() == track


@pytest.mark.asyncio
@pytest.mark.parametrize('node_id,category,tool_name,model_id,params', [
    ('krea-enhance-magnific-precise-enhance', 'enhance', 'enhance_image', 'magnific/precise-enhance',
     {'width': 2048, 'height': 2048, 'image_url': 'https://assets.example.test/source.png'}),
    ('krea-3d-microsoft-trellis-2', '3d', 'generate_3d', 'microsoft/trellis-2',
     {'prompt': 'a ceramic fox', 'input_mode': 'text'}),
])
async def test_account_enhance_and_3d_use_their_own_krea_tools(live_setup, node_id, category, tool_name, model_id, params):
    session, _ = live_setup
    url = CDN if category == 'enhance' else 'https://media.example.test/model.glb'
    body = png() if category == 'enhance' else b'glTF' + bytes(32)
    mime = 'image/png' if category == 'enhance' else 'model/gltf-binary'
    session.jobs = [{'job_id': 'job-live-fixture', 'status': 'completed', 'type': 'fixture', 'result': {'urls': [url]}}]
    with respx.mock as router:
        router.get(url).respond(200, content=body, headers={'content-type': mime})
        outputs = await gateway.handle_krea_gateway(
            GraphNode(id='account-' + category, definitionId=node_id, params={'_kreaAuth': 'mcp', **params}),
            {}, {}, emit=AsyncMock())
    assert session.calls[0] == ('list_models', {'category': category})
    submissions = [name for name, _ in session.calls if name.startswith(('generate', 'enhance'))]
    assert submissions == [tool_name]
    primary = 'image' if category == 'enhance' else 'mesh'
    assert Path(outputs[primary]['value']).read_bytes() == body
