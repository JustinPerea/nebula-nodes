/**
 * PR #204 round 7: the backend scan for routes behind the person gate (tests/personGateRoutes.py)
 * fails closed. Two reviews found it skipped forms it couldn't read; now every such form is
 * listed as unreadable, and the forms it can read are read.
 *
 * 1. The real backend: the exact gated route set is pinned to personGateRoutes.snapshot.json, and
 *    every unreadable form in it is declared below with why it is fine.
 * 2. One probe per form (through the --stdin files mode): each gated route is found with its
 *    method and path, or is listed as unreadable, never nothing.
 * 3. The directory mode reads every package under the backend (not only main.py, routes/ and
 *    services/) and skips tests/, __pycache__/ and virtualenvs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GatedRoute, type UnreadableRouteForm, gatedRoutes, unreadableRouteForms } from './personGatedCallers';

const SCRIPT = join(__dirname, 'personGateRoutes.py');
const SNAPSHOT = join(__dirname, 'personGateRoutes.snapshot.json');

const key = (route: GatedRoute) => `${route.method} ${route.path} ${route.handler}`;
const sortKeys = (routes: GatedRoute[]) => routes.map(key).sort();
const unreadKey = (form: UnreadableRouteForm) => `${form.file} ${form.handler ?? '-'} ${form.form}`;

/**
 * Every unreadable route form in today's backend, keyed `file handler form`, with why it is fine.
 * An undeclared one fails (read it, then declare it here or teach the script the form); a
 * declared one that is gone fails too. Today there are none: main.py's
 * `@app.get(backend_address.PROOF_PATH)` is read now (PROOF_PATH is a string constant in
 * services/backend_address.py) and is ungated, so it is in neither list.
 */
const DECLARED: Record<string, string> = {};

describe('round 7: the real backend', () => {
  it('the gated route set is exactly the snapshot', { timeout: 60_000 }, () => {
    // Pinned on purpose: a route that leaves the gate, or a new gated route, fails here until
    // personGateRoutes.snapshot.json is updated by hand (and the frontend callers are checked).
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as GatedRoute[];
    const routes = gatedRoutes();
    // 67 since round 8: WS /ws/chat, whose refusals send the "person_required" code (LOW-5).
    expect(routes.length).toBe(67);
    expect(snapshot.length).toBe(67);
    expect(sortKeys(routes)).toEqual(sortKeys(snapshot));
  });

  it('every unreadable form is declared, and every declaration is still there', { timeout: 60_000 }, () => {
    const found = unreadableRouteForms();
    const undeclared = found.filter((form) => !(unreadKey(form) in DECLARED)).map((form) => `${form.file}:${form.line} ${unreadKey(form)}`);
    expect(undeclared).toEqual([]);
    const seen = new Set(found.map(unreadKey));
    expect(Object.keys(DECLARED).filter((declared) => !seen.has(declared))).toEqual([]);
  });
});

// ---------- probes ----------

const HEAD = 'from fastapi import APIRouter, Depends, FastAPI\napp = FastAPI()\n';
const PG = 'from services.person_gate import require_person\n';
const GATE_FILES = {
  'services/__init__.py': '',
  'services/person_gate.py': 'class PersonGateError(Exception):\n    pass\ndef require_person(headers):\n    raise PersonGateError(403)\n',
  'routes/__init__.py': '',
  'routes/krea_connector.py': 'from services.person_gate import require_person\ndef person_only(request):\n    require_person(request.headers)\n',
};
const BODY = 'def probe(request):\n    require_person(request.headers)\n';

interface Probe { files: Record<string, string>; routes: string[]; unreadable?: string[] }
const probe = (files: Record<string, string>, routes: string[], unreadable: string[] = []): Probe => ({ files: { ...GATE_FILES, ...files }, routes, unreadable });

