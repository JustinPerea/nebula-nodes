import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('../../src/lib/apiRequest', () => ({ apiRequest: (...args: unknown[]) => request(...args) }));
vi.mock('../../src/lib/currentProject', () => ({ resolveProjectId: async (id?: string) => id ?? 'open-project' }));

import { emptyTrash } from '../../src/lib/trash';

beforeEach(() => request.mockReset().mockResolvedValue({ ok: true, json: async () => ({ purged: 0 }) }));

// Review 10, LOW-4 V15: Empty sends exactly what the list showed, so the
// backend deletes nothing for good the person didn't see (an agent's delete
// that landed after the list loaded stays restorable).
describe('emptyTrash', () => {
  it('sends the shown items, kind and id only, with the list\'s filter', async () => {
    await emptyTrash({ kind: 'moodboard', scope: 'project', projectId: 'p1' },
      [{ kind: 'moodboard', id: 'b1', name: 'Rivers', deletedAt: '2026-11-03T10:00:00Z' } as never, { kind: 'moodboard', id: 'b2' }]);
    expect(request).toHaveBeenCalledTimes(1);
    const [heading, path, init] = request.mock.calls[0] as [string, string, RequestInit];
    expect(heading).toBe("Couldn't empty Recently deleted.");
    expect(path).toBe('/api/trash/empty?kind=moodboard&scope=project&projectId=p1');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ items: [{ kind: 'moodboard', id: 'b1' }, { kind: 'moodboard', id: 'b2' }] });
  });

  it('sends an empty list as an empty list, never as no list (which would empty the whole scope)', async () => {
    await emptyTrash({ kind: 'moodboard', scope: 'global' }, []);
    const [, path, init] = request.mock.calls[0] as [string, string, RequestInit];
    expect(path).toBe('/api/trash/empty?kind=moodboard&scope=global');
    expect(JSON.parse(String(init.body))).toEqual({ items: [] });
  });
});
