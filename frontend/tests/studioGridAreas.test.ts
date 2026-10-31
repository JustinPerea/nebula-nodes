import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import selectorParser from 'postcss-selector-parser';
import { appRules, cascaded, mediaMatches, selectorSpecificity, type Viewport } from './helpers/cssCascade';

// fix/moodboard-board-layout: PR #198 added the studios' offline row with one
// generic template in styles/workspace-header.css,
//   body.app-slava-restraint .character-studio-view.character-studio-view,
//   body.app-slava-restraint .moodboard-studio-view.moodboard-studio-view
//   { grid-template-areas: "toolbar toolbar" "offline offline" "rail main" }
// at (0,3,1). It also matched Moodboard Studio's Board view and beat that
// view's own three-column template (moodboard-board.css, `html body`, (0,2,2)):
// the canvas ("board") and the side panel ("panel") named areas the winning
// template didn't have and fell into implicit tracks, so at 1000 px the
// toolbar was one column wide and "Moodboard" wrapped a letter a line.
//
// Each studio's grid is now written once, offline row included, in the
// studio's own stylesheet; the Board view's template is the only one that
// matches it (the List view's is :not(--board)). Two checks hold that:
//  1. Ownership: only a studio's own stylesheet sets a grid template on its
//     root, and a Moodboard Studio template names its variant.
//  2. Resolution: for every studio and variant, under the Slava skin and with
//     the skin class removed, at 1000, 1440 and 1600 px (and 700 px for the
//     narrow layouts), the template that wins in the cascade (helpers/cssCascade)
//     has a named area for every child that names one, as many tracks as its
//     areas have rows and columns, and no child left to auto-placement.
// The live check (docs/notes/2026-10-31-fix-moodboard-board-layout.md) reads
// the same in a real browser from getComputedStyle.

const SRC = join(__dirname, '..', 'src');
const source = (path: string) => readFileSync(join(SRC, path), 'utf8');

type Child = { tag: string; cls: string };
interface Studio {
  name: string;
  root: string;
  /** The stylesheets allowed to set this root's grid template. */
  owners: string[];
  /** The component that renders the root and its direct children (each class is checked there). */
  component: string[];
  children: Child[];
  /** Laid out as a grid even with the skin class removed (the Board view's rules are unscoped). */
  gridWithoutSkin?: boolean;
}

const header = (cls: string): Child => ({ tag: 'header', cls: `workspace-header workspace-header--updates-slot ${cls}` });
const offline: Child = { tag: 'div', cls: 'studio-offline-row' };

