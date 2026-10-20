import '@testing-library/jest-dom';

// JSDOM does not implement document.elementsFromPoint. Define a no-op stub so
// vi.spyOn can intercept it in tests that mock the return value. Guarded so
// pure-logic tests running under `@vitest-environment node` (no DOM) can still
// load this setup file.
if (typeof document !== 'undefined' && typeof document.elementsFromPoint !== 'function') {
  document.elementsFromPoint = (_x: number, _y: number): Element[] => []; // eslint-disable-line @typescript-eslint/no-unused-vars
}

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  binaryType: BinaryType = 'blob';
  readyState = MockWebSocket.CONNECTING;
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  send(): void {
    // Unit tests do not exercise live backend socket transport.
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

// In test mode lib/backend.ts sends every request to http://localhost:8000,
// where a developer's own Nebula may be running. A request a test forgot to
// mock must never reach it: it would act on (or be refused by) the real app,
// and its answer would arrive at a time that depends on the machine, leaking
// into whichever test runs then (2026-10-20: the autosave "Invalid project ID"
// flake). So a request to this machine (localhost, 127.x, 0.0.0.0, [::1]) is
// refused here at once, without touching the network, and the test that sent
// it fails: the afterEach below names the method and URL. Mock the request (vi.mock the api module, or stub fetch for
// the test); tests that stub fetch themselves replace this fetch.
{
  const realFetch = globalThis.fetch;
  // Every name that reaches this machine's own ports: localhost (and its
  // subdomains), all of 127.0.0.0/8, 0.0.0.0 (which macOS and Linux connect
  // to the local listener) and the IPv6 forms of those. `URL` normalizes
  // IPv4 spellings like 2130706433 to dotted form first.
  const isLoopback = (host: string) => host === 'localhost' || host.endsWith('.localhost')
    || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0'
    || host === '[::1]' || host === '[::]' || /^\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(host);
  const unmocked: { request: string; test: string | null }[] = [];
  const currentTest = () => {
    try {
      return expect.getState().currentTestName ?? null;
    } catch {
      return null;
    }
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let host = '';
    try {
      host = new URL(raw, typeof window !== 'undefined' ? window.location.href : 'http://localhost/').hostname;
    } catch { /* Not a URL: let the real fetch say so. */ }
    if (isLoopback(host)) {
      const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
      unmocked.push({ request: `${method} ${raw}`, test: currentTest() });
      return Promise.reject(new TypeError(`fetch failed: unmocked ${method} ${raw}: tests never reach a local server`));
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const failOnUnmocked = (when: string) => {
    if (unmocked.length === 0) return;
    const sent = unmocked.splice(0);
    const now = currentTest();
    // A request recorded in another test (or between tests) says so.
    const line = ({ request, test }: (typeof sent)[number]) =>
      `  ${request}${test === now ? '' : test ? ` (sent during "${test}")` : ' (sent between tests)'}`;
    throw new Error(
      `${sent.length} unmocked request${sent.length === 1 ? '' : 's'} to a local server ${when} (refused, never sent):\n`
        + sent.map(line).join('\n')
        + '\nMock them in this test file (see tests/setup.ts). One sent by a timer or promise an earlier test\n'
        + 'left running is reported in the test that was running when it was sent.',
    );
  };
  afterEach(() => failOnUnmocked('by the end of this test'));
  // A request a file's last test leaves queued (a promise chain, a 0 ms timer)
  // goes out after its afterEach. Give such work a few real turns before the
  // file ends, with the real timer captured here because a file may leave
  // fake timers on. A request later than that is still refused, unreported.
  const realSetTimeout = globalThis.setTimeout;
  const settle = () => new Promise<void>((resolve) => { realSetTimeout(resolve, 0); });
  afterAll(async () => {
    for (let turn = 0; turn < 3; turn += 1) await settle();
    failOnUnmocked('after the last test in this file');
  });
}
