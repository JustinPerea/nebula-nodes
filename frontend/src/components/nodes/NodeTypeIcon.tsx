import type { ModelNodeDefinition } from '../../types';
import { nodeBrowseType, nodeBrowseTypeLabel } from '../../lib/nodeBrowsing';
import { NODE_BROWSE_ICONS } from '../../lib/nodeBrowseIcons';

/** The node's kind, in the same words and icon the Nodes panel uses. */
export function NodeTypeIcon({ definition }: { definition: ModelNodeDefinition | undefined }) {
  if (!definition) return null;
  const type = nodeBrowseType(definition);
  const Icon = NODE_BROWSE_ICONS[type];
  const label = `${nodeBrowseTypeLabel(type)} node`;
  return (
    <span className="model-node__type-icon" role="img" aria-label={label} title={label}>
      <Icon size={13} strokeWidth={1.75} aria-hidden="true" focusable="false" />
    </span>
  );
}
