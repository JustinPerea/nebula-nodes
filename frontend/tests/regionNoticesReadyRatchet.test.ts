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
//   another starts to). It counts only when the file takes that component's
//   module, so a local fixture called App doesn't. PR #221 review 2 LOW-2:
//   the tag is matched by the name the file binds the export to (an alias,
//   a default import, a destructure from `await import`), by the export's
//   own name, or as a property of a namespace binding of the module
//   (`<N.NoticeRegion/>`, `<M.default/>` after `import * as N`, `const M =
//   await import(…)` or vi.importActual). A test helper (a non-test module
//   under tests/) that re-exports a mount (`export { … } from`, `export *`,
//   `export * as`, or an import exported again) is a mount module too,
//   through any chain of helpers.
// - Such a file loads the chunk first, in a beforeAll or beforeEach (any
//   further argument, such as a timeout, is fine):
//   `beforeAll(regionNoticesReady)`, a callback that awaits
//   `regionNoticesReady()` or `DeferredRegionNotices.preload()`, or one
//   that returns `regionNoticesReady()` (an expression body, or a block's
//   `return`, review 2 NIT-4). A bare regionNoticesReady counts only as the
//   helper's own import, never shadowed. A returned
//   `DeferredRegionNotices.preload()`, awaited or not, is the component, and
//   vitest calls a returned function as teardown; it doesn't count.
// - Exempt: a file whose vi.mock of NoticeRegion's module or of deferredChunks
//   replaces it whole. Opt-out: a comment `region-notices-ratchet: off,
//   <reason>` (at least 10 characters).
//
// Known gaps: a hook in dead code still counts; the hook may sit in any
// describe, not necessarily one around the render; a component other than
// App that renders a mount itself (a wrapper in a helper, none today) needs
// adding to MOUNTS.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { allTestFiles, calleeName, isFunctionLike, mayHold, moduleUse, optedOut, parse, some, SRC, TESTS, unwrap } from './helpers/ratchetSource';

/** A module whose exports mount the region, and which of its exports do. */
interface Mount {
  module: RegExp;
  exports: ReadonlySet<string>;
  /** Exports that are a whole mount module (`export * as M from '…/App'`), with that module's mount exports. */
  namespaces?: ReadonlyMap<string, ReadonlySet<string>>;
  /** A re-exporting helper's file name, for the prefilter. */
  token?: string;
}
/** The components that mount the region, by the module each comes from. */
const MOUNTS: readonly Mount[] = [
  { module: /(^|\/)NoticeRegion(\.[jt]sx?)?$/, exports: new Set(['NoticeRegion']) },
  { module: /(^|\/)App(\.[jt]sx?)?$/, exports: new Set(['default', 'App']) },
];
const HELPER = /(^|\/)helpers\/regionNoticesReady(\.[jt]s)?$/;
const CHUNKS = /(^|\/)deferredChunks(\.[jt]s)?$/;
/**
 * The prefilter: a mount needs the component's module named in an import,
 * so the raw text holds "NoticeRegion", an App module specifier, or the name
 * of a test helper that re-exports one (reexportingHelpers).
 */
