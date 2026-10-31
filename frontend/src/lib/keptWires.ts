import type { Connection, Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { DynamicNodeData, NodeData, PortDataType } from '../types';
import type { DroppedWire } from './projects';
import { joinedList } from './errorCopy';
import { PORT_RULES, isPortCompatible } from './portCompatibility';

/**
 * PR #199 round 16 (GM r21, 3): while the canvas is kept, a connection is
 * the tab's own and isn't sent until [Save as a project] files the canvas,
 * so the checks the server's connect route would have run happen here, on
 * the same rules (backend services/port_contracts.validate_edge_contracts,
 * and the cycle check a saved graph gets): both ports exist, the output's
 * type fits the input, the input isn't past its connection limit, the wire
 * isn't there already, and it makes no loop. A kept wire the server would
 * refuse never exists. (A single-connection input is replaced, as on a
 * normal tab: the store's onConnect takes the old wire off first, and both
 * decide that with the same predicate, targetHandleAllowsMultiple.)
 *
 * Round 17 (GM r23, 1 and 2): the person's lines are the tab's own, written
 * from the types it knows ("Couldn’t connect to “References”. It takes
 * images, not text."); the server's sentences are for agents.
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

/** Whether an input keeps every connection drawn into it (several) or takes
 * one, the new one replacing the old: the store's onConnect and the kept
 * rules both ask this (review 15 kept-wires-ui LOW-2: a port marked
 * `multiple` with maxConnections 1 isn't replaced, so it refuses at its
 * limit instead). The port is found as every lookup finds it: the node's
 * dynamic ports, then its definition's (review 16 kept-ui LOW-1: a Cinema
 * scene's empty dynamic input list made its Character refs take one). */
export function targetHandleAllowsMultiple(node: Node<NodeData>, handleId: string | null | undefined): boolean {
  if (!handleId) return false;
  return Boolean(inputPort(node, handleId)?.multiple);
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

const portName = (port: PortShape | undefined, fallback: string) => (port?.label ?? '').trim() || fallback;

/** The person's names for port types (GM r23, 1): lowercase and plural. */
const TYPE_NAMES: Record<string, string> = {
  Image: 'images', Text: 'text', Video: 'video', Audio: 'audio', Mesh: '3D models', Array: 'lists',
  Mask: 'masks', SVG: 'SVG images', World: '3D worlds', CameraPose: 'camera poses', CameraPath: 'camera paths',
  SpatialContext: 'spatial context', DepthMap: 'depth maps', DepthSequence: 'depth sequences',
  PointCloud: 'point clouds', SensorRig: 'sensor rigs', SensorStream: 'sensor streams',
  SpatialSession: 'spatial sessions', Character: 'characters', Moodboard: 'moodboards',
  CameraRig: 'camera rigs', ReferenceSet: 'reference sets', Any: 'anything',
};
export const typeName = (type: string | null | undefined): string =>
  (type && TYPE_NAMES[type]) || (type ? type.toLowerCase() : 'something else');

/** What an input takes, in the person's words (GM r25, 1): every type the
 * shared rule lets into it, its own first, by the shared name-list join:
 * an Image input "images and masks", a Text input "text", Any "anything". */
export function takesTypes(type: string | null | undefined): string {
  if (!type || type === PORT_RULES.any) return typeName(type);
  const partners = PORT_RULES.alsoCompatible.flatMap(([a, b]) => (a === type ? [b] : b === type ? [a] : []));
  return joinedList([...new Set([type, ...partners])].map(typeName));
}

/** Connection refusals (GM r23, 1; GM r25, 1): "Couldn’t connect to
 * “References”. It takes images and masks, not text." A loop (GM r26, 3):
 * "Couldn’t connect to “Prompt”. It would make a loop." A missing port names
 * no input, so it says what happened. */
export const keptWireLoop = (into: PortShape | undefined) =>
  `Couldn’t connect to “${portName(into, 'Input')}”. It would make a loop.`;
export const KEPT_WIRE_NO_PORT = 'Couldn’t make that connection. That input or output isn’t on the node anymore.';
export const keptWireWrongKind = (into: PortShape | undefined, out: PortShape | undefined) =>
  `Couldn’t connect to “${portName(into, 'Input')}”. It takes ${takesTypes(into?.dataType)}, not ${typeName(out?.dataType)}.`;
export const keptWireTooMany = (into: PortShape | undefined, limit: number) =>
  `Couldn’t connect to “${portName(into, 'Input')}”. It takes ${limit === 1 ? 'one connection' : `up to ${limit} connections`}.`;

export type KeptWireCheck = { ok: true; duplicate: boolean } | { ok: false; line: string };

/** Whether a kept tab may draw this wire, by the server's rules. */
export function checkKeptWire(connection: Connection, nodes: readonly Node<NodeData>[], edges: readonly Edge[]): KeptWireCheck {
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  // A node gone since the drag began: nothing to say, nothing drawn.
  if (!source || !target) return { ok: false, line: '' };
  const out = outputPort(source, connection.sourceHandle);
  const into = inputPort(target, connection.targetHandle);
  if (!out || !into) return { ok: false, line: KEPT_WIRE_NO_PORT };
  if (!isPortCompatible(out.dataType, into.dataType)) return { ok: false, line: keptWireWrongKind(into, out) };
  const sameInput = (edge: Edge) => edge.target === connection.target && (edge.targetHandle ?? '') === (connection.targetHandle ?? '');
  const same = (edge: Edge) => sameInput(edge) && edge.source === connection.source
    && (edge.sourceHandle ?? '') === (connection.sourceHandle ?? '');
  if (edges.some(same)) return { ok: true, duplicate: true };
  // One rule with onConnect: an input that doesn't keep several connections
  // has its old one replaced; one that does refuses past its limit.
  const replaced = !targetHandleAllowsMultiple(target, connection.targetHandle);
  if (!replaced) {
    // The predicate found this port marked `multiple` by the same lookup, so
    // its limit is maxConnections (none: no limit).
    const limit = inputConnectionLimit(into);
    if (limit !== null && edges.filter(sameInput).length >= limit) return { ok: false, line: keptWireTooMany(into, limit) };
  }
  // The loop check needs no special case for the connection a replaced
  // input drops: an edge into the target never lies on a path from the
  // target back to the source in a graph without loops (review 15: the
  // filter that left it out was dead, mutants F11, W5 and W8).
  if (wireMakesLoop(connection.source, connection.target, edges)) return { ok: false, line: keptWireLoop(into) };
  return { ok: true, duplicate: false };
}

/** The line for a connection the canvas refused as it was dropped (GM r26,
 * 3: on kept and normal tabs alike, since a silent drop looks like a missed
 * drop). useIsValidConnection refuses only a wrong kind, a loop or a port it
 * can't find, so this says the same rules' line; a drop the rules would take
 * (a limit or a duplicate is never refused at the drop) says nothing. */
export function refusedConnectionLine(connection: Connection, nodes: readonly Node<NodeData>[], edges: readonly Edge[]): string {
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (!source || !target) return '';
  const out = outputPort(source, connection.sourceHandle);
  const into = inputPort(target, connection.targetHandle);
  if (!out || !into) return KEPT_WIRE_NO_PORT;
  if (!isPortCompatible(out.dataType, into.dataType)) return keptWireWrongKind(into, out);
  if (wireMakesLoop(connection.source, connection.target, edges)) return keptWireLoop(into);
  return '';
}

/** The connection a drop the canvas refused would have made (GM r26, 3):
 * React Flow's final state names the handle it was dropped on; the drag
 * began at `from` (an output when its handleType is 'source'). Null when the
 * drop wasn't a refusal on a handle (a drop on empty space opens the
 * connection popup instead). */
export function refusedDropConnection(from: { nodeId: string; handleId: string; handleType: 'source' | 'target' },
  state: { isValid: boolean | null; toHandle?: { nodeId: string; id?: string | null } | null }): Connection | null {
  const to = state.toHandle;
  if (state.isValid !== false || !to?.nodeId) return null;
  const fromSource = from.handleType === 'source';
  return {
    source: fromSource ? from.nodeId : to.nodeId,
    sourceHandle: fromSource ? from.handleId : (to.id ?? null),
    target: fromSource ? to.nodeId : from.nodeId,
    targetHandle: fromSource ? (to.id ?? null) : from.handleId,
  };
}

/** The node a dropped connection's end names: the copy's name, else the
 * tab's own name for the node it had (`nameOf`, by the tab's or the copy's
 * id), else null. */
function endName(wire: DroppedWire, end: 'source' | 'target', nameOf: (id: string) => string | null): string | null {
  const own = end === 'source' ? wire.sourceName : wire.targetName;
  if (own && own.trim()) return own.trim();
  const ids = end === 'source' ? [wire.source, wire.sourceWas] : [wire.target, wire.targetWas];
  for (const id of ids) {
    const name = id ? nameOf(id) : null;
    if (name && name.trim()) return name.trim();
  }
  return null;
}

/** Why one connection was left out, after "because" (GM r23, 2). */
function droppedReason(wire: DroppedWire, from: string | null, to: string | null): string {
  switch (wire.kind) {
    case 'loop': return 'it connected the node to itself';
    case 'duplicate': return 'the same connection was already there';
    case 'missing': {
      const sourceGone = wire.source === null;
      const name = sourceGone ? from : to;
      return name ? `“${name}” isn’t on the canvas` : `the node it ${sourceGone ? 'came from' : 'went to'} isn’t on the canvas`;
    }
    case 'port': return to ? `“${to}” doesn’t have that input anymore` : 'that input isn’t there anymore';
    case 'limit': {
      const limit = typeof wire.limit === 'number' && wire.limit > 0 ? wire.limit : 1;
      return `“${to ?? 'that node'}” takes ${limit === 1 ? 'only one connection' : `up to ${limit} connections`} there`;
    }
    default:
      return wire.targetType && wire.sourceType
        ? `“${to ?? 'that node'}” takes ${takesTypes(wire.targetType)}, not ${typeName(wire.sourceType)}`
        : `“${to ?? 'that node'}” can’t take it`;
  }
}

/** One connection, named: "from “A” to “B”" (an absent end unnamed). */
function connectionNamed(from: string | null, to: string | null): string {
  if (from && to) return `from “${from}” to “${to}”`;
  if (to) return `to “${to}”`;
  if (from) return `from “${from}”`;
  return '';
}

/**
 * The connections Save as a project left out, in the tab's words (GM r23,
 * 2; GM r24: the second sentence of the notice that confirms the save, on
 * every ending): one is named with why ("Nebula left out the connection from
 * “A” to “B” because it connected the node to itself."); from 2 on, "Nebula
 * left out 2 connections that couldn’t be kept." naming up to 3 by the
 * shared rule (from 4 the count alone). The tab's own checks run first, so
 * this says only what reached the server anyway.
 */
export function droppedConnectionsLine(wires: readonly DroppedWire[], nameOf: (id: string) => string | null = () => null): string {
  if (wires.length === 0) return '';
  if (wires.length === 1) {
    const wire = wires[0];
    const from = endName(wire, 'source', nameOf);
    const to = endName(wire, 'target', nameOf);
    const named = connectionNamed(from, to);
    return `Nebula left out ${named ? `the connection ${named}` : 'a connection'} because ${droppedReason(wire, from, to)}.`;
  }
  const lead = `Nebula left out ${wires.length} connections that couldn’t be kept`;
  if (wires.length >= 4) return `${lead}.`;
  const named = wires.map((wire) => connectionNamed(endName(wire, 'source', nameOf), endName(wire, 'target', nameOf)));
  if (named.some((item) => !item)) return `${lead}.`;
  return `${lead}: ${named.length === 2 ? named.join(' and ') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`}.`;
}
