import { X } from 'lucide-react';

export interface AttachedRef {
  filePath: string;
  previewUrl: string;
}

export function ReferenceTray({ refs, onRemove }: { refs: AttachedRef[]; onRemove: (filePath: string) => void }) {
  if (refs.length === 0) return null;
  return (
    <div className="reference-tray">
      {refs.map((r) => (
        <div key={r.filePath} className="reference-tray__chip">
          <img src={r.previewUrl} alt="reference" className="reference-tray__thumb" />
          <button type="button" className="reference-tray__remove" onClick={() => onRemove(r.filePath)} aria-label="Remove reference">
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
