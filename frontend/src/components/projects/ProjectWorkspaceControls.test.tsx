import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));

import { ProjectWorkspaceControls } from './ProjectWorkspaceControls';
import { useProjectStore } from '../../store/projectStore';

describe('ProjectWorkspaceControls', () => {
  const rename = vi.fn(async () => {});
  beforeEach(() => {
    rename.mockClear();
    useProjectStore.setState({
      screen: 'workspace', saveStatus: 'saved', busy: false, error: null, rename,
      activeProject: {
        id: 'glass', name: 'Glass campaign', createdAt: '', updatedAt: '', lastOpenedAt: null,
        nodeCount: 0, edgeCount: 0, thumbnail: null,
      },
    } as never);
  });

  it('renames the open project in place on double-click', () => {
    render(<ProjectWorkspaceControls />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Rename project Glass campaign' }));
    const input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: '  Glass launch ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(rename).toHaveBeenCalledWith('glass', 'Glass launch');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('ignores blank or unchanged names and cancels with Escape', () => {
    render(<ProjectWorkspaceControls />);
    const name = screen.getByRole('button', { name: 'Rename project Glass campaign' });
    fireEvent.keyDown(name, { key: 'F2' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.blur(screen.getByRole('textbox'));
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Rename project Glass campaign' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Other' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(rename).not.toHaveBeenCalled();
  });
});
