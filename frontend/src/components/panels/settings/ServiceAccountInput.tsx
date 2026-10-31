import { useId, useRef, useState, type DragEvent } from 'react';
import { readServiceAccount } from './rowHelpers';


const MAX_KEY_FILE_BYTES = 64 * 1024;

/**
 * Vertex takes the JSON key Google Cloud downloads. Choose or drop the file;
 * pasting the JSON stays available for keys copied from a terminal.
 */
export function ServiceAccountInput({ label, value, fileName, onChange, onSubmit }: {
  label: string;
  value: string;
  fileName: string | null;
  onChange: (text: string, fileName: string | null) => void;
  onSubmit: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [pasting, setPasting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const check = value.trim() ? readServiceAccount(value) : null;

  async function readFile(file: File | undefined) {
    if (!file) return;
    setFileError(null);
    if (file.size > MAX_KEY_FILE_BYTES) { setFileError('That file is too large to be a key file.'); return; }
    try { onChange(await file.text(), file.name); }
    catch { setFileError("That file couldn't be read."); }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void readFile(event.dataTransfer.files[0]);
  }

  return (
    <div className="settings-sa">
      <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-hidden="true" tabIndex={-1}
        onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
      {pasting ? (
        <textarea
          className="settings-sa__paste"
          // The row's one name (GM, PR #203 r29 item 4); "JSON" stays in the
          // placeholder and the hint, never in the name.
          aria-label={label}
          aria-describedby={hintId}
          data-provider-key="GOOGLE_VERTEX_CREDENTIALS"
          value={value}
          rows={4}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder='{"type": "service_account", ...}'
          onChange={(event) => onChange(event.target.value, null)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSubmit(); } }}
        />
      ) : (
        <div
          className={`settings-sa__drop${dragging ? ' settings-sa__drop--over' : ''}${check?.ok ? ' settings-sa__drop--ready' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {check?.ok ? (
            <>
              <span className="settings-sa__file">✓ {fileName ?? 'Service account key'}</span>
              <span className="settings-sa__account">{check.email}</span>
              <span className="settings-hint">Project {check.project} · needs the Vertex AI User role</span>
            </>
          ) : (
            <span className="settings-hint">Drop the JSON key file here, or choose it.</span>
          )}
        </div>
      )}
      {check && !check.ok && <p className="settings-row__error" role="alert">{check.error}</p>}
      {fileError && <p className="settings-row__error" role="alert">{fileError}</p>}
      <div className="settings-sa__choices" id={hintId}>
        <button type="button" className="settings__button settings__button--ghost" data-provider-key={pasting ? undefined : 'GOOGLE_VERTEX_CREDENTIALS'}
          onClick={() => { setPasting(false); fileInput.current?.click(); }}>
          {check?.ok && !pasting ? 'Choose another file…' : 'Choose key file…'}
        </button>
        <button type="button" className="settings__button settings__button--ghost"
          onClick={() => { setPasting((on) => !on); onChange('', null); }}>
          {pasting ? 'Use a file instead' : 'Paste JSON instead'}
        </button>
      </div>
    </div>
  );
}