// The direct children of each root as the app renders them (the live check's
// dump at 1440 px; each class is also looked up in its component below).
const STUDIOS: Studio[] = [
  {
    name: 'Moodboard Studio, Board view', root: 'moodboard-studio-view moodboard-studio-view--board',
    owners: ['styles/moodboard-board.css'], component: ['components/moodboard-studio/MoodboardStudioView.tsx', 'components/moodboard-studio/BoardSidePanel.tsx'],
    children: [header('moodboard-studio-toolbar'), offline, { tag: 'aside', cls: 'moodboard-studio-view__rail' },
      { tag: 'main', cls: 'moodboard-studio-view__board' }, { tag: 'aside', cls: 'moodboard-board-panel' }],
    gridWithoutSkin: true,
  },
  {
    name: 'Moodboard Studio, List view', root: 'moodboard-studio-view',
    owners: ['styles/moodboard-studio.css'], component: ['components/moodboard-studio/MoodboardStudioView.tsx'],
    children: [header('moodboard-studio-toolbar'), offline, { tag: 'aside', cls: 'moodboard-studio-view__rail' },
      { tag: 'main', cls: 'moodboard-studio-view__main' }],
  },
  {
    name: 'Character Studio', root: 'character-studio-view',
    owners: ['styles/character-studio.css'], component: ['components/character-studio/CharacterStudioView.tsx', 'components/character-studio/CharacterStudioToolbar.tsx'],
    children: [header('character-studio-toolbar character-studio-view__header'), offline,
      { tag: 'aside', cls: 'character-studio-view__rail' }, { tag: 'main', cls: 'character-studio-view__main' }],
  },
  {
    name: 'Commons', root: 'commons-view commons-scope',
    owners: ['styles/commons.css'], component: ['components/commons/CommonsView.tsx', 'components/commons/CommonsDetail.tsx', 'components/commons/CommonsFilters.tsx'],
    children: [header('commons-toolbar'), offline, { tag: 'div', cls: 'commons-messages' }, { tag: 'section', cls: 'commons-candidates' },
      { tag: 'aside', cls: 'commons-filters' }, { tag: 'main', cls: 'commons-main' }],
  },
  {
    name: 'Commons with a reference open', root: 'commons-view commons-scope commons-view--detail',
    owners: ['styles/commons.css'], component: ['components/commons/CommonsView.tsx', 'components/commons/CommonsDetail.tsx', 'components/commons/CommonsFilters.tsx'],
    children: [header('commons-toolbar'), offline, { tag: 'aside', cls: 'commons-filters' }, { tag: 'main', cls: 'commons-main' },
      { tag: 'aside', cls: 'commons-detail' }],
  },
  {
    name: 'Create', root: 'create-view',
    owners: ['styles/create-studio.css'], component: ['components/create-studio/CreateView.tsx'],
    children: [header('create-view__topbar'), offline, { tag: 'div', cls: 'create-view__stage' }, { tag: 'div', cls: 'create-view__composer-area' }],
  },
  {
    name: 'Cinema', root: 'cinema-studio-view',
    owners: ['styles/cinema-studio.css'], component: ['components/cinema-studio/CinemaStudioView.tsx', 'components/cinema-studio/CinemaStudioToolbar.tsx'],
    children: [header('cinema-studio-toolbar cinema-studio-view__header'), offline, { tag: 'div', cls: 'cinema-studio-view__body' }],
  },
  {
    name: 'Composition', root: 'remotion-editor-view',
    owners: ['styles/remotion-editor.css'], component: ['components/video-editor/RemotionEditorView.tsx'],
    children: [header('remotion-editor-view__header'), offline, { tag: 'div', cls: 'remotion-editor-view__toolbar' },
      { tag: 'div', cls: 'remotion-editor-view__player' }, { tag: 'div', cls: 'remotion-editor-view__panel' },
      { tag: 'div', cls: 'remotion-editor-view__timeline' }],
  },
  {
    name: 'Commons, Settings', root: 'commons-view commons-scope',
    owners: ['styles/commons.css'], component: ['components/commons/CommonsView.tsx', 'components/commons/CommonsFilters.tsx'],
    children: [header('commons-toolbar'), offline, { tag: 'aside', cls: 'commons-filters' }, { tag: 'main', cls: 'commons-main commons-main--settings' }],
  },
  {
    name: 'Composition with no node', root: 'remotion-editor-view',
    owners: ['styles/remotion-editor.css'], component: ['components/video-editor/RemotionEditorView.tsx'],
    children: [header('remotion-editor-view__header'), offline, { tag: 'div', cls: 'remotion-editor-view__empty-state' }],
  },
  {
    name: 'A studio that could not render', root: 'studio-boundary',
    owners: ['styles/workspace-header.css'], component: ['components/StudioBoundary.tsx'],
    children: [header('studio-boundary__header'), offline, { tag: 'div', cls: 'studio-boundary__body' }],
  },
];

const VIEWPORTS: Viewport[] = [1000, 1440, 1600, 700].map((width) => ({ width, height: 900 }));
const SKINS = [true, false];
const TEMPLATE_PROPS = new Set(['grid-template-areas', 'grid-template-rows', 'grid-template-columns', 'grid-template', 'grid']);

/** A track list's tracks, one per top-level token ("auto minmax(0, 1fr) var(--w)" is three). */
function trackCount(value: string): number {
  let depth = 0; let count = 0; let inToken = false;
  for (const ch of value.trim()) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) { inToken = false; continue; }
    if (!inToken) { count += 1; inToken = true; }
  }
  return count;
}

