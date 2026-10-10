import { useMemo } from 'react';
import { PromptDialog, type PromptRequest } from '../PromptDialog';
import { MAX_PIN_TEXT } from '../../lib/canvasPins';
import { useCanvasPinsStore } from '../../store/canvasPinsStore';
import '../../styles/canvasPins.css';

/** The "Note for agents" dialog, opened from the context menu or the selection toolbar. */
export function PinComposer() {
  const composer = useCanvasPinsStore((s) => s.composer);
  const submit = useCanvasPinsStore((s) => s.submit);
  const cancel = useCanvasPinsStore((s) => s.cancelCompose);
  const error = useCanvasPinsStore((s) => s.error);
  const clearError = useCanvasPinsStore((s) => s.clearError);

  const request = useMemo<PromptRequest | null>(
    () => (composer ? { label: 'Note for agents', initial: '', resolve: () => {} } : null),
    [composer],
  );

  return (
    <>
      {request && (
        <PromptDialog
          request={request}
          maxLength={MAX_PIN_TEXT}
          onDone={(value) => {
            if (value === null || !value.trim()) cancel();
            else void submit(value);
          }}
        />
      )}
      {error && !composer && (
        <div className="canvas-pin-toast" role="alert">
          <span>{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss">×</button>
        </div>
      )}
    </>
  );
}
