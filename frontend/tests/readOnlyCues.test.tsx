import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Round 14 of PR #114 (GM): offline is read-only, and that shows up front.
 * Fields are disabled (they don't take focus for typing), the library still
 * opens for browsing but its items show as disabled, and "Save failed ·
 * Retry" hides while offline (the banner says it).
 */

import { NodeLibrary } from '../src/components/panels/NodeLibrary';
import { ProjectWorkspaceControls } from '../src/components/projects/ProjectWorkspaceControls';
import { useReadOnlyFields } from '../src/hooks/useReadOnlyFields';
import { noteBackendConnection, resetBackendConnectionForTests, subscribeBlockedEdits } from '../src/lib/backendConnection';
import { useBackendOffline } from '../src/lib/useBackendOffline';
import { useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };
const INITIAL_PROJECT_STATE = { ...useProjectStore.getState() };

beforeEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
  useProjectStore.setState(INITIAL_PROJECT_STATE, true);
});
afterEach(() => vi.restoreAllMocks());

function Card({ alreadyDisabled = false }: { alreadyDisabled?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useReadOnlyFields(root, useBackendOffline());
  return (
    <div ref={root}>
      <textarea aria-label="Prompt" defaultValue="hi" />
      <select aria-label="Size" defaultValue="a"><option value="a">a</option></select>
      <input aria-label="Seed" disabled={alreadyDisabled} />
      <button type="button">View output</button>
    </div>
  );
}

describe('fields while offline', () => {
  it('are disabled while offline and enabled again on reconnect; buttons stay', () => {
    render(<Card />);
    expect(screen.getByLabelText('Prompt')).toBeEnabled();
    act(() => noteBackendConnection('offline'));
    expect(screen.getByLabelText('Prompt')).toBeDisabled();
    expect(screen.getByLabelText('Size')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'View output' })).toBeEnabled();
    act(() => noteBackendConnection('online'));
    expect(screen.getByLabelText('Prompt')).toBeEnabled();
    expect(screen.getByLabelText('Size')).toBeEnabled();
  });

  it('a field that was already disabled stays disabled after reconnect', () => {
    render(<Card alreadyDisabled />);
    act(() => noteBackendConnection('offline'));
    act(() => noteBackendConnection('online'));
    expect(screen.getByLabelText('Seed')).toBeDisabled();
  });

  it('a press on a disabled field asks the gate (the banner pulses)', () => {
    let blocked = 0;
    const stop = subscribeBlockedEdits(() => { blocked += 1; });
    render(<Card />);
    act(() => noteBackendConnection('offline'));
    fireEvent.pointerDown(screen.getByLabelText('Prompt'));
    expect(blocked).toBe(1);
    stop();
  });
});

describe('the library while offline', () => {
  it('still browses; its items show as disabled, don\'t drag, and a click adds nothing', () => {
    const addNode = vi.fn(async () => 'n1');
    useGraphStore.setState({ addNode });
    useUIStore.setState((state) => ({
      libraryCollapsed: { __nebulaLibraryInit: true, utility: false },
      panels: { ...state.panels, library: { ...state.panels.library, visible: true } },
    }));
    noteBackendConnection('offline');
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Browse Text nodes' }));
    const item = screen.getByRole('button', { name: 'Text Input' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('draggable', 'false');
    fireEvent.click(item);
    expect(addNode).not.toHaveBeenCalled();
  });
});

describe('the project bar while offline', () => {
  it('hides "Save failed · Retry" while offline and shows it again online', () => {
    useProjectStore.setState({ activeProject: { id: 'A', name: 'Harbor' } as never, screen: 'workspace',
      saveStatus: 'error', saveError: null } as never);
    render(<ProjectWorkspaceControls />);
    expect(screen.getByRole('button', { name: 'Save failed · Retry' })).toBeInTheDocument();
    act(() => noteBackendConnection('offline'));
    expect(screen.queryByRole('button', { name: 'Save failed · Retry' })).not.toBeInTheDocument();
    act(() => noteBackendConnection('online'));
    expect(screen.getByRole('button', { name: 'Save failed · Retry' })).toBeInTheDocument();
  });
});
