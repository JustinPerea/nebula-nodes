/**
 * Q118, GM - Design's layout and lines for "saving paused", verbatim:
 * - the header: "Saving paused · {size} MB" in the same warning colour as
 *   "Save failed", clickable, tooltip "This project is over the 16 MB save
 *   limit. Click to see what's large.";
 * - the notice's "See what's large" button opens the same panel;
 * - the panel: heading "Saving paused"; "This project is {size} MB. Make it
 *   {over} MB smaller and it saves again by itself. Until then, changes stay
 *   only in this tab."; "Download a copy"; "Largest first"; the top ten
 *   rows (the node's name as the canvas shows it, a dimmer part, the size
 *   right-aligned in MB to one decimal; no ids; a dimmer type for two nodes
 *   with one name); "{n} smaller items, {size} MB in all". Clicking a row
 *   selects the node and pans to it. Esc closes it, and focus goes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../types';

vi.mock('../../lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), subscribeFirst: vi.fn(), disconnect: vi.fn() },
}));

import { ProjectWorkspaceControls } from './ProjectWorkspaceControls';
import { ProjectSizePanel } from './ProjectSizePanel';
import { SavePausedNotice } from './SavePausedNotice';
import { useProjectStore } from '../../store/projectStore';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import { PROJECT_SAVE_LIMIT_BYTES } from '../../lib/projectSize';

const MIB = 1024 * 1024;
const initialProject = useProjectStore.getState();
const initialGraph = useGraphStore.getState();
const initialUI = useUIStore.getState();

function node(id: string, label: string, definitionId: string, value: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label, definitionId, params: { value }, state: 'idle', outputs: {} } };
}

beforeEach(() => {
  useProjectStore.setState({
    screen: 'workspace', saveStatus: 'paused', busy: false, error: null, dirty: true,
    savePaused: { bytes: Math.round(16.31 * MIB) }, sizePanelOpen: false, sizeNotice: null,
    activeProject: { id: 'glass', name: 'Glass campaign', createdAt: '', updatedAt: '', lastOpenedAt: null,
      nodeCount: 0, edgeCount: 0, thumbnail: null },
  } as never);
  const nodes = [
    node('n1', 'Brief', 'text-input', 'b'.repeat(Math.round(1.24 * MIB))),
    node('n2', 'Brief', 'llm-chat', 'c'.repeat(Math.round(0.6 * MIB))),
    node('n3', '', 'text-input', 'small'),
    ...Array.from({ length: 12 }, (_, index) => node(`m${index}`, `Note ${index}`, 'text-input', 'x'.repeat(100 + index))),
  ];
  useGraphStore.setState({ nodes, edges: [], runHistory: [] });
});
afterEach(() => {
  useProjectStore.setState(initialProject, true);
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
  vi.restoreAllMocks();
});

describe('the header', () => {
  it('reads "Saving paused · {size} MB" in the warning colour, with GM\'s tooltip, and opens the panel', () => {
    render(<ProjectWorkspaceControls />);
    const button = screen.getByRole('button', { name: 'Saving paused · 16.4 MB' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.className).toContain('project-workspace-controls__retry');
    expect(button.getAttribute('title')).toBe("This project is over the 16 MB save limit. Click to see what's large.");
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect((useProjectStore.getState() as never as { sizePanelOpen: boolean }).sizePanelOpen).toBe(true);
  });
});

describe('the notice', () => {
  it("has GM's line and its See what's large button opens the panel", () => {
    useProjectStore.setState({ sizeNotice: { id: 7, text: 'Saving paused. This project is 16.4 MB, over the 16 MB limit.', action: true } } as never);
    render(<SavePausedNotice />);
    const notice = screen.getByRole('status');
    expect(within(notice).getByText('Saving paused. This project is 16.4 MB, over the 16 MB limit.')).toBeTruthy();
    fireEvent.click(within(notice).getByRole('button', { name: "See what's large" }));
    expect((useProjectStore.getState() as never as { sizePanelOpen: boolean }).sizePanelOpen).toBe(true);
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect((useProjectStore.getState() as never as { sizeNotice: unknown }).sizeNotice).toBeNull();
  });

  it('"Saving again" has no button', () => {
    useProjectStore.setState({ sizeNotice: { id: 8, text: 'Saving again. This project is 15.9 MB.', action: false } } as never);
    render(<SavePausedNotice />);
    expect(screen.getByText('Saving again. This project is 15.9 MB.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: "See what's large" })).toBeNull();
  });
});

describe('the panel', () => {
  function open() {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    useProjectStore.setState({ sizePanelOpen: true } as never);
    const view = render(<ProjectSizePanel />);
    return { opener, view };
  }

  it("shows GM's heading, the live line, Download a copy and the largest rows of 0.1 MB and up, without ids", () => {
    const { opener } = open();
    const panel = screen.getByRole('dialog', { name: 'Saving paused' });
    expect(within(panel).getByRole('heading', { name: 'Saving paused' })).toBeTruthy();
    expect(within(panel).getByText('This project is 16.4 MB. Make it 0.4 MB smaller and it saves again by itself. Until then, changes stay only in this tab.')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Download a copy' })).toBeTruthy();
    expect(within(panel).getByText('Largest first')).toBeTruthy();
    const rows = within(panel).getAllByRole('button').filter((button) => button.closest('[data-size-row]'));
    // Only the two Briefs are 0.1 MB or more; the rest fold into one line (GM, #182).
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.textContent).not.toContain('0.0 MB');
    // The largest, by name as the canvas shows it, its part, its size.
    expect(rows[0].textContent).toContain('Brief');
    expect(rows[0].textContent).toContain('Text');
    expect(rows[0].textContent).toContain('1.2 MB');
    // Two nodes named "Brief": each gets its type, dimmer.
    expect(rows[0].querySelector('[data-size-type]')?.textContent).toBe('Text Input');
    expect(rows[1].querySelector('[data-size-type]')?.textContent).toBeTruthy();
    // No ids on screen.
    expect(panel.textContent).not.toMatch(/\bn1\b|\bm0\b/);
    // The rest, counted.
    // Thirteen small nodes and the project's settings.
    // Their total rounds to 0.0, so the line has no size (GM, #182: (b)).
    expect(within(panel).getByText('14 smaller items')).toBeTruthy();
    opener.remove();
  });

  it('a node with no title shows its type', () => {
    const { opener } = open();
    const panel = screen.getByRole('dialog', { name: 'Saving paused' });
    expect(panel.textContent).not.toContain('undefined');
    opener.remove();
  });

  it('clicking a row selects the node and pans to it', () => {
    const { opener } = open();
    const panel = screen.getByRole('dialog', { name: 'Saving paused' });
    const [first] = within(panel).getAllByRole('button').filter((button) => button.closest('[data-size-row]'));
    fireEvent.click(first);
    expect(useUIStore.getState().selectedNodeId).toBe('n1');
    expect(useUIStore.getState().canvasFocusRequest?.nodeId).toBe('n1');
    opener.remove();
  });

  it('Download a copy downloads the whole project', () => {
    const download = vi.fn(async () => {});
    useProjectStore.setState({ downloadProjectCopy: download } as never);
    const { opener } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Download a copy' }));
    expect(download).toHaveBeenCalledTimes(1);
    opener.remove();
  });

  it('Esc closes it and focus goes back where it came from', () => {
    const { opener, view } = open();
    const panel = screen.getByRole('dialog', { name: 'Saving paused' });
    expect(panel.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect((useProjectStore.getState() as never as { sizePanelOpen: boolean }).sizePanelOpen).toBe(false);
    view.rerender(<ProjectSizePanel />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('the size updates live', () => {
    const { opener } = open();
    act(() => { useProjectStore.setState({ savePaused: { bytes: PROJECT_SAVE_LIMIT_BYTES + 3 * MIB } } as never); });
    expect(screen.getByText('This project is 19.0 MB. Make it 3.0 MB smaller and it saves again by itself. Until then, changes stay only in this tab.')).toBeTruthy();
    opener.remove();
  });
});
