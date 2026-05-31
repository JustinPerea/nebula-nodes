import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const NODE_DEFS_PATH = join(REPO_ROOT, 'backend', 'data', 'node_definitions.json');
const FRONTEND_DEFS_PATH = join(REPO_ROOT, 'frontend', 'src', 'constants', 'nodeDefinitions.ts');
const ENV_EXAMPLE_PATH = join(REPO_ROOT, '.env.example');

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
  'utility',
]);
const VALID_EXECUTION_PATTERNS = new Set(['sync', 'async-poll', 'stream']);
const VALID_PORT_TYPES = new Set(['Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Mesh', 'Character', 'Any']);
const VALID_PARAM_TYPES = new Set(['string', 'integer', 'float', 'boolean', 'enum', 'textarea', 'file', 'palette']);
const PARAM_GROUPS = ['params', 'sharedParams', 'falParams', 'directParams'];
const LOCAL_EXECUTION_NODE_IDS = new Set([
  'text-input',
  'image-input',
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
  'preview',
  'combine-text',
  'router',
  'reroute',
]);

const definitions = JSON.parse(await readFile(NODE_DEFS_PATH, 'utf8'));
const frontendSource = await readFile(FRONTEND_DEFS_PATH, 'utf8');
const envExample = await readFile(ENV_EXAMPLE_PATH, 'utf8');
const errors = [];

validateRegistryShape();
validateFrontendBackendIdParity();
validateEnvExampleCoverage();
validateGeneratedReference();
validatePinnedCorrections();
validateLocalExecutionCoverage();
validateLocalExecutionProvider();

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
    for (const group of PARAM_GROUPS) validateParams(nodeId, group, definition[group]);
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

function validateEnvExampleCoverage() {
  const keys = new Set();
  for (const definition of Object.values(definitions)) {
    const env = definition.envKeyName;
    if (typeof env === 'string' && env) keys.add(env);
    if (Array.isArray(env)) {
      for (const key of env) if (key) keys.add(key);
    }
  }
  for (const key of [...keys].sort()) {
    if (!envExample.includes(`${key}=`)) errors.push(`.env.example missing ${key}`);
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
