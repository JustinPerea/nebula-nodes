"""Evaluation isolation and immutable human labels; all media lives in tmp dirs."""
import copy
import io
import json
import secrets
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from commons import actors, evaluation, intake, records
from commons.db import CommonsDB, now_iso
from commons.store import CommonsStore

@pytest.fixture
def store(tmp_path):
    db = CommonsDB(tmp_path / 'state' / 'commons.db')
    yield CommonsStore(db, tmp_path / 'state' / 'blobs')
    db.close()

@pytest.fixture
def source(tmp_path):
    root = tmp_path / 'source'
    for n in range(45):
        folder = root / f'folder-{n % 3}'
        folder.mkdir(parents=True, exist_ok=True)
        Image.fromarray(np.random.default_rng(n).integers(0, 255, (32, 40, 3), dtype=np.uint8)).save(folder / f'{n:02}.png')
    return root

def test_connected_clusters_are_transitive_and_selection_is_fixed():
    rows = [{'rel': f'{i}/x.png', 'hashes': [f'{h:016x}']} for i, h in enumerate([0, 255, 65535])]
    assert len(evaluation.clusters(rows)) == 1
    with pytest.raises(evaluation.EvaluationError, match='45'):
        evaluation.select(rows)

@pytest.mark.asyncio
async def test_prepare_is_atomic_private_and_preimport(store, source):
    result = await evaluation.prepare(store, str(source))
    assert len(result['items']) == 15 and result['denominator'] == 150
    assert all('palette' not in i and 'rel' not in i and 'source' not in i for i in result['items'])
    with store.db.read() as conn:
        assert conn.execute('SELECT count(*) FROM assets').fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM quarantine').fetchone()[0] == 15
        manifest = json.loads(conn.execute('SELECT manifest FROM evaluation_batch').fetchone()[0])
    assert len(manifest['tuning']) == 30
    assert len({x['cluster'] for x in manifest['heldout'] + manifest['tuning']}) == 45
    assert {x['rel'].split('/')[0] for x in manifest['heldout']} == {'folder-0','folder-1','folder-2'}
    with pytest.raises(evaluation.EvaluationError):
        await evaluation.prepare(store, str(source))
    image = evaluation.image_bytes(store, 0)
    for path in source.rglob('*.png'):
        path.write_bytes(b'changed')
    assert evaluation.image_bytes(store, 0) == image

@pytest.mark.asyncio
async def test_scan_downloads_before_read_and_fails_closed(store, source, monkeypatch):
    events = []
    monkeypatch.setattr(evaluation, 'is_dataless', lambda st: True)
    class Downloader:
        async def download(self, path):
            events.append(path)
            return False
    with pytest.raises(evaluation.EvaluationError, match='download'):
        await evaluation.prepare(store, str(source), downloader=Downloader())
    assert events and evaluation.view(store) is None
    with store.db.read() as conn:
        assert conn.execute('SELECT count(*) FROM quarantine').fetchone()[0] == 0

@pytest.mark.asyncio
async def test_symlinks_and_bad_media_do_not_reduce_denominator(store, source):
    (source / 'link.png').symlink_to(source / 'folder-0/00.png')
    with pytest.raises(evaluation.EvaluationError, match='symlink'):
        await evaluation.prepare(store, str(source))
    (source / 'link.png').unlink()
    (source / 'broken.png').write_bytes(b'not an image')
    with pytest.raises(evaluation.EvaluationError):
        await evaluation.prepare(store, str(source))
    assert evaluation.view(store) is None

def labels(palette):
    return {'tags': {'type_style':'none','spacing_density':'balanced','layout':'n_a','medium':'photo'},
            'axes': {k:0 for k in evaluation.AXES}, 'palette_roles': {str(p['index']):'other' for p in palette},
            'keywords': [], 'no_keywords': True, 'flagged':False}

