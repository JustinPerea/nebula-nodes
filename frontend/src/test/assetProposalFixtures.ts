import type { AssetProposalView } from '../lib/assetProposals';

/** An open cover proposal for project "Dusk", as the backend's view has it. */
export function coverProposal(overrides: Partial<AssetProposalView> = {}): AssetProposalView {
  return {
    id: 'pa_00000001', status: 'open', agent: { id: 'claude-code', name: 'Claude Code', color: '#5B9DFF' },
    note: 'The new grade reads better', kind: 'project', target: { kind: 'project', id: 'dusk', name: 'Dusk' },
    change: { cover: { from: '/api/outputs/a.png', to: '/api/outputs/c.png', fromBy: { kind: 'person', name: 'You' } } },
    summary: 'make another image the cover of “Dusk”', decideIn: 'projects',
    createdAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, reason: null, applied: null, ...overrides,
  };
}

/** An open commons proposal on reference ast_1 (two edits), as the person's
 * socket has it: the view plus `before`, which only the person's screen gets. */
export function commonsProposal(overrides: Partial<AssetProposalView> = {}): AssetProposalView {
  return coverProposal({
    id: 'pa_0000c001', note: 'Reads quieter to me', kind: 'commons', target: { kind: 'commons', id: 'ast_1', name: '' },
    change: { edits: [
      { correction: { field_path: 'summary.value', op: 'set', value: 'A quiet grid poster', reason: 'the type is small' } },
      { correction: { field_path: 'keywords', op: 'add', value: 'brutalist', reason: null } },
      { region: { id: 'reg_1', status: 'confirmed' } },
      { membership: { id: 'mem_1', role: 'avoid', why: 'too loud for us' } },
    ] },
    before: [{ value: 'A loud poster' }, { present: false },
      { label: 'headline', note: null, status: 'proposed', box: [0.1, 0.1, 0.3, 0.2] },
      { role: 'neutral', why: 'loud poster', in_inbox: false }],
    summary: 'make 4 changes to an image in the Commons', decideIn: 'commons', ...overrides,
  });
}
