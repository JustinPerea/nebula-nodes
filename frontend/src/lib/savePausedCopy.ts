/**
 * GM - Design's lines for a project over the save limit (Q118), verbatim.
 * Sizes come from lib/projectSize (displaySize, overBy, rowSize): MiB
 * labelled "MB", one decimal; the limit is "16 MB".
 */
import { displaySize, overBy } from './projectSize';

export const SEE_WHATS_LARGE = "See what's large";
export const SAVING_PAUSED = 'Saving paused';
export const DOWNLOAD_A_COPY = 'Download a copy';
export const LARGEST_FIRST = 'Largest first';
export const HEADER_TOOLTIP = "This project is over the 16 MB save limit. Click to see what's large.";

/** The header's save status while paused. */
export const headerLine = (bytes: number) => `Saving paused · ${displaySize(bytes)} MB`;
/** The one notice on entering the state. */
export const pausedNotice = (bytes: number) => `Saving paused. This project is ${displaySize(bytes)} MB, over the 16 MB limit.`;
/** The notice after Load graph opened a file over the limit. As a new
 * project (Q120), GM's shorter line: the header already shows the project's
 * name, taken from the file, and its size, so one line fits beside the
 * button. */
export const loadedNotice = (fileName: string, bytes: number, asNewProject = false) => (asNewProject
  ? "Opened as a new project. It's over the save limit."
  : `Opened ${fileName}. It's ${displaySize(bytes)} MB, over the save limit.`);
/** The panel's live line. */
export const panelLine = (bytes: number) =>
  `This project is ${displaySize(bytes)} MB. Make it ${overBy(bytes)} MB smaller and it saves again by itself. Until then, changes stay only in this tab.`;
/** Once it saves again. */
export const savingAgainNotice = (bytes: number) => `Saving again. This project is ${displaySize(bytes)} MB.`;
/** Past the top ten rows. GM wrote the plural; one item reads singular. */
/** With no size when it rounds to 0.0 (GM - Design, #182: "14 smaller
 * items", since "0.0 MB" tells nobody anything). */
export const smallerLine = (count: number, size: string) =>
  `${count} smaller ${count === 1 ? 'item' : 'items'}${size === '0.0' ? '' : `, ${size} MB in all`}`;

/** The dimmer part label on a node's row (lib/projectSize SizePart). GM
 * named "Text" and "Stored outputs"; "Embedded files" (data: URLs pasted
 * into a node's settings) and "Node data" (the rest of its entry) name the
 * other real fields. */
export const PART_LABELS = {
  text: 'Text', outputs: 'Stored outputs', embedded: 'Embedded files', node: 'Node data',
} as const;
/** Rows that aren't nodes (GM's "Run history"; the others named for what
 * they hold). */
export const ROW_NAMES = {
  runHistory: 'Run history', wires: 'Connections', createDraft: 'Create draft', project: 'Project settings',
} as const;
