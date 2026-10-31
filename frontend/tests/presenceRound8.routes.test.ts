/**
 * PR #204 round 8: the backend scan for routes behind the person gate (tests/personGateRoutes.py),
 * after review 6 (LOW-5, NIT-2).
 *
 * 1. LOW-5: the refusal code "person_required" written as a value is a gate form (the chat
 *    socket's refusals, so `WS /ws/chat` is listed), and a gate read out of a container by
 *    subscript (`CHECKS["p"](...)`) is listed as unreadable, never skipped.
 * 2. NIT-2: `except PersonGateError` (or an isinstance) isn't a gate; building or raising one is.
 *    A sub-app mounted with mount() is listed as unreadable, and so is each route on it.
 * 3. Each gate name is a gate by name alone, also when its definition can't be read (review 6
 *    S2: `_person_only_refusal` was only ever found through its body).
 */
import { describe, expect, it } from 'vitest';
import { type UnreadableRouteForm, gatedRoutes, unreadableRouteForms } from './personGatedCallers';

const HEAD = 'from fastapi import APIRouter, Depends, FastAPI\napp = FastAPI()\n';
const PG = 'from services.person_gate import require_person\n';
const GATE_FILES = {
  'services/__init__.py': '',
  'services/person_gate.py': 'class PersonGateError(Exception):\n    pass\nPERSON_REQUIRED = "person_required"\ndef require_person(headers):\n    raise PersonGateError(403, "x", PERSON_REQUIRED)\n',
  'routes/__init__.py': '',
};
const BODY = 'def probe(request):\n    require_person(request.headers)\n';
const ERR = 'from services.person_gate import PersonGateError\n';
const POST = '@app.post("/api/probe")\n';

interface Probe { files: Record<string, string>; routes: string[]; unreadable: string[] }
const probe = (files: Record<string, string>, routes: string[], unreadable: string[] = []): Probe => ({ files: { ...GATE_FILES, ...files }, routes, unreadable });
const unreadLine = (form: UnreadableRouteForm) => `${form.file} ${form.form} ${form.method ?? '-'} ${form.path ?? '-'}`;
const SUBSCRIPT = 'main.py @app.post whose handler reads a gate by subscript POST /api/probe';

