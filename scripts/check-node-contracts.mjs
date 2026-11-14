import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeTables, tableProblems as moodboardAdapterProblems } from './moodboard-adapter-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const NODE_DEFS_PATH = join(REPO_ROOT, 'backend', 'data', 'node_definitions.json');
const FRONTEND_DEFS_PATH = join(REPO_ROOT, 'frontend', 'src', 'constants', 'nodeDefinitions.ts');
const ENV_EXAMPLE_PATH = join(REPO_ROOT, '.env.example');
const SETTINGS_EXAMPLE_PATH = join(REPO_ROOT, 'settings.example.json');
// Inline route-table nodes (route_cases.json) and the key -> provider table
// (route_tables.json, generated from backend services/node_route.py).
// NEBULA_CONTRACTS_ROUTE_CASES_PATH: another copy of the fixture nodes (tests
// check a broken copy with it).
const ROUTE_CASES_PATH = process.env.NEBULA_CONTRACTS_ROUTE_CASES_PATH || join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'route_cases.json');
const ROUTE_TABLES_PATH = join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'route_tables.json');
// NEBULA_CONTRACTS_PRICING_PATH points the check at another pricing table
// (tests/test_node_contracts.py checks a broken copy with it).
const PRICING_PATH = process.env.NEBULA_CONTRACTS_PRICING_PATH || join(REPO_ROOT, 'backend', 'data', 'model_pricing.json');
// NEBULA_CONTRACTS_ADAPTERS_PATH and NEBULA_CONTRACTS_KREA_ADAPTERS_PATH point
// the moodboard adapter check at other copies of the two tables (tests break
// a copy and expect the backend's message).
const ADAPTERS_PATH = process.env.NEBULA_CONTRACTS_ADAPTERS_PATH || join(REPO_ROOT, 'backend', 'data', 'moodboard_adapters.json');
const KREA_ADAPTERS_PATH = process.env.NEBULA_CONTRACTS_KREA_ADAPTERS_PATH || join(REPO_ROOT, 'backend', 'data', 'moodboard_adapters_krea.json');
const KREA_CATALOG_PATH = join(REPO_ROOT, 'backend', 'data', 'krea_gateway_models.json');

const VALID_CATEGORIES = new Set([
  'image-gen',
  'video-gen',
  'text-gen',
  'audio-gen',
  '3d-gen',
  'transform',
  'analyzer',
  'utility',
  'universal',
  'cinematic',
  'character',
  'moodboard',
]);
const VALID_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'runway',
  'kling',
  'elevenlabs',
  'replicate',
  'fal',
  'bytedance',
  'minimax',
  'luma',
  'xai',
  'recraft',
  'ideogram',
  'openrouter',
  'bfl',
  'higgsfield',
  'meshy',
  'quiver',
  'krea',
  'nous',
  'worldlabs',
  'typesafe',
  'speridlabs',
  'utility',
]);
const VALID_EXECUTION_PATTERNS = new Set(['sync', 'async-poll', 'stream']);
const VALID_PORT_TYPES = new Set([
  'Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Mesh',
  'Character', 'Moodboard', 'CameraRig', 'ReferenceSet',
  'CameraPose', 'CameraPath', 'SpatialContext', 'DepthMap', 'DepthSequence',
  'PointCloud', 'SensorRig', 'SensorStream', 'SpatialSession',
  'World', 'Any',
]);
// moodboard / character: a saved asset's id (backend services/agent_params.py).
const VALID_PARAM_TYPES = new Set(['string', 'integer', 'float', 'boolean', 'enum', 'textarea', 'file', 'palette', 'moodboard', 'character']);
const PARAM_GROUPS = ['params', 'sharedParams', 'falParams', 'directParams'];
// A route-table node's routes (definition `routes`, docs/PROVIDER-ROUTES.md).
const ROUTE_HANDLERS = new Set(['bfl', 'fal', 'replicate-model', 'openrouter-images', 'openrouter-videos', 'krea',
  'hf-space']);
const ROUTE_FIELDS = new Set(['id', 'provider', 'maker', 'keys', 'optionalKeys', 'plan', 'handler', 'endpoint', 'endpointWhen',
  'params', 'rename', 'valueMap', 'rules', 'paramVisibleWhen', 'pricing', 'note', 'missingKeyLine', 'mayBillWithKey']);
const ROUTE_RULES = new Set(['blockedBy', 'accepts', 'rejects', 'rejectsWhen', 'size', 'ports']);
const BILLING_PARAMS = ['_provider', '_kreaAuth'];
const LOCAL_EXECUTION_NODE_IDS = new Set([
  'text-input',
  'image-input',
  'paper-source',
  'video-input',
  'audio-input',
  'sticky-note',
  'frame-extractor',
  'array-builder',
  'array-selector',
  'image-compare',
  'svg-rasterize',
  'iterator-image',
  'iterator-text',
  'batch',
  'preview',
  'combine-text',
  'router',
  'reroute',
]);

