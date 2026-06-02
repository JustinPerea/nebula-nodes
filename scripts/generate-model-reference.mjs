/**
 * generate-model-reference.mjs
 *
 * Reads backend/data/node_definitions.json and emits docs/MODEL_REFERENCE.md.
 *
 * Usage:
 *   node scripts/generate-model-reference.mjs          # write the file
 *   node scripts/generate-model-reference.mjs --check  # diff against committed file; exit 1 if different
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const NODE_DEFS_PATH = join(REPO_ROOT, 'backend', 'data', 'node_definitions.json');
const MODEL_PROVIDERS_PATH = join(REPO_ROOT, 'docs', 'model-providers');
const OUTPUT_PATH = join(REPO_ROOT, 'docs', 'MODEL_REFERENCE.md');

// Category display names and sort order
const CATEGORY_ORDER = [
  'image-gen',
  'video-gen',
  'text-gen',
  'audio-gen',
  '3d-gen',
  'transform',
  'analyzer',
  'universal',
  'cinematic',
  'character',
  'utility',
];
const CATEGORY_LABELS = {
  'image-gen': 'Image Generation',
  'video-gen': 'Video Generation',
  'text-gen': 'Text Generation',
  'audio-gen': 'Audio Generation',
  '3d-gen': '3D Generation',
  'transform': 'Transform',
  'analyzer': 'Analyzer',
  'universal': 'Universal',
  'cinematic': 'Cinematic',
  'character': 'Character',
  'utility': 'Utility',
};

// Provider display names
const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  runway: 'Runway',
  kling: 'Kling',
  elevenlabs: 'ElevenLabs',
  replicate: 'Replicate',
  fal: 'FAL',
  bytedance: 'ByteDance',
  minimax: 'MiniMax',
  luma: 'Luma',
  xai: 'xAI',
  recraft: 'Recraft',
  ideogram: 'Ideogram',
  openrouter: 'OpenRouter',
  bfl: 'BFL',
  higgsfield: 'Higgsfield',
  meshy: 'Meshy',
  krea: 'Krea',
  nous: 'Nous',
  utility: 'Utility',
};

const PARAM_GROUPS = ['params', 'sharedParams', 'falParams', 'directParams'];

// Param group display names for dual/triple-param nodes
const PARAM_GROUP_LABELS = {
  params: 'Parameters',
  sharedParams: 'Shared Parameters',
  falParams: 'FAL Parameters',
  directParams: 'Direct Parameters',
};

/**
 * Escape pipe characters and strip newlines in Markdown table cells.
 */
function escapeCell(value) {
  if (value == null) return '—';
  return String(value)
    .replace(/\n/g, ' ')
    .replace(/\|/g, '&#124;');
}


/**
 * Format a single parameter row for the params table.
 * Returns [label, type, default, options/range]
 */
function formatParamRow(param) {
  const label = escapeCell(param.label);
  let typeStr = param.type;
  if (param.type === 'integer') typeStr = 'int';
  if (param.type === 'float') typeStr = 'float';
  if (param.type === 'boolean') typeStr = 'bool';

  let defaultVal = '—';
  if (param.default !== undefined && param.default !== null && param.default !== '') {
    defaultVal = escapeCell(String(param.default));
  }

  let options = '—';
  if (param.type === 'enum' && Array.isArray(param.options)) {
    const labels = param.options.map((o) => escapeCell(o.label ?? o.value));
    if (labels.length > 8) {
      options = labels.slice(0, 8).join(', ') + ', …';
    } else {
      options = labels.join(', ');
    }
  } else if ((param.type === 'integer' || param.type === 'float') && (param.min != null || param.max != null)) {
    const lo = param.min != null ? String(param.min) : '…';
    const hi = param.max != null ? String(param.max) : '…';
    options = `${lo}–${hi}`;
  }

  return [label, typeStr, defaultVal, options];
}

/**
 * Render a parameters table from an array of params.
 */
