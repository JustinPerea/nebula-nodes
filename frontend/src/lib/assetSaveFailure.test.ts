import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./backend', () => ({ apiFetch: backend.apiFetch, rewriteBackendAssetUrls: (value: unknown) => value }));
vi.mock('./currentProject', () => ({ resolveProjectId: async () => 'p1' }));

import { updateCharacter, updateMoodboard } from './api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => backend.apiFetch.mockReset());

/** The person has a board open in Studio and an agent moves it to Recently
 * deleted. The next autosave must say where it went, so they restore it and
 * Retry instead of losing their edits to a bare "404". */
describe('saving an asset someone moved to Recently deleted', () => {
  it('says who moved the board and how to get it back', async () => {
    backend.apiFetch.mockResolvedValue(json(404, {
      detail: 'x', code: 'in_trash', trashed: { deletedBy: { kind: 'agent', name: 'GM - Design' } },
    }));
    await expect(updateMoodboard('b1', { name: 'Edited' })).rejects.toThrow(
      'This board was moved to Recently deleted by GM - Design (agent). Restore it from the list on the left, then Retry to save your changes.');
  });

  it('leaves out who when it was the person, and keeps the plain error otherwise', async () => {
    backend.apiFetch.mockResolvedValueOnce(json(404, { code: 'in_trash', trashed: { deletedBy: { kind: 'person', name: 'You' } } }));
    await expect(updateCharacter('c1', { name: 'Edited' })).rejects.toThrow(
      'This Character was moved to Recently deleted. Restore it');
    backend.apiFetch.mockResolvedValueOnce(json(404, { detail: "Character 'c1' not found" }));
    await expect(updateCharacter('c1', { name: 'Edited' })).rejects.toThrow('Update character failed: 404');
  });
});