const definitions = JSON.parse(await readFile(NODE_DEFS_PATH, 'utf8'));
const frontendSource = await readFile(FRONTEND_DEFS_PATH, 'utf8');
const envExample = await readFile(ENV_EXAMPLE_PATH, 'utf8');
const settingsExample = JSON.parse(await readFile(SETTINGS_EXAMPLE_PATH, 'utf8'));
const routeFixtures = JSON.parse(await readFile(ROUTE_CASES_PATH, 'utf8')).definitions ?? {};
const pricing = JSON.parse(await readFile(PRICING_PATH, 'utf8'));
const keyProviders = JSON.parse(await readFile(ROUTE_TABLES_PATH, 'utf8')).keyProviders ?? {};
const moodboardAdapters = JSON.parse(await readFile(ADAPTERS_PATH, 'utf8'));
const kreaMoodboardAdapters = JSON.parse(await readFile(KREA_ADAPTERS_PATH, 'utf8'));
const kreaCatalog = JSON.parse(await readFile(KREA_CATALOG_PATH, 'utf8'));
// backend/services/credential_catalog.py KEYS_AHEAD_OF_NODES: keys Settings
// lists before any node uses them.
const catalogSource = await readFile(join(REPO_ROOT, 'backend', 'services', 'credential_catalog.py'), 'utf8');
const keysAheadOfNodes = new Set([
  ...(catalogSource.match(/KEYS_AHEAD_OF_NODES[^=]*= frozenset\(\{([\s\S]*?)\}\)/)?.[1] ?? '').matchAll(/"([A-Z0-9_]+)"/g),
].map((match) => match[1]));
const errors = [];

validateRegistryShape();
validateRoutes(definitions, '');
validateRoutes(routeFixtures, 'route_cases.json ');
validateHiddenPrices(definitions, pricing);
validateFrontendBackendIdParity();
validateCredentialExampleCoverage();
validateGeneratedReference();
validatePinnedCorrections();
validateLocalExecutionCoverage();
validateLocalExecutionProvider();
validateProviderVia();
validateMoodboardAdapters();

