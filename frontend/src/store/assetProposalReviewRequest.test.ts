import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestReview, takeReview } = await import('./assetProposalReviewRequest');
const { useAssetProposalsStore } = await import('./assetProposalsStore');

describe('a Review request (Q92 a)', () => {
  beforeEach(() => {
    useAssetProposalsStore.getState().clear();
    vi.useRealTimers();
  });

  it('is held until the strip for that target takes it, once', () => {
    requestReview({ kind: 'moodboard', targetId: 'mb1' });
    expect(useAssetProposalsStore.getState().review).toMatchObject({ kind: 'moodboard', targetId: 'mb1' });
    requestReview({ kind: 'project', targetId: 'dusk' });
    expect(takeReview('moodboard', 'mb1')).toBe(false);
    expect(useAssetProposalsStore.getState().review).not.toBeNull();
    expect(takeReview('project', 'dusk')).toBe(true);
    expect(useAssetProposalsStore.getState().review).toBeNull();
    expect(takeReview('project', 'dusk')).toBe(false);
  });

  it('clears itself when no strip takes it, so it can never fire later (review finding)', () => {
    vi.useFakeTimers();
    requestReview({ kind: 'commons', targetId: 'ast_1' });
    vi.advanceTimersByTime(11_000);
    expect(useAssetProposalsStore.getState().review).toBeNull();
  });

  it("an older request's clean-up leaves a newer one alone", () => {
    vi.useFakeTimers();
    requestReview({ kind: 'commons', targetId: 'ast_1' });
    vi.advanceTimersByTime(6_000);
    requestReview({ kind: 'project', targetId: 'dusk' });
    vi.advanceTimersByTime(5_000);
    expect(useAssetProposalsStore.getState().review).toMatchObject({ kind: 'project', targetId: 'dusk' });
    vi.advanceTimersByTime(6_000);
    expect(useAssetProposalsStore.getState().review).toBeNull();
  });

  it('goes stale when the strip never came (the proposal closed meanwhile)', () => {
    vi.useFakeTimers();
    requestReview({ kind: 'project', targetId: 'dusk' });
    vi.advanceTimersByTime(11_000);
    expect(takeReview('project', 'dusk')).toBe(false);
    expect(useAssetProposalsStore.getState().review).toBeNull();
  });
});
