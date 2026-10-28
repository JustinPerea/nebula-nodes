import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ProjectHome, type ProjectSummary } from '../src/components/projects/ProjectHome';

vi.mock('../src/lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

/**
 * GM r8/r9 ("Toasts wrap to 3 lines and never cut a sentence"), measured on
 * what renders, not on selector names (review 8 of PR #199, N-4): the
 * Projects home's toasts and notices are rendered with every stylesheet in
 * src applied, and each element that holds their text, and every element
 * around it up to the toast or notice, is checked through getComputedStyle
 * for anything that cuts text: an ellipsis, one line (nowrap / pre), a line
 * clamp, or hidden overflow under a fixed or maximum height. jsdom does no
 * layout, so the live check (catalog-build/fix8/live) measures the same
 * elements' scroll sizes in Chromium; this one runs in CI.
 */
const root = join(__dirname, '../src');
const sheets: string[] = [];
const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name);
  if (statSync(path).isDirectory()) walk(path); else if (name.endsWith('.css')) sheets.push(path); } };
walk(root);

beforeAll(() => {
  for (const file of sheets) {
    const style = document.createElement('style');
    style.dataset.file = file.slice(root.length + 1);
    style.textContent = readFileSync(file, 'utf8');
    document.head.appendChild(style);
  }
  // Every stylesheet in src is parsed here: generous for a loaded CI machine.
}, 120_000);
afterEach(cleanup);

const long = 'A canvas with a long name that should wrap onto the next line rather than be cut short';
const project = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z', lastOpenedAt: null,
  nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

/** Where text in `surface` could be cut: one entry per offending element. */
function cuts(surface: Element): string[] {
  const found: string[] = [];
  const holders = [...surface.querySelectorAll('*'), surface].filter((element) =>
    [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0)
    && !element.closest('button'));
  for (const holder of holders) {
    for (let element: Element | null = holder; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      const name = `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`;
      if (style.textOverflow === 'ellipsis') found.push(`${name}: text-overflow ellipsis`);
      if (/^(nowrap|pre)$/.test(style.whiteSpace)) found.push(`${name}: white-space ${style.whiteSpace}`);
      const clamp = style.getPropertyValue('-webkit-line-clamp') || style.getPropertyValue('line-clamp');
      if (clamp && clamp !== 'none') found.push(`${name}: line clamp ${clamp}`);
      const hidden = [style.overflow, style.overflowY, style.overflowX].some((value) => /hidden|clip/.test(value ?? ''));
      const boxed = (style.maxHeight && style.maxHeight !== 'none') || (style.height && style.height !== 'auto');
      if (hidden && boxed) found.push(`${name}: overflow hidden under height ${style.height || style.maxHeight}`);
      if (element === surface) break;
    }
  }
  return [...new Set(found)];
}

const surfaces = () => [...document.querySelectorAll('.project-home__toast, .project-home__notice')];

describe('no Projects home toast or notice cuts its text (rendered)', { timeout: 120_000 }, () => {
  it('applies the stylesheets it measures with', () => {
    render(<ProjectHome projects={[]} loading={false} busy={false} error={null} onCreate={vi.fn()} onOpen={vi.fn()}
      onRename={vi.fn()} onDelete={vi.fn()} onRetry={vi.fn()}
      canvasSaved={{ id: A, name: long }} />);
    // A rule from project-home.css reached the rendered toast: the measure
    // sees real styles, not defaults.
    const toast = document.querySelector('.project-home__toast')!;
    expect(getComputedStyle(toast).position).not.toBe('');
    expect(sheets.some((file) => file.endsWith('project-home.css'))).toBe(true);
  });

  it('every toast and notice, with long names', () => {
    render(<ProjectHome projects={[project(A, long), project(B, `${long} 2`)]} loading={false} busy={false} error={null}
      onCreate={vi.fn()} onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onRetry={vi.fn()}
      catalogRestore={{ id: 'r', kind: 'restored', source: 'catalog.json.bak', addedBack: [], addedBackCount: 0,
        notAddedBackCount: 0, damagedFile: '/x/catalog.json.damaged', damagedReadWhole: false,
        recoveredCanvas: { id: A, name: long }, alsoFiled: [{ id: B, name: `${long} 2`, overSaveLimit: true }] }}
      canvasHeldUnreadable={{ count: 2 }}
      canvasNotFiled={{ reason: 'projects', projectLimit: 500, canvases: [{ name: long }, { name: `${long} 3` }], deletes: 2 }}
      canvasSaved={{ id: B, name: `${long} 4`, another: true }}
      lastDeleted={{ id: 'c'.repeat(32), name: long, deletedAt: '2026-10-28T10:00:00Z' } as never} />);
    const all = surfaces();
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.flatMap((surface) => cuts(surface))).toEqual([]);
  });

  it('the held canvases\' notice alone, with its ×', () => {
    render(<ProjectHome projects={[]} loading={false} busy={false} error={null} onCreate={vi.fn()} onOpen={vi.fn()}
      onRename={vi.fn()} onDelete={vi.fn()} onRetry={vi.fn()} canvasHeldUnreadable={{ count: null }} />);
    expect(surfaces()).toHaveLength(1);
    expect(cuts(surfaces()[0])).toEqual([]);
  });

  it('catches a cut: a clamp, an ellipsis or a fixed box planted on the toast text', () => {
    const planted = document.createElement('style');
    planted.textContent = `.project-home__toast-text { -webkit-line-clamp: 2; overflow: hidden; max-height: 3em; text-overflow: ellipsis; }`;
    document.head.appendChild(planted);
    try {
      render(<ProjectHome projects={[]} loading={false} busy={false} error={null} onCreate={vi.fn()} onOpen={vi.fn()}
        onRename={vi.fn()} onDelete={vi.fn()} onRetry={vi.fn()} canvasSaved={{ id: A, name: long }} />);
      const found = cuts(document.querySelector('.project-home__toast')!);
      expect(found.some((line) => line.includes('line clamp'))).toBe(true);
      expect(found.some((line) => line.includes('ellipsis'))).toBe(true);
      expect(found.some((line) => line.includes('overflow hidden under height'))).toBe(true);
    } finally {
      planted.remove();
    }
  });
});
