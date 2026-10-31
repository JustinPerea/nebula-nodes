import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import selectorParser from 'postcss-selector-parser';
import { readdirSync, statSync } from 'node:fs';
import {
  appRules, cascaded, declarationsOf, mediaMatches, selectorSpecificity, wins, type Viewport, type Winner,
} from './helpers/cssCascade';

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

/**
 * The widths to check (review 1 LOW-4): 700, 1000, 1440 and 1600, and both
 * sides of every min-width and max-width breakpoint the app's sheets use
 * (N and N+1 for a max-width N, N-1 and N for a min-width N), so a rule
 * that only holds between two sampled widths is still seen. Widths at which
 * the same set of @media queries holds lay out the same; one of each is kept.
 */
function viewports(): Viewport[] {
  const widths = new Set([700, 1000, 1440, 1600]);
  const queries = new Set(appRules().flatMap((rule) => rule.media));
  for (const query of queries) {
    for (const [, kind, n] of query.matchAll(/\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g)) {
      const at = Math.round(Number(n));
      if (kind === 'max') { widths.add(at); widths.add(at + 1); } else { widths.add(at - 1); widths.add(at); }
    }
  }
  const seen = new Map<string, Viewport>();
  for (const width of [...widths].sort((a, b) => a - b)) {
    const viewport = { width, height: 900 };
    const key = [...queries].filter((query) => mediaMatches(query, viewport)).sort().join('|');
    if (!seen.has(key)) seen.set(key, viewport);
  }
  return [...seen.values()];
}
const VIEWPORTS: Viewport[] = viewports();
const SKINS = [true, false];
const TEMPLATE_PROPS = new Set(['grid-template-areas', 'grid-template-rows', 'grid-template-columns', 'grid-template', 'grid']);

type Template = { areas?: string; rows?: string; columns?: string };

/** Split at top-level `/` (outside brackets, parentheses and quotes). */
function splitSlash(value: string): string[] {
  const parts: string[] = [];
  let depth = 0; let quote = false; let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '"') quote = !quote;
    else if (!quote && (ch === '(' || ch === '[')) depth += 1;
    else if (!quote && (ch === ')' || ch === ']')) depth -= 1;
    else if (!quote && depth === 0 && ch === '/') { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

/**
 * What a `grid-template` or `grid` value sets (review 1 MEDIUM-1): `none`;
 * `<rows> / <columns>`; or `"a b" <row size>? "c d" <row size>? / <columns>`.
 * A `grid` with `auto-flow` sets no template areas, and no explicit tracks on
 * its auto-flow side.
 */
function parseGridTemplate(value: string, shorthand: 'grid-template' | 'grid'): Template {
  const text = value.trim();
  if (text === 'none') return { areas: 'none', rows: 'none', columns: 'none' };
  const [left, right] = splitSlash(text);
  if (shorthand === 'grid' && /\bauto-flow\b/.test(text)) {
    return { areas: 'none', rows: /\bauto-flow\b/.test(left) ? 'none' : left, columns: /\bauto-flow\b/.test(right ?? '') ? 'none' : (right ?? 'none') };
  }
  if (left.includes('"')) {
    const areas: string[] = []; const rows: string[] = [];
    for (const [, area, size] of left.replace(/\[[^\]]*\]/g, ' ').matchAll(/"([^"]*)"\s*((?:[\w-]+\([^()]*(?:\([^()]*\)[^()]*)*\)|[^"\s]+))?/g)) {
      areas.push(`"${area.trim()}"`);
      rows.push(size ?? 'auto');
    }
    return { areas: areas.join(' '), rows: rows.join(' '), columns: right ?? 'none' };
  }
  return { areas: 'none', rows: left, columns: right ?? 'none' };
}

const LONGHANDS = { areas: 'grid-template-areas', rows: 'grid-template-rows', columns: 'grid-template-columns' } as const;

/**
 * The template that wins on `root`: each longhand against the `grid-template`
 * and `grid` shorthands that also set it, in cascade order. Two top
 * declarations from different sheets that tie (same importance and
 * specificity) are a problem: cssCascade orders sheets alphabetically, not
 * as the bundle does, so it must never decide a studio template (LOW-3).
 */
