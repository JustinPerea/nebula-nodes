import { Suspense, useState, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import {
  DeferredConnectionPopup,
  DeferredMaskPainterModal,
  DeferredOnboardingOverlay,
  DeferredRunHistoryPanel,
} from '../lib/deferredChunks';
import { DeferredBoundary } from './DeferredBoundary';

/**
 * Run History, the onboarding tour and the canvas connection popup ("add a
 * next step" after dropping a wire), loaded on first open.
 *
 * None of them draws anything while closed, so each stays unmounted until it is
 * first opened and then stays mounted (its own exit animation, focus return
 * and Escape handling run exactly as before). App.tsx preloads the chunks on
 * idle, so a first open from the rail, the command palette, the help button
 * or a wire drop renders synchronously. If an open beats the preload the fallback is empty,
 * the same nothing the closed panel draws, and the panel's own entrance plays
 * once when it arrives.
 */
/**
 * Whether the piece has ever been opened, and a count of opens: each new open
 * is an intent to load it, so a chunk that failed retries on the next one
 * (DeferredBoundary's `retryKey`). A failed open also closes the piece again
 * (`onChunkError`), so the rail, the Help button or the next wire drop is an
 * open, not a toggle off of something that draws nothing.
 */
function useOpens(open: boolean): { opened: boolean; opens: number } {
  const [seen, setSeen] = useState({ open, opens: open ? 1 : 0 });
  if (open !== seen.open) setSeen({ open, opens: seen.opens + (open ? 1 : 0) });
  const opens = seen.opens + (open && !seen.open ? 1 : 0);
  return { opened: opens > 0, opens };
}

const closeRunHistory = () => {
  const ui = useUIStore.getState();
  if (ui.panels.history.visible) ui.togglePanel('history');
};
const closeTour = () => useUIStore.setState({ onboardingActive: false, onboardingStep: 0 });
const closeConnectionPopup = () => useUIStore.getState().hideConnectionPopup();

export function RunHistoryPanel() {
  const { opened, opens } = useOpens(useUIStore((s) => s.panels.history.visible));
  if (!opened) return null;
  return (
    <DeferredBoundary chunk={DeferredRunHistoryPanel} retryKey={opens} onChunkError={closeRunHistory} failed={null}>
      <Suspense fallback={null}>
        <DeferredRunHistoryPanel />
      </Suspense>
    </DeferredBoundary>
  );
}

export function OnboardingOverlay() {
  const { opened, opens } = useOpens(useUIStore((s) => s.onboardingActive));
  if (!opened) return null;
  return (
    <DeferredBoundary chunk={DeferredOnboardingOverlay} retryKey={opens} onChunkError={closeTour} failed={null}>
      <Suspense fallback={null}>
        <DeferredOnboardingOverlay />
      </Suspense>
    </DeferredBoundary>
  );
}

/** Mounted inside Canvas (it needs the React Flow context), like the original. */
export function ConnectionPopup() {
  const { opened, opens } = useOpens(useUIStore((s) => s.connectionPopup.visible));
  if (!opened) return null;
  return (
    <DeferredBoundary chunk={DeferredConnectionPopup} retryKey={opens} onChunkError={closeConnectionPopup} failed={null}>
      <Suspense fallback={null}>
        <DeferredConnectionPopup />
      </Suspense>
    </DeferredBoundary>
  );
}

/**
 * The mask painter opens only from the Inspector's Paint Mask button, which
 * preloads it on hover and focus (and App preloads it on idle). If the click
 * still beats the chunk, the fallback is the painter's own overlay and header
 * (with its Close) in the state it shows while it reads the image size, so the
 * dialog appears at once and fills in. If the chunk cannot load, the same
 * shell says so, with Try again next to Close (DeferredBoundary). The next
 * Paint Mask mounts it afresh, which fetches again too.
 */
function MaskPainterShell({ children, onClose, busy = false }: { children: ReactNode; onClose: () => void; busy?: boolean }) {
  return (
    <div className="mask-painter__overlay" role="dialog" aria-label="Mask painter" aria-busy={busy || undefined}>
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
    <DeferredBoundary
      chunk={DeferredMaskPainterModal}
      failed={({ retry, retrying }) => (
        <MaskPainterShell onClose={props.onClose} busy={retrying}>
          <div className="mask-painter__empty" role="alert">Could not load the mask painter. Check your connection and try again.</div>
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
  );
}