if (errors.length) {
  console.error(`Node contract check failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Node contract check passed for ${Object.keys(definitions).length} definitions.`);

function validateRegistryShape() {
  for (const [nodeId, definition] of Object.entries(definitions)) {
    if (definition.id !== nodeId) errors.push(`${nodeId}.id must match registry key`);
    if (!definition.displayName) errors.push(`${nodeId}.displayName is required`);
    if (!VALID_CATEGORIES.has(definition.category)) errors.push(`${nodeId}.category invalid: ${definition.category}`);
    if (!VALID_PROVIDERS.has(definition.apiProvider)) errors.push(`${nodeId}.apiProvider invalid: ${definition.apiProvider}`);
    if (!VALID_EXECUTION_PATTERNS.has(definition.executionPattern)) {
      errors.push(`${nodeId}.executionPattern invalid: ${definition.executionPattern}`);
    }
    if (!(typeof definition.envKeyName === 'string' || Array.isArray(definition.envKeyName) || definition.envKeyName === null)) {
      errors.push(`${nodeId}.envKeyName must be string, array, or null`);
    }
    validatePorts(nodeId, 'inputPorts', definition.inputPorts);
    validatePorts(nodeId, 'outputPorts', definition.outputPorts);
    if ('displayOutputs' in definition) {
      // Display-only outputs are saved with the node but never wired, so an id
      // here must not also be a wireable output.
      validatePorts(nodeId, 'displayOutputs', definition.displayOutputs);
      const wireable = new Set((definition.outputPorts ?? []).map((port) => port?.id));
      for (const port of Array.isArray(definition.displayOutputs) ? definition.displayOutputs : []) {
        if (wireable.has(port?.id)) errors.push(`${nodeId}.displayOutputs.${port.id} repeats an outputPorts id`);
      }
    }
    for (const group of PARAM_GROUPS) validateParams(nodeId, group, definition[group]);
    for (const [index, route] of (Array.isArray(definition.routes) ? definition.routes : []).entries()) {
      validateParams(nodeId, `routes[${index}].params`, route?.params);
    }
  }
}

// Route-table nodes: the same rules as backend services/node_route.py
// routes_problems (test_node_contracts.py runs it over the registry).

function keyNames(value) {
  return (Array.isArray(value) ? value : [value]).filter((key) => typeof key === 'string' && key);
}

function validateRoutes(nodes, source) {
  for (const [nodeId, definition] of Object.entries(nodes)) {
    if (!('routes' in definition)) continue;
    const where = `${source}${nodeId}`;
    const routes = definition.routes;
    if (!Array.isArray(routes) || !routes.length) {
      errors.push(`${where}.routes must be a non-empty list`);
      continue;
    }
    for (const field of ['directParams', 'falParams', 'directRoute']) {
      if (field in definition) errors.push(`${where}.${field} can't sit next to routes`);
    }
    const ids = [];
    const own = new Map();
    const shared = new Set((definition.sharedParams ?? []).map((param) => param?.key));
    routes.forEach((route, index) => {
      const at = `${where}.routes[${index}]`;
      if (!route || typeof route !== 'object') {
        errors.push(`${at} must be an object`);
        return;
      }
      const stray = Object.keys(route).filter((key) => !ROUTE_FIELDS.has(key));
      if (stray.length) errors.push(`${at} has unknown fields ${stray.join(', ')}`);
      if (typeof route.id !== 'string' || !route.id) errors.push(`${at} needs an id`);
      else if (route.id === 'auto') errors.push(`${at} id 'auto' is the Auto choice, not a route`);
      else if (ids.includes(route.id)) errors.push(`${where} has duplicate route id ${route.id}`);
      ids.push(String(route.id));
      const keys = Array.isArray(route.keys) && route.keys.every((key) => typeof key === 'string' && key) ? route.keys : null;
      if (!keys) errors.push(`${at}.keys must be a list of key names`);
      if (![undefined, 'optional', 'only'].includes(route.plan)) errors.push(`${at}.plan must be 'optional' or 'only'`);
      if (route.plan && route.provider !== 'krea') errors.push(`${at} only a Krea route can bill the plan`);
      // A keyless route (node_route.is_keyless): runs with no key, uses an
      // optional one when set; its keys stay [] and out of envKeyName.
      let optional = route.optionalKeys;
      if (optional !== undefined) {
        if (!Array.isArray(optional) || !optional.every((key) => typeof key === 'string' && key)) {
          errors.push(`${at}.optionalKeys must be a list of key names`);
          optional = [];
        }
        if (keys?.length) errors.push(`${at} lists keys and optionalKeys; a keyless route's keys must be []`);
        for (const key of optional) {
          if (!Object.hasOwn(keyProviders, key)) errors.push(`${at}.optionalKeys names ${key}, which Settings doesn't store`);
        }
        if (route.plan) errors.push(`${at} a keyless route can't bill a plan`);
      }
      if (route.plan !== 'only' && !keys?.length && optional === undefined) {
        errors.push(`${at} needs keys (only a plan-only or keyless route runs without one)`);
      }
      // A maker's Hugging Face Space (handler hf-space) names the maker as its
      // provider; its key is the Hugging Face token (node_route.routes_problems).
      if (keys?.length && keyProviders[keys[0]] !== route.provider
        && !(route.handler === 'hf-space' && keys[0] === 'HF_TOKEN')) {
        errors.push(`${at}.provider must be '${keyProviders[keys[0]]}', who bills ${keys[0]}`);
      }
      // A keyless route whose run with one of its optional keys can bill the
      // key owner's account (node_route.routes_problems, RouteSpec.mayBillWithKey).
      if (route.mayBillWithKey !== undefined) {
        if (route.mayBillWithKey !== true) errors.push(`${at}.mayBillWithKey must be true when present`);
        if (!Array.isArray(route.optionalKeys) || !route.optionalKeys.length) {
          errors.push(`${at}.mayBillWithKey needs optionalKeys: it says a run with one of them may bill`);
        }
      }
      if (route.missingKeyLine !== undefined) {
        if (typeof route.missingKeyLine !== 'string' || !route.missingKeyLine.trim()) {
          errors.push(`${at}.missingKeyLine must be a sentence`);
        }
        if (!keys?.length) errors.push(`${at}.missingKeyLine needs keys to be missing`);
      }
      if (!ROUTE_HANDLERS.has(route.handler)) errors.push(`${at}.handler must be one of ${[...ROUTE_HANDLERS].join(', ')}`);
      if (![undefined, true].includes(route.maker)) errors.push(`${at}.maker must be true or left out`);
      if (route.maker && index !== 0) errors.push(`${at} only routes[0] may be the maker`);
      if (route.rules !== undefined && (typeof route.rules !== 'object' || route.rules === null)) {
        errors.push(`${at}.rules must be an object`);
      } else if (route.rules) {
        const unknown = Object.keys(route.rules).filter((key) => !ROUTE_RULES.has(key));
        if (unknown.length) errors.push(`${at}.rules has unknown rules ${unknown.join(', ')}`);
        const inputIds = new Set((definition.inputPorts ?? []).map((port) => port?.id));
        for (const [port, limit] of Object.entries(route.rules.ports ?? {})) {
          if (!Number.isInteger(limit?.max) || limit.max < 0) errors.push(`${at}.rules.ports.${port}.max must be a whole number of inputs`);
          if (!limit || typeof limit !== 'object') continue;
          const strayLimit = Object.keys(limit).filter((key) => !['max', 'of', 'label'].includes(key));
          if (strayLimit.length) errors.push(`${at}.rules.ports.${port} has unknown fields ${strayLimit.join(', ')}`);
          // A group (FLUX 3 Video's ten images in all) caps several ports together.
          if (limit.of !== undefined && (!Array.isArray(limit.of) || limit.of.length < 2
            || !limit.of.every((name) => typeof name === 'string' && inputIds.has(name)))) {
            errors.push(`${at}.rules.ports.${port}.of must list two or more of the node's input ports`);
          }
          if (limit.of !== undefined && inputIds.has(port)) {
            errors.push(`${at}.rules.ports.${port} groups ports, so its key must not be an input port`);
          }
          if ('label' in limit && (typeof limit.label !== 'string' || !limit.label.trim())) {
            errors.push(`${at}.rules.ports.${port}.label must be text`);
          }
        }
      }
      const routeKeys = new Set((route.params ?? []).map((param) => param?.key));
      for (const param of route.params ?? []) {
        if (BILLING_PARAMS.includes(param?.key)) errors.push(`${at}.params: ${param.key} must sit in params, never in a route`);
        else if (shared.has(param?.key)) errors.push(`${at}.params: ${param.key} is both shared and this route's own`);
        else if (own.has(param?.key) && JSON.stringify(own.get(param.key)) !== JSON.stringify(param)) {
          errors.push(`${at}.params: ${param.key} differs from another route's; use a route-prefixed key and rename`);
        }
        if (!own.has(param?.key)) own.set(param?.key, param);
      }
      for (const field of ['rename', 'valueMap']) {
        for (const key of Object.keys(route[field] ?? {})) {
          if (!shared.has(key) && !routeKeys.has(key)) errors.push(`${at}.${field} names ${key}, which isn't one of its params`);
        }
      }
      validateParamVisibleWhen(definition, route, at);
      validateHideable(definition, route, at);
    });
    const union = [...new Set(routes.flatMap((route) => keyNames(route?.keys)))];
    if (JSON.stringify(keyNames(definition.envKeyName)) !== JSON.stringify(union)) {
      errors.push(`${where}.envKeyName must be ${JSON.stringify(union)}, the routes' keys in order`);
    }
    const first = routes[0] ?? {};
    if (first.maker && JSON.stringify(keyNames(definition.directKeyName)) !== JSON.stringify(keyNames(first.keys))) {
      errors.push(`${where}.directKeyName must be the maker route's keys`);
    }
    if (!first.maker && keyNames(definition.directKeyName).length) {
      errors.push(`${where}.directKeyName is only for a node whose routes[0] is the maker`);
    }
    for (const param of definition.sharedParams ?? []) {
      if (BILLING_PARAMS.includes(param?.key)) errors.push(`${where}.sharedParams: ${param.key} must sit in params`);
    }
    const top = new Map((definition.params ?? []).map((param) => [param?.key, param]));
    for (const key of top.keys()) {
      if (!BILLING_PARAMS.includes(key)) errors.push(`${where}.params: ${key} belongs in sharedParams or a route`);
    }
    const choice = top.get('_provider');
    if (!choice) {
      errors.push(`${where}: _provider must sit in params`);
    } else {
      const values = (choice.options ?? []).map((option) => option?.value);
      if (JSON.stringify(values) !== JSON.stringify(['auto', ...ids])) {
        errors.push(`${where}._provider options must be ${JSON.stringify(['auto', ...ids])}`);
      }
      if (choice.default !== 'auto' || !choice.hidden) errors.push(`${where}._provider must default to 'auto' and be hidden`);
    }
    const plans = routes.some((route) => route?.plan);
    if (plans && !top.has('_kreaAuth')) errors.push(`${where}: a Krea route that bills the plan needs _kreaAuth in params`);
    if (!plans && top.has('_kreaAuth') && definition.apiProvider !== 'krea') {
      errors.push(`${where}._kreaAuth is only for a node with a Krea plan route`);
    }
    for (const group of ['params', 'sharedParams']) validateParams(where, group, definition[group]);
    routes.forEach((route, index) => validateParams(where, `routes[${index}].params`, route?.params));
  }
}

// What a route can hide must not pick its endpoint or hide itself
// (node_route._hideable_problems): an endpointWhen key that is a param must
// be one the route always shows, and the route's visibility conditions
// (paramVisibleWhen plus its params' own visibleWhen) may not go in a circle.
function validateHideable(definition, route, at) {
  if (!route || typeof route !== 'object') return;
  const listed = new Map([...(definition.sharedParams ?? []), ...(route.params ?? [])].filter((p) => p?.key).map((p) => [p.key, p]));
  const conditions = route.paramVisibleWhen && typeof route.paramVisibleWhen === 'object' ? route.paramVisibleWhen : {};
  const every = new Set([definition.params, definition.sharedParams, ...(definition.routes ?? []).map((r) => r?.params)]
    .flatMap((group) => (group ?? []).map((p) => p?.key)).filter(Boolean));
  (route.endpointWhen ?? []).forEach((option, index) => {
    for (const key of Object.keys(option?.when ?? {})) {
      if (!every.has(key)) continue;
      const own = listed.get(key)?.visibleWhen;
      if (!listed.has(key) || conditions[key] !== undefined || (own && Object.keys(own).length)) {
        const problem = `${at}.endpointWhen[${index}] reads ${key}, which the route can hide`;
        if (!errors.includes(problem)) errors.push(problem);
      }
    }
  });
  const edges = new Map();
  for (const [key, param] of listed) edges.set(key, new Set(Object.keys(param.visibleWhen ?? {}).filter((c) => listed.has(c))));
  for (const [key, condition] of Object.entries(conditions)) {
    if (condition && typeof condition === 'object') {
      if (!edges.has(key)) edges.set(key, new Set());
      for (const c of Object.keys(condition)) if (listed.has(c)) edges.get(key).add(c);
    }
  }
  const state = new Map();
  const visit = (key, path) => {
    state.set(key, 1);
    for (const next of [...(edges.get(key) ?? [])].sort()) {
      if (state.get(next) === 1) {
        const loop = path.includes(next) ? [...path.slice(path.indexOf(next)), next] : [key, next];
        errors.push(`${at} visibility conditions go in a circle: ${loop.join(' -> ')}`);
      } else if (!state.get(next)) visit(next, [...path, next]);
    }
    state.set(key, 2);
  };
  for (const key of [...edges.keys()].sort()) if (!state.get(key)) visit(key, [key]);
}

// What a route offers (node_route._visible_when_problems): `paramVisibleWhen`
// names this route's own params; each is false or {controller: [values]}
// with controllers from the same list and literal option values, never
// "(set)"/"(unset)".
function literalValues(param) {
  if (Array.isArray(param?.options) && param.options.length) return new Set(param.options.map((o) => String(o?.value ?? o)));
  if (param?.type === 'boolean') return new Set(['true', 'false']);
  return null;
}

function validateParamVisibleWhen(definition, route, at) {
  if (!('paramVisibleWhen' in route)) return;
  const conditions = route.paramVisibleWhen;
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions) || !Object.keys(conditions).length) {
    errors.push(`${at}.paramVisibleWhen must be a non-empty object`);
    return;
  }
  const listed = new Map([...(definition.sharedParams ?? []), ...(route.params ?? [])].filter((p) => p?.key).map((p) => [p.key, p]));
  for (const [key, condition] of Object.entries(conditions)) {
    const where = `${at}.paramVisibleWhen.${key}`;
    if (!listed.has(key)) { errors.push(`${where} isn't one of this route's params`); continue; }
    if (condition === false) continue;
    if (!condition || typeof condition !== 'object' || Array.isArray(condition) || !Object.keys(condition).length) {
      errors.push(`${where} must be false or {controller: [values]}`);
      continue;
    }
    for (const [controller, allowed] of Object.entries(condition)) {
      if (controller === key || !listed.has(controller)) {
        errors.push(`${where} names ${controller}, which isn't another of this route's params`);
        continue;
      }
      if (conditions[controller] === false) errors.push(`${where} names ${controller}, which this route never offers`);
      if (!Array.isArray(allowed) || !allowed.length) { errors.push(`${where}.${controller} must list one or more values`); continue; }
      if (allowed.some((value) => value === '(set)' || value === '(unset)')) {
        errors.push(`${where}.${controller} can't use (set)/(unset): visibility never reads wired ports`);
        continue;
      }
      const literal = literalValues(listed.get(controller));
      if (!literal || allowed.some((value) => !literal.has(String(value)))) {
        errors.push(`${where}.${controller} values must be options of ${controller}`);
      }
    }
  }
}

