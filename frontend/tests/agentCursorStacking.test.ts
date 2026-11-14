import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GM r56 item B (2026-11-03): the canvas cursor layer sits under the
 * floating chrome (the Agent log, the toolbars, the Inspector, the Updates
 * corner, the tabs, the rail and launchers, the panels). A cursor under a
 * panel is hidden until Phase 3's edge chips.
 *
 * How it holds: the layer renders inside React Flow's viewport
 * (ViewportPortal), so it paints inside the `.react-flow` wrapper's stacking
 * context. React Flow pins that wrapper at z-index 0 inline (Slava's sheet
 * asks for 1; the inline style wins, and either is under the chrome). Every
 * chrome surface is position: fixed at the app root, outside the canvas,
 * with a z-index of 10 or more in both skins. Whatever z-index the cursor
 * layer takes inside the wrapper, it can't climb out of it.
 *
 * Each test below fails when one link of that breaks.
 */

const SRC = resolve(__dirname, '../src');
const read = (path: string) => readFileSync(resolve(SRC, path), 'utf8');

const cssFiles: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.css')) cssFiles.push(path);
  }
};
walk(SRC);

interface Rule { file: string; selector: string; body: string }
const rules: Rule[] = [];
for (const file of cssFiles) {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of m[1].split(',').map((s) => s.trim())) rules.push({ file, selector, body: m[2] });
  }
}

/** The rules whose selector ends on `.cls` itself (with any class, attribute
 *  or pseudo-class on it, never a pseudo-element or a descendant). */
const rulesFor = (cls: string) => rules.filter(({ selector }) =>
  new RegExp(`\\.${cls}(?![\\w-])(?:[.:\\[][^\\s>+~]*)?$`).test(selector) && !selector.includes('::'));

const decls = (body: string, prop: string) =>
  [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1].trim());

/** Rules that apply in a skin: unskinned rules, and that skin's own. */
type Skin = 'classic' | 'slava';
const inSkin = (selector: string, skin: Skin) => {
  if (selector.includes('body:not(.app-slava-restraint)')) return skin === 'classic';
  if (selector.includes('.app-slava-restraint')) return skin === 'slava';
  return true;
};

/** Slava's layer tokens (--sr-layer-*), for resolving z-indexes. */
const tokens = new Map<string, number>();
for (const m of read('styles/slava-restraint.css').matchAll(/(--sr-layer-[\w-]+)\s*:\s*(-?\d+)\s*;/g)) tokens.set(m[1], Number(m[2]));
// And the layers written from another (PR #203's proposal bar and the ambient chrome under it):
// --sr-layer-x: calc(var(--sr-layer-y) - 1).
for (const m of read('styles/slava-restraint.css').matchAll(/(--sr-layer-[\w-]+)\s*:\s*calc\(var\((--sr-layer-[\w-]+)\)\s*([-+])\s*(\d+)\)\s*;/g)) {
  const base = tokens.get(m[2]);
  if (base !== undefined) tokens.set(m[1], m[3] === '-' ? base - Number(m[4]) : base + Number(m[4]));
}

/** A z-index value as a number: a plain integer, a layer token (or its
 *  fallback) or a calc() sum of those. */
const zOf = (value: string): number => {
  const plain = value.replace(/\s*!important$/, '').replace(/var\((--[\w-]+)(?:\s*,\s*(-?\d+))?\)/g, (_, name: string, fallback?: string) => {
    const known = tokens.get(name) ?? (fallback !== undefined ? Number(fallback) : undefined);
    if (known === undefined) throw new Error(`unknown z-index token ${name}`);
    return String(known);
  });
  const sum = /^calc\((.*)\)$/.exec(plain)?.[1] ?? plain;
  if (!/^[-\d\s+]+$/.test(sum)) throw new Error(`z-index this test cannot read: ${value}`);
  return sum.split(/(?=[+-])/).reduce((total, part) => total + Number(part.replace(/\s/g, '')), 0);
};

/** The floating chrome a cursor must stay under, by its class. */
const CHROME = [
  ['agent-log', 'the Agent log'],
  ['toolbar', 'the toolbar'],
  ['node-inspector-popover', 'the Inspector'],
  ['agent-notes-chip', 'the Updates corner'],
  ['canvas-tabs-wrap', 'the canvas tabs'],
  ['workspace-rail', 'the workspace rail'],
  ['panel-launcher', 'the launchers'],
  ['panel', 'the floating panels'],
] as const;

