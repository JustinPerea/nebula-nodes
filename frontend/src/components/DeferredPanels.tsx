import { Suspense, useState, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import {
  DeferredAgentLog,
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
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

/**
 * The Agent log (bottom right on the canvas). Unlike the panels below it shows
 * at once, with nothing opened first, so it mounts straight away and simply
 * appears when its chunk lands; the empty fallback is what a hidden log draws.
 */
export function AgentLog() {
  return (
    <DeferredBoundary failed={null}>
      <Suspense fallback={null}>
        <DeferredAgentLog />
      </Suspense>
    </DeferredBoundary>
  );
}

export function RunHistoryPanel() {
  const opened = useOpenedOnce(useUIStore((s) => s.panels.history.visible));
  if (!opened) return null;
  return (
    <DeferredBoundary failed={null}>
      <Suspense fallback={null}>
        <DeferredRunHistoryPanel />
      </Suspense>
    </DeferredBoundary>
  );
}

export function OnboardingOverlay() {
  const opened = useOpenedOnce(useUIStore((s) => s.onboardingActive));
  if (!opened) return null;
  return (
    <DeferredBoundary failed={null}>
      <Suspense fallback={null}>
        <DeferredOnboardingOverlay />
      </Suspense>
    </DeferredBoundary>
  );
}

/** Mounted inside Canvas (it needs the React Flow context), like the original. */
export function ConnectionPopup() {
  const opened = useOpenedOnce(useUIStore((s) => s.connectionPopup.visible));
  if (!opened) return null;
  return (
    <DeferredBoundary failed={null}>
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
 * dialog appears at once and fills in. If the chunk cannot load at all, the
 * same shell says so and Close still works (DeferredBoundary).
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
      failed={(
        <MaskPainterShell onClose={props.onClose}>
          <div className="mask-painter__empty" role="alert">Could not load the mask painter. Reload Nebula to try again.</div>
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

