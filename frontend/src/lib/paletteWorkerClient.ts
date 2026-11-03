/** Extract from reference, worked out in a Web Worker so the canvas never
 *  freezes (GM r16 on #208). From round 8c (GM r18 5) the worker reads the
 *  picked file itself (``createImageBitmap`` and an ``OffscreenCanvas``), so
 *  the page does no pixel work: the same draws, in the same order, as the
 *  page's ``readPaletteJob``, and the same pure ``runPaletteJob``, so the
 *  colours are the same either way. A worker that can't read files (no
 *  OffscreenCanvas there), or a file it can't read (an SVG), is read on the
 *  page as in 8b and the pixels are transferred, not copied.
 *
 *  Where a worker can't start (a content security policy, an old browser,
 *  its script failing to load), the palette is worked out on the page. A
 *  worker that doesn't say it's ready within ``WORKER_READY_MS`` is let go
 *  and its work done on the page; the next Extract tries a new one once,
 *  and only a second slow start keeps Extract on the page for the session.
 *  A ready worker that doesn't answer a job within ``JOB_DEADLINE_MS``, or
 *  fails mid-job, is let go too, and the job is done again on the page from
 *  the picked file. Nothing new shows: the Inspector's line stays until the
 *  page has the palette. Work goes to the worker only once it has said it's
 *  ready, so pixels are never lost to a worker that never ran. */
import {
  extractPaletteFromImage,
  readPaletteJob,
  runPaletteJob,
  type PaletteJob,
  type PaletteResult,
} from './paletteExtract';

export type PaletteRequest = { id: number; job: PaletteJob } | { id: number; file: Blob; k: number };
export type PaletteReply =
  | { ready: true; reads?: boolean }
  | { id: number; result: PaletteResult }
  | { id: number; unread: true };

/** What this module needs of a Worker (a test passes its own). */
export type PaletteWorkerLike = {
  postMessage: (message: PaletteRequest, transfer: Transferable[]) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<PaletteReply>) => void) | null;
  onerror: ((event: Event) => void) | null;
};

export const WORKER_READY_MS = 3000;
/** A ready worker's answer to one job: about 20 times the 8K read and
 *  palette on this Mac's worker (1.4 s), so only a worker that has stopped
 *  meets it. */
export const JOB_DEADLINE_MS = 30_000;

const defaultFactory = (): PaletteWorkerLike =>
  new Worker(new URL('./paletteWorker.ts', import.meta.url), { type: 'module' }) as unknown as PaletteWorkerLike;

/** One Extract's work. ``job``: pixels read on the page and not yet handed
 *  over; ``file``: the picked file, kept so the page can start again. */
type Task = {
  file: Blob | null;
  k: number;
  job: PaletteJob | null;
  unreadable: boolean;
  resolve: (result: PaletteResult) => void;
};

let makeWorker: () => PaletteWorkerLike = defaultFactory;
let worker: PaletteWorkerLike | null = null;
let status: 'none' | 'starting' | 'ready' | 'broken' = 'none';
let reads = false;
let slowStarts = 0;
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;
const waiting: Task[] = [];
const pending = new Map<number, { task: Task; deadline: ReturnType<typeof setTimeout> }>();

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

/** The task done on the page: its pixels if it still has them, else the
 *  picked file read again; "other" only for pixels a worker took and lost
 *  with no file to read again (``computePalette`` alone). */
async function fallback(task: Task): Promise<void> {
  if (task.job) {
    task.resolve(onPage(task.job));
    return;
  }
  if (task.file) {
    try {
      task.resolve(await extractPaletteFromImage(task.file, task.k));
    } catch {
      task.resolve({ ok: false, reason: 'other' });
    }
    return;
  }
  task.resolve({ ok: false, reason: 'other' });
}

/** Read ``task``'s file on the page, then hand the pixels on. */
async function readOnPage(task: Task): Promise<void> {
  const job = await readPaletteJob(task.file!, task.k);
  if (!('data' in job)) {
    task.resolve(job);
    return;
  }
  task.job = job;
  place(task);
}

