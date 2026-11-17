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

  it('a failed save says "Not saved" beside a Try again button, and the because line is the button\'s title and accessible description', () => {
    const retry = vi.fn(async () => {});
    const retrySave = vi.fn(async () => {});
    const line = 'Nebula couldn’t save the project because the server didn’t respond. Try again.';
    useProjectStore.setState({ saveStatus: 'error', error: 'Nebula couldn’t rename the project because the server didn’t respond. Try again.',
      saveError: line, retry, retrySave } as never);
    render(<ProjectWorkspaceControls />);
    // The header's visible words are the two short ones; the sentence is not in the page text.
    expect(screen.getByText('Not saved')).toBeTruthy();
    expect(screen.queryByText(line, { ignore: '[hidden]' })).toBeNull();
    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button.textContent).toBe('Try again');
    expect(button.getAttribute('title')).toBe(line);
    // A title is not read by every screen reader and never shows on touch: the same line describes the button.
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(line);
    fireEvent.click(button);
    expect(retrySave).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('with no save line kept, the title still says what failed and ends in Try again', () => {
    useProjectStore.setState({ saveStatus: 'error', saveError: null, retrySave: vi.fn(async () => {}) } as never);
    render(<ProjectWorkspaceControls />);
    expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('title')).toBe('Nebula couldn’t save the project. Try again.');
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
