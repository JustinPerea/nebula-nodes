"""Pre-import C1/C2 selection and human-only ground truth. Never calls a model."""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
import hashlib
import json
import math
import os
import stat
from pathlib import Path
import tempfile

from commons import media
from commons.db import now_iso
from commons.icloud import DatalessDownloader, is_dataless
from commons.measure import CODE_VERSION, measure_image, phash, phash_distance
from commons.reader import TYPE_STYLES, SPACING, LAYOUTS, MEDIA, ROLES
from commons.search import AXES
from commons.vocab import load_vocabulary

VERSION = 'heldout-1'
FIELDS = dict(type_style=TYPE_STYLES, spacing_density=SPACING, layout=LAYOUTS, medium=MEDIA)


class EvaluationError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def clusters(rows):
    """Connected components, not only direct neighbors of the chosen representative."""
    parents = list(range(len(rows)))
    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    for i, row in enumerate(rows):
        for j in range(i):
            if any(phash_distance(a, b) <= 8 for a in row['hashes'] for b in rows[j]['hashes']):
                parents[root(i)] = root(j)
    result = defaultdict(list)
    for i in range(len(rows)):
        result[root(i)].append(i)
    return list(result.values())


def select(rows):
    components = clusters(rows)
    if len(components) < 45:
        raise EvaluationError(f'Need at least 45 distinct perceptual-hash clusters; found {len(components)}. No batch created.')
    groups = defaultdict(deque)
    for component in components:
        # Stable hash ranking avoids filename order deciding the content of the evaluation.
        representative = min(component, key=lambda n: sha((VERSION + rows[n]['rel']).encode()))
        group = str(Path(rows[representative]['rel']).parent)
        groups[group].append((representative, component))
    ordered = []
    while any(groups.values()):
        for group in sorted(groups):
            if groups[group]:
                ordered.append(groups[group].popleft())
    return ordered[:15], ordered[15:45]


def _inventory(root):
    if not root.is_dir() or root.is_symlink():
        raise EvaluationError('Choose a real folder, not a symlink.')
    paths, excluded = [], []
    def fail(error):
        raise EvaluationError(f'Cannot enumerate source folder: {error}')
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=fail):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            if path.is_symlink():
                raise EvaluationError(f'Resolve symlink before selection: {path.relative_to(root)}')
        for name in sorted(files):
            path = Path(directory) / name
            if path.suffix.lower().lstrip('.') in media.ACCEPTED_EXT:
                paths.append(path)
            else:
                excluded.append(str(path.relative_to(root)))
        if len(paths) + len(excluded) > 5000:
            raise EvaluationError('Folder exceeds the 5,000-file scan limit; no batch created.')
    return sorted(paths), sorted(excluded)


def _snapshot(path, root):
    # Open each component relative to a stable directory descriptor: replacing a
    # file or an intermediate directory with a symlink cannot escape the scan root.
    parts = path.relative_to(root).parts
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise EvaluationError('Only regular media files can be scanned.')
        if is_dataless(before):
            raise EvaluationError('File is still dataless after download.')
        if before.st_size > media.VIDEO_CAP:
            raise EvaluationError('File exceeds media size cap.')
        data = source.read(media.VIDEO_CAP + 1)
        after = os.fstat(source.fileno())
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise EvaluationError('Source changed during scan; retry before labeling.')
    sniffed = media.sniff(data)
    media.check_size(sniffed.media, len(data))
    if sniffed.media == 'image':
        images = [media.load_image(data, sniffed.mime)]
        times = []
    else:
        # Probe the copied bytes, so video frame extraction cannot race the source file.
        with tempfile.TemporaryDirectory(prefix='commons-eval-video-') as tmp:
            video = Path(tmp) / ('source.' + sniffed.ext)
            video.write_bytes(data)
            info = media.probe_video(video)
            times = media.keyframe_times(info['duration'], media.scene_cuts(video))
            images = [media.load_image(media.extract_frame(video, t), 'image/png') for t in times]
        if not images:
            raise EvaluationError('Video yielded no keyframes.')
    png = media.encode_png(images[0])
    return {'rel': str(path.relative_to(root)), 'source_sha256': sha(data), 'image_sha256': sha(png),
            'hashes': sorted(set(phash(image) for image in images)), 'media': sniffed.media,
            'frame_times': times, 'width': images[0].width, 'height': images[0].height, '_png': png}


def _check_preimport(conn):
    existing = conn.execute('SELECT sealed, closed FROM evaluation_batch').fetchone()
    if existing and (existing['sealed'] or existing['closed']):
        ended = 'sealed' if existing['sealed'] else 'closed as assisted review'
        raise EvaluationError(f'A held-out batch already exists ({ended}). A new blind batch needs a '
                              'separately chosen unseen set, which is not supported yet.')
    if existing:
        raise EvaluationError('A held-out batch already exists. Continue its labels.')
    if conn.execute('SELECT 1 FROM assets').fetchone() or conn.execute('SELECT 1 FROM analyses').fetchone():
        raise EvaluationError('Select held-out references before any import or analysis.')


