import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NodeInspectorPopover } from '../../src/components/panels/NodeInspectorPopover';
import { WorkspaceRail } from '../../src/components/WorkspaceRail';
import { useUIStore, type LeftDock } from '../../src/store/uiStore';

vi.mock('../../src/components/panels/Inspector', () => ({
  Inspector: () => {
    const nodeId = useUIStore((s) => s.selectedNodeId);
    return <><label>Unavailable parameter<input disabled defaultValue="Unavailable" /></label>
      <label>Prompt<input defaultValue="A logo" /></label><output>{nodeId}</output></>;
  },
}));

let previousUi: ReturnType<typeof useUIStore.getState>;
let nextRaf: number;
let callbacks: Map<number, FrameRequestCallback>;
let drawerExtraWidth: number;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function railRect() {
  const compact = window.innerWidth <= 700;
  return rect(compact ? 8 : 16, 8, compact ? 48 : 56, Math.min(426, window.innerHeight - 16));
}

function drawerRect() {
  const compact = window.innerWidth <= 700;
  const left = compact ? 64 : 84;
  const width = compact ? window.innerWidth - left - 8 : Math.min(360, Math.max(280, window.innerWidth * 0.24));
  return rect(left, compact ? 8 : 16, width + drawerExtraWidth, window.innerHeight - (compact ? 148 : 32));
}

// Render the same shared footprint for each real rail destination, without
// loading provider accounts or making media/history/settings API requests.
function DrawerFixture() {
  const dock = useUIStore((s) => s.leftDock);
  if (!dock) return null;
  return <div className={`panel panel--${dock} workspace-dock-panel`} ref={(element) => {
    if (element) element.getBoundingClientRect = drawerRect;
  }} data-testid="active-drawer">
    <span>{dock}</span>
    <button onClick={() => useUIStore.getState().setLeftDock(null)}>Close active drawer</button>
  </div>;
}

