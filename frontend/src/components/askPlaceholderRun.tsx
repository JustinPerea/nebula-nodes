import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { PlaceholderRunConfirm } from '../lib/placeholderRunConfirm';
import { PlaceholderRunDialog } from './PlaceholderRunDialog';

export interface AskPlaceholderRunOptions {
  /** Asked again because the run changed since the person last saw it (GM, round 5). */
  changed?: boolean;
  /** Asked again because a route or price moved: which nodes (round 16 (a):
   * movedRowIds), named in GM's line in place of the round-5 line. */
  moved?: readonly string[];
  /** Called once as the dialog opens with a function that shows newer words
   * (a measured input's price, the keys read again); returns its stop. The
   * dialog stops watching the moment it is answered. */
  watch?: (show: (next: PlaceholderRunConfirm) => void) => () => void;
}

/** Shows the dialog and resolves with the words it was showing when the
 * person clicked Run (review 5, L6: the run sends those, never words still
 * waiting to be drawn), or null for Cancel. Newer words from `watch` are
 * drawn at once where React allows it (flushSync), so the click guard starts
 * with them. */
export function askPlaceholderRun(model: PlaceholderRunConfirm, options: AskPlaceholderRunOptions = {}): Promise<PlaceholderRunConfirm | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (ok: boolean, shown: PlaceholderRunConfirm) => {
      if (settled) return;
      settled = true;
      stop?.();
      root.unmount();
      host.remove();
      resolve(ok ? shown : null);
    };
    const draw = (shown: PlaceholderRunConfirm) =>
      root.render(<PlaceholderRunDialog model={shown} changed={options.changed} moved={options.moved} onDone={done} />);
    draw(model);
    const stop = options.watch?.((next) => {
      if (!settled) flushSync(() => draw(next));
    });
  });
}
