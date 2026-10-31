/**
 * PR #204 round 9 (review 7 NIT-1): gate forms the backend scan (tests/personGateRoutes.py)
 * missed in synthetic code, each pinned to its exact route or unreadable line.
 * - The "person_required" code counts anywhere outside a comparison or a docstring: set by
 *   subscript, held in a local, a positional argument, or a string constant.
 * - A raised subclass of PersonGateError (its bases are followed).
 * - A container that holds a gate, used other than by subscript (a for loop, .get(), handed on),
 *   is listed as unreadable, as a subscript is.
 */
import { describe, expect, it } from 'vitest';
import { type UnreadableRouteForm, gatedRoutes, unreadableRouteForms } from './personGatedCallers';

const HEAD = 'from fastapi import FastAPI\napp = FastAPI()\n';
const PG = 'from services.person_gate import require_person\n';
const ERR = 'from services.person_gate import PersonGateError\n';
const POST = '@app.post("/api/probe")\n';
const GATE_FILES = {
  'services/__init__.py': '',
  'services/person_gate.py': 'class PersonGateError(Exception):\n    pass\nPERSON_REQUIRED = "person_required"\ndef require_person(headers):\n    raise PersonGateError(403)\n',
};
const ROUTE = ['POST /api/probe main.probe'];
const HELD = ['main.py @app.post whose handler reads a gate out of a container POST /api/probe'];

interface Probe { main: string; routes: string[]; unreadable?: string[]; files?: Record<string, string> }
const unreadLine = (form: UnreadableRouteForm) => `${form.file} ${form.form} ${form.method ?? '-'} ${form.path ?? '-'}`;

const PROBES: Record<string, Probe> = {
  // ---- the code, written as a value anywhere ----
  'a code set by subscript assignment': { main: `${HEAD}${POST}def probe(request):\n    event = {"type": "error"}\n    event["code"] = "person_required"\n    return event\n`, routes: ROUTE },
  'a code held in a local': { main: `${HEAD}${POST}def probe(request):\n    code = "person_required"\n    return {"code": code}\n`, routes: ROUTE },
  'a positional "person_required" argument': { main: `${HEAD}from services.refusals import Refusal\n${POST}def probe(request):\n    return Refusal(403, "x", "person_required")\n`, routes: ROUTE },
  'a module constant as a positional argument': { main: `${HEAD}from services.refusals import Refusal\nCODE = "person_" + "required"\n${POST}def probe(request):\n    return Refusal(403, "x", CODE)\n`, routes: ROUTE },
  'an f-string that makes the code': { main: `${HEAD}from services.refusals import Refusal\nP = "person"\n${POST}def probe(request):\n    return Refusal(403, f"{P}_required")\n`, routes: ROUTE },
  'the code in a helper the handler calls': { main: `${HEAD}def refuse(event):\n    event["code"] = "person_required"\n${POST}def probe(request):\n    event = {}\n    refuse(event)\n    return event\n`, routes: ROUTE },
  // Read, not written: neither.
  'the code compared (==, in a tuple, a constant)': { main: `${HEAD}CODE = "person_required"\n${POST}def probe(request, body: dict):\n    if body.get("code") in ("person_required", "x") or body.get("c") == CODE:\n        return {"retry": True}\n    return {}\n`, routes: [] },
  'a docstring that is only the code': { main: `${HEAD}${POST}def probe(request):\n    """person_required"""\n    return {}\n`, routes: [] },
  // ---- a subclass of PersonGateError ----
  'a raised subclass of PersonGateError': { main: `${HEAD}${ERR}class MyGate(PersonGateError):\n    pass\n${POST}def probe(request):\n    raise MyGate(403)\n`, routes: ROUTE },
  'a subclass two levels down, built in a helper': { main: `${HEAD}${ERR}class A(PersonGateError):\n    pass\nclass B(A):\n    pass\ndef refusal():\n    return B(403)\n${POST}def probe(request):\n    raise refusal()\n`, routes: ROUTE },
  'a subclass from another module': { main: `${HEAD}from services.errors import MyGate\n${POST}def probe(request):\n    raise MyGate(403)\n`,
    files: { 'services/errors.py': `${ERR}class MyGate(PersonGateError):\n    pass\n` }, routes: ROUTE },
  'a subclass of another error isn\'t a gate': { main: `${HEAD}class Other(Exception):\n    pass\n${POST}def probe(request):\n    raise Other(403)\n`, routes: [] },
  'except of a subclass isn\'t a gate': { main: `${HEAD}${ERR}class MyGate(PersonGateError):\n    pass\n${POST}def probe(request):\n    try:\n        return {}\n    except MyGate:\n        return {}\n`, routes: [] },
  // ---- a container that holds a gate ----
  'a gate in a list run in a for loop': { main: `${HEAD}${PG}CHECKS = [require_person]\n${POST}def probe(request):\n    for c in CHECKS:\n        c(request.headers)\n`, routes: [], unreadable: HELD },
  'a gate taken from a dict with .get': { main: `${HEAD}${PG}CHECKS = {"p": require_person}\n${POST}def probe(request):\n    CHECKS.get("p")(request.headers)\n`, routes: [], unreadable: HELD },
  'a gate list built in the handler and looped': { main: `${HEAD}${PG}${POST}def probe(request):\n    for c in [require_person]:\n        c(request.headers)\n`, routes: [], unreadable: HELD },
  'a gate list handed to a helper that loops it': { main: `${HEAD}${PG}CHECKS = (require_person,)\ndef run_all(checks, request):\n    for c in checks:\n        c(request.headers)\n${POST}def probe(request):\n    run_all(CHECKS, request)\n`, routes: [], unreadable: HELD },
  'a helper that loops a gate list, called by the handler': { main: `${HEAD}${PG}CHECKS = [require_person]\ndef run_all(request):\n    for c in CHECKS:\n        c(request.headers)\n${POST}def probe(request):\n    run_all(request)\n`, routes: [], unreadable: HELD },
  'a gate list looped two calls down': { main: `${HEAD}${PG}CHECKS = [require_person]\ndef run_all(request):\n    for c in CHECKS:\n        c(request.headers)\ndef outer(request):\n    run_all(request)\n${POST}def probe(request):\n    outer(request)\n`, routes: [], unreadable: HELD },
  'a list with no gate in it, looped, is neither': { main: `${HEAD}import os\nCHECKS = [os.getcwd]\n${POST}def probe(request):\n    for c in CHECKS:\n        c()\n`, routes: [] },
  'a gated route that also loops a gate list is just listed': { main: `${HEAD}${PG}CHECKS = [require_person]\n${POST}def probe(request):\n    require_person(request.headers)\n    for c in CHECKS:\n        c(request.headers)\n`, routes: ROUTE },
};

describe('round 9: gate forms the scan missed (review 7 NIT-1)', () => {
  for (const [form, { main, routes, unreadable = [], files = {} }] of Object.entries(PROBES)) {
    it(form, { timeout: 30_000 }, () => {
      const all = { ...GATE_FILES, ...files, 'main.py': main };
      expect(gatedRoutes(all).map((route) => `${route.method} ${route.path} ${route.handler}`).sort()).toEqual(routes);
      expect(unreadableRouteForms(all).map(unreadLine).sort()).toEqual(unreadable);
    });
  }
});
