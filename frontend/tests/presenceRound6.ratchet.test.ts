/**
 * PR #204 round 6. Two ratchets on the promote mechanism, read with the TypeScript parser:
 *
 * 1. GM r6 (2), the shared-line rule: a "not connected" refusal of anything that retries on the
 *    promote says why in the "because" form ("Nebula couldn’t <do it> because this tab isn’t
 *    connected as you. …"), never "then try again" or "This change needs your OK". Every
 *    `retryOnPromote(` call's enclosing function words its line with `notConnectedBecause(` (or
 *    `markReadRefusedCopy(`, which is built on it).
 * 2. Review 4 LOW-3 (held-state-ui): a request is done again on the promote through
 *    `retryOnPromote` only. A clear callback (what `clearsOnPromote`, `clearRefusedOnPromote`,
 *    `clearLineOnPromote` and `clearSetterOnPromote` run) only takes a line down: a call in it
 *    that reads like a request (retry, save, send, dismiss, load, fetch, flush, refresh,
 *    hydrate, setAttempt…) fails.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { notConnectedBecause } from '../src/lib/errorCopy';

const SRC = join(__dirname, '..', 'src');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return walk(path);
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
});
const files = () => walk(SRC).filter((path) => relative(SRC, path) !== 'lib/clearsOnPromote.ts');
const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
  path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(node)
  || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function callsIn(root: ts.Node, visit: (call: ts.CallExpression) => void): void {
  const go = (node: ts.Node) => { if (ts.isCallExpression(node)) visit(node); ts.forEachChild(node, go); };
  go(root);
}

/** The function a call sits in (not a callback passed to the call itself). */
function enclosing(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let at = node.parent; at; at = at.parent) if (isFunction(at)) return at;
  return null;
}

