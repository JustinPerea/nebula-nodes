import { isStudioShortcutTarget } from './studioKeys';

/**
 * Cmd+V in Moodboard Studio (Justin decided, 2026-10-31): what a paste holds
 * for the board. Image files go through the drop path (same filter, upload,
 * placement and one undo step). A browser's copy of an image carries the
 * file and HTML with an <img>: the file is taken, the HTML ignored. Text is
 * read as links, one per line; only http and https links count, and a
 * data:, file:, blob: or javascript: link is refused, never fetched.
 */
export interface ClipboardImages {
  /** Image files, in clipboard order. */
  files: File[];
  /** http(s) links, one per line of the text, when every line is one. */
  links: string[];
}

/** The line when a paste holds nothing to add (GM's). */
export const NOTHING_TO_PASTE = 'There’s no image or image link on the clipboard to add.';

/** A file the drop path would take: an image type (BoardCanvas onDrop, MoodboardStudioView handleDrop). */
const isImageFile = (file: File | null): file is File => file !== null && file.type.startsWith('image/');

function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []).filter(isImageFile);
  if (files.length > 0) return files;
  // Some sources (a screenshot in Chrome) put the image only in `items`.
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(isImageFile);
}

/** The text's lines as http(s) links, or none when any line is something else. */
export function webLinks(text: string): string[] {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const links: string[] = [];
  for (const line of lines) {
    let parsed: URL;
    try { parsed = new URL(line); } catch { return []; }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return [];
    links.push(line);
  }
  return links;
}

export function readClipboardImages(data: DataTransfer | null): ClipboardImages {
  if (!data) return { files: [], links: [] };
  const files = clipboardFiles(data);
  if (files.length > 0) return { files, links: [] };
  return { files: [], links: webLinks(data.getData('text/plain') ?? '') };
}

/** Whether a paste is the Studio's: not one meant for a text field (input,
 *  textarea, contenteditable: Direction, Avoid, a colour, a note keep their
 *  own paste) or a dialog, and not one outside the Studio's tree. As the
 *  Studio's Cmd+Z (studioKeys), which yields only to text boxes and dialogs. */
export function isStudioPasteTarget(target: EventTarget | null): boolean {
  return isStudioShortcutTarget(target, 'undo');
}
