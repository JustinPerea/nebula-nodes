import { backendWebSocketUrl } from './backend';
import type { PortValue, VariantScope } from '../types';
import type { ExecutionStatusResult } from './api';
import type {
  ProviderRecoveryCheckpoint,
  ProviderStartAmbiguity,
  ProviderStartKind,
} from './runHistory';

export type ErrorCategory =
  | 'blocked'
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'invalid_input'
  | 'unknown';

/** Where an agent cursor points: a node, one of its ports, or a flow-space spot. */
export type AgentCursorAnchor =
  | { nodeId: string; handle?: string }
  | { x: number; y: number };

export interface AgentPresenceEvent {
  type: 'agentPresence';
  agent: { id: string; name: string; color: string; verified: boolean };
  target: AgentCursorAnchor;
  from?: AgentCursorAnchor;
  action: 'move' | 'click' | 'drag' | 'look';
  say: string;
  /** Backend wall-clock milliseconds. */
  at: number;
}

/** A short note the person pinned for agents (backend services/canvas_pins.py). */
export interface Pin {
  id: string;
  text: string;
  anchor: { nodeId: string } | { x: number; y: number };
  /** Last known flow position (the node's, or the spot). */
  position: { x: number; y: number } | null;
  status: 'open' | 'resolved';
  /** ISO timestamp. */
  createdAt: string;
  /** True once the node it was pinned to was removed; it stays where the node was. */
  detached: boolean;
  detachedFrom?: string;
  reply: {
    agent: { id: string; name: string; color: string; verified: boolean };
    text: string;
    at: string;
  } | null;
}

/** The active project's pins, sent after graphSync and on every pin change. */
export interface CanvasPinsEvent {
  type: 'canvasPins';
  projectId: string | null;
  pins: Pin[];
}

export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'withdrawn' | 'expired' | 'invalidated';

/** One node's run cost. Nebula has no price list, so it is only free or paid. */
export interface ProposalCost {
  kind: 'free' | 'paid';
  provider: string | null;
  label: string;
}

export interface ProposalPort {
  id: string;
  label: string;
  dataType: string;
}

/** An agent's proposed change (backend services/canvas_proposals.ProposalBook.view). */
export interface ProposalView {
  id: string;
  status: ProposalStatus;
  agent: { id: string; name: string; color: string; verified: boolean };
  note: string;
  projectId: string | null;
  /** Backend wall-clock milliseconds. */
  createdAt: number;
  expiresAt: number;
  nodes: Array<{
    ref: string;
    definitionId: string;
    name: string;
    category: string;
    params: Record<string, unknown>;
    position: { x: number; y: number };
    cost: ProposalCost;
    runs: boolean;
    willRun: boolean;
    ports: { inputs: ProposalPort[]; outputs: ProposalPort[] };
  }>;
  edges: Array<{ source: string; sourceHandle: string; target: string; targetHandle: string }>;
  params: Array<{ nodeId: string; name: string; changes: Record<string, { from: unknown; to: unknown }> }>;
  run: string[];
  cost: {
    paidRuns: number;
    freeRuns: number;
    estimate: null;
    upTo: boolean;
    providers: string[];
    nodes: Array<ProposalCost & { ref: string; nodeId: string | null }>;
    note: string;
  };
  references: string[];
  reason: string | null;
  idMap: Record<string, string> | null;
  runNodeIds: string[] | null;
}

/**
 * Browser sockets only: exactly what Accept will write (canvas_proposals.person_values).
 * The view's values are cut for agents; these are what the person approves.
 */
export interface ProposalPersonValues {
  /** New node ref -> its proposed params. */
  nodes: Record<string, Record<string, unknown>>;
  /** Existing node id -> param key -> {from, to}. */
  params: Record<string, Record<string, { from: unknown; to: unknown }>>;
}

/** Browser sockets only: a new proposal plus the key that lets this canvas decide it. */
export interface ProposalOpenedEvent {
  type: 'proposalOpened';
  proposal: ProposalView;
  acceptKey: string;
  personValues?: ProposalPersonValues;
}

/** Browser sockets only, after graphSync: every open proposal with its key. */
export interface ProposalSyncEvent {
  type: 'proposalSync';
  proposals: Array<ProposalView & { acceptKey: string; personValues?: ProposalPersonValues }>;
}

export interface ProposalClosedEvent {
  type: 'proposalClosed';
  proposalId: string;
  status: Exclude<ProposalStatus, 'open'>;
  reason?: string | null;
  idMap?: Record<string, string>;
}

export type ExecutionEvent = (
  | { type: 'queued'; nodeId: string }
  | { type: 'executing'; nodeId: string; variant?: VariantScope | null }
  | { type: 'progress'; nodeId: string; value: number; variant?: VariantScope | null }
  | { type: 'executed'; nodeId: string; outputs: Record<string, PortValue>; batchOutputs?: Array<Record<string, PortValue>> | null; variant?: VariantScope | null; batchVariants?: VariantScope[] | null }
  | { type: 'error'; nodeId: string; error: string; retryable: boolean; category?: ErrorCategory; friendly?: string; variant?: VariantScope | null }
  | { type: 'validationError'; errors: Array<{ nodeId: string; portId: string; message: string }> }
  | { type: 'graphComplete'; duration: number; nodesExecuted: number }
  | { type: 'graphCancelled' }
  | {
      type: 'executionStatus';
      status: 'cancelled' | 'completed' | 'failed';
    }
  | {
      type: 'providerRecovery';
      nodeId: string;
      resumeOperationId: string | null;
      existingWorldId: string | null;
      durable: boolean;
      warning: string | null;
    }
  | {
      type: 'providerStartAmbiguous';
      nodeId: string;
      kind: ProviderStartKind;
      message: string;
      durable: boolean;
    }
  | { type: 'streamDelta'; nodeId: string; delta: string; accumulated: string }
  | { type: 'streamPartialImage'; nodeId: string; partialIndex: number; src: string; isFinal: boolean }
  | { type: 'streamPartialSvg'; nodeId: string; partialIndex: number; svg: string; isFinal: boolean }
  | {
      type: 'graphSync';
      nodes: unknown[];
      edges: unknown[];
      empty: boolean;
      /** Explicit committed graph import; ordinary updates remain merges. */
      graphReplaced?: boolean;
      activeProjectId?: string | null;
      workspaceRevision?: string;
      providerRecoveries?: ProviderRecoveryCheckpoint[];
      providerStartAmbiguities?: ProviderStartAmbiguity[];
      executionStatuses?: ExecutionStatusResult[];
    }
  | AgentPresenceEvent
  | CanvasPinsEvent
  | ProposalOpenedEvent
  | ProposalSyncEvent
  | ProposalClosedEvent
) & { runId?: string };

type EventHandler = (event: ExecutionEvent) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Set<EventHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private path: string;
  private connecting = false;
  private connectRun = 0;
  private forceDiscoveryOnReconnect = false;

  constructor(path: string) {
    this.path = path;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.connecting) return;

    this.connecting = true;
    const run = ++this.connectRun;

    const forceDiscovery = this.forceDiscoveryOnReconnect;
    backendWebSocketUrl(this.path, { forceDiscovery })
      .then((url) => {
        if (run !== this.connectRun) return;
        this.connecting = false;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          this.forceDiscoveryOnReconnect = false;
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
          this.forceDiscoveryOnReconnect = true;
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
        this.forceDiscoveryOnReconnect = true;
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
