// The moodboard adapter contract (moodboard canvas plan section 5.7.10,
// decision A5), for scripts/check-node-contracts.mjs. It mirrors
// backend/services/moodboard_adapters.py table_problems message for message
// (rules 1 to 9, 12 and 13), so CI's Node-only contracts job refuses what the
// backend test refuses; backend/tests/test_moodboard_adapters.py runs both
// on the same broken tables. Rule 10 (the generated Krea file equals what
// scripts/sync-krea-catalog.py writes) and rule 11 (maker routes that refuse
// a start image with references, run with HTTP mocked) need Python and live
// in that test only.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const BOARD_PORT = 'moodboard';
export const GENERATED_BY = 'scripts/sync-krea-catalog.py';
const CHANNELS = ['weighted-style', 'style-object', 'refs', 'role-slots', 'views', 'texture-style', 'music', 'text-only'];
const DEFAULTS = ['images', 'text', 'never'];
const HANDLERS = ['reads-board'];
const TEXTS = ['brief', 'music-direction'];
const WEIGHT_NORMALIZE = { native: 'sum-to-strength', 'at-creation': 'sum-to-one', select: 'rank', global: null };
const COST_PER_REF = ['priced', 'free', 'plus', 'unknown'];
const FACE_POLICIES = ['block', 'warn', 'allow'];
const LIMIT_FIELDS = new Set(['maxEdge', 'minEdge', 'maxBytes', 'requestBytes', 'formats', 'face']);
const CLASSIFIED_TYPES = ['Image', 'Any'];
const FRAME_WORDS = ['first', 'last', 'start', 'end', 'tail', 'frame', 'frames', 'keyframe', 'keyframes'];
export const CENSUS_CATEGORIES = ['image-gen', 'video-gen', 'audio-gen'];
const SYNTAX = /^(plain|[^{}]*\{n\}[^{}]*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PENDING = /^PR\d+[a-z]?$/;
const ENTRY_FIELDS = new Set([
  'channel', 'default', 'handler', 'slots', 'needsWired', 'never', 'exclusive', 'textSlot', 'textUnless', 'text',
  'negativeField', 'paletteParam', 'weight', 'order', 'syntax', 'syntaxReason', 'limits', 'requires', 'collage',
  'costPerRef', 'byModel', 'byRoute', 'sources', 'checked', 'unconfirmed', 'reason',
]);
const SLOT_FIELDS = new Set(['port', 'max', 'roles', 'sharesLimitWith']);
const WEIGHT_FIELDS = new Set(['mode', 'field', 'param', 'range', 'normalize', 'precision', 'schema', 'source']);
const IMAGE_FIELDS = ['default', 'handler', 'slots', 'needsWired', 'exclusive', 'weight', 'order', 'syntax',
  'syntaxReason', 'limits', 'requires', 'collage', 'costPerRef'];
const PARAM_GROUPS = ['params', 'sharedParams', 'directParams', 'falParams'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const sorted = (values) => [...values].sort();
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// Python's repr and f"{x:g}" for the values messages quote.
function repr(value) {
  if (value === undefined || value === null) return 'None';
  if (typeof value === 'string') return `'${value}'`;
  if (value === true) return 'True';
  if (value === false) return 'False';
  return JSON.stringify(value);
}
const number = (value) => (isNumber(value) ? String(value) : repr(value));
const rangeText = (values) => (Array.isArray(values) ? `[${values.map(number).join(', ')}]` : repr(values));

function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return value <= today;
}

// services/node_route.py routes_of / all_param_definitions, as far as the
// contract reads them: route ids and every param a node declares.
function keyList(value) {
  return (Array.isArray(value) ? value : [value]).filter((key) => typeof key === 'string' && key);
}
const hasRoutes = (definition) => Array.isArray(definition.routes) && definition.routes.length > 0;

function routeIds(definition, keyProviders) {
  if (hasRoutes(definition)) return definition.routes.filter(isObject).map((route) => String(route.id));
  const provider = definition.apiProvider;
  const env = keyList(definition.envKeyName);
  const direct = keyList(definition.directKeyName);
  if (env.length < 2) return [String(provider ?? '')];
  const ids = [];
  if (direct.length) ids.push(String(keyProviders[direct[0]] ?? provider));
  for (const key of env.filter((key) => !direct.includes(key))) {
    const id = String(keyProviders[key] ?? provider);
    if (!ids.slice(direct.length ? 1 : 0).includes(id)) ids.push(id);
  }
  return ids;
}

function allParams(definition) {
  const seen = new Map();
  const groups = PARAM_GROUPS.map((group) => definition[group] ?? []);
  if (hasRoutes(definition)) groups.push(...definition.routes.filter(isObject).map((route) => route.params ?? []));
  for (const group of groups) {
    for (const param of Array.isArray(group) ? group : []) {
      if (isObject(param) && param.key && !seen.has(String(param.key))) seen.set(String(param.key), param);
    }
  }
  return [...seen.values()];
}
const paramKeys = (definition) => new Set(allParams(definition).map((param) => String(param.key)));
const paramDefinition = (definition, key) => allParams(definition).find((param) => param.key === key);

function ports(definition) {
  return Object.fromEntries((definition.inputPorts ?? []).filter(isObject).map((port) => [String(port.id), port]));
}

export function boardPort(definition) {
  if (!isObject(definition)) return undefined;
  return (definition.inputPorts ?? []).find((port) => isObject(port) && port.id === BOARD_PORT);
}

export function frameWord(portId, label = '') {
  const words = [];
  for (const text of [portId, label]) {
    const spaced = String(text ?? '').replace(/([a-z0-9])(?=[A-Z])/g, '$1 ');
    words.push(...spaced.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.toLowerCase()));
  }
  return words.find((word) => FRAME_WORDS.includes(word)) ?? null;
}