function renderParamTable(params) {
  if (!Array.isArray(params) || params.length === 0) return '';
  const rows = params.map(formatParamRow);
  const lines = [
    '| Parameter | Type | Default | Options/Range |',
    '|-----------|------|---------|---------------|',
  ];
  for (const [label, type, def, opts] of rows) {
    lines.push(`| ${label} | ${type} | ${def} | ${opts} |`);
  }
  return lines.join('\n');
}

/**
 * Render a metadata table row.
 */
function metaRow(label, value) {
  return `| **${label}** | ${escapeCell(value)} |`;
}

/**
 * Format envKeyName for display.
 */
function formatEnvKey(envKeyName) {
  if (!envKeyName) return '—';
  if (Array.isArray(envKeyName)) {
    if (envKeyName.length === 0) return '—';
    return envKeyName.join(', ');
  }
  return envKeyName;
}

/**
 * Format ports list for display: "Label (DataType)*" with * on required.
 */
function formatPorts(ports) {
  if (!Array.isArray(ports) || ports.length === 0) return '—';
  return ports.map((p) => {
    const suffix = p.required ? '*' : '';
    const multi = p.multiple ? ' ×n' : '';
    return `${escapeCell(p.label)} (${p.dataType}${multi})${suffix}`;
  }).join(', ');
}

/**
 * Build all groups that have non-empty params for a node.
 */
function getPopulatedParamGroups(node) {
  return PARAM_GROUPS.filter((g) => Array.isArray(node[g]) && node[g].length > 0);
}

/**
 * Generate the full Markdown content.
 */