// A route's price may not read a setting where the route hides it
// (node_route.price_row_problems): over every combination of the values its
// rows, extras and its params' conditions tell apart, the first row that
// matches, every extra that matches and every multiplyBy param must not name
// a param that route doesn't show with those values.
function validateHiddenPrices(nodes, table) {
  const asText = (value) => (value === undefined || value === null ? '' : String(value));
  for (const [nodeId, definition] of Object.entries(nodes)) {
    if (!Array.isArray(definition.routes) || !definition.routes.length) continue;
    const entry = table.nodes?.[nodeId];
    if (!entry?.routes) continue;
    const all = new Map();
    for (const group of [definition.params, definition.sharedParams, ...definition.routes.map((r) => r.params)]) {
      for (const param of group ?? []) if (param?.key && !all.has(param.key)) all.set(param.key, param);
    }
    for (const route of definition.routes) {
      const priced = entry.routes[route.pricing ?? route.id];
      const rows = priced?.rows;
      if (!Array.isArray(rows)) continue;
      const extras = (Array.isArray(priced.extras) ? priced.extras : []).filter((extra) => extra && typeof extra === 'object');
      const factors = (Array.isArray(priced.multiplyBy) ? priced.multiplyBy : []).map(String).filter((key) => !key.startsWith('('));
      const matched = [...rows, ...extras];
      const conditions = route.paramVisibleWhen ?? {};
      const offered = new Map();
      for (const param of [...(definition.sharedParams ?? []), ...(route.params ?? [])]) {
        if (!param?.key || conditions[param.key] === false) continue;
        const merged = Object.fromEntries(Object.entries(param.visibleWhen ?? {}).map(([k, v]) => [k, [...v]]));
        for (const [k, v] of Object.entries(conditions[param.key] ?? {})) {
          merged[k] = merged[k] ? merged[k].filter((x) => v.map(asText).includes(asText(x))) : [...v];
        }
        offered.set(param.key, merged);
      }
      const named = new Set([...matched.flatMap((row) => Object.keys(row.match ?? {})).filter((key) => !key.startsWith('(')), ...factors]);
      const keys = new Set([...matched.flatMap((row) => Object.keys(row.match ?? {})), ...factors]);
      for (const key of named) for (const ctrl of Object.keys(offered.get(key) ?? {})) keys.add(ctrl);
      const ordered = [...keys].sort();
      const choices = ordered.map((key) => {
        const literal = literalValues(all.get(key));
        if (literal) return [...literal].sort();
        return [...new Set(matched.filter((row) => key in (row.match ?? {})).map((row) => asText(row.match[key])))].sort().concat(['(other)']);
      });
      const combos = choices.reduce((acc, values) => acc.flatMap((combo) => values.map((value) => [...combo, value])), [[]]);
      for (const combo of combos) {
        const values = Object.fromEntries(ordered.map((key, i) => [key, combo[i] === '(other)' ? undefined : combo[i]]));
        for (const [key, param] of all) if (values[key] === undefined && param.default !== undefined && param.default !== null) values[key] = asText(param.default);
        const matches = (candidate) => Object.entries(candidate.match ?? {}).every(([k, want]) => asText(values[k]) === asText(want));
        const row = rows.find(matches);
        if (!row) continue;
        const listed = new Set(offered.keys());
        const reads = [[`price row ${rows.indexOf(row)}`, Object.keys(row.match ?? {})],
          ...extras.map((extra, index) => [`price extra ${index}`, matches(extra) ? Object.keys(extra.match ?? {}) : []]),
          ['multiplyBy', factors]];
        for (const [what, read] of reads) for (const key of read) {
          if (key.startsWith('(')) continue;
          const condition = offered.get(key);
          const shown = condition !== undefined && Object.entries(condition).every(([ctrl, allowed]) =>
            !listed.has(ctrl) || values[ctrl] === undefined || allowed.map(asText).includes(asText(values[ctrl])));
          if (!shown) {
            const problem = `${nodeId} (${route.pricing ?? route.id} route): ${what} reads ${key}, which the route doesn't show with ${ordered.map((k, i) => `${k}=${combo[i]}`).join(', ')}`;
            if (!errors.includes(problem)) errors.push(problem);
          }
        }
      }
    }
  }
}