export function censusNodes(definitions, categories = CENSUS_CATEGORIES) {
  const out = [];
  for (const [nodeId, definition] of Object.entries(definitions)) {
    if (!isObject(definition) || !categories.includes(definition.category)) continue;
    const ids = new Set((definition.inputPorts ?? []).filter(isObject).map((port) => port.id));
    if (ids.has('prompt') || paramKeys(definition).has('prompt')) out.push(nodeId);
  }
  return sorted(out);
}

function matches(key, params) {
  const at = key.indexOf('=');
  const [param, value] = at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)];
  let have = params[param];
  if (typeof have === 'boolean') have = have ? 'true' : 'false';
  return have !== undefined && have !== null && String(have) === value;
}

function partition(key) {
  const at = String(key).indexOf('=');
  return at < 0 ? [String(key), ''] : [String(key).slice(0, at), String(key).slice(at + 1)];
}

// services/moodboard_adapters.py resolve_entry.
export function resolveEntry(entry, params, route) {
  const values = params ?? {};
  const out = {};
  for (const [key, value] of Object.entries(entry)) if (key !== 'byModel' && key !== 'byRoute') out[key] = clone(value);
  for (const [key, override] of Object.entries(entry.byModel ?? {})) {
    if (isObject(override) && matches(String(key), values)) Object.assign(out, clone(override));
  }
  const byRoute = entry.byRoute ?? {};
  if (route !== null && route !== undefined && isObject(byRoute[route])) Object.assign(out, clone(byRoute[route]));
  if (out.channel === 'text-only') {
    const slotPorts = (Array.isArray(out.slots) ? out.slots : []).filter(isObject).map((slot) => slot.port);
    const never = Array.isArray(out.never) || typeof out.never === 'string' ? [...out.never] : [];
    const outNever = [...never, ...slotPorts.filter((port) => typeof port === 'string' && !never.includes(port))];
    for (const key of IMAGE_FIELDS) delete out[key];
    if (outNever.length) out.never = outNever;
  }
  return out;
}

function catalogModel(catalog, endpoint) {
  return Object.values(catalog?.models ?? {}).find((model) => isObject(model) && model.endpoint === endpoint);
}

function itemSchema(model, field) {
  const properties = model?.requestSchema?.properties ?? {};
  const items = isObject(properties[field]) ? properties[field].items : undefined;
  return isObject(items) ? items : {};
}

