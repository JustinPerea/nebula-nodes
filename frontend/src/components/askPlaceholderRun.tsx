import { createRoot } from 'react-dom/client';
import type { PlaceholderRunConfirm } from '../lib/placeholderRunConfirm';
import { PlaceholderRunDialog } from './PlaceholderRunDialog';

/** Shows the dialog and resolves with the person's answer: true runs. */
export function askPlaceholderRun(model: PlaceholderRunConfirm): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      root.unmount();
      host.remove();
      resolve(ok);
    };
    root.render(<PlaceholderRunDialog model={model} onDone={done} />);
  });
}
