/**
 * PR #204 round 10 (review 8 NIT-1 and LOW-2): gate forms the backend scan
 * (tests/personGateRoutes.py) missed in synthetic code, each pinned to its exact route or
 * unreadable line.
 * - NIT-1: the "person_required" code built by `"_".join([...])`, `.format` or `%` is the code; a
 *   gate container held as a class attribute (`for c in K.CHECKS`), or filled by
 *   `.append(require_person)` (and the like), is listed as unreadable like any gate container.
 * - LOW-2 (S_no_binop_code): an inline `"person_" + "required"` outside a dict value or keyword.
 * - LOW-2 (S_held_form_none): a handler named by reference (add_api_route, app.api_route(...)(fn))
 *   that reads a gate out of a container is listed with that form.
 * Negative controls: the code read (`in [...]`, `==`), however it is built, is neither.
 */
import { describe, expect, it } from 'vitest';
import { type UnreadableRouteForm, gatedRoutes, unreadableRouteForms } from './personGatedCallers';

const HEAD = 'from fastapi import FastAPI\napp = FastAPI()\n';
const PG = 'from services.person_gate import require_person\n';
const POST = '@app.post("/api/probe")\n';
const GATE_FILES = {
  'services/__init__.py': '',
  'services/person_gate.py': 'class PersonGateError(Exception):\n    pass\nPERSON_REQUIRED = "person_required"\ndef require_person(headers):\n    raise PersonGateError(403)\n',
};
const ROUTE = ['POST /api/probe main.probe'];
const HELD = ['main.py @app.post whose handler reads a gate out of a container POST /api/probe'];
const LOOP = '    for c in CHECKS:\n        c(request.headers)\n';

interface Probe { main: string; routes: string[]; unreadable?: string[] }
const unreadLine = (form: UnreadableRouteForm) => `${form.file} ${form.form} ${form.method ?? '-'} ${form.path ?? '-'}`;
const handler = (body: string) => `${HEAD}${POST}def probe(request, b: dict = {}):\n${body}`;