function sourceProblems(source, repoRoot) {
  if (!isObject(source)) return [`source ${repr(source)} must be an object`];
  const out = [];
  const { url, code } = source;
  const named = url || code;
  if (typeof code === 'string' && code && (url === undefined || url === null)) {
    const path = code.split(':', 1)[0];
    const full = join(repoRoot, path);
    if (!(existsSync(full) && statSync(full).isFile())) out.push(`source ${code} names no file in the repo`);
  } else if (!(typeof url === 'string' && url.startsWith('https://') && (code === undefined || code === null))) {
    out.push(`source ${named} must be an https URL or a repo path`);
  }
  if ('quote' in source && !isText(source.quote)) out.push(`source ${named} has an empty quote`);
  if ('checked' in source && !isDate(source.checked)) out.push(`source ${named} checked must be a date (YYYY-MM-DD)`);
  const extra = Object.keys(source).filter((key) => !['url', 'code', 'quote', 'checked'].includes(key));
  if (extra.length) out.push(`source ${named} has unknown fields ${sorted(extra).join(', ')}`);
  return out;
}

function names(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item)) return value;
  return null;
}

function weightProblems(weight, params, catalog, fixtures) {
  if (!isObject(weight)) return ['weight must be an object'];
  const out = [];
  const extra = Object.keys(weight).filter((key) => !WEIGHT_FIELDS.has(key));
  if (extra.length) out.push(`weight has unknown fields ${sorted(extra).join(', ')}`);
  const { mode, normalize } = weight;
  if (!Object.hasOwn(WEIGHT_NORMALIZE, mode)) {
    return [...out, `weight mode must be one of ${Object.keys(WEIGHT_NORMALIZE).join(', ')}`];
  }
  const wanted = WEIGHT_NORMALIZE[mode];
  if (normalize === 'none') {
    if (!fixtures) out.push('weight normalize none is for test fixtures only');
    else if (mode !== 'native') out.push('weight normalize none is for native weights only');
  } else if (wanted === null) {
    if (normalize !== undefined && normalize !== null) {
      out.push(`weight mode ${mode} takes no normalize (the strength stays the person's)`);
    }
  } else if (normalize !== wanted) {
    out.push(`weight mode ${mode} needs normalize ${wanted} (has ${normalize ?? 'None'})`);
  }
  let bounds;
  if (mode === 'native' || mode === 'global') {
    bounds = weight.range;
    if (!(Array.isArray(bounds) && bounds.length === 2 && bounds.every(isNumber) && bounds[0] < bounds[1])) {
      out.push('weight range must be [low, high]');
      bounds = null;
    }
  }
  if (mode === 'native') {
    if (typeof weight.field !== 'string') out.push('a native weight names its field (strength)');
    const { precision, schema } = weight;
    if (precision !== undefined && precision !== null && !(isNumber(precision) && precision > 0 && precision < 1)) {
      out.push('weight precision must be between 0 and 1');
    }
    if (!isObject(schema)) {
      out.push('a native weight names the vendor schema its range comes from');
    } else if (schema.source !== 'krea-catalog' || !Array.isArray(schema.endpoints) || !schema.endpoints.length
               || typeof schema.field !== 'string') {
      out.push('weight schema must be {source: krea-catalog, endpoints, field}');
    } else if (bounds) {
      for (const endpoint of schema.endpoints) {
        const model = catalogModel(catalog, endpoint);
        if (!model) {
          out.push(`weight schema names no Krea catalog endpoint ${endpoint}`);
          continue;
        }
        const item = (itemSchema(model, schema.field).properties ?? {})[weight.field] ?? {};
        const vendor = [item.minimum ?? null, item.maximum ?? null];
        if (vendor[0] !== bounds[0] || vendor[1] !== bounds[1]) {
          out.push(`weight range ${rangeText(bounds)} isn't the vendor's ${rangeText(vendor)} `
                   + `(${schema.field}[].${weight.field} on ${endpoint})`);
          break;
        }
      }
    }
  } else if (mode === 'at-creation') {
    if (typeof weight.field !== 'string') out.push('an at-creation weight names its field (image_weights)');
  } else if (mode === 'global') {
    if (!params.has(weight.param)) out.push("a global weight names the node's strength param");
    if (weight.source !== 'person') out.push("a global weight's source is person: Nebula never writes it");
  }
  return out;
}

