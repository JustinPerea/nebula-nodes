/**
 * Palette focus and scroll for the Inspector's Extract from reference
 * (#208 round 8e, GM r22 Q3/Q4/Q6).
 *
 * While "Extracting colors…" shows, a focused swatch keeps focus (its
 * controls are aria-disabled, not disabled). When the palette lands, focus
 * stays at the same swatch, clamped to the last one; with none left, or
 * from Try again or the line, it goes to Extract. Module state, since the
 * result may land in an Inspector opened again since (one source of truth
 * per node, usePaletteExtracts).
 */
type PaletteFocusPlan = { key: string; part: string | null; index: number; count: number; control?: string };
let paletteFocusPlan: PaletteFocusPlan | null = null;
/** The palette control a person last focused in (its key and part). */
let lastPaletteFocus: { key: string; part: string } | null = null;
/** GM r23: the row control (Add or Extract) focus left for the line, so it
 *  goes back to that control when the palette lands. */
let lineFrom: { key: string; part: string } | null = null;

function paletteStackOf(key: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-palette-key]'))
    .find((stack) => stack.dataset.paletteKey === key) ?? null;
}

/** Read where focus is before a palette lands: `count` is the new swatch
 *  count (null: the swatches don't change); `cantRun`, the can't-run line
 *  stays (Try again keeps focus). */
export function planPaletteFocus(key: string, count: number | null, cantRun = false): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const stack = active?.closest<HTMLElement>('[data-palette-key]');
  if (!active || !stack || stack.dataset.paletteKey !== key) return;
  const swatch = active.dataset.swatchPart;
  const part = active.dataset.palettePart;
  if (swatch) {
    const index = Number(active.dataset.swatchIndex);
    if (count === null || index < count) return; // the same element stays
    paletteFocusPlan = count > 0
      ? { key, part: swatch, index: count - 1, count }
      : { key, part: null, index: 0, count: 0 };
  } else if (part === 'pending') {
    const control = lineFrom?.key === key ? lineFrom.part : undefined;
    paletteFocusPlan = { key, part: null, index: 0, count: count ?? -1, control };
  } else if (part === 'try' && !cantRun) {
    paletteFocusPlan = { key, part: null, index: 0, count: count ?? -1 };
  }
}

/** After a render: carry out the plan once the DOM has the new swatches
 *  (or Extract), and move focus from a row the line replaced to the line. */
export function applyPaletteFocus(): void {
  const plan = paletteFocusPlan;
  if (plan) {
    const stack = paletteStackOf(plan.key);
    const active = document.activeElement;
    // Closed, or the person moved on: the plan goes.
    if (!stack || (active && active !== document.body && !stack.contains(active))) {
      paletteFocusPlan = null;
    } else {
      const rows = stack.querySelectorAll('.inspector__palette-row').length;
      const target = plan.part
        ? (rows === plan.count
          ? stack.querySelector<HTMLElement>(`[data-swatch-part="${plan.part}"][data-swatch-index="${plan.index}"]`)
          : null)
        : (plan.control ? stack.querySelector<HTMLElement>(`[data-palette-part="${plan.control}"]`) : null)
          ?? stack.querySelector<HTMLElement>('[data-palette-part="extract"], [data-palette-part="try"]');
      if (target) {
        target.focus();
        paletteFocusPlan = null;
      }
    }
  }
  const last = lastPaletteFocus;
  if (last && (last.part === 'add' || last.part === 'extract') && document.activeElement === document.body) {
    const line = paletteStackOf(last.key)?.querySelector<HTMLElement>('[data-palette-part="pending"]');
    if (line) {
      lineFrom = { key: last.key, part: last.part };
      line.focus();
    }
  }
}

export function notePaletteFocus(key: string, target: EventTarget | null): void {
  if (!(target instanceof HTMLElement)) return;
  lastPaletteFocus = { key, part: target.dataset.palettePart ?? target.dataset.swatchPart ?? 'other' };
}

/** GM r22 Q6: the can't-run slot, scrolled into the Inspector by the least
 *  that shows all of it (smooth; a jump under reduced motion). */
let paletteScrollKey: string | null = null;

export function setPaletteScrollKey(key: string): void {
  paletteScrollKey = key;
}

function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return null;
}

export function scrollPaletteSlot(): void {
  const key = paletteScrollKey;
  if (!key) return;
  const stack = paletteStackOf(key);
  const line = stack?.querySelector<HTMLElement>('.inspector__palette-cant-run');
  const row = stack?.querySelector<HTMLElement>('.inspector__palette-actions');
  if (!line || !row) return;
  paletteScrollKey = null;
  const scroller = scrollParentOf(line);
  if (!scroller) return;
  // One scroll, by the least that shows the line and its row (two
  // scrollIntoView calls would cancel each other's smooth scroll).
  const view = scroller.getBoundingClientRect();
  const top = line.getBoundingClientRect().top;
  const bottom = row.getBoundingClientRect().bottom;
  let delta = 0;
  if (bottom > view.bottom) delta = Math.min(bottom - view.bottom, top - view.top);
  else if (top < view.top) delta = top - view.top;
  if (delta === 0) return;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  scroller.scrollBy({ top: delta, behavior: reduced ? 'auto' : 'smooth' });
}

export function resetPaletteFocusForTests(): void {
  paletteFocusPlan = null;
  lastPaletteFocus = null;
  lineFrom = null;
  paletteScrollKey = null;
}
