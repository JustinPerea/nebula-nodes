"""Closing a held-out batch as assisted review releases the analysis gate.

Regression for the deadlock where agent grades made sealing impossible while
the worker waited for a seal forever. All media lives in tmp dirs.
"""
import io
import json
import secrets
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from commons import actors, evaluation, intake, records, review
from commons.db import CommonsDB, now_iso
from commons.reader import MODEL_ID, ReaderResult
from commons.store import CommonsStore
from tests.test_commons_evaluation import labels, store, source  # noqa: F401
from tests.test_commons_review import output


async def _grade(store, position, monkeypatch):
    monkeypatch.setenv('NEBULA_COMMONS_REVIEW_CALL_BUDGET', '15')
    async def reader(png, palette, shots, *, vocab):
        return ReaderResult(output(palette), None, MODEL_ID, 1)
    return await review.propose(store, position, reader=reader)


def _import(store, color, name='new.png'):
    collection = store.ensure_collection('library', 'manual', actor='human:justin')
    buf = io.BytesIO(); Image.new('RGB', (16, 16), color).save(buf, 'PNG')
    return intake.add_bytes(store, buf.getvalue(), filename=name, collection_id=collection['id'],
                            actor='human:justin', source={}).asset


def _close(store, **kwargs):
    revision = evaluation.view(store)['revision']
    return evaluation.close(store, revision, actor='human:justin', acknowledge=True, **kwargs)


@pytest.mark.asyncio
async def test_close_releases_worker_gate_after_assisted_review(store, source, monkeypatch):
    await evaluation.prepare(store, str(source))
    assert evaluation.view(store)['assisted_reviews'] == 0
    await _grade(store, 0, monkeypatch)
    assert evaluation.view(store)['assisted_reviews'] == 1
    asset = _import(store, 'white')
    assert records.claim_next(store, now_iso=now_iso()) is None
    with pytest.raises(evaluation.EvaluationError, match='assisted'):
        evaluation.seal(store, evaluation.view(store)['revision'])

    result = _close(store)

    assert result['state'] == 'closed' and len(result['close_hash']) == 64
    assert result['closed']['kind'] == 'assisted_review'
    assert result['closed']['independent_ground_truth'] is False
    assert evaluation.sha(evaluation.canonical(result['closed']).encode()) == result['close_hash']
    claimed = records.claim_next(store, now_iso=now_iso())
    assert claimed['id'] == asset['id'] and claimed['analysis_state'] == 'analyzing'


@pytest.mark.asyncio
async def test_close_keeps_quarantine_and_still_blocks_quarantined_assets(store, source, monkeypatch):
    await evaluation.prepare(store, str(source))
    await _grade(store, 0, monkeypatch)
    clean = _import(store, 'white', 'clean.png')
    near = _import(store, 'black', 'near.png')
    with store.db.tx() as conn:
        held = conn.execute('SELECT phash FROM quarantine LIMIT 1').fetchone()[0]
        conn.execute('UPDATE assets SET phash=? WHERE id=?', (held, near['id']))
        before = conn.execute('SELECT count(*) FROM quarantine').fetchone()[0]

    result = _close(store)

    with store.db.read() as conn:
        assert conn.execute('SELECT count(*) FROM quarantine').fetchone()[0] == before
    assert result['closed']['quarantine_count'] == before
    assert records.is_quarantined(store, near['id'])
    assert records.claim_next(store, now_iso=now_iso())['id'] == clean['id']
    assert records.claim_next(store, now_iso=now_iso()) is None


@pytest.mark.asyncio
async def test_accept_still_works_after_close_but_new_grading_is_refused(store, source, monkeypatch):
    await evaluation.prepare(store, str(source))
    item = (await _grade(store, 0, monkeypatch))['items'][0]
    closed = _close(store)

    corrected = json.loads(json.dumps(item['proposal']['labels']))
    corrected['axes']['quiet_loud'] = -0.5
    saved = review.accept(store, 0, item['revision'], corrected)['items'][0]

    assert saved['reviewer'] == 'human:justin' and saved['reviewed_labels'] == corrected
    assert saved['reviewed_at'] > closed['closed']['closed_at']
    after = evaluation.view(store)
    assert after['closed'] == closed['closed'] and after['close_hash'] == closed['close_hash']
    with pytest.raises(evaluation.EvaluationError, match='closed'):
        await _grade(store, 1, monkeypatch)
    reviewed = review.view(store)
    assert reviewed['state'] == 'closed' and reviewed['close_hash'] == closed['close_hash']