/** `routes`: "METHOD path handler"; `unreadable`: "file form [method path]". */
const PROBES: Record<string, Probe> = {
  '@app.post(path="/api/probe")': probe({ 'main.py': `${HEAD}${PG}@app.post(path="/api/probe")\n${BODY}` }, ['POST /api/probe main.probe']),
  'app.add_api_route(...)': probe({ 'main.py': `${HEAD}${PG}${BODY}app.add_api_route("/api/probe", probe, methods=["POST"])\napp.add_api_route("/api/plain", probe)\n` },
    ['GET /api/plain main.probe', 'POST /api/probe main.probe']),
  'app.add_api_route with an endpoint it can\'t find': probe({ 'main.py': `${HEAD}def register(handler):\n    app.add_api_route("/api/probe", handler)\n` },
    [], ['main.py app.add_api_route with an endpoint it can\'t find - /api/probe']),
  'a module instance\'s method': probe({ 'main.py': `${HEAD}${PG}class Gate:\n    def check(self, request):\n        require_person(request.headers)\ngate = Gate()\n@app.post("/api/probe")\ndef probe(request):\n    gate.check(request)\n` },
    ['POST /api/probe main.probe']),
  'an instance imported from another module': probe({
    'main.py': `${HEAD}from services.gates import gate\n@app.post("/api/probe")\ndef probe(request):\n    gate.check(request)\n`,
    'services/gates.py': `${PG}class Gate:\n    def check(self, request):\n        require_person(request.headers)\ngate = Gate()\n` }, ['POST /api/probe main.probe']),
  'a dotted import chain': probe({
    'main.py': `${HEAD}import services.helpers\n@app.post("/api/probe")\ndef probe(request):\n    services.helpers.check(request)\n`,
    'services/helpers.py': `${PG}def check(request):\n    require_person(request.headers)\n` }, ['POST /api/probe main.probe']),
  'an import inside the handler': probe({
    'main.py': `${HEAD}@app.post("/api/probe")\ndef probe(request):\n    from services import helpers\n    helpers.check(request)\n`,
    'services/helpers.py': `${PG}def check(request):\n    require_person(request.headers)\n` }, ['POST /api/probe main.probe']),
  'an f-string path it can read': probe({ 'main.py': `${HEAD}${PG}BASE = "/api"\n@app.post(f"{BASE}/probe")\n${BODY}` }, ['POST /api/probe main.probe']),
  'an f-string path it can\'t read': probe({ 'main.py': `${HEAD}${PG}import os\n@app.post(f"/api/{os.environ['P']}")\n${BODY}` },
    [], ['main.py @app.post with a path it can\'t read POST -']),
  '@xr.post on a router imported into main': probe({
    'main.py': `${HEAD}${PG}from routes.x import router as xr\n@xr.post("/probe")\n${BODY}app.include_router(xr)\n`,
    'routes/x.py': 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/api/x")\n' }, ['POST /api/x/probe main.probe']),
  '@xr.post on an owner it can\'t read': probe({ 'main.py': `${HEAD}${PG}def register(xr):\n    @xr.post("/api/probe")\n    ${BODY.replace('\n    ', '\n        ')}` },
    [], ['main.py @xr.post on xr, not an app or router it can read POST /api/probe']),
  'a lambda alias': probe({ 'main.py': `${HEAD}${PG}g = lambda *a: require_person(*a)\n@app.post("/api/probe")\ndef probe(request):\n    g(request.headers)\n` },
    ['POST /api/probe main.probe']),
  'a custom @person_required decorator': probe({
    'main.py': `${HEAD}from services.deco import person_required\n@app.post("/api/probe")\n@person_required\ndef probe(request):\n    return {}\n`,
    'services/deco.py': `import functools\n${PG}def person_required(fn):\n    @functools.wraps(fn)\n    def inner(request, *a, **k):\n        require_person(request.headers)\n        return fn(request, *a, **k)\n    return inner\n` },
    ['POST /api/probe main.probe']),
  'a decorator factory @person_required()': probe({
    'main.py': `${HEAD}${PG}def person_required():\n    def mark(fn):\n        def inner(request):\n            require_person(request.headers)\n            return fn(request)\n        return inner\n    return mark\n@app.post("/api/probe")\n@person_required()\ndef probe(request):\n    return {}\n` },
    ['POST /api/probe main.probe']),
  'getattr(pg, "require_person")': probe({ 'main.py': `${HEAD}from services import person_gate as pg\n@app.post("/api/probe")\ndef probe(request):\n    getattr(pg, "require_person")(request.headers)\n` },
    ['POST /api/probe main.probe']),
  'include_router(xr, dependencies=[Depends(person_only)])': probe({
    'main.py': `${HEAD}from routes.krea_connector import person_only\nfrom routes.x import router as xr\napp.include_router(xr, dependencies=[Depends(person_only)])\n`,
    'routes/x.py': 'from fastapi import APIRouter\nrouter = APIRouter()\n@router.post("/api/probe")\ndef probe():\n    return {}\n' }, ['POST /api/probe x.probe']),
  'include_router(xr, prefix="/api/x")': probe({
    'main.py': `${HEAD}from routes.x import router as xr\napp.include_router(xr, prefix="/api/x")\n`,
    'routes/x.py': `from fastapi import APIRouter\n${PG}router = APIRouter()\n@router.post("/probe")\n${BODY}` }, ['POST /api/x/probe x.probe']),
  'include_router with a prefix it can\'t read': probe({
    'main.py': `${HEAD}import os\nfrom routes.x import router as xr\napp.include_router(xr, prefix=os.environ["P"])\n`,
    'routes/x.py': `from fastapi import APIRouter\n${PG}router = APIRouter()\n@router.post("/probe")\n${BODY}` },
    [], ['main.py include_router prefix= it can\'t read - -', 'routes/x.py @router.post on a router whose prefix it can\'t read POST /probe']),
  'include_router of something it can\'t read': probe({ 'main.py': `${HEAD}import plugins\napp.include_router(plugins.load())\n` },
    [], ['main.py include_router of plugins.load(), not a router it can read - -']),
  'a router mounted inside another router': probe({
    'main.py': `${HEAD}from routes.x import outer\napp.include_router(outer, prefix="/api")\n`,
    'routes/x.py': `from fastapi import APIRouter\n${PG}inner = APIRouter(prefix="/in")\nouter = APIRouter(prefix="/out")\n@inner.post("/probe")\n${BODY}outer.include_router(inner)\n` },
    ['POST /api/out/in/probe x.probe']),
  'router = make()': probe({ 'routes/x.py': `from fastapi import APIRouter\n${PG}def make():\n    return APIRouter(prefix="/api/m")\nrouter = make()\n@router.post("/probe")\n${BODY}` },
    ['POST /api/m/probe x.probe']),
  'router = a call it can\'t follow': probe({ 'routes/x.py': `import factory\n${PG}router = factory.build()\n@router.post("/api/probe")\n${BODY}` },
    [], ['routes/x.py @router.post on router, not an app or router it can read POST /api/probe']),
  'methods=M': probe({ 'main.py': `${HEAD}${PG}M = ["POST"]\n@app.api_route("/api/probe", methods=M)\n${BODY}` },
    [], ['main.py @app.api_route with methods= it can\'t read * /api/probe']),
  'a path from a constant': probe({ 'main.py': `${HEAD}${PG}PROBE = "/api/probe"\n@app.post(PROBE)\n${BODY}` }, ['POST /api/probe main.probe']),
  'a path from another module\'s constant': probe({
    'main.py': `${HEAD}${PG}from services import addr\n@app.post(addr.PROBE_PATH)\n${BODY}`,
    'services/addr.py': 'PROBE_PATH = "/api/" + "probe"\n' }, ['POST /api/probe main.probe']),
  'a path it can\'t read (a subscript)': probe({ 'main.py': `${HEAD}${PG}PATHS = ["/api/probe"]\n@app.post(PATHS[0])\n${BODY}` },
    [], ['main.py @app.post with a path it can\'t read POST -']),
  'a decorator\'s dependencies=': probe({ 'main.py': `${HEAD}from routes.krea_connector import person_only\n@app.post("/api/probe", dependencies=[Depends(person_only)])\ndef probe():\n    return {}\n` },
    ['POST /api/probe main.probe']),
  'stop_refusal': probe({ 'main.py': `${HEAD}from services.runs import stop_refusal\n@app.post("/api/probe")\ndef probe():\n    return stop_refusal(None)\n`,
    'services/runs.py': 'def stop_refusal(started_by):\n    return None\n' }, ['POST /api/probe main.probe']),
  'a websocket': probe({ 'main.py': `${HEAD}${PG}@app.websocket("/ws/probe")\nasync def probe(socket):\n    require_person(socket.headers)\n` }, ['WS /ws/probe main.probe']),
  'a gated middleware': probe({ 'main.py': `${HEAD}${PG}@app.middleware("http")\nasync def fence(request, call_next):\n    require_person(request.headers)\n    return await call_next(request)\n` },
    [], ['main.py a middleware that reaches a gate - -']),
  'a file that doesn\'t parse': probe({ 'main.py': `${HEAD}def broken(:\n` }, [], ['main.py a file that doesn\'t parse - -']),
};

const unreadLine = (form: UnreadableRouteForm) => `${form.file} ${form.form} ${form.method ?? '-'} ${form.path ?? '-'}`;

describe('round 7: every route form is read, or listed as unreadable', () => {
  for (const [form, { files, routes, unreadable }] of Object.entries(PROBES)) {
    it(form, { timeout: 30_000 }, () => {
      expect(gatedRoutes(files).map((route) => `${route.method} ${route.path} ${route.handler}`).sort()).toEqual(routes);
      expect(unreadableRouteForms(files).map(unreadLine).sort()).toEqual(unreadable);
      expect(routes.length + (unreadable ?? []).length).toBeGreaterThan(0);
    });
  }

  it('an ungated route gives neither a route nor an unreadable form', { timeout: 30_000 }, () => {
    const files = { ...GATE_FILES, 'main.py': `${HEAD}import os\n@app.post("/api/open")\ndef open_route(request):\n    return {"cwd": os.getcwd()}\napp.add_api_route("/api/open2", open_route, methods=["PUT"])\n` };
    expect(gatedRoutes(files)).toEqual([]);
    expect(unreadableRouteForms(files)).toEqual([]);
  });
});

// ---------- the directory mode ----------

describe('round 7: the directory mode reads every backend package', () => {
  it('a helper in handlers/ gates; tests/, __pycache__/ and a virtualenv are skipped', { timeout: 30_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'nebula-gate-routes-'));
    try {
      const write = (rel: string, source: string) => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), source);
      };
      for (const [rel, source] of Object.entries(GATE_FILES)) write(rel, source);
      write('main.py', `${HEAD}from handlers.checks import check\n@app.post("/api/probe")\ndef probe(request):\n    check(request)\n`);
      write('handlers/__init__.py', '');
      write('handlers/checks.py', `${PG}def check(request):\n    require_person(request.headers)\n`);
      // Gated routes in places that aren't the backend: never listed.
      const skipped = `${HEAD}${PG}@app.post("/api/skipped")\n${BODY}`;
      write('tests/test_probe.py', skipped);
      write('__pycache__/probe.py', skipped);
      write('.venv/lib/probe.py', skipped);
      write('localenv/pyvenv.cfg', 'home = /usr/bin\n');
      write('localenv/lib/probe.py', skipped);
      const scan = JSON.parse(execFileSync('python3', ['-I', SCRIPT, root], { encoding: 'utf8' })) as { routes: GatedRoute[]; unreadable: UnreadableRouteForm[] };
      expect(scan.routes.map(key)).toEqual(['POST /api/probe main.probe']);
      expect(scan.unreadable).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