async function generate() {
  const rawDefs = await readFile(NODE_DEFS_PATH, 'utf8');
  const definitions = JSON.parse(rawDefs);

  const auditMap = buildAuditMapSync();

  const nodeCount = Object.keys(definitions).length;

  const lines = [];

  // Header
  lines.push('# Nebula Node — Model Reference');
  lines.push('');
  lines.push(`Nodes: ${nodeCount} | Source: [\`backend/data/node_definitions.json\`](../backend/data/node_definitions.json)`);
  lines.push('');
  lines.push('> This file is generated by `scripts/generate-model-reference.mjs`. Do not edit by hand.');
  lines.push('> Run `node scripts/generate-model-reference.mjs` to regenerate.');
  lines.push('> The live registry currently contains ' + nodeCount + ' nodes in `backend/data/node_definitions.json`.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group nodes by category, sorted by ID within each category
  const byCategory = {};
  for (const cat of CATEGORY_ORDER) byCategory[cat] = [];

  for (const [nodeId, node] of Object.entries(definitions)) {
    const cat = node.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push([nodeId, node]);
  }

  for (const cat of CATEGORY_ORDER) {
    const nodes = byCategory[cat] || [];
    if (nodes.length === 0) continue;

    // Sort by ID for determinism
    nodes.sort((a, b) => a[0].localeCompare(b[0]));

    lines.push(`## ${CATEGORY_LABELS[cat] ?? cat}`);
    lines.push('');

    for (const [nodeId, node] of nodes) {
      lines.push(`### ${node.displayName}`);
      lines.push('');

      // Metadata table
      const envDisplay = formatEnvKey(node.envKeyName);
      const providerDisplay = PROVIDER_LABELS[node.apiProvider] ?? node.apiProvider;
      const executionDisplay = node.executionPattern === 'async-poll'
        ? 'async-poll'
        : node.executionPattern;
      const audited = auditMap.get(nodeId) ?? '—';

      lines.push('| | |');
      lines.push('|---|---|');
      lines.push(metaRow('ID', `\`${nodeId}\``));
      lines.push(metaRow('Provider', providerDisplay));
      lines.push(metaRow('API Key', envDisplay === '—' ? '—' : envDisplay));
      if (node.apiEndpoint) {
        lines.push(metaRow('Endpoint', `\`${escapeCell(node.apiEndpoint)}\``));
      }
      lines.push(metaRow('Execution', executionDisplay));
      lines.push(metaRow('Inputs', formatPorts(node.inputPorts)));
      lines.push(metaRow('Outputs', formatPorts(node.outputPorts)));
      lines.push(metaRow('Audited', audited));
      lines.push('');

      // Parameters — handle dual/triple param groups
      const populatedGroups = getPopulatedParamGroups(node);

      if (populatedGroups.length === 0) {
        // No params at all
      } else if (populatedGroups.length === 1) {
        const [group] = populatedGroups;
        const table = renderParamTable(node[group]);
        if (table) {
          lines.push(table);
          lines.push('');
        }
      } else {
        // Multiple non-empty param groups — label each table
        for (const group of populatedGroups) {
          const table = renderParamTable(node[group]);
          if (!table) continue;
          lines.push(`**${PARAM_GROUP_LABELS[group] ?? group}**`);
          lines.push('');
          lines.push(table);
          lines.push('');
        }
      }

      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Sync version of buildAuditMap for use in generate() after module resolution.
 */
function buildAuditMapSync() {
  const auditMap = new Map();

  if (!existsSync(MODEL_PROVIDERS_PATH)) return auditMap;

  for (const provider of readdirSync(MODEL_PROVIDERS_PATH)) {
    const providerPath = join(MODEL_PROVIDERS_PATH, provider);
    let files;
    try {
      files = readdirSync(providerPath).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const fname of files) {
      const fpath = join(providerPath, fname);
      let content;
      try {
        content = readFileSync(fpath, 'utf8');
      } catch {
        continue;
      }

      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const fm = {};
      for (const line of fmMatch[1].split('\n')) {
        const colonIdx = line.indexOf(': ');
        if (colonIdx !== -1) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 2).trim();
          fm[key] = val;
        }
      }

      const verified = fm.verified;
      if (!verified) continue;

      const body = content.slice(fmMatch[0].length);
      const slugMatches = [...body.matchAll(/`([a-z][a-z0-9-]+)`/g)].map((m) => m[1]);
      for (const slug of slugMatches) {
        if (!auditMap.has(slug)) {
          auditMap.set(slug, verified);
        }
      }

      const modelField = fm.model ?? '';
      for (const part of modelField.split(',')) {
        const trimmed = part.trim();
        if (/^[a-z][a-z0-9-]+$/.test(trimmed) && !auditMap.has(trimmed)) {
          auditMap.set(trimmed, verified);
        }
      }
    }
  }

  return auditMap;
}

// Main
const isCheck = process.argv.includes('--check');

const generated = await generate();

if (isCheck) {
  let existing;
  try {
    existing = await readFile(OUTPUT_PATH, 'utf8');
  } catch {
    console.error('MODEL_REFERENCE.md does not exist — run without --check to generate it.');
    process.exit(1);
  }

  if (generated === existing) {
    console.log('MODEL_REFERENCE.md is up to date.');
    process.exit(0);
  } else {
    // Show a diff summary
    const genLines = generated.split('\n');
    const existLines = existing.split('\n');
    const maxLines = Math.max(genLines.length, existLines.length);
    let diffCount = 0;
    const diffSamples = [];
    for (let i = 0; i < maxLines; i++) {
      if (genLines[i] !== existLines[i]) {
        diffCount++;
        if (diffSamples.length < 5) {
          diffSamples.push(`  line ${i + 1}: expected ${JSON.stringify(genLines[i]?.slice(0, 80))}, got ${JSON.stringify(existLines[i]?.slice(0, 80))}`);
        }
      }
    }
    console.error(`MODEL_REFERENCE.md is out of date (${diffCount} differing line(s)).`);
    console.error('First differences:');
    for (const sample of diffSamples) console.error(sample);
    console.error('Run `node scripts/generate-model-reference.mjs` to regenerate.');
    process.exit(1);
  }
} else {
  await writeFile(OUTPUT_PATH, generated, 'utf8');
  const nodeCount = Object.keys(JSON.parse(await readFile(NODE_DEFS_PATH, 'utf8'))).length;
  console.log(`Generated docs/MODEL_REFERENCE.md (${nodeCount} nodes).`);
}
