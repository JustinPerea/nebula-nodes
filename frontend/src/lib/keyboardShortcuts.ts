/** Every app shortcut, in one place, for the "?" sheet. Keys are listed as
 * separate caps; "Mod" renders as ⌘ on a Mac and Ctrl elsewhere. */
export interface ShortcutEntry { keys: string[]; label: string }
export interface ShortcutGroup { title: string; items: ShortcutEntry[] }

export const SHORTCUTS_OPEN_EVENT = 'nebula:shortcuts-open';
/** Asks one node's title to switch into its rename field. detail: { nodeId }. */
export const NODE_RENAME_EVENT = 'nebula:node-rename';

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Canvas',
    items: [
      { keys: ['Mod', 'Enter'], label: 'Run canvas' },
      { keys: ['Mod', 'Z'], label: 'Undo' },
      { keys: ['Shift', 'Mod', 'Z'], label: 'Redo' },
      { keys: ['Mod', 'A'], label: 'Select all nodes' },
      { keys: ['Mod', 'C'], label: 'Copy selected nodes' },
      { keys: ['Mod', 'V'], label: 'Paste nodes' },
      { keys: ['Mod', 'D'], label: 'Duplicate selected nodes' },
      { keys: ['F2'], label: 'Rename the selected node' },
    ],
  },
  {
    title: 'View',
    items: [
      { keys: ['Mod', '='], label: 'Zoom in' },
      { keys: ['Mod', '−'], label: 'Zoom out' },
      { keys: ['Shift', '1'], label: 'Fit view' },
      { keys: ['Shift', '0'], label: 'Zoom to 100%' },
    ],
  },
  {
    title: 'App',
    items: [
      { keys: ['Mod', 'K'], label: 'Search commands and nodes' },
      { keys: ['Mod', 'S'], label: 'Save canvas' },
      { keys: ['Mod', 'O'], label: 'Load canvas' },
      { keys: ['?'], label: 'Show these shortcuts' },
      { keys: ['Esc'], label: 'Close the open drawer or dialog' },
    ],
  },
];

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
}

export function displayKey(key: string, mac = isMacPlatform()): string {
  if (key === 'Mod') return mac ? '⌘' : 'Ctrl';
  if (key === 'Shift') return mac ? '⇧' : 'Shift';
  if (key === 'Enter') return mac ? '↵' : 'Enter';
  return key;
}
