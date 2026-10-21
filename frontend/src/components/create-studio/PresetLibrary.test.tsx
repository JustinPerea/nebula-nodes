import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const presets = vi.hoisted(() => ({ fetchPresets: vi.fn() }));
vi.mock('../../lib/createPresets', () => presets);
vi.mock('../../lib/backend', async (importOriginal) => ({ ...(await importOriginal<object>()), backendAssetUrlSync: (url: string) => url }));
const socket = vi.hoisted(() => ({ handlers: new Set<(event: unknown) => void>() }));
vi.mock('../../lib/wsClient', () => ({ wsClient: {
  subscribe: (handler: (event: unknown) => void) => { socket.handlers.add(handler); return () => socket.handlers.delete(handler); },
  connect: () => {}, send: () => {} } }));

import { PresetLibrary } from './PresetLibrary';
import { setOpenProject } from '../../test/projectState';

const style = { id: 's1', name: 'Neon noir', category: 'My Styles', prompt: 'neon', params: {}, modelId: null,
  refImages: [], thumbnail: '', version: 1, scope: 'global', projectId: null, createdAt: '', updatedAt: '' };

const emit = (event: unknown) => act(() => { for (const handler of socket.handlers) handler(event); });

beforeEach(() => {
  presets.fetchPresets.mockReset().mockImplementation(async (scope: string) => (scope === 'global' ? [style] : []));
  setOpenProject(['pA', 'Shoot A']);
});

describe("Create's Styles", () => {
  it('lists again when a Style is saved, deleted or restored elsewhere (an agent, the Assets panel)', async () => {
    render(<PresetLibrary onApply={() => {}} onSaveCurrent={() => {}} onClose={() => {}} reloadKey={0} />);
    expect(await screen.findByText('Neon noir')).toBeTruthy();

    presets.fetchPresets.mockImplementation(async () => []);
    emit({ type: 'storedAssetChanged', kind: 'style', id: 's1', deleted: true });
    expect(await screen.findByText('No styles yet.')).toBeTruthy();

    presets.fetchPresets.mockImplementation(async (scope: string) => (scope === 'global' ? [style] : []));
    emit({ type: 'socketReconnected' });
    expect(await screen.findByText('Neon noir')).toBeTruthy();
  });

  it("ignores a board's or a Character's change", async () => {
    render(<PresetLibrary onApply={() => {}} onSaveCurrent={() => {}} onClose={() => {}} reloadKey={0} />);
    await screen.findByText('Neon noir');
    const calls = presets.fetchPresets.mock.calls.length;
    emit({ type: 'storedAssetChanged', kind: 'moodboard', id: 'b1', deleted: false });
    expect(presets.fetchPresets.mock.calls.length).toBe(calls);
  });
});
