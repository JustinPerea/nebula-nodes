/**
 * PR #204 round 18h (GM r38 3a): every Commons line that ends "Try again." ends in a Try again
 * button that does it, the loaded-state lines too (Agent review's 5 s re-read keeps polling; the
 * button reads at once). Every Commons line goes through CommonsErrorLine, which renders the
 * button for a load's line when it is given `onRetry` (errorCopy retryStem). So:
 *
 * 1. Every <CommonsErrorLine> in src passes `onRetry`, except the few below, each with why.
 * 2. With `onRetry` a load line ending "Try again." has the button (the full stop after it, outside
 *    it); without `onRetry`, or for an action's line, it has none.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CommonsErrorLine } from '../src/components/commons/CommonsErrorLine';
import { resetLinesForTests } from '../src/lib/notConnectedLine';

const SRC = join(__dirname, '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
  return name.endsWith('.tsx') && !name.includes('.test.') ? [path] : [];
});

/** file → how many of its CommonsErrorLine may go without `onRetry`, and why. */
const NO_RETRY: Record<string, { count: number; why: string }> = {
  'components/commons/CommonsOffView.tsx': { count: 1, why: 'shows only the Commons-off line, which says to restart Nebula and never ends "Try again."' },
  'components/commons/CommonsCloseBatch.tsx': { count: 1, why: 'an action’s line only: a button there would send the close again; the person presses Close again' },
};

function linesWithoutRetry(source: string, name: string): number {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (node: ts.Node) => {
    const opening = ts.isJsxSelfClosingElement(node) ? node : ts.isJsxElement(node) ? node.openingElement : null;
    if (opening && opening.tagName.getText(sf) === 'CommonsErrorLine'
      && !opening.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'onRetry')) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

afterEach(() => { cleanup(); resetLinesForTests(); });

describe('every Commons line ending "Try again." has the button', () => {
  it('every CommonsErrorLine passes onRetry, but the listed few', () => {
    const found: Record<string, number> = {};
    for (const path of files(SRC)) {
      const missing = linesWithoutRetry(readFileSync(path, 'utf8'), path);
      if (missing) found[relative(SRC, path)] = missing;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(NO_RETRY).map(([file, { count }]) => [file, count])));
  });

  it('the scan sees a line without onRetry, and one with it', () => {
    expect(linesWithoutRetry('const a = <CommonsErrorLine line={x} />;', 'a.tsx')).toBe(1);
    expect(linesWithoutRetry('const a = <CommonsErrorLine line={x} onRetry={go} />;', 'a.tsx')).toBe(0);
    expect(linesWithoutRetry('const a = <CommonsErrorLine line={x}>{y}</CommonsErrorLine>;', 'a.tsx')).toBe(1);
  });

  const LOAD = 'Nebula couldn’t load Agent review because the server hit an error. Try again.';
  it('a load line with onRetry ends in the button, the full stop after it', () => {
    render(<CommonsErrorLine line={LOAD} onRetry={() => {}} />);
    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button.textContent).toBe('Try again');
    expect(button.nextSibling?.textContent).toBe('.');
  });

  it('without onRetry the same line has no button', () => {
    render(<CommonsErrorLine line={LOAD} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(document.querySelector('[data-commons-line]')?.textContent).toBe(LOAD);
  });

  it('an action’s line has no button even with onRetry (it would send the action again)', () => {
    render(<CommonsErrorLine line="Couldn’t save the settings. The server hit an error. Try again." onRetry={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('the Try again hand-off when its line goes (review 16 NIT-2 N6, N7)', () => {
  const LINE = 'Nebula couldn’t load the collections because the server didn’t respond. Try again.';
  const Page = ({ line }: { line: string | null }) => (
    <div className="commons-view">
      <h1 data-workspace-heading="" tabIndex={-1}>Commons</h1>
      <div className="commons-messages"><CommonsErrorLine line={line} onRetry={() => {}} /></div>
      <button type="button">Elsewhere</button>
    </div>
  );

  it('N6: a button without focus hands nothing on: focus that was elsewhere stays put', async () => {
    const view = render(<Page line={LINE} />);
    expect(document.activeElement).toBe(document.body);
    view.rerender(<Page line={null} />);
    await Promise.resolve();
    expect(document.activeElement).toBe(document.body);
  });

  it('N7: focus moved on before the hand-off runs is left where it went', async () => {
    const view = render(<Page line={LINE} />);
    screen.getByRole('button', { name: 'Try again' }).focus();
    view.rerender(<Page line={null} />);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('the button that had focus, its line gone: the heading', async () => {
    const view = render(<Page line={LINE} />);
    screen.getByRole('button', { name: 'Try again' }).focus();
    view.rerender(<Page line={null} />);
    await Promise.resolve();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Commons' }));
  });
});