async def prepare(store, path, *, downloader=None):
    with store.db.read() as conn:
        _check_preimport(conn)
    root = Path(path).expanduser()
    if not root.is_absolute():
        raise EvaluationError('Use an absolute folder path.')
    paths, excluded = await asyncio.to_thread(_inventory, root)
    downloader = downloader or DatalessDownloader()
    rows, total = [], 0
    for path in paths:
        try:
            if is_dataless(path.stat()) and not await downloader.download(path):
                raise EvaluationError(f'iCloud download failed: {path.relative_to(root)}')
            row = await asyncio.to_thread(_snapshot, path, root)
        except (OSError, media.MediaError) as exc:
            raise EvaluationError(f'Cannot read {path.relative_to(root)}: {exc}') from exc
        total += len(row['_png'])
        if total > 256 * 1024 * 1024:
            raise EvaluationError('Decoded snapshot set exceeds 256 MB; no batch created.')
        rows.append(row)
    return await asyncio.to_thread(_persist, store, root, rows, excluded)


def _persist(store, root, rows, excluded):
    heldout, tuning = select(rows)
    public_rows = [{k:v for k,v in row.items() if k != '_png'} for row in rows]
    def entries(selection):
        return [{**public_rows[n], 'cluster': sha(canonical([public_rows[i] for i in component]).encode()),
                 'members': component} for n, component in selection]
    manifest = dict(version=VERSION, measurement_version=CODE_VERSION, vocabulary_version=load_vocabulary().version,
                    vocabulary_terms=list(load_vocabulary().terms), source_root=str(root), inventory=public_rows, excluded=excluded,
                    heldout=entries(heldout), tuning=entries(tuning), created_at=now_iso())
    snapshots = []
    for n, _ in heldout:
        png = rows[n]['_png']
        palette = measure_image(media.load_image(png, 'image/png'))['palette']
        snapshots.append((png, canonical(palette)))
    with store.db.tx() as conn:
        _check_preimport(conn)
        conn.execute('INSERT INTO evaluation_batch(id,manifest,manifest_hash,revision) VALUES (1,?,?,0)',
                     (canonical(manifest), sha(canonical(manifest).encode())))
        for n, (png, palette) in enumerate(snapshots):
            conn.execute('INSERT INTO evaluation_items(position,image,palette) VALUES (?,?,?)', (n, png, palette))
        for _, component in heldout:
            for n in component:
                for h in rows[n]['hashes']:
                    conn.execute('INSERT OR IGNORE INTO quarantine(phash,source_rel_path,created_at) VALUES (?,?,?)',
                                 (h, rows[n]['rel'], manifest['created_at']))
    return view(store)


def _batch(conn, revision=None, *, mutable=False):
    row = conn.execute('SELECT * FROM evaluation_batch WHERE id=1').fetchone()
    if row is None:
        raise EvaluationError('No held-out batch. Prepare a folder first.')
    if mutable and row['sealed']:
        raise EvaluationError('Labels are sealed and cannot be changed.')
    if mutable and row['closed']:
        raise EvaluationError('This batch was closed as assisted review; blind labels are read-only.')
    if revision is not None and (type(revision) is not int or revision != row['revision']):
        raise EvaluationError('Labels changed in another window. Reload before saving.')
    return row


def _item(conn, position):
    row = conn.execute('SELECT * FROM evaluation_items WHERE position=?', (position,)).fetchone()
    if row is None:
        raise EvaluationError('Reference not found.')
    return row


def state(batch):
    """'open' until the batch is sealed as blind truth or closed as assisted review."""
    return 'sealed' if batch['sealed'] else 'closed' if batch['closed'] else 'open'


def _verify(conn, batch):
    """Recheck the frozen batch before it is sealed or closed. Fails closed.

    Catches accidental corruption (a bad restore, a hand edit, a bug); it is not
    a signature and cannot stop a deliberate edit to the database. Closing
    releases the analysis gate, which is only safe while the quarantine still
    covers every held-out cluster.
    """
    if sha(batch['manifest'].encode()) != batch['manifest_hash']:
        raise EvaluationError('Integrity check failed: the manifest no longer matches its hash. Nothing was changed.')
    manifest = json.loads(batch['manifest'])
    rows = conn.execute('SELECT position, image FROM evaluation_items ORDER BY position').fetchall()
    if len(rows) != len(manifest['heldout']) or any(
            sha(row['image']) != manifest['heldout'][row['position']]['image_sha256'] for row in rows):
        raise EvaluationError('Integrity check failed: a reference image changed. Nothing was changed.')
    quarantined = {r[0] for r in conn.execute('SELECT phash FROM quarantine')}
    needed = {h for entry in manifest['heldout'] for n in entry['members'] for h in manifest['inventory'][n]['hashes']}
    if needed - quarantined:
        raise EvaluationError('Integrity check failed: a held-out cluster is missing from quarantine. Nothing was changed.')
    return manifest, sorted(quarantined)


