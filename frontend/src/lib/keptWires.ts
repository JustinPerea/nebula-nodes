import type { Connection, Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { DynamicNodeData, NodeData, PortDataType } from '../types';
import { isPortCompatible } from './portCompatibility';

/**
 * PR #199 round 16 (GM r21, 3): while the canvas is kept, a connection is
 * the tab's own and isn't sent until [Save as a project] files the canvas,
 * so the checks the server's connect route would have run happen here, on
 * the same rules (backend services/port_contracts.validate_edge_contracts,
 * and the cycle check a saved graph gets): both ports exist, the output's
 * type fits the input, the input isn't past its connection limit, the wire
 * isn't there already, and it makes no loop. A kept wire the server would
 * refuse never exists. (A single-connection input is replaced, as on a
 * normal tab: the store's onConnect takes the old wire off first.)
 */

interface PortShape { id: string; label?: string; dataType: PortDataType; multiple?: boolean; maxConnections?: number }

function outputPort(node: Node<NodeData>, handle: string | null | undefined): PortShape | undefined {
  const data = node.data as unknown as DynamicNodeData;
  if (data?.isDynamic && data.dynamicOutputPorts) {
    const port = data.dynamicOutputPorts.find((p) => p.id === handle);
    if (port) return port;
  }
  return NODE_DEFINITIONS[node.data.definitionId]?.outputPorts.find((p) => p.id === handle);
}

function inputPort(node: Node<NodeData>, handle: string | null | undefined): PortShape | undefined {
  const data = node.data as unknown as DynamicNodeData;
  if (data?.isDynamic && data.dynamicInputPorts) {
    const port = data.dynamicInputPorts.find((p) => p.id === handle);
    if (port) return port;
  }
  return NODE_DEFINITIONS[node.data.definitionId]?.inputPorts.find((p) => p.id === handle);
}

/** The server's `_input_connection_limit`: one unless the input takes
 * several, then its maxConnections (none: no limit). */
export function inputConnectionLimit(port: PortShape | undefined): number | null {
  if (!port) return null;
  if (!port.multiple) return 1;
  return typeof port.maxConnections === 'number' && port.maxConnections >= 0 ? port.maxConnections : null;
}

/** Would `source → target` close a loop over `edges`? */
export function wireMakesLoop(source: string, target: string, edges: readonly Edge[]): boolean {
  if (source === target) return true;
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target]);
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (at === source) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    stack.push(...(next.get(at) ?? []));
  }
  return false;
}

const inputName = (port: PortShape | undefined) => (port?.label ?? '').trim() || 'Input';

/** Kept wires' lines, after "Couldn't make that connection.": the first
 * sentence of the server's own person lines (port_contracts _wrong_kind_line
 * and _too_many_line, GM's), since nothing was drawn to remove. */
export const KEPT_WIRE_LOOP = 'It would connect the node back to itself.';
export const keptWireWrongKind = (port: PortShape | undefined) => `The connection into “${inputName(port)}” brings something it can’t take.`;
export const keptWireTooMany = (port: PortShape | undefined, limit: number) =>
  `“${inputName(port)}” takes ${limit === 1 ? 'one connection' : `up to ${limit} connections`}.`;

export type KeptWireCheck = { ok: true; duplicate: boolean } | { ok: false; line: string };

/** Whether a kept tab may draw this wire, by the server's rules. */
export function checkKeptWire(connection: Connection, nodes: readonly Node<NodeData>[], edges: readonly Edge[]): KeptWireCheck {
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  // A node gone since the drag began: nothing to say, nothing drawn.
  if (!source || !target) return { ok: false, line: '' };
  const out = outputPort(source, connection.sourceHandle);
  const into = inputPort(target, connection.targetHandle);
  if (!out || !into || !isPortCompatible(out.dataType, into.dataType)) return { ok: false, line: keptWireWrongKind(into) };
  const same = (edge: Edge) => edge.source === connection.source && (edge.sourceHandle ?? '') === (connection.sourceHandle ?? '')
    && edge.target === connection.target && (edge.targetHandle ?? '') === (connection.targetHandle ?? '');
  if (edges.some(same)) return { ok: true, duplicate: true };
  const limit = inputConnectionLimit(into);
  // A one-connection input is replaced (onConnect), so only a several-input limit refuses.
  if (limit !== null && limit !== 1) {
    const held = edges.filter((edge) => edge.target === connection.target && (edge.targetHandle ?? '') === (connection.targetHandle ?? '')).length;
    if (held >= limit) return { ok: false, line: keptWireTooMany(into, limit) };
  }
  // The wires a one-connection input drops don't count for the loop.
  const kept = limit === 1
    ? edges.filter((edge) => !(edge.target === connection.target && (edge.targetHandle ?? '') === (connection.targetHandle ?? '')))
    : edges;
  if (wireMakesLoop(connection.source, connection.target, kept)) return { ok: false, line: KEPT_WIRE_LOOP };
  return { ok: true, duplicate: false };
}
