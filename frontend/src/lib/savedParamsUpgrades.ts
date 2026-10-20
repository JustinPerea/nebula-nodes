/**
 * One-time param upgrades of values saved in the browser.
 *
 * The backend (services/saved_graph_upgrades.py) upgrades everything it
 * stores: projects, the live graph, imported graph files, recovered copies and
 * style presets (upgraded when read; Create's "Save current" sends
 * `paramsVersion` so a value set after an upgrade is kept).
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
 * A tab is only current at this bundle's version. Every request sends it
 * (`X-Nebula-Params-Version`, lib/backend.ts), the backend refuses saves and
 * runs from another version, and from a browser that sends none (409
 * `params_outdated`). A tab that learns the backend moved on saves unsaved
 * work as a recovered copy and reloads, and a tab connected to an older
 * backend (one that reports no version is 0) stops and loads nothing from it
 * (lib/paramsOutdated.ts, store/projectStore.ts). So no tab saves or runs
 * values from before an upgrade with rules that don't know about it.
 *
 * Builds also carry the version: vite-plugins/buildStamp.ts writes it to
 * nebula-build.json, and the desktop app refuses at launch to open a build
 * whose stamp differs from /api/health's `paramsVersion`
 * (desktop/frontend-build.mjs). Keep this module free of imports; the stamp
 * plugin reads it under the Node tsconfig.
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

/** The part of a run recipe (runHistory.ts RunGraphSnapshot) an upgrade reads. */
interface UpgradableSnapshot {
  nodes: ReadonlyArray<{ definitionId: unknown; params: unknown }>;
}

/** A run recipe saved at `version` as it should run now. Never mutates its
 * input, and returns the same object when nothing changes.
 *
 * Typed structurally rather than importing RunGraphSnapshot so this module
 * imports nothing: the build's stamp plugin (vite-plugins/buildStamp.ts)
 * reads GRAPH_PARAMS_VERSION from here under the Node tsconfig, where the
 * browser-only runHistory.ts doesn't typecheck. */
export function upgradeRunSnapshot<T extends UpgradableSnapshot>(snapshot: T, version: number): T {
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

/**
 * Behaviour changes that are not params upgrades. No saved value changes
 * meaning, so GRAPH_PARAMS_VERSION stays and the recipe replays as sent; a
 * replay of a record from before the change says once that it can differ.
 *
 * Every new run record is stamped with the behaviour version its bundle runs
 * at (`behaviourVersion`, runHistory.ts openRunRecord; missing means 0), and
 * a change counts from the version that brought it, not from a calendar
 * date: a record made on any build before the change shipped has a lower
 * stamp, whenever it merges.
 *
 * Krea 2 board strengths (Q21 b, Justin 2026-10-20; moodboard canvas PR13a,
 * plan section 4.8 item 7): behaviour version 1. A Nebula board's images used
 * to go at `strength × weight` each, and now share out the board's strength.
 * The backend can't tell a replay from a new run (POST /api/execute carries
 * no record), so the canvas adds the line, beside the run's own notes, when
 * the replayed node reports (graphStore's executed event). The date in the
 * line is copy only.
 */
export const RUN_BEHAVIOUR_VERSION = 1;
const KREA2_BOARD_STRENGTHS_VERSION = 1;
export const KREA2_BOARD_STRENGTHS_CHANGED = '2026-10-20';
export const KREA2_BOARD_STRENGTHS_REPLAY_NOTE = 'Krea 2 board strengths now add up to the board\'s strength '
  + `(changed ${KREA2_BOARD_STRENGTHS_CHANGED}), so this replay can differ from the original.`;

/** The part of a run recipe the replay lines read. */
interface ReplayableSnapshot {
  nodes: ReadonlyArray<{ id: string; definitionId: unknown }>;
  edges: ReadonlyArray<{ source: string; target: string; targetHandle?: string | null }>;
}

/** Nodes that hand their input on unchanged (backend/execution/engine.py
 * `router`, `reroute`), so a board wired through them still reaches Krea 2. */
const PASS_THROUGH_NODES = new Set(['reroute', 'router']);

/** The one-time lines a replay of a recipe first run at `behaviourVersion`
 * (the record's stamp; missing is 0) should show, by node id. Empty when
 * nothing it replays has changed. */
export function runReplayNotes(snapshot: ReplayableSnapshot, behaviourVersion: number): Record<string, string[]> {
  const notes: Record<string, string[]> = {};
  if (!(behaviourVersion < KREA2_BOARD_STRENGTHS_VERSION)) return notes;
  const kinds = new Map(snapshot.nodes.map((node) => [node.id, node.definitionId]));
  const fedByBoard = (target: string, port: string, seen: Set<string>): boolean =>
    snapshot.edges.some((edge) => {
      if (edge.target !== target || edge.targetHandle !== port) return false;
      const kind = kinds.get(edge.source);
      if (kind === 'nebula-moodboard') return true;
      if (typeof kind !== 'string' || !PASS_THROUGH_NODES.has(kind) || seen.has(edge.source)) return false;
      seen.add(edge.source);
      return fedByBoard(edge.source, 'input', seen);
    });
  for (const node of snapshot.nodes) {
    if (node.definitionId !== 'krea-2-generate') continue;
    if (fedByBoard(node.id, 'moodboard', new Set())) notes[node.id] = [KREA2_BOARD_STRENGTHS_REPLAY_NOTE];
  }
  return notes;
}
