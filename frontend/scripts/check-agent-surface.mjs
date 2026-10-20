#!/usr/bin/env node
// The canvas half of the agent-surface guard (Justin, 2026-10-20: "Every
// feature we add needs to make sure we include MCP support for agents").
//
// Reads backend/data/agent_surface.json (the export of backend/agent_surface.py)
// and fails when the canvas:
//   - calls an /api route no ROUTES row matches,
//   - has a GraphState member (frontend/src/store/graphStore.ts) with no
//     FRONTEND_ACTIONS row, or a row for a member that's gone,
//   - writes a "_" node param with no INTERNAL_PARAMS row, or a row nothing uses.
// The backend half is backend/tests/test_agent_surface.py.
//
// Usage: node frontend/scripts/check-agent-surface.mjs
// NEBULA_AGENT_SURFACE_SRC / NEBULA_AGENT_SURFACE_JSON point it at other copies
// (backend/tests/test_agent_surface.py checks broken ones).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SRC = process.env.NEBULA_AGENT_SURFACE_SRC || join(REPO_ROOT, 'frontend', 'src');
const MANIFEST_JSON = process.env.NEBULA_AGENT_SURFACE_JSON || join(REPO_ROOT, 'backend', 'data', 'agent_surface.json');
const STORE = join(SRC, 'store', 'graphStore.ts');
const MANIFEST = 'backend/agent_surface.py';
const REFRESH = 'then run `cd backend && .venv/bin/python agent_surface_check.py --write`';
const HOLE = '\u0000';

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'test' || name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.(test|spec)\./.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

