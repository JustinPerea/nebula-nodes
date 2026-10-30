/**
 * A fake Nebula backend for the held-undo tests (round 17): it keeps the
 * graph (node ids, params and wires), applies each request when it arrives,
 * queues the graphSync each change broadcasts (its echo, in order), and
 * holds or releases each HTTP answer. Tests choose when echoes and answers
 * reach the canvas, so they can play every order a real tab can see: a
 * WebSocket delivers echoes in the order Nebula sent them, while each HTTP
 * answer comes on its own.
 */
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

export interface FakeNode { id: string; definitionId: string; label: string; params: Record<string, unknown>; position: { x: number; y: number } }
export interface FakeWire { id: string; source: string; sourceHandle: string; target: string; targetHandle: string }
interface HeldAnswer { id: number; label: string; release: () => void }
type Graph = { nodes: FakeNode[]; edges: FakeWire[] };
/** An echo, and the request whose change it shows. */
type Echo = Graph & { request: number };

const CLI = /^n\d+$/;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class FakeNebula {
  nodes = new Map<string, FakeNode>();
  edges: FakeWire[] = [];
  next = 1;
  calls: Array<{ path: string; method: string; body?: string }> = [];
  /** Echoes Nebula broadcast that haven't reached the canvas, oldest first. */
  echoes: Echo[] = [];
  /** Requests whose answer reached the tab. */
  answered = new Set<number>();
  /** The request being handled (its echo and answer carry it). */
  request = 0;
  /** HTTP answers on their way. */
  answers: HeldAnswer[] = [];
  holdEchoes = false;
  holdAnswers = false;
  /** Delivers one graphSync to the canvas (set by the test). */
  emit: (event: Record<string, unknown>) => void = () => {};
  tab = '';
  private answerSeq = 0;

  reset(nodes: FakeNode[], edges: FakeWire[] = []): void {
    this.nodes = new Map(nodes.map((node) => [node.id, clone(node)]));
    this.edges = clone(edges);
    this.next = Math.max(0, ...nodes.map((node) => Number(node.id.slice(1)) || 0)) + 1;
    this.calls = [];
    this.echoes = [];
    this.answers = [];
    this.answered = new Set();
    this.holdEchoes = false;
    this.holdAnswers = false;
  }

  ids(): string[] { return [...this.nodes.keys()].sort(); }
  valueOf(id: string): unknown { return this.nodes.get(id)?.params.value; }
  wires(): string[] { return this.edges.map((edge) => `${edge.source}>${edge.target}`).sort(); }

  /** The graph as a graphSync carries it. */
  static syncNodes(graph: Graph): Node<NodeData>[] {
    return graph.nodes.map((node) => ({ id: node.id, type: 'model-node', position: { ...node.position },
      data: { label: node.label, definitionId: node.definitionId, params: clone(node.params), state: 'idle', outputs: {} } }) as Node<NodeData>);
  }

  broadcast(): void {
    const graph = { nodes: [...this.nodes.values()].map(clone), edges: clone(this.edges), request: this.request };
    this.echoes.push(graph);
    if (!this.holdEchoes) this.deliverEchoes();
  }

  /**
   * Nebula writes each echo to the WebSocket before it answers the request
   * (main._broadcast_graph_sync is awaited), so on the person's machine an
   * echo can trail its own answer only for a moment: never past the person's
   * next action. Delivers every echo up to the last one whose answer landed.
   */
  catchUp(): void {
    let last = -1;
    this.echoes.forEach((echo, index) => { if (this.answered.has(echo.request)) last = index; });
    for (let index = 0; index <= last; index += 1) this.deliverEcho();
  }

  /** Delivers the oldest echo still on its way (the WebSocket's order). */
  deliverEcho(): boolean {
    const graph = this.echoes.shift();
    if (!graph) return false;
    this.emit({ nodes: FakeNebula.syncNodes(graph), edges: graph.edges, empty: graph.nodes.length === 0,
      edit: { actor: { kind: 'person' }, tab: this.tab, id: 'ed_own' } });
    return true;
  }

  deliverEchoes(): void { while (this.deliverEcho()); }

  /** Releases an HTTP answer still on its way (the oldest, or the `index`th). */
  releaseAnswer(index = 0): boolean {
    const [held] = this.answers.splice(index, 1);
    if (!held) return false;
    held.release();
    return true;
  }

  private answer(label: string, status: number, body: unknown): Promise<Response> {
    const request = this.request;
    const make = () => { this.answered.add(request); return new Response(JSON.stringify(body), { status }); };
    return this.later(label, make);
  }

  /** An answer on its way: at once, or held until released. */
  later<T>(label: string, make: () => T): Promise<T> {
    if (!this.holdAnswers) return Promise.resolve(make());
    return new Promise((resolve) => {
      this.answers.push({ id: ++this.answerSeq, label, release: () => resolve(make()) });
    });
  }

  private addWire(wire: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }): FakeWire | null {
    if (!this.nodes.has(wire.source) || !this.nodes.has(wire.target)) return null;
    const same = this.edges.find((edge) => edge.source === wire.source && edge.target === wire.target
      && edge.sourceHandle === (wire.sourceHandle ?? '') && edge.targetHandle === (wire.targetHandle ?? ''));
    if (same) return same;
    const made = { id: `e${this.edges.length + 1}-${wire.source}-${wire.target}`, source: wire.source,
      sourceHandle: wire.sourceHandle ?? '', target: wire.target, targetHandle: wire.targetHandle ?? '' };
    this.edges.push(made);
    return made;
  }

  private dropWire(wire: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }): void {
    this.edges = this.edges.filter((edge) => !(edge.source === wire.source && edge.target === wire.target
      && edge.sourceHandle === (wire.sourceHandle ?? '') && edge.targetHandle === (wire.targetHandle ?? '')));
  }

  private create(definitionId: string, params: Record<string, unknown>, position: { x: number; y: number }, label = definitionId): FakeNode {
    const node = { id: `n${this.next++}`, definitionId, label, params: clone(params ?? {}), position: { ...position } };
    this.nodes.set(node.id, node);
    return node;
  }

  async apiFetch(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    this.calls.push({ path, method, body: raw });
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    this.request += 1;
    if (path === '/api/graph/export') return new Response(JSON.stringify({ empty: this.nodes.size === 0 }), { status: 200 });
    if (path === '/api/graph/node' && method === 'POST') {
      const made = this.create(String(body.definitionId), body.params as Record<string, unknown>, body.position as { x: number; y: number });
      this.broadcast();
      return this.answer(`add ${made.id}`, 200, { id: made.id, definitionId: made.definitionId, params: made.params });
    }
    if (path === '/api/graph/node-and-connect' && method === 'POST') {
      const connect = body.connect as { source: string; sourceHandle: string; target: string; targetHandle: string; newNodeIs: 'source' | 'target' };
      // Nebula refuses it when the node to connect to is gone (main.add_node_and_connect).
      if (!this.nodes.has(connect.newNodeIs === 'target' ? connect.source : connect.target)) {
        return this.answer('add+wire refused', 404, { detail: 'No such node.' });
      }
      const made = this.create(String(body.definitionId), body.params as Record<string, unknown>, body.position as { x: number; y: number });
      const edge = this.addWire({ ...connect, source: connect.newNodeIs === 'source' ? made.id : connect.source,
        target: connect.newNodeIs === 'target' ? made.id : connect.target });
      this.broadcast();
      return this.answer(`add+wire ${made.id}`, 200, { id: made.id, definitionId: made.definitionId, params: made.params,
        connected: true, edge: edge && { ...edge, type: 'typed-edge', data: { dataType: 'Text' } } });
    }
    if (path === '/api/graph/cluster' && method === 'POST') {
      const specs = body.nodes as Array<{ tempId: string; definitionId: string; params: Record<string, unknown>; position: { x: number; y: number } }>;
      const idMap: Record<string, string> = {};
      const made = specs.map((spec) => { const node = this.create(spec.definitionId, spec.params, spec.position); idMap[spec.tempId] = node.id; return node; });
      const wires = (body.edges as Array<{ source: string; sourceHandle: string; target: string; targetHandle: string }>)
        .map((edge) => this.addWire({ ...edge, source: idMap[edge.source], target: idMap[edge.target] })).filter(Boolean) as FakeWire[];
      this.broadcast();
      return this.answer(`cluster ${made.map((node) => node.id).join(',')}`, 200, { idMap,
        nodes: FakeNebula.syncNodes({ nodes: made, edges: [] }), edges: wires });
    }
    const named = /^\/api\/graph\/node\/(n\d+)\/label$/.exec(path);
    if (named && method === 'PUT') {
      const node = this.nodes.get(named[1]);
      if (!node) return this.answer(`label ${named[1]}`, 404, { detail: 'No such node.' });
      node.label = String(body.label);
      this.broadcast();
      return this.answer(`label ${named[1]}`, 200, { status: 'updated' });
    }
    const one = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
    if (one && method === 'DELETE') {
      if (!this.nodes.has(one[1])) return this.answer(`delete ${one[1]}`, 404, { detail: 'No such node.' });
      this.nodes.delete(one[1]);
      this.edges = this.edges.filter((edge) => edge.source !== one[1] && edge.target !== one[1]);
      this.broadcast();
      return this.answer(`delete ${one[1]}`, 200, { status: 'deleted', id: one[1] });
    }
    if (one && method === 'PUT') {
      const node = this.nodes.get(one[1]);
      if (!node) return this.answer(`params ${one[1]}`, 404, { detail: 'No such node.' });
      node.params = { ...node.params, ...clone(body.params as Record<string, unknown>) };
      this.broadcast();
      return this.answer(`params ${one[1]}`, 200, { status: 'updated' });
    }
    if (path === '/api/graph/restore' && method === 'POST') {
      for (const id of (body.remove as string[] | undefined) ?? []) {
        this.nodes.delete(id);
        this.edges = this.edges.filter((edge) => edge.source !== id && edge.target !== id);
      }
      for (const item of (body.nodes as Array<Record<string, unknown>> | undefined) ?? []) {
        const id = String(item.id);
        if (!CLI.test(id)) continue;
        const was = this.nodes.get(id);
        this.nodes.set(id, { id, definitionId: String(item.definitionId ?? was?.definitionId ?? 'text-input'),
          label: String(item.label ?? was?.label ?? id),
          params: item.params ? clone(item.params as Record<string, unknown>) : { ...(was?.params ?? {}) },
          position: (item.position as { x: number; y: number }) ?? was?.position ?? { x: 0, y: 0 } });
      }
      for (const wire of (body.unwire as FakeWire[] | undefined) ?? []) this.dropWire(wire);
      for (const wire of (body.wire as FakeWire[] | undefined) ?? []) this.addWire(wire);
      this.broadcast();
      return this.answer('restore', 200, { status: 'restored', reattached: [], reopened: [], notReopened: [], pinsLeft: [], removals: [] });
    }
    if (path === '/api/graph/connect' || path === '/api/graph/edge') {
      if (path === '/api/graph/connect') this.addWire(body as unknown as FakeWire);
      else this.dropWire(body as unknown as FakeWire);
      this.broadcast();
      return this.answer('wire', 200, {});
    }
    return new Response('{}', { status: 200 });
  }
}

export function textFakeNode(id: string, value = id): FakeNode {
  return { id, definitionId: 'text-input', label: id, params: { value }, position: { x: 100, y: 100 } };
}

/** The canvas copy of a fake node (what a test's start graph puts on the canvas). */
export function canvasNode(node: FakeNode, extra: Partial<Node<NodeData>> = {}): Node<NodeData> {
  return { id: node.id, type: 'model-node', position: { ...node.position }, width: 120, height: 60,
    data: { label: node.label, definitionId: node.definitionId, params: clone(node.params), state: 'idle', outputs: {} }, ...extra } as Node<NodeData>;
}

export type { Edge };