const where = (source: ts.SourceFile, node: ts.Node) =>
  `${relative(SRC, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

const WORDS_BECAUSE = /\b(?:notConnectedBecause|markReadRefusedCopy)\(/;

/** Calls that read like a request, which a clear callback must not make. */
const REQUEST = /^(?:retry\w*|save\w*|send\w*|dismiss\w*|load\w*|reload\w*|fetch\w*|flush\w*|refresh\w*|hydrate\w*|setAttempt\w*|initialize|open|run|apiFetch|apiRequest|requestJson)$/;
const CLEARS: Record<string, number> = { clearsOnPromote: 0, clearRefusedOnPromote: 1, clearLineOnPromote: 3 };

export function retriesWithoutBecause(sources = files().map(parse)): string[] {
  const bad: string[] = [];
  for (const source of sources) callsIn(source, (call) => {
    if (calleeName(call) !== 'retryOnPromote') return;
    const fn = enclosing(call);
    if (!fn || !WORDS_BECAUSE.test(fn.getText(source))) bad.push(where(source, call));
  });
  return bad;
}

export function requestsInClears(sources = files().map(parse)): string[] {
  const bad: string[] = [];
  for (const source of sources) callsIn(source, (call) => {
    const name = calleeName(call);
    if (!name || !(name in CLEARS)) return;
    const clear = call.arguments[CLEARS[name]];
    if (!clear) return;
    callsIn(clear, (inner) => {
      const innerName = calleeName(inner);
      if (innerName && REQUEST.test(innerName)) bad.push(`${where(source, inner)} ${innerName}()`);
    });
    // A clear passed by name: its declaration in the same file is read too.
    if (ts.isIdentifier(clear)) {
      const go = (node: ts.Node) => {
        const declared = (ts.isFunctionDeclaration(node) && node.name?.text === clear.text) ? node
          : (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === clear.text && node.initializer) ? node.initializer : null;
        if (declared) callsIn(declared, (inner) => {
          const innerName = calleeName(inner);
          if (innerName && REQUEST.test(innerName)) bad.push(`${where(source, inner)} ${innerName}()`);
        });
        ts.forEachChild(node, go);
      };
      go(source);
    }
  });
  return bad;
}

const fixture = (text: string) => ts.createSourceFile(join(SRC, 'fixture.ts'), text, ts.ScriptTarget.Latest, true);

describe('GM r6 (2): what retries on the promote says why in the because form', () => {
  it('every retryOnPromote caller words its line with notConnectedBecause', { timeout: 60_000 }, () => {
    expect(retriesWithoutBecause()).toEqual([]);
  });

  it('the because form names what failed, says why, and never asks for a retry or an OK', () => {
    for (const what of ['save the style', 'save the project', 'load your work', 'switch projects', 'load your agents',
      'load the connected apps', 'mark the updates as read']) {
      for (const desktop of [false, true]) {
        const line = notConnectedBecause(what, desktop, null);
        expect(line).toMatch(new RegExp(`^Nebula couldn’t ${what} because this (?:tab|window) isn’t connected as you\\. `));
        expect(line).not.toMatch(/try again|needs your OK/i);
      }
    }
  });

  it('the ratchet catches a retry whose line keeps the generic form (mutant)', () => {
    const mutant = fixture(`function f(e) { const line = personRequiredCopy(); retryOnPromote(e, 'k', () => go()); }`);
    expect(retriesWithoutBecause([mutant])).toHaveLength(1);
    const kept = fixture(`function f(e) { const line = notConnectedBecause('save it'); retryOnPromote(e, 'k', () => go()); }`);
    expect(retriesWithoutBecause([kept])).toEqual([]);
  });
});

describe('review 4 LOW-3: nothing retries outside retryOnPromote', () => {
  it('no clear callback makes a request', { timeout: 60_000 }, () => {
    expect(requestsInClears()).toEqual([]);
  });

  it('the ratchet catches a retry inside a clear callback (M18), inline or by name', () => {
    const inline = fixture(`clearRefusedOnPromote(e, () => { setError(null); setAttempt((n) => n + 1); });`);
    expect(requestsInClears([inline])).toEqual(['fixture.ts:1 setAttempt()']);
    const store = fixture(`clearLineOnPromote(e, () => get().error, line, () => { set({ error: null }); void get().retry(); });`);
    expect(requestsInClears([store])).toEqual(['fixture.ts:1 retry()']);
    const named = fixture(`const back = () => { reload(); };\nclearsOnPromote(back);`);
    expect(requestsInClears([named])).toEqual(['fixture.ts:1 reload()']);
    const clean = fixture(`clearRefusedOnPromote(e, () => { setError((now) => (now === line ? null : now)); });`);
    expect(requestsInClears([clean])).toEqual([]);
  });
});

// ---------- review 4 MEDIUM-1, LOW-1, LOW-2: the trace follows rethrows and fails closed ----------

import { callersOf, gatedRoutes, untracedApiText, withSources } from './personGatedCallers';

const PRESETS = { method: 'POST', path: '/api/presets' };
const realSources = () => Object.fromEntries(walk(SRC).map((path) => [relative(SRC, path), readFileSync(path, 'utf8')]));

/** A component that calls `call` and shows the failure without registering it. */
const panel = (imports: string, call: string) => `${imports}
import { failureMessage } from '../lib/errorCopy';
export function Panel({ setLine }: { setLine: (line: string) => void }) {
  const go = async () => { try { await ${call}; } catch (error) { setLine(failureMessage(error, 'No.')); } };
  return go;
}`;
const sends = (path: string) => `apiFetch(${path}, { method: 'POST' })`;
const PROBES: Record<string, Record<string, string>> = {
  'a base before /api/': { 'lib/a.ts': `const BASE = '';\nexport function save() { return ${sends('`${BASE}/api/presets`')}; }`,
    'components/C.tsx': panel(`import { save } from '../lib/a';`, 'save()') },
  'a top-level const path': { 'lib/a.ts': `const PATH = '/api/presets';\nexport function save() { return ${sends('PATH')}; }`,
    'components/C.tsx': panel(`import { save } from '../lib/a';`, 'save()') },
  "'/api/' + 'presets'": { 'lib/a.ts': `export function save() { return ${sends("'/api/' + 'presets'")}; }`,
    'components/C.tsx': panel(`import { save } from '../lib/a';`, 'save()') },
  'a written ?query': { 'lib/a.ts': `export function save() { return ${sends("'/api/presets?scope=project'")}; }`,
    'components/C.tsx': panel(`import { save } from '../lib/a';`, 'save()') },
  'a renamed re-export': { 'lib/a.ts': `export function save() { return ${sends("'/api/presets'")}; }`,
    'lib/index.ts': `export { save as savePreset } from './a';`,
    'components/C.tsx': panel(`import { savePreset } from '../lib/index';`, 'savePreset()') },
  'export *': { 'lib/a.ts': `export function save() { return ${sends("'/api/presets'")}; }`,
    'lib/index.ts': `export * from './a';`,
    'components/C.tsx': panel(`import { save } from '../lib/index';`, 'save()') },
  'a default-exported helper': { 'lib/a.ts': `export default function save() { return ${sends("'/api/presets'")}; }`,
    'components/C.tsx': panel(`import savePreset from '../lib/a';`, 'savePreset()') },
  'an object-property helper': { 'lib/a.ts': `export const styles = { save: () => ${sends("'/api/presets'")} };`,
    'components/C.tsx': panel(`import { styles } from '../lib/a';`, 'styles.save()') },
  'a lib class method': { 'lib/a.ts': `class Api { save() { return ${sends("'/api/presets'")}; } }\nexport const api = new Api();`,
    'components/C.tsx': panel(`import { api } from '../lib/a';`, 'api.save()') },
};

describe('review 4 LOW-1: a frontend request the trace used to miss is found, or must be declared', () => {
  for (const [form, files] of Object.entries(PROBES)) {
    it(form, () => {
      const found = withSources(files, () => callersOf(PRESETS));
      expect(found.get('components/C.tsx#go')?.outcome, [...found.keys()].join(', ')).toBe('drops');
    });
  }

  it('fail closed: a lib helper reached by nothing it can follow (built with new) is returned itself', () => {
    const found = withSources({
      'lib/a.ts': `export class Api { save() { return ${sends("'/api/presets'")}; } }`,
      'components/C.tsx': panel(`import { Api } from '../lib/a';`, 'new Api().save()'),
    }, () => callersOf(PRESETS));
    expect(found.get('lib/a.ts#save')?.outcome).toBe('drops');
  });

  it('fail closed: /api/ text the trace can\'t place is listed', () => {
    const untraced = withSources({ 'lib/a.ts': `export const PATHS = { save: '/api/presets' };\nexport const note = 'see /api/presets';` },
      () => untracedApiText().map((entry) => entry.text));
    expect(untraced).toEqual(['/api/presets', 'see /api/presets']);
  });
});

/** /api/ text in src the trace doesn't follow, each with why it sends nothing. Keyed `file text`. */
const UNTRACED: Record<string, string> = {
  'constants/nodeDefinitions.ts A saved character': 'a node\'s description (prose)',
  'constants/nodeDefinitions.ts A saved Nebula moodboard': 'a node\'s description (prose)',
  'constants/nodeDefinitions.ts https://openrouter.ai/api/v1/chat/completions': 'another host\'s endpoint, named in a node\'s docs',
  'lib/backend.ts /api/agent/spend': 'PERSON_READ_PREFIXES: which reads carry the person header; sends nothing',
  'lib/backend.ts /api/krea/': 'PERSON_READ_PREFIXES',
  'lib/backend.ts /api/personal-agents': 'PERSON_READ_PREFIXES',
  'lib/backend.ts /api/settings': 'PERSON_READ_PATHS',
  'lib/backend.ts /api/outputs/': 'BACKEND_ASSET_PREFIXES: media paths rewritten to the backend origin',
  'lib/backend.ts /api/presets/thumbnails/': 'BACKEND_ASSET_PREFIXES',
  'lib/backend.ts /api/paper/snapshots/': 'BACKEND_ASSET_PREFIXES',
  'lib/backend.ts /api/graph': 'GRAPH_BODY_PREFIXES: which bodies are canonicalised; sends nothing',
  'lib/backend.ts /api/execute': 'GRAPH_BODY_PREFIXES',
  'lib/backend.ts /api/cinema': 'GRAPH_BODY_PREFIXES',
  'lib/backend.ts /api/quick': 'GRAPH_BODY_PREFIXES',
  'lib/backend.ts /api/projects': 'GRAPH_BODY_PREFIXES',
  'lib/backend.ts /api/presets': 'GRAPH_BODY_PREFIXES',
  'lib/spatialValue.ts must be an unsigned relative /api/outputs/ path': 'a validation message',
  'lib/storedImage.ts /api/outputs/': 'SERVED: which image paths are Nebula\'s own',
  'lib/storedImage.ts /api/presets/thumbnails/': 'SERVED',
};

describe('round 6: every /api/ text the trace can\'t follow is declared', () => {
  it('and every declaration is still there', { timeout: 60_000 }, () => {
    const keyOf = (entry: { file: string; text: string }) => Object.keys(UNTRACED)
      .find((key) => key === `${entry.file} ${entry.text}` || (`${entry.file} ${entry.text}`.startsWith(key) && key.split(' ').length > 2));
    const undeclared = untracedApiText().filter((entry) => !keyOf(entry)).map((entry) => `${entry.file}:${entry.line} ${entry.text}`);
    expect(undeclared).toEqual([]);
    const used = new Set(untracedApiText().map(keyOf));
    expect(Object.keys(UNTRACED).filter((key) => !used.has(key))).toEqual([]);
  });
});

describe('review 4 MEDIUM-1: a store action that throws on is followed into the components that call it', () => {
  const cluster = () => gatedRoutes().find((route) => route.method === 'POST' && route.path === '/api/graph/cluster')!;

  it('today: CreateView\'s catch on authorGenerationCluster registers (create.generate)', { timeout: 60_000 }, () => {
    const found = callersOf(cluster());
    expect(found.has('store/graphStore.ts#authorGenerationCluster')).toBe(false); // followed past
    expect(found.get('components/create-studio/CreateView.tsx#handleGenerate')?.outcome).toBe('keeps');
  });

  it('mutant 1: CreateView\'s create.generate registration removed: its caller drops the line', { timeout: 60_000 }, () => {
    const sources = realSources();
    const file = 'components/create-studio/CreateView.tsx';
    sources[file] = sources[file].split('\n').filter((line) => !line.includes('// clears-on-promote: create.generate')).join('\n');
    const found = withSources(sources, () => callersOf(cluster()));
    expect(found.get(`${file}#handleGenerate`)?.outcome).toBe('drops');
  });

  it('mutant 2: a new component calls getState().authorGenerationCluster() and shows failureMessage without registering', { timeout: 60_000 }, () => {
    const sources = realSources();
    sources['components/Mutant.tsx'] = `import { useGraphStore } from '../store/graphStore';
import { failureMessage } from '../lib/errorCopy';
export function Mutant({ setLine }: { setLine: (line: string) => void }) {
  const go = async () => {
    try { await useGraphStore.getState().authorGenerationCluster({} as never); }
    catch (error) { setLine(failureMessage(error, 'No.')); }
  };
  return go;
}`;
    const found = withSources(sources, () => callersOf(cluster()));
    expect(found.get('components/Mutant.tsx#go')?.outcome).toBe('drops');
  });

  it('a selector (useStore((s) => s.action)) is followed to the calls of its name', { timeout: 60_000 }, () => {
    const sources = realSources();
    sources['components/Mutant.tsx'] = `import { useGraphStore } from '../store/graphStore';
import { failureMessage } from '../lib/errorCopy';
export function Mutant({ setLine }: { setLine: (line: string) => void }) {
  const author = useGraphStore((s) => s.authorGenerationCluster);
  const go = async () => { try { await author({} as never); } catch (error) { setLine(failureMessage(error, 'No.')); } };
  return go;
}`;
    const found = withSources(sources, () => callersOf(cluster()));
    expect(found.get('components/Mutant.tsx#go')?.outcome).toBe('drops');
  });
});

