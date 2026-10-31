/**
 * Round 17 of PR #199 (GM r24): when Save as a project lands on Projects
 * (the copy didn't open), the home's notice that confirms the save names the
 * copy, then says the connection its rules left out, in the tab's words.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps } from './ProjectHome';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));
vi.mock('../../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), notePersonAct: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}),
    subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));

const base = { projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } satisfies ProjectHomeProps;

describe('GM r24 on PR #199: Save as a project landed on Projects', () => {
  it('the saved toast, then the left-out connection as its second sentence', () => {
    const dropped = 'Nebula left out the connection from “Hero prompt” to “Seedream 4.5” because the same connection was already there.';
    render(<ProjectHome {...base} editsRecoveredAs={{ id: 'p', name: 'Recovered Delta', dropped }} />);
    expect(screen.getByText(`Your latest edits were saved as their own project, “Recovered Delta”. ${dropped}`)).toBeTruthy();
  });

  it('nothing left out: the toast alone', () => {
    render(<ProjectHome {...base} editsRecoveredAs={{ id: 'p', name: 'Recovered Delta' }} />);
    expect(screen.getByText('Your latest edits were saved as their own project, “Recovered Delta”.')).toBeTruthy();
  });
});