const PROBES: Record<string, Probe> = {
  // ---- NIT-1: the code, built ----
  'a code built by "_".join([...])': { main: handler('    return {"code": "_".join(["person", "required"])}\n'), routes: ROUTE },
  'a code built by .format': { main: handler('    return {"code": "{}_required".format("person")}\n'), routes: ROUTE },
  'a code built by .format with a keyword': { main: handler('    return {"code": "{who}_required".format(who="person")}\n'), routes: ROUTE },
  'a code built by %': { main: handler('    return {"code": "%s_required" % "person"}\n'), routes: ROUTE },
  'a code built by % of a tuple': { main: handler('    return {"code": "%s_%s" % ("person", "required")}\n'), routes: ROUTE },
  'a joined code set by subscript': { main: handler('    event = {}\n    event["code"] = "_".join(["person", "required"])\n    return event\n'), routes: ROUTE },
  'a joined code as a positional argument': { main: `${HEAD}from services.refusals import Refusal\n${POST}def probe(request):\n    return Refusal(403, "x", "_".join(("person", "required")))\n`, routes: ROUTE },
  'a %-built code held in a local': { main: handler('    code = "person_%s" % "required"\n    return {"c": code}\n'), routes: ROUTE },
  // ---- LOW-2: an inline + outside a dict value or keyword ----
  'an inline "person_" + "required" set by subscript': { main: handler('    event = {}\n    event["code"] = "person_" + "required"\n    return event\n'), routes: ROUTE },
  // ---- negative controls: read, however it is built ----
  'NEG the code compared with in [...]': { main: handler('    return {"r": b.get("code") in ["person_required"]}\n'), routes: [] },
  'NEG the code compared with ==': { main: handler('    return {"r": b.get("code") == "person_required"}\n'), routes: [] },
  'NEG a joined code compared': { main: handler('    return {"r": b.get("code") == "_".join(["person", "required"])}\n'), routes: [] },
  'NEG a %-built code compared': { main: handler('    return {"r": b.get("code") in ("%s_required" % "person",)}\n'), routes: [] },
  'NEG another code joined': { main: handler('    return {"code": "_".join(["person", "optional"])}\n'), routes: [] },
  'NEG a format it can\'t fill': { main: handler('    return {"code": "{}_required".format(b)}\n'), routes: [] },
  // ---- NIT-1: a gate container as a class attribute ----
  'a gate list held as a class attribute': { main: `${HEAD}${PG}class K:\n    CHECKS = [require_person]\n${POST}def probe(request):\n    for c in K.CHECKS:\n        c(request.headers)\n`,
    routes: [], unreadable: HELD },
  'a gate list held as an annotated class attribute': { main: `${HEAD}${PG}class K:\n    CHECKS: list = [require_person]\n${POST}def probe(request):\n    for c in K.CHECKS:\n        c(request.headers)\n`,
    routes: [], unreadable: HELD },
  'NEG a class attribute list with no gate': { main: `${HEAD}import os\nclass K:\n    CHECKS = [os.getcwd]\n${POST}def probe(request):\n    for c in K.CHECKS:\n        c()\n`, routes: [] },
  // ---- NIT-1: a gate container filled after it is made ----
  'a gate list filled by .append': { main: `${HEAD}${PG}CHECKS = []\nCHECKS.append(require_person)\n${POST}def probe(request):\n${LOOP}`, routes: [], unreadable: HELD },
  'a gate list filled by .extend': { main: `${HEAD}${PG}CHECKS = []\nCHECKS.extend([require_person])\n${POST}def probe(request):\n${LOOP}`, routes: [], unreadable: HELD },
  'a gate dict filled by subscript': { main: `${HEAD}${PG}CHECKS = {}\nCHECKS["p"] = require_person\n${POST}def probe(request):\n    for c in CHECKS.values():\n        c(request.headers)\n`,
    routes: [], unreadable: HELD },
  'a gate list filled by +=': { main: `${HEAD}${PG}CHECKS = []\nCHECKS += [require_person]\n${POST}def probe(request):\n${LOOP}`, routes: [], unreadable: HELD },
  'a gate list made by list() and filled by .append': { main: `${HEAD}${PG}CHECKS = list()\nCHECKS.append(require_person)\n${POST}def probe(request):\n${LOOP}`, routes: [], unreadable: HELD },
  'a class attribute list filled by .append': { main: `${HEAD}${PG}class K:\n    CHECKS = []\nK.CHECKS.append(require_person)\n${POST}def probe(request):\n    for c in K.CHECKS:\n        c(request.headers)\n`,
    routes: [], unreadable: HELD },
  // In a def, the gate handed to .append is a gate it reaches: the route is listed as gated.
  'a gate list filled by .append in the handler': { main: `${HEAD}${PG}${POST}def probe(request):\n    checks = []\n    checks.append(require_person)\n    for c in checks:\n        c(request.headers)\n`,
    routes: ROUTE },
  'NEG a list filled with no gate': { main: `${HEAD}import os\nCHECKS = []\nCHECKS.append(os.getcwd)\n${POST}def probe(request):\n${LOOP.replace('c(request.headers)', 'c()')}`, routes: [] },
  // ---- LOW-2: a handler named by reference that reads a gate out of a container ----
  'add_api_route of a handler that loops a gate list': { main: `${HEAD}${PG}CHECKS = [require_person]\ndef probe(request):\n${LOOP}app.add_api_route("/api/probe", probe, methods=["POST"])\n`,
    routes: [], unreadable: ['main.py app.add_api_route whose handler reads a gate out of a container POST /api/probe'] },
  'app.api_route(...)(fn) of a handler that loops a gate list': { main: `${HEAD}${PG}CHECKS = [require_person]\ndef probe(request):\n${LOOP}app.api_route("/api/probe", methods=["POST"])(probe)\n`,
    routes: [], unreadable: ['main.py app.api_route(...)(...) whose handler reads a gate out of a container POST /api/probe'] },
  'add_api_route of a handler that reads a gate by subscript': { main: `${HEAD}${PG}CHECKS = {"p": require_person}\ndef probe(request):\n    CHECKS["p"](request.headers)\napp.add_api_route("/api/probe", probe, methods=["POST"])\n`,
    routes: [], unreadable: ['main.py app.add_api_route whose handler reads a gate by subscript POST /api/probe'] },
};

describe('round 10: gate forms the scan missed (review 8 NIT-1, LOW-2)', () => {
  for (const [form, { main, routes, unreadable = [] }] of Object.entries(PROBES)) {
    it(form, { timeout: 30_000 }, () => {
      const all = { ...GATE_FILES, 'main.py': main };
      expect(gatedRoutes(all).map((route) => `${route.method} ${route.path} ${route.handler}`).sort()).toEqual(routes);
      expect(unreadableRouteForms(all).map(unreadLine).sort()).toEqual(unreadable);
    });
  }
});
