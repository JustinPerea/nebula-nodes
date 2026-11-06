import { afterEach, describe, expect, it, vi } from 'vitest';

// Review 8 of PR #205, limits MEDIUM-1: a refused Accept's answer names the
// limit it hit (`limit.kind` beside `code: "proposal_too_complex"`). The
// proposal client reads it from the answer, so the bar picks its line by it.

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', () => ({ apiFetch, rewriteBackendAssetUrls: (value: unknown) => value }));

import { ProposalRequestError, acceptProposal } from '../src/lib/canvasProposals';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SIZE_DETAIL = "The person's Accept of Codex's proposal p_a was refused: This edit would leave the open project at 18,874,837 bytes, over Nebula's save limit of 16 MiB (16,777,216 bytes), and the person's canvas can't save a project that large. Nothing changed. Call project_size (`nebula project size`) to see what takes the space, and make the edit smaller. The proposal is still open.";

afterEach(() => {
  apiFetch.mockReset();
  vi.restoreAllMocks();
});

describe('a refused Accept carries its limit', () => {
  it.each([
    ['size', { kind: 'size', max: 16_777_216 }],
    ['depth', { kind: 'depth', max: 64 }],
    ['values', { kind: 'values', max: 1_000_000 }],
  ])('%s', async (kind, limit) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiFetch.mockResolvedValue(json({ detail: SIZE_DETAIL, code: 'proposal_too_complex', agent: 'Codex', limit }, 409));
    const refused = await acceptProposal('p_a', 'key', {}).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProposalRequestError);
    const error = refused as ProposalRequestError;
    expect([error.status, error.code, error.limitKind, error.heading]).toEqual([409, 'proposal_too_complex', kind, "Couldn't accept the proposal."]);
    expect(error.detail).toBe(SIZE_DETAIL);
  });

  it('another 409 has no limit, and keeps its own reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiFetch.mockResolvedValue(json({ detail: 'This proposal no longer fits the canvas: n3 is gone' }, 409));
    const refused = await acceptProposal('p_a', 'key', {}).catch((error: unknown) => error) as ProposalRequestError;
    expect(refused).toBeInstanceOf(ProposalRequestError);
    expect([refused.status, refused.code, refused.limitKind]).toEqual([409, null, null]);
    expect(refused.reason).toBe('This proposal no longer fits the canvas: n3 is gone');
  });

  it('an answer that isn’t JSON: no limit, and the refusal still reads as one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiFetch.mockResolvedValue(new Response('nope', { status: 409 }));
    const refused = await acceptProposal('p_a', 'key', {}).catch((error: unknown) => error) as ProposalRequestError;
    expect([refused.status, refused.limitKind]).toEqual([409, null]);
  });
});