function validatePorts(nodeId, group, ports) {
  if (!Array.isArray(ports)) {
    errors.push(`${nodeId}.${group} must be an array`);
    return;
  }
  const seen = new Set();
  for (const port of ports) {
    if (!port || typeof port !== 'object') {
      errors.push(`${nodeId}.${group} contains a non-object port`);
      continue;
    }
    if (!port.id) {
      errors.push(`${nodeId}.${group} contains a port without id`);
      continue;
    }
    if (seen.has(port.id)) errors.push(`${nodeId}.${group} duplicate port id: ${port.id}`);
    seen.add(port.id);
    if (!port.label) errors.push(`${nodeId}.${group}.${port.id} missing label`);
    if (!VALID_PORT_TYPES.has(port.dataType)) errors.push(`${nodeId}.${group}.${port.id} invalid dataType: ${port.dataType}`);
    if (typeof port.required !== 'boolean') errors.push(`${nodeId}.${group}.${port.id}.required must be boolean`);
    if ('multiple' in port && typeof port.multiple !== 'boolean') {
      errors.push(`${nodeId}.${group}.${port.id}.multiple must be boolean`);
    }
    if ('maxConnections' in port && !Number.isInteger(port.maxConnections)) {
      errors.push(`${nodeId}.${group}.${port.id}.maxConnections must be integer`);
    }
    // Gate ports (backend/execution/gating.py) exist only on outputs.
    if ('conditional' in port && (group !== 'outputPorts' || port.conditional !== true)) {
      errors.push(`${nodeId}.${group}.${port.id}.conditional must be true and only on an output port`);
    }
  }
}

