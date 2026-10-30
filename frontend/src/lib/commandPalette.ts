import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { CATEGORY_LABELS, matchesSearch, modelSearchText, providerLabel } from './modelDiscovery';
import { SHORTCUTS_OPEN_EVENT } from './keyboardShortcuts';
import { RUN_LOCK_VERBS, runFinishesLine } from './runLock';

export type PaletteGroup = 'Actions' | 'View' | 'Agent' | 'Canvas' | 'Nodes';

/** Group render order in the palette (Actions/View/Agent first, then existing
 *  Canvas nodes to focus, then the Nodes library to insert). */
export const PALETTE_GROUP_ORDER: PaletteGroup[] = ['Actions', 'View', 'Agent', 'Canvas', 'Nodes'];

export interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  group: PaletteGroup;
  /** Extra terms folded into the substring match (not shown). */
  keywords?: string;
  /** When false the command is shown disabled and cannot be run. */
  enabled?: boolean;
  /** GM PR #205 r2 item 3: why a locked row is locked, shown as the row's
   * own secondary text (a tooltip never shows on a row reached by the arrow
   * keys) and named by its aria-describedby. */
  lockLine?: string;
  /** The palette stays open: the command changes what it shows ("Ask the
   * agent…" opens its agent prompt; review 11). Others close it first. */
  keepsOpen?: boolean;
  /** Round 23 (review 22, L-3): the command changes the canvas (run, load,
   * ask the agent, insert a node), so it takes the canvas lock: disabled,
   * marked and refused while the tab follows an agent's switch or Nebula is
   * offline. Commands without it only look (fit, focus, panels, views) or
   * export (save), and stay enabled. */
  acts?: boolean;
  perform: () => void;
}

/** Everything the commands need from the app, supplied by the component via hooks. */
export interface PaletteContext {
  addNodeAtCenter: (definitionId: string) => void;
  runGraph: () => void;
  save: () => void;
  load: () => void;
  fitView: () => void;
  enterCreateView: () => void;
  togglePanel: (p: 'library' | 'inspector' | 'settings' | 'chat' | 'assets' | 'history') => void;
  startAgentQuery: () => void;
  canRun: boolean;
  canSave: boolean;
  canLoad: boolean;
  /** This tab's run is going or starting: Run, Save and Load say so. */
  running?: boolean;
  /** Existing nodes on the canvas, for search-and-focus. */
  canvasNodes: Array<{ id: string; label: string }>;
  focusNode: (id: string) => void;
}

type PanelKey = 'library' | 'inspector' | 'settings' | 'chat' | 'assets' | 'history';

const PANELS: Array<[PanelKey, string]> = [
  ['library', 'Node Library'],
  ['inspector', 'Inspector'],
  ['settings', 'Settings'],
  ['chat', 'Chat'],
  ['assets', 'Assets'],
  ['history', 'Run History'],
];

/** A row the run locks says its lock line (GM PR #205 r2 item 3). */
function runLocked(ctx: PaletteContext, enabled: boolean, verb: string): Pick<PaletteCommand, 'lockLine'> {
  return ctx.running && !enabled ? { lockLine: runFinishesLine(verb) } : {};
}

export function buildCommands(ctx: PaletteContext): PaletteCommand[] {
  const cmds: PaletteCommand[] = [
    // GM PR #205 r2 item 3: "canvas", the word the rest of the app uses.
    { id: 'action:run', title: 'Run canvas', group: 'Actions', keywords: 'execute play graph', enabled: ctx.canRun, acts: true, perform: ctx.runGraph,
      ...runLocked(ctx, ctx.canRun, RUN_LOCK_VERBS.runCanvas) },
    { id: 'action:save', title: 'Save canvas', group: 'Actions', keywords: 'export json download graph', enabled: ctx.canSave, perform: ctx.save,
      ...runLocked(ctx, ctx.canSave, RUN_LOCK_VERBS.saveCanvas) },
    { id: 'action:load', title: 'Load canvas', group: 'Actions', keywords: 'open import json graph', enabled: ctx.canLoad, acts: true, perform: ctx.load,
      ...runLocked(ctx, ctx.canLoad, RUN_LOCK_VERBS.loadCanvas) },
    { id: 'action:fit', title: 'Fit view', group: 'Actions', keywords: 'zoom center frame fit', perform: ctx.fitView },
    { id: 'agent:ask', title: 'Ask the agent…', subtitle: 'Describe what to build', group: 'Agent', keywords: 'chat ai prompt generate', keepsOpen: true, acts: true, perform: ctx.startAgentQuery },
    { id: 'view:create', title: 'Open Creator Studio', group: 'View', keywords: 'create generate studio prompt', perform: ctx.enterCreateView },
    { id: 'view:shortcuts', title: 'Keyboard shortcuts', group: 'View', keywords: 'keys hotkeys help cheat sheet',
      perform: () => window.dispatchEvent(new CustomEvent(SHORTCUTS_OPEN_EVENT)) },
  ];

  for (const [panel, label] of PANELS) {
    cmds.push({
      id: `view:toggle:${panel}`,
      title: `Toggle ${label}`,
      group: 'View',
      keywords: `panel show hide ${panel}`,
      perform: () => ctx.togglePanel(panel),
    });
  }

  for (const n of ctx.canvasNodes) {
    cmds.push({
      id: `canvas:${n.id}`,
      title: n.label,
      subtitle: 'on canvas · focus',
      group: 'Canvas',
      keywords: `focus find node ${n.id}`,
      perform: () => ctx.focusNode(n.id),
    });
  }

  for (const def of Object.values(NODE_DEFINITIONS)) {
    cmds.push({
      id: `node:${def.id}`,
      title: def.displayName,
      subtitle: `${CATEGORY_LABELS[def.category]} · ${providerLabel(def.apiProvider)}`,
      group: 'Nodes',
      keywords: `${modelSearchText(def)} add node`,
      acts: true,
      perform: () => ctx.addNodeAtCenter(def.id),
    });
  }

  return cmds;
}

/** Shared token matching over title + subtitle + keywords. */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  return commands.filter((command) => matchesSearch(
    `${command.title} ${command.subtitle ?? ''} ${command.keywords ?? ''}`, query,
  ));
}
