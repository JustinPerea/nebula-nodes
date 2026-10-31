/**
 * PR #204 round 11 (review 9 gates-trace LOW-1, NIT-2; lock-sweep LOW-2): the backend scan
 * (tests/personGateRoutes.py), in synthetic code.
 * - NIT-2: personOnly's unconditional run goes on past an `if` whose branches can't return (a
 *   validation guard that raises or falls through: POST /api/trash/empty's shape), and stops at
 *   one that may return; a `try` counts only when every handler raises again (mutants S5, S9).
 * - LOW-1: a container local to a function is keyed by that function. Another handler's local
 *   `checks.append(require_person)` no longer marks every `checks[...]` route unreadable, while a
 *   local container filled with a gate in the same handler (or a closure around it) still is.
 */
import { describe, expect, it } from 'vitest';
import { type UnreadableRouteForm, gatedRoutes, personOnlyRoutes, unreadableRouteForms } from './personGatedCallers';

const HEAD = 'from fastapi import FastAPI, HTTPException\napp = FastAPI()\n';
const PG = 'from services.person_gate import require_person\n';
const GATE_FILES = {
  'services/__init__.py': '',
  'services/person_gate.py': 'class PersonGateError(Exception):\n    pass\ndef require_person(headers):\n    raise PersonGateError(403)\n',
};
const handler = (body: string, name = 'probe', path = '/api/probe') => `@app.post("${path}")\ndef ${name}(request, kind=None):\n${body}`;
const both = (main: string) => {
  const files = { ...GATE_FILES, 'main.py': main };
  return {
    gated: gatedRoutes(files).map((r) => `${r.method} ${r.path}`).sort(),
    personOnly: personOnlyRoutes(files).map((r) => `${r.method} ${r.path}`).sort(),
  };
};
const ROUTE = ['POST /api/probe'];
const unreadLine = (form: UnreadableRouteForm) => `${form.file} ${form.form} ${form.method ?? '-'} ${form.path ?? '-'}`;

describe('round 11: personOnly past a guard, not past a branch (review 9 NIT-2, S5, S9)', () => {
  const PROBES: Record<string, { body: string; personOnly: string[] }> = {
    'a guard that calls a validator (empty_trash)': {
      body: '    """Docs."""\n    if kind is not None:\n        _check(kind)\n    require_person(request.headers)\n    return {}\n', personOnly: ROUTE },
    'a guard that raises': { body: '    if not kind:\n        raise HTTPException(400)\n    require_person(request.headers)\n    return {}\n', personOnly: ROUTE },
    'a guard with an else that raises': {
      body: '    if kind:\n        _check(kind)\n    else:\n        raise HTTPException(400)\n    require_person(request.headers)\n', personOnly: ROUTE },
    'a try whose handler raises again': {
      body: '    try:\n        require_person(request.headers)\n    except Exception:\n        raise\n    return {}\n', personOnly: ROUTE },
    // Negative controls: these may skip the gate, so the control stays live.
    'NEG an if that returns before the gate': { body: '    if kind:\n        return {}\n    require_person(request.headers)\n', personOnly: [] },
    'NEG an else that returns before the gate': {
      body: '    if kind:\n        _check(kind)\n    else:\n        return {}\n    require_person(request.headers)\n', personOnly: [] },
    'NEG a return nested in the guard': {
      body: '    if kind:\n        with open("x") as f:\n            return f.read()\n    require_person(request.headers)\n', personOnly: [] },
    'NEG a gate inside the if': { body: '    if kind:\n        require_person(request.headers)\n    return {}\n', personOnly: [] },
    'NEG a try whose handler swallows the refusal': {
      body: '    try:\n        require_person(request.headers)\n    except Exception:\n        pass\n    return {}\n', personOnly: [] },
    'NEG a try with one handler that swallows': {
      body: '    try:\n        require_person(request.headers)\n    except ValueError:\n        raise\n    except Exception:\n        return {}\n', personOnly: [] },
  };
  for (const [name, { body, personOnly }] of Object.entries(PROBES)) {
    it(name, { timeout: 30_000 }, () => {
      const main = `${HEAD}${PG}def _check(kind):\n    raise HTTPException(400)\n${handler(body)}`;
      expect(both(main)).toEqual({ gated: ROUTE, personOnly });
    });
  }
});

