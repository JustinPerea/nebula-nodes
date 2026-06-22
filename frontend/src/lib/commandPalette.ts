import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { SKINS, type SkinId } from './skins';

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
  togglePanel: (p: 'library' | 'inspector' | 'settings' | 'chat' | 'assets') => void;
  setSkin: (s: SkinId) => void;
  startAgentQuery: () => void;
  canRun: boolean;
  /** Existing nodes on the canvas, for search-and-focus. */
  canvasNodes: Array<{ id: string; label: string }>;
  focusNode: (id: string) => void;
}

type PanelKey = 'library' | 'inspector' | 'settings' | 'chat' | 'assets';

const PANELS: Array<[PanelKey, string]> = [
  ['library', 'Node Library'],
  ['inspector', 'Inspector'],
  ['settings', 'Settings'],
  ['chat', 'Chat'],
  ['assets', 'Assets'],
];

export function buildCommands(ctx: PaletteContext): PaletteCommand[] {
  const cmds: PaletteCommand[] = [
    { id: 'action:run', title: 'Run graph', group: 'Actions', keywords: 'execute play', enabled: ctx.canRun, perform: ctx.runGraph },
    { id: 'action:save', title: 'Save graph', group: 'Actions', keywords: 'export json download', perform: ctx.save },
    { id: 'action:load', title: 'Load graph', group: 'Actions', keywords: 'open import json', perform: ctx.load },
    { id: 'action:fit', title: 'Fit view', group: 'Actions', keywords: 'zoom center frame fit', perform: ctx.fitView },
    { id: 'agent:ask', title: 'Ask the agent…', subtitle: 'Describe what to build', group: 'Agent', keywords: 'daedalus chat ai prompt generate', perform: ctx.startAgentQuery },
    { id: 'view:create', title: 'Open Create view', group: 'View', keywords: 'generate studio prompt', perform: ctx.enterCreateView },
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

  for (const skin of SKINS) {
    cmds.push({
      id: `view:skin:${skin.id}`,
      title: `Skin: ${skin.label}`,
      group: 'View',
      keywords: `theme appearance skin ${skin.label}`,
      perform: () => ctx.setSkin(skin.id),
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
      subtitle: `${def.category} · ${def.apiProvider}`,
      group: 'Nodes',
      keywords: `${def.category} ${def.apiProvider} add node`,
      perform: () => ctx.addNodeAtCenter(def.id),
    });
  }

  return cmds;
}

/** Case-insensitive substring match over title + subtitle + keywords. */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) =>
    `${c.title} ${c.subtitle ?? ''} ${c.keywords ?? ''}`.toLowerCase().includes(q)
  );
}