// ---------- review 4 LOW-2: the backend forms the line scan missed ----------

const ROUTE_HEAD = `from fastapi import APIRouter, Depends, FastAPI\napp = FastAPI()\n`;
const BACKEND_PROBES: Record<string, { files: Record<string, string>; expect: string }> = {
  'a multi-line decorator': { files: { 'main.py': `${ROUTE_HEAD}from services.person_gate import require_person\n@app.post(\n    "/api/probe",\n)\ndef probe(request):\n    require_person(request.headers)\n` }, expect: 'POST /api/probe' },
  'a single-quoted path': { files: { 'main.py': `${ROUTE_HEAD}from services.person_gate import require_person\n@app.post('/api/probe')\ndef probe(request):\n    require_person(request.headers)\n` }, expect: 'POST /api/probe' },
  '@app.api_route': { files: { 'main.py': `${ROUTE_HEAD}from services.person_gate import require_person\n@app.api_route("/api/probe", methods=["PUT", "PATCH"])\ndef probe(request):\n    require_person(request.headers)\n` }, expect: 'PATCH /api/probe,PUT /api/probe' },
  'a cross-module helper in services/': { files: {
    'main.py': `${ROUTE_HEAD}from services import helpers\n@app.post("/api/probe")\ndef probe(request):\n    helpers.check(request)\n`,
    'services/helpers.py': `from services.person_gate import require_person\ndef check(request):\n    require_person(request.headers)\n`,
    'services/__init__.py': '' }, expect: 'POST /api/probe' },
  'PersonGateError raised inline': { files: { 'main.py': `${ROUTE_HEAD}from services.person_gate import PersonGateError\n@app.post("/api/probe")\ndef probe(request):\n    raise PersonGateError(403, "no")\n` }, expect: 'POST /api/probe' },
  'PERSON_REQUIRED written inline': { files: { 'main.py': `${ROUTE_HEAD}from services import person_gate\n@app.post("/api/probe")\ndef probe(request):\n    return {"code": person_gate.PERSON_REQUIRED}\n` }, expect: 'POST /api/probe' },
  'a class static method': { files: { 'main.py': `${ROUTE_HEAD}from services.person_gate import require_person\nclass Gate:\n    @staticmethod\n    def check(request):\n        require_person(request.headers)\n@app.post("/api/probe")\ndef probe(request):\n    Gate.check(request)\n` }, expect: 'POST /api/probe' },
  'an alias': { files: { 'main.py': `${ROUTE_HEAD}from services.person_gate import require_person as must_be_person\ngate = must_be_person\n@app.post("/api/probe")\ndef probe(request):\n    gate(request.headers)\n` }, expect: 'POST /api/probe' },
  'a Depends(person_only) parameter': { files: { 'routes/probe.py': `from fastapi import APIRouter, Depends\nfrom routes.krea_connector import person_only\nrouter = APIRouter(prefix="/api/p")\n@router.post("/probe")\ndef probe(_: None = Depends(person_only)):\n    return {}\n` }, expect: 'POST /api/p/probe' },
  'router-level dependencies=': { files: { 'routes/probe.py': `from fastapi import APIRouter, Depends\nfrom routes.krea_connector import person_only\nrouter = APIRouter(prefix="/api/p", dependencies=[Depends(person_only)])\n@router.get("/probe")\ndef probe():\n    return {}\n` }, expect: 'GET /api/p/probe' },
};

describe('review 4 LOW-2: backend routes behind the gate, read with ast', () => {
  for (const [form, probe] of Object.entries(BACKEND_PROBES)) {
    it(form, { timeout: 30_000 }, () => {
      expect(gatedRoutes(probe.files).map((route) => `${route.method} ${route.path}`).join(',')).toBe(probe.expect);
    });
  }

  it('a route with no gate is not listed', () => {
    expect(gatedRoutes({ 'main.py': `${ROUTE_HEAD}@app.post("/api/open")\ndef open_route():\n    return {}\n` })).toEqual([]);
  });
});