/** The highest z-index the canvas wrapper can take: React Flow's inline 0,
 *  or any z-index the app's sheets give `.react-flow`. */
const canvasZ = Math.max(0, ...rulesFor('react-flow').flatMap((r) => decls(r.body, 'z-index')).map(zOf));

describe('the cursor layer paints inside the canvas', () => {
  it('renders into React Flow\'s viewport, never a portal of its own', () => {
    // The canvas layer puts the shared `.agent-cursor-layer` (the hook in
    // agent-cursor/AgentCursorField.tsx, Phase 3) straight into the viewport.
    const layer = read('components/canvas/AgentCursorLayer.tsx');
    const shared = read('components/agent-cursor/AgentCursorField.tsx');
    expect(layer).toMatch(/<ViewportPortal>\{layer\}<\/ViewportPortal>/);
    expect(shared).toMatch(/layerClass = 'agent-cursor-layer'/);
    expect(layer + shared).not.toMatch(/createPortal|document\.body/);
    const css = read('styles/agentCursor.css');
    for (const { body } of rules.filter((r) => r.file.endsWith('agentCursor.css'))) {
      expect(decls(body, 'position')).not.toContain('fixed');
    }
    expect(css).not.toMatch(/agent-cursor-layer[^{]*\{[^}]*position:\s*fixed/);
  });

  it('is mounted inside <ReactFlow>, and the chrome outside the canvas, at the app root', () => {
    const canvas = read('components/Canvas.tsx');
    const flow = canvas.slice(canvas.indexOf('<ReactFlow'), canvas.indexOf('</ReactFlow>'));
    expect(flow).toContain('<AgentCursorLayer />');
    const app = read('App.tsx');
    for (const mount of ['<AgentLog />', '<Toolbar />', '<NodeInspectorPopover />', '<AgentNotes />', '<CanvasTabs />', '<WorkspaceRail />', '<ChatLauncher />']) {
      expect(app).toContain(mount);
      expect(canvas).not.toContain(mount);
    }
  });

  it('React Flow pins its wrapper at z-index 0 inline, after any style the app passes', () => {
    const lib = readFileSync(resolve(__dirname, '../node_modules/@xyflow/react/dist/esm/index.mjs'), 'utf8');
    const wrapper = /const wrapperStyle = \{([^}]*)\};\s*function ReactFlow\(/.exec(lib);
    expect(wrapper).not.toBeNull();
    expect(wrapper![1]).toMatch(/position: 'relative'/);
    expect(wrapper![1]).toMatch(/zIndex: 0/);
    expect(lib).toContain('style: { ...style, ...wrapperStyle }');
  });

  it('nothing lifts the canvas: no !important z-index or isolation on .react-flow, no stacking context on its wrapper', () => {
    for (const { body } of rulesFor('react-flow')) {
      for (const z of decls(body, 'z-index')) expect(z).not.toMatch(/!important/);
      expect(decls(body, 'position')).not.toContain('fixed');
    }
    for (const { body } of rulesFor('canvas-wrapper')) {
      for (const prop of ['z-index', 'isolation', 'transform', 'filter', 'will-change', 'contain']) {
        expect(decls(body, prop), `.canvas-wrapper ${prop}`).toEqual([]);
      }
    }
  });
});

describe.each(['classic', 'slava'] as const)('the chrome sits above the canvas in the %s skin', (skin) => {
  it.each(CHROME)('.%s (%s) is fixed at a z-index above the canvas', (cls) => {
    const applied = rulesFor(cls).filter((r) => inSkin(r.selector, skin));
    const positions = applied.flatMap((r) => decls(r.body, 'position')).map((p) => p.replace(/\s*!important$/, ''));
    expect(positions.length).toBeGreaterThan(0);
    expect(new Set(positions)).toEqual(new Set(['fixed']));
    const zs = applied.flatMap((r) => decls(r.body, 'z-index')).map(zOf);
    expect(zs.length).toBeGreaterThan(0);
    for (const z of zs) expect(z).toBeGreaterThan(canvasZ);
  });
});
