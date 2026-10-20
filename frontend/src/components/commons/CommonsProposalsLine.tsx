import { useShallow } from 'zustand/react/shallow';
import type { AssetProposalView } from '../../lib/assetProposals';
import { useAssetProposalsStore } from '../../store/assetProposalsStore';

interface Waiting {
  assetId: string;
  agents: string[];
  count: number;
  /** What the one proposal asks, in words; the count says it when there are several. */
  asks: string;
}

function asks(view: AssetProposalView): string {
  const edits = view.change.edits ?? [];
  if (edits.length > 1) return `make ${edits.length} changes to a reference`;
  const only = edits[0];
  if (only && 'membership' in only && only.membership.accept && Object.keys(only.membership).length === 2) {
    return 'take a reference out of the inbox';
  }
  return 'change a reference';
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'An agent';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** One line per Commons reference that agents ask to change, oldest first: the
 * grid shows twenty at a time, so this is how the person finds the rest. */
export function CommonsProposalsLine({ onOpen }: { onOpen: (assetId: string) => void }) {
  const waiting = useAssetProposalsStore(useShallow((state) => {
    const byAsset = new Map<string, Waiting>();
    const entries = Object.values(state.proposals)
      .filter((entry) => !entry.closing && entry.view.kind === 'commons')
      .sort((left, right) => left.view.createdAt - right.view.createdAt);
    for (const { view } of entries) {
      const line = byAsset.get(view.target.id) ?? { assetId: view.target.id, agents: [], count: 0, asks: asks(view) };
      if (!line.agents.includes(view.agent.name)) line.agents.push(view.agent.name);
      line.count += 1;
      byAsset.set(view.target.id, line);
    }
    // A string per line keeps useShallow's comparison stable between renders.
    return [...byAsset.values()].map((line) => JSON.stringify(line));
  }));
  if (waiting.length === 0) return null;
  return (
    <>
      {waiting.map((raw) => {
        const line = JSON.parse(raw) as Waiting;
        const verb = line.agents.length > 1 ? 'ask' : 'asks';
        return (
          <p key={line.assetId} className="commons-notice commons-notice--proposal" role="status">
            <span>
              {joinNames(line.agents)} {verb} to {line.count > 1 ? 'change a reference' : line.asks}
              {line.count > 1 ? ` (${line.count} proposals)` : ''}
            </span>
            <button type="button" className="commons-link" onClick={() => onOpen(line.assetId)}>Review</button>
          </p>
        );
      })}
    </>
  );
}
