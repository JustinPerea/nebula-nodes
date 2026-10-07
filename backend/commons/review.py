"""Model-first review, separate from independent human ground truth.

One metered attempt per frozen reference. Proposals are immutable; only the
human acceptance endpoint writes reviewed labels. No import, few-shots,
tuning, or release of quarantined images occurs here. Once Justin closes the
batch (evaluation.close) no new attempts start, but accepting and correcting
the existing grades keeps working.
"""
from __future__ import annotations

import asyncio
import json
import os

from commons import evaluation as ev, media, records
from commons.db import now_iso
from commons.reader import MODEL_ID, PROMPT_VERSION, AnalysisInvalid, read_image, validate
from commons.vocab import Vocabulary


def _budget():
    return max(0, min(15, int(os.environ.get('NEBULA_COMMONS_REVIEW_CALL_BUDGET', '0'))))


def view(store):
    with store.db.read() as conn:
        batch = conn.execute('SELECT * FROM evaluation_batch WHERE id=1').fetchone()
        if batch is None:
            return None
        manifest = json.loads(batch['manifest'])
        items = []
        for row in conn.execute('SELECT position, palette FROM evaluation_items ORDER BY position'):
            review = conn.execute('SELECT * FROM assisted_reviews WHERE position=?', (row['position'],)).fetchone()
            entry = manifest['heldout'][row['position']]
            item = dict(position=row['position'], width=entry['width'], height=entry['height'],
                        image_sha256=entry['image_sha256'], status='pending', revision=0,
                        proposal=None, reviewed_labels=None, reviewer=None, reviewed_at=None, error=None)
            if review:
                item.update(dict(review))
                for name in ('proposal', 'reviewed_labels'):
                    item[name] = json.loads(review[name]) if review[name] else None
                item['palette'] = json.loads(row['palette'])
            items.append(item)
        closed = json.loads(batch['closed']) if batch['closed'] else None
        return dict(mode='assisted_review', independent_ground_truth=False, state=ev.state(batch),
                    batch_revision=batch['revision'], closed_at=closed['closed_at'] if closed else None,
                    close_hash=batch['close_hash'], manifest_hash=batch['manifest_hash'], items=items, model=MODEL_ID,
                    fields=ev.FIELDS, axes=list(ev.AXES), roles=ev.ROLES,
                    keywords=manifest['vocabulary_terms'], call_budget=_budget(),
                    attempts=sum(i['status'] != 'pending' for i in items))


def _reserve(store, position):
    with store.db.tx() as conn:
        batch = ev._batch(conn)
        if batch['closed']:
            raise ev.EvaluationError('This batch is closed; no new grading attempts.')
        row = ev._item(conn, position)
        if conn.execute('SELECT 1 FROM assisted_reviews WHERE position=?', (position,)).fetchone():
            raise ev.EvaluationError('This reference already has a grading attempt. No automatic retries.')
        if conn.execute('SELECT count(*) FROM assisted_reviews').fetchone()[0] >= _budget():
            raise ev.EvaluationError('Assisted review call budget reached or disabled.')
        if conn.execute("SELECT 1 FROM assisted_reviews WHERE status='running'").fetchone():
            raise ev.EvaluationError('Another reference is being graded. Wait for it to finish.')
        meter = records.meter_today(store)
        if meter['remaining'] <= 0:
            raise ev.EvaluationError('Daily model call cap reached.')
        # Meter and reservation commit together, before the external call.
        # A crash leaves a visible attempt, never an automatic second charge.
        conn.execute("INSERT INTO meter(day,kind,calls) VALUES (?,'analysis',1) "
                     'ON CONFLICT(day,kind) DO UPDATE SET calls=calls+1', (meter['day'],))
        conn.execute("INSERT INTO assisted_reviews(position,status,started_at) VALUES (?,'running',?)", (position,now_iso()))
        return bytes(row['image']), json.loads(row['palette']), json.loads(batch['manifest'])


async def propose(store, position, *, reader=None):
    png, palette, manifest = await asyncio.to_thread(_reserve, store, position)
    vocab = Vocabulary(manifest['vocabulary_version'], tuple(manifest['vocabulary_terms']), {})
    proposal = None
    error = None
    try:
        model_png = await asyncio.to_thread(media.encode_png, media.load_image(png, 'image/png'), max_edge=1568)
        result = await (reader or read_image)(model_png, palette, [], vocab=vocab)
        if result.error or result.structured is None:
            raise AnalysisInvalid('Reader did not return a valid proposal.')
        fields, _, _ = validate(result.structured, palette_len=len(palette), vocab=vocab)
        labels = dict(tags={key: fields[key]['value'] for key in ev.FIELDS},
                      axes={key: fields['axes'][key]['value'] for key in ev.AXES},
                      palette_roles={str(p['index']): p['role'] for p in fields['palette_roles']},
                      keywords=fields['keywords'], no_keywords=not fields['keywords'], flagged=False)
        ev.validate_labels(labels, palette, vocabulary=vocab.terms, complete=True)
        proposal = dict(labels=labels, fields=fields, model=result.model or MODEL_ID,
                        requested_model=MODEL_ID, prompt_version=PROMPT_VERSION,
                        vocabulary_version=vocab.version, image_sha256=ev.sha(png),
                        input_image_sha256=ev.sha(model_png), duration_ms=result.duration_ms,
                        created_at=now_iso(), actor='agent:commons-reader', fewshot_ids=[])
    except asyncio.CancelledError:
        _finish(store, position, None, 'Grading interrupted. No automatic retry was made.')
        raise
    except Exception:
        # Arbitrary subprocess errors can contain secrets or image instructions.
        error = 'The reader could not produce a complete valid grade. No automatic retry was made.'
    await asyncio.to_thread(_finish, store, position, proposal, error)
    return view(store)


def _finish(store, position, proposal, error):
    with store.db.tx() as conn:
        conn.execute('UPDATE assisted_reviews SET status=?,proposal=?,error=?,revision=revision+1 WHERE position=?',
                     ('ready' if proposal else 'failed', ev.canonical(proposal) if proposal else None, error, position))


def fail_interrupted(store):
    """Run at startup only, when no attempt can be in flight. A leftover
    'running' row means the process died mid-call; left alone it blocks every
    later attempt and the batch close. The call was metered, so fail it."""
    with store.db.tx() as conn:
        return conn.execute("UPDATE assisted_reviews SET status='failed',error=?,revision=revision+1 WHERE status='running'",
                            ('Grading was interrupted when Nebula stopped. No automatic retry was made.',)).rowcount


def accept(store, position, revision, labels):
    with store.db.tx() as conn:
        batch = ev._batch(conn)
        item = ev._item(conn, position)
        row = conn.execute('SELECT * FROM assisted_reviews WHERE position=?', (position,)).fetchone()
        if row is None or row['status'] != 'ready':
            raise ev.EvaluationError('Wait for a valid agent grade before reviewing.')
        if type(revision) is not int or revision != row['revision']:
            raise ev.EvaluationError('This review changed in another window. Reload before saving.')
        ev.validate_labels(labels, json.loads(item['palette']), vocabulary=json.loads(batch['manifest'])['vocabulary_terms'], complete=True)
        conn.execute("UPDATE assisted_reviews SET reviewed_labels=?,reviewer='human:justin',reviewed_at=?,revision=revision+1 WHERE position=?",
                     (ev.canonical(labels), now_iso(), position))
    return view(store)
