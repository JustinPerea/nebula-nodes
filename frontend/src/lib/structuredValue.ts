/**
 * A port value that no media renderer draws (an Array, a Character, a Krea
 * job object, an `Any` holding a list of image URLs...), read into a small,
 * bounded description a card can draw. Nothing here walks a whole large
 * value: lists are judged by their first SAMPLE items and only what is shown
 * is summarised, so a 50 MB array costs what its first few hundred items cost.
 */
import type { PortValue } from '../types';
import { isHexColor } from './moodboardBundle';
import { hasRepresentationViewer } from './representationViewerRegistry';

export type MediaKind = 'image' | 'video' | 'audio';

export interface StructuredField {
  /** The field's own key, unique within the object (React keys use it). */
  id: string;
  /** The key as shown, clamped. */
  key: string;
  value: string;
}

export type StructuredView =
  | { kind: 'empty'; text: string }
  | { kind: 'scalar'; text: string; long: boolean }
  | { kind: 'media'; media: MediaKind; urls: string[]; total: number }
  | { kind: 'colors'; colors: string[]; total: number }
  | { kind: 'list'; items: string[]; total: number }
  | { kind: 'record'; title: string | null; thumbnails: string[]; fields: StructuredField[]; total: number };

export interface DescribeLimits {
  /** Media or colours drawn from a list. */
  media: number;
  /** List items summarised. */
  items: number;
  /** Fields of an object listed. */
  fields: number;
  /** Characters of one string shown. */
  chars: number;
}

export const CARD_LIMITS: DescribeLimits = { media: 4, items: 5, fields: 24, chars: 160 };
export const FULL_LIMITS: DescribeLimits = { media: 12, items: 12, fields: 60, chars: 600 };