@pytest.mark.asyncio
async def test_close_is_idempotent_and_refuses_cleanly(store, source, monkeypatch):
    await evaluation.prepare(store, str(source))
    await _grade(store, 0, monkeypatch)
    stale = evaluation.view(store)['revision']
    with pytest.raises(evaluation.EvaluationError, match='changed'):
        evaluation.close(store, stale - 1, actor='human:justin', acknowledge=True)
    with pytest.raises(evaluation.EvaluationError, match='Confirm'):
        evaluation.close(store, stale, actor='human:justin', acknowledge=False)
    with store.db.tx() as conn:
        conn.execute("UPDATE assisted_reviews SET status='running' WHERE position=0")
    with pytest.raises(evaluation.EvaluationError, match='running'):
        evaluation.close(store, stale, actor='human:justin', acknowledge=True)
    assert evaluation.view(store)['state'] == 'open'
    with store.db.tx() as conn:
        conn.execute("UPDATE assisted_reviews SET status='ready' WHERE position=0")

    first = evaluation.close(store, stale, actor='human:justin', acknowledge=True)
    again = evaluation.close(store, stale, actor='human:justin', acknowledge=True)

    assert again['close_hash'] == first['close_hash'] and again['revision'] == first['revision']
    with pytest.raises(evaluation.EvaluationError, match='closed'):
        evaluation.seal(store, first['revision'])
    with pytest.raises(evaluation.EvaluationError, match='closed'):
        evaluation.lock_accents(store, 1, first['revision'], [], True)
    with pytest.raises(evaluation.EvaluationError, match='closed'):
        evaluation.save_labels(store, 1, first['revision'], labels([]))
    with pytest.raises(evaluation.EvaluationError, match='closed as assisted review'):
        await evaluation.prepare(store, str(source))


@pytest.mark.asyncio
async def test_attempt_left_running_by_a_crash_is_failed_at_startup(store, source, monkeypatch):
    await evaluation.prepare(store, str(source))
    monkeypatch.setenv('NEBULA_COMMONS_REVIEW_CALL_BUDGET', '15')
    review._reserve(store, 0)  # the process dies here, before _finish runs
    with pytest.raises(evaluation.EvaluationError, match='running'):
        _close(store)
    with pytest.raises(evaluation.EvaluationError, match='being graded'):
        review._reserve(store, 1)

    assert review.fail_interrupted(store) == 1
    assert review.fail_interrupted(store) == 0

    item = review.view(store)['items'][0]
    assert item['status'] == 'failed' and 'interrupted' in item['error']
    with pytest.raises(evaluation.EvaluationError, match='No automatic retries'):
        review._reserve(store, 0)
    asset = _import(store, 'white')
    assert _close(store)['state'] == 'closed'
    assert records.claim_next(store, now_iso=now_iso())['id'] == asset['id']


@pytest.mark.asyncio
async def test_startup_fails_interrupted_attempts(store, source, monkeypatch):
    import main
    from commons import runtime, ui_auth
    await evaluation.prepare(store, str(source))
    monkeypatch.setenv('NEBULA_COMMONS_REVIEW_CALL_BUDGET', '15')
    review._reserve(store, 0)
    monkeypatch.delenv('NEBULA_COMMONS_NO_STARTUP_SCAN')
    monkeypatch.setattr(runtime, 'get_store', lambda: store)
    monkeypatch.setattr(ui_auth, 'initialize_ui_session', lambda session: None)

    await main._commons_startup()

    assert review.view(store)['items'][0]['status'] == 'failed'


@pytest.mark.asyncio
async def test_sealed_batch_cannot_be_closed(store, source):
    await evaluation.prepare(store, str(source))
    revision = 0
    for n in range(15):
        view = evaluation.lock_accents(store, n, revision, [], True)
        view = evaluation.save_labels(store, n, view['revision'], labels(view['items'][n]['palette']))
        revision = view['revision']
    sealed = evaluation.seal(store, revision)
    with pytest.raises(evaluation.EvaluationError, match='sealed'):
        evaluation.close(store, sealed['revision'], actor='human:justin', acknowledge=True)
    assert sealed['state'] == 'sealed'


@pytest.mark.asyncio
async def test_close_abandoned_blind_batch_without_agent_grades(store, source):
    await evaluation.prepare(store, str(source))
    evaluation.lock_accents(store, 0, 0, [], True)
    asset = _import(store, 'white')

    result = _close(store)

    assert result['closed']['kind'] == 'abandoned'
    assert result['closed']['blind_drafts']['accents_locked'] == [0]
    assert result['closed']['reviews'] == []
    assert records.claim_next(store, now_iso=now_iso())['id'] == asset['id']


