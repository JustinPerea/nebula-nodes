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

/** The line when a paste holds nothing to add (GM, #210 item 1). */
export const NOTHING_TO_PASTE = 'There’s no image on the clipboard to add.';
/** The line when a paste holds only http(s) links (GM, #210 item 2): nothing is fetched or added. */
export const LINKS_NOT_ADDED = 'Nebula can’t add images from links. Copy the image itself, then paste it.';

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

/** An http(s) link with an authority (`//host`): `http:foo` and `https:example.com` aren't. */
const WEB_LINK = /^https?:\/\//iu;

/** The text's lines as http(s) links, or none when any line is something else. */
export function webLinks(text: string): string[] {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return linksOf(lines);
}

/** A `text/uri-list`'s links (RFC 2483): one per line, `#` lines are comments. */
export function uriListLinks(list: string): string[] {
  const lines = list.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  return linksOf(lines);
}

function linksOf(lines: string[]): string[] {
  if (lines.length === 0) return [];
  for (const line of lines) {
    // WHATWG URL parsing gives every http(s) URL a host, so the scheme and
    // the `//` are the whole check.
    if (!WEB_LINK.test(line)) return [];
    try { new URL(line); } catch { return []; }
  }
  return lines;
}

export function readClipboardImages(data: DataTransfer | null): ClipboardImages {
  if (!data) return { files: [], links: [] };
  const files = clipboardFiles(data);
  if (files.length > 0) return { files, links: [] };
  // A link may come as plain text, or only as a uri-list (some apps copy that way).
  const plain = webLinks(data.getData('text/plain') ?? '');
  return { files: [], links: plain.length > 0 ? plain : uriListLinks(data.getData('text/uri-list') ?? '') };
}

/** One file's identity for the held-key backstop: size, type and a SHA-256 of its bytes. */
export async function fileSignature(file: File): Promise<string> {
  const head = `${file.size}:${file.type}`;
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    return `${head}:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    // No Web Crypto (an old shell): the name and time stand in for the bytes.
    return `${head}:${file.name}:${file.lastModified}`;
  }
}

/** Whether a paste is the Studio's: not one meant for a text field (input,
 *  textarea, contenteditable: Direction, Avoid, a colour, a note keep their
 *  own paste) or a dialog, and not one outside the Studio's tree. As the
 *  Studio's Cmd+Z (studioKeys), which yields only to text boxes and dialogs. */
export function isStudioPasteTarget(target: EventTarget | null): boolean {
  return isStudioShortcutTarget(target, 'undo');
}
