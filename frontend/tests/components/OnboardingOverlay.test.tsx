import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OnboardingOverlay } from '../../src/components/onboarding/OnboardingOverlay';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import { ONBOARDING_TOUR } from '../../src/lib/onboarding';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const originalOnboarded = localStorage.getItem('nebula:onboarded');
type Rect = { left: number; top: number; width: number; height: number };
const dimensions = new Map<string, Rect>();
let tooltipSize = { width: 320, height: 250 };
let workspace: HTMLDivElement;
let opener: HTMLButtonElement;
let previouslyInert: HTMLDivElement;
let observers: FakeResizeObserver[];

class FakeResizeObserver {
  readonly targets = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) { observers.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  notify() {
    this.callback([...this.targets].map((target) => ({ target, contentRect: target.getBoundingClientRect() })) as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

function rect(value: Rect): DOMRect {
  return { ...value, x: value.left, y: value.top, right: value.left + value.width, bottom: value.top + value.height,
    toJSON: () => value } as DOMRect;
}
function target(name: string): HTMLElement {
  const element = workspace.querySelector<HTMLElement>(`[data-onboarding-target="${name}"]`);
  if (!element) throw new Error(`Missing fixture target ${name}`);
  return element;
}
function tooltip(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.onboarding__tooltip');
  if (!element) throw new Error('Missing current tour tooltip');
  return element;
}
function spotlight(): HTMLElement | null { return document.querySelector('.onboarding__spotlight'); }
function notifyResize() { act(() => observers.forEach((observer) => observer.notify())); }
async function startTour() {
  fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
  await screen.findByRole('dialog', { name: ONBOARDING_TOUR[0].title });
  await waitFor(() => expect(spotlight()).not.toBeNull());
}

beforeEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState({ onboardingActive: false, hasOnboarded: false, onboardingStep: 0, viewMode: 'canvas' });
  localStorage.removeItem('nebula:onboarded');
  observers = [];
  dimensions.clear();
  tooltipSize = { width: 320, height: 250 };
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
  vi.stubGlobal('fetch', vi.fn());
  workspace = document.createElement('div');
  workspace.className = 'app';
  for (const [index, name] of ['nodes', 'settings', 'create', 'history', 'chat', 'help'].entries()) {
    const button = document.createElement('button');
    button.dataset.onboardingTarget = name;
    button.textContent = name;
    dimensions.set(name, { left: name === 'chat' ? 720 : 16, top: 70 + index * 65, width: 44, height: 44 });
    workspace.append(button);
  }
  opener = target('help') as HTMLButtonElement;
  opener.addEventListener('click', () => useUIStore.getState().startOnboarding());
  document.body.append(workspace);
  previouslyInert = document.createElement('div');
  previouslyInert.setAttribute('inert', '');
  previouslyInert.setAttribute('aria-hidden', 'true');
  document.body.append(previouslyInert);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.onboardingTarget) return rect(dimensions.get(this.dataset.onboardingTarget) ?? { left: 0, top: 0, width: 0, height: 0 });
    if (this.classList.contains('onboarding__tooltip')) return rect({ left: 0, top: 0, ...tooltipSize });
    return rect({ left: 0, top: 0, width: 0, height: 0 });
  });
  opener.focus();
  act(() => useUIStore.getState().startOnboarding());
});
afterEach(() => {
  cleanup();
  workspace.remove();
  previouslyInert.remove();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  if (originalOnboarded === null) localStorage.removeItem('nebula:onboarded');
  else localStorage.setItem('nebula:onboarded', originalOnboarded);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('optional onboarding that preserves work', () => {
  it('offers current safe welcome choices and never replaces the graph or starts a run', async () => {
    const load = vi.spyOn(useGraphStore.getState(), 'loadSampleGraph');
    const execute = vi.spyOn(useGraphStore.getState(), 'executeGraph');
    render(<OnboardingOverlay />);
    const dialog = screen.getByRole('dialog', { name: 'Welcome to Nebula Nodes' });
    expect(within(dialog).getByRole('button', { name: 'Take the tour' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Start browsing' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load a sample graph|Describe what you want/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start browsing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useUIStore.getState().leftDock).toBe('library');
    expect(useUIStore.getState().viewMode).toBe('canvas');
    expect(opener).toHaveFocus();
    expect(load).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows all five current controls, current catalog count and explicit-generation guidance', async () => {
    const graph = useGraphStore.getState();
    const load = vi.spyOn(graph, 'loadSampleGraph');
    const execute = vi.spyOn(graph, 'executeGraph');
    render(<OnboardingOverlay />);
    await startTour();
    expect(screen.getByRole('dialog', { name: ONBOARDING_TOUR[0].title })).toHaveTextContent(`${Object.keys(NODE_DEFINITIONS).length} nodes`);
    expect(document.body).not.toHaveTextContent('138 nodes');
    for (let index = 0; index < ONBOARDING_TOUR.length; index++) {
      const step = ONBOARDING_TOUR[index];
      const dialog = await screen.findByRole('dialog', { name: step.title });
      const control = target(step.target).getBoundingClientRect();
      await waitFor(() => expect(spotlight()).toHaveStyle({
        left: `${control.left}px`, top: `${control.top}px`, width: `${control.width}px`, height: `${control.height}px`,
      }));
      expect(dialog).toHaveTextContent(`Getting started · ${index + 1} of 5`);
      expect(target(step.target).getBoundingClientRect().width).toBeGreaterThan(0);
      if (index === 1) expect(dialog).toHaveTextContent('without generating');
      if (index === 2) expect(dialog).toHaveTextContent('Choose Generate');
      if (index === 3) expect(dialog).toHaveTextContent('Explicitly rerun');
      fireEvent.click(within(dialog).getByRole('button', { name: index === 4 ? 'Done' : 'Next' }));
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useGraphStore.getState().nodes).toBe(graph.nodes);
    expect(useGraphStore.getState().edges).toBe(graph.edges);
    expect(useGraphStore.getState().runHistory).toBe(graph.runHistory);
    expect(load).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('supports back, skip and repeated help without hidden authoring actions', async () => {
    render(<OnboardingOverlay />);
    await startTour();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('dialog', { name: ONBOARDING_TOUR[1].title });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: ONBOARDING_TOUR[0].title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Welcome to Nebula Nodes' })).toBeInTheDocument();
    expect(useUIStore.getState().onboardingStep).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('onboarding modal ownership', () => {
  it('wraps keyboard focus, captures Escape and restores its opener and prior inert state', async () => {
    const backgroundKeys = vi.fn();
    document.addEventListener('keydown', backgroundKeys);
    render(<OnboardingOverlay />);
    const first = screen.getByRole('button', { name: 'Take the tour' });
    const last = screen.getByRole('button', { name: 'Skip' });
    expect(workspace.closest('[inert]')).not.toBeNull();
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    backgroundKeys.mockClear();
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(backgroundKeys).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
    expect(workspace).not.toHaveAttribute('inert');
    expect(previouslyInert).toHaveAttribute('inert');
    expect(previouslyInert).toHaveAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', backgroundKeys);
  });

  it('contains focus after changing steps and suppresses workspace shortcuts', async () => {
    render(<OnboardingOverlay />);
    await startTour();
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toHaveFocus();
    fireEvent.click(next);
    await screen.findByRole('dialog', { name: ONBOARDING_TOUR[1].title });
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
    const backgroundKeys = vi.fn();
    document.addEventListener('keydown', backgroundKeys);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Next' }), { key: 'k', metaKey: true });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Next' }), { key: 'Enter', ctrlKey: true });
    expect(backgroundKeys).not.toHaveBeenCalled();
    document.removeEventListener('keydown', backgroundKeys);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('captures background keyboard events even when the browser has dropped card focus', () => {
    render(<OnboardingOverlay />);
    const first = screen.getByRole('button', { name: 'Take the tour' });
    const backgroundKeys = vi.fn();
    document.addEventListener('keydown', backgroundKeys);
    const shortcut = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent(document.body, shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(backgroundKeys).not.toHaveBeenCalled();
    expect(first).toHaveFocus();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(document, escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(backgroundKeys).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    document.removeEventListener('keydown', backgroundKeys);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prevents backdrop pointer-down focus loss while preserving card button interaction', () => {
    render(<OnboardingOverlay />);
    const first = screen.getByRole('button', { name: 'Take the tour' });
    const backdrop = document.querySelector('.onboarding__backdrop')!;
    const outside = new Event('pointerdown', { bubbles: true, cancelable: true });
    fireEvent(backdrop, outside);
    expect(outside.defaultPrevented).toBe(true);
    const inside = new Event('pointerdown', { bubbles: true, cancelable: true });
    fireEvent(first, inside);
    expect(inside.defaultPrevented).toBe(false);
    expect(first).toHaveFocus();
  });

  it('contains programmatic outside focus and isolates new portal siblings until dismissal', async () => {
    render(<OnboardingOverlay />);
    const first = screen.getByRole('button', { name: 'Take the tour' });
    opener.focus();
    expect(first).toHaveFocus();
    const laterPortal = document.createElement('div');
    laterPortal.setAttribute('aria-hidden', 'false');
    const outsideButton = document.createElement('button');
    outsideButton.textContent = 'Later background portal';
    laterPortal.append(outsideButton);
    document.body.append(laterPortal);
    try {
      await waitFor(() => {
        expect(laterPortal).toHaveAttribute('inert');
        expect(laterPortal).toHaveAttribute('aria-hidden', 'true');
      });
      outsideButton.focus();
      expect(first).toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
      expect(laterPortal).not.toHaveAttribute('inert');
      expect(laterPortal).toHaveAttribute('aria-hidden', 'false');
      expect(opener).toHaveFocus();
    } finally { laterPortal.remove(); }
  });

  it('returns an automatically started welcome to Help when there is no focusable opener', () => {
    opener.blur();
    expect(document.body).toHaveFocus();
    render(<OnboardingOverlay />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(opener).toHaveFocus();
  });

  it('returns to current Help if the original studio opener has unmounted', () => {
    const studioOpener = document.createElement('button');
    studioOpener.textContent = 'Help in Create';
    workspace.append(studioOpener);
    studioOpener.focus();
    render(<OnboardingOverlay />);
    studioOpener.remove();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(opener).toHaveFocus();
    expect(workspace).not.toHaveAttribute('inert');
  });

  it('cleans up inert background and restores focus when an active overlay unmounts', () => {
    const { unmount } = render(<OnboardingOverlay />);
    expect(workspace.closest('[inert]')).not.toBeNull();
    unmount();
    expect(workspace).not.toHaveAttribute('inert');
    expect(previouslyInert).toHaveAttribute('inert');
    expect(opener).toHaveFocus();
    expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);
  });
});

describe('onboarding geometry follows current controls', () => {
  it('updates the highlight and tooltip after target movement, ResizeObserver and scroll', async () => {
    render(<OnboardingOverlay />);
    await startTour();
    const beforeLeft = tooltip().style.left;
    dimensions.set('nodes', { left: 250, top: 220, width: 60, height: 44 });
    notifyResize();
    await waitFor(() => expect(tooltip().style.left).not.toBe(beforeLeft));
    const movedLeft = tooltip().style.left;
    dimensions.set('nodes', { left: 280, top: 250, width: 60, height: 44 });
    fireEvent.scroll(window);
    await waitFor(() => expect(tooltip().style.left).not.toBe(movedLeft));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('measures changing tooltip height and stays bounded in a compact viewport', async () => {
    dimensions.set('nodes', { left: 16, top: 320, width: 44, height: 44 });
    render(<OnboardingOverlay />);
    await startTour();
    const originalTop = tooltip().style.top;
    tooltipSize.height = 400;
    notifyResize();
    await waitFor(() => expect(tooltip().style.top).not.toBe(originalTop));
    vi.stubGlobal('innerWidth', 320);
    vi.stubGlobal('innerHeight', 240);
    fireEvent(window, new Event('resize'));
    await waitFor(() => {
      const left = Number.parseFloat(tooltip().style.left);
      const top = Number.parseFloat(tooltip().style.top);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThan(320);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThan(240);
    });
  });

  it('removes a stale highlight when its target disappears and follows a replacement target', async () => {
    render(<OnboardingOverlay />);
    await startTour();
    const original = target('nodes');
    original.remove();
    await waitFor(() => expect(spotlight()).toBeNull());
    const replacement = document.createElement('button');
    replacement.dataset.onboardingTarget = 'nodes';
    replacement.textContent = 'Replacement nodes control';
    dimensions.set('nodes', { left: 420, top: 280, width: 44, height: 44 });
    workspace.append(replacement);
    await waitFor(() => expect(spotlight()).not.toBeNull());
    expect(observers.some((observer) => observer.targets.has(replacement))).toBe(true);
    expect(observers.every((observer) => !observer.targets.has(original))).toBe(true);
  });
});