function resolveTemplate(root: Element, viewport: Viewport): { template: Template; from: Record<string, string>; ties: string[] } {
  const template: Template = {};
  const from: Record<string, string> = {};
  const ties: string[] = [];
  for (const [key, longhand] of Object.entries(LONGHANDS) as Array<[keyof Template, string]>) {
    const all: Array<Winner & { set: string }> = [
      ...declarationsOf(root, longhand, { viewport }).map((decl) => ({ ...decl, set: decl.value })),
      ...(['grid-template', 'grid'] as const).flatMap((shorthand) => declarationsOf(root, shorthand, { viewport })
        .map((decl) => ({ ...decl, set: parseGridTemplate(decl.value, shorthand)[key] ?? 'none' }))),
    ].sort((a, b) => (wins(a, b) ? 1 : -1));
    const winner = all.at(-1);
    const runner = all.at(-2);
    if (!winner) continue;
    template[key] = winner.set;
    from[key] = `${winner.file}: ${winner.selector}`;
    if (runner && runner.file !== winner.file && runner.important === winner.important
      && runner.specificity.join() === winner.specificity.join()) {
      ties.push(`${longhand} ties across sheets: ${runner.file} (${runner.selector}) and ${winner.file} (${winner.selector})`);
    }
  }
  return { template, from, ties };
}

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
  const { template, from, ties } = resolveTemplate(root, viewport);
  problems.push(...ties.map((tie) => `${where}: ${tie}`));
  const areasText = template.areas ?? 'none';
  const areaRows = [...areasText.matchAll(/"([^"]*)"/g)].map((m) => m[1].trim().split(/\s+/));
  const names = new Set(areaRows.flat().filter((name) => name !== '.'));
  if (areaRows.length === 0) problems.push(`${where}: no grid-template-areas`);
  if (!names.has('offline')) problems.push(`${where}: no offline row in ${areasText} (${from.areas})`);
  const rows = template.rows === 'none' ? undefined : template.rows;
  const columns = template.columns === 'none' ? undefined : template.columns;
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
      if (!names.has(name)) problems.push(`${where}: ${label} names "${name}", not an area of ${areasText} (${from.areas})`);
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

/** The last compound of a selector: the element the rule styles. */
function subject(selector: string): string {
  let last = selector;
  selectorParser((root) => {
    const nodes = root.first.nodes;
    let index = nodes.length - 1;
    while (index >= 0 && nodes[index].type !== 'combinator') index -= 1;
    last = nodes.slice(index + 1).join('');
  }).processSync(selector);
  return last;
}
/** The classes a subject carries, outside any :not(). */
const classesOf = (target: string) => [...target.replace(/:not\([^)]*\)/g, '').matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
/** A studio root's family: the class without its `--variant`. */
const family = (cls: string) => cls.replace(/--[\w-]+$/, '');
/** A class that names a view, a variant of one, or a scope (review 1 MEDIUM-2 (b)). */
const VIEWISH = /-view(?:--[\w-]+)?$|-scope$/;
/** Every family a studio root's classes belong to, with the sheets that own its template. */
const OWNERS = new Map<string, Set<string>>();
for (const studio of STUDIOS) {
  for (const cls of studio.root.split(' ')) {
    const owners = OWNERS.get(family(cls)) ?? new Set<string>();
    for (const owner of studio.owners) owners.add(owner);
    OWNERS.set(family(cls), owners);
  }
}
const SETS_TEMPLATE = (rule: { decls: Array<{ prop: string }> }) => rule.decls.some((decl) => TEMPLATE_PROPS.has(decl.prop));