// Rules 3 to 8 and 13 for one resolved variant of an entry.
function variantProblems(nodeId, entry, definition, catalog, fixtures) {
  const out = [];
  const inputs = ports(definition);
  const params = paramKeys(definition);
  const { channel } = entry;
  if (!CHANNELS.includes(channel)) out.push(`channel must be one of ${CHANNELS.join(', ')} (has ${repr(channel)})`);
  const textOnly = channel === 'text-only';
  if ((textOnly || entry.default === 'never') && !isText(entry.reason)) {
    out.push(textOnly ? 'a text-only entry needs a reason' : 'default never needs a reason');
  }

  const textSlot = entry.textSlot;
  if (!(isObject(textSlot) && Object.keys(textSlot).length === 1
        && typeof (textSlot.port || textSlot.param) === 'string')) {
    out.push('textSlot must be {port} or {param}');
  } else if ('port' in textSlot && !(textSlot.port in inputs)) {
    out.push(`textSlot names no input port ${textSlot.port}`);
  } else if ('param' in textSlot && !params.has(textSlot.param)) {
    out.push(`textSlot names no param ${textSlot.param}`);
  }
  if (!TEXTS.includes(entry.text)) out.push(`text must be one of ${TEXTS.join(', ')}`);
  if ('textUnless' in entry && !(entry.textUnless in inputs)) out.push(`textUnless names no input port ${entry.textUnless}`);
  if ('negativeField' in entry && entry.negativeField !== 'auto') {
    out.push("negativeField must be auto (resolved from the active route's params)");
  }
  const palette = entry.paletteParam;
  if (palette !== undefined && palette !== null
      && !(isObject(palette) && params.has(palette.param) && typeof palette.format === 'string')) {
    out.push('paletteParam must be {param, format} naming a param of the node');
  }

  // Rule 3: named ports are real, and a port is a slot or never, not both.
  let { slots } = entry;
  const slotPorts = [];
  if (slots !== undefined && slots !== null && !Array.isArray(slots)) {
    out.push('slots must be a list');
    slots = [];
  }
  for (const slot of slots ?? []) {
    if (!isObject(slot) || typeof slot.port !== 'string') {
      out.push('each slot needs a port');
      continue;
    }
    const portId = slot.port;
    slotPorts.push(portId);
    if (!(portId in inputs)) out.push(`slots names no input port ${portId}`);
    const extra = Object.keys(slot).filter((key) => !SLOT_FIELDS.has(key));
    if (extra.length) out.push(`slot ${portId} has unknown fields ${sorted(extra).join(', ')}`);
    const limit = slot.max;
    if (!(Number.isInteger(limit) && limit >= 1)) {
      out.push(`slot ${portId} needs a max of at least 1`);
    } else {
      // Rule 6: within the port and every route.
      const portMax = inputs[portId]?.maxConnections;
      if (Number.isInteger(portMax) && limit > portMax) {
        out.push(`slot ${portId} takes up to ${limit}, more than the port's ${portMax}`);
      }
      for (const route of definition.routes ?? []) {
        const routeMax = route?.rules?.ports?.[portId]?.max;
        if (Number.isInteger(routeMax) && limit > routeMax) {
          out.push(`slot ${portId} takes up to ${limit}, more than the ${route?.id ?? 'None'} route's ${routeMax}`);
        }
      }
    }
    const shares = names(slot.sharesLimitWith);
    if (shares === null) out.push(`slot ${portId} sharesLimitWith must be a list of ports`);
    for (const other of shares ?? []) {
      if (!(other in inputs)) out.push(`slot ${portId} sharesLimitWith names no input port ${other}`);
    }
    const { roles } = slot;
    if (roles !== undefined && roles !== null
        && !(isObject(roles) && Object.values(roles).every((count) => Number.isInteger(count) && count >= 0))) {
      out.push(`slot ${portId} roles must map each role to a count`);
    }
  }
  const lists = {};
  for (const field of ['never', 'needsWired', 'exclusive']) {
    let listed = names(entry[field]);
    if (listed === null) {
      out.push(`${field} must be a list of input ports`);
      listed = [];
    }
    lists[field] = listed;
    for (const portId of listed) if (!(portId in inputs)) out.push(`${field} names no input port ${portId}`);
  }
  const never = new Set(lists.never);
  const needsWired = new Set(lists.needsWired);
  for (const portId of sorted(new Set(slotPorts.filter((port) => never.has(port))))) {
    out.push(`${portId} is in both slots and never`);
  }
  for (const portId of sorted([...never].filter((port) => needsWired.has(port)))) {
    out.push(`${portId} is in both never and needsWired`);
  }

  // Rule 4: every Image or Any input is classified. Rule 5: frames are never.
  const classified = new Set([...slotPorts, ...never, ...needsWired]);
  for (const [portId, port] of Object.entries(inputs)) {
    if (portId === BOARD_PORT) continue;
    if (CLASSIFIED_TYPES.includes(port.dataType) && !classified.has(portId)) {
      out.push(`input port ${portId} (${port.dataType}) isn't classified in slots, never or needsWired`);
    }
  }
  for (const portId of [...slotPorts, ...sorted([...needsWired].filter((port) => !slotPorts.includes(port)))]) {
    const word = frameWord(portId, String(inputs[portId]?.label ?? ''));
    if (word && portId in inputs) out.push(`${portId} reads as a frame (${word}), so it must be in never`);
  }

  // Rule 7, and what an entry that takes images needs.
  if (textOnly) {
    if (slotPorts.length) out.push('a text-only entry takes no slots');
  } else {
    if (!DEFAULTS.includes(entry.default)) out.push('needs a default (images, text or never)');
    if (channel === 'views') {
      if (slotPorts.length) out.push('a views entry takes no slots');
    } else if (!slotPorts.length && Array.isArray(slots)) {
      out.push('needs slots');
    }
    if (slotPorts.length && channel !== 'views') {
      if (!('weight' in entry)) out.push('needs a weight');
      if (!('syntax' in entry)) out.push('needs a syntax (or null with a syntaxReason)');
    }
    if ('handler' in entry && !HANDLERS.includes(entry.handler)) out.push(`handler must be one of ${HANDLERS.join(', ')}`);
    if (entry.default === 'images' && !('costPerRef' in entry)) out.push('default images needs a costPerRef');
  }
  if ('costPerRef' in entry && !COST_PER_REF.includes(entry.costPerRef)) {
    out.push(`costPerRef must be one of ${COST_PER_REF.join(', ')}`);
  }
  if ('syntax' in entry) {
    const { syntax } = entry;
    if (syntax === null) {
      if (!isText(entry.syntaxReason)) out.push('syntax null needs a syntaxReason');
    } else if (!(typeof syntax === 'string' && SYNTAX.test(syntax))) {
      out.push(`syntax must be plain, null or a pattern with {n} (has ${repr(syntax)})`);
    }
  }
  if ('order' in entry && entry.order !== 'weight') out.push('order must be weight');
  const { limits } = entry;
  if (limits !== undefined && limits !== null) {
    if (!isObject(limits) || Object.keys(limits).some((key) => !LIMIT_FIELDS.has(key))) {
      out.push(`limits takes only ${sorted(LIMIT_FIELDS).join(', ')}`);
    } else if ('face' in limits && !FACE_POLICIES.includes(limits.face)) {
      out.push(`limits.face must be one of ${FACE_POLICIES.join(', ')}`);
    }
  }
  if ('requires' in entry && !isObject(entry.requires)) out.push('requires must be an object');

  // Rule 8: a collage goes into one single-image slot that isn't a target.
  if ('collage' in entry) {
    if (typeof entry.collage !== 'boolean') {
      out.push('collage must be true or false');
    } else if (entry.collage) {
      if ((slots ?? []).length !== 1 || (slots[0] ?? {}).max !== 1) out.push('collage needs a single slot with max 1');
      for (const portId of slotPorts) if (needsWired.has(portId)) out.push(`collage can't go on an edit target (${portId})`);
    }
  }

  // Rule 13: the weight form the node needs (Q21 b).
  const { weight } = entry;
  if (weight !== undefined && weight !== null) out.push(...weightProblems(weight, params, catalog, fixtures));
  const model = catalog?.models?.[nodeId];
  for (const portId of slotPorts) {
    const required = itemSchema(model, portId).required ?? [];
    if (required.includes('strength') && weight?.mode !== 'native') {
      out.push(`${portId} items require a strength on Krea, so the weight must be native`);
    }
  }
  return out;
}