function build(studio: Studio): HTMLElement {
  const root = document.createElement('div');
  root.className = studio.root;
  for (const child of studio.children) {
    const el = document.createElement(child.tag);
    el.className = child.cls;
    root.appendChild(el);
  }
  document.body.appendChild(root);
  return root;
}

/** What's wrong with a studio's layout at one viewport and skin; empty when nothing is. */
function layoutProblems(studio: Studio, viewport: Viewport, slava: boolean): string[] {
  document.body.className = slava ? 'app-slava-restraint' : '';
  document.body.innerHTML = '';
  const root = build(studio);
  const own = cascaded(root, undefined, { viewport });
  const value = (prop: string) => own.get(`|${prop}`)?.value;
  const problems: string[] = [];
  const where = `${studio.name} at ${viewport.width} (${slava ? 'Slava' : 'no skin'})`;
  if (value('display') !== 'grid') {
    if (slava || studio.gridWithoutSkin) problems.push(`${where}: not a grid (display ${value('display') ?? 'unset'})`);
    return problems;
  }
  const areasText = value('grid-template-areas') ?? 'none';
  const areaRows = [...areasText.matchAll(/"([^"]*)"/g)].map((m) => m[1].trim().split(/\s+/));
  const names = new Set(areaRows.flat().filter((name) => name !== '.'));
  if (areaRows.length === 0) problems.push(`${where}: no grid-template-areas`);
  if (!names.has('offline')) problems.push(`${where}: no offline row in ${areasText} (${own.get('|grid-template-areas')?.selector})`);
  const rows = value('grid-template-rows');
  const columns = value('grid-template-columns');
  if (rows && trackCount(rows) !== areaRows.length) {
    problems.push(`${where}: ${trackCount(rows)} row tracks (${rows}) for ${areaRows.length} rows of areas ${areasText}`);
  }
  const width = areaRows[0]?.length ?? 1;
  if (areaRows.some((row) => row.length !== width)) problems.push(`${where}: ragged areas ${areasText}`);
  if ((columns ? trackCount(columns) : 1) !== width) {
    problems.push(`${where}: ${columns ? trackCount(columns) : 1} column tracks (${columns ?? 'none'}) for ${width} columns of areas ${areasText}`);
  }
  for (const child of [...root.children]) {
    const style = cascaded(child, undefined, { viewport });
    const get = (prop: string) => style.get(`|${prop}`)?.value;
    const label = child.className.split(' ').at(-1);
    if (get('display') === 'none' || get('position') === 'absolute' || get('position') === 'fixed') continue;
    const area = get('grid-area');
    const row = get('grid-row') ?? get('grid-row-start');
    if (area) {
      const name = area.split('/')[0].trim();
      if (/^-?\d|^span\b/.test(name)) continue;
      if (!names.has(name)) problems.push(`${where}: ${label} names "${name}", not an area of ${areasText} (${own.get('|grid-template-areas')?.selector})`);
    } else if (row) {
      const lines = row.split('/').map((part) => part.trim());
      const start = Number(lines[0]);
      if (!Number.isInteger(start) || start < 1 || start > areaRows.length) problems.push(`${where}: ${label} starts on row ${lines[0]} of ${areaRows.length}`);
    } else {
      problems.push(`${where}: ${label} names no area, so it is auto-placed`);
    }
  }
  return problems;
}

afterEach(() => {
  document.body.className = '';
  document.body.innerHTML = '';
});

describe('every studio names its offline row and every child in its own template', () => {
  for (const studio of STUDIOS) {
    it(`${studio.name}: under both skins, at 700-1600 px`, () => {
      const problems = VIEWPORTS.flatMap((viewport) => SKINS.flatMap((slava) => layoutProblems(studio, viewport, slava)));
      expect(problems).toEqual([]);
    });
  }

  it('each child the check builds is one the studio renders', () => {
    for (const studio of STUDIOS) {
      const text = studio.component.map(source).join('\n');
      for (const child of studio.children) {
        const own = child === offline ? 'StudioOfflineRow' : child.cls.split(' ').at(-1)!;
        if (child === offline) {
          expect(text, studio.name).toMatch(/<WorkspaceHeader|<SafeHeader/);
          expect(source('components/StudioOfflineRow.tsx')).toMatch(/className="studio-offline-row"/);
        } else {
          expect(text, `${studio.name}: ${own}`).toContain(own);
        }
      }
    }
  });
});