// "/api..." string and template literals; each ${...} becomes HOLE.
export function apiLiterals(text) {
  const found = [];
  const start = /(['"`])\/api/g;
  let match;
  while ((match = start.exec(text)) !== null) {
    const quote = match[1];
    let i = match.index + 1;
    let value = '';
    let ok = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { value += text[i + 1] ?? ''; i += 2; continue; }
      if (ch === quote) { ok = true; break; }
      if (ch === '\n' && quote !== '`') break;
      if (quote === '`' && ch === '$' && text[i + 1] === '{') {
        let depth = 1;
        i += 2;
        while (i < text.length && depth > 0) {
          if (text[i] === '{') depth += 1;
          else if (text[i] === '}') depth -= 1;
          i += 1;
        }
        value += HOLE;
        continue;
      }
      value += ch;
      i += 1;
    }
    if (ok) found.push({ value, index: match.index });
    start.lastIndex = Math.max(start.lastIndex, i + 1);
  }
  return found;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function routeRegex(path) {
  return new RegExp(`^${path.split(/(\{[^}]+\})/).map((part) => (
    part.startsWith('{') ? (part.endsWith(':path}') ? '.+' : '[^/]+') : escapeRe(part)
  )).join('')}$`);
}

// Whether a literal can be a request to one of the routes.
export function literalMatches(literal, paths) {
  const bare = literal.split('?')[0];
  // A prefix the canvas builds or tests urls with ('/api/outputs/', '/api/commons').
  if (!bare.includes(HOLE) && paths.some((path) => path.startsWith(`${bare.replace(/\/$/, '')}/`))) return true;
  if (bare.endsWith('/') && paths.some((path) => path.startsWith(bare) || routeRegex(`${path}/`).test(bare))) return true;
  let pattern = '';
  for (let i = 0; i < bare.length; i += 1) {
    const ch = bare[i];
    if (ch !== HOLE) { pattern += escapeRe(ch); continue; }
    const segment = bare[i - 1] === '/' && (i + 1 === bare.length || bare[i + 1] === '/');
    pattern += segment ? '[^/]+' : '.*';
  }
  const literalRe = new RegExp(`^${pattern}$`);
  const sample = bare.split(HOLE).join('X1');
  return paths.some((path) => literalRe.test(path.replace(/\{[^}]+\}/g, 'X1')) || routeRegex(path).test(sample));
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

// Members of `interface GraphState { ... }` at depth 1.
export function storeMembers(text) {
  const at = text.indexOf('interface GraphState {');
  if (at < 0) throw new Error('graphStore.ts has no `interface GraphState {`');
  // Comments inside the interface can hold unbalanced brackets; the interface
  // itself holds no strings that look like comments, so stripping is safe there.
  const end = text.indexOf('\n}', at);
  const clean = stripComments(text.slice(at, end < 0 ? undefined : end + 2));
  const members = [];
  let depth = 0;
  let lineStart = true;
  for (let i = 'interface GraphState '.length; i < clean.length; i += 1) {
    const ch = clean[i];
    if ('{(['.includes(ch)) depth += 1;
    else if ('})]'.includes(ch)) {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && lineStart) {
      const m = /^[ \t]*(?:readonly[ \t]+)?([A-Za-z_$][\w$]*)\??[ \t]*[:(]/.exec(clean.slice(i, i + 200));
      if (m) members.push(m[1]);
    }
    lineStart = ch === '\n';
  }
  return members;
}

// "_" names the canvas uses where a node param could be: params._x, params['_x'],
// { _x: ... } keys and '_x' strings.
export function underscoreNames(text) {
  const names = new Map();
  const add = (name, index) => { if (!names.has(name)) names.set(name, index); };
  const clean = text;
  for (const re of [
    /params\??\.(_[A-Za-z][\w]*)/g,
    /params\??\[['"](_[A-Za-z][\w]*)['"]\]/g,
    /(?:^|[{,(\s])['"]?(_[a-z][A-Za-z0-9]*)['"]?\s*\??:(?!:)/gm,
    /['"`](_[a-z][A-Za-z0-9_]*)['"`]/g,
  ]) {
    let m;
    while ((m = re.exec(clean)) !== null) add(m[1], m.index);
  }
  return names;
}

export function check({ src = SRC, manifestPath = MANIFEST_JSON } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const routePaths = [...new Set(Object.keys(manifest.routes).map((key) => key.split(' ').slice(1).join(' ')))];
  const problems = [];
  const usedUnderscore = new Set();

  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(REPO_ROOT, file);
    for (const { value, index } of apiLiterals(text)) {
      if (!literalMatches(value, routePaths)) {
        problems.push(`${rel}:${lineOf(text, index)} calls ${value.split(HOLE).join('${...}')}, which no ROUTES row in ${MANIFEST} matches. A new route needs its row there (${REFRESH}); a route that's gone needs this call fixed.`);
      }
    }
    for (const [name, index] of underscoreNames(text)) {
      if (name in manifest.frontendNotParams) continue;
      usedUnderscore.add(name);
      if (!(name in manifest.internalParams)) {
        problems.push(`${rel}:${lineOf(text, index)} uses "${name}": add "${name}": ... to INTERNAL_PARAMS in ${MANIFEST} (agents can't send "_" params, so name the tool that writes it server-side, or Gap/Exempt), or to FRONTEND_NOT_PARAMS if it isn't a node param; ${REFRESH}.`);
      }
    }
  }

  const backendParams = new Set(manifest.backendParams);
  for (const name of Object.keys(manifest.internalParams)) {
    if (!usedUnderscore.has(name) && !backendParams.has(name) && !['_provider', '_kreaAuth'].includes(name)) {
      problems.push(`INTERNAL_PARAMS["${name}"]: neither the backend nor the canvas uses it any more; delete the row (${REFRESH}).`);
    }
  }

  const members = storeMembers(readFileSync(STORE, 'utf8'));
  const rows = new Set(Object.keys(manifest.frontendActions));
  for (const member of members) {
    if (!rows.has(`graphStore.${member}`)) {
      problems.push(`graphStore.${member} has no row: add "graphStore.${member}": Tool("<mcp tool>") (or ReadOnly, Propose, Gap, Exempt("browser-state")) to FRONTEND_ACTIONS in ${MANIFEST}; if its logic runs only in the canvas, move it into a backend route first. ${REFRESH}.`);
    }
  }
  const memberSet = new Set(members.map((m) => `graphStore.${m}`));
  for (const row of rows) {
    if (!memberSet.has(row)) problems.push(`FRONTEND_ACTIONS["${row}"]: GraphState no longer has it; delete the row (${REFRESH}).`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = check();
  if (problems.length) {
    console.error(`Agent surface: ${problems.length} problem(s)\n${problems.map((p) => `- ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Agent surface: every /api call, store action and "_" param on the canvas has a row.');
}
