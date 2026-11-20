import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { nodeTitle } from './directRoute';
import type { RunGraphSnapshot } from './runHistory';

/** What the canvas holds for one node: its definition and the name the person gave it. */
export interface LiveNodeName { definitionId: string; label: string | undefined }

function titleFor(definitionId: string | undefined, rawLabel: unknown): string {
  const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel : null;
  const definition = definitionId ? NODE_DEFINITIONS[definitionId] : undefined;
  return (definition ? nodeTitle(definition, label) : label) || definition?.displayName || 'Node';
}

/**
 * A node's canvas name for a person reading a saved run, never its id (design): the name
 * it ran under (the run's own snapshot), else its definition's default title (nodeTitle,
 * the rule the cards and the agent log use). A snapshot that kept names (labelsKept) is
 * trusted: no label means it ran unnamed. A record saved before names were kept falls back to
 * the live node's name when that node has the same definition. A node the snapshot lacks
 * reads from the canvas. "Node" when nobody knows its definition.
 */
export function runNodeTitle(snapshot: RunGraphSnapshot, live: LiveNodeName | undefined, nodeId: string): string {
  const saved = snapshot.nodes.find((node) => node.id === nodeId);
  if (!saved) return titleFor(live?.definitionId, live?.label);
  if (snapshot.labelsKept) return titleFor(saved.definitionId, saved.label);
  return titleFor(saved.definitionId, saved.label ?? (live && live.definitionId === saved.definitionId ? live.label : undefined));
}