export function entryProblems(nodeId, entry, definition, { catalog, keyProviders = {}, repoRoot, fixtures = false }) {
  if (!isObject(entry)) return [`${nodeId}: entry must be an object`];
  const out = [];
  for (const field of sorted(Object.keys(entry).filter((key) => !ENTRY_FIELDS.has(key)))) out.push(`unknown field ${field}`);
  if (entry.channel === 'text-only') {
    for (const field of IMAGE_FIELDS) if (field in entry) out.push(`a text-only entry takes no ${field}`);
  }
  // Rule 9: dated, sourced, and what isn't sourced is listed.
  if (!isDate(entry.checked)) out.push(`checked must be a date (YYYY-MM-DD), not ${repr(entry.checked)}`);
  const { sources, unconfirmed } = entry;
  if (!Array.isArray(sources) || !sources.length) out.push('needs at least one source');
  else for (const source of sources) out.push(...sourceProblems(source, repoRoot));
  if (unconfirmed !== undefined && unconfirmed !== null && !(Array.isArray(unconfirmed) && unconfirmed.every(isText))) {
    out.push('unconfirmed must be a list of what no source says');
  }

  // Rule 6: byModel keys are real enum values, byRoute keys real routes.
  const byModel = entry.byModel ?? {};
  const byRoute = entry.byRoute ?? {};
  if (!isObject(byModel) || !isObject(byRoute)) {
    return [...out, 'byModel and byRoute must be objects'].map((problem) => `${nodeId}: ${problem}`);
  }
  for (const [key, override] of Object.entries(byModel)) {
    const [paramKey, value] = partition(key);
    const param = paramDefinition(definition, paramKey);
    const options = (param?.options ?? []).map((option) => String(option?.value));
    if (!param || !value || !options.includes(value)) out.push(`byModel ${key} isn't a value of ${paramKey}`);
    if (!isObject(override) || 'byModel' in override || 'byRoute' in override) {
      out.push(`byModel ${key} must be an object of entry fields`);
    }
  }
  const ids = routeIds(definition, keyProviders);
  for (const [key, override] of Object.entries(byRoute)) {
    if (!ids.includes(key)) out.push(`byRoute ${key} isn't one of its routes (${ids.join(', ')})`);
    if (!isObject(override) || 'byModel' in override || 'byRoute' in override) {
      out.push(`byRoute ${key} must be an object of entry fields`);
    }
  }

  const base = variantProblems(nodeId, resolveEntry(entry, {}, null), definition, catalog, fixtures);
  out.push(...base);
  const seen = new Set(base);
  const combos = [];
  for (const key of Object.keys(byModel)) {
    const [paramKey, value] = partition(key);
    combos.push([`byModel ${key}`, { [paramKey]: value }, null]);
  }
  for (const key of Object.keys(byRoute)) {
    combos.push([`byRoute ${key}`, {}, key]);
    for (const modelKey of Object.keys(byModel)) {
      const [paramKey, value] = partition(modelKey);
      combos.push([`byModel ${modelKey}, byRoute ${key}`, { [paramKey]: value }, key]);
    }
  }
  for (const [label, values, route] of combos) {
    for (const problem of variantProblems(nodeId, resolveEntry(entry, values, route), definition, catalog, fixtures)) {
      if (!seen.has(problem)) {
        seen.add(problem);
        out.push(`(${label}) ${problem}`);
      }
    }
  }
  return out.map((problem) => `${nodeId}: ${problem}`);
}

