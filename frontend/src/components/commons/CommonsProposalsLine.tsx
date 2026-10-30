import type { CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AssetProposalView } from '../../lib/assetProposals';
import { proposalAgentColor, useAssetProposalsStore } from '../../store/assetProposalsStore';
import { useHeldCommonsLines } from '../../store/heldAssetProposals';

interface Agent {
  name: string;
  color: string;
}

interface Waiting {
  assetId: string;
  agents: Agent[];
  count: number;
  /** What the one proposal asks, in words; the count says it when there are several. */
  asks: string;
  at: number;
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

/** Who asks: a dot in each agent's colour (GM, PR #202 r1), then the names. */
function Who({ agents }: { agents: Agent[] }) {
  return (
    <>
      {agents.map((agent) => (
        <span key={agent.name} className="commons-notice__dot" aria-hidden="true"
          style={{ '--agent-color': agent.color } as CSSProperties} />
      ))}
      {joinNames(agents.map((agent) => agent.name))}
    </>
  );
}

/** One line per Commons reference that agents ask to change, oldest first: the
 * grid shows twenty at a time, so this is how the person finds the rest.
 *
 * GM, PR #202 r1: while this tab isn't connected as the person, the proposals
 * themselves don't reach it (person-only), only their Updates. Each open
 * Update about a Commons reference counts in that reference's line as one
 * proposal by its agent (store/heldAssetProposals.ts `heldCommonsLines`, from
 * the Update's ref, never its text), and a line known only from Updates has
 * no Review. The person's sync after the promote brings the same proposals,
 * so the line keeps its words and only gains Review: nothing moves.
 * (One case the held tab can't see: an agent asking twice about the same
 * reference while held shares one Update, so the promote then raises the
 * count in place.) */
export function CommonsProposalsLine({ onOpen }: { onOpen: (assetId: string) => void }) {
  const known = useAssetProposalsStore(useShallow((state) => Object.values(state.proposals)
    .filter((entry) => !entry.closing && entry.view.kind === 'commons')
    // A string per proposal keeps useShallow's comparison stable between renders.
    .map(({ view }) => JSON.stringify({ assetId: view.target.id, agent: { name: view.agent.name, color: proposalAgentColor(view.agent.color) },
      asks: asks(view), at: view.createdAt }))));
  const held = useHeldCommonsLines();
  const asked = [
    ...known.map((raw) => ({ ...(JSON.parse(raw) as { assetId: string; agent: Agent; asks: string; at: number }), held: null as string | null })),
    ...held.map((line) => ({ assetId: line.assetId, agent: { name: line.agentName, color: line.agentColor }, asks: line.asks, at: line.at,
      held: line.proposalId })),
  ].sort((left, right) => left.at - right.at);
  if (asked.length === 0) return null;
  const byAsset = new Map<string, Waiting & { held: string[]; known: number }>();
  for (const one of asked) {
    const line = byAsset.get(one.assetId) ?? { assetId: one.assetId, agents: [], count: 0, asks: one.asks, at: one.at, held: [], known: 0 };
    if (!line.agents.some((agent) => agent.name === one.agent.name)) line.agents.push(one.agent);
    line.count += 1;
    if (one.held) line.held.push(one.held); else line.known += 1;
    byAsset.set(one.assetId, line);
  }
  return (
    <>
      {[...byAsset.values()].map((line) => {
        const verb = line.agents.length > 1 ? 'ask' : 'asks';
        const heldOnly = line.known === 0;
        return (
          <p key={line.assetId} className="commons-notice commons-notice--proposal" role="status" data-commons-asset={line.assetId}
            data-held-commons={heldOnly ? line.held.join(' ') : undefined}>
            <span className="commons-notice__text">
              <Who agents={line.agents} /> {verb} to {line.count > 1 ? 'change a reference' : line.asks}
              {line.count > 1 ? ` (${line.count} proposals)` : ''}
            </span>
            {!heldOnly && <button type="button" className="commons-link" onClick={() => onOpen(line.assetId)}>Review</button>}
          </p>
        );
      })}
    </>
  );
}
