/**
 * Round 20 of PR #195 (GM - Design's follow-up of 2026-10-27, verbatim):
 * while the tab follows an agent's switch the project bar says "Opening
 * “<project>”…" in place of the save state, without changing width; Run is
 * disabled with "Wait for “<project>” to open."; and a failed handoff's line
 * offers "Open copy".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(), getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }),
  useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
    selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
  useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
}));

import { ProjectWorkspaceControls } from '../src/components/projects/ProjectWorkspaceControls';
import { Toolbar } from '../src/components/panels/Toolbar';
import { CanvasUndoNotice } from '../src/components/canvas/CanvasUndoNotice';
import { useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { EDITABLE_AREA, useFollowingReadOnly } from '../src/hooks/useFollowingReadOnly';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const initialProject = useProjectStore.getState();
const project = { id: 'alpha', name: 'Glass campaign', createdAt: '', updatedAt: '', lastOpenedAt: null, nodeCount: 1,
  edgeCount: 0, thumbnail: null };

beforeEach(() => {
  useProjectStore.setState({ activeProject: project as never, screen: 'workspace', saveStatus: 'unsaved' });
  useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Hero prompt', definitionId: 'text-input', params: { value: 'a' }, state: 'idle', outputs: {} } }],
  edges: [], isExecuting: false, undoNotice: null, messageNotice: null });
});
afterEach(() => {
  cleanup();
  resetCanvasFollowForTests();
  useProjectStore.setState(initialProject, true);
});

describe('the project bar while it follows', () => {
  it('"Opening “beta”…" in the name slot, in place of the old name and the save state (GM round 21, item 1)', () => {
    const { container } = render(<ProjectWorkspaceControls />);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    act(() => setFollowingSwitch({ projectName: 'beta', agent: 'Claude Code' }));
    const line = screen.getByRole('status', { name: 'Opening “beta”…' });
    expect(line.textContent).toBe('Opening “beta”…');
    expect(screen.queryByText('Glass campaign')).toBeNull();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.queryByText('Saved')).toBeNull();
    // The count of the canvas that is going gives its room to the line.
    expect(container.querySelector('.project-workspace-controls__count')).toBeNull();
    // The name is the part that is cut: the words around it never shrink.
    expect(container.querySelector('.project-workspace-controls__opening-name')?.textContent).toBe('beta');
    expect([...container.querySelectorAll('.project-workspace-controls__opening-fixed')].map((part) => part.textContent))
      .toEqual(['Opening “', '”…']);
    act(() => setFollowingSwitch(null));
    expect(screen.queryByRole('status', { name: 'Opening “beta”…' })).toBeNull();
    expect(screen.getByText('Glass campaign')).toBeInTheDocument();
  });

  it('the CSS cuts inside the name and never the quote or the ellipsis', () => {
    const css = readFileSync(resolve(__dirname, '../src/components/projects/ProjectWorkspaceControls.css'), 'utf8');
    expect(css).toMatch(/\.project-workspace-controls__opening-fixed \{ flex: 0 0 auto; \}/);
    expect(css).toMatch(/\.project-workspace-controls__opening-name \{[^}]*text-overflow: ellipsis;[^}]*\}/);
  });

  it('keeps the width it had', () => {
    const { container } = render(<ProjectWorkspaceControls />);
    const bar = container.querySelector('.project-workspace-controls') as HTMLElement;
    bar.getBoundingClientRect = () => ({ width: 214, height: 30, x: 0, y: 0, top: 0, left: 0, right: 214, bottom: 30, toJSON: () => ({}) });
    act(() => setFollowingSwitch({ projectName: 'a much longer project name than the bar holds', agent: 'Claude Code' }));
    expect(bar.style.width).toBe('214px');
    expect(bar.style.maxWidth).toBe('214px');
  });
});

describe('the node popover\'s Inspector while it follows (round 21, review 20 L-2)', () => {
  function Gate() {
    useFollowingReadOnly();
    return null;
  }
  it('is in the read-only area: its fields show disabled and typing is refused', () => {
    expect(EDITABLE_AREA.split(',').map((part) => part.trim())).toContain('.node-inspector-popover');
    const css = readFileSync(resolve(__dirname, '../src/styles/canvas-follow.css'), 'utf8');
    expect(css).toContain(':is(.react-flow, .panel--inspector, .node-inspector-popover) :is(input, textarea');
    render(<Gate />);
    const popover = document.createElement('div');
    popover.className = 'node-inspector-popover';
    const field = document.createElement('textarea');
    popover.appendChild(field);
    document.body.appendChild(popover);
    act(() => setFollowingSwitch({ projectName: 'beta', agent: 'Claude Code' }));
    expect(document.body).toHaveClass('nebula-following');
    const typing = new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'X', inputType: 'insertText' });
    field.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(true);
    const key = new KeyboardEvent('keydown', { key: 'X', bubbles: true, cancelable: true });
    field.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    popover.remove();
  });
});

describe('Run while it follows', () => {
  it('disabled, with the tooltip; a click sends nothing', () => {
    const run = vi.spyOn(useGraphStore.getState(), 'executeGraph');
    render(<Toolbar />);
    act(() => setFollowingSwitch({ projectName: 'beta', agent: 'Claude Code' }));
    const button = screen.getByRole('button', { name: /^Run/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('title', 'Wait for “beta” to open.');
    fireEvent.click(button);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the failed handoff's line", () => {
  it('offers Open copy, which opens the copy', () => {
    const open = vi.spyOn(useProjectStore.getState(), 'open').mockResolvedValue();
    useGraphStore.setState({ undoNotice: { id: 99, text: 'line', offer: null, tone: 'error', copy: { projectId: 'copy-1' } } });
    render(<CanvasUndoNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'Open copy' }));
    expect(open).toHaveBeenCalledWith('copy-1');
  });
});
