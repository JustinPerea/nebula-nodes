import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/backend', () => ({ apiFetch }));
import { enhancePrompt } from '../../src/lib/enhancePrompt';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('enhancePrompt errors', () => {
  beforeEach(() => apiFetch.mockReset());

  it('shows the length-cap message as written', async () => {
    apiFetch.mockResolvedValue(json({ detail: 'Prompt is too long for Enhance (5000 characters; the limit is 4000).' }, 413));
    await expect(enhancePrompt('x')).rejects.toThrow('Prompt is too long for Enhance (5000 characters; the limit is 4000).');
  });

  it('a validation list says GM\'s fallback line, not [object Object] (error-copy round 2)', async () => {
    apiFetch.mockResolvedValue(json({ detail: [{ loc: ['body', 'prompt'], msg: 'Field required', type: 'missing' }] }, 422));
    await expect(enhancePrompt('x')).rejects.toThrow(
      "Couldn't enhance the prompt. Try again, or reload if it keeps happening.");
  });

  it("shows the person gate refusal as GM's line (Q116 a: every person-only refusal)", async () => {
    apiFetch.mockResolvedValue(json({ detail: 'Only the person can do this', code: 'person_required' }, 403));
    await expect(enhancePrompt('x')).rejects.toThrow("This change needs your OK, and this tab isn’t connected as you. Open the link Nebula printed when it started, then try again.");
  });
});