// Rule 12: every census node has a Moodboard port, or is listed.
export function censusProblems(table, definitions) {
  const census = isObject(table.census) ? table.census : {};
  const excluded = isObject(census.excluded) ? census.excluded : {};
  const pending = isObject(census.pending) ? census.pending : {};
  const categories = census.categories || CENSUS_CATEGORIES;
  const out = [];
  if (JSON.stringify([...categories]) !== JSON.stringify(CENSUS_CATEGORIES)) {
    out.push(`census: categories must be ${CENSUS_CATEGORIES.join(', ')} (PR16, PR17 and PR18 extend the lists, not the categories)`);
  }
  const nodes = new Set(censusNodes(definitions, categories));
  for (const nodeId of sorted(nodes)) {
    if (boardPort(definitions[nodeId])) {
      if (nodeId in pending) out.push(`${nodeId}: has a Moodboard port, so it can't be listed as pending`);
      if (nodeId in excluded) out.push(`${nodeId}: has a Moodboard port, so it can't be listed as excluded`);
    } else if (!(nodeId in pending) && !(nodeId in excluded)) {
      out.push(`${nodeId}: takes a prompt but has no Moodboard port, and isn't listed as excluded or pending `
               + '(census, plan section 5.7.10 rule 12)');
    }
  }
  for (const nodeId of sorted(new Set([...Object.keys(excluded), ...Object.keys(pending)]))) {
    if (!nodes.has(nodeId)) out.push(`${nodeId}: listed in the census but isn't an image, video or audio generator with a prompt`);
    if (nodeId in excluded && nodeId in pending) out.push(`${nodeId}: listed as both excluded and pending`);
  }
  for (const [nodeId, reason] of Object.entries(excluded)) {
    if (!isText(reason)) out.push(`${nodeId}: an excluded node needs a reason`);
  }
  for (const [nodeId, pr] of Object.entries(pending)) {
    if (!(typeof pr === 'string' && PENDING.test(pr))) {
      out.push(`${nodeId}: pending must name the PR that gives it a port (PR16), not ${repr(pr)}`);
    }
  }
  return out;
}