def _view(conn):
    b = _batch(conn)
    manifest = json.loads(b['manifest'])
    items = []
    for row in conn.execute('SELECT * FROM evaluation_items ORDER BY position'):
        entry = manifest['heldout'][row['position']]
        item = dict(position=row['position'], image_sha256=entry['image_sha256'], width=entry['width'], height=entry['height'],
                    accent_locked=row['accents'] is not None, labels=json.loads(row['labels']) if row['labels'] else None)
        if row['accents'] is not None:
            item.update(json.loads(row['accents']))
            item['palette'] = json.loads(row['palette'])
        items.append(item)
    return dict(revision=b['revision'], items=items, denominator=150, tuning_count=30, state=state(b),
                manifest_hash=b['manifest_hash'], sealed=json.loads(b['sealed']) if b['sealed'] else None,
                seal_hash=b['seal_hash'], closed=json.loads(b['closed']) if b['closed'] else None,
                close_hash=b['close_hash'], fields=FIELDS, axes=list(AXES), roles=ROLES,
                keywords=manifest['vocabulary_terms'], excluded_count=len(manifest['excluded']),
                assisted_reviews=conn.execute('SELECT count(*) FROM assisted_reviews').fetchone()[0])


def view(store):
    with store.db.read() as conn:
        if not conn.execute('SELECT 1 FROM evaluation_batch').fetchone():
            return None
        return _view(conn)


def image_bytes(store, position):
    with store.db.read() as conn:
        return bytes(_item(conn, position)['image'])


def _bump(conn):
    conn.execute('UPDATE evaluation_batch SET revision=revision+1 WHERE id=1')


def lock_accents(store, position, revision, points, no_accents):
    if type(no_accents) is not bool or not isinstance(points, list) or len(points) > 100 or bool(points) == no_accents:
        raise EvaluationError('Mark 1–100 accent points, or explicitly record no accents.')
    with store.db.tx() as conn:
        _batch(conn, revision, mutable=True)
        row = _item(conn, position)
        if row['accents'] is not None:
            raise EvaluationError('Accent observations are already locked.')
        image = media.load_image(row['image'], 'image/png')
        accents = []
        for point in points:
            if not isinstance(point, dict) or set(point) != {'x','y'}:
                raise EvaluationError('Each accent needs x and y coordinates only.')
            x, y = point['x'], point['y']
            if any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in (x,y)):
                raise EvaluationError('Accent coordinates must be between 0 and 1.')
            rgb = image.getpixel((min(image.width-1,int(x*image.width)),min(image.height-1,int(y*image.height))))
            accents.append(dict(x=x,y=y,hex='#' + ''.join(f'{c:02x}' for c in rgb)))
        conn.execute('UPDATE evaluation_items SET accents=? WHERE position=?',
                     (canonical(dict(accents=accents, no_accents=no_accents, locked_at=now_iso())), position))
        _bump(conn)
        return _view(conn)


def validate_labels(labels, palette, *, vocabulary, complete=False):
    if not isinstance(labels, dict) or set(labels) != {'tags','axes','palette_roles','keywords','no_keywords','flagged'}:
        raise EvaluationError('Invalid ground-truth label fields.')
    for field in ('tags','axes','palette_roles'):
        if not isinstance(labels[field], dict):
            raise EvaluationError(f'{field} must be an object.')
    if set(labels['tags']) - set(FIELDS) or any(v not in FIELDS[k] for k,v in labels['tags'].items()):
        raise EvaluationError('Unknown structure label.')
    if set(labels['axes']) - set(AXES) or any(type(v) not in (int,float) or not math.isfinite(v) or not -1 <= v <= 1 for v in labels['axes'].values()):
        raise EvaluationError('Each character value must be a finite number from -1 to 1.')
    indexes = {str(p['index']) for p in palette}
    if set(labels['palette_roles']) - indexes or any(v not in ROLES for v in labels['palette_roles'].values()):
        raise EvaluationError('Invalid palette role or index.')
    words = labels['keywords']
    if not isinstance(words,list) or any(not isinstance(w,str) for w in words) or len(words)>12 or len(set(words))!=len(words) or set(words)-set(vocabulary):
        raise EvaluationError('Choose up to 12 distinct canonical keywords.')
    if type(labels['no_keywords']) is not bool or type(labels['flagged']) is not bool or (words and labels['no_keywords']):
        raise EvaluationError('Invalid explicit-absence or review flag.')
    if complete and (set(labels['tags']) != set(FIELDS) or set(labels['axes']) != set(AXES) or set(labels['palette_roles']) != indexes or not (words or labels['no_keywords']) or labels['flagged']):
        raise EvaluationError('All 15 references need complete labels and cleared review flags before sealing.')


