// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Round 8b (GM r16 on #208): Extract works out the palette in a worker. The
// worker runs the same pure runPaletteJob on pixels the page read, so the
// result must be the same as on the page, byte for byte.
const reads = vi.hoisted(() => ({ next: [] as ((value: unknown) => void)[] }));
vi.mock('../src/lib/paletteExtract', async (original) => ({
  ...await original<typeof import('../src/lib/paletteExtract')>(),
  readPaletteJob: vi.fn(() => new Promise((done) => { reads.next.push(done); })),
}));

import { runPaletteJob, type PaletteJob, type PaletteResult } from '../src/lib/paletteExtract';
import {
  computePalette,
  extractPaletteLatest,
  resetPaletteWorkerForTests,
  transferOf,
  WORKER_READY_MS,
  type PaletteReply,
  type PaletteRequest,
  type PaletteWorkerLike,
} from '../src/lib/paletteWorkerClient';

vi.setConfig({ testTimeout: 120_000 });

/** A worker in this process: the message crosses by structured clone, with
 *  its transfer list, as it does between threads. */
class FakeWorker implements PaletteWorkerLike {
  static made = 0;
  onmessage: ((event: MessageEvent<PaletteReply>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  transfers: Transferable[][] = [];
  terminated = false;
  constructor(private readonly options: { ready?: boolean; crash?: boolean } = {}) {
    FakeWorker.made++;
    if (options.ready !== false) setTimeout(() => this.reply({ ready: true }), 0);
  }
  reply(data: PaletteReply) {
    this.onmessage?.({ data } as MessageEvent<PaletteReply>);
  }
  postMessage(message: PaletteRequest, transfer: Transferable[]) {
    this.transfers.push(transfer);
    const { id, job } = structuredClone(message, { transfer });
    setTimeout(() => {
      if (this.options.crash) this.onerror?.(new Event('error'));
      else this.reply({ id, result: runPaletteJob(job) });
    }, 0);
  }
  terminate() {
    this.terminated = true;
  }
}

const fixture = (name: string) => new Uint8ClampedArray(readFileSync(resolve(__dirname, `fixtures/palette/${name}.rgba`)));
// An opaque image read at 96 px (its own downscale, one buffer) and a
// 1000 px one with clear pixels (the area path; its 96 px read apart).
function opaqueJob(): PaletteJob {
  const data = fixture('dusk-harbour-16x9-96x54');
  return { data, width: 96, height: 54, k: 6, small: { data, width: 96 } };
}
function clearJob(): PaletteJob {
  const width = 1000;
  const height = 600;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const y = Math.floor(i / width);
    const v = y < 180 ? 0 : y < 205 ? 51 : y < 230 ? 221 : 255;
    data.set([v, v, v, (i % width) < 40 ? 0 : 255], i * 4);
  }
  return { data, width, height, k: 6, small: { data: new Uint8ClampedArray(96 * 58 * 4), width: 96 } };
}
const copy = (job: PaletteJob): PaletteJob => {
  const data = job.data.slice();
  return { ...job, data, small: { data: job.small.data === job.data ? data : job.small.data.slice(), width: job.small.width } };
};

let worker: FakeWorker | null = null;
function useWorker(options: { ready?: boolean; crash?: boolean } = {}) {
  FakeWorker.made = 0;
  resetPaletteWorkerForTests(() => (worker = new FakeWorker(options)));
}

afterEach(() => {
  vi.useRealTimers();
  worker = null;
  reads.next.length = 0;
  resetPaletteWorkerForTests();
});

describe('the palette worker gives what the page gives (round 8b)', () => {
  it('returns the same palette as runPaletteJob on the page, opaque and with transparency', async () => {
    useWorker();
    for (const make of [opaqueJob, clearJob]) {
      const direct = runPaletteJob(copy(make()));
      const viaWorker = await computePalette(make());
      expect(JSON.stringify(viaWorker)).toBe(JSON.stringify(direct));
      expect(direct.ok).toBe(true);
    }
  });

  it('transfers the pixels, not a copy: each buffer once, gone from the page after', async () => {
    useWorker();
    const job = clearJob();
    const buffers = [job.data.buffer, job.small.data.buffer];
    expect(transferOf(job)).toEqual(buffers);
    const same = opaqueJob();
    expect(transferOf(same)).toEqual([same.data.buffer]);
    await computePalette(job);
    expect(worker!.transfers[0]).toEqual(buffers);
    expect(job.data.byteLength).toBe(0);
    expect(job.small.data.byteLength).toBe(0);
  });

  it('hands over no pixels until the worker says it is ready', async () => {
    vi.useFakeTimers();
    useWorker({ ready: false });
    const job = opaqueJob();
    const done = computePalette(job);
    expect(worker!.transfers).toEqual([]);
    expect(job.data.byteLength).toBeGreaterThan(0);
    worker!.reply({ ready: true });
    expect(worker!.transfers).toHaveLength(1);
    await vi.runAllTimersAsync();
    expect((await done).ok).toBe(true);
  });
});

describe('without a worker, the page works out the palette (round 8b)', () => {
  it('falls back when a worker cannot be made (a CSP, an old browser), and tries once', async () => {
    FakeWorker.made = 0;
    resetPaletteWorkerForTests(() => { FakeWorker.made++; throw new Error('blocked'); });
    const direct = runPaletteJob(opaqueJob());
    expect(await computePalette(opaqueJob())).toEqual(direct);
    expect(await computePalette(opaqueJob())).toEqual(direct);
    expect(FakeWorker.made).toBe(1);
  });

  it('falls back when the worker fails to start: the waiting job runs on the page', async () => {
    useWorker({ ready: false });
    const job = opaqueJob();
    const direct = runPaletteJob(copy(job));
    const done = computePalette(job);
    worker!.onerror?.(new Event('error'));
    expect(await done).toEqual(direct);
    expect(worker).not.toBeNull();
    const started = FakeWorker.made;
    expect(await computePalette(opaqueJob())).toEqual(direct);
    expect(FakeWorker.made).toBe(started);
  });

  it(`falls back when the worker isn't ready in ${WORKER_READY_MS} ms`, async () => {
    vi.useFakeTimers();
    useWorker({ ready: false });
    const direct = runPaletteJob(opaqueJob());
    const done = computePalette(opaqueJob());
    const made = worker!;
    await vi.advanceTimersByTimeAsync(WORKER_READY_MS - 1);
    expect(made.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toEqual(direct);
    expect(made.terminated).toBe(true);
  });

  it('a worker that fails mid-job answers "other" (its pixels are gone), and the next runs on the page', async () => {
    useWorker({ crash: true });
    expect(await computePalette(opaqueJob())).toEqual({ ok: false, reason: 'other' });
    expect(await computePalette(opaqueJob())).toEqual(runPaletteJob(opaqueJob()));
  });
});

describe('a later Extract wins (round 8b)', () => {
  const result = (hex: string): PaletteResult => ({ ok: true, colors: [hex] });
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it("drops an earlier extract's result for the same control, whichever finishes first", async () => {
    useWorker();
    const file = new Blob([]);
    const first = extractPaletteLatest('n1:palette', file);
    const second = extractPaletteLatest('n1:palette', file);
    await settle();
    reads.next[1](result('#222222'));
    reads.next[0](result('#111111'));
    expect(await second).toEqual(result('#222222'));
    expect(await first).toBeNull();
  });

  it('keeps extracts for two controls apart', async () => {
    useWorker();
    const file = new Blob([]);
    const a = extractPaletteLatest('n1:palette', file);
    const b = extractPaletteLatest('n2:palette', file);
    await settle();
    reads.next[0](result('#111111'));
    reads.next[1](result('#222222'));
    expect(await a).toEqual(result('#111111'));
    expect(await b).toEqual(result('#222222'));
  });
});

describe('the worker module (round 8b)', () => {
  it('says it is ready, then answers each job with runPaletteJob, and "other" for one that throws', async () => {
    const posted: PaletteReply[] = [];
    const scope = { onmessage: null as ((event: MessageEvent<PaletteRequest>) => void) | null, postMessage: (m: PaletteReply) => posted.push(m) };
    vi.stubGlobal('self', scope);
    try {
      vi.resetModules();
      await import('../src/lib/paletteWorker');
      expect(posted).toEqual([{ ready: true }]);
      scope.onmessage!({ data: { id: 7, job: opaqueJob() } } as MessageEvent<PaletteRequest>);
      expect(posted[1]).toEqual({ id: 7, result: runPaletteJob(opaqueJob()) });
      scope.onmessage!({ data: { id: 8, job: { ...opaqueJob(), data: null } } } as unknown as MessageEvent<PaletteRequest>);
      expect(posted[2]).toEqual({ id: 8, result: { ok: false, reason: 'other' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
