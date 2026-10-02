import { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ExternalLink, Link2, RefreshCw } from 'lucide-react';
import type { NodeData } from '../../types';
import { useGraphStore } from '../../store/graphStore';
import { backendAssetUrlSync } from '../../lib/backend';
import {
  getPaperSelection,
  inspectPaperObject,
  linkPaperSource,
  reconnectPaperSource,
  refreshPaperSource,
  openPaperSource,
  PaperSourceError,
  type PaperSelection,
  type PaperSourceRecord,
} from '../../lib/paperSource';
import '../../styles/paper-source-node.css';

function refreshLabel(value?: string): string {
  if (!value) return 'Never refreshed';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Explicit source lifecycle only: no timer, watcher or generation action. */
export function PaperSourceNode({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as NodeData;
  const source = nodeData.params._paperSource as PaperSourceRecord | undefined;
  const applyPaperSource = useGraphStore((state) => state.applyPaperSource);
  const [busy, setBusy] = useState<'selection' | 'export' | null>(null);
  const [selection, setSelection] = useState<PaperSelection | null>(null);
  const [objectId, setObjectId] = useState('');
  const [scale, setScale] = useState<'1x' | '2x'>('2x');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);
  const [manualIds, setManualIds] = useState({ fileId: '', pageId: '', objectId: '' });
  const snapshot = source?.snapshot;

  function reportError(value: unknown) {
    const message = value instanceof Error ? value.message : 'Paper source is unavailable.';
    setError(message);
    if (value instanceof PaperSourceError && value.source) {
      applyPaperSource(id, value.source);
    } else if (source) {
      // Network failure has no newer server record. Keep immutable bytes and
      // source identity while making its last-good status visible.
      applyPaperSource(id, { ...source, state: 'unavailable', lastError: message });
    }
  }

  async function readSelection() {
    setBusy('selection');
    setError('');
    setNotice('');
    setManual(false);
    try {
      const current = await getPaperSelection();
      setSelection(current);
      setObjectId(current.selection.length === 1 ? current.selection[0].id : '');
      setScale(source?.exportSettings.scale ?? '2x');
    } catch (value) {
      reportError(value);
    } finally {
      setBusy(null);
    }
  }

  function chooseManual() {
    setManual(true);
    setSelection(null);
    setError('');
    setManualIds({ fileId: source?.identity.fileId ?? '', pageId: source?.identity.pageId ?? '', objectId: source?.identity.objectId ?? '' });
  }

  async function inspectManual() {
    setBusy('selection');
    setError('');
    try {
      const result = await inspectPaperObject(manualIds);
      setSelection(result);
      setObjectId(result.selection[0].id);
      setScale(source?.exportSettings.scale ?? '2x');
    } catch (value) {
      setError(value instanceof Error ? value.message : 'Could not resolve this exact Paper object.');
    } finally {
      setBusy(null);
    }
  }

  async function open() {
    if (!source) return;
    setError('');
    try {
      const result = await openPaperSource(source.id);
      if (!result.opened) throw new Error('Paper did not confirm opening the source file.');
      setNotice(`Paper accepted the file link. If needed, choose the “${source.identity.fileName}” tab, then “${source.identity.pageName}” and “${source.identity.objectName}” manually.`);
    } catch (value) {
      setError(value instanceof Error ? value.message : 'Could not open the Paper file.');
    }
  }

  async function confirmLink() {
    if (!selection || !objectId) return;
    setBusy('export');
    setError('');
    const request = { fileId: selection.file.id, pageId: selection.pageId, objectId, scale };
    try {
      const result = source
        ? await reconnectPaperSource(source.id, request)
        : await linkPaperSource(request);
      applyPaperSource(id, result);
      setSelection(null);
      setManual(false);
      setNotice(source ? 'Object reconnected. Rerun the saved recipe explicitly.' : 'Artwork linked. Connect the image output to a recipe.');
    } catch (value) {
      reportError(value);
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    if (!source) return;
    setBusy('export');
    setError('');
    setNotice('');
    try {
      const result = await refreshPaperSource(source.id);
      applyPaperSource(id, result);
      setNotice(result.changed
        ? 'Source updated. Previous results are out of date. Rerun the saved recipe explicitly.'
        : 'Artwork unchanged. No new snapshot.');
    } catch (value) {
      reportError(value);
    } finally {
      setBusy(null);
    }
  }

  const candidate = selection?.selection.find((object) => object.id === objectId);
  const stateLabel = busy === 'export' ? 'Exporting artwork…'
    : source?.state === 'missing' ? 'Object missing'
    : source?.state === 'unavailable' ? 'Paper unavailable'
    : source ? 'Connected' : 'Not linked';
  const lastGood = Boolean(snapshot && source?.state !== 'current');
  const displayedError = error || source?.lastError;

  return (
    <div className={`paper-source-node ${selected ? 'paper-source-node--selected' : ''}`}>
      <div className="paper-source-node__header"><Link2 size={15} aria-hidden="true" /> Paper source</div>
      <div className="paper-source-node__status" role="status">{stateLabel}</div>
      {snapshot ? (
        <figure className="paper-source-node__preview">
          <img className="nodrag" src={backendAssetUrlSync(snapshot.previewUrl)} alt={`${snapshot.identity.objectName} exported from Paper`} draggable={false} />
          <figcaption>{lastGood ? 'Last good snapshot · ' : ''}{snapshot.width} × {snapshot.height} PNG · {snapshot.hasTransparency ? 'Transparent pixels' : 'Opaque artwork'}</figcaption>
        </figure>
      ) : (
        <div className="paper-source-node__empty">Select one editable logo in Paper, then link its actual export.</div>
      )}
      {source && (
        <div className="paper-source-node__identity">
          <strong>{source.identity.objectName}</strong>
          <span>{source.identity.fileName} · {source.identity.pageName}</span>
          <code title={source.identity.objectId}>Object {source.identity.objectId}</code>
          <span title={source.lastSuccessfulRefresh}>Last successful refresh: {refreshLabel(source.lastSuccessfulRefresh)}</span>
        </div>
      )}
      <div className="paper-source-node__actions nodrag nopan">
        {source && <>
          <button type="button" disabled={Boolean(busy)} onClick={() => void open()}>
            <ExternalLink size={12} aria-hidden="true" /> Open in Paper
          </button>
          <button type="button" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={12} aria-hidden="true" /> Refresh source</button>
        </>}
        <button type="button" disabled={Boolean(busy)} onClick={() => void readSelection()}>{source ? 'Reconnect object' : 'Link selected object'}</button>
        <button type="button" disabled={Boolean(busy)} onClick={chooseManual}>{source ? 'Reconnect by ID' : 'Link object by ID'}</button>
      </div>
      {source && <p className="paper-source-node__note">If the file is already open, choose the “{source.identity.fileName}” tab in Paper. Navigate to “{source.identity.pageName}” and select “{source.identity.objectName}” manually.</p>}
      {manual && <div className="paper-source-node__link-form nodrag nopan" role="group" aria-label="Choose exact Paper identity">
        {(['fileId', 'pageId', 'objectId'] as const).map((field) => <label key={field}>{field === 'fileId' ? 'File ID' : field === 'pageId' ? 'Page ID' : 'Object ID'}
          <input aria-label={`Paper ${field}`} value={manualIds[field]} disabled={Boolean(busy)} onChange={(event) => {
            setManualIds({ ...manualIds, [field]: event.target.value });
            setSelection(null);
          }} />
        </label>)}
        <button type="button" disabled={Boolean(busy) || Object.values(manualIds).some((value) => !value.trim())} onClick={() => void inspectManual()}>Inspect exact object</button>
        {!selection && <button type="button" disabled={Boolean(busy)} onClick={() => setManual(false)}>Cancel</button>}
      </div>}
      {selection && (
        <div className="paper-source-node__link-form nodrag nopan" role="group" aria-label="Confirm Paper object">
          <strong>{source ? 'Reconnect to a chosen object' : 'Confirm chosen object'}</strong>
          <span>{selection.file.name} · {selection.pageName}</span>
          {selection.selection.length > 0 ? <>
            <label>Object
              <select aria-label="Paper object" value={objectId} onChange={(event) => setObjectId(event.target.value)} disabled={Boolean(busy)}>
                <option value="">Choose one object</option>
                {selection.selection.map((object) => <option key={object.id} value={object.id}>{object.name} ({object.id})</option>)}
              </select>
            </label>
            {candidate && <span>Object bounds: {candidate.width} × {candidate.height} · {candidate.id}</span>}
            <label>Export resolution
              <select aria-label="Export resolution" value={scale} onChange={(event) => setScale(event.target.value as '1x' | '2x')} disabled={Boolean(busy)}>
                <option value="1x">1×</option><option value="2x">2×</option>
              </select>
            </label>
            <span>PNG · chosen object bounds · Paper artwork transparency</span>
            <button type="button" disabled={!candidate || Boolean(busy)} onClick={() => void confirmLink()}>{source ? 'Export and reconnect' : 'Export and link'}</button>
          </> : <p>No object selected. Select the logo in Paper and read the selection again.</p>}
          <button type="button" disabled={Boolean(busy)} onClick={() => { setSelection(null); setManual(false); }}>Cancel</button>
        </div>
      )}
      {displayedError && <p className="paper-source-node__error" role="alert">{displayedError}{snapshot && ' Last good artwork retained.'}</p>}
      {notice && <p className="paper-source-node__note" role="status">{notice}</p>}
      <p className="paper-source-node__note">Refresh exports artwork only. Run the saved recipe separately.</p>
      {source && source.snapshots.length > 0 && (
        <details className="paper-source-node__history nodrag nopan">
          <summary>Source snapshots ({source.snapshots.length})</summary>
          {source.snapshots.map((entry) => <a key={entry.id} href={backendAssetUrlSync(entry.previewUrl)} target="_blank" rel="noopener noreferrer" title={entry.hash}>
            {entry.hash.slice(0, 12)} · {refreshLabel(entry.capturedAt)}
          </a>)}
        </details>
      )}
      <div className="paper-source-node__output">Image
        <Handle type="source" position={Position.Right} id="image" className="paper-source-node__handle" />
      </div>
    </div>
  );
}
