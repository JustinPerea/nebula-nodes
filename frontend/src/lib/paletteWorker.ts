/** Extract's palette, off the main thread (GM r16 on #208: no freeze). From
 *  round 8c (GM r18 5) the worker reads the picked file itself
 *  (``readPaletteJobOffscreen``: ``createImageBitmap`` and an sRGB
 *  ``OffscreenCanvas``), so the page does no pixel work at all. A file it
 *  can't read (an SVG, a browser without OffscreenCanvas in workers) it
 *  hands back unread, and the page reads it as before and sends the pixels.
 *  It says it's ready first, and whether it can read files, so the page only
 *  hands over work a live worker will do (``paletteWorkerClient``). */
import { readPaletteJobOffscreen, runPaletteJob, type PaletteJob, type PaletteResult } from './paletteExtract';
import type { PaletteReply, PaletteRequest } from './paletteWorkerClient';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PaletteRequest>) => void) | null;
  postMessage: (message: PaletteReply) => void;
};

function run(job: PaletteJob): PaletteResult {
  try {
    return runPaletteJob(job);
  } catch {
    return { ok: false, reason: 'other' };
  }
}

scope.onmessage = async (event) => {
  const request = event.data;
  if ('job' in request) {
    scope.postMessage({ id: request.id, result: run(request.job) });
    return;
  }
  let job: PaletteJob | null = null;
  try {
    job = await readPaletteJobOffscreen(request.file, request.k);
  } catch {
    job = null;
  }
  if (!job) scope.postMessage({ id: request.id, unread: true });
  else scope.postMessage({ id: request.id, result: run(job) });
};

scope.postMessage({
  ready: true,
  reads: typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function',
});
