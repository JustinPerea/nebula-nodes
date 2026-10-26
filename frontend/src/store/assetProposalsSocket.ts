import { wsClient } from '../lib/wsClient';
import { listAssetProposals } from '../lib/assetProposals';
import { useAssetProposalsStore } from './assetProposalsStore';

/**
 * Asset proposals reach the person's tab over its socket (keys included,
 * browser-only), whatever screen is open: App imports this at start so a
 * sync sent on hello is never missed. When a project or board an open
 * proposal waits on changes, the tab lists them again: the backend closes
 * the ones that no longer fit (another cover pinned, notes turned on) and
 * says so, and this drops whatever it no longer lists.
 */
let relisting: Promise<void> | null = null;

function relist(): void {
  if (relisting) return;
  // Only what was open when the list was asked for: one that opens while the
  // answer is on its way isn't in it, and is still open.
  const asked = new Set(Object.keys(useAssetProposalsStore.getState().proposals));
  relisting = listAssetProposals()
    .then((open) => {
      const store = useAssetProposalsStore.getState();
      // The views may have moved too (a pin whose image went, Q90 a).
      store.refresh(open);
      const listed = new Set(open.map((view) => view.id));
      store.retain(Object.keys(store.proposals).filter((id) => listed.has(id) || !asked.has(id)));
    })
    .catch(() => { /* the socket still says when one closes */ })
    .finally(() => { relisting = null; });
}

function waitsOn(kind: 'project' | 'moodboard', id: string | null | undefined): boolean {
  if (!id) return false;
  return Object.values(useAssetProposalsStore.getState().proposals)
    .some((entry) => !entry.closing && entry.view.kind === kind && entry.view.target.id === id);
}

wsClient.subscribe((event) => {
  const store = useAssetProposalsStore.getState();
  if (event.type === 'assetProposalSync') store.sync(event.proposals);
  else if (event.type === 'assetProposalOpened') store.open(event.proposal, event.acceptKey);
  else if (event.type === 'assetProposalClosed') store.close(event);
  else if (event.type === 'projectsChanged' && waitsOn('project', event.projectId)) relist();
  else if (event.type === 'storedAssetChanged' && event.kind === 'moodboard' && waitsOn('moodboard', event.id)) relist();
});