function advanceLayout() {
  act(() => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

function viewport(width: number, height: number) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  fireEvent(window, new Event('resize'));
}

function renderWorkbench(width = 1280, height = 720) {
  viewport(width, height);
  const result = render(<><WorkspaceRail /><DrawerFixture /><NodeInspectorPopover /></>);
  const rail = screen.getByRole('navigation', { name: 'Workspace navigation' });
  rail.getBoundingClientRect = railRect;
  advanceLayout();
  return result;
}

function panel() {
  return document.querySelector<HTMLDivElement>('.node-inspector-popover')!;
}

function panelBounds() {
  const { style } = panel();
  const left = parseFloat(style.left);
  const top = parseFloat(style.top);
  const width = parseFloat(style.width);
  const height = parseFloat(style.height);
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function expectClearNavigation() {
  const bounds = panelBounds();
  expect(bounds.left).toBeGreaterThan(railRect().right);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
}

beforeEach(() => {
  previousUi = useUIStore.getState();
  nextRaf = 0;
  callbacks = new Map();
  drawerExtraWidth = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextRaf, callback);
    return nextRaf;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  useUIStore.getState().setLeftDock(null);
  useUIStore.getState().selectNode('n1');
  useUIStore.getState().setInspectorPinned(true);
});

afterEach(() => {
  cleanup();
  useUIStore.setState(previousUi, true);
  document.querySelectorAll('[data-node-inspector-anchor]').forEach((element) => element.remove());
  vi.unstubAllGlobals();
});

describe('Pinned Inspector navigation clearance', () => {
  it('resumes keyboard editing in the first enabled parameter after a completed picker loses focus', () => {
    useUIStore.getState().setInspectorVisible(false);
    renderWorkbench();
    const pickerChoice = document.createElement('button');
    pickerChoice.textContent = 'Prepare video';
    document.body.append(pickerChoice);
    pickerChoice.focus();
    const anchor = document.createElement('button');
    anchor.dataset.nodeInspectorAnchor = 'new-video';
    anchor.getBoundingClientRect = () => rect(140, 100, 200, 160);
    document.body.append(anchor);
    act(() => {
      pickerChoice.remove();
      useUIStore.getState().selectNode('new-video');
      useUIStore.getState().setInspectorVisible(true);
    });
    expect(document.activeElement).toBe(document.body);
    advanceLayout();
    expect(screen.getByRole('textbox', { name: 'Unavailable parameter' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus();
    expect(screen.getByText('new-video')).toBeVisible();
  });

  it('preserves an active navigation control when Inspector opens, changes selection, or reflows', () => {
    useUIStore.getState().setInspectorVisible(false);
    renderWorkbench();
    const activeControl = screen.getByRole('button', { name: 'Open assets' });
    activeControl.focus();
    act(() => useUIStore.getState().setInspectorPinned(true));
    advanceLayout();
    expect(activeControl).toHaveFocus();
    act(() => useUIStore.getState().selectNode('n2'));
    advanceLayout();
    expect(screen.getByText('n2')).toBeVisible();
    expect(activeControl).toHaveFocus();
    viewport(800, 300);
    advanceLayout();
    expect(activeControl).toHaveFocus();
    expectClearNavigation();
  });

  it.each([[1280, 720], [800, 300]])('keeps navigation and Inspector controls reachable at %sx%s', (width, height) => {
    renderWorkbench(width, height);
    expectClearNavigation();
    expect(panel()).not.toHaveAttribute('hidden');
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close inspector' })).toBeVisible();
    expect(panel().querySelector('.node-inspector-popover__body')).toBeTruthy();
  });

  it.each<[LeftDock, string]>([
    ['library', 'Add nodes'], ['assets', 'Open assets'],
    ['history', 'Open run history'], ['settings', 'Open settings'],
  ])('keeps %s and its rail control reachable in a short window', (dock, name) => {
    renderWorkbench(800, 300);
    const control = screen.getByRole('button', { name });
    control.focus();
    fireEvent.click(control);
    advanceLayout();
    expect(useUIStore.getState().leftDock).toBe(dock);
    expect(document.activeElement).toBe(control);
    expect(panel()).not.toHaveAttribute('hidden');
    expect(panelBounds().left).toBeGreaterThan(drawerRect().right);
    expectClearNavigation();
    fireEvent.click(screen.getByRole('button', { name: 'Close active drawer' }));
    advanceLayout();
    expectClearNavigation();
    expect(useUIStore.getState().selectedNodeId).toBe('n1');
    expect(useUIStore.getState().inspectorPinned).toBe(true);
  });

  it('reflows with drawer geometry and viewport changes without losing focus, fields, or selection', () => {
    renderWorkbench();
    const input = screen.getByRole('textbox', { name: 'Prompt' });
    input.focus();
    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    act(() => useUIStore.getState().setLeftDock('history'));
    advanceLayout();
    const leftBeforeResize = panelBounds().left;
    drawerExtraWidth = 50;
    advanceLayout();
    expect(panelBounds().left).toBeGreaterThan(leftBeforeResize);
    expect(panelBounds().left).toBeGreaterThan(drawerRect().right);
    viewport(800, 300);
    advanceLayout();
    expectClearNavigation();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBe(input);
    expect(input).toHaveValue('Keep this draft');
    expect(document.activeElement).toBe(input);
    act(() => useUIStore.getState().selectNode('n2'));
    advanceLayout();
    expect(screen.getByText('n2')).toBeVisible();
    expect(document.activeElement).toBe(input);
    expect(useUIStore.getState().inspectorPinned).toBe(true);
  });

  it('yields to covering drawers and restores the same mounted fields when dismissed by keyboard', () => {
    renderWorkbench(600, 300);
    const inspector = panel();
    const input = screen.getByRole('textbox', { name: 'Prompt' });
    fireEvent.change(input, { target: { value: 'An unfinished prompt' } });
    for (const name of ['Add nodes', 'Open assets', 'Open run history', 'Open settings']) {
      const control = screen.getByRole('button', { name });
      control.focus();
      fireEvent.click(control);
      advanceLayout();
      expect(panel()).toBe(inspector);
      expect(panel()).toHaveAttribute('hidden');
      expect(panel()).toHaveAttribute('inert');
      expect(screen.queryByRole('textbox', { name: 'Prompt' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Close active drawer' })).toBeVisible();
      expect(document.activeElement).toBe(control);
      expect(useUIStore.getState().selectedNodeId).toBe('n1');
      expect(useUIStore.getState().inspectorPinned).toBe(true);
    }
    fireEvent.keyDown(document, { key: 'Escape' });
    advanceLayout();
    expect(useUIStore.getState().leftDock).toBeNull();
    expect(panel()).toBe(inspector);
    expect(panel()).not.toHaveAttribute('hidden');
    expect(panel()).not.toHaveAttribute('inert');
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBe(input);
    expect(input).toHaveValue('An unfinished prompt');
    expectClearNavigation();
  });

  it('clamps dragging clear of navigation and preserves the user position across node and drawer changes', () => {
    renderWorkbench();
    const header = panel().querySelector('.node-inspector-popover__header')!;
    fireEvent.mouseDown(header, { button: 0, clientX: 100, clientY: 300 });
    fireEvent.mouseMove(window, { clientX: -500, clientY: 1000 });
    fireEvent.mouseUp(window);
    advanceLayout();
    expectClearNavigation();
    const beforeDrag = panelBounds();
    fireEvent.mouseDown(header, { button: 0, clientX: beforeDrag.left + 20, clientY: beforeDrag.top + 10 });
    fireEvent.mouseMove(window, { clientX: 670, clientY: 150 });
    fireEvent.mouseUp(window);
    advanceLayout();
    const moved = panelBounds();
    expect(moved.left).toBeGreaterThan(beforeDrag.left);
    act(() => useUIStore.getState().selectNode('n2'));
    advanceLayout();
    act(() => useUIStore.getState().setLeftDock('assets'));
    advanceLayout();
    expect(panelBounds()).toEqual(moved);
    viewport(800, 300);
    advanceLayout();
    expectClearNavigation();
    expect(panelBounds().left).toBeGreaterThan(drawerRect().right);
    viewport(1280, 720);
    advanceLayout();
    expect(panelBounds()).toEqual(moved);
  });

  it('retains native resize preferences while bounding the full panel after a viewport or drawer change', () => {
    renderWorkbench(1280, 800);
    panel().style.width = '450px';
    panel().style.height = '500px';
    advanceLayout();
    expect(panelBounds().width).toBe(450);
    expect(panelBounds().height).toBe(500);
    viewport(800, 300);
    advanceLayout();
    act(() => useUIStore.getState().setLeftDock('library'));
    advanceLayout();
    expect(panelBounds().left).toBeGreaterThan(drawerRect().right);
    expectClearNavigation();
    expect(panelBounds().width).toBeLessThan(450);
    expect(panelBounds().height).toBeLessThan(500);
    expect(parseFloat(panel().style.maxWidth)).toBeLessThanOrEqual(window.innerWidth - panelBounds().left);
    expect(parseFloat(panel().style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - panelBounds().top);
    act(() => useUIStore.getState().setLeftDock(null));
    viewport(1280, 800);
    advanceLayout();
    expect(panelBounds().width).toBe(450);
    expect(panelBounds().height).toBe(500);
    expectClearNavigation();
  });

  it('continues to unpin onto the selected node anchor and close without clearing selection', () => {
    renderWorkbench();
    const anchor = document.createElement('button');
    anchor.dataset.nodeInspectorAnchor = 'n1';
    anchor.getBoundingClientRect = () => rect(140, 100, 200, 160);
    document.body.append(anchor);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin inspector' }));
    advanceLayout();
    expect(useUIStore.getState().inspectorPinned).toBe(false);
    expect(panel()).toHaveAttribute('data-placement', 'right');
    expect(panelBounds().left).toBeGreaterThan(anchor.getBoundingClientRect().right);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(document.querySelector('.node-inspector-popover')).toBeNull();
    expect(useUIStore.getState().selectedNodeId).toBe('n1');
    expect(callbacks.size).toBe(0);
  });

  it('stops geometry tracking when unmounted', () => {
    const workbench = renderWorkbench();
    expect(callbacks.size).toBe(1);
    workbench.unmount();
    expect(callbacks.size).toBe(0);
  });
});
