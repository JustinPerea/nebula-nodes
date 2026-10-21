import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const commons = vi.hoisted(() => ({ status: vi.fn(), collections: vi.fn(), search: vi.fn() }));
vi.mock('../src/lib/commonsApi', () => ({ commonsApi: commons, filtersToRequest: () => ({ query: '', filters: {} }) }));
vi.mock('../src/components/commons/CommonsDetail', () => ({
  CommonsDetail: ({ assetId }: { assetId: string }) => <div role="region" aria-label={`Detail ${assetId}`} />,
}));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: () => null }));
vi.mock('../src/components/commons/CommonsSettings', () => ({ CommonsSettings: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { useAssetProposalsStore } = await import('../src/store/assetProposalsStore');
const { useUIStore } = await import('../src/store/uiStore');
const { requestReview } = await import('../src/store/assetProposalReviewRequest');

beforeEach(() => {
  useAssetProposalsStore.getState().clear();
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
  commons.collections.mockResolvedValue([]);
  commons.status.mockResolvedValue({ worker: { running: false, state: 'idle' }, queue: {} });
  commons.search.mockResolvedValue({ results: [] });
});
afterEach(() => cleanup());

it('opens the reference a Review on its Update asks for (Q92 a)', async () => {
  requestReview({ kind: 'commons', targetId: 'ast_1' });
  render(<CommonsView />);
  expect(await screen.findByRole('region', { name: 'Detail ast_1' })).toBeTruthy();
  // A later Review, with the Commons already open, opens that one.
  act(() => requestReview({ kind: 'commons', targetId: 'ast_2' }));
  expect(await screen.findByRole('region', { name: 'Detail ast_2' })).toBeTruthy();
});

it("doesn't reopen the reference on a later visit when no strip took the request (review finding)", async () => {
  // The proposal closed before the person arrived: no strip shows, so nothing takes the request.
  requestReview({ kind: 'commons', targetId: 'ast_1' });
  render(<CommonsView />);
  expect(await screen.findByRole('region', { name: 'Detail ast_1' })).toBeTruthy();
  cleanup(); // the person leaves the Commons
  render(<CommonsView />); // and comes back
  await screen.findByRole('tablist', { name: 'Commons sections' });
  expect(screen.queryByRole('region', { name: /^Detail/ })).toBeNull();
});

it('leaves a Review for a project or board alone', async () => {
  requestReview({ kind: 'project', targetId: 'dusk' });
  render(<CommonsView />);
  await screen.findByRole('tablist', { name: 'Commons sections' });
  expect(screen.queryByRole('region', { name: /^Detail/ })).toBeNull();
});
