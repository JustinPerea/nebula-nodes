/**
 * The trash says "moodboard" in every person line, counted or not (design, copy
 * sweep), and a moodboard's home line says "This moodboard is …".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const trash = vi.hoisted(() => ({ fetchTrash: vi.fn() }));
vi.mock('../src/lib/trash', async (original) => ({
  ...await original<typeof import('../src/lib/trash')>(),
  fetchTrash: (...args: unknown[]) => trash.fetchTrash(...args),
}));

import { RecentlyDeletedAssets } from '../src/components/asset-trash/AssetTrash';
import { whereItLives } from '../src/lib/assetHome';

const item = (id: string) => ({ kind: 'moodboard', id, name: `Coast ${id}`, deletedAt: '2026-11-16T10:00:00Z' });

afterEach(() => { cleanup(); trash.fetchTrash.mockReset(); });

describe('the moodboard trash', () => {
  const open = async (items: ReturnType<typeof item>[]) => {
    trash.fetchTrash.mockResolvedValue(items);
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: /Recently deleted/ }));
  };

  it('names the list, its note and the one-item confirm "moodboard"', async () => {
    await open([item('a')]);
    expect(screen.getByLabelText('Recently deleted moodboards')).toBeTruthy();
    expect(screen.getByText('Deleted moodboards stay here until you delete them for good.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
    expect(screen.getByText('Delete this moodboard for good?')).toBeTruthy();
  });

  it('a count reads "moodboards"', async () => {
    await open([item('a'), item('b')]);
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
    expect(screen.getByText('Delete all 2 moodboards for good?')).toBeTruthy();
  });
});

describe('where a moodboard lives', () => {
  it('says "This moodboard is …" for each home', () => {
    expect(whereItLives('moodboard', { scope: 'global' })).toBe('This moodboard is Global.');
    expect(whereItLives('moodboard', { scope: 'project', here: true })).toBe('This moodboard is in this project.');
    expect(whereItLives('moodboard', { scope: 'project', here: false, projectName: 'Atlas' })).toBe('This moodboard is in Atlas.');
  });
});
