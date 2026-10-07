import { useRef } from 'react';
import { X } from 'lucide-react';
import type { CreateDraftUpload } from '../../store/createDraftStore';

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
  return (
    <div className="reference-tray__chip reference-tray__upload" aria-busy={uploading}>
      <div>
        <span className="reference-tray__name">{upload.name}</span>
        <span className="reference-tray__status" role={uploading ? 'status' : 'alert'}>
          {uploading ? 'Uploading…' : upload.error ?? 'Could not upload this image. Please try again.'}
        </span>
      </div>
      {!uploading && <button type="button" className="reference-tray__retry"
        onClick={() => canRetry ? onRetry() : input.current?.click()}
        aria-label={`${canRetry ? 'Retry' : 'Attach again'} ${upload.name}`}>
        {canRetry ? 'Retry' : 'Attach again'}
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