describe('only a studio\'s own stylesheet writes its grid template', () => {
  it('a template rule on a studio root, any of its classes or variants, sits in that studio\'s sheet', () => {
    const strays: string[] = [];
    for (const rule of appRules()) {
      if (!SETS_TEMPLATE(rule)) continue;
      for (const cls of classesOf(subject(rule.selector))) {
        const owners = OWNERS.get(family(cls));
        if (owners && !owners.has(rule.file)) strays.push(`${rule.file}: ${rule.selector} (.${cls} belongs to ${[...owners].join(', ')})`);
      }
    }
    expect(strays).toEqual([]);
  });

  it('any other view or scope has its template in one sheet, and workspace-header.css writes none on a view', () => {
    const files = new Map<string, Set<string>>();
    const strays: string[] = [];
    for (const rule of appRules()) {
      if (!SETS_TEMPLATE(rule)) continue;
      for (const cls of classesOf(subject(rule.selector)).filter((name) => VIEWISH.test(name))) {
        if (rule.file === 'styles/workspace-header.css') strays.push(`${rule.file}: ${rule.selector}`);
        if (OWNERS.has(family(cls))) continue;
        const sheets = files.get(family(cls)) ?? new Set<string>();
        sheets.add(rule.file);
        files.set(family(cls), sheets);
      }
    }
    for (const [name, sheets] of files) if (sheets.size > 1) strays.push(`.${name}: templates in ${[...sheets].join(', ')}`);
    expect(strays).toEqual([]);
  });

  it('no studio root takes the grid or grid-template shorthand: each writes its longhands', () => {
    const strays = appRules().filter((rule) => rule.decls.some((decl) => decl.prop === 'grid' || decl.prop === 'grid-template'))
      .filter((rule) => classesOf(subject(rule.selector)).some((cls) => OWNERS.has(family(cls))))
      .map((rule) => `${rule.file}: ${rule.selector}`);
    expect(strays).toEqual([]);
  });

  it('a Moodboard Studio template names its variant: the Board view\'s has --board, the List view\'s :not(--board)', () => {
    const wrong: string[] = [];
    for (const rule of appRules()) {
      if (!SETS_TEMPLATE(rule)) continue;
      const target = subject(rule.selector);
      if (!classesOf(target).some((cls) => family(cls) === 'moodboard-studio-view')) continue;
      const board = classesOf(target).includes('moodboard-studio-view--board');
      const list = /:not\(\.moodboard-studio-view--board\)/.test(target);
      if (rule.file === 'styles/moodboard-board.css' ? !board : !list) wrong.push(`${rule.file}: ${rule.selector}`);
    }
    expect(wrong).toEqual([]);
  });

  it('the Board root is framed and painted by moodboard-board.css alone, under both skins (review 1 LOW-2)', () => {
    const board = STUDIOS.find((studio) => studio.root.includes('--board'))!;
    const wrong: string[] = [];
    for (const slava of SKINS) {
      document.body.className = slava ? 'app-slava-restraint' : '';
      document.body.innerHTML = '';
      const root = build(board);
      const own = cascaded(root, undefined, { viewport: { width: 1440, height: 900 } });
      for (const prop of ['position', 'inset', 'z-index', 'display', 'background', 'color', 'font-family', 'overflow',
        'grid-template-rows', 'grid-template-columns', 'grid-template-areas']) {
        const winner = own.get(`|${prop}`);
        if (winner?.file !== 'styles/moodboard-board.css') {
          wrong.push(`${slava ? 'Slava' : 'no skin'} ${prop}: ${winner ? `${winner.file} (${winner.selector})` : 'unset'}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('no studio root sets its grid inline', () => {
    const files = [...new Set([...STUDIOS.flatMap((studio) => studio.component), ...Object.keys(NOT_A_GRID)])];
    const inline = files.filter((file) => /\bgrid(?:Template\w*|Area|Row\w*|Column\w*)\s*:/.test(source(file)));
    expect(inline).toEqual([]);
  });
});

/** Screens with a studio header that are flex columns, not grids: their offline row is a flex item. */
const NOT_A_GRID: Record<string, string> = {
  'components/editor/EditorView.tsx': 'editor-view',
  'components/brand/BrandShowcaseView.tsx': 'nn-bs',
};

/** A JSX opening tag from `start`, to its `>` outside any `{…}` (props may hold JSX and arrows). */
function openingTag(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') depth -= 1;
    else if (text[i] === '>' && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

describe('every screen with a studio header is checked (review 1 MEDIUM-2 (a))', () => {
  /** Every component under src/components, read from disk. */
  const components = (dir = join(SRC, 'components')): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return components(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path.slice(SRC.length + 1)] : [];
  });

  it('a component that renders the studio header or the offline row is one STUDIOS lists, or a flex screen', () => {
    const listed = new Set([...STUDIOS.flatMap((studio) => studio.component), ...Object.keys(NOT_A_GRID)]);
    const missing = components().filter((file) => {
      if (file === 'components/WorkspaceHeader.tsx' || file === 'components/StudioOfflineRow.tsx') return false;
      const text = source(file);
      const headers = [...text.matchAll(/<WorkspaceHeader\b/g)].map((m) => openingTag(text, m.index));
      const rendersRow = /<StudioOfflineRow\b/.test(text) || /<SafeHeader\b/.test(text)
        || headers.some((tag) => !/offlineRow=\{false\}/.test(tag));
      return rendersRow && !listed.has(file);
    });
    expect(missing).toEqual([]);
  });

  it('the flex screens are flex columns, not grids', () => {
    document.body.className = 'app-slava-restraint';
    for (const [file, root] of Object.entries(NOT_A_GRID)) {
      expect(source(file), file).toContain(`"${root}`);
      document.body.innerHTML = '';
      const el = document.createElement('div');
      el.className = root;
      document.body.appendChild(el);
      expect(cascaded(el, undefined, { viewport: { width: 1440, height: 900 } }).get('|display')?.value, root).toBe('flex');
    }
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

  it('!important beats a more specific normal declaration; a later rule of the same specificity wins (review 1 LOW-3)', () => {
    document.body.innerHTML = '<div id="x" class="a b"></div>';
    const el = document.getElementById('x')!;
    const css = '.a.b#x { color: red; } .a { color: blue !important; } .b { width: 1px; } .a { width: 2px; }';
    const own = cascaded(el, css);
    expect(own.get('|color')?.value).toBe('blue');
    expect(own.get('|width')?.value).toBe('2px');
  });

  it('reads the grid-template and grid shorthands (review 1 MEDIUM-1)', () => {
    expect(parseGridTemplate('"toolbar toolbar" auto "rail main" minmax(0, 1fr) / 240px 1fr', 'grid-template'))
      .toEqual({ areas: '"toolbar toolbar" "rail main"', rows: 'auto minmax(0, 1fr)', columns: '240px 1fr' });
    expect(parseGridTemplate('[top] "a" 44px [mid] "b" / 1fr', 'grid-template')).toEqual({ areas: '"a" "b"', rows: '44px auto', columns: '1fr' });
    expect(parseGridTemplate('auto 1fr / 250px 1fr', 'grid')).toEqual({ areas: 'none', rows: 'auto 1fr', columns: '250px 1fr' });
    expect(parseGridTemplate('auto-flow / 1fr 1fr', 'grid')).toEqual({ areas: 'none', rows: 'none', columns: '1fr 1fr' });
    expect(parseGridTemplate('none', 'grid-template')).toEqual({ areas: 'none', rows: 'none', columns: 'none' });
  });

  it('a shorthand that outranks the longhands decides the template', () => {
    document.body.className = 'app-slava-restraint';
    document.body.innerHTML = '';
    const root = build(STUDIOS.find((studio) => studio.name === 'Character Studio')!);
    const { template } = resolveTemplate(root, { width: 1440, height: 900 });
    expect(template.areas).toContain('offline');
  });

  it('checks both sides of the app\'s breakpoints (review 1 LOW-4)', () => {
    const widths = VIEWPORTS.map((viewport) => viewport.width);
    const queries = [...new Set(appRules().flatMap((rule) => rule.media))];
    // Every distinct set of width queries the app can be in is checked once.
    for (const width of [699, 701, 759, 760, 761, 999, 1001, 1279, 1281, 1358, 1359, 1360, 1399, 1400, 1401, 1439, 1441, 1599, 1601]) {
      const key = (w: number) => queries.filter((query) => mediaMatches(query, { width: w, height: 900 })).sort().join('|');
      expect(widths.some((w) => key(w) === key(width)), `${width}`).toBe(true);
    }
  });
});