function post(task: Task): void {
  const id = ++nextId;
  const message: PaletteRequest = task.job ? { id, job: task.job } : { id, file: task.file!, k: task.k };
  const deadline = setTimeout(() => fail('deadline'), JOB_DEADLINE_MS);
  pending.set(id, { task, deadline });
  try {
    worker!.postMessage(message, task.job ? transferOf(task.job) : []);
  } catch {
    // Nothing was handed over (a clone error throws before the transfer).
    clearTimeout(deadline);
    pending.delete(id);
    void fallback(task);
    return;
  }
  // Transferred: these pixels are the worker's now.
  task.job = null;
}

/** To the worker when it's ready, the page when there is none. */
function place(task: Task): void {
  if (status === 'none') start();
  if (status === 'broken') void fallback(task);
  else if (status === 'starting') waiting.push(task);
  else if (task.job || (reads && !task.unreadable)) post(task);
  else void readOnPage(task);
}

/** Let the worker go and do its work on the page. A slow start gets one
 *  more worker on the next Extract; anything else keeps the page. */
function fail(why: 'slow' | 'error' | 'deadline'): void {
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = null;
  try {
    worker?.terminate();
  } catch {
    // Already gone.
  }
  worker = null;
  status = why === 'slow' && ++slowStarts < 2 ? 'none' : 'broken';
  const tasks = waiting.splice(0);
  for (const { task, deadline } of pending.values()) {
    clearTimeout(deadline);
    tasks.push(task);
  }
  pending.clear();
  for (const task of tasks) void fallback(task);
}

function start(): void {
  let made: PaletteWorkerLike;
  try {
    made = makeWorker();
  } catch {
    worker = null;
    status = 'broken';
    return;
  }
  worker = made;
  status = 'starting';
  reads = false;
  readyTimer = setTimeout(() => fail('slow'), WORKER_READY_MS);
  made.onerror = () => {
    if (worker === made) fail('error');
  };
  made.onmessage = (event) => {
    if (worker !== made) return;
    const reply = event.data;
    if ('ready' in reply) {
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = null;
      status = 'ready';
      reads = reply.reads === true;
      for (const task of waiting.splice(0)) place(task);
      return;
    }
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.deadline);
    if ('unread' in reply) {
      entry.task.unreadable = true;
      void readOnPage(entry.task);
      return;
    }
    entry.task.resolve(reply.result);
  };
}

/** The palette of read pixels, worked out in the worker (or on the page
 *  when there is none). The job's buffers are transferred: don't read them
 *  after. */
export function computePalette(job: PaletteJob): Promise<PaletteResult> {
  return new Promise((resolve) => place({ file: null, k: job.k, job, unreadable: false, resolve }));
}

/** The palette of a picked file, read and worked out in the worker where it
 *  can, on the page where it can't. */
export function paletteOfFile(file: Blob, k = 6): Promise<PaletteResult> {
  return new Promise((resolve) => place({ file, k, job: null, unreadable: false, resolve }));
}

const latest = new Map<string, number>();

/** Extract ``file``'s palette for ``key`` (one palette control on one
 *  node). A later Extract for the same key wins: an earlier one still
 *  running resolves null, and its result is dropped. */
export async function extractPaletteLatest(key: string, file: Blob, k = 6): Promise<PaletteResult | null> {
  const ticket = (latest.get(key) ?? 0) + 1;
  latest.set(key, ticket);
  const result = await paletteOfFile(file, k);
  return latest.get(key) === ticket ? result : null;
}

/** Tests only: use ``factory`` for the next worker, and forget the last. */
export function resetPaletteWorkerForTests(factory: () => PaletteWorkerLike = defaultFactory): void {
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = null;
  try {
    worker?.terminate();
  } catch {
    // Already gone.
  }
  worker = null;
  status = 'none';
  reads = false;
  slowStarts = 0;
  waiting.length = 0;
  for (const { deadline } of pending.values()) clearTimeout(deadline);
  pending.clear();
  latest.clear();
  makeWorker = factory;
}