@pytest.mark.asyncio
async def test_lock_revisions_validation_and_immutable_seal(store, source):
    await evaluation.prepare(store, str(source))
    with pytest.raises(evaluation.EvaluationError):
        evaluation.save_labels(store, 0, 0, labels([]))
    with pytest.raises(evaluation.EvaluationError):
        evaluation.seal(store, 0)
    revision = 0
    for n in range(15):
        view = evaluation.lock_accents(store, n, revision, [{'x':0.25,'y':0.75}], False)
        revision = view['revision']
        assert view['items'][n]['accents'][0]['hex'].startswith('#')
        with pytest.raises(evaluation.EvaluationError):
            evaluation.lock_accents(store, n, revision, [], True)
        body = labels(view['items'][n]['palette'])
        bad = copy.deepcopy(body); bad['axes']['quiet_loud'] = float('nan')
        with pytest.raises(evaluation.EvaluationError):
            evaluation.save_labels(store, n, revision, bad)
        with pytest.raises(evaluation.EvaluationError, match='changed'):
            evaluation.save_labels(store, n, revision - 1, body)
        view = evaluation.save_labels(store, n, revision, body)
        revision = view['revision']
    result = evaluation.seal(store, revision)
    assert result['sealed']['denominator'] == 150 and len(result['seal_hash']) == 64
    assert evaluation.seal(store, result['revision']) == result
    with pytest.raises(evaluation.EvaluationError):
        evaluation.save_labels(store, 0, result['revision'], body)
    assert evaluation.view(store)['seal_hash'] == result['seal_hash']

def test_worker_never_claims_quarantined_transitive_cluster(store):
    collection = store.ensure_collection('test', 'manual', actor='human:justin')
    ids=[]
    for n, h in enumerate([0, 255, 65535]):
        buf=io.BytesIO(); Image.new('RGB',(8,8),(n,0,0)).save(buf,'PNG')
        a=intake.add_bytes(store,buf.getvalue(),filename='x.png',collection_id=collection['id'],actor='human:justin',source={}).asset
        with store.db.tx() as conn:
            conn.execute('UPDATE assets SET phash=? WHERE id=?',(f'{h:016x}',a['id']))
        ids.append(a['id'])
    records.quarantine_add(store, [('0000000000000000', None)])
    assert records.quarantined_asset_ids(store) == set(ids)
    assert records.claim_next(store, now_iso=now_iso()) is None

@pytest.mark.asyncio
async def test_api_denies_every_evaluation_surface_to_agents(store, source, monkeypatch):
    from routes.commons import router, store_dep
    app=FastAPI(); app.include_router(router); app.dependency_overrides[store_dep]=lambda:store
    monkeypatch.setattr(actors,'ui_session',actors.UISession())
    token=secrets.token_urlsafe(32); actors.ui_session.set(token)
    human={'Authorization':f'Bearer {token}'}
    await evaluation.prepare(store, str(source))
    client=TestClient(app)
    for method, path, body in [('GET','',None),('GET','/items/0/image',None),('POST','/prepare',{'path':str(source)}),
                               ('POST','/items/0/accents',{'revision':0,'points':[],'no_accents':True}),
                               ('PUT','/items/0/labels',{'revision':0,'labels':{}}),('POST','/seal',{'revision':0})]:
        for headers in ({},{'X-Nebula-Client':'human:justin'}):
            assert client.request(method,'/api/commons/evaluation'+path,json=body,headers=headers).status_code == 403
    response=client.get('/api/commons/evaluation',headers=human)
    assert response.status_code == 200 and len(response.json()['items']) == 15
    image=client.get('/api/commons/evaluation/items/0/image',headers=human)
    assert image.status_code == 200 and 'no-store' in image.headers['cache-control']

@pytest.mark.asyncio
async def test_existing_import_prevents_selection_and_unsealed_batch_blocks_worker(store, source):
    await evaluation.prepare(store, str(source))
    col=store.ensure_collection('tuning', 'manual', actor='human:justin')
    buf=io.BytesIO(); Image.new('RGB',(16,16),'white').save(buf,'PNG')
    intake.add_bytes(store,buf.getvalue(),filename='new.png',collection_id=col['id'],actor='human:justin',source={})
    assert records.claim_next(store, now_iso=now_iso()) is None
    with store.db.tx() as conn:
        conn.execute('DELETE FROM evaluation_items')
        conn.execute('DELETE FROM evaluation_batch')
    with pytest.raises(evaluation.EvaluationError, match='before any import'):
        await evaluation.prepare(store, str(source))

