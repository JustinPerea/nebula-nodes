import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ModalPortal } from '../src/components/ModalPortal';

/**
 * Review 9, M-1: modals portalled from inside a node card (the Mesh and World
 * previews) bubbled their React events to the node: arrows on the preview's
 * Close moved the node, Enter selected it, Escape deselected it. Every modal
 * in the app now renders through one ModalPortal: on document.body, with
 * `nokey` (React Flow ignores keys from inside it) and clicks, double clicks
 * and context menus contained, so nothing inside acts on what is behind.
 * Nits a and b: a modal inside a hidden, inert or display:none ancestor
 * doesn't count, and the one on top is the last one opened.
 */

const SRC = join(__dirname, '..', 'src');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}
// A modal whose markup lives in one file and whose portal is its caller's.
const PORTALLED_BY: Record<string, string> = {
  'components/panels/MaskPainterModal.tsx': 'components/DeferredPanels.tsx',
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('every modal in the app renders through ModalPortal', () => {
  const modals = sources(SRC).filter((path) => /\saria-modal="true"/.test(readFileSync(path, 'utf8')));

  it('found the modals (a sanity floor)', () => {
    expect(modals.length).toBeGreaterThanOrEqual(14);
  });

  it.each(sources(SRC).filter((path) => /\saria-modal="true"/.test(readFileSync(path, 'utf8'))).map((path) => relative(SRC, path)))(
    '%s', (file) => {
      const text = readFileSync(join(SRC, file), 'utf8');
      const portal = PORTALLED_BY[file] ? readFileSync(join(SRC, PORTALLED_BY[file]), 'utf8') : text;
      expect(portal).toContain('<ModalPortal');
      expect(text).not.toMatch(/createPortal\(/);
    },
  );

  it('the command palette is one of them (review 9, L-1)', () => {
    expect(readFileSync(join(SRC, 'components/CommandPalette.tsx'), 'utf8')).toMatch(/\saria-modal="true"/);
  });
});

describe('ModalPortal', () => {
  it('renders on document.body, marked nokey, one layer per modal in the order they open', () => {
    render(<ModalPortal><div role="dialog" aria-modal="true" aria-label="first" /></ModalPortal>);
    render(<ModalPortal><div role="dialog" aria-modal="true" aria-label="second" /></ModalPortal>);
    const [first, second] = [...document.querySelectorAll('[aria-modal="true"]')];
    const layer = (el: Element) => Number(el.closest('[data-modal-layer]')?.getAttribute('data-modal-layer'));
    expect(first.closest('.nokey')).not.toBeNull();
    expect(first.closest('[data-modal-layer]')?.parentElement).toBe(document.body);
    expect(layer(second)).toBeGreaterThan(layer(first));
  });

  it("a click, double click or context menu inside never reaches the React parent behind it; keys still reach the window", () => {
    const parent = { click: vi.fn(), dbl: vi.fn(), menu: vi.fn() };
    const windowKey = vi.fn();
    window.addEventListener('keydown', windowKey);
    const { getByRole } = render(
      <div onClick={parent.click} onDoubleClick={parent.dbl} onContextMenu={parent.menu}>
        <ModalPortal><div role="dialog" aria-modal="true" aria-label="inside"><button type="button">Close</button></div></ModalPortal>
      </div>,
    );
    const close = getByRole('button', { name: 'Close' });
    fireEvent.click(close);
    fireEvent.doubleClick(close);
    fireEvent.contextMenu(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    window.removeEventListener('keydown', windowKey);
    expect(parent.click).not.toHaveBeenCalled();
    expect(parent.dbl).not.toHaveBeenCalled();
    expect(parent.menu).not.toHaveBeenCalled();
    expect(windowKey).toHaveBeenCalledOnce();
  });
});