describe('round 11: a function\'s own container is keyed by that function (review 9 LOW-1)', () => {
  const OTHER = handler('    checks = list()\n    checks.append(require_person)\n    for c in checks:\n        c(request.headers)\n', 'other', '/api/other');
  const READS = handler('    out = list()\n    out.append(1)\n    return out[0]\n');
  it('another handler\'s local fill doesn\'t make this one unreadable', { timeout: 30_000 }, () => {
    const main = `${HEAD}${PG}${OTHER.replace(/checks/g, 'out')}${READS}`;
    const files = { ...GATE_FILES, 'main.py': main };
    expect(unreadableRouteForms(files).map(unreadLine)).toEqual([]);
    expect(gatedRoutes(files).map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/other']);
  });
  it('a local container filled with a gate in the handler that reads it by subscript is unreadable', { timeout: 30_000 }, () => {
    const main = `${HEAD}${PG}${handler('    checks = list()\n    checks.append(require_person)\n    return checks[0](request.headers)\n')}`;
    const files = { ...GATE_FILES, 'main.py': main };
    expect(unreadableRouteForms(files).map(unreadLine)).toEqual([]);
    // Reached directly too (the gate handed to .append): listed as gated.
    expect(gatedRoutes(files).map((r) => `${r.method} ${r.path}`)).toEqual(ROUTE);
  });
  it('a closure\'s container filled around a nested route is still read', { timeout: 30_000 }, () => {
    const main = `${HEAD}${PG}def make():\n    checks = list()\n    checks.append(require_person)\n    @app.post("/api/probe")\n    def probe(request):\n        return checks[0](request.headers)\n    return probe\n`;
    const files = { ...GATE_FILES, 'main.py': main };
    expect(unreadableRouteForms(files).map(unreadLine)).toEqual(['main.py @app.post whose handler reads a gate by subscript POST /api/probe']);
  });
  it('a module container filled inside a function (global) is the module\'s', { timeout: 30_000 }, () => {
    const main = `${HEAD}${PG}CHECKS = list()\ndef setup():\n    global CHECKS\n    CHECKS.append(require_person)\n${handler('    for c in CHECKS:\n        c(request.headers)\n')}`;
    const files = { ...GATE_FILES, 'main.py': main };
    expect(unreadableRouteForms(files).map(unreadLine)).toEqual(['main.py @app.post whose handler reads a gate out of a container POST /api/probe']);
  });
  it('a module container made by a function that declares it global is the module\'s', { timeout: 30_000 }, () => {
    const main = `${HEAD}${PG}def setup():\n    global CHECKS\n    CHECKS = list()\n    CHECKS.append(require_person)\n${handler('    for c in CHECKS:\n        c(request.headers)\n')}`;
    const files = { ...GATE_FILES, 'main.py': main };
    expect(unreadableRouteForms(files).map(unreadLine)).toEqual(['main.py @app.post whose handler reads a gate out of a container POST /api/probe']);
  });
  it('an instance container filled in __init__ (self.checks) is the class\'s', { timeout: 30_000 }, () => {
    const main = `${HEAD}${PG}class Gate:\n    def __init__(self):\n        self.checks = list()\n        self.checks.append(require_person)\n    def run(self, request):\n        return self.checks[0](request.headers)\ngate = Gate()\n${handler('    return gate.run(request)\n')}`;
    const files = { ...GATE_FILES, 'main.py': main };
    expect(unreadableRouteForms(files).map(unreadLine)).toEqual(['main.py @app.post whose handler reads a gate by subscript POST /api/probe']);
  });
});
