/**
 * PR #199 fix round 23, GM r35 COPY 1, verbatim: a new project refused at
 * the project limit says "You have 501 projects and the limit is 500. You
 * can make a new one after you delete 2 projects." with the real numbers,
 * and "after you delete 1 project" for one. One shared line
 * (lib/errorCopy overProjectLimitCopy) that every refusal of a new project
 * reads from the answer's numbers (`projectCount`, `projectLimit`,
 * `deletes`), through the real request client. The list may be past the
 * limit after a restore, an Undo of a delete or the person's save of kept
 * edits; only new projects are refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: fetch,
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { createProject } from '../src/lib/projects';
import { overProjectLimitCopy, RequestFailedError } from '../src/lib/errorCopy';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });
afterEach(() => fetch.mockReset());

describe('GM r35: the over-limit line', () => {
  it("GM's words, with the real numbers", () => {
    expect(overProjectLimitCopy(501, 500, 2))
      .toBe('You have 501 projects and the limit is 500. You can make a new one after you delete 2 projects.');
    expect(overProjectLimitCopy(500, 500, 1))
      .toBe('You have 500 projects and the limit is 500. You can make a new one after you delete 1 project.');
  });

  it('without the backend\'s count of what is added, the count past the limit plus one', () => {
    expect(overProjectLimitCopy(503, 500)).toMatch(/after you delete 4 projects\.$/);
    expect(overProjectLimitCopy(500, 500)).toMatch(/after you delete 1 project\.$/);
    expect(overProjectLimitCopy(500, 500, 0)).toMatch(/after you delete 1 project\.$/);
  });

  it("the backend's count wins: a new one that also saves a waiting canvas needs one more", async () => {
    fetch.mockResolvedValueOnce(json(413, { detail: 'Project limit reached', limit: 'projects', projectLimit: 500, projectCount: 501, deletes: 3 }));
    expect(await createProject('Fresh', 'rev-a').catch((error: RequestFailedError) => error.reason))
      .toBe('You have 501 projects and the limit is 500. You can make a new one after you delete 3 projects.');
  });

  it('a create refused at the limit reads it under its own heading', async () => {
    fetch.mockResolvedValueOnce(json(413, { detail: 'Project limit reached', limit: 'projects', projectLimit: 500, projectCount: 501, deletes: 2 }));
    const refused = await createProject('Fresh', 'rev-a').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RequestFailedError);
    expect(refused).toMatchObject({ heading: "Couldn't create the project.", status: 413, storageLimit: 'projects',
      reason: 'You have 501 projects and the limit is 500. You can make a new one after you delete 2 projects.',
      detail: 'Project limit reached' });
  });

  it('only for the project limit with both numbers: storage, a size 413 or an older answer read as before', async () => {
    fetch.mockResolvedValueOnce(json(413, { detail: 'Project limit reached', limit: 'projects' }));
    expect(await createProject('Fresh', 'rev-a').catch((error: RequestFailedError) => error.reason)).toBe('Project limit reached');
    fetch.mockResolvedValueOnce(json(413, { detail: 'Project storage limit reached', limit: 'storage', projectLimit: 500, projectCount: 501 }));
    expect(await createProject('Fresh', 'rev-a').catch((error: RequestFailedError) => error.reason)).toBe('Project storage limit reached');
    fetch.mockResolvedValueOnce(json(409, { detail: 'Busy', limit: 'projects', projectLimit: 500, projectCount: 501 }));
    expect(await createProject('Fresh', 'rev-a').catch((error: RequestFailedError) => error.reason)).toBe('Busy');
    fetch.mockResolvedValueOnce(json(413, { detail: 'Project limit reached', limit: 'projects', projectLimit: 500, projectCount: 12 }));
    expect(await createProject('Fresh', 'rev-a').catch((error: RequestFailedError) => error.reason)).toBe('Project limit reached');
  });
});