/** `routes`: "METHOD path handler"; `unreadable`: "file form method path". */
const PROBES: Record<string, Probe> = {
  // ---- LOW-5: the "person_required" refusal code ----
  'JSONResponse({"code": "person_required"}, 403)': probe({
    'main.py': `${HEAD}from fastapi.responses import JSONResponse\n${POST}def probe(request):\n    return JSONResponse({"code": "person_required"}, status_code=403)\n` },
  ['POST /api/probe main.probe']),
  'a websocket that sends {"code": "person_required"} (as /ws/chat)': probe({
    'main.py': `${HEAD}from services import person_session\n@app.websocket("/ws/probe")\nasync def probe(ws):\n    async def send_event(event):\n        await ws.send_json(event)\n    payload = await ws.receive_json()\n    if not person_session.verify(payload.get("personToken")):\n        await send_event({"type": "error", "code": "person_required", "source": "system"})\n` },
  ['WS /ws/probe main.probe']),
  'code="person_required" as a keyword': probe({
    'main.py': `${HEAD}from services.refusals import Refusal\n${POST}def probe(request):\n    return Refusal(403, code="person_required")\n` },
  ['POST /api/probe main.probe']),
  'the code from another module\'s string constant': probe({
    'main.py': `${HEAD}from services import codes\n${POST}def probe(request):\n    return {"code": codes.CODE}\n`,
    'services/codes.py': 'CODE = "person_" + "required"\n' },
  ['POST /api/probe main.probe']),
  '"person_required" read, not written as a value, isn\'t a gate': probe({
    'main.py': `${HEAD}${POST}def probe(request, body: dict):\n    """Answers person_required refusals from upstream."""\n    if body.get("code") == "person_required":\n        return {"retry": True}\n    return {}\n` },
  []),
  'the code in services/person_gate.py itself isn\'t a route': probe({ 'main.py': `${HEAD}from services.person_gate import PERSON_REQUIRED as _\n` }, []),

  // ---- LOW-5: a gate read by subscript ----
  'CHECKS["p"](...), a module-level dict': probe({
    'main.py': `${HEAD}${PG}CHECKS = {"p": require_person}\n${POST}def probe(request):\n    CHECKS["p"](request.headers)\n` },
  [], [SUBSCRIPT]),
  'a dict built in the handler, read into a name': probe({
    'main.py': `${HEAD}${PG}${POST}def probe(request):\n    checks = {"p": require_person}\n    check = checks["p"]\n    check(request.headers)\n` },
  [], [SUBSCRIPT]),
  'a list of gates from another module, read two calls down': probe({
    'main.py': `${HEAD}from services.checks import run\ndef outer(request):\n    run(request)\n${POST}def probe(request):\n    outer(request)\n`,
    'services/checks.py': `${PG}GATES = [require_person]\ndef run(request):\n    GATES[0](request.headers)\n` },
  [], [SUBSCRIPT]),
  'a subscripted container with a gated helper in it': probe({
    'main.py': `${HEAD}${PG}def helper(request):\n    require_person(request.headers)\nCHECKS = {"p": helper}\n${POST}def probe(request):\n    CHECKS["p"](request)\n` },
  [], [SUBSCRIPT]),
  'a gated route that also reads by subscript is just listed': probe({
    'main.py': `${HEAD}${PG}CHECKS = {"p": require_person}\n${POST}def probe(request):\n    require_person(request.headers)\n    CHECKS["p"](request.headers)\n` },
  ['POST /api/probe main.probe']),
  'a subscripted container with no gate in it is neither': probe({
    'main.py': `${HEAD}import os\nHANDLERS = {"cwd": os.getcwd}\n${POST}def probe(request):\n    return HANDLERS["cwd"]()\n` },
  []),

  // ---- NIT-2: PersonGateError built or raised, not caught ----
  'raise PersonGateError(...)': probe({ 'main.py': `${HEAD}${ERR}${POST}def probe(request):\n    raise PersonGateError(403, "x")\n` }, ['POST /api/probe main.probe']),
  'raise PersonGateError (the class, bare)': probe({ 'main.py': `${HEAD}${ERR}${POST}def probe(request):\n    raise PersonGateError\n` }, ['POST /api/probe main.probe']),
  'return PersonGateError(...) (built, as _person_only_refusal does)': probe({
    'main.py': `${HEAD}${ERR}def refusal():\n    return PersonGateError(403, "x")\n${POST}def probe(request):\n    raise refusal()\n` },
  ['POST /api/probe main.probe']),
  'an aliased PersonGateError raised': probe({
    'main.py': `${HEAD}from services.person_gate import PersonGateError as PGE\n${POST}def probe(request):\n    raise PGE(403, "x")\n` },
  ['POST /api/probe main.probe']),
  // A positional argument, not a value under a key: only the PERSON_REQUIRED name rule reads it.
  'PERSON_REQUIRED written': probe({
    'main.py': `${HEAD}from services.person_gate import PERSON_REQUIRED\nfrom services.refusals import Refusal\n${POST}def probe(request):\n    return Refusal(403, "x", PERSON_REQUIRED)\n` },
  ['POST /api/probe main.probe']),
  'except PersonGateError without a gate (review 6 B1) isn\'t a gate': probe({
    'main.py': `${HEAD}${ERR}${POST}def probe(request):\n    try:\n        pass\n    except PersonGateError as exc:\n        exc.detail = "x"\n        raise\n` },
  []),
  'except (HTTPException, PersonGateError) and isinstance() aren\'t gates': probe({
    'main.py': `${HEAD}from fastapi import HTTPException\n${ERR}${POST}def probe(request):\n    try:\n        return {}\n    except (HTTPException, PersonGateError) as exc:\n        if isinstance(exc, PersonGateError):\n            return {"x": 1}\n        return {}\n` },
  []),

  // ---- NIT-2: mount() ----
  'a sub-app mounted with mount()': probe({
    'main.py': `${HEAD}${PG}sub = FastAPI()\n@sub.post("/probe")\n${BODY}app.mount("/api/sub", sub)\n` },
  [], ['main.py @sub.post on an app or router mounted with mount() POST /probe', 'main.py an app or router mounted with mount() - -']),
  'a router included into a mounted sub-app': probe({
    'main.py': `${HEAD}from routes.x import router as xr\nsub = FastAPI()\nsub.include_router(xr, prefix="/x")\napp.mount("/api/sub", sub)\n`,
    'routes/x.py': `from fastapi import APIRouter\n${PG}router = APIRouter()\n@router.post("/probe")\n${BODY}` },
  [], ['main.py an app or router mounted with mount() - -', 'routes/x.py @router.post on a router whose prefix it can\'t read POST /probe']),
  'mount() of something that isn\'t an app (StaticFiles) is neither': probe({
    'main.py': `${HEAD}from fastapi.staticfiles import StaticFiles\napp.mount("/static", StaticFiles(directory="static"))\n` },
  []),
};

// ---- S2: each gate name counts by name, also when its definition can't be read ----
for (const name of ['require_person', '_person_only_refusal', 'stop_refusal', 'person_only']) {
  PROBES[`${name} from a module it can't read`] = probe({
    'main.py': `${HEAD}from nebula_ext.gates import ${name}\n${POST}def probe(request):\n    raise ${name}(request)\n` },
  ['POST /api/probe main.probe']);
}

describe('round 8: the refusal code, subscripts, PersonGateError and mount()', () => {
  for (const [form, { files, routes, unreadable }] of Object.entries(PROBES)) {
    it(form, { timeout: 30_000 }, () => {
      expect(gatedRoutes(files).map((route) => `${route.method} ${route.path} ${route.handler}`).sort()).toEqual(routes);
      expect(unreadableRouteForms(files).map(unreadLine).sort()).toEqual(unreadable);
    });
  }
});

describe('round 8: the real backend', () => {
  it('WS /ws/chat is gated: its refusals send the "person_required" code (LOW-5)', { timeout: 60_000 }, () => {
    expect(gatedRoutes().map((route) => `${route.method} ${route.path} ${route.handler}`)).toContain('WS /ws/chat main.chat_websocket');
  });
});