@pytest.mark.asyncio
async def test_close_and_seal_refuse_when_the_frozen_batch_was_altered(store, source, monkeypatch, tmp_path):
    await evaluation.prepare(store, str(source))
    await _grade(store, 0, monkeypatch)
    with store.db.tx() as conn:
        conn.execute("UPDATE evaluation_items SET image=x'00' WHERE position=3")
    with pytest.raises(evaluation.EvaluationError, match='Integrity'):
        _close(store)
    assert evaluation.view(store)['state'] == 'open'

    db = CommonsDB(tmp_path / 'second' / 'commons.db')
    second = CommonsStore(db, tmp_path / 'second' / 'blobs')
    try:
        await evaluation.prepare(second, str(source))
        with second.db.tx() as conn:
            conn.execute('DELETE FROM quarantine WHERE rowid = (SELECT min(rowid) FROM quarantine)')
        with pytest.raises(evaluation.EvaluationError, match='Integrity'):
            _close(second)
        with second.db.tx() as conn:
            conn.execute("UPDATE evaluation_batch SET manifest = manifest || ' '")
        revision = 0
        for n in range(15):
            view = evaluation.lock_accents(second, n, revision, [], True)
            view = evaluation.save_labels(second, n, view['revision'], labels(view['items'][n]['palette']))
            revision = view['revision']
        with pytest.raises(evaluation.EvaluationError, match='Integrity'):
            evaluation.seal(second, revision)
        assert evaluation.view(second)['sealed'] is None
    finally:
        db.close()


@pytest.mark.asyncio
async def test_v3_database_migrates_to_v4_without_changing_the_batch(store, source, monkeypatch):
    await evaluation.prepare(store, str(source))
    await _grade(store, 0, monkeypatch)
    path, blobs = store.db.path, store.blobs
    before = evaluation.view(store)
    with store.db.read() as conn:
        quarantine = conn.execute('SELECT count(*) FROM quarantine').fetchone()[0]
    store.db.close()
    raw = sqlite3.connect(path)
    raw.execute('ALTER TABLE evaluation_batch DROP COLUMN close_hash')
    raw.execute('ALTER TABLE evaluation_batch DROP COLUMN closed')
    raw.execute("UPDATE meta SET value='3' WHERE key='schema_version'")
    raw.commit(); raw.close()

    for _ in range(2):  # the migration is idempotent across reopens
        db = CommonsDB(path)
        reopened = CommonsStore(db, blobs)
        try:
            with db.read() as conn:
                columns = {r[1] for r in conn.execute('PRAGMA table_info(evaluation_batch)')}
                assert {'closed', 'close_hash'} <= columns
                assert conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == '4'
                assert conn.execute('SELECT count(*) FROM quarantine').fetchone()[0] == quarantine
                assert conn.execute('SELECT count(*) FROM assisted_reviews').fetchone()[0] == 1
            after = evaluation.view(reopened)
            assert after['state'] == 'open' and after['closed'] is None
            assert (after['manifest_hash'], after['revision']) == (before['manifest_hash'], before['revision'])
            assert records.claim_next(reopened, now_iso=now_iso()) is None
        finally:
            db.close()


@pytest.mark.asyncio
async def test_close_api_is_human_only_and_status_reports_state(store, source, monkeypatch):
    from routes import commons as routes
    app = FastAPI(); app.include_router(routes.router); app.dependency_overrides[routes.store_dep] = lambda: store
    monkeypatch.setattr(routes, '_worker_status', lambda: {'state': 'idle', 'running': False})
    monkeypatch.setattr(actors, 'ui_session', actors.UISession())
    token = secrets.token_urlsafe(32); actors.ui_session.set(token)
    human = {'Authorization': f'Bearer {token}'}
    client = TestClient(app)

    status = client.get('/api/commons/status').json()
    assert status['evaluation_state'] == 'none' and status['evaluation_waiting'] is False
    await evaluation.prepare(store, str(source))
    status = client.get('/api/commons/status').json()
    assert (status['evaluation_state'], status['evaluation_waiting'], status['evaluation_assisted']) == ('open', True, False)
    await _grade(store, 0, monkeypatch)
    assert client.get('/api/commons/status').json()['evaluation_assisted'] is True

    body = {'revision': evaluation.view(store)['revision'], 'acknowledge_not_blind': True}
    for headers in ({}, {'X-Nebula-Client': 'human:justin'}):
        assert client.post('/api/commons/evaluation/close', json=body, headers=headers).status_code == 403
    assert evaluation.view(store)['state'] == 'open'
    assert client.post('/api/commons/evaluation/close', json={**body, 'acknowledge_not_blind': False},
                       headers=human).status_code == 409
    response = client.post('/api/commons/evaluation/close', json=body, headers=human)
    assert response.status_code == 200 and 'no-store' in response.headers['cache-control']
    assert response.json()['state'] == 'closed' and len(response.json()['close_hash']) == 64
    assert response.json()['closed']['actor'] == 'human:justin'

    status = client.get('/api/commons/status').json()
    assert (status['evaluation_state'], status['evaluation_waiting']) == ('closed', False)
