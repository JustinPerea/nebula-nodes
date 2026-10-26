import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { PlaceholderRunConfirm } from '../lib/placeholderRunConfirm';
import { PlaceholderRunDialog } from './PlaceholderRunDialog';

export interface AskPlaceholderRunOptions {
  /** Asked again because the run changed since the person last saw it (GM, round 5). */
  changed?: boolean;
  /** Called once as the dialog opens with a function that shows newer words
   * (a measured input's price, the keys read again); returns its stop. The
   * dialog stops watching the moment it is answered. */
  watch?: (show: (next: PlaceholderRunConfirm) => void) => () => void;
}

/** Shows the dialog and resolves with the person's answer: true runs. Newer
 * words from `watch` are drawn at once (flushSync), so the click guard starts
 * with them and a click can't land on the old ones. */
export function askPlaceholderRun(model: PlaceholderRunConfirm, options: AskPlaceholderRunOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      stop?.();
      root.unmount();
      host.remove();
      resolve(ok);
    };
    const draw = (shown: PlaceholderRunConfirm) =>
      root.render(<PlaceholderRunDialog model={shown} changed={options.changed} onDone={done} />);
    draw(model);
    const stop = options.watch?.((next) => {
      if (!settled) flushSync(() => draw(next));
    });
  });
}