function validateParams(nodeId, group, params) {
  if (params == null) return;
  if (!Array.isArray(params)) {
    errors.push(`${nodeId}.${group} must be an array`);
    return;
  }
  const seen = new Set();
  for (const param of params) {
    if (!param || typeof param !== 'object') {
      errors.push(`${nodeId}.${group} contains a non-object param`);
      continue;
    }
    if (!param.key) {
      errors.push(`${nodeId}.${group} contains a param without key`);
      continue;
    }
    if (seen.has(param.key)) errors.push(`${nodeId}.${group} duplicate param key: ${param.key}`);
    seen.add(param.key);
    if (!param.label) errors.push(`${nodeId}.${group}.${param.key} missing label`);
    if (!VALID_PARAM_TYPES.has(param.type)) errors.push(`${nodeId}.${group}.${param.key} invalid type: ${param.type}`);
    if (typeof param.required !== 'boolean') errors.push(`${nodeId}.${group}.${param.key}.required must be boolean`);
    if (param.type === 'enum') validateEnumParam(nodeId, group, param);
    if ('defaultBy' in param) validateDefaultBy(nodeId, group, param, params);
  }
}

// A per-value default (frontend lib/paramDefaults.ts, backend
// services/param_defaults.py): one controlling enum in the same group, keyed by
// its option values, never by its own default (every canvas path that writes
// `default` into a new node uses that one), and inside the param's range.
function validateDefaultBy(nodeId, group, param, params) {
  const where = `${nodeId}.${group}.${param.key}.defaultBy`;
  const entries = Object.entries(param.defaultBy ?? {});
  if (entries.length !== 1) {
    errors.push(`${where} must name exactly one param`);
    return;
  }
  const [controllerKey, table] = entries[0];
  const controller = params.find((candidate) => candidate?.key === controllerKey);
  if (!controller || controller.type !== 'enum') {
    errors.push(`${where} must name an enum param in ${group}: ${controllerKey}`);
    return;
  }
  if (!table || typeof table !== 'object' || !Object.keys(table).length) {
    errors.push(`${where}.${controllerKey} must list at least one value`);
    return;
  }
  const values = new Set((controller.options ?? []).map((option) => String(option.value)));
  for (const [value, dflt] of Object.entries(table)) {
    if (!values.has(value)) errors.push(`${where}.${controllerKey} lists ${value}, which isn't a ${controllerKey} option`);
    if (value === String(controller.default) && dflt !== param.default) {
      errors.push(`${where}.${controllerKey} lists the ${controllerKey} default ${value}; put that in ${param.key}.default`);
    }
    if (param.type === 'integer' && !Number.isInteger(dflt)) errors.push(`${where}.${controllerKey}.${value} must be an integer`);
    if (typeof dflt === 'number' && ((param.min != null && dflt < param.min) || (param.max != null && dflt > param.max))) {
      errors.push(`${where}.${controllerKey}.${value} is outside ${param.min}–${param.max}`);
    }
  }
}

function validateEnumParam(nodeId, group, param) {
  if (!Array.isArray(param.options) || !param.options.length) {
    errors.push(`${nodeId}.${group}.${param.key} enum must have options`);
    return;
  }
  const values = new Set();
  for (const option of param.options) {
    if (!option || typeof option !== 'object' || !('label' in option) || !('value' in option)) {
      errors.push(`${nodeId}.${group}.${param.key} has malformed enum option`);
      continue;
    }
    const valueKey = JSON.stringify(option.value);
    if (values.has(valueKey)) errors.push(`${nodeId}.${group}.${param.key} duplicate enum value: ${option.value}`);
    values.add(valueKey);
  }
  if ('default' in param && !values.has(JSON.stringify(param.default))) {
    errors.push(`${nodeId}.${group}.${param.key} default is not in enum options: ${param.default}`);
  }
}