// How many items of a list decide whether it is a list of media or colours.
const SAMPLE = 500;
const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif|avif|bmp|svg)$/i;
const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v)$/i;
const AUDIO_EXT = /\.(?:mp3|wav|ogg|m4a|flac|aac)$/i;
const URL_KEYS = ['url', 'src', 'image', 'image_url', 'imageUrl'] as const;
// Which field names an object's heading, in order.
const TITLE_KEYS = ['name', 'label', 'title', 'kind', 'id'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeUrl(value: string): boolean {
  return value.startsWith('/') || /^https?:\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:');
}

/** The media a string or `{url}` object points at, if it plainly is one. */
export function mediaOf(value: unknown): { kind: MediaKind; url: string } | null {
  let url: string | null = null;
  if (typeof value === 'string') url = value.trim();
  else if (isRecord(value)) {
    for (const key of URL_KEYS) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) { url = candidate.trim(); break; }
    }
  }
  if (!url || (url.length > 4096 && !url.startsWith('data:')) || !looksLikeUrl(url)) return null;
  if (url.startsWith('data:image/')) return { kind: 'image', url };
  if (url.startsWith('data:video/')) return { kind: 'video', url };
  if (url.startsWith('data:audio/')) return { kind: 'audio', url };
  const path = url.split(/[?#]/)[0];
  if (IMAGE_EXT.test(path)) return { kind: 'image', url };
  if (VIDEO_EXT.test(path)) return { kind: 'video', url };
  if (AUDIO_EXT.test(path)) return { kind: 'audio', url };
  return null;
}

export function clampText(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars).trimEnd()}…` : text;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line for a value inside a list or a field: strings clamped, lists and
 *  objects counted. */
export function summarizeValue(value: unknown, chars: number): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value.trim() ? clampText(value, chars) : 'Empty';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return plural(value.length, 'item');
  if (isRecord(value)) {
    const title = recordTitle(value);
    const count = plural(Object.keys(value).length, 'field');
    return title ? `${clampText(title.text, chars)} · ${count}` : count;
  }
  return String(value);
}

function recordTitle(value: Record<string, unknown>): { key: string; text: string } | null {
  for (const key of TITLE_KEYS) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return { key, text: candidate.trim() };
  }
  return null;
}

/** Up to `limit` image URLs from an object's own fields and its lists (one
 *  level down: ReferenceSet `items[].url`, Character `referenceViews`). */
function recordThumbnails(value: Record<string, unknown>, keys: readonly string[], limit: number): string[] {
  const urls: string[] = [];
  const add = (candidate: unknown) => {
    const media = mediaOf(candidate);
    if (media?.kind === 'image' && !urls.includes(media.url)) urls.push(media.url);
  };
  // Over the caller's key list and only the first fields: Object.values on a
  // 300,000-key object would read every value to show four thumbnails.
  for (let index = 0; index < keys.length && index < limit * 50; index += 1) {
    if (urls.length >= limit) break;
    const field = value[keys[index]];
    if (Array.isArray(field)) {
      for (const item of field.slice(0, limit * 4)) {
        if (urls.length >= limit) break;
        add(item);
      }
    } else if (typeof field === 'string') add(field);
  }
  return urls;
}

/** Thumbnails load lazily on a card, like its other images. In the Inspector
 *  they load at once: its masked scroll panel never starts lazy images below
 *  the first row. */
export function thumbnailLoading(variant: 'card' | 'full'): 'lazy' | 'eager' {
  return variant === 'card' ? 'lazy' : 'eager';
}

/** What to draw for a value no other renderer drew. */
export function describeStructuredValue(value: unknown, limits: DescribeLimits = CARD_LIMITS): StructuredView {
  if (value === null || value === undefined) return { kind: 'empty', text: 'No value' };
  if (typeof value === 'string') {
    if (!value.trim()) return { kind: 'empty', text: 'Empty' };
    const media = mediaOf(value);
    if (media) return { kind: 'media', media: media.kind, urls: [media.url], total: 1 };
    if (isHexColor(value)) return { kind: 'colors', colors: [value.trim()], total: 1 };
    return { kind: 'scalar', text: value, long: value.length > limits.chars };
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return { kind: 'scalar', text: String(value), long: false };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'empty', text: 'Empty list' };
    // A list is drawn as media or colours only when every item (of the
    // first SAMPLE) is one.
    const sample = value.length > SAMPLE ? value.slice(0, SAMPLE) : value;
    if (sample.every(isHexColor)) {
      return { kind: 'colors', colors: value.slice(0, limits.media * 6).map((hex) => hex.trim()), total: value.length };
    }
    const first = mediaOf(value[0]);
    if (first && sample.every((item) => mediaOf(item)?.kind === first.kind)) {
      const urls = value.slice(0, limits.media).map((item) => mediaOf(item)!.url);
      return { kind: 'media', media: first.kind, urls, total: value.length };
    }
    return {
      kind: 'list',
      items: value.slice(0, limits.items).map((item) => summarizeValue(item, limits.chars)),
      total: value.length,
    };
  }
  if (isRecord(value)) {
    const title = recordTitle(value);
    const keys = Object.keys(value);
    const fields: StructuredField[] = [];
    for (const key of keys) {
      if (fields.length >= limits.fields) break;
      if (title && key === title.key) continue;
      fields.push({ id: key, key: clampText(key, 60), value: summarizeValue(value[key], limits.chars) });
    }
    return {
      kind: 'record',
      title: title ? clampText(title.text, limits.chars) : null,
      thumbnails: recordThumbnails(value, keys, limits.media),
      fields,
      total: keys.length - (title ? 1 : 0),
    };
  }
  return { kind: 'scalar', text: String(value), long: false };
}

/**
 * Pretty JSON of `value`, at most `maxChars` long. It stops walking the value
 * once the budget is spent, so a huge value is never serialised whole.
 */
export function boundedJson(value: unknown, maxChars: number): { text: string; truncated: boolean } {
  let out = '';
  let truncated = false;
  const seen = new WeakSet<object>();

  const write = (chunk: string): boolean => {
    if (truncated) return false;
    if (out.length + chunk.length > maxChars) {
      out += chunk.slice(0, Math.max(0, maxChars - out.length));
      truncated = true;
      return false;
    }
    out += chunk;
    return true;
  };

  const walk = (node: unknown, depth: number): boolean => {
    if (typeof node === 'string') {
      const room = Math.max(0, maxChars - out.length);
      if (node.length > room) return write(JSON.stringify(node.slice(0, room + 1)));
      return write(JSON.stringify(node));
    }
    if (node === null || typeof node === 'number' || typeof node === 'boolean') return write(JSON.stringify(node));
    if (typeof node === 'bigint') return write(String(node));
    if (typeof node !== 'object') return write('null');
    if (seen.has(node)) return write('"[circular]"');
    seen.add(node);
    const pad = '  '.repeat(depth + 1);
    const close = '  '.repeat(depth);
    if (Array.isArray(node)) {
      if (node.length === 0) return write('[]');
      if (!write('[\n')) return false;
      for (let index = 0; index < node.length; index += 1) {
        if (!write(pad) || !walk(node[index], depth + 1)) return false;
        if (!write(index < node.length - 1 ? ',\n' : '\n')) return false;
      }
      return write(`${close}]`);
    }
    // Values are read one at a time and the walk stops at the budget, so a
    // wide object costs its key list, not every value (Object.entries).
    const record = node as Record<string, unknown>;
    const keys = Object.keys(record);
    let wrote = 0;
    for (const key of keys) {
      const item = record[key];
      if (item === undefined) continue;
      if (!write(wrote === 0 ? '{\n' : ',\n')) return false;
      if (!write(`${pad}${JSON.stringify(key)}: `) || !walk(item, depth + 1)) return false;
      wrote += 1;
    }
    return write(wrote === 0 ? '{}' : `\n${close}}`);
  };

  walk(value, 0);
  return { text: out, truncated };
}

// Port types a card draws itself when the value is a file URL.
const MEDIA_TYPES = new Set(['Image', 'Mask', 'Video', 'Audio', 'Mesh', 'SVG']);

/**
 * A run's outputs that no media renderer draws, for the Inspector's "Last
 * output": a media type holding a URL, a string Text, a World and the
 * spatial types (RepresentationViewer) are left out; everything else stays.
 */
export function structuredOutputEntries(outputs: Readonly<Record<string, PortValue>> | undefined): Array<[string, PortValue]> {
  return Object.entries(outputs ?? {}).filter(([, output]) => {
    if (!output || typeof output !== 'object') return false;
    if (MEDIA_TYPES.has(output.type) && typeof output.value === 'string') return false;
    if (output.type === 'Text' && typeof output.value === 'string') return false;
    if (output.type === 'World' || hasRepresentationViewer(output.type)) return false;
    return true;
  });
}
