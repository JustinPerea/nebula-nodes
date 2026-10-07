"""Assisted review keeps model proposals separate from human judgments."""
import asyncio
import copy
import json
import pytest
from commons import evaluation, review
from commons.reader import ReaderResult, MODEL_ID
from tests.test_commons_evaluation import store, source  # noqa: F401


def output(palette):
    def field(value):
        return {'value': value, 'why': 'Visible in the reference.'}
    return dict(summary=field('A reference'), type_style=field('none'), spacing_density=field('airy'),
                layout=field('n_a'), medium=field('photo'), subject=field('Shapes'),
                composition_notes=field('Open space around the subject'),
                axes={k: field(0.25) for k in evaluation.AXES}, keywords=[], candidate_keywords=[], regions=[],
                palette_roles=[{'index': p['index'], 'role': 'other'} for p in palette])


@pytest.mark.asyncio
async def test_proposal_has_no_human_labels_or_fewshots_and_is_not_blind(store, source, monkeypatch):
    monkeypatch.setenv('NEBULA_COMMONS_REVIEW_CALL_BUDGET', '15')
    await evaluation.prepare(store, str(source))
    async def reader(png, palette, shots, *, vocab):
        assert png.startswith(b'\x89PNG') and shots == []
        return ReaderResult(output(palette), None, MODEL_ID, 50)
    result = await review.propose(store, 0, reader=reader)
    item = result['items'][0]
    assert item['status'] == 'ready' and item['reviewed_labels'] is None
    assert item['proposal']['model'] == MODEL_ID
    assert item['proposal']['labels']['axes']['quiet_loud'] == 0.25
    blind = evaluation.view(store)
    assert blind['items'][0]['labels'] is None and not blind['items'][0]['accent_locked']
    with pytest.raises(evaluation.EvaluationError, match='assisted'):
        evaluation.seal(store, blind['revision'])
    with pytest.raises(evaluation.EvaluationError, match='already'):
        await review.propose(store, 0, reader=reader)
    with store.db.read() as conn:
        assert conn.execute('SELECT sum(calls) FROM meter').fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM assets').fetchone()[0] == 0
    labels = copy.deepcopy(item['proposal']['labels'])
    labels['axes']['quiet_loud'] = -0.5
    result = review.accept(store, 0, item['revision'], labels)
    saved = result['items'][0]
    assert saved['reviewed_labels'] == labels and saved['reviewer'] == 'human:justin'
    assert saved['proposal'] == item['proposal']
    with pytest.raises(evaluation.EvaluationError, match='changed'):
        review.accept(store, 0, item['revision'], labels)
    labels['axes'] = {}
    with pytest.raises(evaluation.EvaluationError):
        review.accept(store, 0, saved['revision'], labels)


@pytest.mark.asyncio
async def test_budget_failure_and_duplicate_inflight_cannot_spend_twice(store, source, monkeypatch):
    await evaluation.prepare(store, str(source))
    monkeypatch.setenv('NEBULA_COMMONS_REVIEW_CALL_BUDGET', '0')
    with pytest.raises(evaluation.EvaluationError, match='budget'):
        await review.propose(store, 0)
    monkeypatch.setenv('NEBULA_COMMONS_REVIEW_CALL_BUDGET', '1')
    started, release = asyncio.Event(), asyncio.Event()
    async def reader(*args, **kwargs):
        started.set(); await release.wait()
        return ReaderResult(None, None, MODEL_ID, 1, error='provider failure')
    task = asyncio.create_task(review.propose(store, 0, reader=reader))
    await started.wait()
    with pytest.raises(evaluation.EvaluationError):
        await review.propose(store, 0, reader=reader)
    release.set()
    result = await task
    assert result['items'][0]['status'] == 'failed'
    assert result['items'][0]['reviewed_labels'] is None
    with pytest.raises(evaluation.EvaluationError, match='budget'):
        await review.propose(store, 1, reader=reader)


@pytest.mark.asyncio
async def test_missing_palette_roles_are_failed_not_invented(store, source, monkeypatch):
    monkeypatch.setenv('NEBULA_COMMONS_REVIEW_CALL_BUDGET', '15')
    await evaluation.prepare(store, str(source))
    async def reader(png, palette, shots, *, vocab):
        value = output(palette); value['palette_roles'] = []
        return ReaderResult(value, None, MODEL_ID, 1)
    result = await review.propose(store, 0, reader=reader)
    assert result['items'][0]['status'] == 'failed'
    assert result['items'][0]['proposal'] is None


@pytest.mark.asyncio
async def test_review_api_requires_human_and_records_only_explicit_acceptance(store, source, monkeypatch):
    import secrets
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from commons import actors
    from routes.commons import router, store_dep
    await evaluation.prepare(store, str(source))
    monkeypatch.setenv('NEBULA_COMMONS_REVIEW_CALL_BUDGET', '15')
    async def reader(png, palette, shots, *, vocab):
        return ReaderResult(output(palette), None, MODEL_ID, 1)
    monkeypatch.setattr(review, 'read_image', reader)
    app = FastAPI(); app.include_router(router); app.dependency_overrides[store_dep] = lambda: store
    monkeypatch.setattr(actors, 'ui_session', actors.UISession())
    token = secrets.token_urlsafe(32); actors.ui_session.set(token)
    client = TestClient(app); headers = {'Authorization': f'Bearer {token}'}
    for method, path, body in [('GET', '', None), ('POST', '/items/0/propose', {}), ('PUT', '/items/0', {'revision':0,'labels':{}})]:
        assert client.request(method, '/api/commons/review' + path, json=body).status_code == 403
    response = client.post('/api/commons/review/items/0/propose', headers=headers, json={})
    assert response.status_code == 200 and response.headers['cache-control'] == 'no-store'
    item = response.json()['items'][0]
    response = client.put('/api/commons/review/items/0', headers=headers, json={'revision': item['revision'], 'labels': item['proposal']['labels']})
    assert response.status_code == 200 and response.json()['items'][0]['reviewed_at']
