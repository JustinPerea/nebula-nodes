import { useEffect, useMemo, useState } from 'react';

/** How long a held notice button waits before it greys, so a try that
 * answers fast never flickers (design). */
export const HELD_LOOK_DELAY_MS = 150;

/** Set once the hold has lasted HELD_LOOK_DELAY_MS: the grey shows. */
export const HELD_LOOK_ATTR = 'data-held-look';

/** Set for the hold's first HELD_LOOK_DELAY_MS: the shared disabled rule
 * (styles/disabled-buttons.css) passes over a button that has it, so it
 * keeps its own look meanwhile (one rule, no notice overrides). */
export const HELD_PENDING_ATTR = 'data-held-pending';

export interface HeldLookProps {
  'aria-disabled'?: true;
  'data-held-look'?: '';
  'data-held-pending'?: '';
}

/**
 * A notice button held while its action is on its way (a [Try again], a
 * clash answer being sent) is aria-disabled at once, with its label
 * unchanged and no reason tooltip (a moment, not a lock; design). The grey
 * (the shared disabled style, keyed on aria-disabled) comes only after
 * HELD_LOOK_DELAY_MS (data-held-pending until then), and goes the moment it
 * is released.
 */
export function useHeldLook(held: boolean): HeldLookProps {
  // One token per hold, so a grey from an earlier hold never carries over.
  const hold = useMemo(() => (held ? {} : null), [held]);
  const [greyHold, setGreyHold] = useState<object | null>(null);
  useEffect(() => {
    if (!hold) return undefined;
    const timer = window.setTimeout(() => setGreyHold(hold), HELD_LOOK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hold]);
  if (!hold) return {};
  return greyHold === hold ? { 'aria-disabled': true, [HELD_LOOK_ATTR]: '' } : { 'aria-disabled': true, [HELD_PENDING_ATTR]: '' };
}