def save_labels(store, position, revision, labels):
    with store.db.tx() as conn:
        batch = _batch(conn, revision, mutable=True)
        row = _item(conn, position)
        if row['accents'] is None:
            raise EvaluationError('Save blind accent observations before labeling the palette.')
        validate_labels(labels, json.loads(row['palette']), vocabulary=json.loads(batch['manifest'])['vocabulary_terms'])
        conn.execute('UPDATE evaluation_items SET labels=? WHERE position=?', (canonical(labels),position))
        _bump(conn)
        return _view(conn)


def seal(store, revision):
    with store.db.tx() as conn:
        batch = _batch(conn, revision)
        if batch['sealed']:
            return _view(conn)
        if batch['closed']:
            raise EvaluationError('This batch was closed as assisted review; it cannot be sealed.')
        if conn.execute('SELECT 1 FROM assisted_reviews').fetchone():
            raise EvaluationError('This batch is now assisted review; it cannot be sealed as independent blind labels.')
        _verify(conn, batch)
        rows = conn.execute('SELECT * FROM evaluation_items ORDER BY position').fetchall()
        if len(rows)!=15:
            raise EvaluationError('The evaluation requires exactly 15 references.')
        labels = []
        for row in rows:
            if row['accents'] is None or row['labels'] is None:
                raise EvaluationError('Finish all 15 references before sealing.')
            value = json.loads(row['labels'])
            palette = json.loads(row['palette'])
            validate_labels(value, palette, vocabulary=json.loads(batch['manifest'])['vocabulary_terms'], complete=True)
            labels.append(dict(position=row['position'],image_sha256=sha(row['image']),palette=palette,
                               **json.loads(row['accents']), **value))
        payload = dict(version=VERSION, manifest_hash=batch['manifest_hash'], denominator=150,
                       actor='human:justin', sealed_at=now_iso(), labels=labels)
        serialized = canonical(payload)
        conn.execute('UPDATE evaluation_batch SET sealed=?,seal_hash=?,revision=revision+1 WHERE id=1',
                     (serialized,sha(serialized.encode())))
        return _view(conn)


def close(store, revision, *, actor, acknowledge):
    """End a batch without sealing it: assisted review (or abandoned), never blind truth.

    Seal refuses once agents have graded the references, and import analysis
    waits while a batch is open, so without this an assisted batch would block
    the worker forever. Closing keeps the quarantine, keeps accept/correct
    working, makes blind drafts read-only and stops new grading attempts.
    """
    if acknowledge is not True:
        raise EvaluationError('Confirm that this batch becomes assisted review, not blind ground truth.')
    with store.db.tx() as conn:
        batch = _batch(conn)
        if batch['closed']:
            return _view(conn)  # a double click or a stale window gets the same record
        if batch['sealed']:
            raise EvaluationError('This batch is sealed as blind ground truth; there is nothing to close.')
        _batch(conn, revision)
        if conn.execute("SELECT 1 FROM assisted_reviews WHERE status='running'").fetchone():
            raise EvaluationError('A grading attempt is still running. Close after it finishes.')
        _, phashes = _verify(conn, batch)
        items = conn.execute('SELECT position, accents, labels FROM evaluation_items ORDER BY position').fetchall()
        reviews = conn.execute('SELECT * FROM assisted_reviews ORDER BY position').fetchall()
        # Only the parts that can no longer change are hashed. Reviewed labels are
        # left out: Justin keeps accepting and correcting grades after the close,
        # and each of those carries its own reviewed_at.
        payload = dict(
            version=VERSION, kind='assisted_review' if reviews else 'abandoned', independent_ground_truth=False,
            manifest_hash=batch['manifest_hash'], blind_revision=batch['revision'],
            blind_drafts=dict(accents_locked=[i['position'] for i in items if i['accents'] is not None],
                              labels_saved=[i['position'] for i in items if i['labels'] is not None]),
            reviews=[dict(position=r['position'], status=r['status'],
                          proposal_sha256=sha(r['proposal'].encode()) if r['proposal'] else None,
                          reviewed_before_close=r['reviewed_at'] is not None) for r in reviews],
            quarantine_count=len(phashes), quarantine_sha256=sha(canonical(phashes).encode()),
            actor=actor, closed_at=now_iso())
        serialized = canonical(payload)
        conn.execute('UPDATE evaluation_batch SET closed=?, close_hash=?, revision=revision+1 '
                     'WHERE id=1 AND sealed IS NULL AND closed IS NULL', (serialized, sha(serialized.encode())))
        return _view(conn)
