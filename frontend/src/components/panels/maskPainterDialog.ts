import { useRef, type FocusEvent } from 'react';
import { usePanelFocus } from '../../hooks/usePanelFocus';
import { returnFocusOnSlip } from '../../lib/modalFocus';

const CLOSE = '.mask-painter__icon-btn';

/**
 * The mask painter covers the whole window, so it is a modal dialog
 * (review 8, L-d): aria-modal, which keeps every canvas key from acting
 * behind it (lib/canvasShortcutScope.ts), focus on Close when it opens, Tab
 * kept inside, Escape closes it, a slip to the page comes back to Close, and
 * focus goes back to Paint Mask when it closes. Shared by the painter and the
 * shell shown while its chunk loads (DeferredPanels.tsx). Spread the result
 * on its overlay.
 */
export function useMaskPainterDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  usePanelFocus(true, ref, onClose, { initialFocus: CLOSE, trap: true });
  const onBlur = (event: FocusEvent<HTMLDivElement>) =>
    returnFocusOnSlip(event, () => ref.current?.querySelector<HTMLElement>(CLOSE) ?? null);
  return { ref, onBlur };
}