// Both files as one table, as services/moodboard_adapters.py load_table
// reads them, plus what only the files themselves can get wrong.
export function mergeTables(hand, krea, { handName, kreaName }) {
  const out = [];
  const handEntries = isObject(hand?.entries) ? hand.entries : {};
  const kreaEntries = isObject(krea?.entries) ? krea.entries : {};
  if (!isObject(hand?.entries)) out.push(`${handName} must be an object with an entries object`);
  if (!isObject(krea?.entries)) out.push(`${kreaName} must be an object with an entries object`);
  if (krea?.generatedBy !== GENERATED_BY) out.push(`${kreaName}: generatedBy must be ${GENERATED_BY} (it is never edited by hand)`);
  const ids = Object.keys(handEntries);
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1] > ids[index]) {
      out.push(`${handName}: entries must be sorted by node id (${ids[index]} comes before ${ids[index - 1]})`);
      break;
    }
  }
  for (const nodeId of sorted(ids.filter((id) => id in kreaEntries))) {
    out.push(`${nodeId} is in both ${handName} and ${kreaName}; the generated file owns Krea catalog nodes and the hand-written one the rest`);
  }
  const entries = Object.fromEntries(sorted(Object.keys({ ...handEntries, ...kreaEntries }))
    .map((id) => [id, kreaEntries[id] ?? handEntries[id]]));
  return { table: { entries, census: isObject(hand?.census) ? hand.census : {} }, problems: out };
}

// Every problem in the table against the node definitions and the pinned
// Krea catalog (rules 1 to 9, 12 and 13). Empty means it passes.
export function tableProblems(table, definitions, options) {
  const entries = isObject(table.entries) ? table.entries : {};
  const out = [];
  // Rule 1: a Moodboard port has an entry (and is a board port).
  for (const [nodeId, definition] of Object.entries(definitions)) {
    const port = boardPort(definition);
    if (!port) continue;
    if (port.dataType !== 'Moodboard') out.push(`${nodeId}: input port moodboard must be dataType Moodboard (is ${port.dataType})`);
    if (!(nodeId in entries)) out.push(`${nodeId}: has a Moodboard input port but no adapter entry`);
  }
  // Rule 2, and each entry's own rules.
  for (const [nodeId, entry] of Object.entries(entries)) {
    const definition = definitions[nodeId];
    if (!isObject(definition)) {
      out.push(`${nodeId}: no such node`);
      continue;
    }
    if (!boardPort(definition)) out.push(`${nodeId}: has an entry but no Moodboard input port`);
    out.push(...entryProblems(nodeId, entry, definition, options));
  }
  out.push(...censusProblems(table, definitions));
  return out;
}