// Moodboard canvas plan section 5.7.10 (A5): how each node with a Moodboard
// port takes a board, in backend/data/moodboard_adapters.json and the
// generated moodboard_adapters_krea.json. scripts/moodboard-adapter-contract.mjs
// mirrors backend/services/moodboard_adapters.py.
function validateMoodboardAdapters() {
  const { table, problems } = mergeTables(moodboardAdapters, kreaMoodboardAdapters, {
    handName: 'moodboard_adapters.json', kreaName: 'moodboard_adapters_krea.json',
  });
  errors.push(...problems);
  errors.push(...moodboardAdapterProblems(table, definitions, { catalog: kreaCatalog, keyProviders, repoRoot: REPO_ROOT }));
}

function validateFrontendBackendIdParity() {
  const frontendIds = new Set([...frontendSource.matchAll(/^\s+'([^']+)':\s+\{/gm)].map((match) => match[1]));
  const backendIds = new Set(Object.keys(definitions));
  for (const id of backendIds) {
    if (!frontendIds.has(id)) errors.push(`frontend NODE_DEFINITIONS missing backend id: ${id}`);
  }
  for (const id of frontendIds) {
    if (!backendIds.has(id)) errors.push(`backend node_definitions.json missing frontend id: ${id}`);
  }
}

function validateCredentialExampleCoverage() {
  const keys = new Set();
  for (const definition of Object.values(definitions)) {
    const env = definition.envKeyName;
    if (typeof env === 'string' && env) keys.add(env);
    if (Array.isArray(env)) {
      for (const key of env) if (key) keys.add(key);
    }
    // A keyless route's optional key (a Hugging Face token) is still a key
    // Settings stores for a node.
    for (const route of definition.routes ?? []) {
      for (const key of route.optionalKeys ?? []) if (key) keys.add(key);
    }
  }
  const settingsKeys = new Set(Object.keys(settingsExample.apiKeys ?? {}));
  for (const key of [...keys].sort()) {
    if (!settingsKeys.has(key)) errors.push(`settings.example.json apiKeys missing ${key}`);
    if (envExample.includes(`${key}=`)) {
      errors.push(`.env.example must not advertise provider credential ${key}`);
    }
  }
  for (const key of [...settingsKeys].sort()) {
    if (!keys.has(key) && !keysAheadOfNodes.has(key)) errors.push(`settings.example.json apiKeys has unused key ${key}`);
  }
  for (const key of [...keysAheadOfNodes].sort()) {
    if (keys.has(key)) errors.push(`${key} is used by a node now; remove it from credential_catalog.py KEYS_AHEAD_OF_NODES`);
  }
}

function validateGeneratedReference() {
  const generatorPath = join(__dirname, 'generate-model-reference.mjs');
  const result = spawnSync(process.execPath, [generatorPath, '--check'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim().split('\n')[0];
    errors.push(`MODEL_REFERENCE.md is out of sync with registry: ${msg}`);
  }
}

function validatePinnedCorrections() {
  const ltx = definitions['ltx-video-2'];
  const ltxResolutionValues = new Set(paramByKey(ltx, 'resolution').options.map((option) => option.value));
  const ltxDurationValues = new Set(paramByKey(ltx, 'duration').options.map((option) => String(option.value)));
  assertSet('ltx-video-2.resolution', ltxResolutionValues, ['1080p', '1440p', '2160p']);
  assertSet('ltx-video-2.duration', ltxDurationValues, ['6', '8', '10']);

  for (const nodeId of ['minimax-t2v', 'minimax-i2v']) {
    const model = paramByKey(definitions[nodeId], 'model');
    if (model.default !== 'MiniMax-Hailuo-2.3') errors.push(`${nodeId}.model default must be MiniMax-Hailuo-2.3`);
  }

  const elevenlabs = definitions['elevenlabs-tts'];
  for (const key of ['similarity_boost', 'style', 'use_speaker_boost', 'speed', 'output_format', 'seed']) {
    paramByKey(elevenlabs, key);
  }

  // Text to Dialogue: the endpoint defaults to eleven_v3, so the node pins
  // eleven_v4, and its `settings` take only stability and similarity.
  const dialogue = definitions['elevenlabs-dialogue'];
  if (dialogue) {
    const model = paramByKey(dialogue, 'model_id');
    if (model?.default !== 'eleven_v4') errors.push('elevenlabs-dialogue.model_id default must be eleven_v4');
    assertSet('elevenlabs-dialogue.model_id', new Set((model?.options ?? []).map((option) => option.value)), ['eleven_v4', 'eleven_v3']);
    for (const key of ['similarity', 'stability', 'output_format', 'seed', 'language_code']) paramByKey(dialogue, key);
    // Speakers are voice names written in the script, looked up at run time,
    // so the card has no per-speaker voice fields.
    for (const key of ['speed', 'style', 'use_speaker_boost', 'similarity_boost', 'voice_1', 'voice_2', 'voice_3', 'voice_4']) {
      if ((dialogue.params ?? []).some((param) => param.key === key)) errors.push(`elevenlabs-dialogue must not expose ${key}`);
    }
  } else {
    errors.push('elevenlabs-dialogue definition is missing');
  }
}

function validateLocalExecutionCoverage() {
  for (const nodeId of LOCAL_EXECUTION_NODE_IDS) {
    if (!definitions[nodeId]) errors.push(`LOCAL_EXECUTION_NODE_IDS contains unknown node: ${nodeId}`);
  }
}

function validateLocalExecutionProvider() {
  for (const nodeId of LOCAL_EXECUTION_NODE_IDS) {
    const definition = definitions[nodeId];
    if (!definition) continue;
    if (definition.apiProvider !== 'utility') {
      errors.push(`${nodeId} is a local utility node and must have apiProvider: 'utility' (got '${definition.apiProvider}')`);
    }
    const env = definition.envKeyName;
    const envIsEmpty = (Array.isArray(env) && env.length === 0) || env === '' || env == null;
    if (!envIsEmpty) {
      errors.push(`${nodeId} is a local utility node and must have empty envKeyName (got ${JSON.stringify(env)})`);
    }
  }
}

// A utility node that still calls a provider says how (types/index.ts
// ProviderVia). Every name in it has to resolve, or readiness, the run
// estimate and the agent surfaces would read it wrong.
function validateProviderVia() {
  const settingsKeys = new Set(Object.keys(settingsExample.apiKeys ?? {}));
  for (const [nodeId, definition] of Object.entries(definitions)) {
    const via = definition.providerVia;
    if (via === undefined) continue;
    const where = `${nodeId}.providerVia`;
    if (definition.apiProvider !== 'utility') errors.push(`${where} is only for utility nodes`);
    if (!via || typeof via !== 'object') {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (via.kind === 'model') {
      if (!Array.isArray(via.path) || !via.path.length || !via.path.every((part) => typeof part === 'string')) {
        errors.push(`${where}.path must be a non-empty list of keys`);
      } else if (!PARAM_GROUPS.some((group) => (definition[group] ?? []).some((param) => param.key === via.path[0]))) {
        errors.push(`${where}.path starts at unknown param ${via.path[0]}`);
      }
      if (!Array.isArray(via.models) || !via.models.length) errors.push(`${where}.models must list the models it can run`);
      for (const model of via.models ?? []) {
        const target = definitions[model];
        if (!target) {
          errors.push(`${where}.models names unknown node ${model}`);
          continue;
        }
        if (target.apiProvider === 'utility') errors.push(`${where}.models names utility node ${model}`);
        const env = Array.isArray(target.envKeyName) ? target.envKeyName : [target.envKeyName];
        const kreaAuth = (target.params ?? []).some((param) => param.key === '_kreaAuth');
        if (!env.filter(Boolean).length && !kreaAuth) errors.push(`${where}.models ${model} has no key to check`);
      }
      if (!(via.models ?? []).includes(via.default)) errors.push(`${where}.default must be one of its models`);
      if (!Array.isArray(via.fallbackFor)) errors.push(`${where}.fallbackFor must be a list`);
    } else if (via.kind === 'param') {
      const param = PARAM_GROUPS.flatMap((group) => definition[group] ?? []).find((candidate) => candidate.key === via.param);
      if (!param) {
        errors.push(`${where}.param names unknown param ${via.param}`);
        continue;
      }
      if (param.type !== 'enum') errors.push(`${where}.param ${via.param} must be an enum`);
      const values = new Set((param.options ?? []).map((option) => option.value));
      if (!Array.isArray(via.freeWhen)) errors.push(`${where}.freeWhen must be a list`);
      for (const value of via.freeWhen ?? []) {
        if (!values.has(value)) errors.push(`${where}.freeWhen ${value} is not an option of ${via.param}`);
      }
      if (![...values].some((value) => !(via.freeWhen ?? []).includes(value))) {
        errors.push(`${where} has no option that calls a provider`);
      }
      if (!Array.isArray(via.anyKey) || !via.anyKey.length) errors.push(`${where}.anyKey must list the keys`);
      for (const key of via.anyKey ?? []) {
        if (!settingsKeys.has(key)) errors.push(`${where}.anyKey ${key} is missing from settings.example.json apiKeys`);
        if (envExample.includes(`${key}=`)) errors.push(`.env.example must not advertise provider credential ${key}`);
      }
      if (typeof via.provider !== 'string' || !via.provider) errors.push(`${where}.provider must name what it calls`);
      // A value with its own keys and provider (QC mode jev -> TypeSafe).
      if (via.byValue !== undefined && (!via.byValue || typeof via.byValue !== 'object' || Array.isArray(via.byValue))) {
        errors.push(`${where}.byValue must be an object of value -> {anyKey, provider}`);
      }
      for (const [value, route] of Object.entries(via.byValue ?? {})) {
        if (!values.has(value)) errors.push(`${where}.byValue ${value} is not an option of ${via.param}`);
        if ((via.freeWhen ?? []).includes(value)) errors.push(`${where}.byValue ${value} runs locally (freeWhen)`);
        if (!Array.isArray(route?.anyKey) || !route.anyKey.length) errors.push(`${where}.byValue.${value}.anyKey must list the keys`);
        for (const key of route?.anyKey ?? []) {
          if (!settingsKeys.has(key)) errors.push(`${where}.byValue.${value}.anyKey ${key} is missing from settings.example.json apiKeys`);
          if (envExample.includes(`${key}=`)) errors.push(`.env.example must not advertise provider credential ${key}`);
        }
        if (typeof route?.provider !== 'string' || !route.provider) errors.push(`${where}.byValue.${value}.provider must name what it calls`);
      }
    } else {
      errors.push(`${where}.kind must be 'model' or 'param'`);
    }
  }
}

function paramByKey(definition, key) {
  for (const group of PARAM_GROUPS) {
    for (const param of definition[group] ?? []) {
      if (param.key === key) return param;
    }
  }
  errors.push(`${definition.id} missing param: ${key}`);
  return { options: [] };
}

function assertSet(label, actual, expected) {
  const expectedSet = new Set(expected);
  for (const value of expectedSet) {
    if (!actual.has(value)) errors.push(`${label} missing ${value}`);
  }
  for (const value of actual) {
    if (!expectedSet.has(value)) errors.push(`${label} has unexpected ${value}`);
  }
}
