#!/usr/bin/env node
/**
 * Generate docs/ipad-conversion/NODE-CONTRACT-AUDIT.md
 * Per-node contract layer inventory for the iPad port.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const NODE_DEFS_PATH = join(REPO_ROOT, 'backend', 'data', 'node_definitions.json');
const SYNC_RUNNER_PATH = join(REPO_ROOT, 'backend', 'execution', 'sync_runner.py');
const ENGINE_PATH = join(REPO_ROOT, 'backend', 'execution', 'engine.py');
const HANDLERS_DIR = join(REPO_ROOT, 'backend', 'handlers');
const TESTS_DIR = join(REPO_ROOT, 'backend', 'tests');
const PROVIDER_DOCS_DIR = join(REPO_ROOT, 'docs', 'model-providers');
const OUT_MD = join(REPO_ROOT, 'docs', 'ipad-conversion', 'NODE-CONTRACT-AUDIT.md');
const OUT_CSV = join(REPO_ROOT, 'docs', 'ipad-conversion', 'NODE-CONTRACT-AUDIT.csv');

const LOCAL_EXECUTION_NODE_IDS = new Set([
  'text-input',
  'image-input',
  'document-input',
  'video-input',
  'audio-input',
  'sticky-note',
  'frame-extractor',
  'array-builder',
  'array-selector',
  'image-compare',
  'svg-rasterize',
  'mask-painter',
  'iterator-image',
  'iterator-text',
  'preview',
  'combine-text',
  'router',
  'reroute',
]);

const LAYER_DESC = {
  node: 'Param schema, ports, executionPattern from node_definitions.json',
  handler: 'Provider HTTP mapping → Swift ProviderClient',
  'local-handler': 'Engine-local execution (no external API)',
  'async-poll': 'Submit job + poll until complete',
  stream: 'SSE / chunked streaming response',
  'dual-route': 'sharedParams + falParams/directParams routing',
  keychain: 'BYOK envKeyName → KeychainSettings',
  'media-output': 'Binary output (video/audio/3d/mesh) → MediaAsset',
  ffmpeg: 'Video-edit pipeline (defer to v1.2 / server proxy)',
  'remotion-defer': 'Remotion JS runtime — out of v1 scope',
  oauth: 'OAuth session (not API key)',
  'provider-audit': 'docs/model-providers reference exists',
  intent: 'App Intent surface for Siri (subset of high-value nodes)',
};

const definitions = JSON.parse(await readFile(NODE_DEFS_PATH, 'utf8'));
const syncRunner = await readFile(SYNC_RUNNER_PATH, 'utf8');
const engineSource = await readFile(ENGINE_PATH, 'utf8');

const syncHandlers = parseSyncHandlers(syncRunner);
const registryHandlers = parseRegistryAssignments(syncRunner);
const engineLocalIds = parseEngineLocalIds(engineSource);

const handlerFiles = await loadHandlerFileContents();
const nodeHandlerModules = parseNodeHandlerModules(syncRunner, handlerFiles);
const providerAuditDocs = await loadProviderAuditDocs();
const backendTestMentions = await loadTestMentions(TESTS_DIR, Object.keys(definitions));

const rows = Object.entries(definitions)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([nodeId, def]) => buildRow(nodeId, def));

const byWave = groupBy(rows, 'wave');
const byCategory = groupBy(rows, 'category');
const layerCounts = countLayers(rows);
const gapCounts = countGaps(rows);

const md = renderMarkdown(rows, byWave, byCategory, layerCounts, gapCounts);
await writeFile(OUT_MD, md, 'utf8');
await writeFile(OUT_CSV, renderCsv(rows), 'utf8');
console.log(`Wrote ${OUT_MD}`);
console.log(`Wrote ${OUT_CSV}`);
console.log(`Audited ${rows.length} nodes`);

function parseSyncHandlers(source) {
  const m = source.match(/SYNC_HANDLERS[^=]*=\s*\{([\s\S]*?)\n\}/);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/"([^"]+)":/g)].map((x) => x[1]));
}

function parseRegistryAssignments(source) {
  return new Set([...source.matchAll(/registry\["([^"]+)"\]/g)].map((x) => x[1]));
}

function parseEngineLocalIds(source) {
  const m = source.match(/LOCAL_EXECUTION_NODE_IDS\s*=\s*frozenset\(\s*\{([\s\S]*?)\}\s*\)/);
  if (!m) return LOCAL_EXECUTION_NODE_IDS;
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

function parseNodeHandlerModules(syncSource, handlerFileMap) {
  const fnToModule = new Map();
  for (const [stem, text] of handlerFileMap) {
    for (const m of text.matchAll(/^(?:async )?def (handle_[a-z0-9_]+)/gm)) {
      fnToModule.set(m[1], stem);
    }
  }

  const nodeToModule = new Map();

  const syncBlock = syncSource.match(/SYNC_HANDLERS[^=]*=\s*\{([\s\S]*?)\n\}/);
  if (syncBlock) {
    for (const m of syncBlock[1].matchAll(/"([^"]+)":\s*(handle_[a-z0-9_]+)/g)) {
      const mod = fnToModule.get(m[2]);
      if (mod) nodeToModule.set(m[1], mod);
    }
  }

  const regStart = syncSource.indexOf('def get_handler_registry');
  const regEnd = syncSource.indexOf('return registry', regStart);
  const regBlock = regStart >= 0 && regEnd >= 0 ? syncSource.slice(regStart, regEnd) : syncSource;

  for (const m of regBlock.matchAll(/async def (_[a-z0-9_]+)\(/g)) {
    const fnName = m[1];
    const fnStart = m.index;
    const nextDef = regBlock.indexOf('\n        async def ', fnStart + 1);
    const fnBody = regBlock.slice(fnStart, nextDef > fnStart ? nextDef : fnStart + 1500);
    let stem = null;
    const importMatch = fnBody.match(/from handlers\.([a-z0-9_]+) import (handle_[a-z0-9_]+)/);
    if (importMatch) stem = importMatch[1];
    else if (fnBody.includes('handle_fal_universal')) stem = 'fal_universal';
    else if (fnBody.includes('handle_minimax')) stem = 'minimax';
    if (stem) fnToModule.set(fnName, stem);
  }

  for (const m of regBlock.matchAll(/registry\["([^"]+)"\]\s*=\s*(_[a-z0-9_]+)/g)) {
    const mod = fnToModule.get(m[2]);
    if (mod) nodeToModule.set(m[1], mod);
  }

  for (const m of regBlock.matchAll(/registry\["([^"]+)"\]\s*=\s*(handle_[a-z0-9_]+)/g)) {
    const mod = fnToModule.get(m[2]);
    if (mod) nodeToModule.set(m[1], mod);
  }

  return nodeToModule;
}

function hasEnvKey(def) {
  const env = def.envKeyName;
  if (typeof env === 'string') return env.length > 0;
  if (Array.isArray(env)) return env.some((k) => typeof k === 'string' && k.length > 0);
  return false;
}

async function loadHandlerFileContents() {
  const { readdir, readFile: rf } = await import('node:fs/promises');
  const entries = await readdir(HANDLERS_DIR);
  const map = new Map();
  for (const name of entries) {
    if (!name.endsWith('.py') || name === '__init__.py') continue;
    const stem = name.replace(/\.py$/, '');
    map.set(stem, await rf(join(HANDLERS_DIR, name), 'utf8'));
  }
  return map;
}

async function loadProviderAuditDocs() {
  const { readdir, stat } = await import('node:fs/promises');
  const docs = [];
  async function walk(dir, prefix = '') {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) await walk(full, rel);
      else if (ent.name.endsWith('.md')) docs.push(rel.replace(/\.md$/, ''));
    }
  }
  await walk(PROVIDER_DOCS_DIR);
  return docs;
}

async function loadTestMentions(testDir, nodeIds) {
  const { readdir, readFile: rf } = await import('node:fs/promises');
  const mentions = new Map(nodeIds.map((id) => [id, []]));
  const files = await readdir(testDir);
  for (const file of files) {
    if (!file.startsWith('test_') || !file.endsWith('.py')) continue;
    const text = await rf(join(testDir, file), 'utf8');
    for (const id of nodeIds) {
      if (text.includes(id)) mentions.get(id).push(file);
    }
  }
  return mentions;
}

function inferHandlerFiles(nodeId, def) {
  if (nodeHandlerModules.has(nodeId)) return [nodeHandlerModules.get(nodeId)];

  const hits = [];
  for (const [stem, text] of handlerFiles) {
    if (
      text.includes(`"${nodeId}"`) ||
      text.includes(`'${nodeId}'`) ||
      text.includes(`registry["${nodeId}"]`)
    ) {
      hits.push(stem);
    }
  }
  if (hits.length) return [...new Set(hits)].sort();
  return [];
}

function findAuditDocs(def, handlerStems) {
  const provider = def.apiProvider ?? '';
  const hits = new Set();
  for (const doc of providerAuditDocs) {
    const lower = doc.toLowerCase();
    if (provider && lower.includes(provider)) hits.add(doc);
    for (const stem of handlerStems) {
      if (lower.includes(stem.replace(/_/g, '-'))) hits.add(doc);
    }
    if (def.id && lower.includes(def.id)) hits.add(doc);
  }
  return [...hits].sort().slice(0, 3);
}

function resolveExecutionSite(nodeId, def) {
  if (engineLocalIds.has(nodeId) || LOCAL_EXECUTION_NODE_IDS.has(nodeId)) return 'local-engine';
  if (syncHandlers.has(nodeId)) return 'sync-handler';
  if (registryHandlers.has(nodeId)) return 'async-registry';
  if (def.apiProvider === 'utility' || def.category === 'utility') return 'local-engine';
  return 'unregistered';
}

function inferOutputKind(def) {
  const types = new Set((def.outputPorts ?? []).map((p) => p.dataType));
  if (types.has('Video')) return 'video';
  if (types.has('Audio')) return 'audio';
  if (types.has('Mesh')) return '3d';
  if (types.has('Image') || types.has('SVG')) return 'image';
  if (types.has('Text')) return 'text';
  if (types.has('Character')) return 'character';
  if (types.has('Moodboard')) return 'moodboard';
  return 'any';
}

function hasDualRoute(def) {
  return Boolean(
    (def.sharedParams?.length ?? 0) > 0 ||
      (def.falParams?.length ?? 0) > 0 ||
      (def.directParams?.length ?? 0) > 0,
  );
}

function contractLayers(nodeId, def, site) {
  const layers = ['node'];
  if (site === 'local-engine') layers.push('local-handler');
  else if (site !== 'unregistered') layers.push('handler');

  const pattern = def.executionPattern;
  if (pattern === 'async-poll') layers.push('async-poll');
  if (pattern === 'stream') layers.push('stream');
  if (hasDualRoute(def)) layers.push('dual-route');
  if (hasEnvKey(def)) layers.push('keychain');

  const out = inferOutputKind(def);
  if (['video', 'audio', '3d'].includes(out)) layers.push('media-output');

  if (def.category === 'cinematic' || nodeId.startsWith('video-edit')) layers.push('ffmpeg');
  if (nodeId.includes('remotion') || def.category === 'remotion') layers.push('remotion-defer');
  if (nodeId === 'nous-portal-universal' || def.apiProvider === 'nous') layers.push('oauth');

  return layers;
}

function ipadWave(nodeId, def, site) {
  if (nodeId === 'remotion-node') return 'defer-remotion';
  if (nodeId === 'video-edit') return 'defer-v1.2';
  if (site === 'local-engine') return 'W0';
  if (def.category === 'cinematic' || nodeId.startsWith('cinema-')) return 'W5';
  if (def.category === 'character' || nodeId === 'character') return 'W5';
  if (def.category === 'moodboard' || nodeId === 'nebula-moodboard') return 'W5';

  const p = def.apiProvider;
  if (p === 'openai' || p === 'anthropic') return 'W1';
  if (p === 'google') return 'W2';
  if (
    p === 'fal' ||
    p === 'openrouter' ||
    p === 'replicate' ||
    p === 'bytedance' ||
    p === 'bfl' ||
    p === 'luma' ||
    p === 'kling' ||
    p === 'recraft'
  ) {
    return 'W3';
  }
  if (p === 'elevenlabs' || p === 'runway' || p === 'minimax' || p === 'xai' || p === 'higgsfield') return 'W4';
  if (p === 'meshy' || p === 'quiver' || p === 'hunyuan') return 'W5';
  if (p === 'ideogram' || p === 'krea' || p === 'nous' || p === 'utility') return 'W6';
  return 'W6';
}

function inferGaps(nodeId, def, site, handlerStems, auditDocs, tests) {
  const gaps = [];
  if (site === 'unregistered') gaps.push('no-handler-registry');
  if (site !== 'local-engine' && !handlerStems.length) gaps.push('handler-file-unclear');
  if (site !== 'local-engine' && !auditDocs.length) gaps.push('no-provider-audit');
  if (!tests.length) gaps.push('no-backend-test');
  if (!hasEnvKey(def) && def.apiProvider !== 'utility' && nodeId !== 'nous-portal-universal') {
    gaps.push('no-env-key-declared');
  }
  const paramGroups = ['params', 'sharedParams', 'falParams', 'directParams'];
  for (const g of paramGroups) {
    if (!Array.isArray(def[g])) continue;
    for (const param of def[g]) {
      if (param.type === 'file') {
        gaps.push('file-param-ipados');
        break;
      }
    }
  }
  return [...new Set(gaps)];
}

function intentCandidate(nodeId, def, wave) {
  if (wave.startsWith('defer')) return false;
  if (def.apiProvider === 'utility') return nodeId === 'text-input' || nodeId === 'preview';
  if (wave === 'W1' && def.category === 'image-gen') return true;
  if (nodeId === 'fal-universal' || nodeId === 'openrouter-universal') return true;
  return false;
}

function buildRow(nodeId, def) {
  const site = resolveExecutionSite(nodeId, def);
  const handlerStems = inferHandlerFiles(nodeId, def);
  const auditDocs = findAuditDocs(def, handlerStems);
  const tests = backendTestMentions.get(nodeId) ?? [];
  const layers = contractLayers(nodeId, def, site);
  if (auditDocs.length) layers.push('provider-audit');
  const wave = ipadWave(nodeId, def, site);
  if (intentCandidate(nodeId, def, wave)) layers.push('intent');
  const gaps = inferGaps(nodeId, def, site, handlerStems, auditDocs, tests);

  return {
    id: nodeId,
    label: def.displayName ?? nodeId,
    category: def.category,
    provider: def.apiProvider,
    executionPattern: def.executionPattern,
    executionSite: site,
    outputKind: inferOutputKind(def),
    envKey: formatEnvKey(def.envKeyName),
    wave,
    layers: [...new Set(layers)],
    handlerFiles: handlerStems,
    auditDocs,
    backendTests: tests.slice(0, 3),
    gaps,
    paramCount:
      (def.params?.length ?? 0) +
      (def.sharedParams?.length ?? 0) +
      (def.falParams?.length ?? 0) +
      (def.directParams?.length ?? 0),
    dualRoute: hasDualRoute(def),
  };
}

function formatEnvKey(envKeyName) {
  if (!envKeyName) return '—';
  if (Array.isArray(envKeyName)) return envKeyName.join(' | ');
  return envKeyName;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

function countLayers(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const layer of row.layers) {
      counts.set(layer, (counts.get(layer) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function countGaps(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const gap of row.gaps) {
      counts.set(gap, (counts.get(gap) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderMarkdown(rows, byWave, byCategory, layerCounts, gapCounts) {
  const lines = [];
  lines.push('# Nebula Node Contract Audit');
  lines.push('');
  lines.push(
    'Per-node contract requirements for the iPad port. Generated by `scripts/audit-ipad-node-contracts.mjs` from `node_definitions.json`, `sync_runner.py`, and `engine.py`.',
  );
  lines.push('');
  lines.push('## Executive summary');
  lines.push('');
  lines.push(`- **Total nodes:** ${rows.length}`);
  lines.push(`- **Local engine (W0):** ${(byWave.get('W0') ?? []).length}`);
  lines.push(`- **W1 OpenAI/Anthropic:** ${(byWave.get('W1') ?? []).length}`);
  lines.push(`- **W2 Google:** ${(byWave.get('W2') ?? []).length}`);
  lines.push(`- **W3 FAL/universal/bulk:** ${(byWave.get('W3') ?? []).length}`);
  lines.push(`- **W4 video/audio async:** ${(byWave.get('W4') ?? []).length}`);
  lines.push(`- **W5 cinema/3D/SVG:** ${(byWave.get('W5') ?? []).length}`);
  lines.push(`- **W6 remaining:** ${(byWave.get('W6') ?? []).length}`);
  const deferred = rows.filter((r) => r.wave.startsWith('defer'));
  lines.push(`- **Deferred:** ${deferred.length}`);
  lines.push(`- **Unregistered handlers:** ${rows.filter((r) => r.executionSite === 'unregistered').length}`);
  lines.push('');
  lines.push('### What “contract” means per layer');
  lines.push('');
  lines.push('| Layer | Nodes | iPad artifact |');
  lines.push('|-------|------:|---------------|');
  for (const [layer, count] of layerCounts) {
    const artifact = {
      node: '`NodeDefinition` + `ParamSchema` (generated)',
      handler: '`ProviderClient` protocol + per-provider impl',
      'local-handler': '`LocalNodeExecutor` cases',
      'async-poll': '`AsyncJob` + poller',
      stream: '`AsyncStream` adapter',
      'dual-route': '`RouteResolver` (FAL vs direct)',
      keychain: '`KeychainSettings` key id',
      'media-output': '`MediaAsset` + sandbox paths',
      ffmpeg: 'AVFoundation wave or Mac proxy',
      'remotion-defer': 'Skip v1',
      oauth: '`OAuthSession` (Nous Portal)',
      'provider-audit': 'Human reference during port',
      intent: 'App Intent + FM `Tool` (subset)',
    }[layer] ?? LAYER_DESC[layer] ?? '';
    lines.push(`| \`${layer}\` | ${count} | ${artifact} |`);
  }
  lines.push('');
  lines.push('## Contract stack (all nodes)');
  lines.push('');
  lines.push('Every node needs at minimum:');
  lines.push('');
  lines.push('1. **Node contract** — id, category, `executionPattern`, ports, params (including `sharedParams` / `falParams` / `directParams` when present)');
  lines.push('2. **Execution contract** — local-engine vs sync-handler vs async-registry mapping');
  lines.push('3. **Handler contract** (if external API) — request/response mapping, auth key, poll/stream lifecycle');
  lines.push('4. **Media contract** (if binary output) — download, cache path, preview component');
  lines.push('');
  lines.push('## Gaps to close before handler ports');
  lines.push('');
  for (const [gap, count] of gapCounts) {
    lines.push(`- **${gap}** — ${count} nodes`);
  }
  lines.push('');
  lines.push('## By iPad wave');
  lines.push('');
  const waveOrder = ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'defer-v1.2', 'defer-remotion'];
  for (const wave of waveOrder) {
    const waveRows = byWave.get(wave) ?? [];
    if (!waveRows.length) continue;
    lines.push(`### ${wave} (${waveRows.length} nodes)`);
    lines.push('');
    for (const r of waveRows) {
      const layers = r.layers.map((l) => `\`${l}\``).join(', ');
      const handler = r.handlerFiles.length ? r.handlerFiles.join(', ') : (r.executionSite === 'local-engine' ? 'engine' : '—');
      const gaps = r.gaps.length ? r.gaps.join(', ') : '—';
      lines.push(
        `- **${r.id}** — ${r.label} | ${r.category}/${r.provider} | ${r.executionSite} (${r.executionPattern}) | layers: ${layers} | handler: ${handler} | gaps: ${gaps}`,
      );
    }
    lines.push('');
  }
  lines.push('## By category');
  lines.push('');
  for (const [cat, catRows] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const union = new Set(catRows.flatMap((r) => r.layers));
    lines.push(`### ${cat} (${catRows.length})`);
    lines.push(`Layers: ${[...union].sort().map((l) => `\`${l}\``).join(', ')}`);
    lines.push('');
  }
  lines.push('## Full table');
  lines.push('');
  lines.push('| ID | Label | Category | Provider | Output | Site | Pattern | Wave | Layers | Env key | Gaps |');
  lines.push('|----|-------|----------|----------|--------|------|---------|------|--------|---------|------|');
  for (const r of rows) {
    const esc = (s) => String(s).replace(/\|/g, '\\|');
    lines.push(
      `| ${r.id} | ${esc(r.label.slice(0, 28))} | ${r.category} | ${r.provider} | ${r.outputKind} | ${r.executionSite} | ${r.executionPattern} | ${r.wave} | ${r.layers.join('+')} | ${esc(r.envKey)} | ${r.gaps.join(';')} |`,
    );
  }
  lines.push('');
  lines.push('## Regenerate');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/audit-ipad-node-contracts.mjs');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function renderCsv(rows) {
  const header = [
    'id',
    'label',
    'category',
    'provider',
    'outputKind',
    'executionSite',
    'executionPattern',
    'wave',
    'layers',
    'envKey',
    'handlerFiles',
    'auditDocs',
    'gaps',
  ];
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const body = rows.map((r) =>
    [
      r.id,
      r.label,
      r.category,
      r.provider,
      r.outputKind,
      r.executionSite,
      r.executionPattern,
      r.wave,
      r.layers.join('|'),
      r.envKey,
      r.handlerFiles.join('|'),
      r.auditDocs.join('|'),
      r.gaps.join('|'),
    ]
      .map(esc)
      .join(','),
  );
  return [header.join(','), ...body].join('\n');
}
