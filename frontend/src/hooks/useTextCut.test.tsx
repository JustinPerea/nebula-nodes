import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { WorkspaceHeader } from '../components/WorkspaceHeader';
import { CanvasTabs } from '../components/CanvasTabs';
import { CreateView } from '../components/create-studio/CreateView';
import { useUIStore } from '../store/uiStore';

// #213 review 1 NIT-6: a studio title cut with an ellipsis gets its full text
// as a tooltip; a whole one gets none.

const widths = { scroll: 120, client: 200 };
let resized: Array<() => void> = [];
const initialViewMode = useUIStore.getState().viewMode;

beforeEach(() => {
  Object.assign(widths, { scroll: 120, client: 200 });
  resized = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return widths.scroll; } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return widths.client; } });
  // Only an observer that observes something runs on a resize.
  vi.stubGlobal('ResizeObserver', class {
    cb: () => void;
    constructor(cb: () => void) { this.cb = cb; }
    observe() { resized.push(this.cb); }
    disconnect() { resized = resized.filter((run) => run !== this.cb); }
  });
});
afterEach(() => {
  cleanup();
  useUIStore.setState({ viewMode: initialViewMode });
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

describe('the studio title, cut in a narrow window', () => {
  it('a whole title has no tooltip; cut, its tooltip is the full title; whole again, none', () => {
    render(<WorkspaceHeader title="Moodboard Studio" updatesSlot={false} offlineRow={false} />);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.hasAttribute('title')).toBe(false);
    act(() => {
      widths.client = 80;
      for (const run of resized) run();
    });
    expect(title.getAttribute('title')).toBe('Moodboard Studio');
    act(() => {
      widths.client = 200;
      for (const run of resized) run();
    });
    expect(title.hasAttribute('title')).toBe(false);
  });
});

describe('the web font loading (#213 round 3c)', () => {
  it('a title the font widens past its box gets its tooltip once the font has loaded, with no resize', async () => {
    const listeners: Array<() => void> = [];
    let loaded: () => void = () => {};
    const ready = new Promise<void>((resolve) => { loaded = resolve; });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready, addEventListener: (_: string, run: () => void) => listeners.push(run), removeEventListener: vi.fn() },
    });
    try {
      render(<WorkspaceHeader title="Moodboard Studio" updatesSlot={false} offlineRow={false} />);
      const title = screen.getByRole('heading', { level: 1 });
      expect(title.hasAttribute('title')).toBe(false);
      widths.scroll = 240; // the font is wider than the fallback
      await act(async () => { loaded(); await ready; });
      expect(title.getAttribute('title')).toBe('Moodboard Studio');
      widths.scroll = 120; // a later font face loads narrower
      act(() => { for (const run of listeners) run(); });
      expect(title.hasAttribute('title')).toBe(false);
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });
});

describe('a screen-reader-only title gets no tooltip (#213 round 3c)', () => {
  it('a header with navigation: its hidden title has none, even cut', () => {
    widths.client = 1; // a visually hidden box is 1 px wide: always "cut"
    render(<WorkspaceHeader title="Creator Studio" navigation={<nav aria-label="Workspace" />} updatesSlot={false} offlineRow={false} />);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.hasAttribute('title')).toBe(false);
  });

  it('the Canvas header\'s h1 has no title', () => {
    widths.client = 1;
    useUIStore.setState({ viewMode: 'canvas' });
    render(<CanvasTabs />);
    const title = screen.getByRole('heading', { level: 1, name: 'Canvas' });
    expect(title.hasAttribute('title')).toBe(false);
  });

  it('the Creator Studio header\'s h1 has no title', () => {
    widths.client = 1;
    useUIStore.setState({ viewMode: 'create' });
    render(<CreateView />);
    const title = screen.getByRole('heading', { level: 1, name: 'Creator Studio' });
    expect(title.hasAttribute('title')).toBe(false);
  });
});
