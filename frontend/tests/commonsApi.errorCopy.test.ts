import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * error-copy: every Commons request (commonsApi's call(), and the blob and
 * image fetches through it) fails with a CommonsRequestError whose message
 * is copy. Its status stays, so the leave popover's retry rule is unchanged:
 * a lost connection (status 0), 408, 429 and 5xx can be tried again; any
 * other 4xx can't. The raw answer stays on the error for debugging.
 */

const LOST = "Couldn't reach Nebula. Check your connection and try again.";
const NO_ANSWER = "Nebula didn't respond. Try again.";

sessionStorage.setItem('nebula.person', JSON.stringify({ token: crypto.randomUUID(), backend: 'http://localhost:8000' }));
const { commonsApi, commonsEvaluationApi } = await import('../src/lib/commonsApi');
const { CommonsRequestError } = await import('../src/lib/commonsRequestError');
const { saveFailure } = await import('../src/components/commons/commonsLeave');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let answer: () => Response | Promise<Response>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => answer()));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function failure(run: () => Promise<unknown>) {
  const error = await run().then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(CommonsRequestError);
  return error as InstanceType<typeof CommonsRequestError>;
}

describe('Commons request failures carry copy and keep their status', () => {
  it('a lost connection: the connection line, status 0, the browser\'s error as the cause', async () => {
    const original = new TypeError('Failed to fetch');
    answer = () => { throw original; };
    const error = await failure(() => commonsEvaluationApi.labels(0, 3, {} as never));
    expect(error.reason).toBe(LOST);
    expect(error.status).toBe(0);
    expect((error.cause as Error).cause).toBe(original);
    // Round 2: the popover's short line (Save and leave is the retry), the banner's one line.
    expect(saveFailure(error)).toEqual({ ok: false, reason: "Couldn't reach Nebula. Check your connection.",
      message: `Couldn't save your labels. ${LOST}`, retry: true });
    expect(error.heading).toBe("Couldn't save your labels.");
  });

  it.each([408, 429, 500, 502, 503, 504])('HTTP %i: the no-response line, the status, retry', async (status) => {
    answer = () => json({ detail: 'upstream exploded' }, status);
    const error = await failure(() => commonsApi.status());
    expect(error.reason).toBe(NO_ANSWER);
    expect(error.status).toBe(status);
    expect(error.detail).toBe('upstream exploded');
    expect(saveFailure(error).retry).toBe(true);
  });

  it('the export says "ZIP" in capitals, as everywhere else (GM, round 3)', async () => {
    answer = () => new Response('', { status: 503 });
    expect((await failure(() => commonsApi.exportZip())).heading).toBe("Couldn't export the ZIP.");
  });

  it('a 503 with no JSON body no longer says "Commons request failed (503)"', async () => {
    answer = () => new Response('Service Unavailable', { status: 503 });
    expect((await failure(() => commonsApi.status())).reason).toBe(NO_ANSWER);
  });

  it('a 409 keeps the backend\'s words and is not retried', async () => {
    answer = () => json({ detail: 'Labels changed in another window. Reload before saving.' }, 409);
    const error = await failure(() => commonsEvaluationApi.labels(0, 3, {} as never));
    expect(error.reason).toBe('Labels changed in another window. Reload before saving.');
    expect(saveFailure(error)).toEqual({ ok: false, reason: 'Labels changed in another window. Reload before saving.',
      message: "Couldn't save your labels. Labels changed in another window. Reload before saving.", retry: false });
  });

  it.each([
    ['no body', () => new Response('', { status: 400 })],
    ['a FastAPI field list', () => json({ detail: [{ loc: ['body', 'revision'], msg: 'field required', type: 'missing' }] }, 422)],
  ])('a 4xx with %s says a written line, never the status or the raw detail', async (_name, make) => {
    answer = make;
    const error = await failure(() => commonsApi.status());
    expect(error.reason).toBe("That didn't work. Try again, or reload if it keeps happening.");
    expect(error.message).not.toMatch(/\d{3}|field required|loc/);
  });

  it.each([
    [403, "You don't have access to this anymore. Reload to sign in again."],
    [413, "That's too large to save."],
  ])('a bare %i says GM\'s line for it and is not retried', async (status, line) => {
    answer = () => new Response('', { status });
    const error = await failure(() => commonsEvaluationApi.labels(0, 3, {} as never));
    expect(error.reason).toBe(line);
    expect(saveFailure(error)).toEqual({ ok: false, reason: line, message: `${error.heading} ${line}`, retry: false });
  });

  it('a failure that isn\'t a request\'s says GM\'s general line, never its own message', () => {
    expect(saveFailure(new SyntaxError('Unexpected token < in JSON at position 0'))).toEqual({
      ok: false, reason: "That didn't work. Try again, or reload if it keeps happening.",
      message: "Couldn't save your labels. That didn't work. Try again, or reload if it keeps happening.", retry: true,
    });
  });

  it('the image and blob fetches say the same lines', async () => {
    answer = () => { throw new TypeError('Failed to fetch'); };
    expect((await failure(() => commonsEvaluationApi.image(0))).reason).toBe(LOST);
    answer = () => new Response('', { status: 502 });
    expect((await failure(() => commonsApi.blob('/api/commons/blobs/abc'))).reason).toBe(NO_ANSWER);
  });

  it('the caller\'s own abort of an image comes back as an abort, not as copy', async () => {
    const controller = new AbortController();
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    answer = () => { controller.abort(); throw abort; };
    await expect(commonsEvaluationApi.image(0, controller.signal)).rejects.toBe(abort);
  });
});
