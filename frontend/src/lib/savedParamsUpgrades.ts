import type { RunGraphSnapshot } from './runHistory';

/**
 * One-time param upgrades of values saved in the browser.
 *
 * The backend (services/saved_graph_upgrades.py) upgrades everything it
 * stores: projects, the live graph, imported graph files and recovered copies.
 * Create drafts are also kept in localStorage, which only the browser reads,
 * so the same rule runs here when those drafts load. A backend test keeps the
 * version, the four models and both numbers equal to the Python ones.
 *
 * Run records are never rewritten: each one keeps what that run sent. A record
 * carries the version its recipe was sent at (`paramsVersion`, missing = 0,
 * stamped by openRunRecord), and `upgradeRunSnapshot` upgrades a copy of the
 * recipe when it is used again: replays (executeHistoricalRun), Create's
 * "Reuse settings" (resultContext.ts) and Paper freshness checks.
 *
 * Version 1 (Justin, 2026-10-17): a claude-chat value on Claude Opus 4.6,
 * Sonnet 4.6, Opus 4.7 or Opus 4.8 with Extended Thinking on, holding Max
 * Tokens 4,096 (the only default before 2026-10-16), becomes 64,000, the
 * current default. A 4,096 set afterwards is kept.
 */
export const GRAPH_PARAMS_VERSION = 1;

// Version 1. Frozen (not read from the definition) so a later default change
// can't change what this upgrade did.
export const CLAUDE_THINKING_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-8',
]);
export const OLD_MAX_TOKENS = 4096;
export const UPGRADED_MAX_TOKENS = 64000;

function isOldMaxTokens(value: unknown): boolean {
  if (typeof value === 'number') return value === OLD_MAX_TOKENS;
  return typeof value === 'string' && value.trim() === String(OLD_MAX_TOKENS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The params a value saved at `version` should hold now, or null if unchanged. */
export function upgradeSavedParams(
  definitionId: unknown, params: unknown, version: number,
): Record<string, unknown> | null {
  if (version >= 1 || definitionId !== 'claude-chat' || !isRecord(params)) return null;
  const model = params.model;
  // Same truthiness the backend handler uses for the toggle.
  if (typeof model === 'string' && CLAUDE_THINKING_MODELS.has(model) && params.extended_thinking
    && isOldMaxTokens(params.max_tokens)) {
    return { ...params, max_tokens: UPGRADED_MAX_TOKENS };
  }
  return null;
}

/** A run recipe saved at `version` as it should run now. Never mutates its
 * input, and returns the same object when nothing changes. */
export function upgradeRunSnapshot(snapshot: RunGraphSnapshot, version: number): RunGraphSnapshot {
  if (version >= GRAPH_PARAMS_VERSION) return snapshot;
  let changed = false;
  const nodes = snapshot.nodes.map((node) => {
    const params = upgradeSavedParams(node.definitionId, node.params, version);
    if (!params) return node;
    changed = true;
    return { ...node, params };
  });
  return changed ? { ...snapshot, nodes } : snapshot;
}