const BASE_TOKENS: readonly (string | RegExp)[] = ['NoticeRegion', /['"`][^'"`\n]*\/App(\.[jt]sx?)?['"`]/];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The names a module exports that are a mount (review 2 LOW-2, re-exports):
 * `export { NoticeRegion as Region } from '…'`, `export * from '…'`, or a
 * mount imported and exported again (`export { Main }`, `export default Main`).
 */
function mountExports(source: string, fileName: string, mounts: readonly Mount[]) {
  const file = parse(source, fileName);
  const out = new Set<string>();
  const namespaces = new Map<string, ReadonlySet<string>>();
  const locals = new Map<string, true>();
  for (const mount of mounts) {
    const use = moduleUse(file, mount.module);
    for (const name of use.localsOf(mount.exports)) locals.set(name, true);
    for (const statement of file.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.moduleSpecifier
        || !ts.isStringLiteralLike(statement.moduleSpecifier) || !mount.module.test(statement.moduleSpecifier.text)) continue;
      const clause = statement.exportClause;
      if (!clause) mount.exports.forEach((name) => { if (name !== 'default') out.add(name); });
      else if (ts.isNamespaceExport(clause)) namespaces.set(clause.name.text, mount.exports);
      else for (const element of clause.elements) {
        if (mount.exports.has((element.propertyName ?? element.name).text)) out.add(element.name.text);
      }
    }
  }
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) if (locals.has((element.propertyName ?? element.name).text)) out.add(element.name.text);
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression) && locals.has(statement.expression.text)) out.add('default');
  }
  return { exports: out, namespaces };
}

/**
 * The test helpers (any non-test module under tests/) that re-export a
 * mount, as more mounts; followed through helpers that re-export helpers.
 */
function reexportingHelpers(modules: ReadonlyArray<{ path: string; source: string }>): Mount[] {
  const found = new Map<string, Mount>();
  for (let changed = true; changed;) {
    changed = false;
    for (const { path, source } of modules) {
      if (found.has(path)) continue;
      const { exports, namespaces } = mountExports(source, path, [...MOUNTS, ...found.values()]);
      if (exports.size === 0 && namespaces.size === 0) continue;
      const base = basename(path).replace(/\.[jt]sx?$/, '');
      found.set(path, { module: new RegExp(`(^|\\/)${escapeRegExp(base)}(\\.[jt]sx?)?$`), exports, namespaces, token: base });
      changed = true;
    }
  }
  return [...found.values()];
}

const tokensFor = (mounts: readonly Mount[]) => [...BASE_TOKENS, ...mounts.flatMap((mount) => (mount.token ? [mount.token] : []))];

function readFile(source: string, fileName?: string, mounts: readonly Mount[] = MOUNTS) {
  const file = parse(source, fileName);
  // Review 2 LOW-2: a mount is matched by the name the file binds it to (an
  // alias, a default import, a destructure from `await import`), by the
  // export's own name, or as `<N.NoticeRegion/>` / `<M.default/>` on a
  // namespace binding of the module.
  const names = new Set<string>();
  const namespaced: Array<{ namespaces: ReadonlySet<string>; exports: ReadonlySet<string> }> = [];
  for (const mount of mounts) {
    const use = moduleUse(file, mount.module);
    if (!use.takes) continue;
    mount.exports.forEach((name) => { if (name !== 'default') names.add(name); });
    use.localsOf(mount.exports).forEach((name) => names.add(name));
    namespaced.push({ namespaces: use.namespaces, exports: mount.exports });
    for (const [exported, inner] of mount.namespaces ?? []) namespaced.push({ namespaces: use.localsOf(new Set([exported])), exports: inner });
  }
  const isMount = (tag: ts.Node | undefined): boolean => {
    if (!tag) return false;
    const node = ts.isExpression(tag) ? unwrap(tag) : tag;
    if (ts.isIdentifier(node)) return names.has(node.text);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const root = node.expression.text;
      return namespaced.some(({ namespaces, exports }) => namespaces.has(root) && exports.has(node.name.text));
    }
    return false;
  };
  const mounts_ = namespaced.length > 0 && some(file, (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) return isMount(node.tagName);
    return ts.isCallExpression(node) && calleeName(node) === 'createElement' && isMount(node.arguments[0]);
  });
  if (!mounts_) return { mounts: mounts_, loads: false, racing: false };
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
  /** A returned value is handed to vitest, which calls a returned function as teardown: only the helper's promise is safe. */
  const returnsHelper = (returned: ts.Expression) => {
    const value = unwrap(returned);
    return helperCall(ts.isAwaitExpression(value) ? value.expression : value);
  };
  const awaitsLoad = (body: ts.Block) => some(body, (node) => (ts.isReturnStatement(node) && !!node.expression && returnsHelper(node.expression))
    || (ts.isAwaitExpression(node) && !ts.isReturnStatement(node.parent) && (helperCall(node.expression) || preloadCall(node.expression))));
  const loads = some(file, (node) => {
    if (!ts.isCallExpression(node) || !['beforeAll', 'beforeEach'].includes(calleeName(node))) return false;
    const hook = node.arguments[0];
    if (!hook) return false;
    if (isHelper(unwrap(hook))) return true;
    if (!isFunctionLike(hook)) return false;
    // Review 2 NIT-4: a block body that returns the helper's promise is fine too.
    if (ts.isBlock(hook.body)) return awaitsLoad(hook.body);
    return returnsHelper(hook.body);
  });
  const racing = !loads && !moduleUse(file, MOUNTS[0].module).fullMock && !moduleUse(file, CHUNKS).fullMock
    && !optedOut(file, 'region-notices-ratchet');
  return { mounts: mounts_, loads, racing };
}

const racing = (source: string, fileName?: string, mounts: readonly Mount[] = MOUNTS) =>
  mayHold(source, tokensFor(mounts)) && readFile(source, fileName, mounts).racing;
const TOKENS = BASE_TOKENS;

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
    // Review 2 LOW-2: the mount by the name the file binds it to.
    ['a renamed named import', "import { NoticeRegion as Region } from '../src/components/NoticeRegion';\nit('x', () => { render(<Region />); });"],
    ['a default import of App under another name', "import Main from '../src/App';\nit('x', () => { render(<Main />); });"],
    ['<M.default/> from `await import`', "it('x', async () => { const M = await import('../src/App'); render(<M.default />); });"],
    ['a namespace import', "import * as N from '../src/components/NoticeRegion';\nit('x', () => { render(<N.NoticeRegion screen=\"canvas\" />); });"],
    ['a destructure-rename from `await import`', "it('x', async () => { const { NoticeRegion: Region } = await import('../src/components/NoticeRegion'); render(<Region />); });"],
    ['default destructured from `await import`', "it('x', async () => { const { default: Main } = await import('../src/App'); render(<Main />); });"],
    ['a template-literal App import', "it('x', async () => { const M = await import(`../src/App`); render(<M.default />); });"],
    ['createElement on a namespace', "import * as N from '../src/components/NoticeRegion';\nit('x', () => { render(createElement(N.NoticeRegion, {})); });"],
    ['vi.importActual of App', "it('x', async () => { const M = await vi.importActual('../src/App'); render(<M.default />); });"],
    // Review 2 NIT-4's other side: a returned preload is still the component.
    ['the preload returned from a block body', `${IMPORT_REGION}${IMPORT_CHUNKS}beforeAll(async () => { return await DeferredRegionNotices.preload(); });\n${RENDER}`],
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
    // Review 2 NIT-4: a block body that returns the helper's promise.
    ['the helper returned from a block body', `${IMPORT_REGION}${IMPORT_HELPER}beforeAll(() => { return regionNoticesReady(); });\n${RENDER}`],
    ['the helper awaited and returned from a block body', `${IMPORT_REGION}${IMPORT_HELPER}beforeAll(async () => { return await regionNoticesReady(); });\n${RENDER}`],
    ['an aliased mount with the helper', `import { NoticeRegion as Region } from '../src/components/NoticeRegion';\n${IMPORT_HELPER}beforeAll(regionNoticesReady);\nit('x', () => { render(<Region />); });`],
    ['another export of a namespace', "import * as N from '../src/components/NoticeRegion';\nit('x', () => { render(<N.regionLabel />); });"],
  ];
  it.each(passes)('passes: %s', (_, source) => {
    expect(racing(source)).toBe(false);
  });
});

describe('a test helper that re-exports a mount is a mount too (review 2 LOW-2)', () => {
  const HELPERS = [
    { path: '/t/tests/helpers/regionHarness.tsx', source: "export { NoticeRegion as Region } from '../../src/components/NoticeRegion';\n" },
    { path: '/t/tests/helpers/appHarness.tsx', source: "import App from '../../src/App';\nexport default App;\n" },
    { path: '/t/tests/helpers/allOfApp.ts', source: "export * as AppModule from '../../src/App';\n" },
    { path: '/t/tests/helpers/chained.ts', source: "export { Region as Chained } from './regionHarness';\n" },
    { path: '/t/tests/helpers/plain.ts', source: "import App from '../../src/App';\nexport const appName = App.name;\n" },
  ];
  const mounts = [...MOUNTS, ...reexportingHelpers(HELPERS)];
  it('finds the re-exporting helpers, and only those', () => {
    expect(mounts.slice(MOUNTS.length).map((mount) => mount.token)).toEqual(['regionHarness', 'appHarness', 'allOfApp', 'chained']);
  });
  const caught: Array<[string, string]> = [
    ['a renamed re-export', "import { Region } from './helpers/regionHarness';\nit('x', () => { render(<Region />); });"],
    ['an import exported again as default', "import Harness from './helpers/appHarness';\nit('x', () => { render(<Harness />); });"],
    ['a namespace re-export', "import { AppModule } from './helpers/allOfApp';\nit('x', () => { render(<AppModule.default />); });"],
    ['a helper re-exporting a helper', "import { Chained } from './helpers/chained';\nit('x', () => { render(<Chained />); });"],
  ];
  it.each(caught)('%s', (_, source) => {
    expect(racing(source, undefined, mounts)).toBe(true);
  });
  it('passes: a re-exported mount with the helper', () => {
    expect(racing(`import { Region } from './helpers/regionHarness';\n${IMPORT_HELPER}beforeAll(regionNoticesReady);\nit('x', () => { render(<Region />); });`, undefined, mounts)).toBe(false);
  });
});

/** Every module under tests/ that isn't a test file: where a re-export would live. */
const helperModules = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === 'node_modules') return [];
  if (statSync(path).isDirectory()) return helperModules(path);
  return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
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
    const helpers = helperModules(TESTS).map((path) => ({ path, source: readFileSync(path, 'utf8') }));
    expect(helpers.length).toBeGreaterThan(0);
    const mounts = [...MOUNTS, ...reexportingHelpers(helpers)];
    const found = files.filter((path) => path !== __filename && racing(readFileSync(path, 'utf8'), path, mounts))
      .map((path) => relative(join(__dirname, '..'), path));
    expect(found).toEqual([]);
  });
});
