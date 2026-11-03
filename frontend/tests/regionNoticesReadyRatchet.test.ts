// fix/ci-flakes-rename-fix16: the notice region's own notices (RegionNotices)
// are a deferred chunk. A test that renders <NoticeRegion> before the chunk is
// in gets the notices from a Suspense retry React runs outside act(); a findBy
// sees that commit, but the store hooks' subscriptions are still queued, so a
// store change made next in act() never reaches the line. pr198Fix23Ui "a
// rename during a try" read "Opening" after the rename on a busy CI runner
// (run 41584394316, attempt 1); with React's scheduler stalled 20 ms it fails
// every time, and so did pr198Fix20Ui and pr198Fix21Ui (PR #221 review 1).
//
// The check, read from each test file's syntax tree (PR #221 review 1 LOW-2,
// NIT-1, NIT-2), so comments and strings never count as code:
// - A file mounts the region when it renders, in JSX or createElement, a
//   component that mounts it: NoticeRegion itself, or App (the one app
//   component that renders <NoticeRegion>; the last case below fails if
//   another starts to). The name counts only when the file imports that
//   component's module, so a local fixture called App doesn't.
// - Such a file loads the chunk first, in a beforeAll or beforeEach (any
//   further argument, such as a timeout, is fine):
//   `beforeAll(regionNoticesReady)`, a callback that awaits
//   `regionNoticesReady()` or `DeferredRegionNotices.preload()`, or an
//   expression body `() => regionNoticesReady()`. A bare regionNoticesReady
//   counts only as the helper's own import, never shadowed.
//   `() => DeferredRegionNotices.preload()`, with or without an `await` in the
//   expression body, returns the component, and vitest calls a returned
//   function as teardown; it doesn't count.
// - Exempt: a file whose vi.mock of NoticeRegion's module or of deferredChunks
//   replaces it whole. Opt-out: a comment `region-notices-ratchet: off,
//   <reason>` (at least 10 characters).
//
// Known gaps: a hook in dead code still counts; the hook may sit in any
// describe, not necessarily one around the render; a component other than
// App that mounts the region through another (none today) needs adding to
// MOUNTS.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { allTestFiles, calleeName, isFunctionLike, mayHold, moduleUse, optedOut, parse, some, SRC, unwrap } from './helpers/ratchetSource';

/** The components that mount the region, by the module each comes from. */
const MOUNTS: Record<string, RegExp> = {
  NoticeRegion: /(^|\/)NoticeRegion(\.[jt]sx?)?$/,
  App: /(^|\/)App(\.[jt]sx?)?$/,
};
const HELPER = /(^|\/)helpers\/regionNoticesReady(\.[jt]s)?$/;
const CHUNKS = /(^|\/)deferredChunks(\.[jt]s)?$/;
/**
 * The prefilter: a mount needs the component's module named in an import,
 * so the raw text holds "NoticeRegion" or an App module specifier.
 */
const TOKENS = ['NoticeRegion', /['"][^'"\n]*\/App(\.[jt]sx?)?['"]/];

function readFile(source: string, fileName?: string) {
  const file = parse(source, fileName);
  const mounting = new Set(Object.entries(MOUNTS).filter(([, module]) => moduleUse(file, module).takes).map(([name]) => name));
  const mounts = mounting.size > 0 && some(file, (node) => {
    const tag = ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node) ? node.tagName
      : ts.isCallExpression(node) && calleeName(node) === 'createElement' ? node.arguments[0] : undefined;
    return !!tag && ts.isIdentifier(tag) && mounting.has(tag.text);
  });
  if (!mounts) return { mounts, loads: false, racing: false };
  const helper = moduleUse(file, HELPER);
  const isHelper = (node: ts.Expression) => ts.isIdentifier(node) && helper.isExport(node.text, 'regionNoticesReady');
  const helperCall = (node: ts.Expression) => {
    const target = unwrap(node);
    return ts.isCallExpression(target) && target.arguments.length === 0 && isHelper(unwrap(target.expression));
  };
  const preloadCall = (node: ts.Expression) => {
    const target = unwrap(node);
    if (!ts.isCallExpression(target)) return false;
    const callee = unwrap(target.expression);
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'preload'
      && ts.isIdentifier(callee.expression) && callee.expression.text === 'DeferredRegionNotices';
  };
  const awaitsLoad = (body: ts.Node) => some(body, (node) => ts.isAwaitExpression(node) && (helperCall(node.expression) || preloadCall(node.expression)));
  const loads = some(file, (node) => {
    if (!ts.isCallExpression(node) || !['beforeAll', 'beforeEach'].includes(calleeName(node))) return false;
    const hook = node.arguments[0];
    if (!hook) return false;
    if (isHelper(unwrap(hook))) return true;
    if (!isFunctionLike(hook)) return false;
    if (ts.isBlock(hook.body)) return awaitsLoad(hook.body);
    // An expression body is returned: only the helper's promise is safe to hand vitest.
    const returned = unwrap(hook.body);
    return helperCall(ts.isAwaitExpression(returned) ? returned.expression : returned);
  });
  const racing = !loads && !moduleUse(file, MOUNTS.NoticeRegion).fullMock && !moduleUse(file, CHUNKS).fullMock
    && !optedOut(file, 'region-notices-ratchet');
  return { mounts, loads, racing };
}

