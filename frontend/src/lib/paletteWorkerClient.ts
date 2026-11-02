/** Extract from reference, with the palette worked out in a Web Worker so
 *  the canvas never freezes (GM r16 on #208). The pixels are read on the
 *  page exactly as before (``readPaletteJob``: the same draws, in the same
 *  order) and transferred, not copied, to the worker, which runs the same
 *  pure ``runPaletteJob``: the colours are the same either way.
 *
 *  Where a worker can't start (a content security policy, an old browser),
 *  or doesn't say it's ready within ``WORKER_READY_MS``, the palette is
 *  worked out on the page, as before. Pixels go to the worker only once it
 *  has said it's ready, so they are never lost to a worker that never ran.
 *  A worker that fails mid-job can't give its pixels back: that job reads
 *  as a failure ("Couldn't find colors"), and the next runs on the page. */
import { readPaletteJob, runPaletteJob, type PaletteJob, type PaletteResult } from './paletteExtract';

export type PaletteRequest = { id: number; job: PaletteJob };
export type PaletteReply = { ready: true } | { id: number; result: PaletteResult };

/** What this module needs of a Worker (a test passes its own). */
export type PaletteWorkerLike = {
  postMessage: (message: PaletteRequest, transfer: Transferable[]) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<PaletteReply>) => void) | null;
  onerror: ((event: Event) => void) | null;
};

export const WORKER_READY_MS = 3000;

const defaultFactory = (): PaletteWorkerLike =>
  new Worker(new URL('./paletteWorker.ts', import.meta.url), { type: 'module' }) as unknown as PaletteWorkerLike;

let makeWorker: () => PaletteWorkerLike = defaultFactory;
let worker: PaletteWorkerLike | null = null;
let status: 'none' | 'starting' | 'ready' | 'broken' = 'none';
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;
const waiting: { id: number; job: PaletteJob; resolve: (result: PaletteResult) => void }[] = [];
const pending = new Map<number, (result: PaletteResult) => void>();

/** On this thread: the fallback, and the answer for a worker that never ran. */
function onPage(job: PaletteJob): PaletteResult {
  try {
    return runPaletteJob(job);
  } catch {
    return { ok: false, reason: 'other' };
  }
}

/** Each buffer once: an image read at 96 px or less is its own downscale. */
export function transferOf(job: PaletteJob): ArrayBuffer[] {
  return [...new Set([job.data.buffer, job.small.data.buffer])] as ArrayBuffer[];
}

function send(id: number, job: PaletteJob, resolve: (result: PaletteResult) => void): void {
  pending.set(id, resolve);
  try {
    worker!.postMessage({ id, job }, transferOf(job));
  } catch {
    // Nothing was handed over (a clone error throws before the transfer).
    pending.delete(id);
    resolve(onPage(job));
  }
}

function fail(): void {
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = null;
  status = 'broken';
  try {
    worker?.terminate();
  } catch {
    // Already gone.
  }
  worker = null;
  for (const { job, resolve } of waiting.splice(0)) resolve(onPage(job));
  for (const resolve of pending.values()) resolve({ ok: false, reason: 'other' });
  pending.clear();
}

function start(): void {
  try {
    worker = makeWorker();
  } catch {
    worker = null;
    status = 'broken';
    return;
  }
  status = 'starting';
  readyTimer = setTimeout(fail, WORKER_READY_MS);
  worker.onerror = () => fail();
  worker.onmessage = (event) => {
    const reply = event.data;
    if ('ready' in reply) {
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = null;
      status = 'ready';
      for (const { id, job, resolve } of waiting.splice(0)) send(id, job, resolve);
      return;
    }
    const resolve = pending.get(reply.id);
    if (!resolve) return;
    pending.delete(reply.id);
    resolve(reply.result);
  };
}

/** The palette of read pixels, worked out in the worker (or on the page
 *  when there is none). The job's buffers are transferred: don't read them
 *  after. */
export function computePalette(job: PaletteJob): Promise<PaletteResult> {
  if (status === 'none') start();
  if (status === 'broken') return Promise.resolve(onPage(job));
  return new Promise((resolve) => {
    const id = ++nextId;
    if (status === 'ready') send(id, job, resolve);
    else waiting.push({ id, job, resolve });
  });
}

const latest = new Map<string, number>();

/** Extract ``file``'s palette for ``key`` (one palette control). A later
 *  Extract for the same key wins: an earlier one still running resolves
 *  null, and its result is dropped. */
export async function extractPaletteLatest(key: string, file: Blob, k = 6): Promise<PaletteResult | null> {
  const ticket = (latest.get(key) ?? 0) + 1;
  latest.set(key, ticket);
  const job = await readPaletteJob(file, k);
  const result = 'data' in job ? await computePalette(job) : job;
  return latest.get(key) === ticket ? result : null;
}

/** Tests only: use ``factory`` for the next worker, and forget the last. */
export function resetPaletteWorkerForTests(factory: () => PaletteWorkerLike = defaultFactory): void {
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = null;
  worker = null;
  status = 'none';
  waiting.length = 0;
  pending.clear();
  latest.clear();
  makeWorker = factory;
}
