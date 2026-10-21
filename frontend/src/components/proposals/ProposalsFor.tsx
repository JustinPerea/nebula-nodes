import { lazy, Suspense } from 'react';
import type { AssetProposalKind } from '../../lib/assetProposals';
import { useAssetProposalsStore } from '../../store/assetProposalsStore';

// The strip loads only when an agent has proposed something here, so the
// Projects screen's first load doesn't carry it.
const AssetProposalStrip = lazy(() => import('./AssetProposalStrip').then((module) => ({ default: module.AssetProposalStrip })));

/** An agent's proposals for this project, board or Commons reference, once there is one.
 * `names` lets the strip name a Commons region or collection by id. */
export function ProposalsFor({ kind, targetId, names }: { kind: AssetProposalKind; targetId: string;
  names?: Readonly<Record<string, string>> }) {
  const waiting = useAssetProposalsStore((state) => Object.values(state.proposals)
    .some((entry) => entry.view.kind === kind && entry.view.target.id === targetId));
  if (!waiting) return null;
  return <Suspense fallback={null}><AssetProposalStrip kind={kind} targetId={targetId} names={names} /></Suspense>;
}