const racing = (source: string, fileName?: string) => mayHold(source, TOKENS) && readFile(source, fileName).racing;

const IMPORT_REGION = "import { NoticeRegion } from '../src/components/NoticeRegion';\n";
const IMPORT_APP = "import App from '../src/App';\n";
const IMPORT_HELPER = "import { regionNoticesReady } from './helpers/regionNoticesReady';\n";
const IMPORT_CHUNKS = "import { DeferredRegionNotices } from '../src/lib/deferredChunks';\n";
const RENDER = "it('x', () => { render(<NoticeRegion screen=\"canvas\" />); });\n";

describe('the ratchet reads the forms (mutation cases: each must be caught)', () => {
  const caught: Array<[string, string]> = [
    ['a render with no preload', `${IMPORT_REGION}${RENDER}`],
    ['the helper imported but never called', `${IMPORT_REGION}${IMPORT_HELPER}${RENDER}`],
    // Review 1 LOW-2: a comment is not a hook.
    ['the hook only in a line comment', `${IMPORT_REGION}${IMPORT_HELPER}// beforeAll(regionNoticesReady);\n${RENDER}`],
    ['the hook only in a block comment', `${IMPORT_REGION}${IMPORT_HELPER}/* beforeAll(regionNoticesReady); */\n${RENDER}`],
    ['the hook only in a string', `${IMPORT_REGION}${IMPORT_HELPER}const why = 'beforeAll(regionNoticesReady)';\n${RENDER}`],
    ['the preload returned (vitest calls it as teardown)', `${IMPORT_REGION}${IMPORT_CHUNKS}beforeAll(() => DeferredRegionNotices.preload());\n${RENDER}`],
    ['the preload awaited in an expression body (still returned)', `${IMPORT_REGION}${IMPORT_CHUNKS}beforeAll(async () => await DeferredRegionNotices.preload());\n${RENDER}`],
    ['the preload passed bare', `${IMPORT_REGION}${IMPORT_CHUNKS}beforeAll(DeferredRegionNotices.preload);\n${RENDER}`],
    ['the preload called but not awaited', `${IMPORT_REGION}${IMPORT_CHUNKS}beforeAll(() => { DeferredRegionNotices.preload(); });\n${RENDER}`],
    ['the helper awaited only in a test', `${IMPORT_REGION}${IMPORT_HELPER}it('y', async () => { await regionNoticesReady(); });\n${RENDER}`],
    ['a local regionNoticesReady', `${IMPORT_REGION}const regionNoticesReady = async () => {};\nbeforeAll(regionNoticesReady);\n${RENDER}`],
    ['a createElement render', `${IMPORT_REGION}it('x', () => { render(createElement(NoticeRegion, { screen: 'canvas' })); });`],
    // Review 1 NIT-2: <App/> mounts the region.
    ['an <App/> render with no preload', `${IMPORT_APP}it('x', () => { render(<App />); });`],
    ['an <App></App> render', `${IMPORT_APP}it('x', () => { render(<App></App>); });`],
    ['a partial mock of NoticeRegion is still the real region', `vi.mock('../src/components/NoticeRegion', async (importOriginal) => ({ ...await importOriginal() }));\n${IMPORT_REGION}${RENDER}`],
    ['an opt-out with no reason', `// region-notices-ratchet: off\n${IMPORT_REGION}${RENDER}`],
    ['an opt-out only in a string', `${IMPORT_REGION}const s = '// region-notices-ratchet: off, only a string here';\n${RENDER}`],
    ['a unicode escape in the tag', `${IMPORT_REGION}it('x', () => { render(<Notice\\u0052egion screen="canvas" />); });`],
  ];
  it.each(caught)('%s', (_, source) => {
    expect(racing(source)).toBe(true);
  });
  it('the prefilter lets every caught form through', () => {
    expect(caught.filter(([, source]) => !mayHold(source, TOKENS)).map(([name]) => name)).toEqual([]);
    expect(mayHold("import { render } from '@testing-library/react';", TOKENS)).toBe(false);
    expect(mayHold("import { Apply } from './Apply';\nrender(createElement(Apply));", TOKENS)).toBe(false);
  });

  const passes: Array<[string, string]> = [
    ['beforeAll(regionNoticesReady)', `${IMPORT_REGION}${IMPORT_HELPER}beforeAll(regionNoticesReady);\n${RENDER}`],
    // Review 1 NIT-1: a timeout argument is fine.
    ['beforeAll(regionNoticesReady, 10_000)', `${IMPORT_REGION}${IMPORT_HELPER}beforeAll(regionNoticesReady, 10_000);\n${RENDER}`],
    ['beforeEach(regionNoticesReady)', `${IMPORT_REGION}${IMPORT_HELPER}beforeEach(regionNoticesReady);\n${RENDER}`],
    ['an awaited preload in a block', `${IMPORT_REGION}${IMPORT_CHUNKS}beforeAll(async () => { await DeferredRegionNotices.preload(); });\n${RENDER}`],
    ['an awaited helper among other setup', `${IMPORT_REGION}${IMPORT_HELPER}beforeAll(async () => { setup(); await regionNoticesReady(); }, 10_000);\n${RENDER}`],
    ['the helper returned from an expression body', `${IMPORT_REGION}${IMPORT_HELPER}beforeAll(() => regionNoticesReady());\n${RENDER}`],
    ['a renamed helper import', `${IMPORT_REGION}import { regionNoticesReady as ready } from './helpers/regionNoticesReady';\nbeforeAll(async () => { await ready(); });\n${RENDER}`],
    ['the hook inside a describe', `${IMPORT_REGION}${IMPORT_HELPER}describe('d', () => { beforeAll(regionNoticesReady); ${RENDER} });`],
    ['an import of NoticeRegion with no render', IMPORT_REGION],
    ['a local App fixture that is not the app', "const App = () => null;\nit('x', () => { render(<App />); });"],
    ['a full mock of NoticeRegion', `vi.mock('../src/components/NoticeRegion', () => ({ NoticeRegion: () => null }));\n${IMPORT_REGION}${RENDER}`],
    ['an opt-out with a reason', `// region-notices-ratchet: off, tests the region before its chunk on purpose\n${IMPORT_REGION}${RENDER}`],
    ['the render only in a comment', `${IMPORT_REGION}// render(<NoticeRegion screen="canvas" />);\n`],
  ];
  it.each(passes)('passes: %s', (_, source) => {
    expect(racing(source)).toBe(false);
  });
});

describe('tests that mount the notice region load its notices chunk first', () => {
  it('App is the only app component that renders <NoticeRegion>', () => {
    const appFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return appFiles(path);
      return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
    });
    const mountingRegion = appFiles(SRC).filter((path) => readFileSync(path, 'utf8').includes('<NoticeRegion'))
      .map((path) => relative(SRC, path));
    expect(mountingRegion).toEqual(['App.tsx']);
  });

  // Sized from measurement: see the PR notes (the scan's time locally and under load).
  it('every test file that mounts the region waits on regionNoticesReady', { timeout: 20_000 }, () => {
    const files = allTestFiles();
    expect(files.length).toBeGreaterThan(100);
    const found = files.filter((path) => path !== __filename && racing(readFileSync(path, 'utf8'), path))
      .map((path) => relative(join(__dirname, '..'), path));
    expect(found).toEqual([]);
  });
});
