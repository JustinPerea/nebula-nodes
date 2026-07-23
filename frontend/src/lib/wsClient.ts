import { backendWebSocketUrl } from './backend';

export type ErrorCategory =
  | 'blocked'
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'invalid_input'
  | 'unknown';

export type ExecutionEvent = (
  | { type: 'queued'; nodeId: string }
  | { type: 'executing'; nodeId: string }
  | { type: 'progress'; nodeId: string; value: number }
  | { type: 'executed'; nodeId: string; outputs: Record<string, { type: string; value: string | null }> }
  | { type: 'error'; nodeId: string; error: string; retryable: boolean; category?: ErrorCategory; friendly?: string }
  | { type: 'validationError'; errors: Array<{ nodeId: string; portId: string; message: string }> }
  | { type: 'graphComplete'; duration: number; nodesExecuted: number }
  | { type: 'streamDelta'; nodeId: string; delta: string; accumulated: string }
  | { type: 'streamPartialImage'; nodeId: string; partialIndex: number; src: string; isFinal: boolean }
  | { type: 'streamPartialSvg'; nodeId: string; partialIndex: number; svg: string; isFinal: boolean }
  | { type: 'graphSync'; nodes: unknown[]; edges: unknown[]; empty: boolean }
) & { runId?: string };

type EventHandler = (event: ExecutionEvent) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Set<EventHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private path: string;
  private connecting = false;
  private connectRun = 0;

  constructor(path: string) {
    this.path = path;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.connecting) return;

    this.connecting = true;
    const run = ++this.connectRun;

    backendWebSocketUrl(this.path)
      .then((url) => {
        if (run !== this.connectRun) return;
        this.connecting = false;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          console.log('[ws] connected');
        };

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            const parsed = JSON.parse(event.data) as ExecutionEvent;
            for (const handler of this.handlers) {
              handler(parsed);
            }
          } catch (err) {
            console.error('[ws] failed to parse message:', err);
          }
        };

        this.ws.onclose = () => {
          console.log('[ws] disconnected, reconnecting in 3s...');
          this.scheduleReconnect();
        };

        this.ws.onerror = (err) => {
          console.error('[ws] error:', err);
          this.ws?.close();
        };
      })
      .catch((err) => {
        if (run !== this.connectRun) return;
        this.connecting = false;
        console.error('[ws] backend discovery failed:', err);
        this.scheduleReconnect();
      });
  }

  disconnect(): void {
    this.connectRun += 1;
    this.connecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}

export const wsClient = new WebSocketClient('/ws');
