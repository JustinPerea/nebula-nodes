import '@testing-library/jest-dom';

// JSDOM does not implement document.elementsFromPoint. Define a no-op stub so
// vi.spyOn can intercept it in tests that mock the return value.
if (typeof document.elementsFromPoint !== 'function') {
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
