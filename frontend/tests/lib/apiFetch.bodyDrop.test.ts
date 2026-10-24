import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, fetchUrl } from '../../src/lib/backend';
import { fetchClaudeStatus } from '../../src/lib/api';
import {
  CONNECTION_LOST_COPY,
  ConnectionLostError,
  REFUSED_FALLBACK_COPY,
  failureMessage,
} from '../../src/lib/errorCopy';

/**
 * typeerror2 (2026-10-24): apiFetch answered, then the connection dropped
 * while the caller read the body. The read rejects with fetch's own
 * TypeError ("network error"). The first pass made a bare TypeError read as
 * GM's general line, so this case lost the connection line. The read is now
 * classified where apiFetch (and fetchUrl) hand out the Response: fetch's
 * own body-read failure becomes a ConnectionLostError; a used or locked body,
 * a JSON SyntaxError and the caller's own abort keep their class.
 */

const LOST = CONNECTION_LOST_COPY;
const GENERAL = REFUSED_FALLBACK_COPY;
const HEADING = "Couldn't check Claude status.";

/** Headers and the first bytes arrive, then the stream errors as fetch's does mid-body. */
function droppingResponse(init: ResponseInit = {}): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"installed": tr')); },
    pull(controller) { controller.error(new TypeError('network error')); },
  }), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
}

let answer: () => Response;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => answer()));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch: a body that drops mid-read is a lost connection', () => {
  it.each([
    ['json', (r: Response) => r.json()],
    ['text', (r: Response) => r.text()],
    ['blob', (r: Response) => r.blob()],
    ['arrayBuffer', (r: Response) => r.arrayBuffer()],
  ])('%s() rejects with a ConnectionLostError under no heading, fetch\'s error as its cause', async (_name, read) => {
    answer = () => droppingResponse();
    const response = await apiFetch('/api/agents/claude/status');
    const error = await read(response).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect((error as ConnectionLostError).heading).toBe('');
    expect((error as ConnectionLostError).cause).toBeInstanceOf(TypeError);
    expect(failureMessage(error, HEADING)).toBe(`${HEADING} ${LOST}`);
  });

  it('a clone\'s read is classified too', async () => {
    answer = () => droppingResponse();
    const response = await apiFetch('/api/x');
    await expect(response.clone().json()).rejects.toBeInstanceOf(ConnectionLostError);
  });

  it('the Response is still the one fetch gave: same object, status, headers, instanceof Response', async () => {
    const original = new Response('{"ok":true}', { status: 201, headers: { 'Content-Type': 'application/json', 'X-Test': 'yes' } });
    answer = () => original;
    const response = await apiFetch('/api/x');
    expect(response).toBe(original);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(201);
    expect(response.headers.get('X-Test')).toBe('yes');
    expect(response.bodyUsed).toBe(false);
    await expect(response.clone().json()).resolves.toEqual({ ok: true });
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.bodyUsed).toBe(true);
  });

  it('a real caller (fetchClaudeStatus, through apiRequest) says the connection line under its heading', async () => {
    answer = () => droppingResponse();
    const error = await fetchClaudeStatus().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect(failureMessage(error, HEADING)).toBe(`${HEADING} ${LOST}`);
  });

  it('fetchUrl classifies the read under its own heading', async () => {
    answer = () => droppingResponse();
    const response = await fetchUrl('/api/outputs/a.json', {}, "Couldn't load it.");
    const error = await response.text().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect(failureMessage(error, 'Other heading.')).toBe(`Couldn't load it. ${LOST}`);
  });
});

describe('apiFetch: body failures that are not a dropped connection keep their class', () => {
  it('a used body (a bug) stays a plain TypeError and says the general line', async () => {
    answer = () => new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } });
    const response = await apiFetch('/api/x');
    await response.text();
    const error = await response.json().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ConnectionLostError);
    expect(failureMessage(error, HEADING)).toBe(`${HEADING} ${GENERAL}`);
  });

  it('a locked body (a bug) stays a plain TypeError', async () => {
    answer = () => new Response('{"a":1}');
    const response = await apiFetch('/api/x');
    response.body!.getReader();
    const error = await response.json().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ConnectionLostError);
  });

  it('a JSON SyntaxError stays a SyntaxError and says the general line', async () => {
    answer = () => new Response('<html>not json</html>', { headers: { 'Content-Type': 'text/html' } });
    const response = await apiFetch('/api/x');
    const error = await response.json().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(failureMessage(error, HEADING)).toBe(`${HEADING} ${GENERAL}`);
  });

  it('the caller\'s own abort mid-body comes back as the AbortError', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    answer = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(abort); },
    }));
    const response = await apiFetch('/api/x');
    await expect(response.text()).rejects.toBe(abort);
  });

  it('a TypeError the caller throws while handling the body stays the caller\'s', async () => {
    answer = () => new Response('null', { headers: { 'Content-Type': 'application/json' } });
    const error = await fetchClaudeStatus()
      .then((status) => status.installed)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ConnectionLostError);
    expect(failureMessage(error, HEADING)).toBe(`${HEADING} ${GENERAL}`);
  });

  it('an answer that is not a real Response (a test double) is handed out untouched', async () => {
    const json = vi.fn(async () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); });
    const double = { ok: true, status: 200, headers: new Headers(), json } as unknown as Response;
    answer = () => double;
    const response = await apiFetch('/api/x');
    expect(response).toBe(double);
    expect(response.json).toBe(json);
    const error = await response.json().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ConnectionLostError);
  });
});
