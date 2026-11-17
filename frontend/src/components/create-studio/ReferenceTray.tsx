import { useRef } from 'react';
import { X } from 'lucide-react';
import type { CreateDraftUpload } from '../../store/createDraftStore';
import { besideButton } from '../../lib/errorCopy';
import { LineText } from '../LineText';

export interface AttachedRef {
  filePath: string;
  previewUrl: string;
}

interface ReferenceTrayProps {
  refs: AttachedRef[];
  onRemove: (filePath: string) => void;
  uploads?: CreateDraftUpload[];
  canRetry?: (id: string) => boolean;
  onRetry?: (id: string, replacement?: File) => void;
  onRemoveUpload?: (id: string) => void;
}

function UploadChip({ upload, canRetry, onRetry, onRemove }: {
  upload: CreateDraftUpload;
  canRetry: boolean;
  onRetry: (file?: File) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const uploading = upload.status === 'uploading';
  const line = upload.error ?? 'Nebula couldn’t upload this image.';
  return (
    <div className="reference-tray__chip reference-tray__upload" aria-busy={uploading}>
      <div>
        <span className="reference-tray__name">{upload.name}</span>
        <span className="reference-tray__status" role={uploading ? 'status' : 'alert'}>
          {/* Beside a “Try again” button the line ends “Try again.” The draft keeps only the line (it is saved with the
              page), so the button's ending is swapped in here (besideButton). Beside “Attach again” it stays as written:
              its ending must not name a button that isn't there. */}
          {uploading ? 'Uploading…' : <LineText text={canRetry ? besideButton(line) : line} />}
        </span>
      </div>
      {!uploading && <button type="button" className="reference-tray__retry"
        onClick={() => canRetry ? onRetry() : input.current?.click()}
        aria-label={canRetry ? `Try again to upload “${upload.name}”` : `Attach again ${upload.name}`}>
        {canRetry ? 'Try again' : 'Attach again'}
      </button>}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onRetry(file);
          event.target.value = '';
        }} />
      <button type="button" className="reference-tray__remove" onClick={onRemove} aria-label={`Remove ${upload.name}`}>
        <X size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ReferenceTray({ refs, onRemove, uploads = [], canRetry, onRetry, onRemoveUpload }: ReferenceTrayProps) {
  if (refs.length === 0 && uploads.length === 0) return null;
  return (
    <div className="reference-tray" aria-label="Reference images">
      {refs.map((r, index) => (
        <div key={r.filePath} className="reference-tray__chip">
          <img src={r.previewUrl} alt={`Reference ${index + 1}`} className="reference-tray__thumb" />
          <button type="button" className="reference-tray__remove" onClick={() => onRemove(r.filePath)} aria-label={`Remove reference ${index + 1}`}>
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ))}
      {uploads.map((upload) => <UploadChip key={upload.id} upload={upload}
        canRetry={canRetry?.(upload.id) ?? false}
        onRetry={(file) => onRetry?.(upload.id, file)} onRemove={() => onRemoveUpload?.(upload.id)} />)}
    </div>
  );
}
