/** Extract's palette, off the main thread (GM r16 on #208: no freeze). The
 *  page reads the pixels, as it always did, and transfers them here; this
 *  runs the same pure ``runPaletteJob`` and sends the result back. It says
 *  it's ready first, so the page only hands over pixels a live worker will
 *  read (``paletteWorkerClient``). */
import { runPaletteJob, type PaletteResult } from './paletteExtract';
import type { PaletteReply, PaletteRequest } from './paletteWorkerClient';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PaletteRequest>) => void) | null;
  postMessage: (message: PaletteReply) => void;
};

scope.onmessage = (event) => {
  const { id, job } = event.data;
  let result: PaletteResult;
  try {
    result = runPaletteJob(job);
  } catch {
    result = { ok: false, reason: 'other' };
  }
  scope.postMessage({ id, result });
};

scope.postMessage({ ready: true });