@pytest.mark.asyncio
async def test_whole_cluster_quarantine_and_disk_reopen(store, source):
    original=source/'folder-0/00.png'
    (source/'copy.png').write_bytes(original.read_bytes())
    result=await evaluation.prepare(store,str(source))
    with store.db.read() as conn:
        manifest=json.loads(conn.execute('SELECT manifest FROM evaluation_batch').fetchone()[0])
        for entry in manifest['heldout']:
            for n in entry['members']:
                for h in manifest['inventory'][n]['hashes']:
                    assert conn.execute('SELECT 1 FROM quarantine WHERE phash=?',(h,)).fetchone()
    db=CommonsDB(store.db.path)
    reopened=CommonsStore(db,store.blobs)
    try:
        assert evaluation.view(reopened)==result
    finally:
        db.close()

@pytest.mark.asyncio
async def test_download_success_then_read_and_video_hashes(store, source, monkeypatch):
    pending={source/'folder-0/00.png'}
    original_snapshot=evaluation._snapshot
    monkeypatch.setattr(evaluation,'is_dataless',lambda st: bool(pending))
    class Downloader:
        async def download(self,path):
            pending.clear()
            return True
    def snapshot(path,root):
        assert not pending
        return original_snapshot(path,root)
    monkeypatch.setattr(evaluation,'_snapshot',snapshot)
    result=await evaluation.prepare(store,str(source),downloader=Downloader())
    assert len(result['items'])==15


def test_video_all_keyframes_participate_in_clustering(tmp_path, monkeypatch):
    from commons import media
    video=tmp_path/'a.mp4'; video.write_bytes(b'\x00\x00\x00\x18ftypisom' + b'\x00'*32)
    frames=[]
    for n in range(2):
        b=io.BytesIO(); Image.fromarray(np.random.default_rng(n).integers(0,255,(24,24,3),dtype=np.uint8)).save(b,'PNG'); frames.append(b.getvalue())
    monkeypatch.setattr(media,'probe_video',lambda p:{'duration':1})
    monkeypatch.setattr(media,'scene_cuts',lambda p:[])
    monkeypatch.setattr(media,'keyframe_times',lambda *args:[0,0.5])
    monkeypatch.setattr(media,'extract_frame',lambda p,t:frames[0 if t==0 else 1])
    row=evaluation._snapshot(video,tmp_path)
    assert len(row['hashes'])==2 and row['frame_times']==[0,0.5]
    linked={'rel':'still.png','hashes':[row['hashes'][1]]}
    assert len(evaluation.clusters([row,linked]))==1

@pytest.mark.asyncio
async def test_full_authenticated_api_seal_and_validation(store, source, monkeypatch):
    from routes.commons import router, store_dep
    app=FastAPI(); app.include_router(router); app.dependency_overrides[store_dep]=lambda:store
    monkeypatch.setattr(actors,'ui_session',actors.UISession())
    token=secrets.token_urlsafe(32); actors.ui_session.set(token)
    client=TestClient(app); headers={'Authorization':f'Bearer {token}'}
    url='/api/commons/evaluation'
    result=client.post(url+'/prepare',headers=headers,json={'path':str(source)})
    assert result.status_code==200
    state=result.json()
    assert client.post(url+'/items/0/accents',headers=headers,json={'revision':0,'points':[{'x':0.5,'y':0.5,'hex':'#ffffff'}],'no_accents':False}).status_code==409
    for n in range(15):
        result=client.post(url+f'/items/{n}/accents',headers=headers,json={'revision':state['revision'],'points':[],'no_accents':True})
        assert result.status_code==200; state=result.json()
        result=client.put(url+f'/items/{n}/labels',headers=headers,json={'revision':state['revision'],'labels':labels(state['items'][n]['palette'])})
        assert result.status_code==200; state=result.json()
    result=client.post(url+'/seal',headers=headers,json={'revision':state['revision']})
    assert result.status_code==200; state=result.json()
    assert evaluation.sha(evaluation.canonical(state['sealed']).encode())==state['seal_hash']
    assert client.put(url+'/items/0/labels',headers=headers,json={'revision':state['revision'],'labels':labels(state['items'][0]['palette'])}).status_code==409