describe('only a studio\'s own stylesheet writes its grid template', () => {
  const roots = [...new Set(STUDIOS.map((studio) => studio.root.split(' ')[0]))];
  /** The last compound of a selector: the element the rule styles. */
  const subject = (selector: string) => {
    let last = selector;
    selectorParser((root) => {
      const nodes = root.first.nodes;
      let index = nodes.length - 1;
      while (index >= 0 && nodes[index].type !== 'combinator') index -= 1;
      last = nodes.slice(index + 1).join('');
    }).processSync(selector);
    return last;
  };

  it('a rule that sets a grid template on a studio root sits in that studio\'s stylesheet', () => {
    const strays: string[] = [];
    for (const rule of appRules()) {
      if (!rule.decls.some((decl) => TEMPLATE_PROPS.has(decl.prop))) continue;
      const target = subject(rule.selector);
      for (const root of roots) {
        if (!new RegExp(`\\.${root}(?![\\w-])`).test(target.replace(/:not\([^)]*\)/g, ''))) continue;
        const owners = STUDIOS.filter((studio) => studio.root.split(' ')[0] === root).flatMap((studio) => studio.owners);
        if (!owners.includes(rule.file)) strays.push(`${rule.file}: ${rule.selector}`);
      }
    }
    expect(strays).toEqual([]);
  });

  it('a Moodboard Studio template names its variant: the Board view\'s has --board, the List view\'s :not(--board)', () => {
    const wrong: string[] = [];
    for (const rule of appRules()) {
      if (!rule.decls.some((decl) => TEMPLATE_PROPS.has(decl.prop))) continue;
      const target = subject(rule.selector);
      if (!/\.moodboard-studio-view(?![\w-])/.test(target.replace(/:not\([^)]*\)/g, ''))) continue;
      const board = /\.moodboard-studio-view--board(?![\w-])/.test(target.replace(/:not\([^)]*\)/g, ''));
      const list = /:not\(\.moodboard-studio-view--board\)/.test(target);
      if (rule.file === 'styles/moodboard-board.css' ? !board : !list) wrong.push(`${rule.file}: ${rule.selector}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('helpers/cssCascade reads :is(), :not(), :where() and @media the way the browser does', () => {
  it('counts what comes after an :is(), :not() or :where()', () => {
    expect(selectorSpecificity('.a:where(.b) .c')).toEqual([0, 2, 0]);
    expect(selectorSpecificity(':is(.x):is(:disabled, .y)')).toEqual([0, 2, 0]);
    expect(selectorSpecificity('body.s .v:not(.v--board) > .c')).toEqual([0, 4, 1]);
    expect(selectorSpecificity('html body .v.v--board')).toEqual([0, 2, 2]);
    expect(selectorSpecificity('#id :is(.a, #b) p::before')).toEqual([2, 0, 2]);
  });

  it('applies an @media block only where its query holds', () => {
    const at = (width: number) => ({ width, height: 900 });
    expect(mediaMatches('(max-width: 760px)', at(700))).toBe(true);
    expect(mediaMatches('(max-width: 760px)', at(1000))).toBe(false);
    expect(mediaMatches('(max-width: 640px), (max-height: 540px)', at(1000))).toBe(false);
    expect(mediaMatches('(max-width: 640px), (max-height: 540px)', { width: 1000, height: 500 })).toBe(true);
    expect(mediaMatches('(prefers-reduced-motion: reduce)', at(1000))).toBe(false);
    expect(mediaMatches('(forced-colors: active)', at(1000))).toBe(false);
  });
});
