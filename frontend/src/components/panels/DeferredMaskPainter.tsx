import { Suspense, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { DeferredMaskPainterModal } from '../../lib/deferredChunks';
import { CONNECTION_LOST_SHORT_COPY } from '../../lib/errorCopy';
import { DeferredBoundary } from '../DeferredBoundary';
import { ModalPortal } from '../ModalPortal';
import { useMaskPainterDialog } from './maskPainterDialog';

/*
 * The mask painter's wrapper and the shell it draws while its chunk loads, in
 * its own module so the startup entry doesn't carry them (PR #203, entry
 * budget). Only the Inspector, itself a deferred chunk, renders it; it is
 * listed in lib/deferredChunks.ts DEFERRED_MODULES.
 */

/**
 * The mask painter opens only from the Inspector's Paint Mask button, which
 * preloads it on hover and focus (and App preloads it on idle). If the click
 * still beats the chunk, the fallback is the painter's own overlay and header
 * (with its Close) in the state it shows while it reads the image size, so the
 * dialog appears at once and fills in. If the chunk cannot load, the same
 * shell says so, with Try again next to Close (DeferredBoundary). The next
 * Paint Mask mounts it afresh, which fetches again too. Both are on
 * document.body (ModalPortal, review 9 M-2): rendered inside the Inspector
 * popover, whose backdrop-filter under Slava restraint makes it the
 * containing block of a position:fixed overlay, the painter was the
 * popover's 260x300 box, with the canvas usable beside it.
 */
function MaskPainterShell({ children, onClose, busy = false }: { children: ReactNode; onClose: () => void; busy?: boolean }) {
  const dialog = useMaskPainterDialog(onClose);
  return (
    <div {...dialog} className="mask-painter__overlay" role="dialog" aria-modal="true" aria-label="Mask painter" aria-busy={busy || undefined}>
      <div className="mask-painter__panel">
        <div className="mask-painter__header">
          <span className="mask-painter__title">Paint Mask</span>
          <button type="button" className="mask-painter__icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function MaskPainterModal(props: ComponentProps<typeof DeferredMaskPainterModal>) {
  return (
    <ModalPortal>
    <DeferredBoundary
      chunk={DeferredMaskPainterModal}
      failed={({ retry, retrying }) => (
        <MaskPainterShell onClose={props.onClose} busy={retrying}>
          {/* GM's WRAP rule (round 3b): Try again is beside it and loads it again.
              Round 3f: the server is on this computer, not "your connection". */}
          <div className="mask-painter__empty" role="alert">Couldn't load the mask painter. {CONNECTION_LOST_SHORT_COPY}</div>
          <div className="mask-painter__toolbar">
            <div className="mask-painter__spacer" />
            <button type="button" className="mask-painter__cancel" onClick={props.onClose}>Close</button>
            {/* aria-disabled, not disabled: a disabled button drops keyboard focus to the page. */}
            <button type="button" className="mask-painter__save" onClick={retry} aria-disabled={retrying || undefined}>
              {retrying ? 'Trying again…' : 'Try again'}
            </button>
          </div>
        </MaskPainterShell>
      )}
    >
      <Suspense
        fallback={(
          <MaskPainterShell onClose={props.onClose} busy>
            <div className="mask-painter__empty" role="status">Loading the mask painter…</div>
          </MaskPainterShell>
        )}
      >
        <DeferredMaskPainterModal {...props} />
      </Suspense>
    </DeferredBoundary>
    </ModalPortal>
  );
}
